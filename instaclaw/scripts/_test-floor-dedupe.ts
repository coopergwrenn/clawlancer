/**
 * Contract test for the message_in double-write dedupe (lib/floor-activity.ts).
 *
 * The proxy-coverage fix (2026-06-01) added a SECOND message_in producer (the
 * proxy entry path) alongside the existing inbound-webhook producer. A single
 * shared-bot user message reaches BOTH (the webhook at arrival, then the relay
 * echoes back through the proxy), so without dedupe the user would see a DOUBLE
 * perk-up. This proves the dedupe suppresses the echo while never dropping a
 * genuinely-distinct message.
 *
 * Two layers tested:
 *   1. isDuplicateMessageInLocal — the pure in-process recency guard (no I/O),
 *      exercised directly with injected `now`.
 *   2. recordMessageIn — the full path with a STUBBED supabase client, proving:
 *      (a) the in-process guard short-circuits before any DB call,
 *      (b) the DB-recency probe suppresses a cross-instance echo,
 *      (c) a genuinely-new message (outside the window, empty probe) inserts.
 *
 * Run: npx tsx scripts/_test-floor-dedupe.ts
 */

import { __setSupabaseForTests } from "../lib/supabase";
import {
  isDuplicateMessageInLocal,
  recordMessageIn,
  __resetMessageInDedupeForTests,
  MESSAGE_IN_DEDUPE_WINDOW_MS,
} from "../lib/floor-activity";

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

const W = MESSAGE_IN_DEDUPE_WINDOW_MS;
const t0 = 5_000_000;

// Wrapped in main() because this tsx/esbuild config (cjs output) doesn't allow
// top-level await (the other floor suites are sync; this one awaits I/O stubs).
async function main(): Promise<void> {
console.log("\n=== The Floor — message_in double-write dedupe ===\n");

// ── 1. In-process recency guard (pure) ──────────────────────────────────────
console.log("isDuplicateMessageInLocal (in-process guard):");
{
  __resetMessageInDedupeForTests();
  check("first call for a VM → not duplicate (records)", isDuplicateMessageInLocal("vm-a", t0) === false);
  check("same VM within window → duplicate", isDuplicateMessageInLocal("vm-a", t0 + W - 1) === true);
  check("a DIFFERENT VM within window → not duplicate", isDuplicateMessageInLocal("vm-b", t0 + 1) === false);
  check("same VM AFTER window → not duplicate again", isDuplicateMessageInLocal("vm-a", t0 + W + 1) === false);
  check("...and that re-stamps, so an immediate repeat is duplicate", isDuplicateMessageInLocal("vm-a", t0 + W + 2) === true);
}

// ── 2. recordMessageIn — stubbed supabase to observe DB calls + inserts ──────
// A minimal chainable stub. `select().eq().eq().gte().limit()` resolves to a
// configurable `probeRows`; `insert()` records the inserted row.
function makeStub(probeRows: Array<{ id: string }>) {
  const calls = { selects: 0, inserts: 0, insertedKinds: [] as string[] };
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = () => {
    calls.selects++;
    return builder;
  };
  builder.eq = chain;
  builder.gte = chain;
  builder.limit = () => Promise.resolve({ data: probeRows, error: null });
  builder.insert = (row: { kind?: string }) => {
    calls.inserts++;
    calls.insertedKinds.push(row.kind ?? "?");
    return Promise.resolve({ error: null });
  };
  const client = { from: () => builder };
  return { client, calls };
}

console.log("\nrecordMessageIn (in-process guard short-circuits I/O):");
{
  __resetMessageInDedupeForTests();
  const { client, calls } = makeStub([]);
  __setSupabaseForTests(client);

  await recordMessageIn({ vmId: "vm-x", userId: "u", channel: "telegram" }, t0);
  check("first message → 1 insert", calls.inserts === 1);
  check("first message → inserted kind is message_in", calls.insertedKinds[0] === "message_in");
  check("first message → DB probe ran (select)", calls.selects === 1);

  // Immediate echo (same lambda, within window) — must NOT touch the DB at all.
  const selectsBefore = calls.selects;
  const insertsBefore = calls.inserts;
  await recordMessageIn({ vmId: "vm-x", userId: "u", channel: "web" }, t0 + 3000);
  check("echo within window → NO new insert (deduped)", calls.inserts === insertsBefore);
  check("echo within window → NO DB probe (in-process short-circuit)", calls.selects === selectsBefore);

  __setSupabaseForTests(null);
}

console.log("\nrecordMessageIn (cross-instance echo caught by DB probe):");
{
  // Simulate a DIFFERENT lambda: the in-process map is empty here, but the DB
  // already has a recent message_in (written by the webhook on instance A).
  __resetMessageInDedupeForTests();
  const { client, calls } = makeStub([{ id: "existing-recent-row" }]);
  __setSupabaseForTests(client);

  await recordMessageIn({ vmId: "vm-y", userId: "u", channel: "web" }, t0);
  check("DB shows a recent message_in → probe runs", calls.selects === 1);
  check("DB shows a recent message_in → NO insert (cross-instance dedupe)", calls.inserts === 0);

  __setSupabaseForTests(null);
}

console.log("\nrecordMessageIn (genuinely-new message inserts):");
{
  // Different lambda, empty DB probe (no recent row) → must insert.
  __resetMessageInDedupeForTests();
  const { client, calls } = makeStub([]);
  __setSupabaseForTests(client);

  await recordMessageIn({ vmId: "vm-z", userId: "u", channel: "web" }, t0);
  check("empty DB probe → inserts", calls.inserts === 1);
  check("inserted kind is message_in", calls.insertedKinds[0] === "message_in");

  __setSupabaseForTests(null);
}

console.log("\nrecordMessageIn (never throws on DB error):");
{
  __resetMessageInDedupeForTests();
  // A stub whose probe rejects — recordMessageIn must swallow and not throw.
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = () => builder;
  builder.eq = chain;
  builder.gte = chain;
  builder.limit = () => Promise.reject(new Error("supabase down"));
  builder.insert = () => Promise.resolve({ error: null });
  __setSupabaseForTests({ from: () => builder });

  let threw = false;
  try {
    await recordMessageIn({ vmId: "vm-err", userId: "u", channel: "web" }, t0);
  } catch {
    threw = true;
  }
  check("DB probe rejects → recordMessageIn does NOT throw", threw === false);

  __setSupabaseForTests(null);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness threw:", err);
  process.exit(1);
});
