/**
 * Canary test: add model.fallbacks to ONE VM's OpenClaw config.
 *
 * This patches agents.defaults.model.fallbacks in openclaw.json,
 * restarts the gateway, then verifies health (Rule 5).
 *
 * Usage:
 *   npx tsx scripts/_canary-model-fallbacks.ts --dry-run     (preview only)
 *   npx tsx scripts/_canary-model-fallbacks.ts --test-first   (apply to 1 VM)
 *
 * Following Rules 3, 4, 5 from CLAUDE.md.
 */
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local.full") });

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_FIRST = process.argv.includes("--test-first");

if (!DRY_RUN && !TEST_FIRST) {
  console.error("Usage: npx tsx scripts/_canary-model-fallbacks.ts [--dry-run | --test-first]");
  process.exit(1);
}

const NVM = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Python script to add model.fallbacks to openclaw.json
const PATCH_PY = `
import json, os, sys
p = os.path.expanduser("~/.openclaw/openclaw.json")
with open(p) as f: c = json.load(f)

# Navigate to agents.defaults.model
agents = c.get("agents", {})
defaults = agents.get("defaults", {})
model = defaults.get("model", {})

# Check current state
current_primary = model.get("primary", "(not set)")
current_fallbacks = model.get("fallbacks", [])

if current_fallbacks:
    print(f"ALREADY_SET: primary={current_primary}, fallbacks={current_fallbacks}")
    sys.exit(0)

# Add fallbacks
model["fallbacks"] = ["anthropic/claude-haiku-4-5"]
defaults["model"] = model
agents["defaults"] = defaults
c["agents"] = agents

with open(p, "w") as f: json.dump(c, f, indent=2)
print(f"PATCHED: primary={current_primary}, added fallbacks=['anthropic/claude-haiku-4-5']")
`.trim();

// Python script to read current config (for dry-run)
const READ_PY = `
import json, os
p = os.path.expanduser("~/.openclaw/openclaw.json")
with open(p) as f: c = json.load(f)
model = c.get("agents", {}).get("defaults", {}).get("model", {})
print(json.dumps(model, indent=2))
`.trim();

