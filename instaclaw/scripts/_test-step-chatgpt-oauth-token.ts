#!/usr/bin/env tsx
/**
 * Tests for stepChatGPTOAuthToken — Day 11-15 reconciler loop-closer.
 *
 * Mock supabase + mock SSH connection. Exercises the 6 main paths:
 *
 *   1. Never-connected user, already synced       → alreadyCorrect (no SSH)
 *   2. Disconnected user (NULL tokens), unsynced  → SSH remove + DB bump
 *   3. Expired access_token                       → warning, no push
 *   4. Active token, drift detected               → SSH write + verify + DB bump
 *   5. Active token, on-disk already matches      → no SSH write, DB bump
 *   6. Decrypt failure                            → result.errors
 *
 * Strategy: import stepChatGPTOAuthToken indirectly by importing the entire
 * lib/vm-reconcile module is overkill (file is huge). Instead, replicate
 * the step's contract through a thin re-export at the bottom of the test
 * file — actually no, the cleanest path is to test through the actual
 * module. We use the __setSupabaseForTests escape hatch and a mock SSH
 * object that records every execCommand call.
 *
 * Run: npx tsx instaclaw/scripts/_test-step-chatgpt-oauth-token.ts
 */

// Set encryption env BEFORE any module loads
const TEST_KEY = "a".repeat(64);
process.env.OPENAI_OAUTH_KEY_CURRENT = "v1";
process.env.OPENAI_OAUTH_KEY_V1 = TEST_KEY;

import { encryptSecret } from "../lib/openai-oauth-encryption";
import { __setSupabaseForTests } from "../lib/supabase";

// ─── Test harness ────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

// ─── Mock SSH ────────────────────────────────────────────────────────────

interface MockSshCall {
  command: string;
  result: { code: number; stdout: string; stderr: string };
}

interface MockSshOpts {
  /** Predefined responses keyed by substring match against the command. */
  responses?: Array<{ match: RegExp; result: { code: number; stdout: string; stderr?: string } }>;
  /** Default response when no match — defaults to code 0, empty stdout. */
  default?: { code: number; stdout: string; stderr?: string };
}

function makeMockSsh(opts: MockSshOpts = {}) {
  const calls: MockSshCall[] = [];
  const ssh = {
    async execCommand(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
      for (const r of opts.responses ?? []) {
        if (r.match.test(cmd)) {
          const result = { code: r.result.code, stdout: r.result.stdout, stderr: r.result.stderr ?? "" };
          calls.push({ command: cmd, result });
          return result;
        }
      }
      const def = opts.default ?? { code: 0, stdout: "", stderr: "" };
      const result = { code: def.code, stdout: def.stdout, stderr: def.stderr ?? "" };
      calls.push({ command: cmd, result });
      return result;
    },
    async putFile(): Promise<void> {
      /* unused by this step */
    },
  };
  return { ssh, calls };
}

// ─── Mock Supabase ───────────────────────────────────────────────────────

interface MockUser {
  id: string;
  openai_token_version?: number;
  openai_oauth_access_token?: string | null;
  openai_oauth_expires_at?: string | null;
  openai_oauth_account_id?: string | null;
}

interface MockSbOpts {
  user?: MockUser | null;
  userReadError?: { message: string };
  vmUpdateError?: { message: string };
}

