/**
 * Fleet V2 SOUL.md migration rollout.
 *
 * Per CLAUDE.md OpenClaw Playbook + Rule 8 (cron lock) + Rule 3 (--test-first)
 * + Rule 4 (--dry-run first). Per PRD soul-md-trim-2026-05-11.md §5.
 *
 * Usage:
 *   npx tsx scripts/_fleet-v2-rollout.ts [options]
 *
 * Options:
 *   --dry-run            run reconcileVM with dryRun=true; no writes
 *   --priority-first     migrate over-budget VMs (SOUL.md > 35K) first
 *   --concurrency=N      worker concurrency, default 3, MAX 3 (Playbook)
 *   --wave=N             VMs per audit-gated wave, default 10
 *   --vms=name1,name2    explicit comma-separated VM names (overrides selection)
 *   --skip-probe         skip the post-wave SSH audit (faster, less safe)
 *   --max-vms=N          stop after migrating N VMs (default: no limit)
 *   --yes                skip interactive confirmation between waves
 *
 * Safety:
 *   1. Acquires `reconcile-fleet` cron lock for the full duration (Rule 8).
 *      Bails immediately if the Vercel cron is mid-tick or another manual
 *      rollout is running.
 *   2. Sets RECONCILE_SOUL_MIGRATION_ENABLED=true ONLY in this process's env
 *      (no Vercel env mutation — pure local). Migration is whitelist-scoped
 *      to the VMs this wave is processing.
 *   3. Concurrency hard-capped at 3 (Playbook).
 *   4. Per-wave audit gate: after each wave, SSH-probes every migrated VM for
 *      all 4 V2 markers + sizes + gateway active + /health=200. ANY failure
 *      HALTS the rollout — operator must intervene.
 *   5. Idempotent: a VM that's already V2 is detected by the migration step
 *      and reported as alreadyCorrect. Re-running the script is safe.
 *   6. Per-VM tar backup created automatically by the migration step. Rollback
 *      via _rollback-v2-from-tar.ts.
 *
 * Selection logic (when --vms is not specified):
 *   - WHERE assigned_to IS NOT NULL
 *   - AND health_status = 'healthy'
 *   - AND telegram_bot_username IS NOT NULL  (skip the Telegram-401 cluster
 *     unless explicitly listed via --vms; they're migration-safe but probe-
 *     deferred per PRD §5.2)
 *   - Ordered by: --priority-first → SOUL.md size DESC (probe each VM, sort
 *     by current size, biggest first). Default → name ASC (deterministic).
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
import {
  SOUL_V2_MARKER,
  AGENTS_V2_MARKER,
  TOOLS_V2_MARKER,
  IDENTITY_V2_MARKER,
} from "../lib/workspace-templates-v2";
import { tryAcquireCronLock, releaseCronLock } from "../lib/cron-lock";

const sshKey = Buffer.from(
  process.env.SSH_PRIVATE_KEY_B64!,
  "base64",
).toString("utf-8");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── args ──
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const priorityFirst = args.includes("--priority-first");
const skipProbe = args.includes("--skip-probe");
const autoYes = args.includes("--yes");
const concurrency = Math.min(
  3,
  parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "3", 10),
);
const waveSize = parseInt(
  args.find((a) => a.startsWith("--wave="))?.split("=")[1] ?? "10",
  10,
);
const maxVms = parseInt(
  args.find((a) => a.startsWith("--max-vms="))?.split("=")[1] ?? "0",
  10,
);
const explicitVms = args
  .find((a) => a.startsWith("--vms="))
  ?.split("=")[1]
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (concurrency > 3) {
  console.error("FATAL: concurrency capped at 3 per CLAUDE.md OpenClaw Playbook");
  process.exit(64);
}

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

// ── Probe SOUL.md size for priority ordering ──
async function probeSoulSize(host: string, name: string): Promise<number> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host, username: "openclaw", privateKey: sshKey, readyTimeout: 8_000 });
    const r = await ssh.execCommand(
      `wc -c < ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo 0`,
    );
    return parseInt((r.stdout || "0").trim(), 10) || 0;
  } catch (e) {
    console.warn(`  probeSoulSize ${name}: ${(e as Error).message}`);
    return -1; // mark as unreachable — sort to the back
  } finally {
    ssh.dispose();
  }
}

// ── Post-migration audit on one VM ──
async function auditVm(
  host: string,
  name: string,
): Promise<{ ok: boolean; details: string[] }> {
  const details: string[] = [];
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host, username: "openclaw", privateKey: sshKey, readyTimeout: 8_000 });
  } catch (e) {
    return { ok: false, details: [`SSH connect failed: ${(e as Error).message}`] };
  }
  try {
    // V2 markers + sizes
    const fileChecks: Array<{ file: string; marker: string; maxBytes: number }> = [
      { file: "SOUL.md", marker: SOUL_V2_MARKER, maxBytes: 6000 },
      { file: "AGENTS.md", marker: AGENTS_V2_MARKER, maxBytes: 20000 }, // V2 template = 18,933 bytes; +1067 buffer
      { file: "TOOLS.md", marker: TOOLS_V2_MARKER, maxBytes: 7000 },
      { file: "IDENTITY.md", marker: IDENTITY_V2_MARKER, maxBytes: 4000 },
    ];
    let allGood = true;
    for (const c of fileChecks) {
      const path = `~/.openclaw/workspace/${c.file}`;
      const r = await ssh.execCommand(
        `if [ -f ${path} ]; then ` +
          `printf '%s %s ' EXISTS $(wc -c < ${path}); ` +
          `grep -qF "${c.marker}" ${path} && echo MARKER_OK || echo MARKER_MISSING; ` +
          `else echo MISSING; fi`,
      );
      const out = (r.stdout || "").trim();
      if (out.startsWith("MISSING")) {
        details.push(`${c.file}: MISSING`);
        allGood = false;
        continue;
      }
      const m = out.match(/^EXISTS (\d+) (\S+)/);
      if (!m) {
        details.push(`${c.file}: unparseable: ${out.slice(0, 80)}`);
        allGood = false;
        continue;
      }
      const size = parseInt(m[1], 10);
      const markerState = m[2];
      if (markerState !== "MARKER_OK") {
        details.push(`${c.file}: NO_V2_MARKER (size=${size})`);
        allGood = false;
        continue;
      }
      if (size > c.maxBytes) {
        details.push(`${c.file}: oversize ${size} > ${c.maxBytes}`);
        allGood = false;
        continue;
      }
    }

    // Gateway active + /health
    const gw = await ssh.execCommand(
      `systemctl --user is-active openclaw-gateway 2>/dev/null || echo inactive`,
    );
    const gwActive = (gw.stdout || "").trim() === "active";
    if (!gwActive) {
      details.push(`gateway not active: ${(gw.stdout || "").trim()}`);
      allGood = false;
    }
    const health = await ssh.execCommand(
      `curl -sf -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000`,
    );
    if ((health.stdout || "").trim() !== "200") {
      details.push(`gateway /health = ${health.stdout?.trim()}`);
      allGood = false;
    }
    return { ok: allGood, details };
  } finally {
    ssh.dispose();
  }
}

// ── Migrate one VM ──
type Outcome = "migrated" | "already-v2" | "error" | "skip-disk" | "skip-other";

async function migrateOne(
  vm: { id: string; name: string; ip_address: string; partner: string | null; assigned_to: string | null; health_status: string },
): Promise<{ outcome: Outcome; messages: string[]; elapsedMs: number }> {
  const start = Date.now();
  // NOTE: RECONCILE_SOUL_MIGRATION_VM_IDS is set ONCE in main() with all VM
  // IDs joined by comma — must NOT be set per-VM here. With concurrency>1,
  // per-VM env-var writes race; the last write wins for all in-flight
  // reconciles, causing siblings whose ID isn't the "winner" to be silently
  // skipped by stepMigrateSoulV2's whitelist check. Fixed by setting once
  // upfront in main(); see comment near process.env in §3.

  let result;
  try {
    result = await reconcileVM(vm as never, VM_MANIFEST, {
      dryRun,
      strict: true,
      canary: false,
      skipGatewayRestart: false,
    });
  } catch (e) {
    return {
      outcome: "error",
      messages: [`reconcileVM threw: ${(e as Error).message}`],
      elapsedMs: Date.now() - start,
    };
  }

  const elapsedMs = Date.now() - start;
  const messages: string[] = [];

  // Distill migration-relevant entries
  const migErrors = result.errors.filter((s) => s.includes("soul-v2-migration"));
  const migFixed = result.fixed.filter((s) => s.includes("soul-v2-migration"));
  const migCorrect = result.alreadyCorrect.filter((s) => s.includes("soul-v2-migration"));

  for (const e of migErrors) messages.push(`✗ ${e}`);
  for (const e of migFixed) messages.push(`+ ${e}`);
  for (const e of migCorrect) messages.push(`~ ${e}`);

  if (migErrors.length > 0) {
    const diskErr = migErrors.find((e) => e.includes("insufficient disk"));
    if (diskErr) return { outcome: "skip-disk", messages, elapsedMs };
    return { outcome: "error", messages, elapsedMs };
  }
  if (migFixed.some((s) => s.includes("[dry-run]") || s.includes("wrote"))) {
    return { outcome: "migrated", messages, elapsedMs };
  }
  if (migCorrect.some((s) => s.includes("all 4 files at V2"))) {
    return { outcome: "already-v2", messages, elapsedMs };
  }
  return { outcome: "skip-other", messages, elapsedMs };
}

async function main(): Promise<number> {
  console.log("══ Fleet V2 SOUL.md migration rollout ══");
  console.log(`  dryRun:        ${dryRun}`);
  console.log(`  priorityFirst: ${priorityFirst}`);
  console.log(`  concurrency:   ${concurrency}`);
  console.log(`  waveSize:      ${waveSize}`);
  console.log(`  skipProbe:     ${skipProbe}`);
  console.log(`  maxVms:        ${maxVms || "unlimited"}`);
  console.log(`  manifest:      v${VM_MANIFEST.version}`);

  // ── 1. Acquire cron lock (Rule 8) ──
  if (!dryRun) {
    console.log("\n── 1. Acquire reconcile-fleet cron lock ──");
    const acquired = await tryAcquireCronLock(
      "reconcile-fleet",
      8 * 3600, // 8h ceiling
      "manual-fleet-v2-rollout",
    );
    if (!acquired) {
      console.error("FATAL: reconcile-fleet cron lock already held — aborting.");
      console.error("  Wait for the cron to finish or kill the lock manually if stale.");
      return 2;
    }
    console.log("  ✓ cron lock acquired");
  } else {
    console.log("\n── 1. (dry-run — skipping cron lock) ──");
  }

  process.env.RECONCILE_SOUL_MIGRATION_ENABLED = "true";

  try {
    // ── 2. Select VMs ──
    console.log("\n── 2. Select VMs ──");
    let vms: Array<{
      id: string;
      name: string;
      ip_address: string;
      partner: string | null;
      assigned_to: string | null;
      health_status: string;
      telegram_bot_username: string | null;
      config_version: number | null;
    }>;
    if (explicitVms && explicitVms.length > 0) {
      const { data } = await sb
        .from("instaclaw_vms")
        .select("*")
        .in("name", explicitVms);
      vms = (data ?? []) as never;
      console.log(`  explicit list: ${vms.length}/${explicitVms.length} VMs resolved`);
    } else {
      const { data } = await sb
        .from("instaclaw_vms")
        .select("*")
        .eq("health_status", "healthy")
        .not("assigned_to", "is", null)
        .not("telegram_bot_username", "is", null)
        .order("name");
      vms = (data ?? []) as never;
      console.log(`  candidate (healthy + assigned + bot): ${vms.length}`);
    }

    // Filter out unreachable IPs
    vms = vms.filter((v) => !!v.ip_address);

    if (priorityFirst) {
      console.log("  --priority-first: probing SOUL.md size on each VM (concurrency=3) …");
      const sizes = new Map<string, number>();
      const batchSize = 3;
      for (let i = 0; i < vms.length; i += batchSize) {
        const batch = vms.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map((v) => probeSoulSize(v.ip_address, v.name)),
        );
        batch.forEach((v, idx) => sizes.set(v.id, results[idx]));
      }
      vms.sort((a, b) => (sizes.get(b.id) ?? -1) - (sizes.get(a.id) ?? -1));
      const overBudget = vms.filter((v) => (sizes.get(v.id) ?? 0) > 35000);
      console.log(`  over-budget VMs (SOUL > 35K): ${overBudget.length}`);
      if (overBudget.length > 0) {
        console.log(`  worst offender: ${overBudget[0].name} = ${sizes.get(overBudget[0].id)} bytes`);
      }
    }

    if (maxVms > 0) vms = vms.slice(0, maxVms);
    console.log(`  final cohort: ${vms.length} VMs`);

    if (vms.length === 0) {
      console.log("  Nothing to do. Exiting.");
      return 0;
    }

    // §3 — Set RECONCILE_SOUL_MIGRATION_VM_IDS once with ALL VM IDs joined by
    // comma. stepMigrateSoulV2's whitelist check uses `.includes(vm.id)` on
    // the parsed list, so listing all of them allows each VM's reconcile to
    // pass. Setting per-VM in migrateOne races with concurrency>1; setting
    // once upfront eliminates the race.
    process.env.RECONCILE_SOUL_MIGRATION_VM_IDS = vms.map((v) => v.id).join(",");
    console.log(`  RECONCILE_SOUL_MIGRATION_VM_IDS=${vms.length} ids (whitelist-scoped to this cohort)`);

    // Confirm before live run
    if (!dryRun) {
      const ans = await prompt(`\nProceed with LIVE V2 migration on ${vms.length} VMs? [yes/no] `);
      if (ans !== "yes" && ans !== "y") {
        console.log("Aborted.");
        return 1;
      }
    }

    // ── 3. Rollout in waves ──
    const tally = {
      migrated: 0,
      alreadyV2: 0,
      skipDisk: 0,
      skipOther: 0,
      error: 0,
      auditFail: 0,
    };
    const failures: string[] = [];

    for (let w = 0; w < vms.length; w += waveSize) {
      const wave = vms.slice(w, w + waveSize);
      console.log(
        `\n══ Wave ${Math.floor(w / waveSize) + 1}/${Math.ceil(vms.length / waveSize)}: ${wave.length} VMs ══`,
      );
      const waveStart = Date.now();

      // Migrate at concurrency=N
      const waveResults = new Map<
        string,
        { outcome: Outcome; messages: string[]; elapsedMs: number }
      >();
      for (let i = 0; i < wave.length; i += concurrency) {
        const batch = wave.slice(i, i + concurrency);
        const results = await Promise.all(batch.map((v) => migrateOne(v)));
        batch.forEach((v, idx) => waveResults.set(v.id, results[idx]));
      }

      // Per-VM results
      for (const v of wave) {
        const r = waveResults.get(v.id)!;
        const tag = r.outcome.padEnd(11);
        console.log(`  [${tag}] ${v.name.padEnd(20)} (${(r.elapsedMs / 1000).toFixed(1)}s) ${v.partner ?? ""}`);
        for (const m of r.messages) console.log(`              ${m}`);
        switch (r.outcome) {
          case "migrated":
            tally.migrated++;
            break;
          case "already-v2":
            tally.alreadyV2++;
            break;
          case "skip-disk":
            tally.skipDisk++;
            failures.push(`${v.name}: skip-disk`);
            break;
          case "skip-other":
            tally.skipOther++;
            break;
          case "error":
            tally.error++;
            failures.push(`${v.name}: ${r.messages.join("; ").slice(0, 200)}`);
            break;
        }
      }

      // Post-wave audit gate
      const migratedInWave = wave.filter(
        (v) => waveResults.get(v.id)!.outcome === "migrated",
      );
      if (!dryRun && !skipProbe && migratedInWave.length > 0) {
        console.log(`\n  ── Audit gate: ${migratedInWave.length} migrated VMs ──`);
        const auditResults = await Promise.all(
          migratedInWave.map((v) => auditVm(v.ip_address, v.name)),
        );
        let waveAuditFails = 0;
        migratedInWave.forEach((v, idx) => {
          const a = auditResults[idx];
          if (a.ok) {
            console.log(`    ✓ ${v.name}: V2 + healthy`);
          } else {
            waveAuditFails++;
            tally.auditFail++;
            failures.push(`${v.name}: audit FAIL — ${a.details.join("; ")}`);
            console.log(`    ✗ ${v.name}: ${a.details.join("; ")}`);
          }
        });
        if (waveAuditFails > 0) {
          console.log(
            `\n  ❌ Audit fail ${waveAuditFails}/${migratedInWave.length} in wave. HALTING.`,
          );
          console.log(
            `  Investigate failures and consider _rollback-v2-from-tar.ts on the failed VMs.`,
          );
          break;
        }
      }

      const waveElapsed = ((Date.now() - waveStart) / 1000).toFixed(1);
      console.log(`  wave done in ${waveElapsed}s`);
    }

    // ── 4. Summary ──
    console.log("\n══ Rollout summary ══");
    console.log(`  migrated:    ${tally.migrated}`);
    console.log(`  alreadyV2:   ${tally.alreadyV2}`);
    console.log(`  skipDisk:    ${tally.skipDisk}`);
    console.log(`  skipOther:   ${tally.skipOther}`);
    console.log(`  errors:      ${tally.error}`);
    console.log(`  auditFail:   ${tally.auditFail}`);
    if (failures.length > 0) {
      console.log("\n  Failures:");
      for (const f of failures.slice(0, 50)) console.log(`    ${f}`);
      if (failures.length > 50) console.log(`    … (+${failures.length - 50} more)`);
    }

    const allClean = tally.error + tally.auditFail + tally.skipDisk === 0;
    return allClean ? 0 : 2;
  } finally {
    if (!dryRun) {
      await releaseCronLock("reconcile-fleet").catch(() => {});
      console.log("  ✓ cron lock released");
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FATAL:", e);
    // Try to release lock on crash
    releaseCronLock("reconcile-fleet").catch(() => {});
    process.exit(1);
  });
