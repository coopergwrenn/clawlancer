/**
 * Contract test for The Floor store's ingest logic + the H1 keyset cursor.
 *
 * After the H1 fix, the SERVER filters strictly-new rows via a (created_at, id)
 * keyset cursor; the store folds whatever it's given (first load seeds from the
 * newest only). The two load-bearing behaviors:
 *
 *   1. FIRST-LOAD GUARD — the first poll returns the newest page; we must NOT
 *      replay it as live perk-ups.
 *   2. H1: NO MISSED EVENTS UNDER FLOOD — even when far more than one page of
 *      events exists, draining the keyset cursor in order folds EVERY event
 *      exactly once, so a buried `message_in` always fires its perk-up. This is
 *      proven by driving the store through a SIMULATED SERVER that mirrors the
 *      real SQL (`selectNewActivity`), with a small page limit to force
 *      multi-batch draining.
 *
 * Runs with NO network and NO React (zustand vanilla works in node).
 * Run: npx tsx scripts/_test-floor-store.ts
 */

import { useFloorStore, type ActivityRow } from "../lib/floor/store";
import {
  selectNewActivity,
  newestCursor,
  type ActivityCursor,
} from "../lib/floor/activity-window";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let idSeq = 0;
function row(
  kind: ActivityRow["kind"],
  atMs: number,
  extra: Partial<ActivityRow> = {},
): ActivityRow {
  return {
    id: `evt-${String(++idSeq).padStart(5, "0")}`,
    created_at: new Date(atMs).toISOString(),
    kind,
    station: null,
    intensity: null,
    channel: null,
    tool_name: null,
    ...extra,
  };
}

const t0 = 2_000_000;

console.log("\n=== The Floor — store ingest + H1 keyset cursor ===\n");

// ── 1. FIRST-LOAD GUARD: backlog seeds from newest, no stampede ─────────────
console.log("First-load guard (no backlog stampede):");
{
  useFloorStore.getState().reset(t0);
  const backlog: ActivityRow[] = [
    row("message_in", t0 - 60_000, { channel: "telegram" }),
    row("complete", t0 - 59_000),
    row("message_in", t0 - 30_000, { channel: "telegram" }),
    row("complete", t0 - 29_000),
    row("message_in", t0 - 5_000, { channel: "imessage" }),
  ];
  const changed = useFloorStore.getState().ingestActivity(backlog, t0);
  const s = useFloorStore.getState();
  check("first ingest reports change", changed === true);
  check("primed after first poll", s.primed === true);
  check("cursor at newest backlog row", s.cursor?.id === backlog[backlog.length - 1].id);
  check(
    "did NOT stampede — perkSeq ≤ 1 despite 3 message_in in backlog",
    s.director.perkSeq <= 1,
    `perkSeq=${s.director.perkSeq}`,
  );
  check(
    "behavior reflects newest backlog row (incoming from last message_in)",
    s.director.behavior === "incoming",
  );
}

// ── 2. RE-POLL with the cursor → server returns nothing new → no change ─────
console.log("\nRe-poll with cursor (server returns empty):");
{
  const before = useFloorStore.getState().director;
  const changed = useFloorStore.getState().ingestActivity([], t0 + 100);
  check("empty server batch → no change", changed === false);
  check("director untouched", useFloorStore.getState().director === before);
}

// ── 3. LIVE PATH: a NEW message_in (server-filtered) fires the perk-up ──────
console.log("\nLive path (new message_in → perk-up):");
{
  // Settle to idle via a complete, then a fresh message_in — each delivered as
  // the server would: only the strictly-new rows.
  useFloorStore.getState().ingestActivity([row("complete", t0 + 1_000)], t0 + 1_000);
  const perkBefore = useFloorStore.getState().director.perkSeq;

  const newMsg = row("message_in", t0 + 2_000, { channel: "telegram" });
  const changed = useFloorStore.getState().ingestActivity([newMsg], t0 + 2_000);
  const s = useFloorStore.getState();
  check("new message_in reports change", changed === true);
  check("behavior flipped to incoming (THE MAGIC MOMENT)", s.director.behavior === "incoming");
  check("perkSeq incremented exactly once", s.director.perkSeq === perkBefore + 1);
  check("cursor advanced to the new row", s.cursor?.id === newMsg.id);
}

// ── 4. DEFENSIVE: an exact cursor-id re-send is dropped (no double-fold) ─────
console.log("\nDefensive re-send of the cursor row:");
{
  const s0 = useFloorStore.getState();
  const cursorRow: ActivityRow = {
    id: s0.cursor!.id,
    created_at: s0.cursor!.ts,
    kind: "message_in",
    station: null,
    intensity: null,
    channel: null,
    tool_name: null,
  };
  const perkBefore = s0.director.perkSeq;
  const changed = useFloorStore.getState().ingestActivity([cursorRow], t0 + 2_100);
  check("re-sent cursor row → no change", changed === false);
  check(
    "perkSeq NOT double-incremented",
    useFloorStore.getState().director.perkSeq === perkBefore,
  );
}