function makeMockSupabase(opts: MockSbOpts) {
  const vmUpdates: Array<Record<string, unknown>> = [];
  const sb = {
    from(table: string) {
      let method: "select" | "update" = "select";
      let pendingUpdatePayload: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {
        select() {
          method = "select";
          return builder;
        },
        update(payload: Record<string, unknown>) {
          method = "update";
          pendingUpdatePayload = payload;
          if (table === "instaclaw_vms") {
            vmUpdates.push(payload);
          }
          return builder;
        },
        eq() {
          return builder;
        },
        async single() {
          if (table === "instaclaw_users" && method === "select") {
            if (opts.userReadError) return { data: null, error: opts.userReadError };
            return { data: opts.user ?? null, error: opts.user ? null : { message: "no rows" } };
          }
          return { data: null, error: null };
        },
        // PostgREST update without `.select()` resolves via .then on the eq chain.
        then(resolve: (v: unknown) => void) {
          if (table === "instaclaw_vms" && method === "update") {
            if (opts.vmUpdateError) {
              return Promise.resolve({ data: null, error: opts.vmUpdateError }).then(resolve);
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  // The "as unknown as" cast is intentional — we're injecting a minimal mock,
  // not implementing the full SupabaseClient interface.
  __setSupabaseForTests(sb as unknown as Parameters<typeof __setSupabaseForTests>[0]);
  return { vmUpdates };
}

// ─── Step access ─────────────────────────────────────────────────────────

// The step is NOT exported from lib/vm-reconcile.ts (it's an internal
// helper of reconcileVM). We can't import it directly. Workaround: import
// it via a tiny re-export shim. For Phase 1 test coverage of just this
// step, we instead test it through the public reconcileVM entry — too
// heavy. Cleaner path: temporarily export the step from the module.
//
// Pragmatic decision for this commit: re-implement the test through the
// reconciler's internal step list isn't feasible without restructuring.
// We add a TEST-ONLY re-export at the bottom of lib/vm-reconcile.ts so
// scripts/_test-*.ts can import it. Production code never imports from
// this entry; only tests use it.
import { __testOnly_stepChatGPTOAuthToken } from "../lib/vm-reconcile";

interface VMFixture {
  id: string;
  assigned_to: string | null;
  openai_token_version_synced?: number | null;
  default_model?: string | null;
  gateway_token?: string;
}

function makeResult() {
  return {
    fixed: [] as string[],
    alreadyCorrect: [] as string[],
    errors: [] as string[],
    warnings: [] as string[],
    gatewayRestartNeeded: false,
    gatewayRestarted: false,
    gatewayHealthy: true,
    strictErrors: [] as string[],
    canaryHealthy: null,
    canarySkippedBudget: false,
    envPushSucceeded: true,
  };
}

const USER_ID = "user-00000000-0000-0000-0000-000000000001";

// ─── Tests ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== stepChatGPTOAuthToken test suite ===\n");

  // ─── Test 1: never-connected user, already synced → skip ──────────────
  console.log("1. Never-connected user, already synced:");
  {
    const { ssh, calls } = makeMockSsh();
    makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 0,
        openai_oauth_access_token: null,
      },
    });
    const vm: VMFixture = {
      id: "vm-1",
      assigned_to: USER_ID,
      openai_token_version_synced: 0,
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);
    assert(result.errors.length === 0, "no errors");
    assert(calls.length === 0, "no SSH calls (cheap-path skip)");
    assert(
      result.alreadyCorrect.some((s) => s.includes("never-connected")),
      "marked alreadyCorrect with never-connected note",
    );
  }

  // ─── Test 2: disconnected user, unsynced → SSH remove + DB bump ───────
  console.log("\n2. Disconnected user (NULL tokens), unsynced:");
  {
    // VM had openai-codex on disk; user.openai_oauth_access_token is NULL;
    // user_version > synced_version → disconnect path fires.
    const onDiskJson = JSON.stringify({
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-anthropic" },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "stale-token",
          expires: Date.now() + 1000 * 60 * 60,
          accountId: "acct_x",
        },
      },
    });
    const { ssh, calls } = makeMockSsh({
      responses: [
        { match: /cat ~\/\.openclaw\/agents\/main\/agent\/auth-profiles\.json/, result: { code: 0, stdout: onDiskJson } },
        { match: /python3.*model.*primary/, result: { code: 0, stdout: "openai-codex/gpt-5.5\n" } },
      ],
    });
    const { vmUpdates } = makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 7,
        openai_oauth_access_token: null,
      },
    });
    const vm: VMFixture = {
      id: "vm-2",
      assigned_to: USER_ID,
      openai_token_version_synced: 6,
      default_model: "claude-sonnet-4-6", // disconnectUser already set this
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);

    assert(result.errors.length === 0, "no errors on disconnect");
    const removedWrite = calls.find(
      (c) =>
        c.command.includes("base64 -d") &&
        c.command.includes("auth-profiles.json.tmp") &&
        c.command.includes("mv"),
    );
    assert(!!removedWrite, "atomic write to remove openai-codex entry");
    const wroteCorrectJson = removedWrite
      ? Buffer.from(
          removedWrite.command.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] ?? "",
          "base64",
        ).toString("utf-8")
      : "";
    assert(
      !wroteCorrectJson.includes("openai-codex:default"),
      "post-disconnect JSON has NO openai-codex entry",
    );
    assert(
      wroteCorrectJson.includes("anthropic:default"),
      "post-disconnect JSON PRESERVES anthropic:default",
    );
    const setModelCall = calls.find((c) =>
      c.command.includes("openclaw config set agents.defaults.model.primary"),
    );
    assert(!!setModelCall, "model.primary reset call fired");
    assert(
      !!setModelCall && setModelCall.command.includes("anthropic/claude-sonnet-4-6"),
      "model.primary reset to anthropic/claude-sonnet-4-6",
    );
    assert(vmUpdates.length >= 1, "vm row update fired");
    assert(
      vmUpdates.some((u) => u.openai_token_version_synced === 7),
      "openai_token_version_synced bumped to 7",
    );
  }

  // ─── Test 3: expired token → warning, no push ─────────────────────────
  console.log("\n3. Expired access_token:");
  {
    const expiredAccess = encryptSecret("expired-jwt-bytes", USER_ID);
    const { ssh, calls } = makeMockSsh();
    makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 3,
        openai_oauth_access_token: expiredAccess,
        // Expired 1 hour ago
        openai_oauth_expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    });
    const vm: VMFixture = {
      id: "vm-3",
      assigned_to: USER_ID,
      openai_token_version_synced: 0,
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);
    assert(
      result.warnings.some((w) => w.includes("expired")),
      "warning about expired token",
    );
    assert(result.errors.length === 0, "no errors on expired");
    assert(calls.length === 0, "no SSH writes for expired token");
    assert(result.fixed.length === 0, "no fixes claimed");
  }

  // ─── Test 4: active token, drift → write + verify + DB bump ────────────
  console.log("\n4. Active token, drift detected:");
  {
    const REAL_TOKEN = "eyJ.access.JWT.bytes.test4";
    const encryptedToken = encryptSecret(REAL_TOKEN, USER_ID);
    const expiresAtIso = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();
    const expectedExpiresMs = new Date(expiresAtIso).getTime();
    // On-disk has anthropic only — no openai-codex entry, so drift.
    const onDiskJson = JSON.stringify({
      profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-x" } },
    });
    const { ssh, calls } = makeMockSsh({
      // Order matters: most-specific first. Verify-after-write reads via
      // `cat ... | python3 ... openai-codex:default ... access ... [:16]
      // ... expires` — needs to match BEFORE the generic cat-auth-profiles
      // read. Stdout shape: `TOKEN_PREFIX|EXPIRES_MS` (load-bearing for
      // the verify check that catches future shape regressions).
      responses: [
        // model.primary read (most specific python3 pipeline)
        { match: /python3.*model.*primary/, result: { code: 0, stdout: "anthropic/claude-sonnet-4-6\n" } },
        // verify-after-write: returns "PREFIX|EXPIRES_MS"
        {
          match: /python3.*openai-codex:default.*access/,
          result: { code: 0, stdout: REAL_TOKEN.slice(0, 16) + "|" + expectedExpiresMs + "\n" },
        },
        // initial read of existing file
        { match: /cat ~\/\.openclaw\/agents\/main\/agent\/auth-profiles\.json/, result: { code: 0, stdout: onDiskJson } },
      ],
      default: { code: 0, stdout: "" },
    });
    const { vmUpdates } = makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 5,
        openai_oauth_access_token: encryptedToken,
        openai_oauth_expires_at: expiresAtIso,
        openai_oauth_account_id: "acct_abc",
      },
    });
    const vm: VMFixture = {
      id: "vm-4",
      assigned_to: USER_ID,
      openai_token_version_synced: 0,
      default_model: "claude-sonnet-4-6",
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);

    assert(result.errors.length === 0, "no errors on drift-push");
    const profileWrite = calls.find(
      (c) =>
        c.command.includes("base64 -d > ~/.openclaw/agents/main/agent/auth-profiles.json.tmp") &&
        c.command.includes("mv"),
    );
    assert(!!profileWrite, "atomic profile write fired");
    const writtenJson = profileWrite
      ? Buffer.from(
          profileWrite.command.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] ?? "",
          "base64",
        ).toString("utf-8")
      : "";
    const parsed = JSON.parse(writtenJson) as {
      profiles: {
        "openai-codex:default"?: {
          type?: string;
          provider?: string;
          access?: string;
          expires?: number;
          accountId?: string;
          // Old shape fields MUST NOT appear — load-bearing regression check.
          key?: string;
          metadata?: { accountId?: string };
        };
      };
    };
    const written = parsed.profiles["openai-codex:default"];
    assert(written?.type === "oauth", "written profile.type === oauth");
    assert(written?.provider === "openai-codex", "written profile.provider === openai-codex");
    assert(written?.access === REAL_TOKEN, "written profile has decrypted token in .access (NOT .key)");
    assert(written?.expires === expectedExpiresMs, `written profile has .expires as numeric ms (got ${written?.expires})`);
    assert(written?.accountId === "acct_abc", "written profile has top-level .accountId (NOT under .metadata)");
    // Regression guards — pi-ai silently rejects the legacy shape.
    assert(written?.key === undefined, "written profile has NO .key field (legacy shape)");
    assert(written?.metadata === undefined, "written profile has NO .metadata field (legacy shape)");
    assert(
      "anthropic:default" in parsed.profiles,
      "anthropic:default preserved alongside new openai-codex",
    );
    const setModelCall = calls.find((c) =>
      c.command.includes("openclaw config set agents.defaults.model.primary 'openai-codex/gpt-5.5'"),
    );
    assert(!!setModelCall, "model.primary set to openai-codex/gpt-5.5");
    assert(result.gatewayRestartNeeded === true, "gatewayRestartNeeded marked");
    assert(
      vmUpdates.some(
        (u) =>
          u.api_mode === "chatgpt_oauth" &&
          u.default_model === "openai-codex/gpt-5.5" &&
          u.openai_token_version_synced === 5,
      ),
      "vm row updated with api_mode + default_model + synced version",
    );
  }

  // ─── Test 5: active token, on-disk matches → no SSH write ─────────────
  console.log("\n5. Active token, on-disk already matches:");
  {
    const REAL_TOKEN = "eyJ.matching.JWT";
    const encryptedToken = encryptSecret(REAL_TOKEN, USER_ID);
    const expiresAtIso = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();
    const matchingExpiresMs = new Date(expiresAtIso).getTime();
    const onDiskJson = JSON.stringify({
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-x" },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: REAL_TOKEN,
          expires: matchingExpiresMs,
          accountId: "acct_match",
        },
      },
    });
    const { ssh, calls } = makeMockSsh({
      responses: [
        { match: /cat ~\/\.openclaw\/agents\/main\/agent\/auth-profiles\.json/, result: { code: 0, stdout: onDiskJson } },
        { match: /python3.*model.*primary/, result: { code: 0, stdout: "openai-codex/gpt-5.5\n" } },
      ],
    });
    const { vmUpdates } = makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 9,
        openai_oauth_access_token: encryptedToken,
        openai_oauth_expires_at: expiresAtIso,
        openai_oauth_account_id: "acct_match",
      },
    });
    const vm: VMFixture = {
      id: "vm-5",
      assigned_to: USER_ID,
      openai_token_version_synced: 3,
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);

    assert(result.errors.length === 0, "no errors when on-disk matches");
    const profileWrite = calls.find((c) =>
      c.command.includes("auth-profiles.json.tmp"),
    );
    assert(!profileWrite, "NO atomic profile write (on-disk matched)");
    const modelSet = calls.find((c) =>
      c.command.includes("openclaw config set agents.defaults.model.primary"),
    );
    assert(!modelSet, "NO model.primary set (already correct)");
    assert(
      vmUpdates.some((u) => u.openai_token_version_synced === 9),
      "synced version bumped to 9 (DB-only update)",
    );
    assert(
      result.alreadyCorrect.some((s) => s.includes("in-sync")),
      "alreadyCorrect notes in-sync state",
    );
  }

  // ─── Test 6: decrypt failure → errors ─────────────────────────────────
  console.log("\n6. Decrypt failure:");
  {
    // Encrypt with USER_ID, but VM has assigned_to = DIFFERENT user → AAD
    // mismatch → DecryptError.
    const encryptedToken = encryptSecret("some-token", USER_ID);
    const { ssh } = makeMockSsh();
    makeMockSupabase({
      user: {
        id: "user-different-yyy",
        openai_token_version: 2,
        openai_oauth_access_token: encryptedToken,
        openai_oauth_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    const vm: VMFixture = {
      id: "vm-6",
      assigned_to: "user-different-yyy",
      openai_token_version_synced: 0,
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);
    assert(
      result.errors.some((e) => e.includes("decrypt failed")),
      "decrypt failure surfaced as error",
    );
    assert(
      result.errors.some((e) => e.includes("DecryptError")),
      "error message names DecryptError class",
    );
  }

  // ─── Test 7: VM with no assigned_to → no-op ───────────────────────────
  console.log("\n7. VM with no assigned_to:");
  {
    const { ssh, calls } = makeMockSsh();
    makeMockSupabase({});
    const vm: VMFixture = { id: "vm-7", assigned_to: null };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);
    assert(result.errors.length === 0, "no errors");
    assert(result.warnings.length === 0, "no warnings");
    assert(calls.length === 0, "no SSH calls");
    assert(result.fixed.length === 0, "no fixes");
  }

  // ─── Test 8: User lookup fails (transient) → warning ──────────────────
  console.log("\n8. User lookup transient failure:");
  {
    const { ssh, calls } = makeMockSsh();
    makeMockSupabase({
      userReadError: { message: "connection reset by peer" },
    });
    const vm: VMFixture = { id: "vm-8", assigned_to: USER_ID };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);
    assert(
      result.warnings.some((w) => w.includes("user lookup failed")),
      "user-lookup failure surfaces as warning",
    );
    assert(result.errors.length === 0, "no errors (just warning)");
    assert(calls.length === 0, "no SSH calls");
  }

  // ─── Test 9: dryRun mode → no SSH writes, no DB writes ────────────────
  console.log("\n9. Dry-run mode for drift case:");
  {
    const REAL_TOKEN = "eyJ.dryrun.token";
    const encryptedToken = encryptSecret(REAL_TOKEN, USER_ID);
    const onDiskJson = JSON.stringify({
      profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-x" } },
    });
    const { ssh, calls } = makeMockSsh({
      responses: [
        { match: /cat ~\/\.openclaw\/agents\/main\/agent\/auth-profiles\.json/, result: { code: 0, stdout: onDiskJson } },
      ],
    });
    const { vmUpdates } = makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 1,
        openai_oauth_access_token: encryptedToken,
        openai_oauth_expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
        openai_oauth_account_id: "acct_dry",
      },
    });
    const vm: VMFixture = {
      id: "vm-9",
      assigned_to: USER_ID,
      openai_token_version_synced: 0,
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, true);
    assert(
      result.fixed.some((f) => f.includes("[dry-run]")),
      "dry-run marker in fixed list",
    );
    const writeCall = calls.find((c) => c.command.includes("auth-profiles.json.tmp"));
    assert(!writeCall, "NO actual auth-profiles.json write in dry-run");
    assert(vmUpdates.length === 0, "NO DB updates in dry-run");
  }

  // ─── Test 10: NULL expires_at + non-JWT token → error, refuse to push ──
  // BEHAVIOR CHANGED 2026-05-20: pi-ai's hasUsableOAuthCredential REQUIRES
  // a numeric `expires` field; without one, the profile is silently
  // rejected at runtime. So we MUST resolve an expiry before pushing.
  // The step now: (a) prefers DB ISO if present, (b) falls back to
  // decoding the access-token JWT's `exp` claim, (c) refuses to push and
  // pushes to result.errors if both fail. This test exercises path (c):
  // NULL expires_at + a non-JWT-shaped token → JWT decode fails → error.
  console.log("\n10. NULL expires_at + non-JWT token → error (refuse to push):");
  {
    // 3-part dotted token but middle part is not valid base64url JSON.
    const NON_JWT_TOKEN = "eyJ.null-expiry.JWT";
    const encryptedToken = encryptSecret(NON_JWT_TOKEN, USER_ID);
    const { ssh, calls } = makeMockSsh();
    const { vmUpdates } = makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 4,
        openai_oauth_access_token: encryptedToken,
        // expires_at omitted (NULL on instaclaw_users)
        openai_oauth_account_id: "acct_null_exp",
      },
    });
    const vm: VMFixture = {
      id: "vm-10",
      assigned_to: USER_ID,
      openai_token_version_synced: 0,
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);

    assert(
      result.errors.some((e) => e.includes("cannot determine token expiry")),
      "error surfaced — cannot determine expiry",
    );
    assert(
      result.errors.some((e) => e.includes("refusing to push")),
      "error message includes refuse-to-push posture",
    );
    assert(calls.length === 0, "NO SSH writes — error gates before applyConnectedState");
    assert(vmUpdates.length === 0, "NO DB updates on expiry-resolution failure");
  }

  // ─── Test 11: Empty decrypted token → result.errors ────────────────────
  // P2-A from the v110 audit. encryptSecret("") is valid; if a bug stored
  // empty plaintext somewhere upstream, the decrypt returns "" and we'd
  // push an empty bearer to the VM. Refuse the push, push error to gate
  // the cv bump.
  console.log("\n11. Empty decrypted token → error:");
  {
    const encryptedEmpty = encryptSecret("", USER_ID); // empty plaintext, valid encrypt
    const { ssh, calls } = makeMockSsh();
    makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 2,
        openai_oauth_access_token: encryptedEmpty,
        openai_oauth_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        openai_oauth_account_id: "acct_empty",
      },
    });
    const vm: VMFixture = {
      id: "vm-11",
      assigned_to: USER_ID,
      openai_token_version_synced: 0,
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);

    assert(
      result.errors.some((e) => e.includes("empty")),
      "empty decrypted token surfaced as error",
    );
    assert(
      result.errors.some((e) => e.includes("refusing to push")),
      "error message explains the refuse-to-push posture",
    );
    assert(calls.length === 0, "NO SSH writes for empty-token case (rejected before applyConnectedState)");
  }

  // ─── Test 12: vm.default_model with shell-meta chars → safe fallback ────
  // P1 from the v110 audit. If vm.default_model is set to an injection
  // string via DB compromise, the disconnect path calls toOpenClawModel.
  // The whitelist now rejects shell-meta chars and falls back to the
  // safe default. Verifies the injection vector is blocked at the
  // toOpenClawModel layer.
  console.log("\n12. Disconnect with attacker-controlled vm.default_model:");
  {
    const onDiskJson = JSON.stringify({
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-x" },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "stale",
          expires: Date.now() + 1000 * 60 * 60,
          accountId: "acct_x",
        },
      },
    });
    const { ssh, calls } = makeMockSsh({
      responses: [
        { match: /python3.*model.*primary/, result: { code: 0, stdout: "openai-codex/gpt-5.5\n" } },
        { match: /cat ~\/\.openclaw\/agents\/main\/agent\/auth-profiles\.json/, result: { code: 0, stdout: onDiskJson } },
      ],
    });
    makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 9,
        openai_oauth_access_token: null, // disconnected
      },
    });
    const vm: VMFixture = {
      id: "vm-12",
      assigned_to: USER_ID,
      openai_token_version_synced: 7,
      // Attacker-controlled value attempting shell injection via single quote
      default_model: "openai-codex/'; whoami #",
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);

    assert(result.errors.length === 0, "no errors — safe fallback used");
    // Verify the model set command uses the SAFE fallback, not the injection.
    const modelSetCall = calls.find((c) =>
      c.command.includes("openclaw config set agents.defaults.model.primary"),
    );
    assert(
      !!modelSetCall && modelSetCall.command.includes("anthropic/claude-sonnet-4-6"),
      "shell-meta in default_model falls back to anthropic/claude-sonnet-4-6 — injection blocked",
    );
    assert(
      !!modelSetCall && !modelSetCall.command.includes("whoami"),
      "injection payload NOT present in shell command",
    );
  }

  // ─── Test 13: token rotation (model.primary unchanged, profile changed) ──
  // Regression guard for the 2026-05-20 vm-780 incident: after the shape
  // fix, the reconciler pushed a correct-shape profile to disk but pi-ai's
  // gateway kept serving the OLD-shape profile from its in-memory cache
  // (captured at last startup). Root cause: the restart trigger was
  // conditional on model.primary changing; when only the profile content
  // changed (token rotation, shape fix, account swap), no restart fired.
  // Fix: any profile write MUST set gatewayRestartNeeded.
  console.log("\n13. Token rotation — model.primary unchanged, profile content changed:");
  {
    const NEW_TOKEN = "eyJ.rotated.token.v13";
    const encryptedToken = encryptSecret(NEW_TOKEN, USER_ID);
    const newExpiresIso = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString();
    const newExpiresMs = new Date(newExpiresIso).getTime();
    // On-disk has the OLD token + OLD expiry. Model.primary already
    // openai-codex/gpt-5.5 from a prior cycle (the normal steady state
    // for an already-connected user, before the refresh cron rotates).
    const oldExpiresMs = Date.now() + 1 * 24 * 60 * 60 * 1000;
    const onDiskJson = JSON.stringify({
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-x" },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "eyJ.OLD.token.v12",
          expires: oldExpiresMs,
          accountId: "acct_rot",
        },
      },
    });
    const { ssh, calls } = makeMockSsh({
      responses: [
        // model.primary read returns the ALREADY-correct value
        { match: /python3.*model.*primary/, result: { code: 0, stdout: "openai-codex/gpt-5.5\n" } },
        // verify-after-write — must return the NEW prefix + NEW expires
        {
          match: /python3.*openai-codex:default.*access/,
          result: { code: 0, stdout: NEW_TOKEN.slice(0, 16) + "|" + newExpiresMs + "\n" },
        },
        { match: /cat ~\/\.openclaw\/agents\/main\/agent\/auth-profiles\.json/, result: { code: 0, stdout: onDiskJson } },
      ],
      default: { code: 0, stdout: "" },
    });
    const { vmUpdates } = makeMockSupabase({
      user: {
        id: USER_ID,
        openai_token_version: 3,
        openai_oauth_access_token: encryptedToken,
        openai_oauth_expires_at: newExpiresIso,
        openai_oauth_account_id: "acct_rot",
      },
    });
    const vm: VMFixture = {
      id: "vm-13",
      assigned_to: USER_ID,
      openai_token_version_synced: 2,
      // VM already at openai-codex on the DB side too — only the profile
      // file content (token + expires) is what's stale relative to user.
      api_mode: "chatgpt_oauth",
      default_model: "openai-codex/gpt-5.5",
    };
    const result = makeResult();
    await __testOnly_stepChatGPTOAuthToken(ssh as never, vm as never, result as never, false);

    assert(result.errors.length === 0, "no errors on token rotation");
    const profileWrite = calls.find(
      (c) =>
        c.command.includes("base64 -d > ~/.openclaw/agents/main/agent/auth-profiles.json.tmp") &&
        c.command.includes("mv"),
    );
    assert(!!profileWrite, "profile rewritten with new token + expires");
    // The model.primary SET command MUST NOT fire (already correct).
    const modelSet = calls.find((c) =>
      c.command.includes("openclaw config set agents.defaults.model.primary"),
    );
    assert(!modelSet, "NO model.primary set call (already correct)");
    // CRITICAL: gateway restart MUST be flagged even though model.primary
    // didn't change. This is the exact regression guard for 2026-05-20.
    assert(
      result.gatewayRestartNeeded === true,
      "gatewayRestartNeeded === true even with model.primary unchanged (profile content rewrite must restart gateway)",
    );
    assert(
      vmUpdates.some((u) => u.openai_token_version_synced === 3),
      "synced version bumped to 3 (matches user.openai_token_version)",
    );
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n=== Results ===`);
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("UNCAUGHT:", err);
  process.exit(1);
});
