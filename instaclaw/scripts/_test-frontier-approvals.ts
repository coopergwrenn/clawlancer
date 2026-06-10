#!/usr/bin/env tsx
/**
 * Tests for the human_approved hardening (Model C tiered + D notify):
 *   - lib/frontier-authz.ts        decideAuthorization tiering (session vs forgeable,
 *                                  threshold, the phase-3 flip)
 *   - lib/frontier-approvals.ts    evaluateApproval / approvalMatchesSpend /
 *                                  isApprovalExpired + the one-tap revoke HMAC token
 *
 * Failure-mode-first (Rule 31): the amount-swap, the flip boundary, Gate-1 precedence
 * over a session approval, TTL expiry, single-use, token tamper / wrong-secret / aud.
 * Run: npx tsx scripts/_test-frontier-approvals.ts   (exit 0 = all pass)
 */
import crypto from "crypto";

// NEXTAUTH_SECRET must be present for the token round-trip tests. Set a deterministic
// test secret BEFORE importing the module (the module reads process.env at call time,
// so order is not strictly required, but be explicit).
const PRIOR_SECRET = process.env.NEXTAUTH_SECRET;
process.env.NEXTAUTH_SECRET = PRIOR_SECRET && PRIOR_SECRET.length >= 16 ? PRIOR_SECRET : "test-secret-frontier-approvals-0123456789";

import { decideAuthorization, type AuthorizationInput } from "../lib/frontier-authz";
import {
  evaluateApproval,
  approvalMatchesSpend,
  isApprovalExpired,
  signRevokeToken,
  verifyRevokeToken,
  APPROVAL_TTL_MS,
  type ApprovalRow,
} from "../lib/frontier-approvals";
import { DEFAULT_BANDS_BY_TIER, type SpendDecision, type SpendEvaluation } from "../lib/frontier-policy";
import type { CreditStanding, StandingLevel } from "../lib/frontier-standing";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const BANDS = DEFAULT_BANDS_BY_TIER.pro;
const THRESH = BANDS.justDoItPerTx; // the Model-C line
function ev(decision: SpendDecision, reason = "test_reason"): SpendEvaluation {
  return { decision, reason, effectiveBands: BANDS };
}
function st(earned: number, level: StandingLevel = "assist", score = 600): CreditStanding {
  return {
    score, level, earnedDailyBudgetUsd: earned,
    factors: { reliability: 0.5, discipline: 0.5, tenure: 0.5, diversity: 0.5, integrity: 1 },
    worldIdVerified: true,
  };
}
function decide(p: Partial<AuthorizationInput>) {
  return decideAuthorization({
    evaluation: ev("just_do_it"),
    standing: st(0.1, "audit"),     // low earned budget so the gate would otherwise ask_first
    reserveAwareSpentTodayUsd: 0,
    amountUsd: THRESH + 5,          // above threshold by default
    categoryKnown: true,
    justDoItPerTxUsd: THRESH,
    ...p,
  });
}

// ── decideAuthorization tiering ──

// (a) session approval is honored at ANY amount, including above threshold.
check("session-approved above threshold → authorized",
  decide({ sessionApproved: true, amountUsd: THRESH + 50 }).authorized === true);
check("session-approved → reason human_approved_session",
  decide({ sessionApproved: true }).reason === "human_approved_session");
check("session-approved → mode human_approved",
  decide({ sessionApproved: true }).mode === "human_approved");
check("session-approved below threshold → authorized",
  decide({ sessionApproved: true, amountUsd: Math.max(0.01, THRESH - 0.01) }).authorized === true);

// (b) forgeable above threshold, flip OFF (phase 1) → honored, reason human_approved (route notifies).
check("forgeable above threshold, flip OFF → authorized",
  decide({ humanApprovedForgeable: true, requireSessionAboveThreshold: false, amountUsd: THRESH + 50 }).authorized === true);
check("forgeable honored → reason human_approved (drives notify)",
  decide({ humanApprovedForgeable: true, requireSessionAboveThreshold: false }).reason === "human_approved");

