/**
 * Fleet deploy: Push cron-guard.py to all active assigned VMs.
 *
 * For each VM:
 *   1. Copies cron-guard.py to ~/scripts/
 *   2. Adds a cron entry to run every 60 seconds (one-shot mode)
 *   3. Verifies the cron entry is installed
 *
 * Usage:
 *   npx tsx scripts/_fleet-deploy-cron-guard.ts --dry-run
 *   npx tsx scripts/_fleet-deploy-cron-guard.ts --canary
 *   npx tsx scripts/_fleet-deploy-cron-guard.ts --all
 */
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";
import * as path from "path";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const CRON_GUARD_PATH = path.resolve(
  __dirname,
  "../skills/shared/scripts/cron-guard.py"
);
const CRON_ENTRY = "* * * * * python3 ~/scripts/cron-guard.py >> /tmp/cron-guard.log 2>&1";
const CRON_MARKER = "cron-guard.py";

function sshExec(client: Client, cmd: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSH timeout")), timeout);
    client.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let out = "";
      stream.on("data", (d: Buffer) => (out += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (out += d.toString()));
      stream.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
    });
  });
}

function sshWriteFile(
  client: Client,
  remotePath: string,
  content: string,
  timeout = 15000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SFTP timeout")), timeout);
    client.sftp((err, sftp) => {
      if (err) { clearTimeout(timer); return reject(err); }
      const stream = sftp.createWriteStream(remotePath);
      stream.on("close", () => { clearTimeout(timer); sftp.end(); resolve(); });
      stream.on("error", (e: Error) => { clearTimeout(timer); sftp.end(); reject(e); });
      stream.end(content);
    });
  });
}

function connectSSH(
  host: string,
  port: number,
  user: string,
  privateKey: Buffer
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error("SSH connect timeout"));
    }, 10000);

    client.on("ready", () => { clearTimeout(timer); resolve(client); });
    client.on("error", (e) => { clearTimeout(timer); reject(e); });
    client.connect({
      host,
      port,
      username: user,
      privateKey,
      readyTimeout: 10000,
    });
  });
}

async function deployToVM(
  vm: { id: string; name: string; ip_address: string; ssh_port: number; ssh_user: string },
  scriptContent: string,
  privateKey: Buffer
): Promise<{ success: boolean; error?: string }> {
  let client: Client | null = null;
  try {
    client = await connectSSH(vm.ip_address, vm.ssh_port || 22, vm.ssh_user || "claw", privateKey);

    // 1. Ensure ~/scripts/ exists
    await sshExec(client, "mkdir -p ~/scripts");

    // 2. Write cron-guard.py via SFTP
    const homeDir = (await sshExec(client, "echo $HOME")).trim() || "/home/claw";
    await sshWriteFile(client, `${homeDir}/scripts/cron-guard.py`, scriptContent);
    await sshExec(client, "chmod +x ~/scripts/cron-guard.py");

    // 3. Check if cron entry already exists
    const existing = await sshExec(client, `crontab -l 2>/dev/null | grep '${CRON_MARKER}' || true`);
    if (existing.includes(CRON_MARKER)) {
      // Already installed — just update the script
      client.end();
      return { success: true };
    }

    // 4. Add cron entry
    await sshExec(
      client,
      `(crontab -l 2>/dev/null; echo '${CRON_ENTRY}') | crontab -`
    );

    // 5. Verify
    const verify = await sshExec(client, `crontab -l 2>/dev/null | grep '${CRON_MARKER}' || true`);
    client.end();

    if (!verify.includes(CRON_MARKER)) {
      return { success: false, error: "Cron entry not found after install" };
    }

    return { success: true };
  } catch (err) {
    if (client) client.end();
    return { success: false, error: String(err).slice(0, 200) };
  }
}

async function main() {
  const mode = process.argv[2] || "--help";
  if (mode === "--help") {
    console.log("Usage: npx tsx scripts/_fleet-deploy-cron-guard.ts [--dry-run | --canary | --all]");
    process.exit(0);
  }

  // Load SSH key
  let keyB64 = process.env.SSH_PRIVATE_KEY_B64;
  if (!keyB64) {
    const sshEnvPath = path.resolve(__dirname, "../.env.ssh-key");
    if (fs.existsSync(sshEnvPath)) {
      const content = fs.readFileSync(sshEnvPath, "utf-8");
      const match = content.match(/SSH_PRIVATE_KEY_B64=(.+)/);
      if (match) keyB64 = match[1].replace(/['"]/g, "");
    }
  }
  if (!keyB64) {
    console.error("SSH_PRIVATE_KEY_B64 not found in .env.local or .env.ssh-key");
    process.exit(1);
  }
  const privateKey = Buffer.from(keyB64, "base64");

  // Load script content
  if (!fs.existsSync(CRON_GUARD_PATH)) {
    console.error(`Script not found: ${CRON_GUARD_PATH}`);
    process.exit(1);
  }
  const scriptContent = fs.readFileSync(CRON_GUARD_PATH, "utf-8");

  // Fetch VMs
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, assigned_to")
    .eq("status", "assigned")
    .not("gateway_token", "is", null)
    .not("ip_address", "is", null);

  if (error || !vms) {
    console.error("Failed to fetch VMs:", error?.message);
    process.exit(1);
  }

  // Filter to only VMs with assigned users
  const activeVMs = vms.filter((v) => v.assigned_to);
  console.log(`Found ${activeVMs.length} active assigned VMs`);

  if (mode === "--dry-run") {
    console.log("\n=== DRY RUN ===");
    console.log(`Would deploy cron-guard.py to ${activeVMs.length} VMs:`);
    for (const vm of activeVMs) {
      console.log(`  ${vm.name || vm.id} — ${vm.ip_address}`);
    }
    console.log(`\nCron entry: ${CRON_ENTRY}`);
    console.log("\nRun with --canary to deploy to 1 VM first, or --all for full fleet.");
    return;
  }

  const targets = mode === "--canary" ? activeVMs.slice(0, 1) : activeVMs;
  console.log(`\nDeploying to ${targets.length} VM(s)...\n`);

  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ name: string; error: string }> = [];

  // Deploy in batches of 10 for parallel SSH
  const BATCH_SIZE = 10;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (vm) => {
        const result = await deployToVM(vm, scriptContent, privateKey);
        const label = vm.name || vm.id;
        if (result.success) {
          console.log(`  ✓ ${label}`);
          succeeded++;
        } else {
          console.log(`  ✗ ${label}: ${result.error}`);
          failed++;
          failures.push({ name: label, error: result.error || "unknown" });
        }
        return result;
      })
    );
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Succeeded: ${succeeded}/${targets.length}`);
  console.log(`Failed: ${failed}/${targets.length}`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  ${f.name}: ${f.error}`);
    }
  }
}

main().catch(console.error);
