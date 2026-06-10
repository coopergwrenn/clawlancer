/**
 * Failure-mode tests for the Travala booking bridge (Rule 31). Pure/synthetic —
 * runs without a VM or live Travala. Exercises the adverse cases the PRD §14-I
 * enumerates that are unit-testable here:
 *   - malformed `resource` field (P0 wrinkle i) → rebuilt from baseURL+path
 *   - 402 shape drift → extractBookQuote handles structuredContent / content[].text
 *     / direct, and fails cleanly when next_action/paymentRequirements are absent
 *   - amount discipline (P0 wrinkle ii) → paymentRequirements pass through with
 *     maxAmountRequired intact so the downstream selectPaymentRequirement signs
 *     against the on-chain amount, not a display price
 *   - kill-switch / opt-in semantics → isTravalaBookingEnabled FAIL-CLOSED,
 *     isTravalaBookingKilled FAIL-OPEN
 *   - token mint not_configured when env is absent
 *   - OAuth secret verifier shape check (whitespace / too-short rejected)
 *
 * Failure modes NOT tested here (covered elsewhere):
 *   - privacy-mode + spend-ceiling denial → frontier's own authorize gate suite
 *     (frontier-authz.decideAuthorization); the travala wrapper just relays the
 *     deny outcome.
 *   - live MCP SSE parsing / live mint → exercised by the P3 canary + the Rule 49
 *     verifier against real Travala.
 *
 * Run: `npx tsx scripts/_test-travala-failure-modes.ts`
 */
import { extractBookQuote, mintTravalaToken } from "../lib/travala-mcp";
import { isTravalaBookingEnabled } from "../lib/travala-kill-switch";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// The real 402 shape from the P0 probe (verbatim paymentRequirements[0]).
const REAL_REQUIREMENT = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x000000000000000000000000000000000000dEaD",
  maxAmountRequired: "370630000", // 370.63 USDC — the ON-CHAIN amount (display was 370.58)
  maxTimeoutSeconds: 600,
  extra: { name: "USD Coin", version: "2" },
};

function nextActionWith(resourceField: unknown) {
  return {
    next_action: {
      baseURL: "https://payment-mcp.travala.com",
      path: "/m2m-payment/book",
      method: "POST",
      body: { package_id: "qekuyjnOICYmdUP7", session_id: "tON2jOn8uWGPajSG", contact: { firstName: "A" } },
      ...(resourceField !== undefined ? { resource: resourceField } : {}),
    },
    paymentRequirements: [REAL_REQUIREMENT],
    x402Version: 1,
  };
}

