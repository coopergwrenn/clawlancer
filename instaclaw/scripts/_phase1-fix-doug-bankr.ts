/**
 * Phase 1 — Doug Rathell (vm-725) Bankr fix.
 *
 * Doug's VM was assigned 2026-04-08, before BANKR_PARTNER_KEY was active in
 * production. The Stripe webhook fired provisionBankrWallet but the helper
 * returned null silently. DB Bankr fields stayed NULL. configureOpenClaw
 * never wrote BANKR_API_KEY to ~/.openclaw/.env. The agent improvised by
 * running `bankr login` against Doug's personal account → 403 on launch.
 *
 * This script — idempotent, single-VM scope:
 *   1. Confirm pre-state (sanity)
 *   2. provisionBankrWallet (DB write)
 *   3. Re-read DB, decrypt the API key
 *   4. SSH to write BANKR_API_KEY + BANKR_WALLET_ADDRESS to .env
 *   5. SSH to rename ~/.bankr/config.json → .predoug-personal-bak (force
 *      bankr CLI to use env-var auth instead of Doug's user-account)
 *   6. SSH to scrub "VM fork limits" lies from MEMORY.md + session-log.md
 *   7. Restart gateway, verify health
 *
 * Phase 5 cleans memory more aggressively — this script does the minimum
 * needed for Doug to launch today.
 */

import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import { config } from "dotenv";
import { resolve } from "path";
import { provisionBankrWallet } from "../lib/bankr-provision";
import { decryptBankrKey } from "../lib/bankr-encryption";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.production.local"), override: false });

const VM_ID = "f6d90080-913b-456e-ac2a-8a0142a4c406";
const USER_ID = "5689bff7-7a5e-402f-b5c3-a9fb87875c5f";
const VM_IP = "45.33.74.65";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

function log(stage: string, msg: string) {
  console.log(`[${stage}] ${msg}`);
}

