/**
 * v2 Agent-to-Agent Negotiation — state machine.
 *
 * Three concerns separated from negotiation-types.ts so the type-only
 * import (used by mjs-adjacent code, MCP tool, dashboards) stays small:
 *   1. Turn-invariant validator (which envelope types are valid at
 *      each turn of each state)
 *   2. State-set predicates (terminal vs active, by-actor)
 *   3. Transition function (state × envelope-type → next state)
 *
 * Server-side gate. Clients are not trusted with this logic — every
 * /api/match/v1/negotiation/* route that mutates state must run the
 * inbound envelope through isTransitionAllowed BEFORE writing.
 *
 * PRD: instaclaw/docs/prd/PRD-v2-agent-negotiation.md §3.3 + §3.4.
 */
import type {
  EnvelopeType,
  ThreadState,
  CancelOriginator,
} from "./negotiation-types";

// ─── Re-exported predicates from negotiation-types.ts ───────────────
//
// These live in the types file because TS recursive imports get
// tangled if we duplicate them. Keep the canonical source there;
// just re-export here so /api routes can `import { isTerminal,
// isTransitionAllowed } from "@/lib/negotiation-state-machine"` and
// not need two imports.
export {
  TERMINAL_STATES,
  ACTIVE_STATES,
  isTerminal,
  isTransitionAllowed,
  nextState,
} from "./negotiation-types";

// ─── Turn role: who is allowed to send turn N? ──────────────────────

/**
 * Turn 1: initiator (PROPOSE).
 * Turn 2: responder (ACCEPT / COUNTER / DECLINE / CANCEL-by-initiator).
 *   Note: turn 2 CANCEL is a special case — the initiator can CANCEL
 *   their own PROPOSE while it's still PROPOSED. So turn 2 is
 *   "whoever responds first", not strictly the responder.
 * Turn 3: initiator (ACCEPT / DECLINE / CANCEL on a COUNTER).
 * Turn 4: responder's user, USER_CANCEL only, within 1h grace.
 */
export type TurnRole = "initiator" | "responder" | "either" | "responder_user";

export function expectedTurnRole(turn: 1 | 2 | 3 | 4, type: EnvelopeType): TurnRole {
  if (turn === 1) return "initiator";
  if (turn === 2) {
    // CANCEL at turn 2 is the initiator taking back their PROPOSE.
    // Other types at turn 2 are the responder reacting to PROPOSE.
    return type === "cancel" ? "either" : "responder";
  }
  if (turn === 3) {
    // CANCEL at turn 3 could be either — but ACCEPT/DECLINE at turn 3
    // is always initiator (responding to COUNTER).
    return type === "cancel" ? "either" : "initiator";
  }
  if (turn === 4) {
    // Turn 4 is only USER_CANCEL post-ACCEPTED grace.
    return "responder_user";
  }
  return "either";
}

/**
 * Given the thread parties + caller, return whether the caller is
 * authorized to send the given turn. Used by /respond and
 * /user-override before applying any state transition.
 */
export function isCallerAuthorizedForTurn(
  callerUserId: string,
  initiatorUserId: string,
  receiverUserId: string,
  turn: 1 | 2 | 3 | 4,
  envelopeType: EnvelopeType,
): { allowed: boolean; reason?: string } {
  const isInitiator = callerUserId === initiatorUserId;
  const isReceiver = callerUserId === receiverUserId;
  if (!isInitiator && !isReceiver) {
    return { allowed: false, reason: "caller is neither initiator nor receiver of thread" };
  }
  const role = expectedTurnRole(turn, envelopeType);
  if (role === "either") return { allowed: true };
  if (role === "initiator") {
    if (!isInitiator) return { allowed: false, reason: `turn ${turn} ${envelopeType} must be sent by initiator` };
    return { allowed: true };
  }
  if (role === "responder" || role === "responder_user") {
    if (!isReceiver) return { allowed: false, reason: `turn ${turn} ${envelopeType} must be sent by responder` };
    return { allowed: true };
  }
  return { allowed: false, reason: "unrecognized turn role" };
}

// ─── 1-hour USER_CANCEL grace window helper ─────────────────────────

const USER_CANCEL_GRACE_MS = 60 * 60 * 1000;

/**
 * For a thread in state='accepted', is `now` still within the
 * 1-hour USER_CANCEL grace window measured from terminated_at?
 *
 * Returns false if:
 *   - thread is not accepted (USER_CANCEL only valid post-ACCEPT)
 *   - terminated_at is null (defensive — schema CHECK should prevent
 *     this, but UI/cron code shouldn't crash on a hypothetical NULL)
 *   - now > terminated_at + 1h
 */
export function isWithinUserCancelGrace(
  state: ThreadState,
  terminatedAtIso: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (state !== "accepted") return false;
  if (!terminatedAtIso) return false;
  const t = Date.parse(terminatedAtIso);
  if (Number.isNaN(t)) return false;
  return nowMs - t <= USER_CANCEL_GRACE_MS;
}

// ─── Compute the inbound turn from current thread state ─────────────

/**
 * Given a thread's current state, what's the next valid turn number?
 * Used by /respond and /user-override before they call
 * isTransitionAllowed.
 *
 * Returns null if no further turn is valid (terminal except for the
 * USER_CANCEL grace path, which the caller resolves separately).
 */
export function nextTurnFromState(
  state: ThreadState,
  envelopeType: EnvelopeType,
): 1 | 2 | 3 | 4 | null {
  // Brand new thread (no negotiation_threads row exists yet) → turn 1.
  // The /reserve endpoint handles this case before calling here.
  if (state === "proposed") return 2;
  if (state === "countered") return 3;
  if (state === "accepted" && envelopeType === "cancel") return 4;
  return null;
}

// ─── Cancel-originator inference ────────────────────────────────────

/**
 * For nextState's cancelOriginator parameter: turn 4 cancel is always
 * USER_CANCEL (CANCELLED_BY_USER state). All other cancels are agent-
 * initiated unless explicitly tagged user_override in the payload.
 */
export function cancelOriginatorFor(
  turn: 1 | 2 | 3 | 4,
  payloadCancelledBy: CancelOriginator | null,
): CancelOriginator {
  if (turn === 4) return "user_override";
  return payloadCancelledBy === "user_override" ? "user_override" : "agent";
}
