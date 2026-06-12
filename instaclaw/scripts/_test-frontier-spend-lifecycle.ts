#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-spend-lifecycle.ts (red-team F4 — the SQL trigger's spec mirror).
 *
 * Proves the INVARIANT, not just a happy path: every revoking transition clears, every
 * non-revoking transition does NOT (incl. the canary enable/disable dance, inactivity-
 * suspend, 'failed', thaw-to-same-owner), and the stale-authority audit primitive. The
 * SQL trigger must match this; the live-probe proves they agree on a real DB write.
 * Run: npx tsx scripts/_test-frontier-spend-lifecycle.ts
 */
import {
  shouldRevokeSpendAuthority,
  hasStaleSpendAuthority,
  SPEND_REVOKING_TERMINAL_STATUSES,
  type VmLifecycleState,
} from "../lib/frontier-spend-lifecycle";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}
const A = "user-A";
const B = "user-B";
const s = (assignedTo: string | null, status: string | null): VmLifecycleState => ({ assignedTo, status });
const revoke = (o: VmLifecycleState, n: VmLifecycleState) => shouldRevokeSpendAuthority(o, n);

// ── REVOKING transitions (must clear) ──
check("unassign (A → null) → revoke", revoke(s(A, "assigned"), s(null, "assigned")) === true);
check("reassign (A → B, direct) → revoke", revoke(s(A, "assigned"), s(B, "assigned")) === true);
check("fresh-assign (null → B) → revoke (new owner never inherits)", revoke(s(null, "ready"), s(B, "assigned")) === true);
check("freeze (assigned → frozen, same owner) → revoke", revoke(s(A, "assigned"), s(A, "frozen")) === true);
check("terminate (assigned → terminated, same owner) → revoke", revoke(s(A, "assigned"), s(A, "terminated")) === true);
check("freeze AND unassign in one write → revoke", revoke(s(A, "assigned"), s(null, "frozen")) === true);

// ── NON-revoking transitions (must NOT clear) ──
check("no-op (A/assigned → A/assigned) → no revoke", revoke(s(A, "assigned"), s(A, "assigned")) === false);
check("enable/disable dance: status+owner unchanged (only the flag moves) → no revoke",
  revoke(s(A, "assigned"), s(A, "assigned")) === false);
check("'failed' (assigned → failed, transient/recoverable) → no revoke", revoke(s(A, "assigned"), s(A, "failed")) === false);
check("thaw (frozen → assigned, SAME owner) → no revoke (already false from freeze; re-enable required)",
  revoke(s(A, "frozen"), s(A, "assigned")) === false);
check("status ready → assigned, same (null) owner — wait: owner null→null, status non-terminal → no revoke",
  revoke(s(null, "ready"), s(null, "provisioning")) === false);
// inactivity-suspend is health_status (NOT modeled here — status/assigned unchanged) → no revoke.
check("inactivity-suspend (status + assigned_to unchanged) → no revoke (health_status not a trigger column)",
  revoke(s(A, "assigned"), s(A, "assigned")) === false);

// thaw that REASSIGNS to a different owner → revoke (ownership changed) — the one thaw that clears.
check("thaw-and-reassign (frozen/A → assigned/B) → revoke (ownership changed)",
  revoke(s(A, "frozen"), s(B, "assigned")) === true);

// ── null handling ──
check("null → null owner, terminal status → revoke (status terminal)", revoke(s(null, "assigned"), s(null, "terminated")) === true);
check("null owner, status unchanged null → null → no revoke", revoke(s(null, null), s(null, null)) === false);

// ── SPEND_REVOKING_TERMINAL_STATUSES is exactly {frozen, terminated} ──
check("terminal set = frozen + terminated", SPEND_REVOKING_TERMINAL_STATUSES.length === 2
  && SPEND_REVOKING_TERMINAL_STATUSES.includes("frozen") && SPEND_REVOKING_TERMINAL_STATUSES.includes("terminated"));
check("'suspended' is NOT a revoking terminal status", !SPEND_REVOKING_TERMINAL_STATUSES.includes("suspended"));
check("'failed' is NOT a revoking terminal status", !SPEND_REVOKING_TERMINAL_STATUSES.includes("failed"));

// ── hasStaleSpendAuthority (Rule-27 audit) ──
check("enabled + assigned + healthy status → NOT stale",
  hasStaleSpendAuthority({ frontier_spend_enabled: true, assigned_to: A, status: "assigned" }) === false);
check("enabled + UNASSIGNED → stale", hasStaleSpendAuthority({ frontier_spend_enabled: true, assigned_to: null, status: "assigned" }) === true);
check("enabled + FROZEN → stale", hasStaleSpendAuthority({ frontier_spend_enabled: true, assigned_to: A, status: "frozen" }) === true);
check("enabled + TERMINATED → stale", hasStaleSpendAuthority({ frontier_spend_enabled: true, assigned_to: A, status: "terminated" }) === true);
check("DISABLED + unassigned → NOT stale", hasStaleSpendAuthority({ frontier_spend_enabled: false, assigned_to: null, status: "terminated" }) === false);
check("null flag + unassigned → NOT stale", hasStaleSpendAuthority({ frontier_spend_enabled: null, assigned_to: null, status: "frozen" }) === false);
check("enabled + 'failed' status (not terminal) + assigned → NOT stale",
  hasStaleSpendAuthority({ frontier_spend_enabled: true, assigned_to: A, status: "failed" }) === false);

console.log(`\nfrontier-spend-lifecycle: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
