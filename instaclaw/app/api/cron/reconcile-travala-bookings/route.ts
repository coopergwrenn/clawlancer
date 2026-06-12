/**
 * reconcile-travala-bookings — the recovery net for paid-but-unrecorded Travala
 * bookings (Rule-22 class: a real, paid booking with no row is uncancellable
 * through the agent). Cross-references settled 'travala'-tagged frontier spends
 * against booking rows; any paid spend older than the record grace window with no
 * matching booking row is a paid-but-unrecorded booking → admin alert (deduped).
 *
 * Read-only + alert-only by design: it does NOT auto-insert rows (recovery is
 * agent/operator-driven via travala-book.mjs --retry, which re-checks book-status
 * and re-records). Surfacing the gap is the job here — the immediate signal is the
 * book-record route's own alert; this cron catches anything that slipped past it.
 *
 * Auth: Vercel-cron bearer (CRON_SECRET), same as the other crons.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { isTravalaSpend, TRAVALA_BOOKINGS_TABLE } from "@/lib/travala-bookings";
import { sendPerVmAlertDeduped } from "@/lib/admin-alert";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GRACE_MIN = 30; // a spend settled <30m ago may still be mid-record (book-record runs after settle)
const LOOKBACK_DAYS = 7; // don't chase ancient spends forever (the 24h dedup also guards repeats)

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = getSupabase();
  const now = Date.now();
  const olderThan = new Date(now - GRACE_MIN * 60 * 1000).toISOString();
  const since = new Date(now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Settled, money-moved spends in the window. category=travel is the cheap DB
  // pre-filter; isTravalaSpend (the 'travala' tag) is the precise confirm.
  // NOTE: 'success'/'disputed' are the money-moved terminal states; confirm
  // against the first real settle that these are the literal status values.
  const { data: spends, error } = await supabase
    .from("frontier_transactions")
    .select("id, request_id, vm_id, amount_usdc, status, metadata, created_at")
    .eq("direction", "spend")
    .in("status", ["success", "disputed"])
    .eq("metadata->>category", "travel")
    .lt("created_at", olderThan)
    .gt("created_at", since)
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const travala = (spends ?? []).filter((s) => isTravalaSpend((s as { metadata: unknown }).metadata));
  let checked = 0;
  let unrecorded = 0;
  let alerted = 0;
  for (const s of travala) {
    checked++;
    const sp = s as { id: string; request_id: string | null; vm_id: string; amount_usdc: unknown; created_at: string };
    // recorded iff a booking row references this hold (id) or its request_id.
    const ors = [`hold_id.eq.${sp.id}`];
    if (sp.request_id) ors.push(`request_id.eq.${sp.request_id}`);
    const { data: rows } = await supabase
      .from(TRAVALA_BOOKINGS_TABLE)
      .select("id")
      .or(ors.join(","))
      .limit(1);
    if (rows && rows.length > 0) continue;
    unrecorded++;
    const res = await sendPerVmAlertDeduped({
      alertKey: `travala_unrecorded:${sp.id}`,
      subject: `[P1] Paid Travala booking with NO record (hold ${sp.id.slice(0, 8)})`,
      body:
        `A settled Travala spend has no booking row — a paid-but-unrecorded booking ` +
        `(uncancellable through the agent).\n\n` +
        `hold_id: ${sp.id}\nrequest_id: ${sp.request_id ?? "none"}\nvm_id: ${sp.vm_id}\n` +
        `amount_usdc: ${sp.amount_usdc}\nsettled: ${sp.created_at}\n\n` +
        `Recovery: travala-book.mjs --retry on the VM (re-checks book-status + re-records), ` +
        `or manual insert into ${TRAVALA_BOOKINGS_TABLE}.`,
      dedupHours: 24,
    }).catch(() => "failed" as const);
    if (res === "sent") alerted++;
  }

  return NextResponse.json({
    ok: true,
    scanned: (spends ?? []).length,
    travala: travala.length,
    checked,
    unrecorded,
    alerted,
  });
}
