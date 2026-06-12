/**
 * Frontier human_approved hardening -- the I/O side (Surfaces 1 + 3).
 *
 * The pure logic (identity match, TTL, token HMAC, the tiered decision) lives in
 * lib/frontier-approvals.ts + lib/frontier-authz.ts. This module is its DB + Telegram
 * shell, kept out of the authorize route so the route stays readable:
 *
 *   - lookupApproval        read the (vm_id, request_id) approval row
 *   - mintPendingApproval   on ask_first, capture the EXACT proposed spend so the
 *                           human approves precisely that (anti-amount-swap); returns
 *                           the approval id + the session-authed confirm URL
 *   - consumeApproval       single-use: mark an honored approval consumed
 *   - sendForgeableSpendNotification  the out-of-band detection push for a
 *                           forgeable-honored spend + a one-tap revoke URL-button
 *   - requireSessionApprovalAboveThreshold  the phase-3 flip flag (Rule 61)
 *
 * Everything is best-effort and fail-safe: a Telegram failure never blocks a spend;
 * a missing approvals table (pre-migration) degrades to "no approval" (the forgeable
 * + autonomy paths still work), never a 500.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTelegramMessageWithButton, discoverTelegramChatId } from "@/lib/telegram";
import { signRevokeToken, APPROVAL_TTL_MS, type ApprovalRow } from "@/lib/frontier-approvals";
import { logger } from "@/lib/logger";

const APP_URL =
  process.env.INSTACLAW_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "https://instaclaw.io";

const APPROVALS_TABLE = "instaclaw_frontier_spend_approvals";

/** PostgREST/Postgres "table or column absent" -> pre-migration; degrade, never 500. */
function isMissingRelationError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703" || err.code === "PGRST204" || err.code === "PGRST205") return true;
  return /(does not exist|schema cache|could not find)/i.test(err.message ?? "") &&
    /instaclaw_frontier_spend_approvals/.test(err.message ?? "");
}

export interface ApprovalRowFull extends ApprovalRow {
  id: string;
  vm_id: string;
  owner_id: string;
  request_id: string;
}

/** Read the approval row for this spend. null on absent row OR pre-migration table. */
export async function lookupApproval(
  supabase: SupabaseClient,
  vmId: string,
  requestId: string,
): Promise<ApprovalRowFull | null> {
  const { data, error } = await supabase
    .from(APPROVALS_TABLE)
    .select("id, vm_id, owner_id, request_id, status, amount_usd, category, counterparty, expires_at")
    .eq("vm_id", vmId)
    .eq("request_id", requestId)
    .maybeSingle();
  if (error) {
    if (!isMissingRelationError(error)) {
      logger.warn("frontier approval lookup failed", { route: "frontier-approval-io", code: error.code });
    }
    return null;
  }
  return (data as ApprovalRowFull) ?? null;
}

export interface MintArgs {
  vmId: string;
  ownerId: string;
  requestId: string;
  amountUsd: number;
  category: string | null;
  counterparty: string | null;
  nowMs: number;
}

/**
 * Mint (or idempotently reuse) a pending_approval row for an ask_first spend.
 * Returns the confirm URL the agent relays to its human. Idempotent on
 * (vm_id, request_id): a retried ask_first reuses the existing row (preserving its
 * status -- if the human already approved, we do NOT reset it to pending). Returns
 * null only if the table is absent (pre-migration) or the write hard-fails -- the
 * caller then just omits the approval_url (the autonomy/forgeable paths still work).
 */
