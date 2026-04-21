/**
 * User-facing copy for Bankr claim / wallet flows.
 * Centralized so a designer or Cooper can edit without hunting through components.
 *
 * Not yet wired — will be imported by the claim UI (bankr-wallet-card.tsx or
 * a future claim button component) once that flow lands.
 */

/**
 * Shown when a claim attempt fails because the wallet has 0 ETH for gas and
 * Bankr's gas sponsorship isn't yet live for our org.
 *
 * Displayed in-dashboard; our side handles the top-up via /partner/wallets/:id/fund.
 */
export const CLAIM_WALLET_UNFUNDED =
  "Your agent's wallet needs a tiny amount of ETH to claim for the first time. " +
  "We'll fund it — give us a minute and try again.";
