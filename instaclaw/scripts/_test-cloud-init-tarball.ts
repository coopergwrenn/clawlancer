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
  buildAgentKey,
  buildAuthProfilesJson,
  buildBootstrapMd,
  buildDotEnv,
  buildIdentityMd,
  buildWalletMd,
  buildWorldIdMd,
  collectPartialEntries,
  packPartialTarball,
  validateTarballParams,
  type TarballParams,
} from "../lib/cloud-init-tarball";
import { WORKSPACE_BOOTSTRAP_SHORT, buildPersonalizedBootstrap } from "../lib/ssh";

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

  // IDENTITY.md content
  const id = files.get("home/openclaw/.openclaw/workspace/IDENTITY.md")!.body;
  assert(id.includes(`@${validParams.telegramBotUsername}`), "IDENTITY.md mentions bot username");
  assert(id.includes("<!-- INSTACLAW_IDENTITY_V1 -->"), "IDENTITY.md carries sentinel");

  // WALLET.md content
  const wallet = files.get("home/openclaw/.openclaw/workspace/WALLET.md")!.body;
  assert(wallet.includes(validParams.agentbookAddress), "WALLET.md has agentbook address");
  assert(wallet.includes(validParams.bankrEvmAddress!), "WALLET.md has bankr EVM address");
  assert(wallet.includes("<!-- INSTACLAW_WALLET_V1 -->"), "WALLET.md carries sentinel");

  // agent.key
  const key = files.get("home/openclaw/.openclaw/wallet/agent.key")!.body;
  assert(key.includes("BEGIN EC PRIVATE KEY"), "agent.key contains private-key body");
  assert(key.endsWith("\n"), "agent.key ends with newline (canonical)");
}

async function test2_ByokEdgeCity() {
  console.log("\n─── TEST 2: byok + edge_city + worldId ─────────────");
  const buf = await streamToBuffer(packPartialTarball(edgeCityParams));
  const files = await unpackTarball(buf);

  // WORLD_ID.md should appear now
  assert(files.has("home/openclaw/.openclaw/workspace/WORLD_ID.md"), "WORLD_ID.md present");
  const worldId = files.get("home/openclaw/.openclaw/workspace/WORLD_ID.md")!.body;
  assert(worldId.includes(edgeCityParams.worldIdNullifier!), "WORLD_ID.md has nullifier");
  assert(worldId.includes("<!-- INSTACLAW_WORLD_ID_V1 -->"), "WORLD_ID.md carries sentinel");

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
  assert(buildIdentityMd(validParams).includes("@fucking1999_bot"), "buildIdentityMd substitutes username");
  assert(buildWalletMd(validParams).includes("0x5Bc5"), "buildWalletMd includes agentbook address");
  assert(buildWorldIdMd(validParams) === null, "buildWorldIdMd returns null without nullifier");
  assert(buildWorldIdMd(edgeCityParams) !== null, "buildWorldIdMd returns content with nullifier");
  assert(buildDotEnv(validParams).includes("INSTACLAW_ENV_V1"), "buildDotEnv has sentinel");
  assert(JSON.parse(buildAuthProfilesJson(validParams)).profiles, "buildAuthProfilesJson is valid JSON");
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
  await test5_PerFileBuildersDirect();

  console.log("\n════════════════════════════════════════════════════════");
  console.log("ALL PASS");
  console.log("════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
