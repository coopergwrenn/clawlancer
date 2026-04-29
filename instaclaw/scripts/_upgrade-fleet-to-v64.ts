/**
 * One-shot fleet upgrade runner — bring all healthy assigned VMs to v64.
 *
 * Why this script exists:
 *   The Vercel reconcile-fleet cron has a 300s maxDuration. Per-VM upgrade
 *   time for the v64 (Node 22.22.2 + OpenClaw 2026.4.26) bump is ~5 min on
 *   a v63 VM and 7-15 min on older versions. The cron times out before
 *   completing even a single VM, so the fleet is deadlocked at v63 with
 *   zero progress despite the cron running every 3 min for hours.
 *
 *   This script bypasses Vercel by calling auditVMConfig() directly from
 *   a long-running local Node process. No timeout. Sequential. Idempotent.
 *
 * Behavior:
 *   - Acquires the reconcile-fleet cron lock so the Vercel cron stops
 *     competing for the same VMs while this is running.
 *   - Sorts: power tier → pro tier → starter tier → free, then by
 *     config_version ascending (oldest version processed first within
 *     each tier — so a v55 power user goes before a v62 power user).
 *   - For each VM: calls auditVMConfig(), bumps config_version to manifest
 *     version on success (errors empty), logs to file + stdout.
 *   - Ctrl+C: finishes the current VM (no clean way to cancel an in-flight
 *     SSH chain), then releases the lock and exits.
 *
 * Usage:
 *   npx tsx scripts/_upgrade-fleet-to-v64.ts                 # dry-run (default)
 *   npx tsx scripts/_upgrade-fleet-to-v64.ts --execute       # actually run
 *   npx tsx scripts/_upgrade-fleet-to-v64.ts --tier=power,pro --execute
 *   npx tsx scripts/_upgrade-fleet-to-v64.ts --max=5 --execute   # process first 5
 *   npx tsx scripts/_upgrade-fleet-to-v64.ts --no-lock --execute # skip cron lock
 */
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
dotenv.config({ path: path.join(__dirname, "../.env.ssh-key") });
dotenv.config({ path: path.join(__dirname, "../.env.local") });

import { createClient } from "@supabase/supabase-js";
import { auditVMConfig } from "../lib/ssh";
import { VM_MANIFEST } from "../lib/vm-manifest";
import { tryAcquireCronLock, releaseCronLock } from "../lib/cron-lock";
import { NodeSSH } from "node-ssh";

// ─── Browser-relay-server post-step (path B from the 2026-04-29 v65 audit) ──
// e85666d added the browser-relay install ONLY to configureOpenClaw, not to
// reconcileVM. Existing VMs reconciled to v65 bump their version but never
// get the relay deployed — confirmed broken on vm-867 (DB v65, relay
// missing, /relay/extension/status returned 502 via Caddy). Until a proper
// reconcile step lands (path A), this script invokes the same install
// inline after every successful version bump.
const SERVER_JS = fs.readFileSync(
  path.join(__dirname, "browser-relay-server/browser-relay-server.js"),
  "utf-8",
);
const SERVICE_UNIT = fs.readFileSync(
  path.join(__dirname, "browser-relay-server/browser-relay-server.service"),
  "utf-8",
);
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

interface RelayDeployResult {
  ok: boolean;
  reason: string;
  caddyStatus?: number;
}

/**
 * Mirror of scripts/_deploy-browser-relay-to-vm.ts:main() — SCP the
 * server.js + systemd unit, daemon-reload + enable + restart, verify
 * is-active and Caddy public proxy round-trips. Returns ok=true only when
 * the unit is active AND the public Caddy probe returns 200 (so the
 * dashboard's "isUnavailable" status check would now pass).
 */
