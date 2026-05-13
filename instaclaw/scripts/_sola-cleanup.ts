/**
 * SOLA_AUTH_TOKEN cleanup — remove deprecated env var line from edge VMs.
 *
 * Context: Edge City migrated from Sola (Social Layer) to their own EdgeOS
 * calendar system. The SOLA_AUTH_TOKEN env var is now dead. lib/ssh.ts no
 * longer writes it during configureOpenClaw, but existing VMs may still
 * have `SOLA_AUTH_TOKEN=PLACEHOLDER_WAITING_ON_TULE` (or some value) in
 * their ~/.openclaw/.env from prior provisioning runs.
 *
 * This script: for each edge_city VM, removes any `SOLA_AUTH_TOKEN=`
 * line from ~/.openclaw/.env and verifies the gateway is still healthy
 * afterwards.
 *
 * SSH path: deploy keys go through the privacy bridge (post-cutover).
 * Bridge takes early-exit when privacy_mode_until is null (verified by
 * pre-cutover audit). Commands pass through to bash.
 *
 * sed -i is NOT in the privacy-ON allowlist (it's blocked at SENSITIVE),
 * but under privacy OFF the bridge passes it through. Privacy is OFF on
 * all edge users — confirmed by today's audit.
 *
 * Idempotent: removes ANY line starting with SOLA_AUTH_TOKEN=. If no
 * matching line, the sed is a no-op and the script reports "already clean".
 *
 * Usage: tsx scripts/_sola-cleanup.ts [vm-name | --all] [--dry-run]
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { connectSSH } from "../lib/ssh";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.ssh-key") });

interface VmRow {
  id: string;
  name: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  partner: string | null;
}

interface CleanupResult {
  vm: string;
  status: "already_clean" | "removed" | "failed";
  preLine?: string;
  gatewayActiveAfter?: boolean;
  detail?: string;
}

async function cleanupOne(vm: VmRow, dryRun: boolean): Promise<CleanupResult> {
  if (!vm.ip_address) return { vm: vm.name, status: "failed", detail: "no ip_address" };

  const ssh = await connectSSH(vm);
  try {
    // ── Phase 1: inspect current state ──
    const probe = await ssh.execCommand(
      `grep "^SOLA_AUTH_TOKEN=" ~/.openclaw/.env 2>/dev/null || echo NONE`
    );
    const preLine = (probe.stdout || "").trim();
    if (preLine === "NONE" || preLine === "") {
      return { vm: vm.name, status: "already_clean", preLine: "(no SOLA_AUTH_TOKEN line)" };
    }

    if (dryRun) {
      return { vm: vm.name, status: "removed", preLine, detail: "[dry-run] would remove this line" };
    }

    // ── Phase 2: one-shot remove + verify ──
    // Backup → sed-delete → verify the line is gone → check gateway still active
    const oneShot = `
set -u
ENV=~/.openclaw/.env
BAK=$ENV.bak.sola-cleanup.$$
# Idempotent: if no SOLA line, skip
if ! grep -q '^SOLA_AUTH_TOKEN=' "$ENV"; then
  echo "STATUS=already_clean_at_phase2"
  exit 0
fi
cp -p "$ENV" "$BAK" || { echo "STATUS=backup_failed"; exit 10; }
# Remove ANY SOLA_AUTH_TOKEN= line (idempotent for repeated values)
sed -i '/^SOLA_AUTH_TOKEN=/d' "$ENV" || { echo "STATUS=sed_failed"; cp -p "$BAK" "$ENV"; rm -f "$BAK"; exit 11; }
# Verify the line is gone
if grep -q '^SOLA_AUTH_TOKEN=' "$ENV"; then
  cp -p "$BAK" "$ENV"
  rm -f "$BAK"
  echo "STATUS=verify_failed_line_still_present"
  exit 12
fi
# Verify gateway is still active (sanity check)
GW=$(systemctl --user is-active openclaw-gateway 2>&1)
if [ "$GW" != "active" ]; then
  # Don't roll back — env change shouldn't break gateway, and rolling back
  # might also fail. Report the state.
  echo "STATUS=removed_but_gateway_non_active"
  echo "GATEWAY=$GW"
  rm -f "$BAK"
  exit 13
fi
# Cleanup backup
rm -f "$BAK"
echo "STATUS=removed"
echo "GATEWAY=$GW"
exit 0
`;
    const r = await ssh.execCommand(oneShot);
    const out = r.stdout || "";
    const status = out.match(/^STATUS=(\S+)/m)?.[1];
    const gw = out.match(/^GATEWAY=(\S+)/m)?.[1];

    if (status === "removed" || status === "already_clean_at_phase2") {
      return {
        vm: vm.name,
        status: status === "removed" ? "removed" : "already_clean",
        preLine,
        gatewayActiveAfter: gw === "active",
      };
    }
    return {
      vm: vm.name,
      status: "failed",
      preLine,
      detail: `${status} (exit=${r.code}): ${(out + r.stderr).slice(0, 300)}`,
    };
  } finally {
    ssh.dispose();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const singleVm = args.find((a) => !a.startsWith("--"));

  if (!all && !singleVm) {
    console.error("Usage: tsx scripts/_sola-cleanup.ts <vm-name | --all> [--dry-run]");
    process.exit(1);
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  let vms: VmRow[];
  if (singleVm) {
    const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", singleVm).single();
    if (!vm) { console.error(`VM not found: ${singleVm}`); process.exit(1); }
    if (vm.partner !== "edge_city") {
      console.error(`SAFETY: ${singleVm} partner is "${vm.partner}", not edge_city`);
      process.exit(1);
    }
    vms = [vm as VmRow];
  } else {
    const { data } = await sb.from("instaclaw_vms").select("*").eq("partner", "edge_city").eq("status", "assigned");
    vms = (data ?? []) as VmRow[];
  }

  console.log(`Targets (${vms.length}): ${vms.map(v => v.name).join(", ")}`);
  console.log(`Dry run: ${dryRun}`);
  console.log("");

  const results: CleanupResult[] = [];
  for (const vm of vms) {
    process.stdout.write(`${vm.name.padEnd(22)} ... `);
    try {
      const r = await cleanupOne(vm, dryRun);
      results.push(r);
      const tag = r.status === "removed" ? "✓ REMOVED" : r.status === "already_clean" ? "· clean" : "✗ FAILED";
      console.log(`${tag}${r.preLine ? ` (pre: ${r.preLine.slice(0, 60)})` : ""}${r.gatewayActiveAfter !== undefined ? ` gateway=${r.gatewayActiveAfter ? "active" : "NOT-ACTIVE"}` : ""}`);
      if (r.detail) console.log(`           detail: ${r.detail}`);
    } catch (e) {
      results.push({ vm: vm.name, status: "failed", detail: e instanceof Error ? e.message : String(e) });
      console.log(`✗ EXCEPTION: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\n" + "─".repeat(60));
  const removed = results.filter(r => r.status === "removed").length;
  const clean = results.filter(r => r.status === "already_clean").length;
  const failed = results.filter(r => r.status === "failed").length;
  console.log(`Removed: ${removed}${dryRun ? " (dry-run)" : ""}  Already clean: ${clean}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
