/**
 * Unit test for lib/usage-tokens.ts — the token-capture seams.
 * Run: npx tsx scripts/_test-usage-tokens.ts
 *
 * Covers happy path + failure modes (Rule 31): missing usage, partial usage,
 * output last-wins across deltas, input latched from message_start, malformed
 * input, AND the streaming tee's passthrough-integrity + fire-once contract.
 */
import {
  parseUsageFromJson,
  extractStreamingUsage,
  attachUsageScanner,
  hasAnyToken,
  type TokenUsage,
} from "../lib/usage-tokens";

let pass = 0,
  fail = 0;
// order-insensitive deep-equal via sorted-key canonical JSON
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
const eq = (label: string, got: unknown, want: unknown) => {
  const g = canon(got),
    w = canon(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    console.log(`  ✗ FAIL ${label}\n      got:  ${g}\n      want: ${w}`);
  }
};
const ok = (label: string, cond: boolean) => {
  cond ? pass++ : (fail++, console.log(`  ✗ FAIL ${label}`));
};

console.log("\n== parseUsageFromJson (non-streaming) ==");
eq(
  "full usage block",
  parseUsageFromJson({
    usage: {
      input_tokens: 14000,
      output_tokens: 2000,
      cache_read_input_tokens: 30000,
      cache_creation_input_tokens: 1200,
    },
  }),
  { input_tokens: 14000, output_tokens: 2000, cache_read_tokens: 30000, cache_creation_tokens: 1200 },
);
eq(
  "partial usage (no cache fields)",
  parseUsageFromJson({ usage: { input_tokens: 100, output_tokens: 50 } }),
  { input_tokens: 100, output_tokens: 50, cache_read_tokens: null, cache_creation_tokens: null },
);
eq("missing usage key", parseUsageFromJson({ content: [] }), {
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_creation_tokens: null,
});
eq("null input (never throws)", parseUsageFromJson(null), {
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_creation_tokens: null,
});
eq("non-numeric token value ignored", parseUsageFromJson({ usage: { input_tokens: "lots", output_tokens: 5 } }), {
  input_tokens: null,
  output_tokens: 5,
  cache_read_tokens: null,
  cache_creation_tokens: null,
});

console.log("\n== extractStreamingUsage (SSE text) ==");
// Realistic Anthropic SSE: message_start carries input+cache (+output:1),
// then message_delta carries cumulative output (last is final).
const sse = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":14000,"cache_read_input_tokens":30000,"cache_creation_input_tokens":1200,"output_tokens":1}}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":900}}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2000}}\n\n`,
].join("");
eq("full stream: input latched, output last-wins", extractStreamingUsage(sse), {
  input_tokens: 14000,
  cache_read_tokens: 30000,
  cache_creation_tokens: 1200,
  output_tokens: 2000,
});
eq("output_tokens only in message_start (=1), no deltas → 1", extractStreamingUsage(`data: {"usage":{"input_tokens":5,"output_tokens":1}}`), {
  input_tokens: 5,
  cache_read_tokens: null,
  cache_creation_tokens: null,
  output_tokens: 1,
});
eq("no usage anywhere → all null", extractStreamingUsage(`event: ping\ndata: {}`), {
  input_tokens: null,
  cache_read_tokens: null,
  cache_creation_tokens: null,
  output_tokens: null,
});

console.log("\n== empty completion (200 + stop + no content): output_tokens=0 must be captured as 0, NOT dropped ==");
// This is the fleet-wide empty-rate detector shape (vm-050 fable empties,
// 2026-06-10). Real input, output_tokens:0 — must survive as 0, not null.
eq("non-streaming empty completion", parseUsageFromJson({ stop_reason: "stop", content: [], usage: { input_tokens: 31000, output_tokens: 0 } }), {
  input_tokens: 31000,
  output_tokens: 0,
  cache_read_tokens: null,
  cache_creation_tokens: null,
});
ok("non-streaming empty → hasAnyToken true (input present) → UPDATE fires", hasAnyToken(parseUsageFromJson({ usage: { input_tokens: 31000, output_tokens: 0 } })) === true);
eq(
  "streaming empty completion (message_start input, message_delta output:0)",
  extractStreamingUsage(
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":31000,"cache_read_input_tokens":30000,"output_tokens":0}}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"stop"},"usage":{"output_tokens":0}}\n\n`,
  ),
  { input_tokens: 31000, cache_read_tokens: 30000, cache_creation_tokens: null, output_tokens: 0 },
);

console.log("\n== hasAnyToken ==");
ok("all-null → false", hasAnyToken({ input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null }) === false);
ok("null arg → false", hasAnyToken(null) === false);
ok("one field → true", hasAnyToken({ input_tokens: 1, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null }) === true);

console.log("\n== attachUsageScanner (streaming tee: passthrough + fire-once) ==");
async function streamTest() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  // build a source stream that emits the SSE in 5 arbitrary chunks (splits
  // message_start across a boundary to exercise the rolling-buffer reassembly)
  const chunks = [sse.slice(0, 40), sse.slice(40, 120), sse.slice(120, 300), sse.slice(300, 500), sse.slice(500)];
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  let captured: TokenUsage | null = null;
  let capturedSawContent: boolean | null = null;
  let fireCount = 0;
  const teed = attachUsageScanner(src, (u, sawContent) => {
    fireCount++;
    captured = u;
    capturedSawContent = sawContent;
  });
  // drain the teed stream, reassemble bytes — must be byte-identical (passthrough)
  const reader = teed.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  ok("passthrough bytes byte-identical to source", out === sse);
  ok("onUsage fired exactly once", fireCount === 1);
  eq("scanner latched correct usage across chunk splits", captured, {
    input_tokens: 14000,
    cache_read_tokens: 30000,
    cache_creation_tokens: 1200,
    output_tokens: 2000,
  });
  ok("non-empty stream → sawContent true (has content_block_delta)", capturedSawContent === true);

  // empty completion stream: message_start → message_delta(stop), NO content block
  const emptySse =
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":31000,"output_tokens":0}}}\n\n` +
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"stop"},"usage":{"output_tokens":0}}\n\n`;
  const emptySrc = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(emptySse)); c.close(); },
  });
  let emptyUsage: TokenUsage | null = null;
  let emptySaw: boolean | null = null;
  const teed2 = attachUsageScanner(emptySrc, (u, s) => { emptyUsage = u; emptySaw = s; });
  const r2 = teed2.getReader();
  for (;;) { const { done } = await r2.read(); if (done) break; }
  ok("empty stream → sawContent FALSE (Guard 2 streaming trigger)", emptySaw === false);
  eq("empty stream → usage still latched (input real, output 0)", emptyUsage, {
    input_tokens: 31000, cache_read_tokens: null, cache_creation_tokens: null, output_tokens: 0,
  });
}

streamTest().then(() => {
  console.log(`\n== RESULT: ${pass} pass / ${fail} fail ==`);
  process.exit(fail === 0 ? 0 : 1);
});
