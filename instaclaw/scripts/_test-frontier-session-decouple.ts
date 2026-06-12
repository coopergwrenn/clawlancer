#!/usr/bin/env tsx
/**
 * The travel decouple (2026-06-12): hotel booking is NOT autonomous spending, so
 * session-required categories are exempt from the frontier_spend_enabled standing
 * mandate. This suite is the Rule-31 guarantee that the exemption can never widen
 * into an approval-free money path.
 *
 * Four blocks, each written to BREAK the guarantee, not to confirm it:
 *
 *   A. THE INVARIANT — every SESSION_REQUIRED_CATEGORIES member has $0 just-do-it
 *      bands under EVERY tier and under ADVERSARIAL overrides (an attacker/config
 *      bug trying to raise them). The nastiest future mistake — adding a category
 *      to the set without a $0-band layer — fails block A on every tier.
 *   B. THE MATRIX — the exact behavior table of the decouple (Cooper's five cases
 *      + the edges: ceiling-with-tap, privacy-with-tap, expired tap, null
 *      category, gate-order).
 *   C. THE DISCRIMINATION TEST — a lying agent labels an arbitrary spend
 *      category:"travel" to ride the exemption, then tries every consent shortcut
 *      it can forge. Each one must fail; only a tap bound to the EXACT
 *      amount@6dp + category + counterparty authorizes.
 *   D. BELT-AND-BRACES — blocksUnmandatedReserve catches the futures the
 *      structural guarantees can't: a session-required category that regained
 *      autonomous bands, a new authorizing branch, a corrupted decision where
 *      mode and reason disagree.
 *
 * Run: npx tsx scripts/_test-frontier-session-decouple.ts  (exit 0 = all pass)
 */
import {
  evaluateSpend,
  SESSION_REQUIRED_CATEGORIES,
  isSessionRequiredCategory,
  ALL_CATEGORIES,
  TRAVEL_MAX_PER_TX,
  type FrontierTier,
  type SpendCategory,
  type SpendEvaluation,
} from "../lib/frontier-policy";
import { decideAuthorization, blocksUnmandatedReserve, type AuthorizationInput } from "../lib/frontier-authz";
import { spendMandateSatisfied, isFrontierSpendEnabled } from "../lib/frontier-spend-optin";
import { evaluateApproval, approvalMatchesSpend, shouldRearmApproval, type ApprovalRow } from "../lib/frontier-approvals";
import type { CreditStanding } from "../lib/frontier-standing";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const TIERS: readonly FrontierTier[] = ["starter", "pro", "power"];

// A standing engineered to be MAXIMALLY permissive — if autonomy were possible
// anywhere, this agent would have it. The guarantee must hold even for it.
function godStanding(): CreditStanding {
  return {
    score: 850,
    level: "autopilot" as CreditStanding["level"],
    earnedDailyBudgetUsd: 1_000_000,
    factors: { reliability: 1, discipline: 1, tenure: 1, diversity: 1, integrity: 1 },
    worldIdVerified: true,
  };
}

function decideFor(
  category: SpendCategory,
  evaluation: SpendEvaluation,
  p: Partial<AuthorizationInput> = {},
) {
  return decideAuthorization({
    evaluation,
    standing: godStanding(),
    reserveAwareSpentTodayUsd: 0,
    amountUsd: 100,
    humanApprovedForgeable: false,
    sessionApproved: false,
    justDoItPerTxUsd: evaluation.effectiveBands.justDoItPerTx,
    requireSessionAboveThreshold: false, // pre-flip world — the guarantee must not depend on the flip
    disallowForgeableApproval: isSessionRequiredCategory(category),
    categoryKnown: true,
    ...p,
  });
}

/* ── A. THE INVARIANT — $0 bands for every session-required member, everywhere ── */

// Adversarial overrides: a config bug / hostile write trying to RAISE autonomy.
const ADVERSARIAL_OVERRIDES = [
  null,
  { justDoItPerTx: 500, justDoItPerDay: 5000 },
  { justDoItPerTx: 500, justDoItPerDay: 5000, neverPerTx: 999_999, neverPerDay: 999_999 },
  { justDoItPerTx: 0.01 }, // even a tiny raise is a raise
];

