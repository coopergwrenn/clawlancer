# ChatGPT OAuth Reasoning Routing & Watchdog — Design Doc

**Status**: Design, not yet implemented. Awaiting Cooper review before any code/SSH changes.
**Author**: this terminal, 2026-05-20.
**Trigger**: Cooper's "yoo" to @edgecitybot took 3 minutes via GPT-5.5; "what model are you running?" took ~30s. The fix is intelligent reasoning routing + watchdog architecture that's protocol-aware, not wall-clock-aware.

---

## 0. TL;DR

1. **Cooper's prior watchdog work already removed the dangerous kill timers.** Per v69 (2026-04-30) + v76 (2026-05-01), gateway-watchdog timer is disabled and vm-watchdog + silence-watchdog are removed from the manifest cronJobs. The only active watchdog is ack-watchdog (v95, mine) which never restarts. The fleet currently has NO hard kill timer for legitimate long reasoning.
2. **Remaining real cap on long reasoning**: `agents.defaults.timeoutSeconds=300` (set in 18eed486 — bumped 90→300 because Anthropic 3-min responses forced it). For GPT-5.5 high-effort on 27K-token prompts, 300s is sufficient 99% of the time but caps "deep research" requests. Recommendation: keep at 300 (or bump conditionally per effort) — see §4.
3. **Latent UX bug**: ack-watchdog sends "Hit my limit on this one — taking too long" at 180s. On legitimate long reasoning, this misleads users. Recommendation: change copy + make it effort-aware.
4. **The big insight from OpenAI research**: the Codex Responses API SSE stream is **not silent during reasoning**. It emits `response.reasoning_summary_text.delta` and `response.reasoning_text.delta` events throughout the thinking phase. We can build a watchdog that distinguishes "actively thinking" from "actually stuck" at the protocol level — not by counting wall-clock seconds.
5. **OpenAI's own Codex CLI uses `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000` (5 min IDLE)** — the right ground-truth ceiling for our own per-request timeout. Not 60s wall-clock.
6. **Reasoning router**: a fast heuristic classifier (no LLM, no >5ms latency) selects `effort` per request. Defaults to medium/high; only drops to low for genuinely simple/social messages. User overrides via natural language and dashboard preference. Routes through a new `lib/reasoning-router.ts` that's called before pi-ai builds the request.

---

## 1. What I learned from OpenAI docs

### 1.1 Server-side limits for the Codex Responses endpoint

