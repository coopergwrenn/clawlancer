/**
 * GET /api/cron/sample-operator-audit
 *
 * Daily 5% transparency sample. For each edge_city user with operator activity
 * in the last 24h, picks a random sample (≥1, ≤20) of their audit rows and
 * emails it. Skips users with zero activity.
 *
 * Auth: Bearer CRON_SECRET. Schedule: 0 12 * * * (noon UTC daily).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { sendOperatorAuditSampleEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SAMPLE_RATE = 0.05;
const SAMPLE_MIN = 1;
const SAMPLE_MAX = 20;
const WINDOW_HOURS = 24;

interface AuditRow {
  user_id: string;
  command: string;
  decision: string;
  created_at: string;
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const sinceIso = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  // TODO(privacy-v0-followup): per QA-2026-05-02 #6, this query has no
  // .limit() and will OOM the function at scale. v0 traffic is tiny
  // (5 edge_city VMs, low command volume), but v1 should iterate user-by-
  // user with a per-user .limit() and order_by created_at DESC, or use a
  // Postgres-side TABLESAMPLE to do the 5% sampling without loading the
  // full 24h window into memory.
  const { data: rows, error: selectErr } = await supabase
    .from("instaclaw_operator_audit_log")
    .select("user_id, command, decision, created_at")
    .gte("created_at", sinceIso);

  if (selectErr) {
    logger.error("sample-operator-audit select failed", { error: selectErr.message });
    return NextResponse.json({ error: "Select failed" }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ users_emailed: 0, total_rows: 0 });
  }

  const byUser = new Map<string, AuditRow[]>();
  for (const r of rows as AuditRow[]) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id)!.push(r);
  }

  const userIds = Array.from(byUser.keys());
  const { data: users } = await supabase
    .from("instaclaw_users")
    .select("id, email")
    .in("id", userIds);

  const emailById = new Map<string, string>(
    (users ?? []).filter((u) => u.email).map((u) => [u.id, u.email as string])
  );

  let emailed = 0;
  let failures = 0;
  for (const [userId, userRows] of byUser.entries()) {
    const email = emailById.get(userId);
    if (!email) continue;
    const sampleSize = Math.max(SAMPLE_MIN, Math.min(SAMPLE_MAX, Math.ceil(userRows.length * SAMPLE_RATE)));
    const samples = pickRandom(userRows, sampleSize).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    try {
      await sendOperatorAuditSampleEmail(email, userRows.length, samples);
      emailed++;
    } catch (e) {
      failures++;
      logger.error("sample-operator-audit email failed", {
        userId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logger.info("sample-operator-audit complete", {
    users_emailed: emailed,
    failures,
    total_rows: rows.length,
  });
  return NextResponse.json({
    users_emailed: emailed,
    failures,
    total_rows: rows.length,
  });
}