for (const cat of SESSION_REQUIRED_CATEGORIES) {
  for (const tier of TIERS) {
    for (const [i, ov] of ADVERSARIAL_OVERRIDES.entries()) {
      const e = evaluateSpend(tier, {
        amountUsd: 5,
        spentTodayUsd: 0,
        walletBalanceUsd: 10_000,
        privacyModeOn: false,
        counterpartyVerified: true,
        overrides: ov ?? undefined,
        category: cat,
      });
      check(
        `A: ${cat}/${tier}/ov${i} justDoItPerTx is $0 (got ${e.effectiveBands.justDoItPerTx})`,
        e.effectiveBands.justDoItPerTx === 0,
      );
      check(
        `A: ${cat}/${tier}/ov${i} justDoItPerDay is $0 (got ${e.effectiveBands.justDoItPerDay})`,
        e.effectiveBands.justDoItPerDay === 0,
      );
      check(
        `A: ${cat}/${tier}/ov${i} never evaluates just_do_it (got ${e.decision})`,
        e.decision !== "just_do_it",
      );
    }
  }
}

// The autonomy fuzz: across amounts, spent-today, balances — with a maximally
// permissive standing and NO consent of any kind, a session-required spend must
// never come back autonomous/authorized.
for (const cat of SESSION_REQUIRED_CATEGORIES) {
  for (const amount of [0.01, 0.99, 1, 5, 49.99, 100, 1199.99]) {
    for (const balance of [10_000, null]) {
      const e = evaluateSpend("power", {
        amountUsd: amount, spentTodayUsd: 0, walletBalanceUsd: balance,
        privacyModeOn: false, counterpartyVerified: true, category: cat,
      });
      const d = decideFor(cat, e, { amountUsd: amount });
      check(`A-fuzz: ${cat} $${amount} bal=${balance} never autonomous`, d.mode !== "autonomous");
      check(`A-fuzz: ${cat} $${amount} bal=${balance} never authorized w/o consent`, d.authorized === false);
    }
  }
}

// The membership cross-check: the exemption keys on the same predicate as the
// hardening — a category is exempt iff it is session-required, byte-identical set.
for (const cat of ALL_CATEGORIES) {
  const exemptWithoutOptIn = spendMandateSatisfied({ frontier_spend_enabled: false }, cat);
  check(
    `A-SoT: ${cat} mandate-exemption ⟺ session-required (exempt=${exemptWithoutOptIn})`,
    exemptWithoutOptIn === isSessionRequiredCategory(cat),
  );
}

/* ── B. THE MATRIX — the decouple's behavior table ─────────────────────────── */

const OFF = { frontier_spend_enabled: false };
const ON = { frontier_spend_enabled: true };
const travelEval = (amount: number, balance: number | null = 10_000, privacy = false, spent = 0) =>
  evaluateSpend("starter", {
    amountUsd: amount, spentTodayUsd: spent, walletBalanceUsd: balance,
    privacyModeOn: privacy, counterpartyVerified: true, category: "travel",
  });

// B1. OFF + travel passes the mandate gate (the decouple itself).
check("B1: OFF + travel — mandate satisfied (gate does not fire)", spendMandateSatisfied(OFF, "travel") === true);

// B2. OFF + travel + session tap → authorized via human_approved_session, reserve allowed.
{
  const d = decideFor("travel", travelEval(84.5), { amountUsd: 84.5, sessionApproved: true });
  check("B2: OFF + travel + tap → authorized", d.authorized === true);
  check("B2: reason is human_approved_session", d.reason === "human_approved_session");
  check("B2: belt-and-braces permits the session reserve", blocksUnmandatedReserve(d, false) === false);
}

// B3. OFF + travel, no tap → ask_first (the tap-able path), NOT spend_not_enabled.
{
  const d = decideFor("travel", travelEval(84.5), { amountUsd: 84.5 });
  check("B3: OFF + travel no tap → ask_first", d.outcome === "ask_first" && d.authorized === false);
  check("B3: reason is the band ask, not spend_not_enabled", d.reason === "within_ask_first_band");
}

// B4. OFF + travel + FORGED human_approved bool → needs_session_approval, never authorized.
{
  const d = decideFor("travel", travelEval(84.5), { amountUsd: 84.5, humanApprovedForgeable: true });
  check("B4: forged bool never authorizes travel", d.authorized === false);
  check("B4: reason is needs_session_approval", d.reason === "needs_session_approval");
}

