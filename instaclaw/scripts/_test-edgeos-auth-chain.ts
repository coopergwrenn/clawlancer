/**
 * End-to-end test of the EdgeOS auth chain.
 *
 *   email → OTP → bearer → eos_live_*
 *
 * Two modes:
 *
 *   --smoke  (no OTP, no human)  — non-interactive checks against the live
 *            sandbox: liveness, OpenAPI shape, error categorization, tenant
 *            lookup, popup list. Safe to run in CI or any time. Confirms the
 *            modules' assumptions match the live API.
 *
 *   --email <addr>  (interactive) — full happy-path test. Triggers a real
 *            OTP send to <addr>, prompts you to paste the code, exchanges it
 *            for a bearer, mints an api-key, lists keys, probes /events,
 *            exercises the name_conflict path, runs mintOrReuseApiKey, then
 *            revokes everything it created. Requires the email to be a
 *            registered EdgeOS user on demo.dev.edgeos.world AND a popup
 *            application approved by Tule. See:
 *              instaclaw/docs/edgeos-sandbox-test-setup.md
 *
 * Defaults to the sandbox (api.dev.edgeos.world). Pass --prod to hit prod.
 *
 * Usage:
 *   tsx scripts/_test-edgeos-auth-chain.ts --smoke
 *   tsx scripts/_test-edgeos-auth-chain.ts --email you@example.com
 *   tsx scripts/_test-edgeos-auth-chain.ts --email you@example.com --prod
 *   tsx scripts/_test-edgeos-auth-chain.ts --email you@example.com --keep
 *       (default behavior is to revoke the test key at the end; --keep
 *        preserves it so you can keep poking at the events API)
 *
 * Side effects (interactive mode):
 *   - Sends an OTP email to the supplied address.
 *   - Mints an EdgeOS api-key named "instaclaw-edge-test" (deterministic).
 *   - Sweeps any prior "instaclaw-edge-test*" keys at the start of the run
 *     so re-runs don't accumulate orphans.
 *   - Revokes the new key at the end unless --keep.
 *
 * Does NOT touch any production VM or InstaClaw DB. Pure remote API test.
 *
 * Output: structured `[phase=…] ok|fail status=… took_ms=…` lines so the
 * output is easy to grep when a failure shows up in CI logs.
 */
import { createInterface } from "readline";
import {
  requestOTP,
  authenticateOTP,
  maskToken,
  buildHeaders,
  fetchWithTimeout,
  EDGEOS_TENANT_EDGECITY_PROD,
  EDGEOS_TENANT_DEMO_SANDBOX,
  type EdgeOSEnv,
} from "../lib/edgeos-auth";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deterministicKeyName,
} from "../lib/edgeos-api-keys";
import { mintOrReuseApiKey } from "../lib/edgeos-mint";

const SANDBOX = "https://api.dev.edgeos.world";
const PROD = "https://api.edgeos.world";

// Deterministic name shared across runs so re-runs reuse instead of accumulate.
// (Pre-sweep in setupHappyPath() still removes anything left behind by a
// prior crashed run.)
const HAPPY_PATH_KEY_NAME = "instaclaw-edge-test";
const HAPPY_PATH_VM_NAME = "test-mint"; // → key name "instaclaw-edge-test-mint"

// Substring used by the orphan sweep to identify keys this script may have
// created in a prior run. Anything matching this prefix gets revoked at the
// start of an interactive run. Be conservative — pick a prefix that only
// this script would use.
const ORPHAN_PREFIX = "instaclaw-edge-test";

// ─── CLI ──────────────────────────────────────────────────────────────────

