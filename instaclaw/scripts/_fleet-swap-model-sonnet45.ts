/**
 * Fleet model swap: claude-sonnet-4-6 → claude-sonnet-4-5-20241022
 *
 * Updates openclaw.json primary model on all assigned VMs and restarts gateways.
 * Mucus (104.237.145.128) is always processed first.
 *
 * Usage:
 *   npx tsx scripts/_fleet-swap-model-sonnet45.ts --mucus-only
 *   npx tsx scripts/_fleet-swap-model-sonnet45.ts
 */
import { createClient } from "@supabase/supabase-js";
import { Client } from "ssh2";
import * as path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const OLD_MODEL = "anthropic/claude-sonnet-4-6";
const NEW_MODEL = "anthropic/claude-sonnet-4-5-20241022";
const MUCUS_IP = "104.237.145.128";

function sshExec(client: Client, cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SSH cmd timeout")), 30000);
    client.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timeout); return reject(err); }
      let stdout = "";
      let stderr = "";
      stream.on("data", (d: Buffer) => (stdout += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      stream.on("close", () => { clearTimeout(timeout); resolve({ stdout, stderr }); });
    });
  });
}

async function connectVM(ip: string, port: number, user: string, privateKey: string): Promise<Client> {
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("connect timeout")), 10000);
    client.on("ready", () => { clearTimeout(timeout); resolve(); });
    client.on("error", (e) => { clearTimeout(timeout); reject(e); });
    client.connect({ host: ip, port, username: user, privateKey, readyTimeout: 10000 });
  });
  return client;
}

async function swapModelOnVM(
  vm: { id: string; ip_address: string; ssh_port: number; ssh_user: string; name: string },
  privateKey: string,
): Promise<{ success: boolean; message: string; wasAlreadyNew?: boolean }> {
  const label = `${vm.name || vm.id.slice(0, 8)} (${vm.ip_address})`;
  let client: Client | null = null;

  try {
    client = await connectVM(vm.ip_address, vm.ssh_port || 22, vm.ssh_user || "openclaw", privateKey);

    // 1. Read current model from openclaw.json
    const { stdout: currentConfig } = await sshExec(client, "cat ~/.openclaw/openclaw.json 2>/dev/null");
    if (!currentConfig || currentConfig === "NOT FOUND") {
      return { success: false, message: `[SKIP] ${label}: no openclaw.json found` };
    }

    const config = JSON.parse(currentConfig);
    const currentModel = config?.agents?.defaults?.model?.primary;

    if (currentModel === NEW_MODEL) {
      return { success: true, message: `[ALREADY] ${label}: already on ${NEW_MODEL}`, wasAlreadyNew: true };
    }

    // 2. Update the model in openclaw.json using jq for safety
    const jqCmd = `cat ~/.openclaw/openclaw.json | python3 -c '
import sys, json
c = json.load(sys.stdin)
if "agents" not in c: c["agents"] = {}
if "defaults" not in c["agents"]: c["agents"]["defaults"] = {}
if "model" not in c["agents"]["defaults"]: c["agents"]["defaults"]["model"] = {}
c["agents"]["defaults"]["model"]["primary"] = "${NEW_MODEL}"
# Also update fallbacks if they reference the old model
fb = c["agents"]["defaults"]["model"].get("fallbacks", [])
c["agents"]["defaults"]["model"]["fallbacks"] = ["${NEW_MODEL}" if m == "${OLD_MODEL}" else m for m in fb]
json.dump(c, sys.stdout, indent=2)
' > /tmp/openclaw-new.json && mv /tmp/openclaw-new.json ~/.openclaw/openclaw.json`;

    const { stderr: jqErr } = await sshExec(client, jqCmd);
    if (jqErr && jqErr.includes("Error")) {
      return { success: false, message: `[ERROR] ${label}: config update failed: ${jqErr}` };
    }

    // 3. Verify the update
    const { stdout: verifyConfig } = await sshExec(client, "cat ~/.openclaw/openclaw.json 2>/dev/null");
    const verified = JSON.parse(verifyConfig);
    if (verified?.agents?.defaults?.model?.primary !== NEW_MODEL) {
      return { success: false, message: `[VERIFY FAIL] ${label}: model is ${verified?.agents?.defaults?.model?.primary}` };
    }

    // 4. Restart gateway
    const restartCmd = `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart openclaw-gateway`;
    await sshExec(client, restartCmd);

    // 5. Wait for gateway to come back (up to 30s per CLAUDE.md rules)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const { stdout: status } = await sshExec(client,
        `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user is-active openclaw-gateway 2>/dev/null || echo "unknown"`
      );
      if (status.trim() === "active") {
        return { success: true, message: `[SWAPPED] ${label}: ${OLD_MODEL} → ${NEW_MODEL}, gateway active after ${(i+1)*2}s` };
      }
    }

    return { success: false, message: `[WARN] ${label}: model swapped but gateway didn't reach active in 30s` };
  } catch (e: any) {
    return { success: false, message: `[ERROR] ${label}: ${e.message}` };
  } finally {
    try { client?.end(); } catch {}
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mucusOnly = args.includes("--mucus-only");

  const keyB64 = process.env.SSH_PRIVATE_KEY_B64!;
  if (!keyB64) throw new Error("SSH_PRIVATE_KEY_B64 not set");
  const privateKey = Buffer.from(keyB64, "base64").toString("utf-8");

  // Get all assigned VMs
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, default_model")
    .eq("status", "assigned")
    .not("ip_address", "is", null);

  if (!vms || vms.length === 0) {
    console.log("No assigned VMs found");
    return;
  }

  // Sort: Mucus first
  const sorted = [...vms].sort((a, b) => {
    if (a.ip_address === MUCUS_IP) return -1;
    if (b.ip_address === MUCUS_IP) return 1;
    return 0;
  });

  // === Phase 1: Mucus first ===
  const mucusVM = sorted.find(v => v.ip_address === MUCUS_IP);
  if (mucusVM) {
    console.log("=== PHASE 1: Mucus (priority) ===\n");
    const result = await swapModelOnVM(mucusVM, privateKey);
    console.log(result.message);
    if (!result.success) {
      console.log("\nMucus swap FAILED — aborting fleet deploy");
      return;
    }

    // Update DB
    await supabase
      .from("instaclaw_vms")
      .update({ default_model: "claude-sonnet-4-5-20241022" })
      .eq("id", mucusVM.id);
    console.log("DB updated for Mucus");

    if (mucusOnly) {
      console.log("\n--mucus-only flag set, stopping here.");
      return;
    }

    console.log("\nMucus is live. Proceeding to fleet...\n");
  }

  // === Phase 2: Rest of fleet ===
  console.log("=== PHASE 2: Fleet deploy ===\n");
  const remaining = sorted.filter(v => v.ip_address !== MUCUS_IP);
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  // Batches of 5
  for (let i = 0; i < remaining.length; i += 5) {
    const batch = remaining.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(vm => swapModelOnVM(vm, privateKey))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const vm = batch[j];
      console.log(r.message);
      if (r.wasAlreadyNew) {
        skipped++;
      } else if (r.success) {
        succeeded++;
        // Update DB
        await supabase
          .from("instaclaw_vms")
          .update({ default_model: "claude-sonnet-4-5-20241022" })
          .eq("id", vm.id);
      } else {
        failed++;
      }
    }
    if (i + 5 < remaining.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone: ${succeeded} swapped, ${skipped} already on new model, ${failed} failed out of ${remaining.length} VMs`);
}

main().catch(console.error);