export async function mintPendingApproval(
  supabase: SupabaseClient,
  a: MintArgs,
): Promise<{ approvalId: string; approvalUrl: string } | null> {
  // Reuse an existing row if present (don't clobber an in-flight approval/denial).
  const existing = await lookupApproval(supabase, a.vmId, a.requestId);
  if (existing) {
    return { approvalId: existing.id, approvalUrl: `${APP_URL}/economy/approve?id=${existing.id}` };
  }
  const expiresAt = new Date(a.nowMs + APPROVAL_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from(APPROVALS_TABLE)
    .insert({
      vm_id: a.vmId,
      owner_id: a.ownerId,
      request_id: a.requestId,
      amount_usd: a.amountUsd,
      category: a.category,
      counterparty: a.counterparty,
      status: "pending_approval",
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error) {
    // Unique-violation race: another concurrent ask_first minted it first -> re-read.
    if (error.code === "23505") {
      const row = await lookupApproval(supabase, a.vmId, a.requestId);
      if (row) return { approvalId: row.id, approvalUrl: `${APP_URL}/economy/approve?id=${row.id}` };
    }
    if (!isMissingRelationError(error)) {
      logger.warn("frontier approval mint failed", { route: "frontier-approval-io", code: error.code });
    }
    return null;
  }
  return { approvalId: data.id as string, approvalUrl: `${APP_URL}/economy/approve?id=${data.id}` };
}

/** Single-use: mark an honored approval consumed. Best-effort; only flips an
 *  'approved' row (never resurrects a terminal one). */
export async function consumeApproval(supabase: SupabaseClient, vmId: string, requestId: string): Promise<void> {
  try {
    await supabase
      .from(APPROVALS_TABLE)
      .update({ status: "consumed", consumed_at: new Date().toISOString() })
      .eq("vm_id", vmId)
      .eq("request_id", requestId)
      .eq("status", "approved");
  } catch {
    // best-effort
  }
}

interface NotifyVm {
  id: string;
  telegram_bot_token?: string | null;
  telegram_chat_id?: string | null;
}

/**
 * The out-of-band detection push for a FORGEABLE-honored spend. Platform-sent via
 * the VM bot token + (lazily discovered) chat_id, so a compromised agent cannot
 * suppress it. Includes a one-tap Revoke URL-button (HMAC-signed; disables spend --
 * the fail-safe direction). Entirely best-effort: any failure is swallowed (the spend
 * already authorized; this is detection + control, not a gate).
 */
export async function sendForgeableSpendNotification(
  supabase: SupabaseClient,
  vm: NotifyVm,
  spend: { amountUsd: number; counterparty: string | null; category: string | null; nowMs: number },
): Promise<void> {
  try {
    const botToken = vm.telegram_bot_token;
    if (!botToken) return;
    let chatId = vm.telegram_chat_id ?? null;
    if (!chatId) {
      chatId = await discoverTelegramChatId(botToken);
      if (chatId) {
        try {
          await supabase.from("instaclaw_vms").update({ telegram_chat_id: chatId }).eq("id", vm.id);
        } catch {
          /* write-back optimization only */
        }
      }
    }
    if (!chatId) return;

    const amt = `$${spend.amountUsd.toFixed(2)}`;
    const who = spend.counterparty ? ` to ${spend.counterparty}` : "";
    const what = spend.category ? ` for ${spend.category}` : "";
    const message =
      `Heads up: your agent just authorized a ${amt} payment${who}${what} -- with your approval.\n\n` +
      `If that wasn't you, tap Revoke to turn off autonomous spending for this agent immediately.`;

    const signed = signRevokeToken(vm.id, spend.nowMs);
    if (signed.ok) {
      const revokeUrl = `${APP_URL}/api/agent-economy/revoke-spend?token=${encodeURIComponent(signed.token)}`;
      await sendTelegramMessageWithButton(botToken, chatId, message, "Revoke spending", revokeUrl);
    } else {
      // No signing secret -> still inform; the user can revoke from the dashboard.
      const { sendTelegramNotification } = await import("@/lib/telegram");
      await sendTelegramNotification(botToken, chatId, message + `\n\nManage spending: ${APP_URL}/economy`);
    }
  } catch {
    // best-effort, never throws
  }
}

/**
 * The phase-3 flip (Rule 61): when "true", a forgeable approval at/above the tier's
 * justDoItPerTx no longer authorizes -- session approval is required. Default/unset =
 * phase 1 (both honored, zero break). Validated by VALUE: a set-but-not-"true" value
 * is a misconfiguration and is logged loudly (but still treated as off -- fail to the
 * safe-for-rollout phase-1 behavior, never silently to the stricter mode mid-rollout).
 */
export function requireSessionApprovalAboveThreshold(): boolean {
  const raw = process.env.FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD;
  if (raw === "true") return true;
  if (raw !== undefined && raw !== "false" && raw !== "0" && raw !== "no" && raw !== "") {
    logger.warn(
      "FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD is set but not 'true' -- treating as OFF (phase 1). " +
        "To flip, run: printf 'true' | npx vercel env add FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD production",
      { route: "frontier-approval-io", actual: JSON.stringify(raw), expected: "true" },
    );
  }
  return false;
}
