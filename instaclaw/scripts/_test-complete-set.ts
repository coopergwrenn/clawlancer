/**
 * _test-complete-set.ts — discrimination tests for the Rule 85 fix (INC-2026-06-12).
 *
 * These are the tests that would have caught the orphan-reaper bug before it
 * shipped:
 *   - seed 1001+ rows, prove the fetch returns ALL of them and the map equals
 *     count(*) → the reaper finds ZERO false orphans;
 *   - feed a fetch whose pages can't deliver count(*) (the 1004→1000 cap
 *     signature) → fetchAllOrThrow ABORTS (throws) instead of returning a
 *     truncated set → the reaper deletes nothing.
 *
 * Run: npx tsx scripts/_test-complete-set.ts
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

type Row = { id: string; provider_server_id: number; status: string };

/**
 * Minimal supabase-builder mock. Honors:
 *   - count/head query (returns countOverride ?? rows.length, or countErr)
 *   - .range(from,to) paging, with an optional per-response `pageCap` that
 *     simulates PostgREST's hard cap (a single response can't exceed it).
 */
function makeMock(
  rows: Row[],
  opts: { pageCap?: number; countErr?: boolean; countOverride?: number } = {},
) {
  return {
    from() {
      let isCount = false;
      const b: any = {
        select(_cols: string, o?: { head?: boolean; count?: string }) {
          if (o && o.head) isCount = true;
          return b;
        },
        eq() {
          return b;
        },
        range(from: number, to: number) {
          let slice = rows.slice(from, to + 1);
          if (opts.pageCap != null && slice.length > opts.pageCap) {
            slice = slice.slice(0, opts.pageCap);
          }
          return Promise.resolve({ data: slice, error: null });
        },
        then(resolve: (v: any) => void) {
          // Only the count(head) query is awaited without .range().
          if (isCount) {
            if (opts.countErr) return resolve({ count: null, error: { message: "count boom" } });
            return resolve({ count: opts.countOverride ?? rows.length, error: null });
          }
          return resolve({ data: rows, error: null });
        },
      };
      return b;
    },
  };
}

function rows(n: number, startPsid = 90000000): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    provider_server_id: startPsid + i,
    status: "assigned",
  }));
}

/** Replicates the reaper's candidate predicate: a running Linode is an orphan
 *  candidate iff its psid is ABSENT from the (complete) DB map, or its row is
 *  in a dead status. This is the decision the completeness guard protects. */
function orphanCandidates(
  runningPsids: number[],
  dbByPsid: Map<string, Row>,
  deadStatuses: Set<string>,
): number[] {
  const out: number[] = [];
  for (const id of runningPsids) {
    const dbRow = dbByPsid.get(String(id));
    const isNotInDb = !dbRow;
    const isDbDead = !!dbRow && deadStatuses.has(dbRow.status ?? "");
    if (isNotInDb || isDbDead) out.push(id);
  }
  return out;
}