// B5. OFF + every NON-session category → mandate NOT satisfied (spend_not_enabled
//     deny fires at the gate, before any approval lookup — behavior unchanged).
for (const cat of ALL_CATEGORIES.filter((c) => !isSessionRequiredCategory(c))) {
  check(`B5: OFF + ${cat} — mandate gate still fires`, spendMandateSatisfied(OFF, cat) === false);
}
check("B5: OFF + null/unknown category — mandate gate still fires", spendMandateSatisfied(OFF, null) === false);
check("B5: OFF + undefined category — mandate gate still fires", spendMandateSatisfied(OFF, undefined) === false);

// B6. ON → satisfied for everything (the standing mandate is the superset).
for (const cat of [...ALL_CATEGORIES, null] as const) {
  check(`B6: ON + ${cat ?? "null"} — satisfied`, spendMandateSatisfied(ON, cat) === true);
}

// B7. Empty wallet → would_drain_wallet HARD DENY — before any tap could matter,
//     and the tap cannot override it (Gate 1 precedes Gate 3).
{
  const e = travelEval(84.5, 3); // $3 in the wallet
  check("B7: empty wallet evaluates deny would_drain_wallet", e.decision === "deny" && e.reason === "would_drain_wallet");
  const d = decideFor("travel", e, { amountUsd: 84.5, sessionApproved: true });
  check("B7: tap does NOT override the drain deny", d.authorized === false && d.outcome === "deny");
}

// B8. Over the travel ceiling + tap → deny stands (a tap never lifts a hard limit).
{
  const e = travelEval(TRAVEL_MAX_PER_TX + 1);
  check("B8: over-ceiling evaluates deny", e.decision === "deny" && e.reason === "exceeds_per_tx_ceiling");
  const d = decideFor("travel", e, { amountUsd: TRAVEL_MAX_PER_TX + 1, sessionApproved: true });
  check("B8: tap does NOT lift the $1200 ceiling", d.authorized === false);
}

// B9. Privacy mode + tap → deny stands.
{
  const e = travelEval(84.5, 10_000, true);
  const d = decideFor("travel", e, { amountUsd: 84.5, sessionApproved: true });
  check("B9: privacy mode denies even with a tap", d.authorized === false && d.outcome === "deny");
}

// B10. Daily travel ceiling: $3000/day binds across bookings even with taps.
{
  const e = travelEval(500, 10_000, false, 2700); // $2700 already spent today
  check("B10: daily ceiling evaluates deny", e.decision === "deny" && e.reason === "exceeds_daily_ceiling");
}

// B11. Category override that EXCLUDES travel still hard-denies (the user's real
//      "turn travel off" lever survives the decouple).
{
  const e = evaluateSpend("starter", {
    amountUsd: 84.5, spentTodayUsd: 0, walletBalanceUsd: 10_000,
    privacyModeOn: false, counterpartyVerified: true,
    category: "travel", allowedCategories: ["data", "search"], // travel excluded
  });
  check("B11: excluded category hard-denies", e.decision === "deny" && e.reason === "category_not_allowed");
  const d = decideFor("travel", e, { amountUsd: 84.5, sessionApproved: true });
  check("B11: tap does NOT override the category exclusion", d.authorized === false);
}

/* ── C. THE DISCRIMINATION TEST — the lying agent, trying hard ─────────────── */
// A compromised agent labels an arbitrary $999 spend to an attacker address as
// category:"travel" to ride the opt-in exemption. Walk every shortcut it can
// reach from the VM (it holds the gateway token; it can NEVER hold the owner's
// browser session) and show each one failing.

const ATTACK = { amountUsd: 999, category: "travel" as SpendCategory, counterparty: "0xAttackerAddress" };
const NOW = 1_750_000_000_000;
const freshRow = (over: Partial<ApprovalRow>): ApprovalRow => ({
  status: "approved",
  amount_usd: 999,
  category: "travel",
  counterparty: "0xAttackerAddress",
  expires_at: new Date(NOW + 60_000).toISOString(),
  ...over,
});

// C1. The label alone changes nothing: no consent → ask_first, not authorized.
{
  const e = travelEval(999);
  const d = decideFor("travel", e, { amountUsd: 999 });
  check("C1: travel label alone → ask_first, no money", d.authorized === false);
}

// C2. The forgeable bool (the thing it CAN set from the VM) → blocked.
{
  const d = decideFor("travel", travelEval(999), { amountUsd: 999, humanApprovedForgeable: true });
  check("C2: forged bool → needs_session_approval", d.authorized === false && d.reason === "needs_session_approval");
}

