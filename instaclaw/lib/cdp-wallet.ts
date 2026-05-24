/**
 * Coinbase Developer Platform (CDP) backup-wallet provisioning.
 *
 * CDP is the InstaClaw agent's BACKUP wallet — server-managed via
 * Coinbase's MPC custody. It runs ADDITIVELY alongside Bankr (the
 * primary wallet) so paying users have continuity when Bankr is in
 * maintenance or otherwise unavailable.
 *
 * Single-responsibility: this helper only talks to Coinbase CDP +
 * Supabase. It does NOT SSH to the VM, write to ~/.openclaw/.env, or
 * restart the gateway — those are separate concerns handled by
 * configureOpenClaw(), the cloud-init tarball builder, or the
 * provision-missing-cdp-wallets backfill cron.
 *
 * Callers:
 *  - app/api/vm/assign/route.ts — runs FIRST during VM assignment,
 *    BEFORE Bankr (Cooper's "CDP is the reliable baseline"). Provides
 *    a working EVM receive address even if Bankr provisioning fails.
 *  - app/api/billing/webhook/route.ts — Stripe webhook path, same
 *    rationale.
 *  - app/api/cron/provision-missing-cdp-wallets/route.ts — every
 *    30 min safety net for any VM that doesn't yet have a CDP wallet.
 *
 * ────────────────────────────────────────────────────────────────────
 * CRITICAL ARCHITECTURAL DIFFERENCE FROM BANKR (Rule 38 + Rule 41):
 *
 *   Bankr accepts an idempotencyKey on POST /partner/wallets — re-runs
 *   return the SAME wallet via a 409 response. So bankr-provision.ts
 *   safely calls the API on every invocation without checking the DB.
 *
 *   CDP has NO idempotency key. `cdp.evm.createAccount()` creates a
 *   NEW account on every call. Calling it twice for the same VM would
 *   leave one orphan account in Coinbase's custody forever (we can
 *   never delete CDP accounts; they accumulate inert in our org).
 *
 *   Therefore this helper MUST check `instaclaw_vms.cdp_wallet_address`
 *   FIRST and short-circuit-return if a wallet already exists. Re-runs
 *   become no-ops, never new mints.
 * ────────────────────────────────────────────────────────────────────
 *
 * Fail-soft: if `CDP_API_KEY_ID`/`_SECRET`/`_WALLET_SECRET` are missing
 * or the API call fails, returns null and logs a warning. Callers
 * should null-check; VM assignment must NEVER block on CDP. The next
 * /api/cron/provision-missing-cdp-wallets run picks the VM back up.
 *
 * NO `isBankrMaintenance` gate — CDP is precisely the backup that
 * must continue working when Bankr is down. Inverse of bankr-provision.ts.
 */

import { CdpClient } from "@coinbase/cdp-sdk";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// 15s budget for the Coinbase API call. Production CDP endpoints
// usually return in <500ms; the timeout exists to bound configure-time
// latency if Coinbase is degraded. Matches the root lib/cdp.ts budget
// that's been in production since 2026-02 with no observed timeouts.
const CDP_CREATE_TIMEOUT_MS = 15_000;

let _client: InstanceType<typeof CdpClient> | null = null;

/**
 * Lazy singleton CdpClient. The SDK reads three env vars; we read them
 * here at first-call time (not module-load time) so a missing var
 * raises a recognizable error rather than crashing the module import.
 */
function getClient(): InstanceType<typeof CdpClient> {
  if (_client) return _client;
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  if (!apiKeyId || !apiKeySecret) {
    throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set");
  }
  _client = new CdpClient({
    apiKeyId,
    apiKeySecret,
    walletSecret: walletSecret || undefined,
  });
  return _client;
}

/** All three CDP env vars present. Callers can short-circuit cleanly. */
export function isCdpConfigured(): boolean {
  return !!(
    process.env.CDP_API_KEY_ID &&
    process.env.CDP_API_KEY_SECRET &&
    process.env.CDP_WALLET_SECRET
  );
}

/** Standard 0x-prefixed 40-hex-char EVM address shape. */
export function isValidCdpWalletAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export interface ProvisionCdpWalletOptions {
  /** VM row id — where the provisioned wallet gets written. */
  vmId: string;
  /** User id — for logs. CDP wallets are bound to VMs, not users
   *  directly (mirrors Bankr's per-VM provisioning). */
  userId: string;
}

export interface ProvisionCdpWalletResult {
  walletId: string;
  evmAddress: string;
  /** True if this call short-circuited on an existing DB row. False
   *  if a fresh CDP account was created during this call. Useful for
   *  metrics + the backfill cron's result classification. */
  alreadyExisted: boolean;
}

/**
 * Provision a CDP backup wallet for a VM, or return the existing one
 * if already provisioned.
 *
 * Side effects (on fresh mint only):
 *  - Calls `cdp.evm.createAccount()` against Coinbase Developer Platform.
 *  - Writes `cdp_wallet_id` + `cdp_wallet_address` to instaclaw_vms.{vmId}.
 *  - Emits logger.info on success, logger.warn on any non-fatal failure.
 *
 * Returns null on:
 *  - CDP env vars not configured (silent skip — safe default).
 *  - Any error during the Coinbase API call or DB write.
 *
 * Returns ProvisionCdpWalletResult with alreadyExisted=true on:
 *  - Existing cdp_wallet_address found in DB (no API call made).
 *
 * Returns ProvisionCdpWalletResult with alreadyExisted=false on:
 *  - Fresh CDP account created + persisted successfully.
 */
