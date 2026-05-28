// ─── @vercel/nft cache-bust: 2026-05-17 03:xx UTC ─────────────────────────
// Forces re-trace after v101 stale-bundle recurrence (stale_bundle:9a4afc5c8d0e5348
// fired 4x in 24h at 6h cadence — most recent 2026-05-16 19:27 UTC). v101
// manifest bumped 2026-05-16 19:07 EDT (commit 48af5075) but Vercel bundle
// kept serving v100; integrity check halted reconcile-fleet, only 6/149 VMs
// advanced to cv=101 over ~5h. Manual touch + push needed because husky
// pre-commit hook didn't fire on the orphan-tool_use commit. Pre-bake-check
// found via scripts/_pre-bake-check.ts on 2026-05-16 (T-7 days before v101
// bake on 5/23). Re-add on future incidents.

// ─── @vercel/nft cache-bust: 2026-05-15 16:30 UTC ─────────────────────────
// Forces re-trace after v100 stale-bundle halt (stale_bundle:9a4afc5c8d0e5348,
// fired 15:12 UTC). Runtime bundle was at v99 while main has v100. Rule 44
// gate (line ~226) halted every tick for ~80 min. Re-add on future incidents.

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { auditVMConfig } from "@/lib/ssh";
import { VM_MANIFEST } from "@/lib/vm-manifest";
import { SECRET_VERSION } from "@/lib/vm-reconcile";
import { verifyManifestFreshness, manifestFingerprint } from "@/lib/manifest-integrity";
import { sendAdminAlertEmail } from "@/lib/email";
import * as crypto from "crypto";

/**
 * Rule 40 — extract reconciler step names from error strings.
 *
 * Most reconciler errors are formatted "step-tag: details" (e.g.
 *   "config-set verify-after-set mismatch: messages.streaming.mode ..."
 *   "instaclaw-xmtp: surgical fix failed: state=activating NRestarts=19736"
 *   "node_exporter: port did not open ()"
 *   "file ~/.openclaw/scripts/strip-thinking.py: ..."
 * ). The token before the first ':' is the step tag. We deduplicate +
 * cap at 6 so a multi-step failure doesn't blow up the log payload.
 */
function extractFailingSteps(errors: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const err of errors) {
    const colon = err.indexOf(":");
    let tag: string;
    if (colon > 0 && colon < 80) {
      tag = err.slice(0, colon).trim();
    } else {
      // Fallback: first 3 words.
      tag = err.split(/\s+/).slice(0, 3).join(" ").slice(0, 40);
    }
    if (tag) tags.add(tag);
    if (tags.size >= 6) break;
  }
  return Array.from(tags);
}

// ─── Vercel cron config ────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
// 2026-05-15: bumped 300s → 600s after confirming Fluid Compute is enabled on
// the instaclaw Vercel project (resourceConfig.fluid=true, verified via
// /v9/projects API). Fluid Compute on Vercel Pro lifts the per-function
// timeout ceiling from 300s to 800s, so the historical Rule 11 constant
// (300s) was a conservative floor, not a hard limit. The 32 cv=95 cohort P0
// (2026-05-15) measured cv=95→cv=100 first-time-through reconciles at
// 213-248s. The previous 300s ceiling with PER_VM_TIMEOUT_MS=220s gave
// effectively 0s of safety margin; vm-893 (248.3s observed) was guaranteed
// to time out every cron tick. Bumping to 600s lifts the ceiling far enough
// that future manifest growth has room before the next regression.
//
// Coordination invariant: PER_VM_TIMEOUT_MS < maxDuration < LOCK_TTL_SECONDS.
// 500_000 < 600_000 < 660_000. The 60s buffer between maxDuration and
// LOCK_TTL_SECONDS prevents lock-expiry races (lock outlives the function
// invocation so the next cron tick can never start a parallel batch).
export const maxDuration = 600;

// ─── Constants ─────────────────────────────────────────────────────────────

const CRON_NAME = "reconcile-fleet";
const LOCK_TTL_SECONDS = 660; // > maxDuration with 60s headroom (was 360 when maxDuration=300)
// 2026-05-05: dropped 10 → 3 to fit under Vercel 300s maxDuration.
// Per-VM cost on stale cohort (cv=82) is ~150-300s after v87 added
// stepPrctlSubreaper (180s npm install + node-gyp) and v88 added
// build-essential to stepSystemPackages. Batch of 10 was hitting
// FUNCTION_INVOCATION_TIMEOUT and only the first VM was getting cv-bumped.
// 3 × ~300s worst case fits within budget. Throughput 60/hr (was nominally
// 200/hr but actual was ~20/hr due to timeouts).
//
// Cache-bust touch 2026-05-05 23:50 UTC: editing this file forces Vercel to
// re-run @vercel/nft on this route, which is the only way to pick up the
// outputFileTracingIncludes glob change in next.config.ts (commits 3f3443d2
// → cb4d20c3 → 48c98a93). Build cache key is per-route source file, not
// config — local builds picked up the change immediately, but every Vercel
// deploy was restoring the old route.js.nft.json. Touch comment is harmless
// and load-bearing; do not remove without re-deploying first.
//
// Cache-bust touch 2026-05-07 19:45 UTC: re-bust to force a fresh nft trace
// after the v90 four-layer reliability fix (commit 7ac0d370) added 7 new
// agents.defaults.compaction.* keys to lib/vm-manifest.ts:configSettings
// (mode, maxActiveTranscriptBytes, recentTurnsPreserve, qualityGuard.enabled,
// qualityGuard.maxRetries, notifyUser, truncateAfterCompaction). Verified on
// vm-648 (the first VM to reconcile to cv=91 post-deploy): strip-thinking.py
// had all 4 new Layer 1+3 sentinels (def compact_session_in_place_lines /
// SESSION COMPACTED: / def _extract_large_tool_results_to_cache /
// LAYER3_EXTRACTED:) but openclaw.json compaction block was the OLD shape
// (only reserveTokensFloor + memoryFlush). The reconciler bundle on Vercel
// was running pre-v90 vm-manifest.ts because Vercel's nft trace was cached
// from before the v90 deploy. Pre-flight test on vm-512 had already
// confirmed all 7 keys are schema-accepted (EXIT:0 each), so this is purely
// a build-cache problem, not a config-validity problem. Same precedent as
// the 2026-05-05 touch above. Once Vercel rebuilds with this comment, the
// next reconcile cycle will pick up the new keys for any VM at cv<91.
// Already-at-v91 VMs (vm-648, vm-043) won't auto-receive Layer 2 until the
// next manifest bump — Layer 1 (the critical nuke-prevention fix) is on
// them and protective regardless.
//
// 2026-05-14: dropped 3 → 1 as part of the PER_VM_TIMEOUT_MS hotfix below.
// At 220s per-VM and 300s Vercel maxDuration, only one VM fits cleanly per
// tick. Fleet drain rate becomes 20 VMs/hour (3-min cron interval × 1
// VM/tick) — ~6h to clear the 142-VM cv=95 cohort that's currently
// completely stuck. Option C (decouple secret_version to its own cron)
// is the proper structural fix and is filed as a follow-up.
const CONFIG_AUDIT_BATCH_SIZE = 1;
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-28 13:17 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-27 22:23 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-26 12:20 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-25 15:49 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-24 13:13 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-23 21:02 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-23 20:29 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-23 20:14 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-23 19:57 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-23 19:16 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-23 16:56 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-22 18:43 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-21 14:16 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-20 21:02 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-20 14:51 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-20 14:14 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-19 21:27 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-19 18:11 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-18 21:54 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-18 17:22 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-18 17:06 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-18 16:10 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-17 22:38 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-16 23:07 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-15 23:47 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-15 23:42 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-15 15:24 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-15 15:07 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-14 19:41 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-14 17:57 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-14 17:16 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-13 16:34 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-12 03:18 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-11 22:14 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-11 20:02 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-11 19:46 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-11 19:24 UTC

// Per-VM hard timeout. A clean reconcile is 30-60s; a stale-cohort
// reconcile is 60-120s. Anything past 120s is almost certainly a slow
// SSH connection, hung command, or unrecoverable VM. Without this cap,
// a single hung VM at the head of the batch can eat the entire 300s
// Vercel budget, leaving the other 2 batch slots unprocessed.
//
// Implementation: Promise.race against a setTimeout reject. The
// in-flight SSH commands continue executing on the VM side after the
// timeout — they just stop being awaited by us. The reconciler is
// designed to be idempotent and the cv bump only happens on full
// success, so an aborted mid-flight reconcile leaves the VM at its
// prior cv and the next cron tick retries naturally.
//
// 2026-05-14: bumped 120s → 220s. v96 SOUL.md V2 rewrite + v99 stepNodeExporter
// textfile-collector additions + v100 PATH fix collectively pushed per-VM
// reconcile workload past the previous 120s budget for the cv=95 cohort
// (142 of 148 healthy assigned VMs). Every per-VM Promise.race hit the
// 120s outer timeout BEFORE reconcileVM's STRICT_DEADLINE_MS=180s could
// return a partial result, so `audited++` and the secret_version bump
// block at line ~432 were unreachable for every VM. Net effect: 0 VMs
// advanced to cv=99/100 in 12+ minutes of cron ticks; 0 VMs bumped to
// secret_version=1.
//
// 2026-05-15: bumped 220s → 500s (FIX-A). P0 cv=95 cohort investigation
// measured cv=95 → cv=100 first-time-through reconcile wall-clock via
// scripts/_diag-cv95-reconcile-one.ts (local execution, no Promise.race):
//   vm-865 (lightest, partner=null, 0 backups): 212.9s — borderline-fit
//   vm-893 (partner=null, 5112 backups):        248.3s — exceeds 220s
// Cumulative work (BRAVE_API_KEY env push, 25 skill SCPs + 54 scripts,
// agentkit-cli + mcporter + usecomputer npm installs, apt build-essential,
// POLYGON_RPC_URL update, v100 systemd override rewrite, gateway restart
// with health verify) legitimately takes 213-250s. 32 paying-customer VMs
// were stranded at cv=95 for 1-3 weeks because every Vercel cron tick
// blew the 220s deadline, threw "per-VM reconcile timeout after 220s",
// and the catch path silently swallowed the error (route.ts:712-723 pre-
// FIX-B path skipped DB failure-tracking writes; counter stayed at 0;
// quarantine at K=10 never tripped; alerts never fired).
//
// Initial fix proposed 220s → 280s (just over observed max). Cooper flagged
// that Vercel Fluid Compute is enabled on the instaclaw project (verified
// via /v9/projects API → resourceConfig.fluid=true). Fluid lifts the
// per-function ceiling to 800s on Pro, so the 300s maxDuration was the
// historical Rule 11 floor, not a hard cap. Bumped maxDuration to 600s
// (above), giving room for PER_VM_TIMEOUT_MS=500s with 100s slack inside
// the function budget. Heaviest observed reconcile today (vm-893 at 248.3s)
// now uses 50% of the budget — comfortable; ~250s of future growth absorbed
// before next breach.
//
// FIX-B (below + at the catch path) closes the silent-bookkeeping-bypass
// so future timeouts surface as visible incidents (counter++, alert at
// counter==1 || quarantine), not invisible fleet rot.
const PER_VM_TIMEOUT_MS = 500_000;

