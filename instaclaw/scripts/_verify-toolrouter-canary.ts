/**
 * _verify-toolrouter-canary.ts — pre-flight verification for the
 * ToolRouter v1 canary.
 *
 * Automates as much of docs/operations/toolrouter-v1-canary-runbook.md
 * pre-flight (steps 1-6) as can be checked programmatically. Run this
 * AFTER Cooper completes the manual setup (toolrouter.world signup,
 * AgentBook register, Stripe SKU creation, env var setting, migration
 * apply via Supabase Studio).
 *
 * Out of scope (manual steps in the runbook itself):
 *   - Task J: SSH probe of the canary VM, Telegram prompts (need a live agent)
 *   - Task K.10: Stripe checkout completion (need a browser)
 *   - Task K.11: Free-fallback adequacy (need agent prompts via Telegram)
 *
 * Sections (each line ✓/✗/·/~):
 *   1. Vercel env vars (4 checks)
 *   2. Database schema (4 checks — columns, table, 2 RPCs)
 *   3. Code wiring (5 file-exists + 2 cron entries in vercel.json)
 *   4. Stripe SKU (price exists, $10, USD, active)
 *   5. Partner-secret HTTP probe (delegate to verifyAllPartnerSecrets)
 *   6. Migration file location (Rule 56)
 *   7. TS/SQL tier-grant sync (TOOLROUTER_TIER_GRANTS vs migration CASE block)
 *   8. Wrapper wiring — dead-code detection for callToolRouter callers
 *      (Task K.4 status). INFO at v1 ship; OK once production code calls
 *      callToolRouter or instaclaw_consume_toolrouter_searches.
 *   9. K.4 wrapper deployed on canary VM — SSH probe of wrapper file
 *      existence + MCP config wire-up. Set TOOLROUTER_CANARY_VM env to
 *      a VM name (defaults to instaclaw-vm-1019, Cooper's standing
 *      canary). Set TOOLROUTER_CANARY_VM='' to skip.
 *
 * Exit code:
 *   0 — all hard gates clear (soft signals like unreachable / not-yet-applied logged but pass)
 *   1 — at least one hard failure (script blocks the canary)
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Load env vars before importing modules that read process.env.
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env file missing is fine here; verifier will report missing keys.
  }
}

import { verifyAllPartnerSecrets } from "../lib/partner-secrets";
import { TOOLROUTER_TIER_GRANTS, TOOLROUTER_TOPUP_PACK } from "../lib/toolrouter-credits";

const REPO_INSTACLAW = "/Users/cooperwrenn/wild-west-bots/instaclaw";
const MIGRATION_FILENAME = "20260527200000_toolrouter_allocation.sql";
const TOOLROUTER_API_KEY_SHAPE = /^tr_[A-Za-z0-9_-]{16,}$/;
const STRIPE_PRICE_ID_SHAPE = /^price_[A-Za-z0-9_-]+$/;
const VALID_TRANSPORTS = new Set(["stdio", "streamable-http"]);

type Severity = "OK" | "HARD" | "SOFT" | "INFO";
interface CheckResult {
  name: string;
  severity: Severity;
  detail: string;
}

const SYMBOL: Record<Severity, string> = {
  OK: "✓",
  HARD: "✗",
  SOFT: "~",
  INFO: "·",
};

const results: CheckResult[] = [];
function record(r: CheckResult): void {
  results.push(r);
}

// ────────────────────────────────────────────────────────────────────
// Section 1 — Vercel env vars
// ────────────────────────────────────────────────────────────────────

function checkEnvVars(): void {
  const apiKey = process.env.TOOLROUTER_API_KEY;
  if (!apiKey) {
    record({
      name: "1.1 TOOLROUTER_API_KEY",
      severity: "HARD",
      detail: "unset — printf 'tr_...' | npx vercel env add TOOLROUTER_API_KEY production",
    });
  } else if (!TOOLROUTER_API_KEY_SHAPE.test(apiKey)) {
    record({
      name: "1.1 TOOLROUTER_API_KEY",
      severity: "HARD",
      detail: `shape invalid (expected /^tr_[A-Za-z0-9_-]{16,}$/, got ${apiKey.slice(0, 8)}…, len=${apiKey.length})`,
    });
  } else {
    record({
      name: "1.1 TOOLROUTER_API_KEY",
      severity: "OK",
      detail: `shape ok (${apiKey.slice(0, 6)}…${apiKey.slice(-2)}, len=${apiKey.length})`,
    });
  }

  // Rule 61: boolean env vars must be the literal "true".
  const enabledRaw = process.env.TOOLROUTER_ENABLED;
  if (enabledRaw === undefined || enabledRaw === "") {
    record({
      name: "1.2 TOOLROUTER_ENABLED",
      severity: "HARD",
      detail: "unset — printf 'true' | npx vercel env add TOOLROUTER_ENABLED production",
    });
  } else if (enabledRaw !== "true") {
    record({
      name: "1.2 TOOLROUTER_ENABLED",
      severity: "HARD",
      detail: `${JSON.stringify(enabledRaw)} (expected literal "true" per Rule 61 — printf 'true', not echo/<<<)`,
    });
  } else {
    record({
      name: "1.2 TOOLROUTER_ENABLED",
      severity: "OK",
      detail: '"true"',
    });
  }

  const transport = process.env.TOOLROUTER_TRANSPORT;
  if (!transport) {
    record({
      name: "1.3 TOOLROUTER_TRANSPORT",
      severity: "HARD",
      detail: "unset — printf 'stdio' | npx vercel env add TOOLROUTER_TRANSPORT production",
    });
  } else if (!VALID_TRANSPORTS.has(transport)) {
    record({
      name: "1.3 TOOLROUTER_TRANSPORT",
      severity: "HARD",
      detail: `${JSON.stringify(transport)} (expected "stdio" or "streamable-http")`,
    });
  } else {
    record({
      name: "1.3 TOOLROUTER_TRANSPORT",
      severity: "OK",
      detail: `"${transport}"`,
    });
  }

  const priceId = process.env.STRIPE_PRICE_TOOLROUTER_100;
  if (!priceId) {
    record({
      name: "1.4 STRIPE_PRICE_TOOLROUTER_100",
      severity: "HARD",
      detail: "unset — create the Stripe SKU, then printf 'price_xxx' | npx vercel env add STRIPE_PRICE_TOOLROUTER_100 production",
    });
  } else if (!STRIPE_PRICE_ID_SHAPE.test(priceId)) {
    record({
      name: "1.4 STRIPE_PRICE_TOOLROUTER_100",
      severity: "HARD",
      detail: `shape invalid (expected /^price_[A-Za-z0-9_-]+$/, got ${priceId.slice(0, 12)}…)`,
    });
  } else {
    record({
      name: "1.4 STRIPE_PRICE_TOOLROUTER_100",
      severity: "OK",
      detail: `shape ok (${priceId})`,
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Section 2 — Database schema (Supabase)
// ────────────────────────────────────────────────────────────────────

async function checkDatabaseSchema(): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const skipped = [
      "2.1 instaclaw_users.toolrouter_* columns",
      "2.2 instaclaw_toolrouter_call_log table",
      "2.3 instaclaw_consume_toolrouter_searches RPC",
      "2.4 instaclaw_add_toolrouter_searches RPC",
    ];
    for (const name of skipped) {
      record({ name, severity: "SOFT", detail: "SKIPPED — no Supabase credentials in .env.local" });
    }
    return;
  }

  // Defer import until env is confirmed loaded.
  const { getSupabase } = await import("../lib/supabase");
  const supabase = getSupabase();

  // 2.1 — columns on instaclaw_users (5 expected).
  // PostgREST returns 42703 (undefined_column) if any column is missing.
  // We use limit(0) so no rows are read — schema-only probe.
  {
    const { error } = await supabase
      .from("instaclaw_users")
      .select(
        "toolrouter_balance, toolrouter_grant_override, toolrouter_grant_period_start, toolrouter_80pct_notified_at, toolrouter_topup_balance",
      )
      .limit(0);
    if (error) {
      record({
        name: "2.1 instaclaw_users.toolrouter_* columns",
        severity: "HARD",
        detail: `${error.code ?? "?"}: ${error.message.slice(0, 140)}`,
      });
    } else {
      record({
        name: "2.1 instaclaw_users.toolrouter_* columns",
        severity: "OK",
        detail: "5 columns present (balance, grant_override, period_start, 80pct_notified_at, topup_balance)",
      });
    }
  }

  // 2.2 — instaclaw_toolrouter_call_log table.
  // PostgREST returns 42P01 / PGRST204 if table is missing.
  {
    const { error } = await supabase
      .from("instaclaw_toolrouter_call_log")
      .select("id")
      .limit(0);
    if (error) {
      record({
        name: "2.2 instaclaw_toolrouter_call_log table",
        severity: "HARD",
        detail: `${error.code ?? "?"}: ${error.message.slice(0, 140)}`,
      });
    } else {
      record({
        name: "2.2 instaclaw_toolrouter_call_log table",
        severity: "OK",
        detail: "table accessible",
      });
    }
  }

  // 2.3 — instaclaw_consume_toolrouter_searches RPC.
  // Safe probe: p_charged=false short-circuits at the top of the function
  // BEFORE any SELECT/UPDATE. Returns {allowed:true, allocation_source:"sponsored_agentkit"}.
  // If RPC missing, PostgREST returns PGRST202 (function-not-found).
  {
    const { data, error } = await supabase.rpc("instaclaw_consume_toolrouter_searches", {
      p_user_id: "00000000-0000-0000-0000-000000000000",
      p_weight: 0,
      p_endpoint_id: "_canary_verifier_probe",
      p_charged: false, // critical — short-circuits without mutating state
      p_trace_id: "_canary_verifier",
    });
    if (error) {
      record({
        name: "2.3 instaclaw_consume_toolrouter_searches RPC",
        severity: "HARD",
        detail: `${error.code ?? "?"}: ${error.message.slice(0, 140)}`,
      });
    } else {
      const allowed = (data as { allowed?: boolean } | null)?.allowed;
      const okShape = allowed === true;
      record({
        name: "2.3 instaclaw_consume_toolrouter_searches RPC",
        severity: okShape ? "OK" : "SOFT",
        detail: okShape ? "callable, sponsored-agentkit short-circuit returned allowed=true" : `unexpected shape: ${JSON.stringify(data).slice(0, 100)}`,
      });
    }
  }

  // 2.4 — instaclaw_add_toolrouter_searches RPC.
  // Safe probe: p_credits=0 makes the UPDATE a no-op; WHERE id=zero-uuid matches 0 rows.
  {
    const { error } = await supabase.rpc("instaclaw_add_toolrouter_searches", {
      p_user_id: "00000000-0000-0000-0000-000000000000",
      p_credits: 0,
    });
    if (error) {
      record({
        name: "2.4 instaclaw_add_toolrouter_searches RPC",
        severity: "HARD",
        detail: `${error.code ?? "?"}: ${error.message.slice(0, 140)}`,
      });
    } else {
      record({
        name: "2.4 instaclaw_add_toolrouter_searches RPC",
        severity: "OK",
        detail: "callable, zero-credits no-op succeeded",
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Section 3 — Code wiring (file existence + vercel.json crons)
// ────────────────────────────────────────────────────────────────────

function checkCodeWiring(): void {
  const expectedFiles = [
    "lib/toolrouter-client.ts",
    "lib/toolrouter-credits.ts",
    // K.4 (added 2026-06-01): the wrapper source + the endpoint it POSTs to.
    "lib/toolrouter-wrapper-script.ts",
    "app/api/agent/toolrouter/record-usage/route.ts",
    "app/api/cron/reconcile-toolrouter-usage/route.ts",
    "app/api/toolrouter/balance/route.ts",
    "app/api/cron/probe-toolrouter-balance/route.ts",
    "app/api/cron/probe-toolrouter-registry/route.ts",
  ];
  for (const rel of expectedFiles) {
    const abs = resolve(REPO_INSTACLAW, rel);
    if (existsSync(abs)) {
      record({ name: `3.* ${rel}`, severity: "OK", detail: "present" });
    } else {
      record({ name: `3.* ${rel}`, severity: "HARD", detail: "missing — check merge state" });
    }
  }

  // 3.* — crons registered in vercel.json
  try {
    const vercelJson = JSON.parse(
      readFileSync(resolve(REPO_INSTACLAW, "vercel.json"), "utf-8"),
    );
    const crons = (vercelJson.crons as Array<{ path: string; schedule: string }> | undefined) ?? [];
    const expectedCrons = [
      "/api/cron/probe-toolrouter-balance",
      "/api/cron/probe-toolrouter-registry",
      // K.4 (added 2026-06-01): hourly drift detector for wrapper missed-reports.
      "/api/cron/reconcile-toolrouter-usage",
    ];
    for (const path of expectedCrons) {
      const entry = crons.find((c) => c.path === path);
      if (entry) {
        record({
          name: `3.* cron ${path}`,
          severity: "OK",
          detail: `registered (schedule="${entry.schedule}")`,
        });
      } else {
        record({
          name: `3.* cron ${path}`,
          severity: "HARD",
          detail: "missing from vercel.json crons[]",
        });
      }
    }
  } catch (e) {
    record({
      name: "3.* vercel.json crons",
      severity: "HARD",
      detail: `parse error: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Section 4 — Stripe SKU
// ────────────────────────────────────────────────────────────────────

async function checkStripeSku(): Promise<void> {
  const priceId = process.env.STRIPE_PRICE_TOOLROUTER_100;
  if (!priceId) {
    record({
      name: "4.1 Stripe price retrieve",
      severity: "SOFT",
      detail: "SKIPPED — STRIPE_PRICE_TOOLROUTER_100 not set (Section 1 will flag)",
    });
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    record({
      name: "4.1 Stripe price retrieve",
      severity: "SOFT",
      detail: "SKIPPED — STRIPE_SECRET_KEY not in .env.local",
    });
    return;
  }

  try {
    const { getStripe } = await import("../lib/stripe");
    const stripe = getStripe();
    const price = await stripe.prices.retrieve(priceId);

    const issues: string[] = [];
    const expectedAmount = TOOLROUTER_TOPUP_PACK.price_usd * 100; // dollars → cents
    if (price.unit_amount !== expectedAmount) {
      issues.push(`unit_amount=${price.unit_amount}¢ (expected ${expectedAmount}¢ for $${TOOLROUTER_TOPUP_PACK.price_usd} pack)`);
    }
    if (price.currency !== "usd") {
      issues.push(`currency="${price.currency}" (expected "usd")`);
    }
    if (price.active !== true) {
      issues.push(`active=${price.active} (expected true)`);
    }

    if (issues.length === 0) {
      record({
        name: "4.1 Stripe price retrieve",
        severity: "OK",
        detail: `$${(price.unit_amount! / 100).toFixed(2)} ${price.currency.toUpperCase()}, active, livemode=${price.livemode}`,
      });
    } else {
      record({
        name: "4.1 Stripe price retrieve",
        severity: "HARD",
        detail: issues.join("; "),
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    record({
      name: "4.1 Stripe price retrieve",
      // Stripe-not-found / wrong-mode → hard fail (operator misconfigured)
      // Network / 5xx → soft fail (transient)
      severity: /No such price|resource_missing/i.test(msg) ? "HARD" : "SOFT",
      detail: msg.slice(0, 160),
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Section 5 — Partner-secret HTTP probe
// ────────────────────────────────────────────────────────────────────

async function checkPartnerSecret(): Promise<void> {
  if (!process.env.TOOLROUTER_API_KEY) {
    record({
      name: "5.1 TOOLROUTER_API_KEY live probe",
      severity: "SOFT",
      detail: "SKIPPED — key not set (Section 1 will flag)",
    });
    return;
  }

  try {
    const allResults = await verifyAllPartnerSecrets();
    const r = allResults.find((x) => x.envKey === "TOOLROUTER_API_KEY");
    if (!r) {
      record({
        name: "5.1 TOOLROUTER_API_KEY live probe",
        severity: "HARD",
        detail: "verifier not registered in SECRET_VERIFIERS — check lib/partner-secrets.ts",
      });
      return;
    }

    // Map verifier status to our severity model. Aligns with
    // _verify-partner-secrets.ts: hard-fail = shape_invalid/auth_failed/endpoint_other/endpoint_5xx,
    // soft-fail = unreachable, info = not_configured, ok = ok.
    const status = r.status;
    const http = r.http_code ? ` http=${r.http_code}` : "";
    if (status === "ok") {
      record({
        name: "5.1 TOOLROUTER_API_KEY live probe",
        severity: "OK",
        detail: `live /health + /v1/endpoints both 200${http}`,
      });
    } else if (status === "not_configured") {
      record({
        name: "5.1 TOOLROUTER_API_KEY live probe",
        severity: "INFO",
        detail: "not_configured (shouldn't happen if Section 1 passed)",
      });
    } else if (status === "unreachable" || status === "endpoint_5xx") {
      record({
        name: "5.1 TOOLROUTER_API_KEY live probe",
        severity: "SOFT",
        detail: `${status}${http} — transient, retry`,
      });
    } else {
      record({
        name: "5.1 TOOLROUTER_API_KEY live probe",
        severity: "HARD",
        detail: `${status}${http} — ${r.error?.slice(0, 100) ?? ""}`,
      });
    }
  } catch (e) {
    record({
      name: "5.1 TOOLROUTER_API_KEY live probe",
      severity: "SOFT",
      detail: `verifier threw: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Section 6 — Migration file location (Rule 56)
// ────────────────────────────────────────────────────────────────────

function checkMigrationLocation(): void {
  const inMigrations = existsSync(
    resolve(REPO_INSTACLAW, "supabase/migrations", MIGRATION_FILENAME),
  );
  const inPending = existsSync(
    resolve(REPO_INSTACLAW, "supabase/pending_migrations", MIGRATION_FILENAME),
  );

  if (inMigrations && !inPending) {
    record({
      name: "6.1 migration file location",
      severity: "OK",
      detail: `${MIGRATION_FILENAME} in migrations/ (applied + moved per Rule 56)`,
    });
  } else if (!inMigrations && inPending) {
    record({
      name: "6.1 migration file location",
      severity: "INFO",
      detail: `${MIGRATION_FILENAME} still in pending_migrations/ — after applying via Studio, run: git mv .../pending_migrations/${MIGRATION_FILENAME} supabase/migrations/`,
    });
  } else if (inMigrations && inPending) {
    record({
      name: "6.1 migration file location",
      severity: "HARD",
      detail: `${MIGRATION_FILENAME} in BOTH migrations/ AND pending_migrations/ — duplicate, must remove the pending_migrations/ copy`,
    });
  } else {
    record({
      name: "6.1 migration file location",
      severity: "HARD",
      detail: `${MIGRATION_FILENAME} missing from BOTH locations — investigate (run "git status" + "git log")`,
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Section 7 — TS / SQL tier-grant sync (drift catcher)
// ────────────────────────────────────────────────────────────────────

function checkTierGrantSync(): void {
  // Source of truth (TS).
  const tsGrants = TOOLROUTER_TIER_GRANTS as unknown as Record<string, number>;

  // Read migration content (whichever location it's in) and parse the CASE block.
  const candidates = [
    resolve(REPO_INSTACLAW, "supabase/migrations", MIGRATION_FILENAME),
    resolve(REPO_INSTACLAW, "supabase/pending_migrations", MIGRATION_FILENAME),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    record({
      name: "7.1 tier-grant TS/SQL sync",
      severity: "SOFT",
      detail: "SKIPPED — migration file not found (Section 6 will flag)",
    });
    return;
  }

  const sql = readFileSync(path, "utf-8");
  // Capture lines like: WHEN 'starter' THEN 60
  const sqlGrants: Record<string, number> = {};
  for (const m of sql.matchAll(/WHEN\s+'([a-z_]+)'\s+THEN\s+(\d+)/g)) {
    sqlGrants[m[1]] = Number(m[2]);
  }

  const mismatches: string[] = [];
  for (const tier of Object.keys(tsGrants)) {
    const tsVal = tsGrants[tier];
    const sqlVal = sqlGrants[tier];
    if (sqlVal === undefined) {
      mismatches.push(`${tier}: in TS (${tsVal}) but missing from SQL CASE`);
    } else if (sqlVal !== tsVal) {
      mismatches.push(`${tier}: TS=${tsVal}, SQL=${sqlVal}`);
    }
  }
  for (const tier of Object.keys(sqlGrants)) {
    if (!(tier in tsGrants)) {
      mismatches.push(`${tier}: in SQL (${sqlGrants[tier]}) but missing from TS TOOLROUTER_TIER_GRANTS`);
    }
  }

  if (mismatches.length === 0) {
    record({
      name: "7.1 tier-grant TS/SQL sync",
      severity: "OK",
      detail: `${Object.keys(tsGrants).length} tiers in sync (${Object.entries(tsGrants).map(([k, v]) => `${k}=${v}`).join(", ")})`,
    });
  } else {
    record({
      name: "7.1 tier-grant TS/SQL sync",
      severity: "HARD",
      detail: `drift detected: ${mismatches.join("; ")}`,
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Section 8 — Wrapper wiring (dead-code detection, Task K.4 status)
// ────────────────────────────────────────────────────────────────────
//
// The wrapper function callToolRouter() at lib/toolrouter-client.ts:346
// implements the call-first-decrement-after consumption logic. It's
// well-formed but optional at v1 (PRD Task K.4 — "lands in K.4, not
// exported at v1"). When v1 ships without it:
//   - User tool calls route via MCP subprocess → toolrouter.world directly
//   - Allocation columns (toolrouter_balance / toolrouter_topup_balance)
//     never decrement
//   - 80%/100% upsell never fires
//   - Top-up purchases credit a column that no consumer reads
//
// This section greps the codebase for production callers and reports
// the wiring state so the operator knows whether allocation enforcement
// is live or decorative. INFO at v1 ship state; OK once K.4 lands.

function checkWrapperWiring(): void {
  const candidates = [
    resolve(REPO_INSTACLAW, "app/api"),
    resolve(REPO_INSTACLAW, "lib"),
  ];

  // Find all .ts/.tsx files that import or reference callToolRouter +
  // instaclaw_consume_toolrouter_searches. Exclude the wrapper's own
  // file and verifier scripts.
  const excludePaths = [
    "lib/toolrouter-client.ts", // wrapper's own definition + types
  ];

  function listTs(dir: string, acc: string[] = []): string[] {
    let entries: string[];
    try {
      entries = require("fs").readdirSync(dir, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const ent of entries) {
      const full = `${dir}/${ent.name}`;
      if (ent.isDirectory()) listTs(full, acc);
      else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx"))) {
        acc.push(full);
      }
    }
    return acc;
  }

  const files: string[] = [];
  for (const dir of candidates) files.push(...listTs(dir));

  const callerHits: string[] = [];
  const rpcHits: string[] = [];
  for (const path of files) {
    const rel = path.replace(REPO_INSTACLAW + "/", "");
    if (excludePaths.includes(rel)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    // The wrapper's name OR the canonical RPC call. Either signals
    // allocation enforcement is in the production code path.
    if (/\bcallToolRouter\s*\(/.test(content)) {
      callerHits.push(rel);
    }
    if (/\.rpc\(\s*["']instaclaw_consume_toolrouter_searches["']/.test(content)) {
      rpcHits.push(rel);
    }
  }

  if (callerHits.length === 0 && rpcHits.length === 0) {
    record({
      name: "8.1 wrapper wiring (callToolRouter callers)",
      severity: "INFO",
      detail:
        "no production callers — Task K.4 deferred at v1. Allocation columns track top-up purchases but never decrement on tool calls. dashboard card is decorative until K.4 lands.",
    });
  } else {
    const all = [...new Set([...callerHits, ...rpcHits])].sort();
    record({
      name: "8.1 wrapper wiring (callToolRouter callers)",
      severity: "OK",
      detail: `${all.length} caller(s): ${all.slice(0, 3).join(", ")}${all.length > 3 ? "…" : ""}`,
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Section 9 — K.4 wrapper deployed on canary VM (SSH live probe)
// ────────────────────────────────────────────────────────────────────
//
// Section 8 is a static codebase check. Section 9 is the runtime
// counterpart: SSH into a canary VM and probe whether the wrapper
// .mjs file is actually deployed AND the mcp.servers.toolrouter
// config points at it (.command="node" + .args[0]=<wrapperPath>).
//
// The wrapper deploy happens via stepFiles + the file-drift cron;
// the MCP wire-up happens via stepToolRouter (reconcile-fleet cron,
// gated on cv-staleness OR secret_version-staleness). On a fresh
// post-deploy fleet, both should land within ~30 min of the Vercel
// deploy. Until VM_MANIFEST.version bumps to force re-reconcile,
// caught-up VMs have the wrapper on disk but their MCP config still
// points at the v1 direct-toolrouter shape.
//
// Canary VM: TOOLROUTER_CANARY_VM env var, defaults to
// "instaclaw-vm-1019" (Cooper's standing canary per CLAUDE.md
// Rule 64). Set TOOLROUTER_CANARY_VM='' to skip Section 9 entirely.

const TOOLROUTER_CANARY_VM_DEFAULT = "instaclaw-vm-1019";
const TOOLROUTER_WRAPPER_PATH_ON_VM = "/home/openclaw/.openclaw/scripts/toolrouter-wrapper.mjs";

async function checkWrapperDeployedOnCanary(): Promise<void> {
  const canaryName = process.env.TOOLROUTER_CANARY_VM === undefined
    ? TOOLROUTER_CANARY_VM_DEFAULT
    : process.env.TOOLROUTER_CANARY_VM;

  if (!canaryName) {
    record({
      name: "9.1 wrapper deployed on canary VM",
      severity: "INFO",
      detail: "skipped (TOOLROUTER_CANARY_VM='')",
    });
    return;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SSH_PRIVATE_KEY_B64) {
    record({
      name: "9.1 wrapper deployed on canary VM",
      severity: "SOFT",
      detail: "SKIPPED — need SUPABASE_SERVICE_ROLE_KEY + SSH_PRIVATE_KEY_B64",
    });
    return;
  }

  // Resolve canary IP from Supabase
  const { getSupabase } = await import("../lib/supabase");
  const supabase = getSupabase();
  const { data: vm, error: lookupErr } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, gateway_token, health_status, status")
    .eq("name", canaryName)
    .maybeSingle();
  if (lookupErr || !vm) {
    record({
      name: "9.1 wrapper deployed on canary VM",
      severity: "SOFT",
      detail: `canary VM "${canaryName}" not found: ${lookupErr?.message ?? "no row"}`,
    });
    return;
  }
  if (vm.status !== "assigned" || vm.health_status !== "healthy") {
    record({
      name: "9.1 wrapper deployed on canary VM",
      severity: "SOFT",
      detail: `canary "${canaryName}" not eligible (status=${vm.status}, health=${vm.health_status})`,
    });
    return;
  }

  // SSH probe (mirrors _coverage-toolrouter.ts pattern)
  const { NodeSSH } = await import("node-ssh");
  const ssh = new NodeSSH();
  let sshPrivateKey: string;
  try {
    sshPrivateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
  } catch (e) {
    record({
      name: "9.1 wrapper deployed on canary VM",
      severity: "SOFT",
      detail: `SSH_PRIVATE_KEY_B64 decode failed: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`,
    });
    return;
  }

  try {
    await ssh.connect({
      host: vm.ip_address,
      username: "openclaw",
      privateKey: sshPrivateKey,
      readyTimeout: 8_000,
    });

    const probe = await ssh.execCommand(
      `echo "WRAPPER_EXISTS:$(test -f ${TOOLROUTER_WRAPPER_PATH_ON_VM} && echo 1 || echo 0)"; ` +
      `echo "WRAPPER_SENTINEL:$(grep -c TOOLROUTER_WRAPPER_V1 ${TOOLROUTER_WRAPPER_PATH_ON_VM} 2>/dev/null || echo 0)"; ` +
      `echo "MCP_COMMAND:$(jq -r '.mcp.servers.toolrouter.command // ""' $HOME/.openclaw/openclaw.json 2>/dev/null)"; ` +
      `echo "MCP_ARG0:$(jq -r '.mcp.servers.toolrouter.args[0] // ""' $HOME/.openclaw/openclaw.json 2>/dev/null)"`,
    );

    const out = probe.stdout || "";
    const lines = out.split("\n");
    const find = (prefix: string): string => {
      const ln = lines.find((l) => l.startsWith(prefix + ":"));
      return ln ? ln.slice(prefix.length + 1).trim() : "";
    };
    const wrapperExists = find("WRAPPER_EXISTS") === "1";
    const wrapperSentinelCount = Number(find("WRAPPER_SENTINEL")) || 0;
    const mcpCommand = find("MCP_COMMAND");
    const mcpArg0 = find("MCP_ARG0");

    // State matrix:
    //   wrapper missing, mcp=toolrouter      → v1 state, pre-K.4
    //   wrapper present, mcp=toolrouter      → mid-rollout (file-drift ran, manifest not bumped)
    //   wrapper present, mcp=node + arg=path → K.4 fully wired ✓
    //   wrapper missing, mcp=node            → BAD — MCP config points at non-existent wrapper
    if (!wrapperExists) {
      record({
        name: "9.1 wrapper deployed on canary VM",
        severity: mcpCommand === "node" ? "HARD" : "INFO",
        detail: mcpCommand === "node"
          ? `BROKEN: ${canaryName} MCP points at wrapper that's not on disk (mcp.command=${mcpCommand})`
          : `K.4 not rolled to ${canaryName} yet (wrapper missing, MCP at v1 shape command=${mcpCommand || "unset"})`,
      });
      return;
    }
    if (wrapperSentinelCount < 1) {
      record({
        name: "9.1 wrapper deployed on canary VM",
        severity: "HARD",
        detail: `${canaryName} wrapper file present but TOOLROUTER_WRAPPER_V1 sentinel missing — Rule 23 should have refused this deploy`,
      });
      return;
    }
    if (mcpCommand !== "node" || !mcpArg0.includes("toolrouter-wrapper.mjs")) {
      record({
        name: "9.1 wrapper deployed on canary VM",
        severity: "INFO",
        detail: `${canaryName} wrapper deployed but MCP not wired yet (mcp.command=${mcpCommand || "unset"}, arg0=${mcpArg0.slice(-40) || "unset"}) — waiting for manifest version bump`,
      });
      return;
    }

    record({
      name: "9.1 wrapper deployed on canary VM",
      severity: "OK",
      detail: `${canaryName}: wrapper on disk + MCP wired (command=node, arg0=…${mcpArg0.slice(-40)})`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    record({
      name: "9.1 wrapper deployed on canary VM",
      severity: "SOFT",
      detail: `${canaryName} SSH probe failed: ${msg.slice(0, 120)}`,
    });
  } finally {
    try { ssh.dispose(); } catch { /* swallow */ }
  }
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("ToolRouter v1 canary — pre-flight verification\n");
  console.log("Runbook: instaclaw/docs/operations/toolrouter-v1-canary-runbook.md");
  console.log("Out of scope (manual): Task J SSH+Telegram, K.10 Stripe checkout, K.11 free-fallback prompts\n");

  console.log("Section 1: Vercel env vars");
  checkEnvVars();

  console.log("Section 2: Database schema (Supabase)");
  await checkDatabaseSchema();

  console.log("Section 3: Code wiring + cron registration");
  checkCodeWiring();

  console.log("Section 4: Stripe SKU");
  await checkStripeSku();

  console.log("Section 5: Partner-secret live probe");
  await checkPartnerSecret();

  console.log("Section 6: Migration file location (Rule 56)");
  checkMigrationLocation();

  console.log("Section 7: TS/SQL tier-grant sync");
  checkTierGrantSync();

  console.log("Section 8: Wrapper wiring (K.4 status)");
  checkWrapperWiring();

  console.log("Section 9: K.4 wrapper deployed on canary VM (SSH probe)");
  await checkWrapperDeployedOnCanary();

  console.log("\n──────── results ────────");
  for (const r of results) {
    const sym = SYMBOL[r.severity];
    console.log(`  [${sym}] ${r.name.padEnd(56)} ${r.detail}`);
  }

  const counts: Record<Severity, number> = { OK: 0, HARD: 0, SOFT: 0, INFO: 0 };
  for (const r of results) counts[r.severity]++;

  console.log("");
  console.log(`Summary: ${results.length} checks — ${counts.OK} pass, ${counts.HARD} hard-fail, ${counts.SOFT} soft-fail, ${counts.INFO} info`);
  console.log("  Hard failures (✗) → exit 1, block the canary until resolved");
  console.log("  Soft failures (~) → exit 0, retry or investigate");
  console.log("  Info (·) → exit 0, expected pre-flip state");

  if (counts.HARD > 0) {
    console.error(`\nBLOCKED: ${counts.HARD} hard failure(s). Fix before running canary.`);
    process.exit(1);
  }
  console.log("\nREADY: all hard gates clear. Proceed to Task J in the runbook.");
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
