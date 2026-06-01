/**
 * Contract test for the proxy `complete` (turn-END) event — the 2026-06-01 v2
 * proxy-coverage fix (lib/floor-activity.ts + app/api/gateway/proxy/route.ts).
 *
 * Before this, the proxy only wrote `message_in`; proxy-only agents had no
 * terminal signal, so Larry "worked/typed" until the director's 180s safety
 * timeout, long after the agent answered. The proxy now writes `complete` when
 * the FINAL LLM response of a turn ends with a turn-ENDING stop_reason — and
 * crucially NOT on a tool-use response (the agent keeps going; celebrating
 * mid-turn would be worse than the bug).
 *
 * Covers:
 *   1. isTurnEndStopReason — end-of-turn vs continue-with-tool classification.
 *   2. extractStopReason — pulling the terminal stop_reason out of SSE/JSON text
 *      (incl. ignoring `stop_reason:null`, and last-wins).
 *   3. attachCompletionScanner — passthrough byte-integrity, fires exactly once,
 *      detects across a chunk boundary, and reports tool_use (→ not a complete).
 *   4. recordComplete — 5s dedupe (in-process + DB probe), per-kind independence
 *      from message_in, the proxy↔webhook echo collapse, never throws.
 *   5. recordForwardOutcome — routes `complete` through the deduped writer and
 *      `error` straight through.
 *
 * Run: npx tsx scripts/_test-floor-complete.ts
 */

