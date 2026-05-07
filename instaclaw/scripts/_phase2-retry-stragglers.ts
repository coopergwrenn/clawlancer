/**
 * Phase 2 retries — handle the two simple failure cases from the main run:
 *   - vm-726 (ssh-failed): wallet provisioned, just retry the SSH .env write
 *   - vm-831 (provision-failed null): retry provisionBankrWallet
 *
 * The 4 "no bankr_api_key_encrypted" cases (vm-855/868/881/897) are NOT
 * handled here — they're idempotency-409 orphan-wallet cases that need a
 * versioned key. Phase 4 cron handles those.
 */
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import { config } from "dotenv";
import { resolve } from "path";
import { provisionBankrWallet } from "../lib/bankr-provision";
import { decryptBankrKey } from "../lib/bankr-encryption";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.production.local"), override: false });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

async function retrySshOnly(vmId: string) {
  const { data: vm } = await sb.from("instaclaw_vms").select("name, ip_address, ssh_port, ssh_user, bankr_evm_address, bankr_api_key_encrypted").eq("id", vmId).single();
  if (!vm?.bankr_api_key_encrypted || !vm?.bankr_evm_address) {
    console.log(`[${vmId}] cannot retry SSH-only — bankr_api_key_encrypted or bankr_evm_address missing.`);
    return false;
  }
  const plainApiKey = decryptBankrKey(vm.bankr_api_key_encrypted);
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: vm.ip_address, username: vm.ssh_user ?? "openclaw", port: vm.ssh_port ?? 22, privateKey, readyTimeout: 15_000 });
    const r = await ssh.execCommand([
      'touch "$HOME/.openclaw/.env"',
      `K=${JSON.stringify(plainApiKey)}`,
      `A=${JSON.stringify(vm.bankr_evm_address)}`,
      'grep -q "^BANKR_API_KEY=" "$HOME/.openclaw/.env" && sed -i "s|^BANKR_API_KEY=.*|BANKR_API_KEY=$K|" "$HOME/.openclaw/.env" || echo "BANKR_API_KEY=$K" >> "$HOME/.openclaw/.env"',
      'grep -q "^BANKR_WALLET_ADDRESS=" "$HOME/.openclaw/.env" && sed -i "s|^BANKR_WALLET_ADDRESS=.*|BANKR_WALLET_ADDRESS=$A|" "$HOME/.openclaw/.env" || echo "BANKR_WALLET_ADDRESS=$A" >> "$HOME/.openclaw/.env"',
      'chmod 600 "$HOME/.openclaw/.env"',
      'grep -E "^BANKR_(API_KEY|WALLET_ADDRESS)=" "$HOME/.openclaw/.env" | wc -l',
    ].join('\n'));
    const ok = parseInt((r.stdout || "0").trim(), 10) >= 2;
    console.log(`[${vm.name}] SSH-only retry: ${ok ? "✓ env written" : "✗ failed"}`);
    return ok;
  } catch (e: unknown) {
    console.log(`[${vm.name}] SSH retry failed:`, e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    ssh.dispose();
  }
}

async function retryProvision(vmId: string) {
  const { data: vm } = await sb.from("instaclaw_vms").select("name, ip_address, assigned_to").eq("id", vmId).single();
  if (!vm) { console.log(`[${vmId}] vm not found`); return false; }
  const result = await provisionBankrWallet({
    vmId,
    userId: vm.assigned_to,
    vmIp: vm.ip_address,
    idempotencyKey: `instaclaw_user_${vm.assigned_to}`,
  });
  if (!result) { console.log(`[${vm.name}] provision retry: ✗ still null`); return false; }
  console.log(`[${vm.name}] provision retry: ✓ wallet=${result.walletId}, evm=${result.evmAddress}`);
  return await retrySshOnly(vmId);
}

(async () => {
  console.log("\n=== Phase 2 retries ===\n");
  console.log("Retry vm-726 (ssh-failed):");
  await retrySshOnly("c8b6e9de-271d-4bf3-b54f-0916533aca0d");
  console.log("\nRetry vm-831 (provision-failed null):");
  await retryProvision("cef5b6e1-a83c-419f-bf2a-b0a76b262ee0");
  console.log("");
})();
