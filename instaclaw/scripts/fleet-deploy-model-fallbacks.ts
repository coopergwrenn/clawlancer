/**
 * Fleet deploy: add model.fallbacks to all assigned VMs.
 *
 * Adds agents.defaults.model.fallbacks = ["anthropic/claude-haiku-4-5"]
 * to each VM's openclaw.json, restarts the gateway, and verifies health.
 *
 * Usage:
 *   npx tsx scripts/fleet-deploy-model-fallbacks.ts --dry-run        (preview all targets)
 *   npx tsx scripts/fleet-deploy-model-fallbacks.ts --test-first     (patch 3 VMs, pause for approval)
 *   npx tsx scripts/fleet-deploy-model-fallbacks.ts --full           (patch all remaining VMs)
 *
 * Rules 3-5: test on one first, dry-run before real, verify health after.
 */
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import * as dotenv from "dotenv";
import * as path from "path";
import * as readline from "readline";
dotenv.config({ path: path.join(__dirname, "../.env.local.full") });

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_FIRST = process.argv.includes("--test-first");
const FULL = process.argv.includes("--full");

if (!DRY_RUN && !TEST_FIRST && !FULL) {
  console.error("Usage: npx tsx scripts/fleet-deploy-model-fallbacks.ts [--dry-run | --test-first | --full]");
  process.exit(1);
}

const NVM = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';
const HEALTH_PORT = 18789;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Python script to add model.fallbacks
const PATCH_PY = `
import json, os, sys
p = os.path.expanduser("~/.openclaw/openclaw.json")
with open(p) as f: c = json.load(f)
agents = c.get("agents", {})
defaults = agents.get("defaults", {})
model = defaults.get("model", {})
current_fallbacks = model.get("fallbacks", [])
if current_fallbacks:
    print(f"ALREADY_SET: fallbacks={current_fallbacks}")
    sys.exit(0)
model["fallbacks"] = ["anthropic/claude-haiku-4-5"]
defaults["model"] = model
agents["defaults"] = defaults
c["agents"] = agents
with open(p, "w") as f: json.dump(c, f, indent=2)
primary = model.get("primary", "(not set)")
print(f"PATCHED: primary={primary}, fallbacks=['anthropic/claude-haiku-4-5']")
`.trim();

// Python script to REVERT fallbacks
const REVERT_PY = `
import json, os
p = os.path.expanduser("~/.openclaw/openclaw.json")
with open(p) as f: c = json.load(f)
model = c.get("agents", {}).get("defaults", {}).get("model", {})
if "fallbacks" in model:
    del model["fallbacks"]
    c["agents"]["defaults"]["model"] = model
    with open(p, "w") as f: json.dump(c, f, indent=2)
    print("REVERTED")
else:
    print("NO_FALLBACKS")
`.trim();

const patchB64 = Buffer.from(PATCH_PY).toString("base64");
const revertB64 = Buffer.from(REVERT_PY).toString("base64");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface VMTarget {
  id: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  health_status: string;
  tier: string | null;
  default_model: string | null;
}

type PatchResult = "OK" | "ALREADY_SET" | "FAIL" | "REVERTED";

async function patchVM(vm: VMTarget, sshKey: string): Promise<{ status: PatchResult; detail: string }> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      port: vm.ssh_port || 22,
      username: vm.ssh_user || "openclaw",
      privateKey: sshKey,
      readyTimeout: 10000,
    });

    // Step 1: Apply patch
    const r1 = await ssh.execCommand(`echo '${patchB64}' | base64 -d | python3`);
    const output = (r1.stdout || r1.stderr).trim();

    if (output.includes("ALREADY_SET")) {
      ssh.dispose();
      return { status: "ALREADY_SET", detail: output };
    }

    if (!output.includes("PATCHED")) {
      ssh.dispose();
      return { status: "FAIL", detail: `patch failed: ${output}` };
    }

    // Step 2: Restart gateway
    const restartScript = [
      "#!/bin/bash",
      "systemctl --user stop openclaw-gateway 2>/dev/null || pkill -9 -f 'openclaw-gateway' 2>/dev/null || true",
      "sleep 2",
      "systemctl --user start openclaw-gateway",
    ].join("\n");
    await ssh.execCommand(restartScript);

    // Step 3: Wait up to 30s for health (Rule 5)
    let healthy = false;
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      const hc = await ssh.execCommand(
        `SVC=$(systemctl --user is-active openclaw-gateway 2>/dev/null || echo 'inactive'); HTTP=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:${HEALTH_PORT}/health 2>/dev/null || echo '000'); echo "$SVC $HTTP"`
      );
      const hout = hc.stdout.trim();
      if (hout.includes("active") && hout.includes("200")) {
        healthy = true;
        break;
      }
    }

    if (!healthy) {
      // REVERT (Rule 5)
      await ssh.execCommand(`echo '${revertB64}' | base64 -d | python3`);
      await ssh.execCommand(restartScript);
      await sleep(10000);
      ssh.dispose();
      return { status: "REVERTED", detail: "gateway did not recover after 30s, config reverted" };
    }

    ssh.dispose();
    return { status: "OK", detail: output };
  } catch (err: unknown) {
    try { ssh.dispose(); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "FAIL", detail: `ssh error: ${msg}` };
  }
}

