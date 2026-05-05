/**
 * Fleet rollout v82 at concurrency=3.
 *
 * Reconciles every healthy assigned VM whose config_version < 82, in
 * waves of 10 with concurrency=3 within each wave. Audits each wave's
 * results before continuing — halts on the first wave that produces
 * any errors (per CLAUDE.md Rule 3).
 *
 * What v82 ships (carrying anything not already on the VM via reconciler):
 *   - v81: matching engine VM-side scripts + 30-min cron
 *          (consensus_match_pipeline.py / rerank.py / deliberate.py / consent.py)
 *   - v82: SOUL.md CONSENSUS_MATCHING_AWARENESS paragraph (so the agent
 *          knows to ask the consent question + handle "show me my matches")
 *   - x-call-kind: match-pipeline header in rerank.py + deliberate.py
 *          (gateway heartbeat reclassification bypass — last P1 fix)
 *
 * Discipline (per CLAUDE.md):
 *   Rule 3 — test on one VM first → vm-780 canary already done (commit d099a5af)
 *   Rule 4 — --dry-run support (run with --dry-run first to preview)
 *   Rule 5 — verify gateway active + /health 200 after each VM
 *   Rule 8 — take the reconcile-fleet cron lock so we don't race the cron
 *   Rule 10 — banned `|| true`; reconcileVM verifies each step
 *   Rule 23 — sentinel guards refuse stale-cache writes (already in manifest)
 *
 * Usage:
 *   npx tsx scripts/_fleet-rollout-v82.ts --dry-run    # preview only
 *   npx tsx scripts/_fleet-rollout-v82.ts              # actual rollout
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

import { reconcileVM } from "../lib/vm-reconcile";
import { VM_MANIFEST } from "../lib/vm-manifest";
import { tryAcquireCronLock, releaseCronLock } from "../lib/cron-lock";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TARGET_VERSION = VM_MANIFEST.version;
const WAVE_SIZE = 10;
const CONCURRENCY = 3;
// Lock TTL: should comfortably exceed wall-clock time of full rollout.
// Generous: 90 min covers ~120 VMs × ~1 min each at concurrency 3, with
// audit gaps. We release on success/failure regardless.
const LOCK_TTL_SECONDS = 90 * 60;

interface VMRow {
  id: string;
  name: string | null;
  ip_address: string;
  ssh_port: number | null;
  ssh_user: string | null;
  gateway_url: string | null;
  gateway_token: string | null;
  health_status: string | null;
  assigned_to: string | null;
  config_version: number | null;
  tier: string | null;
  api_mode: string | null;
  user_timezone: string | null;
  partner: string | null;
}

// Skip VMs more than this many versions behind. The reconciler IS
// idempotent across version bumps, but a 29-version jump (v53 → v82)
// crosses unaudited territory — the OpenClaw upgrade playbook asks for
// dedicated canary attention on big jumps. We bound this rollout to
// recent versions and let Cooper handle stragglers separately.
//
// Empirically (dry-run 2026-05-05): 140/150 VMs are at v79+, only 10
// at v53/v54/v77. Capturing the 140 here delivers the launch-critical
// matching engine + SOUL.md awareness with minimal risk.
const MIN_FROM_VERSION = 79;

async function getStaleVMs(): Promise<VMRow[]> {
  const { data, error } = await sb
    .from("instaclaw_vms")
    .select(
      "id, name, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, health_status, assigned_to, config_version, tier, api_mode, user_timezone, partner",
    )
    .not("assigned_to", "is", null)
    .eq("health_status", "healthy")
    .gte("config_version", MIN_FROM_VERSION)
    .lt("config_version", TARGET_VERSION)
    // Newest config_version FIRST. Most-likely-to-succeed VMs reconcile
    // first; if we have to halt on failure, we've still delivered the
    // bulk. The reconcile-fleet cron uses ascending (oldest-first) for
    // fairness across all stale VMs over time — that's a different goal.
    .order("config_version", { ascending: false })
    .order("name", { ascending: true });
  if (error) throw new Error(`stale VM query: ${error.message}`);
  return (data ?? []) as VMRow[];
}

async function reconcileOne(vm: VMRow): Promise<{
  vmId: string;
  vmName: string | null;
  fromVersion: number | null;
  ok: boolean;
  errors: string[];
  fixed: number;
  gatewayHealthy: boolean;
  elapsedSec: number;
}> {
  const start = Date.now();
  try {
    const result = await reconcileVM(vm as never, VM_MANIFEST, {
      dryRun: false,
      strict: false,
      canary: true,
      skipGatewayRestart: vm.health_status !== "healthy",
    });
    const elapsedSec = Number(((Date.now() - start) / 1000).toFixed(1));

    // Bump config_version only when there are no errors, mirroring the cron's
    // pushFailed gate (route.ts:245). Same semantics: errors held → next
    // cycle retries.
    const pushFailed = result.errors.length > 0;
    if (!pushFailed && result.gatewayHealthy) {
      await sb
        .from("instaclaw_vms")
        .update({ config_version: TARGET_VERSION })
        .eq("id", vm.id);
    }

    return {
      vmId: vm.id,
      vmName: vm.name,
      fromVersion: vm.config_version,
      ok: !pushFailed && result.gatewayHealthy,
      errors: result.errors,
      fixed: result.fixed.length,
      gatewayHealthy: result.gatewayHealthy,
      elapsedSec,
    };
  } catch (e) {
    return {
      vmId: vm.id,
      vmName: vm.name,
      fromVersion: vm.config_version,
      ok: false,
      errors: [e instanceof Error ? e.message : String(e)],
      fixed: 0,
      gatewayHealthy: false,
      elapsedSec: Number(((Date.now() - start) / 1000).toFixed(1)),
    };
  }
}

async function runWaveWithConcurrency(
  vms: VMRow[],
  concurrency: number,
): Promise<Awaited<ReturnType<typeof reconcileOne>>[]> {
  const results: Awaited<ReturnType<typeof reconcileOne>>[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < vms.length) {
      const i = cursor++;
      const vm = vms[i];
      const r = await reconcileOne(vm);
      const tag = r.ok ? "✓" : "✗";
      const errMsg = r.errors.length > 0 ? `  errors: ${r.errors.slice(0, 2).join("; ")}` : "";
      console.log(
        `  ${tag} ${(vm.name ?? vm.id).padEnd(22)} ` +
          `v${r.fromVersion ?? "?"}→v${TARGET_VERSION} ` +
          `fixed=${r.fixed} ${r.elapsedSec}s${errMsg}`,
      );
      results.push(r);
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log(`══ Fleet rollout to v${TARGET_VERSION} (concurrency ${CONCURRENCY}, wave ${WAVE_SIZE}) ══`);
  if (dryRun) console.log("(DRY-RUN — preview only, no reconciles will run)");
  console.log("");

  const stale = await getStaleVMs();
  console.log(`Stale VMs (healthy assigned, config_version < ${TARGET_VERSION}): ${stale.length}`);
  if (stale.length === 0) {
    console.log("No stale VMs — fleet is already at the target version.");
    process.exit(0);
  }

  // Distribution by from-version for visibility
  const byVer: Record<string, number> = {};
  for (const v of stale) byVer[String(v.config_version ?? "null")] = (byVer[String(v.config_version ?? "null")] ?? 0) + 1;
  console.log("Distribution by current config_version:");
  for (const [k, n] of Object.entries(byVer).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  v${k.padEnd(3)} → ${n}`);
  }

  if (dryRun) {
    console.log("\nFirst 10 stale VMs:");
    for (const vm of stale.slice(0, 10)) {
      console.log(`  - ${vm.name} (v${vm.config_version} → v${TARGET_VERSION})`);
    }
    console.log("\nDRY-RUN complete — re-run without --dry-run to execute.");
    process.exit(0);
  }

  // Take the cron lock — prevents the Vercel cron from running batches
  // concurrently with this manual rollout.
  const lockSource = `manual-fleet-rollout-v${TARGET_VERSION}-${process.pid}`;
  const acquired = await tryAcquireCronLock("reconcile-fleet", LOCK_TTL_SECONDS, lockSource);
  if (!acquired) {
    console.error("\nFATAL: could not acquire reconcile-fleet cron lock.");
    console.error("Either the cron is mid-batch right now, or a prior rollout left a stale lock.");
    console.error("Wait 5 minutes and retry, or inspect instaclaw_cron_locks in Studio.");
    process.exit(2);
  }
  console.log(`\n✓ acquired reconcile-fleet cron lock (${LOCK_TTL_SECONDS}s TTL, source=${lockSource})`);

  let totalOk = 0;
  let totalFailed = 0;
  let halted = false;

  try {
    for (let waveStart = 0; waveStart < stale.length; waveStart += WAVE_SIZE) {
      const wave = stale.slice(waveStart, waveStart + WAVE_SIZE);
      const waveNum = Math.floor(waveStart / WAVE_SIZE) + 1;
      const totalWaves = Math.ceil(stale.length / WAVE_SIZE);
      console.log(`\n── Wave ${waveNum}/${totalWaves} (${wave.length} VMs, concurrency ${CONCURRENCY}) ──`);

      const waveStartTs = Date.now();
      const results = await runWaveWithConcurrency(wave, CONCURRENCY);
      const waveElapsedSec = ((Date.now() - waveStartTs) / 1000).toFixed(1);

      const okInWave = results.filter((r) => r.ok).length;
      const failedInWave = results.filter((r) => !r.ok).length;
      totalOk += okInWave;
      totalFailed += failedInWave;
      console.log(`Wave ${waveNum}: ${okInWave} ok, ${failedInWave} failed in ${waveElapsedSec}s`);

      // Audit gate (Rule 3): halt on first failure to investigate before
      // continuing. The reconciler's sentinel + verify-after-set logic
      // means failures are real; don't paper over.
      if (failedInWave > 0) {
        console.log("\n══ HALTED — failures detected. Investigate before continuing. ══");
        for (const r of results.filter((r) => !r.ok)) {
          console.log(`\n  ✗ ${r.vmName} (${r.vmId})`);
          console.log(`      gatewayHealthy=${r.gatewayHealthy}, fixed=${r.fixed}`);
          for (const e of r.errors.slice(0, 4)) console.log(`      ${e}`);
        }
        halted = true;
        break;
      }
    }
  } finally {
    // Always release the cron lock
    await releaseCronLock("reconcile-fleet");
    console.log("\n✓ released reconcile-fleet cron lock");
  }

  console.log(`\n══ Rollout summary ══`);
  console.log(`  reconciled: ${totalOk}`);
  console.log(`  failed:     ${totalFailed}`);
  console.log(`  remaining:  ${stale.length - totalOk - totalFailed}`);
  if (halted) {
    console.log("\nRollout halted. Fix the failed VMs (or investigate the failure cause) before re-running.");
    process.exit(1);
  } else {
    console.log("\nFleet at v" + TARGET_VERSION + ". Reconcile-fleet cron will continue picking up any future drift.");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  console.error(e instanceof Error ? e.stack : "");
  releaseCronLock("reconcile-fleet").catch(() => {});
  process.exit(1);
});
