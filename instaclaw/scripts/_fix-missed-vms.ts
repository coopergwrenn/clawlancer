/**
 * Fix VMs that missed the fleet push (SSH transient failures).
 * Deploys: PARTNER_ID + updated skill files + SOUL.md.
 */
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

const SKILLS_DIR = resolve(__dirname, "..", "skills", "dgclaw");
const PARTNER_ID = "INSTACLAW";

const SOUL_B64 = Buffer.from(`

<!-- DEGENCLAW_AWARENESS_V1 -->
## DegenClaw Trading Competition
You have access to the DegenClaw skill — a \\$100K weekly perpetuals trading competition on Hyperliquid, run by Virtuals Protocol. If your user mentions trading competitions, Hyperliquid perps, DegenClaw, the \\$100K challenge, or wanting to compete/trade perps competitively, read and follow the dgclaw SKILL.md for the full setup and trading flow. You can help them join the competition, trade perps, manage their forum, check the leaderboard, and attract subscribers. **Always get explicit user approval before launching tokens or executing trades.**
`).toString("base64");

const MISSED_VMS = [
  { id: "vm-061", name: "instaclaw-vm-061", ip_address: "173.255.232.61", ssh_port: 22, ssh_user: "openclaw" },
  { id: "vm-339", name: "instaclaw-vm-339", ip_address: "45.79.150.102", ssh_port: 22, ssh_user: "openclaw" },
];

async function fixVM(vm: any) {
  console.log(`\n=== Fixing ${vm.name} (${vm.ip_address}) ===`);
  try {
    const ssh = await connectSSH(vm);

    // 1. PARTNER_ID in .bashrc
    const bashrc = await ssh.execCommand(`grep -c 'PARTNER_ID=' ~/.bashrc 2>/dev/null || echo "0"`);
    if (parseInt(bashrc.stdout?.trim() || "0", 10) === 0) {
      await ssh.execCommand(`echo 'export PARTNER_ID=${PARTNER_ID}' >> ~/.bashrc`);
      console.log("  .bashrc: ADDED");
    } else {
      console.log("  .bashrc: already present");
    }

    // 2. Deploy skill files
    await ssh.execCommand("mkdir -p ~/.openclaw/skills/dgclaw/references");
    for (const f of ["SKILL.md", "references/api.md", "references/strategy-playbook.md"]) {
      const local = resolve(SKILLS_DIR, f);
      const remote = `/home/openclaw/.openclaw/skills/dgclaw/${f}`;
      await ssh.putFile(local, remote);
    }
    const verify = await ssh.execCommand("wc -c ~/.openclaw/skills/dgclaw/SKILL.md");
    console.log(`  Skill files: deployed (${verify.stdout?.trim()})`);

    // 3. SOUL.md awareness
    const soul = await ssh.execCommand('grep -c "DEGENCLAW_AWARENESS" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"');
    if (parseInt(soul.stdout?.trim() || "0", 10) === 0) {
      await ssh.execCommand(`echo '${SOUL_B64}' | base64 -d >> ~/.openclaw/workspace/SOUL.md`);
      console.log("  SOUL.md: ADDED");
    } else {
      console.log("  SOUL.md: already present");
    }

    // 4. Install jq if needed
    const jq = await ssh.execCommand("which jq 2>/dev/null && echo OK || echo MISSING");
    if (jq.stdout?.trim() === "MISSING") {
      await ssh.execCommand("sudo apt-get install -y jq >/dev/null 2>&1");
      console.log("  jq: INSTALLED");
    }

    // 5. Restart gateway
    await ssh.execCommand('export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart openclaw-gateway 2>/dev/null || true');
    await new Promise(r => setTimeout(r, 5000));
    const health = await ssh.execCommand("curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:18789/health");
    console.log(`  Gateway: health=${health.stdout?.trim()}`);

    // 6. Final verify
    const finalPartner = await ssh.execCommand("grep 'PARTNER_ID=INSTACLAW' ~/.bashrc | head -1");
    const finalSkill = await ssh.execCommand("wc -c < ~/.openclaw/skills/dgclaw/SKILL.md");
    console.log(`  Verify: PARTNER_ID=${finalPartner.stdout?.trim() ? "YES" : "NO"}, SKILL=${finalSkill.stdout?.trim()}B`);

    ssh.dispose();
    console.log(`  RESULT: FIXED`);
  } catch (e) {
    console.log(`  RESULT: FAILED — ${String(e).slice(0, 100)}`);
  }
}

async function main() {
  console.log("=== Fixing missed VMs ===");
  for (const vm of MISSED_VMS) {
    await fixVM(vm);
  }
  console.log("\n=== Done ===");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