function askForApproval(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

async function main() {
  // Fetch all assigned VMs with gateway
  const { data: allVms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, health_status, tier, default_model")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .order("ip_address");

  if (error || !allVms?.length) {
    console.error("No assigned VMs found", error);
    process.exit(1);
  }

  // Filter to healthy VMs only
  const healthyVms = allVms.filter((v) => v.health_status === "healthy");
  const unhealthyVms = allVms.filter((v) => v.health_status !== "healthy");

  console.log(`\n=== Fleet Deploy: model.fallbacks ===`);
  console.log(`Total assigned VMs: ${allVms.length}`);
  console.log(`  Healthy: ${healthyVms.length}`);
  console.log(`  Unhealthy/Unknown (skipped): ${unhealthyVms.length}`);

  if (unhealthyVms.length > 0) {
    console.log(`\n  Skipping unhealthy VMs:`);
    for (const v of unhealthyVms) {
      console.log(`    ${v.ip_address} (${v.id.slice(0, 8)}...) health=${v.health_status}`);
    }
  }

  console.log(`\n  Targets (${healthyVms.length} healthy VMs):`);
  for (const v of healthyVms) {
    const t = v.tier || "null";
    const m = (v.default_model || "none").slice(0, 25);
    console.log(`    ${v.ip_address.padEnd(18)} | tier=${t.padEnd(8)} | model=${m}`);
  }

  if (DRY_RUN) {
    console.log(`\n--- DRY RUN ---`);
    console.log(`Would patch ${healthyVms.length} VMs with:`);
    console.log(`  agents.defaults.model.fallbacks = ["anthropic/claude-haiku-4-5"]`);
    console.log(`\nRun with --test-first to patch 3 canary VMs.`);
    return;
  }

  const sshKey = process.env.SSH_PRIVATE_KEY_B64
    ? Buffer.from(process.env.SSH_PRIVATE_KEY_B64, "base64").toString("utf-8")
    : null;
  if (!sshKey) {
    console.error("SSH_PRIVATE_KEY_B64 not set");
    process.exit(1);
  }

  // Select 3 canary VMs from different IP subnets for --test-first
  if (TEST_FIRST) {
    // Pick VMs from different /16 subnets for provider diversity
    const seen = new Set<string>();
    const canaries: VMTarget[] = [];
    for (const v of healthyVms) {
      const subnet = v.ip_address.split(".").slice(0, 2).join(".");
      if (!seen.has(subnet) && canaries.length < 3) {
        seen.add(subnet);
        canaries.push(v);
      }
    }

    console.log(`\n--- TEST-FIRST: Patching ${canaries.length} canary VMs ---\n`);

    const results: { ip: string; status: PatchResult; detail: string }[] = [];
    for (const vm of canaries) {
      process.stdout.write(`  ${vm.ip_address.padEnd(18)} ... `);
      const r = await patchVM(vm, sshKey);
      console.log(`${r.status} — ${r.detail}`);
      results.push({ ip: vm.ip_address, status: r.status, detail: r.detail });
    }

    const failures = results.filter((r) => r.status === "FAIL" || r.status === "REVERTED");
    console.log(`\n--- Canary Results ---`);
    console.log(`  OK: ${results.filter((r) => r.status === "OK").length}`);
    console.log(`  Already set: ${results.filter((r) => r.status === "ALREADY_SET").length}`);
    console.log(`  Failed/Reverted: ${failures.length}`);

    if (failures.length > 0) {
      console.error(`\n  CANARY FAILURES — DO NOT proceed with full fleet deploy.`);
      for (const f of failures) {
        console.error(`    ${f.ip}: ${f.detail}`);
      }
      process.exit(1);
    }

    console.log(`\nCanary VMs are healthy. Run with --full to deploy to remaining ${healthyVms.length - canaries.length} VMs.`);
    return;
  }

  // --full: patch all healthy VMs
  if (FULL) {
    console.log(`\n--- FULL FLEET DEPLOY: ${healthyVms.length} VMs ---\n`);

    const approved = await askForApproval(
      `Proceed with patching ${healthyVms.length} VMs? [y/N] `
    );
    if (!approved) {
      console.log("Aborted.");
      return;
    }

    const results: { ip: string; status: PatchResult; detail: string }[] = [];
    let okCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (let i = 0; i < healthyVms.length; i++) {
      const vm = healthyVms[i];
      process.stdout.write(`  [${i + 1}/${healthyVms.length}] ${vm.ip_address.padEnd(18)} ... `);
      const r = await patchVM(vm, sshKey);
      console.log(`${r.status} — ${r.detail}`);
      results.push({ ip: vm.ip_address, status: r.status, detail: r.detail });

      if (r.status === "OK") okCount++;
      else if (r.status === "ALREADY_SET") skipCount++;
      else failCount++;

      // Stop on 3+ failures (circuit breaker)
      if (failCount >= 3) {
        console.error(`\n  CIRCUIT BREAKER: ${failCount} failures. Stopping fleet deploy.`);
        console.error(`  ${healthyVms.length - i - 1} VMs were NOT patched.`);
        break;
      }
    }

    console.log(`\n=== Fleet Deploy Summary ===`);
    console.log(`  OK: ${okCount}`);
    console.log(`  Already set: ${skipCount}`);
    console.log(`  Failed/Reverted: ${failCount}`);
    console.log(`  Total processed: ${results.length}/${healthyVms.length}`);

    if (failCount > 0) {
      console.log(`\n  Failed VMs:`);
      for (const r of results.filter((r) => r.status === "FAIL" || r.status === "REVERTED")) {
        console.error(`    ${r.ip}: ${r.detail}`);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
