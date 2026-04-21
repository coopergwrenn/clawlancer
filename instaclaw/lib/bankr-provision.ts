/**
 * Bankr wallet provisioning — mints a new wallet via the Partner API, encrypts
 * the returned agent API key, and persists wallet identifiers to the VM row.
 *
 * Single-responsibility: this helper only talks to Bankr + Supabase. It does NOT
 * SSH to the VM, write to ~/.openclaw/.env, or restart the gateway — those are
 * separate concerns handled by configureOpenClaw() or a reset script composing
 * this helper with its own SSH steps.
 *
 * Callers:
 *  - app/api/billing/webhook/route.ts — on VM assignment, uses the default
 *    idempotency key `instaclaw_user_${userId}` (idempotent across webhook retries)
 *  - scripts/_reset-edgecitybot-reprovision.ts — reset flow uses a distinct key
 *    like `instaclaw_reset_${userId}_${timestamp}` to force a NEW wallet
 *
 * Non-fatal: if BANKR_PARTNER_KEY is missing or the API call fails, returns
 * null and logs a warning. Callers should null-check; billing's fail-soft
 * contract stays intact.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { encryptBankrKey } from "@/lib/bankr-encryption";

const BANKR_API_URL = "https://api.bankr.bot";

export interface ProvisionBankrWalletOptions {
  /** VM row id — where the provisioned wallet gets written */
  vmId: string;
  /** User id — for logs + default idempotency key construction in callers */
  userId: string;
  /** VM IP — locks the returned API key to that source IP */
  vmIp: string;
  /**
   * Idempotency key sent to Bankr. Required — no hidden defaults.
   * Billing webhook passes `instaclaw_user_${userId}` (retries return the same wallet).
   * Reset script passes a unique key (e.g. `instaclaw_reset_${userId}_${ts}`) to force
   * a fresh wallet.
   */
  idempotencyKey: string;
}

export interface ProvisionBankrWalletResult {
  walletId: string;
  evmAddress: string;
}

/**
 * Provision a Bankr wallet under the current BANKR_PARTNER_KEY. Returns the
 * new wallet id + EVM address on success, or null on any non-fatal failure.
 *
 * Side effects:
 *  - Calls POST /partner/wallets on api.bankr.bot
 *  - Writes bankr_wallet_id, bankr_evm_address, bankr_api_key_encrypted to instaclaw_vms.{vmId}
 *  - Emits logger.info on success, logger.warn on any failure
 */
export async function provisionBankrWallet(
  opts: ProvisionBankrWalletOptions,
): Promise<ProvisionBankrWalletResult | null> {
  const { vmId, userId, vmIp, idempotencyKey } = opts;

  const partnerKey = process.env.BANKR_PARTNER_KEY;
  if (!partnerKey) return null; // Not configured — silent skip (preserves billing fail-soft)

  try {
    const res = await fetch(`${BANKR_API_URL}/partner/wallets`, {
      method: "POST",
      headers: {
        "x-partner-key": partnerKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotencyKey,
        apiKey: {
          permissions: {
            agentApiEnabled: true,
            llmGatewayEnabled: false,
            readOnly: false,
          },
          allowedIps: [vmIp],
        },
      }),
    });

    // 409 = idempotency key already used — wallet already exists, treat as success.
    // Bankr still returns the existing wallet's info in the body for 409s.
    if (!res.ok && res.status !== 409) {
      const errText = await res.text().catch(() => "unknown");
      logger.warn("Bankr wallet provisioning failed (non-fatal)", {
        status: res.status,
        error: errText.slice(0, 300),
        userId,
        vmId,
        idempotencyKey,
      });
      return null;
    }

    const data = await res.json();
    const supabase = getSupabase();

    // Encrypt the API key before storing — plaintext only exists in memory.
    let encryptedKey: string | null = null;
    if (data.apiKey) {
      try {
        encryptedKey = encryptBankrKey(data.apiKey);
      } catch (encErr) {
        logger.warn("Bankr API key encryption failed — storing null", {
          error: String(encErr),
          vmId,
        });
      }
    }

    await supabase
      .from("instaclaw_vms")
      .update({
        bankr_wallet_id: data.id ?? null,
        bankr_evm_address: data.evmAddress ?? null,
        bankr_api_key_encrypted: encryptedKey,
      })
      .eq("id", vmId);

    logger.info("Bankr wallet provisioned", {
      vmId,
      userId,
      walletId: data.id,
      evmAddress: data.evmAddress,
      idempotencyKey,
    });

    if (!data.id || !data.evmAddress) {
      // Shouldn't happen — Bankr always returns both — but guard for the type contract.
      logger.warn("Bankr wallet response missing id or evmAddress", { vmId, data });
      return null;
    }

    return { walletId: data.id, evmAddress: data.evmAddress };
  } catch (err) {
    logger.warn("Bankr wallet provisioning error (non-fatal)", {
      error: String(err),
      userId,
      vmId,
      idempotencyKey,
    });
    return null;
  }
}
