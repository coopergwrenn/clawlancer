#!/usr/bin/env tsx
/**
 * One-off: stand up the Frontier spend canary on coopergrantwrenn@gmail.com
 * (66afc149) using the audited pool-assign + wallet pipeline. Cooper-approved
 * Rule-8 exception (pool-assign, not manual Linode provision).
 *
 * Steps here (1–3): cron lock → assignOrProvisionUserVm (pool-first; STOP if
 * pool empty) → provisionBankrWallet + provisionCdpWallet. Configure runs next
 * via the real /api/vm/configure route (X-Admin-Key) so it's identical to a
 * real customer. Run: npx tsx scripts/_canary-frontier-provision.ts
 */
import { readFileSync } from "node:fs";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local", "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key"]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* optional */ }
}

import { tryAcquireCronLock, releaseCronLock } from "../lib/cron-lock";
import { assignOrProvisionUserVm } from "../lib/createUserVM";
import { provisionBankrWallet } from "../lib/bankr-provision";
import { provisionCdpWallet } from "../lib/cdp-wallet";
import { getSupabase } from "../lib/supabase";

const USER_ID = "66afc149-5597-49a0-ad09-eeac7e6dcf1d"; // coopergrantwrenn@gmail.com (clean — vm-050 stays on coopgwrenn@)

async function main() {
  const supabase = getSupabase();

  console.log("[1] acquiring replenish-pool cron lock (Rule 8)…");
  const lock = await tryAcquireCronLock("replenish-pool", 600, "canary-frontier-provision");
  if (!lock) {
    console.error("ABORT: replenish-pool cron is running. Try again shortly.");
    process.exit(1);
  }

  try {
    console.log("[2] assignOrProvisionUserVm (pool-first)…");
    const res = await assignOrProvisionUserVm(USER_ID);
    if (!res) {
      console.error("ABORT: assign returned null (pool empty + cloud-init disabled). NOT triggering a manual Linode provision — surfacing to Cooper.");
      process.exit(2);
    }
    console.log(`    → vmId=${res.vmId} ip=${res.ipAddress} source=${res.source}`);
    if (res.source !== "pool") {
      console.log(`    NOTE: source=${res.source} (not a fast pool claim) — continuing.`);
    }

    const ip = res.ipAddress;
    const vmId = res.vmId;

    console.log("[3a] provisionBankrWallet…");
    const bankr = await provisionBankrWallet({ vmId, userId: USER_ID, vmIp: ip, idempotencyKey: `canary-bankr-${vmId}` });
    console.log("    bankr:", bankr ? JSON.stringify({ address: bankr.evmAddress ?? (bankr as Record<string, unknown>).address }) : "null (maintenance or missing partner key)");

    console.log("[3b] provisionCdpWallet…");
    const cdp = await provisionCdpWallet({ vmId, userId: USER_ID });
    console.log("    cdp:", cdp ? JSON.stringify({ address: (cdp as Record<string, unknown>).address ?? (cdp as Record<string, unknown>).cdpWalletAddress }) : "null");

    // Re-fetch the row to confirm wallet fields persisted (Rule 19: select *).
    const { data: vm } = await supabase.from("instaclaw_vms").select("*").eq("id", vmId).single();
    console.log("\n=== CANARY VM PROVISIONED (pre-configure) ===");
    console.log(JSON.stringify({
      name: vm?.name, ip: vm?.ip_address, status: vm?.status, health: vm?.health_status,
      tier: vm?.tier, api_mode: vm?.api_mode,
      bankr_evm_address: vm?.bankr_evm_address,
      bankr_api_key_present: !!vm?.bankr_api_key,
      cdp_wallet_address: vm?.cdp_wallet_address ?? null,
      gateway_token_present: !!vm?.gateway_token,
    }, null, 2));
    console.log("\nNEXT: configure via POST /api/vm/configure (X-Admin-Key, userId=" + USER_ID + ")");
  } finally {
    await releaseCronLock("replenish-pool");
    console.log("[lock] released replenish-pool");
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