import { __setSupabaseForTests } from "../lib/supabase";
import {
  isTurnEndStopReason,
  extractStopReason,
  attachCompletionScanner,
  recordComplete,
  recordMessageIn,
  recordForwardOutcome,
  __resetMessageInDedupeForTests,
  TERMINAL_DEDUPE_WINDOW_MS,
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

const TW = TERMINAL_DEDUPE_WINDOW_MS;
const MW = MESSAGE_IN_DEDUPE_WINDOW_MS;
const t0 = 5_000_000;

// Minimal chainable supabase stub: probe resolves to `probeRows`; insert records.
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
  return { client: { from: () => builder }, calls };
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

async function main(): Promise<void> {
  console.log("\n=== The Floor — proxy complete (turn-end) event ===\n");

  // ── 1. isTurnEndStopReason ────────────────────────────────────────────────
  console.log("isTurnEndStopReason (done vs continue-with-tool):");
  for (const s of ["end_turn", "stop_sequence", "max_tokens", "stop", "length"]) {
    check(`"${s}" → turn-end (true)`, isTurnEndStopReason(s) === true);
  }
  for (const s of ["tool_use", "tool_calls", "function_call", "pause_turn"]) {
    check(`"${s}" → NOT turn-end (false)`, isTurnEndStopReason(s) === false);
  }
  check("null → false", isTurnEndStopReason(null) === false);
  check("undefined → false", isTurnEndStopReason(undefined) === false);
  check('"" → false', isTurnEndStopReason("") === false);
  check('unknown "whatever" → false', isTurnEndStopReason("whatever") === false);

  // ── 2. extractStopReason ──────────────────────────────────────────────────
  console.log("\nextractStopReason (terminal value out of text):");
  check(
    "anthropic message_delta → end_turn",
    extractStopReason('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}') === "end_turn",
  );
  check(
    "anthropic tool_use → tool_use",
    extractStopReason('{"delta":{"stop_reason":"tool_use"}}') === "tool_use",
  );
  check(
    "openai finish_reason → stop",
    extractStopReason('{"choices":[{"finish_reason":"stop"}]}') === "stop",
  );
  check(
    'stop_reason:null (unquoted) → null (ignored)',
    extractStopReason('{"message":{"stop_reason":null}}') === null,
  );
  check("no stop_reason at all → null", extractStopReason("event: ping\ndata: {}") === null);
  check(
    "message_start(null) THEN message_delta(end_turn) → last wins (end_turn)",
    extractStopReason(
      '{"stop_reason":null} ... {"delta":{"stop_reason":"end_turn"}}',
    ) === "end_turn",
  );

  // ── 3. attachCompletionScanner (passthrough tee) ──────────────────────────
  console.log("\nattachCompletionScanner (passthrough + detect):");
  {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"stop_reason":null}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const fires: string[] = [];
    const teed = attachCompletionScanner(streamFromChunks(sse), (sr) => fires.push(sr));
    const out = await collect(teed);
    check("passthrough preserves bytes exactly", out === sse.join(""));
    check("fired exactly once", fires.length === 1);
    check("fired with end_turn", fires[0] === "end_turn");
    check("downstream classifies it as a complete", isTurnEndStopReason(fires[0]) === true);
  }
  {
    // stop_reason split across a chunk boundary — tail buffer must still catch it.
    const chunks = [
      'event: message_delta\ndata: {"delta":{"stop_rea',
      'son":"end_turn"}}\n\n',
    ];
    const fires: string[] = [];
    const teed = attachCompletionScanner(streamFromChunks(chunks), (sr) => fires.push(sr));
    const out = await collect(teed);
    check("split-chunk passthrough preserves bytes", out === chunks.join(""));
    check("split-chunk still detects end_turn once", fires.length === 1 && fires[0] === "end_turn");
  }
  {
    // tool_use response: scanner fires, but it is NOT a complete.
    const chunks = [
      'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ];
    const fires: string[] = [];
    const teed = attachCompletionScanner(streamFromChunks(chunks), (sr) => fires.push(sr));
    await collect(teed);
    check("tool_use stream → scanner reports tool_use", fires.length === 1 && fires[0] === "tool_use");
    check("tool_use → NOT treated as complete", isTurnEndStopReason(fires[0]) === false);
  }

  // ── 4. recordComplete dedupe (5s window) ──────────────────────────────────
  console.log("\nrecordComplete (5s dedupe, in-process + DB):");
  {
    __resetMessageInDedupeForTests();
    const { client, calls } = makeStub([]);
    __setSupabaseForTests(client);

    await recordComplete({ vmId: "vm-c", userId: "u", channel: "web" }, t0);
    check("first complete → 1 insert", calls.inserts === 1);
    check("inserted kind is complete", calls.insertedKinds[0] === "complete");

    const sBefore = calls.selects;
    const iBefore = calls.inserts;
    await recordComplete({ vmId: "vm-c", userId: "u", channel: "web" }, t0 + TW - 1);
    check("echo within 5s → NO new insert", calls.inserts === iBefore);
    check("echo within 5s → NO DB probe (in-process short-circuit)", calls.selects === sBefore);

    // Just past the window → a genuinely-next turn must still record.
    await recordComplete({ vmId: "vm-c", userId: "u", channel: "web" }, t0 + TW + 1);
    check("just past 5s → next turn's complete DOES insert", calls.inserts === iBefore + 1);

    __setSupabaseForTests(null);
  }

  console.log("\nrecordComplete (cross-instance echo caught by DB probe):");
  {
    __resetMessageInDedupeForTests();
    const { client, calls } = makeStub([{ id: "proxy-already-wrote-it" }]);
    __setSupabaseForTests(client);
    await recordComplete({ vmId: "vm-d", userId: "u", channel: "web" }, t0);
    check("DB shows recent complete → probe runs", calls.selects === 1);
    check("DB shows recent complete → NO insert", calls.inserts === 0);
    __setSupabaseForTests(null);
  }

  console.log("\ncomplete vs message_in are independent (per-kind keys + windows):");
  {
    __resetMessageInDedupeForTests();
    const { client, calls } = makeStub([]);
    __setSupabaseForTests(client);
    // Same VM, same instant: a message_in AND a complete must BOTH record.
    await recordMessageIn({ vmId: "vm-e", userId: "u", channel: "web" }, t0);
    await recordComplete({ vmId: "vm-e", userId: "u", channel: "web" }, t0);
    check("message_in + complete same VM/time → 2 inserts", calls.inserts === 2);
    check(
      "kinds are message_in then complete",
      calls.insertedKinds[0] === "message_in" && calls.insertedKinds[1] === "complete",
    );
    // 6s later: past the 5s complete window (records) but inside the 15s
    // message_in window (deduped) — proves the windows are distinct per kind.
    check("sanity: 5s < 6s < 15s", TW < 6000 && 6000 < MW);
    const iBefore = calls.inserts;
    await recordComplete({ vmId: "vm-e", userId: "u", channel: "web" }, t0 + 6000);
    check("complete +6s → inserts (past 5s window)", calls.inserts === iBefore + 1);
    await recordMessageIn({ vmId: "vm-e", userId: "u", channel: "web" }, t0 + 6000);
    check("message_in +6s → deduped (inside 15s window)", calls.inserts === iBefore + 1);
    __setSupabaseForTests(null);
  }

  console.log("\nrecordComplete (never throws on DB error):");
  {
    __resetMessageInDedupeForTests();
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
      await recordComplete({ vmId: "vm-err", userId: "u", channel: "web" }, t0);
    } catch {
      threw = true;
    }
    check("DB probe rejects → recordComplete does NOT throw", threw === false);
    __setSupabaseForTests(null);
  }

  // ── 5. recordForwardOutcome routing (relay → deduped complete / direct error)
  console.log("\nrecordForwardOutcome (complete deduped, error direct):");
  {
    __resetMessageInDedupeForTests();
    const { client, calls } = makeStub([]);
    __setSupabaseForTests(client);
    // Two relay successes back-to-back (real Date.now(), ms apart) → the second
    // is the in-process echo of the same turn → only ONE complete recorded.
    await recordForwardOutcome("u", { ok: true, vmId: "vm-f" });
    await recordForwardOutcome("u", { ok: true, vmId: "vm-f" });
    check("two relay successes → exactly 1 complete (routed via deduped writer)", calls.inserts === 1);
    check("the insert is a complete", calls.insertedKinds[0] === "complete");
    // A failure routes straight through as an `error` (different VM to avoid the
    // complete window interfering).
    await recordForwardOutcome("u", { ok: false, vmId: "vm-g", reason: "boom" });
    check("relay failure → error inserted", calls.insertedKinds.includes("error"));
    __setSupabaseForTests(null);
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness threw:", err);
  process.exit(1);
});
