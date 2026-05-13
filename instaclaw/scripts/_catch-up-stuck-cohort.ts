/**
 * Catch up VMs that are stuck N+ versions behind the current manifest.
 *
 * THE PROBLEM (forensic intel from 2026-05-11 evening session):
 * --------------------------------------------------------------
 * The fleet has 67% of healthy assigned VMs (102/152) stuck at cv=82-85 while
 * the manifest is at v94. The Vercel cron's reconcile-fleet route processes
 * VMs but never advances them past cv=82 because:
 *
 *   1. reconcileVM in strict mode has a hardcoded 180s STRICT_DEADLINE_MS
 *      (vm-reconcile.ts:149). This is sized for Vercel's 300s function
 *      maxDuration (Rule 11): with 3 VMs per cron batch, ~100s per VM is the
 *      effective budget.
 *
 *   2. A VM at cv=82 needs to catch up 12 manifest versions of accumulated
 *      configSettings keys + files entries. In strict mode each key is
 *      read-verify-write-verify (3-5 SSH round-trips of ~1-3s each). For 29
 *      configSettings keys × 5s × multiple versions of drift, the catch-up
 *      legitimately needs 200-300s.
 *
 *   3. When the strict deadline fires, the error goes to
 *      `result.strictErrors`, NOT `result.errors`. The cron route classifies
 *      this as `strictFailed` (strict_hold_streak counter) NOT `pushFailed`
 *      (reconcile_consecutive_failures counter). The auto-quarantine at K=10
 *      from commit e2380e68 only fires on pushFailed, so persistent stalls
 *      are alerted but never auto-quarantined.
 *
 *   4. Even removing the 180s deadline doesn't help Vercel cron because it's
 *      still bounded by the 300s function maxDuration. cv=82 catch-up
 *      LITERALLY DOES NOT FIT in any Vercel cron tick.
 *
 * CONSEQUENCE: every fleet-wide feature is dead-on-arrival on the stuck
 * cohort. V2 SOUL.md, v94 ack-ux Layer 1+2 (👀 reactions, streaming preview),
 * gbrain, monitoring crons — none of them reach 67% of the fleet until this
 * is fixed. Edge Esmeralda is 19 days away.
 *
 * THE FIX (this script):
 * ----------------------
 * Run reconcileVM(strict=false) on the stuck cohort, from a LOCAL machine
 * (no 300s ceiling). Per-VM takes whatever it takes (typically 3-10 min for
 * cv=82 → v94). For each VM that completes clean, UPDATE config_version to
 * MANIFEST.version directly.
 *
 * THE COMPANION FIX (separate):
 * -----------------------------
 * vm-354 and vm-050 are at cv=92 with v94 messages.* keys on disk but their
 * gateway has never restarted since the keys were written. The
 * RESTART_REQUIRED_CONFIG_PREFIXES = ["messages."] trigger in stepConfigSettings
 * (vm-reconcile.ts:73) only fires when keys are WRITTEN, not when they're
 * alreadyCorrect. So these VMs need a one-shot manual gateway restart for
 * the closure-captured ackReaction/ackReactionScope/etc. to refresh. This is
 * NOT what this script does — see _restart-stale-closure-vms.ts (sibling).
 *
 * SAFETY:
 *   1. Acquires reconcile-fleet cron lock for the duration (Rule 8). The lock
 *      TTL is configurable; default 2 hours covers ~20 VMs at 5 min each
 *      sequentially. Operator should pick TTL based on cohort size.
 *   2. RECONCILE_SOUL_MIGRATION_ENABLED is NOT set. This script is PURELY
 *      catch-up. Do NOT run with V2 env vars in this process. V2 migration
 *      is a separate concern handled by _fleet-v2-rollout.ts.
 *   3. reconcileVM called with strict=false. Per-key verify-after-set is
 *      loosened in stepConfigSettings; the next Vercel cron tick re-verifies
 *      under strict mode after this script completes.
 *   4. Per-VM audit AFTER reconcile: gateway active + /health=200. If audit
 *      fails, log + continue (don't halt run on isolated failures).
 *   5. Per-wave halt threshold: if more than 30% of a wave fails the audit
 *      (default; configurable), halt the script for operator review.
 *   6. CV bump: only update config_version in DB if result.errors.length === 0.
 *      This mirrors the cron route's pushFailed gate (route.ts:405).
 *   7. Continue-on-error per VM: one VM's reconcile failure doesn't halt
 *      the run. Failures accumulate in a per-VM result table.
 *   8. Idempotent: re-running on a partially-completed cohort is safe.
 *      Already-current VMs are skipped (cv >= MANIFEST.version - min_gap).
 *   9. Process exit code via return-pattern (not process.exit) so the
 *      finally block runs releaseCronLock(). Same discipline as the
 *      ddb58683 fix.
 *
 * Usage:
 *   npx tsx scripts/_catch-up-stuck-cohort.ts [options]
 *
 * Options:
 *   --dry-run             read-only, no writes, no DB update
 *   --min-gap=N           target VMs at cv ≤ MANIFEST.version - N (default 5)
 *   --max-vms=N           stop after processing N VMs (default: unlimited)
 *   --vms=name1,name2     override automatic cohort selection
 *   --concurrency=N       worker concurrency (max 3, default 1)
 *   --wave-size=N         VMs per audit-gated wave (default 5)
 *   --lock-ttl-hours=N    cron lock TTL hours (default 2)
 *   --halt-fail-pct=N     halt if wave audit fail rate > N% (default 30)
 *   --yes                 skip interactive confirmation
 *
 * Examples:
 *   # Dry-run inspect the cohort
 *   npx tsx scripts/_catch-up-stuck-cohort.ts --dry-run
 *
 *   # Catch up just the 5 worst VMs (cv furthest behind)
 *   npx tsx scripts/_catch-up-stuck-cohort.ts --max-vms=5 --yes
 *
 *   # Targeted set
 *   npx tsx scripts/_catch-up-stuck-cohort.ts --vms=instaclaw-vm-882,instaclaw-vm-896 --yes
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";
import * as readline from "readline";

// ── env loading (CLAUDE.md Rule 18) ──
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

import { reconcileVM } from "../lib/vm-reconcile";
import { VM_MANIFEST } from "../lib/vm-manifest";
import { tryAcquireCronLock, releaseCronLock } from "../lib/cron-lock";

const sshKey = Buffer.from(
  process.env.SSH_PRIVATE_KEY_B64!,
  "base64",
).toString("utf-8");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// CRITICAL: this script must NEVER set RECONCILE_SOUL_MIGRATION_ENABLED.
// V2 migration is a separate concern handled by _fleet-v2-rollout.ts. If this
// script were to set the env var, every catch-up reconcile would also migrate
// the VM to V2 — a massively higher blast radius than what this script is for.
// Defensive: explicitly clear the env var if it's set in the parent shell.
if (process.env.RECONCILE_SOUL_MIGRATION_ENABLED === "true") {
  console.error(
    "FATAL: RECONCILE_SOUL_MIGRATION_ENABLED=true was set in parent shell. " +
      "This script does NOT do V2 migration. Unset and re-run.",
  );
  process.exit(64);
}
delete process.env.RECONCILE_SOUL_MIGRATION_ENABLED;
delete process.env.RECONCILE_SOUL_MIGRATION_VM_IDS;

// ── args ──
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const autoYes = args.includes("--yes");
const minGap = parseInt(
  args.find((a) => a.startsWith("--min-gap="))?.split("=")[1] ?? "5",
  10,
);
const maxVms = parseInt(
  args.find((a) => a.startsWith("--max-vms="))?.split("=")[1] ?? "0",
  10,
);
const concurrencyArg = parseInt(
  args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "1",
  10,
);
const concurrency = Math.min(3, Math.max(1, concurrencyArg));
const waveSize = parseInt(
  args.find((a) => a.startsWith("--wave-size="))?.split("=")[1] ?? "5",
  10,
);
const lockTtlHours = parseInt(
  args.find((a) => a.startsWith("--lock-ttl-hours="))?.split("=")[1] ?? "2",
  10,
);
const haltFailPct = parseInt(
  args.find((a) => a.startsWith("--halt-fail-pct="))?.split("=")[1] ?? "30",
  10,
);
const explicitVms =
  args
    .find((a) => a.startsWith("--vms="))
    ?.split("=")[1]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];

async function prompt(q: string): Promise<string> {
  if (autoYes) return "yes";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
}

// ── Audit a VM post-reconcile: gateway active + /health=200 ──
//
// Retry loop up to 120s (12 × 10s) for both conditions to land in the
// SAME iteration. Same pattern as stepGatewayRestart's existing 24×5s loop
// in vm-reconcile.ts.
//
// Why: edge_city VMs load 8 plugins (acpx, bonjour, browser, device-pair,
// memory-core, phone-control, talk-voice, telegram) and take ~90s to cold-
// boot. The old single-shot audit checked immediately after reconcileVM's
// own restart loop finished and saw the gateway in a transient state.
// 2026-05-12 vm-923 (paying customer cwt45@cornell.edu) audit-failed via
// this exact race — caught-up clean per reconcileVM, then audit saw
// inactive 1s later because the new gateway was mid-cold-boot.
// The wave-halt threshold (default 30%) then aborted the entire run on a
// single false-positive.
//
// Pairing is load-bearing: a healthy gateway has BOTH is-active=active AND
// /health=200. During cold boot, systemd transitions: inactive → activating →
// active, while the HTTP server may not yet be bound. A "active + 000"
// reading means systemd thinks the unit is running but the gateway hasn't
// finished initializing. Both must match in the SAME iteration to confirm
// the gateway is genuinely serving.
async function auditVm(
  host: string,
): Promise<{ ok: boolean; reason?: string }> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host, username: "openclaw", privateKey: sshKey, readyTimeout: 8_000 });
  } catch (e) {
    return { ok: false, reason: `ssh-connect: ${(e as Error).message.slice(0, 80)}` };
  }
  const MAX_ATTEMPTS = 12;
  const INTERVAL_MS = 10_000;
  let lastGw = "(none)";
  let lastHealth = "(none)";
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Combined check in ONE SSH round-trip to avoid sequential drift
      // between gateway-state and health-port readings.
      const combined = await ssh.execCommand(
        `gw=$(systemctl --user is-active openclaw-gateway 2>/dev/null || echo inactive); ` +
        `h=$(curl -sf -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000); ` +
        `echo "GW=$gw HEALTH=$h"`,
      );
      const out = (combined.stdout || "").trim();
      const m = out.match(/GW=(\S+) HEALTH=(\S+)/);
      if (!m) {
        // Malformed output — log + treat as miss this iteration, retry
        lastGw = "(parse-error)";
        lastHealth = out.slice(0, 50);
      } else {
        lastGw = m[1];
        lastHealth = m[2];
        if (lastGw === "active" && lastHealth === "200") {
          return { ok: true };
        }
      }
      // Not healthy this iteration — wait + retry (unless this was the last attempt)
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, INTERVAL_MS));
      }
    }
    // All attempts exhausted
    return {
      ok: false,
      reason: `gateway-not-healthy-after-${(MAX_ATTEMPTS * INTERVAL_MS) / 1000}s: gw=${lastGw} /health=${lastHealth}`,
    };
  } finally {
    ssh.dispose();
  }
}

// ── Per-VM catch-up: reconcileVM(strict=false), update cv on clean result ──
type Outcome = "caught-up" | "already-current" | "push-error" | "audit-fail" | "exception";
interface VmResult {
  name: string;
  cv_before: number | null;
  cv_after: number | null;
  outcome: Outcome;
  elapsedMs: number;
  fixedCount: number;
  alreadyCorrectCount: number;
  errorCount: number;
  errorSummary: string;
  auditReason?: string;
}

// ── ExecStart pre-flight result type ──
type PreflightResult =
  | { ok: true; action: "aligned-already" | "rewrote"; details?: string }
  | { ok: false; action: "skipped"; reason: string }
  | { ok: false; action: "error"; reason: string };

// Canonical openclaw-gateway.service ExecStart pattern (configureOpenClaw output).
// If a VM's ExecStart deviates from this, we DON'T rewrite (would risk corrupting
// a manually-edited unit). Safety invariant: SKIP > break.
const CANONICAL_EXECSTART_RE =
  /^ExecStart=\/home\/openclaw\/\.nvm\/versions\/node\/v\d+\.\d+\.\d+\/bin\/node \/home\/openclaw\/\.nvm\/versions\/node\/v\d+\.\d+\.\d+\/lib\/node_modules\/openclaw\/dist\/index\.js gateway --port 18789$/;

const NVM_FOR_PREFLIGHT = 'source ~/.nvm/nvm.sh 2>/dev/null';
const DBUS_FOR_PREFLIGHT = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

/**
 * Pre-flight: rewrite the openclaw-gateway.service ExecStart line to point to
 * the current Node version, ONLY IF every safety check passes.
 *
 * Why: 2026-05-12 incident — stepNodeUpgrade upgrades Node from v22.22.0 →
 * v22.22.2 and installs openclaw at the new path, but the systemd unit's
 * ExecStart still points to the OLD Node path which has openclaw 2026.4.5
 * (without the new compaction-key schema). When stepGatewayRestart triggers,
 * systemd loads the OLD binary which rejects the new keys → crash-loop.
 * Affected 2 paying customers (coastalstu@gmail.com, agent@superpower.io).
 *
 * Safety invariant per Cooper: "fix only fires if (a) target Node path exists
 * with installed openclaw AND (b) ExecStart pattern is recognized. otherwise
 * SKIP. worst case = VM stays in current state."
 *
 * Does NOT restart the gateway — that's stepGatewayRestart's job. Only rewrites
 * the unit file + daemon-reload + verifies systemd's runtime view picked it up.
 *
 * Returns:
 *   { ok:true,  action:"aligned-already" } — no work needed, proceed
 *   { ok:true,  action:"rewrote" }         — fix applied, proceed
 *   { ok:false, action:"skipped" }         — safety guard, proceed without fix
 *                                            (worst case = old behavior, no worse)
 *   { ok:false, action:"error" }           — partial-state risk, DO NOT proceed
 *                                            with reconcileVM (treat as exception)
 */