async function deployBrowserRelay(vm: { ip_address: string; gateway_url?: string | null; name?: string | null; }): Promise<RelayDeployResult> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: vm.ip_address, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 12_000 });

    await ssh.execCommand("mkdir -p ~/scripts ~/.config/systemd/user");
    const sftp = await ssh.requestSFTP();
    await new Promise<void>((res, rej) => sftp.writeFile("/home/openclaw/scripts/browser-relay-server.js", Buffer.from(SERVER_JS, "utf-8"), (err) => err ? rej(err) : res()));
    await new Promise<void>((res, rej) => sftp.writeFile("/home/openclaw/.config/systemd/user/browser-relay-server.service", Buffer.from(SERVICE_UNIT, "utf-8"), (err) => err ? rej(err) : res()));
    sftp.end();

    const sysctl = (cmd: string) => `export XDG_RUNTIME_DIR="/run/user/$(id -u)"; systemctl --user ${cmd}`;
    await ssh.execCommand(sysctl("daemon-reload"));
    await ssh.execCommand(sysctl("enable browser-relay-server.service"));
    const restart = await ssh.execCommand(sysctl("restart browser-relay-server.service"));
    if (restart.code !== 0) return { ok: false, reason: `restart failed: ${restart.stderr.slice(0, 160)}` };

    await new Promise((r) => setTimeout(r, 1500));
    const active = await ssh.execCommand(sysctl("is-active browser-relay-server.service"));
    if (active.stdout.trim() !== "active") return { ok: false, reason: `unit not active: ${active.stdout.trim()}` };

    // Public Caddy probe — confirms the wire all the way through (this is
    // what the dashboard's status check hits via /api/vm/extension-status).
    if (vm.gateway_url) {
      try {
        const res = await fetch(`${vm.gateway_url.replace(/\/+$/, "")}/relay/extension/status`, {
          signal: AbortSignal.timeout(5000),
        });
        return { ok: res.status === 200, reason: res.status === 200 ? "active + Caddy 200" : `Caddy status ${res.status}`, caddyStatus: res.status };
      } catch (err) {
        return { ok: false, reason: `Caddy probe failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}` };
      }
    }
    return { ok: true, reason: "active (no gateway_url to probe via Caddy)" };
  } finally {
    try { ssh.dispose(); } catch { /* noop */ }
  }
}

// ─── Args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const isExecute = argv.includes("--execute");
const skipLock = argv.includes("--no-lock");
const tierArg = argv.find(a => a.startsWith("--tier="))?.split("=")[1];
const allowedTiers = tierArg ? new Set(tierArg.split(",").map(s => s.trim())) : null;
const maxArg = argv.find(a => a.startsWith("--max="))?.split("=")[1];
const maxCount = maxArg ? parseInt(maxArg, 10) : Infinity;
const concurrencyArg = argv.find(a => a.startsWith("--concurrency="))?.split("=")[1];
const concurrency = Math.max(1, concurrencyArg ? parseInt(concurrencyArg, 10) : 5);

// ─── Constants ────────────────────────────────────────────────────────
const TIER_PRIORITY: Record<string, number> = {
  power: 0,
  pro: 1,
  starter: 2,
  free: 3,
};
const CRON_LOCK_TTL_S = 8 * 3600; // 8h — long enough for the run, short enough that a crash doesn't block cron forever
const CRON_LOCK_HOLDER = "manual-fleet-upgrade-v64";

