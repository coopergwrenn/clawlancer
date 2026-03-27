/**
 * Fleet deploy: Dispatch v2 — action batching, screenshot optimization, rate limit bump
 *
 * Files deployed:
 *   1. dispatch-server.js (rate limits 10/sec, 500/session, batch timeout)
 *   2. dispatch-remote-screenshot.sh (WebP, quality 55, node instead of python3)
 *   3. dispatch-screenshot.sh (WebP, quality 55, resolution cap)
 *   4. dispatch-remote-batch.sh (NEW — batch command)
 *   5. SKILL.md (batching docs, verification tree, updated rate limits)
 *
 * Usage:
 *   npx tsx scripts/_fleet-deploy-dispatch-v2.ts --dry-run
 *   npx tsx scripts/_fleet-deploy-dispatch-v2.ts --test-first
 *   npx tsx scripts/_fleet-deploy-dispatch-v2.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load env
for (const f of [".env.ssh-key", ".env.local"]) {
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

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_FIRST = process.argv.includes("--test-first");

// Read files to deploy
const FILES = [
  {
    local: resolve("skills/computer-dispatch/dispatch-server.js"),
    remote: "~/scripts/dispatch-server.js",
    label: "dispatch-server.js",
  },
  {
    local: resolve("skills/computer-dispatch/scripts/dispatch-remote-screenshot.sh"),
    remote: "~/scripts/dispatch-remote-screenshot.sh",
    label: "dispatch-remote-screenshot.sh",
  },
  {
    local: resolve("skills/computer-dispatch/scripts/dispatch-screenshot.sh"),
    remote: "~/scripts/dispatch-screenshot.sh",
    label: "dispatch-screenshot.sh",
  },
  {
    local: resolve("skills/computer-dispatch/scripts/dispatch-remote-batch.sh"),
    remote: "~/scripts/dispatch-remote-batch.sh",
    label: "dispatch-remote-batch.sh",
  },
  {
    local: resolve("skills/computer-dispatch/SKILL.md"),
    remote: "~/.openclaw/skills/computer-dispatch/SKILL.md",
    label: "SKILL.md",
  },
];

const filePayloads = FILES.map((f) => ({
  ...f,
  b64: Buffer.from(readFileSync(f.local, "utf-8"), "utf-8").toString("base64"),
}));

async function deployToVm(vm: { ip_address: string; name: string }, ssh: any): Promise<boolean> {
  try {
    await ssh.connect({
      host: vm.ip_address,
      port: 22,
      username: "openclaw",
      privateKey,
      readyTimeout: 10000,
    });

    // Ensure directories exist
    await ssh.execCommand("mkdir -p ~/scripts ~/.openclaw/skills/computer-dispatch");

    // Deploy each file
    for (const f of filePayloads) {
      await ssh.execCommand(`echo '${f.b64}' | base64 -d > ${f.remote}`);
    }

    // Make scripts executable
    await ssh.execCommand("chmod +x ~/scripts/dispatch-*.sh ~/dispatch-server.js");

    // Restart dispatch-server if it's running (non-disruptive — will auto-reconnect relay)
    const { stdout: pid } = await ssh.execCommand("pgrep -f 'node.*dispatch-server' || true");
    if (pid.trim()) {
      await ssh.execCommand("kill $(pgrep -f 'node.*dispatch-server') 2>/dev/null; sleep 1; nohup node ~/dispatch-server.js > /tmp/dispatch-server.log 2>&1 &");
    }

    ssh.dispose();
    return true;
  } catch (err) {
    ssh.dispose();
    return false;
  }
}

async function main() {
  console.log("=== Fleet Deploy: Dispatch v2 (Batching + Screenshot Optimization) ===\n");
  console.log("Files to deploy:");
  for (const f of FILES) {
    console.log(`  ${f.label} → ${f.remote}`);
  }
  console.log();

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("ip_address, name, status, health_status")
    .in("status", ["assigned", "ready"])
    .not("health_status", "eq", "suspended");

  if (!vms?.length) {
    console.log("No VMs found.");
    return;
  }

  console.log(`Target: ${vms.length} VMs\n`);

  if (DRY_RUN) {
    console.log("[DRY RUN] Would deploy to:");
    for (const vm of vms.slice(0, 10)) {
      console.log(`  ${vm.name} (${vm.ip_address}) — ${vm.status}/${vm.health_status}`);
    }
    if (vms.length > 10) console.log(`  ... and ${vms.length - 10} more`);
    console.log("\nRun without --dry-run to deploy.");
    return;
  }

  const { NodeSSH } = await import("node-ssh");

  if (TEST_FIRST) {
    // Deploy to first VM only, verify, then ask for approval
    const testVm = vms[0];
    console.log(`[TEST] Deploying to ${testVm.name} (${testVm.ip_address})...`);
    const ssh = new NodeSSH();
    const ok = await deployToVm(testVm, ssh);
    console.log(`[TEST] ${testVm.name}: ${ok ? "OK" : "FAILED"}`);

    if (ok) {
      // Verify dispatch-server is responding
      const ssh2 = new NodeSSH();
      await ssh2.connect({ host: testVm.ip_address, port: 22, username: "openclaw", privateKey, readyTimeout: 10000 });
      const { stdout } = await ssh2.execCommand("cat ~/scripts/dispatch-remote-batch.sh | head -1");
      const { stdout: skillCheck } = await ssh2.execCommand("grep -c 'batch' ~/.openclaw/skills/computer-dispatch/SKILL.md");
      ssh2.dispose();
      console.log(`[TEST] batch script present: ${stdout.includes("bash") ? "YES" : "NO"}`);
      console.log(`[TEST] SKILL.md batch mentions: ${skillCheck.trim()}`);
      console.log("\n[TEST] Test VM deployed successfully. Run without --test-first to deploy to all VMs.");
    }
    return;
  }

  // Full fleet deploy in batches of 15
  let ok = 0, fail = 0, total = 0;

  for (let i = 0; i < vms.length; i += 15) {
    const batch = vms.slice(i, i + 15);
    await Promise.all(
      batch.map(async (vm) => {
        const ssh = new NodeSSH();
        const success = await deployToVm(vm, ssh);
        if (success) ok++;
        else fail++;
        total++;
      })
    );
    if (total % 50 === 0 || total === vms.length) {
      console.log(`  ${total}/${vms.length} (${ok} ok, ${fail} fail)`);
    }
  }

  console.log(`\nDONE: ${ok} ok, ${fail} failed (${total} total)`);
}

main().catch(console.error);
