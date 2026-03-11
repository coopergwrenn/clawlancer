/**
 * Fleet-patch: install web3.py on all active assigned VMs.
 * Required by agentbook-check.py for on-chain AgentBook lookups.
 *
 * Usage:
 *   npx tsx instaclaw/scripts/_fleet-patch-web3py.ts --dry-run
 *   npx tsx instaclaw/scripts/_fleet-patch-web3py.ts --canary   (first 2 VMs)
 *   npx tsx instaclaw/scripts/_fleet-patch-web3py.ts --all
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local") });
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const mode = process.argv[2] ?? "--dry-run";

async function main() {
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, assigned_to")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .order("name");

  if (!vms || vms.length === 0) {
    console.log("No active assigned VMs found.");
    return;
  }

  const targets = mode === "--canary" ? vms.slice(0, 2) : vms;
  console.log(`Mode: ${mode} | Targets: ${targets.length} of ${vms.length} VMs\n`);

  if (mode === "--dry-run") {
    for (const vm of targets) {
      console.log(`  [DRY-RUN] ${vm.name} (${vm.ip_address})`);
    }
    console.log(`\nDry run complete. Run with --canary or --all to apply.`);
    return;
  }

  let success = 0;
  let failed = 0;

  for (const vm of targets) {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: vm.ip_address,
        port: vm.ssh_port ?? 22,
        username: vm.ssh_user ?? "openclaw",
        privateKey: sshKey,
        readyTimeout: 15000,
      });

      // Bootstrap pip if missing, then install web3
      const result = await ssh.execCommand(
        'python3 -m pip --version >/dev/null 2>&1 || curl -sS https://bootstrap.pypa.io/get-pip.py | python3 - --break-system-packages --quiet 2>/dev/null; ' +
        'python3 -m pip install --quiet --break-system-packages web3 2>&1 | tail -3'
      );

      // Verify import works
      const verify = await ssh.execCommand('python3 -c "from web3 import Web3; print(Web3)" 2>&1');
      const ok = verify.stdout.includes("Web3");

      if (ok) {
        console.log(`  [OK] ${vm.name} — web3 installed`);
        success++;
      } else {
        console.log(`  [FAIL] ${vm.name} — import test failed: ${verify.stderr || verify.stdout}`);
        failed++;
      }
    } catch (err) {
      console.log(`  [FAIL] ${vm.name} — SSH error: ${String(err).slice(0, 100)}`);
      failed++;
    } finally {
      ssh.dispose();
    }
  }

  console.log(`\nDone: ${success} OK, ${failed} failed out of ${targets.length}`);
}

main().catch(console.error);
