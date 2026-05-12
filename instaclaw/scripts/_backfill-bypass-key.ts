/**
 * Backfill the emergency-bypass SSH key to every edge_city VM.
 *
 * Pre-cutover gate for _deploy-privacy-bridge-cutover.ts. The cutover wraps
 * deploy keys with the privacy-bridge `command="..."` directive; the bypass
 * key MUST remain unwrapped so we have an escape hatch if the bridge ever
 * fails. Without a bypass, a bridge crash = permanent lockout.
 *
 * Usage:
 *   tsx scripts/_backfill-bypass-key.ts --dry-run
 *   tsx scripts/_backfill-bypass-key.ts --test-first instaclaw-vm-780
 *   tsx scripts/_backfill-bypass-key.ts
 *
 * Source of truth: vm-050's authorized_keys (Cooper deployed the bypass
 * there manually on 2026-05-11; this script extracts its public key line
 * and appends it to every other edge_city VM that doesn't already have it).
 *
 * Idempotent — running twice is a no-op on any VM that already has the
 * bypass. Atomic write: backup → tmp → mv → re-read verify. Never deletes.
 *
 * Env: loads .env.local AND .env.ssh-key per Rule 18 (SSH_PRIVATE_KEY_B64).
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import type { NodeSSH } from "node-ssh";
import { connectSSH } from "../lib/ssh";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.ssh-key") });

const BYPASS_PATTERN = /bypass/i;
const SOURCE_VM_NAME = "instaclaw-vm-050";

interface VmRow {
  id: string;
  name: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  partner: string | null;
}

interface BackfillResult {
  vm: string;
  status: "appended" | "already_had" | "failed";
  msg: string;
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

async function readBypassLine(vm: VmRow): Promise<string> {
  if (!vm.ip_address) throw new Error(`${vm.name} has no ip_address`);
  const ssh = await connectSSH({
    ip_address: vm.ip_address,
    ssh_port: vm.ssh_port ?? 22,
    ssh_user: vm.ssh_user ?? "openclaw",
  });
  try {
    const res = await ssh.execCommand("cat ~/.ssh/authorized_keys");
    if (res.code !== 0) {
      throw new Error(`read authorized_keys on ${vm.name}: ${res.stderr}`);
    }
    const candidates = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !l.startsWith("#") &&
          !l.startsWith("command=") &&
          /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-)/.test(l) &&
          BYPASS_PATTERN.test(l)
      );
    if (candidates.length === 0) {
      throw new Error(
        `${vm.name} has no bypass key in authorized_keys — cannot extract source. Did Cooper deploy it there manually on 2026-05-11?`
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `${vm.name} has multiple lines matching /bypass/i (${candidates.length}); refusing to guess which is canonical. Investigate manually.`
      );
    }
    return candidates[0];
  } finally {
    ssh.dispose();
  }
}

async function appendBypassToVm(
  vm: VmRow,
  bypassLine: string,
  dryRun: boolean
): Promise<BackfillResult> {
  if (!vm.ip_address)
    return { vm: vm.name, status: "failed", msg: "no ip_address" };

  let ssh: NodeSSH;
  try {
    ssh = await connectSSH({
      ip_address: vm.ip_address,
      ssh_port: vm.ssh_port ?? 22,
      ssh_user: vm.ssh_user ?? "openclaw",
    });
  } catch (e) {
    return {
      vm: vm.name,
      status: "failed",
      msg: `connect: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    const read = await ssh.execCommand("cat ~/.ssh/authorized_keys");
    if (read.code !== 0) {
      return { vm: vm.name, status: "failed", msg: `read: ${read.stderr}` };
    }
    const existing = read.stdout;

    // Idempotency check — already has a bypass key, leave alone.
    if (BYPASS_PATTERN.test(existing)) {
      return {
        vm: vm.name,
        status: "already_had",
        msg: "bypass key already present",
      };
    }

    if (dryRun) {
      return {
        vm: vm.name,
        status: "appended",
        msg: "[dry-run] would append bypass key",
      };
    }

    // Compose new content. Append cleanly with a leading newline if the
    // existing file doesn't already end with one (common on hand-edited
    // authorized_keys).
    const needsNewline = existing.length > 0 && !existing.endsWith("\n");
    const newContent =
      existing + (needsNewline ? "\n" : "") + bypassLine + "\n";

    // Backup → write → atomic mv → chmod, mirroring the cutover script.
    const backup = await ssh.execCommand(
      "cp ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak.bypass-backfill"
    );
    if (backup.code !== 0) {
      return { vm: vm.name, status: "failed", msg: `backup: ${backup.stderr}` };
    }

    const b64 = Buffer.from(newContent, "utf-8").toString("base64");
    const write = await ssh.execCommand(
      `echo '${b64}' | base64 -d > ~/.ssh/authorized_keys.tmp && mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys && chmod 0600 ~/.ssh/authorized_keys`
    );
    if (write.code !== 0) {
      // Revert
      await ssh.execCommand(
        "cp ~/.ssh/authorized_keys.bak.bypass-backfill ~/.ssh/authorized_keys"
      );
      return {
        vm: vm.name,
        status: "failed",
        msg: `write: ${write.stderr} (reverted)`,
      };
    }

    // Verify: re-read, confirm the bypass pattern is now present.
    const verify = await ssh.execCommand("cat ~/.ssh/authorized_keys");
    if (verify.code !== 0) {
      return {
        vm: vm.name,
        status: "failed",
        msg: `verify-read: ${verify.stderr}`,
      };
    }
    if (!BYPASS_PATTERN.test(verify.stdout)) {
      // This shouldn't happen — the new content we wrote includes the
      // bypass line. If verify fails, revert and report.
      await ssh.execCommand(
        "cp ~/.ssh/authorized_keys.bak.bypass-backfill ~/.ssh/authorized_keys"
      );
      return {
        vm: vm.name,
        status: "failed",
        msg: "verify mismatch: bypass not found after write (reverted)",
      };
    }

    return { vm: vm.name, status: "appended", msg: "bypass key appended + verified" };
  } finally {
    ssh.dispose();
  }
}

(async () => {
  const { dryRun, testFirst, concurrency } = parseArgs();
  console.log(
    `Bypass-key backfill — dryRun=${dryRun} testFirst=${testFirst ?? "(no)"} concurrency=${concurrency}`
  );

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
    process.exit(1);
  }
  if (!process.env.SSH_PRIVATE_KEY_B64) {
    console.error("Missing SSH_PRIVATE_KEY_B64 — is .env.ssh-key loaded?");
    process.exit(1);
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // Read canonical bypass line from vm-050.
  const { data: sourceVm, error: srcErr } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", SOURCE_VM_NAME)
    .single();
  if (srcErr || !sourceVm) {
    console.error(`Source VM ${SOURCE_VM_NAME} not found: ${srcErr?.message}`);
    process.exit(1);
  }

  console.log(`Reading canonical bypass line from ${SOURCE_VM_NAME}...`);
  let bypassLine: string;
  try {
    bypassLine = await readBypassLine(sourceVm as VmRow);
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.log(`  ✓ bypass line extracted (${bypassLine.length} chars)`);

  // Query all edge_city VMs (including the source — script will detect
  // already_had and skip the source naturally).
  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("partner", "edge_city")
    .eq("status", "assigned");
  if (error) {
    console.error("VM query failed:", error.message);
    process.exit(1);
  }
  if (!vms || vms.length === 0) {
    console.log("No assigned edge_city VMs found.");
    return;
  }

  const list = (vms as VmRow[]).filter((v) =>
    testFirst ? v.name === testFirst : true
  );
  if (testFirst && list.length === 0) {
    console.error(`--test-first ${testFirst} not found among edge_city VMs.`);
    process.exit(1);
  }
  console.log(`Targets (${list.length}): ${list.map((v) => v.name).join(", ")}`);
  console.log("");

  // Sequential worker(s) for safety.
  const queue = [...list];
  const results: BackfillResult[] = [];
  async function worker() {
    while (queue.length) {
      const vm = queue.shift();
      if (!vm) return;
      const r = await appendBypassToVm(vm, bypassLine, dryRun);
      const tag =
        r.status === "appended" ? "✓" : r.status === "already_had" ? "·" : "✗";
      console.log(`${tag} ${r.vm}: ${r.msg}`);
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Summary
  console.log("");
  console.log("─".repeat(60));
  const appended = results.filter((r) => r.status === "appended").length;
  const already = results.filter((r) => r.status === "already_had").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`Appended:   ${appended}${dryRun ? " (dry-run)" : ""}`);
  console.log(`Already had: ${already}`);
  console.log(`Failed:     ${failed}`);
  if (failed > 0) {
    console.log("");
    console.log("Failures:");
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(`  ${r.vm}: ${r.msg}`);
    }
    process.exit(1);
  }
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
