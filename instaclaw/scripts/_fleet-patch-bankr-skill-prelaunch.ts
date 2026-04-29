/**
 * Fleet patch: apply InstaClaw overlay to the upstream Bankr skill on
 * every healthy + assigned VM, NOW, without waiting for the v66
 * reconciler to roll across the fleet.
 *
 * What gets applied (mirrors lib/ssh.ts configureOpenClaw, idempotent):
 *   1. rm -rf ~/.openclaw/skills/bankr/clanker  (Clanker SDK misroute)
 *   2. rm -rf ~/.openclaw/skills/bankr/base     (empty placeholder)
 *   3. Prepend BANKR_SKILL_PATCH_DIRECTIVE to bankr/bankr/SKILL.md
 *      gated by INSTACLAW_BANKR_PATCH_V1 marker.
 *
 * Per CLAUDE.md fleet-script rules:
 *   - Default = dry-run. Use --exec to write.
 *   - --test-first patches one VM (vm-780 by default) then pauses for
 *     human approval before continuing.
 *   - --dry-run prints the candidate set + first-10 targets.
 *
 * Usage:
 *   npx tsx scripts/_fleet-patch-bankr-skill-prelaunch.ts                          # dry-run
 *   npx tsx scripts/_fleet-patch-bankr-skill-prelaunch.ts --test-first             # patch vm-780, pause, dry-run rest
 *   npx tsx scripts/_fleet-patch-bankr-skill-prelaunch.ts --test-first --exec      # patch vm-780, pause, then full fleet
 *   npx tsx scripts/_fleet-patch-bankr-skill-prelaunch.ts --exec                   # full fleet, no pause
 *   npx tsx scripts/_fleet-patch-bankr-skill-prelaunch.ts --exec --batch=10 --delay=5000
 *
 * Safety:
 *   - Targets only status=assigned + health_status=healthy.
 *   - Idempotent: re-running on a patched VM is a no-op (skip).
 *   - Patch fails closed: never deletes the bankr/SKILL.md if directive
 *     prepend fails (writes to tmp, atomic mv).
 *   - Per-VM log written to /tmp/bankr-skill-prelaunch-{ts}.json.
 */
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env.ssh-key") });
import { connectSSH } from "../lib/ssh";
import { BANKR_SKILL_PATCH_DIRECTIVE, BANKR_SKILL_PATCH_MARKER } from "../lib/ssh";

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const EXEC = process.argv.includes("--exec");
const TEST_FIRST = process.argv.includes("--test-first");
const TEST_VM_NAME = process.argv.find((a) => a.startsWith("--test-vm="))?.split("=")[1] ?? "instaclaw-vm-780";
const BATCH_SIZE = parseInt(process.argv.find((a) => a.startsWith("--batch="))?.split("=")[1] ?? "10", 10);
const BATCH_DELAY_MS = parseInt(process.argv.find((a) => a.startsWith("--delay="))?.split("=")[1] ?? "5000", 10);

type VMRow = {
  id: string;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  status: string;
  health_status: string;
};

type Result = {
  vm: string;
  ip: string;
  result: "PATCHED" | "ALREADY_OK" | "NO_SKILL" | "SSH_FAIL" | "PATCH_FAIL" | "VERIFY_FAIL";
  detail?: string;
  ms: number;
};

const DIRECTIVE_B64 = Buffer.from(BANKR_SKILL_PATCH_DIRECTIVE, "utf-8").toString("base64");

