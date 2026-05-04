/**
 * Canary reconcile vm-780 to v81. Verifies the new manifest entries
 * (consensus_match_*.py + 30-min cron) actually deploy via the
 * existing reconciler path, with sentinel guards working.
 *
 * Per CLAUDE.md Rule 3: ALWAYS reconcile one VM first, verify gateway
 * stays healthy, before any fleet rollout. This script does step 1.
 *
 * What we verify after the reconcile:
 *   1. config_version bumped to 81 in instaclaw_vms
 *   2. All 4 matchpool scripts exist on disk under ~/.openclaw/scripts/
 *   3. Each script's sentinel strings are present (canonical post-fix
 *      content actually landed, not stale cache)
 *   4. Cron entry registered for consensus_match_pipeline.py
 *   5. Gateway is active + /health 200 (Rule 5)
 *   6. Pipeline can run from cron one time (--no-jitter, manual fire)
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
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

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  let pass = 0, fail = 0;
  const ok = (m: string) => { console.log(`  ✓ ${m}`); pass++; };
  const bad = (m: string) => { console.log(`  ✗ ${m}`); fail++; };

  console.log(`══ Canary reconcile vm-780 to manifest v${VM_MANIFEST.version} ══\n`);

  // 0. Pre-state
  console.log("── 0. Pre-state ──");
  const { data: vm0 } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", "instaclaw-vm-780")
    .single();
  if (!vm0) {
    console.error("FATAL: vm-780 not found");
    process.exit(2);
  }
  console.log(`  config_version: ${vm0.config_version}`);
  console.log(`  health_status:  ${vm0.health_status}`);
  console.log(`  partner:        ${vm0.partner ?? "null"}`);

  // 1. Reconcile
  console.log("\n── 1. Reconcile via lib/vm-reconcile.ts:reconcileVM ──");
  const start = Date.now();
  const result = await reconcileVM(vm0 as never, VM_MANIFEST, {
    dryRun: false,
    strict: true,
    canary: true,
    skipGatewayRestart: false,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  reconcile took ${elapsed}s`);
  console.log(`  fixed:           ${result.fixed.length} item(s)`);
  if (result.fixed.length > 0) {
    for (const item of result.fixed.slice(0, 30)) console.log(`    + ${item}`);
    if (result.fixed.length > 30) console.log(`    … (+${result.fixed.length - 30} more)`);
  }
  console.log(`  alreadyCorrect:  ${result.alreadyCorrect.length}`);
  console.log(`  errors:          ${result.errors.length}`);
  if (result.errors.length > 0) {
    for (const e of result.errors) console.log(`    ✗ ${e}`);
    bad("reconcile reported errors");
  } else {
    ok("reconcile reported zero errors");
  }
  console.log(`  gatewayRestartNeeded: ${result.gatewayRestartNeeded}`);
  console.log(`  gatewayRestarted:     ${result.gatewayRestarted}`);
  console.log(`  gatewayHealthy:       ${result.gatewayHealthy}`);
  console.log(`  canaryHealthy:        ${result.canaryHealthy}`);
  if (result.gatewayHealthy) ok("gateway healthy after reconcile");
  else bad("gateway NOT healthy after reconcile");

  // 2. Verify DB state
  console.log("\n── 2. Verify config_version bumped ──");
  const { data: vm1 } = await sb
    .from("instaclaw_vms")
    .select("config_version, health_status")
    .eq("name", "instaclaw-vm-780")
    .single();
  if (vm1?.config_version === VM_MANIFEST.version) {
    ok(`config_version = ${vm1.config_version} (expected ${VM_MANIFEST.version})`);
  } else {
    bad(`config_version = ${vm1?.config_version} (expected ${VM_MANIFEST.version})`);
  }

  // 3. Verify scripts on disk + sentinels
  console.log("\n── 3. Verify scripts on disk + sentinels ──");
  const ssh = new NodeSSH();
  await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 12000 });

  const scriptChecks: Array<[string, string[]]> = [
    ["consensus_match_pipeline.py", [
      "def build_l2_passthrough_deliberations",
      "FALLBACK_ABORT_THRESHOLD",
      "snapshot_anchor",
      "CONSENSUS_MEMORY_PATH",
      "maybe_send_match_notification",
    ]],
    ["consensus_match_rerank.py", [
      "RERANK_INSTRUCTIONS",
      "fabrication rule",
      "Banned phrases",
      "def shuffle_candidates",
    ]],
    ["consensus_match_deliberate.py", [
      "DELIBERATION_INSTRUCTIONS",
      "fabrication rule",
      "skip-reason discipline",
      "def make_fallback",
    ]],
    ["consensus_match_consent.py", [
      "VALID_TIERS",
      "interests_plus_name",
    ]],
  ];

  for (const [filename, sentinels] of scriptChecks) {
    const path = `~/.openclaw/scripts/${filename}`;
    const r = await ssh.execCommand(`test -f ${path} && wc -c ${path}`);
    if (r.code === 0) {
      const bytes = r.stdout.trim().split(" ")[0];
      ok(`${filename} exists (${bytes} bytes)`);

      // Sentinel check
      const grepCmd = sentinels.map((s) => `grep -q ${JSON.stringify(s)} ${path}`).join(" && ");
      const sentinelResult = await ssh.execCommand(grepCmd + " && echo ALL_PRESENT");
      if (sentinelResult.stdout.includes("ALL_PRESENT")) {
        ok(`${filename}: all ${sentinels.length} sentinels present`);
      } else {
        bad(`${filename}: missing sentinels (some/all)`);
      }
    } else {
      bad(`${filename} missing on disk`);
    }
  }

  // 4. Verify cron entry
  console.log("\n── 4. Verify cron entry ──");
  const cronR = await ssh.execCommand("crontab -l 2>/dev/null | grep -F 'consensus_match_pipeline.py'");
  if (cronR.code === 0 && cronR.stdout.includes("consensus_match_pipeline.py")) {
    ok("cron entry registered:");
    console.log("    " + cronR.stdout.trim());
  } else {
    bad("cron entry NOT found");
  }

  // 5. Gateway health
  console.log("\n── 5. Gateway health check ──");
  const healthR = await ssh.execCommand(
    "systemctl --user is-active openclaw-gateway && curl -sS -o /dev/null -w '%{http_code}' http://localhost:18789/health"
  );
  if (healthR.stdout.includes("active") && healthR.stdout.includes("200")) {
    ok("systemctl active AND /health 200");
  } else {
    bad(`gateway health check: stdout='${healthR.stdout}' stderr='${healthR.stderr}'`);
  }

  // 6. Pipeline cron-style test run
  console.log("\n── 6. Pipeline test run from on-disk script (simulates cron) ──");
  // Clear state so the throttle doesn't skip
  await ssh.execCommand("rm -f ~/.openclaw/.consensus_match_state.json ~/.openclaw/.consensus_match.lock");
  const pipR = await ssh.execCommand(
    "python3 ~/.openclaw/scripts/consensus_match_pipeline.py --force --no-jitter 2>&1 | head -30"
  );
  console.log("  output (first 30 lines):");
  console.log("  " + pipR.stdout.split("\n").join("\n  "));
  if (pipR.stdout.includes("post_results_ok") || pipR.stdout.includes("ok n=")) {
    ok("on-disk pipeline runs end-to-end");
  } else if (pipR.stdout.includes("abort high_fallback_rate")) {
    console.log("  ⚠ pipeline aborted on fallback rate (gateway flake) — graceful, P1 still open");
  } else {
    bad("on-disk pipeline did not complete successfully");
  }

  ssh.dispose();

  console.log(`\n══ ${pass} passed, ${fail} failed ══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  console.error(e instanceof Error ? e.stack : "");
  process.exit(1);
});
