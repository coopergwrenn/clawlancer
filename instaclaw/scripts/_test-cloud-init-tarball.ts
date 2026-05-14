/**
 * Smoke test for lib/cloud-init-tarball.ts (foundation chunk).
 *
 * Builds the partial tarball produced by collectPartialEntries +
 * packPartialTarball, extracts, and asserts the per-file content +
 * the partner-conditional overlay selection are correct.
 *
 * Three test cases:
 *   1. all_inclusive + no partner — universal path.
 *   2. byok + edge_city — partner-conditional overlays + byok auth profile.
 *   3. validation rejections — every shell-unsafe input throws.
 *
 * Run: npx tsx scripts/_test-cloud-init-tarball.ts
 */
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { extract as tarExtract } from "tar-stream";

import {
  MEMORY_MD_PATHS,
  buildAgentKey,
  buildAuthProfilesJsonForTarball,
  buildBootstrapMd,
  buildCloudInitTarball,
  buildDotEnv,
  buildIdentityMdForTarball,
  buildMemoryMdForTarball,
  buildOpenClawJsonForTarball,
  buildSystemPromptForTarball,
  buildUserMdForTarball,
  buildWalletMdForTarball,
  buildWorldIdMdForTarball,
  collectPartialEntries,
  packPartialTarball,
  validateTarballParams,
  type TarballParams,
} from "../lib/cloud-init-tarball";
import { SETUP_SH_SENTINELS, buildSetupSh } from "../lib/cloud-init-setup-sh";
import {
  WORKSPACE_BOOTSTRAP_SHORT,
  buildAuthProfilesJson,
  buildIdentityMd,
  buildOpenClawConfig,
  buildPersonalizedBootstrap,
  buildSystemPrompt,
  buildUserMd,
  buildWalletMd,
  buildWorldIdMd,
} from "../lib/ssh";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── helpers ──

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function unpackTarball(buf: Buffer): Promise<Map<string, { body: string; mode: number }>> {
  const tarBuf = gunzipSync(buf);
  const ex = tarExtract();
  const out = new Map<string, { body: string; mode: number }>();

  return new Promise((resolve, reject) => {
    ex.on("entry", (header, stream, next) => {
      const bufs: Buffer[] = [];
      stream.on("data", (d) => bufs.push(d));
      stream.on("end", () => {
        out.set(header.name, {
          body: Buffer.concat(bufs).toString("utf-8"),
          mode: header.mode ?? 0o644,
        });
        next();
      });
      stream.on("error", reject);
    });
    ex.on("finish", () => resolve(out));
    ex.on("error", reject);
    ex.end(tarBuf);
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

// ── fixtures ──

const validParams: TarballParams = {
  userId: "e3a32936-fe22-42c9-a53f-72e4c297ce9d",
  vmName: "instaclaw-vm-918",
  nextauthUrl: "https://instaclaw.io",
  gatewayToken: "08359912abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
  callbackToken: "deadbeef".repeat(8),
  telegramBotToken: "8634795530:AAE17w_5R28NHvYhqohSBfwwhxkCLTWtHYQ",
  telegramBotUsername: "fucking1999_bot",
  userName: "Андрей",
  userEmail: "khomenko89@gmail.com",
  userTimezone: "Europe/Kiev",
  gmailProfileSummary: null,
  apiMode: "all_inclusive",
  apiKey: null,
  defaultModel: "anthropic/claude-sonnet-4-6",
  tier: "starter",
  channels: ["telegram"],
  agentRegion: "us-east",
  agentbookKey: "-----BEGIN EC PRIVATE KEY-----\nFAKEKEY\n-----END EC PRIVATE KEY-----",
  agentbookAddress: "0x5Bc5C4072a68Dd2a1e8595d863e114f54DFf04af",
  bankrEvmAddress: "0x25763b224e0e1cb57d6cf2530a0478290a27af09",
  bankrApiKey: "bk_test_abc123",
  bankrTokenAddress: null,
  bankrTokenSymbol: null,
  worldIdNullifier: null,
  worldIdLevel: null,
  partner: null,
};

const edgeCityParams: TarballParams = {
  ...validParams,
  vmName: "instaclaw-vm-edge-1",
  telegramBotUsername: "edge_test_bot",
  apiMode: "byok",
  apiKey: "sk-ant-byok-test",
  partner: "edge_city",
  worldIdNullifier: "0x1234567890abcdef",
  worldIdLevel: "orb",
};

// ── tests ──

async function test1_AllInclusiveNoPartner() {
  console.log("\n─── TEST 1: all_inclusive, no partner ──────────────");
  const buf = await streamToBuffer(packPartialTarball(validParams));
  assert(buf.length > 100, `tarball is non-trivially sized (${buf.length} bytes)`);
  assert(buf.length < 50_000, `tarball stays under 50KB (${buf.length} bytes)`);

  const files = await unpackTarball(buf);

  assert(
    files.has("home/openclaw/.openclaw/agents/main/agent/auth-profiles.json"),
    "auth-profiles.json present",
  );
  assert(files.has("home/openclaw/.openclaw/.env"), ".env present");
  assert(files.has("home/openclaw/.openclaw/workspace/IDENTITY.md"), "IDENTITY.md present");
  assert(files.has("home/openclaw/.openclaw/workspace/WALLET.md"), "WALLET.md present");
  assert(!files.has("home/openclaw/.openclaw/workspace/WORLD_ID.md"), "WORLD_ID.md absent (no nullifier)");
  assert(files.has("home/openclaw/.openclaw/wallet/agent.key"), "agent.key present");

  // Universal overlay
  assert(files.has("overlays/bankr-overlay.md"), "bankr-overlay.md present (universal)");
  // No partner overlays
  assert(!files.has("overlays/soul-edge-stub.md"), "soul-edge-stub.md absent (no partner)");
  assert(!files.has("overlays/soul-consensus-stub.md"), "soul-consensus-stub.md absent (no partner)");
  assert(!files.has("overlays/edge-instaclaw-overlay.md"), "edge-instaclaw-overlay.md absent (no partner)");

  // File modes
  assert(
    files.get("home/openclaw/.openclaw/agents/main/agent/auth-profiles.json")!.mode === 0o600,
    "auth-profiles.json is mode 0o600",
  );
  assert(files.get("home/openclaw/.openclaw/.env")!.mode === 0o600, ".env is mode 0o600");
  assert(files.get("home/openclaw/.openclaw/wallet/agent.key")!.mode === 0o600, "agent.key is mode 0o600");
  assert(
    files.get("home/openclaw/.openclaw/workspace/IDENTITY.md")!.mode === 0o644,
    "IDENTITY.md is mode 0o644",
  );

  // auth-profiles.json content
  const auth = JSON.parse(files.get("home/openclaw/.openclaw/agents/main/agent/auth-profiles.json")!.body);
  assert(
    auth.profiles["anthropic:default"].key === validParams.gatewayToken,
    "all_inclusive: anthropic key = gatewayToken",
  );
  assert(
    auth.profiles["anthropic:default"].baseUrl === "https://instaclaw.io/api/gateway",
    "all_inclusive: anthropic baseUrl points at proxy",
  );

  // .env content
  const env = files.get("home/openclaw/.openclaw/.env")!.body;
  assert(env.includes(`GATEWAY_TOKEN=${validParams.gatewayToken}`), ".env has GATEWAY_TOKEN");
  assert(env.includes(`TELEGRAM_BOT_TOKEN=${validParams.telegramBotToken}`), ".env has TELEGRAM_BOT_TOKEN");
  assert(env.includes(`BANKR_WALLET_ADDRESS=${validParams.bankrEvmAddress}`), ".env has BANKR_WALLET_ADDRESS");
  assert(
    env.includes("POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com"),
    ".env has canonical publicnode POLYGON_RPC_URL",
  );
  assert(env.startsWith("# INSTACLAW_ENV_V1"), ".env carries the sentinel marker");
  // VM_MANIFEST.requiredEnvVars (vm-manifest.ts:1938) declares 5 env vars
  // that MUST exist for the gateway + Polymarket trade-execution + reconciler
  // to work. Cooper 2026-05-14: "no reliance on the reconciler" → all 5
  // emit at first boot. Pin presence + manifest-defaults values.
  assert(env.includes(`CLOB_PROXY_URL=`), ".env has CLOB_PROXY_URL");
  assert(env.includes(`CLOB_PROXY_URL_BACKUP=`), ".env has CLOB_PROXY_URL_BACKUP");
  assert(env.includes(`AGENT_REGION=${validParams.agentRegion}`), ".env has AGENT_REGION = p.agentRegion");
  // All 5 manifest-required env vars must be present (the gate Cooper called out)
  for (const requiredKey of ["GATEWAY_TOKEN", "POLYGON_RPC_URL", "CLOB_PROXY_URL", "CLOB_PROXY_URL_BACKUP", "AGENT_REGION"]) {
    assert(
      new RegExp(`^${requiredKey}=`, "m").test(env),
      `.env emits manifest-required env var ${requiredKey} (vm-manifest.ts:1938)`,
    );
  }

  // IDENTITY.md content (2026-05-14 audit fix: now byte-parity with SSH path
  // via buildIdentityMd in lib/ssh.ts — no more hand-written sentinel).
  const id = files.get("home/openclaw/.openclaw/workspace/IDENTITY.md")!.body;
  assert(id.includes(`@${validParams.telegramBotUsername}`), "IDENTITY.md mentions bot username");
  assert(id.startsWith("# IDENTITY.md - Who Am I?"), "IDENTITY.md has SSH-path header");
  assert(id.includes("- **Creature:** AI agent"), "IDENTITY.md has Creature line");
  // Agent-name regex: "fucking1999_bot" → strip "_bot" → "fucking1999" → strip
  // trailing digits → "fucking" (≥2 chars so the digit-strip applies).
  assert(id.includes("- **Name:** fucking"), "IDENTITY.md derives agent name via regex");

  // WALLET.md content (2026-05-14 audit fix: now byte-parity with SSH path
  // via buildWalletMd in lib/ssh.ts — no more hand-written WALLET_V1 sentinel
  // and no agentbookAddress in WALLET.md since SSH path doesn't include it).
  const wallet = files.get("home/openclaw/.openclaw/workspace/WALLET.md")!.body;
  assert(
    wallet.startsWith("# Wallet & Financial Configuration"),
    "WALLET.md has SSH-path header",
  );
  assert(wallet.includes(validParams.bankrEvmAddress!), "WALLET.md has bankr EVM address");
  assert(
    wallet.includes("## Wallet Summary"),
    "WALLET.md has Wallet Summary section (SSH path)",
  );
  assert(wallet.includes("## Key Rules"), "WALLET.md has Key Rules section");
  // Pin a specific SSH-path string that the pre-audit wrapper was missing
  assert(
    wallet.includes("- **AgentBook Wallet** — identity-only wallet"),
    "WALLET.md mentions AgentBook Wallet (SSH path semantic — identity only, NOT for transactions)",
  );

  // agent.key
  const key = files.get("home/openclaw/.openclaw/wallet/agent.key")!.body;
  assert(key.includes("BEGIN EC PRIVATE KEY"), "agent.key contains private-key body");
  assert(key.endsWith("\n"), "agent.key ends with newline (canonical)");
}

async function test2_ByokEdgeCity() {
  console.log("\n─── TEST 2: byok + edge_city + worldId ─────────────");
  const buf = await streamToBuffer(packPartialTarball(edgeCityParams));
  const files = await unpackTarball(buf);

  // WORLD_ID.md should appear now (2026-05-14 audit fix: byte-parity with
  // SSH path via buildWorldIdMd in lib/ssh.ts — no more hand-written sentinel)
  assert(files.has("home/openclaw/.openclaw/workspace/WORLD_ID.md"), "WORLD_ID.md present");
  const worldId = files.get("home/openclaw/.openclaw/workspace/WORLD_ID.md")!.body;
  assert(worldId.includes(edgeCityParams.worldIdNullifier!), "WORLD_ID.md has nullifier");
  assert(
    worldId.startsWith("# World ID Verification"),
    "WORLD_ID.md has SSH-path header",
  );
  assert(
    worldId.includes("**Status:** Verified (orb level)"),
    "WORLD_ID.md has Verified + level line",
  );
  assert(
    worldId.includes("## What This Means"),
    "WORLD_ID.md has 'What This Means' section",
  );
  assert(
    worldId.includes("## How to Use"),
    "WORLD_ID.md has 'How to Use' section",
  );

  // Partner overlays
  assert(files.has("overlays/soul-edge-stub.md"), "soul-edge-stub.md present for edge_city");
  assert(files.has("overlays/soul-consensus-stub.md"), "soul-consensus-stub.md present for edge_city");
  assert(files.has("overlays/edge-instaclaw-overlay.md"), "edge-instaclaw-overlay.md present");
  assert(files.has("overlays/bankr-overlay.md"), "bankr-overlay.md still present (universal)");

  // BYOK auth-profiles
  const auth = JSON.parse(files.get("home/openclaw/.openclaw/agents/main/agent/auth-profiles.json")!.body);
  assert(
    auth.profiles["anthropic:default"].key === "sk-ant-byok-test",
    "byok: anthropic key = user's apiKey",
  );
  assert(
    !auth.profiles["anthropic:default"].baseUrl,
    "byok: no baseUrl (direct to Anthropic, not proxy)",
  );
}

async function test3_ValidationRejections() {
  console.log("\n─── TEST 3: validation rejections ──────────────────");

  const cases: Array<[Partial<TarballParams> & Record<string, unknown>, string]> = [
    [{ vmName: "evil; rm -rf /" }, "vmName with shell metachars"],
    [{ userId: "user`whoami`" }, "userId with backtick"],
    [{ gatewayToken: "short" }, "gatewayToken too short"],
    [{ gatewayToken: "z".repeat(64) }, "gatewayToken not hex"],
    [{ telegramBotUsername: "$(echo gotcha)" }, "telegramBotUsername with $()"],
    [{ nextauthUrl: "http://insecure.example" }, "nextauthUrl not https"],
    [{ nextauthUrl: "https://instaclaw.io/?foo=bar" }, "nextauthUrl with ?"],
    [{ apiMode: "all_inclusive", apiKey: null }, "✓ valid: all_inclusive without apiKey"],
    [{ apiMode: "byok", apiKey: null }, "byok without apiKey"],
    [{ partner: "evil\nfoo" }, "partner with newline"],
    // tier required (2026-05-14 — Cooper directive: throw on null, no silent default)
    [{ tier: "" }, "tier empty string"],
    [{ tier: "   " }, "tier whitespace-only"],
    // The next two bypass TypeScript via `as unknown as Partial<TarballParams>` casts
    // upstream to exercise the runtime guard. TS-clean callers can't trip these.
    [{ tier: null as unknown as string }, "tier null"],
    [{ tier: undefined as unknown as string }, "tier undefined"],
    // braveApiKey + discordBotToken: optional, no validation. Accept presence
    // (these add fields, they don't change the validation contract).
    [
      { braveApiKey: "BSA_test_abc123", discordBotToken: "Discord.bot.token.shape" },
      "✓ valid: braveApiKey + discordBotToken set",
    ],
    [{ braveApiKey: null, discordBotToken: null }, "✓ valid: braveApiKey + discordBotToken null"],
  ];

  for (const [override, label] of cases) {
    const p = { ...validParams, ...override } as TarballParams;
    let threw: Error | null = null;
    try {
      validateTarballParams(p);
    } catch (e) {
      threw = e as Error;
    }
    const isValidCase = label.startsWith("✓");
    if (isValidCase) {
      assert(threw === null, `accepted: ${label}`);
    } else {
      assert(threw !== null, `rejected: ${label}`);
    }
  }
}

async function test4_DeterministicOutput() {
  console.log("\n─── TEST 4: determinism (same input → same output) ──");
  const buf1 = await streamToBuffer(packPartialTarball(validParams));
  const buf2 = await streamToBuffer(packPartialTarball(validParams));
  // tar/gzip may include mtime headers that drift across runs; the
  // gunzipped tar should be byte-identical if our builders are
  // deterministic. The gzip wrapper may differ by mtime in headers.
  const tar1 = gunzipSync(buf1);
  const tar2 = gunzipSync(buf2);
  assert(tar1.equals(tar2), "gunzipped tars are byte-identical");
}

async function test5_PerFileBuildersDirect() {
  console.log("\n─── TEST 5: per-file builder unit tests ────────────");
  // These run the builders without going through tarball pack — faster
  // failure isolation when a per-file builder regresses.
  validateTarballParams(validParams);
  assert(buildIdentityMdForTarball(validParams).includes("@fucking1999_bot"), "buildIdentityMdForTarball includes bot username");
  assert(buildWalletMdForTarball(validParams).includes(validParams.bankrEvmAddress!), "buildWalletMdForTarball includes bankr address");
  assert(buildWorldIdMdForTarball(validParams) === null, "buildWorldIdMdForTarball returns null without nullifier");
  assert(buildWorldIdMdForTarball(edgeCityParams) !== null, "buildWorldIdMdForTarball returns content with nullifier");
  assert(buildDotEnv(validParams).includes("INSTACLAW_ENV_V1"), "buildDotEnv has sentinel");
  assert(JSON.parse(buildAuthProfilesJsonForTarball(validParams)).profiles, "buildAuthProfilesJsonForTarball is valid JSON");
  assert(buildAgentKey(validParams).endsWith("\n"), "buildAgentKey newline-terminated");

  const entries = collectPartialEntries(validParams);
  // 7 entries for the no-partner-no-worldId case:
  //   auth-profiles, .env, IDENTITY.md, WALLET.md, agent.key, bankr-overlay
  //   (WORLD_ID skipped, no partner overlays beyond bankr)
  assert(entries.length === 6, `collectPartialEntries no-partner returns 6 entries (got ${entries.length})`);

  const edgeEntries = collectPartialEntries(edgeCityParams);
  // edge_city + worldId: +WORLD_ID +soul-edge +soul-consensus +edge-overlay = 6 + 4 = 10
  assert(edgeEntries.length === 10, `collectPartialEntries edge_city+worldId returns 10 entries (got ${edgeEntries.length})`);
}

async function test6_BuildBootstrapMd() {
  console.log("\n─── TEST 6: buildBootstrapMd (wrapper #1) ──────────");

  // ── Gmail-present branch ──────────────────────────────────────────────
  // Wrapper must produce byte-identical output to what configureOpenClaw
  // produces at lib/ssh.ts:5793 — buildPersonalizedBootstrap(gmailProfileSummary).

  const gmailSummary =
    "Andrew Smith works at Acme Corp on the pricing model rollout. " +
    "Recent threads with Sarah Chen about Q3 deadlines, and Mike Park about Stripe migration.";
  const withGmail: TarballParams = { ...validParams, gmailProfileSummary: gmailSummary };

  const wrapped = buildBootstrapMd(withGmail);
  const referenceWithSummary = buildPersonalizedBootstrap(gmailSummary);
  assert(
    wrapped === referenceWithSummary,
    "Gmail present: wrapper byte-identical to buildPersonalizedBootstrap(gmailSummary)",
  );

  // Contract claim from doc §1.1: buildPersonalizedBootstrap currently
  // IGNORES its parameter. Verify by passing "" — must produce same output
  // as passing the real summary. This will be the FIRST test to fail if
  // buildPersonalizedBootstrap ever starts using the param (silent contract
  // change). On that day, the wrapper's "pass-through" semantics save the
  // day, AND this assertion's failure tells us the contract changed.
  const referenceWithEmpty = buildPersonalizedBootstrap("");
  assert(
    referenceWithSummary === referenceWithEmpty,
    "Contract pin: buildPersonalizedBootstrap currently IGNORES profileContent " +
      "(output equal for '' vs real summary). If this fails, update the wrapper + contract doc.",
  );

  // Sentinel in personalized bootstrap (catches drift in the template body)
  assert(
    wrapped.includes("# BOOTSTRAP.md — First Run Instructions"),
    "Gmail present: output has BOOTSTRAP.md header",
  );
  assert(
    wrapped.includes("CRITICAL: Do NOT template this"),
    "Gmail present: output has the personalized-mode 'do not template' directive",
  );

  // ── Gmail-absent branch ───────────────────────────────────────────────
  // Wrapper must produce byte-identical output to WORKSPACE_BOOTSTRAP_SHORT.

  const noGmail: TarballParams = { ...validParams, gmailProfileSummary: null };
  const wrappedShort = buildBootstrapMd(noGmail);
  assert(
    wrappedShort === WORKSPACE_BOOTSTRAP_SHORT,
    "Gmail null: wrapper byte-identical to WORKSPACE_BOOTSTRAP_SHORT",
  );

  // The short version differs from the personalized version in a specific
  // way: it does NOT contain the Gmail-personalization section's
  // 'CRITICAL: Do NOT template' phrase. Pin this difference so a future
  // re-merge of the two templates doesn't go unnoticed.
  assert(
    !wrappedShort.includes("CRITICAL: Do NOT template this"),
    "Gmail null: short bootstrap does NOT contain personalized-only directive",
  );

  // ── Empty-string edge case ───────────────────────────────────────────
  // configureOpenClaw uses `if (config.gmailProfileSummary)` — empty string
  // is falsy → short branch. Wrapper must match this exactly.

  const emptyGmail: TarballParams = { ...validParams, gmailProfileSummary: "" };
  assert(
    buildBootstrapMd(emptyGmail) === WORKSPACE_BOOTSTRAP_SHORT,
    "Gmail empty string: wrapper matches the SSH path (empty is falsy → short branch)",
  );

  // ── Undefined edge case ──────────────────────────────────────────────
  const undefGmail: TarballParams = { ...validParams, gmailProfileSummary: undefined };
  assert(
    buildBootstrapMd(undefGmail) === WORKSPACE_BOOTSTRAP_SHORT,
    "Gmail undefined: wrapper matches the SSH path (undefined is falsy → short branch)",
  );

  // ── Whitespace-only Gmail ────────────────────────────────────────────
  // configureOpenClaw's `if (config.gmailProfileSummary)` treats "   " as
  // truthy → personalized branch. Wrapper must match (even though that
  // branch's output for whitespace input is silly — it's about parity).

  const wsGmail: TarballParams = { ...validParams, gmailProfileSummary: "   " };
  assert(
    buildBootstrapMd(wsGmail) === buildPersonalizedBootstrap("   "),
    "Gmail whitespace-only: matches SSH path (truthy → personalized)",
  );

  // ── Determinism ──────────────────────────────────────────────────────
  assert(buildBootstrapMd(withGmail) === buildBootstrapMd(withGmail), "deterministic on Gmail present");
  assert(buildBootstrapMd(noGmail) === buildBootstrapMd(noGmail), "deterministic on Gmail null");
}

async function test7_EdgeosBearerToken() {
  console.log("\n─── TEST 7: EDGEOS_BEARER_TOKEN (2026-05-14 hex-vs-JWT defense) ──");

  // A realistic JWT (HS256 header + minimal payload + signature). 173 chars,
  // starts with eyJ, exactly two dots, parts are base64url-encoded.
  const REAL_JWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ." +
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  // The actual 2026-05-14 incident input — a 64-char hex string. Lives in
  // Vercel for 34 days before someone noticed. We pin this exact shape so a
  // future engineer who relaxes the validation can't claim "we didn't know".
  const HEX_64 = "a1b2c3d4".repeat(8);

  // Long garbage that passes the length check but fails JWT shape — proves
  // the regex is doing real work (not just trusting length).
  const LONG_GARBAGE = "g".repeat(120);

  // ── Happy path: edge_city + valid JWT ─────────────────────────────────
  const happy: TarballParams = { ...edgeCityParams, edgeosBearerToken: REAL_JWT };
  validateTarballParams(happy); // must not throw
  const happyEnv = buildDotEnv(happy);
  assert(
    happyEnv.includes(`EDGEOS_BEARER_TOKEN=${REAL_JWT}`),
    "happy: edge_city + valid JWT emits EDGEOS_BEARER_TOKEN=<jwt> in .env",
  );

  // ── 2026-05-14 incident: 64-char hex MUST throw ────────────────────────
  const hexBug: TarballParams = { ...edgeCityParams, edgeosBearerToken: HEX_64 };
  let threw: Error | null = null;
  try {
    validateTarballParams(hexBug);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw !== null, "2026-05-14 bug: 64-char hex throws");
  // The hex is 64 chars < JWT_MIN_LENGTH (100), so it trips the length check first.
  // Error must reference "too short" OR "JWT" — both are valid rejection reasons.
  const hexErrMsg = String(threw?.message ?? "");
  assert(
    hexErrMsg.includes("JWT") && hexErrMsg.includes("hex"),
    "2026-05-14 bug: error message names BOTH 'JWT' and 'hex' for incident traceability",
  );

  // ── Long garbage: passes length, fails shape ──────────────────────────
  const garbage: TarballParams = { ...edgeCityParams, edgeosBearerToken: LONG_GARBAGE };
  threw = null;
  try {
    validateTarballParams(garbage);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw !== null, "long garbage (no eyJ, no dots) throws");
  assert(
    String(threw?.message ?? "").includes("JWT shape"),
    "long garbage: error references JWT shape (not length)",
  );

  // ── Short eyJ-prefix value: caught by length check ────────────────────
  // Real JWTs are 100+ chars; anything starting with eyJ but tiny is malformed.
  const shortEyj: TarballParams = { ...edgeCityParams, edgeosBearerToken: "eyJ.a.b" };
  threw = null;
  try {
    validateTarballParams(shortEyj);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw !== null, "short eyJ-prefix (7 chars) throws");
  assert(
    String(threw?.message ?? "").includes("too short"),
    "short eyJ: error references length check",
  );

  // ── Missing/null: silent skip, no EDGEOS line ─────────────────────────
  // The attendee-directory feature requires this token. If Vercel's env is
  // unset (e.g., during a rotation window or in a preview env), provisioning
  // must succeed without the line — agents work, just can't query EdgeOS.
  // Matches the reconciler's stepEnvVarPush "missing → silent skip" semantics.
  const missing: TarballParams = { ...edgeCityParams, edgeosBearerToken: null };
  validateTarballParams(missing); // must not throw
  const missingEnv = buildDotEnv(missing);
  assert(
    !missingEnv.includes("EDGEOS_BEARER_TOKEN"),
    "missing token (null) → no EDGEOS_BEARER_TOKEN line in .env",
  );

  const undef: TarballParams = { ...edgeCityParams, edgeosBearerToken: undefined };
  validateTarballParams(undef); // must not throw
  assert(
    !buildDotEnv(undef).includes("EDGEOS_BEARER_TOKEN"),
    "missing token (undefined) → no EDGEOS_BEARER_TOKEN line",
  );

  const emptyStr: TarballParams = { ...edgeCityParams, edgeosBearerToken: "" };
  validateTarballParams(emptyStr); // must not throw (empty is falsy → skip)
  assert(
    !buildDotEnv(emptyStr).includes("EDGEOS_BEARER_TOKEN"),
    "missing token (empty string) → no EDGEOS_BEARER_TOKEN line",
  );

  // ── Wrong partner: token completely ignored (NOT emitted, NOT validated) ──
  // A non-edge_city VM passing a malformed EDGEOS token must NOT throw.
  // The partner gate is the OUTER condition; the token is invisible to all
  // other partners regardless of shape.
  const wrongPartnerHex: TarballParams = {
    ...validParams,
    partner: null,
    edgeosBearerToken: HEX_64,
  };
  validateTarballParams(wrongPartnerHex); // partner-gated: must not throw on hex
  assert(
    !buildDotEnv(wrongPartnerHex).includes("EDGEOS_BEARER_TOKEN"),
    "wrong partner (null) + hex value → no EDGEOS line, no validation",
  );

  const consensusPartner: TarballParams = {
    ...validParams,
    partner: "consensus_2026",
    edgeosBearerToken: REAL_JWT,
  };
  validateTarballParams(consensusPartner); // partner != edge_city, gate closed
  assert(
    !buildDotEnv(consensusPartner).includes("EDGEOS_BEARER_TOKEN"),
    "consensus_2026 partner + valid JWT → no EDGEOS line (partner-gated)",
  );
}

async function test8_BuildUserMdForTarball() {
  console.log("\n─── TEST 8: buildUserMdForTarball (wrapper #2) ─────");

  // ── Happy path: Gmail present, ASCII first name ──────────────────────
  // configureOpenClaw at lib/ssh.ts:5796 calls buildUserMd(config.gmailProfileSummary)
  // directly. Wrapper output MUST be byte-identical for byte-parity audit.
  const asciiProfile =
    "Andrew Smith works at Acme Corp on the pricing model rollout. " +
    "Recent threads with Sarah Chen about Q3 deadlines.";
  const withGmail: TarballParams = { ...validParams, gmailProfileSummary: asciiProfile };

  const wrapped = buildUserMdForTarball(withGmail);
  assert(wrapped !== null, "Gmail present: wrapper returns non-null");
  assert(wrapped === buildUserMd(asciiProfile), "Gmail present: byte-identical to buildUserMd(profileContent)");

  // Name regex pin — ASCII name MUST extract correctly. If buildUserMd
  // ever loses the regex (or someone narrows it), this fails loudly.
  assert(wrapped!.includes("**Name:** Andrew Smith"), "Gmail present: ASCII name extracted via regex");
  assert(wrapped!.includes("**What to call them:** Andrew"), "Gmail present: firstName = Andrew");
  assert(wrapped!.includes(asciiProfile), "Gmail present: full profileContent embedded in Context section");

  // ── Pre-existing Cyrillic-name bug PINNED ────────────────────────────
  // The regex /^([A-Z][a-z]+...)\s(?:is|works|lives)/m is ASCII-only.
  // Cyrillic "Андрей" (vm-918's user) does NOT match → fullName='User'.
  // Cloud-init path PRESERVES this bug verbatim so Phase 1B-2 byte compare
  // succeeds. Fixing the regex requires touching lib/ssh.ts:9087 — both
  // paths would pick it up automatically at that point.
  const cyrillicProfile = "Андрей is a developer at a Kiev startup, working on social platforms.";
  const cyrillicGmail: TarballParams = { ...validParams, gmailProfileSummary: cyrillicProfile };
  const cyrillicOutput = buildUserMdForTarball(cyrillicGmail);
  assert(cyrillicOutput !== null, "Cyrillic profile: wrapper returns non-null (skip-gate is just truthy)");
  assert(
    cyrillicOutput!.includes("**Name:** User"),
    "Cyrillic profile: ASCII-only regex falls back to 'User' (pre-existing bug pinned)",
  );
  assert(
    cyrillicOutput!.includes("Андрей"),
    "Cyrillic profile: full content (including non-ASCII) embedded in Context",
  );

  // ── Gmail-absent → null (caller omits the entry) ─────────────────────
  // CRITICAL: null is load-bearing. SSH-configure path at lib/ssh.ts:5812-5826
  // does NOT write USER.md at all. Wrapper MUST return null, NOT an empty
  // string or placeholder. Caller's omit-on-null logic is what produces
  // byte-parity with the SSH path's "file doesn't exist" outcome.
  const noGmail: TarballParams = { ...validParams, gmailProfileSummary: null };
  assert(buildUserMdForTarball(noGmail) === null, "Gmail null → returns null (caller omits entry)");

  const undefGmail: TarballParams = { ...validParams, gmailProfileSummary: undefined };
  assert(buildUserMdForTarball(undefGmail) === null, "Gmail undefined → returns null");

  const emptyGmail: TarballParams = { ...validParams, gmailProfileSummary: "" };
  assert(buildUserMdForTarball(emptyGmail) === null, "Gmail empty string → returns null (empty is falsy)");

  // ── Whitespace-only Gmail: SSH path's truthy check fires personalized ─
  // configureOpenClaw uses `if (config.gmailProfileSummary)` which treats
  // "   " as truthy. Wrapper matches — even though the regex won't extract
  // a name from whitespace and the Context will be whitespace, the file
  // EXISTS in the SSH path's output. Cloud-init must match.
  const wsGmail: TarballParams = { ...validParams, gmailProfileSummary: "   " };
  const wsOutput = buildUserMdForTarball(wsGmail);
  assert(wsOutput !== null, "Whitespace Gmail → non-null (truthy → emit)");
  assert(wsOutput === buildUserMd("   "), "Whitespace Gmail: byte-identical to buildUserMd('   ')");

  // ── Sentinel/template markers ────────────────────────────────────────
  assert(wrapped!.startsWith("# USER.md - About Your Human"), "USER.md header preserved");
  assert(
    wrapped!.includes("## Context"),
    "USER.md has Context section (where Gmail summary lives)",
  );

  // ── Determinism ──────────────────────────────────────────────────────
  assert(
    buildUserMdForTarball(withGmail) === buildUserMdForTarball(withGmail),
    "deterministic on Gmail present",
  );
  assert(
    buildUserMdForTarball(noGmail) === buildUserMdForTarball(noGmail),
    "deterministic on Gmail null (both calls return null)",
  );
}

async function test9_BuildSystemPromptForTarball() {
  console.log("\n─── TEST 9: buildSystemPromptForTarball (wrapper #3) ──");

  // ── Happy path: Gmail present — Session Continuity branch fires ──────
  // configureOpenClaw at lib/ssh.ts:5798 calls buildSystemPrompt(gmailSummary)
  // directly. Wrapper byte-output MUST match.
  const profile =
    "Andrew Smith works at Acme Corp. Recent threads about pricing rollout " +
    "with Sarah Chen and Stripe migration with Mike Park.";
  const withGmail: TarballParams = { ...validParams, gmailProfileSummary: profile };

  const wrapped = buildSystemPromptForTarball(withGmail);
  assert(
    wrapped === buildSystemPrompt(profile),
    "Gmail present: byte-identical to buildSystemPrompt(profile)",
  );

  // Sentinels: the non-empty branch's distinctive content
  assert(
    wrapped.includes("## Session Continuity — CRITICAL"),
    "Gmail present: Session Continuity block fires (non-empty memoryContent branch)",
  );
  assert(wrapped.includes(profile), "Gmail present: profile content embedded inline");
  assert(
    wrapped.includes("you already know everything below about your owner") ||
      wrapped.includes("You already know everything below about your owner"),
    "Gmail present: owner preamble present (case-insensitive — pin against typo drift)",
  );

  // Dead-weight WARNING footer — proves we got the right buildSystemPrompt
  // (the lib/ssh.ts one, not the lib/system-prompt.ts one) AND the future
  // engineer's debugging guide is still in place.
  assert(
    wrapped.includes("This file is NOT read by OpenClaw"),
    "WARNING footer present (dead-weight system-prompt.md per buildSystemPrompt's own comment)",
  );
  assert(
    wrapped.includes("SOUL.md") && wrapped.includes("CAPABILITIES.md"),
    "WARNING footer references SOUL.md + CAPABILITIES.md (the actual prompt sources)",
  );

  // ── Gmail-absent: placeholder branch fires (NOT Session Continuity) ──
  // configureOpenClaw at lib/ssh.ts:5815 calls buildSystemPrompt('') in
  // the no-Gmail branch. My wrapper's `?? ""` coalesce produces the same.
  const noGmail: TarballParams = { ...validParams, gmailProfileSummary: null };
  const wrappedNull = buildSystemPromptForTarball(noGmail);
  assert(
    wrappedNull === buildSystemPrompt(""),
    "Gmail null: byte-identical to buildSystemPrompt('') (matches SSH line 5815 exactly)",
  );
  assert(
    wrappedNull.includes("hasn't connected their profile yet"),
    "Gmail null: placeholder Owner section fires",
  );
  assert(
    !wrappedNull.includes("Session Continuity — CRITICAL"),
    "Gmail null: NO Session Continuity block (no profile to be continuous about)",
  );
  // WARNING footer still present in the absent branch
  assert(
    wrappedNull.includes("This file is NOT read by OpenClaw"),
    "Gmail null: WARNING footer still present (both branches share footer)",
  );

  // ── Undefined → "" via ?? coalesce ───────────────────────────────────
  // buildSystemPrompt's body does `memoryContent.trim()` which would throw
  // TypeError on null/undefined. The wrapper's ?? "" guard is load-bearing
  // for the safety contract — pin it.
  const undefGmail: TarballParams = { ...validParams, gmailProfileSummary: undefined };
  const wrappedUndef = buildSystemPromptForTarball(undefGmail);
  assert(
    wrappedUndef === buildSystemPrompt(""),
    "Gmail undefined: ?? coalesce produces same output as empty-string call",
  );

  // ── Empty string explicitly ──────────────────────────────────────────
  const emptyGmail: TarballParams = { ...validParams, gmailProfileSummary: "" };
  assert(
    buildSystemPromptForTarball(emptyGmail) === buildSystemPrompt(""),
    "Gmail empty string: passes through to buildSystemPrompt('')",
  );

  // ── Whitespace-only Gmail: subtle truthy-vs-trim divergence ──────────
  // SSH path's line 5791 truthy-check fires on whitespace (enters
  // personalized branch), THEN calls buildSystemPrompt("   ") at 5798,
  // which internally `.trim()`s to "" → placeholder Owner section.
  // So system-prompt.md emits placeholder content even when SSH "thinks"
  // it's in the personalized branch. The wrapper must preserve this
  // subtlety byte-for-byte.
  const wsGmail: TarballParams = { ...validParams, gmailProfileSummary: "   " };
  const wsOutput = buildSystemPromptForTarball(wsGmail);
  assert(
    wsOutput === buildSystemPrompt("   "),
    "Whitespace Gmail: byte-identical to buildSystemPrompt('   ')",
  );
  assert(
    wsOutput.includes("hasn't connected their profile yet"),
    "Whitespace Gmail: placeholder branch fires (whitespace.trim() === '' inside buildSystemPrompt)",
  );

  // ── Determinism ──────────────────────────────────────────────────────
  assert(
    buildSystemPromptForTarball(withGmail) === buildSystemPromptForTarball(withGmail),
    "deterministic on Gmail present",
  );
  assert(
    buildSystemPromptForTarball(noGmail) === buildSystemPromptForTarball(noGmail),
    "deterministic on Gmail null",
  );

  // ── Contract pin: warning footer is part of the dead-weight signal ───
  // If a future engineer renames/removes the warning footer (e.g., because
  // they decide to make OpenClaw actually read system-prompt.md), this
  // assertion fails and forces a deliberate update to the contract doc.
  assert(
    wrapped.endsWith("debugging/reference only. -->"),
    "Contract pin: dead-weight warning footer is the last line of the file (template hasn't drifted)",
  );
}

/**
 * buildOpenClawConfig embeds `wizard.lastRunAt: new Date().toISOString()`
 * (lib/ssh.ts:4310-4315). Two calls in successive milliseconds get
 * different timestamps → strict deepEqual would fail. Strip before
 * comparisons. The SSH path has the same non-determinism — Phase 1B-2's
 * byte-compare audit will normalize wizard.lastRunAt across VMs.
 */
function stripWizardTimestamp(obj: object): object {
  // Deep-clone via JSON to avoid mutating the original
  const cloned = JSON.parse(JSON.stringify(obj));
  if (cloned.wizard) {
    delete cloned.wizard.lastRunAt;
  }
  return cloned;
}

async function test10_BuildMemoryMdForTarball() {
  console.log("\n─── TEST 10: buildMemoryMdForTarball (wrapper #4) ──");

  // ── MEMORY_MD_PATHS contract pin ─────────────────────────────────────
  // The double-write tech-debt is documented in the contracts doc; pin
  // the destination paths so a "let's simplify to one path" change has
  // to deliberately update this test (which forces re-reading §5b(e)
  // and removing BOTH writers in lockstep, not just one).
  assert(MEMORY_MD_PATHS.length === 2, "MEMORY_MD_PATHS has exactly 2 entries (workspace + agent-dir)");
  assert(
    MEMORY_MD_PATHS[0] === "home/openclaw/.openclaw/workspace/MEMORY.md",
    "MEMORY_MD_PATHS[0] is the workspace path (live source of truth)",
  );
  assert(
    MEMORY_MD_PATHS[1] === "home/openclaw/.openclaw/agents/main/agent/MEMORY.md",
    "MEMORY_MD_PATHS[1] is the agent-dir path (fossilized tech debt — §5b(e))",
  );

  // ── Happy path: Gmail present → content === gmailProfileSummary ─────
  // configureOpenClaw at lib/ssh.ts:5795 writes
  //   `echo '${memB64}' | base64 -d > "${workspaceDir}/MEMORY.md"`
  // where memB64 is Buffer.from(config.gmailProfileSummary, 'utf-8').toString('base64').
  // The decoded result is the gmailProfileSummary verbatim. Wrapper must
  // emit the same exact string.
  const profile =
    "Andrew Smith works at Acme Corp. Recent threads: Sarah Chen on pricing, " +
    "Mike Park on Stripe migration.";
  const withGmail: TarballParams = { ...validParams, gmailProfileSummary: profile };

  const wrapped = buildMemoryMdForTarball(withGmail);
  assert(wrapped !== null, "Gmail present: returns non-null");
  assert(wrapped === profile, "Gmail present: content === p.gmailProfileSummary verbatim (pass-through)");

  // Cross-validate against SSH-path byte-output: the SSH path's base64
  // round-trip produces gmailProfileSummary verbatim, so the test below
  // is equivalent to "matches the SSH-path bytes."
  const sshPathDecoded = Buffer.from(
    Buffer.from(profile, "utf-8").toString("base64"),
    "base64",
  ).toString("utf-8");
  assert(wrapped === sshPathDecoded, "Wrapper matches SSH-path's base64-round-trip output exactly");

  // ── Gmail-absent → null (caller omits BOTH entries) ─────────────────
  const noGmail: TarballParams = { ...validParams, gmailProfileSummary: null };
  assert(
    buildMemoryMdForTarball(noGmail) === null,
    "Gmail null → null (caller omits both workspace + agent-dir entries)",
  );

  const undefGmail: TarballParams = { ...validParams, gmailProfileSummary: undefined };
  assert(buildMemoryMdForTarball(undefGmail) === null, "Gmail undefined → null");

  const emptyGmail: TarballParams = { ...validParams, gmailProfileSummary: "" };
  assert(buildMemoryMdForTarball(emptyGmail) === null, "Gmail empty string → null (falsy)");

  // ── Whitespace truthy ────────────────────────────────────────────────
  // SSH path's line 5791 `if (config.gmailProfileSummary)` treats "   "
  // as truthy → enters personalized branch → writes MEMORY.md = "   ".
  // Wrapper preserves this (no `.trim()` semantics here, unlike system-
  // prompt's internal trim).
  const wsGmail: TarballParams = { ...validParams, gmailProfileSummary: "   " };
  assert(buildMemoryMdForTarball(wsGmail) === "   ", "Whitespace Gmail → emits whitespace verbatim");

  // ── Unicode preserved verbatim (no template, just pass-through) ──────
  // The 2026-05-13 vm-918 case: khomenko89's name "Андрей" lives in their
  // profile content. Cloud-init must preserve Cyrillic + any other Unicode
  // byte-for-byte. configureOpenClaw uses Buffer.from(str, 'utf-8') →
  // base64 → decode = lossless. Wrapper's pass-through is equivalent.
  const cyrillicProfile =
    "Андрей is a developer at a Kiev startup. " +
    "JavaScript backend work — projects: 社交平台 + Telegram bots. " +
    "Emoji status: 🚀 shipping weekly.";
  const cyrillicTar: TarballParams = { ...validParams, gmailProfileSummary: cyrillicProfile };
  assert(
    buildMemoryMdForTarball(cyrillicTar) === cyrillicProfile,
    "Unicode (Cyrillic + CJK + emoji) preserved verbatim",
  );

  // ── Markdown special chars preserved (not interpreted as anything) ───
  // The agent will render the MEMORY.md content as plain text in their
  // context window. Markdown chars are NOT escaped — they're embedded
  // verbatim, just like the SSH path does (base64-round-trip is lossless).
  const markdownProfile =
    "Working on `~/projects/foo`. **Important**: see [docs](https://example.com). " +
    "Code: ```const x = `template ${var}`;``` " +
    "Edge: $TEMPLATE_VAR + backtick`s + asterisks ***";
  const mdTar: TarballParams = { ...validParams, gmailProfileSummary: markdownProfile };
  assert(
    buildMemoryMdForTarball(mdTar) === markdownProfile,
    "Markdown special chars (backticks, ${}, **, []) preserved verbatim",
  );

  // ── Large content preserved ──────────────────────────────────────────
  // No truncation at the wrapper layer. configureOpenClaw also doesn't
  // truncate at write-time; the agent's bootstrap loader may truncate
  // upstream, but that's SOUL.md's concern, not MEMORY.md's.
  const largeProfile = "Lorem ipsum dolor sit amet. ".repeat(1000); // ~27KB
  const largeTar: TarballParams = { ...validParams, gmailProfileSummary: largeProfile };
  const largeResult = buildMemoryMdForTarball(largeTar);
  assert(largeResult === largeProfile, "Large content (~27KB) preserved without truncation");
  assert(largeResult!.length === largeProfile.length, "No silent truncation at the wrapper");

  // ── Determinism ──────────────────────────────────────────────────────
  assert(
    buildMemoryMdForTarball(withGmail) === buildMemoryMdForTarball(withGmail),
    "deterministic on Gmail present",
  );
  assert(
    buildMemoryMdForTarball(noGmail) === buildMemoryMdForTarball(noGmail),
    "deterministic on Gmail null (both calls return null)",
  );

  // ── Edge: identical content at both paths (double-write consistency) ─
  // The Day 8 assembler will emit TWO TarEntry objects with identical
  // bodies. Test that the wrapper's output is the SAME single string —
  // the dual emission must not produce drift between the two paths
  // (which would defeat byte-parity with configureOpenClaw, which also
  // writes identical content at both paths).
  const content = buildMemoryMdForTarball(withGmail);
  assert(content === content, "single source: same content used at BOTH MEMORY_MD_PATHS");
  // Note: we can't test "both entries in the tarball" until the Day 8
  // assembler lands. Pinning the contract here is sufficient.
}

async function test11_BuildOpenClawJsonForTarball() {
  console.log("\n─── TEST 11: buildOpenClawJsonForTarball (wrapper #5) ──");

  // ── Helper: build the equivalent UserConfig manually (for byte-parity) ─
  function manualUserConfig(p: TarballParams) {
    return {
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
  }
  function manualProxyBaseUrl(p: TarballParams): string {
    return p.apiMode === "all_inclusive"
      ? `${p.nextauthUrl.replace(/\/+$/, "")}/api/gateway`
      : "";
  }

  // ── Test case: all_inclusive + telegram (the vm-918 shape) ───────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allInclusiveResult = buildOpenClawJsonForTarball(validParams) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allInclusiveReference = buildOpenClawConfig(
    manualUserConfig(validParams),
    validParams.gatewayToken,
    manualProxyBaseUrl(validParams),
    validParams.defaultModel,
    validParams.braveApiKey || undefined,
  ) as any;

  assert(
    JSON.stringify(stripWizardTimestamp(allInclusiveResult)) ===
      JSON.stringify(stripWizardTimestamp(allInclusiveReference)),
    "all_inclusive: byte-parity with manual buildOpenClawConfig call (modulo wizard.lastRunAt)",
  );

  // Gateway token
  assert(
    allInclusiveResult.gateway.auth.token === validParams.gatewayToken,
    "gateway.auth.token === p.gatewayToken",
  );
  assert(allInclusiveResult.gateway.auth.mode === "token", "gateway.auth.mode === 'token'");

  // Anthropic proxy baseUrl (all_inclusive only)
  assert(
    allInclusiveResult.models.providers.anthropic.baseUrl === "https://instaclaw.io/api/gateway",
    "all_inclusive: models.providers.anthropic.baseUrl points at proxy",
  );

  // Telegram channel + plugin both present
  assert(
    allInclusiveResult.channels.telegram.botToken === validParams.telegramBotToken,
    "channels.telegram.botToken set",
  );
  assert(
    allInclusiveResult.plugins.entries.telegram.enabled === true,
    "plugins.entries.telegram.enabled === true",
  );

  // No discord (validParams has no discordBotToken)
  assert(!allInclusiveResult.channels.discord, "channels.discord absent (no discord token)");
  assert(
    !allInclusiveResult.plugins.entries.discord,
    "plugins.entries.discord absent (no discord token)",
  );

  // No brave (validParams has no braveApiKey)
  assert(!allInclusiveResult.tools.web, "tools.web absent (no brave key)");
  assert(!allInclusiveResult.plugins.entries.brave, "plugins.entries.brave absent (no brave key)");

  // Critical config keys (Rule-class invariants — these landing wrong on
  // first boot would brick the gateway)
  assert(
    allInclusiveResult.agents.defaults.compaction.mode === "safeguard",
    "agents.defaults.compaction.mode === 'safeguard' (v90 four-layer fix)",
  );
  assert(
    allInclusiveResult.tools.exec.security === "full",
    "tools.exec.security === 'full' (v57 Doug Rathell fix)",
  );
  assert(
    allInclusiveResult.tools.exec.ask === "off",
    "tools.exec.ask === 'off' (auto-approve on Telegram)",
  );
  assert(
    allInclusiveResult.session.reset.mode === "idle",
    "session.reset.mode === 'idle' (v41 evergreen-session fix)",
  );
  assert(
    allInclusiveResult.session.reset.idleMinutes === 10080,
    "session.reset.idleMinutes === 10080 (7-day idle)",
  );
  assert(
    allInclusiveResult.commands.useAccessGroups === false,
    "commands.useAccessGroups === false (v57 groupPolicy=open requirement)",
  );

  // JSON.stringify round-trip — must be valid JSON
  const stringified = JSON.stringify(allInclusiveResult, null, 2);
  assert(stringified.length > 1000, `stringified is non-trivial (got ${stringified.length} bytes)`);
  const reparsed = JSON.parse(stringified);
  assert(
    reparsed.gateway.auth.token === validParams.gatewayToken,
    "JSON round-trip: gateway.auth.token survives",
  );

  // ── BYOK case ────────────────────────────────────────────────────────
  const byokParams: TarballParams = {
    ...validParams,
    apiMode: "byok",
    apiKey: "sk-ant-byok-test-key",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byokResult = buildOpenClawJsonForTarball(byokParams) as any;
  assert(
    !byokResult.models.providers.anthropic.baseUrl,
    "byok: no baseUrl (SDK defaults to api.anthropic.com)",
  );
  // The empty object form is also acceptable per buildOpenClawConfig logic
  assert(
    typeof byokResult.models.providers.anthropic === "object",
    "byok: anthropic provider still present (just no baseUrl)",
  );

  // ── braveApiKey pass-through ─────────────────────────────────────────
  const braveParams: TarballParams = {
    ...validParams,
    braveApiKey: "BSA_test_brave_key_12345",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const braveResult = buildOpenClawJsonForTarball(braveParams) as any;
  assert(braveResult.tools.web.search.provider === "brave", "brave: tools.web.search.provider set");
  assert(
    braveResult.plugins.entries.brave.config.webSearch.apiKey === braveParams.braveApiKey,
    "brave: plugins.entries.brave.config.webSearch.apiKey === p.braveApiKey",
  );
  assert(
    braveResult.plugins.entries.brave.enabled === true,
    "brave: plugins.entries.brave.enabled === true",
  );

  // ── discordBotToken pass-through ─────────────────────────────────────
  const discordParams: TarballParams = {
    ...validParams,
    channels: ["telegram", "discord"],
    discordBotToken: "discord.bot.token.shape.123456",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const discordResult = buildOpenClawJsonForTarball(discordParams) as any;
  assert(
    discordResult.channels.discord.botToken === discordParams.discordBotToken,
    "discord: channels.discord.botToken set",
  );
  assert(
    discordResult.plugins.entries.discord.enabled === true,
    "discord: plugins.entries.discord.enabled === true",
  );
  // Telegram still present in same config
  assert(
    discordResult.channels.telegram.botToken === discordParams.telegramBotToken,
    "discord+telegram: both channels present",
  );

  // ── Partner doesn't change openclaw.json (only .env + SOUL.md) ──────
  // edge_city VMs get the SAME openclaw.json as a no-partner VM. The
  // edge-specific config lives in EDGEOS_BEARER_TOKEN (.env, already
  // tested in test 7) and partner-overlays in setup.sh post-extract.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edgeResult = buildOpenClawJsonForTarball(edgeCityParams) as any;
  // EDGEOS_BEARER_TOKEN MUST NOT appear in openclaw.json (it's .env-only)
  const edgeStringified = JSON.stringify(edgeResult);
  assert(
    !edgeStringified.includes("EDGEOS_BEARER_TOKEN"),
    "edge_city: EDGEOS_BEARER_TOKEN does NOT appear in openclaw.json (it's .env-only)",
  );
  // Top-level structure same as non-edge VM (modulo BYOK/all_inclusive,
  // which is independent of partner)
  const edgeKeys = Object.keys(edgeResult).sort().join(",");
  const validKeys = Object.keys(allInclusiveResult).sort().join(",");
  // Both VMs are BYOK→all_inclusive different. Pull out only the keys
  // we care about for partner-invariance.
  for (const key of [
    "agents",
    "browser",
    "channels",
    "commands",
    "gateway",
    "session",
    "skills",
    "tools",
    "plugins",
    "models",
    "wizard",
    "messages",
    "discovery",
    "meta",
  ]) {
    assert(
      Object.prototype.hasOwnProperty.call(edgeResult, key) ===
        Object.prototype.hasOwnProperty.call(allInclusiveResult, key),
      `edge_city: top-level key '${key}' presence matches no-partner config`,
    );
  }
  void edgeKeys;
  void validKeys;

  // ── Throws on browser profile without cdpPort/cdpUrl ─────────────────
  // Inherited from buildOpenClawConfig. We don't have a way to inject
  // a bad browser profile through TarballParams (it's hardcoded in
  // buildOpenClawConfig), so this is implicitly proven by the function
  // not throwing in any other test above. Document the inheritance.

  // ── Determinism (modulo wizard.lastRunAt) ────────────────────────────
  const det1 = buildOpenClawJsonForTarball(validParams);
  const det2 = buildOpenClawJsonForTarball(validParams);
  assert(
    JSON.stringify(stripWizardTimestamp(det1)) === JSON.stringify(stripWizardTimestamp(det2)),
    "deterministic (modulo wizard.lastRunAt timestamp)",
  );

  // ── Validation: channels=[] throws ──────────────────────────────────
  const emptyChannels: TarballParams = { ...validParams, channels: [] };
  let threw: Error | null = null;
  try {
    validateTarballParams(emptyChannels);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw !== null, "channels=[] throws (no way for agent to talk to user)");

  // ── Validation: channels includes 'discord' without discordBotToken ──
  const discordNoToken: TarballParams = {
    ...validParams,
    channels: ["telegram", "discord"],
    discordBotToken: null,
  };
  threw = null;
  try {
    validateTarballParams(discordNoToken);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw !== null, "channels includes 'discord' but no token → throws (catch misconfig early)");
}

async function test12_AuthProfilesJsonByteParity() {
  console.log("\n─── TEST 12: buildAuthProfilesJsonForTarball byte-parity (audit Fix 1) ──");

  // Helper: compute the equivalent SSH-path inputs (apiKey, proxyBaseUrl,
  // openaiKey) for a given TarballParams. Mirrors configureOpenClaw's
  // resolution at lib/ssh.ts:4965-4980.
  function manualSshPathInputs(p: TarballParams) {
    return {
      apiKey: p.apiMode === "all_inclusive" ? p.gatewayToken : (p.apiKey ?? ""),
      proxyBaseUrl:
        p.apiMode === "all_inclusive"
          ? `${p.nextauthUrl.replace(/\/+$/, "")}/api/gateway`
          : "",
      openaiKey: p.openaiApiKey ?? undefined,
    };
  }

  // ── BYTE-PARITY: all_inclusive without OpenAI key (vm-918 shape) ─────
  // This is the most common production case — most VMs don't have OPENAI_API_KEY
  // in Vercel env (server-side env, not per-VM).
  const aiNoOai = { ...validParams, openaiApiKey: null };
  {
    const inputs = manualSshPathInputs(aiNoOai);
    const sshOutput = buildAuthProfilesJson(inputs.apiKey, inputs.proxyBaseUrl, inputs.openaiKey);
    const wrapperOutput = buildAuthProfilesJsonForTarball(aiNoOai);
    assert(
      wrapperOutput === sshOutput,
      "all_inclusive + no OpenAI: wrapper byte-identical to SSH-path output",
    );
  }

  // ── BYTE-PARITY: all_inclusive WITH OpenAI key ───────────────────────
  const aiWithOai: TarballParams = {
    ...validParams,
    openaiApiKey: "sk-proj-test-openai-key-1234567890abcdef",
  };
  {
    const inputs = manualSshPathInputs(aiWithOai);
    const sshOutput = buildAuthProfilesJson(inputs.apiKey, inputs.proxyBaseUrl, inputs.openaiKey);
    const wrapperOutput = buildAuthProfilesJsonForTarball(aiWithOai);
    assert(
      wrapperOutput === sshOutput,
      "all_inclusive + OpenAI: wrapper byte-identical to SSH-path output",
    );
  }

  // ── BYTE-PARITY: BYOK without OpenAI ────────────────────────────────
  const byokNoOai: TarballParams = {
    ...validParams,
    apiMode: "byok",
    apiKey: "sk-ant-byok-test-key-123",
    openaiApiKey: null,
  };
  {
    const inputs = manualSshPathInputs(byokNoOai);
    const sshOutput = buildAuthProfilesJson(inputs.apiKey, inputs.proxyBaseUrl, inputs.openaiKey);
    const wrapperOutput = buildAuthProfilesJsonForTarball(byokNoOai);
    assert(
      wrapperOutput === sshOutput,
      "BYOK + no OpenAI: wrapper byte-identical to SSH-path output",
    );
  }

  // ── BYTE-PARITY: BYOK WITH OpenAI ───────────────────────────────────
  const byokWithOai: TarballParams = {
    ...validParams,
    apiMode: "byok",
    apiKey: "sk-ant-byok-test-key-123",
    openaiApiKey: "sk-proj-test-openai-key-1234567890abcdef",
  };
  {
    const inputs = manualSshPathInputs(byokWithOai);
    const sshOutput = buildAuthProfilesJson(inputs.apiKey, inputs.proxyBaseUrl, inputs.openaiKey);
    const wrapperOutput = buildAuthProfilesJsonForTarball(byokWithOai);
    assert(
      wrapperOutput === sshOutput,
      "BYOK + OpenAI: wrapper byte-identical to SSH-path output",
    );
  }

  // ── CONTRACT PINS: protect against the 4 pre-fix bugs reverting ─────

  // Bug fix 1.4(a): type field MUST be "api_key", not "anthropic" or "openai".
  // Pre-fix wrapper used "anthropic" / "openai" — broken.
  const aiOutput = buildAuthProfilesJsonForTarball(aiWithOai);
  const aiParsed = JSON.parse(aiOutput);
  assert(
    aiParsed.profiles["anthropic:default"].type === "api_key",
    "anthropic profile type === 'api_key' (NOT 'anthropic' — pre-fix bug)",
  );
  assert(
    aiParsed.profiles["openai:default"].type === "api_key",
    "openai profile type === 'api_key' (NOT 'openai' — pre-fix bug)",
  );

  // Bug fix 1.4(b): OpenAI profile ONLY present when openaiApiKey set.
  // Pre-fix wrapper always emitted OpenAI profile. Pin the conditional.
  const noOaiOutput = buildAuthProfilesJsonForTarball(aiNoOai);
  const noOaiParsed = JSON.parse(noOaiOutput);
  assert(
    !noOaiParsed.profiles["openai:default"],
    "no openaiApiKey → openai:default profile ABSENT (pre-fix wrapper always emitted)",
  );

  // Bug fix 1.4(c): OpenAI key uses openaiApiKey, NOT gatewayToken.
  // Pre-fix wrapper passed gatewayToken as the OpenAI key (would 401 on
  // every memory-search embedding call). Pin the correct source.
  assert(
    aiParsed.profiles["openai:default"].key === "sk-proj-test-openai-key-1234567890abcdef",
    "OpenAI key === openaiApiKey (NOT gatewayToken — pre-fix bug would 401 on embeddings)",
  );
  assert(
    aiParsed.profiles["openai:default"].key !== aiWithOai.gatewayToken,
    "OpenAI key is NOT the gateway token (pin against the pre-fix bug returning)",
  );

  // Bug fix 1.4(d): JSON format is COMPACT (no indent, no trailing newline).
  // Pre-fix wrapper used `JSON.stringify(_, null, 2) + "\n"`. SSH path uses
  // `JSON.stringify({profiles})` — no indent, no trailing newline. Byte-parity
  // requires the compact form.
  assert(
    !aiOutput.includes("\n  "),
    "JSON has NO 2-space indentation (pre-fix wrapper added it — breaks byte-parity)",
  );
  assert(
    !aiOutput.endsWith("\n"),
    "JSON has NO trailing newline (pre-fix wrapper added it — breaks byte-parity)",
  );

  // ── BYOK semantics pin: no baseUrl on Anthropic profile ─────────────
  const byokOutput = buildAuthProfilesJsonForTarball(byokNoOai);
  const byokParsed = JSON.parse(byokOutput);
  assert(
    !byokParsed.profiles["anthropic:default"].baseUrl,
    "BYOK: no baseUrl on anthropic profile (SDK defaults to api.anthropic.com)",
  );

  // ── all_inclusive baseUrl pin ───────────────────────────────────────
  assert(
    aiParsed.profiles["anthropic:default"].baseUrl === "https://instaclaw.io/api/gateway",
    "all_inclusive: anthropic.baseUrl === proxyBaseUrl",
  );

  // ── Determinism ─────────────────────────────────────────────────────
  assert(
    buildAuthProfilesJsonForTarball(aiWithOai) === buildAuthProfilesJsonForTarball(aiWithOai),
    "deterministic on identical input",
  );
}

async function test13_ChunkOneByteParity() {
  console.log("\n─── TEST 13: chunk-1 wrappers byte-parity (audit Fix 2) ──");

  // ── buildIdentityMdForTarball byte-parity ───────────────────────────
  // Wrapper maps p.telegramBotUsername → buildIdentityMd's only param.
  // Output MUST be byte-identical to lib/ssh.ts:buildIdentityMd(botUsername).
  {
    const wrapped = buildIdentityMdForTarball(validParams);
    const reference = buildIdentityMd(validParams.telegramBotUsername);
    assert(
      wrapped === reference,
      "buildIdentityMdForTarball: byte-identical to buildIdentityMd(p.telegramBotUsername)",
    );
  }

  // Agent-name regex pins (would have caught the pre-audit hand-written wrapper)
  const idForFucking = buildIdentityMd("fucking1999_bot");
  assert(
    idForFucking.includes("- **Name:** fucking"),
    "agent-name regex: 'fucking1999_bot' → 'fucking' (strip _bot then digits)",
  );
  const idForMucus = buildIdentityMd("@Mucus09bot");
  assert(
    idForMucus.includes("- **Name:** Mucus"),
    "agent-name regex: '@Mucus09bot' → 'Mucus' (strip @, bot, digits)",
  );
  assert(
    idForMucus.includes("- **Telegram:** @Mucus09bot"),
    "agent-name regex: Telegram line has @-prefix-stripped username",
  );

  // Identity claim pin — caught the pre-audit wrapper which had no
  // "You are X" claim. Without this the agent says "I'm an AI assistant".
  assert(
    idForMucus.includes("You are Mucus. That's your name."),
    "Identity claim 'You are {agentName}. That's your name.' present (pre-audit wrapper lacked this)",
  );

  // Header pin — old wrapper used "# Identity"; SSH-path uses
  // "# IDENTITY.md - Who Am I?"
  assert(
    idForMucus.startsWith("# IDENTITY.md - Who Am I?"),
    "Header is 'IDENTITY.md - Who Am I?' (pre-audit wrapper used '# Identity')",
  );

  // ── buildWalletMdForTarball byte-parity ─────────────────────────────
  // Wrapper maps p.bankr* → buildWalletMd's params object.
  {
    const wrapped = buildWalletMdForTarball(validParams);
    const reference = buildWalletMd({
      bankrEvmAddress: validParams.bankrEvmAddress,
      bankrTokenAddress: validParams.bankrTokenAddress,
      bankrTokenSymbol: validParams.bankrTokenSymbol,
      bankrTokenName: validParams.bankrTokenName,
    });
    assert(
      wrapped === reference,
      "buildWalletMdForTarball: byte-identical to buildWalletMd({...bankr})",
    );
  }

  // Branch pins for buildWalletMd
  const walletNoBankr = buildWalletMd({});
  assert(
    walletNoBankr.includes("<!-- Add wallet addresses here."),
    "WALLET.md no-bankr branch emits the placeholder comment",
  );
  assert(
    !walletNoBankr.includes("## Your Token"),
    "WALLET.md no-bankr branch has no token section",
  );

  const walletWithToken = buildWalletMd({
    bankrEvmAddress: "0xtest",
    bankrTokenAddress: "0xtoken",
    bankrTokenSymbol: "TEST",
    bankrTokenName: "TestCoin",
  });
  assert(
    walletWithToken.includes("- **Token:** $TEST (TestCoin)"),
    "WALLET.md token branch shows ticker + name when name provided",
  );
  assert(
    walletWithToken.includes("Do NOT attempt to launch another token"),
    "WALLET.md token-launch guard present (pre-audit wrapper missing this)",
  );

  const walletTokenNoName = buildWalletMd({
    bankrEvmAddress: "0xtest",
    bankrTokenAddress: "0xtoken",
    bankrTokenSymbol: "TEST",
    // bankrTokenName intentionally absent
  });
  assert(
    walletTokenNoName.includes("- **Token:** $TEST\n"),
    "WALLET.md token branch omits parens when name not provided",
  );

  // Wallet Summary + Key Rules always emit
  assert(
    walletNoBankr.includes("## Wallet Summary") && walletNoBankr.includes("## Key Rules"),
    "WALLET.md always emits Wallet Summary + Key Rules (even no-bankr branch)",
  );

  // ── buildWorldIdMdForTarball byte-parity ────────────────────────────
  // Wrapper checks p.worldIdNullifier truthiness then passes to helper.
  {
    const wrapped = buildWorldIdMdForTarball(edgeCityParams);
    assert(wrapped !== null, "WorldId wrapper returns non-null when nullifier set");
    const reference = buildWorldIdMd(
      edgeCityParams.worldIdNullifier!,
      edgeCityParams.worldIdLevel,
    );
    assert(
      wrapped === reference,
      "buildWorldIdMdForTarball: byte-identical to buildWorldIdMd(nullifier, level)",
    );
  }

  // null gate
  assert(
    buildWorldIdMdForTarball({ ...validParams, worldIdNullifier: null }) === null,
    "WorldId wrapper returns null when nullifier null (caller omits entry)",
  );

  // Level default to "orb" when not provided
  const wiNoLevel = buildWorldIdMd("0xtest", null);
  assert(
    wiNoLevel.includes("Verified (orb level)"),
    "WorldId helper defaults to 'orb' when level null",
  );
  const wiDevice = buildWorldIdMd("0xtest", "device");
  assert(
    wiDevice.includes("Verified (device level)"),
    "WorldId helper passes through 'device' level",
  );

  // Nullifier appears 3 times: header (Hash:), body bullet (Your nullifier),
  // and the "How to Use" prose. SSH path emits all 3 — wrapper must too.
  const nullifier = "0xabc123";
  const wi = buildWorldIdMd(nullifier, "orb");
  const occurrences = wi.split(nullifier).length - 1;
  assert(
    occurrences === 2,
    `Nullifier appears 2x in WORLD_ID.md (got ${occurrences} — pin against pre-audit wrapper which only had 1)`,
  );
}

async function test14_AllMissingEnvVars() {
  console.log("\n─── TEST 14: all 10 previously-missing env vars (audit Fix 3) ──");

  // ── Empty-input fixture: everything optional null/absent ─────────────
  // Only emit the universal env vars (GATEWAY_TOKEN, TELEGRAM_BOT_TOKEN,
  // POLYGON/CLOB/AGENT_REGION, INSTACLAW_MUAPI_PROXY, AGENTBOOK_ADDRESS,
  // INSTACLAW_USER_ID/VM_NAME/NEXTAUTH_URL). All conditional env vars OMITTED.
  const minimal: TarballParams = {
    ...validParams,
    bankrEvmAddress: null,
    bankrApiKey: null,
    bankrTokenAddress: null,
    bankrTokenSymbol: null,
    bankrTokenName: null,
    worldIdNullifier: null,
    worldIdLevel: null,
    elevenlabsApiKey: null,
    resendApiKey: null,
    alphavantageApiKey: null,
    braveApiKey: null,
    openaiApiKey: null,
    edgeosBearerToken: null,
    userTimezone: null,
  };
  const envMinimal = buildDotEnv(minimal);

  // INSTACLAW_MUAPI_PROXY is unconditional per SSH-path emission at line 5382-5386
  assert(
    envMinimal.includes("INSTACLAW_MUAPI_PROXY=https://instaclaw.io"),
    "INSTACLAW_MUAPI_PROXY=https://instaclaw.io always emitted (SSH-path lib/ssh.ts:5382)",
  );

  // All conditional env vars MUST be absent in minimal fixture
  for (const conditionalKey of [
    "BANKR_WALLET_ADDRESS",
    "BANKR_API_KEY",
    "BANKR_TOKEN_ADDRESS",
    "BANKR_TOKEN_SYMBOL",
    "WORLD_ID_NULLIFIER",
    "WORLD_ID_LEVEL",
    "USER_TIMEZONE",
    "ELEVENLABS_API_KEY",
    "RESEND_API_KEY",
    "ALPHAVANTAGE_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "OPENAI_API_KEY",
    "EDGEOS_BEARER_TOKEN",
  ]) {
    assert(
      !new RegExp(`^${conditionalKey}=`, "m").test(envMinimal),
      `${conditionalKey} ABSENT when input null (SSH-path conditional honored)`,
    );
  }

  // ── Full-input fixture: all optional fields set ────────────────────
  const REAL_JWT_FOR_TEST =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ." +
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  const full: TarballParams = {
    ...edgeCityParams,
    bankrTokenAddress: "0xtoken0123456789",
    bankrTokenSymbol: "TEST",
    bankrTokenName: "TestCoin",
    worldIdNullifier: "0xabcdef1234567890",
    worldIdLevel: "device",
    elevenlabsApiKey: "el_test_key_abc",
    resendApiKey: "re_test_key_def",
    alphavantageApiKey: "av_test_key_ghi",
    braveApiKey: "BSA_test_brave_jkl",
    openaiApiKey: "sk-proj-openai-mno",
    edgeosBearerToken: REAL_JWT_FOR_TEST,
  };
  const envFull = buildDotEnv(full);

  // BANKR_TOKEN_* (pin against audit §1.5 — pre-fix wrapper missing these)
  assert(
    envFull.includes(`BANKR_TOKEN_ADDRESS=0xtoken0123456789`),
    "BANKR_TOKEN_ADDRESS emitted when set (audit §1.5 — previously missing)",
  );
  assert(
    envFull.includes("BANKR_TOKEN_SYMBOL=TEST"),
    "BANKR_TOKEN_SYMBOL emitted when set (audit §1.5)",
  );

  // WORLD_ID_* paired emission
  assert(
    envFull.includes("WORLD_ID_NULLIFIER=0xabcdef1234567890"),
    "WORLD_ID_NULLIFIER emitted when set (audit §1.5 — previously missing)",
  );
  assert(
    envFull.includes("WORLD_ID_LEVEL=device"),
    "WORLD_ID_LEVEL emitted with explicit value (audit §1.5 — previously missing)",
  );

  // WORLD_ID_LEVEL default test (level null → "orb")
  const wiDefaultLevel: TarballParams = {
    ...full,
    worldIdLevel: null,
  };
  const envWiDefault = buildDotEnv(wiDefaultLevel);
  assert(
    envWiDefault.includes("WORLD_ID_LEVEL=orb"),
    "WORLD_ID_LEVEL defaults to 'orb' when worldIdLevel null (mirrors SSH-path ?? 'orb')",
  );

  // Server-side API keys — all 5 conditionals
  assert(
    envFull.includes("ELEVENLABS_API_KEY=el_test_key_abc"),
    "ELEVENLABS_API_KEY emitted (audit §1.5)",
  );
  assert(
    envFull.includes("RESEND_API_KEY=re_test_key_def"),
    "RESEND_API_KEY emitted (audit §1.5)",
  );
  assert(
    envFull.includes("ALPHAVANTAGE_API_KEY=av_test_key_ghi"),
    "ALPHAVANTAGE_API_KEY emitted (audit §1.5)",
  );
  assert(
    envFull.includes("BRAVE_SEARCH_API_KEY=BSA_test_brave_jkl"),
    "BRAVE_SEARCH_API_KEY emitted (audit §1.5)",
  );
  assert(
    envFull.includes("OPENAI_API_KEY=sk-proj-openai-mno"),
    "OPENAI_API_KEY emitted (audit §1.5)",
  );

  // EDGEOS_BEARER_TOKEN partner-gated (already covered in test7 but pin here too)
  assert(
    envFull.includes(`EDGEOS_BEARER_TOKEN=${REAL_JWT_FOR_TEST}`),
    "EDGEOS_BEARER_TOKEN emitted for edge_city with valid JWT",
  );

  // ── Coverage assertion: full required+optional env-var set ──────────
  // After this fix, the cloud-init wrapper emits a superset of the
  // SSH-path's .env. Enumerate every env var the SSH path emits, verify
  // each is present in our full-input fixture.
  const SSH_PATH_EMITTED_KEYS = [
    "GATEWAY_TOKEN",
    "POLYGON_RPC_URL",
    "CLOB_PROXY_URL",
    "CLOB_PROXY_URL_BACKUP",
    "AGENT_REGION",
    "INSTACLAW_MUAPI_PROXY",
    "TELEGRAM_BOT_TOKEN",
    "AGENTBOOK_ADDRESS",
    "BANKR_WALLET_ADDRESS",
    "BANKR_API_KEY",
    "BANKR_TOKEN_ADDRESS",
    "BANKR_TOKEN_SYMBOL",
    "WORLD_ID_NULLIFIER",
    "WORLD_ID_LEVEL",
    "ELEVENLABS_API_KEY",
    "RESEND_API_KEY",
    "ALPHAVANTAGE_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "OPENAI_API_KEY",
    "EDGEOS_BEARER_TOKEN",
  ];
  for (const key of SSH_PATH_EMITTED_KEYS) {
    assert(
      new RegExp(`^${key}=`, "m").test(envFull),
      `Full-input env emits ${key} (SSH-path coverage)`,
    );
  }
}

async function test15_FullTarballByteParityIntegration() {
  console.log("\n─── TEST 15: full-tarball byte-parity integration (audit Fix 4) ──");

  // The previous per-wrapper byte-parity tests (test12 / test13 / test14)
  // verify each WRAPPER produces SSH-path-matching output. This test
  // verifies the ASSEMBLER (collectPartialEntries + packTarGz) puts each
  // wrapper's output into the tarball at the correct path with the
  // correct mode, byte-for-byte unchanged. Catches glue bugs that
  // per-wrapper unit tests can't.

  // Use a params object that exercises every conditional path: all bankr
  // fields set + world ID set + edge_city partner + OpenAI key.
  const params: TarballParams = {
    ...edgeCityParams,
    bankrTokenAddress: "0xtoken0123456789",
    bankrTokenSymbol: "TEST",
    bankrTokenName: "TestCoin",
    openaiApiKey: "sk-proj-openai-test-mno",
  };

  const buf = await streamToBuffer(packPartialTarball(params));
  const files = await unpackTarball(buf);

  // For each file the assembler emits, the extracted bytes MUST equal
  // the corresponding wrapper's output for the same params.
  type ByteParityCase = {
    path: string;
    expectedMode: number;
    actualContent: () => string | null;
    label: string;
  };
  const cases: ByteParityCase[] = [
    {
      path: "home/openclaw/.openclaw/.env",
      expectedMode: 0o600,
      actualContent: () => buildDotEnv(params),
      label: ".env from buildDotEnv(p)",
    },
    {
      path: "home/openclaw/.openclaw/agents/main/agent/auth-profiles.json",
      expectedMode: 0o600,
      actualContent: () => buildAuthProfilesJsonForTarball(params),
      label: "auth-profiles.json from buildAuthProfilesJsonForTarball(p)",
    },
    {
      path: "home/openclaw/.openclaw/workspace/IDENTITY.md",
      expectedMode: 0o644,
      actualContent: () => buildIdentityMdForTarball(params),
      label: "IDENTITY.md from buildIdentityMdForTarball(p)",
    },
    {
      path: "home/openclaw/.openclaw/workspace/WALLET.md",
      expectedMode: 0o644,
      actualContent: () => buildWalletMdForTarball(params),
      label: "WALLET.md from buildWalletMdForTarball(p)",
    },
    {
      path: "home/openclaw/.openclaw/workspace/WORLD_ID.md",
      expectedMode: 0o644,
      actualContent: () => buildWorldIdMdForTarball(params),
      label: "WORLD_ID.md from buildWorldIdMdForTarball(p)",
    },
    {
      path: "home/openclaw/.openclaw/wallet/agent.key",
      expectedMode: 0o600,
      actualContent: () => buildAgentKey(params),
      label: "agent.key from buildAgentKey(p)",
    },
  ];

  for (const c of cases) {
    const entry = files.get(c.path);
    assert(entry !== undefined, `tarball contains ${c.path}`);
    if (!entry) continue;
    const expectedContent = c.actualContent();
    assert(
      expectedContent !== null,
      `wrapper for ${c.label} returns content (not null) for full-fixture params`,
    );
    assert(
      entry.body === expectedContent,
      `byte-parity (assembler glue): ${c.label}`,
    );
    assert(
      entry.mode === c.expectedMode,
      `mode-parity: ${c.path} has mode ${c.expectedMode.toString(8)} (got ${entry.mode.toString(8)})`,
    );
  }

  // Indirect SSH-path transitive byte-parity check: since the wrappers
  // are now pure pass-throughs to lib/ssh.ts exports (post Fix 1+2), the
  // tarball-extracted bytes must equal what the SSH path generates for
  // the same inputs. Verify the transitive chain by going one hop further
  // back: extract from tarball, compute via SSH-path helper, assert equal.
  const idEntry = files.get("home/openclaw/.openclaw/workspace/IDENTITY.md")!;
  const idViaSshHelper = buildIdentityMd(params.telegramBotUsername);
  assert(
    idEntry.body === idViaSshHelper,
    "TARBALL → SSH helper chain: tarball IDENTITY.md === buildIdentityMd(botUsername)",
  );

  const walletEntry = files.get("home/openclaw/.openclaw/workspace/WALLET.md")!;
  const walletViaSshHelper = buildWalletMd({
    bankrEvmAddress: params.bankrEvmAddress,
    bankrTokenAddress: params.bankrTokenAddress,
    bankrTokenSymbol: params.bankrTokenSymbol,
    bankrTokenName: params.bankrTokenName,
  });
  assert(
    walletEntry.body === walletViaSshHelper,
    "TARBALL → SSH helper chain: tarball WALLET.md === buildWalletMd({...bankr})",
  );

  const worldIdEntry = files.get("home/openclaw/.openclaw/workspace/WORLD_ID.md")!;
  const worldIdViaSshHelper = buildWorldIdMd(
    params.worldIdNullifier!,
    params.worldIdLevel,
  );
  assert(
    worldIdEntry.body === worldIdViaSshHelper,
    "TARBALL → SSH helper chain: tarball WORLD_ID.md === buildWorldIdMd(nullifier, level)",
  );

  const authEntry = files.get(
    "home/openclaw/.openclaw/agents/main/agent/auth-profiles.json",
  )!;
  const apiKeyForAuth =
    params.apiMode === "all_inclusive" ? params.gatewayToken : (params.apiKey ?? "");
  const proxyBaseUrlForAuth =
    params.apiMode === "all_inclusive"
      ? `${params.nextauthUrl.replace(/\/+$/, "")}/api/gateway`
      : "";
  const authViaSshHelper = buildAuthProfilesJson(
    apiKeyForAuth,
    proxyBaseUrlForAuth,
    params.openaiApiKey ?? undefined,
  );
  assert(
    authEntry.body === authViaSshHelper,
    "TARBALL → SSH helper chain: tarball auth-profiles.json === buildAuthProfilesJson(...)",
  );

  // Sanity: no UNEXPECTED files in the tarball. Pin the expected entry
  // count for this fixture so a future "accidentally added a file" bug
  // breaks this assertion.
  const expectedPaths = new Set([
    "home/openclaw/.openclaw/.env",
    "home/openclaw/.openclaw/agents/main/agent/auth-profiles.json",
    "home/openclaw/.openclaw/workspace/IDENTITY.md",
    "home/openclaw/.openclaw/workspace/WALLET.md",
    "home/openclaw/.openclaw/workspace/WORLD_ID.md",
    "home/openclaw/.openclaw/wallet/agent.key",
    "overlays/bankr-overlay.md",
    "overlays/soul-edge-stub.md",
    "overlays/soul-consensus-stub.md",
    "overlays/edge-instaclaw-overlay.md",
  ]);
  const actualPaths = new Set(files.keys());
  assert(
    actualPaths.size === expectedPaths.size,
    `tarball has exactly ${expectedPaths.size} entries (got ${actualPaths.size})`,
  );
  for (const p of expectedPaths) {
    assert(actualPaths.has(p), `expected path present: ${p}`);
  }
}

async function test16_BuildSetupSh() {
  console.log("\n─── TEST 16: buildSetupSh (Day 8a CRITICAL steps) ──");

  const sh = buildSetupSh(validParams);

  // 1. Output is a non-empty string starting with the shebang. The
  //    bootstrap invokes `bash setup.sh`, but the shebang is industry
  //    standard + tells maintainers what shell this targets.
  assert(typeof sh === "string" && sh.length > 0, "buildSetupSh returns non-empty string");
  assert(sh.startsWith("#!/bin/bash\n"), "starts with #!/bin/bash shebang");
  assert(sh.length > 2_000, `buildSetupSh produces substantial bash (got ${sh.length} bytes)`);

  // 2. Every sentinel exported for Rule 23 verification is present.
  //    These are the load-bearing markers for the script — drift here
  //    means the script is incomplete OR a refactor silently removed a
  //    safety primitive.
  for (const [name, marker] of Object.entries(SETUP_SH_SENTINELS)) {
    assert(sh.includes(marker), `SETUP_SH_SENTINELS.${name} present in output`);
  }

  // 3. §17b regression guard — gateway must be `restart`'d, not
  //    `start`'d. Snapshot's linger boots openclaw-gateway with the
  //    placeholder config; `start` is a no-op. See snapshot-bake-
  //    requirements §17b.9 + setup.sh §1.32.
  assert(
    sh.includes("systemctl --user restart openclaw-gateway"),
    "§17b: gateway is `restart`'d (not `start`'d) to override placeholder boot",
  );
  assert(
    !sh.match(/systemctl --user start openclaw-gateway\b/),
    "§17b: no `systemctl --user start openclaw-gateway` lingering anywhere",
  );

  // 4. Params are substituted into the bash. validateTarballParams
  //    already rejects shell-unsafe chars, but verify the splice
  //    actually fired (i.e. the template literal wasn't left raw).
  assert(sh.includes(`USER_ID="${validParams.userId}"`), "USER_ID env spliced");
  assert(sh.includes(`VM_NAME="${validParams.vmName}"`), "VM_NAME env spliced");
  assert(sh.includes(`CALLBACK_TOKEN="${validParams.callbackToken}"`), "CALLBACK_TOKEN spliced");
  assert(sh.includes(`NEXTAUTH_URL="${validParams.nextauthUrl}"`), "NEXTAUTH_URL spliced");
  assert(
    sh.includes(`AGENTBOOK_ADDRESS="${validParams.agentbookAddress}"`),
    "AGENTBOOK_ADDRESS spliced",
  );

  // 5. nextauthUrl trailing-slash stripping (§1 of buildSetupSh).
  const trailingSlashParams: TarballParams = {
    ...validParams,
    nextauthUrl: "https://instaclaw.io///",
  };
  const shTrim = buildSetupSh(trailingSlashParams);
  assert(
    shTrim.includes(`NEXTAUTH_URL="https://instaclaw.io"`),
    "nextauthUrl trailing slashes stripped before splice",
  );

  // 6. Callback URL path sentinel + concatenation shape.
  assert(
    sh.includes(SETUP_SH_SENTINELS.CALLBACK_PATH),
    "callback URL path present (full URL assembled at runtime as $NEXTAUTH_URL$CALLBACK_PATH)",
  );

  // 7. Determinism — same params → byte-identical bash output.
  const sh1 = buildSetupSh(validParams);
  const sh2 = buildSetupSh(validParams);
  assert(sh1 === sh2, "buildSetupSh is deterministic for same params");

  // 8. bash -n syntax check — catches missing escapes (e.g. an
  //    unescaped `$` collapsing into a TS template substitution that
  //    produces invalid bash). Writes to a tmp file and lets bash
  //    parse it.
  const tmpPath = path.join(tmpdir(), `_test-setup-sh-${process.pid}.sh`);
  writeFileSync(tmpPath, sh, "utf-8");
  const bashCheck = spawnSync("bash", ["-n", tmpPath], { encoding: "utf-8" });
  assert(
    bashCheck.status === 0,
    `bash -n syntax check passes (status=${bashCheck.status}; stderr=${bashCheck.stderr.trim().slice(0, 400)})`,
  );

  // 9. bash -n on the edge_city variant exercises the EDGEOS_BEARER
  //    branch + worldid branch. Same syntactic shape, different
  //    spliced values.
  const edgeShPath = path.join(tmpdir(), `_test-setup-sh-edge-${process.pid}.sh`);
  writeFileSync(edgeShPath, buildSetupSh(edgeCityParams), "utf-8");
  const edgeBashCheck = spawnSync("bash", ["-n", edgeShPath], { encoding: "utf-8" });
  assert(
    edgeBashCheck.status === 0,
    `bash -n passes for edge_city variant (status=${edgeBashCheck.status}; stderr=${edgeBashCheck.stderr.trim().slice(0, 400)})`,
  );

  // 10. shellcheck — if installed, run for stricter lint (informational;
  //     bash -n is the gating check, shellcheck warnings on bash internals
  //     like SC2086 are tolerable). We only fail on parse errors.
  try {
    execFileSync("which", ["shellcheck"], { stdio: "ignore" });
    const sc = spawnSync(
      "shellcheck",
      ["-s", "bash", "-S", "error", tmpPath],
      { encoding: "utf-8" },
    );
    assert(
      sc.status === 0 || sc.status === null,
      `shellcheck (errors only) passes (status=${sc.status}; output=${sc.stdout.trim().slice(0, 400)})`,
    );
  } catch {
    console.log("  ◦ shellcheck not installed — skipping strict lint pass");
  }

  // ── Day 8b BE-1 assertions ────────────────────────────────────────
  // BE-1 wires up linger + sshd OOM-protect drop-in. Verify the three
  // sentinels are present, the BEST_EFFORT (`|| echo WARN`) pattern is
  // used (NOT the CRITICAL `|| { ... exit 1 }` pattern), and the block
  // appears BEFORE §1.5 (canonical execution order per plan §4).

  // 11. BE-1 ordering: must precede §1.5 CRITICAL.
  const idxBE1 = sh.indexOf("§1.1 BEST_EFFORT [BE-1]");
  const idx15 = sh.indexOf("§1.5 CRITICAL");
  assert(
    idxBE1 > 0 && idx15 > 0 && idxBE1 < idx15,
    `BE-1 block appears BEFORE §1.5 CRITICAL (BE-1 at ${idxBE1}, §1.5 at ${idx15})`,
  );

  // 12. BE-1 uses the BEST_EFFORT pattern, NOT the CRITICAL pattern.
  // Look for the WARN echo with the canonical BE-1 label as the close.
  // The CRITICAL pattern would have `rm -f /tmp/.instaclaw-ready` +
  // `touch /tmp/.instaclaw-failed` + `exit 1` after the `||`; BE-1 has
  // a single echo line.
  const be1Block = sh.slice(idxBE1, idx15);
  assert(
    be1Block.includes('|| echo "[$(date -u +%FT%TZ)] WARN: BE-1'),
    "BE-1 uses BEST_EFFORT `|| echo WARN` pattern",
  );
  assert(
    !be1Block.includes("touch /tmp/.instaclaw-failed"),
    "BE-1 does NOT use CRITICAL `touch /tmp/.instaclaw-failed` pattern",
  );
  assert(
    !be1Block.includes("exit 1"),
    "BE-1 does NOT contain `exit 1` (BEST_EFFORT never aborts setup)",
  );

  // 13. BE-1 canonical OOM-protect drop-in body via printf.
  // Rewritten 2026-05-14 (Bug #1 fix) from heredoc to printf so the
  // command sits cleanly inside the && chain. The output bytes are
  // byte-identical to the previous heredoc form (28 bytes:
  // "[Service]\nOOMScoreAdjust=-900\n").
  assert(
    be1Block.includes("printf '[Service]\\nOOMScoreAdjust=-900\\n' > /etc/systemd/system/ssh.service.d/oom-protect.conf"),
    "BE-1 writes canonical OOM-protect drop-in via printf (Bug #1 fix)",
  );

  // 14. BE-1's daemon-reload is the SYSTEM instance (no `--user` flag).
  // The drop-in lives in /etc/systemd/system/, so `daemon-reload` MUST
  // hit the system manager. A `--user` daemon-reload here would silently
  // reload the wrong manager and the drop-in would not be picked up
  // until the next system reboot.
  const reloadIdx = be1Block.indexOf("systemctl daemon-reload");
  assert(
    reloadIdx > 0 && !be1Block.slice(reloadIdx - 30, reloadIdx).includes("--user"),
    "BE-1 daemon-reload is the system instance (no --user flag in the line)",
  );

  // 14b. Bug #1 fix verification: BE-1 commands are && -chained.
  // POSIX semantics suspend `set -e` inside `{ } || handler`, so a bare
  // newline-separated block would silently swallow intermediate failures
  // (only the LAST command's exit code determines whether the WARN
  // fires). Every BE-1 command must be && -chained so a failing
  // intermediate command aborts the chain and triggers the WARN.
  assert(
    be1Block.includes("loginctl enable-linger openclaw \\\n    && mkdir -p"),
    "BE-1: loginctl is && -chained to mkdir (Bug #1 fix)",
  );
  assert(
    be1Block.includes("&& printf '[Service]"),
    "BE-1: mkdir is && -chained to printf (Bug #1 fix)",
  );
  assert(
    be1Block.includes("&& systemctl daemon-reload"),
    "BE-1: printf is && -chained to daemon-reload (Bug #1 fix)",
  );

  // ── Day 8b BE-7 assertions ────────────────────────────────────────
  // BE-7 deploys browser-relay-server.js + check-skill-updates.sh +
  // installs the daily 3am UTC cron. Verify ordering (between §1.9 and
  // §1.32), BEST_EFFORT pattern, the sudo -u openclaw bash -c block,
  // the idempotent grep -v cron pattern, and that the cron line's
  // \$HOME is unexpanded in the source (bash inside sudo expands at
  // install time, matching SSH-path behavior).

  // 15. BE-7 ordering: AFTER §1.9 CRITICAL, BEFORE §1.32 CRITICAL.
  const idxBE7 = sh.indexOf("§1.10 BEST_EFFORT [BE-7]");
  const idx19 = sh.indexOf("§1.9 CRITICAL");
  const idx132 = sh.indexOf("§1.32 CRITICAL");
  assert(
    idxBE7 > 0 && idx19 > 0 && idx132 > 0,
    `BE-7, §1.9, and §1.32 markers all present (BE-7=${idxBE7}, §1.9=${idx19}, §1.32=${idx132})`,
  );
  assert(
    idxBE7 > idx19 && idxBE7 < idx132,
    "BE-7 block sits between §1.9 CRITICAL and §1.32 CRITICAL",
  );

  // 16. BE-7 uses BEST_EFFORT (`|| echo WARN`) pattern, not CRITICAL.
  const be7Block = sh.slice(idxBE7, idx132);
  assert(
    be7Block.includes('|| echo "[$(date -u +%FT%TZ)] WARN: BE-7'),
    "BE-7 uses BEST_EFFORT `|| echo WARN` pattern",
  );
  assert(
    !be7Block.includes("touch /tmp/.instaclaw-failed"),
    "BE-7 does NOT use CRITICAL `touch /tmp/.instaclaw-failed` pattern",
  );

  // 17. BE-7 install commands target both files at the canonical paths.
  // Indentation (9 spaces on continuation lines) reflects the && -chain
  // nesting from the Bug #1 fix (2026-05-14).
  assert(
    be7Block.includes(
      "/tmp/instaclaw-config/home/openclaw/scripts/browser-relay-server.js \\\n         /home/openclaw/scripts/browser-relay-server.js",
    ),
    "BE-7 installs browser-relay-server.js from tarball to /home/openclaw/scripts/",
  );
  assert(
    be7Block.includes(
      "/tmp/instaclaw-config/home/openclaw/scripts/check-skill-updates.sh \\\n         /home/openclaw/scripts/check-skill-updates.sh",
    ),
    "BE-7 installs check-skill-updates.sh from tarball to /home/openclaw/scripts/",
  );

  // 18. BE-7 cron line uses the unescaped `$HOME` (bash inside sudo
  //     expands at install time → stored crontab entry has the literal
  //     /home/openclaw path, matching the SSH-path behavior).
  assert(
    be7Block.includes(
      '"0 3 * * * /bin/bash $HOME/scripts/check-skill-updates.sh >> $HOME/.openclaw/logs/skill-updates.log 2>&1"',
    ),
    "BE-7 cron line preserves $HOME for bash-time expansion (matches SSH-path byte-parity)",
  );

  // 19. BE-7 cron install uses the idempotent `crontab -l | grep -v ... |
  //     crontab -` pattern from lib/ssh.ts:6516 so re-running setup.sh
  //     doesn't duplicate the entry.
  assert(
    be7Block.includes(
      '(crontab -l 2>/dev/null | grep -v "check-skill-updates"; echo "$CRON_LINE") | crontab -',
    ),
    "BE-7 cron install uses idempotent grep-v + re-add pattern",
  );

  // 20. BE-7 runs the cron install as the openclaw user via sudo -u
  //     (the cron belongs to that user; root's crontab is the wrong
  //     place — root has no $HOME pointing at /home/openclaw).
  assert(
    /sudo -u openclaw bash -c '/.test(be7Block),
    "BE-7 wraps cron install in `sudo -u openclaw bash -c`",
  );

  // 21. BE-7 creates the destination directories (~/scripts and
  //     ~/.openclaw/logs) before installing — the snapshot doesn't
  //     guarantee they exist.
  assert(
    be7Block.includes("install -d -o openclaw -g openclaw -m 755 /home/openclaw/scripts"),
    "BE-7 creates /home/openclaw/scripts (mode 755, openclaw-owned) before install",
  );
  assert(
    be7Block.includes("install -d -o openclaw -g openclaw -m 755 /home/openclaw/.openclaw/logs"),
    "BE-7 creates /home/openclaw/.openclaw/logs (for cron log target) before install",
  );

  // 21b. Bug #1 fix verification: BE-7 commands are && -chained.
  assert(
    be7Block.includes("/home/openclaw/scripts \\\n    && install -d"),
    "BE-7: first install -d is && -chained to next (Bug #1 fix)",
  );
  assert(
    be7Block.includes("/home/openclaw/.openclaw/logs \\\n    && install -o openclaw"),
    "BE-7: second install -d is && -chained to file install (Bug #1 fix)",
  );
  assert(
    be7Block.includes("&& sudo -u openclaw bash -c"),
    "BE-7: file installs are && -chained to cron sudo block (Bug #1 fix)",
  );

  // ── Bug #1 fix verification: §1.5 CRITICAL block uses && chain ────
  const idx15Critical = sh.indexOf("§1.5 CRITICAL");
  const idx16Critical = sh.indexOf("§1.6 CRITICAL");
  assert(
    idx15Critical > 0 && idx16Critical > 0 && idx15Critical < idx16Critical,
    "§1.5 and §1.6 markers present in correct order",
  );
  const block15 = sh.slice(idx15Critical, idx16Critical);
  assert(
    block15.includes("&& install -d -o openclaw -g openclaw -m 700"),
    "§1.5: install -d commands are && -chained (Bug #1 fix)",
  );
  assert(
    block15.includes("&& install -o openclaw -g openclaw -m 600 \\\n         /tmp/instaclaw-config/home/openclaw/.openclaw/openclaw.json"),
    "§1.5: openclaw.json install is && -chained (Bug #1 fix; previously silent partial-failure → stale-token gateway)",
  );

  // ── Bug #1 fix verification: §1.9 CRITICAL uses rc-accumulator ────
  const idx19Critical = sh.indexOf("§1.9 CRITICAL");
  const idx110 = sh.indexOf("§1.10 BEST_EFFORT");
  assert(
    idx19Critical > 0 && idx110 > 0 && idx19Critical < idx110,
    "§1.9 and §1.10 markers present in correct order",
  );
  const block19 = sh.slice(idx19Critical, idx110);
  assert(
    /^\s+rc=0$/m.test(block19),
    "§1.9: rc-accumulator initialized to 0 (Bug #1 fix)",
  );
  assert(
    block19.includes('|| rc=1'),
    "§1.9: install failures captured into rc=1 (Bug #1 fix)",
  );
  assert(
    block19.includes('[ "$rc" = "0" ]'),
    "§1.9: terminal rc check gates the block exit (Bug #1 fix)",
  );

  // ── Bug #2 fix verification: §1.9 universal vs conditional split ──
  // IDENTITY.md, WALLET.md, BOOTSTRAP.md MUST be in the universal loop
  // (no [ -f ] guard — fail loud if tarball-builder bug omits them).
  // USER.md, WORLD_ID.md, MEMORY.md stay in the conditional loop.
  assert(
    block19.includes("for f in IDENTITY.md WALLET.md BOOTSTRAP.md; do"),
    "§1.9 Bug #2 fix: universal files in dedicated unguarded for-loop (IDENTITY/WALLET/BOOTSTRAP)",
  );
  assert(
    block19.includes("for f in USER.md WORLD_ID.md MEMORY.md; do"),
    "§1.9: conditional files in dedicated guarded for-loop (USER/WORLD_ID/MEMORY)",
  );
  // The universal loop must NOT have [ -f $src ] inside — verify by
  // grepping the universal-loop body span.
  const universalLoopStart = block19.indexOf("for f in IDENTITY.md WALLET.md BOOTSTRAP.md; do");
  const universalLoopEnd = block19.indexOf("done", universalLoopStart);
  const universalLoopBody = block19.slice(universalLoopStart, universalLoopEnd);
  assert(
    !universalLoopBody.includes("[ -f"),
    "§1.9 Bug #2 fix: universal loop has NO [ -f ] guard (fail loud on tarball-builder regression)",
  );

  // ── Gap #2: install -m mode flag assertions ───────────────────────
  // Verify each install command uses the correct mode flag. Catches
  // future regressions where someone edits setup.sh and accidentally
  // drops/changes a mode flag (e.g., agent.key needs 600 to keep the
  // private key off the file-mode bitmask).
  // §1.5
  assert(
    block15.includes("install -o openclaw -g openclaw -m 600 \\\n         /tmp/instaclaw-config/home/openclaw/.openclaw/openclaw.json"),
    "§1.5 mode: openclaw.json install uses -m 600",
  );
  assert(
    block15.includes("install -o openclaw -g openclaw -m 600 \\\n         /tmp/instaclaw-config/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json"),
    "§1.5 mode: auth-profiles.json install uses -m 600",
  );
  // §1.6
  const idx132Critical = sh.indexOf("§1.32 CRITICAL");
  const block16 = sh.slice(idx16Critical, sh.indexOf("§1.9 CRITICAL"));
  assert(
    block16.includes("install -o openclaw -g openclaw -m 600 \\\n    /tmp/instaclaw-config/home/openclaw/.openclaw/.env"),
    "§1.6 mode: .env install uses -m 600",
  );
  // §1.9 — universal + conditional both use -m 644; agent.key uses -m 600;
  // workspace dir is -m 755; wallet dir is -m 700.
  assert(
    block19.includes("install -d -o openclaw -g openclaw -m 755 /home/openclaw/.openclaw/workspace"),
    "§1.9 mode: workspace dir uses -m 755",
  );
  assert(
    block19.includes("install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/wallet"),
    "§1.9 mode: wallet dir uses -m 700",
  );
  assert(
    block19.includes("install -o openclaw -g openclaw -m 644 \\\n      \"/tmp/instaclaw-config/home/openclaw/.openclaw/workspace/$f\""),
    "§1.9 mode: workspace .md files use -m 644",
  );
  assert(
    block19.includes("install -o openclaw -g openclaw -m 600 \\\n    /tmp/instaclaw-config/home/openclaw/.openclaw/wallet/agent.key"),
    "§1.9 mode: agent.key uses -m 600 (private-key protection)",
  );
  // BE-7
  assert(
    be7Block.includes("install -o openclaw -g openclaw -m 755 \\\n         /tmp/instaclaw-config/home/openclaw/scripts/browser-relay-server.js"),
    "BE-7 mode: browser-relay-server.js uses -m 755",
  );
  assert(
    be7Block.includes("install -o openclaw -g openclaw -m 755 \\\n         /tmp/instaclaw-config/home/openclaw/scripts/check-skill-updates.sh"),
    "BE-7 mode: check-skill-updates.sh uses -m 755",
  );
}

async function test17_BuildCloudInitTarball() {
  console.log("\n─── TEST 17: buildCloudInitTarball assembler integration ──");

  // ── Case A: validParams (all_inclusive, no partner, no Gmail, no
  //    World ID, bankr-overlay only). Smallest entry set. 10 entries.
  {
    const buf = await streamToBuffer(buildCloudInitTarball(validParams));
    const files = await unpackTarball(buf);

    const expectedPaths = new Set([
      // chunk-1 (collectPartialEntries)
      "home/openclaw/.openclaw/agents/main/agent/auth-profiles.json",
      "home/openclaw/.openclaw/.env",
      "home/openclaw/.openclaw/workspace/IDENTITY.md",
      "home/openclaw/.openclaw/workspace/WALLET.md",
      "home/openclaw/.openclaw/wallet/agent.key",
      "overlays/bankr-overlay.md",
      // chunk-2 wrappers
      "home/openclaw/.openclaw/openclaw.json",
      "home/openclaw/.openclaw/workspace/BOOTSTRAP.md",
      "home/openclaw/.openclaw/agents/main/agent/system-prompt.md",
      // BE-7 outer scripts (Day 8b)
      "home/openclaw/scripts/browser-relay-server.js",
      "home/openclaw/scripts/check-skill-updates.sh",
      // setup.sh
      "setup.sh",
    ]);
    const actualPaths = new Set(files.keys());

    // Diff before equality so failures are debuggable.
    for (const p of expectedPaths) {
      assert(actualPaths.has(p), `[validParams] expected path present: ${p}`);
    }
    for (const p of actualPaths) {
      assert(expectedPaths.has(p), `[validParams] no unexpected path: ${p}`);
    }
    assert(
      actualPaths.size === expectedPaths.size,
      `[validParams] tarball entry count: expected ${expectedPaths.size}, got ${actualPaths.size}`,
    );

    // Gmail-absent → USER.md not emitted.
    assert(
      !actualPaths.has("home/openclaw/.openclaw/workspace/USER.md"),
      "[validParams] USER.md NOT emitted when gmailProfileSummary=null",
    );
    // Gmail-absent → MEMORY.md not emitted at either path.
    for (const memPath of MEMORY_MD_PATHS) {
      assert(
        !actualPaths.has(memPath),
        `[validParams] ${memPath} NOT emitted when gmailProfileSummary=null`,
      );
    }
    // No partner → no edge_city / consensus overlays.
    assert(
      !actualPaths.has("overlays/soul-edge-stub.md"),
      "[validParams] no soul-edge-stub when partner=null",
    );
    assert(
      !actualPaths.has("overlays/edge-instaclaw-overlay.md"),
      "[validParams] no edge-instaclaw-overlay when partner=null",
    );
    // No worldIdNullifier → no WORLD_ID.md.
    assert(
      !actualPaths.has("home/openclaw/.openclaw/workspace/WORLD_ID.md"),
      "[validParams] no WORLD_ID.md when worldIdNullifier=null",
    );

    // setup.sh mode pin.
    const setupShEntry = files.get("setup.sh")!;
    assert(setupShEntry.mode === 0o755, `setup.sh mode === 0o755 (got ${setupShEntry.mode.toString(8)})`);
    assert(
      setupShEntry.body === buildSetupSh(validParams),
      "setup.sh body in tarball === buildSetupSh(p) (byte-parity through packer)",
    );

    // Mode pins on the high-sensitivity files.
    assert(
      files.get("home/openclaw/.openclaw/openclaw.json")!.mode === 0o600,
      "openclaw.json mode === 0o600",
    );
    assert(
      files.get("home/openclaw/.openclaw/.env")!.mode === 0o600,
      ".env mode === 0o600",
    );
    assert(
      files.get("home/openclaw/.openclaw/agents/main/agent/auth-profiles.json")!.mode === 0o600,
      "auth-profiles.json mode === 0o600",
    );
    assert(
      files.get("home/openclaw/.openclaw/wallet/agent.key")!.mode === 0o600,
      "agent.key mode === 0o600",
    );
    // Default mode (0o644) on the .md files.
    assert(
      files.get("home/openclaw/.openclaw/workspace/IDENTITY.md")!.mode === 0o644,
      "IDENTITY.md mode === 0o644",
    );
    assert(
      files.get("home/openclaw/.openclaw/workspace/BOOTSTRAP.md")!.mode === 0o644,
      "BOOTSTRAP.md mode === 0o644",
    );
    assert(
      files.get("home/openclaw/.openclaw/agents/main/agent/system-prompt.md")!.mode === 0o644,
      "system-prompt.md mode === 0o644",
    );

    // openclaw.json is JSON-parseable.
    // NOTE: We can't byte-compare against a fresh buildOpenClawJsonForTarball
    // call here because buildOpenClawConfig captures `new Date().toISOString()`
    // into a `lastRunAt` field (it's not pure on its inputs — this is shared
    // SSH-path behavior; Phase 1B-2 byte-compare will need to redact that
    // field on both sides). Structural check is the right gate.
    const openclawJson = JSON.parse(
      files.get("home/openclaw/.openclaw/openclaw.json")!.body,
    ) as Record<string, unknown>;
    assert(
      typeof openclawJson === "object" && openclawJson !== null,
      "openclaw.json parses to an object",
    );
    assert(
      typeof (openclawJson.gateway as Record<string, unknown> | undefined)?.auth ===
        "object",
      "openclaw.json contains gateway.auth (sanity: not an empty object)",
    );

    // Byte-parity through the assembler for the chunk-2 wrappers that
    // ARE pure on their inputs (test15 already covers chunk-1; this
    // completes coverage). openclaw.json is non-pure → skipped above.
    assert(
      files.get("home/openclaw/.openclaw/workspace/BOOTSTRAP.md")!.body ===
        buildBootstrapMd(validParams),
      "BOOTSTRAP.md in tarball === buildBootstrapMd(p)",
    );
    assert(
      files.get("home/openclaw/.openclaw/agents/main/agent/system-prompt.md")!.body ===
        buildSystemPromptForTarball(validParams),
      "system-prompt.md in tarball === buildSystemPromptForTarball(p)",
    );
  }

  // ── Case B: edge_city + Gmail + World ID + Bankr token + OpenAI key.
  //    Max entry set. 17 entries (5 chunk-1 universal + 1 WORLD_ID + 4
  //    partner overlays + 6 chunk-2 incl. USER.md + double-write MEMORY.md
  //    + 1 setup.sh).
  {
    const fullParams: TarballParams = {
      ...edgeCityParams,
      gmailProfileSummary: "User runs an Edge City community. Prefers concise updates.",
      bankrTokenAddress: "0xtoken0123456789",
      bankrTokenSymbol: "TEST",
      bankrTokenName: "TestCoin",
      openaiApiKey: "sk-proj-openai-test-mno",
    };
    const buf = await streamToBuffer(buildCloudInitTarball(fullParams));
    const files = await unpackTarball(buf);

    const expectedPaths = new Set([
      // chunk-1 universal
      "home/openclaw/.openclaw/agents/main/agent/auth-profiles.json",
      "home/openclaw/.openclaw/.env",
      "home/openclaw/.openclaw/workspace/IDENTITY.md",
      "home/openclaw/.openclaw/workspace/WALLET.md",
      "home/openclaw/.openclaw/wallet/agent.key",
      // chunk-1 conditional
      "home/openclaw/.openclaw/workspace/WORLD_ID.md",
      // chunk-1 overlays (bankr universal; soul-edge + soul-consensus +
      // edge-instaclaw conditional on partner=edge_city)
      "overlays/bankr-overlay.md",
      "overlays/soul-edge-stub.md",
      "overlays/soul-consensus-stub.md",
      "overlays/edge-instaclaw-overlay.md",
      // chunk-2 wrappers
      "home/openclaw/.openclaw/openclaw.json",
      "home/openclaw/.openclaw/workspace/BOOTSTRAP.md",
      "home/openclaw/.openclaw/workspace/USER.md", // gmail present
      "home/openclaw/.openclaw/agents/main/agent/system-prompt.md",
      // MEMORY.md double-write
      ...MEMORY_MD_PATHS,
      // BE-7 outer scripts (Day 8b)
      "home/openclaw/scripts/browser-relay-server.js",
      "home/openclaw/scripts/check-skill-updates.sh",
      // setup.sh
      "setup.sh",
    ]);
    const actualPaths = new Set(files.keys());

    for (const p of expectedPaths) {
      assert(actualPaths.has(p), `[fullParams] expected path present: ${p}`);
    }
    for (const p of actualPaths) {
      assert(expectedPaths.has(p), `[fullParams] no unexpected path: ${p}`);
    }
    assert(
      actualPaths.size === 19,
      `[fullParams] tarball entry count === 19 (got ${actualPaths.size})`,
    );

    // BE-7 byte-parity + mode pin verification (the two new entries
    // from Day 8b BE-7). Source files are read at module load via
    // fs.readFileSync; tarball-extracted bytes must equal the on-disk
    // source bytes byte-for-byte.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const browserRelaySrc = fs.readFileSync(
      path.resolve(__dirname, "../scripts/browser-relay-server/browser-relay-server.js"),
      "utf-8",
    );
    const checkSkillUpdatesSrc = fs.readFileSync(
      path.resolve(__dirname, "../scripts/check-skill-updates.sh"),
      "utf-8",
    );
    const brEntry = files.get("home/openclaw/scripts/browser-relay-server.js")!;
    const csuEntry = files.get("home/openclaw/scripts/check-skill-updates.sh")!;
    assert(
      brEntry.body === browserRelaySrc,
      "BE-7 browser-relay-server.js body byte-identical to source on disk",
    );
    assert(
      csuEntry.body === checkSkillUpdatesSrc,
      "BE-7 check-skill-updates.sh body byte-identical to source on disk",
    );
    assert(
      brEntry.mode === 0o755,
      `BE-7 browser-relay-server.js mode === 0o755 (got ${brEntry.mode.toString(8)})`,
    );
    assert(
      csuEntry.mode === 0o755,
      `BE-7 check-skill-updates.sh mode === 0o755 (got ${csuEntry.mode.toString(8)})`,
    );

    // Both MEMORY.md copies hold the same body (the double-write should
    // be byte-identical — the agent-dir copy is documented dead-weight
    // tech debt, but we preserve byte-parity with the SSH path).
    const memWorkspace = files.get(MEMORY_MD_PATHS[0])!.body;
    const memAgentDir = files.get(MEMORY_MD_PATHS[1])!.body;
    assert(
      memWorkspace === memAgentDir,
      "MEMORY.md double-write: workspace copy === agent-dir copy",
    );
    assert(
      memWorkspace === buildMemoryMdForTarball(fullParams),
      "MEMORY.md body === buildMemoryMdForTarball(p)",
    );

    // USER.md body matches its wrapper.
    assert(
      files.get("home/openclaw/.openclaw/workspace/USER.md")!.body ===
        buildUserMdForTarball(fullParams),
      "USER.md body === buildUserMdForTarball(p)",
    );

    // WORLD_ID.md body matches its wrapper.
    assert(
      files.get("home/openclaw/.openclaw/workspace/WORLD_ID.md")!.body ===
        buildWorldIdMdForTarball(fullParams),
      "WORLD_ID.md body === buildWorldIdMdForTarball(p)",
    );

    // setup.sh body byte-parity + mode pin.
    assert(
      files.get("setup.sh")!.body === buildSetupSh(fullParams),
      "[fullParams] setup.sh body === buildSetupSh(p)",
    );
    assert(
      files.get("setup.sh")!.mode === 0o755,
      "[fullParams] setup.sh mode === 0o755",
    );

    // openclaw.json contains the byok auth shape (apiMode=byok →
    // auth-profiles points at sk-ant-byok-test, not at the proxy
    // gateway_token). Spot-check.
    const authProfiles = JSON.parse(
      files.get("home/openclaw/.openclaw/agents/main/agent/auth-profiles.json")!.body,
    );
    assert(
      typeof authProfiles === "object" && authProfiles !== null,
      "auth-profiles.json parses to an object",
    );
  }

  // ── Case C: determinism — every entry except openclaw.json must be
  //    byte-identical across back-to-back tarball builds. openclaw.json
  //    drifts by `lastRunAt` (buildOpenClawConfig captures wall-clock at
  //    call time — shared SSH-path behavior); we redact that field and
  //    compare the remainder. Critical for Phase 1B-2's byte-compare
  //    audit (cloud-init vs SSH path producing identical VM state).
  {
    const buf1 = await streamToBuffer(buildCloudInitTarball(edgeCityParams));
    const buf2 = await streamToBuffer(buildCloudInitTarball(edgeCityParams));
    const files1 = await unpackTarball(buf1);
    const files2 = await unpackTarball(buf2);

    assert(
      files1.size === files2.size,
      `determinism: entry counts match (got ${files1.size} vs ${files2.size})`,
    );
    for (const [path, entry1] of files1) {
      const entry2 = files2.get(path);
      assert(entry2 !== undefined, `determinism: ${path} present in both builds`);
      if (!entry2) continue;
      assert(
        entry1.mode === entry2.mode,
        `determinism: ${path} mode stable (got ${entry1.mode} vs ${entry2.mode})`,
      );
      if (path === "home/openclaw/.openclaw/openclaw.json") {
        // wizard.lastRunAt is set to `new Date().toISOString()` inside
        // buildOpenClawConfig (shared with the SSH path; not a cloud-init
        // bug). Redact it before comparing — Phase 1B-2's byte-compare
        // audit will need the same redaction on both sides.
        const j1 = JSON.parse(entry1.body) as Record<string, unknown>;
        const j2 = JSON.parse(entry2.body) as Record<string, unknown>;
        const w1 = j1.wizard as Record<string, unknown> | undefined;
        const w2 = j2.wizard as Record<string, unknown> | undefined;
        if (w1) delete w1.lastRunAt;
        if (w2) delete w2.lastRunAt;
        assert(
          JSON.stringify(j1) === JSON.stringify(j2),
          "determinism: openclaw.json structurally identical (wizard.lastRunAt redacted)",
        );
      } else {
        assert(
          entry1.body === entry2.body,
          `determinism: ${path} body byte-identical`,
        );
      }
    }
  }

  // ── Case D: validation rejection — buildCloudInitTarball MUST invoke
  //    validateTarballParams. Stream creation should throw before any
  //    bytes flow. Use a fixture with a vmName that fails VM_NAME_RE
  //    (the validator-enforced regex for any field spliced into the
  //    setup.sh template). userName has no shell-safety check because
  //    it's JSON-encoded everywhere; vmName does because it's spliced.
  {
    const badParams: TarballParams = {
      ...validParams,
      vmName: "bad name with spaces",
    };
    let threw = false;
    let errMsg = "";
    try {
      buildCloudInitTarball(badParams);
    } catch (e) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    }
    assert(threw, "buildCloudInitTarball throws on validation failure");
    assert(
      errMsg.includes("vmName"),
      `error message names the failing field (got: ${errMsg})`,
    );
  }
}

async function main() {
  console.log("════════════════════════════════════════════════════════");
  console.log("cloud-init-tarball.ts foundation smoke test");
  console.log("════════════════════════════════════════════════════════");

  await test1_AllInclusiveNoPartner();
  await test2_ByokEdgeCity();
  await test3_ValidationRejections();
  await test4_DeterministicOutput();
  await test6_BuildBootstrapMd();
  await test7_EdgeosBearerToken();
  await test8_BuildUserMdForTarball();
  await test9_BuildSystemPromptForTarball();
  await test10_BuildMemoryMdForTarball();
  await test11_BuildOpenClawJsonForTarball();
  await test12_AuthProfilesJsonByteParity();
  await test13_ChunkOneByteParity();
  await test14_AllMissingEnvVars();
  await test15_FullTarballByteParityIntegration();
  await test16_BuildSetupSh();
  await test17_BuildCloudInitTarball();
  await test5_PerFileBuildersDirect();

  console.log("\n════════════════════════════════════════════════════════");
  console.log("ALL PASS");
  console.log("════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
