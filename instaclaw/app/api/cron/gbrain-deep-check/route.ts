/**
 * GET /api/cron/gbrain-deep-check
 *
 * Hourly deep end-to-end health check for the gbrain HTTP sidecar (Rule 35).
 *
 * Different cron from /api/cron/gbrain-coverage-check (May 12) — that one is
 * a SHALLOW presence/install detector that probes `gbrain --version` +
 * `openclaw mcp show gbrain` + env var presence. It's fast (~3s/VM, no LLM
 * calls) and runs every 30 min to track install rollout.
 *
 * This cron is the DEEP complement — it runs the production verify script
 * (lib/gbrain-deep-check.ts → scripts/verify-gbrain-mcp.py) against each VM
 * with gbrain installed, doing a real put_page → get_page roundtrip via the
 * per-VM Bearer. Catches:
 *   - PGLite schema corruption (sidecar UP but INSERTs fail)
 *   - Bearer token drift (file ≠ DB row)
 *   - Embedding dimension mismatch (every put_page errors at embed)
 *   - OpenAI key revocation
 *   - Sidecar worker thread crash (sibling still answers /health)
 *
 * Cost: ~$0.62/day at hourly cadence for 200 edge_city VMs (~$0.00013 per
 * OpenAI embed × 4800 checks). See design doc §5.
 *
 * Operational mode:
 *   - GBRAIN_DEEP_CHECK_ENABLED != "true" (default) → noop, returns
 *     {skipped:"disabled"}. Lands in code without firing until Cooper
 *     flips the flag in Vercel env.
 *   - GBRAIN_DEEP_CHECK_ENABLED == "true" → executes the batch.
 *
 * Schema dependency: instaclaw_gbrain_health_log table + 3 columns on
 * instaclaw_vms (gbrain_last_check_at, gbrain_last_check_status,
 * gbrain_consecutive_failures). Migration is in supabase/pending_migrations/
 * per Rule 56 — Cooper must `supabase db push` BEFORE flipping
 * GBRAIN_DEEP_CHECK_ENABLED, otherwise INSERTs/UPDATEs error.
 *
 * Design doc:    instaclaw/docs/prd/gbrain-coverage-cron-2026-05-16.md
 * Predecessor:   PRD §10 P2 in instaclaw/docs/prd/gbrain-fleet-rollout-2026-05-12.md
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { connectSSH } from "@/lib/ssh";
import { checkGbrainDeepHealth, type DeepCheckResult } from "@/lib/gbrain-deep-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// verify-gbrain-mcp.py makes 3-5 HTTP calls inside a wall-clock-bounded loop
// PLUS an OpenAI embed call. At batch_size=10 sequential × ~5s/VM = ~50s.
// Set ceiling to 300 (Rule 11) to absorb tail SSH latency.
export const maxDuration = 300;

const CRON_NAME = "gbrain-deep-check";
const CRON_LOCK_TTL_SECONDS = 600; // > maxDuration so we never release early
const BATCH_SIZE = 10;
const STALE_AFTER_MINUTES = 50; // hourly cadence means consecutive ticks shouldn't re-check
const COOLDOWN_HOURS = 6;
const ESCALATION_COOLDOWN_HOURS = 24;
const ESCALATION_THRESHOLD = 3; // consecutive failures before P0 page-class alert
const COVERAGE_ALLOWLIST: string[] = ["edge_city"];

interface ProbeOutcome {
  vmId: string;
  vmName: string;
  result: DeepCheckResult;
  /** New value of consecutive_failures AFTER this tick (0 on ok, prev+1 on fail). */
  consecutiveFailuresAfter: number;
  /** Did this tick cause an escalation (consecutive_failures crossed the threshold)? */
  escalated: boolean;
  /** Was an alert email sent on this tick (false if deduped or status=ok). */
  alertSent: boolean;
}

