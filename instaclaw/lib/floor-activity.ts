/**
 * The Floor — activity producer (docs/prd/the-floor.md §9, §10.1, §35).
 *
 * This is the ONLY sanctioned way to write `instaclaw_agent_activity` rows.
 * Every row drives Larry's on-screen behavior on The Floor, and the cardinal
 * rule is the honesty thesis (PRD §9): a row exists IFF a real agent event
 * happened. If nothing happened, Larry idles — we never fabricate activity.
 *
 * ── Sanitization by construction (PRD §13.1 #4 — load-bearing) ──────────────
 * `FloorActivityInput` has NO field that accepts message text, prompt content,
 * `prompt_hint`, tool inputs/outputs, or secrets. There is therefore no code
 * path through which content can reach this table, even by accident. `meta` is
 * narrowly typed to sanitized scalars. This is defense-in-depth: the worst-case
 * blast radius of any future RLS misconfig is "abstract activity leaks", never
 * "a stranger reads your messages". Keep it that way — do NOT add a `text` /
 * `content` / `prompt` field to this input type.
 *
 * ── Producers (PRD §10.1 — three, not one) ──────────────────────────────────
 *   1. inbound webhooks  → `message_in`  (the perk-up trigger; ALL users incl.
 *                          BYOK). The single most important write — without it
 *                          the activation moment (§24) is a lie (§35.2).
 *   2. gateway proxy     → `working` / `tool` + intensity + station
 *                          (all-inclusive only; BYOK bypasses the proxy). [v1]
 *   3. outbound relay    → `complete` / `error`  (ALL users), via
 *                          `recordForwardOutcome` below.
 *
 * The MVP data plane is producers (1) + (3): `message_in` on arrival,
 * `complete`/`error` on resolution. The director (PRD §10.4) fills the 60–90s
 * gap between them with the honest "working" animation — the agent genuinely IS
 * working that whole time, so a continuous typing loop is the truthful render.
 * Producer (2) adds intensity/station richness in v1 (the proxy extension).
 *
 * ── Fire-and-forget, never throws ───────────────────────────────────────────
 * Writing a Floor row must NEVER add latency to, or risk failing, the user's
 * actual message handling. Callers invoke this inside Next's `after()` so it
 * survives the response; on any error we log and swallow. A missed Floor beat
 * is cosmetic; a broken agent reply is not.
 *
 * NOTE: until `pending_migrations/20260530180000_floor_agent_activity.sql` is
 * applied to prod (Rule 56), inserts no-op with a warn — safe by design.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export type FloorActivityKind =
  | "message_in"
  | "working"
  | "tool"
  | "complete"
  | "error"
  | "heartbeat"
  | "idle"
  | "skill_added";

export type FloorStation =
  | "browser"
  | "trading"
  | "mailroom"
  | "memory"
  | "studio"
  | "workbench";

export type FloorChannel = "telegram" | "imessage" | "discord" | "web";

/**
 * The complete, content-free input contract. Note the deliberate ABSENCE of
 * any message/prompt/content field — see the sanitization note above.
 */
export interface FloorActivityInput {
  vmId: string;
  userId: string;
  kind: FloorActivityKind;
  /** Whitelisted station (PRD §26). Omit unless tool→station mapping resolved. */
  station?: FloorStation;
  /** Effort tier 1–3 (light/focused/deep) from cost_weight/model. */
  intensity?: 1 | 2 | 3;
  /** Originating channel, for `message_in`. */
  channel?: FloorChannel;
  /** Whitelisted tool name ONLY (PRD §26). Never a free-form model string. */
  toolName?: string;
  /** Sanitized structured extras ONLY — scalars, no content. */
  meta?: Record<string, string | number | boolean>;
}

/** The exact row shape written to `instaclaw_agent_activity`. */
export interface FloorActivityRow {
  vm_id: string;
  user_id: string;
  kind: FloorActivityKind;
  station: FloorStation | null;
  intensity: 1 | 2 | 3 | null;
  channel: FloorChannel | null;
  tool_name: string | null;
  public_safe: boolean;
  meta: Record<string, string | number | boolean>;
}

/**
 * Pure, deterministic row-builder. Extracted so it can be unit-tested with no
 * database (the sanitization guarantee is verified here — see
 * scripts/_test-floor-activity.ts). All optional fields normalize to null so
 * the DB row shape is explicit and stable.
 */
