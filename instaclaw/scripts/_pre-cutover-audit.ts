/**
 * Pre-cutover audit — read-only verification that every edge_city VM
 * is ready for the privacy-bridge cutover.
 *
 * NO WRITES anywhere. For each VM, checks 9 invariants and prints a
 * green/yellow/red status. Final summary lists any VMs that should
 * NOT be cut over yet.
 *
 * Usage:  tsx scripts/_pre-cutover-audit.ts
 *
 * Per Cooper's directive 2026-05-12: never run cutover without this audit
 * passing green on every VM. ANY red on ANY VM = STOP + report.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { connectSSH } from "../lib/ssh";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.ssh-key") });

const BRIDGE_PATH = "/home/openclaw/.openclaw/scripts/privacy-bridge.sh";
const BYPASS_PATTERN = /bypass/i;

interface VmRow {
  id: string;
  name: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  partner: string | null;
  health_status: string | null;
}

interface AuditResult {
  vm: string;
  ip: string | null;
  // Per-check status
  ssh_reachable: boolean;
  bridge_sha_match: boolean | null;
  bridge_sha_on_disk: string | null;
  bridge_chattr_i: boolean | null;
  lsattr_present: boolean | null;
  bypass_present: boolean | null;
  bypass_unwrapped: boolean | null;
  gateway_active: boolean | null;
  no_leftover_backup: boolean | null;
  privacy_off: boolean | null; // user's privacy_mode_until must be NULL
  // Key inventory
  keys_total: number;
  keys_wrapped: number;
  keys_unwrapped: number;
  bypass_keys: number;
  // Aggregate
  green: boolean;
  notes: string[];
}

function readyToCutover(r: AuditResult): boolean {
  return (
    r.ssh_reachable &&
    r.bridge_sha_match === true &&
    r.bridge_chattr_i === true &&
    r.lsattr_present === true &&
    r.bypass_present === true &&
    r.bypass_unwrapped === true &&
    r.gateway_active === true &&
    r.no_leftover_backup === true &&
    r.privacy_off === true
  );
}

async function auditOne(vm: VmRow, expectedBridgeSha: string, sb: ReturnType<typeof createClient>): Promise<AuditResult> {
  const r: AuditResult = {
    vm: vm.name,
    ip: vm.ip_address,
    ssh_reachable: false,
    bridge_sha_match: null,
    bridge_sha_on_disk: null,
    bridge_chattr_i: null,
    lsattr_present: null,
    bypass_present: null,
    bypass_unwrapped: null,
    gateway_active: null,
    no_leftover_backup: null,
    privacy_off: null,
    keys_total: 0,
    keys_wrapped: 0,
    keys_unwrapped: 0,
    bypass_keys: 0,
    green: false,
    notes: [],
  };

  // ── Pre-flight privacy-state check (DB only, no SSH needed) ──
  // The cutover script's revert path uses `cp` which isn't in the
  // tightened bridge allowlist. If privacy is ON during cutover and
  // verify fails, the script can't revert. Refuse cutover for any VM
  // whose assigned user has privacy_mode_until in the future.
  if (!(vm as { assigned_to?: string }).assigned_to) {
    r.privacy_off = true; // unassigned VM, no user, no privacy
  } else {
    const { data: user } = await sb
      .from("instaclaw_users")
      .select("privacy_mode_until")
      .eq("id", (vm as { assigned_to: string }).assigned_to)
      .single();
    const until = (user as { privacy_mode_until: string | null } | null)?.privacy_mode_until;
    if (!until) {
      r.privacy_off = true;
    } else {
      const isActive = new Date(until).getTime() > Date.now();
      r.privacy_off = !isActive;
      if (isActive) {
        r.notes.push(`PRIVACY MODE ACTIVE for assigned user until ${until} — cutover revert path would be blocked. WAIT for privacy to expire or use admin-override.`);
      }
    }
  }

  if (!vm.ip_address) {
    r.notes.push("no ip_address in DB");
    return r;
  }

  let ssh;
  try {
    ssh = await connectSSH(vm);
    r.ssh_reachable = true;
  } catch (e) {
    r.notes.push(`SSH connect failed: ${e instanceof Error ? e.message : String(e)}`);
    return r;
  }

  try {
    // 1. Bridge SHA (file exists + content matches)
    const shaRes = await ssh.execCommand(
      `[ -f ${BRIDGE_PATH} ] && sha256sum ${BRIDGE_PATH} | awk '{print $1}' || echo MISSING`
    );
    const sha = (shaRes.stdout || "").trim();
    r.bridge_sha_on_disk = sha;
    if (sha === "MISSING") {
      r.bridge_sha_match = false;
      r.notes.push(`bridge file MISSING at ${BRIDGE_PATH} (reconciler hasn't pushed it yet)`);
    } else {
      r.bridge_sha_match = sha === expectedBridgeSha;
      if (!r.bridge_sha_match) {
        r.notes.push(`bridge SHA mismatch: expected ${expectedBridgeSha.slice(0, 12)} got ${sha.slice(0, 12)} (old bridge — reconciler hasn't picked up new code yet)`);
      }
    }

    // 2. lsattr binary present (the bridge stage-1 check uses it)
    const lsattrCheck = await ssh.execCommand(`command -v lsattr >/dev/null && echo OK || echo MISSING`);
    r.lsattr_present = (lsattrCheck.stdout || "").trim() === "OK";
    if (!r.lsattr_present) {
      r.notes.push("lsattr binary MISSING — bridge stage-1 check will panic-block every SSH after cutover");
    }

    // 3. Bridge chattr +i (only meaningful if file exists)
    if (sha !== "MISSING") {
      const lsattrRes = await ssh.execCommand(`lsattr -- ${BRIDGE_PATH} 2>&1 | awk '{print $1}'`);
      const attrs = (lsattrRes.stdout || "").trim();
      r.bridge_chattr_i = /i/.test(attrs);
      if (!r.bridge_chattr_i) {
        r.notes.push(`bridge missing chattr +i (attrs=${attrs}) — stage-1 self-integrity will panic post-cutover`);
      }
    }

    // 4. authorized_keys read + parse
    const akRes = await ssh.execCommand("cat ~/.ssh/authorized_keys");
    if (akRes.code !== 0) {
      r.notes.push(`authorized_keys read failed: ${akRes.stderr}`);
      return r;
    }
    const lines = akRes.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const keyLines = lines.filter((l) => /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-)/.test(l) || /command=.*?(ssh-rsa|ssh-ed25519|ecdsa-sha2-)/.test(l));
    r.keys_total = keyLines.length;
    r.keys_wrapped = keyLines.filter((l) => l.startsWith("command=")).length;
    r.keys_unwrapped = r.keys_total - r.keys_wrapped;
    const bypassLines = keyLines.filter((l) => BYPASS_PATTERN.test(l));
    r.bypass_keys = bypassLines.length;
    r.bypass_present = bypassLines.length > 0;
    // bypass unwrapped: at least one bypass line that doesn't have command= prefix
    r.bypass_unwrapped = bypassLines.some((l) => !l.startsWith("command="));
    if (!r.bypass_present) {
      r.notes.push("BYPASS KEY MISSING — cutover would wrap all keys with no escape hatch");
    } else if (!r.bypass_unwrapped) {
      r.notes.push("bypass key is WRAPPED (has command=) — bypass would not function as escape hatch");
    }

    // 5. Gateway active
    const gwRes = await ssh.execCommand("systemctl --user is-active openclaw-gateway 2>&1");
    const gwOut = (gwRes.stdout || "").trim();
    r.gateway_active = gwOut === "active";
    if (!r.gateway_active) {
      r.notes.push(`gateway is "${gwOut}" — cutover's verify step will fail and revert`);
    }

    // 6. Leftover backup from a prior cutover attempt
    const bakRes = await ssh.execCommand(`[ -f ~/.ssh/authorized_keys.bak.privacy-cutover ] && echo PRESENT || echo NONE`);
    const bakOut = (bakRes.stdout || "").trim();
    r.no_leftover_backup = bakOut === "NONE";
    if (!r.no_leftover_backup) {
      r.notes.push("authorized_keys.bak.privacy-cutover EXISTS — a prior cutover attempt may have run on this VM; investigate before continuing");
    }
  } finally {
    ssh.dispose();
  }

  r.green = readyToCutover(r);
  return r;
}

async function main() {
  // Compute expected bridge SHA from local checkout (which is what main has).
  const bridgeContent = readFileSync(resolve(__dirname, "..", "lib", "privacy-bridge.sh"), "utf-8");
  const expectedSha = createHash("sha256").update(bridgeContent).digest("hex");
  console.log(`Expected bridge SHA: ${expectedSha}\n`);

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("partner", "edge_city")
    .eq("status", "assigned");
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  if (!vms || vms.length === 0) {
    console.log("no edge_city VMs found");
    return;
  }

  console.log(`Auditing ${vms.length} edge_city VMs sequentially...\n`);

  const results: AuditResult[] = [];
  for (const vm of vms as VmRow[]) {
    process.stdout.write(`  ${vm.name.padEnd(22)} ... `);
    const r = await auditOne(vm, expectedSha, sb);
    results.push(r);
    process.stdout.write(`${r.green ? "GREEN" : "RED"}\n`);
  }

  console.log("\n" + "═".repeat(80));
  console.log("Per-VM detail");
  console.log("═".repeat(80));
  for (const r of results) {
    const status = r.green ? "✅ GREEN" : "❌ RED";
    console.log(`\n${status}  ${r.vm}  (${r.ip ?? "no-ip"})`);
    const flag = (v: boolean | null) => (v === true ? "✓" : v === false ? "✗" : "?");
    console.log(`  ${flag(r.ssh_reachable)} SSH reachable`);
    console.log(`  ${flag(r.bridge_sha_match)} bridge SHA matches main (${r.bridge_sha_on_disk?.slice(0, 12) ?? "?"})`);
    console.log(`  ${flag(r.bridge_chattr_i)} bridge chattr +i set`);
    console.log(`  ${flag(r.lsattr_present)} lsattr binary present`);
    console.log(`  ${flag(r.bypass_present)} bypass key present`);
    console.log(`  ${flag(r.bypass_unwrapped)} bypass key unwrapped`);
    console.log(`  ${flag(r.gateway_active)} gateway active`);
    console.log(`  ${flag(r.no_leftover_backup)} no leftover .bak.privacy-cutover`);
    console.log(`  ${flag(r.privacy_off)} privacy mode OFF (user's privacy_mode_until is null)`);
    console.log(`  keys: ${r.keys_total} total (${r.keys_unwrapped} unwrapped, ${r.keys_wrapped} command=-wrapped, ${r.bypass_keys} marked bypass)`);
    if (r.notes.length > 0) {
      console.log(`  notes:`);
      for (const n of r.notes) console.log(`    - ${n}`);
    }
  }

  console.log("\n" + "═".repeat(80));
  const green = results.filter((r) => r.green);
  const red = results.filter((r) => !r.green);
  console.log(`Summary: ${green.length} green / ${red.length} red / ${results.length} total`);
  if (red.length > 0) {
    console.log("\nDO NOT CUT OVER. Red VMs:");
    for (const r of red) console.log(`  - ${r.vm}: ${r.notes.join("; ")}`);
    process.exit(1);
  } else {
    console.log("\nAll VMs green. Safe to proceed with cutover --test-first instaclaw-vm-050 (and STOP for review).");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
