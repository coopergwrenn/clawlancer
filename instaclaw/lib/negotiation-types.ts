/**
 * v2 Agent-to-Agent Negotiation — shared types + state machine predicates.
 *
 * Source of truth for envelope shapes, thread states, and turn invariants.
 * Used by every server route under /api/match/v1/negotiation/*, the
 * cron expiry sweep, and the (separate) JS-side mjs receiver.
 *
 * PRD: instaclaw/docs/prd/PRD-v2-agent-negotiation.md §3 (protocol),
 *      §3.3 (state machine), §3.4 (turn invariant).
 */

// ─── Wire format constants ──────────────────────────────────────────

export const NEGOTIATION_V2_MARKER = "[INSTACLAW_AGENT_NEGOTIATION_V2]";
export const NEGOTIATION_V2_ACK_MARKER = "[INSTACLAW_AGENT_NEGOTIATION_ACK_V2]";
export const NEGOTIATION_SEPARATOR = "---";

// 8000 bytes total envelope cap (existing mjs listener limit). Telegram
// per-message cap is 4000 chars. The prose body is what gets surfaced
// to the user via Telegram, so the prose alone must respect 4000.
export const ENVELOPE_MAX_BYTES = 8000;
export const PROSE_MAX_CHARS = 4000;

// ─── Envelope types ─────────────────────────────────────────────────

export type EnvelopeType = "propose" | "counter" | "accept" | "decline" | "cancel";

export const ENVELOPE_TYPES: ReadonlySet<EnvelopeType> = new Set([
  "propose", "counter", "accept", "decline", "cancel",
]);

// ─── Thread states ──────────────────────────────────────────────────

export type ThreadState =
  | "proposed"
  | "countered"
  | "accepted"
  | "declined"
  | "cancelled"
  | "cancelled_by_user"
  | "expired";

export const TERMINAL_STATES: ReadonlySet<ThreadState> = new Set([
  "accepted", "declined", "cancelled", "cancelled_by_user", "expired",
]);

export const ACTIVE_STATES: ReadonlySet<ThreadState> = new Set([
  "proposed", "countered",
]);

export function isTerminal(state: ThreadState): boolean {
  return TERMINAL_STATES.has(state);
}

// ─── Decline categories ─────────────────────────────────────────────

export type DeclineCategory = "scheduling" | "not_interested" | "conflicting_intent" | "other";

export const DECLINE_CATEGORIES: ReadonlySet<DeclineCategory> = new Set([
  "scheduling", "not_interested", "conflicting_intent", "other",
]);

// ─── Cancel sub-flavors ─────────────────────────────────────────────

export type CancelOriginator = "agent" | "user_override";

// ─── Envelope payloads (one per type) ───────────────────────────────

export interface ProposePayload {
  topic: string;
  rationale: string;
  proposed_windows: string[]; // 1..5 free-text windows
  deliberation_score: number; // 0.0 .. 1.0 — sender's L3 confidence
}

export interface CounterPayload {
  counter_window: string;
  counter_topic: string | null;
  user_facing_reason: string;
}

export interface AcceptPayload {
  accepted_window: string; // must match a turn-1 proposed_window OR turn-2 counter_window
  user_facing_message: string;
}

export interface DeclinePayload {
  decline_category: DeclineCategory;
  user_facing_reason: string;
}

export interface CancelPayload {
  cancelled_by: CancelOriginator;
  user_facing_reason: string;
}

export type EnvelopePayload =
  | ProposePayload
  | CounterPayload
  | AcceptPayload
  | DeclinePayload
  | CancelPayload;

// ─── Common envelope header (all types share these fields) ──────────

export interface EnvelopeHeader<P extends EnvelopePayload = EnvelopePayload> {
  v: 2;
  type: EnvelopeType;
  thread_id: string;
  turn: 1 | 2 | 3 | 4;
  from_xmtp: string;
  from_user_id: string;
  from_name: string;
  from_telegram_handle?: string | null;
  from_telegram_bot_username?: string | null;
  from_identity_wallet?: string | null;
  payload: P;
}

