/**
 * Shared OpenClaw-provisioning types.
 *
 * Lifted from lib/ssh.ts:71 (where UserConfig lived as a module-private
 * interface) so that both configureOpenClaw and the cloud-init tarball
 * builder can reference the same shape without one importing implementation
 * from the other.
 *
 * Pattern matches lib/negotiation-types.ts. Future shared provisioning
 * types should land here.
 */

/**
 * Per-user parameters passed into `buildOpenClawConfig` in `lib/ssh.ts`.
 * Describes everything our app knows about a user that gets baked into
 * `openclaw.json` at provision time.
 *
 * The fields with `?` are optional — `buildOpenClawConfig` conditionally
 * emits the relevant sections of openclaw.json based on which fields are
 * present (telegram channel only if telegramBotToken; brave plugin only
 * if a brave key is wired; etc.).
 *
 * `tier` is declared required here because it's required everywhere
 * upstream (signup flow always sets it). If you find yourself wanting to
 * pass `tier: undefined`, fix the upstream caller — don't relax this type.
 */
export interface UserConfig {
  telegramBotToken?: string;
  apiMode: "all_inclusive" | "byok";
  apiKey?: string;
  tier: string;
  model?: string;
  discordBotToken?: string;
  channels?: string[];
  braveApiKey?: string;
  gmailProfileSummary?: string;
  elevenlabsApiKey?: string;
  /** Force generation of a new gateway token even if one exists in the DB. */
  forceNewToken?: boolean;
  /** User's full name (from instaclaw_users.name) — used for IDENTITY.md + USER.md */
  userName?: string;
  /** User's email (from instaclaw_users.email) — used for USER.md */
  userEmail?: string;
  /** Bot's Telegram username (e.g., "Mucus09bot") — used for IDENTITY.md */
  botUsername?: string;
  /** User's timezone (e.g., "America/New_York") — used for USER.md */
  userTimezone?: string;
  /** World ID nullifier hash — deployed to VM .env + WORLD_ID.md */
  worldIdNullifier?: string;
  /** World ID verification level ("orb" or "device") */
  worldIdLevel?: string;
  /** Bankr wallet API key (bk_usr_...) — deployed to VM .env for trading skill */
  bankrApiKey?: string;
  /** Bankr EVM wallet address — deployed to VM .env + Wallet.md */
  bankrEvmAddress?: string;
  /** Bankr token contract address — if agent has been tokenized */
  bankrTokenAddress?: string;
  /** Bankr token symbol — e.g. "ALPHA" */
  bankrTokenSymbol?: string;
  /** Bankr token name — e.g. "AlphaTrader" */
  bankrTokenName?: string;
  /**
   * CDP (Coinbase Developer Platform) backup wallet address — 0x-prefixed
   * EVM address on Base. Receive-only from the agent's perspective: the
   * private key lives in Coinbase MPC custody, never on the VM. Deployed
   * to ~/.openclaw/.env as `CDP_WALLET_ADDRESS` and rendered as the
   * "Backup Wallet" section in WALLET.md. Used when Bankr is unavailable.
   */
  cdpWalletAddress?: string;
  /** Partner tag (e.g., "edge_city") — gates partner-specific skill installation */
  partner?: string;
}
