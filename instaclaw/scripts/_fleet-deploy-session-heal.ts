/**
 * Fleet deploy: session-heal-cron.sh
 * Pushes the session corruption auto-heal cron to all assigned VMs.
 *
 * Usage:
 *   npx tsx scripts/_fleet-deploy-session-heal.ts --dry-run
 *   npx tsx scripts/_fleet-deploy-session-heal.ts --test-first
 *   npx tsx scripts/_fleet-deploy-session-heal.ts
 */
import { createClient } from "@supabase/supabase-js";
import { Client } from "ssh2";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const CRON_SCRIPT = fs.readFileSync(
  path.resolve(__dirname, "session-heal-cron.sh"),
  "utf-8",
);

const CRON_ENTRY = "* * * * * /bin/bash /home/openclaw/scripts/session-heal-cron.sh >> /tmp/session-heal-cron.log 2>&1";

function sshExec(client: Client, cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SSH cmd timeout")), 30000);
    client.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timeout); return reject(err); }
      let stdout = "";
      let stderr = "";
      stream.on("data", (d: Buffer) => (stdout += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      stream.on("close", () => { clearTimeout(timeout); resolve({ stdout, stderr }); });
    });
  });
}

async function connectVM(ip: string, port: number, user: string, privateKey: string): Promise<Client> {
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("connect timeout")), 10000);
    client.on("ready", () => { clearTimeout(timeout); resolve(); });
    client.on("error", (e) => { clearTimeout(timeout); reject(e); });
    client.connect({ host: ip, port, username: user, privateKey, readyTimeout: 10000 });
  });
  return client;
}

async function deployToVM(
  vm: { id: string; ip_address: string; ssh_port: number; ssh_user: string; name: string },
  privateKey: string,
  dryRun: boolean,
): Promise<{ success: boolean; message: string }> {
  const label = `${vm.name || vm.id.slice(0, 8)} (${vm.ip_address})`;

  if (dryRun) {
    return { success: true, message: `[DRY-RUN] Would deploy to ${label}` };
  }

  let client: Client | null = null;
  try {
    client = await connectVM(vm.ip_address, vm.ssh_port || 22, vm.ssh_user || "openclaw", privateKey);

    // 1. Ensure ~/scripts/ exists
    await sshExec(client, "mkdir -p ~/scripts");

    // 2. Write the cron script via heredoc
    const escaped = CRON_SCRIPT.replace(/'/g, "'\\''");
    await sshExec(client, `cat > ~/scripts/session-heal-cron.sh << 'HEAL_EOF'\n${CRON_SCRIPT}\nHEAL_EOF`);
    await sshExec(client, "chmod +x ~/scripts/session-heal-cron.sh");

    // 3. Add cron entry if not already present
    const { stdout: existingCron } = await sshExec(client, "crontab -l 2>/dev/null || true");
    if (existingCron.includes("session-heal-cron.sh")) {
      // Already installed, update the script only
      return { success: true, message: `[UPDATED] ${label}: script updated, cron already installed` };
    }

    // Add new cron entry
    const newCron = existingCron.trim()
      ? `${existingCron.trim()}\n${CRON_ENTRY}\n`
      : `${CRON_ENTRY}\n`;
    await sshExec(client, `echo '${newCron.replace(/'/g, "'\\''")}' | crontab -`);

    // 4. Verify
    const { stdout: verifyCron } = await sshExec(client, "crontab -l 2>/dev/null | grep session-heal");
    const { stdout: verifyScript } = await sshExec(client, "test -x ~/scripts/session-heal-cron.sh && echo OK || echo MISSING");

    if (verifyCron.includes("session-heal") && verifyScript.trim() === "OK") {
      return { success: true, message: `[DEPLOYED] ${label}` };
    } else {
      return { success: false, message: `[VERIFY FAIL] ${label}: cron=${!!verifyCron} script=${verifyScript.trim()}` };
    }
  } catch (e: any) {
    return { success: false, message: `[ERROR] ${label}: ${e.message}` };
  } finally {
    try { client?.end(); } catch {}
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const testFirst = args.includes("--test-first");

  const keyB64 = process.env.SSH_PRIVATE_KEY_B64!;
  if (!keyB64) throw new Error("SSH_PRIVATE_KEY_B64 not set");
  const privateKey = Buffer.from(keyB64, "base64").toString("utf-8");

  // Get all assigned VMs
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, health_status")
    .eq("status", "assigned")
    .not("ip_address", "is", null);

  if (!vms || vms.length === 0) {
    console.log("No assigned VMs found");
    return;
  }

  console.log(`${dryRun ? "[DRY-RUN] " : ""}Deploying session-heal cron to ${vms.length} VMs\n`);

  if (testFirst) {
    // Deploy to first VM only, wait for confirmation
    const testVM = vms[0];
    console.log(`Testing on: ${testVM.name || testVM.id} (${testVM.ip_address})`);
    const result = await deployToVM(testVM, privateKey, dryRun);
    console.log(result.message);
    if (!result.success) {
      console.log("\nTest failed, aborting fleet deploy");
      return;
    }
    console.log("\n✓ Test VM deployed successfully. Run without --test-first to deploy to full fleet.");
    return;
  }

  // Deploy in batches of 5
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < vms.length; i += 5) {
    const batch = vms.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((vm) => deployToVM(vm, privateKey, dryRun)),
    );
    for (const r of results) {
      console.log(r.message);
      if (r.success) succeeded++;
      else failed++;
    }
    // Small pause between batches
    if (i + 5 < vms.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone: ${succeeded} succeeded, ${failed} failed out of ${vms.length} VMs`);
}

main().catch(console.error);