// Mirrors the configureOpenClaw shell snippet but in a single script that
// can be exec'd over SSH. Returns a status code we map to a Result.
//   exit 0  → patched OR already-ok
//   exit 1  → ssh ok but skill dir missing (unprovisioned bankr skill)
//   exit 2  → patch step failed
//   exit 3  → verify step failed
const PATCH_SCRIPT = (b64: string): string => `
set -u
SKILL_BASE="$HOME/.openclaw/skills/bankr"
SKILL_MD="$SKILL_BASE/bankr/SKILL.md"
if [ ! -d "$SKILL_BASE" ] || [ ! -f "$SKILL_MD" ]; then
  echo "NO_SKILL"
  exit 1
fi
HAD_CLANKER=0
HAD_BASE=0
HAD_MARKER=0
[ -d "$SKILL_BASE/clanker" ] && HAD_CLANKER=1
[ -d "$SKILL_BASE/base" ] && HAD_BASE=1
grep -q "${BANKR_SKILL_PATCH_MARKER}" "$SKILL_MD" && HAD_MARKER=1
if [ "$HAD_CLANKER" = "0" ] && [ "$HAD_BASE" = "0" ] && [ "$HAD_MARKER" = "1" ]; then
  echo "ALREADY_OK"
  exit 0
fi
rm -rf "$SKILL_BASE/clanker" "$SKILL_BASE/base"
if [ "$HAD_MARKER" = "0" ]; then
  TMP=$(mktemp) || { echo "MKTEMP_FAIL"; exit 2; }
  if ! echo '${b64}' | base64 -d > "$TMP"; then
    rm -f "$TMP"
    echo "B64_DECODE_FAIL"
    exit 2
  fi
  if ! cat "$SKILL_MD" >> "$TMP"; then
    rm -f "$TMP"
    echo "APPEND_FAIL"
    exit 2
  fi
  if ! mv "$TMP" "$SKILL_MD"; then
    rm -f "$TMP"
    echo "MV_FAIL"
    exit 2
  fi
fi
# verify
if [ -d "$SKILL_BASE/clanker" ] || [ -d "$SKILL_BASE/base" ]; then
  echo "VERIFY_DIRS_REMAIN"
  exit 3
fi
if ! grep -q "${BANKR_SKILL_PATCH_MARKER}" "$SKILL_MD"; then
  echo "VERIFY_NO_MARKER"
  exit 3
fi
echo "PATCHED had_clanker=$HAD_CLANKER had_base=$HAD_BASE marker_added=$([ "$HAD_MARKER" = "0" ] && echo 1 || echo 0)"
exit 0
`;

async function patchOne(vm: VMRow): Promise<Result> {
  const start = Date.now();
  let ssh;
  try {
    ssh = await connectSSH(vm as Parameters<typeof connectSSH>[0]);
  } catch (err) {
    return {
      vm: vm.name,
      ip: vm.ip_address,
      result: "SSH_FAIL",
      detail: String(err).slice(0, 150),
      ms: Date.now() - start,
    };
  }
  try {
    const r = await ssh.execCommand(`bash -lc '${PATCH_SCRIPT(DIRECTIVE_B64).replace(/'/g, "'\\''")}'`);
    const out = (r.stdout || r.stderr || "").trim();
    const ms = Date.now() - start;
    if (r.code === 0) {
      if (out.startsWith("ALREADY_OK")) return { vm: vm.name, ip: vm.ip_address, result: "ALREADY_OK", detail: out, ms };
      if (out.startsWith("PATCHED")) return { vm: vm.name, ip: vm.ip_address, result: "PATCHED", detail: out, ms };
      return { vm: vm.name, ip: vm.ip_address, result: "PATCH_FAIL", detail: `unknown exit-0 stdout: ${out.slice(0, 150)}`, ms };
    }
    if (r.code === 1) return { vm: vm.name, ip: vm.ip_address, result: "NO_SKILL", detail: out.slice(0, 150), ms };
    if (r.code === 2) return { vm: vm.name, ip: vm.ip_address, result: "PATCH_FAIL", detail: out.slice(0, 150), ms };
    if (r.code === 3) return { vm: vm.name, ip: vm.ip_address, result: "VERIFY_FAIL", detail: out.slice(0, 150), ms };
    return {
      vm: vm.name,
      ip: vm.ip_address,
      result: "PATCH_FAIL",
      detail: `unexpected exit ${r.code}: ${out.slice(0, 150)}`,
      ms,
    };
  } finally {
    ssh.dispose();
  }
}

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