The Codex OAuth endpoint (`POST https://chatgpt.com/backend-api/codex/responses`) has **no publicly-documented hard duration cap**. Related anchors:
- `gpt-5.5-pro` on the standard `/v1/responses` endpoint has a documented **10-minute server timeout** ([OpenAI Help — Controlling response length](https://help.openai.com/en/articles/5072518)).
- OpenAI's documented escape hatch for genuinely-unbounded work is **`background: true`** with polling — not "raise the foreground timeout" ([Background mode](https://developers.openai.com/api/docs/guides/background)).
- Failure mode when reached: returns 503 in observed incidents.
- Our direct curl probe earlier showed **143ms TTFB** for trivial requests on the ChatGPT-OAuth tier — proves the endpoint itself is fast; reasoning latency is purely client-perceived thinking time.

**Implication**: design our system with the assumption that any single foreground request CAN take 10 minutes. Don't impose tighter caps than OpenAI does. For >10 min workloads (deep research), use background mode (Phase 3 work).

### 1.2 SSE event sequence — the critical insight

OpenAI's official Codex CLI test fixtures (`codex-rs/core/tests/common/responses.rs:622-918`) enumerate the canonical event types:

```
response.created                       ← lifecycle start, immediately on accept
response.output_item.added             ← new output item begins
response.reasoning_summary_text.delta  ← STREAMED DURING REASONING ★
response.reasoning_text.delta          ← STREAMED DURING REASONING ★
response.output_text.delta             ← first user-visible token
response.output_item.done              ← item complete
response.completed                     ← lifecycle end (success)
response.failed                        ← lifecycle end (error)
```

**The reasoning-text and reasoning-summary deltas arrive BEFORE the first visible output token.** The SSE stream is alive during the thinking phase. This invalidates the assumption behind silence-watchdog (60s of "no visible reply" = stuck). The right liveness signal is "any SSE event in the last N seconds", not "any user-visible reply in the last N seconds".

The actual parser at `codex-rs/codex-client/src/sse.rs:23` uses `tokio::time::timeout(idle_timeout, stream.next())` — gives up only when NO byte arrives for the configured idle window.

### 1.3 OpenAI's own Codex CLI client timeouts

- **`DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`** (5 min) — `codex-rs/model-provider-info/src/lib.rs:26`. **This is the value OpenAI's own client uses.** Best reference for our upper bound.
- **`COMPACT_REQUEST_TIMEOUT_IDLE_MULTIPLIER = 4`** — `codex-rs/core/src/client.rs:151`. Compaction calls get 4× idle = 20-min idle budget.
- **No overall-request timeout** at the reqwest layer — only idle. Reasonable for streaming.
- 15s WebSocket connect timeout (realtime only; not applicable to `/responses`).
- Per-tenant override exposed as config `stream_idle_timeout_ms` — could be made user-configurable in our stack too.

**Implication**: our hard ceiling should be at most 5 minutes of IDLE (no SSE event), matching Codex CLI. Not 60s wall-clock. Distinct concepts.

### 1.4 Reasoning effort behavior

- **Levels for gpt-5.5**: `none, low, medium, high, xhigh` ([Codersera GPT-5.5 guide 2026](https://codersera.com/blog/gpt-5-5-complete-guide-2026/), [OpenAI latest-model docs](https://developers.openai.com/api/docs/guides/latest-model)). Default per OpenAI = **medium**. (gpt-5 still also supports `minimal` per [aimultiple](https://aimultiple.com/llm-parameters)).
- **What it controls**: token budget for the chain-of-thought generated before the answer. NOT model routing or architecture switch — same model, different internal thinking budget.
- **Real measured numbers**: at `xhigh` the model shows **115-second time-to-first-token** on Responses API ([Codersera benchmarks](https://codersera.com/blog/gpt-5-5-complete-guide-2026/)). 23× swing in reasoning-token-count between `minimal` and `high` ([Artificial Analysis GPT-5 benchmarks](https://artificialanalysis.ai/articles/gpt-5-benchmarks-and-analysis)).
- **OpenClaw's wrapper currently defaults to `"high"`** (`provider-stream-BtN3gEYv.js:1337`: `normalizeOpenAIReasoningEffort(options?.reasoningEffort ?? options?.reasoning ?? "high")`). This is wrong for the common case.

**Implication**: the leverage is dramatic. Going from `high` to `low` on a greeting cuts ~99% of the reasoning-token cost AND TTFB. Going from `medium` (OpenAI's API default) to `high` (OpenClaw's wrapper default) is a 3-5× latency hit on identical prompts. The router needs to bias **medium** as the default, not high — and route low only for genuinely-simple inputs.

---

## 2. Current state — what kill timers actually exist on the fleet

Reading the manifest at HEAD + checking vm-780 crontab:

| Mechanism | Status | Effect on long reasoning |
|---|---|---|
| `silence-watchdog.py` (60s window, restarts gateway) | **REMOVED from manifest in v76 (1a2fc677). On vm-780 crontab line is commented `# DISABLED 2026-05-01 demo-stabilize`.** State file last fire = 2026-04-30. Not running. | None |
| `vm-watchdog.py` (5min × 2 stale → restart) | **Same.** Removed from manifest in v76, commented in vm-780 crontab. Not running. | None |
| gateway-watchdog systemd timer | **Disabled fleet-wide in v69 (d967db50).** | None |
| `ack-watchdog.py` (sends "Thinking…" at 30s, "Hit my limit" at 180s) | **Running** via cronJobs entry. Line 16 of script: "NEVER restarts the gateway." | UX-only: misleading 180s message but no kill |
| `agents.defaults.timeoutSeconds = 300` | **Set in v89 manifest.** Per-turn agent timeout in OpenClaw. Came from 18eed486 — bumped 90→300 because Anthropic 3-min responses forced it. | **REAL CAP — 5 min hard ceiling per turn.** Applies to all providers including openai-codex. |
| `agents.defaults.timeoutSeconds` per-model override | Not set | n/a |
| `models.providers.timeoutSeconds` | Not set | n/a |
| `transport-stream-shared` per-model `requestTimeoutMs` | Not set in catalog → `resolveModelRequestTimeoutMs` returns `undefined` → no HTTP-level timeout from our side | None |
| OpenAI server-side cap | UNVERIFIED for ChatGPT-OAuth tier; `gpt-5.5-pro` doc says 10 min on `/v1/responses` | 10 min (assumed) |
| Codex CLI reference: idle timeout | 5 min idle (their own value) | Reference only |
| Pi-ai or OpenClaw internal idle timeout for openai-codex provider | None — `streamOpenAICodexResponses` uses fetch without `signal: AbortSignal.timeout()` | None |

**Net**: the only real cap on legitimate long reasoning is `agents.defaults.timeoutSeconds=300`. Everything else is gone or never existed.

### 2.1 Why Cooper's 3-min response survived

- Both kill watchdogs disabled since May 1.
- ack-watchdog never kills.
- `timeoutSeconds=300` was not exceeded (3 min < 5 min).
- OpenAI itself doesn't bound aggressively at the foreground-request level.

It was safe by accident, not design. The next legitimate >5 min response (deep research) WILL be cut by `timeoutSeconds=300`. That's the real remaining bug.

### 2.2 Lock files and state files

- `/tmp/ic-restart.lock` — 300s cooldown coordinator between all restart sources. Currently mtime 19:35 today (last touch by my manual restart sequence).
- `~/.openclaw/.silence-watchdog-state.json` — last fire 2026-04-30 (3 weeks ago, before disable).
- `~/.openclaw/.watchdog-stale-agent` — empty / nonexistent on vm-780.
- `~/.openclaw/agents/main/sessions/.ack-watchdog-state.json` — per-turn dedup state.
- `~/.openclaw/agents/main/sessions/.ack-watchdog.lock` — fcntl mutex against concurrent watchdog ticks.

No conflicting kill paths active.

---

## 3. Architectural proposals — beyond bumping numbers

### 3.1 Proposal A — In-flight request manifest

**Idea**: the gateway writes a `~/.openclaw/.llm-inflight.jsonl` file with one line per active LLM request:

```json
{"requestId":"abc123","sessionId":"c1e98...","provider":"openai-codex","model":"gpt-5.5","reasoningEffort":"high","promptTokens":27000,"startedAt":1747776543234,"lastSseAt":1747776550000,"lastSseEventType":"response.reasoning_text.delta","reasoningEventCount":47,"expectedDurationMs":180000}
```

- Append-only during request. Truncate on `response.completed` or `response.failed`.
- Atomic write per line (fsync after each SSE event would be too noisy — instead, write on event-type transitions: created, first reasoning, first output, completed/failed).

Any watchdog reads this file and gets ground-truth on:
- Is there an active request? (yes if any non-terminal row)
- Is the request still alive at the protocol level? (`now - lastSseAt < N`)
- Was it expected to take this long? (`now - startedAt vs expectedDurationMs`)
- Is the model still doing reasoning, or wedged in some other phase? (`lastSseEventType`)

This replaces "wall-clock since last assistant text" — the wrong signal — with "SSE-event idle time" + "effort-aware expected duration" — the right signals.

**Implementation**: requires a small hook in pi-ai's `streamOpenAICodexResponses` OR a wrapper in OpenClaw's provider runtime. ~50 LOC. Per-VM, no external dependency.

### 3.2 Proposal B — Effort-aware expected durations

Routing layer assigns each request an `expectedDurationMs` based on the chosen `reasoning.effort` AND the prompt-token count:

| Effort | Expected TTFB | Hard timeout (when to give up) |
|---|---|---|
| `low` | 5–10s for greetings | 60s |
| `medium` | 15–45s for normal tasks | 300s |
| `high` | 60–180s for analysis | 600s |
| `xhigh` | 120–300s for deep research | 1800s (matches Cooper's "30 min or whatever makes sense") |

Stored in the in-flight manifest (§3.1). Watchdog uses `2× expectedDurationMs` as the "definitely stuck" threshold. OR `lastSseAt > 300s ago` (matching Codex CLI idle ceiling). Whichever hits first.

Replaces the single global `agents.defaults.timeoutSeconds=300` with a per-request budget. Still allow the global as a hard ceiling for safety.

### 3.3 Proposal C — Telegram UX during long reasoning

Three layers:

1. **Telegram typing indicator** — sent every 4s while in-flight. Telegram's `sendChatAction` API. Free, no cost, makes the UI feel alive. The bot disappears from "typing…" only when the request completes or the watchdog gives up.

2. **Effort-aware ack messages**:
   - For `low`/`medium` requests: ack-watchdog stays silent (response should complete in <30s).
   - For `high` requests: at 30s, ack-watchdog sends *"Thinking through this — give me ~30-60s on it."*
   - For `xhigh` requests: at 60s, ack-watchdog sends *"Doing some deep reasoning on this one. Hang tight — about 2 minutes."*
   - The 180s "Hit my limit" message GOES AWAY for routine high-effort requests. Only fires after the per-effort expected duration is exceeded by 2×.

3. **Optional reasoning-progress message**: parse `response.reasoning_summary_text.delta` events and post short summary updates to Telegram ("Looking up the Edge schedule…", "Cross-referencing AI infra topics…"). Reasoning summaries are short text snippets the model emits to summarize its own thinking. Could provide a magical "watch it think" experience. Phase 2 work — out of scope for the initial router.

### 3.4 Proposal D — Reasoning router (the main ask)

A pure-function classifier at `lib/reasoning-router.ts` that runs before pi-ai builds the request body. Input: user message text, conversation context (last N turns), per-user/per-VM preference. Output: `{effort: "low"|"medium"|"high"|"xhigh", expectedDurationMs, reason: "<human-readable>"}`.

**Design principle (per Cooper's spec)**: bias toward quality. Default to medium/high. Drop to low only for genuinely simple inputs. Cooper: "high reasoning is the standard, low is only for obviously simple messages".

**Taxonomy of message types** (with effort assignment):

| Category | Signals | Effort | Examples |
|---|---|---|---|
| **Pure social / greeting** | <20 chars, no question mark, contains common-greeting tokens (`yo`, `hey`, `hi`, `gm`, `gn`, `thanks`, `lol`, `sup`, emojis only) | `low` | "yoo", "hey", "gm ☀️", "thanks!" |
| **Acknowledgment / status check** | <60 chars, no question mark OR ends in single `?`, contains check-tokens (`ok`, `cool`, `nice`, `got it`, `did it work`, `?`) | `low` | "did you get that?", "all good?", "ok cool" |
| **Simple factual lookup** | Single clear noun-phrase question, no list/compare/analyze words | `medium` | "what's my wallet address?", "when is the next session?", "who is speaking?" |
| **Conversational task** | Imperative + single object, may include short context | `medium` | "remind me about lunch tomorrow", "send a thank-you to Tule", "log this idea: …" |
| **Multi-part task** | Multiple sentences, conjunctions (`and then`, `also`), enumerations, lists | `high` | "send a thank-you to Tule and also pin the address to my notes" |
| **Analysis / synthesis / comparison** | Contains keywords (`analyze`, `compare`, `evaluate`, `recommend`, `explain why`, `which`, `pros and cons`, `tradeoffs`, `deep dive`, `summarize`) | `high` | "analyze the Edge schedule and recommend sessions for AI infra interest" |
| **Creative / open-ended generation** | Contains keywords (`write`, `draft`, `compose`, `generate`, `create`, `design`, `come up with`) | `high` | "draft a proposal for Cooper", "write a song about Edge" |
| **Code / technical reasoning** | Contains code-fence markers (`)\`\`\``), tech keywords (`function`, `class`, `error`, `bug`, `stack trace`, `debug`), file paths, URLs to docs | `high` | "fix this stack trace: …" |
| **Deep research / multi-step planning** | Contains keywords (`research`, `investigate`, `plan a strategy`, `step by step`, `comprehensive`, `thorough`, `walk me through`, multi-paragraph context) | `xhigh` | "research the speakers at tomorrow's events, cross-reference with my interests in decentralized identity, and tell me which ones align" |
| **Explicit user override** | Contains override-keywords (`think harder`, `use max reasoning`, `quick answer`, `don't overthink`, `low effort`, `deep think`) | Per-override | "think harder about this" → `high` |

**Algorithm sketch** (~30 LOC):

```typescript
interface RoutingDecision {
  effort: "low" | "medium" | "high" | "xhigh";
  expectedDurationMs: number;
  reason: string;
}

function routeReasoningEffort(
  message: string,
  context: { userPreference?: "auto"|"low"|"medium"|"high"; sessionOverride?: Effort; recentTurns?: Message[] }
): RoutingDecision {
  // 1. User dashboard preference takes precedence (unless "auto")
  if (context.userPreference && context.userPreference !== "auto") {
    return preferenceToDecision(context.userPreference);
  }
  // 2. Per-session natural-language override (set by previous turn — see §3.5)
  if (context.sessionOverride) {
    return effortToDecision(context.sessionOverride, "session-override");
  }
  // 3. Explicit in-message override
  const explicit = detectExplicitOverride(message);
  if (explicit) return effortToDecision(explicit.effort, `explicit:${explicit.phrase}`);
  // 4. Heuristic classification
  const length = message.length;
  const wordCount = message.trim().split(/\s+/).length;
  const lower = message.toLowerCase().trim();
  // 4a. Pure social
  if (length < 20 && !lower.includes("?") && SOCIAL_RE.test(lower)) {
    return { effort: "low", expectedDurationMs: 15_000, reason: "social/greeting" };
  }
  // 4b. Status check
  if (length < 60 && STATUS_CHECK_RE.test(lower)) {
    return { effort: "low", expectedDurationMs: 15_000, reason: "status-check" };
  }
  // 4c. Deep research signals
  if (DEEP_RESEARCH_RE.test(lower) || wordCount > 50) {
    return { effort: "xhigh", expectedDurationMs: 600_000, reason: "deep-research" };
  }
  // 4d. Analysis / comparison
  if (ANALYSIS_RE.test(lower)) {
    return { effort: "high", expectedDurationMs: 180_000, reason: "analysis" };
  }
  // 4e. Code / technical
  if (CODE_RE.test(message)) {
    return { effort: "high", expectedDurationMs: 180_000, reason: "code/technical" };
  }
  // 4f. Multi-part task
  if (wordCount > 25 || MULTI_PART_RE.test(lower)) {
    return { effort: "high", expectedDurationMs: 180_000, reason: "multi-part" };
  }
  // 4g. Default — quality-biased
  return { effort: "medium", expectedDurationMs: 45_000, reason: "default" };
}
```

**Latency budget for the router itself**: <1ms (pure regex matching, no async, no I/O). Single-file module. No external deps beyond regex.

**Why medium and not high as default**: OpenAI's own API default is medium. OpenClaw's `?? "high"` default is an over-correction. Medium produces noticeably faster TTFB while preserving most of the quality of high (per the Codersera benchmarks: medium ~45s TTFB on a 27K-token prompt; high ~120s; xhigh ~180s). The difference between high and medium on a routine task is rarely user-perceivable; the latency difference always is. **For users who want maximum quality**, the dashboard "always high" toggle (§3.6) is the right escape hatch — not the global default.

This is a deliberate disagreement with Cooper's "bias toward high". My read: Cooper wants the quality bar high. Medium IS high enough for 90% of real conversations on GPT-5.5; the latency cost of high-everywhere is felt on every turn while the quality gain is marginal except on actual analysis. The router decides analysis cases get high. So the median user gets fast medium responses AND the analysis cases get the deep thinking they need.

**If Cooper disagrees**, the fix is a one-line change to the default fallback: `effort: "high", expectedDurationMs: 180_000`. Trivial.

### 3.5 Natural-language user override

Detected in-message via regex (no LLM call):

| User phrase | Resulting effort | Persist? |
|---|---|---|
| "think harder", "use max reasoning", "really analyze this", "be thorough" | `high` (or `xhigh` if currently high) | This turn only |
| "deep think this", "research mode", "comprehensive answer" | `xhigh` | This turn only |
| "quick answer", "don't overthink", "tldr", "short version" | `low` | This turn only |
| "stay in deep mode", "use deep thinking from now on" | `xhigh` | Persist until "back to normal" or 1 hour |
| "be quick from now on", "fast mode" | `low` | Persist until override |

Persistence stored in `~/.openclaw/agents/main/sessions/.reasoning-override.json` per-session:
```json
{"sessionId":"<id>","effort":"xhigh","setAt":1747776543234,"expiresAt":1747780143234,"phrase":"stay in deep mode"}
```

Read by router on every turn. Cleared by:
- Explicit "back to normal" / "auto mode"
- TTL expiry (1 hour default for natural-language; permanent for dashboard preference)
- Session reset

### 3.6 Dashboard preference

UI section near the ChatGPT OAuth connection block in `app/dashboard`:

```
[ ChatGPT Connection ]
✓ Connected — ChatGPT Plus (shelpinc@gmail.com)
   Disconnect

[ Reasoning Style ]
Choose how your agent thinks:
( ) Auto (recommended) — quick on greetings, thorough on analysis
( ) Always thorough — best quality, slower for everything
( ) Balanced — medium effort always (matches GPT-5.5 default)
( ) Always quick — fastest responses, less depth
```

Stored in `instaclaw_users.reasoning_preference` column (text enum: `auto|high|medium|low`). Default `auto`. Flowed to VM via reconciler's existing user-config push path — gets written to `~/.openclaw/.reasoning-preference` file, read by the router.

**Per-VM, not per-session.** A user has one preference across all conversations.

---

## 4. Recommended timeout values + rationale

| Knob | Current | Recommended | Rationale |
|---|---|---|---|
| `agents.defaults.timeoutSeconds` | 300 | **300** (unchanged) for `auto` routing — covers low/medium/high comfortably. For users who route to `xhigh` either via dashboard or natural-language override, the in-flight manifest's per-request budget supersedes; gateway respects whichever is higher. | OpenAI's own gpt-5.5-pro foreground max is 10 min. We don't need to match it as a default — most users hit `xhigh` rarely. The default 5 min covers the 99th percentile of `auto`/`medium`/`high` cases. |
| `ack-watchdog.SLOW_WARN_AGE_MS` | 30s | **30s** (unchanged) for `medium`/`high`; **skip** for `low`; **60s** for `xhigh` | Match user expectation per effort tier. Low requests shouldn't be slow enough to warrant any ack. xhigh requests are expected to take >60s, so 30s ack would be noisy. |
| `ack-watchdog.HARD_FAIL_AGE_MS` | 180s | **600s** (10 min) AND change copy from "Hit my limit on this one" → "Still thinking deeply on this — give me a bit more time. If you'd rather, send `/quick` to retry with faster reasoning." | Removes the misleading 180s message on legitimate high-effort responses. 10 min matches OpenAI's foreground server max. The "/quick" suggestion gives users an explicit escape hatch. |
| `ack-watchdog.MAX_TURN_AGE_MS` | 30 min | **30 min** (unchanged) | Sensible "abandoned turn" cap. |
| `silence-watchdog` | Disabled (since v76) | **Stay disabled.** The in-flight manifest (Proposal A) replaces its function with a better signal. | The original silence-watchdog was the wrong primitive (wall-clock since last user-visible reply, with a 30-second fire window). Replacing it with SSE-event-aware liveness is the right move. |
| `vm-watchdog.AGENT_STALE_MINUTES` | Disabled (since v76) | **Re-enable at 15 min** (effective 30 min via 2× consecutive checks), AND make it skip when in-flight manifest shows an active LLM request | Need *some* defense against genuinely-frozen agents (gateway holding a session lock but not making progress). 30 min effective + check the in-flight signal first = catches real stuck state without false-positive on long reasoning. |
| `models.providers.timeoutSeconds` | Unset | **Set on `openai-codex` provider to 600s** (10 min) — but only as an HTTP-level idle ceiling, not a wall-clock-since-start cap | Matches OpenAI Codex CLI's own 5-min idle (we go higher for safety on heavy reasoning). Provides a final HTTP-level guard against truly-stuck TCP connections. |

### 4.1 Why I'm pushing back on the "30 minute everywhere" recommendation

Cooper suggested 1800s globally. My counter: 1800s as the global default makes the "request stuck" path noisy. If the gateway crashes mid-reasoning, the user waits 30 minutes for nothing. The smarter pattern is per-request budgets via the in-flight manifest, with 1800s reserved for explicit `xhigh` requests.

For a user on the `auto` router, a "yoo" gets a 60s budget. An "analyze the schedule" gets a 600s budget. A "deep research" gets 1800s. **Each request has the right budget for its expected duration.** The agent never waits longer than it should, and the watchdog never kills a legitimate long request.

---

## 5. Edge cases + how the design handles them

### 5.1 Gateway crashes mid-reasoning (OOM, segfault, etc.)

- In-flight manifest: line exists for the request but `lastSseAt` stops updating.
- Watchdog sees `now - lastSseAt > 60s` AND `now - startedAt < expectedDurationMs` — ambiguous: still thinking, or dead?
- After `now - lastSseAt > 300s` (matching Codex CLI idle), classify as dead.
- Send fallback Telegram message: "Looks like my reasoning stalled — could you resend?"
- DO NOT auto-restart the gateway (systemd `Restart=on-failure` handles real crashes).
- Remove the dead request from the in-flight manifest.
- User experience: ~5 min of "thinking…" then an error. Acceptable. Could be improved later by parsing process-state (gateway alive + no LLM request = stuck differently than gateway dead).

### 5.2 Cascading failures (50 users all sending complex queries simultaneously)

- Not a watchdog problem. This is a gateway-capacity problem.
- The in-flight manifest naturally surfaces it: if 50 lines all show active requests and queueDepth > N, the gateway is overloaded.
- Mitigation paths (not in scope for this design): VM-level concurrency limit, queueing, autoscale.
- For now: monitor + alert if in-flight count > 10 sustained.

### 5.3 Telegram typing indicator timeout

- Telegram's typing indicator auto-expires after **5 seconds** without a refresh.
- Solution: gateway sends `sendChatAction(typing)` every 4 seconds while in-flight (loop wakes on a tick; runs while any non-terminal row exists in the manifest).
- Cost: 1 HTTP request per VM per 4s while idle is reasoning. ~225 requests per 15-min session of heavy use. Negligible.

### 5.4 Request crosses the `xhigh` threshold mid-reasoning

- Router selects `high` initially based on signals.
- 90s in, model is still thinking — the watchdog could detect "this is taking longer than expected" but we should NOT escalate to xhigh mid-stream (the request is already running with a fixed effort).
- Just let it complete. The next request with similar phrasing will route to `high` again (or `xhigh` if the user's natural-language override sets it).

### 5.5 User sends "quick answer" mid-conversation but with a complex question

- Router: explicit override `low` wins regardless of message complexity.
- Output: GPT-5.5 with `effort: low` on a complex prompt returns a shallower answer faster.
- Expected: user gets what they asked for. Quality drop is on them.
- Trust the user.

### 5.6 Race between concurrent requests on the same session

- Per-session lock (existing in OpenClaw — `agent:main:main` lane in the queue) serializes requests.
- One request finishes before the next starts.
- In-flight manifest has at most 1 entry per session at any time. No race.

### 5.7 OpenAI returns a 503 mid-reasoning

- pi-ai's openai-codex provider surfaces the 503 as an error.
- Model fallback path (currently set to `anthropic/claude-haiku-4-5-20251001`) — but for OAuth users, fallback to anthropic returns 403 BYOK from our own gateway proxy (correctly fail-closed).
- User sees: "Looks like ChatGPT had a hiccup. Try again in a moment?" — needs a custom error handler in the failover decision module. Currently shows the raw "All models failed" message. Out of scope for this design; tracked as P2 follow-up.

### 5.8 User sets dashboard to "always high" then sends "yoo"

- Router: dashboard preference wins → `effort: high`.
- ack-watchdog sends "Thinking through this — give me ~30-60s" at 30s.
- GPT-5.5 high on a tiny prompt returns in ~30-45s.
- User gets a thorough greeting reply.
- Their choice.

### 5.9 Edge Esmeralda crowd of 500 attendees all sending "yoo" at 9am

- Each VM is independent — no cross-VM contention.
- Per-VM gateway handles one chat at a time per session.
- 500 users × 1 reply each = 500 OpenAI API calls.
- At low effort, each completes in <15s — total fleet throughput is fine.
- If router accidentally routes to high, total time could spike.
- Monitoring: count router decisions per minute in a metric. If `effort=high` count spikes 10× expected, the heuristic is wrong somewhere; investigate.

---

## 6. Implementation plan

### Phase 1 — Tame existing kill timers (the only thing Cooper explicitly asked for tonight)

**A. ack-watchdog message + threshold fix.** Edit `~/.openclaw/scripts/ack-watchdog.py` on vm-780 first:
- `HARD_FAIL_AGE_MS = 180 * 1000` → **`600 * 1000`** (10 min)
- `ACK_WATCHDOG_HARD_FAIL` message: change from "Hit my limit on this one — taking too long. Mind retrying or rephrasing?" → "Still thinking on this — give me a bit more time. If you'd rather speed it up, send `/quick` to retry with faster reasoning." (`/quick` slash command can be a future Phase 2 enhancement; the message stands on its own).
- Sentinel update so reconciler accepts the new content.

**B. Verify ack-watchdog is the only Telegram-fallback path.** Confirm via journalctl that silence-watchdog and vm-watchdog are not running on vm-780 (already confirmed). Confirm same on a sample of other production VMs to make sure the manifest disable propagated everywhere. Spot-check 5 VMs via SSH.

**C. agents.defaults.timeoutSeconds stays at 300.** Don't bump globally yet — wait for the router to land, then bump conditionally per effort tier.

Then ask Cooper to retest. If both probes (greeting + analysis) work and the misleading "Hit my limit" message no longer appears, Phase 1 is done.

### Phase 2 — Reasoning router (the main work)

1. **`lib/reasoning-router.ts`**: pure-function classifier per §3.4. Includes the regex taxonomy + the algorithm sketch. Unit tests for each category with example inputs.
2. **Plumb through to pi-ai's `options.reasoningEffort`**: find the call path from OpenClaw's runtime to pi-ai's `streamOpenAICodexResponses(model, context, options)` and inject `options.reasoningEffort` from the router's decision. May require patching `provider-stream-BtN3gEYv.js` upstream or wrapping pi-ai's provider with a local shim. Investigate during implementation.
3. **`~/.openclaw/.reasoning-preference` file**: written by reconciler when `instaclaw_users.reasoning_preference` is set. Read by the router every turn.
4. **`~/.openclaw/agents/main/sessions/.reasoning-override.json` file**: written by the router on natural-language override detection. Read on subsequent turns until expiry.
5. **Telemetry**: log every routing decision to `~/.openclaw/logs/reasoning-router.log` with `{messageLength, decidedEffort, reason}` so we can audit + tune.
6. **Unit tests**: a corpus of 50+ real example messages with expected effort, run via `scripts/_test-reasoning-router.ts`. CI-runnable.
7. **One-VM canary on vm-780**.
8. **Manifest version bump + fleet rollout** via reconciler.

### Phase 3 — Smart watchdog (in-flight manifest)

1. **In-flight manifest writer**: hook in OpenClaw's openai-codex provider runtime to append/update `~/.openclaw/.llm-inflight.jsonl` on SSE event boundaries.
2. **New `~/.openclaw/scripts/inflight-watchdog.py`** that replaces ack-watchdog's role with an event-aware version. Reads the in-flight manifest; sends acks based on per-request expected duration; never restarts.
3. **Telegram typing indicator refresh**: separate `typing-refresh.py` cron that runs every 4s while any in-flight request exists. Sends `sendChatAction(typing)` to the request's chat_id.
4. **Re-enable vm-watchdog at 15 min with in-flight skip**: edit `vm-watchdog.py` to check in-flight manifest before triggering stale-agent restart. Re-add to manifest cronJobs.

### Phase 4 — Dashboard preference + natural-language override (Phase 1 has shipped routing; this is UX polish)

1. **Migration**: add `reasoning_preference` text column to `instaclaw_users` with default `'auto'`.
2. **API route**: `PATCH /api/users/me` accepts `{reasoning_preference}`. Validate enum.
3. **Reconciler step**: `stepReasoningPreference` writes `~/.openclaw/.reasoning-preference` on the VM based on user row. Triggered on user-version bump (similar pattern to chatgpt-oauth token push).
4. **Dashboard UI**: Reasoning Style block near the ChatGPT Connection section. Radio group, calls the API on change.
5. **Natural-language override** in the router: detect override phrases, write `.reasoning-override.json`, respect on next turn.

### Phase 5 — Out of scope for this design (but worth noting)

- Background mode (`background: true`) for deep-research requests that legitimately need 10+ min. Polled separately. Different UX.
- Multi-VM concurrency limits.
- Reasoning-summary streaming to Telegram ("watch it think" experience).
- Per-skill effort hints (e.g., the `solana-defi` skill marks all its requests as `high` because trading analysis is non-trivial).

---

## 7. Disagreements / things to validate with Cooper before building

1. **Default effort: medium vs high.** I'm recommending `medium` as the auto-router default (with high routing on analysis signals). Cooper said "bias toward high". My recommendation differs because the 3-5× latency cost of high-everywhere is felt on every turn while the quality gain is marginal except on actual analysis. **If you want high default**, change one line in §3.4. Trivial.

2. **`agents.defaults.timeoutSeconds`: keep at 300 vs bump to 1800.** I'm recommending keep at 300 for `auto` and override per-request via the in-flight manifest. Cooper suggested 1800 globally. My counter: 1800 global makes stuck-request UX worse (longer waits when something IS dead). Per-request budgets are more nuanced. **If you prefer the simpler bump**, set timeoutSeconds=1800 and skip the per-request budget logic. The router still works.

3. **Re-enable vm-watchdog at 15 min**: I'm proposing this as defense against truly-stuck agents. The disable was for "demo-stabilize" and might have been intended as permanent. **If you want it to stay disabled**, drop it from the plan; ack-watchdog + systemd Restart=on-failure cover most cases.

4. **/quick slash command**: implies Telegram slash-command infrastructure. May already exist; need to check. **If not in scope**, drop the suggestion from the hard-fail message.

5. **In-flight manifest writes from pi-ai**: requires either upstreaming a hook to pi-ai or wrapping the provider locally. Upstream is the right answer but slow. Local wrap risks shape regression on OpenClaw upgrades. **Which path?**

6. **Phase ordering**: my Phase 1 is "tame ack-watchdog only" and Phase 2 is "reasoning router". Cooper's earlier directive: "the router is meaningless until the kill timers are tamed". Agreed — Phase 1 first. But the timers are mostly already tamed; Phase 1 is just an ack-watchdog message fix. **Want me to combine Phase 1 + Phase 2 into a single rollout?**

---

## 8. Open questions / things to research further

1. **`agents.defaults.timeoutSeconds=300`: does it apply to streaming responses by per-chunk or by total duration?** If by total, 300s could cut off a long high-effort response even if the SSE stream is actively flowing. Need to check pi-ai's `streamOpenAICodexResponses` against the OpenClaw runtime that wraps it.

2. **Does OpenClaw's stream consumer have its own idle timeout?** Couldn't find one in `transport-stream-shared`. But pi-ai might. If yes, what's the value?

3. **What's the right Telegram typing-indicator implementation?** A cron polling the manifest every 4s is one path. A long-lived in-gateway goroutine is cleaner. Investigate during implementation.

4. **OpenAI's actual server-side max for the ChatGPT-OAuth Codex endpoint** — unverified. Could be the same as standard (10 min for gpt-5.5-pro) or different. Worth empirically testing once we have a way to drive deep-reasoning requests.

5. **Reasoning-effort cost implications**: at `xhigh` we generate 23× more reasoning tokens than `minimal`. For ChatGPT Plus subscriptions, this counts against the subscription's quota differently than API tokens. Need to verify there's no "premium tier" bandwidth concern for users hitting xhigh often.

---

## 9. Concrete next step request from Cooper

Two paths:

**Path A — ship Phase 1 only tonight.** Just the ack-watchdog message fix on vm-780, with a sentinel update so the reconciler accepts it. Test that Cooper's existing 3-min response no longer surfaces the misleading "Hit my limit" message. Defer Phases 2-5 to a fresh session.

**Path B — ship Phase 1 + Phase 2 tonight on vm-780.** Adds the reasoning router (pure TS module + tests + wire-up). Cooper tests both "yoo" (should route to `low`, complete in <15s) and "analyze the Edge Esmeralda schedule…" (should route to `high`, complete in ~60-120s with no false "Hit my limit" message). Defer Phases 3-5 to follow-up work.

Recommend Path B. The router is small (~150 LOC + tests), the wire-up is contained (one helper in vm-reconcile or a pi-ai shim), and the value to Cooper for the Edge Esmeralda launch is significant.

If Path B: I need approval to do Phase 2's "wire-up" — either patch pi-ai dist on vm-780 (fast hack, fragile on upgrade) or add a wrapper layer in OpenClaw's provider runtime (proper, requires more reading). Which?

---

## 10. References

- OpenAI: [Reasoning models guide](https://developers.openai.com/api/docs/guides/reasoning), [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses), [Background mode](https://developers.openai.com/api/docs/guides/background), [Error codes](https://developers.openai.com/api/docs/guides/error-codes), [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).
- Codex CLI source: [github.com/openai/codex](https://github.com/openai/codex) — `codex-rs/codex-client/src/sse.rs`, `codex-rs/core/src/client.rs`, `codex-rs/model-provider-info/src/lib.rs`, `codex-rs/core/tests/common/responses.rs`.
- Benchmarks: [Codersera GPT-5.5 guide](https://codersera.com/blog/gpt-5-5-complete-guide-2026/), [Artificial Analysis](https://artificialanalysis.ai/articles/gpt-5-benchmarks-and-analysis).
- Internal: `lib/vm-reconcile.ts:stepChatGPTOAuthToken` + `applyConnectedState` (recent shape fix at `195b276f` + gateway-restart fix at `29b7284a`). `lib/vm-manifest.ts:cronJobs` (manifest v76 watchdog disables). `~/.openclaw/scripts/{silence,vm,ack}-watchdog.py` on vm-780.
- Earlier session's P2 notes: `instaclaw/docs/chatgpt-oauth-runtime-routing-p2-2026-05-20.md`.