export function buildActivityRow(input: FloorActivityInput): FloorActivityRow {
  return {
    vm_id: input.vmId,
    user_id: input.userId,
    kind: input.kind,
    station: input.station ?? null,
    intensity: input.intensity ?? null,
    channel: input.channel ?? null,
    tool_name: input.toolName ?? null,
    // Every field this producer can emit is abstract/non-PII, so rows are
    // public-safe by construction. (The public projection still gates on this
    // column AND reads through an anonymized view — belt and suspenders.)
    public_safe: true,
    meta: input.meta ?? {},
  };
}

/**
 * Dedupe window for `message_in` (PRD §35 / proxy coverage fix, 2026-06-01).
 *
 * A single user message can reach TWO producers:
 *   1. the inbound webhook (shared-bot / iMessage) writes message_in at arrival;
 *   2. that relay then calls the VM's OpenClaw gateway, whose LLM call routes
 *      BACK through our proxy — where `isManualMessage` is also true — so the
 *      proxy would write a SECOND message_in ~seconds later → a double perk-up.
 *
 * Most agents (own Telegram bot / web / mini-app) only ever hit the proxy, so
 * the proxy write is REQUIRED for coverage; we just need to suppress the echo
 * for the shared-bot subset. The dedupe is a short recency window per VM:
 *   - cheap in-process guard (Fluid Compute reuses instances, so the webhook +
 *     proxy writes frequently land on the same warm lambda → caught for free);
 *   - plus a DB-recency check (covers the cross-instance case) before insert.
 *
 * Window is generous enough to cover relay→gateway→proxy round-trip latency
 * (a few seconds) but far shorter than any realistic gap between two genuinely
 * distinct user messages.
 */
export const MESSAGE_IN_DEDUPE_WINDOW_MS = 15_000;

/**
 * Dedupe window for the TERMINAL `complete` event (proxy-coverage v2, 2026-06-01).
 *
 * Like `message_in`, a single turn's `complete` can reach TWO producers:
 *   1. the proxy detects the final LLM response's turn-ending `stop_reason` and
 *      writes `complete` as the stream finishes;
 *   2. for a shared-bot/iMessage turn, that same relay then returns and the
 *      webhook writes `complete` via `recordForwardOutcome` ~1–3s later.
 * Whichever fires first wins; the echo within the window is dropped.
 *
 * Deliberately SHORTER than the message_in window: it only needs to cover the
 * proxy→relay-return echo (a couple of seconds), and a longer window would risk
 * swallowing a genuinely-NEXT turn's `complete` in a rapid back-and-forth —
 * which would drop that turn's terminal event and re-introduce the "Larry types
 * to the 180s safety timeout" bug this whole change exists to fix.
 */
export const TERMINAL_DEDUPE_WINDOW_MS = 5_000;

/** In-process last-write timestamp per `${vmId}:${kind}` (best-effort, per-lambda). */
const _lastByVmKind = new Map<string, number>();

/**
 * Decide whether an activity event of `kind` for this VM is a duplicate of one
 * just recorded, using ONLY the in-process map. Pure-ish (mutates the module
 * map). Returns true = "duplicate, skip"; false = "record it" (and stamps the
 * map so the next call within the window is deduped). Keyed by (vmId, kind) so
 * `message_in` and `complete` dedupe independently.
 */
export function isDuplicateActivityLocal(
  vmId: string,
  kind: FloorActivityKind,
  now: number,
  windowMs: number,
): boolean {
  const key = `${vmId}:${kind}`;
  const last = _lastByVmKind.get(key);
  if (last !== undefined && now - last < windowMs) return true;
  _lastByVmKind.set(key, now);
  // Opportunistic cleanup so the map can't grow unbounded on a long-lived
  // lambda: drop entries older than 2× the longest window we use.
  if (_lastByVmKind.size > 1000) {
    const cutoff = now - MESSAGE_IN_DEDUPE_WINDOW_MS * 2;
    for (const [k, v] of _lastByVmKind) {
      if (v < cutoff) _lastByVmKind.delete(k);
    }
  }
  return false;
}

/**
 * Back-compat shim for the original message_in-only guard (the unit test and
 * any existing callers use this signature). Delegates to the generic guard.
 */
export function isDuplicateMessageInLocal(
  vmId: string,
  now: number,
  windowMs: number = MESSAGE_IN_DEDUPE_WINDOW_MS,
): boolean {
  return isDuplicateActivityLocal(vmId, "message_in", now, windowMs);
}

/** Test-only: clear the in-process dedupe map between cases. */
export function __resetMessageInDedupeForTests(): void {
  _lastByVmKind.clear();
}