export async function provisionCdpWallet(
  opts: ProvisionCdpWalletOptions,
): Promise<ProvisionCdpWalletResult | null> {
  const { vmId, userId } = opts;

  // Silent skip when CDP isn't configured (e.g., local dev without
  // Coinbase keys, or rollback by env-var-unset). Same behavior shape
  // as bankr-provision when BANKR_PARTNER_KEY is missing. The cron
  // safety net picks up later if/when keys are added.
  if (!isCdpConfigured()) {
    return null;
  }

  const supabase = getSupabase();

  // ── Idempotency gate: DB first ────────────────────────────────────
  // Because CDP has no idempotency key on createAccount, we MUST read
  // the DB before calling the API. Otherwise a retried route handler,
  // a concurrent /api/vm/assign + /api/billing/webhook race, or the
  // backfill cron racing the assign path would mint orphan accounts.
  //
  // .select("*") would be Rule-19-safe but we only need two columns;
  // these are simple text columns with no RLS overlay, so explicit
  // select is fine here.
  try {
    const { data: existing, error: readErr } = await supabase
      .from("instaclaw_vms")
      .select("cdp_wallet_id, cdp_wallet_address")
      .eq("id", vmId)
      .single();

    if (readErr) {
      logger.warn("provisionCdpWallet: DB pre-check failed (non-fatal)", {
        route: "lib/cdp-wallet",
        vmId,
        userId,
        error: readErr.message,
        code: readErr.code,
      });
      // Continue to attempt provisioning — better to risk a dup row
      // (unique partial index will reject it) than to leave the VM
      // without a backup wallet because of a transient PostgREST blip.
    } else if (
      existing?.cdp_wallet_id &&
      existing?.cdp_wallet_address &&
      isValidCdpWalletAddress(existing.cdp_wallet_address)
    ) {
      // Already provisioned — short-circuit. This is the idempotent
      // re-entry path that prevents orphan accumulation.
      return {
        walletId: existing.cdp_wallet_id,
        evmAddress: existing.cdp_wallet_address,
        alreadyExisted: true,
      };
    }
    // Either no row, no wallet on row, or invalid-shape address →
    // fall through to mint. The unique partial index on
    // cdp_wallet_address protects against duplicate inserts even in
    // the race case.
  } catch (preCheckErr) {
    logger.warn("provisionCdpWallet: DB pre-check threw (non-fatal)", {
      route: "lib/cdp-wallet",
      vmId,
      userId,
      error: preCheckErr instanceof Error ? preCheckErr.message : String(preCheckErr),
    });
    // Same posture as above — fall through.
  }

  // ── Fresh mint ────────────────────────────────────────────────────
  try {
    const cdp = getClient();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`CDP createAccount timed out after ${CDP_CREATE_TIMEOUT_MS}ms`)),
        CDP_CREATE_TIMEOUT_MS,
      ),
    );
    const account = await Promise.race([cdp.evm.createAccount(), timeout]);

    if (!account?.address || !isValidCdpWalletAddress(account.address)) {
      logger.warn("provisionCdpWallet: CDP returned invalid account shape", {
        route: "lib/cdp-wallet",
        vmId,
        userId,
        receivedAddress: account?.address ?? null,
      });
      return null;
    }

    // CDP SDK uses the EVM address as the account identifier. We
    // store both columns for clarity + forward-compat in case CDP
    // ever introduces a separate ID type.
    const walletId = account.address;
    const evmAddress = account.address;

    const { error: writeErr } = await supabase
      .from("instaclaw_vms")
      .update({
        cdp_wallet_id: walletId,
        cdp_wallet_address: evmAddress,
      })
      .eq("id", vmId);

    if (writeErr) {
      // Unique constraint violation on cdp_wallet_address means another
      // concurrent call beat us to it. The mint above is now an orphan
      // (cannot be deleted in CDP), but we have no way to recover.
      // Surface loudly so the orphan rate can be monitored.
      logger.warn("provisionCdpWallet: DB write failed after mint (likely concurrent race; orphan CDP account)", {
        route: "lib/cdp-wallet",
        vmId,
        userId,
        evmAddress,
        error: writeErr.message,
        code: writeErr.code,
      });
      return null;
    }

    logger.info("CDP backup wallet provisioned", {
      route: "lib/cdp-wallet",
      vmId,
      userId,
      walletId,
      evmAddress,
    });

    return { walletId, evmAddress, alreadyExisted: false };
  } catch (err) {
    logger.warn("provisionCdpWallet: provisioning error (non-fatal)", {
      route: "lib/cdp-wallet",
      vmId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Best-effort USDC-on-Base balance lookup for a CDP address. Read-only,
 * not on the hot provisioning path. Exposed for future dashboard /
 * admin tooling (e.g., "how much value is sitting in backup wallets
 * across the fleet"). Returns "0" on any error so callers can render
 * without null-checking.
 */
export async function getCdpUsdcBalance(address: string): Promise<string> {
  if (!isCdpConfigured()) return "0";
  if (!isValidCdpWalletAddress(address)) return "0";
  try {
    const cdp = getClient();
    const result = await cdp.evm.listTokenBalances({
      address: address as `0x${string}`,
      network: "base",
    });
    const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const usdc = result.balances.find(
      (b: { token: { contractAddress?: string } }) =>
        b.token.contractAddress?.toLowerCase() === USDC_BASE,
    );
    return usdc ? String(usdc.amount) : "0";
  } catch {
    return "0";
  }
}