// FIX-A guardrail (2026-05-15): proactive warning threshold. If a successful
// reconcile takes >80% of PER_VM_TIMEOUT_MS (400s at 500s), emit a deduped
// admin alert AND log the wall-clock. Catches drift BEFORE the next manifest
// addition pushes reconcile work over the hard ceiling and silently strands
// VMs (the 2026-05-15 P0 pattern was discovered post-hoc, weeks late — this
// alert ensures the next regression fires immediately at first encounter).
//
// Why 80%: gives 100s of headroom over the warning. Reconcile time would
// need to grow ~150s over today's heaviest VM (248.3s → 400s) before the
// warning fires — that's a substantial future regression but still well
// under the ceiling, giving operators clear time to investigate (optimize
// step, bump ceiling further, refactor) before customer impact lands.
//
// Empirical baseline (2026-05-15 cv=95 → cv=100 first-time-through):
//   vm-865 (lightest, partner=null, 0 backups): 212.9s = 42.6% (quiet)
//   vm-893 (partner=null, 5112 backups):        248.3s = 49.7% (quiet)
// Both well under warning threshold. Today's traffic produces no alerts.
// First alerts will fire when sustained reconcile times reach ~400s — a
// meaningful early signal of drift rather than a false-positive on
// normal-but-large catch-up reconciles.
const PER_VM_TIMEOUT_WARN_MS = Math.floor(PER_VM_TIMEOUT_MS * 0.8);

// Auto-quarantine threshold: after K consecutive reconcile failures (cycles
// where pushFailed gate held the cv bump), set reconcile_quarantined_at and
// alert. The eligibility query above filters out quarantined VMs so they
// stop consuming cron cycles. K=10 mirrors the watchdog_consecutive_failures
// threshold (already proven). At /3min cron interval, K=10 means quarantine
// fires after ~30 min of consistent failure — fast enough to surface broken
// VMs, slow enough to absorb single transient errors. Operator manually
// clears reconcile_quarantined_at to re-enable a VM after fixing root cause.
const RECONCILE_QUARANTINE_THRESHOLD = 10;

// 2026-05-17: persistent-failure alert threshold. Sits between the existing
// counter==1 "first fire" early-warning and the counter>=K "auto-quarantine"
// alert. At 3 consecutive failures (~9 min wall-clock on a 3-min cron tick),
// the VM is past transient territory but still 7 cycles ahead of quarantine —
// the right time to flag it for operator attention without waiting 30 min.
// Dedup 12h per-VM so re-fires within the same incident don't spam.
//
// Why this exists: we have a "soft" first-fire alert at counter==1 and a
// "hard" auto-quarantine alert at counter==K=10. In between, counters 2-9
// were silent. The next structural bug (a 23h cron halt, a manifest stale-
// bundle, a step regression) will produce VMs at counter=3-9 for 6-27 min
// before quarantine. This alert turns that window into an operator signal.
const RECONCILE_PERSISTENT_THRESHOLD = 3;
const RECONCILE_PERSISTENT_DEDUP_HOURS = 12;

// 2026-05-17: end-of-cron staleness sweep. Catches VMs the candidate query
// isn't reaching at all — structurally distinct from the per-VM consecutive-
// failure path (those VMs ARE being attempted; they're failing). A VM that
// the batch isn't sweeping will have a stale or NULL reconcile_last_failure_at
// AND a stale config_version. Single deduped summary alert because per-VM
// would spam during the regression class that creates this state.
//
// "BEHIND_BY=5" allows up to 4 manifest bumps of natural lag before alerting
// (since the cron tick rate naturally produces ~1 version of drift mid-bump).
// "ATTEMPT_AGE_HOURS=2" is much larger than the cron's 3-min cadence — a
// VM that hasn't seen a single attempt in 40 cycles is genuinely starved.
const STALENESS_SWEEP_BEHIND_BY = 5;
const STALENESS_SWEEP_ATTEMPT_AGE_HOURS = 2;
const STALENESS_SWEEP_DEDUP_HOURS = 12;

/**
 * Strict-mode allowlist. Comma-separated VM UUIDs. Any VM whose id is in
 * this set is reconciled in strict mode for this cron cycle:
 *   - config set failures are captured (not swallowed by `|| true`)
 *   - a canary round-trip probe runs after writes
 *   - config_version is NOT advanced unless strictErrors=[] and canary passes
 *
 * Empty (default) = zero VMs in strict mode = behavior identical to pre-2c.
 * This is the rollout surface for stages 1/2/3 of the strict-mode migration:
 *   - stage 1: 3 canary VMs
 *   - stage 2: 20 mixed-version VMs
 *   - stage 3: full fleet
 */