// ─── Supabase ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ─── Logging ───────────────────────────────────────────────────────────
const logFile = `/tmp/upgrade-fleet-v64-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
let logStream: fs.WriteStream | null = null;
function log(msg: string) {
  console.log(msg);
  if (logStream) logStream.write(msg + "\n");
}

// ─── Graceful shutdown ─────────────────────────────────────────────────
let cancelRequested = false;
let cleaningUp = false;
async function cleanup(reason: string, code: number) {
  if (cleaningUp) return;
  cleaningUp = true;
  log(`\n[cleanup] reason=${reason}`);
  if (isExecute && !skipLock) {
    try {
      await releaseCronLock("reconcile-fleet");
      log("[cleanup] released reconcile-fleet cron lock");
    } catch (err) {
      log(`[cleanup] lock release failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (logStream) {
    logStream.end();
    log(`[cleanup] log saved to ${logFile}`);
  }
  process.exit(code);
}
process.on("SIGINT", () => {
  if (cancelRequested) {
    // Second Ctrl+C — hard exit
    console.log("\n[SIGINT] second Ctrl+C, hard exit (lock will leak until TTL ~8h)");
    process.exit(130);
  }
  cancelRequested = true;
  console.log("\n[SIGINT] cancellation requested. Will finish current VM (may take several minutes), then exit. Press Ctrl+C again to force-kill.");
});
process.on("SIGTERM", () => { cancelRequested = true; });

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  log("═".repeat(80));
  log("FLEET UPGRADE TO v64 — LOCAL RUNNER");
  log("═".repeat(80));
  log(`mode:           ${isExecute ? "EXECUTE (live)" : "DRY-RUN"}`);
  log(`manifest:       v${VM_MANIFEST.version}`);
  log(`tier filter:    ${allowedTiers ? Array.from(allowedTiers).join(",") : "(all)"}`);
  log(`max:            ${maxCount === Infinity ? "(no cap)" : maxCount}`);
  log(`concurrency:    ${concurrency}`);
  log(`cron lock:      ${skipLock ? "SKIPPED" : `acquire (TTL ${CRON_LOCK_TTL_S}s)`}`);
  log(`log file:       ${logFile}`);
  log("");

  // ─── Acquire cron lock ────────────────────────────────────────────
  if (isExecute && !skipLock) {
    const acquired = await tryAcquireCronLock("reconcile-fleet", CRON_LOCK_TTL_S, CRON_LOCK_HOLDER);
    if (!acquired) {
      log("[FAIL] could not acquire reconcile-fleet cron lock — Vercel cron is running.");
      log("       options:");
      log("       1. wait 6 min for Vercel cron to release (its TTL is 360s)");
      log("       2. force-clear: DELETE FROM instaclaw_cron_locks WHERE name='reconcile-fleet';");
      log("       3. re-run with --no-lock (RISKY: races with Vercel cron)");
      process.exit(1);
    }
    log("[ok] acquired reconcile-fleet cron lock");
  } else if (isExecute && skipLock) {
    log("[warn] --no-lock: not blocking Vercel cron. Both may try to reconcile the same VM. Per-VM lifecycle_locked_at protects against double-restart but doesn't protect against double-install.");
  }

  // ─── Query candidates ─────────────────────────────────────────────
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, health_status, status, assigned_to, config_version, tier, api_mode, user_timezone, default_model")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .lt("config_version", VM_MANIFEST.version)
    .not("gateway_url", "is", null);

  if (error) {
    log(`[FAIL] query error: ${error.message}`);
    await cleanup("query-failed", 1);
    return;
  }
  if (!vms || vms.length === 0) {
    log("No candidates. All assigned/healthy VMs are at manifest version.");
    await cleanup("no-candidates", 0);
    return;
  }

  // ─── Sort + filter ────────────────────────────────────────────────
  let pool = vms;
  if (allowedTiers) {
    pool = pool.filter(v => allowedTiers.has(v.tier ?? ""));
    log(`[filter] tier filter applied: ${pool.length} of ${vms.length} matched`);
  }
  pool.sort((a, b) => {
    const at = TIER_PRIORITY[a.tier ?? ""] ?? 99;
    const bt = TIER_PRIORITY[b.tier ?? ""] ?? 99;
    if (at !== bt) return at - bt;
    return (a.config_version ?? 0) - (b.config_version ?? 0);
  });
  if (maxCount !== Infinity) pool = pool.slice(0, maxCount);

  // Distribution preview
  const tierCounts: Record<string, number> = {};
  const versionCounts: Record<string, number> = {};
  for (const v of pool) {
    tierCounts[v.tier ?? "?"] = (tierCounts[v.tier ?? "?"] || 0) + 1;
    versionCounts[String(v.config_version ?? "?")] = (versionCounts[String(v.config_version ?? "?")] || 0) + 1;
  }
  log(`\n=== Candidates: ${pool.length} ===`);
  log(`tier:       ${Object.entries(tierCounts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  log(`version:    ${Object.entries(versionCounts).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `v${k}=${v}`).join("  ")}`);
  log("");

  // First 10 + last 5 preview
  log("first 10:");
  for (let i = 0; i < Math.min(10, pool.length); i++) {
    const v = pool[i];
    log(`  ${i + 1}. ${(v.name ?? v.id).padEnd(20)} tier=${(v.tier ?? "?").padEnd(8)} v${v.config_version}  ${v.ip_address}`);
  }
  if (pool.length > 15) {
    log(`  ... ${pool.length - 15} more ...`);
    log("last 5:");
    for (let i = pool.length - 5; i < pool.length; i++) {
      const v = pool[i];
      log(`  ${i + 1}. ${(v.name ?? v.id).padEnd(20)} tier=${(v.tier ?? "?").padEnd(8)} v${v.config_version}  ${v.ip_address}`);
    }
  }
  log("");

  if (!isExecute) {
    log("═".repeat(80));
    log("DRY-RUN. No changes made.");
    log("Re-run with --execute to actually upgrade these VMs.");
    log("═".repeat(80));
    await cleanup("dry-run-done", 0);
    return;
  }

  // ─── Execute ──────────────────────────────────────────────────────
  logStream = fs.createWriteStream(logFile, { flags: "a" });
  log(`\n=== Starting live run at ${new Date().toISOString()} ===\n`);

  let successes = 0;
  let pushFailures = 0;  // result.errors non-empty
  let throwFailures = 0; // auditVMConfig threw
  let relayDeployOk = 0;
  let relayDeployFail = 0;
  const totalStartMs = Date.now();

  // ─── Wave-based concurrency with audit gates ───────────────────────
  // Each VM upgrade is independent (separate SSH, separate filesystem) so
  // concurrency=5 within a wave is safe — proven by the browser-relay deploy
  // (197 VMs, conc=5, 30s, zero failures).
  // BUT: a regression in shared code (manifest, reconciler) would otherwise
  // burn through the whole fleet before being noticed. The wave gate stops
  // that: process 10 VMs in parallel, then SSH-audit those same 10 against
  // 4 health checks (gateway active, /health 200, openclaw 2026.4.26,
  // SOUL.md v67 marker present). If any audit fails, halt — Cooper
  // investigates before the next wave.
  const WAVE_SIZE = 10;
  let completed = 0;

  async function processOne(i: number, vm: typeof pool[number]) {
    const t0 = Date.now();
    const startTs = new Date().toISOString();
    log(`[${(i + 1).toString().padStart(3)}/${pool.length}] ${startTs}  ${(vm.name ?? vm.id).padEnd(20)}  tier=${(vm.tier ?? "?").padEnd(8)} v${vm.config_version}→v${VM_MANIFEST.version}  ${vm.ip_address}`);

    let result: Awaited<ReturnType<typeof auditVMConfig>> | null = null;
    let threw: Error | null = null;
    try {
      result = await auditVMConfig(vm as Parameters<typeof auditVMConfig>[0], { strict: false, skipGatewayRestart: false });
    } catch (err) {
      threw = err instanceof Error ? err : new Error(String(err));
    }
    const dur = Math.round((Date.now() - t0) / 1000);

    if (threw) {
      throwFailures++;
      log(`  [${(i + 1).toString().padStart(3)}] ✗ THREW in ${dur}s: ${threw.message.slice(0, 200)}`);
      return;
    }
    if (!result) {
      throwFailures++;
      log(`  [${(i + 1).toString().padStart(3)}] ✗ no result (impossible) in ${dur}s`);
      return;
    }
    if (result.errors && result.errors.length > 0) {
      pushFailures++;
      log(`  [${(i + 1).toString().padStart(3)}] ✗ PUSH-FAILED in ${dur}s — ${result.errors.length} step error${result.errors.length > 1 ? "s" : ""}, fixed=${result.fixed.length}, gatewayRestarted=${result.gatewayRestarted}`);
      for (const e of result.errors.slice(0, 3)) log(`         • ${e.slice(0, 160)}`);
      return;
    }

    // Success: bump config_version
    const { error: updateErr } = await supabase
      .from("instaclaw_vms")
      .update({ config_version: VM_MANIFEST.version })
      .eq("id", vm.id);
    if (updateErr) {
      throwFailures++;
      log(`  [${(i + 1).toString().padStart(3)}] ✗ DB BUMP FAILED in ${dur}s: ${updateErr.message}`);
      return;
    }
    successes++;
    log(`  [${(i + 1).toString().padStart(3)}] ✓ v${vm.config_version}→v${VM_MANIFEST.version} in ${dur}s  fixed=${result.fixed.length}  alreadyCorrect=${result.alreadyCorrect.length}  gatewayRestarted=${result.gatewayRestarted}`);

    // Post-step: deploy browser-relay-server (path B for v65 rollout).
    const tRelay = Date.now();
    const relay = await deployBrowserRelay(vm as { ip_address: string; gateway_url?: string | null; name?: string | null });
    const relayDur = Math.round((Date.now() - tRelay) / 1000);
    if (relay.ok) {
      relayDeployOk++;
      log(`  [${(i + 1).toString().padStart(3)}] ↳ relay deployed in ${relayDur}s — ${relay.reason}`);
    } else {
      relayDeployFail++;
      log(`  [${(i + 1).toString().padStart(3)}] ↳ relay DEPLOY FAILED in ${relayDur}s — ${relay.reason}`);
    }
  }

  async function auditOneVM(vm: typeof pool[number]): Promise<{ ok: true } | { ok: false; reason: string }> {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ host: vm.ip_address, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 12_000 });
      // Health check has 3 retries × 10s timeout (was 1× 5s). The 5s probe
      // race-failed on VMs that had just come back from a gateway restart
      // — confirmed during wave 1 (vm-696/634/780 all failed audit but
      // returned health-OK 2 min later). 30s of retry headroom is plenty.
      const r = await ssh.execCommand(
        // emit one line per check, in order: ACTIVE / HEALTH / VERSION / MARKER
        `export XDG_RUNTIME_DIR="/run/user/$(id -u)"; ` +
        `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" 2>/dev/null; ` +
        `echo "ACTIVE:$(systemctl --user is-active openclaw-gateway 2>&1 | head -1)"; ` +
        `for i in 1 2 3; do ` +
          `curl -sf -o /dev/null --max-time 10 http://localhost:18789/health && { echo "HEALTH:OK"; break; }; ` +
          `if [ $i -lt 3 ]; then sleep 10; fi; ` +
          `if [ $i -eq 3 ]; then echo "HEALTH:FAIL"; fi; ` +
        `done; ` +
        `echo "VERSION:$(openclaw --version 2>&1 | head -1)"; ` +
        // v67 SOUL.md marker — the unique routing-table row introduced in commit 9dfe894
        `grep -q "Token launches deploy on Base mainnet" "$HOME/.openclaw/workspace/SOUL.md" 2>/dev/null && echo "MARKER:OK" || echo "MARKER:FAIL"`,
      );
      const lines: Record<string, string> = {};
      for (const ln of r.stdout.split("\n")) {
        const idx = ln.indexOf(":");
        if (idx > 0) lines[ln.slice(0, idx)] = ln.slice(idx + 1).trim();
      }
      if (lines.ACTIVE !== "active") return { ok: false, reason: `gateway not active (${lines.ACTIVE || "unknown"})` };
      if (lines.HEALTH !== "OK") return { ok: false, reason: `health endpoint failed` };
      if (!lines.VERSION || !lines.VERSION.includes("2026.4.26")) return { ok: false, reason: `openclaw version mismatch (${lines.VERSION || "missing"})` };
      if (lines.MARKER !== "OK") return { ok: false, reason: `SOUL.md v67 marker missing` };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `ssh: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
    } finally {
      try { ssh.dispose(); } catch { /* noop */ }
    }
  }

  let auditHaltReason: string | null = null;

  for (let waveStart = 0; waveStart < pool.length; waveStart += WAVE_SIZE) {
    if (cancelRequested) break;
    const waveEnd = Math.min(waveStart + WAVE_SIZE, pool.length);
    const wave = pool.slice(waveStart, waveEnd);
    const waveNum = Math.floor(waveStart / WAVE_SIZE) + 1;
    const totalWaves = Math.ceil(pool.length / WAVE_SIZE);

    log(`\n══════ Wave ${waveNum}/${totalWaves}: VMs ${waveStart + 1}-${waveEnd} (${wave.length}) — upgrading conc=${concurrency} ══════`);

    // Worker pool inside the wave
    let waveNextIdx = 0;
    async function waveWorker() {
      while (true) {
        if (cancelRequested) return;
        const i = waveNextIdx++;
        if (i >= wave.length) return;
        await processOne(waveStart + i, wave[i]);
        completed++;
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => waveWorker()));

    if (cancelRequested) break;

    // Audit the wave
    log(`\n══════ Wave ${waveNum}/${totalWaves}: auditing ${wave.length} VMs ══════`);
    const auditResults = await Promise.all(wave.map(async vm => ({ vm, audit: await auditOneVM(vm) })));
    const failures = auditResults.filter(r => !r.audit.ok);
    if (failures.length > 0) {
      log(`\n[HALT] wave ${waveNum} audit: ${failures.length}/${wave.length} VMs FAILED health check:`);
      for (const f of failures) {
        log(`  ✗ ${f.vm.name ?? f.vm.id}  ${f.vm.ip_address}  — ${(f.audit as { reason: string }).reason}`);
      }
      auditHaltReason = `wave ${waveNum} audit failed for ${failures.length} VMs`;
      break;
    }
    log(`         ✓ batch ${waveNum} verified clean (${wave.length}/${wave.length})`);

    // Per-wave progress summary
    const elapsedMin = Math.round((Date.now() - totalStartMs) / 60000);
    const remaining = pool.length - completed;
    const avgPerVM = (Date.now() - totalStartMs) / completed;
    const etaMin = Math.round((remaining * avgPerVM) / 60000 / concurrency);
    log(`         ──── progress ${completed}/${pool.length}  ${successes}✓ ${pushFailures + throwFailures}✗  relay=${relayDeployOk}✓/${relayDeployFail}✗  elapsed ${elapsedMin}min  ETA ${etaMin}min  conc=${concurrency} ────`);
  }

  if (auditHaltReason) {
    log(`\n[HALT] ${auditHaltReason} — investigation required before continuing`);
  }

  // ─── Final summary ────────────────────────────────────────────────
  const totalMin = Math.round((Date.now() - totalStartMs) / 60000);
  log(`\n═══════════════════════════════════════════════════════════════════════════════`);
  log(`DONE at ${new Date().toISOString()} — ${totalMin}min total`);
  log(`successes:        ${successes}`);
  log(`push-failures:    ${pushFailures} (auditVMConfig returned non-empty errors[])`);
  log(`throw-failures:   ${throwFailures} (auditVMConfig or DB update threw)`);
  log(`relay deploy ok:  ${relayDeployOk} (browser-relay-server installed + Caddy 200)`);
  log(`relay deploy ✗:   ${relayDeployFail} (post-step failed — version bumped but relay not running)`);
  log(`cancelled:        ${cancelRequested ? "yes" : "no"}`);
  log(`═══════════════════════════════════════════════════════════════════════════════`);

  await cleanup("done", successes > 0 || (pushFailures + throwFailures) === 0 ? 0 : 2);
}

main().catch(async (err) => {
  log(`\n[FATAL] ${err instanceof Error ? err.stack : String(err)}`);
  await cleanup("fatal", 1);
});