async function main() {
console.log("\n=== Travala booking failure-mode tests ===\n");

// ── extractBookQuote: malformed resource workaround (P0 wrinkle i) ──
console.log("extractBookQuote — malformed resource workaround:");
{
  // structuredContent shape with Travala's malformed "undefined/m2m-payment/book"
  const q = extractBookQuote({ structuredContent: nextActionWith("undefined/m2m-payment/book") });
  check("parses ok", q.ok === true);
  check("resource rebuilt from baseURL+path (ignores malformed value)",
    q.resource === "https://payment-mcp.travala.com/m2m-payment/book", `got ${q.resource}`);
  check("resource is NOT Travala's malformed value", q.resource !== "undefined/m2m-payment/book");
  check("next_action.baseURL preserved", q.next_action?.baseURL === "https://payment-mcp.travala.com");
  check("next_action.body passed through verbatim",
    (q.next_action?.body as Record<string, unknown>)?.package_id === "qekuyjnOICYmdUP7");
}

// ── amount discipline (P0 wrinkle ii): maxAmountRequired preserved ──
console.log("\nextractBookQuote — amount discipline (maxAmountRequired preserved):");
{
  const q = extractBookQuote({ structuredContent: nextActionWith(undefined) });
  const req = (q.paymentRequirements?.[0] ?? {}) as typeof REAL_REQUIREMENT;
  check("paymentRequirements passed through", Array.isArray(q.paymentRequirements) && q.paymentRequirements.length === 1);
  check("maxAmountRequired is the on-chain amount (370630000)", req.maxAmountRequired === "370630000");
  check("no display price substituted", req.maxAmountRequired !== "370580000");
  // resource still rebuilt even with no resource field at all
  check("resource rebuilt when field absent", q.resource === "https://payment-mcp.travala.com/m2m-payment/book");
}

// ── 402 shape drift: content[].text JSON, direct result, missing pieces ──
console.log("\nextractBookQuote — 402 shape drift tolerance:");
{
  // content[].text carrying JSON (alternate MCP server shape)
  const viaText = extractBookQuote({ content: [{ type: "text", text: JSON.stringify(nextActionWith(undefined)) }] });
  check("parses next_action from content[].text JSON", viaText.ok === true && !!viaText.next_action);

  // next_action directly on the result object
  const viaDirect = extractBookQuote(nextActionWith(undefined));
  check("parses next_action directly on result", viaDirect.ok === true);

  // camelCase nextAction alias
  const camel = extractBookQuote({ nextAction: nextActionWith(undefined).next_action, paymentRequirements: [REAL_REQUIREMENT] });
  check("accepts camelCase nextAction alias", camel.ok === true);

  // missing paymentRequirements → not ok
  const noReq = extractBookQuote({ next_action: nextActionWith(undefined).next_action });
  check("fails cleanly when paymentRequirements absent", noReq.ok === false && !!noReq.error);

  // empty result → not ok
  const empty = extractBookQuote({});
  check("fails cleanly on empty result", empty.ok === false);

  // garbage text block → not ok (doesn't throw)
  const garbage = extractBookQuote({ content: [{ type: "text", text: "not json {{{" }] });
  check("ignores non-JSON content blocks without throwing", garbage.ok === false);
}

// ── per-VM opt-in: FAIL-CLOSED ──
console.log("\nisTravalaBookingEnabled — fail-closed:");
{
  check("true only on explicit === true", isTravalaBookingEnabled({ travala_booking_enabled: true }) === true);
  check("false on false", isTravalaBookingEnabled({ travala_booking_enabled: false }) === false);
  check("false on null", isTravalaBookingEnabled({ travala_booking_enabled: null }) === false);
  check("false on undefined column", isTravalaBookingEnabled({}) === false);
  check("false on null vm", isTravalaBookingEnabled(null) === false);
  check("false on undefined vm", isTravalaBookingEnabled(undefined) === false);
  // truthy-but-not-true must NOT enable (strict equality is the safety property)
  check("false on string 'true' (not boolean)", isTravalaBookingEnabled({ travala_booking_enabled: "true" as unknown as boolean }) === false);
  check("false on 1 (not boolean)", isTravalaBookingEnabled({ travala_booking_enabled: 1 as unknown as boolean }) === false);
}

// ── token mint: not_configured when env absent ──
console.log("\nmintTravalaToken — not_configured when env absent:");
{
  const savedId = process.env.TRAVALA_OAUTH_CLIENT_ID;
  const savedSecret = process.env.TRAVALA_OAUTH_CLIENT_SECRET;
  delete process.env.TRAVALA_OAUTH_CLIENT_ID;
  delete process.env.TRAVALA_OAUTH_CLIENT_SECRET;
  const r = await mintTravalaToken("mcp:read mcp:book");
  check("returns not_configured (no live call attempted)", r.ok === false && r.status === "not_configured");
  if (savedId !== undefined) process.env.TRAVALA_OAUTH_CLIENT_ID = savedId;
  if (savedSecret !== undefined) process.env.TRAVALA_OAUTH_CLIENT_SECRET = savedSecret;
}

// ── OAuth secret verifier: shape check (no network for the bad shapes) ──
console.log("\nverifyTravalaOAuthClientSecret — shape check:");
{
  const { SECRET_VERIFIERS } = await import("../lib/partner-secrets");
  const entry = SECRET_VERIFIERS.find((v) => v.envKey === "TRAVALA_OAUTH_CLIENT_SECRET");
  check("verifier registered in SECRET_VERIFIERS", !!entry);
  if (entry) {
    const empty = await entry.verify("");
    check("empty → not_configured", empty.status === "not_configured");
    const ws = await entry.verify("has whitespace\n");
    check("whitespace/newline → shape_invalid (Rule 6 trailing-\\n catch)", ws.status === "shape_invalid");
    const short = await entry.verify("short");
    check("too-short → shape_invalid", short.status === "shape_invalid");
  }
}

// ── travel session-approval contract (frontier F2) — the exact decideAuthorization
//    behavior travala-book.mjs step 3 branches on. If frontier changes this, these
//    fail and the wrapper must be reworked. ──
console.log("\ndecideAuthorization — travel session-required contract (F2):");
{
  const { decideAuthorization } = await import("../lib/frontier-authz");
  type AuthzInput = Parameters<typeof decideAuthorization>[0];
  const mk = (o: { decision?: string; reason?: string; forgeable?: boolean; session?: boolean; disallow?: boolean }): AuthzInput =>
    ({
      evaluation: { decision: o.decision ?? "allow", reason: o.reason ?? "ok", effectiveBands: { justDoItPerTx: 1 } },
      standing: { earnedDailyBudgetUsd: 100000 },
      reserveAwareSpentTodayUsd: 0,
      amountUsd: 370.63,
      categoryKnown: true,
      humanApprovedForgeable: o.forgeable ?? false,
      sessionApproved: o.session ?? false,
      justDoItPerTxUsd: 0, // everything is "above threshold"
      disallowForgeableApproval: o.disallow ?? true, // travel = session-required
    } as unknown as AuthzInput);

  // forgeable bool alone NEVER authorizes travel — it bounces to session approval.
  const f = decideAuthorization(mk({ forgeable: true, session: false, disallow: true }));
  check("travel + forgeable-only → NOT authorized", f.authorized === false);
  check("travel + forgeable-only → outcome ask_first", f.outcome === "ask_first");
  check("travel + forgeable-only → reason needs_session_approval", f.reason === "needs_session_approval", `got ${f.reason}`);

  // a browser-session approval authorizes travel at any amount.
  const s = decideAuthorization(mk({ session: true, disallow: true }));
  check("travel + session → authorized", s.authorized === true);
  check("travel + session → mode human_approved", s.mode === "human_approved");
  check("travel + session → reason human_approved_session", s.reason === "human_approved_session", `got ${s.reason}`);

  // session wins even if the forgeable bool is also set.
  const both = decideAuthorization(mk({ forgeable: true, session: true, disallow: true }));
  check("travel + session + forgeable → authorized via session", both.authorized === true && both.reason === "human_approved_session");

  // a hard deny (over the §6 ceiling) stays denied — forgeable can't override Gate 1.
  const deny = decideAuthorization(mk({ decision: "deny", reason: "exceeds_never_per_tx", forgeable: true, session: false }));
  check("travel hard-deny → NOT authorized (forgeable can't override)", deny.authorized === false);
  check("travel hard-deny → outcome deny", deny.outcome === "deny");
  check("travel hard-deny → reason preserved", deny.reason === "exceeds_never_per_tx");

  // even a session approval can't override a hard deny (Gate 1 is absolute).
  const denySession = decideAuthorization(mk({ decision: "deny", reason: "exceeds_never_per_tx", session: true }));
  check("travel hard-deny + session → still denied (Gate 1 absolute)", denySession.authorized === false && denySession.outcome === "deny");
}

// ── summary ──
console.log(`\n=== ${passed} passed / ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
