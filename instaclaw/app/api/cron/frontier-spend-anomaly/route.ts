/**
 * cron/frontier-spend-anomaly — per-VM UNCONSENTED-spend anomaly visibility (red-team F5).
 *
 * `frontier-spend-health` watches the RAILS (settle-failure spike, stuck holds) at fleet
 * aggregate. This watches BEHAVIOR per VM: "an agent spending its human's real money, and
 * nobody is watching at 3am." The signal is consent-graded (lib/frontier-spend-anomaly):
 * post-F2 every travel booking is session-approved (a human approved it in a browser) and is
 * NOT an anomaly; the risk is UNCONSENTED spend — autonomous (the agent alone) or forgeable
 * (the raw human_approved bool a compromised agent can set). We alarm only on unconsented $,
 * via a dual condition (an absolute floor AND a single-large-or-burst trigger) so a legitimate
 * human-approved booking spree never pages (fintech anti-false-positive discipline).
 *
 * Per-VM, 6h-deduped via instaclaw_admin_alert_log (key `frontier-spend-anomaly:<vm_id>`).
 * `?dryRun=true` computes + returns every VM verdict WITHOUT alerting — a safe prod spot-check
 * and the decision-level live-probe surface.
 *
 * Thresholds are env-overridable (FRONTIER_ANOMALY_*), defaults in lib/frontier-spend-anomaly.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { sendAdminAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";
import {
  evaluateSpendAnomaly,
  DEFAULT_ANOMALY_THRESHOLDS,
  type AnomalyThresholds,
  type AnomalyTxnRow,
  type AnomalyVerdict,
} from "@/lib/frontier-spend-anomaly";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HOUR_MS = 60 * 60 * 1000;
const ALERT_COOLDOWN_HOURS = 6;
type SB = ReturnType<typeof getSupabase>;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function thresholdsFromEnv(): AnomalyThresholds {
  const d = DEFAULT_ANOMALY_THRESHOLDS;
  return {
    windowMs: numEnv("FRONTIER_ANOMALY_WINDOW_MS", d.windowMs),
    holdTtlMs: d.holdTtlMs,
    floorUsd: numEnv("FRONTIER_ANOMALY_FLOOR_USD", d.floorUsd),
    singleLargeUsd: numEnv("FRONTIER_ANOMALY_SINGLE_USD", d.singleLargeUsd),
    burstSumUsd: numEnv("FRONTIER_ANOMALY_BURST_SUM_USD", d.burstSumUsd),
    burstCount: numEnv("FRONTIER_ANOMALY_BURST_COUNT", d.burstCount),
  };
}

interface SpendRow extends AnomalyTxnRow {
  vm_id: string;
}

async function canAlert(sb: SB, key: string, nowMs: number): Promise<boolean> {
  const cooldownAgoIso = new Date(nowMs - ALERT_COOLDOWN_HOURS * HOUR_MS).toISOString();
  const { data } = await sb
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", key)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  return !(data && data.length > 0);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";
  const sb = getSupabase();
  const nowMs = Date.now();
  const t = thresholdsFromEnv();
  const windowAgoIso = new Date(nowMs - t.windowMs).toISOString();

  // Pull this window's committed-or-pending spends across the fleet. Bounded by the 1h
  // window; only the columns the pure logic + alert context need.
  const { data: rows, error } = await sb
    .from("frontier_transactions")
    .select("vm_id, amount_usdc, status, created_at, metadata")
    .eq("direction", "spend")
    .in("status", ["settled", "pending"])
    .gte("created_at", windowAgoIso);

  if (error) {
    logger.error("frontier-spend-anomaly query failed", { error: error.message, code: error.code });
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }

  // Group by vm_id.
  const byVm = new Map<string, SpendRow[]>();
  for (const r of (rows ?? []) as SpendRow[]) {
    if (!r.vm_id) continue;
    const arr = byVm.get(r.vm_id);
    if (arr) arr.push(r);
    else byVm.set(r.vm_id, [r]);
  }

  const flagged: Array<{ vmId: string; verdict: AnomalyVerdict }> = [];
  for (const [vmId, vmRows] of byVm) {
    const verdict = evaluateSpendAnomaly(vmRows, nowMs, t);
    if (verdict.flagged) flagged.push({ vmId, verdict });
  }

  const fired: string[] = [];
  for (const { vmId, verdict } of flagged) {
    const key = `frontier-spend-anomaly:${vmId}`;
    const may = dryRun ? true : await canAlert(sb, key, nowMs);
    if (!may) continue;

    // VM + owner context for triage (best-effort).
    let vmName = vmId;
    let ownerEmail = "(unknown)";
    try {
      const { data: vm } = await sb
        .from("instaclaw_vms")
        .select("name, assigned_to")
        .eq("id", vmId)
        .maybeSingle();
      if (vm?.name) vmName = vm.name as string;
      if (vm?.assigned_to) {
        const { data: u } = await sb.from("instaclaw_users").select("email").eq("id", vm.assigned_to).maybeSingle();
        if (u?.email) ownerEmail = u.email as string;
      }
    } catch {
      /* best-effort context */
    }

    const subject = `[P1] Frontier spend anomaly — ${vmName} $${verdict.unconsentedSumUsd.toFixed(2)} unconsented (${verdict.reason})`;
    const body =
      `cron/frontier-spend-anomaly flagged a VM spending its owner's money WITHOUT human\n` +
      `consent at an unusual rate in the last ${(t.windowMs / HOUR_MS).toFixed(0)}h.\n\n` +
      `VM:              ${vmName} (${vmId})\n` +
      `Owner:           ${ownerEmail}\n` +
      `Trigger:         ${verdict.reason}\n` +
      `Unconsented:     $${verdict.unconsentedSumUsd.toFixed(2)} across ${verdict.unconsentedCount} spend(s)\n` +
      `Largest single:  $${verdict.largestUnconsentedUsd.toFixed(2)} (single-large threshold $${t.singleLargeUsd})\n` +
      `Session (OK):    $${verdict.sessionSumUsd.toFixed(2)} (human-approved in-browser — excluded from the signal)\n\n` +
      `WHAT THIS MEANS\n` +
      `"Unconsented" = autonomous (the agent decided alone) + forgeable (the raw human_approved\n` +
      `bool, which a prompt-injected / token-stolen agent can set itself). Session-approved spend\n` +
      `is EXCLUDED — a real human approved each in a browser. So this is the signal for an agent\n` +
      `spending unusually on its own, the 3am-nobody-watching case.\n\n` +
      `OPERATOR ACTIONS\n` +
      `1. Inspect the VM's recent spend + its agent's session for prompt injection / odd tasks:\n` +
      `   SELECT amount_usdc, status, created_at, metadata FROM frontier_transactions\n` +
      `     WHERE vm_id='${vmId}' AND direction='spend' AND created_at > now() - interval '${(t.windowMs / HOUR_MS).toFixed(0)} hours'\n` +
      `     ORDER BY created_at DESC;\n` +
      `2. If compromise is suspected, disable spend NOW (fail-safe): set\n` +
      `   instaclaw_vms.frontier_spend_enabled=false for ${vmId} (the gate then denies every spend).\n` +
      `3. Cross-check the owner — a legitimate burst is possible; the consent-grading means this is\n` +
      `   genuinely UNCONSENTED spend, but the owner may have a forged-but-intended automation.\n\n` +
      `Suppressed for ${ALERT_COOLDOWN_HOURS}h for this VM after this alert.`;

    if (!dryRun) {
      await sb.from("instaclaw_admin_alert_log").insert({
        alert_key: key,
        vm_count: 1,
        details: `${verdict.reason} $${verdict.unconsentedSumUsd.toFixed(2)} x${verdict.unconsentedCount}`,
      });
      await sendAdminAlertEmail(subject, body);
    }
    fired.push(vmName);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    scanned_vms: byVm.size,
    window_h: t.windowMs / HOUR_MS,
    thresholds: t,
    flagged: flagged.map((f) => ({ vm_id: f.vmId, ...f.verdict })),
    fired,
  });
}