function getStrictVmIds(): Set<string> {
  const raw = (process.env.STRICT_RECONCILE_VM_IDS ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

// ─── Route handler ─────────────────────────────────────────────────────────

/**
 * Dedicated fleet reconciler.
 *
 * Purpose: push VM_MANIFEST drift to assigned VMs whose config_version is
 * behind the current manifest version. Previously this lived inside
 * /api/cron/health-check as "Pass 4" but it was starved by the ~10 earlier
 * passes consuming most of the 600s health-check budget — observed throughput
 * was ~1-2 VMs per cron run instead of the configured 10, so backlog clearing
 * took 4-8 hours.
 *
 * This route runs ONLY the audit pass with its own dedicated 300s budget.
 * Same batch size (10), same per-VM logic (auditVMConfig → reconcileVM),
 * same DB update (bump config_version after success). Just isolated.
 *
 * Schedule: every 3 minutes (see vercel.json)
 * Throughput: 10 VMs × 20 cron runs/hour = 200 audits/hour
 * Backlog clear time at 86 stale VMs: ~26 minutes
 */
export async function GET(req: NextRequest) {
  // 1. Auth — same Bearer pattern as all other crons
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Distributed lock — race-safe via instaclaw_cron_locks PK constraint.
  // Without this, two overlapping cron runs (e.g., previous run took 5+ min
  // and a new tick fires) could double-process the same batch.
  const lockAcquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("reconcile-fleet: lock held, skipping", {
      route: "cron/reconcile-fleet",
    });
    return NextResponse.json({ skipped: "lock_held" });
  }

  // 2b. Manifest integrity gate (D.2-A, 2026-05-09).
  //
  // Vercel's @vercel/nft trace cache has shipped stale `vm-manifest.ts`
  // to this route across multiple deploys (5e710334, 16aa97c9, e30c6a78).
  // The pre-v90 incident (20 VMs stuck at cv=91 with old configSettings
  // on disk) is the most expensive instance documented. Reactive
  // touch-route comments are not enough — a bundle that loads stale
  // VM_MANIFEST will sail through the per-step verify-after-set
  // because every key it checks was in the OLD shape too.
  //
  // Verify here, before any cv mutation: fetch the live vm-manifest.ts
  // from main on GitHub (outside the bundle, can't be cached by nft),
  // hash (version + configSettings), compare to runtime. Mismatch =
  // bundle is stale = REFUSE to bump cv this cycle. Release lock and
  // exit; next deploy will rebuild the bundle and the next cron tick
  // will pass the integrity check.
  //
  // GitHub outage / parse error / network timeout = degrade to old
  // behavior (allow cv bump). Better than halting the entire reconcile
  // pipeline on a transient GitHub blip.
  const integrity = await verifyManifestFreshness(manifestFingerprint(VM_MANIFEST));
  if (integrity.ok && !integrity.fresh) {
    logger.error("reconcile-fleet: STALE BUNDLE — refusing to bump cv this cycle", {
      route: "cron/reconcile-fleet",
      runtime_version: integrity.runtime_version,
      remote_version: integrity.remote_version,
      runtime_sha: integrity.runtime_sha,
      remote_sha: integrity.remote_sha,
      diff_summary: integrity.diff_summary,
      action: "REFUSE_CV_BUMP_REASON_STALE_BUNDLE",
    });
    // P0 admin alert (Rule 37/Rule 49 dedup pattern). 6h-deduped via
    // instaclaw_admin_alert_log keyed by `stale_bundle:${remote_sha}` so
    // a single bad deploy doesn't re-alert across the ~20 cron ticks
    // before it's noticed. Fire-and-forget — don't block the halt path
    // on email delivery.
    sendStaleBundleAlertDeduped(integrity).catch((e) => {
      logger.error("reconcile-fleet: stale-bundle alert dispatch failed", {
        route: "cron/reconcile-fleet",
        error: String(e).slice(0, 200),
      });
    });
    await releaseCronLock(CRON_NAME);
    return NextResponse.json({
      halted: "stale_bundle",
      runtime_version: integrity.runtime_version,
      remote_version: integrity.remote_version,
      runtime_sha: integrity.runtime_sha,
      remote_sha: integrity.remote_sha,
      diff_summary: integrity.diff_summary,
      action_required: "Vercel has cached a stale vm-manifest.ts. Force a redeploy (touch route.ts comment + push) and verify the next cron tick reports fresh: true.",
    }, { status: 503 });
  }
  if (!integrity.ok) {
    // Couldn't verify — degrade to old behavior (allow cv bump). Log
    // a warning so monitoring can flag prolonged github_unreachable
    // states (those would mask staleness silently).
    logger.warn("reconcile-fleet: manifest integrity check unverifiable — proceeding with caution", {
      route: "cron/reconcile-fleet",
      reason: integrity.reason,
      detail: integrity.detail,
    });
  }

  const startMs = Date.now();
  let candidates = 0;
  let audited = 0;
  let fixed = 0;
  let errored = 0;
  const errorDetails: { vmId: string; vmName: string | null; error: string }[] = [];
  // Max strict_hold_streak observed across this batch. Surfaced in response
  // so we see the worst case without a follow-up DB query.
  let response_strict_hold_streak_max = 0;

  try {
    const supabase = getSupabase();

    // 3. Pull stale assigned VMs.
    //
    // Filters:
    //   - status="assigned" (the only VMs that benefit from reconciliation;
    //     ready pool VMs are handled by the snapshot itself)
    //   - config_version < VM_MANIFEST.version (the staleness signal)
    //   - health_status='healthy' — see HISTORY note below.
    //   - gateway_url IS NOT NULL (skip VMs that never finished provisioning)
    //
    // Order: oldest config_version first so v55 VMs (most drifted) get
    // priority over v57 VMs (only 1 version behind).
    //
    // ── HISTORY: eligibility filter ──
    // 2026-04-28: widened from eq('healthy') → in('healthy','suspended','hibernating')
    //   so suspended/hibernating users would have current config when they
    //   came back. Each suspended VM ran with skipGatewayRestart=true so the
    //   reconcile didn't accidentally un-suspend them.
    //
    // 2026-05-09: REVERTED to eq('healthy'). The widened filter caused fleet
    //   throughput to collapse from nominal 60 VMs/hr to ~0.4 VMs/hr.
    //   Diagnosis: 45 long-dormant suspended/hibernating VMs at cv=74-80
    //   (last_health_check 2-28 days old, many SSH-degraded a la vm-726)
    //   were head-of-line blocking the 149 healthy stale VMs behind them.
    //   The cron's oldest-cv-first ordering re-picked the same broken cohort
    //   every tick, burned the full 300s Vercel budget, and made zero
    //   forward progress.
    //
    //   Why removing them is safe: suspended VMs serve no user traffic, so
    //   there's no time pressure to keep their config current. When the user
    //   pays again, wakeIfHibernating (lib/wake-vm.ts) flips health_status
    //   to 'healthy' and the VM re-enters eligibility on the next tick.
    //   Oldest-cv-first ordering puts the just-woken VM at the head of the
    //   queue (it's the most stale by definition), so reconcile happens
    //   within 1-2 ticks (3-6 min) of wake. Acceptable staleness window vs.
    //   making wake synchronous-reconcile (which would 30-90s the Stripe
    //   webhook and breach the 10s timeout).
    //
    //   skipGatewayRestart logic at the loop site is preserved (defensive —
    //   /api/admin/reconcile-vm can still be invoked manually against
    //   suspended VMs, which is the only remaining caller of that path).
    const { data: staleVms, error: queryErr } = await supabase
      .from("instaclaw_vms")
      // reconcile_first_failure_at added 2026-05-17 — the persistent-failure
      // alert body shows "time since first failure" computed from this column.
      .select("id, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, health_status, assigned_to, name, config_version, secret_version, tier, api_mode, user_timezone, strict_hold_streak, partner, reconcile_consecutive_failures, reconcile_first_failure_at, index_user_id, index_api_key, index_provisioned_at, gbrain_enabled, edgeos_api_key")
      .eq("status", "assigned")
      .eq("provider", "linode")
      .eq("health_status", "healthy")
      // Defense in depth: terminated/destroyed/failed VMs can never enter the
      // reconcile pool, even if health_status got left at 'healthy' by a
      // partial-write upstream (vm-lifecycle / cloud-init-poll). The
      // .eq('status','assigned') filter above already excludes these states,
      // but this explicit clause documents the protection and survives any
      // future refactor that widens the status filter.
      .not("status", "in", '("terminated","destroyed","failed")')
      // Eligibility is the UNION of two independent staleness signals:
      //   1. config_version < manifest version (existing — manifest drift)
      //   2. secret_version  < SECRET_VERSION  (2026-05-14 — secret rotation)
      // OR-ing them means a caught-up VM (cv = MANIFEST.version) still
      // re-enters the queue when SECRET_VERSION bumps. Without this, secret
      // rotations silently fail to propagate to caught-up VMs (Rule 45 /
      // 2026-05-14 EDGEOS_BEARER_TOKEN incident). See lib/vm-reconcile.ts:
      // SECRET_VERSION for the bump procedure.
      .or(`config_version.lt.${VM_MANIFEST.version},secret_version.lt.${SECRET_VERSION}`)
      .not("gateway_url", "is", null)
      // Auto-quarantined VMs (K=10 consecutive reconcile failures) are
      // excluded so they stop wasting cron cycles. Operator clears the
      // quarantine flag manually after fixing the root cause. See
      // 20260511220000_reconcile_failure_tracking.sql + the
      // RECONCILE_QUARANTINE_THRESHOLD constant below.
      .is("reconcile_quarantined_at", null)
      .order("config_version", { ascending: true, nullsFirst: true })
      // Secondary sort: within the same cv-tier, prioritize the
      // most-overdue secret_version first. Added 2026-05-16 to unstick
      // edge_city — all 7 edge_city VMs sat at cv=100 sv=0 at
      // queue-position 14+ behind ~13 non-partner cv=100 sv=1 VMs
      // because the previous single-key cv-ASC sort had no tiebreaker
      // and PostgREST default-ordered ties by insertion. Adding sv ASC
      // here surfaces edge_city naturally (and benefits any other
      // sv=0 cohort waiting behind sv=1 peers) without harming the
      // cv<100 cohort which still sorts first.
      .order("secret_version", { ascending: true, nullsFirst: true })
      .limit(CONFIG_AUDIT_BATCH_SIZE);

    if (queryErr) {
      logger.error("reconcile-fleet: stale-VM query failed", {
        route: "cron/reconcile-fleet",
        error: queryErr.message,
      });
      return NextResponse.json(
        { error: "DB query failed", detail: queryErr.message },
        { status: 500 }
      );
    }

    candidates = staleVms?.length ?? 0;

    if (candidates === 0) {
      logger.info("reconcile-fleet: no stale VMs", {
        route: "cron/reconcile-fleet",
        manifestVersion: VM_MANIFEST.version,
      });
      return NextResponse.json({
        candidates: 0,
        audited: 0,
        fixed: 0,
        errored: 0,
        manifestVersion: VM_MANIFEST.version,
        durationMs: Date.now() - startMs,
      });
    }

    logger.info("reconcile-fleet: starting batch", {
      route: "cron/reconcile-fleet",
      candidates,
      manifestVersion: VM_MANIFEST.version,
      vmIds: staleVms!.map((v) => v.id),
    });

    // 4. Process each stale VM sequentially. Sequential (not Promise.all)
    // matches the previous health-check Pass 4 behavior and avoids
    // 10 concurrent SSH connections + 10 concurrent openclaw config-set
    // chains, which could trip rate limits or DB pool exhaustion. If the
    // throughput becomes a problem we can revisit (Fix B in the audit doc).
    const strictVmIds = getStrictVmIds();

    // ── Phase 2c runtime kill switches ──
    // DB-backed flags in instaclaw_admin_settings. Read once per cron
    // invocation (not per VM) so we have a consistent view for this batch.
    // Flipping either row in Supabase UI takes effect on the NEXT cron
    // fire (≤3 min). This beats env-var rollback which requires a redeploy.
    const { strictModeEnabled, canaryEnabled } = await readStrictKillSwitches(supabase);

    // If strict_mode_enabled=false, every VM runs legacy mode regardless of
    // the STRICT_RECONCILE_VM_IDS env allowlist. This is the "stop everything
    // strict" kill. Bypasses the strict gate entirely — config_version bumps
    // like pre-2c.
    const strictEnabledForBatch = strictModeEnabled && strictVmIds.size > 0;

    if (!strictModeEnabled && strictVmIds.size > 0) {
      logger.warn("reconcile-fleet: strict_mode_enabled=false in DB — ignoring STRICT_RECONCILE_VM_IDS", {
        route: "cron/reconcile-fleet",
        envAllowlistSize: strictVmIds.size,
      });
    }

    let strictHeld = 0; // Count of VMs held back from config_version bump in this batch
    let strictProbes = 0;
    let strictClean = 0;
    let canariesSkippedBudget = 0;
    const batchHolds: Array<{ vmId: string; vmName: string | null; streak: number; errors: string[] }> = [];

    for (const vm of staleVms!) {
      // FIX-A guardrail (2026-05-15): capture per-VM wall-clock so we can warn
      // on reconciles approaching PER_VM_TIMEOUT_MS. Pre-Promise.race so the
      // measurement includes the actual auditVMConfig work; post-handling
      // bookkeeping (cv-bump, secret bump) adds <1s and is captured too.
      const vmStartMs = Date.now();
      try {
        const strict = strictEnabledForBatch && strictVmIds.has(vm.id);
        // Suspended/hibernating VMs: do everything EXCEPT restart the gateway.
        // Their gateway is intentionally stopped/idle — restarting would
        // un-suspend them. Config + files land; gateway picks them up on next
        // start (reactivation flow runs auditVMConfig again, this time with
        // skipGatewayRestart=false, so the gateway gets the latest).
        const skipGatewayRestart = vm.health_status !== "healthy";
        // Per-VM hard timeout (PER_VM_TIMEOUT_MS, currently 120s). One slow
        // VM can otherwise eat the full 300s Vercel budget and starve the
        // other 2 batch slots. The thrown timeout error falls into the catch
        // block below → errored++, no cv bump, next cron cycle retries.
        const auditResult = await Promise.race([
          auditVMConfig(vm, { strict, canary: canaryEnabled, skipGatewayRestart }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `per-VM reconcile timeout after ${PER_VM_TIMEOUT_MS / 1000}s`,
                  ),
                ),
              PER_VM_TIMEOUT_MS,
            ),
          ),
        ]);
        audited++;
        if (strict) {
          strictProbes++;
          if (auditResult.canarySkippedBudget) canariesSkippedBudget++;
        }

        // ── secret_version bump (decoupled from config_version) ──
        // Bump independently of strict/push gating so a successful
        // stepEnvVarPush propagates immediately even when a later step
        // fails. The whole point of `secret_version` is that secret
        // distribution is NOT held hostage to the rest of the reconciler.
        // See lib/vm-reconcile.ts:SECRET_VERSION + CLAUDE.md "Operational
        // runbook: rotating secrets" in the Incident Response Runbook.
        const vmSecretVersion = (vm as { secret_version?: number | null }).secret_version ?? 0;
        if (auditResult.envPushSucceeded && vmSecretVersion < SECRET_VERSION) {
          const { error: secretBumpErr } = await supabase
            .from("instaclaw_vms")
            .update({ secret_version: SECRET_VERSION })
            .eq("id", vm.id);
          if (secretBumpErr) {
            logger.error("reconcile-fleet: secret_version bump failed", {
              route: "cron/reconcile-fleet",
              vmId: vm.id,
              vmName: vm.name,
              fromVersion: vmSecretVersion,
              toVersion: SECRET_VERSION,
              error: secretBumpErr.message,
            });
          } else {
            logger.info("reconcile-fleet: secret_version bumped", {
              route: "cron/reconcile-fleet",
              vmId: vm.id,
              vmName: vm.name,
              fromVersion: vmSecretVersion,
              toVersion: SECRET_VERSION,
            });
          }
        }

        if (auditResult.fixed.length > 0) {
          fixed++;
          logger.info("reconcile-fleet: drift fixed", {
            route: "cron/reconcile-fleet",
            vmId: vm.id,
            vmName: vm.name,
            fromVersion: vm.config_version ?? 0,
            toVersion: VM_MANIFEST.version,
            fixed: auditResult.fixed,
            alreadyCorrect: auditResult.alreadyCorrect.length,
            strict,
          });
        }

        // Strict gate — hold config_version back ONLY when strictErrors is
        // non-empty. Canary failure already pushes a "canary: ..." entry
        // into strictErrors (see stepCanaryProbe), so no separate canary
        // branch is needed here. Unit-tested for equivalence across all
        // cases — see lib/__tests__/vm-reconcile-strict.test.ts.
        const strictFailed = strict && auditResult.strictErrors.length > 0;

        // Bump-without-push gate — added 2026-04-28. Until now, any
        // result.errors from reconcileVM (file SCP failures, config-set
        // failures, npm install errors, etc.) were silently swallowed in
        // non-strict mode and the cron bumped config_version regardless.
        // That meant a VM could be marked v63 while pushes had failed.
        // Now: if auditResult.errors is non-empty, hold config_version
        // back. Logged + counted as 'errored' so it shows in the response.
        // Distinct from strictFailed: no streak/alert bookkeeping, just a
        // soft hold so next cron cycle retries naturally.
        const pushFailed = auditResult.errors.length > 0;

        if (strictFailed) {
          strictHeld++;

          // ── Persist the hold event + advance streak (atomic-ish) ──
          // 1. Bump streak on the VM and capture the new value.
          const { data: streakRow } = await supabase
            .from("instaclaw_vms")
            .update({ strict_hold_streak: (vm.strict_hold_streak ?? 0) + 1 })
            .eq("id", vm.id)
            .select("strict_hold_streak")
            .single();
          const newStreak = streakRow?.strict_hold_streak ?? ((vm.strict_hold_streak ?? 0) + 1);

          // 2. Append to the event log.
          await supabase.from("instaclaw_strict_holds").insert({
            vm_id: vm.id,
            strict_errors: auditResult.strictErrors,
            canary_healthy: auditResult.canaryHealthy,
            at_version: vm.config_version ?? 0,
            manifest_version: VM_MANIFEST.version,
            strict_hold_streak: newStreak,
          });

          batchHolds.push({
            vmId: vm.id,
            vmName: vm.name,
            streak: newStreak,
            errors: auditResult.strictErrors,
          });

          // Rule 40 — structured CV_BUMP_BLOCKED line (strict variant).
          // Strict and push hold-paths emit the SAME greppable prefix so a
          // single log search surfaces all currently-blocked VMs.
          //
          // 3am-triage context fields (ipAddress / tier / partner / versionGap /
          // healthStatus) added 2026-05-18 so an operator can act on a single
          // log line without first running a DB lookup to find the IP / tier.
          logger.error("CV_BUMP_BLOCKED", {
            route: "cron/reconcile-fleet",
            reason: "strict",
            vmId: vm.id,
            vmName: vm.name,
            ipAddress: vm.ip_address ?? null,
            healthStatus: vm.health_status,
            tier: vm.tier ?? null,
            partner: vm.partner ?? null,
            cvCurrent: vm.config_version ?? 0,
            cvTarget: VM_MANIFEST.version,
            versionGap: VM_MANIFEST.version - (vm.config_version ?? 0),
            errorsCount: auditResult.strictErrors.length,
            failingSteps: extractFailingSteps(auditResult.strictErrors),
            sampleError: (auditResult.strictErrors[0] ?? "").slice(0, 200),
            strictErrors: auditResult.strictErrors,
            canaryHealthy: auditResult.canaryHealthy,
            streak: newStreak,
          });
          errorDetails.push({
            vmId: vm.id,
            vmName: vm.name,
            error: `strict: ${auditResult.strictErrors.slice(0, 3).join("; ")}`,
          });

          // 3. Per-VM alerting with fire-first-then-escalate dedup.
          //    Fire-and-forget — never block the cron on email delivery.
          sendPerVmHoldAlert(supabase, vm, auditResult, newStreak).catch((e) =>
            logger.error("reconcile-fleet: per-VM alert dispatch failed", {
              route: "cron/reconcile-fleet", vmId: vm.id, error: String(e),
            }),
          );
        } else if (pushFailed) {
          // Push errors → hold config_version back. Surfaces as 'errored' in
          // the response so the cron summary catches it. Next cycle
          // re-evaluates; if errors clear, we'll bump.
          //
          // 2026-05-11 P1: persist failure history per VM. The pre-fix path
          // logged warnings into Vercel cron logs that disappeared the
          // moment the function returned. 53 paying customers hit this
          // failure path for 33-86 days each with zero alerting because
          // no DB record persisted across cycles. Now: increment a
          // counter, capture the most recent error string, auto-quarantine
          // at K=10 so persistent failures stop wasting cron cycles AND
          // surface to operators via the alert + reconcile_quarantined_at
          // dashboard column.
          errored++;
          errorDetails.push({
            vmId: vm.id,
            vmName: vm.name,
            error: `push: ${auditResult.errors.slice(0, 3).join("; ")}`,
          });
          // FIX-B (2026-05-15): bookkeeping extracted to recordReconcileFailure
          // for symmetric reuse from the catch (err) path. Same DB writes as
          // the inline code this replaces — no behavior change in this branch.
          // The catch path now calls the same helper to close the silent-
          // bookkeeping-bypass that stranded the 32 cv=95 cohort.
          const { newCounter, shouldQuarantine } = await recordReconcileFailure(
            supabase, vm, auditResult.errors,
          );

          // Rule 40 — structured CV_BUMP_BLOCKED line. The "CV_BUMP_BLOCKED"
          // message is the canonical greppable prefix; failingSteps +
          // sampleError accelerate incident triage from "SSH-probe each
          // stuck VM" to one log search / SQL query.
          //
          // 3am-triage context fields (ipAddress / tier / partner / versionGap)
          // added 2026-05-18 so an operator can act on a single log line
          // without first running a DB lookup to find the IP / tier.
          logger.warn("CV_BUMP_BLOCKED", {
            route: "cron/reconcile-fleet",
            reason: "push",
            vmId: vm.id,
            vmName: vm.name,
            ipAddress: vm.ip_address ?? null,
            healthStatus: vm.health_status,
            tier: vm.tier ?? null,
            partner: vm.partner ?? null,
            cvCurrent: vm.config_version ?? 0,
            cvTarget: VM_MANIFEST.version,
            versionGap: VM_MANIFEST.version - (vm.config_version ?? 0),
            errorsCount: auditResult.errors.length,
            failingSteps: extractFailingSteps(auditResult.errors),
            sampleError: (auditResult.errors[0] ?? "").slice(0, 200),
            errors: auditResult.errors,
            reconcileConsecutiveFailures: newCounter,
            quarantined: shouldQuarantine,
          });

          // Alert dispatch — fire-and-forget. Two trigger points:
          //   1. First fire (counter==1): "VM started failing" — early
          //      warning so operators can investigate before quarantine
          //   2. Quarantine fire (counter>=K): "VM auto-quarantined" — the
          //      automatic "this VM needs hands-on attention" signal
          // Dedup via instaclaw_admin_alert_log (existing table).
          if (newCounter === 1 || shouldQuarantine) {
            sendReconcileFailureAlert(supabase, vm, newCounter, shouldQuarantine, auditResult.errors).catch((e) =>
              logger.error("reconcile-fleet: failure alert dispatch failed", {
                route: "cron/reconcile-fleet", vmId: vm.id, error: String(e),
              }),
            );
          }

          // 2026-05-17: mid-tier "persistently failing" alert. Fires at
          // counter>=3 but NOT at counter==K (quarantine path above handles
          // that separately with its own alert key, so the !shouldQuarantine
          // gate avoids double-mailing operators on the crossing tick).
          // Different alert key from first-fire/quarantine, so its 12h
          // dedup doesn't suppress those distinct signals.
          if (newCounter >= RECONCILE_PERSISTENT_THRESHOLD && !shouldQuarantine) {
            sendReconcilePersistentFailureAlert(supabase, vm, newCounter, auditResult.errors).catch((e) =>
              logger.error("reconcile-fleet: persistent-fail alert dispatch failed", {
                route: "cron/reconcile-fleet", vmId: vm.id, error: String(e),
              }),
            );
          }
        } else {
          if (strict) strictClean++;

          // Reset streak if this VM was previously holding.
          if ((vm.strict_hold_streak ?? 0) > 0) {
            await supabase
              .from("instaclaw_vms")
              .update({ strict_hold_streak: 0 })
              .eq("id", vm.id);
            logger.info("reconcile-fleet: strict_hold_streak reset to 0", {
              route: "cron/reconcile-fleet",
              vmId: vm.id,
              vmName: vm.name,
              priorStreak: vm.strict_hold_streak,
            });
          }

          // Reset reconcile-failure history on success. If the VM was
          // quarantined, it stays quarantined until an operator manually
          // clears reconcile_quarantined_at — successful reconcile alone
          // doesn't auto-unquarantine because we want operators to
          // explicitly acknowledge the recovery (and ensure they understood
          // what was originally broken).
          if ((vm.reconcile_consecutive_failures ?? 0) > 0) {
            await supabase
              .from("instaclaw_vms")
              .update({
                reconcile_consecutive_failures: 0,
                reconcile_first_failure_at: null,
                reconcile_last_error: null,
                // NOTE: reconcile_quarantined_at NOT cleared here — operator
                // action required after they understand what was failing.
              })
              .eq("id", vm.id);
            logger.info("reconcile-fleet: reconcile_consecutive_failures reset to 0", {
              route: "cron/reconcile-fleet",
              vmId: vm.id,
              vmName: vm.name,
              priorCounter: vm.reconcile_consecutive_failures,
            });
          }

          // Bump config_version when the check passed (nothing failed strictly
          // AND no push errors). Default (non-strict, no errors) = bump.
          const { error: updateErr } = await supabase
            .from("instaclaw_vms")
            .update({ config_version: VM_MANIFEST.version })
            .eq("id", vm.id);

          if (updateErr) {
            logger.error("reconcile-fleet: config_version bump failed", {
              route: "cron/reconcile-fleet",
              vmId: vm.id,
              vmName: vm.name,
              error: updateErr.message,
            });
          }

          // FIX-A guardrail (2026-05-15): log wall-clock for every successful
          // reconcile + emit deduped admin alert when elapsed >80% of the
          // PER_VM_TIMEOUT_MS ceiling. Catches reconcile-time drift BEFORE
          // the next manifest addition pushes a VM over the timeout and
          // silently strands it (the 2026-05-15 P0 pattern — investigate
          // proactively at 80%, not reactively at 100%).
          const elapsedMs = Date.now() - vmStartMs;
          logger.info("reconcile-fleet: vm success", {
            route: "cron/reconcile-fleet",
            vmId: vm.id,
            vmName: vm.name,
            elapsedMs,
            elapsedPctOfTimeout: Math.round((elapsedMs / PER_VM_TIMEOUT_MS) * 100),
            fromVersion: vm.config_version ?? 0,
            toVersion: VM_MANIFEST.version,
          });
          if (elapsedMs >= PER_VM_TIMEOUT_WARN_MS) {
            logger.warn("reconcile-fleet: vm reconcile approaching timeout ceiling", {
              route: "cron/reconcile-fleet",
              vmId: vm.id,
              vmName: vm.name,
              elapsedMs,
              timeoutMs: PER_VM_TIMEOUT_MS,
              warnThresholdMs: PER_VM_TIMEOUT_WARN_MS,
              elapsedPctOfTimeout: Math.round((elapsedMs / PER_VM_TIMEOUT_MS) * 100),
            });
            sendReconcileApproachTimeoutAlert(supabase, vm, elapsedMs).catch((e) =>
              logger.error("reconcile-fleet: approach-timeout alert dispatch failed", {
                route: "cron/reconcile-fleet", vmId: vm.id, error: String(e),
              }),
            );
          }
        }
      } catch (err) {
        errored++;
        const msg = err instanceof Error ? err.message : String(err);
        errorDetails.push({ vmId: vm.id, vmName: vm.name, error: msg });

        // FIX-B (2026-05-15): record the throw to the same failure-tracking
        // columns the pushFailed branch uses. Pre-FIX-B, this path skipped
        // the DB write entirely — that's the silent-bookkeeping-bypass bug
        // that stranded the 32 cv=95 cohort for 1-3 weeks (per-VM 220s
        // timeout fired, threw, caught here, no DB write, no quarantine,
        // no alert, retried every 3 min indefinitely).
        //
        // Wrap the helper in an inner try/catch so a transient DB write
        // failure here doesn't propagate out of the route — the cron
        // should always continue to the next VM, never return 500 on
        // bookkeeping flakiness. Logged loudly as a last-resort signal.
        let newCounter = 0;
        let shouldQuarantine = false;
        try {
          const r = await recordReconcileFailure(supabase, vm, [msg]);
          newCounter = r.newCounter;
          shouldQuarantine = r.shouldQuarantine;
        } catch (bookkeepingErr) {
          logger.error("reconcile-fleet: catch-path bookkeeping write failed", {
            route: "cron/reconcile-fleet",
            vmId: vm.id,
            originalError: msg,
            bookkeepingError: bookkeepingErr instanceof Error ? bookkeepingErr.message : String(bookkeepingErr),
          });
        }

        // Rule 40 — structured CV_BUMP_BLOCKED log. reason="throw" mirrors
        // the pushFailed branch's reason="push" so a single grep against
        // CV_BUMP_BLOCKED surfaces every currently-blocked VM regardless of
        // which path took it out of cv-bump eligibility.
        logger.warn("CV_BUMP_BLOCKED", {
          route: "cron/reconcile-fleet",
          reason: "throw",
          vmId: vm.id,
          vmName: vm.name,
          cvCurrent: vm.config_version ?? 0,
          cvTarget: VM_MANIFEST.version,
          errorsCount: 1,
          failingSteps: extractFailingSteps([msg]),
          sampleError: msg.slice(0, 200),
          thrownError: msg,
          healthStatus: vm.health_status,
          reconcileConsecutiveFailures: newCounter,
          quarantined: shouldQuarantine,
        });

        // Alert dispatch on first failure or auto-quarantine. fire-and-forget;
        // failures to email don't block the cron from advancing.
        if (newCounter === 1 || shouldQuarantine) {
          sendReconcileFailureAlert(supabase, vm, newCounter, shouldQuarantine, [msg]).catch((e) =>
            logger.error("reconcile-fleet: failure alert dispatch failed (throw path)", {
              route: "cron/reconcile-fleet", vmId: vm.id, error: String(e),
            }),
          );
        }

        // 2026-05-17: mid-tier "persistently failing" alert (throw path).
        // Mirror of the pushFailed-branch dispatch above — same trigger
        // conditions, same dedup, same gate against double-mailing on the
        // counter==K crossing tick.
        if (newCounter >= RECONCILE_PERSISTENT_THRESHOLD && !shouldQuarantine) {
          sendReconcilePersistentFailureAlert(supabase, vm, newCounter, [msg]).catch((e) =>
            logger.error("reconcile-fleet: persistent-fail alert dispatch failed (throw path)", {
              route: "cron/reconcile-fleet", vmId: vm.id, error: String(e),
            }),
          );
        }

        // Preserve the original "audit failed" log line for backwards-compat
        // grep patterns + any existing alerting that keys on this string.
        logger.error("reconcile-fleet: audit failed", {
          route: "cron/reconcile-fleet",
          vmId: vm.id,
          vmName: vm.name,
          error: msg,
        });
        // Continue to next VM rather than aborting the batch.
      }
    }

    if (strictHeld > 0) {
      logger.warn("reconcile-fleet: strict holds in batch", {
        route: "cron/reconcile-fleet",
        strictHeld,
        strictAllowlistSize: strictVmIds.size,
      });

      // Batch summary email — one per cron invocation, regardless of hold count.
      // Intentionally separate from per-VM emails (Cooper's spec: "20 emails
      // if 20 VMs hold, AND a batch summary"). Fire-and-forget.
      sendBatchSummaryAlert(supabase, batchHolds, strictHeld, audited, strictVmIds.size).catch((e) =>
        logger.error("reconcile-fleet: batch summary alert failed", {
          route: "cron/reconcile-fleet", error: String(e),
        }),
      );
    }

    // ── Daily stats upsert — fire-and-forget aggregate ──
    // One UPSERT per cron invocation into instaclaw_strict_daily_stats.
    // Lets ops answer "is strict mode still running?" with a single-row
    // lookup instead of counting strict_hold events.
    if (strictProbes > 0 || strictHeld > 0) {
      const now = new Date();
      const statDate = now.toISOString().split("T")[0];
      const streakMaxThisBatch = batchHolds.reduce((m, h) => Math.max(m, h.streak), 0);
      upsertDailyStats(supabase, statDate, {
        probesRun: strictProbes,
        probesClean: strictClean,
        probesHeld: strictHeld,
        probesErrored: errored,
        canariesSkippedBudget,
        now,
      }).catch((e) =>
        logger.error("reconcile-fleet: daily stats upsert failed", {
          route: "cron/reconcile-fleet", error: String(e),
        }),
      );
      // Surface max streak in the response so callers see the worst case
      // without needing a follow-up DB query.
      response_strict_hold_streak_max = streakMaxThisBatch;
    }

    // 2026-05-17: staleness sweep. Catch VMs the candidate query isn't
    // reaching at all — structurally distinct from the per-VM failure
    // alerts. Single deduped summary email (12h key). Never throws;
    // failure to send the alert must not interrupt the response.
    await runStalenessSweep(supabase).catch((e) =>
      logger.error("reconcile-fleet: staleness sweep failed", {
        route: "cron/reconcile-fleet", error: String(e),
      }),
    );

    const durationMs = Date.now() - startMs;
    logger.info("reconcile-fleet: batch complete", {
      route: "cron/reconcile-fleet",
      candidates,
      audited,
      fixed,
      errored,
      durationMs,
      manifestVersion: VM_MANIFEST.version,
    });

    return NextResponse.json({
      candidates,
      audited,
      fixed,
      errored,
      strictHeld,
      strictAllowlistSize: strictVmIds.size,
      strict_hold_streak_max: response_strict_hold_streak_max,
      errorDetails: errorDetails.slice(0, 10), // Cap response size
      manifestVersion: VM_MANIFEST.version,
      durationMs,
    });
  } catch (err) {
    logger.error("reconcile-fleet: unhandled error", {
      route: "cron/reconcile-fleet",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    // 5. Always release the lock — finally block guarantees cleanup even
    // on uncaught throws so the next cron run isn't blocked.
    await releaseCronLock(CRON_NAME);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof getSupabase>;

/**
 * Read the DB-backed runtime kill switches. Fail-safe: if the settings table
 * is unreachable or missing rows, default to {strict_mode_enabled: true,
 * canary_enabled: true} so a partial outage of the settings row doesn't
 * secretly disable strict mode.
 */
async function readStrictKillSwitches(supabase: SupabaseClient): Promise<{
  strictModeEnabled: boolean;
  canaryEnabled: boolean;
}> {
  try {
    const { data } = await supabase
      .from("instaclaw_admin_settings")
      .select("setting_key, bool_value")
      .in("setting_key", ["strict_mode_enabled", "canary_enabled"]);
    const map = new Map<string, boolean | null | undefined>();
    for (const row of data ?? []) map.set(row.setting_key, row.bool_value);
    return {
      // Missing row or null = default-on. Explicit false = off.
      strictModeEnabled: map.get("strict_mode_enabled") !== false,
      canaryEnabled: map.get("canary_enabled") !== false,
    };
  } catch (err) {
    logger.warn("reconcile-fleet: readStrictKillSwitches failed, defaulting ON", {
      route: "cron/reconcile-fleet",
      error: String(err),
    });
    return { strictModeEnabled: true, canaryEnabled: true };
  }
}

/**
 * Error-set dedup key. Same VM + same set of strict errors → same alert key.
 * A sorted + joined + sha1-truncated digest keeps the key short and stable
 * across "same errors in different order" variations.
 */
function strictHoldAlertKey(vmId: string, strictErrors: string[]): string {
  const sorted = [...strictErrors].sort().join("|");
  const hash = crypto.createHash("sha1").update(sorted).digest("hex").slice(0, 16);
  return `strict_hold:${vmId}:${hash}`;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const PERSISTENT_HOLD_THRESHOLD = 5;

/**
 * P1-4 / Rule 37 / Rule 49 dedup pattern — admin alert on a confirmed
 * stale-bundle verdict from `verifyManifestFreshness`.
 *
 * Why this alert exists:
 *   The integrity check is the HARD prevention layer that halts the
 *   reconcile when Vercel's nft cache ships a stale vm-manifest.ts. Pre-
 *   2026-05-14 the halt was visible only in Vercel function logs — an
 *   operator had to notice "fleet not advancing" and read the logs to
 *   find the cause. With ~20 cron ticks between visibility and the next
 *   manual deploy push, that's an hour-plus of fleet-stuck before
 *   anyone notices. This alert makes the halt itself a paging event.
 *
 * Dedup key: `stale_bundle:${remote_sha}`. Keyed on the GitHub-raw SHA
 * (not the runtime SHA, not a timestamp) so a single bad deploy fires
 * one email per dedup-window regardless of how many cron ticks observe
 * the same stale bundle. A NEW deploy that produces a different remote
 * SHA will fire a fresh alert if it's also stale.
 *
 * 30-min cooldown (was 6h, narrowed 2026-05-16). Background: the
 * 2026-05-16 INC-stale-bundle outage ran ~23h with only 3 deduped
 * alerts (5:54, 11:57, 19:27 UTC) — they got drowned in baseline
 * heartbeat_staleness_sweep volume (~28/day) and went unnoticed
 * overnight. Structural failures don't auto-resolve and deserve a
 * sustaining drumbeat: 30min ⇒ ~10 alerts per 5h outage window, hard
 * to ignore. Per docs/incidents/2026-05-16-stale-bundle-23h-cron-halt.md
 * §7 Option A. Cost: ~10 emails per outage (extremely rare event class
 * — 2 documented occurrences in fleet history).
 *
 * Fire-and-forget; all DB writes wrapped in try/catch so a transient
 * supabase hiccup never blocks the halt path.
 */
const STALE_BUNDLE_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 min — see docstring above
async function sendStaleBundleAlertDeduped(verdict: {
  runtime_version: number;
  remote_version: number | null;
  runtime_sha: string;
  remote_sha: string;
  diff_summary: string;
}): Promise<void> {
  const supabase = getSupabase();
  const alertKey = `stale_bundle:${verdict.remote_sha.slice(0, 16)}`;
  const cutoffIso = new Date(Date.now() - STALE_BUNDLE_DEDUP_WINDOW_MS).toISOString();

  // Dedup check
  let recentlySent = false;
  try {
    const { data } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", alertKey)
      .gte("sent_at", cutoffIso)
      .limit(1);
    recentlySent = (data?.length ?? 0) > 0;
  } catch {
    // Dedup-table missing or unreachable → proceed without dedup
    // (better to over-alert than miss the first signal).
  }
  if (recentlySent) {
    logger.info("stale-bundle alert suppressed (30-min dedup)", {
      route: "cron/reconcile-fleet",
      remote_sha: verdict.remote_sha.slice(0, 16),
    });
    return;
  }

  // Record BEFORE send so two near-simultaneous cron starts can't both
  // alert on the same bad bundle.
  try {
    await supabase.from("instaclaw_admin_alert_log").insert({
      alert_key: alertKey,
      vm_count: 0, // not a per-VM alert; affects the whole fleet's cron
      details: `runtime_v=${verdict.runtime_version} remote_v=${verdict.remote_version} diff=${verdict.diff_summary.slice(0, 200)}`,
    });
  } catch {
    // Insert failed (table missing, RLS) — proceed to send anyway.
  }

  const subject = `[P1-4 / Rule 37] Stale vm-manifest.ts bundle — reconcile-fleet halted`;
  const body =
    `The reconcile-fleet cron has refused to bump config_version for this\n` +
    `tick because the bundled vm-manifest.ts doesn't match the live\n` +
    `source-of-truth on main (Vercel @vercel/nft trace cache regression).\n` +
    `\n` +
    `Runtime version: ${verdict.runtime_version}\n` +
    `Remote version:  ${verdict.remote_version ?? "(parse failed)"}\n` +
    `Runtime SHA:     ${verdict.runtime_sha}\n` +
    `Remote SHA:      ${verdict.remote_sha}\n` +
    `\n` +
    `Diff summary: ${verdict.diff_summary}\n` +
    `\n` +
    `What this means:\n` +
    `  - No cv-bump damage was done — the integrity gate caught the\n` +
    `    stale bundle before any VM was touched with old config.\n` +
    `  - But every subsequent cron tick will continue to halt until\n` +
    `    Vercel rebuilds with a fresh nft trace.\n` +
    `\n` +
    `Action required:\n` +
    `  1. Inspect the diff_summary above to confirm this is a stale-\n` +
    `     bundle situation (not an in-flight unmerged change).\n` +
    `  2. Force a Vercel redeploy: touch the cache-bust comment line in\n` +
    `     app/api/cron/reconcile-fleet/route.ts (near the\n` +
    `     CONFIG_AUDIT_BATCH_SIZE declaration) and push.\n` +
    `  3. Verify the next cron tick reports fresh: true (Vercel function\n` +
    `     logs for /api/cron/reconcile-fleet).\n` +
    `\n` +
    `Background: CLAUDE.md Rule 37 + P1-4, lib/manifest-integrity.ts.`;

  await sendAdminAlertEmail(subject, body);
}

/**
 * Per-VM strict-hold alerting with fire-first-then-escalate dedup.
 *
 *   1st occurrence of (vm, error_set) in the last hour → send "Strict hold fired" email.
 *   2nd–4th → suppressed (event still logged to instaclaw_strict_holds — this is
 *             about ALERT volume, not about losing data).
 *   5th → send "PERSISTENT strict hold" email ("this one's stuck, stop ignoring").
 *   6th+ → suppressed until the hourly window resets.
 *
 * Dedup tracked via instaclaw_admin_alert_log rows keyed by
 * `strict_hold:{vmId}:{error_hash}`.
 *
 * All DB writes wrapped in try/catch — alert dispatch MUST NOT interrupt
 * the main reconcile path.
 */
async function sendPerVmHoldAlert(
  supabase: SupabaseClient,
  vm: { id: string; name: string | null; config_version: number | null },
  audit: {
    strictErrors: string[];
    canaryHealthy: boolean | null;
  },
  newStreak: number,
): Promise<void> {
  const alertKey = strictHoldAlertKey(vm.id, audit.strictErrors);
  const oneHourAgo = new Date(Date.now() - ONE_HOUR_MS).toISOString();

  // Count how many times this (vm, error_set) fired in the last hour.
  const { count } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id", { count: "exact", head: true })
    .eq("alert_key", alertKey)
    .gte("sent_at", oneHourAgo);

  const occurrencesInHour = (count ?? 0) + 1; // +1 for the current event

  // Policy:
  //   occurrencesInHour === 1          → send "Strict hold fired" (first-fire email)
  //   occurrencesInHour === THRESHOLD  → send "PERSISTENT hold" (escalation email)
  //   other                            → suppress
  let subject: string | null = null;
  let body: string | null = null;
  const canaryStr =
    audit.canaryHealthy === true ? "healthy" : audit.canaryHealthy === false ? "failed" : "skipped";

  if (occurrencesInHour === 1) {
    subject = `[InstaClaw] Strict reconcile held — ${vm.name ?? vm.id.slice(0, 8)}`;
    body = [
      `VM ${vm.name ?? vm.id} (${vm.id}) was held at config_version ${vm.config_version ?? 0} during reconcile.`,
      "",
      `Manifest version: v${VM_MANIFEST.version} (gap: ${VM_MANIFEST.version - (vm.config_version ?? 0)})`,
      `Canary: ${canaryStr}`,
      `Strict hold streak: ${newStreak} consecutive cycles`,
      "",
      `Strict errors (${audit.strictErrors.length}):`,
      ...audit.strictErrors.map((e) => `  ${e}`),
      "",
      "Next action:",
      "  - Full history: GET /api/admin/strict-holds?vmId=" + vm.id,
      "  - If manifest-wide issue: revert the manifest bump",
      "  - If VM-specific: remove from STRICT_RECONCILE_VM_IDS + inspect manually",
      "",
      `Event log: SELECT * FROM instaclaw_strict_holds WHERE vm_id = '${vm.id}' ORDER BY event_time DESC LIMIT 10`,
    ].join("\n");
  } else if (occurrencesInHour === PERSISTENT_HOLD_THRESHOLD) {
    subject = `[InstaClaw] PERSISTENT strict hold — ${vm.name ?? vm.id.slice(0, 8)} (${PERSISTENT_HOLD_THRESHOLD}× in last hour)`;
    body = [
      `VM ${vm.name ?? vm.id} has hit strict reconcile ${PERSISTENT_HOLD_THRESHOLD} consecutive times`,
      `in the last hour with the SAME errors. Further identical holds this hour`,
      "will be suppressed (still recorded in DB).",
      "",
      "Most recent error set:",
      ...audit.strictErrors.map((e) => `  ${e}`),
      "",
      `Canary: ${canaryStr}`,
      `Total hold streak: ${newStreak}`,
      `This hour: ${occurrencesInHour} fires`,
      "",
      "This is NOT a transient issue. The manifest or the VM has a real",
      "problem that the reconciler cannot self-heal. Manual investigation",
      "required.",
      "",
      `Event log: SELECT * FROM instaclaw_strict_holds WHERE vm_id = '${vm.id}' ORDER BY event_time DESC LIMIT 10`,
    ].join("\n");
  }

  // Always record the event in the alert log (even when suppressed) so the
  // count query above reflects all fires.
  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: alertKey,
    vm_count: 1,
    details: subject ? `sent: ${subject}` : `suppressed: occurrence ${occurrencesInHour}`,
  });

  if (subject && body) {
    await sendAdminAlertEmail(subject, body);
    logger.info("reconcile-fleet: per-VM alert dispatched", {
      route: "cron/reconcile-fleet",
      vmId: vm.id,
      alertKey,
      occurrencesInHour,
      type: occurrencesInHour === 1 ? "first-fire" : "persistent",
    });
  } else {
    logger.info("reconcile-fleet: per-VM alert suppressed (dedup)", {
      route: "cron/reconcile-fleet",
      vmId: vm.id,
      alertKey,
      occurrencesInHour,
    });
  }
}

/**
 * Batch summary email — one per cron invocation if any VMs held strict.
 * Not deduplicated; Cooper's spec is intentional: one email per batch, always.
 */
async function sendBatchSummaryAlert(
  _supabase: SupabaseClient,
  batchHolds: Array<{ vmId: string; vmName: string | null; streak: number; errors: string[] }>,
  strictHeld: number,
  audited: number,
  strictAllowlistSize: number,
): Promise<void> {
  // Top 5 by streak (persistent ones most worth surfacing).
  const top5 = [...batchHolds].sort((a, b) => b.streak - a.streak).slice(0, 5);

  const subject = `[InstaClaw] reconcile-fleet batch: ${strictHeld} VMs held`;
  const body = [
    `Cron run at ${new Date().toISOString()} held ${strictHeld} / ${audited} VMs at their current config_version.`,
    "",
    `Manifest version:      v${VM_MANIFEST.version}`,
    `Strict allowlist size: ${strictAllowlistSize}`,
    "",
    "Top 5 offenders (by strict_hold_streak):",
    ...top5.map(
      (h, i) =>
        `  ${i + 1}. ${h.vmName ?? h.vmId.slice(0, 8)} streak=${h.streak} errors: [${h.errors.slice(0, 2).join("; ")}]`,
    ),
    "",
    "Full list of held VMs in this batch:",
    ...batchHolds.map((h) => `  ${h.vmId}  ${h.vmName ?? "(no name)"}  streak=${h.streak}`),
    "",
    "Dashboards:",
    "  GET https://instaclaw.io/api/admin/strict-holds",
    "  Supabase: SELECT * FROM instaclaw_strict_daily_stats ORDER BY stat_date DESC LIMIT 7;",
  ].join("\n");

  await sendAdminAlertEmail(subject, body);
}

/**
 * UPSERT one row per day into instaclaw_strict_daily_stats. Additive on
 * existing counters when called multiple times (e.g., multiple cron runs in
 * the same day). The "is strict mode still running?" query looks up
 * yesterday's row: if probes_run = 0 despite a non-empty allowlist, strict
 * mode stopped firing and needs investigation.
 */
async function upsertDailyStats(
  supabase: SupabaseClient,
  statDate: string,
  delta: {
    probesRun: number;
    probesClean: number;
    probesHeld: number;
    probesErrored: number;
    canariesSkippedBudget: number;
    now: Date;
  },
): Promise<void> {
  const { probesRun, probesClean, probesHeld, probesErrored, canariesSkippedBudget, now } = delta;

  // Do NOT rely on upsert() here — Supabase's PostgREST upsert can't do
  // "incremental counter" semantics. Read-modify-write is the portable path,
  // and per-cron serialization via cron lock means no race with itself.
  const { data: existing } = await supabase
    .from("instaclaw_strict_daily_stats")
    .select("*")
    .eq("stat_date", statDate)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("instaclaw_strict_daily_stats")
      .update({
        probes_run: (existing.probes_run ?? 0) + probesRun,
        probes_clean: (existing.probes_clean ?? 0) + probesClean,
        probes_held: (existing.probes_held ?? 0) + probesHeld,
        probes_errored: (existing.probes_errored ?? 0) + probesErrored,
        canaries_skipped_budget:
          (existing.canaries_skipped_budget ?? 0) + canariesSkippedBudget,
        last_probe_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("stat_date", statDate);
  } else {
    await supabase.from("instaclaw_strict_daily_stats").insert({
      stat_date: statDate,
      probes_run: probesRun,
      probes_clean: probesClean,
      probes_held: probesHeld,
      probes_errored: probesErrored,
      canaries_skipped_budget: canariesSkippedBudget,
      first_probe_at: now.toISOString(),
      last_probe_at: now.toISOString(),
    });
  }
}

/**
 * Record a reconcile-failure event to the VM's failure-tracking columns.
 *
 * Extracted from the pushFailed branch (route.ts:600-620 inline pre-FIX-B)
 * AND newly called from the catch (err) branch (route.ts:712 post-FIX-B).
 * Before FIX-B (2026-05-15), the catch path was a silent bookkeeping bypass:
 * any throw from auditVMConfig (per-VM 220s timeout, SSH connect error,
 * unhandled step exception) skipped the failure columns entirely. The
 * consequences:
 *
 *   - reconcile_consecutive_failures stayed at 0 → the auto-quarantine
 *     threshold (K=10) never tripped, so the cron retried the same failing
 *     VM every 3 min indefinitely, with no progress and no signal.
 *   - reconcile_last_error stayed NULL → operators had no way to learn
 *     WHAT was failing without SSH-probing each stuck VM.
 *   - sendReconcileFailureAlert (gated on counter==1 || quarantined)
 *     never fired → silent fleet rot.
 *
 * The 32 cv=95 cohort (2026-05-15 P0) was stranded for 1-3 weeks via this
 * silent path. Structurally identical to the 2026-05-11 P0 (53 customers
 * stuck 33-86d each — see CLAUDE.md Rule 23 P1-1) but at a different code
 * site. Calling this helper from BOTH branches closes the bypass: every
 * observed failure mode now bumps the counter, fires the alert at
 * counter==1 || quarantine, and auto-quarantines at K=10.
 *
 * Returns {newCounter, shouldQuarantine} so the call site can emit its own
 * structured Rule 40 CV_BUMP_BLOCKED log + dispatch its own alert. Those
 * stay at the call site because the "reason" tag differs ("push" vs "throw")
 * and the error array shape differs (auditResult.errors[] vs [thrown.message]).
 *
 * Idempotent on the DB write: single UPDATE with computed values. No retry.
 * For the catch branch, the caller wraps this in an inner try/catch so that
 * a failed bookkeeping write itself doesn't propagate out of the route (the
 * cron should still move to the next VM rather than returning 500).
 */
async function recordReconcileFailure(
  supabase: SupabaseClient,
  vm: { id: string; reconcile_consecutive_failures?: number | null },
  errors: string[],
): Promise<{ newCounter: number; shouldQuarantine: boolean }> {
  const newCounter = (vm.reconcile_consecutive_failures ?? 0) + 1;
  const errSnippet = errors.join("; ").slice(0, 500);
  const nowIso = new Date().toISOString();
  const shouldQuarantine = newCounter >= RECONCILE_QUARANTINE_THRESHOLD;
  const update: Record<string, unknown> = {
    reconcile_consecutive_failures: newCounter,
    reconcile_last_failure_at: nowIso,
    reconcile_last_error: errSnippet,
  };
  if ((vm.reconcile_consecutive_failures ?? 0) === 0) {
    update.reconcile_first_failure_at = nowIso;
  }
  if (shouldQuarantine) {
    update.reconcile_quarantined_at = nowIso;
  }
  await supabase.from("instaclaw_vms").update(update).eq("id", vm.id);
  return { newCounter, shouldQuarantine };
}

/**
 * FIX-A guardrail (2026-05-15): per-VM "reconcile approaching timeout ceiling"
 * alert. Fires when a successful reconcile takes >80% of PER_VM_TIMEOUT_MS.
 *
 * Why this exists: the 32 cv=95 cohort (2026-05-15 P0) was stranded for 1-3
 * weeks because reconcile time crept past PER_VM_TIMEOUT_MS as manifest
 * versions added work, the timeout fired, the throw was silently swallowed,
 * and no operator saw the drift. This alert catches the next regression at
 * the 80% threshold (currently 400s at PER_VM_TIMEOUT_MS=500s) — well before
 * the hard ceiling — giving operators time to investigate (optimize a step,
 * bump the ceiling further on Fluid Compute, refactor) before customer
 * impact lands. Dedup is per-VM-per-24h so a single slow VM doesn't email
 * Cooper 20 times a day.
 *
 * Never throws (caller fires-and-forgets) — alert delivery failures must
 * NEVER interrupt the cron.
 */
async function sendReconcileApproachTimeoutAlert(
  supabase: SupabaseClient,
  vm: { id: string; name: string | null; config_version: number | null; assigned_to?: string | null },
  elapsedMs: number,
): Promise<void> {
  const alertKey = `reconcile_approach_timeout:${vm.id}`;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id", { count: "exact", head: true })
    .eq("alert_key", alertKey)
    .gte("sent_at", oneDayAgo);
  if ((count ?? 0) > 0) {
    logger.info("reconcile-fleet: approach-timeout alert suppressed (24h dedup)", {
      route: "cron/reconcile-fleet", vmId: vm.id, alertKey,
    });
    return;
  }

  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  const ceilingSec = (PER_VM_TIMEOUT_MS / 1000).toFixed(0);
  const pct = Math.round((elapsedMs / PER_VM_TIMEOUT_MS) * 100);
  const subject = `[InstaClaw] reconcile approaching timeout ceiling — ${vm.name ?? vm.id.slice(0, 8)} (${elapsedSec}s / ${ceilingSec}s = ${pct}%)`;
  const body = [
    `VM ${vm.name ?? vm.id} (${vm.id}) just completed a successful reconcile that consumed ${pct}% of the per-VM timeout budget (${elapsedSec}s of ${ceilingSec}s ceiling).`,
    "",
    `This is a proactive early-warning. The reconcile DID succeed — config_version was bumped to v${VM_MANIFEST.version}. But the wall-clock is approaching the PER_VM_TIMEOUT_MS ceiling, which suggests reconcile-time drift from accumulated manifest work.`,
    "",
    `If reconcile time grows by another ${Math.round((PER_VM_TIMEOUT_MS - elapsedMs) / 1000)}s (any combination of: heavier session-backups cleanup, new npm install, new skill clone, slower partner setup, network jitter), the next tick will breach the ceiling, throw "per-VM reconcile timeout after ${ceilingSec}s", and silently strand this VM at its current config_version.`,
    "",
    `cv:                  ${vm.config_version ?? 0}`,
    `manifest:            v${VM_MANIFEST.version}`,
    `elapsed:             ${elapsedSec}s`,
    `timeout ceiling:     ${ceilingSec}s`,
    `pct of ceiling:      ${pct}%`,
    `warn threshold:      ${(PER_VM_TIMEOUT_WARN_MS / 1000).toFixed(0)}s (80% of ceiling)`,
    `assigned_to:         ${vm.assigned_to ?? "(none)"}`,
    "",
    "Suggested investigation (in priority order):",
    "  1. Was a new reconciler step added recently (git log -- lib/vm-reconcile.ts)?",
    "  2. Is this VM's stepDiskGuard cleanup heavier than average? (df + session-backups count)",
    "  3. Are partner-gated steps (edge-overlay, EDGEOS env) firing slowly?",
    "  4. Network jitter (`time ssh <vm> exit` from monitoring VM)?",
    "  5. If sustained across multiple VMs, bump PER_VM_TIMEOUT_MS + maxDuration in app/api/cron/reconcile-fleet/route.ts (Fluid Compute supports up to 800s).",
    "",
    `Dedup: 24h via alert_key="${alertKey}". Next alert for this VM will not fire until ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()}.`,
  ].join("\n");

  await sendAdminAlertEmail(subject, body).catch((e) => {
    logger.error("reconcile-fleet: approach-timeout alert email send failed", {
      route: "cron/reconcile-fleet", vmId: vm.id, error: String(e),
    });
  });
  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: alertKey,
    vm_count: 1,
    details: `vm=${vm.name ?? vm.id} elapsed=${elapsedSec}s pct=${pct}% ceiling=${ceilingSec}s cv=${vm.config_version ?? 0}→v${VM_MANIFEST.version}`,
  }).then(({ error }) => {
    if (error) {
      logger.warn("reconcile-fleet: approach-timeout alert log insert failed", {
        route: "cron/reconcile-fleet", vmId: vm.id, error: error.message,
      });
    }
  });
}

/**
 * Per-VM reconcile-failure alert. Two trigger points:
 *   - first fire (counter==1): early warning that a VM started failing
 *   - quarantine fire (counter>=K): VM auto-quarantined, needs operator
 *
 * Dedup via instaclaw_admin_alert_log. Alert key includes the trigger
 * type so the two alert types deduplicate independently — a VM that
 * already triggered the "first fire" alert can still trigger a
 * "quarantine" alert when it crosses K.
 *
 * Never throws (caller fires-and-forgets) — alert delivery failures
 * must NEVER interrupt the cron.
 */
async function sendReconcileFailureAlert(
  supabase: SupabaseClient,
  vm: { id: string; name: string | null; config_version: number | null; assigned_to?: string | null },
  counter: number,
  quarantined: boolean,
  errors: string[],
): Promise<void> {
  const alertType = quarantined ? "quarantined" : "first-fire";
  const alertKey = `reconcile_failure_${alertType}:${vm.id}`;

  // Suppress if we've already sent this exact alert in the last 24h.
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id", { count: "exact", head: true })
    .eq("alert_key", alertKey)
    .gte("sent_at", oneDayAgo);
  if ((count ?? 0) > 0) {
    logger.info("reconcile-fleet: failure alert suppressed (24h dedup)", {
      route: "cron/reconcile-fleet", vmId: vm.id, alertKey,
    });
    return;
  }

  const subject = quarantined
    ? `[InstaClaw] reconcile QUARANTINED — ${vm.name ?? vm.id.slice(0, 8)} (${counter} consecutive failures)`
    : `[InstaClaw] reconcile failing — ${vm.name ?? vm.id.slice(0, 8)} (first fire)`;

  const body = [
    quarantined
      ? `VM ${vm.name ?? vm.id} (${vm.id}) has been auto-quarantined from the reconcile-fleet cron after ${counter} consecutive failures.`
      : `VM ${vm.name ?? vm.id} (${vm.id}) just started failing reconcile. Tracking for ${RECONCILE_QUARANTINE_THRESHOLD - counter} more failures before auto-quarantine.`,
    "",
    `cv:                  ${vm.config_version ?? 0}`,
    `manifest:            v${VM_MANIFEST.version}`,
    `consecutive failures: ${counter}`,
    `assigned_to:         ${vm.assigned_to ?? "(none)"}`,
    "",
    `Recent errors (most recent reconcile cycle):`,
    ...errors.slice(0, 5).map((e) => `  ${e.slice(0, 200)}`),
    "",
    quarantined ? "Operator action required:" : "If failures continue, this VM will auto-quarantine within ~30 min.",
    quarantined ? "  1. Investigate root cause via reconcile_last_error column" : "  Watch reconcile_last_error column for the specific failing step.",
    quarantined ? "  2. Fix the issue (often a step* function bug)" : "",
    quarantined ? "  3. Manually clear: UPDATE instaclaw_vms SET reconcile_quarantined_at = NULL, reconcile_consecutive_failures = 0 WHERE id = '" + vm.id + "';" : "",
    "",
    "Dashboards:",
    `  SELECT name, config_version, reconcile_consecutive_failures, reconcile_last_error FROM instaclaw_vms WHERE reconcile_consecutive_failures > 0 OR reconcile_quarantined_at IS NOT NULL ORDER BY reconcile_consecutive_failures DESC;`,
  ].join("\n");

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: alertKey,
    vm_count: 1,
    details: `sent: ${subject}`,
  });

  await sendAdminAlertEmail(subject, body);
  logger.info("reconcile-fleet: failure alert dispatched", {
    route: "cron/reconcile-fleet",
    vmId: vm.id,
    alertKey,
    counter,
    quarantined,
  });
}

