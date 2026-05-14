/**
 * lib/cloud-init-tarball.ts — server-side generator for the per-user
 * tarball that the cloud-init bootstrap fetches and extracts.
 *
 * Architecture: see docs/cloud-init-builder-plan-2026-05-13.md (v2,
 * bootstrap+fetch). The Linode user_data carries a ~2.3KB bootstrap
 * that curls /api/vm/cloud-init-config; this module builds the tarball
 * that endpoint streams back.
 *
 * This file owns:
 *   - TarballParams type (the per-user-VM input shape)
 *   - validateTarballParams (boundary validation)
 *   - Per-file wrappers that produce each file in the tarball:
 *     openclaw.json, auth-profiles.json, .env, IDENTITY.md, WALLET.md,
 *     WORLD_ID.md, BOOTSTRAP.md, USER.md, system-prompt.md, MEMORY.md
 *     (workspace + agent-dir copies), wallet/agent.key, partner overlays.
 *   - tar.gz packing (tar-stream + zlib.createGzip, streaming).
 *
 * Byte-parity with the SSH-configure path is structurally guaranteed:
 * every per-file wrapper is a pass-through to a generator function
 * exported from lib/ssh.ts. configureOpenClaw and buildCloudInitTarball
 * call the same underlying functions with the same inputs and get
 * byte-identical output. See docs/cloud-init-audit-2026-05-14.md for
 * the pre-audit hand-written wrapper bugs this discipline now prevents.
 *
 * The exception is buildDotEnv: the SSH path appends env vars piecemeal
 * across configureOpenClaw rather than building the .env body in one
 * shot, so no single helper exists to pass-through to. buildDotEnv
 * mirrors the SSH path's conditional emission per env var, verified by
 * test14 + test15.
 *
 * Security:
 *   - Input validation (validateTarballParams): shell-unsafe chars
 *     blocked on every param that flows into setup.sh as a template
 *     substitution. JWT shape enforced on EDGEOS_BEARER_TOKEN.
 *   - Tokens (gatewayToken, callbackToken, telegramBotToken, apiKey,
 *     edgeosBearerToken, openaiApiKey, etc.) live in the tarball ONLY
 *     (never in Linode user_data — see lib/cloud-init-userdata.ts).
 *     Tarball at-rest lifetime in /tmp is ~5 seconds.
 *   - File modes: openclaw.json + .env + auth-profiles.json + agent.key
 *     → 0o600. Workspace .md files → 0o644. setup.sh → 0o755.
 *   - Tar entry mtimes pinned to TARBALL_FIXED_MTIME for determinism
 *     (Phase 1B-2 byte-compare audit relies on this).
 */
import { pack as tarPack } from "tar-stream";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";

import {
  EDGE_INSTACLAW_OVERLAY_MD,
  SOUL_STUB_CONSENSUS,
  SOUL_STUB_EDGE,
} from "./partner-content";
import {
  BANKR_SKILL_PATCH_DIRECTIVE,
  WORKSPACE_BOOTSTRAP_SHORT,
  buildAuthProfilesJson,
  buildIdentityMd,
  buildOpenClawConfig,
  buildPersonalizedBootstrap,
  buildSystemPrompt,
  buildUserMd,
  buildWalletMd,
  buildWorldIdMd,
} from "./ssh";
import type { UserConfig } from "./user-config-types";
import { VM_MANIFEST } from "./vm-manifest";

// ════════════════════════════════════════════════════════════════════════
// §1. Public types
// ════════════════════════════════════════════════════════════════════════

/**
 * Parameters for building the cloud-init tarball. Composed server-side
 * by the /api/vm/cloud-init-config endpoint after atomic-claiming the
 * config_token, reading the row from instaclaw_vms + the user record.
 *
 * Strict subset: only fields actually written into tarball files. The
 * full DB row has more (heartbeat config, watchdog state, etc.) that
 * the tarball doesn't carry — those are reconciler-managed.
 */
export interface TarballParams {
  // ── Identifiers ──
  userId: string;
  vmName: string;

  // ── Network ──
  nextauthUrl: string;

  // ── Tokens (per-VM, never in Linode user_data) ──
  /** instaclaw_vms.gateway_token — proxy auth + (all-inclusive) Anthropic key. */
  gatewayToken: string;
  /** One-time-use callback_token, consumed by /api/vm/cloud-init-callback. */
  callbackToken: string;

  // ── Bots ──
  telegramBotToken: string;
  telegramBotUsername: string;
  /** Enabled-channels array from vm.channels_enabled (DB column). Drives
   *  conditional emission of channels.* and plugins.entries.* blocks in
   *  openclaw.json. Default for current production: ["telegram"]. Adding
   *  "discord" requires discordBotToken to also be set (buildOpenClawConfig
   *  guards both conditions). REQUIRED — every VM must have at least one
   *  channel (else the agent has no way to talk to its user). */
  channels: string[];
  /** Per-user Discord bot token. As of 2026-05-13, 0 of 239 production
   *  VMs have this set — keeping the field for forward-compat without
   *  hardcoding the assumption that everyone is telegram-only. When
   *  absent, buildOpenClawConfig naturally omits the discord channel. */
  discordBotToken?: string | null;

  // ── User profile (workspace files) ──
  userName?: string | null;
  userEmail?: string | null;
  userTimezone?: string | null;
  /** Optional Gmail-derived profile summary. If non-empty, BOOTSTRAP.md
   *  is generated and a personalized system-prompt.md is built; otherwise
   *  the snapshot's WORKSPACE_BOOTSTRAP_SHORT serves as the bootstrap. */
  gmailProfileSummary?: string | null;