async function main() {
  const dead = new Set(["terminated", "failed", "destroyed"]);

  // ── Test 1: 1001 assigned rows → complete fetch, map === count, ZERO orphans
  console.log("Test 1: 1001 assigned rows → complete fetch + zero false orphans");
  {
    const data = rows(1001);
    const fetched = await fetchAllOrThrow<Row>(makeMock(data) as any, {
      table: "instaclaw_vms",
      columns: "id, provider_server_id, status",
      applyFilters: (q) => q.eq("provider", "linode"),
    });
    ok("fetched all 1001 (not capped at 1000)", fetched.length === 1001, `got ${fetched.length}`);
    const map = new Map<string, Row>();
    for (const r of fetched) map.set(String(r.provider_server_id), r);
    ok("dbByPsid.size === count(*)", map.size === data.length, `${map.size} vs ${data.length}`);
    const running = data.map((r) => r.provider_server_id); // all 1001 are running + assigned
    const cands = orphanCandidates(running, map, dead);
    ok("ZERO orphan candidates (the bug would have flagged the overflow rows)", cands.length === 0, `got ${cands.length}`);
  }

  // ── Test 2: count(*) says 1004 but pages deliver only 1000 (THE cap signature)
  console.log("Test 2: count=1004 but only 1000 fetchable → ABORT (throw), not truncate");
  {
    const data = rows(1000); // pages can only ever yield 1000
    let threw: IncompleteFetchError | null = null;
    try {
      await fetchAllOrThrow<Row>(makeMock(data, { countOverride: 1004 }) as any, {
        table: "instaclaw_vms",
        columns: "id, provider_server_id, status",
        context: "test",
      });
    } catch (e) {
      if (e instanceof IncompleteFetchError) threw = e;
    }
    ok("threw IncompleteFetchError", threw !== null);
    ok("error reports fetched=1000, expected=1004", threw?.fetched === 1000 && threw?.expected === 1004, `${threw?.fetched}/${threw?.expected}`);
  }

  // ── Test 3: misconfigured pageSize > PostgREST per-response cap → ABORT
  console.log("Test 3: pageSize 2000 but DB caps each response at 1000 → ABORT");
  {
    const data = rows(1004);
    let threw = false;
    try {
      await fetchAllOrThrow<Row>(makeMock(data, { pageCap: 1000 }) as any, {
        table: "instaclaw_vms",
        columns: "id, provider_server_id, status",
        pageSize: 2000, // asks for 1004 in one page; cap truncates to 1000
      });
    } catch (e) {
      threw = e instanceof IncompleteFetchError;
    }
    ok("threw IncompleteFetchError on capped over-large page", threw);
  }

  // ── Test 4: count query error → ABORT (can't establish denominator)
  console.log("Test 4: count query error → ABORT");
  {
    let threw = false;
    try {
      await fetchAllOrThrow<Row>(makeMock(rows(10), { countErr: true }) as any, {
        table: "instaclaw_vms",
        columns: "id, provider_server_id, status",
      });
    } catch (e) {
      threw = e instanceof IncompleteFetchError;
    }
    ok("threw IncompleteFetchError on count error", threw);
  }

  // ── Test 5: the reaper's guard — on IncompleteFetchError it deletes NOTHING
  console.log("Test 5: reaper aborts (deletes nothing) when fetch can't be proven complete");
  {
    let deletions = 0;
    let running = rows(1004).map((r) => r.provider_server_id);
    const dbByPsid = new Map<string, Row>();
    try {
      const all = await fetchAllOrThrow<Row>(makeMock(rows(1000), { countOverride: 1004 }) as any, {
        table: "instaclaw_vms",
        columns: "id, provider_server_id, status",
      });
      for (const r of all) dbByPsid.set(String(r.provider_server_id), r);
    } catch (e) {
      if (e instanceof IncompleteFetchError) running = []; // fail closed (the route's behavior)
    }
    for (const _ of orphanCandidates(running, dbByPsid, dead)) deletions++;
    ok("zero deletions after abort", deletions === 0, `got ${deletions}`);
  }

  // ── Test 6: prove WHY completeness matters — a truncated map yields a false
  //            positive (this is exactly what shipped). The guard prevents the
  //            truncated map from ever reaching the loop.
  console.log("Test 6: a truncated map WOULD delete a present VM (the bug, demonstrated)");
  {
    const data = rows(1001);
    const truncated = new Map<string, Row>();
    for (const r of data.slice(0, 1000)) truncated.set(String(r.provider_server_id), r); // drop row #1001
    const running = data.map((r) => r.provider_server_id); // all 1001 running
    const cands = orphanCandidates(running, truncated, dead);
    ok("truncated map → exactly 1 false orphan candidate (the deleted customer)", cands.length === 1, `got ${cands.length}`);
  }

  // ── Test 7: empty table → [] (no throw)
  console.log("Test 7: empty table → [] (no throw, no false work)");
  {
    const fetched = await fetchAllOrThrow<Row>(makeMock([]) as any, {
      table: "instaclaw_vms",
      columns: "id, provider_server_id, status",
    });
    ok("empty → []", Array.isArray(fetched) && fetched.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