async function preflightFixExecStart(ip: string): Promise<PreflightResult> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: ip, port: 22, username: "openclaw", privateKey: sshKey, readyTimeout: 12_000 });

    // ── 1. Current Node version on PATH ──
    const curNodeRes = await ssh.execCommand(`${NVM_FOR_PREFLIGHT} && node --version`);
    const curNode = (curNodeRes.stdout || "").trim();
    if (!/^v\d+\.\d+\.\d+$/.test(curNode)) {
      return { ok: false, action: "skipped", reason: `current node version not in expected format: '${curNode}'` };
    }

    // ── 2. Read current ExecStart line ──
    const unitPath = "$HOME/.config/systemd/user/openclaw-gateway.service";
    const esRes = await ssh.execCommand(`grep -E "^ExecStart=" ${unitPath} 2>/dev/null | head -1`);
    const currentExecStart = (esRes.stdout || "").split("\n")[0];
    if (!CANONICAL_EXECSTART_RE.test(currentExecStart)) {
      return { ok: false, action: "skipped", reason: `ExecStart pattern not recognized (manual edit?)` };
    }
    const oldNodeMatch = currentExecStart.match(/\/node\/(v\d+\.\d+\.\d+)\//);
    const oldNode = oldNodeMatch?.[1] ?? "?";

    // ── 3. Idempotency — already aligned ──
    if (oldNode === curNode) {
      return { ok: true, action: "aligned-already", details: `${oldNode}` };
    }

    // ── 4. Target Node path exists + openclaw installed ──
    const targetBin = `/home/openclaw/.nvm/versions/node/${curNode}/bin/node`;
    const targetDist = `/home/openclaw/.nvm/versions/node/${curNode}/lib/node_modules/openclaw/dist/index.js`;
    const checkRes = await ssh.execCommand(`test -x ${targetBin} && test -f ${targetDist} && echo OK || echo MISSING`);
    if (!(checkRes.stdout || "").trim().endsWith("OK")) {
      return { ok: false, action: "skipped", reason: `target ${curNode} bin or dist missing — npm install may not have completed` };
    }

    // ── 5. Target node binary returns clean version ──
    const tvRes = await ssh.execCommand(`${targetBin} --version`);
    const tv = (tvRes.stdout || "").trim();
    if (tvRes.code !== 0 || tv !== curNode) {
      return { ok: false, action: "skipped", reason: `target node binary reports '${tv}', expected '${curNode}'` };
    }

    // ── 6. No drop-in ExecStart override (would shadow our rewrite) ──
    const dropinRes = await ssh.execCommand(`grep -lE "^ExecStart=" ~/.config/systemd/user/openclaw-gateway.service.d/*.conf 2>/dev/null | head -3`);
    if ((dropinRes.stdout || "").trim()) {
      return { ok: false, action: "skipped", reason: `drop-in ExecStart override present — rewrite would be shadowed` };
    }

    // ── 7. Atomic in-place rewrite via sed with timestamped .bak ──
    const newExecStart = `ExecStart=/home/openclaw/.nvm/versions/node/${curNode}/bin/node /home/openclaw/.nvm/versions/node/${curNode}/lib/node_modules/openclaw/dist/index.js gateway --port 18789`;
    const sedReplacement = newExecStart.replace(/\//g, "\\/");
    const sedCmd = `sed -i.bak.execstart-fix-$(date -u +%Y%m%dT%H%M%SZ) -E 's|^ExecStart=/home/openclaw/\\.nvm/versions/node/v[0-9]+\\.[0-9]+\\.[0-9]+/bin/node /home/openclaw/\\.nvm/versions/node/v[0-9]+\\.[0-9]+\\.[0-9]+/lib/node_modules/openclaw/dist/index\\.js gateway --port 18789|${sedReplacement}|' ${unitPath}`;
    const sedRes = await ssh.execCommand(sedCmd);
    if (sedRes.code !== 0) {
      return { ok: false, action: "error", reason: `sed rewrite failed (exit ${sedRes.code}): ${(sedRes.stderr || "").slice(0, 200)}` };
    }

    // ── 8. Verify rewrite landed on disk ──
    const vRes = await ssh.execCommand(`grep -E "^ExecStart=" ${unitPath} | head -1`);
    if ((vRes.stdout || "").split("\n")[0] !== newExecStart) {
      return { ok: false, action: "error", reason: `post-sed verify mismatch — file may be partially written` };
    }

    // ── 9. daemon-reload (DBUS prefix required for SSH sessions) ──
    const reloadRes = await ssh.execCommand(`${DBUS_FOR_PREFLIGHT} && systemctl --user daemon-reload`);
    if (reloadRes.code !== 0) {
      return { ok: false, action: "error", reason: `daemon-reload failed (exit ${reloadRes.code}): ${(reloadRes.stderr || "").slice(0, 200)}` };
    }

    // ── 10. Verify systemd runtime view ──
    const showRes = await ssh.execCommand(`${DBUS_FOR_PREFLIGHT} && systemctl --user show openclaw-gateway -p ExecStart --value`);
    if (!(showRes.stdout || "").includes(`/node/${curNode}/bin/node`) || !(showRes.stdout || "").includes(`/node/${curNode}/lib/node_modules/openclaw`)) {
      return { ok: false, action: "error", reason: `systemd runtime ExecStart doesn't reflect rewrite` };
    }

    return { ok: true, action: "rewrote", details: `${oldNode} → ${curNode}` };
  } catch (e: any) {
    return { ok: false, action: "error", reason: `preflight threw: ${String(e?.message ?? e).slice(0, 200)}` };
  } finally {
    ssh.dispose();
  }
}

