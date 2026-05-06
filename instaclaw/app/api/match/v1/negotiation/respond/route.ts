/**
 * POST /api/match/v1/negotiation/respond
 *
 * Apply a state transition to a negotiation thread. The trust boundary
 * — clients (gateway tool, consensus_agent_negotiation.py, /user-override)
 * propose envelopes; THIS endpoint validates and commits them. Anything
 * the client claims (turn number, transition validity, authorization)
 * is verified server-side before any write.
 *
 * Body:
 *   {
 *     "thread_id": "<uuid>",
 *     "envelope_type": "accept" | "counter" | "decline" | "cancel",
 *     "payload": { ...type-specific... },
 *     "triggered_by": "user" | "agent_autonomous" | "agent_expiry"
 *   }
 *
 * Auth: gateway_token Bearer. Caller's user_id must be initiator OR
 *       receiver of the thread.
 *
 * Validation order (each step's failure is non-recoverable, returns
 * appropriate status):
 *   1. Auth → caller's user_id
 *   2. Body shape + envelope_type ∈ valid set
 *   3. Thread exists; caller is initiator or receiver
 *   4. nextTurnFromState(thread.state, type) — compute server-side
 *   5. isTransitionAllowed(thread.state, type, turn) — state machine
 *   6. isCallerAuthorizedForTurn(caller, initiator, receiver, turn, type)
 *   7. Type-specific payload validation
 *   8. INSERT message (replay-safe via UNIQUE)
 *   9. UPDATE thread state + current_turn + terminated_at if terminal
 *   10. Build envelope to return
 *
 * Returns:
 *   { ok, applied, new_state, terminal, envelope_to_send, envelope_prose }
 *
 * Replays (same envelope already on this thread+turn):
 *   { ok: true, applied: false, no_op: true, existing_message_id, ... }
 *
 * PRD: instaclaw/docs/prd/PRD-v2-agent-negotiation.md §5.4 (/respond),
 *      §3.2 (envelope payloads), §3.3 (state machine).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import {
  ENVELOPE_TYPES,
  DECLINE_CATEGORIES,
  type EnvelopeType,
  type ThreadState,
  type CancelOriginator,
} from "@/lib/negotiation-types";
import {
  isTransitionAllowed,
  nextState,
  nextTurnFromState,
  isCallerAuthorizedForTurn,
  isWithinUserCancelGrace,
  cancelOriginatorFor,
  isTerminal,
} from "@/lib/negotiation-state-machine";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_USER_FACING_REASON_CHARS = 1500;
const MAX_USER_FACING_MESSAGE_CHARS = 2000;
const MAX_WINDOW_CHARS = 200;
const MAX_TOPIC_CHARS = 500;

const VALID_TRIGGERED_BY = new Set(["user", "agent_autonomous", "agent_expiry"]);

function extractGatewayToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const xGate = req.headers.get("x-gateway-token");
  if (xGate?.trim()) return xGate.trim();
  return null;
}

function isUUID(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

interface PayloadValidation {
  ok: true;
  cleaned: Record<string, unknown>;
}
interface PayloadValidationError {
  ok: false;
  error: string;
}

function validatePayload(
  type: EnvelopeType,
  raw: unknown,
  proposedWindows: string[] | null,
  counterWindow: string | null,
): PayloadValidation | PayloadValidationError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "payload must be an object" };
  }
  const p = raw as Record<string, unknown>;

  if (type === "accept") {
    const w = p.accepted_window;
    if (typeof w !== "string" || w.length === 0 || w.length > MAX_WINDOW_CHARS) {
      return { ok: false, error: "accepted_window required (1..200 chars)" };
    }
    // Server-side validation: accepted_window must match a turn-1
    // proposed_window OR the turn-2 counter_window. PRD §3.2.3.
    const allowedWindows: string[] = [];
    if (proposedWindows) allowedWindows.push(...proposedWindows);
    if (counterWindow) allowedWindows.push(counterWindow);
    if (!allowedWindows.includes(w)) {
      return {
        ok: false,
        error: `accepted_window must match a previously proposed window. Allowed: ${JSON.stringify(allowedWindows)}`,
      };
    }
    const msg = p.user_facing_message;
    return {
      ok: true,
      cleaned: {
        accepted_window: w,
        user_facing_message: typeof msg === "string"
          ? msg.slice(0, MAX_USER_FACING_MESSAGE_CHARS)
          : "",
      },
    };
  }

  if (type === "counter") {
    const w = p.counter_window;
    if (typeof w !== "string" || w.length === 0 || w.length > MAX_WINDOW_CHARS) {
      return { ok: false, error: "counter_window required (1..200 chars)" };
    }
    const reason = p.user_facing_reason;
    if (typeof reason !== "string" || reason.length === 0) {
      return { ok: false, error: "user_facing_reason required" };
    }
    const topic = p.counter_topic;
    return {
      ok: true,
      cleaned: {
        counter_window: w,
        counter_topic: typeof topic === "string" ? topic.slice(0, MAX_TOPIC_CHARS) : null,
        user_facing_reason: reason.slice(0, MAX_USER_FACING_REASON_CHARS),
      },
    };
  }

  if (type === "decline") {
    const cat = p.decline_category;
    if (typeof cat !== "string" || !DECLINE_CATEGORIES.has(cat as never)) {
      return {
        ok: false,
        error: `decline_category must be one of: ${Array.from(DECLINE_CATEGORIES).join(", ")}`,
      };
    }
    const reason = p.user_facing_reason;
    if (typeof reason !== "string") {
      return { ok: false, error: "user_facing_reason required (may be empty)" };
    }
    return {
      ok: true,
      cleaned: {
        decline_category: cat,
        user_facing_reason: reason.slice(0, MAX_USER_FACING_REASON_CHARS),
      },
    };
  }

  if (type === "cancel") {
    const cancelledBy = p.cancelled_by;
    if (cancelledBy !== "agent" && cancelledBy !== "user_override") {
      return { ok: false, error: "cancelled_by must be 'agent' or 'user_override'" };
    }
    const reason = p.user_facing_reason;
    return {
      ok: true,
      cleaned: {
        cancelled_by: cancelledBy,
        user_facing_reason: typeof reason === "string"
          ? reason.slice(0, MAX_USER_FACING_REASON_CHARS)
          : "",
      },
    };
  }

  return { ok: false, error: `unknown envelope_type: ${type}` };
}

export async function POST(req: NextRequest) {
  // ─ Auth ─
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }
  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to, xmtp_address");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const callerUserId = vm.assigned_to as string;
  const callerXmtp = (vm.xmtp_address as string | null);
  if (!callerXmtp) {
    return NextResponse.json({ error: "VM has no xmtp_address" }, { status: 409 });
  }

  // ─ Body ─
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const threadId = b.thread_id;
  const envelopeTypeRaw = b.envelope_type;
  const triggeredByRaw = b.triggered_by;

  if (!isUUID(threadId)) {
    return NextResponse.json({ error: "thread_id must be UUID" }, { status: 400 });
  }
  if (typeof envelopeTypeRaw !== "string" || !ENVELOPE_TYPES.has(envelopeTypeRaw as never)) {
    return NextResponse.json({
      error: `envelope_type must be one of: ${Array.from(ENVELOPE_TYPES).join(", ")}`,
    }, { status: 400 });
  }
  // PROPOSE belongs to /reserve, never /respond.
  if (envelopeTypeRaw === "propose") {
    return NextResponse.json({
      error: "PROPOSE envelopes go through /api/match/v1/negotiation/reserve, not /respond",
    }, { status: 400 });
  }
  const envelopeType = envelopeTypeRaw as EnvelopeType;

  if (typeof triggeredByRaw !== "string" || !VALID_TRIGGERED_BY.has(triggeredByRaw)) {
    return NextResponse.json({
      error: `triggered_by must be one of: ${Array.from(VALID_TRIGGERED_BY).join(", ")}`,
    }, { status: 400 });
  }

  const supabase = getSupabase();

  // ─ Load thread ─
  const { data: thread, error: threadErr } = await supabase
    .from("negotiation_threads")
    .select("*")
    .eq("id", threadId)
    .maybeSingle();
  if (threadErr) {
    return NextResponse.json({ error: "thread lookup failed" }, { status: 503 });
  }
  if (!thread) {
    return NextResponse.json({ error: "thread not found" }, { status: 404 });
  }
  const initiatorUserId = thread.initiator_user_id as string;
  const receiverUserId = thread.receiver_user_id as string;
  const currentState = thread.state as ThreadState;
  const proposedWindows = (thread.proposed_windows as string[] | null) ?? null;

  if (callerUserId !== initiatorUserId && callerUserId !== receiverUserId) {
    return NextResponse.json({
      error: "caller is not initiator or receiver of this thread",
    }, { status: 403 });
  }

  // ─ Compute server-side turn ─
  let inboundTurn = nextTurnFromState(currentState, envelopeType);
  if (inboundTurn === null) {
    // Special case: if current state is 'accepted' and envelope is
    // 'cancel', it might be the USER_CANCEL grace path (turn 4).
    // nextTurnFromState already returns 4 for this case, so reaching
    // null here means a genuinely invalid combination.
    return NextResponse.json({
      ok: true,
      applied: false,
      new_state: currentState,
      terminal: isTerminal(currentState),
      reason: `no valid turn for ${envelopeType} from state ${currentState}`,
    });
  }

  // Turn 4 is USER_CANCEL only — additional grace-window check.
  if (inboundTurn === 4) {
    if (envelopeType !== "cancel") {
      return NextResponse.json({
        error: "turn 4 only valid for USER_CANCEL (cancel envelope)",
      }, { status: 422 });
    }
    if (!isWithinUserCancelGrace(currentState, thread.terminated_at as string | null)) {
      return NextResponse.json({
        ok: true,
        applied: false,
        new_state: currentState,
        terminal: true,
        reason: "grace_window_expired",
        advice: "1-hour USER_CANCEL window has lapsed. DM the other party directly.",
      });
    }
  }

  // ─ State machine validation ─
  const transition = isTransitionAllowed(currentState, envelopeType, inboundTurn);
  if (!transition.allowed) {
    return NextResponse.json({
      ok: true,
      applied: false,
      new_state: currentState,
      terminal: isTerminal(currentState),
      reason: `transition_disallowed: ${transition.reason}`,
    }, { status: 422 });
  }

  // ─ Authorization: caller must be the right party for this turn ─
  const auth = isCallerAuthorizedForTurn(
    callerUserId,
    initiatorUserId,
    receiverUserId,
    inboundTurn,
    envelopeType,
  );
  if (!auth.allowed) {
    return NextResponse.json({ error: `unauthorized: ${auth.reason}` }, { status: 403 });
  }

  // ─ Counter window resolution (for accept-after-counter validation) ─
  let counterWindow: string | null = null;
  if (envelopeType === "accept" && currentState === "countered") {
    const { data: turn2 } = await supabase
      .from("negotiation_messages")
      .select("payload")
      .eq("thread_id", threadId)
      .eq("turn", 2)
      .eq("envelope_type", "counter")
      .maybeSingle();
    counterWindow = (turn2?.payload as Record<string, unknown> | null)?.counter_window as string | null ?? null;
  }

  // ─ Type-specific payload validation ─
  const payloadValid = validatePayload(envelopeType, b.payload, proposedWindows, counterWindow);
  if (!payloadValid.ok) {
    return NextResponse.json({ error: payloadValid.error }, { status: 400 });
  }
  const cleanedPayload = payloadValid.cleaned;

  // ─ INSERT message (replay-safe) ─
  const { data: msg, error: msgErr } = await supabase
    .from("negotiation_messages")
    .insert({
      thread_id: threadId,
      turn: inboundTurn,
      envelope_type: envelopeType,
      sender_user_id: callerUserId,
      sender_xmtp_address: callerXmtp.toLowerCase(),
      payload: cleanedPayload,
      status: "pending",
    })
    .select("id")
    .single();

  if (msgErr) {
    if ((msgErr as { code?: string }).code === "23505") {
      // Replay — same thread+turn already has a message. Return the
      // existing one as no-op success.
      const { data: existing } = await supabase
        .from("negotiation_messages")
        .select("id, envelope_type, payload, status")
        .eq("thread_id", threadId)
        .eq("turn", inboundTurn)
        .maybeSingle();
      return NextResponse.json({
        ok: true,
        applied: false,
        no_op: true,
        new_state: currentState,
        terminal: isTerminal(currentState),
        existing_message_id: existing?.id ?? null,
      });
    }
    return NextResponse.json({ error: "message insert failed", detail: msgErr.message }, { status: 503 });
  }

  // ─ UPDATE thread state ─
  const cancelOriginator: CancelOriginator | null =
    envelopeType === "cancel"
      ? cancelOriginatorFor(inboundTurn, (cleanedPayload.cancelled_by as CancelOriginator) ?? null)
      : null;
  const newState = nextState(currentState, envelopeType, cancelOriginator);
  const terminal = isTerminal(newState);

  const threadUpdate: Record<string, unknown> = {
    state: newState,
    current_turn: inboundTurn,
  };
  if (terminal) {
    threadUpdate.terminated_at = new Date().toISOString();
  } else {
    // Reset expires_at on each non-terminal turn so an active
    // back-and-forth doesn't time out mid-conversation.
    threadUpdate.expires_at = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  }
  // On ACCEPT, persist agreed_window for fast reads from /my-threads
  // and the dashboard.
  if (envelopeType === "accept") {
    threadUpdate.agreed_window = cleanedPayload.accepted_window;
  }

  const { error: tUpdErr } = await supabase
    .from("negotiation_threads")
    .update(threadUpdate)
    .eq("id", threadId);
  if (tUpdErr) {
    // Message already inserted, thread state didn't update. The next
    // legitimate turn will fail validation (state stale), and the
    // expiry cron will eventually clean up. Caller treats this as
    // a transient error worth retrying.
    return NextResponse.json({
      error: "thread state update failed (message inserted but state stale)",
      detail: tUpdErr.message,
      message_id: msg.id,
    }, { status: 503 });
  }

  // ─ Build envelope payload to return ─
  // The caller (gateway tool / mjs / sender pipeline) takes this
  // header + builds the wire format with NEGOTIATION_V2_MARKER.
  // The envelope's `from_*` fields are filled in by the caller from
  // its own self-info — server doesn't presume.
  const envelopeHeader = {
    v: 2 as const,
    type: envelopeType,
    thread_id: threadId,
    turn: inboundTurn,
    payload: cleanedPayload,
  };
  const envelopeProse = buildProsePreview(envelopeType, cleanedPayload);

  return NextResponse.json({
    ok: true,
    applied: true,
    new_state: newState,
    terminal,
    message_id: msg.id,
    thread_id: threadId,
    envelope_to_send: envelopeHeader,
    envelope_prose: envelopeProse,
  });
}

/**
 * Build a short prose preview for the envelope body. The receiver-side
 * mjs renders the rich user-facing copy via /decide; this is the
 * fallback shown when /decide is unreachable AND the disk-only
 * persistence path. Keep it brief but informative.
 */
function buildProsePreview(type: EnvelopeType, payload: Record<string, unknown>): string {
  if (type === "accept") {
    return `Accepted: ${payload.accepted_window}. ${payload.user_facing_message || ""}`.trim();
  }
  if (type === "counter") {
    return `Counter: ${payload.counter_window}. ${payload.user_facing_reason || ""}`.trim();
  }
  if (type === "decline") {
    return `Declined (${payload.decline_category}). ${payload.user_facing_reason || ""}`.trim();
  }
  if (type === "cancel") {
    return `Cancelled (${payload.cancelled_by}). ${payload.user_facing_reason || ""}`.trim();
  }
  return "";
}