// ── 5. H1 — NO MISSED EVENTS UNDER FLOOD (the headline fix) ─────────────────
console.log("\nH1: flood larger than a page never skips a buried message_in:");
{
  useFloorStore.getState().reset(t0);
  const PAGE = 10; // small page → force multi-batch draining

  // Build a long flood: 25 working/tool events, a message_in BURIED in the
  // middle (id/time-wise), and a complete at the end. Total 27 > 2× PAGE.
  const all: ActivityRow[] = [];
  let ts = t0;
  for (let i = 0; i < 12; i++) all.push(row("working", (ts += 50), { intensity: 2 }));
  const buriedMsg = row("message_in", (ts += 50), { channel: "telegram" });
  all.push(buriedMsg);
  for (let i = 0; i < 12; i++) all.push(row("tool", (ts += 50), { station: "browser" }));
  const finalComplete = row("complete", (ts += 50));
  all.push(finalComplete);

  // Simulated server: first poll returns the NEWEST page (desc→chrono); then
  // incremental polls return selectNewActivity (the SQL model), draining in
  // order. We assert EVERY event is folded exactly once and the buried
  // message_in fires a perk-up.
  function simulateServerFirstLoad(): ActivityRow[] {
    return all.slice(-PAGE); // newest PAGE, already chronological
  }
  function simulateServerIncremental(cursor: ActivityCursor | null): ActivityRow[] {
    return selectNewActivity(all, cursor, PAGE);
  }

  // First poll (no cursor) — seeds from newest only, no stampede.
  useFloorStore.getState().ingestActivity(simulateServerFirstLoad(), ts + 1000);
  const afterFirst = useFloorStore.getState();
  check("first-load primed", afterFirst.primed === true);
  // First load seeds from the newest row (the finalComplete) → celebrating.
  check("first-load seeds from newest (celebrating)", afterFirst.director.behavior === "celebrating");

  // The buried message_in is OLDER than the first-load window's cursor, so a
  // naive newest-only client would MISS it forever. Reset to simulate a client
  // that connected BEFORE the flood (cursor at the very start), then drain.
  useFloorStore.getState().reset(t0);
  // Prime with an empty first load so subsequent polls are "live" and cursor
  // starts before everything.
  useFloorStore.getState().ingestActivity([], t0); // primes, cursor null
  let cursor: ActivityCursor | null = null;
  let perkFired = false;
  let drains = 0;
  let totalFolded = 0;
  // Drain until the server has nothing left after the cursor.
  for (let guard = 0; guard < 100; guard++) {
    const batch = simulateServerIncremental(cursor);
    if (batch.length === 0) break;
    drains++;
    totalFolded += batch.length;
    const perkBefore = useFloorStore.getState().director.perkSeq;
    useFloorStore.getState().ingestActivity(batch, t0 + 10_000 + guard);
    if (useFloorStore.getState().director.perkSeq > perkBefore) perkFired = true;
    cursor = newestCursor(batch); // advance exactly as pollOnce does
  }
  check("flood required multiple drain batches (>1)", drains > 1, `drains=${drains}`);
  check("every event folded exactly once (27 total)", totalFolded === all.length, `folded=${totalFolded}/${all.length}`);
  check("the BURIED message_in fired a perk-up (H1: never skipped)", perkFired === true);
  check("final cursor at the last event", cursor?.id === finalComplete.id);
}

// ── 6. selectNewActivity model — keyset correctness directly ────────────────
console.log("\nselectNewActivity model (keyset semantics):");
{
  const rows: ActivityRow[] = [
    row("working", t0 + 1),
    row("working", t0 + 2),
    row("complete", t0 + 3),
  ];
  const all = selectNewActivity(rows, null, 100);
  check("no cursor → returns all", all.length === 3);

  const afterFirst = selectNewActivity(rows, { ts: rows[0].created_at, id: rows[0].id }, 100);
  check("cursor at row0 → returns rows after it (2)", afterFirst.length === 2);
  check("first returned is row1 (chronological)", afterFirst[0].id === rows[1].id);

  const limited = selectNewActivity(rows, null, 2);
  check("limit respected (2)", limited.length === 2);
  check("limit returns OLDEST first (drain order)", limited[0].id === rows[0].id);

  // Same-millisecond rows disambiguated by id (the v1-flood collision case).
  const a = row("tool", t0 + 500);
  const b = row("tool", t0 + 500); // identical ts, later id
  const collide = selectNewActivity([a, b], { ts: a.created_at, id: a.id }, 100);
  check("same-ts collision: cursor=a returns only b (no skip, no dup)", collide.length === 1 && collide[0].id === b.id);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