async function catchUpOne(
  vm: { id: string; name: string; config_version: number | null; ip_address: string },
): Promise<VmResult> {
  const start = Date.now();
  const cvBefore = vm.config_version ?? 0;

  // ── PRE-FLIGHT: rewrite stale ExecStart before any config changes ──
  // Must run BEFORE reconcileVM so stepConfigSettings + stepGatewayRestart
  // see a unit file pointing to the current Node binary.
  const pre = await preflightFixExecStart(vm.ip_address);
  if (pre.action === "rewrote") {
    console.log(`  ${vm.name}: ExecStart pre-flight: rewrote ${pre.details}`);
  } else if (pre.action === "skipped") {
    // Safety guard — proceed with reconcileVM as-is. Worst case = old
    // behavior (no worse than before this script existed). Logged.
    console.log(`  ${vm.name}: ExecStart pre-flight: SKIP (${pre.reason})`);
  } else if (pre.action === "error") {
    // Partial-state risk — DO NOT proceed with reconcileVM, the unit file
    // may be half-written or systemd runtime view is unknown.
    return {
      name: vm.name,
      cv_before: cvBefore,
      cv_after: null,
      outcome: "exception",
      elapsedMs: Date.now() - start,
      fixedCount: 0,
      alreadyCorrectCount: 0,
      errorCount: 0,
      errorSummary: `preflight ExecStart fix ERROR: ${pre.reason}`,
    };
  }
  // "aligned-already" is silent (no work needed) — proceed normally.

  let result;
  try {
    // strict=false drops the 180s deadline AND loosens per-key
    // configSettings verify-after-set. Vercel cron's next tick re-verifies
    // under strict mode (defense in depth). Migration env vars NOT set
    // (defended at script init).
    result = await reconcileVM(vm as never, VM_MANIFEST, {
      dryRun,
      strict: false,
      canary: false,
      skipGatewayRestart: false,
    });
  } catch (e) {
    return {
      name: vm.name,
      cv_before: cvBefore,
      cv_after: null,
      outcome: "exception",
      elapsedMs: Date.now() - start,
      fixedCount: 0,
      alreadyCorrectCount: 0,
      errorCount: 0,
      errorSummary: `reconcileVM threw: ${(e as Error).message.slice(0, 200)}`,
    };
  }

  const elapsedMs = Date.now() - start;
  const fixedCount = result.fixed.length;
  const alreadyCorrectCount = result.alreadyCorrect.length;
  const errorCount = result.errors.length;
  const errorSummary = result.errors.slice(0, 3).join("; ").slice(0, 300);

  // Detect already-current
  // (no fixed entries, no errors → VM was already correct)
  if (fixedCount === 0 && errorCount === 0) {
    return {
      name: vm.name, cv_before: cvBefore, cv_after: cvBefore,
      outcome: "already-current", elapsedMs,
      fixedCount, alreadyCorrectCount, errorCount, errorSummary,
    };
  }

  if (errorCount > 0) {
    return {
      name: vm.name, cv_before: cvBefore, cv_after: cvBefore,
      outcome: "push-error", elapsedMs,
      fixedCount, alreadyCorrectCount, errorCount, errorSummary,
    };
  }

  // Clean reconcile. Now bump cv in DB.
  // Mirrors cron route logic (route.ts:405-460) for the "no strictFailed,
  // no pushFailed" branch — we update config_version to MANIFEST.version.
  if (!dryRun) {
    const { error: updateErr } = await sb
      .from("instaclaw_vms")
      .update({
        config_version: VM_MANIFEST.version,
        // Reset failure tracking on success — mirrors route.ts:545
        reconcile_consecutive_failures: 0,
        reconcile_first_failure_at: null,
        reconcile_last_error: null,
        // Reset strict-hold streak too — these VMs may have accumulated
        // many strict-deadline holds while stuck.
        strict_hold_streak: 0,
      })
      .eq("id", vm.id);
    if (updateErr) {
      return {
        name: vm.name, cv_before: cvBefore, cv_after: cvBefore,
        outcome: "push-error", elapsedMs,
        fixedCount, alreadyCorrectCount, errorCount: 1,
        errorSummary: `db-update-failed: ${updateErr.message}`,
      };
    }
  }

  return {
    name: vm.name, cv_before: cvBefore, cv_after: VM_MANIFEST.version,
    outcome: "caught-up", elapsedMs,
    fixedCount, alreadyCorrectCount, errorCount, errorSummary,
  };
}

