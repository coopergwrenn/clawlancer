/**
 * Backfill `instaclaw_users.xmtp_greeting_sent_at` from on-VM marker files.
 *
 * Why: the per-user marker was added in PR #4 (feat/xmtp-per-user-marker).
 * Existing users whose VMs sent the greeting BEFORE that PR have a per-VM
 * filesystem marker (`~/.openclaw/xmtp/.greeting-sent`) but no DB row in
 * `instaclaw_users.xmtp_greeting_sent_at`. If their VM is ever re-provisioned,
 * they'd be greeted a SECOND time. This script flips the DB column for every
 * already-greeted user using the marker file as the source of truth.
 *
 * Default mode: DRY RUN. Prints a table of (user, vm, marker_timestamp, action)
 * and a summary. Does NOT touch the database.
 *
 * --execute: Actually issues the UPDATE for each backfill candidate. Only
 * writes when the column is currently NULL (idempotent — re-runs are safe).
 *
 * Usage:
 *   npx tsx scripts/_backfill-xmtp-greeting-sent-at.ts          # dry-run
 *   npx tsx scripts/_backfill-xmtp-greeting-sent-at.ts --execute
 *   npx tsx scripts/_backfill-xmtp-greeting-sent-at.ts --concurrency 5
 *
 * Concurrency: SSHes a few VMs in parallel (default 8). Lower with --concurrency
 * if seeing rate-limit / connection errors against many VMs at once.
 */
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Load env ──
function loadEnv(file: string) {
  try {
    const content = readFileSync(resolve(".", file), "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {
    /* file may not exist — skip */
  }
}
loadEnv(".env.local");
loadEnv(".env.ssh-key");

// ── Args ──
const EXECUTE = process.argv.includes("--execute");
const concurrencyArg = process.argv.find((a) => a.startsWith("--concurrency"));
const CONCURRENCY = concurrencyArg
  ? Number(concurrencyArg.split("=")[1] ?? process.argv[process.argv.indexOf(concurrencyArg) + 1])
  : 8;

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!process.env.SSH_PRIVATE_KEY_B64) {
  console.error("Missing SSH_PRIVATE_KEY_B64");
  process.exit(1);
}

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64, "base64").toString("utf-8");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── Types ──
interface VmRow {
  id: string;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  assigned_to: string;
  xmtp_address: string | null;
}
interface ProbeResult {
  vmId: string;
  vmName: string;
  ip: string;
  userId: string;
  status: "would_backfill" | "already_set" | "no_marker" | "ssh_failed";
  markerTimestamp?: string | null;
  existingDbValue?: string | null;
  error?: string;
}

// ── Probe one VM ──
async function probeVm(vm: VmRow, currentDbValue: string | null): Promise<ProbeResult> {
  const result: ProbeResult = {
    vmId: vm.id,
    vmName: vm.name,
    ip: vm.ip_address,
    userId: vm.assigned_to,
    status: "ssh_failed",
    existingDbValue: currentDbValue,
  };

  // If DB already has a value, skip without SSHing — backfill not needed.
  if (currentDbValue) {
    result.status = "already_set";
    return result;
  }

  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      port: vm.ssh_port,
      username: vm.ssh_user,
      privateKey: sshKey,
      readyTimeout: 10_000,
    });
    const r = await ssh.execCommand(
      "cat ~/.openclaw/xmtp/.greeting-sent 2>/dev/null || echo NO_MARKER",
    );
    const stdout = r.stdout.trim();
    if (stdout === "NO_MARKER" || !stdout) {
      result.status = "no_marker";
    } else {
      result.status = "would_backfill";
      result.markerTimestamp = stdout;
    }
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
    return result;
  } finally {
    ssh.dispose();
  }
}

