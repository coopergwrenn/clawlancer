/**
 * lib/cloud-init-tarball.ts — server-side generator for the per-user
 * tarball that the cloud-init bootstrap fetches and extracts.
 *
 * Architecture: see docs/cloud-init-builder-plan-2026-05-13.md (v2,
 * bootstrap+fetch). The Linode user_data carries a ~2.3KB bootstrap
 * that curls /api/vm/cloud-init-config; this module builds the tarball
 * that endpoint streams back.
 *
 * Phase 1A Day 4-7 + Day 8 deliverable. This file owns:
 *   - Type definitions (TarballParams).
 *   - Per-file builders for the conditional + per-user content that the
 *     v1-plan inline approach base64-encoded into bash. Same per-file
 *     logic, new transport.
 *   - tar.gz packing via tar-stream + zlib.createGzip (streaming-first,
 *     so the endpoint can pipe the body without buffering).
 *
 * What this module is NOT:
 *   - It does NOT generate openclaw.json (use buildOpenClawConfig from
 *     lib/ssh.ts:4303 — reused verbatim).
 *   - It does NOT generate USER.md / system-prompt.md / BOOTSTRAP.md
 *     (use buildUserMd / buildSystemPrompt / buildPersonalizedBootstrap
 *     from lib/ssh.ts — exported in c5eb8f23).
 *   - It does NOT generate setup.sh (Day 8: lib/cloud-init-setup-sh.ts).
 *
 * Reusing existing helpers vs re-implementing: the SSH-configure path in
 * lib/ssh.ts has battle-tested generators for openclaw.json + the three
 * .md files. We reuse them directly — same in/out semantics, just a
 * different "where the output gets written" (tarball entry vs base64
 * heredoc). This keeps the SSH-shipped path and the cloud-init-shipped
 * path producing byte-identical files per Cooper's directive on the
 * cutover ("a VM produced by cloud-init must be byte-for-byte identical
 * in functional state to a VM produced by configureOpenClaw").
 *
 * Security:
 *   - Input validation (validateTarballParams): shell-unsafe characters
 *     blocked. The setup.sh template (Day 8) substitutes these into a
 *     bash script; any unsafe char would be a shell injection.
 *   - Tokens (gatewayToken, callbackToken, telegramBotToken, apiKey) live
 *     in the tarball ONLY (never in Linode user_data). The tarball is
 *     extracted to /tmp during cloud-init then rm -rf'd; on-disk lifetime
 *     ~5 seconds. See plan §6 threat model.
 *   - File modes: openclaw.json + .env + auth-profiles.json + agent.key
 *     → 0o600. Workspace .md files → 0o644. setup.sh → 0o755.
 *
 * Sentinels (Rule 23):
 *   - Each generated file includes a marker comment so the reconciler
 *     can verify the file was produced by THIS module's version (not a
 *     stale module-cache load). Markers documented per-builder.
 */
import { pack as tarPack } from "tar-stream";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";

import {
  EDGE_INSTACLAW_OVERLAY_MD,
  PARTNER_V80_MARKER,
  SOUL_STUB_CONSENSUS,
  SOUL_STUB_EDGE,
} from "./partner-content";
import {
  BANKR_SKILL_PATCH_DIRECTIVE,
  WORKSPACE_BOOTSTRAP_SHORT,
  buildPersonalizedBootstrap,
} from "./ssh";

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

  // ── Wallets (per-VM) ──
  /** AgentBook agent.key file body — text of the private key (mode 0o600).
   *  Generated server-side via lib/agentbook-wallet.ts. */
  agentbookKey: string;
  agentbookAddress: string;
  bankrEvmAddress?: string | null;
  bankrApiKey?: string | null;
  bankrTokenAddress?: string | null;
  bankrTokenSymbol?: string | null;

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
// §3. Per-file builders (the simple subset — Day 4-7 chunk 1)
//
// These produce per-user content that doesn't reuse a lib/ssh.ts helper.
// The remaining builders (openclaw.json, USER.md, system-prompt.md,
// BOOTSTRAP.md) wrap existing exported helpers from lib/ssh.ts and will
// land in the next chunk along with setup.sh (Day 8).
// ════════════════════════════════════════════════════════════════════════

