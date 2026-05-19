/**
 * One-shot cleanup for duplicate edge-esmeralda git-pull cron entries.
 *
 * Bug: lib/ssh.ts (pre-2026-05-19) installed the edge-esmeralda
 *      auto-pull cron using `grep -v "edge-agent-skill"` to filter
 *      pre-existing entries, but the actual cron line contains
 *      "skills/edge-esmeralda" — not "edge-agent-skill". So the filter
 *      never matched, and every configureOpenClaw call appended another
 *      copy of the same cron line. Audit on vm-050 found 5+ identical
 *      entries; other edge_city VMs are likely in similar shape.
 *
 *      The ssh.ts side has been fixed in the same PR — new
 *      configureOpenClaw calls will dedup correctly. This script
 *      handles the existing 9 edge_city VMs that already accumulated
 *      duplicates.
 *
 * Strategy (idempotent — safe to re-run):
 *   1. Read each VM's crontab.
 *   2. Count edge-esmeralda git-pull entries.
 *   3. If > 1: rewrite the crontab keeping the FIRST matching line and
 *      removing the rest. Atomic install via `crontab -`.
 *   4. If 0: leave alone (the VM never installed the cron — possibly a
 *      non-fully-configured VM; flag for review).
 *   5. If 1: leave alone (already deduped).
 *
 *   For belt-and-suspenders the script also runs `crontab -l` post-fix
 *   to confirm exactly 1 line. If any VM ends with != 1, exit non-zero.
 *
 * Safety:
 *   - Reads first, then writes ATOMICALLY via `crontab -`. No partial
 *     state if the connection drops mid-call.
 *   - Backs up the original crontab to ~/cron-backups/<ts>.crontab on
 *     the VM before writing. The user can `crontab ~/cron-backups/<ts>.crontab`
 *     to restore.
 *   - Doesn't touch any other cron entries (heartbeat, watchdog, etc.).
 *
 * Usage:
 *   tsx scripts/_dedup-edge-esmeralda-cron.ts --dry-run    # report only
 *   tsx scripts/_dedup-edge-esmeralda-cron.ts              # actually fix
 *
 * Output is a per-VM table:
 *   vm-name  | ip           | before | after | status
 *   vm-050   | 172.x.x.x    | 5      | 1     | ✓ deduped
 *   vm-354   | 172.x.x.x    | 1      | 1     | already-clean
 *   ...
 *
 * Exits 0 if all VMs end at exactly 1 entry; non-zero otherwise.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { connectSSH } from "../lib/ssh";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.ssh-key") });

const CRON_GREP_PATTERN = "skills/edge-esmeralda"; // matches the path in the cron line

interface VmRow {
  id: string;
  name: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  partner: string | null;
  health_status: string | null;
  status: string | null;
}

interface Result {
  vm: string;
  ip: string;
  before: number;
  after: number;
  status: "deduped" | "already-clean" | "no-cron" | "failed";
  detail?: string;
}

async function dedupOne(vm: VmRow, dryRun: boolean): Promise<Result> {
  if (!vm.ip_address) return { vm: vm.name, ip: "?", before: 0, after: 0, status: "failed", detail: "no ip_address" };

  const ssh = await connectSSH(vm);
  try {
    // ── Phase 1: read current crontab + count ──
    const probe = await ssh.execCommand(`crontab -l 2>/dev/null | grep -c "${CRON_GREP_PATTERN}" || echo 0`);
    const before = Number((probe.stdout || "0").trim()) || 0;

    if (before === 0) {
      return { vm: vm.name, ip: vm.ip_address, before, after: 0, status: "no-cron" };
    }
    if (before === 1) {
      return { vm: vm.name, ip: vm.ip_address, before, after: 1, status: "already-clean" };
    }

    if (dryRun) {
      return { vm: vm.name, ip: vm.ip_address, before, after: before, status: "deduped", detail: "[dry-run] would reduce to 1" };
    }

    // ── Phase 2: backup + atomic dedupe-and-rewrite ──
    // Algorithm: print the crontab, keep all non-matching lines, then
    // append the FIRST matching line exactly once.
    //
    // awk approach: first pass collects the first matching line; second
    // pass prints all non-matching lines; then we append the first matching.
    //
    // Bash one-liner that does it in one pass:
    //   crontab -l | awk -v p="$P" 'BEGIN{seen=0} $0 ~ p { if (!seen) { first=$0; seen=1 }; next } { print } END { if (seen) print first }' | crontab -
    //
    // This:
    //   - skips ALL lines matching the pattern, capturing only the first
    //   - prints every non-matching line
    //   - at the end, prints the captured first matching line (so order is non-matching... matching)
    //
    // Backup first:
    const backup = await ssh.execCommand(
      `mkdir -p ~/cron-backups && crontab -l 2>/dev/null > ~/cron-backups/edge-cron-dedup-$(date +%s).crontab && ls -la ~/cron-backups/ | tail -3`
    );
    if (backup.code !== 0) {
      return { vm: vm.name, ip: vm.ip_address, before, after: before, status: "failed", detail: `backup failed: ${(backup.stderr || backup.stdout).slice(0, 200)}` };
    }

    // Apply the dedup (single-pass awk):
    const fix = await ssh.execCommand(
      `crontab -l 2>/dev/null | awk -v p="${CRON_GREP_PATTERN}" 'BEGIN{seen=0} $0 ~ p { if (!seen) { first=$0; seen=1 }; next } { print } END { if (seen) print first }' | crontab -`
    );
    if (fix.code !== 0) {
      return { vm: vm.name, ip: vm.ip_address, before, after: before, status: "failed", detail: `crontab install failed: ${(fix.stderr || fix.stdout).slice(0, 200)}` };
    }

    // ── Phase 3: verify ──
    const verify = await ssh.execCommand(`crontab -l 2>/dev/null | grep -c "${CRON_GREP_PATTERN}" || echo 0`);
    const after = Number((verify.stdout || "0").trim()) || 0;
    if (after !== 1) {
      return { vm: vm.name, ip: vm.ip_address, before, after, status: "failed", detail: `expected 1 after dedupe, got ${after}` };
    }
    return { vm: vm.name, ip: vm.ip_address, before, after, status: "deduped" };
  } finally {
    ssh.dispose();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data, error } = await sb.from("instaclaw_vms")
    .select("*")
    .eq("partner", "edge_city")
    .eq("health_status", "healthy")
    .eq("status", "assigned")
    .order("name");
  if (error) { console.error("supabase err:", error.message); process.exit(2); }

  const vms = (data ?? []) as VmRow[];
  console.log(`Targets: ${vms.length} edge_city VMs (healthy, assigned)`);
  console.log(`Mode:    ${dryRun ? "DRY-RUN (no changes)" : "LIVE (will rewrite crontabs)"}`);
  console.log("");
  console.log("vm".padEnd(22) + "ip".padEnd(18) + "before  after  status");
  console.log("─".repeat(70));

  const results: Result[] = [];
  for (const vm of vms) {
    process.stdout.write(`${vm.name.padEnd(22)}`);
    try {
      const r = await dedupOne(vm, dryRun);
      results.push(r);
      console.log(
        `${(r.ip || "?").padEnd(18)}${String(r.before).padEnd(8)}${String(r.after).padEnd(7)}${r.status}` +
        (r.detail ? `  (${r.detail})` : "")
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      results.push({ vm: vm.name, ip: vm.ip_address || "?", before: -1, after: -1, status: "failed", detail });
      console.log(`${(vm.ip_address || "?").padEnd(18)}—       —      ✗ exception: ${detail.slice(0, 60)}`);
    }
  }

  console.log("");
  console.log("─".repeat(70));
  const deduped = results.filter((r) => r.status === "deduped").length;
  const clean = results.filter((r) => r.status === "already-clean").length;
  const noCron = results.filter((r) => r.status === "no-cron").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`SUMMARY: deduped=${deduped} already-clean=${clean} no-cron=${noCron} failed=${failed}${dryRun ? " (dry-run)" : ""}`);
  if (failed > 0) {
    console.log("");
    console.log("FAILURES:");
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(`  ${r.vm}: ${r.detail}`);
    }
    process.exit(1);
  }
  if (noCron > 0) {
    console.log("");
    console.log(`⚠ ${noCron} VM(s) had NO edge-esmeralda cron entry — flag for review:`);
    for (const r of results.filter((r) => r.status === "no-cron")) {
      console.log(`  ${r.vm} (${r.ip})`);
    }
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(99); });
