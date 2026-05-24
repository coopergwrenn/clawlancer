/**
 * Bankr maintenance flag — single source of truth.
 *
 * When `BANKR_MAINTENANCE=true` (server-side env), wallet-affecting code paths
 * gate themselves off:
 *   - `provisionBankrWallet()` returns null without calling the Bankr API
 *   - `cron/provision-missing-bankr-wallets` early-returns
 *   - Dashboard surfaces (BankrWalletCard, AgentWalletFundingCard, marketing
 *     /token banner) render a maintenance notice instead of action CTAs
 *
 * Read-only surfaces stay visible: wallet addresses, balances (fetched from
 * public Base RPC), already-launched token price/volume, public token-detail
 * pages. The flag pauses NEW wallet actions; it doesn't hide existing state.
 *
 * To flip back to normal, set `BANKR_MAINTENANCE=false` (or unset) and redeploy.
 * No code change required.
 *
 * This file is server-side only. Components that need the flag receive it as
 * a prop from their parent server component (see app/(dashboard)/dashboard/
 * page.tsx for the wiring pattern). We deliberately do NOT export a
 * NEXT_PUBLIC_BANKR_MAINTENANCE because the maintenance state is operationally
 * sensitive and shouldn't be visible to anyone who happens to inspect the
 * client bundle.
 */
export function isBankrMaintenance(): boolean {
  return process.env.BANKR_MAINTENANCE === "true";
}