async function probeAndRecord(supabase: ReturnType<typeof getSupabase>, vm: any): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = {
    vmId: vm.id,
    vmName: vm.name,
    result: { status: "skipped", skipReason: "init", latencyMs: 0, markerTs: "", details: {} },
    consecutiveFailuresAfter: vm.gbrain_consecutive_failures ?? 0,
    escalated: false,
    alertSent: false,
  };

  let ssh;
  try {
    ssh = await connectSSH(vm);
  } catch (e: any) {
    outcome.result = {
      status: "skipped",
      skipReason: `ssh_connect_failed:${String(e?.message ?? e).slice(0, 100)}`,
      latencyMs: 0,
      markerTs: String(Date.now()),
      details: {},
    };
    await recordOutcome(supabase, outcome, vm);
    return outcome;
  }

  try {
    outcome.result = await checkGbrainDeepHealth(ssh);
  } catch (e: any) {
    // checkGbrainDeepHealth never throws per its contract, but defense in
    // depth — if it ever does, log and continue rather than crash the batch.
    outcome.result = {
      status: "skipped",
      skipReason: `check_threw:${String(e?.message ?? e).slice(0, 100)}`,
      latencyMs: 0,
      markerTs: String(Date.now()),
      details: {},
    };
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }

  // Update rolling state on the VM row + insert audit row.
  await recordOutcome(supabase, outcome, vm);

  // Alert dispatch (only on fail; skipped doesn't escalate).
  if (outcome.result.status === "fail") {
    const sent = await maybeFireAlert(supabase, outcome, vm);
    outcome.alertSent = sent.fired;
    outcome.escalated = sent.escalated;
  }

  return outcome;
}

async function recordOutcome(
  supabase: ReturnType<typeof getSupabase>,
  outcome: ProbeOutcome,
  vm: any,
): Promise<void> {
  const r = outcome.result;

  // 1. Append to audit log (best-effort).
  try {
    await supabase.from("instaclaw_gbrain_health_log").insert({
      vm_id: vm.id,
      status: r.status,
      fail_code: r.status === "fail" ? r.failCode : r.status === "skipped" ? r.skipReason : null,
      latency_ms: r.status === "skipped" && r.latencyMs === 0 ? null : r.latencyMs,
      marker_ts: r.markerTs || null,
      details_json: { ...r.details, ...(r.rawOutput ? { raw_output: r.rawOutput } : {}) },
    });
  } catch (e: any) {
    logger.error("gbrain-deep-check: audit-log insert failed", {
      route: `cron/${CRON_NAME}`,
      vm_name: vm.name,
      error: String(e?.message ?? e),
    });
  }

  // 2. Update rolling state on the VM row.
  //    - status=ok      → reset consecutive_failures to 0
  //    - status=fail    → increment consecutive_failures
  //    - status=skipped → leave consecutive_failures unchanged (transient cron-side issue,
  //                       not a VM-side failure). Still update gbrain_last_check_at to
  //                       prevent re-pick-up next cycle (else we'd hammer unreachable VMs).
  let newConsecutive: number;
  if (r.status === "ok") newConsecutive = 0;
  else if (r.status === "fail") newConsecutive = (vm.gbrain_consecutive_failures ?? 0) + 1;
  else newConsecutive = vm.gbrain_consecutive_failures ?? 0;
  outcome.consecutiveFailuresAfter = newConsecutive;

  try {
    await supabase
      .from("instaclaw_vms")
      .update({
        gbrain_last_check_at: new Date().toISOString(),
        gbrain_last_check_status: r.status,
        gbrain_consecutive_failures: newConsecutive,
      })
      .eq("id", vm.id);
  } catch (e: any) {
    logger.error("gbrain-deep-check: rolling-state update failed", {
      route: `cron/${CRON_NAME}`,
      vm_name: vm.name,
      error: String(e?.message ?? e),
    });
  }
}

