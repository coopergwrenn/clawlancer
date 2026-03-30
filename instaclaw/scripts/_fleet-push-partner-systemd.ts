/**
 * Fleet push: Add PARTNER_ID=INSTACLAW to gateway systemd Environment.
 * This ensures ALL child processes (agent tools, npx acp, etc.) inherit it
 * regardless of working directory or dotenv loading.
 *
 * Usage:
 *   npx tsx scripts/_fleet-push-partner-systemd.ts --test-first
 *   npx tsx scripts/_fleet-push-partner-systemd.ts --all
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

async function patchVM(vm: any): Promise<{ vm: string; ok: boolean; action: string; error?: string }> {
  try {
    const ssh = await connectSSH(vm);

    // Check if PARTNER_ID is already in the gateway's process env
    const check = await ssh.execCommand(
      'PID=$(pgrep -f "openclaw-gateway" | head -1) && cat /proc/$PID/environ 2>/dev/null | tr "\\0" "\\n" | grep -c PARTNER_ID || echo "0"'
    );
    const hasIt = parseInt(check.stdout?.trim() || "0", 10) > 0;

    if (hasIt) {
      ssh.dispose();
      return { vm: vm.name, ok: true, action: "already_present" };
    }

    // Add PARTNER_ID to the systemd override
    const addResult = await ssh.execCommand(`
      OVERRIDE="$HOME/.config/systemd/user/openclaw-gateway.service.d/override.conf"
      if [ -f "$OVERRIDE" ]; then
        if grep -q 'PARTNER_ID' "$OVERRIDE" 2>/dev/null; then
          echo "ALREADY_IN_OVERRIDE"
        else
          echo 'Environment=PARTNER_ID=INSTACLAW' >> "$OVERRIDE"
          echo "ADDED_TO_OVERRIDE"
        fi
      else
        mkdir -p "$(dirname "$OVERRIDE")"
        echo '[Service]' > "$OVERRIDE"
        echo 'Environment=PARTNER_ID=INSTACLAW' >> "$OVERRIDE"
        echo "CREATED_OVERRIDE"
      fi
    `);
    const addAction = addResult.stdout?.trim() || "UNKNOWN";

    // Daemon reload + restart gateway
    await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user daemon-reload && systemctl --user restart openclaw-gateway'
    );

    // Wait for gateway to come up
    await new Promise(r => setTimeout(r, 5000));

    // Verify PARTNER_ID is now in the process
    const verify = await ssh.execCommand(
      'PID=$(pgrep -f "openclaw-gateway" | head -1) && cat /proc/$PID/environ 2>/dev/null | tr "\\0" "\\n" | grep PARTNER_ID || echo "NOT_FOUND"'
    );
    const verified = verify.stdout?.trim().includes("INSTACLAW");

    ssh.dispose();
    return { vm: vm.name, ok: verified, action: addAction, error: verified ? undefined : `Verify failed: ${verify.stdout?.trim()}` };
  } catch (e) {
    return { vm: vm.name, ok: false, action: "error", error: String(e).slice(0, 100) };
  }
}

async function main() {
  console.log(`=== PARTNER_ID Gateway Systemd Push (${mode.toUpperCase()}) ===\n`);

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .not("ip_address", "is", null)
    .order("name");

  if (!vms?.length) { console.log("No VMs."); return; }
  console.log(`Found ${vms.length} VMs.\n`);

  if (mode === "dry-run") {
    console.log(`Would add Environment=PARTNER_ID=INSTACLAW to gateway systemd on ${vms.length} VMs.`);
    console.log("Run with --test-first.");
    return;
  }

  if (mode === "test-first") {
    const testVm = vms[0];
    console.log(`Testing on ${testVm.name}...`);
    const result = await patchVM(testVm);
    console.log(`  [${result.ok ? "OK" : "XX"}] ${result.vm}: ${result.action}${result.error ? ` — ${result.error}` : ""}`);
    if (!result.ok) { console.error("Test FAILED."); process.exit(1); }
    console.log(`\nTest PASS. Run with --all for ${vms.length - 1} remaining.`);
    return;
  }

  // --all
  const results: Awaited<ReturnType<typeof patchVM>>[] = [];
  for (let i = 0; i < vms.length; i += CONCURRENCY) {
    const batch = vms.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(patchVM));
    results.push(...batchResults);
    for (const r of batchResults) {
      console.log(`  [${r.ok ? "OK" : "XX"}] ${r.vm}: ${r.action}${r.error ? ` — ${r.error}` : ""}`);
    }
  }

  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log(`\n=== DONE: ${ok}/${vms.length} verified ===`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(`  ${f.vm}: ${f.error}`);
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
