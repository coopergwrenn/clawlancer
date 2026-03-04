/**
 * _deploy-polygon-rpc-fix.ts
 *
 * 1. Deploy updated Polymarket scripts to vm-050 and David's VM
 * 2. Fleet backfill: set POLYGON_RPC_URL on all active VMs missing it
 *
 * Usage: npx tsx scripts/_deploy-polygon-rpc-fix.ts [--dry-run]
 */
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const privateKey = Buffer.from(
  process.env.SSH_PRIVATE_KEY_B64 as string,
  "base64",
).toString("utf-8");

const DRY_RUN = process.argv.includes("--dry-run");

const POLYMARKET_SCRIPTS = [
  "polymarket-setup-creds.py",
  "polymarket-wallet.py",
  "polymarket-positions.py",
  "polymarket-trade.py",
];

const SCRIPT_LOCAL_DIR = path.join(__dirname, "..", "skills", "polymarket", "scripts");
const SCRIPT_REMOTE_DIR = "/home/openclaw/.openclaw/skills/polymarket/scripts";

// Target VMs for script deployment
const DEPLOY_TARGETS = [
  { name: "vm-050 (Cooper)", ip: "172.239.36.76" },
  { name: "vm-linode-06 (David)", ip: "172.104.27.29" },
];

async function connectVM(ip: string): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: ip,
    username: "openclaw",
    privateKey,
    readyTimeout: 12000,
  });
  return ssh;
}

async function deployScripts(ip: string, name: string): Promise<boolean> {
  console.log(`\n── Deploying Polymarket scripts to ${name} (${ip}) ──`);
  if (DRY_RUN) {
    console.log("  [dry-run] Would deploy 4 scripts");
    return true;
  }

  const ssh = await connectVM(ip);
  try {
    const sftp = await ssh.requestSFTP();
    const writeFile = (remotePath: string, content: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(remotePath);
        stream.on("close", () => resolve());
        stream.on("error", (err: Error) => reject(err));
        stream.write(Buffer.from(content, "utf-8"));
        stream.end();
      });

    await ssh.execCommand(`mkdir -p ${SCRIPT_REMOTE_DIR}`);

    for (const script of POLYMARKET_SCRIPTS) {
      const localPath = path.join(SCRIPT_LOCAL_DIR, script);
      const remotePath = `${SCRIPT_REMOTE_DIR}/${script}`;
      const content = fs.readFileSync(localPath, "utf-8");
      await writeFile(remotePath, content);
      await ssh.execCommand(`chmod +x ${remotePath}`);
      console.log(`  ✓ ${script}`);
    }

    // Verify: run polymarket-setup-creds.py status
    console.log(`  Running polymarket-setup-creds.py status...`);
    const result = await ssh.execCommand(
      `cd /home/openclaw && python3 ${SCRIPT_REMOTE_DIR}/polymarket-setup-creds.py status --json 2>&1`,
    );
    const stdout = result.stdout.trim();
    console.log(`  status output: ${stdout.slice(0, 200)}`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed: ${err}`);
    return false;
  } finally {
    ssh.dispose();
  }
}

async function backfillPolygonRpc(): Promise<void> {
  console.log(`\n── Fleet backfill: POLYGON_RPC_URL ──`);

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, status, region")
    .in("status", ["ready", "active", "assigned"]);

  if (error) {
    console.error("Failed to fetch VMs:", error.message);
    return;
  }

  console.log(`Found ${vms?.length ?? 0} active VMs`);

  let fixed = 0;
  let alreadyOk = 0;
  let failed = 0;

  for (const vm of vms ?? []) {
    const label = vm.name || vm.id;
    if (DRY_RUN) {
      console.log(`  [dry-run] Would check ${label} (${vm.ip_address})`);
      continue;
    }

    try {
      const ssh = await connectVM(vm.ip_address);
      try {
        // Check if POLYGON_RPC_URL already set
        const check = await ssh.execCommand(
          'grep -q "^POLYGON_RPC_URL=" "$HOME/.openclaw/.env" 2>/dev/null && echo PRESENT || echo ABSENT',
        );

        if (check.stdout.trim() === "PRESENT") {
          alreadyOk++;
          continue;
        }

        // Append POLYGON_RPC_URL
        await ssh.execCommand(
          'echo "POLYGON_RPC_URL=https://1rpc.io/matic" >> "$HOME/.openclaw/.env"',
        );
        console.log(`  ✓ ${label} (${vm.ip_address}) — POLYGON_RPC_URL set`);
        fixed++;

        // Also backfill AGENT_REGION if missing and we have region data
        if (vm.region) {
          const regionCheck = await ssh.execCommand(
            'grep -q "^AGENT_REGION=" "$HOME/.openclaw/.env" 2>/dev/null && echo PRESENT || echo ABSENT',
          );
          if (regionCheck.stdout.trim() === "ABSENT") {
            await ssh.execCommand(
              `echo "AGENT_REGION=${vm.region}" >> "$HOME/.openclaw/.env"`,
            );
            console.log(`    + AGENT_REGION=${vm.region}`);
          }
        }
      } finally {
        ssh.dispose();
      }
    } catch (err) {
      console.error(`  ✗ ${label} (${vm.ip_address}) — ${err}`);
      failed++;
    }
  }

  console.log(`\nBackfill complete: ${fixed} fixed, ${alreadyOk} already OK, ${failed} failed`);
}

async function main() {
  if (DRY_RUN) console.log("=== DRY RUN MODE ===\n");

  // 1. Deploy scripts to target VMs
  for (const target of DEPLOY_TARGETS) {
    await deployScripts(target.ip, target.name);
  }

  // 2. Fleet backfill
  await backfillPolygonRpc();

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