// (c) forgeable above threshold, flip ON (phase 3) → NOT authorized, needs_session_approval.
check("forgeable above threshold, flip ON → not authorized",
  decide({ humanApprovedForgeable: true, requireSessionAboveThreshold: true, amountUsd: THRESH + 50 }).authorized === false);
check("forgeable above threshold, flip ON → reason needs_session_approval",
  decide({ humanApprovedForgeable: true, requireSessionAboveThreshold: true, amountUsd: THRESH + 50 }).reason === "needs_session_approval");
check("forgeable above threshold, flip ON → outcome ask_first",
  decide({ humanApprovedForgeable: true, requireSessionAboveThreshold: true, amountUsd: THRESH + 50 }).outcome === "ask_first");

// (d) forgeable BELOW threshold, flip ON → still honored (the band we already trust).
check("forgeable below threshold, flip ON → authorized",
  decide({ humanApprovedForgeable: true, requireSessionAboveThreshold: true, amountUsd: Math.max(0.01, THRESH - 0.01) }).authorized === true);
check("forgeable below threshold, flip ON → reason human_approved",
  decide({ humanApprovedForgeable: true, requireSessionAboveThreshold: true, amountUsd: Math.max(0.01, THRESH - 0.01) }).reason === "human_approved");
// boundary: amount EXACTLY == threshold is "above" (>=), so flip ON bounces it.
check("forgeable AT threshold, flip ON → needs_session_approval (>= is above)",
  decide({ humanApprovedForgeable: true, requireSessionAboveThreshold: true, amountUsd: THRESH }).reason === "needs_session_approval");

// (e) Gate 1 hard deny beats EVERYTHING, including a session approval.
check("hard deny + session-approved → still denied",
  decide({ evaluation: ev("deny", "exceeds_daily_ceiling"), sessionApproved: true }).authorized === false);
check("hard deny + session-approved → outcome deny",
  decide({ evaluation: ev("deny", "privacy_mode"), sessionApproved: true }).outcome === "deny");

// (f) session beats forgeable when both set (unforgeable wins, no notify).
check("session + forgeable both set → reason human_approved_session (session wins)",
  decide({ sessionApproved: true, humanApprovedForgeable: true }).reason === "human_approved_session");

// legacy back-compat: the old `humanApproved` field with NO tiered fields behaves
// exactly as before (honored at any amount, reason human_approved).
check("legacy humanApproved, no tiered fields → authorized",
  decideAuthorization({
    evaluation: ev("ask_first"), standing: st(0.1), reserveAwareSpentTodayUsd: 0,
    amountUsd: 9999, humanApproved: true, categoryKnown: true,
  }).authorized === true);
check("legacy humanApproved → reason human_approved",
  decideAuthorization({
    evaluation: ev("ask_first"), standing: st(0.1), reserveAwareSpentTodayUsd: 0,
    amountUsd: 9999, humanApproved: true, categoryKnown: true,
  }).reason === "human_approved");
// no approval of any kind → falls through to the autonomy gate unchanged.
check("no approval, over earned → ask_first exceeds_earned_budget",
  decide({ amountUsd: THRESH + 5 }).reason === "exceeds_earned_budget");

// ── evaluateApproval / approvalMatchesSpend / isApprovalExpired ──

const NOW = 1_900_000_000_000; // fixed
const fresh = new Date(NOW + APPROVAL_TTL_MS / 2).toISOString();
const stale = new Date(NOW - 1000).toISOString();
const spend = { amountUsd: 2.5, category: "data", counterparty: "0xabc" };
function row(over: Partial<ApprovalRow>): ApprovalRow {
  return { status: "approved", amount_usd: 2.5, category: "data", counterparty: "0xabc", expires_at: fresh, ...over };
}