// Touch to bust Vercel nft trace cache (2026-05-18T18:30 UTC). The pre-bake-check
// flagged STALE_BUNDLE hash 9a4afc5c8d0e5348 firing in the last 24h → reconcile-fleet
// is correctly halting at the integrity gate. This redeploy pushes the current
// v105 manifest into the function bundle. cv-lag for 131 VMs should drain to ≤5 over
// the next ~20 ticks (1 hour) once Vercel picks up this commit.

/**
 * Mid-tier reconcile-failure alert. Fires when a VM has accumulated
 * RECONCILE_PERSISTENT_THRESHOLD (3) consecutive failures but hasn't yet
 * reached the auto-quarantine threshold (K=10). Fills the silent gap
 * between the existing counter==1 first-fire alert and the counter==K
 * quarantine alert.
 *
 * Trigger windows:
 *   counter=1                → sendReconcileFailureAlert (first-fire)
 *   counter=2                → silent (still plausibly transient)
 *   counter=3 ... K-1        → sendReconcilePersistentFailureAlert (this fn)
 *   counter>=K (=10)         → sendReconcileFailureAlert (quarantine)
 *
 * Dedup: 12h per-VM. The persistent and quarantine alerts use DIFFERENT
 * alert_key prefixes, so a VM that fires at counter=3 then crosses K
 * within the dedup window will still get the quarantine email — only
 * subsequent persistent-tier re-fires are suppressed.
 *
 * Body includes:
 *   - VM name + owner email (looked up best-effort from instaclaw_users)
 *   - cv current vs manifest target
 *   - consecutive failure count + wall-clock since first failure
 *   - ticks remaining before auto-quarantine
 *   - last error snippet (first 5 errors, 200 chars each)
 *
 * Never throws — caller fires-and-forgets via .catch(). Alert delivery
 * failures must NEVER interrupt the cron.
 */