async function maybeFireAlert(
  supabase: ReturnType<typeof getSupabase>,
  outcome: ProbeOutcome,
  vm: any,
): Promise<{ fired: boolean; escalated: boolean }> {
  const r = outcome.result;
  if (r.status !== "fail" || !r.failCode) return { fired: false, escalated: false };

  // Two layers:
  //   A. Per-(vm, fail_code) standard alert — 6h dedup.
  //   B. Per-vm escalation alert at ≥3 consecutive failures — 24h dedup,
  //      P0-class subject. Fires REGARDLESS of standard cooldown so an
  //      ongoing incident still pages.
  const escalated = outcome.consecutiveFailuresAfter >= ESCALATION_THRESHOLD;

  const stdKey = `${CRON_NAME}:${vm.id}:${r.failCode}`;
  const escKey = `${CRON_NAME}-escalated:${vm.id}`;
  const stdCooldownIso = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
  const escCooldownIso = new Date(Date.now() - ESCALATION_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

  const [stdRecentRes, escRecentRes] = await Promise.all([
    supabase.from("instaclaw_admin_alert_log").select("id").eq("alert_key", stdKey).gte("sent_at", stdCooldownIso).limit(1),
    supabase.from("instaclaw_admin_alert_log").select("id").eq("alert_key", escKey).gte("sent_at", escCooldownIso).limit(1),
  ]);
  const stdInCooldown = (stdRecentRes.data?.length ?? 0) > 0;
  const escInCooldown = (escRecentRes.data?.length ?? 0) > 0;

  // Decide which alert (if any) to fire.
  let fire: "escalated" | "standard" | null = null;
  if (escalated && !escInCooldown) fire = "escalated";
  else if (!escalated && !stdInCooldown) fire = "standard";

  if (!fire) {
    // Suppressed by cooldown. Still log to audit table so operators can see
    // the suppression vs. genuine first-fire.
    const key = escalated ? escKey : stdKey;
    await supabase.from("instaclaw_admin_alert_log").insert({
      alert_key: key,
      vm_count: 1,
      details: `suppressed (dedup): ${vm.name} fail_code=${r.failCode} consec=${outcome.consecutiveFailuresAfter}`,
    });
    return { fired: false, escalated };
  }

  const subject = fire === "escalated"
    ? `[InstaClaw P0] gbrain DEEP HEALTH FAIL (3+ consecutive) on ${vm.name} — ${r.failCode}`
    : `[InstaClaw P2] gbrain deep-check fail on ${vm.name} — ${r.failCode}`;
  const body = [
    `VM: ${vm.name} (${vm.ip_address})`,
    `Partner: ${vm.partner}`,
    `Fail code: ${r.failCode}`,
    `Consecutive failures: ${outcome.consecutiveFailuresAfter}`,
    `Marker ts: ${r.markerTs}`,
    `Latency: ${r.latencyMs}ms`,
    ``,
    `Details:`,
    ...Object.entries(r.details).map(([k, v]) => `  ${k} = ${v}`),
    ``,
    r.rawOutput ? `Raw output (first 500 chars):\n${r.rawOutput}` : "",
    ``,
    `Operator triage:`,
    `  1. SSH into the VM and re-run the verify script manually:`,
    `       ssh openclaw@${vm.ip_address}`,
    `       TOKEN=$(cat ~/.gbrain/openclaw-bearer-token.txt)`,
    `       GBRAIN_BEARER_TOKEN=$TOKEN MARKER_TS=$(date +%s) python3 /tmp/verify-gbrain-mcp.py`,
    `  2. Check sidecar journal for crashes / OOM:`,
    `       journalctl --user -u gbrain.service --since '1 hour ago' | tail -100`,
    `  3. If fail_code is INIT_HTTP_ERROR or HEALTH_UNREACHABLE → sidecar may have died.`,
    `       systemctl --user is-active gbrain.service`,
    `       systemctl --user restart gbrain.service   # SIGKILL semantics (Rule 35)`,
    `  4. If fail_code is AUTH_401 → bearer drift.`,
    `       Compare ~/.gbrain/openclaw-bearer-token.txt sha256 against access_tokens table.`,
    `  5. If fail_code is PUT_HTTP_ERROR with OpenAI mentioned → key revoked or rate-limited.`,
    `       Check GBRAIN_OPENAI_API_KEY in ~/.openclaw/.env vs Vercel env.`,
    ``,
    `Next ${fire === "escalated" ? "escalation " : ""}alert for THIS VM+code suppressed for ${fire === "escalated" ? ESCALATION_COOLDOWN_HOURS : COOLDOWN_HOURS}h.`,
    fire === "escalated"
      ? `Standard alerts continue to fire independently (per-fail-code dedup).`
      : `Escalation alert will fire independently if consecutive_failures reaches ${ESCALATION_THRESHOLD}.`,
  ].filter(Boolean).join("\n");

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: fire === "escalated" ? escKey : stdKey,
    vm_count: 1,
    details: `${fire}: ${vm.name} fail_code=${r.failCode} consec=${outcome.consecutiveFailuresAfter}`,
  });
  await sendAdminAlertEmail(subject, body).catch((e) => {
    logger.error("gbrain-deep-check: email send failed", {
      route: `cron/${CRON_NAME}`,
      vm_name: vm.name,
      error: String(e?.message ?? e),
    });
  });

  return { fired: true, escalated };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Feature flag — code lands but is silent until Cooper flips it AND has
  // applied the supabase/pending_migrations/20260516175000_gbrain_coverage_schema.sql.
  if (process.env.GBRAIN_DEEP_CHECK_ENABLED !== "true") {
    return NextResponse.json({ skipped: "disabled" });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("gbrain-deep-check: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  try {
    const supabase = getSupabase();
    const staleCutoffIso = new Date(Date.now() - STALE_AFTER_MINUTES * 60_000).toISOString();

    // Rule 19: .select("*") for safety-critical reads. The probe drives
    // SSH writes (/tmp upload) + DB writes (audit log + rolling state).
    const { data: candidatesRaw, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .in("partner", COVERAGE_ALLOWLIST)
      .eq("status", "assigned")
      .eq("health_status", "healthy")
      .or(`gbrain_last_check_at.is.null,gbrain_last_check_at.lt.${staleCutoffIso}`)
      .order("gbrain_last_check_at", { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);

    if (queryErr) {
      logger.error("gbrain-deep-check: candidate query failed", {
        route: `cron/${CRON_NAME}`,
        error: queryErr.message,
      });
      return NextResponse.json({ error: "query_failed", details: queryErr.message }, { status: 500 });
    }

    const candidates = (candidatesRaw ?? []) as any[];
    if (candidates.length === 0) {
      logger.info("gbrain-deep-check: no candidates (all VMs recently checked, or empty allowlist)", {
        route: `cron/${CRON_NAME}`,
        allowlist: COVERAGE_ALLOWLIST,
        stale_cutoff_minutes: STALE_AFTER_MINUTES,
      });
      return NextResponse.json({ ok: true, checked: 0, allowlist: COVERAGE_ALLOWLIST });
    }

    // Sequential per-VM. Concurrent SSH adds connection-pool stress for
    // minimal wall-clock win at batch=10 (~50s vs ~17s). Predictability
    // matters more than speed for a low-frequency cron.
    const outcomes: ProbeOutcome[] = [];
    for (const vm of candidates) {
      try {
        outcomes.push(await probeAndRecord(supabase, vm));
      } catch (e: any) {
        // Per-VM isolation: one VM's failure can't kill the batch.
        logger.error("gbrain-deep-check: probe threw uncaught", {
          route: `cron/${CRON_NAME}`,
          vm_name: vm.name,
          error: String(e?.message ?? e),
        });
        outcomes.push({
          vmId: vm.id,
          vmName: vm.name,
          result: {
            status: "skipped",
            skipReason: `outer_throw:${String(e?.message ?? e).slice(0, 100)}`,
            latencyMs: 0,
            markerTs: String(Date.now()),
            details: {},
          },
          consecutiveFailuresAfter: vm.gbrain_consecutive_failures ?? 0,
          escalated: false,
          alertSent: false,
        });
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const ok = outcomes.filter((o) => o.result.status === "ok").length;
    const fail = outcomes.filter((o) => o.result.status === "fail").length;
    const skipped = outcomes.filter((o) => o.result.status === "skipped").length;
    const escalated = outcomes.filter((o) => o.escalated).length;
    const alertsSent = outcomes.filter((o) => o.alertSent).length;

    logger.info("gbrain-deep-check: tick complete", {
      route: `cron/${CRON_NAME}`,
      checked: outcomes.length,
      ok, fail, skipped, escalated, alerts_sent: alertsSent,
      elapsed_ms: elapsedMs,
    });

    return NextResponse.json({
      ok: true,
      checked: outcomes.length,
      summary: { ok, fail, skipped, escalated, alerts_sent: alertsSent },
      results: outcomes.map((o) => ({
        vm: o.vmName,
        status: o.result.status,
        fail_code: o.result.failCode,
        skip_reason: o.result.skipReason,
        latency_ms: o.result.latencyMs,
        consec_failures: o.consecutiveFailuresAfter,
        escalated: o.escalated,
        alert_sent: o.alertSent,
      })),
      elapsed_ms: elapsedMs,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("gbrain-deep-check: unhandled error", {
      route: `cron/${CRON_NAME}`,
      error: msg,
    });
    return NextResponse.json({ error: "unhandled", details: msg }, { status: 500 });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