// ── Limited-concurrency map ──
async function pmap<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Main ──
async function main() {
  console.log(`Mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"}  (concurrency: ${CONCURRENCY})`);
  console.log("");

  // Pull all assigned VMs that have an XMTP address (i.e., setupXMTP ran).
  const { data: vms, error: vmErr } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, assigned_to, xmtp_address")
    .not("assigned_to", "is", null)
    .not("xmtp_address", "is", null)
    .order("name");
  if (vmErr) {
    console.error("Failed to fetch VMs:", vmErr);
    process.exit(1);
  }
  if (!vms || vms.length === 0) {
    console.log("No assigned VMs with xmtp_address found.");
    return;
  }
  console.log(`Found ${vms.length} candidate VMs (assigned + xmtp_address set).`);

  // Pull existing xmtp_greeting_sent_at for the same users so we can skip
  // already-set rows without SSH.
  const userIds = Array.from(new Set(vms.map((v) => v.assigned_to as string)));
  const { data: users } = await sb
    .from("instaclaw_users")
    .select("id, xmtp_greeting_sent_at")
    .in("id", userIds);
  const existingByUser = new Map<string, string | null>();
  for (const u of users ?? []) {
    existingByUser.set(u.id, u.xmtp_greeting_sent_at ?? null);
  }

  // Probe.
  console.log("Probing VMs over SSH...\n");
  const probes = await pmap(vms as VmRow[], CONCURRENCY, (vm) =>
    probeVm(vm, existingByUser.get(vm.assigned_to) ?? null),
  );

  // Categorize.
  const wouldBackfill = probes.filter((p) => p.status === "would_backfill");
  const alreadySet = probes.filter((p) => p.status === "already_set");
  const noMarker = probes.filter((p) => p.status === "no_marker");
  const sshFailed = probes.filter((p) => p.status === "ssh_failed");

  // ── Print results ──
  if (wouldBackfill.length) {
    console.log(`\n=== ${wouldBackfill.length} ${EXECUTE ? "BACKFILLED" : "WOULD BACKFILL"} ===`);
    for (const p of wouldBackfill) {
      console.log(
        `  ${p.vmName.padEnd(20)}  user=${p.userId.slice(0, 8)}…  marker=${p.markerTimestamp}`,
      );
    }
  }
  if (sshFailed.length) {
    console.log(`\n=== ${sshFailed.length} SSH FAILED (skipped) ===`);
    for (const p of sshFailed.slice(0, 20)) {
      console.log(`  ${p.vmName.padEnd(20)}  ${p.ip.padEnd(16)}  ${p.error}`);
    }
    if (sshFailed.length > 20) console.log(`  ... and ${sshFailed.length - 20} more`);
  }
  console.log("");
  console.log(`Summary:`);
  console.log(`  Total VMs probed:      ${probes.length}`);
  console.log(`  Would backfill:        ${wouldBackfill.length}`);
  console.log(`  Already set in DB:     ${alreadySet.length}`);
  console.log(`  No marker on disk:     ${noMarker.length}`);
  console.log(`  SSH failed:            ${sshFailed.length}`);

  // ── Apply (if --execute) ──
  if (!EXECUTE) {
    console.log(`\n[dry-run] No DB writes. Re-run with --execute to apply.`);
    return;
  }

  if (wouldBackfill.length === 0) {
    console.log(`\n[execute] Nothing to write.`);
    return;
  }

  console.log(`\n[execute] Applying ${wouldBackfill.length} updates...`);
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of wouldBackfill) {
    // Use the marker timestamp; if it's not a valid ISO date, fall back to NOW().
    const ts =
      p.markerTimestamp && !Number.isNaN(Date.parse(p.markerTimestamp))
        ? new Date(p.markerTimestamp).toISOString()
        : new Date().toISOString();
    const { data, error } = await sb
      .from("instaclaw_users")
      .update({ xmtp_greeting_sent_at: ts })
      .eq("id", p.userId)
      .is("xmtp_greeting_sent_at", null)
      .select("id");
    if (error) {
      console.log(`  ✗ ${p.vmName}: ${error.message}`);
      failed++;
    } else if (!data?.length) {
      // Race: someone else set the value between probe and update.
      console.log(`  · ${p.vmName}: already set (race)`);
      skipped++;
    } else {
      updated++;
    }
  }
  console.log(`\n[execute] updated=${updated}  skipped=${skipped}  failed=${failed}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