check("approved + fresh + exact match → approved", evaluateApproval(row({}), spend, NOW) === "approved");
check("approved + amount mismatch → identity_mismatch", evaluateApproval(row({ amount_usd: 100 }), spend, NOW) === "identity_mismatch");
check("approved + category mismatch → identity_mismatch", evaluateApproval(row({ category: "media" }), spend, NOW) === "identity_mismatch");
check("approved + counterparty mismatch → identity_mismatch", evaluateApproval(row({ counterparty: "0xdef" }), spend, NOW) === "identity_mismatch");
check("pending_approval + fresh → pending", evaluateApproval(row({ status: "pending_approval" }), spend, NOW) === "pending");
check("approved + expired → none", evaluateApproval(row({ expires_at: stale }), spend, NOW) === "none");
check("denied → none", evaluateApproval(row({ status: "denied" }), spend, NOW) === "none");
check("consumed → none", evaluateApproval(row({ status: "consumed" }), spend, NOW) === "none");
check("expired status → none", evaluateApproval(row({ status: "expired" }), spend, NOW) === "none");
check("null row → none", evaluateApproval(null, spend, NOW) === "none");
// PostgREST returns numeric as string — must still match.
check("amount as string matches", approvalMatchesSpend(row({ amount_usd: "2.500000" }), spend) === true);
check("amount as string mismatch", approvalMatchesSpend(row({ amount_usd: "2.6" }), spend) === false);
// null category/counterparty on both sides is a match (both "unspecified").
check("null===null category/counterparty matches",
  approvalMatchesSpend(row({ category: null, counterparty: null }), { amountUsd: 2.5, category: null, counterparty: null }) === true);
check("null vs set category mismatch",
  approvalMatchesSpend(row({ category: null }), spend) === false);
// TTL helper directly.
check("isApprovalExpired fresh → false", isApprovalExpired(row({ expires_at: fresh }), NOW) === false);
check("isApprovalExpired stale → true", isApprovalExpired(row({ expires_at: stale }), NOW) === true);
check("isApprovalExpired unparseable → true (fail-safe)", isApprovalExpired(row({ expires_at: "not-a-date" }), NOW) === true);

// ── revoke token (HMAC) ──

const signed = signRevokeToken("vm-uuid-123", NOW);
check("sign ok with secret set", signed.ok === true);
if (signed.ok) {
  const v = verifyRevokeToken(signed.token, NOW + 1000);
  check("verify round-trip ok", v.ok === true);
  check("verify returns vmId", v.ok === true && v.vmId === "vm-uuid-123");
  // tamper the hmac → bad_sig
  const tampered = signed.token.slice(0, -2) + (signed.token.endsWith("00") ? "11" : "00");
  const vt = verifyRevokeToken(tampered, NOW + 1000);
  check("tampered hmac → not ok", vt.ok === false);
  // expired: verify far past the 24h TTL
  const ve = verifyRevokeToken(signed.token, NOW + (25 * 60 * 60 * 1000));
  check("past-TTL token → expired", ve.ok === false && (ve as { reason: string }).reason === "expired");
}
check("malformed token → malformed", verifyRevokeToken("garbage", NOW).ok === false);
check("empty token → malformed", verifyRevokeToken("", NOW).ok === false);
check("two-part token → malformed", verifyRevokeToken("a.b", NOW).ok === false);

// wrong-aud: hand-craft a token with the same secret but a different aud → bad_aud.
{
  const secret = process.env.NEXTAUTH_SECRET as string;
  const b64url = (s: string) => Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const payloadB64 = b64url(JSON.stringify({ vm: "vm-x", jti: "deadbeef", aud: "some-other-purpose" }));
  const exp = Math.floor(NOW / 1000) + 3600;
  const hmac = crypto.createHmac("sha256", secret).update(`${payloadB64}.${exp}`).digest("hex");
  const wrongAud = `${payloadB64}.${exp}.${hmac}`;
  const va = verifyRevokeToken(wrongAud, NOW);
  check("wrong-aud token (valid sig) → bad_aud", va.ok === false && (va as { reason: string }).reason === "bad_aud");
}

// missing secret → sign/verify fail gracefully (never throw).
{
  const saved = process.env.NEXTAUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;
  const noSecretSign = signRevokeToken("vm-y", NOW);
  check("sign without secret → ok:false (no throw)", noSecretSign.ok === false);
  const noSecretVerify = verifyRevokeToken("a.b.c", NOW);
  check("verify without secret → missing_secret", noSecretVerify.ok === false && (noSecretVerify as { reason: string }).reason === "missing_secret");
  process.env.NEXTAUTH_SECRET = saved;
}

console.log(`\nfrontier-approvals: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