(async () => {
  console.log(`\n=== Fleet patch: Bankr skill prelaunch overlay (${EXEC ? "EXEC" : "DRY-RUN"}${TEST_FIRST ? " + TEST-FIRST" : ""}) ===\n`);

  const { data: vms, error } = await s
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, status, health_status")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .order("name");
  if (error || !vms) {
    console.error("query error:", error);
    process.exit(1);
  }

  console.log(`Total healthy + assigned VMs: ${vms.length}`);
  console.log(`Marker: ${BANKR_SKILL_PATCH_MARKER}`);
  console.log(`Directive bytes (base64): ${DIRECTIVE_B64.length}`);

  if (!EXEC && !TEST_FIRST) {
    console.log(`\nDRY-RUN — first 10 targets:`);
    for (const v of vms.slice(0, 10)) console.log(`  ${v.name?.padEnd(22)} ${v.ip_address}`);
    console.log(`  ... (${Math.max(0, vms.length - 10)} more)`);
    console.log(`\nTo test on one VM first: rerun with --test-first`);
    console.log(`To execute on full fleet:  rerun with --exec`);
    return;
  }

  const allResults: Result[] = [];

  if (TEST_FIRST) {
    const testVm = vms.find((v) => v.name === TEST_VM_NAME);
    if (!testVm) {
      console.error(`\n--test-first: VM "${TEST_VM_NAME}" not found in healthy+assigned set. Aborting.`);
      process.exit(1);
    }
    console.log(`\n── Test VM: ${testVm.name} (${testVm.ip_address}) ──`);
    const result = await patchOne(testVm as VMRow);
    allResults.push(result);
    const tag = result.result === "PATCHED" ? "✓" : result.result === "ALREADY_OK" ? "·" : "✗";
    console.log(`  ${tag} ${result.result.padEnd(13)} (${result.ms}ms) ${result.detail ?? ""}`);

    if (result.result !== "PATCHED" && result.result !== "ALREADY_OK") {
      console.error(`\nTest VM failed (${result.result}). NOT continuing to fleet.`);
      const logPath = `/tmp/bankr-skill-prelaunch-${Date.now()}.json`;
      fs.writeFileSync(logPath, JSON.stringify({ results: allResults, aborted: true }, null, 2));
      process.exit(1);
    }
    if (!EXEC) {
      console.log(`\nTest VM patched successfully. Re-run with --exec to roll across the fleet.`);
      return;
    }
    const ans = await ask(`\nProceed with full fleet rollout (${vms.length - 1} more VMs)? [y/N] `);
    if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") {
      console.log("Aborted by user.");
      return;
    }
  }

  const targets = TEST_FIRST ? vms.filter((v) => v.name !== TEST_VM_NAME) : vms;
  const batches = Math.ceil(targets.length / BATCH_SIZE);

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = targets.slice(i, i + BATCH_SIZE) as VMRow[];
    console.log(`\n── Batch ${batchNum}/${batches} (${batch.length} VMs) ──`);
    const results = await Promise.all(batch.map(patchOne));
    for (const r of results) {
      const tag =
        r.result === "PATCHED"
          ? "✓"
          : r.result === "ALREADY_OK"
          ? "·"
          : r.result === "NO_SKILL"
          ? "○"
          : "✗";
      console.log(`  ${tag} ${r.vm.padEnd(22)} ${r.result.padEnd(13)} (${r.ms}ms) ${(r.detail ?? "").slice(0, 120)}`);
      allResults.push(r);
    }
    if (i + BATCH_SIZE < targets.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Summary
  const stats: Record<Result["result"], number> = {
    PATCHED: 0,
    ALREADY_OK: 0,
    NO_SKILL: 0,
    SSH_FAIL: 0,
    PATCH_FAIL: 0,
    VERIFY_FAIL: 0,
  };
  for (const r of allResults) stats[r.result]++;

  console.log(`\n=== Summary ===`);
  console.log(`  total checked:    ${allResults.length}`);
  console.log(`  ✓ PATCHED:        ${stats.PATCHED}`);
  console.log(`  · ALREADY_OK:     ${stats.ALREADY_OK}`);
  console.log(`  ○ NO_SKILL:       ${stats.NO_SKILL}      (skill dir missing — VM never provisioned bankr; configureOpenClaw will apply on next reconcile)`);
  console.log(`  ✗ SSH_FAIL:       ${stats.SSH_FAIL}`);
  console.log(`  ✗ PATCH_FAIL:     ${stats.PATCH_FAIL}`);
  console.log(`  ✗ VERIFY_FAIL:    ${stats.VERIFY_FAIL}`);

  const logPath = `/tmp/bankr-skill-prelaunch-${Date.now()}.json`;
  fs.writeFileSync(logPath, JSON.stringify({ stats, results: allResults }, null, 2));
  console.log(`\nDetailed log: ${logPath}`);

  const failed = stats.SSH_FAIL + stats.PATCH_FAIL + stats.VERIFY_FAIL;
  if (failed > 0) {
    console.log(`\n⚠️  ${failed} VMs failed — review log and re-run targeted retries`);
    process.exit(1);
  }
  console.log(`\n✅ All targets patched or already up to date.`);
})();