// Python script to REVERT fallbacks (emergency rollback)
const REVERT_PY = `
import json, os
p = os.path.expanduser("~/.openclaw/openclaw.json")
with open(p) as f: c = json.load(f)
model = c.get("agents", {}).get("defaults", {}).get("model", {})
if "fallbacks" in model:
    del model["fallbacks"]
    c["agents"]["defaults"]["model"] = model
    with open(p, "w") as f: json.dump(c, f, indent=2)
    print("REVERTED: removed fallbacks")
else:
    print("NO_FALLBACKS: nothing to revert")
`.trim();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const sshKey = process.env.SSH_PRIVATE_KEY_B64
    ? Buffer.from(process.env.SSH_PRIVATE_KEY_B64, "base64").toString("utf-8")
    : null;

  if (!sshKey) {
    console.error("SSH_PRIVATE_KEY_B64 not set");
    process.exit(1);
  }

  // Get ONE healthy VM with an assigned user (real canary target)
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, default_model, tier, health_status, assigned_to")
    .eq("health_status", "healthy")
    .not("gateway_token", "is", null)
    .limit(1);

  if (error || !vms?.length) {
    console.error("No healthy assigned VMs found", error);
    process.exit(1);
  }

  const vm = vms[0];
  console.log(`\nCanary VM: ${vm.ip_address} (${vm.id.slice(0, 8)}...)`);
  console.log(`  Model: ${vm.default_model || "(default)"}`);
  console.log(`  Tier: ${vm.tier || "(null)"}`);
  console.log(`  Health: ${vm.health_status}`);

  const ssh = new NodeSSH();
  await ssh.connect({
    host: vm.ip_address,
    port: vm.ssh_port || 22,
    username: vm.ssh_user || "openclaw",
    privateKey: sshKey,
    readyTimeout: 10000,
  });

  // Step 1: Read current config
  console.log("\n--- Current model config ---");
  const readB64 = Buffer.from(READ_PY).toString("base64");
  const readResult = await ssh.execCommand(`echo '${readB64}' | base64 -d | python3`);
  console.log(readResult.stdout || readResult.stderr);

  if (DRY_RUN) {
    console.log("\n--- DRY RUN: Would apply this patch ---");
    console.log('  agents.defaults.model.fallbacks = ["anthropic/claude-haiku-4-5"]');
    console.log("  Then restart gateway and wait up to 30s for health check.");
    console.log("\nDry run complete. Run with --test-first to apply.");
    ssh.dispose();
    process.exit(0);
  }

  // Step 2: Apply the patch (--test-first mode)
  console.log("\n--- Applying model.fallbacks patch ---");
  const patchB64 = Buffer.from(PATCH_PY).toString("base64");
  const patchResult = await ssh.execCommand(`echo '${patchB64}' | base64 -d | python3`);
  console.log(`  Result: ${patchResult.stdout || patchResult.stderr}`);

  if (patchResult.stdout?.includes("ALREADY_SET")) {
    console.log("  Fallbacks already configured. No restart needed.");
    ssh.dispose();
    process.exit(0);
  }

  if (!patchResult.stdout?.includes("PATCHED")) {
    console.error("  Patch failed! No changes made.");
    ssh.dispose();
    process.exit(1);
  }

  // Step 3: Restart gateway
  console.log("\n--- Restarting gateway ---");
  const restartScript = [
    "#!/bin/bash",
    NVM,
    "systemctl --user stop openclaw-gateway 2>/dev/null || pkill -9 -f 'openclaw-gateway' 2>/dev/null || true",
    "sleep 2",
    "systemctl --user start openclaw-gateway",
  ].join("\n");

  await ssh.execCommand(restartScript);
  console.log("  Gateway restart issued. Waiting for health...");

  // Step 4: Wait up to 30s for gateway health (Rule 5)
  let healthy = false;
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    const healthCheck = await ssh.execCommand(
      "SVC=$(systemctl --user is-active openclaw-gateway 2>/dev/null || echo 'inactive'); HTTP=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo '000'); echo \"$SVC $HTTP\""
    );
    const output = healthCheck.stdout.trim();
    console.log(`  Health check ${i + 1}/6: ${output}`);

    if (output.includes("active") && output.includes("200")) {
      healthy = true;
      break;
    }
  }

  if (!healthy) {
    // REVERT! (Rule 5)
    console.error("\n  GATEWAY DID NOT RECOVER! Reverting config...");
    const revertB64 = Buffer.from(REVERT_PY).toString("base64");
    const revertResult = await ssh.execCommand(`echo '${revertB64}' | base64 -d | python3`);
    console.log(`  Revert: ${revertResult.stdout || revertResult.stderr}`);

    // Restart with reverted config
    await ssh.execCommand(restartScript);
    await sleep(5000);

    // Wait a bit longer for reverted gateway to come up
    await sleep(10000);
    const recheck = await ssh.execCommand(
      "SVC=$(systemctl --user is-active openclaw-gateway 2>/dev/null || echo 'inactive'); HTTP=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo '000'); echo \"$SVC $HTTP\""
    );
    console.log(`  After revert, gateway status: ${recheck.stdout.trim()}`);

    ssh.dispose();
    console.error("\n  CANARY FAILED: model.fallbacks caused gateway failure. Reverted.");
    process.exit(1);
  }

  // Step 5: Verify the config is actually applied
  console.log("\n--- Verifying config after restart ---");
  const verifyResult = await ssh.execCommand(`echo '${readB64}' | base64 -d | python3`);
  console.log(verifyResult.stdout || verifyResult.stderr);

  ssh.dispose();

  console.log("\n=== CANARY PASSED ===");
  console.log(`VM ${vm.ip_address} is healthy with model.fallbacks enabled.`);
  console.log("Safe to deploy fleet-wide (after manual approval).\n");
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
