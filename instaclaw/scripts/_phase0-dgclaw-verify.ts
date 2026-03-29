/**
 * Phase 0 post-fleet-push verification: spot-check random VMs for dgclaw deployment.
 * Also finds any VMs that are missing files and retries them.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

for (const f of [".env.ssh-key", ".env.local", ".env.local.full"]) {
  try {
    const c = readFileSync(resolve(".", f), "utf-8");
    for (const l of c.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m) {
        const k = m[1].trim();
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    }
  } catch {}
}

import { connectSSH } from "../lib/ssh";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const FIX = process.argv.includes("--fix");
const SKILLS_DIR = resolve(__dirname, "..", "skills", "dgclaw");

const SOUL_B64 = Buffer.from(`

<!-- DEGENCLAW_AWARENESS_V1 -->
## DegenClaw Trading Competition
You have access to the DegenClaw skill — a \\$100K weekly perpetuals trading competition on Hyperliquid, run by Virtuals Protocol. If your user mentions trading competitions, Hyperliquid perps, DegenClaw, the \\$100K challenge, or wanting to compete/trade perps competitively, read and follow the dgclaw SKILL.md for the full setup and trading flow. You can help them join the competition, trade perps, manage their forum, check the leaderboard, and attract subscribers. **Always get explicit user approval before launching tokens or executing trades.**
`).toString("base64");

async function checkVM(vm: any): Promise<{ vm: string; ip: string; issues: string[]; fixed: string[] }> {
  const issues: string[] = [];
  const fixed: string[] = [];
  try {
    const ssh = await connectSSH(vm);

    // Check SKILL.md
    const skill = await ssh.execCommand("wc -c < ~/.openclaw/skills/dgclaw/SKILL.md 2>/dev/null || echo 0");
    const skillBytes = parseInt(skill.stdout?.trim() || "0", 10);
    if (skillBytes < 1000) {
      issues.push(`SKILL.md missing or truncated (${skillBytes} bytes)`);
      if (FIX) {
        await ssh.execCommand("mkdir -p ~/.openclaw/skills/dgclaw/references");
        await ssh.putFile(resolve(SKILLS_DIR, "SKILL.md"), "/home/openclaw/.openclaw/skills/dgclaw/SKILL.md");
        fixed.push("SKILL.md");
      }
    }

    // Check api.md
    const api = await ssh.execCommand("wc -c < ~/.openclaw/skills/dgclaw/references/api.md 2>/dev/null || echo 0");
    if (parseInt(api.stdout?.trim() || "0", 10) < 100) {
      issues.push("api.md missing");
      if (FIX) {
        await ssh.putFile(resolve(SKILLS_DIR, "references/api.md"), "/home/openclaw/.openclaw/skills/dgclaw/references/api.md");
        fixed.push("api.md");
      }
    }

    // Check strategy-playbook.md
    const strat = await ssh.execCommand("wc -c < ~/.openclaw/skills/dgclaw/references/strategy-playbook.md 2>/dev/null || echo 0");
    if (parseInt(strat.stdout?.trim() || "0", 10) < 1000) {
      issues.push("strategy-playbook.md missing");
      if (FIX) {
        await ssh.putFile(resolve(SKILLS_DIR, "references/strategy-playbook.md"), "/home/openclaw/.openclaw/skills/dgclaw/references/strategy-playbook.md");
        fixed.push("strategy-playbook.md");
      }
    }

    // Check SOUL.md awareness
    const soul = await ssh.execCommand('grep -c "DEGENCLAW_AWARENESS" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo 0');
    if (parseInt(soul.stdout?.trim() || "0", 10) === 0) {
      issues.push("SOUL.md awareness missing");
      if (FIX) {
        await ssh.execCommand(`echo '${SOUL_B64}' | base64 -d >> ~/.openclaw/workspace/SOUL.md`);
        fixed.push("SOUL.md");
      }
    }

    // Check jq
    const jq = await ssh.execCommand("which jq 2>/dev/null && echo OK || echo MISSING");
    if (jq.stdout?.trim() === "MISSING") {
      issues.push("jq not installed");
      if (FIX) {
        await ssh.execCommand("sudo apt-get install -y jq >/dev/null 2>&1");
        fixed.push("jq");
      }
    }

    // Check gateway health
    const health = await ssh.execCommand("curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:18789/health");
    const code = health.stdout?.trim();
    if (code !== "200") {
      issues.push(`gateway health=${code}`);
      if (FIX && fixed.length > 0) {
        // Only restart if we fixed something
        await ssh.execCommand('export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart openclaw-gateway');
        fixed.push("gateway-restarted");
      }
    }

    ssh.dispose();
  } catch (e) {
    issues.push(`SSH error: ${String(e).slice(0, 80)}`);
  }
  return { vm: vm.name, ip: vm.ip_address, issues, fixed };
}

async function main() {
  console.log(`=== DegenClaw Fleet Verification${FIX ? " + FIX" : ""} ===\n`);

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, assigned_to, health_status")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .not("ip_address", "is", null)
    .order("name");

  if (!vms?.length) { console.log("No VMs found."); return; }
  console.log(`Checking ${vms.length} assigned VMs (8 concurrent)...\n`);

  const results: Awaited<ReturnType<typeof checkVM>>[] = [];
  for (let i = 0; i < vms.length; i += 8) {
    const batch = vms.slice(i, i + 8);
    const batchResults = await Promise.all(batch.map(checkVM));
    results.push(...batchResults);
    for (const r of batchResults) {
      if (r.issues.length === 0) {
        // clean VM, don't spam output
      } else {
        console.log(`  [!] ${r.vm} (${r.ip}): ${r.issues.join(", ")}${r.fixed.length ? ` → FIXED: ${r.fixed.join(", ")}` : ""}`);
      }
    }
  }

  const clean = results.filter(r => r.issues.length === 0).length;
  const withIssues = results.filter(r => r.issues.length > 0);
  const fixedCount = results.filter(r => r.fixed.length > 0).length;

  console.log(`\n=== SUMMARY ===`);
  console.log(`  Clean: ${clean}/${vms.length}`);
  console.log(`  Issues: ${withIssues.length}`);
  if (FIX) console.log(`  Fixed: ${fixedCount}`);

  if (withIssues.length > 0 && !FIX) {
    console.log(`\nRun with --fix to repair issues.`);
  }

  // Categorize issues
  const issueCounts: Record<string, number> = {};
  for (const r of withIssues) {
    for (const iss of r.issues) {
      const key = iss.replace(/\d+/g, "N").replace(/\(.*\)/, "");
      issueCounts[key] = (issueCounts[key] || 0) + 1;
    }
  }
  if (Object.keys(issueCounts).length > 0) {
    console.log(`\nIssue breakdown:`);
    for (const [k, v] of Object.entries(issueCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v}x ${k}`);
    }
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