  // ── Tier / model ──
  apiMode: "all_inclusive" | "byok";
  /** BYOK only — the user's own Anthropic API key. Ignored when api_mode
   *  is all_inclusive (auth-profiles.json uses gatewayToken instead). */
  apiKey?: string | null;
  defaultModel: string;
  /** Subscription tier (e.g., "starter", "pro", "power"). REQUIRED — a
   *  user reaching cloud-init without a tier set is a broken signup flow
   *  and we throw rather than silently default. Per Cooper 2026-05-13:
   *  "tier should NEVER be null at provisioning time." */
  tier: string;
  /** Brave Search API key. The endpoint resolves vm.brave_api_key first
   *  (0 of 239 VMs set this in production as of 2026-05-13), falling back
   *  to process.env.BRAVE_SEARCH_API_KEY (fleet-wide). Per Cooper 2026-05-13:
   *  "every agent ships with web search working on first boot. no exceptions."
   *  Wrapper itself is purely functional — it doesn't touch env vars. */
  braveApiKey?: string | null;
  /** OpenAI API key — used for memory-search embeddings. The SSH-configure
   *  path at lib/ssh.ts:5102 reads `process.env.OPENAI_API_KEY` at call
   *  time and conditionally emits the `openai:default` profile in
   *  auth-profiles.json. Cloud-init endpoint sources the same env var
   *  and passes through. When null/undefined, the openai:default profile
   *  is OMITTED (matches SSH-path behavior exactly). */
  openaiApiKey?: string | null;
  /** ElevenLabs API key — voice/TTS skill. SSH path source:
   *  `config.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY`
   *  (BYOK takes precedence over the server-side env). Endpoint should
   *  resolve both and pass the result. Emitted in .env when truthy. */
  elevenlabsApiKey?: string | null;
  /** Resend API key — server-side email sending. SSH path source:
   *  `process.env.RESEND_API_KEY`. Endpoint passes through. Emitted in
   *  .env when truthy. */
  resendApiKey?: string | null;
  /** Alpha Vantage API key — financial-data skill. SSH path source:
   *  `process.env.ALPHAVANTAGE_API_KEY`. Endpoint passes through.
   *  Emitted in .env when truthy. */
  alphavantageApiKey?: string | null;
  /** EdgeOS attendee-directory JWT. Only emitted in .env when partner ===
   *  "edge_city". The endpoint sources this from process.env.EDGEOS_BEARER_TOKEN
   *  (mirrors lib/ssh.ts:5286). 2026-05-14 incident — for 34 days the
   *  Vercel value was a 64-char hex string (duplicate of EDGEOS_API_KEY)
   *  instead of a JWT; the api-citizen-portal.simplefi.tech endpoint
   *  requires a JWT (eyJ...). The SSH-path's `|| ""` fallback had NO
   *  format validation; this wrapper validates JWT shape at the boundary
   *  so the cloud-init path can't make the same silent-bad-value mistake.
   *  See validateTarballParams below. */
  edgeosBearerToken?: string | null;

  /** Linode region slug (e.g., "us-east", "ca-central", "jp-osa"). Emitted
   *  as AGENT_REGION in .env per VM_MANIFEST.requiredEnvVars. REQUIRED —
   *  every VM has a region set at create-Linode time (createUserVM passes
   *  region: "us-east" or per-event-buffer override). A NULL region at
   *  provisioning means the upstream Linode create call malformed. */
  agentRegion: string;

  // ── Wallets (per-VM) ──
  /** AgentBook agent.key file body — text of the private key (mode 0o600).
   *  Generated server-side via lib/agentbook-wallet.ts. */
  agentbookKey: string;
  agentbookAddress: string;
  bankrEvmAddress?: string | null;
  bankrApiKey?: string | null;
  bankrTokenAddress?: string | null;
  bankrTokenSymbol?: string | null;
  /** Bankr token name (e.g., "AlphaTrader"). Optional pretty-name shown
   *  alongside the ticker in WALLET.md's token block. configureOpenClaw
   *  passes config.bankrTokenName directly into the WALLET.md template
   *  via lib/ssh.ts:buildWalletMd. */
  bankrTokenName?: string | null;

  // ── World ID ──
  worldIdNullifier?: string | null;
  worldIdLevel?: string | null;

  // ── Partner ──
  partner?: string | null;
}

/** A single entry to be packed into the tarball. */
interface TarEntry {
  /** Path relative to the tarball root. */
  path: string;
  /** File body. Text bodies are UTF-8 encoded; Buffer bodies are written verbatim. */
  body: string | Buffer;
  /** Unix mode (default 0o644). */
  mode?: number;
}

// ════════════════════════════════════════════════════════════════════════
// §2. Validation
// ════════════════════════════════════════════════════════════════════════

/**
 * Strict shell-safety check on every param that flows into setup.sh as
 * a template substitution. The setup.sh template (Day 8) does:
 *   USER_ID="${p.userId}"
 *   CALLBACK_TOKEN="${p.callbackToken}"
 *   ...
 * Any backtick, $, \, ', ", whitespace, newline, or CR would either
 * break the assignment or open a shell injection. Reject at the
 * boundary.
 */