async function main(): Promise<number> {
  console.log("══ Catch-up stuck cohort ══");
  console.log(`  manifest:        v${VM_MANIFEST.version}`);
  console.log(`  dryRun:          ${dryRun}`);
  console.log(`  minGap:          ${minGap} (target cv ≤ v${VM_MANIFEST.version - minGap})`);
  console.log(`  maxVms:          ${maxVms || "unlimited"}`);
  console.log(`  concurrency:     ${concurrency}`);
  console.log(`  waveSize:        ${waveSize}`);
  console.log(`  lockTtlHours:    ${lockTtlHours}`);
  console.log(`  haltFailPct:     ${haltFailPct}%`);
  console.log(`  explicit cohort: ${explicitVms.length > 0 ? explicitVms.join(",") : "(auto)"}`);

  // ── 1. Acquire reconcile-fleet cron lock ──
  let lockAcquired = false;
  if (!dryRun) {
    console.log("\n── 1. Acquire reconcile-fleet cron lock ──");
    try {
      lockAcquired = await tryAcquireCronLock(
        "reconcile-fleet",
        lockTtlHours * 3600,
        "manual-catch-up-stuck-cohort",
      );
    } catch (e) {
      console.error(`FATAL: tryAcquireCronLock errored: ${(e as Error).message}`);
      return 2;
    }
    if (!lockAcquired) {
      console.error("FATAL: reconcile-fleet cron lock already held — aborting.");
      console.error("  Vercel cron may be mid-tick. Wait and retry.");
      return 2;
    }
    console.log(`  ✓ cron lock acquired (${lockTtlHours}h TTL)`);
  } else {
    console.log("\n── 1. (dry-run — skipping cron lock) ──");
  }

  try {
    // ── 2. Select cohort ──
    console.log("\n── 2. Select cohort ──");
    let vms: Array<{ id: string; name: string; config_version: number | null; ip_address: string; partner: string | null }>;
    if (explicitVms.length > 0) {
      const { data } = await sb
        .from("instaclaw_vms")
        .select("*")
        .in("name", explicitVms);
      vms = (data ?? []) as never;
      console.log(`  explicit list: ${vms.length}/${explicitVms.length} VMs resolved`);
    } else {
      const cutoff = VM_MANIFEST.version - minGap;
      const { data } = await sb
        .from("instaclaw_vms")
        .select("*")
        .eq("health_status", "healthy")
        .not("assigned_to", "is", null)
        .lte("config_version", cutoff)
        .order("config_version", { ascending: true });
      vms = (data ?? []) as never;
      console.log(`  candidate (healthy + assigned + cv ≤ v${cutoff}): ${vms.length}`);
    }

    vms = vms.filter((v) => !!v.ip_address);
    if (maxVms > 0) vms = vms.slice(0, maxVms);

    if (vms.length === 0) {
      console.log("  Nothing to do. Cohort is empty. Exiting.");
      return 0;
    }

    // Distribution preview
    const dist = new Map<number, number>();
    for (const v of vms) dist.set(v.config_version ?? 0, (dist.get(v.config_version ?? 0) ?? 0) + 1);
    console.log(`  cohort cv distribution:`);
    for (const [cv, n] of Array.from(dist.entries()).sort((a, b) => a[0] - b[0])) {
      console.log(`    cv=${String(cv).padStart(3)}: ${n} VM${n === 1 ? "" : "s"}`);
    }
    console.log(`  final cohort: ${vms.length} VMs`);

    // Confirm before live run
    if (!dryRun) {
      const ans = await prompt(
        `\nProceed with LIVE catch-up on ${vms.length} VMs? Each VM may take 3-10 min. [yes/no] `,
      );
      if (ans !== "yes" && ans !== "y") {
        console.log("Aborted.");
        return 1;
      }
    }

    // ── 3. Per-wave catch-up with audit gate ──
    const results: VmResult[] = [];
    const tally: Record<Outcome, number> = {
      "caught-up": 0,
      "already-current": 0,
      "push-error": 0,
      "audit-fail": 0,
      "exception": 0,
    };

    for (let w = 0; w < vms.length; w += waveSize) {
      const wave = vms.slice(w, w + waveSize);
      console.log(
        `\n══ Wave ${Math.floor(w / waveSize) + 1}/${Math.ceil(vms.length / waveSize)}: ${wave.length} VMs (cv range: ${wave[0].config_version}-${wave[wave.length - 1].config_version}) ══`,
      );
      const waveStart = Date.now();

      // Process at concurrency=N per batch
      const waveResults = new Map<string, VmResult>();
      for (let i = 0; i < wave.length; i += concurrency) {
        const batch = wave.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map((v) => catchUpOne(v)));
        batch.forEach((v, idx) => waveResults.set(v.id, batchResults[idx]));
      }

      // Print per-VM results in this wave
      for (const vm of wave) {
        const r = waveResults.get(vm.id)!;
        const tag = r.outcome.padEnd(15);
        const cv =
          r.cv_after !== null && r.cv_after !== r.cv_before
            ? `cv ${r.cv_before}→${r.cv_after}`
            : `cv ${r.cv_before}`;
        console.log(
          `  [${tag}] ${vm.name.padEnd(20)} ${cv.padEnd(14)} ${(r.elapsedMs / 1000).toFixed(1).padStart(5)}s  fixed=${r.fixedCount} alreadyCorrect=${r.alreadyCorrectCount} errors=${r.errorCount}${r.errorSummary ? " err=" + r.errorSummary.slice(0, 80) : ""}`,
        );
        results.push(r);
        tally[r.outcome]++;
      }

      // ── Per-wave audit on freshly caught-up VMs ──
      const caughtUpInWave = wave.filter((v) => waveResults.get(v.id)!.outcome === "caught-up");
      if (!dryRun && caughtUpInWave.length > 0) {
        console.log(`\n  ── Audit: ${caughtUpInWave.length} caught-up VMs ──`);
        const auditResults = await Promise.all(
          caughtUpInWave.map((v) =>
            auditVm(v.ip_address).then((r) => ({ vm: v, r })),
          ),
        );
        let waveAuditFails = 0;
        for (const { vm, r } of auditResults) {
          if (r.ok) {
            console.log(`    ✓ ${vm.name}: gateway healthy`);
          } else {
            waveAuditFails++;
            // Demote outcome to audit-fail
            const idx = results.findIndex((x) => x.name === vm.name);
            if (idx >= 0) {
              tally["caught-up"]--;
              tally["audit-fail"]++;
              results[idx].outcome = "audit-fail";
              results[idx].auditReason = r.reason;
            }
            console.log(`    ✗ ${vm.name}: ${r.reason}`);
          }
        }
        const failPct = (waveAuditFails / caughtUpInWave.length) * 100;
        if (failPct > haltFailPct) {
          console.log(
            `\n  ❌ Audit fail rate ${failPct.toFixed(0)}% > ${haltFailPct}% threshold. HALTING.`,
          );
          console.log(`  Operator should investigate before resuming.`);
          break;
        }
      }

      const waveElapsed = ((Date.now() - waveStart) / 1000).toFixed(1);
      console.log(`  wave done in ${waveElapsed}s`);
    }

    // ── 4. Final summary ──
    console.log("\n══ Catch-up summary ══");
    console.log(`  caught-up:        ${tally["caught-up"]}`);
    console.log(`  already-current:  ${tally["already-current"]}`);
    console.log(`  push-error:       ${tally["push-error"]}`);
    console.log(`  audit-fail:       ${tally["audit-fail"]}`);
    console.log(`  exception:        ${tally["exception"]}`);
    console.log(`  total processed:  ${results.length}`);

    const allClean = tally["push-error"] + tally["audit-fail"] + tally["exception"] === 0;
    if (!allClean) {
      console.log("\n  Failures:");
      for (const r of results.filter((x) =>
        ["push-error", "audit-fail", "exception"].includes(x.outcome),
      )) {
        console.log(
          `    ${r.name.padEnd(20)} [${r.outcome.padEnd(11)}] ${r.errorSummary || r.auditReason || "(no detail)"}`,
        );
      }
    }

    return allClean ? 0 : 2;
  } finally {
    if (lockAcquired) {
      await releaseCronLock("reconcile-fleet").catch(() => {});
      console.log("  ✓ cron lock released");
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FATAL:", e);
    releaseCronLock("reconcile-fleet").catch(() => {});
    process.exit(1);
  });
