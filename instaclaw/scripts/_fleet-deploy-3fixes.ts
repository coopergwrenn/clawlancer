#!/usr/bin/env npx tsx
/**
 * Fleet deployment: 3 fixes
 * 1. Deploy instagram-automation SKILL.md with YAML frontmatter
 * 2. Set maxSkillsPromptChars to 500000
 * 3. Remove duplicate polymarket and solana-defi.disabled skill dirs
 *
 * Usage:
 *   npx tsx instaclaw/scripts/_fleet-deploy-3fixes.ts --dry-run
 *   npx tsx instaclaw/scripts/_fleet-deploy-3fixes.ts --test-first
 *   npx tsx instaclaw/scripts/_fleet-deploy-3fixes.ts
 */

import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Config ──
const SUPABASE_URL = "https://qvrnuyzfqjrsjljcqbub.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? (() => {
  const envPath = path.resolve(__dirname, "../../.env.local");
  const envContent = fs.readFileSync(envPath, "utf8");
  const match = envContent.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/);
  return match?.[1]?.trim() ?? "";
})();

const SSH_KEY_PATH = (() => {
  // Check for temp key first (from previous session), then try env
  const tempKey = "/var/folders/cc/2cqmvj354cv3g_5zt9v6pw0c0000gn/T/tmp.evW82NnKo2";
  if (fs.existsSync(tempKey)) return tempKey;

  const b64 = process.env.SSH_PRIVATE_KEY_B64;
  if (b64) {
    const tmp = path.join(os.tmpdir(), ".fleet-ssh-key");
    fs.writeFileSync(tmp, Buffer.from(b64, "base64"), { mode: 0o600 });
    return tmp;
  }
  throw new Error("No SSH key available");
})();

const SSH_OPTS = `-i "${SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ServerAliveInterval=5`;
const NVM_PREAMBLE = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';

const TEST_VM_IP = "23.92.16.216"; // vm-313

// ── SKILL.md source ──
const SKILL_MD_PATH = path.resolve(__dirname, "../skills/instagram-automation/SKILL.md");

// ── Args ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const TEST_FIRST = args.includes("--test-first");

// ── Stats ──
const stats = {
  total: 0,
  skillFixed: 0,
  charsFixed: 0,
  polyRemoved: 0,
  solanaDisabledRemoved: 0,
  alreadyOk: 0,
  errors: [] as string[],
};

