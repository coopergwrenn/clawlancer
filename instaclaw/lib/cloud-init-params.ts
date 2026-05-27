/**
 * lib/cloud-init-params.ts — VM-row → TarballParams mapping.
 *
 * Called by /api/vm/cloud-init-config AFTER the atomic config-token claim
 * succeeds. Reads VM-row columns directly + sources fleet-wide secrets from
 * process.env (mirrors lib/ssh.ts configureOpenClaw's env-var sourcing so
 * cloud-init and SSH paths produce byte-equivalent tarballs for the same
 * underlying VM state).
 *
 * 2026-05-15 design note: agentbookKey and agentbookAddress are intentionally
 * omitted from the constructed TarballParams. The cloud-init bootstrap+fetch
 * path generates the AgentBook private key ON THE VM during setup.sh via
 * `openssl rand -hex 32` (post-decision "no private keys in our DB ever").
 * See lib/cloud-init-setup-sh.ts §1.9 CLOUD_INIT_AGENT_KEY_ONVM_GEN.
 *
 * Required-field policy: if a column the tarball/setup.sh treats as
 * load-bearing is NULL on the row (e.g., gateway_token, tier, region,
 * cloud_init_callback_token), this function throws with a clear message
 * pointing at the upstream createUserVM bug. The endpoint catches the
 * throw, releases the consumed config_token (so retry can succeed once
 * the upstream defect is fixed), and returns 500.
 *
 * Optional-field policy: missing values degrade silently to undefined
 * (the tarball emitters guard each one). The VM lands with reduced
 * functionality on the missing feature (e.g., no BANKR_API_KEY → bankr
 * skill prompts at first use); the reconciler can backfill from env or
 * a future cloud-init-callback enhancement.
 *
 * Pure async function — no side effects on the DB (the endpoint owns the
 * token lifecycle). Single read of instaclaw_users for name+email.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TarballParams } from "./cloud-init-tarball";

// Structural type — accepts the row PostgREST returns from .select("*")
// without forcing a project-wide Supabase schema-types import. Each field
// access is type-narrowed below.
export type VmRow = Record<string, unknown>;

export async function buildParamsFromVmRow(
  supabase: SupabaseClient,
  vm: VmRow,
): Promise<TarballParams> {
  // ── Local helpers ──
  // str(key): returns string when present and non-empty, null otherwise.
  // requireStr(key): same as str() but throws with a precise error if null.
  // strArray(key): coerces to string[] when an array of strings; [] otherwise.
  const str = (key: string): string | null => {
    const v = vm[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const requireStr = (key: string): string => {
    const v = str(key);
    if (v == null) {
      const vmIdHint = str("id") ?? "(unknown)";
      const vmNameHint = str("name") ?? "(unknown)";
      throw new Error(
        `buildParamsFromVmRow: required column "${key}" is null/empty on vm ` +
          `id=${vmIdHint} name=${vmNameHint}. Upstream createUserVM must ` +
          `populate this column before minting cloud_init_config_token.`,
      );
    }
    return v;
  };
  const strArray = (key: string): string[] => {
    const v = vm[key];
    return Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : [];
  };
  const optStr = (key: string): string | undefined => str(key) ?? undefined;

  // ── Required identifiers + tokens (throw on null) ──
  const userId = requireStr("assigned_to");
  const vmName = requireStr("name");
  const gatewayToken = requireStr("gateway_token");
  const callbackToken = requireStr("cloud_init_callback_token");
  const defaultModel = requireStr("default_model");
  const tier = requireStr("tier");
  const agentRegion = requireStr("region");

  // ── apiMode: enum validation ──
  const apiModeRaw = requireStr("api_mode");
  if (apiModeRaw !== "all_inclusive" && apiModeRaw !== "byok") {
    throw new Error(
      `buildParamsFromVmRow: invalid api_mode "${apiModeRaw}" on vm "${vmName}" — ` +
        `must be "all_inclusive" or "byok".`,
    );
  }
  const apiMode = apiModeRaw as "all_inclusive" | "byok";

  // ── channels — empty array IS valid (channel-first cloud-init, 2026-05-27) ──
  // BYOB VMs have ["telegram"] (or ["telegram","discord"]). Channel-first
  // VMs (iMessage / shared bot) have [] — they don't host an on-VM
  // messaging plugin; the backend relays via lib/channel-routing.
  // Telegram bits only required when "telegram" is in channels (gated below).
  const channels = strArray("channels_enabled");

  const telegramBotToken = channels.includes("telegram")
    ? requireStr("telegram_bot_token")
    : str("telegram_bot_token");
  const telegramBotUsername = channels.includes("telegram")
    ? requireStr("telegram_bot_username")
    : str("telegram_bot_username");

  // ── nextauthUrl: from Vercel env ──
  const nextauthUrl = process.env.NEXTAUTH_URL;
  if (!nextauthUrl) {
    throw new Error(
      "buildParamsFromVmRow: NEXTAUTH_URL not set in process.env. " +
        "This is a Vercel project misconfiguration — every env (production, " +
        "preview, development) must have NEXTAUTH_URL set to the canonical " +
        "https://instaclaw.io URL.",
    );
  }

  // ── BYOK: api_key on row required when apiMode=byok ──
  const apiKey = apiMode === "byok" ? optStr("api_key") : undefined;
  if (apiMode === "byok" && !apiKey) {
    throw new Error(
      `buildParamsFromVmRow: api_mode="byok" but api_key column is null on ` +
        `vm "${vmName}". BYOK users must have their key stored before ` +
        `cloud-init can deliver it.`,
    );
  }

  // ── Optional VM-row fields (degrade silently to undefined) ──
  const discordBotToken = optStr("discord_bot_token");
  const userTimezone = optStr("user_timezone");
  const bankrEvmAddress = optStr("bankr_evm_address");
  const bankrTokenAddress = optStr("bankr_token_address");
  const bankrTokenSymbol = optStr("bankr_token_symbol");
  // CDP backup wallet — receive-only EVM address on Base, server-managed
  // via Coinbase MPC. Always-on fallback that runs alongside Bankr. Public
  // address only; no private key on the VM. Surfaced in WALLET.md and
  // ~/.openclaw/.env (CDP_WALLET_ADDRESS).
  const cdpWalletAddress = optStr("cdp_wallet_address");
  const partner = optStr("partner");

  // bankr_api_key_encrypted: column is encrypted-at-rest (the column name
  // says so). Decryption requires the server-side master key + a small
  // ed25519/AES helper we don't yet have wired into this lib. For now,
  // omit from the tarball — the bankr skill on the VM degrades to read-
  // only (or prompts the user for the key) without it. Future enhancement
  // tracked as a follow-up; not blocking for the Day 9-10 ship.
  const bankrApiKey: string | undefined = undefined;

  // agentbook_wallet_address: typically NULL at cloud-init endpoint time
  // (key generated on-VM, address backfilled later). Pass through if a
  // value happens to be there (legacy SSH-path migration cases).
  const agentbookAddress = optStr("agentbook_wallet_address");
  // agentbookKey: NEVER from DB — generated on-VM in setup.sh §1.9.
  // Intentionally undefined.

  // ── User-table fetch for name + email (single secondary query) ──
  // Best-effort: BOOTSTRAP.md and IDENTITY.md degrade gracefully without
  // these (e.g., agent introduces itself with bot username instead of
  // user name). A failed user lookup MUST NOT block tarball generation —
  // the endpoint already committed to claiming the token and must return
  // a usable response.
  let userName: string | undefined;
  let userEmail: string | undefined;
  try {
    const { data: userRow, error: userErr } = await supabase
      .from("instaclaw_users")
      .select("name, email")
      .eq("id", userId)
      .single();
    if (userErr) {
      // No-op — fall through to undefined.
    } else if (userRow) {
      const row = userRow as { name?: string | null; email?: string | null };
      userName = typeof row.name === "string" && row.name.length > 0 ? row.name : undefined;
      userEmail = typeof row.email === "string" && row.email.length > 0 ? row.email : undefined;
    }
  } catch {
    // Catch-all: any transient PostgREST error → leave both undefined.
  }

  // ── Fleet-wide secrets from process.env ──
  // Mirror lib/ssh.ts configureOpenClaw's resolution order:
  //   VM-row column (vm.brave_api_key for BYOK Brave) > process.env (fleet default).
  // Per Cooper 2026-05-13: "every agent ships with web search working on
  // first boot. no exceptions." → fallback to env-var, not undefined.
  const braveApiKey =
    str("brave_api_key") ?? process.env.BRAVE_SEARCH_API_KEY ?? undefined;
  const openaiApiKey = process.env.OPENAI_API_KEY ?? undefined;
  const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY ?? undefined;
  const resendApiKey = process.env.RESEND_API_KEY ?? undefined;
  const alphavantageApiKey = process.env.ALPHAVANTAGE_API_KEY ?? undefined;

  // EDGEOS_BEARER_TOKEN is partner-gated. lib/cloud-init-tarball.ts:170
  // documents: "Only emitted in .env when partner === 'edge_city'."
  // We source the env var here only when the partner matches so a non-edge
  // VM's tarball doesn't leak the token even if the .env emitter has a bug.
  const edgeosBearerToken =
    partner === "edge_city"
      ? (process.env.EDGEOS_BEARER_TOKEN ?? undefined)
      : undefined;

  // ── World ID nullifier / level ──
  // Currently NOT sourced from any VM-row column — the only nullifier-shaped
  // column on instaclaw_vms is `agentbook_nullifier_hash` which is the
  // AgentBook registration nullifier, NOT the general user's World ID
  // verification nullifier. The general nullifier lives on instaclaw_users
  // for World-ID-verified accounts. Until that fetch is wired (separate
  // follow-up; tracked under World ID integration), this stays undefined
  // and WORLD_ID.md is omitted from the tarball (the buildWorldIdMdForTarball
  // wrapper returns null when worldIdNullifier is absent, matching SSH path).
  const worldIdNullifier: string | undefined = undefined;
  const worldIdLevel: string | undefined = undefined;

  return {
    userId,
    vmName,
    nextauthUrl,
    gatewayToken,
    callbackToken,
    telegramBotToken,
    telegramBotUsername,
    channels,
    discordBotToken,
    userName,
    userEmail,
    userTimezone,
    gmailProfileSummary: null,
    apiMode,
    apiKey,
    defaultModel,
    tier,
    braveApiKey,
    openaiApiKey,
    elevenlabsApiKey,
    resendApiKey,
    alphavantageApiKey,
    edgeosBearerToken,
    agentRegion,
    // agentbookKey: INTENTIONALLY OMITTED — generated on-VM (setup.sh §1.9).
    agentbookAddress,
    bankrEvmAddress,
    bankrApiKey,
    bankrTokenAddress,
    bankrTokenSymbol,
    cdpWalletAddress,
    worldIdNullifier,
    worldIdLevel,
    partner,
  };
}