async function sendReconcilePersistentFailureAlert(
  supabase: SupabaseClient,
  vm: {
    id: string;
    name: string | null;
    config_version: number | null;
    assigned_to?: string | null;
    reconcile_first_failure_at?: string | null;
  },
  counter: number,
  errors: string[],
): Promise<void> {
  const alertKey = `reconcile_failure_persistent:${vm.id}`;
  const cutoff = new Date(
    Date.now() - RECONCILE_PERSISTENT_DEDUP_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { count: recent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id", { count: "exact", head: true })
    .eq("alert_key", alertKey)
    .gte("sent_at", cutoff);
  if ((recent ?? 0) > 0) {
    logger.info("reconcile-fleet: persistent-fail alert suppressed (12h dedup)", {
      route: "cron/reconcile-fleet", vmId: vm.id, alertKey, counter,
    });
    return;
  }

  // Best-effort owner email lookup. Surfacing the email in the alert
  // turns "vm-852 failing" into "Doug Rathell's vm-725 is failing" —
  // saves the operator a SQL join during triage. Failure mode here is
  // non-fatal: a missing email still gets the alert dispatched with
  // "(unknown)".
  let ownerEmail = "(unknown)";
  if (vm.assigned_to) {
    try {
      const { data: u } = await supabase
        .from("instaclaw_users")
        .select("email")
        .eq("id", vm.assigned_to)
        .maybeSingle();
      if (u?.email) ownerEmail = u.email;
    } catch {
      // best-effort only
    }
  }

  // Time-since-first-failure for the body. If first_failure_at is NULL
  // (race with reset, or upstream select missed the column) fall back to
  // the counter × cron-cadence approximation.
  let sinceFirstStr = `${counter} ticks (~${counter * 3} min, cron is every 3 min)`;
  if (vm.reconcile_first_failure_at) {
    const ms = Date.now() - new Date(vm.reconcile_first_failure_at).getTime();
    if (ms > 0) {
      const min = Math.round(ms / 60000);
      sinceFirstStr =
        min < 90 ? `${min} min` : `${(min / 60).toFixed(1)} hours`;
    }
  }

  const ticksToQuarantine = Math.max(
    0,
    RECONCILE_QUARANTINE_THRESHOLD - counter,
  );

  const subject = `[InstaClaw] reconcile persistently failing — ${vm.name ?? vm.id.slice(0, 8)} (${counter} consecutive failures)`;
  const body = [
    `VM ${vm.name ?? vm.id} (${vm.id}) has failed reconcile ${counter} times in a row over the last ${sinceFirstStr}.`,
    "",
    `This is past transient territory — the same step is likely failing every cycle. Investigate before the VM auto-quarantines at counter=${RECONCILE_QUARANTINE_THRESHOLD} (${ticksToQuarantine} more ticks).`,
    "",
    `vm:                  ${vm.name ?? "(unnamed)"}`,
    `vm_id:               ${vm.id}`,
    `owner_email:         ${ownerEmail}`,
    `cv:                  ${vm.config_version ?? 0}`,
    `manifest:            v${VM_MANIFEST.version}`,
    `consecutive failures: ${counter}`,
    `time since first fail: ${sinceFirstStr}`,
    `ticks until quarantine: ${ticksToQuarantine}`,
    "",
    "Recent errors (most recent reconcile cycle):",
    ...errors.slice(0, 5).map((e) => `  ${e.slice(0, 200)}`),
    "",
    "Triage:",
    `  SELECT name, config_version, reconcile_consecutive_failures, reconcile_first_failure_at, reconcile_last_error FROM instaclaw_vms WHERE id = '${vm.id}';`,
    "",
    "If the failing step is acceptable (e.g. partner skill install on a non-partner VM, optional sidecar), reclassify it from result.errors to result.warnings per Rule 39. Otherwise fix the root cause; then either wait for natural success or manually reset:",
    `  UPDATE instaclaw_vms SET reconcile_consecutive_failures = 0, reconcile_first_failure_at = NULL, reconcile_last_error = NULL WHERE id = '${vm.id}';`,
    "",
    `Dedup: ${RECONCILE_PERSISTENT_DEDUP_HOURS}h via alert_key="${alertKey}". Same-VM persistent-tier alerts within this window will be suppressed; quarantine-tier (counter>=${RECONCILE_QUARANTINE_THRESHOLD}) uses a different key and is NOT suppressed.`,
  ].join("\n");

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: alertKey,
    vm_count: 1,
    details: `sent: ${subject}`,
  });

  await sendAdminAlertEmail(subject, body);
  logger.info("reconcile-fleet: persistent-failure alert dispatched", {
    route: "cron/reconcile-fleet",
    vmId: vm.id,
    alertKey,
    counter,
    ticksToQuarantine,
  });
}

