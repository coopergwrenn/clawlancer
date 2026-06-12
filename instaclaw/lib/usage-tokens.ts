/**
 * Token-usage capture for the gateway proxy (margin measurement, launch-week).
 *
 * Captures Anthropic's four token classes per call so `instaclaw_usage_log`
 * carries MEASURED cost inputs instead of the 14k/2k estimate. Used by the
 * proxy's insert-then-update path: the row lands immediately (attribution),
 * tokens fill in via a deferred UPDATE keyed by row id.
 *
 * Safety contract (this code sits in the hot user-response path):
 *   - extraction is pure + total: never throws, returns nulls on anything
 *     unparseable. A capture miss yields NULL columns, never a broken response.
 *   - the streaming tee enqueues every chunk FIRST and unconditionally — the
 *     scan can never alter, drop, reorder, or delay the bytes the client sees
 *     (same contract as lib/floor-activity.ts:attachCompletionScanner).
 *
 * Anthropic usage shape:
 *   non-streaming JSON: { usage: { input_tokens, output_tokens,
 *                          cache_read_input_tokens, cache_creation_input_tokens } }
 *   streaming SSE:
 *     message_start → message.usage.{input_tokens, cache_*_input_tokens, output_tokens:1}
 *     message_delta → usage.{output_tokens}  (cumulative; the LAST one is final)
 *   So input + cache are known at the stream's START; final output at its END.
 */

export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

export const EMPTY_USAGE: TokenUsage = {
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_creation_tokens: null,
};

/** True if at least one token field is populated (worth writing). */
export function hasAnyToken(u: TokenUsage | null | undefined): boolean {
  return !!u && (u.input_tokens != null || u.output_tokens != null || u.cache_read_tokens != null || u.cache_creation_tokens != null);
}

/**
 * Pure: is this a parsed non-streaming Anthropic response an EMPTY completion?
 * Empty = a (terminal) 200 with zero content blocks — the 2026-06-10 incident
 * shape (HTTP 200, stop_reason=stop, content:[]). Conservative: only true when
 * `content` is an array of length 0. Anything unparseable / shape-unexpected
 * returns false (fail-safe: treat as NON-empty → serve + bill as today).
 */
export function isEmptyCompletionJson(obj: unknown): boolean {
  const content = (obj as { content?: unknown } | null)?.content;
  return Array.isArray(content) && content.length === 0;
}

/**
 * Pure: pull the usage block out of a parsed non-streaming Anthropic response.
 * Returns nulls for anything missing; never throws.
 */
export function parseUsageFromJson(obj: unknown): TokenUsage {
  const usage = (obj as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return { ...EMPTY_USAGE };
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    input_tokens: num(usage.input_tokens),
    output_tokens: num(usage.output_tokens),
    cache_read_tokens: num(usage.cache_read_input_tokens),
    cache_creation_tokens: num(usage.cache_creation_input_tokens),
  };
}

/**
 * Pure: scan a buffer of (possibly partial) SSE text for usage scalars.
 *  - input / cache-read / cache-creation: appear once (in message_start). We
 *    return the FIRST occurrence's value; the caller latches it (it never
 *    changes mid-stream, and message_start leads the stream).
 *  - output_tokens: appears in message_start (small) AND every message_delta
 *    (cumulative). We return the LAST occurrence — the final cumulative total.
 * Returns nulls for anything not yet present. Never throws.
 */
export function extractStreamingUsage(text: string): TokenUsage {
  const first = (re: RegExp): number | null => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  const last = (reG: RegExp): number | null => {
    let m: RegExpExecArray | null;
    let v: number | null = null;
    while ((m = reG.exec(text)) !== null) v = Number(m[1]);
    return v;
  };
  return {
    input_tokens: first(/"input_tokens"\s*:\s*(\d+)/),
    cache_read_tokens: first(/"cache_read_input_tokens"\s*:\s*(\d+)/),
    cache_creation_tokens: first(/"cache_creation_input_tokens"\s*:\s*(\d+)/),
    output_tokens: last(/"output_tokens"\s*:\s*(\d+)/g),
  };
}

/**
 * Wrap a streaming response body in a PASSTHROUGH tee that accumulates token
 * usage and invokes `onUsage` exactly once when the stream finishes (flush).
 *
 * Latch discipline (handles a bounded buffer + chunk boundaries):
 *   - input/cache are latched the FIRST time seen (message_start leads the
 *     stream; caught while still inside the rolling window).
 *   - output is updated last-wins on every chunk (final message_delta is the
 *     terminal value).
 *   - a bounded rolling buffer (16 KB) keeps memory flat on huge responses;
 *     16 KB comfortably spans message_start even across chunk splits.
 *
 * onUsage fires once, in flush(), with whatever was latched (possibly all-null
 * if the stream was malformed/empty — the caller treats null as "no update").
 * `sawContent` is true iff at least one `content_block_start` appeared — the
 * streaming empty-completion signal (no content block ⇒ empty, Guard 2).
 */
export function attachUsageScanner<T extends Uint8Array>(
  body: ReadableStream<T>,
  onUsage: (usage: TokenUsage, sawContent: boolean) => void,
): ReadableStream<T> {
  const decoder = new TextDecoder();
  let buf = "";
  const latched: TokenUsage = { ...EMPTY_USAGE };
  let sawContent = false;
  let fired = false;
  const ts = new TransformStream<T, T>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // PASSTHROUGH — always, first, unconditional.
      try {
        buf += decoder.decode(chunk, { stream: true });
        // content-block sighting latches before the buffer can scroll it off.
        // Match start OR delta: a real non-empty completion always emits
        // content_block_start, but matching either is strictly safer — an empty
        // completion emits neither (message_start → message_delta(stop) only).
        if (!sawContent && (buf.includes('"type":"content_block_start"') || buf.includes('"type":"content_block_delta"'))) sawContent = true;
        if (buf.length > 16384) buf = buf.slice(-16384);
        const partial = extractStreamingUsage(buf);
        // latch-first for the input-side (set once, never overwrite)
        if (latched.input_tokens == null && partial.input_tokens != null) latched.input_tokens = partial.input_tokens;
        if (latched.cache_read_tokens == null && partial.cache_read_tokens != null) latched.cache_read_tokens = partial.cache_read_tokens;
        if (latched.cache_creation_tokens == null && partial.cache_creation_tokens != null) latched.cache_creation_tokens = partial.cache_creation_tokens;
        // last-wins for output
        if (partial.output_tokens != null) latched.output_tokens = partial.output_tokens;
      } catch {
        // Never let scanning disturb the user's response.
      }
    },
    flush() {
      if (fired) return;
      fired = true;
      try {
        onUsage(latched, sawContent);
      } catch {
        // onUsage is fire-and-forget telemetry; never disturb stream close.
      }
    },
  });
  return body.pipeThrough(ts);
}
