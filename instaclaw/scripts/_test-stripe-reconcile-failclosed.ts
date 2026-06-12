/**
 * _test-stripe-reconcile-failclosed.ts — Rule 85 discrimination tests for the
 * stripe-reconcile fix (INC-2026-06-12 follow-up).
 *
 * Same shape as the reaper's test: prove that when the users/subs sets can be
 * proven complete the reconcile proceeds correctly, and when they can't,
 * stripe-reconcile FAILS CLOSED — reconciles nothing, marks zero subs canceled
 * — instead of acting on a truncated set (which would leave paying users
 * unsynced → wrongful hibernate, or mark an active sub canceled).
 *
 * Run: npx tsx scripts/_test-stripe-reconcile-failclosed.ts
 */
import { fetchAllOrThrow, IncompleteFetchError } from "../lib/complete-set";

let pass = 0,
  fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

type Row = Record<string, unknown> & { id?: string; user_id?: string };

// Same minimal supabase-builder mock as _test-complete-set.ts. `countOverride`
// simulates "count(*) says more than the pages can deliver" — the exact 1004→
// 1000 cap signature.
function makeMock(rows: Row[], opts: { countOverride?: number } = {}) {
  return {
    from() {
      let isCount = false;
      const b: any = {
        select(_c: string, o?: { head?: boolean }) {
          if (o && o.head) isCount = true;
          return b;
        },
        eq() {
          return b;
        },
        not() {
          return b;
        },
        range(from: number, to: number) {
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
        then(resolve: (v: any) => void) {
          if (isCount) return resolve({ count: opts.countOverride ?? rows.length, error: null });
          return resolve({ data: rows, error: null });
        },
      };
      return b;
    },
  };
}

function users(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.com`, stripe_customer_id: `cus_${i}` }));
}
function subs(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, user_id: `u${i}`, status: "active", stripe_customer_id: `cus_${i}` }));
}

/**
 * Replicates stripe-reconcile's fetch-phase contract: fetch BOTH sets via
 * fetchAllOrThrow; on IncompleteFetchError, ABORT (reconcile nothing, zero
 * cancels). Returns what the route would have done.
 */
async function reconcileFetchPhase(
  usersMock: any,
  subsMock: any,
): Promise<{ aborted: boolean; userMapSize: number; dbSubMapSize: number; cancelsApplied: number }> {
  let uRows: Row[];
  let sRows: Row[];
  try {
    uRows = await fetchAllOrThrow<Row>(usersMock, {
      table: "instaclaw_users",
      columns: "id, email, stripe_customer_id",
      applyFilters: (q) => q.not("stripe_customer_id", "is", null),
    });
    sRows = await fetchAllOrThrow<Row>(subsMock, { table: "instaclaw_subscriptions", columns: "*" });
  } catch (e) {
    if (e instanceof IncompleteFetchError) {
      // Fail closed — exactly the route's behavior: no maps, no Step 6, no cancels.
      return { aborted: true, userMapSize: 0, dbSubMapSize: 0, cancelsApplied: 0 };
    }
    throw e;
  }
  const userByCustomerId = new Map<string, Row>();
  for (const u of uRows) if (u.stripe_customer_id) userByCustomerId.set(u.stripe_customer_id as string, u);
  const dbSubByUserId = new Map<string, Row>();
  for (const s of sRows) dbSubByUserId.set(s.user_id as string, s);
  // Step 6 (simulated): with a complete stripeMap (here: all users still active
  // in Stripe), zero active DB subs should be marked canceled. The point of the
  // test is the ABORT path; this asserts the happy path does no spurious cancels.
  let cancelsApplied = 0;
  for (const s of sRows) {
    if (s.status === "active" && !userByCustomerId.has(s.stripe_customer_id as string)) cancelsApplied++;
  }
  return { aborted: false, userMapSize: userByCustomerId.size, dbSubMapSize: dbSubByUserId.size, cancelsApplied };
}

async function main() {
  // ── Test 1: complete (1001 users + 1001 subs) → proceeds, maps complete, 0 spurious cancels
  console.log("Test 1: 1001 users + 1001 subs → reconcile proceeds, maps === count, 0 spurious cancels");
  {
    const r = await reconcileFetchPhase(makeMock(users(1001)), makeMock(subs(1001)));
    ok("not aborted", !r.aborted);
    ok("userByCustomerId.size === 1001 (not capped at 1000)", r.userMapSize === 1001, `${r.userMapSize}`);
    ok("dbSubByUserId.size === 1001", r.dbSubMapSize === 1001, `${r.dbSubMapSize}`);
    ok("zero spurious cancels on a complete set", r.cancelsApplied === 0, `${r.cancelsApplied}`);
  }

  // ── Test 2: users truncated (count 1004, 1000 fetchable) → ABORT, reconcile NOTHING
  console.log("Test 2: users count=1004 but 1000 fetchable → ABORT, zero cancels");
  {
    const r = await reconcileFetchPhase(makeMock(users(1000), { countOverride: 1004 }), makeMock(subs(1000)));
    ok("aborted", r.aborted);
    ok("zero cancels applied (fail-closed, no Step 6)", r.cancelsApplied === 0);
    ok("no maps built", r.userMapSize === 0 && r.dbSubMapSize === 0);
  }

  // ── Test 3: subs truncated → ABORT (the destructive set itself incomplete)
  console.log("Test 3: subscriptions count=1004 but 1000 fetchable → ABORT, zero cancels");
  {
    const r = await reconcileFetchPhase(makeMock(users(1000)), makeMock(subs(1000), { countOverride: 1004 }));
    ok("aborted", r.aborted);
    ok("zero cancels applied", r.cancelsApplied === 0);
  }

  // ── Test 4: prove WHY — a truncated users map would orphan a paying customer's sub
  //            (the indirect → wrongful-hibernate chain), which the abort prevents.
  console.log("Test 4: truncated users map would orphan a present sub (the chain the abort prevents)");
  {
    // Simulate the OLD behavior: build maps from a truncated users set (1000 of
    // 1001) while subs has all 1001. The 1001st user's active sub now maps to a
    // customer absent from userByCustomerId → in the real Step 6, if that sub
    // also weren't in stripeMap it'd be wrongly canceled; here we show the map
    // gap that the fail-closed guard refuses to act on.
    const truncatedUsers = new Map<string, Row>();
    for (const u of users(1000)) truncatedUsers.set(u.stripe_customer_id as string, u); // dropped u1000
    const missing = subs(1001).filter((s) => !truncatedUsers.has(s.stripe_customer_id as string));
    ok("truncated users map → exactly 1 sub with no matching user (the orphaned payer)", missing.length === 1, `${missing.length}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