/**
 * End-of-cron staleness sweep. Catches the failure mode that's
 * STRUCTURALLY DISTINCT from the per-VM consecutive-failure path:
 * VMs the candidate query isn't reaching at all. A VM that's being
 * attempted every cycle but failing will have a fresh
 * reconcile_last_failure_at (set inside recordReconcileFailure); a VM
 * the batch isn't sweeping will have NULL or stale last-failure.
 * Filtering by "no recent attempt" cleanly isolates the silently-not-
 * reached cohort.
 *
 * Why this is a separate signal: the per-VM alert fires on ANY VM that
 * keeps failing, but says nothing about VMs that never get touched
 * (because they're starved out by a slow per-VM timeout, or excluded
 * by an unintended filter, or stuck at cv=current despite needing
 * work). Without this sweep, the next "23h cron halt"-class structural
 * bug would create another silent-stuck cohort just like before.
 *
 * Without a generic last-attempt timestamp column on instaclaw_vms,
 * "no recent attempt" is approximated as:
 *   reconcile_last_failure_at IS NULL OR reconcile_last_failure_at < (now - 2h)
 *
 * Excludes:
 *   - non-healthy / non-assigned VMs (suspended/hibernating don't need to
 *     be reconciled until they're paid back into service)
 *   - quarantined VMs (already covered by the quarantine-tier alert)
 *
 * Single deduped summary alert (12h key) — per-VM granularity would spam
 * during a structural regression that strands many VMs at once.
 *
 * Never throws — caller wraps in .catch().
 */