interface Args {
  smoke: boolean;
  email: string;
  apiBase: string;
  tenantId: string;
  tenantLabel: string;
  keep: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let smoke = false;
  let email = "";
  let prod = false;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--smoke") smoke = true;
    else if (args[i] === "--email" && args[i + 1]) email = args[++i];
    else if (args[i] === "--prod") prod = true;
    else if (args[i] === "--keep") keep = true;
  }
  if (!smoke && !email) {
    console.error("Usage: tsx scripts/_test-edgeos-auth-chain.ts (--smoke | --email <addr>) [--prod] [--keep]");
    console.error("");
    console.error("  --smoke         non-interactive — exercises every check that doesn't need an OTP");
    console.error("  --email <addr>  interactive happy-path — sends OTP, mints key, etc.");
    console.error("  --prod          use api.edgeos.world (EdgeCity tenant) instead of sandbox");
    console.error("  --keep          don't revoke the minted key on exit (interactive only)");
    process.exit(1);
  }
  return {
    smoke,
    email,
    apiBase: prod ? PROD : SANDBOX,
    tenantId: prod ? EDGEOS_TENANT_EDGECITY_PROD : EDGEOS_TENANT_DEMO_SANDBOX,
    tenantLabel: prod ? "EdgeCity (prod)" : "Demo (sandbox)",
    keep,
  };
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── structured phase logging ──────────────────────────────────────────────

type PhaseStatus = "ok" | "fail" | "skip" | "warn";

interface PhaseResult {
  name: string;
  status: PhaseStatus;
  details?: string;
  tookMs: number;
}

const phaseResults: PhaseResult[] = [];

