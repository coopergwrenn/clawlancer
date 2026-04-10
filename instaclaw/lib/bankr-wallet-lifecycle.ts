/**
 * Bankr wallet lifecycle helpers — suspend / resume / close.
 *
 * These hook into our VM lifecycle (reclaim, resubscribe) to keep the Bankr
 * wallet's status aligned with the user's subscription state. All operations
 * are NON-FATAL — if Bankr's API is down, the local lifecycle action still
 * proceeds. We log the failure for manual reconciliation later.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const BANKR_API_URL = "https://api.bankr.bot";

type LifecycleAction = "suspend" | "resume" | "close";

/**
 * Looks up the VM's bankr_wallet_id and calls the corresponding lifecycle
 * endpoint on Bankr's partner API. Non-fatal — returns false if anything fails,
 * but never throws.
 *
 * IMPORTANT: Call this BEFORE clearing bankr_wallet_id from the DB (e.g.
 * before instaclaw_reclaim_vm()), otherwise we lose the wallet ID needed
 * to make the API call.
 */
export async function bankrWalletLifecycle(
  vmId: string,
  action: LifecycleAction
): Promise<{ success: boolean; status?: string; error?: string }> {
  const partnerKey = process.env.BANKR_PARTNER_KEY;
  if (!partnerKey) {
    // Not configured — silent skip
    return { success: false, error: "BANKR_PARTNER_KEY not configured" };
  }

  try {
    const supabase = getSupabase();
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("bankr_wallet_id")
      .eq("id", vmId)
      .single();

    if (!vm?.bankr_wallet_id) {
      // No Bankr wallet provisioned for this VM — nothing to do
      return { success: true, status: "no_wallet" };
    }

    const res = await fetch(
      `${BANKR_API_URL}/partner/wallets/${vm.bankr_wallet_id}/${action}`,
      {
        method: "POST",
        headers: {
          "X-Partner-Key": partnerKey,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      logger.warn(`Bankr wallet ${action} failed (non-fatal)`, {
        status: res.status,
        error: errText,
        vmId,
        walletId: vm.bankr_wallet_id,
      });
      return { success: false, error: `${res.status}: ${errText.slice(0, 200)}` };
    }

    const data = (await res.json().catch(() => ({}))) as { status?: string };
    logger.info(`Bankr wallet ${action} succeeded`, {
      vmId,
      walletId: vm.bankr_wallet_id,
      status: data.status,
    });
    return { success: true, status: data.status };
  } catch (err) {
    logger.warn(`Bankr wallet ${action} error (non-fatal)`, {
      error: String(err),
      vmId,
    });
    return { success: false, error: String(err).slice(0, 200) };
  }
}