async function runStalenessSweep(supabase: SupabaseClient): Promise<void> {
  const behindCutoff = VM_MANIFEST.version - STALENESS_SWEEP_BEHIND_BY;
  const attemptCutoff = new Date(
    Date.now() - STALENESS_SWEEP_ATTEMPT_AGE_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // 200-row cap is generous — if more than 200 VMs are stale, the
  // operator has bigger problems than the alert payload size, and the
  // sample below will still surface the worst-behind cohort.
  const { data, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, config_version, reconcile_last_failure_at, assigned_to")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .lt("config_version", behindCutoff)
    .is("reconcile_quarantined_at", null)
    .or(
      `reconcile_last_failure_at.is.null,reconcile_last_failure_at.lt.${attemptCutoff}`,
    )
    .limit(200);

  if (error) {
    logger.warn("reconcile-fleet: staleness sweep query failed", {
      route: "cron/reconcile-fleet", error: error.message,
    });
    return;
  }
  const stale = data ?? [];
  if (stale.length === 0) {
    logger.info("reconcile-fleet: staleness sweep clean", {
      route: "cron/reconcile-fleet",
      manifestVersion: VM_MANIFEST.version,
      behindCutoff,
      attemptCutoffH: STALENESS_SWEEP_ATTEMPT_AGE_HOURS,
    });
    return;
  }

  // 12h dedup keyed by a fixed string (summary alert, not per-VM).
  const alertKey = "reconcile_staleness_sweep";
  const dedupCutoff = new Date(
    Date.now() - STALENESS_SWEEP_DEDUP_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { count: recent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id", { count: "exact", head: true })
    .eq("alert_key", alertKey)
    .gte("sent_at", dedupCutoff);
  if ((recent ?? 0) > 0) {
    logger.info("reconcile-fleet: staleness sweep alert suppressed (12h dedup)", {
      route: "cron/reconcile-fleet", vmCount: stale.length,
    });
    return;
  }

  // Sort by cv ascending → the most-behind VMs surface in the sample.
  const samples = stale
    .slice()
    .sort((a, b) => (a.config_version ?? 0) - (b.config_version ?? 0))
    .slice(0, 20);

  const subject = `[InstaClaw] reconcile staleness sweep — ${stale.length} VMs silently stuck`;
  const bodyLines = [
    `${stale.length} assigned+healthy VMs are >= ${STALENESS_SWEEP_BEHIND_BY} versions behind manifest v${VM_MANIFEST.version} AND have no reconcile attempt logged in the last ${STALENESS_SWEEP_ATTEMPT_AGE_HOURS}h.`,
    "",
    "This is the silently-not-reached failure mode — STRUCTURALLY DISTINCT from active reconcile failures (those fire per-VM 'persistent failure' alerts because the counter is ticking). Likely causes:",
    "  • The candidate query is excluding these VMs by an unintended filter",
    "  • Per-VM timeout is short enough that batches starve some VMs (Rule 44 territory)",
    "  • A prior bug (Rule 23 lying-DB, Rule 44 strict-deadline) marked cv ahead of actual disk state",
    "  • cv was manually set ahead of actual on-disk state by an admin script",
    "",
    `Sample (showing ${samples.length} of ${stale.length}, sorted by cv ascending):`,
    ...samples.map((v) => {
      const lastFail = v.reconcile_last_failure_at ?? "never";
      return `  ${v.name ?? v.id.slice(0, 8)}: cv=${v.config_version ?? 0}, last_failure=${lastFail}`;
    }),
    ...(stale.length > samples.length
      ? [`  ... and ${stale.length - samples.length} more`]
      : []),
    "",
    "Investigation query:",
    `  SELECT name, config_version, reconcile_last_failure_at, reconcile_last_error, reconcile_quarantined_at`,
    `  FROM instaclaw_vms`,
    `  WHERE status='assigned' AND health_status='healthy' AND config_version < ${behindCutoff}`,
    `    AND reconcile_quarantined_at IS NULL`,
    `    AND (reconcile_last_failure_at IS NULL OR reconcile_last_failure_at < (now() - interval '${STALENESS_SWEEP_ATTEMPT_AGE_HOURS} hours'))`,
    `  ORDER BY config_version ASC, name ASC;`,
    "",
    "Recovery options (in priority order):",
    "  1. Manually trigger /api/cron/reconcile-fleet to walk the batch with these VMs prioritized.",
    "  2. If a specific cohort is excluded by a filter, audit the candidate query in route.ts.",
    `  3. For known good-state VMs falsely flagged (lying-DB-LOW per Root Cause 3): UPDATE instaclaw_vms SET config_version = ${VM_MANIFEST.version} WHERE name IN (...);`,
    "",
    `Dedup: ${STALENESS_SWEEP_DEDUP_HOURS}h via alert_key="${alertKey}".`,
  ];

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: alertKey,
    vm_count: stale.length,
    details: `${stale.length} VMs >= ${STALENESS_SWEEP_BEHIND_BY} behind v${VM_MANIFEST.version}, last_attempt > ${STALENESS_SWEEP_ATTEMPT_AGE_HOURS}h ago`,
  });

  await sendAdminAlertEmail(subject, bodyLines.join("\n"));
  logger.warn("reconcile-fleet: staleness sweep alert dispatched", {
    route: "cron/reconcile-fleet",
    vmCount: stale.length,
    behindCutoff,
    attemptAgeHours: STALENESS_SWEEP_ATTEMPT_AGE_HOURS,
  });
}
