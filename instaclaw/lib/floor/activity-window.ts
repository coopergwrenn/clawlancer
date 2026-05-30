/**
 * The Floor — activity windowing / keyset cursor (docs/prd/the-floor.md §10.1).
 *
 * The contract between GET /api/floor/activity and the client store. Fixing H1
 * (the build-notes audit): a blind "newest 50" window + client-side cursor
 * search can SKIP events when more than the page size arrives between two polls
 * — and a skipped `message_in` is a missed perk-up, which defeats the whole
 * feature. The fix: the SERVER filters strictly-new rows via a composite
 * (created_at, id) KEYSET cursor and drains them in chronological order, so no
 * event is ever skipped — at worst a flood is delayed across a few poll cycles.
 *
 * Because a turn's `message_in` is the OLDEST event of its burst (the user
 * sends, THEN the agent works for 60–90s), it is always folded first, so the
 * perk-up never lags even under a heavy `working`/`tool` flood.
 *
 * This module holds:
 *   - the cursor type + helpers (shared by store + route),
 *   - `selectNewActivity`, a PURE MODEL of the server SQL. The route's Supabase
 *     query MUST mirror it exactly (see the cross-reference comment in
 *     app/api/floor/activity/route.ts). The model lets the overflow test prove
 *     the drain contract with no database.
 *
 * Precision note (load-bearing): the cursor's `ts` is the RAW `created_at`
 * string PostgREST returns (full microsecond precision). It is sent back to the
 * server verbatim and compared by Postgres at full precision. The client must
 * NOT do millisecond timestamp math for correctness — `Date.parse` truncates to
 * ms and could wrongly drop a row that shares a millisecond with the cursor.
 * The only client-side guard is an exact same-id dedupe (`dedupeAgainstCursor`),
 * which can never drop a genuinely-new event.
 */

/** A row's minimal identity for ordering — matches the activity table. */
export interface ActivityKeysetRow {
  id: string;
  created_at: string;
}

/** Composite keyset cursor: "the newest row we've already folded." */
export interface ActivityCursor {
  /** Raw PostgREST `created_at` string — full precision, compared by SQL. */
  ts: string;
  id: string;
}

/** Build a cursor from a row. */
export function rowCursor(row: ActivityKeysetRow): ActivityCursor {
  return { ts: row.created_at, id: row.id };
}

/** The newest cursor in a chronological (oldest→newest) batch, or null. */
export function newestCursor(
  rowsChrono: ActivityKeysetRow[],
): ActivityCursor | null {
  if (rowsChrono.length === 0) return null;
  return rowCursor(rowsChrono[rowsChrono.length - 1]);
}

/**
 * Total order over rows: by created_at, then id. Returns <0 / 0 / >0.
 *
 * Uses `Date.parse` for the time component — fine for the PURE MODEL because
 * test fixtures use clean millisecond timestamps, and for the store's defensive
 * use it's never the correctness path (the SERVER does the real comparison at
 * full precision). Id is the deterministic tiebreaker for same-instant rows.
 */
export function compareRows(
  a: ActivityKeysetRow,
  b: ActivityKeysetRow,
): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * PURE MODEL of the server query. Given ALL of a vm's rows (chronological), a
 * cursor, and a page limit, return the strictly-newer page in chronological
 * order. The route's SQL mirrors this:
 *
 *   WHERE vm_id = $vm
 *     AND ( created_at > cursor.ts
 *           OR (created_at = cursor.ts AND id > cursor.id) )
 *   ORDER BY created_at ASC, id ASC
 *   LIMIT $limit
 *
 * With no cursor (first load), the route instead returns the NEWEST page
 * descending then reverses to chronological — that path is modeled by the test
 * directly, not here, because first-load deliberately seeds without replay.
 */
export function selectNewActivity<T extends ActivityKeysetRow>(
  allRowsChrono: T[],
  cursor: ActivityCursor | null,
  limit: number,
): T[] {
  const cursorRow = cursor ? { id: cursor.id, created_at: cursor.ts } : null;
  const newer = cursorRow
    ? allRowsChrono.filter((r) => compareRows(r, cursorRow) > 0)
    : allRowsChrono.slice();
  // allRowsChrono is already chronological; keep that order, just page it.
  return newer.slice(0, limit);
}

/**
 * Client defensive guard: drop any row that is an EXACT id match to the current
 * cursor (the only duplicate a correct keyset could ever yield, and only if the
 * SQL ever used `>=`). Cannot drop a genuinely-new event — it only removes a
 * re-send of the exact cursor row. NOT a timestamp comparison (see the
 * precision note above).
 */
export function dedupeAgainstCursor<T extends ActivityKeysetRow>(
  rows: T[],
  cursor: ActivityCursor | null,
): T[] {
  if (!cursor) return rows;
  return rows.filter((r) => r.id !== cursor.id);
}

/** Validate a `since` query param: ISO-ish + parseable. Returns it or null. */
export function sanitizeSince(raw: string | null): string | null {
  if (!raw) return null;
  // Restrict to the character set of an ISO-8601 timestamp so the value can
  // never break the PostgREST `.or(...)` filter grammar (no commas/parens).
  if (!/^[0-9T:.+\-Z ]{1,40}$/.test(raw)) return null;
  if (Number.isNaN(Date.parse(raw))) return null;
  return raw;
}

/** Validate a `sinceId` query param as a UUID. Returns it or null. */
export function sanitizeSinceId(raw: string | null): string | null {
  if (!raw) return null;
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw))
    return null;
  return raw;
}