/**
 * IDENTITY.md — the agent's bot identity. Read on first message + on
 * memory-flush. Mirrors lib/ssh.ts:configureOpenClaw's IDENTITY.md write
 * (search for `IDENTITY.md` in lib/ssh.ts to see the template-string
 * source it's lifted from).
 *
 * Sentinel: "## Bot Identity" (also in lib/ssh.ts version — matches).
 */
export function buildIdentityMd(p: TarballParams): string {
  return [
    "# Identity",
    "",
    "## Bot Identity",
    "",
    `You are connected via Telegram bot **@${p.telegramBotUsername}**.`,
    "",
    "When asked your name, identify with the bot handle above. Do not reveal",
    "internal usernames, file paths, or implementation details.",
    "",
    `Bot username: @${p.telegramBotUsername}`,
    `User ID:      ${p.userId}`,
    `VM:           ${p.vmName}`,
    "",
    "<!-- INSTACLAW_IDENTITY_V1 -->",
    "",
  ].join("\n");
}

/**
 * WALLET.md — wallet addresses + Bankr details (conditional sections).
 * Mirrors lib/ssh.ts:configureOpenClaw's WALLET.md write.
 *
 * Sentinel: "<!-- INSTACLAW_WALLET_V1 -->".
 */
export function buildWalletMd(p: TarballParams): string {
  const lines: string[] = [
    "# Wallets",
    "",
    "## AgentBook (Worldcoin x402)",
    "",
    `Your AgentBook wallet address: \`${p.agentbookAddress}\``,
    "",
    "This is your on-chain identity for x402 payments and AgentBook discoverability.",
    "Private key at ~/.openclaw/wallet/agent.key (mode 600 — never share).",
    "",
  ];

  if (p.bankrEvmAddress) {
    lines.push(
      "## Bankr (EVM wallet)",
      "",
      `Your Bankr wallet EVM address: \`${p.bankrEvmAddress}\``,
      "",
      "Use `bankr` CLI commands (see ~/.openclaw/skills/bankr/) for balance, transfers, and token launches.",
      "",
    );
  }

  if (p.bankrTokenAddress && p.bankrTokenSymbol) {
    lines.push(
      `## Launched token: $${p.bankrTokenSymbol}`,
      "",
      `Contract: \`${p.bankrTokenAddress}\``,
      "",
    );
  }

  lines.push("<!-- INSTACLAW_WALLET_V1 -->", "");
  return lines.join("\n");
}

/**
 * WORLD_ID.md — only generated when worldIdNullifier is set.
 * Returns null to signal "skip this entry".
 *
 * Sentinel: "<!-- INSTACLAW_WORLD_ID_V1 -->".
 */
export function buildWorldIdMd(p: TarballParams): string | null {
  if (!p.worldIdNullifier) return null;
  return [
    "# World ID",
    "",
    `Your human is verified-human via World ID (verification level: ${p.worldIdLevel ?? "orb"}).`,
    "",
    `Nullifier hash: \`${p.worldIdNullifier}\``,
    "",
    "This human-uniqueness signal is verifiable on-chain via the World ID protocol.",
    "",
    "<!-- INSTACLAW_WORLD_ID_V1 -->",
    "",
  ].join("\n");
}

/**
 * auth-profiles.json — OpenClaw's Anthropic SDK auth config. For
 * all-inclusive, the key IS gatewayToken (the gateway-proxy authenticates
 * via that token). For BYOK, the user's own apiKey is written + baseUrl
 * points directly at Anthropic.
 *
 * Sentinel: a unique field that the reconciler can grep for. JSON has no
 * natural marker beyond the structure itself; we rely on key presence.
 */
