/**
 * Canary V2 SOUL.md migration on a single VM.
 *
 * Per CLAUDE.md Rule 3 and PRD soul-md-trim-2026-05-11.md §5: ALWAYS migrate
 * one VM first, verify all the post-conditions, before any fleet rollout.
 *
 * Usage:
 *   npx tsx scripts/_canary-v2-migration.ts <vm-name> [--dry-run] [--no-probes]
 *
 * What this script does:
 *   1. Load env from .env.local AND .env.ssh-key (per CLAUDE.md Rule 18).
 *   2. Resolve VM by name from instaclaw_vms.
 *   3. Pre-check: SSH connectivity, gateway active, /home/openclaw disk free
 *      ≥ 2GB, on-disk SOUL.md size + partner tag.
 *   4. Run reconcileVM with --dry-run FIRST (per CLAUDE.md Rule 4) to surface
 *      what the migration WOULD do without writing.
 *   5. HALT for confirmation unless `--yes` flag (interactive prompt).
 *   6. Set RECONCILE_SOUL_MIGRATION_ENABLED=true AND
 *      RECONCILE_SOUL_MIGRATION_VM_IDS=<this-vm-id> so the migration is
 *      strictly scoped to this VM (no fleet drift).
 *   7. Run reconcileVM for real.
 *   8. Post-check all V2 invariants:
 *        - SOUL.md exists, ≤ 5K bytes, has SOUL_V2_MARKER, has any expected
 *          partner stub
 *        - AGENTS.md exists, has AGENTS_V2_MARKER
 *        - TOOLS.md exists, has TOOLS_V2_MARKER
 *        - IDENTITY.md exists, has IDENTITY_V2_MARKER
 *        - workspace-pre-soul-v2-migration.tar.gz exists, ≥ 1 KB
 *        - openclaw-gateway is active AND /health returns 200
 *   9. Print PASS/FAIL summary and exit non-zero on any fail.
 *
 * Safety:
 *   - Defaults to dry-run-then-prompt. No real write without explicit consent.
 *   - Whitelist-scoped so the global env flip doesn't migrate other VMs even
 *     if another reconciler tick runs concurrently.
 *   - On any post-condition failure, exits with code 2 — caller is expected
 *     to invoke _rollback-v2-from-tar.ts for that VM before retrying.
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
import {
  SOUL_STUB_EDGE_MARKER,
  SOUL_STUB_CONSENSUS_MARKER,
} from "../lib/partner-content";

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
const vmName = args.find((a) => !a.startsWith("--"));
const dryRunOnly = args.includes("--dry-run");
const skipProbes = args.includes("--no-probes");
const autoYes = args.includes("--yes");

if (!vmName) {
  console.error(
    "Usage: npx tsx scripts/_canary-v2-migration.ts <vm-name> [--dry-run] [--no-probes] [--yes]",
  );
  console.error("Example: npx tsx scripts/_canary-v2-migration.ts instaclaw-vm-733");
  process.exit(64);
}

let passCount = 0;
let failCount = 0;
const ok = (m: string) => {
  console.log(`  ✓ ${m}`);
  passCount++;
};
const bad = (m: string) => {
  console.log(`  ✗ ${m}`);
  failCount++;
};

async function prompt(question: string): Promise<string> {
  if (autoYes) return "yes";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
}

async function main(): Promise<number> {
  console.log(`══ Canary V2 SOUL.md migration: ${vmName} ══`);
  console.log(`   manifest v${VM_MANIFEST.version}, gating via RECONCILE_SOUL_MIGRATION_*\n`);

  // ── 0. Resolve VM from DB ──
  console.log("── 0. Resolve VM ──");
  const { data: vm, error: vmErr } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", vmName)
    .single();
  if (vmErr || !vm) {
    console.error(`FATAL: VM '${vmName}' not found in instaclaw_vms: ${vmErr?.message ?? "no row"}`);
    return 2;
  }
  console.log(`  id:              ${vm.id}`);
  console.log(`  ip:              ${vm.ip_address}`);
  console.log(`  config_version:  ${vm.config_version}`);
  console.log(`  health_status:   ${vm.health_status}`);
  console.log(`  partner:         ${vm.partner ?? "null"}`);
  console.log(`  assigned_to:     ${vm.assigned_to ?? "null"}`);
  console.log(`  telegram_bot:    ${vm.telegram_bot_username ?? "null"}`);

  if (vm.health_status !== "healthy") {
    console.log(`\n  ⚠ VM is not healthy (${vm.health_status}). Migration safe but probes may fail.`);
  }

  // ── 0.5. Acquire reconcile-fleet cron lock (CLAUDE.md Rule 8) ──
  // Prevents racing the Vercel cron, which is eligible to process this VM
  // (cv=${vm.config_version} < manifest v${VM_MANIFEST.version}). If the cron
  // picked this VM while the canary runs, both would mutate the same workspace
  // concurrently — SHA-verified atomic writes survive per-step, but inter-step
  // ordering between two reconciles is undefined.
  console.log("\n── 0.5. Acquire reconcile-fleet cron lock ──");
  let lockAcquired = false;
  try {
    lockAcquired = await tryAcquireCronLock(
      "reconcile-fleet",
      900, // 15 min TTL — canary should finish in ~3-5 min; safety net for stuck lock
      `manual-canary-${vmName}`,
    );
  } catch (e) {
    console.error(`FATAL: tryAcquireCronLock errored: ${(e as Error).message}`);
    return 2;
  }
  if (!lockAcquired) {
    console.error("FATAL: reconcile-fleet cron lock already held.");
    console.error("  Vercel cron may be mid-tick, or another manual canary/rollout is running.");
    console.error("  Wait for the lock to release and retry. Inspect instaclaw_cron_locks if persistent.");
    return 2;
  }
  console.log("  ✓ cron lock acquired (15 min TTL)");

  try {
    // ── 1. Pre-check: SSH + disk + on-disk state ──
    console.log("\n── 1. Pre-check: SSH connectivity + disk + on-disk state ──");
    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: vm.ip_address,
        username: "openclaw",
        privateKey: sshKey,
        readyTimeout: 12_000,
      });
      ok("SSH connected");
    } catch (e) {
      bad(`SSH connect failed: ${(e as Error).message}`);
      console.error("FATAL: cannot proceed without SSH");
      return 2;
    }

  // Gateway active?
  const gwActive = await ssh.execCommand(
    `systemctl --user is-active openclaw-gateway 2>/dev/null || echo inactive`,
  );
  if ((gwActive.stdout || "").trim() === "active") {
    ok("openclaw-gateway active");
  } else {
    bad(`openclaw-gateway not active: ${(gwActive.stdout || "").trim()}`);
  }

  // Disk space — same check the migration step does. Surface early.
  const df = await ssh.execCommand(`df -k /home/openclaw 2>/dev/null | tail -1 | awk '{print $4}'`);
  const availKb = parseInt((df.stdout || "0").trim(), 10) || 0;
  const availGb = (availKb / (1024 * 1024)).toFixed(2);
  if (availKb >= 2 * 1024 * 1024) {
    ok(`disk free: ${availGb} GB (≥ 2 GB threshold)`);
  } else {
    bad(`disk free: ${availGb} GB — BELOW 2 GB threshold; migration will skip-with-error`);
  }

  // On-disk file sizes BEFORE
  const beforeSizes = await ssh.execCommand(
    `for f in SOUL.md AGENTS.md TOOLS.md IDENTITY.md; do ` +
      `if [ -f ~/.openclaw/workspace/$f ]; then ` +
      `echo "$f $(wc -c < ~/.openclaw/workspace/$f)"; ` +
      `else echo "$f MISSING"; fi; done`,
  );
  console.log("  ── on-disk sizes (BEFORE) ──");
  for (const line of (beforeSizes.stdout || "").trim().split("\n")) {
    console.log(`    ${line}`);
  }

  // Partner tag → expect which stubs?
  let expectedEdgeStub = false;
  let expectedConsensusStub = false;
  if (vm.partner === "edge_city") {
    expectedEdgeStub = true;
    expectedConsensusStub = true; // edge_city VMs get BOTH stubs
  } else if (vm.partner === "consensus_2026") {
    expectedConsensusStub = true;
  }
  console.log(`  expected partner stubs: edge=${expectedEdgeStub} consensus=${expectedConsensusStub}`);

  ssh.dispose();

  // ── 2. DRY RUN first (CLAUDE.md Rule 4) ──
  console.log("\n── 2. Dry-run migration via reconcileVM ──");
  process.env.RECONCILE_SOUL_MIGRATION_ENABLED = "true";
  process.env.RECONCILE_SOUL_MIGRATION_VM_IDS = vm.id;
  console.log(`  RECONCILE_SOUL_MIGRATION_ENABLED=true`);
  console.log(`  RECONCILE_SOUL_MIGRATION_VM_IDS=${vm.id} (whitelist-scoped)`);

  const dryStart = Date.now();
  const dryResult = await reconcileVM(vm as never, VM_MANIFEST, {
    dryRun: true,
    strict: true,
    canary: true,
    skipGatewayRestart: true, // dry-run shouldn't restart gateway
  });
  const dryElapsed = ((Date.now() - dryStart) / 1000).toFixed(1);
  console.log(`  dry-run took ${dryElapsed}s`);

  // Surface only the soul-v2-migration related entries
  const dryMigrationFixed = dryResult.fixed.filter((s) => s.includes("soul-v2-migration"));
  const dryMigrationErrors = dryResult.errors.filter((s) => s.includes("soul-v2-migration"));
  const dryMigrationCorrect = dryResult.alreadyCorrect.filter((s) => s.includes("soul-v2-migration"));
  console.log(`  soul-v2-migration dry-run:`);
  for (const s of dryMigrationFixed) console.log(`    + ${s}`);
  for (const s of dryMigrationErrors) console.log(`    ✗ ${s}`);
  for (const s of dryMigrationCorrect) console.log(`    ~ ${s}`);

  if (dryMigrationErrors.length > 0) {
    bad("dry-run surfaced errors — STOP, investigate before live run");
    return 2;
  }

  if (dryRunOnly) {
    console.log("\n── dry-run only requested. Exiting. ──");
    console.log(`\n══ Summary: ${passCount} pass / ${failCount} fail ══`);
    return failCount > 0 ? 2 : 0;
  }

  // ── 3. Confirm before live run ──
  const wouldMigrate = dryMigrationFixed.some(
    (s) => s.includes("would write") || s.includes("partial-recovery") || s.includes("fresh-migration"),
  );
  if (!wouldMigrate && dryMigrationCorrect.some((s) => s.includes("all 4 files at V2"))) {
    console.log("\n  ~ VM is already at V2. Nothing to migrate. Exiting clean.");
    return 0;
  }
  if (!wouldMigrate) {
    bad("dry-run reported neither errors nor migration intent — unexpected state");
    return 2;
  }

  const ans = await prompt(`\nProceed with LIVE V2 migration on ${vmName}? [yes/no] `);
  if (ans !== "yes" && ans !== "y") {
    console.log("Aborted by user.");
    return 1;
  }

  // ── 4. LIVE RUN ──
  console.log(`\n── 4. LIVE migration via reconcileVM ──`);
  const liveStart = Date.now();
  const liveResult = await reconcileVM(vm as never, VM_MANIFEST, {
    dryRun: false,
    strict: true,
    canary: true,
    skipGatewayRestart: false,
  });
  const liveElapsed = ((Date.now() - liveStart) / 1000).toFixed(1);
  console.log(`  reconcile took ${liveElapsed}s`);
  console.log(`  fixed:           ${liveResult.fixed.length}`);
  for (const item of liveResult.fixed.slice(0, 40)) console.log(`    + ${item}`);
  if (liveResult.fixed.length > 40) console.log(`    … (+${liveResult.fixed.length - 40} more)`);
  console.log(`  alreadyCorrect:  ${liveResult.alreadyCorrect.length}`);
  console.log(`  errors:          ${liveResult.errors.length}`);
  for (const e of liveResult.errors) console.log(`    ✗ ${e}`);

  if (liveResult.errors.length > 0) {
    bad("reconcileVM returned errors — DO NOT proceed to fleet rollout");
  } else {
    ok("reconcileVM reported zero errors");
  }
  if (liveResult.gatewayHealthy) ok("gateway healthy after reconcile");
  else bad("gateway NOT healthy after reconcile");

  // ── 5. Post-conditions: all 4 V2 markers, file sizes, partner stubs ──
  console.log("\n── 5. Post-conditions: V2 markers + sizes + partner stubs ──");
  const ssh2 = new NodeSSH();
  await ssh2.connect({
    host: vm.ip_address,
    username: "openclaw",
    privateKey: sshKey,
    readyTimeout: 12_000,
  });

  const postChecks: Array<{ file: string; marker: string; maxBytes: number }> = [
    { file: "SOUL.md", marker: SOUL_V2_MARKER, maxBytes: 6000 }, // 2.4K + partner stubs ~3K headroom
    { file: "AGENTS.md", marker: AGENTS_V2_MARKER, maxBytes: 20000 }, // V2 template = 18,933 bytes; +1067 buffer
    { file: "TOOLS.md", marker: TOOLS_V2_MARKER, maxBytes: 7000 },
    { file: "IDENTITY.md", marker: IDENTITY_V2_MARKER, maxBytes: 4000 }, // 500c base + optional preserved identity append
  ];

  for (const chk of postChecks) {
    const path = `~/.openclaw/workspace/${chk.file}`;
    const r = await ssh2.execCommand(
      `if [ -f ${path} ]; then ` +
        `echo "EXISTS $(wc -c < ${path})"; ` +
        `grep -qF "${chk.marker}" ${path} && echo "HAS_MARKER" || echo "NO_MARKER"; ` +
        `else echo "MISSING"; fi`,
    );
    const out = (r.stdout || "").trim();
    if (out.startsWith("MISSING")) {
      bad(`${chk.file} missing`);
      continue;
    }
    const sizeMatch = out.match(/EXISTS (\d+)/);
    const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
    if (size <= chk.maxBytes) {
      ok(`${chk.file} size=${size} ≤ ${chk.maxBytes}`);
    } else {
      bad(`${chk.file} size=${size} > ${chk.maxBytes} (V2 grew unexpectedly?)`);
    }
    if (out.includes("HAS_MARKER")) {
      ok(`${chk.file} has V2 marker`);
    } else {
      bad(`${chk.file} missing V2 marker — migration did NOT land`);
    }
  }

  // Partner stub checks
  if (expectedEdgeStub || expectedConsensusStub) {
    const soulCat = await ssh2.execCommand(`cat ~/.openclaw/workspace/SOUL.md`);
    const soul = soulCat.stdout || "";
    if (expectedEdgeStub) {
      if (soul.includes(SOUL_STUB_EDGE_MARKER)) {
        ok(`SOUL.md contains Edge Esmeralda partner stub`);
      } else {
        bad(`SOUL.md MISSING Edge Esmeralda partner stub (Bug #1 regression?)`);
      }
    }
    if (expectedConsensusStub) {
      if (soul.includes(SOUL_STUB_CONSENSUS_MARKER)) {
        ok(`SOUL.md contains Consensus 2026 partner stub`);
      } else {
        bad(`SOUL.md MISSING Consensus 2026 partner stub (Bug #1 regression?)`);
      }
    }
    // Cache-boundary marker still present (load-bearing for cache stability)
    if (soul.includes("<!-- OPENCLAW_CACHE_BOUNDARY -->")) {
      ok("SOUL.md still has OPENCLAW_CACHE_BOUNDARY marker");
    } else {
      bad("SOUL.md MISSING OPENCLAW_CACHE_BOUNDARY marker — cache stability broken");
    }
  }

  // Tar backup
  const tarChk = await ssh2.execCommand(
    `if [ -f ~/.openclaw/workspace-pre-soul-v2-migration.tar.gz ]; then ` +
      `echo "EXISTS $(wc -c < ~/.openclaw/workspace-pre-soul-v2-migration.tar.gz)"; ` +
      `else echo "MISSING"; fi`,
  );
  const tarOut = (tarChk.stdout || "").trim();
  if (tarOut.startsWith("EXISTS")) {
    const bytes = parseInt(tarOut.split(" ")[1] || "0", 10);
    if (bytes > 1024) {
      ok(`tar backup exists (${bytes} bytes, ≥ 1024)`);
    } else {
      bad(`tar backup too small: ${bytes} bytes`);
    }
  } else {
    bad("tar backup MISSING — rollback impossible");
  }

  // Gateway health (Rule 5)
  const gwActive2 = await ssh2.execCommand(
    `systemctl --user is-active openclaw-gateway 2>/dev/null || echo inactive`,
  );
  const gwHealth = await ssh2.execCommand(
    `curl -sf -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000`,
  );
  if ((gwActive2.stdout || "").trim() === "active") ok("gateway still active");
  else bad(`gateway not active: ${gwActive2.stdout?.trim()}`);
  if ((gwHealth.stdout || "").trim() === "200") ok("gateway /health = 200");
  else bad(`gateway /health = ${gwHealth.stdout?.trim()}`);

  ssh2.dispose();

  // ── 6. Behavioral probes (optional) ──
  if (!skipProbes && vm.telegram_bot_username && vm.health_status === "healthy") {
    console.log("\n── 6. Behavioral probes ──");
    console.log("  ⚠ Behavioral probes not yet automated. Manual checklist:");
    console.log("    V13 — 'launch a token called Test' → routes to instaclaw.io dashboard, no refusal");
    console.log("    V14 — edit Learned Preferences, send another message → cacheRead ≈ original");
    console.log("    V17 — 'what's edge city?' (if edge_city) → references edge-esmeralda SKILL.md");
    console.log("  Run via @" + vm.telegram_bot_username + " and verify before declaring canary green.");
  } else if (skipProbes) {
    console.log("\n── 6. Behavioral probes (skipped via --no-probes) ──");
  } else {
    console.log("\n── 6. Behavioral probes ── deferred (no bot or VM not healthy)");
  }

  // ── 7. Summary ──
  console.log(`\n══ Summary: ${passCount} pass / ${failCount} fail ══`);
  if (failCount > 0) {
    console.log("\n❌ Canary FAILED. Consider _rollback-v2-from-tar.ts for this VM.");
    return 2;
  }
  console.log("\n✅ Canary PASSED. Soak before proceeding to fleet rollout.");
  return 0;
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
    process.exit(1);
  });