async function main() {
  log("init", `Doug fix starting — vm-725 (${VM_IP}), user ${USER_ID}`);

  // ── Step 1: pre-state sanity ──────────────────────────────────────────
  const { data: pre } = await sb
    .from("instaclaw_vms")
    .select("id, name, status, assigned_to, ip_address, bankr_wallet_id, bankr_evm_address, bankr_api_key_encrypted")
    .eq("id", VM_ID)
    .single();
  if (!pre) throw new Error("vm-725 not found");
  if (pre.assigned_to !== USER_ID) {
    throw new Error(`Ownership mismatch: vm assigned_to=${pre.assigned_to} != ${USER_ID}`);
  }
  if (pre.ip_address !== VM_IP) {
    throw new Error(`IP changed: vm.ip=${pre.ip_address} != ${VM_IP}. Aborting — VM may have been re-provisioned.`);
  }
  if (pre.bankr_wallet_id) {
    log("init", `WARNING: bankr_wallet_id already set (${pre.bankr_wallet_id}). Idempotency will return existing wallet via 409.`);
  } else {
    log("init", "Pre-state: bankr_wallet_id NULL (expected).");
  }

  // ── Step 2: provisionBankrWallet ─────────────────────────────────────
  log("provision", "Calling provisionBankrWallet…");
  const result = await provisionBankrWallet({
    vmId: VM_ID,
    userId: USER_ID,
    vmIp: VM_IP,
    idempotencyKey: `instaclaw_user_${USER_ID}`,
  });
  if (!result) {
    throw new Error("provisionBankrWallet returned null. Check logger.warn output above for Bankr API failure detail.");
  }
  log("provision", `Wallet provisioned: walletId=${result.walletId}, evmAddress=${result.evmAddress}`);

  // ── Step 3: re-read DB, decrypt the API key ──────────────────────────
  const { data: post } = await sb
    .from("instaclaw_vms")
    .select("bankr_wallet_id, bankr_evm_address, bankr_api_key_encrypted")
    .eq("id", VM_ID)
    .single();
  if (!post?.bankr_wallet_id || !post?.bankr_evm_address) {
    throw new Error("DB write didn't land — wallet_id or evm_address still null after provision.");
  }
  if (!post.bankr_api_key_encrypted) {
    throw new Error("bankr_api_key_encrypted is null. Bankr API may not have returned an apiKey, or encryption failed.");
  }
  const plainApiKey = decryptBankrKey(post.bankr_api_key_encrypted);
  if (!plainApiKey || !plainApiKey.startsWith("bk_")) {
    throw new Error(`Decrypted key looks wrong (starts with ${plainApiKey.slice(0, 6)}...).`);
  }
  log("decrypt", `Decrypted API key OK (prefix ${plainApiKey.slice(0, 7)}...).`);

  // ── Step 4-7: SSH operations ──────────────────────────────────────────
  const ssh = new NodeSSH();
  await ssh.connect({ host: VM_IP, username: "openclaw", privateKey, readyTimeout: 10_000 });
  log("ssh", `Connected to ${VM_IP}.`);

  // Step 4: write BANKR_API_KEY + BANKR_WALLET_ADDRESS to .env.
  // Mirror configureOpenClaw lib/ssh.ts:4661-4672. sed delimiter `|` because
  // the key contains underscores (no slashes, but `|` is safer regardless).
  const envWrite = await ssh.execCommand([
    'touch "$HOME/.openclaw/.env"',
    `K=${JSON.stringify(plainApiKey)}`,
    `A=${JSON.stringify(result.evmAddress)}`,
    'grep -q "^BANKR_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null && \\',
    '  sed -i "s|^BANKR_API_KEY=.*|BANKR_API_KEY=$K|" "$HOME/.openclaw/.env" || \\',
    '  echo "BANKR_API_KEY=$K" >> "$HOME/.openclaw/.env"',
    'grep -q "^BANKR_WALLET_ADDRESS=" "$HOME/.openclaw/.env" 2>/dev/null && \\',
    '  sed -i "s|^BANKR_WALLET_ADDRESS=.*|BANKR_WALLET_ADDRESS=$A|" "$HOME/.openclaw/.env" || \\',
    '  echo "BANKR_WALLET_ADDRESS=$A" >> "$HOME/.openclaw/.env"',
    'chmod 600 "$HOME/.openclaw/.env"',
    'echo "ENV_WRITE_OK"',
    'grep -E "^BANKR_(API_KEY|WALLET_ADDRESS)=" "$HOME/.openclaw/.env" | sed "s/=.*/=<SET>/"',
  ].join('\n'));
  if (!envWrite.stdout.includes("ENV_WRITE_OK")) {
    ssh.dispose();
    throw new Error(`env write failed:\nstdout=${envWrite.stdout}\nstderr=${envWrite.stderr}`);
  }
  log("env", envWrite.stdout.trim().split("\n").slice(-2).join(" "));

  // Step 5: rename ~/.bankr/config.json so bankr CLI falls back to env.
  // Use a timestamped backup so re-runs don't clobber an existing backup.
  const renameOut = await ssh.execCommand([
    'if [ -f "$HOME/.bankr/config.json" ]; then',
    '  TS=$(date +%s)',
    '  mv "$HOME/.bankr/config.json" "$HOME/.bankr/config.json.predoug-personal-$TS.bak"',
    '  echo "RENAMED to .predoug-personal-$TS.bak"',
    'else',
    '  echo "NO_PERSONAL_CONFIG (already absent or never existed)"',
    'fi',
    'ls -la "$HOME/.bankr/" 2>&1 | head -5',
  ].join('\n'));
  log("bankr-config", renameOut.stdout.split("\n").filter(Boolean).join(" / "));

  // Step 6: scrub "VM fork limits" sentences from MEMORY.md + session-log.md.
  // MINIMAL scrub here — Phase 5 will do the full hygiene pass. Python
  // source is base64'd to avoid multi-layer quoting issues (same pattern
  // the reconciler uses in lib/vm-reconcile.ts).
  const SCRUB_PY = `import os, re
paths = [
  os.path.expanduser("~/.openclaw/workspace/MEMORY.md"),
  os.path.expanduser("~/.openclaw/workspace/memory/session-log.md"),
]
patterns = [
  r"VM fork limits",
  r"VM resource constraints",
  r"VM fork limit issues",
  r"InstaClaw support restart",
]
marker = "<!-- SCRUBBED 2026-05-07 by InstaClaw: bankr-launch issue resolved by provisioning the InstaClaw-managed wallet. The VM-fork-limits diagnosis was incorrect; the actual issue was missing BANKR_API_KEY in .env. -->"
changed = []
for p in paths:
  if not os.path.exists(p):
    continue
  with open(p, "r") as f:
    content = f.read()
  hits = sum(len(re.findall(pat, content, flags=re.IGNORECASE)) for pat in patterns)
  if hits == 0:
    continue
  if marker not in content:
    content = marker + "\\n\\n" + content
  for pat in patterns:
    content = re.sub(pat, "[scrubbed: was-wrong-diagnosis]", content, flags=re.IGNORECASE)
  with open(p, "w") as f:
    f.write(content)
  changed.append((p, hits))
for p, h in changed:
  print("SCRUBBED " + p + " hits=" + str(h))
if not changed:
  print("NO_SCRUB_NEEDED")
`;
  const scrubB64 = Buffer.from(SCRUB_PY, "utf-8").toString("base64");
  const scrubOut = await ssh.execCommand(`echo '${scrubB64}' | base64 -d | python3`);
  log("memory-scrub", scrubOut.stdout.trim() || "(no output)");

  // Step 7: restart gateway + verify
  log("restart", "Restarting gateway…");
  const restartOut = await ssh.execCommand([
    'export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
    'systemctl --user restart openclaw-gateway',
    'sleep 6',
    'systemctl --user is-active openclaw-gateway',
    'curl -s -m 5 http://localhost:18789/health -w " (HTTP %{http_code})\\n" 2>&1 | tail -2',
  ].join('\n'));
  log("restart", restartOut.stdout.trim());
  const isActive = restartOut.stdout.includes("active");
  if (!isActive) {
    ssh.dispose();
    throw new Error("Gateway not active after restart. Manual investigation needed.");
  }

  // Step 8: post-fix sanity — bankr CLI now reports the env key, not Doug's
  const finalCheck = await ssh.execCommand([
    'source ~/.nvm/nvm.sh',
    'set -a; source ~/.openclaw/.env 2>/dev/null; set +a',
    'echo "=== bankr whoami (env-key now in effect) ==="',
    'bankr whoami 2>&1 | head -10',
  ].join('\n'));
  log("verify", finalCheck.stdout.trim());

  ssh.dispose();

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("✅ Phase 1 complete for vm-725 (Doug Rathell).");
  console.log(`   Wallet ID:      ${result.walletId}`);
  console.log(`   EVM Address:    ${result.evmAddress}`);
  console.log("   Tell Doug: 'go to instaclaw.io/dashboard, click Launch Token. Gas is on us.'");
  console.log("──────────────────────────────────────────────────────────────\n");
}

main().catch((e) => {
  console.error("\n❌ Phase 1 FAILED:", e.message);
  process.exit(1);
});