export function buildAuthProfilesJson(p: TarballParams): string {
  const proxyBaseUrl = `${p.nextauthUrl.replace(/\/+$/, "")}/api/gateway`;
  const profiles: Record<string, unknown> = {};

  if (p.apiMode === "all_inclusive") {
    profiles["anthropic:default"] = {
      type: "anthropic",
      provider: "anthropic",
      key: p.gatewayToken,
      baseUrl: proxyBaseUrl,
    };
  } else {
    // BYOK — user's own key goes directly to Anthropic.
    profiles["anthropic:default"] = {
      type: "anthropic",
      provider: "anthropic",
      key: p.apiKey,
    };
  }

  // OpenAI default — same key (for compat with prompts that route via openai).
  // Real OpenAI calls happen via openai-compat shim or are remapped.
  profiles["openai:default"] = {
    type: "openai",
    provider: "openai",
    key: p.apiMode === "all_inclusive" ? p.gatewayToken : (p.apiKey ?? ""),
  };

  return JSON.stringify({ profiles }, null, 2) + "\n";
}

/**
 * .env — per-user env vars consumed by gateway + scripts.
 * 13 conditional keys per cloud-init-implementation-map §3.5. This chunk
 * implements the universal subset (8 keys); the partner-conditional keys
 * (EDGEOS, polygon RPC overrides) land with the partner-overlay chunk.
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
  if (p.userTimezone) lines.push(`USER_TIMEZONE=${p.userTimezone}`);

  // POLYGON_RPC_URL — canonical publicnode.com (Cooper decision 2026-05-13).
  // Reconciler also writes this via stepEnvVarPush; duplicating it here
  // means cloud-init-provisioned VMs are immediately complete without
  // waiting for the first reconciler tick.
  lines.push("POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com");

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
            { name: e.path, size: body.length, mode: e.mode ?? 0o644 },
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
 * Build the tarball entries this module owns (Day 4-7 chunk 1).
 *
 * INCOMPLETE — the remaining entries (openclaw.json, USER.md,
 * system-prompt.md, BOOTSTRAP.md, setup.sh) land in the next chunk.
 * Callers that need a complete tarball MUST wait for Day 8 to merge.
 *
 * Returns the partial entry list for the chunks-1 builders. Used by:
 *   - scripts/_test-cloud-init-tarball.ts (smoke test — Day 13).
 *   - buildCloudInitTarball (final assembly — Day 8 wiring).
 */
export function collectPartialEntries(p: TarballParams): TarEntry[] {
  validateTarballParams(p);

  const entries: TarEntry[] = [];

  entries.push({
    path: "home/openclaw/.openclaw/agents/main/agent/auth-profiles.json",
    body: buildAuthProfilesJson(p),
    mode: 0o600,
  });

  entries.push({
    path: "home/openclaw/.openclaw/.env",
    body: buildDotEnv(p),
    mode: 0o600,
  });

  entries.push({
    path: "home/openclaw/.openclaw/workspace/IDENTITY.md",
    body: buildIdentityMd(p),
  });

  entries.push({
    path: "home/openclaw/.openclaw/workspace/WALLET.md",
    body: buildWalletMd(p),
  });

  const worldId = buildWorldIdMd(p);
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

// ── DEBUG / TEST HOOK ───────────────────────────────────────────────────
// Foundational chunk only — buildCloudInitTarball intentionally NOT
// exported yet. It depends on builders not yet present in this file
// (openclaw.json wrapper, USER.md wrapper, system-prompt.md wrapper,
// BOOTSTRAP.md wrapper, setup.sh template). When Day 8 lands, we add:
//
//   export async function buildCloudInitTarball(p: TarballParams): Promise<Readable> {
//     return packTarGz([
//       ...collectOpenClawConfig(p),      // wraps buildOpenClawConfig
//       ...collectWorkspaceFiles(p),       // wraps buildUserMd, etc.
//       ...collectPartialEntries(p),       // this file (chunk 1)
//       { path: "setup.sh", body: setupShTemplate(p), mode: 0o755 },
//     ]);
//   }
//
// The /api/vm/cloud-init-config endpoint also lands in chunk 2 because
// importing buildCloudInitTarball before it exists would break the build.