// C3. No approval row exists (the human never tapped) → sessionApproved is false.
check("C3: no approval row → none", evaluateApproval(null, ATTACK, NOW) === "none");

// C4. It steals a REAL approval the human minted for a $84.50 hotel and replays
//     it against the $999 attack spend → identity_mismatch (amount binding).
{
  const legit = freshRow({ amount_usd: 84.5, counterparty: "https://travel-mcp.travala.com/mcp" });
  check("C4: $84.50 tap cannot authorize a $999 spend", evaluateApproval(legit, ATTACK, NOW) === "identity_mismatch");
}

// C5. Same amount, different counterparty → identity_mismatch (payee binding).
{
  const legit = freshRow({ counterparty: "https://travel-mcp.travala.com/mcp" });
  check("C5: same-amount different-payee → mismatch", evaluateApproval(legit, ATTACK, NOW) === "identity_mismatch");
}

// C6. Category swap: an approval minted for a travel spend replayed as "market"
//     → identity_mismatch (category binding).
check(
  "C6: category swap → mismatch",
  evaluateApproval(freshRow({}), { ...ATTACK, category: "market" as SpendCategory }, NOW) === "identity_mismatch",
);

// C7. A sub-6dp amount shave ($999 vs $999.000001) → still a mismatch.
check(
  "C7: 1-microdollar shave → mismatch",
  approvalMatchesSpend(freshRow({}), { ...ATTACK, amountUsd: 999.000001 }) === false,
);

// C8. An EXPIRED exact-match approval → none (TTL binds).
check(
  "C8: expired tap → none",
  evaluateApproval(freshRow({ expires_at: new Date(NOW - 1).toISOString() }), ATTACK, NOW) === "none",
);

// C9. A CONSUMED approval replayed → none (single-use binds).
check("C9: consumed tap → none", evaluateApproval(freshRow({ status: "consumed" }), ATTACK, NOW) === "none");

// C10. An unparseable expiry → treated as expired (fail-safe), never approved.
check(
  "C10: corrupt expiry fails safe",
  evaluateApproval(freshRow({ expires_at: "not-a-date" }), ATTACK, NOW) === "none",
);

// C11. The ONLY way through: the owner's browser session approves THIS exact spend.
//      The lie bought the attacker nothing the human didn't read and tap.
{
  check("C11: exact-bound fresh tap approves", evaluateApproval(freshRow({}), ATTACK, NOW) === "approved");
  const d = decideFor("travel", travelEval(999), { amountUsd: 999, sessionApproved: true });
  check("C11: …and only then does the gate authorize", d.authorized === true && d.reason === "human_approved_session");
}

/* ── D. BELT-AND-BRACES — the guard for futures the structure can't reach ──── */

// D1. The nightmare future: a session-required category WITHOUT a $0-band layer
//     (block A would fail, but suppose the suite was skipped). An autonomous
//     decision arrives at the reserve with no standing mandate → BLOCKED.
{
  const rogueAutonomous = { authorized: true, mode: "autonomous" as const, reason: "within_earned_budget" };
  check("D1: autonomous + no mandate → reserve blocked", blocksUnmandatedReserve(rogueAutonomous, false) === true);
  check("D1: autonomous + standing mandate → normal rules", blocksUnmandatedReserve(rogueAutonomous, true) === false);
}

// D2. A future forgeable-honored branch (or the F2 flag regressing) → BLOCKED.
{
  const forgeableHonored = { authorized: true, mode: "human_approved" as const, reason: "human_approved" };
  check("D2: forgeable-honored + no mandate → blocked", blocksUnmandatedReserve(forgeableHonored, false) === true);
}

// D3. FIELD AGREEMENT — a corrupted decision where reason and mode disagree
//     (refactor half-applied) must fail BOTH ways.
{
  const reasonOnly = { authorized: true, mode: "autonomous" as const, reason: "human_approved_session" };
  const modeOnly = { authorized: true, mode: "human_approved" as const, reason: "within_earned_budget" };
  check("D3: session reason + autonomous mode → blocked", blocksUnmandatedReserve(reasonOnly, false) === true);
  check("D3: human mode + non-session reason → blocked", blocksUnmandatedReserve(modeOnly, false) === true);
}