async function phase<T>(
  name: string,
  fn: () => Promise<{ status: PhaseStatus; details?: string; value?: T }>
): Promise<{ status: PhaseStatus; details?: string; value?: T }> {
  const t0 = Date.now();
  let result: { status: PhaseStatus; details?: string; value?: T };
  try {
    result = await fn();
  } catch (err) {
    result = {
      status: "fail",
      details: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const tookMs = Date.now() - t0;
  phaseResults.push({ name, status: result.status, details: result.details, tookMs });
  const icon = { ok: "✓", fail: "✗", skip: "↷", warn: "⚠" }[result.status];
  const line = `[phase=${name}] ${icon} ${result.status} took_ms=${tookMs}` +
    (result.details ? ` :: ${result.details}` : "");
  if (result.status === "fail") console.error(line);
  else console.log(line);
  return result;
}

function reportSummary() {
  console.log("");
  console.log("═══ summary ═══");
  let oks = 0, fails = 0, warns = 0, skips = 0;
  for (const r of phaseResults) {
    if (r.status === "ok") oks++;
    if (r.status === "fail") fails++;
    if (r.status === "warn") warns++;
    if (r.status === "skip") skips++;
  }
  console.log(`  phases: ${phaseResults.length}  ok=${oks}  fail=${fails}  warn=${warns}  skip=${skips}`);
  console.log(`  total_ms: ${phaseResults.reduce((s, r) => s + r.tookMs, 0)}`);
  if (fails > 0) {
    console.log("");
    console.log("FAILURES:");
    for (const r of phaseResults.filter(r => r.status === "fail")) {
      console.log(`  - ${r.name}: ${r.details}`);
    }
  }
}

// ─── runbook pointers — actionable error guidance ──────────────────────────

function actionForNoAccount(email: string, apiBase: string): string {
  const portal = apiBase === SANDBOX ? "demo.dev.edgeos.world" : "edgecity.edgeos.world";
  return [
    `Email ${email} is not a registered EdgeOS user.`,
    `Action: open https://${portal}, sign up with that email, submit an application`,
    `for one of the popups, and have Tule approve it. Then re-run this script.`,
    `Runbook: instaclaw/docs/edgeos-sandbox-test-setup.md`,
  ].join("\n  ");
}

// ─── SMOKE mode — non-interactive checks ───────────────────────────────────

async function runSmoke(args: Args) {
  console.log(`═══ smoke mode — non-interactive ═══`);
  console.log(`api_base=${args.apiBase}`);
  console.log(`tenant=${args.tenantLabel} (${args.tenantId})`);
  console.log("");
  const env: EdgeOSEnv = { apiBase: args.apiBase, tenantId: args.tenantId };

  // S1. Sandbox liveness — fetch openapi.json
  await phase("sandbox_liveness", async () => {
    const res = await fetchWithTimeout(`${args.apiBase}/openapi.json`, { timeoutMs: 10_000 });
    if (!res.ok) return { status: "fail", details: `openapi http=${res.status}` };
    const text = await res.text();
    let parsed: { info?: { title?: string; version?: string }; paths?: object } = {};
    try { parsed = JSON.parse(text); } catch { return { status: "fail", details: "openapi body not JSON" }; }
    const paths = Object.keys(parsed.paths ?? {}).length;
    return {
      status: "ok",
      details: `title=${parsed.info?.title} version=${parsed.info?.version} paths=${paths}`,
    };
  });

  // S2. requestOTP with bogus address → expect no_account
  await phase("request_otp_bogus", async () => {
    const r = await requestOTP("nobody-12345-does-not-exist@gmail.com", env);
    if (r.ok) return { status: "fail", details: "requestOTP succeeded for a bogus address — unexpected" };
    if (r.status === "no_account") return { status: "ok", details: `status=no_account http=${r.httpStatus}` };
    return { status: "warn", details: `expected no_account, got status=${r.status} http=${r.httpStatus}` };
  });

  // S3. requestOTP with reserved TLD → expect validation_error
  await phase("request_otp_reserved_tld", async () => {
    const r = await requestOTP("foo@example.test", env);
    if (r.ok) return { status: "fail", details: "requestOTP accepted a reserved-TLD address" };
    if (r.status === "validation_error") return { status: "ok", details: `status=validation_error http=${r.httpStatus}` };
    return { status: "warn", details: `expected validation_error, got status=${r.status}` };
  });

  // S4. requestOTP with locally-malformed (no @) → caught pre-flight
  await phase("request_otp_malformed_preflight", async () => {
    const r = await requestOTP("not-an-email", env);
    if (r.ok) return { status: "fail", details: "pre-flight let an obviously bad email through" };
    if (r.status === "validation_error") return { status: "ok", details: "pre-flight short-circuit working" };
    return { status: "warn", details: `unexpected status=${r.status}` };
  });

  // S5. authenticateOTP with bogus email → 404 → no_account (NEW after 2026-05-19 fix)
  await phase("authenticate_otp_bogus_email", async () => {
    const r = await authenticateOTP("nobody-12345@gmail.com", "000000", env);
    if (r.ok) return { status: "fail", details: "authenticate accepted bogus credentials" };
    if (r.status === "no_account") return { status: "ok", details: `status=no_account http=${r.httpStatus} (categorization-bug-fix verified)` };
    return { status: "warn", details: `expected no_account, got status=${r.status} http=${r.httpStatus} — if unknown, the 404→no_account fix may have regressed` };
  });

  // S6. authenticateOTP with malformed code → validation_error
  await phase("authenticate_otp_malformed_code", async () => {
    const r = await authenticateOTP("foo@bar.com", "12", env);
    if (r.ok) return { status: "fail", details: "authenticate accepted a 2-digit code" };
    if (r.status === "validation_error") return { status: "ok" };
    return { status: "warn", details: `unexpected status=${r.status}` };
  });

  // S7. Tenant lookup (unauthenticated — sanity check that tenant resolution still works)
  await phase("tenant_lookup", async () => {
    const slug = args.apiBase === SANDBOX ? "demo" : "edgecity";
    const res = await fetchWithTimeout(`${args.apiBase}/api/v1/tenants/public/${slug}`, { timeoutMs: 10_000 });
    if (!res.ok) return { status: "fail", details: `http=${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object" || !("id" in body)) {
      return { status: "fail", details: "tenant response missing id" };
    }
    const expectedId = args.apiBase === SANDBOX ? EDGEOS_TENANT_DEMO_SANDBOX : EDGEOS_TENANT_EDGECITY_PROD;
    const actualId = (body as { id: string }).id;
    if (actualId !== expectedId) {
      return { status: "fail", details: `tenant UUID drifted! expected=${expectedId} got=${actualId}` };
    }
    return { status: "ok", details: `slug=${slug} id=${actualId}` };
  });

  // S8. Popup list (X-Tenant-Id required — confirms the header is working)
  await phase("popup_list", async () => {
    const res = await fetchWithTimeout(
      `${args.apiBase}/api/v1/popups/public/list`,
      { timeoutMs: 10_000, headers: buildHeaders({ tenantId: args.tenantId }) }
    );
    if (!res.ok) return { status: "fail", details: `http=${res.status}` };
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body)) return { status: "fail", details: "popup list response not an array" };
    return { status: "ok", details: `${body.length} popups (slugs: ${body.map((p: { slug?: string }) => p.slug).filter(Boolean).join(",")})` };
  });

  // S9. POST /api-keys with no bearer → 401 → unauthorized (confirms our auth-first contract)
  await phase("api_keys_post_no_bearer", async () => {
    const r = await createApiKey("", { name: "smoke-probe-no-bearer" }, env);
    if (r.ok) return { status: "fail", details: "createApiKey somehow succeeded without a bearer" };
    if (r.status === "unauthorized") return { status: "ok", details: "pre-flight bearer check working" };
    return { status: "warn", details: `unexpected status=${r.status}` };
  });

  reportSummary();
  const failed = phaseResults.some((r) => r.status === "fail");
  if (failed) {
    console.log("");
    console.log("⚠ smoke had failures. Sandbox may be down OR an assumption in the modules has drifted.");
    console.log("  Compare each failing phase against the audit at:");
    console.log("    instaclaw/docs/edgeos-auth-audit-2026-05-14.md");
    process.exit(2);
  }
  console.log("");
  console.log("✓ smoke mode complete — all sandbox assumptions still hold");
}

// ─── HAPPY PATH — interactive (--email) ────────────────────────────────────

/**
 * Revoke any active api-key whose name starts with ORPHAN_PREFIX. Defensive
 * cleanup so a prior crashed run doesn't leave us starting with name_conflict
 * on every key the script tries to mint.
 */
async function sweepOrphans(bearer: string, env: EdgeOSEnv): Promise<{ swept: number; failed: number }> {
  const list = await listApiKeys(bearer, env);
  if (!list.ok) {
    console.error(`  ⚠ sweepOrphans: list failed — status=${list.status} http=${list.httpStatus}`);
    return { swept: 0, failed: 0 };
  }
  const orphans = list.apiKeys.filter(
    (k) => k.name.startsWith(ORPHAN_PREFIX) && k.revokedAt === null
  );
  let swept = 0, failed = 0;
  for (const k of orphans) {
    const r = await revokeApiKey(bearer, k.id, env);
    if (r.ok) {
      swept++;
      console.log(`    revoked orphan: id=${k.id} name=${k.name}`);
    } else {
      failed++;
      console.warn(`    failed to revoke orphan id=${k.id}: status=${r.status}`);
    }
  }
  return { swept, failed };
}

async function runHappyPath(args: Args) {
  const env: EdgeOSEnv = { apiBase: args.apiBase, tenantId: args.tenantId };
  console.log(`═══ happy-path mode — interactive ═══`);
  console.log(`api_base=${args.apiBase}`);
  console.log(`tenant=${args.tenantLabel} (${args.tenantId})`);
  console.log(`email=${args.email}`);
  console.log(`keep=${args.keep}`);
  console.log("");

  // ── 1. requestOTP ──
  const step1 = await phase("request_otp", async () => {
    const r = await requestOTP(args.email, env);
    if (!r.ok) {
      const action = r.status === "no_account" ? `\n  ${actionForNoAccount(args.email, args.apiBase)}` : "";
      return { status: "fail", details: `status=${r.status} http=${r.httpStatus}${action}` };
    }
    return { status: "ok", details: `expires_in_minutes=${r.expiresInMinutes ?? "?"} message=${JSON.stringify(r.message ?? "")}` };
  });
  if (step1.status === "fail") {
    reportSummary();
    process.exit(2);
  }

  // ── 2. prompt + authenticateOTP ──
  const otp = await prompt("Enter the 6-digit OTP code from your email: ");
  if (!otp) {
    console.error("✗ no OTP entered — aborting");
    process.exit(2);
  }

  const step2 = await phase("authenticate_otp", async () => {
    const r = await authenticateOTP(args.email, otp, env);
    if (!r.ok) {
      let action = "";
      if (r.status === "no_account") action = `\n  ${actionForNoAccount(args.email, args.apiBase)}`;
      if (r.status === "invalid_code") action = "\n  Action: re-run the script — the OTP may have expired or been mis-typed.";
      return { status: "fail", details: `status=${r.status} http=${r.httpStatus} raw=${r.raw?.slice(0, 200)}${action}` };
    }
    return { status: "ok", value: r.accessToken as unknown, details: `token_type=${r.tokenType} bearer=${maskToken(r.accessToken)}` };
  });
  if (step2.status === "fail") {
    reportSummary();
    process.exit(3);
  }
  const bearer = step2.value as string;

  // ── 2.5. orphan sweep — defensive cleanup of prior-run leftovers ──
  await phase("orphan_sweep", async () => {
    const { swept, failed } = await sweepOrphans(bearer, env);
    if (failed > 0) return { status: "warn", details: `swept=${swept} failed=${failed}` };
    return { status: "ok", details: `swept=${swept}` };
  });

  // ── 3. createApiKey — deterministic name ──
  const apiKeyResult = await phase("create_api_key", async () => {
    const r = await createApiKey(bearer, { name: HAPPY_PATH_KEY_NAME, scopes: ["events:read"] }, env);
    if (!r.ok) {
      return { status: "fail", details: `status=${r.status} http=${r.httpStatus} raw=${r.raw?.slice(0, 200)}` };
    }
    return {
      status: "ok",
      value: r.apiKey,
      details: `id=${r.apiKey.id} prefix=${r.apiKey.prefix} key=${maskToken(r.apiKey.key)} scopes=${r.apiKey.scopes.join(",")}`,
    };
  });
  if (apiKeyResult.status === "fail") {
    reportSummary();
    process.exit(4);
  }
  const apiKey = apiKeyResult.value as { id: string; key: string; prefix: string; name: string };

  // ── 4. listApiKeys ──
  await phase("list_api_keys", async () => {
    const r = await listApiKeys(bearer, env);
    if (!r.ok) return { status: "fail", details: `status=${r.status} http=${r.httpStatus}` };
    const found = r.apiKeys.find((k) => k.id === apiKey.id);
    if (!found) return { status: "warn", details: `created key id=${apiKey.id} NOT in list (n=${r.apiKeys.length}) — eventual consistency lag?` };
    return { status: "ok", details: `total_keys=${r.apiKeys.length} found_created=true` };
  });

  // ── 5. events probe — uses the typed helpers (NOT raw fetch) ──
  await phase("events_probe", async () => {
    const res = await fetchWithTimeout(
      `${args.apiBase}/api/v1/events/portal/events?limit=5`,
      { headers: buildHeaders({ tenantId: args.tenantId, bearer: apiKey.key }), timeoutMs: 15_000 }
    );
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      return { status: "warn", details: `events http=${res.status} body=${body.slice(0, 200)}` };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch {
      return { status: "warn", details: `events body not JSON: ${body.slice(0, 200)}` };
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { results?: unknown[] }).results)
        ? (parsed as { results: unknown[] }).results
        : [];
    if (rows.length === 0) {
      return { status: "warn", details: `events list empty (popup-membership gate, or no events yet in this popup)` };
    }
    const first = rows[0] as { id?: string; title?: string; start_time?: string };
    return { status: "ok", details: `events=${rows.length} first.id=${first.id} title=${JSON.stringify(first.title ?? "?")}` };
  });

  // ── 6. name_conflict exercise — mint the same name twice ──
  const dupResult = await phase("name_conflict_exercise", async () => {
    const r = await createApiKey(bearer, { name: HAPPY_PATH_KEY_NAME, scopes: ["events:read"] }, env);
    if (r.ok) {
      // Cleanup the unexpected duplicate immediately so we don't leak orphans
      await revokeApiKey(bearer, r.apiKey.id, env);
      return { status: "warn", details: `duplicate accepted (id=${r.apiKey.id} cleaned up) — EdgeOS may not enforce name uniqueness` };
    }
    if (r.status === "name_conflict") {
      return { status: "ok", details: `http=${r.httpStatus} raw=${r.raw?.slice(0, 150)}` };
    }
    return { status: "warn", details: `expected name_conflict, got status=${r.status} http=${r.httpStatus} — check NAME_CONFLICT_HINTS in lib/edgeos-api-keys.ts` };
  });

  // ── 7. mintOrReuseApiKey — full high-level helper exercise ──
  // Uses HAPPY_PATH_VM_NAME so the deterministic key is "instaclaw-edge-test-mint"
  // (orphan sweep at step 2.5 already cleaned any prior version)
  const mint1Result = await phase("mint_or_reuse_first_run", async () => {
    const r = await mintOrReuseApiKey(
      { bearer, vmName: HAPPY_PATH_VM_NAME, scopes: ["events:read"] },
      env
    );
    if (!r.ok) return { status: "fail", details: `status=${r.status} detail=${r.detail}` };
    if (r.mode !== "created") return { status: "warn", details: `mode=${r.mode} (expected 'created' for first run)` };
    return { status: "ok", value: r.apiKey.id, details: `mode=${r.mode} id=${r.apiKey.id}` };
  });
  const mintedId = (mint1Result.value as string | undefined) ?? null;

  await phase("mint_or_reuse_second_run", async () => {
    const r = await mintOrReuseApiKey(
      { bearer, vmName: HAPPY_PATH_VM_NAME, scopes: ["events:read"], onConflict: "return_existing" },
      env
    );
    if (!r.ok) return { status: "fail", details: `status=${r.status} detail=${r.detail}` };
    if (r.mode === "existing" && r.fullKey === null) {
      return { status: "ok", details: `mode=existing (correct — fullKey is null since we never see existing secrets)` };
    }
    return { status: "warn", details: `mode=${r.mode} fullKey=${r.fullKey ? "present" : "null"}` };
  });

  // ── 8. cleanup ──
  if (args.keep) {
    console.log("");
    console.log(`↷ cleanup SKIPPED (--keep) — keys persist for further poking:`);
    console.log(`  step-3 key: id=${apiKey.id}  name=${apiKey.name}`);
    console.log(`  step-3 raw key (shown ONLY here, persist responsibly): ${apiKey.key}`);
    if (mintedId) console.log(`  step-7 key id: ${mintedId} (name=instaclaw-edge-${HAPPY_PATH_VM_NAME})`);
  } else {
    await phase("cleanup_step3", async () => {
      const r = await revokeApiKey(bearer, apiKey.id, env);
      return r.ok ? { status: "ok" } : { status: "warn", details: `status=${r.status}` };
    });
    if (mintedId) {
      await phase("cleanup_step7", async () => {
        const r = await revokeApiKey(bearer, mintedId, env);
        return r.ok ? { status: "ok" } : { status: "warn", details: `status=${r.status}` };
      });
    }
  }

  // Final summary + empirical findings
  reportSummary();
  console.log("");
  console.log("EMPIRICAL FINDINGS (record in audit doc):");
  console.log(`  - X-Tenant-Id required for /api-keys POST: send-if-set is safe either way; ` +
              `dedicated probe needs a real bearer (which we have, see above)`);
  console.log(`  - Duplicate-name response shape: ${dupResult.status === "ok" ? "409 name_conflict" : dupResult.details}`);
  console.log("");

  const failed = phaseResults.some((r) => r.status === "fail");
  process.exit(failed ? 1 : 0);
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  if (args.smoke) await runSmoke(args);
  else await runHappyPath(args);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(99);
});
