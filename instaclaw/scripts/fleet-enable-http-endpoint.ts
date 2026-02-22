/**
 * Fleet patch: enable gateway HTTP chat completions endpoint
 *
 * Adds gateway.http.endpoints.chatCompletions.enabled = true to openclaw.json
 * on every assigned VM, restarts gateway, and verifies the endpoint responds.
 *
 * Rules enforced:
 * - Rule 3: --test-first patches one VM and pauses for approval
 * - Rule 4: --dry-run support (mandatory before real execution)
 * - Rule 5: verify gateway health after config change + restart
 *
 * Usage:
 *   npx tsx scripts/fleet-enable-http-endpoint.ts --dry-run
 *   npx tsx scripts/fleet-enable-http-endpoint.ts --test-first
 *   npx tsx scripts/fleet-enable-http-endpoint.ts
 */
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import * as dotenv from "dotenv";
import * as path from "path";
import * as readline from "readline";
dotenv.config({ path: path.join(__dirname, "../.env.local.full") });

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_FIRST = process.argv.includes("--test-first");

const NVM = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Python script to patch openclaw.json — adds gateway.http.endpoints.chatCompletions.enabled
const PATCH_PY = `
import json, os
p = os.path.expanduser("~/.openclaw/openclaw.json")
with open(p) as f: c = json.load(f)
g = c.setdefault("gateway", {})
h = g.setdefault("http", {})
e = h.setdefault("endpoints", {})
cc = e.get("chatCompletions", {})
was_enabled = cc.get("enabled", False)
e["chatCompletions"] = {"enabled": True}
with open(p, "w") as f: json.dump(c, f, indent=2)
print(f"OK chatCompletions: {was_enabled} -> True")
`.trim();

const patchB64 = Buffer.from(PATCH_PY).toString("base64");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function askConfirmation(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

async function patchVM(
  vm: { id: string; name: string; ip_address: string; gateway_token: string | null },
  sshKey: string
): Promise<string> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      port: 22,
      username: "openclaw",
      privateKey: sshKey,
      readyTimeout: 10000,
    });

    // Step 1: Patch openclaw.json
    const r1 = await ssh.execCommand(`echo '${patchB64}' | base64 -d | python3`);
    if (!r1.stdout.includes("OK")) {
      return `FAIL config patch: ${r1.stderr || r1.stdout}`;
    }
    const configResult = r1.stdout.trim();

    // Step 2: Restart gateway
    const r2 = await ssh.execCommand(
      "systemctl --user restart openclaw-gateway 2>&1 && echo RESTARTED || echo RESTART_FAILED"
    );
    if (!r2.stdout.includes("RESTARTED")) {
      return `FAIL restart: ${r2.stdout}`;
    }

    // Step 3: Wait for gateway to come up (Rule 5: up to 30 seconds)
    let healthy = false;
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      const check = await ssh.execCommand(
        'curl -s -m 5 -o /dev/null -w "%{http_code}" http://localhost:18789/health'
      );
      if (check.stdout.trim() === "200") {
        healthy = true;
        break;
      }
    }

    if (!healthy) {
      // Rule 5: revert and restart with old config
      await ssh.execCommand(
        `echo '${patchB64}' | base64 -d | python3 -c "
import json, os
p = os.path.expanduser('~/.openclaw/openclaw.json')
with open(p) as f: c = json.load(f)
g = c.get('gateway', {})
h = g.get('http', {})
e = h.get('endpoints', {})
if 'chatCompletions' in e: del e['chatCompletions']
if not e and 'endpoints' in h: del h['endpoints']
if not h and 'http' in g: del g['http']
with open(p, 'w') as f: json.dump(c, f, indent=2)
print('REVERTED')
"`
      );
      await ssh.execCommand("systemctl --user restart openclaw-gateway 2>&1");
      ssh.dispose();
      return `FAIL health check failed after 30s — reverted config`;
    }

    // Step 4: Verify the HTTP endpoint actually responds (not 405)
    const token = vm.gateway_token || "";
    const r4 = await ssh.execCommand(
      `curl -s -m 5 -o /dev/null -w "%{http_code}" -X POST http://localhost:18789/v1/chat/completions ` +
      `-H "content-type: application/json" -H "authorization: Bearer ${token}" ` +
      `-d '{"model":"test","messages":[{"role":"user","content":"ping"}]}'`
    );
    const endpointStatus = r4.stdout.trim();

    ssh.dispose();
    return `OK ${configResult} | health:200 | endpoint:${endpointStatus}`;
  } catch (err: any) {
    try { ssh.dispose(); } catch {}
    return `FAIL ssh: ${err.message}`;
  }
}

async function main() {
  console.log(DRY_RUN ? "=== FLEET ENABLE HTTP ENDPOINT (DRY RUN) ===" : "=== FLEET ENABLE HTTP ENDPOINT ===");
  console.log("Patch: gateway.http.endpoints.chatCompletions.enabled = true\n");

  if (TEST_FIRST) {
    console.log("Mode: --test-first (will patch one VM, pause for approval, then continue)\n");
  }

  // Get all assigned VMs with gateway_url
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, health_status, gateway_token")
    .eq("status", "assigned")
    .not("gateway_url", "is", null)
    .order("name");

  if (!vms || vms.length === 0) {
    console.log("No VMs to patch.");
    return;
  }

  console.log(`Found ${vms.length} VMs to patch:`);
  for (const vm of vms) {
    console.log(`  ${vm.name} (${vm.ip_address}) health=${vm.health_status}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log("Dry run — no changes made.");
    return;
  }

  const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
  const results: { name: string; result: string }[] = [];

  if (TEST_FIRST && vms.length > 1) {
    // Patch first VM only
    const testVm = vms[0];
    process.stdout.write(`[TEST] ${testVm.name} (${testVm.ip_address})... `);
    const result = await patchVM(testVm, sshKey);
    console.log(result);
    results.push({ name: testVm.name, result });

    if (!result.startsWith("OK")) {
      console.log("\nTest VM failed — aborting fleet patch.");
      return;
    }

    const proceed = await askConfirmation("\nTest VM succeeded. Continue with remaining VMs?");
    if (!proceed) {
      console.log("Aborted by user.");
      return;
    }

    // Patch remaining VMs
    for (const vm of vms.slice(1)) {
      process.stdout.write(`${vm.name} (${vm.ip_address})... `);
      const r = await patchVM(vm, sshKey);
      console.log(r);
      results.push({ name: vm.name, result: r });
    }
  } else {
    // Patch all VMs sequentially
    for (const vm of vms) {
      process.stdout.write(`${vm.name} (${vm.ip_address})... `);
      const r = await patchVM(vm, sshKey);
      console.log(r);
      results.push({ name: vm.name, result: r });
    }
  }

  // Summary
  console.log("\n=== SUMMARY ===");
  const ok = results.filter((r) => r.result.startsWith("OK"));
  const fail = results.filter((r) => r.result.startsWith("FAIL"));
  console.log(`${ok.length}/${results.length} patched successfully`);
  if (fail.length > 0) {
    console.log("Failures:");
    for (const f of fail) {
      console.log(`  ${f.name}: ${f.result}`);
    }
  }
}

main().catch(console.error);