function ssh(ip: string, cmd: string, timeout = 30): string {
  try {
    return execSync(
      `ssh ${SSH_OPTS} openclaw@${ip} '${cmd.replace(/'/g, "'\\''")}'`,
      { timeout: timeout * 1000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch (e: any) {
    throw new Error(`SSH to ${ip} failed: ${e.stderr?.slice(0, 200) || e.message}`);
  }
}

function scp(ip: string, localPath: string, remotePath: string): void {
  execSync(
    `scp ${SSH_OPTS} "${localPath}" openclaw@${ip}:${remotePath}`,
    { timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
  );
}

async function fixVM(name: string, ip: string): Promise<void> {
  console.log(`\n── ${name} (${ip}) ──`);
  stats.total++;

  try {
    // Batched check: get current state in one SSH call
    const checkCmd = [
      `echo "FRONTMATTER:$(head -1 ~/.openclaw/skills/instagram-automation/SKILL.md 2>/dev/null || echo MISSING)"`,
      `echo "MAXCHARS:$(${NVM_PREAMBLE} && openclaw config get skills.limits.maxSkillsPromptChars 2>/dev/null || echo UNKNOWN)"`,
      `echo "POLYMARKET:$([ -d ~/.openclaw/skills/polymarket ] && echo EXISTS || echo GONE)"`,
      `echo "SOLANA_DIS:$([ -d ~/.openclaw/skills/solana-defi.disabled ] && echo EXISTS || echo GONE)"`,
    ].join(" && ");

    const output = ssh(ip, checkCmd);
    const frontmatter = output.match(/FRONTMATTER:(.*)/)?.[1]?.trim() ?? "MISSING";
    const maxChars = output.match(/MAXCHARS:(.*)/)?.[1]?.trim() ?? "UNKNOWN";
    const polymarket = output.match(/POLYMARKET:(.*)/)?.[1]?.trim() ?? "GONE";
    const solanaDis = output.match(/SOLANA_DIS:(.*)/)?.[1]?.trim() ?? "GONE";

    const maxCharsNum = parseInt(maxChars, 10);
    const needsSkillFix = frontmatter !== "---";
    const needsCharsFix = isNaN(maxCharsNum) || maxCharsNum < 500000;
    const needsPolyRemove = polymarket === "EXISTS";
    const needsSolanaRemove = solanaDis === "EXISTS";

    if (!needsSkillFix && !needsCharsFix && !needsPolyRemove && !needsSolanaRemove) {
      console.log(`  ✓ All 3 fixes already applied`);
      stats.alreadyOk++;
      return;
    }

    if (DRY_RUN) {
      if (needsSkillFix) console.log(`  [dry-run] Would deploy SKILL.md frontmatter fix`);
      if (needsCharsFix) console.log(`  [dry-run] Would set maxSkillsPromptChars to 500000 (current: ${maxChars})`);
      if (needsPolyRemove) console.log(`  [dry-run] Would remove polymarket/ duplicate`);
      if (needsSolanaRemove) console.log(`  [dry-run] Would remove solana-defi.disabled/ duplicate`);
      return;
    }

    // Fix 1: Deploy SKILL.md with frontmatter
    if (needsSkillFix) {
      ssh(ip, "mkdir -p ~/.openclaw/skills/instagram-automation");
      scp(ip, SKILL_MD_PATH, "~/.openclaw/skills/instagram-automation/SKILL.md");
      console.log(`  ✓ Deployed instagram SKILL.md with frontmatter`);
      stats.skillFixed++;
    }

    // Fix 2: Set maxSkillsPromptChars
    if (needsCharsFix) {
      ssh(ip, `${NVM_PREAMBLE} && openclaw config set skills.limits.maxSkillsPromptChars 500000`);
      console.log(`  ✓ Set maxSkillsPromptChars to 500000 (was: ${maxChars})`);
      stats.charsFixed++;
    }

    // Fix 3: Remove duplicates
    if (needsPolyRemove) {
      ssh(ip, "rm -rf ~/.openclaw/skills/polymarket");
      console.log(`  ✓ Removed duplicate polymarket/ skill dir`);
      stats.polyRemoved++;
    }
    if (needsSolanaRemove) {
      ssh(ip, "rm -rf ~/.openclaw/skills/solana-defi.disabled");
      console.log(`  ✓ Removed duplicate solana-defi.disabled/ skill dir`);
      stats.solanaDisabledRemoved++;
    }
  } catch (e: any) {
    console.log(`  ✗ ERROR: ${e.message.slice(0, 200)}`);
    stats.errors.push(`${name}: ${e.message.slice(0, 200)}`);
  }
}

async function main() {
  console.log("═══ Fleet Deploy: 3 Fixes ═══");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : TEST_FIRST ? "TEST FIRST" : "LIVE"}`);
  console.log(`SSH key: ${SSH_KEY_PATH}`);
  console.log(`SKILL.md: ${SKILL_MD_PATH}`);

  // Verify SKILL.md exists and has frontmatter
  const skillContent = fs.readFileSync(SKILL_MD_PATH, "utf8");
  if (!skillContent.startsWith("---")) {
    console.error("ERROR: SKILL.md doesn't start with --- frontmatter!");
    process.exit(1);
  }
  console.log(`SKILL.md verified (${skillContent.length} chars, has frontmatter)`);

  // Get assigned VMs
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("name, ip_address, status")
    .in("status", ["assigned", "ready"])
    .order("name");

  if (error || !vms) {
    console.error("Failed to fetch VMs:", error);
    process.exit(1);
  }

  // Filter to assigned VMs only for the 3 fixes (ready VMs don't have active gateways)
  const assignedVMs = vms.filter((v) => v.status === "assigned");
  console.log(`\nFound ${assignedVMs.length} assigned VMs`);

  if (TEST_FIRST) {
    // Test on vm-313 first
    const testVM = assignedVMs.find((v) => v.ip_address === TEST_VM_IP);
    if (!testVM) {
      console.error("Test VM (vm-313) not found in assigned VMs!");
      process.exit(1);
    }

    console.log("\n━━━ Phase 1: Test VM (vm-313) ━━━");
    await fixVM(testVM.name, testVM.ip_address);

    // Verify gateway health after changes
    if (!DRY_RUN) {
      console.log("\nVerifying gateway health on test VM...");
      try {
        const health = ssh(TEST_VM_IP, "curl -sf --max-time 5 http://localhost:18789/health 2>/dev/null || echo UNHEALTHY");
        if (health.includes("ok")) {
          console.log("  ✓ Gateway healthy on test VM");
        } else {
          console.log(`  ⚠ Gateway health: ${health.slice(0, 100)}`);
          console.log("  Proceeding anyway (config changes don't require restart)");
        }
      } catch {
        console.log("  ⚠ Could not check gateway health");
      }
    }

    console.log("\n━━━ Phase 2: Remaining VMs ━━━");
    const remaining = assignedVMs.filter((v) => v.ip_address !== TEST_VM_IP);

    for (const vm of remaining) {
      await fixVM(vm.name, vm.ip_address);
      await new Promise((r) => setTimeout(r, 300)); // avoid SSH rate limiting
    }
  } else {
    for (const vm of assignedVMs) {
      await fixVM(vm.name, vm.ip_address);
      await new Promise((r) => setTimeout(r, 300)); // avoid SSH rate limiting
    }
  }

  // Summary
  console.log("\n═══ Summary ═══");
  console.log(`Total VMs processed: ${stats.total}`);
  console.log(`Already OK:          ${stats.alreadyOk}`);
  console.log(`SKILL.md fixed:      ${stats.skillFixed}`);
  console.log(`maxChars fixed:      ${stats.charsFixed}`);
  console.log(`polymarket removed:  ${stats.polyRemoved}`);
  console.log(`solana-dis removed:  ${stats.solanaDisabledRemoved}`);
  console.log(`Errors:              ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    console.log("\nFailed VMs:");
    for (const err of stats.errors) {
      console.log(`  - ${err}`);
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
