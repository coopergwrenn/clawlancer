/**
 * complete-set.ts — "never act destructively on a set you can't prove is complete."
 *
 * THE CLASS THIS KILLS (INC-2026-06-12):
 *   The vm-lifecycle orphan reaper built a Map of DB rows from a bare
 *   PostgREST select:
 *
 *     const { data } = await supabase.from("instaclaw_vms")
 *       .select("...").eq("provider", "linode");   // ← NO limit, NO pagination
 *
 *   PostgREST silently caps every response at 1000 rows. The table had 1004.
 *   So 4 PRESENT rows were absent from the Map. The reaper deletes a running
 *   Linode when its id is ABSENT from that Map ("not in DB → orphan"). Result:
 *   13 customer VMs deleted over ~2.3 days, 10 of them paying, 0 recoverable
 *   (no snapshots). 100% were false positives — there were zero real orphans.
 *
 *   The bug is generic: ANY destructive decision (delete / suspend / hibernate
 *   / freeze) that keys on a row's ABSENCE from a fetched set has this latent
 *   shape. The cure is an invariant, not a one-off limit bump:
 *
 *     Before you act on absence, PROVE the set is complete — paginate to
 *     exhaustion AND assert fetched.length === count(*). On any mismatch,
 *     FAIL CLOSED (throw) and let the caller skip the destructive work.
 *
 * USE THIS — never a bare `.select()` — whenever absence-from-the-result
 * drives a destructive action. See CLAUDE.md Rule 85.
 */

import type { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

type SupabaseLike = ReturnType<typeof getSupabase>;

/**
 * Thrown when a set cannot be proven complete. Catching code MUST treat this
 * as "do not make any absence-based destructive decision this run" — skip the
 * work, alert, and retry next cycle. Never swallow it and proceed.
 */
export class IncompleteFetchError extends Error {
  readonly table: string;
  readonly fetched: number;
  readonly expected: number;
  readonly context?: string;

  constructor(p: { table: string; fetched: number; expected: number; context?: string }) {
    super(
      `IncompleteFetch on "${p.table}": fetched ${p.fetched} rows but server count(*) = ${p.expected}` +
        (p.context ? ` (${p.context})` : "") +
        `. Refusing to make a destructive decision from row-absence on a provably-incomplete set.`,
    );
    this.name = "IncompleteFetchError";
    this.table = p.table;
    this.fetched = p.fetched;
    this.expected = p.expected;
    this.context = p.context;
  }
}

export interface FetchAllOpts {
  /** Table name, e.g. "instaclaw_vms". */
  table: string;
  /** Column list for the row pages (the count query ignores it). */
  columns: string;
  /**
   * Apply the SAME filters to BOTH the count query and every row page. If the
   * filters differ between count and pages, the completeness assertion is
   * meaningless. Keep this a pure filter applier: `(q) => q.eq("provider","linode")`.
   */
  applyFilters?: (q: any) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Page size. Default 1000 (PostgREST's typical cap; .range pages around it). */
  pageSize?: number;
  /** Free-text context for logs + error messages, e.g. the calling pass name. */
  context?: string;
}

/**
 * Fetch EVERY row matching a query, with a completeness proof, or throw.
 *
 * 1. Read the exact `count(*)` (HEAD request — no rows transferred).
 * 2. Page through with `.range(from, to)` until `count` rows are collected.
 * 3. Assert collected.length === count. Throw IncompleteFetchError on mismatch
 *    (cap hit, page error, or count drift from concurrent writes — all of which
 *    mean we cannot trust an absence decision, so we fail closed).
 *
 * Returns the complete array of rows (possibly empty). The ONLY way this returns
 * normally is if every matching row is present.
 */
export async function fetchAllOrThrow<T = Record<string, unknown>>(
  supabase: SupabaseLike,
  opts: FetchAllOpts,
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000;
  const applyFilters = opts.applyFilters ?? ((q: any) => q); // eslint-disable-line @typescript-eslint/no-explicit-any

  // 1) Exact count — HEAD, no body.
  const { count, error: countErr } = await applyFilters(
    supabase.from(opts.table).select("id", { count: "exact", head: true }),
  );
  if (countErr) {
    // Can't establish the denominator → cannot prove completeness → fail closed.
    throw new IncompleteFetchError({
      table: opts.table,
      fetched: 0,
      expected: -1,
      context: `count query failed: ${countErr.message}${opts.context ? `; ${opts.context}` : ""}`,
    });
  }
  const expected = count ?? 0;
  if (expected === 0) return [];

  // 2) Page through with .range until we've pulled `expected` rows.
  const rows: T[] = [];
  for (let from = 0; from < expected; from += pageSize) {
    const to = Math.min(from + pageSize - 1, expected - 1);
    const { data, error } = await applyFilters(
      supabase.from(opts.table).select(opts.columns),
    ).range(from, to);
    if (error) {
      throw new IncompleteFetchError({
        table: opts.table,
        fetched: rows.length,
        expected,
        context: `page [${from}-${to}] failed: ${error.message}${opts.context ? `; ${opts.context}` : ""}`,
      });
    }
    if (!data || data.length === 0) break; // count shrank under us → mismatch below
    rows.push(...(data as T[]));
  }

  // 3) The load-bearing assertion. Equality both ways: a short read means the
  //    cap/pagination truncated us; an over-read means count drifted. Either
  //    way an absence decision would be unsafe.
  if (rows.length !== expected) {
    throw new IncompleteFetchError({
      table: opts.table,
      fetched: rows.length,
      expected,
      context: opts.context,
    });
  }

  logger.info("fetchAllOrThrow: complete set verified", {
    route: "lib/complete-set",
    table: opts.table,
    rows: rows.length,
    context: opts.context ?? null,
  });
  return rows;
}