// D4. The legitimate path is untouched: session-approved + no mandate → permitted.
{
  const session = { authorized: true, mode: "human_approved" as const, reason: "human_approved_session" };
  check("D4: session-approved reserve permitted without mandate", blocksUnmandatedReserve(session, false) === false);
}

// D5. Unauthorized decisions are not the guard's business (nothing to reserve).
{
  const denied = { authorized: false, mode: null, reason: "exceeds_per_tx_ceiling" };
  check("D5: non-authorized decision → guard inert", blocksUnmandatedReserve(denied, false) === false);
}

// D6. isFrontierSpendEnabled stays strictly fail-closed (the decouple must not
//     have loosened the primitive itself).
for (const [v, want] of [[true, true], [false, false], [null, false], [undefined, false]] as const) {
  check(`D6: isFrontierSpendEnabled(${String(v)}) === ${want}`, isFrontierSpendEnabled({ frontier_spend_enabled: v }) === want);
}
check("D6: isFrontierSpendEnabled(no vm) === false", isFrontierSpendEnabled(null) === false);

/* ── E. THE RE-ARM DECISION — the >15-min-tap deadlock stays dead ──────────── */
// request_id is single-use (the pay nonce derives from it) and the approvals
// table is unique on (vm_id, request_id) — so each booking has exactly ONE
// approval row forever. shouldRearmApproval decides when mint may RESET that
// row to a fresh pending instead of handing back a dead one (the deadlock).

{
  const row = (over: Partial<ApprovalRow>): ApprovalRow => ({
    status: "pending_approval", amount_usd: 84.5, category: "travel",
    counterparty: "https://travel-mcp.travala.com/mcp",
    expires_at: new Date(NOW + 60_000).toISOString(), ...over,
  });
  // The quiet cases — a live flow must NEVER be clobbered:
  check("E1: live pending → NO re-arm (the 5s poll must not reset the TTL)", shouldRearmApproval(row({}), NOW) === false);
  check("E1: fresh approved → NO re-arm (it authorizes on this very call)", shouldRearmApproval(row({ status: "approved" }), NOW) === false);
  // The dead-end states the fix exists for:
  check("E2: expired status → re-arm (the >15-min-tap deadlock)", shouldRearmApproval(row({ status: "expired" }), NOW) === true);
  check("E2: denied → re-arm (changed-mind path; deny still binds until a fresh tap)", shouldRearmApproval(row({ status: "denied" }), NOW) === true);
  check("E2: pending PAST TTL (lazily expired) → re-arm", shouldRearmApproval(row({ expires_at: new Date(NOW - 1).toISOString() }), NOW) === true);
  check("E2: approved PAST TTL (tapped, never resumed) → re-arm", shouldRearmApproval(row({ status: "approved", expires_at: new Date(NOW - 1).toISOString() }), NOW) === true);
  check("E2: corrupt expiry on pending → re-arm (fail-safe expiry)", shouldRearmApproval(row({ expires_at: "not-a-date" }), NOW) === true);
  // The hard line — consumed is terminal in EVERY timing:
  check("E3: consumed, fresh → NEVER re-arm", shouldRearmApproval(row({ status: "consumed" }), NOW) === false);
  check("E3: consumed, past TTL → NEVER re-arm", shouldRearmApproval(row({ status: "consumed", expires_at: new Date(NOW - 1).toISOString() }), NOW) === false);
  // Composition with the authorize verdict: every re-arm-eligible row is one
  // evaluateApproval already refuses (the fix can't widen consent — a dead row
  // never authorized anything, before or after re-arm).
  for (const dead of [row({ status: "expired" }), row({ status: "denied" }), row({ expires_at: new Date(NOW - 1).toISOString() })]) {
    check(`E4: re-arm-eligible (${dead.status}) is non-authorizing pre-re-arm`,
      evaluateApproval(dead, { amountUsd: 84.5, category: "travel" as SpendCategory, counterparty: "https://travel-mcp.travala.com/mcp" }, NOW) === "none");
  }
  // And a re-armed row (fresh pending) is PENDING — still not authorizing:
  check("E4: post-re-arm shape (fresh pending) → pending, not approved",
    evaluateApproval(row({}), { amountUsd: 84.5, category: "travel" as SpendCategory, counterparty: "https://travel-mcp.travala.com/mcp" }, NOW) === "pending");
}

/* ── verdict ───────────────────────────────────────────────────────────────── */
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
