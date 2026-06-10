# Streaming empty-completion retry — deferred canary project (design capture)

**Status:** DEFERRED (Cooper, 2026-06-10). NOT in the empty-completion-guards build. Captured so it doesn't evaporate.

## Why deferred
Guard 1 (retry-then-fallback on empty) ships transparently on the **non-streaming** path because the body is already buffered+parsed (`route.ts` non-streaming return). The **streaming** path can't retry transparently without holding the stream, and the safety of holding hinges on one **unverified** unknown — so we don't build it blind (quality bar: "must never become a new way to fail a turn").

## The detection-timing problem (proven)
- The existing 5xx→opus retry gates on `providerRes.status >= 500` — known from response **headers, pre-body**.
- An empty completion is **HTTP 200**; emptiness is `message_start → message_delta(stop)/message_stop` with **no `content_block_start`** — only knowable once the stream reaches its terminal event.
- The proxy streams pure passthrough (enqueue-first), so `message_start` is already forwarded to the VM before the empty terminal is detectable. Can't un-send → can't retry transparently.

## The two candidate shapes (both gated on the same unknown)
1. **Buffer-until-first-content:** tee the stream, withhold `message_start`; on first `content_block_start` flush everything + switch to live passthrough; on terminal-with-no-content, retry (nothing forwarded yet). Latency added to *normal* calls = the model's TTFT (the window in which `message_start` is held).
2. **Splice:** forward `message_start` immediately (no hold), passthrough content; if the stream ends empty, suppress the empty terminal, fire the fallback, and splice the fallback's content blocks + terminal into the still-open SSE.

## The gating unknown (what the canary must answer)
**Does OpenClaw's gateway tolerate a multi-second gap with no body bytes after the response headers (shape 1) / after `message_start` (shape 2)?** Today OpenClaw receives `message_start` in ~ms and only *content* is delayed by TTFT; both shapes delay the first byte (or the first byte after `message_start`) by ~TTFT + (for a retry) a second generation. If OpenClaw's stream-inactivity timeout is shorter than that window, the hold becomes a new failure mode.

## Canary plan (when picked up)
1. Read the OpenClaw dist on a VM: the anthropic/openai stream consumer — find the read/inactivity timeout governing the gap between SSE events (grep the provider bundle for the fetch/stream read timeout).
2. Deploy shape 1 (buffer-until-first-content) to vm-1019 only.
3. Force an empty via a **mock upstream** (a test endpoint that emits `message_start → message_delta(stop) → message_stop`, no content) — real Anthropic won't reliably empty.
4. Confirm: (a) OpenClaw tolerates the held `message_start` on a normal (delayed-TTFT) call — no timeout, no "request ended without sending any chunks"; (b) measure the p50/p95 added latency from the hold; (c) the forced empty triggers the fallback and the VM receives the fallback's content as one clean stream.
5. Only fleet-roll if (a) clean AND (b) the latency tax is acceptable. Else abandon streaming retry; streaming empties stay covered by Guard 2 (no-bill) + the empty-rate detector.

## Interim coverage (what ships now)
Streaming empties are **not retried** but are: (a) **never billed** (Guard 2 refund fires on the post-flush empty detection in the usage tee), and (b) **visible** via the `output_tokens=0` empty-rate detector. The user still sees OpenClaw's "couldn't generate a response" on a streaming empty until this canary lands — the bleed we stopped first is the *billing*, and the data to size the problem (empty-rate by model) is now flowing.

## Prerequisite signal
Before investing in this, read the empty-rate data (token logging shipped 2026-06-10): if fable's `output_tokens=0` rate is low, the streaming retry may not be worth the hot-path risk. If it's high at announce scale, prioritize the canary.
