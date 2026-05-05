/**
 * Self-healing telegram_handle backfill.
 *
 * Every 30 min, finds users whose chat_id is known but whose
 * personal handle is null, and asks Telegram's getChat for the
 * username. getChat is non-consuming (unlike getUpdates) so this
 * doesn't race the OpenClaw gateway's long-poll loop on each VM.
 *
 * Self-healing chain:
 *   user DMs their bot
 *      → OpenClaw long-poll consumes the update
 *      → notify_user.sh's chat_id discovery on next notification
 *        captures and writes the chat_id to notification-log.jsonl
 *      → /api/cron/backfill-partner-chat-ids (or similar mechanism)
 *        propagates that chat_id to instaclaw_vms.telegram_chat_id
 *      → THIS cron's next tick calls getChat for that pair
 *      → instaclaw_users.telegram_handle gets populated
 *      → next agent-to-agent intro from that user uses the personal
 *        handle CTA instead of the my-matches fallback
 *
 * No manual backfill needed — every user who chats with their bot
 * gets their handle stored automatically within 30-60 min of first
 * contact.
 *
 * Idempotency: only updates rows where telegram_handle IS NULL. A
 * user who later changes their Telegram handle won't have it picked
 * up here — they'd need a refresh path (out of scope; rare).
 *
 * Auth: CRON_SECRET (Bearer or x-cron-secret).
 *
 * Limits:
 *   - 50 rows per run (one cron tick covers a substantial fleet
 *     burst; the next tick mops up the rest).
 *   - Concurrency 5 — Telegram allows ~30 req/sec to a bot, well
 *     above this. Per-bot rate, but each row uses a different bot.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_SIZE = 50;
const CONCURRENCY = 5;
const TG_API = "https://api.telegram.org";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const xCron = req.headers.get("x-cron-secret");
  if (xCron === secret) return true;
  return false;
}

interface CandidateRow {
  user_id: string;
  vm_id: string;
  vm_name: string | null;
  bot_token: string;
  chat_id: string;
}

interface CaptureResult {
  user_id: string;
  vm_name: string | null;
  status: "captured" | "no_username" | "telegram_error" | "db_error";
  username?: string | null;
  detail?: string;
}

async function captureOne(row: CandidateRow): Promise<CaptureResult> {
  const result: CaptureResult = {
    user_id: row.user_id,
    vm_name: row.vm_name,
    status: "telegram_error",
  };
  try {
    const url = `${TG_API}/bot${row.bot_token}/getChat?chat_id=${encodeURIComponent(row.chat_id)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      result.detail = `getChat http=${res.status}`;
      return result;
    }
    const data = await res.json().catch(() => null) as
      | { ok?: boolean; result?: { username?: string; type?: string }; description?: string }
      | null;
    if (!data?.ok) {
      result.detail = `getChat error: ${data?.description?.slice(0, 100) || "unknown"}`;
      return result;
    }
    const username = (data.result?.username || "").trim().replace(/^@/, "");
    if (!username) {
      // User has no public Telegram handle. Leave the row null —
      // we'll re-check on the next cron tick if they set one later.
      result.status = "no_username";
      return result;
    }
    // Update the row. WHERE telegram_handle IS NULL keeps the write
    // idempotent — if a parallel cron tick (or future refresh path)
    // already wrote one, our update is a no-op.
    const supabase = getSupabase();
    const { error } = await supabase
      .from("instaclaw_users")
      .update({ telegram_handle: username })
      .eq("id", row.user_id)
      .is("telegram_handle", null);
    if (error) {
      result.status = "db_error";
      result.detail = error.message.slice(0, 200);
      return result;
    }
    result.status = "captured";
    result.username = username;
    return result;
  } catch (e) {
    result.detail = e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100);
    return result;
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Two-step lookup:
  // 1. Pull the user_ids whose handle is null AND who have an
  //    assigned VM with a chat_id + bot_token.
  // 2. Build CandidateRow with all the fields we need.
  //
  // PostgREST joins through foreign keys are awkward when we want
  // BOTH sides' columns; explicit two-step is cleaner.
  const { data: vms, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, telegram_bot_token, telegram_chat_id")
    .eq("health_status", "healthy")
    .not("assigned_to", "is", null)
    .not("telegram_chat_id", "is", null)
    .not("telegram_bot_token", "is", null)
    .limit(500);

  if (vmErr) {
    console.error(`backfill-telegram-handles: vm_query_failed ${vmErr.message}`);
    return NextResponse.json({ error: "vm query failed" }, { status: 503 });
  }
  if (!vms || vms.length === 0) {
    console.log("backfill-telegram-handles: no eligible VMs");
    return NextResponse.json({ ok: true, candidates: 0, captured: 0 });
  }

  const userIds = Array.from(new Set(vms.map((v) => v.assigned_to as string)));
  const { data: users, error: userErr } = await supabase
    .from("instaclaw_users")
    .select("id, telegram_handle")
    .in("id", userIds)
    .is("telegram_handle", null);

  if (userErr) {
    console.error(`backfill-telegram-handles: user_query_failed ${userErr.message}`);
    return NextResponse.json({ error: "user query failed" }, { status: 503 });
  }
  if (!users || users.length === 0) {
    console.log("backfill-telegram-handles: no users with null handle");
    return NextResponse.json({ ok: true, candidates: 0, captured: 0 });
  }

  const usersWithoutHandle = new Set(users.map((u) => u.id as string));
  const candidates: CandidateRow[] = vms
    .filter((v) => usersWithoutHandle.has(v.assigned_to as string))
    .slice(0, BATCH_SIZE)
    .map((v) => ({
      user_id: v.assigned_to as string,
      vm_id: v.id as string,
      vm_name: (v.name as string | null) || null,
      bot_token: v.telegram_bot_token as string,
      chat_id: String(v.telegram_chat_id),
    }));

  console.log(`backfill-telegram-handles: candidates=${candidates.length}`);

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, candidates: 0, captured: 0 });
  }

  // Concurrency-limited fan-out.
  const results: CaptureResult[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const i = cursor++;
      const r = await captureOne(candidates[i]);
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const captured = results.filter((r) => r.status === "captured").length;
  const noUsername = results.filter((r) => r.status === "no_username").length;
  const errored = results.filter((r) => r.status === "telegram_error" || r.status === "db_error").length;

  console.log(
    `backfill-telegram-handles: candidates=${candidates.length} captured=${captured} no_username=${noUsername} errored=${errored}`,
  );

  if (errored > 0) {
    for (const r of results.filter((rr) => rr.status === "telegram_error" || rr.status === "db_error")) {
      console.error(`backfill-telegram-handles ALERT: vm=${r.vm_name} status=${r.status} detail=${r.detail || ""}`);
    }
  }

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    captured,
    no_username: noUsername,
    errored,
    sample: results.slice(0, 5).map((r) => ({
      vm: r.vm_name,
      status: r.status,
      username: r.username,
    })),
  });
}