// ─── Type guards ────────────────────────────────────────────────────

export function isProposeEnvelope(h: EnvelopeHeader): h is EnvelopeHeader<ProposePayload> {
  return h.type === "propose";
}
export function isCounterEnvelope(h: EnvelopeHeader): h is EnvelopeHeader<CounterPayload> {
  return h.type === "counter";
}
export function isAcceptEnvelope(h: EnvelopeHeader): h is EnvelopeHeader<AcceptPayload> {
  return h.type === "accept";
}
export function isDeclineEnvelope(h: EnvelopeHeader): h is EnvelopeHeader<DeclinePayload> {
  return h.type === "decline";
}
export function isCancelEnvelope(h: EnvelopeHeader): h is EnvelopeHeader<CancelPayload> {
  return h.type === "cancel";
}

// ─── State machine validator ────────────────────────────────────────

/**
 * Given the current thread state and an inbound envelope (turn + type),
 * return whether the transition is allowed. Server-side gate — clients
 * are not trusted with this logic. PRD §3.3.
 */
export function isTransitionAllowed(
  currentState: ThreadState,
  inboundType: EnvelopeType,
  inboundTurn: 1 | 2 | 3 | 4,
): { allowed: boolean; reason?: string } {
  if (TERMINAL_STATES.has(currentState)) {
    // Only USER_CANCEL within 1h is allowed past terminal — that gate
    // lives in /user-override, not here.
    if (currentState === "accepted" && inboundType === "cancel" && inboundTurn === 4) {
      return { allowed: true };
    }
    return { allowed: false, reason: `thread is terminal (${currentState})` };
  }

  // Turn 1 must be PROPOSE on a fresh thread (not represented as a state — no row exists).
  if (inboundTurn === 1) {
    if (inboundType !== "propose") return { allowed: false, reason: "turn 1 must be propose" };
    return { allowed: true };
  }

  // Turn 2 from current state proposed
  if (inboundTurn === 2) {
    if (currentState !== "proposed") return { allowed: false, reason: `turn 2 only valid from proposed (got ${currentState})` };
    if (!["accept", "counter", "decline", "cancel"].includes(inboundType)) {
      return { allowed: false, reason: `turn 2 invalid type (${inboundType})` };
    }
    return { allowed: true };
  }

  // Turn 3 from current state countered, must be terminal (no second counter)
  if (inboundTurn === 3) {
    if (currentState !== "countered") return { allowed: false, reason: `turn 3 only valid from countered (got ${currentState})` };
    if (inboundType === "counter") return { allowed: false, reason: "turn cap exceeded — no second counter" };
    if (!["accept", "decline", "cancel"].includes(inboundType)) {
      return { allowed: false, reason: `turn 3 invalid type (${inboundType})` };
    }
    return { allowed: true };
  }

  // Turn 4 (USER_CANCEL post-accept) — handled above
  return { allowed: false, reason: `turn ${inboundTurn} not allowed` };
}

/**
 * Compute the next state given (current state, applied envelope type).
 * Caller has already validated via isTransitionAllowed. Cancel from
 * USER_CANCEL grace window maps to cancelled_by_user; any other cancel
 * maps to plain cancelled.
 */
export function nextState(
  currentState: ThreadState,
  appliedType: EnvelopeType,
  cancelOriginator: CancelOriginator | null = null,
): ThreadState {
  if (appliedType === "propose") return "proposed";
  if (appliedType === "counter") return "countered";
  if (appliedType === "accept") return "accepted";
  if (appliedType === "decline") return "declined";
  if (appliedType === "cancel") {
    return cancelOriginator === "user_override" ? "cancelled_by_user" : "cancelled";
  }
  return currentState;
}