/**
 * Record a deduped activity event (`message_in` or `complete`) with double-write
 * dedupe (see the window docs). Use from BOTH the inbound webhooks and the proxy
 * — whichever producer fires first wins; the echo within `windowMs` is dropped.
 * Fire-and-forget; never throws.
 *
 * Order of checks (cheapest first):
 *   1. in-process recency map (no I/O) — catches the common same-lambda echo;
 *   2. DB recency probe — catches the cross-instance echo;
 *   3. insert.
 */
async function recordDedupedActivity(
  input: Omit<FloorActivityInput, "kind">,
  kind: Extract<FloorActivityKind, "message_in" | "complete">,
  windowMs: number,
  now: number,
): Promise<void> {
  // 1. In-process guard. If true, a very recent <kind> for this VM already
  //    happened on THIS lambda — skip without any I/O.
  if (isDuplicateActivityLocal(input.vmId, kind, now, windowMs)) {
    return;
  }
  try {
    // 2. Cross-instance guard: was a <kind> written for this VM within the
    //    window by another lambda (e.g. webhook on instance A, proxy on B)?
    const sinceIso = new Date(now - windowMs).toISOString();
    const { data: recent, error: probeErr } = await getSupabase()
      .from("instaclaw_agent_activity")
      .select("id")
      .eq("vm_id", input.vmId)
      .eq("kind", kind)
      .gte("created_at", sinceIso)
      .limit(1);
    if (!probeErr && recent && recent.length > 0) {
      // An echo from the other producer already landed — drop this one.
      return;
    }
    // 3. No recent <kind> → record it.
    await recordFloorActivity({ ...input, kind });
  } catch (err) {
    // Best-effort. A missed beat is cosmetic, not a broken agent reply —
    // swallow exactly like recordFloorActivity.
    logger.warn(`[floor-activity] record ${kind} threw (non-fatal)`, {
      route: "lib/floor-activity",
      vmId: input.vmId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record a `message_in` (the perk-up trigger). Deduped against the other
 * producer over MESSAGE_IN_DEDUPE_WINDOW_MS. Fire-and-forget; never throws.
 */
export async function recordMessageIn(
  input: Omit<FloorActivityInput, "kind">,
  now: number = Date.now(),
): Promise<void> {
  return recordDedupedActivity(
    input,
    "message_in",
    MESSAGE_IN_DEDUPE_WINDOW_MS,
    now,
  );
}

/**
 * Record a `complete` (the turn-END celebrate + return-to-idle). Call this from
 * the proxy when the final LLM response of a turn ends with a turn-ending
 * `stop_reason` (see `isTurnEndStopReason`), and from the relay outcome. Deduped
 * against the other producer over the SHORT TERMINAL_DEDUPE_WINDOW_MS so the
 * proxy↔webhook echo collapses to one celebrate without swallowing the next
 * turn's. Fire-and-forget; never throws.
 */
export async function recordComplete(
  input: Omit<FloorActivityInput, "kind">,
  now: number = Date.now(),
): Promise<void> {
  return recordDedupedActivity(
    input,
    "complete",
    TERMINAL_DEDUPE_WINDOW_MS,
    now,
  );
}

/**
 * Record one real agent activity event. Fire-and-forget: do NOT block a
 * latency-sensitive path on it; never throws. Returns a promise only so
 * callers inside `after()` (and tests) can await if they choose.
 */
export async function recordFloorActivity(
  input: FloorActivityInput,
): Promise<void> {
  const row = buildActivityRow(input);
  try {
    const { error } = await getSupabase()
      .from("instaclaw_agent_activity")
      .insert(row);
    if (error) {
      logger.warn("[floor-activity] insert failed (non-fatal)", {
        route: "lib/floor-activity",
        kind: row.kind,
        vmId: row.vm_id,
        error: error.message,
      });
    }
  } catch (err) {
    // Best-effort by design. A dropped Floor beat must never surface to the
    // user or fail their message handling.
    logger.warn("[floor-activity] insert threw (non-fatal)", {
      route: "lib/floor-activity",
      kind: row.kind,
      vmId: row.vm_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Minimal structural view of `forwardInboundToVm`'s result. Declared locally
 * (rather than importing `ForwardResult` from lib/channel-routing) to keep the
 * producer decoupled from the relay's full result type — the real
 * `ForwardResult` is structurally assignable to this.
 */
export interface ForwardOutcomeLike {
  ok: boolean;
  vmId?: string;
  reason?: string;
}

/**
 * Pure decision: map a relay outcome to the terminal Floor event (or null).
 *   - success            → `complete`  (Larry celebrates)
 *   - failure with a VM  → `error`     (Larry stumbles, comedic, recoverable)
 *   - failure, no VM     → null        (no office to animate)
 *
 * Extracted as a pure function so the mapping is unit-testable with no DB
 * (scripts/_test-floor-activity.ts).
 */
export function forwardOutcomeToActivity(
  userId: string,
  result: ForwardOutcomeLike,
): FloorActivityInput | null {
  if (result.ok && result.vmId) {
    return { vmId: result.vmId, userId, kind: "complete" };
  }
  if (!result.ok && result.vmId) {
    return {
      vmId: result.vmId,
      userId,
      kind: "error",
      meta: result.reason ? { reason: result.reason } : undefined,
    };
  }
  return null;
}

/**
 * Record the terminal Floor event for a gateway relay. Call this in the inbound
 * webhook's `after()` block, AFTER `message_in` and AFTER awaiting
 * `forwardInboundToVm`. Fire-and-forget; never throws.
 */
export async function recordForwardOutcome(
  userId: string,
  result: ForwardOutcomeLike,
): Promise<void> {
  const input = forwardOutcomeToActivity(userId, result);
  if (!input) return;
  if (input.kind === "complete") {
    // Route the relay's complete through the SAME deduped writer the proxy uses,
    // so a shared-bot turn (proxy detects turn-end AND the relay returns) yields
    // exactly ONE celebrate, not two. (kind is implied by recordComplete.)
    const { kind: _kind, ...rest } = input;
    void _kind;
    await recordComplete(rest);
  } else {
    await recordFloorActivity(input);
  }
}

// ── Turn-end detection (proxy `complete` trigger) ────────────────────────────

/**
 * Is this LLM `stop_reason` / `finish_reason` a TURN-ENDING one (the agent is
 * done and its reply is going back to the user) vs. a continue-with-a-tool one
 * (the agent will run a tool and make another LLM call)?
 *
 * Turn-ending → write `complete` (Larry celebrates + returns to idle):
 *   - Anthropic: end_turn | stop_sequence | max_tokens
 *   - OpenAI/MiniMax: stop | length
 * NOT turn-ending → do nothing (Larry keeps working honestly through the tool):
 *   - tool_use | tool_calls | function_call | pause_turn | null | unknown
 *
 * Unknown defaults to false on purpose: a missed `complete` just rides to the
 * director's safety timeout (the pre-existing behavior), whereas a wrong `true`
 * would celebrate mid-turn — strictly worse than the bug we're fixing.
 */
export function isTurnEndStopReason(s: string | null | undefined): boolean {
  switch (s) {
    case "end_turn":
    case "stop_sequence":
    case "max_tokens":
    case "stop":
    case "length":
      return true;
    default:
      return false;
  }
}

/**
 * Pull the most-recent `stop_reason` / `finish_reason` string value out of a
 * buffer of (possibly partial) SSE / JSON text. Returns the LAST quoted value
 * (the terminal one) or null. `stop_reason: null` (unquoted, in message_start /
 * intermediate chunks) deliberately does NOT match, so only the terminal event
 * is picked up.
 */
export function extractStopReason(text: string): string | null {
  const re = /"(?:stop_reason|finish_reason)"\s*:\s*"([a-z_]+)"/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

/**
 * Wrap a streaming response body in a PASSTHROUGH tee that scans the SSE text
 * for the turn-ending `stop_reason` and invokes `onStopReason` AT MOST ONCE.
 *
 * Safety contract (this sits in the hot user-response path):
 *   - every chunk is enqueued unchanged, FIRST and unconditionally — the scan
 *     can never alter, drop, reorder, or delay the bytes the client receives;
 *   - all scan work is wrapped so a throw can never disturb the passthrough;
 *   - a bounded tail buffer (the terminal stop_reason is always at the stream's
 *     end) keeps memory flat regardless of response size.
 */
export function attachCompletionScanner<T extends Uint8Array>(
  body: ReadableStream<T>,
  onStopReason: (stopReason: string) => void,
): ReadableStream<T> {
  const decoder = new TextDecoder();
  let tail = "";
  let fired = false;
  const ts = new TransformStream<T, T>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // PASSTHROUGH — always, first, unconditional.
      if (fired) return;
      try {
        tail += decoder.decode(chunk, { stream: true });
        if (tail.length > 8192) tail = tail.slice(-8192);
        const sr = extractStopReason(tail);
        if (sr) {
          fired = true; // one signal per stream — the terminal stop_reason
          onStopReason(sr);
        }
      } catch {
        // Never let scanning disturb the user's response.
      }
    },
  });
  return body.pipeThrough(ts);
}
