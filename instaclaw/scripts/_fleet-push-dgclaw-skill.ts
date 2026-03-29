/**
 * Fleet push: DegenClaw skill knowledge to all assigned VMs.
 *
 * Deploys SKILL.md + references, appends SOUL.md awareness, installs jq,
 * restarts gateway so OpenClaw loads the new skill.
 *
 * Usage:
 *   npx tsx scripts/_fleet-push-dgclaw-skill.ts --dry-run      # list affected VMs
 *   npx tsx scripts/_fleet-push-dgclaw-skill.ts --test-first    # patch one VM, pause
 *   npx tsx scripts/_fleet-push-dgclaw-skill.ts --all           # full fleet
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

const mode = process.argv.includes("--all") ? "all"
  : process.argv.includes("--test-first") ? "test-first"
  : "dry-run";

const CONCURRENCY = 8;

// Local skill files to deploy
const SKILLS_DIR = resolve(__dirname, "..", "skills", "dgclaw");
const FILES = [
  { local: "SKILL.md", remote: "SKILL.md" },
  { local: "references/api.md", remote: "references/api.md" },
  { local: "references/strategy-playbook.md", remote: "references/strategy-playbook.md" },
];

// Load file contents + base64 encode for SSH transport
const filePayloads = FILES.map(f => {
  const content = readFileSync(resolve(SKILLS_DIR, f.local));
  return { ...f, b64: content.toString("base64"), bytes: content.length };
});

// SOUL.md awareness paragraph
const SOUL_PARAGRAPH = `

<!-- DEGENCLAW_AWARENESS_V1 -->
## DegenClaw Trading Competition
You have access to the DegenClaw skill — a \\$100K weekly perpetuals trading competition on Hyperliquid, run by Virtuals Protocol. If your user mentions trading competitions, Hyperliquid perps, DegenClaw, the \\$100K challenge, or wanting to compete/trade perps competitively, read and follow the dgclaw SKILL.md for the full setup and trading flow. You can help them join the competition, trade perps, manage their forum, check the leaderboard, and attract subscribers. **Always get explicit user approval before launching tokens or executing trades.**
`;
const SOUL_B64 = Buffer.from(SOUL_PARAGRAPH).toString("base64");

interface Result {
  vm: string;
  ip: string;
  ok: boolean;
  skillFiles: number;
  soulUpdated: boolean;
  jqInstalled: boolean;
  gatewayRestarted: boolean;
  error?: string;
}

async function patchVM(vm: any): Promise<Result> {
  const r: Result = {
    vm: vm.name, ip: vm.ip_address, ok: false,
    skillFiles: 0, soulUpdated: false, jqInstalled: false, gatewayRestarted: false,
  };

  try {
    const ssh = await connectSSH(vm);

    // 1. Create skill directories
    await ssh.execCommand("mkdir -p ~/.openclaw/skills/dgclaw/references");

    // 2. Deploy SKILL.md + references via base64 pipe
    for (const f of filePayloads) {
      const remotePath = `~/.openclaw/skills/dgclaw/${f.remote}`;
      const result = await ssh.execCommand(
        `echo '${f.b64}' | base64 -d > ${remotePath} && wc -c < ${remotePath}`
      );
      const bytes = parseInt(result.stdout?.trim() || "0", 10);
      if (bytes > 100) r.skillFiles++;
    }

    if (r.skillFiles < 3) {
      r.error = `Only ${r.skillFiles}/3 files deployed`;
      ssh.dispose();
      return r;
    }

    // 3. Append SOUL.md awareness if not present
    const check = await ssh.execCommand(
      'grep -c "DEGENCLAW_AWARENESS" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"'
    );
    if (parseInt(check.stdout?.trim() || "0", 10) === 0) {
      await ssh.execCommand(`echo '${SOUL_B64}' | base64 -d >> ~/.openclaw/workspace/SOUL.md`);
      r.soulUpdated = true;
    }

    // 4. Install jq if missing
    const jqCheck = await ssh.execCommand("which jq 2>/dev/null && echo HAS_JQ || echo NO_JQ");
    if (jqCheck.stdout?.trim() === "NO_JQ") {
      await ssh.execCommand("sudo apt-get install -y jq >/dev/null 2>&1");
      r.jqInstalled = true;
    }

    // 5. Restart gateway to pick up new skill
    const restart = await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && ' +
      'systemctl --user restart openclaw-gateway 2>&1 && sleep 3 && ' +
      'systemctl --user is-active openclaw-gateway 2>&1'
    );
    r.gatewayRestarted = restart.stdout?.trim() === "active";

    // 6. Health check
    if (r.gatewayRestarted) {
      const health = await ssh.execCommand(
        "curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:18789/health"
      );
      if (health.stdout?.trim() !== "200") {
        r.error = `Gateway active but health=${health.stdout?.trim()}`;
      }
    } else {
      r.error = `Gateway not active after restart: ${restart.stdout?.trim()}`;
    }

    ssh.dispose();
    r.ok = r.skillFiles === 3 && r.gatewayRestarted && !r.error;
    return r;
  } catch (e) {
    r.error = String(e).slice(0, 120);
    return r;
  }
}

async function runBatch(vms: any[]): Promise<Result[]> {
  const results: Result[] = [];
  for (let i = 0; i < vms.length; i += CONCURRENCY) {
    const batch = vms.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(patchVM));
    results.push(...batchResults);
    for (const r of batchResults) {
      const icon = r.ok ? "OK" : "XX";
      console.log(
        `  [${icon}] ${r.vm} (${r.ip}) — files=${r.skillFiles}/3 soul=${r.soulUpdated ? "added" : "exists"} jq=${r.jqInstalled ? "installed" : "ok"} gw=${r.gatewayRestarted ? "active" : "FAIL"}${r.error ? ` ERR: ${r.error}` : ""}`
      );
    }
  }
  return results;
}

async function main() {
  console.log(`=== DegenClaw Skill Fleet Push (${mode.toUpperCase()}) ===\n`);

  // Verify local files
  for (const f of filePayloads) {
    console.log(`  ${f.local}: ${f.bytes} bytes`);
  }

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, assigned_to, health_status")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .not("ip_address", "is", null)
    .order("name");

  if (!vms?.length) { console.log("No assigned VMs found."); return; }
  console.log(`\nFound ${vms.length} assigned VMs.\n`);

  if (mode === "dry-run") {
    for (const vm of vms) console.log(`  ${vm.name} (${vm.ip_address}) [${vm.health_status}]`);
    console.log(`\nWould deploy to ${vms.length} VMs. Run with --test-first to patch one first.`);
    return;
  }

  if (mode === "test-first") {
    const testVm = vms[0];
    console.log(`Testing on ${testVm.name} (${testVm.ip_address})...\n`);
    const [result] = await runBatch([testVm]);

    if (!result.ok) {
      console.error(`\nTest VM FAILED. Fix before running --all.`);
      process.exit(1);
    }
    console.log(`\nTest VM ${testVm.name}: PASS. Run with --all to deploy to remaining ${vms.length - 1} VMs.`);
    return;
  }

  // --all
  console.log(`Deploying to ${vms.length} VMs (${CONCURRENCY} concurrent)...\n`);
  const results = await runBatch(vms);

  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log(`\n=== DONE: ${ok}/${vms.length} succeeded, ${failed.length} failed ===`);
  if (failed.length) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  ${f.vm}: ${f.error}`);
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
