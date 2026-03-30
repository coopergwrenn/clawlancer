/**
 * Fleet push: PARTNER_ID=INSTACLAW to all assigned VMs.
 *
 * Injects into:
 * 1. ~/.bashrc (all shell sessions)
 * 2. ~/virtuals-protocol-acp/.env (ACP CLI dotenv, if ACP installed)
 * 3. ~/virtuals-protocol-acp/acp-serve.sh (systemd wrapper, if exists)
 *
 * Usage:
 *   npx tsx scripts/_fleet-push-partner-id.ts --dry-run
 *   npx tsx scripts/_fleet-push-partner-id.ts --test-first
 *   npx tsx scripts/_fleet-push-partner-id.ts --all
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

const PARTNER_ID = "INSTACLAW";
const CONCURRENCY = 8;

interface Result {
  vm: string;
  ip: string;
  ok: boolean;
  bashrc: string;
  acpEnv: string;
  acpServe: string;
  hasAcp: boolean;
  error?: string;
}

async function patchVM(vm: any): Promise<Result> {
  const r: Result = {
    vm: vm.name, ip: vm.ip_address, ok: false,
    bashrc: "skip", acpEnv: "skip", acpServe: "skip", hasAcp: false,
  };

  try {
    const ssh = await connectSSH(vm);

    // 1. Add to .bashrc (all VMs)
    const bashrcCheck = await ssh.execCommand(`grep -c 'PARTNER_ID=' ~/.bashrc 2>/dev/null || echo "0"`);
    if (parseInt(bashrcCheck.stdout?.trim() || "0", 10) === 0) {
      await ssh.execCommand(`echo 'export PARTNER_ID=${PARTNER_ID}' >> ~/.bashrc`);
      r.bashrc = "added";
    } else {
      r.bashrc = "exists";
    }

    // 2. Check if ACP is installed
    const acpCheck = await ssh.execCommand("test -d ~/virtuals-protocol-acp && echo YES || echo NO");
    r.hasAcp = acpCheck.stdout?.trim() === "YES";

    if (r.hasAcp) {
      // 3. Add to ACP .env
      const envCheck = await ssh.execCommand(`grep -c 'PARTNER_ID=' ~/virtuals-protocol-acp/.env 2>/dev/null || echo "0"`);
      if (parseInt(envCheck.stdout?.trim() || "0", 10) === 0) {
        await ssh.execCommand(`echo 'PARTNER_ID=${PARTNER_ID}' >> ~/virtuals-protocol-acp/.env`);
        r.acpEnv = "added";
      } else {
        r.acpEnv = "exists";
      }

      // 4. Add to acp-serve.sh wrapper (before the exec line)
      const serveCheck = await ssh.execCommand(`grep -c 'PARTNER_ID=' ~/virtuals-protocol-acp/acp-serve.sh 2>/dev/null || echo "0"`);
      if (parseInt(serveCheck.stdout?.trim() || "0", 10) === 0) {
        await ssh.execCommand(`sed -i '/^exec npx/i export PARTNER_ID=${PARTNER_ID}' ~/virtuals-protocol-acp/acp-serve.sh 2>/dev/null || true`);
        r.acpServe = "added";
      } else {
        r.acpServe = "exists";
      }

      // 5. Restart acp-serve if we made changes (so it picks up PARTNER_ID)
      if (r.acpEnv === "added" || r.acpServe === "added") {
        await ssh.execCommand('export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart acp-serve.service 2>/dev/null || true');
      }
    }

    // Verify — check file contents directly (SSH non-interactive shells don't source .bashrc)
    const verify = await ssh.execCommand(`grep -c 'PARTNER_ID=${PARTNER_ID}' ~/.bashrc 2>/dev/null || echo "0"`);
    r.ok = parseInt(verify.stdout?.trim() || "0", 10) > 0;
    if (!r.ok) r.error = `PARTNER_ID not found in .bashrc`;

    ssh.dispose();
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
        `  [${icon}] ${r.vm} (${r.ip}) — bashrc=${r.bashrc} acp=${r.hasAcp ? `env=${r.acpEnv} serve=${r.acpServe}` : "no-acp"}${r.error ? ` ERR: ${r.error}` : ""}`
      );
    }
  }
  return results;
}

async function main() {
  console.log(`=== PARTNER_ID=${PARTNER_ID} Fleet Push (${mode.toUpperCase()}) ===\n`);

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, assigned_to, health_status")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .not("ip_address", "is", null)
    .order("name");

  if (!vms?.length) { console.log("No VMs found."); return; }
  console.log(`Found ${vms.length} assigned VMs.\n`);

  if (mode === "dry-run") {
    for (const vm of vms) console.log(`  ${vm.name} (${vm.ip_address})`);
    console.log(`\nWould inject PARTNER_ID=${PARTNER_ID} on ${vms.length} VMs. Run with --test-first.`);
    return;
  }

  if (mode === "test-first") {
    const testVm = vms[0];
    console.log(`Testing on ${testVm.name} (${testVm.ip_address})...\n`);
    const [result] = await runBatch([testVm]);
    if (!result.ok) { console.error(`\nTest FAILED.`); process.exit(1); }
    console.log(`\nTest PASS. Run with --all for remaining ${vms.length - 1} VMs.`);
    return;
  }

  // --all
  console.log(`Deploying to ${vms.length} VMs (${CONCURRENCY} concurrent)...\n`);
  const results = await runBatch(vms);

  const ok = results.filter(r => r.ok).length;
  const withAcp = results.filter(r => r.hasAcp).length;
  const failed = results.filter(r => !r.ok);
  console.log(`\n=== DONE: ${ok}/${vms.length} verified, ${withAcp} have ACP, ${failed.length} issues ===`);
  if (failed.length) {
    console.log("\nIssues:");
    for (const f of failed) console.log(`  ${f.vm}: ${f.error}`);
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
