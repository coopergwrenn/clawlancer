/**
 * Fleet push — deploy Solana DeFi Trading skill files + pip deps to assigned VMs.
 * Does NOT generate wallets — wallets are created when users enable the skill.
 *
 * Usage:
 *   npx tsx scripts/fleet-push-solana-defi-skill.ts --dry-run     # show what would be deployed
 *   npx tsx scripts/fleet-push-solana-defi-skill.ts --canary       # deploy to 5 VMs, pause
 *   npx tsx scripts/fleet-push-solana-defi-skill.ts --all          # deploy to all VMs
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
dotenv.config({ path: path.join(__dirname, '../.env.local') });
dotenv.config({ path: path.join(__dirname, '../.env.ssh-key') });

import { createClient } from "@supabase/supabase-js";
import { connectSSH } from "../lib/ssh";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SKILL_DIR = "~/.openclaw/skills/solana-defi";
const REF_DIR = `${SKILL_DIR}/references`;
const CANARY_COUNT = 5;

// Read all local files
const skillDir = path.join(__dirname, "../skills/solana-defi");
const localFiles: Array<{ name: string; localPath: string; remotePath: string; executable?: boolean }> = [
  { name: "SKILL.md", localPath: path.join(skillDir, "SKILL.md"), remotePath: `${SKILL_DIR}/SKILL.md` },
  { name: "jupiter-api.md", localPath: path.join(skillDir, "references/jupiter-api.md"), remotePath: `${REF_DIR}/jupiter-api.md` },
  { name: "pumpportal-api.md", localPath: path.join(skillDir, "references/pumpportal-api.md"), remotePath: `${REF_DIR}/pumpportal-api.md` },
  { name: "dexscreener-api.md", localPath: path.join(skillDir, "references/dexscreener-api.md"), remotePath: `${REF_DIR}/dexscreener-api.md` },
  { name: "solana-rpc.md", localPath: path.join(skillDir, "references/solana-rpc.md"), remotePath: `${REF_DIR}/solana-rpc.md` },
  { name: "safety-patterns.md", localPath: path.join(skillDir, "references/safety-patterns.md"), remotePath: `${REF_DIR}/safety-patterns.md` },
  { name: "setup-solana-wallet.py", localPath: path.join(skillDir, "scripts/setup-solana-wallet.py"), remotePath: "~/scripts/setup-solana-wallet.py", executable: true },
  { name: "solana-trade.py", localPath: path.join(skillDir, "scripts/solana-trade.py"), remotePath: "~/scripts/solana-trade.py", executable: true },
  { name: "solana-balance.py", localPath: path.join(skillDir, "scripts/solana-balance.py"), remotePath: "~/scripts/solana-balance.py", executable: true },
  { name: "solana-positions.py", localPath: path.join(skillDir, "scripts/solana-positions.py"), remotePath: "~/scripts/solana-positions.py", executable: true },
  { name: "solana-snipe.py", localPath: path.join(skillDir, "scripts/solana-snipe.py"), remotePath: "~/scripts/solana-snipe.py", executable: true },
];

// Read and base64-encode all files
const encodedFiles = localFiles.map((f) => ({
  ...f,
  content: fs.readFileSync(f.localPath, "utf-8"),
  b64: Buffer.from(fs.readFileSync(f.localPath, "utf-8"), "utf-8").toString("base64"),
}));

async function deployToVm(vm: any): Promise<boolean> {
  const label = vm.name?.replace("instaclaw-", "") ?? vm.id;
  try {
    const ssh = await connectSSH(vm);
    try {
      // Create directories (including .disabled for non-enabled VMs)
      await ssh.execCommand(`mkdir -p ${SKILL_DIR}/references ${SKILL_DIR}.disabled/references ~/scripts ~/.openclaw/solana-defi`);

      // Deploy files to both active and .disabled directories
      for (const f of encodedFiles) {
        // Deploy to active dir
        await ssh.execCommand(`echo '${f.b64}' | base64 -d > ${f.remotePath}`);
        // Also deploy to .disabled (for VMs that haven't enabled yet)
        if (f.remotePath.startsWith(SKILL_DIR)) {
          const disabledPath = f.remotePath.replace(SKILL_DIR, `${SKILL_DIR}.disabled`);
          await ssh.execCommand(`echo '${f.b64}' | base64 -d > ${disabledPath}`);
        }
        if (f.executable) {
          await ssh.execCommand(`chmod +x ${f.remotePath}`);
        }
      }

      // Install pip deps
      await ssh.execCommand('python3 -m pip install --quiet --break-system-packages solders base58 httpx 2>/dev/null || true');

      // Verify
      const check = await ssh.execCommand(`test -f ${SKILL_DIR}/SKILL.md && echo "OK" || (test -f ${SKILL_DIR}.disabled/SKILL.md && echo "OK_DISABLED" || echo "FAIL")`);
      const status = check.stdout.trim();
      if (status === "FAIL") {
        console.log(`  [${label}] FAIL — files not found after deploy`);
        return false;
      }
      console.log(`  [${label}] OK (${status === "OK_DISABLED" ? "disabled" : "active"})`);
      return true;
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    console.log(`  [${label}] ERROR: ${String(err).slice(0, 100)}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const canary = args.includes("--canary");
  const all = args.includes("--all");

  if (!dryRun && !canary && !all) {
    console.log("Usage: npx tsx scripts/fleet-push-solana-defi-skill.ts [--dry-run | --canary | --all]");
    process.exit(1);
  }

  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("status", "assigned")
    .order("name");

  if (!vms?.length) { console.log("No assigned VMs found"); return; }

  console.log(`\n=== Fleet push: Solana DeFi Trading skill — ${vms.length} VMs ===`);
  console.log(`Files: ${encodedFiles.length} (${encodedFiles.map(f => f.name).join(", ")})\n`);

  if (dryRun) {
    console.log("DRY RUN — would deploy to:");
    for (const vm of vms) {
      const label = vm.name?.replace("instaclaw-", "") ?? vm.id;
      console.log(`  ${label} (${vm.ip_address})`);
    }
    console.log(`\nTotal: ${vms.length} VMs`);
    return;
  }

  const targets = canary ? vms.slice(0, CANARY_COUNT) : vms;
  console.log(`Deploying to ${targets.length} VMs${canary ? " (canary)" : ""}...\n`);

  let ok = 0, errors = 0;
  for (const vm of targets) {
    const success = await deployToVm(vm);
    if (success) ok++; else errors++;
  }

  console.log(`\n=== Done: ${ok} OK, ${errors} errors ===`);

  if (canary && errors === 0) {
    console.log(`\nCanary passed. Run with --all to deploy to remaining ${vms.length - CANARY_COUNT} VMs.`);
  }
}

main().catch(console.error);
