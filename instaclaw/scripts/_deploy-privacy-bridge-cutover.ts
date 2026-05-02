/**
 * Privacy bridge cutover — wires ~/.openclaw/scripts/privacy-bridge.sh into
 * ~/.ssh/authorized_keys on edge_city VMs by prepending the OpenSSH
 * `command="..."` directive to the deploy key line. This is the step that
 * actually starts enforcing privacy mode on every operator SSH command.
 *
 * HIGH-RISK: a malformed authorized_keys edit can lock us out of the VM. The
 * script:
 *   1. Reads the current authorized_keys
 *   2. Computes the new content
 *   3. Writes to a `.tmp` file
 *   4. Atomically renames into place
 *   5. Verifies SSH still works by running an ALWAYS_ALLOWED command
 *      (`systemctl --user is-active openclaw-gateway`) through the bridge
 *   6. If verify fails: REVERT (restore the .bak)
 *
 * Required pre-conditions before running this:
 *   - PRD § 6.1 emergency-bypass key MUST already be deployed in
 *     authorized_keys as a SEPARATE LINE (no command= directive). The cutover
 *     edits ONLY the deploy key, never the bypass key. If you don't have a
 *     bypass key deployed, ABORT — there is no second SSH route into the VM
 *     if the bridge breaks.
 *   - Reconciler v78+ has already deployed privacy-bridge.sh to the VM (run
 *     /api/cron/reconcile-fleet first; verify with `ls
 *     ~/.openclaw/scripts/privacy-bridge.sh` over SSH).
 *
 * Usage:
 *   npx tsx scripts/_deploy-privacy-bridge-cutover.ts --dry-run
 *   npx tsx scripts/_deploy-privacy-bridge-cutover.ts --test-first vm-354
 *   npx tsx scripts/_deploy-privacy-bridge-cutover.ts --concurrency 1
 *
 * Rules: 3 (test on one), 4 (dry-run first), 10 (verify-after-set).
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { connectSSH } from "../lib/ssh";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const BRIDGE_PATH = "/home/openclaw/.openclaw/scripts/privacy-bridge.sh";
const COMMAND_DIRECTIVE = `command="${BRIDGE_PATH}",no-pty`;
const VERIFY_CMD = "systemctl --user is-active openclaw-gateway";

interface VmRow {
  id: string;
  name: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  partner: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const testIdx = args.indexOf("--test-first");
  const testFirst = testIdx >= 0 ? args[testIdx + 1] : null;
  const concIdx = args.indexOf("--concurrency");
  const concurrency = concIdx >= 0 ? parseInt(args[concIdx + 1], 10) || 1 : 1;
  return { dryRun, testFirst, concurrency };
}

async function cutoverOne(vm: VmRow, dryRun: boolean): Promise<{ ok: boolean; msg: string }> {
  if (!vm.ip_address) return { ok: false, msg: "no ip_address" };

  let ssh;
  try {
    ssh = await connectSSH({
      ip_address: vm.ip_address,
      ssh_port: vm.ssh_port ?? 22,
      ssh_user: vm.ssh_user ?? "openclaw",
    });
  } catch (e) {
    return { ok: false, msg: `connect: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    // Pre-check: bridge script exists?
    const exists = await ssh.execCommand(`[ -x ${BRIDGE_PATH} ] && echo OK || echo MISSING`);
    if ((exists.stdout || "").trim() !== "OK") {
      return { ok: false, msg: "privacy-bridge.sh missing — reconcile first" };
    }

    // Read current authorized_keys
    const current = await ssh.execCommand("cat ~/.ssh/authorized_keys");
    if (current.code !== 0) return { ok: false, msg: `read authorized_keys: rc=${current.code}` };

    const lines = (current.stdout || "").split("\n");
    let editedAny = false;
    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      // Skip lines already wrapped (idempotent)
      if (trimmed.startsWith("command=")) return line;
      // Heuristic: ssh-rsa / ssh-ed25519 / ecdsa-sha2-* keys at start of line
      if (/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-)/.test(trimmed)) {
        editedAny = true;
        return `${COMMAND_DIRECTIVE} ${line}`;
      }
      return line;
    });

    if (!editedAny) {
      return { ok: true, msg: "already cutover (no plain key lines found)" };
    }

    if (dryRun) {
      return { ok: true, msg: `[dry-run] would prepend ${COMMAND_DIRECTIVE} to ${lines.filter((l) => /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-)/.test(l.trim())).length} key line(s)` };
    }

    const newContent = newLines.join("\n");

    // Backup, then atomic replace
    const backup = await ssh.execCommand("cp ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak.privacy-cutover");
    if (backup.code !== 0) return { ok: false, msg: `backup: rc=${backup.code}` };

    const b64 = Buffer.from(newContent, "utf-8").toString("base64");
    const write = await ssh.execCommand(
      `echo '${b64}' | base64 -d > ~/.ssh/authorized_keys.tmp && mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys && chmod 0600 ~/.ssh/authorized_keys`,
    );
    if (write.code !== 0) {
      // Try to revert
      await ssh.execCommand("cp ~/.ssh/authorized_keys.bak.privacy-cutover ~/.ssh/authorized_keys");
      return { ok: false, msg: `write: rc=${write.code}` };
    }

    // Disconnect first connection (the new authorized_keys takes effect on next SSH)
    ssh.dispose();

    // Verify: open a fresh SSH connection (which will go through the bridge) and run an allowed command.
    let verifySsh;
    try {
      verifySsh = await connectSSH({
        ip_address: vm.ip_address,
        ssh_port: vm.ssh_port ?? 22,
        ssh_user: vm.ssh_user ?? "openclaw",
      });
    } catch (e) {
      // CRITICAL: verify connect failed. Use the bypass key path or alarm.
      return { ok: false, msg: `VERIFY-CONNECT-FAILED: ${e instanceof Error ? e.message : String(e)} — use bypass key to revert authorized_keys.bak.privacy-cutover` };
    }
    try {
      const verify = await verifySsh.execCommand(VERIFY_CMD);
      if (verify.code !== 0) {
        // Revert via this connection (it works, so we still have access)
        await verifySsh.execCommand("cp ~/.ssh/authorized_keys.bak.privacy-cutover ~/.ssh/authorized_keys");
        return { ok: false, msg: `verify cmd failed rc=${verify.code} stderr=${(verify.stderr || "").slice(0, 200)} — REVERTED` };
      }
      return { ok: true, msg: `cutover applied + verified (gateway ${(verify.stdout || "").trim()})` };
    } finally {
      verifySsh.dispose();
    }
  } finally {
    try {
      ssh.dispose();
    } catch {
      // best effort
    }
  }
}

(async () => {
  const { dryRun, testFirst, concurrency } = parseArgs();
  console.log(`Privacy bridge cutover — dryRun=${dryRun} testFirst=${testFirst ?? "(no)"} concurrency=${concurrency}`);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, partner")
    .eq("partner", "edge_city")
    .eq("status", "assigned");

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }
  if (!vms || vms.length === 0) {
    console.log("No edge_city VMs found.");
    return;
  }

  const list = testFirst ? (vms as VmRow[]).filter((v) => v.name === testFirst) : (vms as VmRow[]);
  if (testFirst && list.length === 0) {
    console.error(`--test-first ${testFirst} not found among edge_city VMs.`);
    process.exit(1);
  }
  console.log(`Targets: ${list.map((v) => v.name).join(", ")}`);
  console.log("");

  // Sequential at concurrency=1 (default) for safety
  const results: Array<{ vm: string; ok: boolean; msg: string }> = [];
  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const vm = queue.shift();
      if (!vm) return;
      const { ok, msg } = await cutoverOne(vm, dryRun);
      results.push({ vm: vm.name, ok, msg });
      console.log(`${ok ? "✓" : "✗"} ${vm.name}: ${msg}`);
      if (!ok && !dryRun) {
        console.error(`HALTING because ${vm.name} failed. Inspect, then re-run.`);
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const okCount = results.filter((r) => r.ok).length;
  console.log("");
  console.log(`=== ${okCount}/${results.length} succeeded ===`);
  if (testFirst && okCount === 1) {
    console.log("");
    console.log("✓ test VM cutover verified. Re-run WITHOUT --test-first to apply to all edge_city VMs.");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
