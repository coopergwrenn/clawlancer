/**
 * POST /api/match/v1/outcome
 *
 * Post-meeting outcome capture. Called by the user's agent after the
 * user replies to the "did you meet X?" Telegram prompt. Closes the
 * feedback loop for the 3-layer matching pipeline.
 *
 * Body:
 *   {
 *     // Identifier — one of these is required:
 *     outreach_log_id?: UUID,    // v1 INTRO_V1 path
 *     intro_id?: UUID,           // v2 negotiation path
 *     candidate_user_id?: UUID,  // fallback: (caller_user_id, candidate_user_id) — newest pair-row
 *
 *     // Outcome signals — at least one MUST be set:
 *     counterpart_response?: "accepted" | "declined" | "no_reply",  // v1 manual update
 *     meeting_actually_happened?: boolean,
 *     rating_post_meeting?: 1 | 2 | 3 | 4 | 5,
 *     reason_text?: string,
 *
 *     // Was this a scheduled cron prompt? Records the timestamp so the
 *     // cron doesn't re-prompt the same user about the same meeting.
 *     mark_prompted?: boolean
 *   }
 *
 * Auth: Bearer <gateway_token>. The caller's user must be the
 *   source_user_id on the outcome row — i.e., the user whose agent
 *   originally generated/sent the match. Receivers cannot mutate the
 *   outcome via this endpoint (a separate symmetric row would be needed
 *   for a candidate-perspective rating; deferred to v1.1).
 *
 * Returns:
 *   { ok: true, outcome_id, updated_fields: [...] }
 *   { ok: false, error: "..." }
 *
 * Per CLAUDE.md Rule 19: uses .select("*") for safety-critical reads.
 * Per Rule 11: maxDuration set for safety (no LLM calls but allows headroom).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const REASON_TEXT_MAX_CHARS = 4000;

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

export async function POST(req: NextRequest) {
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }

  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const sourceUserId = vm.assigned_to as string;

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

  // ── Validate identifier (one of three) ──
  const outreachLogId = b.outreach_log_id;
  const introId = b.intro_id;
  const candidateUserId = b.candidate_user_id;

  if (outreachLogId !== undefined && !isUUID(outreachLogId)) {
    return NextResponse.json({ error: "outreach_log_id must be UUID" }, { status: 400 });
  }
  if (introId !== undefined && !isUUID(introId)) {
    return NextResponse.json({ error: "intro_id must be UUID" }, { status: 400 });
  }
  if (candidateUserId !== undefined && !isUUID(candidateUserId)) {
    return NextResponse.json({ error: "candidate_user_id must be UUID" }, { status: 400 });
  }
  if (!outreachLogId && !introId && !candidateUserId) {
    return NextResponse.json(
      { error: "one of outreach_log_id, intro_id, or candidate_user_id is required" },
      { status: 400 }
    );
  }

  // ── Validate outcome signals (at least one) ──
  const counterpartResponse = typeof b.counterpart_response === "string" ? b.counterpart_response : null;
  if (counterpartResponse !== null && !["accepted", "declined", "no_reply"].includes(counterpartResponse)) {
    return NextResponse.json({ error: "counterpart_response must be accepted|declined|no_reply" }, { status: 400 });
  }

  const meetingHappenedRaw = b.meeting_actually_happened;
  const meetingHappened = typeof meetingHappenedRaw === "boolean" ? meetingHappenedRaw : null;

  const ratingRaw = b.rating_post_meeting;
  let rating: number | null = null;
  if (typeof ratingRaw === "number" && Number.isInteger(ratingRaw)) {
    if (ratingRaw < 1 || ratingRaw > 5) {
      return NextResponse.json({ error: "rating_post_meeting must be 1..5" }, { status: 400 });
    }
    rating = ratingRaw;
  } else if (ratingRaw !== undefined && ratingRaw !== null) {
    return NextResponse.json({ error: "rating_post_meeting must be an integer 1..5" }, { status: 400 });
  }

  const reasonTextRaw = typeof b.reason_text === "string" ? b.reason_text : null;
  const reasonText = reasonTextRaw ? reasonTextRaw.slice(0, REASON_TEXT_MAX_CHARS) : null;

  const markPrompted = b.mark_prompted === true;

  const anySignal = counterpartResponse !== null || meetingHappened !== null || rating !== null || reasonText !== null || markPrompted;
  if (!anySignal) {
    return NextResponse.json(
      { error: "at least one of counterpart_response, meeting_actually_happened, rating_post_meeting, reason_text, mark_prompted must be set" },
      { status: 400 }
    );
  }

  const supabase = getSupabase();

  // ── Locate the outcome row ──
  // Use .select("*") per Rule 19 — this is a safety-critical read and
  // we don't want PostgREST silently returning null for some column.
  type OutcomeRow = {
    outcome_id: string;
    source_user_id: string;
    candidate_user_id: string;
    outreach_log_id: string | null;
    intro_id: string | null;
    counterpart_response: string | null;
    meeting_actually_happened: boolean | null;
    rating_post_meeting: number | null;
  };
  let row: OutcomeRow | null = null;

  if (outreachLogId) {
    const { data, error } = await supabase
      .from("matchpool_outcomes")
      .select("*")
      .eq("outreach_log_id", outreachLogId)
      .eq("source_user_id", sourceUserId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: `lookup failed: ${error.message}` }, { status: 503 });
    }
    row = data as OutcomeRow | null;
  } else if (introId) {
    const { data, error } = await supabase
      .from("matchpool_outcomes")
      .select("*")
      .eq("intro_id", introId)
      .eq("source_user_id", sourceUserId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: `lookup failed: ${error.message}` }, { status: 503 });
    }
    row = data as OutcomeRow | null;
  } else if (candidateUserId) {
    // Fallback path: caller wants to report on a (me, candidate) pair
    // without specifying an outreach/intro. Pick the newest row matching.
    const { data, error } = await supabase
      .from("matchpool_outcomes")
      .select("*")
      .eq("source_user_id", sourceUserId)
      .eq("candidate_user_id", candidateUserId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: `lookup failed: ${error.message}` }, { status: 503 });
    }
    row = data as OutcomeRow | null;
  }

  if (!row) {
    return NextResponse.json({ error: "no matching outcome row found" }, { status: 404 });
  }
  // Caller-identity check — defensive even though the queries above
  // already filter by source_user_id.
  if (row.source_user_id !== sourceUserId) {
    return NextResponse.json({ error: "outcome row does not belong to caller" }, { status: 403 });
  }

  // ── Build the patch — only set fields that aren't already set ──
  // We do "first writer wins" semantics: if the meeting was already
  // rated, a second call doesn't overwrite the rating. Rationale: the
  // user gave us a signal once; a re-prompt shouldn't silently flip it.
  // (Admin updates can use service-role with explicit override.)
  const patch: Record<string, unknown> = {};
  const updatedFields: string[] = [];

  if (counterpartResponse !== null && row.counterpart_response === null) {
    patch.counterpart_response = counterpartResponse;
    updatedFields.push("counterpart_response");
  }
  if (meetingHappened !== null && row.meeting_actually_happened === null) {
    patch.meeting_actually_happened = meetingHappened;
    updatedFields.push("meeting_actually_happened");
  }
  if (rating !== null && row.rating_post_meeting === null) {
    patch.rating_post_meeting = rating;
    patch.rating_source = "user_self_report";
    updatedFields.push("rating_post_meeting", "rating_source");
  }
  if (reasonText !== null) {
    // Reason text is the only field we always overwrite — users might
    // add more context on a second prompt. Bounded to 4000 chars.
    patch.reason_text = reasonText;
    updatedFields.push("reason_text");
  }
  if (markPrompted) {
    patch.post_meeting_prompted_at = new Date().toISOString();
    updatedFields.push("post_meeting_prompted_at");
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({
      ok: true,
      outcome_id: row.outcome_id,
      updated_fields: [],
      note: "all fields already set; no-op",
    });
  }

  const { error: updErr } = await supabase
    .from("matchpool_outcomes")
    .update(patch)
    .eq("outcome_id", row.outcome_id);
  if (updErr) {
    return NextResponse.json({ error: `update failed: ${updErr.message}` }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    outcome_id: row.outcome_id,
    updated_fields: updatedFields,
  });
}