const SHELL_UNSAFE_RE = /[`$\\'"\n\r\t ]/;
const VM_NAME_RE = /^instaclaw-vm-[a-zA-Z0-9_-]+$/;
const HEX_TOKEN_RE = /^[a-fA-F0-9]+$/;
const TG_BOT_USERNAME_RE = /^[a-zA-Z0-9_]{5,32}$/;

/**
 * JWT shape check. A real JWT is three base64url-encoded parts separated
 * by exactly two dots; the header part is base64-encoded JSON beginning
 * with `{"` which encodes to `eyJ`. Conservative validation that catches
 * the actual 2026-05-14 incident input (64-char hex, no dots, no eyJ
 * prefix) without false-rejecting any real-world JWT.
 *
 *   "eyJabc...".split(".").length === 3
 *   "deadbeef" * 8 (64-char hex).split(".").length === 1  → reject
 *   "" (empty)                                            → caller skips, never reaches here
 */
const JWT_SHAPE_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_MIN_LENGTH = 100; // The shortest real JWT (HS256, minimal claims) is ~120 chars; 100 is generous lower bound.

function assertShellSafe(value: string | null | undefined, label: string): void {
  if (value == null) return;
  if (SHELL_UNSAFE_RE.test(value)) {
    throw new Error(`cloud-init-tarball: ${label} contains shell-unsafe character`);
  }
}

export function validateTarballParams(p: TarballParams): void {
  // Required strings
  if (!p.userId) throw new Error("cloud-init-tarball: userId required");
  if (!p.vmName) throw new Error("cloud-init-tarball: vmName required");
  if (!VM_NAME_RE.test(p.vmName)) {
    throw new Error(`cloud-init-tarball: vmName "${p.vmName}" doesn't match ${VM_NAME_RE}`);
  }
  if (!p.nextauthUrl) throw new Error("cloud-init-tarball: nextauthUrl required");
  if (!p.nextauthUrl.startsWith("https://")) {
    throw new Error("cloud-init-tarball: nextauthUrl must start with https://");
  }
  if (p.nextauthUrl.includes("?") || p.nextauthUrl.includes("#")) {
    throw new Error("cloud-init-tarball: nextauthUrl must not contain ? or # (we append our own paths)");
  }
  if (!p.gatewayToken) throw new Error("cloud-init-tarball: gatewayToken required");
  if (p.gatewayToken.length < 32 || !HEX_TOKEN_RE.test(p.gatewayToken)) {
    throw new Error("cloud-init-tarball: gatewayToken must be ≥32 hex chars");
  }
  if (!p.callbackToken) throw new Error("cloud-init-tarball: callbackToken required");
  if (p.callbackToken.length < 32 || !HEX_TOKEN_RE.test(p.callbackToken)) {
    throw new Error("cloud-init-tarball: callbackToken must be ≥32 hex chars");
  }
  if (!p.telegramBotToken) throw new Error("cloud-init-tarball: telegramBotToken required");
  if (!p.telegramBotUsername) throw new Error("cloud-init-tarball: telegramBotUsername required");
  if (!TG_BOT_USERNAME_RE.test(p.telegramBotUsername)) {
    throw new Error(
      `cloud-init-tarball: telegramBotUsername "${p.telegramBotUsername}" doesn't match ${TG_BOT_USERNAME_RE}`,
    );
  }
  if (!p.defaultModel) throw new Error("cloud-init-tarball: defaultModel required");
  if (!p.agentbookKey) throw new Error("cloud-init-tarball: agentbookKey required");
  if (!p.agentbookAddress) throw new Error("cloud-init-tarball: agentbookAddress required");
  if (p.apiMode !== "all_inclusive" && p.apiMode !== "byok") {
    throw new Error(`cloud-init-tarball: invalid apiMode "${p.apiMode}"`);
  }
  if (p.apiMode === "byok" && !p.apiKey) {
    throw new Error("cloud-init-tarball: BYOK mode requires apiKey");
  }
  // tier: per Cooper 2026-05-13, a NULL tier at provisioning time means the
  // signup flow is broken upstream. Throw loudly rather than silently default
  // to "starter" (which would mislabel paying customers in usage analytics +
  // tier-gated feature flags). TypeScript already forbids `null`/`undefined`
  // here at compile time (TarballParams.tier is required string); this check
  // catches the runtime-dynamic-data path where TS was bypassed.
  if (typeof p.tier !== "string" || p.tier.trim() === "") {
    throw new Error(
      `cloud-init-tarball: tier required (got ${JSON.stringify(p.tier)}). ` +
        "A signup flow that reaches cloud-init without a tier set is broken — " +
        "fix the upstream caller; do not relax this check.",
    );
  }
  // agentRegion: AGENT_REGION is one of the 5 required env vars per
  // VM_MANIFEST.requiredEnvVars. A NULL region at provisioning time means
  // the upstream createUserVM call didn't pass a region — broken upstream.
  // Throw rather than emit AGENT_REGION= (with empty value), which would
  // confuse the reconciler's stepEnvVarPush (it'd treat empty as "needs
  // backfill" and constantly overwrite from defaults).
  if (typeof p.agentRegion !== "string" || p.agentRegion.trim() === "") {
    throw new Error(
      `cloud-init-tarball: agentRegion required (got ${JSON.stringify(p.agentRegion)}). ` +
        "A NULL region at provisioning means createUserVM didn't set vm.region — broken upstream.",
    );
  }
  // channels: required, must be a non-empty array. An empty channels list
  // means the agent has no way to talk to its user. buildOpenClawConfig
  // doesn't crash on empty channels (it just emits no channel blocks), but
  // the resulting VM is non-functional. Catch this at the boundary.
  if (!Array.isArray(p.channels) || p.channels.length === 0) {
    throw new Error(
      `cloud-init-tarball: channels required (got ${JSON.stringify(p.channels)}). ` +
        "A VM with no channels has no way for the agent to talk to its user.",
    );
  }
  // If discord is in channels, discordBotToken MUST be present (otherwise
  // buildOpenClawConfig silently drops the channel — agent looks misconfigured).
  if (p.channels.includes("discord") && !p.discordBotToken) {
    throw new Error(
      "cloud-init-tarball: channels includes 'discord' but discordBotToken is missing. " +
        "Either remove 'discord' from channels OR provide the bot token.",
    );
  }

  // EDGEOS_BEARER_TOKEN — 2026-05-14 incident defense.
  //
  // The SSH-configure path at lib/ssh.ts:5286 reads
  //   `process.env.EDGEOS_BEARER_TOKEN || ""`
  // with NO format validation. From 2026-04-10 → 2026-05-14, Vercel's value
  // was a 64-char hex string (someone duplicated EDGEOS_API_KEY into the
  // BEARER_TOKEN slot); every edge_city VM carried the wrong token for 34
  // days. The api-citizen-portal.simplefi.tech attendee-directory endpoint
  // requires a JWT (eyJ...), and silently 401'd every request from the fleet.
  //
  // Defense-in-depth here: validate the JWT shape at the tarball-builder
  // boundary so the cloud-init path CANNOT propagate a hex-shaped value.
  // The endpoint catches the throw → returns 500 → bootstrap retries 3× →
  // cloud-init-poll respawns → admin alert. Loud failure beats silent badness.
  //
  // Missing/null is acceptable (defensive: don't break agent provisioning
  // over a token that only enables ONE feature — attendee directory queries).
  // Wrong-shape is NOT acceptable.
  if (p.partner === "edge_city" && p.edgeosBearerToken) {
    if (p.edgeosBearerToken.length < JWT_MIN_LENGTH) {
      throw new Error(
        `cloud-init-tarball: edgeosBearerToken is too short to be a JWT ` +
          `(got ${p.edgeosBearerToken.length} chars, expected ≥${JWT_MIN_LENGTH}). ` +
          `This is almost certainly the 2026-05-14 hex-instead-of-JWT mistake — ` +
          `verify Vercel's EDGEOS_BEARER_TOKEN starts with "eyJ".`,
      );
    }
    if (!JWT_SHAPE_RE.test(p.edgeosBearerToken)) {
      // Show only a prefix in the error message — never log full token.
      const prefix = p.edgeosBearerToken.slice(0, 8);
      throw new Error(
        `cloud-init-tarball: edgeosBearerToken does not match JWT shape ` +
          `(prefix="${prefix}…"; real JWTs are "eyJ...header.payload.signature"). ` +
          `If this is a hex value, Vercel's EDGEOS_BEARER_TOKEN has been mis-set ` +
          `again — see lib/vm-reconcile.ts:766 post-mortem.`,
      );
    }
  }

  // Shell-safety on all template-substituted fields. Body content (workspace
  // .md, openclaw.json contents) is NOT a template substitution; it's
  // written into files via `install` from disk, so doesn't need shell-safety.
  // The fields below ARE template-substituted into setup.sh.
  assertShellSafe(p.userId, "userId");
  assertShellSafe(p.vmName, "vmName");
  assertShellSafe(p.nextauthUrl, "nextauthUrl");
  assertShellSafe(p.gatewayToken, "gatewayToken");
  assertShellSafe(p.callbackToken, "callbackToken");
  assertShellSafe(p.telegramBotToken, "telegramBotToken");
  assertShellSafe(p.telegramBotUsername, "telegramBotUsername");
  assertShellSafe(p.agentbookAddress, "agentbookAddress");
  assertShellSafe(p.bankrEvmAddress, "bankrEvmAddress");
  assertShellSafe(p.partner, "partner");
}

// ════════════════════════════════════════════════════════════════════════
// §3. Per-file builders + wrappers
//
// Every builder below maps TarballParams → file content for one entry in
// the tarball. The chunk-1 wrappers (buildIdentityMdForTarball,
// buildWalletMdForTarball, buildWorldIdMdForTarball,
// buildAuthProfilesJsonForTarball) are pass-throughs to extracted
// helpers in lib/ssh.ts — byte-parity is structurally guaranteed.
// buildDotEnv has no SSH-path helper to pass through to (env vars are
// appended piecemeal in configureOpenClaw); it mirrors the SSH-path's
// conditional emission per env var.
// ════════════════════════════════════════════════════════════════════════

/**
 * IDENTITY.md — pass-through to lib/ssh.ts:buildIdentityMd.
 *
 * 2026-05-14 audit fix (docs/cloud-init-audit-2026-05-14.md §1.1): the
 * pre-audit hand-written wrapper produced completely different content
 * from the SSH-configure path — missing the agent-name regex derivation
 * (`Mucus09bot` → `Mucus`), wrong heading, no "You are X" identity claim.
 * Byte-parity now structurally guaranteed via pass-through.
 *
 * Maps p.telegramBotUsername → buildIdentityMd's `botUsername` param.
 * The SSH path uses `config.botUsername` (= telegram bot's username with
 * or without the "@" prefix); buildIdentityMd handles either.
 */
export function buildIdentityMdForTarball(p: TarballParams): string {
  return buildIdentityMd(p.telegramBotUsername);
}

/**
 * WALLET.md — pass-through to lib/ssh.ts:buildWalletMd.
 *
 * 2026-05-14 audit fix (docs/cloud-init-audit-2026-05-14.md §1.2): pre-
 * audit wrapper was ~10 lines vs SSH path's ~50+ lines — missing Wallet
 * Summary, Key Rules, elaborate token-launch fee mechanics, the "do NOT
 * launch another token" guard. Byte-parity now structurally guaranteed.
 *
 * Maps the 4 Bankr fields from TarballParams to the helper's params.
 */
export function buildWalletMdForTarball(p: TarballParams): string {
  return buildWalletMd({
    bankrEvmAddress: p.bankrEvmAddress,
    bankrTokenAddress: p.bankrTokenAddress,
    bankrTokenSymbol: p.bankrTokenSymbol,
    bankrTokenName: p.bankrTokenName,
  });
}

/**
 * WORLD_ID.md — pass-through to lib/ssh.ts:buildWorldIdMd.
 *
 * 2026-05-14 audit fix (docs/cloud-init-audit-2026-05-14.md §1.3): pre-
 * audit wrapper had completely different shape from SSH path (no
 * "**Status:** Verified" line, no "## What This Means" + "## How to Use"
 * sections). Byte-parity now structurally guaranteed.
 *
 * Returns `string | null`. **null is load-bearing**: caller must omit
 * the entry when worldIdNullifier is absent. configureOpenClaw at
 * lib/ssh.ts:5558 (`if (config.worldIdNullifier)`) guards the SSH-path
 * write — cloud-init must match.
 */
export function buildWorldIdMdForTarball(p: TarballParams): string | null {
  if (!p.worldIdNullifier) return null;
  return buildWorldIdMd(p.worldIdNullifier, p.worldIdLevel);
}

/**
 * auth-profiles.json — pass-through to lib/ssh.ts:buildAuthProfilesJson.
 *
 * 2026-05-14 audit fix (docs/cloud-init-audit-2026-05-14.md §1.4): the
 * pre-audit hand-written wrapper had 4 distinct bugs (`type` field wrong,
 * OpenAI profile always emitted, OpenAI key from wrong source, JSON
 * indented vs SSH path's compact). All fixed by making this a pass-
 * through to the SSH-path generator that was extracted into an exported
 * helper. Byte-parity now structurally guaranteed.
 *
 * Maps TarballParams → buildAuthProfilesJson args:
 *   - apiKey: gatewayToken for all_inclusive, p.apiKey for BYOK. Same
 *     resolution as configureOpenClaw at lib/ssh.ts:4965-4968.
 *   - proxyBaseUrl: `${nextauthUrl}/api/gateway` for all_inclusive, ""
 *     for BYOK. Same as configureOpenClaw at lib/ssh.ts:4977-4980.
 *   - openaiKey: p.openaiApiKey ?? undefined. SSH-path reads
 *     process.env.OPENAI_API_KEY directly; cloud-init endpoint sources
 *     from the same env and passes through TarballParams for purity.
 *     When undefined/null, openai:default profile is OMITTED (matches
 *     SSH-path behavior exactly).
 *
 * Output format inherited from SSH path: `JSON.stringify({profiles})` —
 * compact, no indent, no trailing newline. Mode 0o600 (set by caller).
 */
export function buildAuthProfilesJsonForTarball(p: TarballParams): string {
  const apiKey = p.apiMode === "all_inclusive" ? p.gatewayToken : (p.apiKey ?? "");
  const proxyBaseUrl =
    p.apiMode === "all_inclusive"
      ? `${p.nextauthUrl.replace(/\/+$/, "")}/api/gateway`
      : "";
  return buildAuthProfilesJson(apiKey, proxyBaseUrl, p.openaiApiKey ?? undefined);
}

/**
 * .env — per-user env vars consumed by gateway + scripts. Mirrors the
 * SSH path's piecemeal emission at configureOpenClaw — every env var
 * the SSH path writes is emitted here under the same condition:
 *
 *   Universal (always): GATEWAY_TOKEN, TELEGRAM_BOT_TOKEN,
 *     INSTACLAW_USER_ID/VM_NAME/NEXTAUTH_URL, AGENTBOOK_ADDRESS,
 *     POLYGON_RPC_URL, CLOB_PROXY_URL, CLOB_PROXY_URL_BACKUP,
 *     AGENT_REGION, INSTACLAW_MUAPI_PROXY.
 *
 *   Conditional (per TarballParams):
 *     BANKR_WALLET_ADDRESS, BANKR_API_KEY,
 *     BANKR_TOKEN_ADDRESS, BANKR_TOKEN_SYMBOL,
 *     USER_TIMEZONE,
 *     WORLD_ID_NULLIFIER + WORLD_ID_LEVEL (paired),
 *     EDGEOS_BEARER_TOKEN (partner-gated),
 *     ELEVENLABS_API_KEY, RESEND_API_KEY, ALPHAVANTAGE_API_KEY,
 *     BRAVE_SEARCH_API_KEY, OPENAI_API_KEY.
 *
 * Sentinel: "# INSTACLAW_ENV_V1" comment at top.
 */
export function buildDotEnv(p: TarballParams): string {
  const lines: string[] = [
    "# INSTACLAW_ENV_V1 — generated by cloud-init-tarball.ts. Do not edit by hand;",
    "# the reconciler will detect drift and re-deploy from canonical content.",
    "",
    `GATEWAY_TOKEN=${p.gatewayToken}`,
    `TELEGRAM_BOT_TOKEN=${p.telegramBotToken}`,
    `INSTACLAW_USER_ID=${p.userId}`,
    `INSTACLAW_VM_NAME=${p.vmName}`,
    `INSTACLAW_NEXTAUTH_URL=${p.nextauthUrl.replace(/\/+$/, "")}`,
    `AGENTBOOK_ADDRESS=${p.agentbookAddress}`,
  ];

  if (p.bankrEvmAddress) lines.push(`BANKR_WALLET_ADDRESS=${p.bankrEvmAddress}`);
  if (p.bankrApiKey) lines.push(`BANKR_API_KEY=${p.bankrApiKey}`);
  if (p.bankrTokenAddress) lines.push(`BANKR_TOKEN_ADDRESS=${p.bankrTokenAddress}`);
  if (p.bankrTokenSymbol) lines.push(`BANKR_TOKEN_SYMBOL=${p.bankrTokenSymbol}`);
  if (p.userTimezone) lines.push(`USER_TIMEZONE=${p.userTimezone}`);

  // ── World ID env vars — paired emission ─────────────────────────────
  // SSH path (lib/ssh.ts:5558-5568) emits both NULLIFIER + LEVEL when
  // worldIdNullifier is set. LEVEL defaults to "orb" if worldIdLevel
  // is null/undefined. Cloud-init mirrors exactly.
  if (p.worldIdNullifier) {
    lines.push(`WORLD_ID_NULLIFIER=${p.worldIdNullifier}`);
    lines.push(`WORLD_ID_LEVEL=${p.worldIdLevel ?? "orb"}`);
  }

  // ── Higgsfield/Muapi video skill ────────────────────────────────────
  // SSH path (lib/ssh.ts:5382-5386) emits this unconditionally pointing
  // at our domain root (NOT /api/gateway — the muapi proxy is at the
  // root path on instaclaw.io).
  lines.push("INSTACLAW_MUAPI_PROXY=https://instaclaw.io");

  // ── Server-side API keys (conditional on resolved value) ───────────
  // Endpoint resolves each of these from process.env and passes through.
  // Mirrors SSH-path conditionals at lib/ssh.ts:6096 (elevenlabs:
  // `config.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY`),
  // lib/ssh.ts:6165 (resend), lib/ssh.ts:6216 (alpha vantage),
  // lib/ssh.ts:6270 (brave search), lib/ssh.ts:6293 (openai).
  if (p.elevenlabsApiKey) lines.push(`ELEVENLABS_API_KEY=${p.elevenlabsApiKey}`);
  if (p.resendApiKey) lines.push(`RESEND_API_KEY=${p.resendApiKey}`);
  if (p.alphavantageApiKey) lines.push(`ALPHAVANTAGE_API_KEY=${p.alphavantageApiKey}`);
  if (p.braveApiKey) lines.push(`BRAVE_SEARCH_API_KEY=${p.braveApiKey}`);
  if (p.openaiApiKey) lines.push(`OPENAI_API_KEY=${p.openaiApiKey}`);

  // ── Manifest-required env vars (per VM_MANIFEST.requiredEnvVars) ──
  //
  // Five env vars MUST exist in ~/.openclaw/.env per the manifest at
  // vm-manifest.ts:1938. Three of them are universal fleet-wide defaults
  // sourced from VM_MANIFEST.envVarDefaults; AGENT_REGION is per-VM (from
  // vm.region). GATEWAY_TOKEN was already emitted above with the other
  // per-user tokens.
  //
  // Reading directly from VM_MANIFEST avoids drift: when Cooper bumps the
  // CLOB proxy IPs (e.g., Osaka → Toronto rotation), this wrapper picks
  // up the new value on the next deploy. The SSH-configure path doesn't
  // emit these uniformly (POLYGON only at lib/ssh.ts:5155-5157, CLOB +
  // AGENT_REGION come from reconciler) — cloud-init delivers all five at
  // first boot so new VMs are immediately first-boot-complete per Cooper
  // directive 2026-05-14: "every agent ships ... no exceptions. do not
  // rely on the reconciler."
  const envDefaults = VM_MANIFEST.envVarDefaults;
  lines.push(`POLYGON_RPC_URL=${envDefaults.POLYGON_RPC_URL}`);
  lines.push(`CLOB_PROXY_URL=${envDefaults.CLOB_PROXY_URL}`);
  lines.push(`CLOB_PROXY_URL_BACKUP=${envDefaults.CLOB_PROXY_URL_BACKUP}`);
  lines.push(`AGENT_REGION=${p.agentRegion}`);

  // EDGEOS_BEARER_TOKEN — partner-gated to edge_city. JWT-shape validated
  // in validateTarballParams (boundary check, see the 2026-05-14 incident
  // commentary above). When token is absent: silent skip — the attendee-
  // directory feature doesn't work until the reconciler's stepEnvVarPush
  // delivers it on the next tick, but the agent provisions normally.
  if (p.partner === "edge_city" && p.edgeosBearerToken) {
    lines.push(`EDGEOS_BEARER_TOKEN=${p.edgeosBearerToken}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * wallet/agent.key — AgentBook private key, written as text. Mode 0o600.
 * No transformation; the agentbookKey field carries the raw key body
 * (generated server-side by the agentbook wallet provisioning).
 */
export function buildAgentKey(p: TarballParams): string {
  return p.agentbookKey.endsWith("\n") ? p.agentbookKey : p.agentbookKey + "\n";
}

// ════════════════════════════════════════════════════════════════════════
// §3b. lib/ssh.ts helper wrappers — byte-parity with configureOpenClaw
//
// These wrap existing helpers (buildPersonalizedBootstrap,
// WORKSPACE_BOOTSTRAP_SHORT, etc.) so the tarball builder can produce
// the same file contents that the SSH-configure path produces for the
// same input. Phase 1B-2 will compare byte-for-byte between a cloud-
// init-provisioned VM and an SSH-configure-provisioned VM; any drift
// here fails that audit.
//
// See docs/cloud-init-wrapper-contracts-2026-05-13.md §1 for the full
// contract documentation behind each wrapper.
// ════════════════════════════════════════════════════════════════════════

/**
 * BOOTSTRAP.md — the agent's first-run instructions.
 *
 * Mirrors the branch logic at lib/ssh.ts:5791 exactly:
 *
 *   if (config.gmailProfileSummary) {
 *     bootstrap = buildPersonalizedBootstrap(config.gmailProfileSummary);
 *   } else {
 *     bootstrap = WORKSPACE_BOOTSTRAP_SHORT;
 *   }
 *
 * **Why pass `p.gmailProfileSummary` through to buildPersonalizedBootstrap
 * even though that function currently ignores it:** today the param is
 * vestigial (the template doesn't substitute it anywhere — see contract
 * doc §1.1). But the SSH-configure path passes the actual content. If
 * buildPersonalizedBootstrap ever starts using the param in the future
 * — a silent contract change — BOTH the SSH path AND this wrapper will
 * pick up the new behavior identically. Passing "" instead would cause
 * silent drift between the two paths at that point.
 *
 * Truthy-check semantics match the SSH path:
 *   - non-empty string → personalized bootstrap
 *   - empty string ""  → short bootstrap (empty is falsy in JS)
 *   - null / undefined → short bootstrap
 *   - whitespace "   " → personalized bootstrap (whitespace is truthy)
 *
 * Mode 0o644.
 */
export function buildBootstrapMd(p: TarballParams): string {
  if (p.gmailProfileSummary) {
    return buildPersonalizedBootstrap(p.gmailProfileSummary);
  }
  return WORKSPACE_BOOTSTRAP_SHORT;
}

/**
 * USER.md — the agent's profile dossier of the human.
 *
 * Returns `string | null`. **null is load-bearing**: the caller (Day 8's
 * collectCoreEntries assembler) must omit the tarball entry entirely
 * when this returns null. configureOpenClaw at lib/ssh.ts:5812-5826
 * (Gmail-absent branch) does NOT write USER.md at all — for byte-parity,
 * the cloud-init path must skip the file under the same condition.
 *
 * Writing a default-placeholder USER.md would diverge from the SSH path
 * (the file would EXIST with placeholder content vs not exist at all)
 * and Phase 1B-2's byte compare would fail. **DO NOT add a placeholder
 * default branch here.** The "file absent" state is the SSH-configure-
 * matching behavior for Gmail-absent users.
 *
 * Truthy-check mirrors lib/ssh.ts:5791:
 *   - non-empty string → buildUserMd(content)
 *   - empty string ""  → null (configure path skips this file)
 *   - null / undefined → null
 *   - whitespace "   " → buildUserMd("   ") (truthy in JS; matches SSH path)
 *
 * Known pre-existing bug PRESERVED for byte-parity (see contract doc
 * §1.2 + commit c893f76e references): buildUserMd's name regex is
 * ASCII-only —
 *   /^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s(?:is|works|lives)/m
 * which fails for Cyrillic ("Андрей" — vm-918's user) / CJK / non-ASCII
 * first letters → fullName silently falls back to "User". Cloud-init
 * path matches this verbatim. Fixing the regex requires touching
 * buildUserMd itself in lib/ssh.ts, which both paths would then pick
 * up automatically — out of scope for this wrapper.
 *
 * Mode 0o644.
 */
export function buildUserMdForTarball(p: TarballParams): string | null {
  if (!p.gmailProfileSummary) {
    return null;
  }
  return buildUserMd(p.gmailProfileSummary);
}

/**
 * system-prompt.md — the agent's gateway-side system prompt scaffold.
 *
 * **READ THIS BEFORE DEBUGGING WHY YOUR SYSTEM PROMPT EDITS DON'T STICK.**
 *
 * This file is documented dead-weight. The function being wrapped
 * (buildSystemPrompt at lib/ssh.ts:8995-9082) closes its own template
 * with this comment:
 *
 *   <!-- WARNING: This file is NOT read by OpenClaw. Agent instructions
 *        now live in SOUL.md (behavioral rules) and CAPABILITIES.md
 *        (tool routing). This file exists for debugging/reference only. -->
 *
 * Both the SSH-configure path AND the cloud-init path emit it because
 * Phase 1B-2's byte-compare audit demands byte-identical filesystem
 * state. But the gateway never reads it — agent behavior is driven by
 * SOUL.md + CAPABILITIES.md (both SNAPSHOT_BAKED, not per-user). If you
 * edit system-prompt.md on a VM and your changes don't take effect,
 * THAT IS EXPECTED. Edit SOUL.md or CAPABILITIES.md instead.
 *
 * configureOpenClaw calls buildSystemPrompt in two places:
 *   line 5798: `buildSystemPrompt(config.gmailProfileSummary)`   (Gmail-present)
 *   line 5815: `buildSystemPrompt('')`                            (Gmail-absent)
 *
 * Both branches always produce the file. The function's body branches
 * internally on `memoryContent.trim()`:
 *   - non-empty → "## Your Owner\n${content}\n## Session Continuity — CRITICAL\n..."
 *   - empty     → "## Your Owner\nYour owner hasn't connected their profile yet..."
 *
 * Wrapper passes through `p.gmailProfileSummary ?? ""` (handles
 * null/undefined safely — `.trim()` on the raw param would crash).
 * The empty-string coalesce produces byte-identical output to the SSH
 * path's line-5815 explicit `''` argument.
 *
 * Mode 0o644.
 */
export function buildSystemPromptForTarball(p: TarballParams): string {
  return buildSystemPrompt(p.gmailProfileSummary ?? "");
}

/**
 * The two destination paths where MEMORY.md is written by both the
 * SSH-configure path AND this cloud-init path. The Day 8 assembler
 * emits TWO TarEntry objects with identical body bytes, one per path.
 *
 * **TECH DEBT — DO NOT NORMALIZE TO ONE PATH WITHOUT READING §5b(e) FIRST.**
 *
 * Per the investigation at docs/cloud-init-wrapper-contracts-2026-05-13.md
 * §5b(e), the agents/main/agent/MEMORY.md copy is fossilized at provision
 * time and never updated:
 *   - workspace/MEMORY.md: LIVE source of truth. Written by
 *     configureOpenClaw (line 5803), strip-thinking.py (line 1273), and
 *     the agent's own SOUL.md memory-filing system. Read by gateway
 *     bootstrap (annotated "bootstrap-loaded" at line 1273 of strip-
 *     thinking).
 *   - agents/main/agent/MEMORY.md: WRITE-ONCE-AT-PROVISION. ONLY writer
 *     in the entire repo is configureOpenClaw line 5809. The ONLY other
 *     reference is the delete-loop at line 9835 (privacy wipe). NO
 *     reader was found in lib/ssh.ts or strip-thinking.py.
 *
 * The cloud-init path preserves the double-write for byte-parity with
 * configureOpenClaw (Phase 1B-2 byte compare). P1 follow-up: a separate
 * PR removes the agent-dir write from BOTH paths simultaneously; the
 * delete-loop at line 9835 stays as defensive cleanup for legacy VMs.
 *
 * If you find yourself wanting to remove ONE of these paths, REMOVE BOTH
 * (and ship the configureOpenClaw delete in the same PR) or you'll
 * break Phase 1B-2.
 */
export const MEMORY_MD_PATHS = [
  "home/openclaw/.openclaw/workspace/MEMORY.md",
  "home/openclaw/.openclaw/agents/main/agent/MEMORY.md",
] as const;

/**
 * MEMORY.md — the agent's long-term memory file (Gmail-derived initial
 * content). Returns the content string that gets emitted at BOTH paths
 * in MEMORY_MD_PATHS above. Day 8's collectCoreEntries assembler is
 * responsible for the dual emission.
 *
 * configureOpenClaw at lib/ssh.ts:5795 writes `config.gmailProfileSummary`
 * verbatim (base64-encoded for shell-transit safety, then decoded back to
 * the original bytes on the VM). The wrapper is a literal pass-through.
 * No template, no string substitution — same input bytes go in, same
 * input bytes come out. Markdown special characters, Unicode (Cyrillic /
 * CJK / emoji), embedded code blocks, template-literal-looking syntax
 * — all preserved verbatim because this is not a template, it's a
 * straight value copy.
 *
 * Gmail-absent (gmailProfileSummary null/undefined/empty): returns null.
 * The SSH path's line 5812-5826 (Gmail-absent branch) does NOT write
 * MEMORY.md — it falls through to the defensive heredoc block at line
 * 5831+ which creates a default template ONLY IF the file is missing.
 * Cloud-init must match by omitting both entries. The setup.sh template
 * (Day 8) already includes the equivalent defensive heredoc.
 *
 * Mode 0o644 (both paths).
 */
export function buildMemoryMdForTarball(p: TarballParams): string | null {
  if (!p.gmailProfileSummary) {
    return null;
  }
  return p.gmailProfileSummary;
}

/**
 * openclaw.json — the gateway's primary config blob. The most complex
 * wrapper because buildOpenClawConfig takes 5 arguments (incl. an
 * optional braveKey) and produces ~5KB of stringified JSON with eight
 * top-level keys + four conditional sub-blocks.
 *
 * Returns an OBJECT, not a string. The caller (Day 8's assembler) does
 * `JSON.stringify(result, null, 2)` to convert. Matches the SSH-configure
 * path at lib/ssh.ts:5074 + 5080 (or wherever the stringify happens).
 *
 * Mapping from TarballParams → UserConfig (per contracts §1.4 table):
 *   - apiMode, apiKey, tier              ─ direct pass-through
 *   - telegramBotToken, discordBotToken  ─ direct pass-through
 *   - channels                            ─ direct pass-through
 *   - braveApiKey                         ─ direct pass-through (also flows
 *                                            as 5th arg to buildOpenClawConfig)
 *   - gmailProfileSummary                 ─ pass-through (buildOpenClawConfig
 *                                            does not currently read this,
 *                                            but the UserConfig type allows it;
 *                                            future-proofs against a change)
 *   - defaultModel                        ─ becomes UserConfig.model AND the
 *                                            4th positional arg openclawModel
 *   - userName/userEmail/userTimezone     ─ pass-through (used by other paths)
 *   - telegramBotUsername                 ─ becomes UserConfig.botUsername
 *   - worldId*, bankr*, partner           ─ pass-through
 *
 * Three positional arguments to buildOpenClawConfig (besides config):
 *   - gatewayToken: `p.gatewayToken` directly.
 *   - proxyBaseUrl: `${nextauthUrl}/api/gateway` for all-inclusive (so the
 *     gateway proxies Anthropic calls through us); empty string for BYOK
 *     (Anthropic SDK uses its default base URL — direct to Anthropic).
 *   - openclawModel: `p.defaultModel` (the agents.defaults.model.primary).
 *   - braveKey: `p.braveApiKey` truthy → web search enabled; else undefined.
 *
 * EDGEOS_BEARER_TOKEN does NOT belong in openclaw.json — that's a .env
 * concern (handled in buildDotEnv above). buildOpenClawConfig has no
 * partner-conditional config beyond what UserConfig.partner declares.
 *
 * Throws (inherited from buildOpenClawConfig): if any browser.profiles
 * entry lacks both cdpPort and cdpUrl. The hardcoded "openclaw" profile
 * sets cdpPort:18800, so this never trips in practice — but the validation
 * is part of the contract we're inheriting.
 *
 * Mode 0o600.
 */
export function buildOpenClawJsonForTarball(p: TarballParams): object {
  const config: UserConfig = {
    apiMode: p.apiMode,
    apiKey: p.apiKey ?? undefined,
    tier: p.tier,
    model: p.defaultModel,
    telegramBotToken: p.telegramBotToken,
    discordBotToken: p.discordBotToken ?? undefined,
    channels: p.channels,
    braveApiKey: p.braveApiKey ?? undefined,
    gmailProfileSummary: p.gmailProfileSummary ?? undefined,
    userName: p.userName ?? undefined,
    userEmail: p.userEmail ?? undefined,
    botUsername: p.telegramBotUsername,
    userTimezone: p.userTimezone ?? undefined,
    worldIdNullifier: p.worldIdNullifier ?? undefined,
    worldIdLevel: p.worldIdLevel ?? undefined,
    bankrApiKey: p.bankrApiKey ?? undefined,
    bankrEvmAddress: p.bankrEvmAddress ?? undefined,
    bankrTokenAddress: p.bankrTokenAddress ?? undefined,
    bankrTokenSymbol: p.bankrTokenSymbol ?? undefined,
    partner: p.partner ?? undefined,
  };

  // proxyBaseUrl:
  //   - all_inclusive: route Anthropic calls through our proxy so we can
  //     authenticate + meter. Strip trailing slashes from nextauthUrl
  //     before appending /api/gateway (validateTarballParams already
  //     rejects ?/# in nextauthUrl, so the simple replace is safe).
  //   - byok: pass empty string → buildOpenClawConfig emits
  //     `models.providers.anthropic: {}` (no baseUrl override; SDK defaults
  //     to https://api.anthropic.com).
  const proxyBaseUrl =
    p.apiMode === "all_inclusive"
      ? `${p.nextauthUrl.replace(/\/+$/, "")}/api/gateway`
      : "";

  // braveKey: undefined when absent so buildOpenClawConfig's `if (braveKey)`
  // gate skips the tools.web + plugins.brave blocks. Empty string is also
  // falsy in JS but undefined is the spec-aligned "this argument was not
  // provided" signal.
  const braveKey = p.braveApiKey || undefined;

  return buildOpenClawConfig(config, p.gatewayToken, proxyBaseUrl, p.defaultModel, braveKey);
}

// ════════════════════════════════════════════════════════════════════════
// §4. Partner overlay selection
// ════════════════════════════════════════════════════════════════════════

/**
 * Returns the set of overlay entries the tarball should include for this
 * VM's partner. Three universal-or-conditional shapes:
 *   - bankr-overlay.md: universal (every VM gets BANKR_SKILL_PATCH_DIRECTIVE).
 *   - soul-edge-stub.md: edge_city only.
 *   - soul-consensus-stub.md: edge_city OR consensus_2026.
 *   - edge-instaclaw-overlay.md: edge_city only.
 *
 * setup.sh checks `[ -f /tmp/instaclaw-config/overlays/<file> ]` so
 * omitting a file from the tarball is the natural "this partner doesn't
 * get this overlay" signal — setup.sh doesn't need per-partner switches.
 */
function buildPartnerOverlays(p: TarballParams): TarEntry[] {
  const overlays: TarEntry[] = [
    {
      // Universal — bankr SKILL.md prepend for every VM.
      path: "overlays/bankr-overlay.md",
      body: BANKR_SKILL_PATCH_DIRECTIVE,
    },
  ];

  const partner = p.partner ?? "";

  if (partner === "edge_city") {
    overlays.push(
      {
        path: "overlays/soul-edge-stub.md",
        body: SOUL_STUB_EDGE,
      },
      {
        path: "overlays/edge-instaclaw-overlay.md",
        body: EDGE_INSTACLAW_OVERLAY_MD,
      },
    );
  }

  if (partner === "edge_city" || partner === "consensus_2026") {
    overlays.push({
      path: "overlays/soul-consensus-stub.md",
      body: SOUL_STUB_CONSENSUS,
    });
  }

  return overlays;
}

// ════════════════════════════════════════════════════════════════════════
// §5. Tar.gz packing
// ════════════════════════════════════════════════════════════════════════

/**
 * Pack the entries into a streaming tar.gz. Returns a Readable that the
 * /api/vm/cloud-init-config endpoint pipes into the response body.
 *
 * tar-stream's pack.entry() is async-callback-based. We serialize entries
 * (parallel writes would race the format). Total wall-clock for ~15
 * small entries ≈ 1-5ms — the streaming model is for the network
 * response, not for parallel file writes.
 *
 * Error handling: if any entry write throws, the gzip stream is
 * destroyed with that error. The caller's pipe() will emit 'error' on
 * the response stream → the HTTP client (the bootstrap's curl) sees a
 * truncated response, retries (3 attempts × 5s backoff per the
 * bootstrap), or eventually marks /tmp/.instaclaw-failed.
 */
/**
 * Pinned mtime for every tar entry. tar-stream's `pack.entry()` defaults
 * mtime to `new Date()` at call time, which makes back-to-back tarball
 * builds non-deterministic across second boundaries (caught by test4 on
 * 2026-05-14 after Fix 3 widened the test surface). Pinning to a fixed
 * historical epoch makes the output byte-identical for the same inputs
 * and gives Phase 1B-2's byte-compare a stable baseline.
 *
 * Value: 2026-01-01T00:00:00Z (start of 2026). Arbitrary but stable.
 */
const TARBALL_FIXED_MTIME = new Date("2026-01-01T00:00:00Z");

function packTarGz(entries: TarEntry[]): Readable {
  const pack = tarPack();
  const gzip = createGzip();

  // Chain: pack → gzip → returned to caller.
  pack.pipe(gzip);

  (async () => {
    try {
      for (const e of entries) {
        const body = Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body, "utf-8");
        await new Promise<void>((resolve, reject) => {
          pack.entry(
            {
              name: e.path,
              size: body.length,
              mode: e.mode ?? 0o644,
              mtime: TARBALL_FIXED_MTIME,
            },
            body,
            (err) => (err ? reject(err) : resolve()),
          );
        });
      }
      pack.finalize();
    } catch (err) {
      // Propagate to gzip → response stream emits 'error'.
      pack.destroy(err instanceof Error ? err : new Error(String(err)));
      gzip.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return gzip;
}

// ════════════════════════════════════════════════════════════════════════
// §6. Main — builds the tarball entry list (foundation)
// ════════════════════════════════════════════════════════════════════════

/**
 * Build the partial tarball entry list. Used by the smoke test
 * (scripts/_test-cloud-init-tarball.ts) to validate the file-set in
 * isolation, and by the (future) buildCloudInitTarball entry point
 * which combines these entries with the remaining wrappers
 * (openclaw.json, BOOTSTRAP.md, USER.md, system-prompt.md, MEMORY.md
 * double-write, setup.sh).
 *
 * Includes:
 *   - auth-profiles.json (mode 0o600)
 *   - .env (mode 0o600)
 *   - workspace/IDENTITY.md, WALLET.md, WORLD_ID.md (conditional)
 *   - wallet/agent.key (mode 0o600)
 *   - partner overlays (bankr universal; soul-edge/consensus/edge-
 *     overlay per partner)
 */
export function collectPartialEntries(p: TarballParams): TarEntry[] {
  validateTarballParams(p);

  const entries: TarEntry[] = [];

  entries.push({
    path: "home/openclaw/.openclaw/agents/main/agent/auth-profiles.json",
    body: buildAuthProfilesJsonForTarball(p),
    mode: 0o600,
  });

  entries.push({
    path: "home/openclaw/.openclaw/.env",
    body: buildDotEnv(p),
    mode: 0o600,
  });

  entries.push({
    path: "home/openclaw/.openclaw/workspace/IDENTITY.md",
    body: buildIdentityMdForTarball(p),
  });

  entries.push({
    path: "home/openclaw/.openclaw/workspace/WALLET.md",
    body: buildWalletMdForTarball(p),
  });

  const worldId = buildWorldIdMdForTarball(p);
  if (worldId) {
    entries.push({
      path: "home/openclaw/.openclaw/workspace/WORLD_ID.md",
      body: worldId,
    });
  }

  entries.push({
    path: "home/openclaw/.openclaw/wallet/agent.key",
    body: buildAgentKey(p),
    mode: 0o600,
  });

  entries.push(...buildPartnerOverlays(p));

  return entries;
}

/**
 * Build the streaming tar.gz from a partial entry list. Used by smoke
 * tests + the chunk-1 verification path. The full buildCloudInitTarball
 * (chunk 2 in Day 8) calls collectPartialEntries + collectRemainingEntries
 * + packTarGz.
 */
export function packPartialTarball(p: TarballParams): Readable {
  return packTarGz(collectPartialEntries(p));
}

// Re-exported for the future Day 8 assembler.
export { packTarGz };
export type { TarEntry };

// ── buildCloudInitTarball entry point — pending Day 8a ──────────────────
//
// The /api/vm/cloud-init-config endpoint will call a single function
// that assembles every entry the tarball needs. That function is the
// only remaining piece of Day 4-7 work. Shape:
//
//   export function buildCloudInitTarball(p: TarballParams): Readable {
//     validateTarballParams(p);
//     return packTarGz([
//       ...collectPartialEntries(p),
//       { path: "home/openclaw/.openclaw/openclaw.json",
//         body: JSON.stringify(buildOpenClawJsonForTarball(p), null, 2),
//         mode: 0o600 },
//       { path: "home/openclaw/.openclaw/workspace/BOOTSTRAP.md",
//         body: buildBootstrapMd(p) },
//       ...(buildUserMdForTarball(p) ? [{ path: ".../USER.md", body: ... }] : []),
//       { path: ".../agent/system-prompt.md", body: buildSystemPromptForTarball(p) },
//       ...(buildMemoryMdForTarball(p)
//             ? MEMORY_MD_PATHS.map(path => ({ path, body: buildMemoryMdForTarball(p)! }))
//             : []),
//       { path: "setup.sh", body: buildSetupSh(p), mode: 0o755 },
//     ]);
//   }
//
// Gated on the post-audit fixes landing (Fixes 1-5 from
// docs/cloud-init-audit-2026-05-14.md) — Day 8a should not assemble a
// tarball wired up with bug-laden wrappers.
