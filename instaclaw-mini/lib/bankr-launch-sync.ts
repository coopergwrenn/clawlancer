import { supabase } from "./supabase";

/**
 * Mini-app port of instaclaw/lib/bankr-launch-sync.ts.
 *
 * Detects token launches that happened outside our /api/bankr/tokenize
 * flow (chat-driven launches via `bankr launch` on the VM) and back-fills
 * the DB so the mini-app dashboard, celebration card, and viral share
 * flow all fire.
 *
 * CANONICAL SOURCE: instaclaw/lib/bankr-launch-sync.ts
 * Keep these two files in sync. The two diverge ONLY in the supabase
 * client import (mini-app: `supabase()`, webapp: `getSupabase()`) and
 * the logger (mini-app uses console.* — no shared logger module).
 *
 * Used by:
 *   - app/(tabs)/home/page.tsx — server-side, fires once on dashboard
 *     load, returns freshLaunch when this call performed the DB write
 *     that discovered the launch
 */

const BANKR_API_URL = "https://api.bankr.bot";
const FETCH_TIMEOUT_MS = 10_000;

interface BankrCreatorFeesResponse {
  address: string;
  chain: string;
  tokens: Array<{
    tokenAddress: string;
    name: string;
    symbol: string;
    poolId: string;
    share: string;
  }>;
}

export interface SyncResult {
  updated: boolean;
  tokenAddress?: string;
  tokenSymbol?: string;
  /** Total autonomous launches across the platform after this write. */
  launchNumber?: number;
  reason?:
    | "vm_not_found"
    | "already_synced"
    | "no_wallet"
    | "no_launches"
    | "fetch_failed"
    | "fetch_timeout"
    | "bankr_error"
    | "db_error"
    | "race_lost";
  bankrStatus?: number;
}

/**
 * Sync a single VM's Bankr launch state. Safe to call concurrently — the
 * conditional UPDATE on `bankr_token_address IS NULL` guarantees only
 * one writer wins (cron vs on-demand vs dashboard-button race).
 *
 * Returns `updated: true` exactly when this call performed the DB write
 * that transitioned the row from no-token to token-set. The mini-app
 * dashboard treats that signal as "we just discovered the launch — fire
 * celebration on first paint."
 */
export async function syncBankrLaunchForVm(vmId: string): Promise<SyncResult> {
  const s = supabase();

  const { data: vm, error: readErr } = await s
    .from("instaclaw_vms")
    .select("id, bankr_evm_address, bankr_token_address, tokenization_platform, telegram_bot_token, telegram_chat_id")
    .eq("id", vmId)
    .single();

  if (readErr || !vm) {
    return { updated: false, reason: "vm_not_found" };
  }

  if (vm.bankr_token_address || vm.tokenization_platform === "bankr") {
    return { updated: false, reason: "already_synced" };
  }

  if (!vm.bankr_evm_address) {
    return { updated: false, reason: "no_wallet" };
  }

  let res: Response;
  try {
    res = await fetch(
      `${BANKR_API_URL}/public/doppler/creator-fees/${vm.bankr_evm_address}`,
      {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "instaclaw-mini-launch-sync/1.0" },
      },
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return { updated: false, reason: isTimeout ? "fetch_timeout" : "fetch_failed" };
  }

  if (!res.ok) {
    return { updated: false, reason: "bankr_error", bankrStatus: res.status };
  }

  let data: BankrCreatorFeesResponse;
  try {
    data = (await res.json()) as BankrCreatorFeesResponse;
  } catch {
    return { updated: false, reason: "bankr_error", bankrStatus: res.status };
  }

  if (!data.tokens || data.tokens.length === 0) {
    return { updated: false, reason: "no_launches" };
  }

  const token = data.tokens[0];
  const symbol = (token.symbol ?? "").toUpperCase();

  const { data: updated, error: updateErr } = await s
    .from("instaclaw_vms")
    .update({
      tokenization_platform: "bankr",
      bankr_token_address: token.tokenAddress,
      bankr_token_symbol: symbol,
      bankr_token_launched_at: new Date().toISOString(),
    })
    .eq("id", vmId)
    .is("bankr_token_address", null)
    .is("tokenization_platform", null)
    .select("id");

  if (updateErr) {
    console.error("[bankr-launch-sync] db update failed", {
      vmId,
      tokenAddress: token.tokenAddress,
      code: updateErr.code,
      error: updateErr.message,
    });
    return { updated: false, reason: "db_error" };
  }

  if (!updated || updated.length === 0) {
    return { updated: false, reason: "race_lost" };
  }

  // Count for celebration "You're #N" line. Non-fatal — omit on failure.
  let launchNumber: number | undefined;
  try {
    const { count } = await s
      .from("instaclaw_vms")
      .select("id", { count: "exact", head: true })
      .not("bankr_token_address", "is", null)
      .eq("tokenization_platform", "bankr");
    if (typeof count === "number" && count > 0) launchNumber = count;
  } catch {
    // Non-fatal — skip silently.
  }

  console.log("[bankr-launch-sync] discovered chat-driven launch", {
    vmId,
    tokenAddress: token.tokenAddress,
    tokenSymbol: symbol,
    walletAddress: vm.bankr_evm_address,
    launchNumber,
  });

  // ── Item #1: agent autopost (Path B) ──
  // Fires when the mini-app's home/page.tsx server render is the one
  // that detected the launch (vs the webapp's cron / /api/vm/status).
  // Best-effort isolated try/catch — sync's SyncResult contract stays
  // clean if Telegram is down or the bot is blocked.
  try {
    const { postLaunchAnnouncement } = await import("./agent-autopost");
    const result = await postLaunchAnnouncement({
      vm: {
        id: vm.id,
        telegram_bot_token: (vm as { telegram_bot_token?: string | null }).telegram_bot_token,
        telegram_chat_id: (vm as { telegram_chat_id?: string | null }).telegram_chat_id,
      },
      tokenSymbol: symbol,
      supabase: s,
    });
    console.log("[agent-autopost] path-B result", {
      vmId,
      tokenSymbol: symbol,
      posted: result.posted,
      reason: result.reason,
    });
  } catch (autopostErr) {
    console.warn("[agent-autopost] path-B threw (non-fatal)", {
      vmId,
      error: String(autopostErr),
    });
  }

  return {
    updated: true,
    tokenAddress: token.tokenAddress,
    tokenSymbol: symbol,
    launchNumber,
  };
}
