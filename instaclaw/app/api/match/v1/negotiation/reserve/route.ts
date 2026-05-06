/**
 * POST /api/match/v1/negotiation/reserve
 *
 * Sender entry point for v2 negotiation. Creates a `negotiation_threads`
 * row + a turn-1 `negotiation_messages` row in PROPOSE state. Mirror
 * of v1's `/api/match/v1/outreach phase=reserve`, with thread state
 * machine + multi-window proposal payload.
 *
 * Body:
 *   {
 *     "target_user_id": "<uuid>",
 *     "anchor_v2": "<initiator_pv>:<target_uid>:<topic_hash>",
 *     "topic": "...",
 *     "rationale": "...",
 *     "proposed_windows": ["Wed 3-5pm at Aria espresso bar", ...],  // 1..5
 *     "deliberation_score": 0.78  // 0.0..1.0
 *   }
 *
 * Auth: gateway_token Bearer (caller is the initiator's VM).
 *
 * Response (allowed):
 *   { ok: true, allowed: true, thread_id, message_id, target_xmtp_address }
 *
 * Response (denied):
 *   { ok: true, allowed: false, reason: "rate_limited" | "duplicate" |
 *     "target_inbox_full" | "feature_disabled" | "no_xmtp_address" |
 *     "mutual_thread_active" | "target_not_found" }
 *
 * PRD: instaclaw/docs/prd/PRD-v2-agent-negotiation.md §5.4 + §3.6
 *      (idempotency) + §7.1 (mutual proposal soft dedup).
 *
 * Combined kill-switch with v1: CONSENSUS_INTRO_FLOW_ENABLED=false
 * gates BOTH v1 /outreach AND v2 /reserve. Rate limits and per-receiver
 * caps are SEPARATE per version in v2.0 (v1 traffic on agent_outreach_log,
 * v2 traffic on negotiation_messages). Combined caps deferred to v2.1
 * if needed. Documented in PRD §9.6.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { isOutreachEnabled, flagName } from "@/lib/outreach-feature-flag";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Mirror of v1's MAX_OUTREACH_PER_24H. PRD §7.5 says "Same protections
// as v1 INTRO." Separate counter on v2 traffic; revisit combined-count
// when phase 2 ramps.
const MAX_PROPOSE_PER_24H = 20;

const MESSAGE_PREVIEW_MAX_CHARS = 4000;

const MAX_PROPOSED_WINDOWS = 5;
const MIN_PROPOSED_WINDOWS = 1;
const MAX_TOPIC_CHARS = 500;
const MAX_RATIONALE_CHARS = 2000;
const MAX_WINDOW_CHARS = 200;

function getPerReceiverCap(): number {
  const raw = process.env.CONSENSUS_INTRO_PER_RECEIVER_CAP_24H;
  if (!raw) return 3;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 3;
  return n;
}

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
  const initiatorUserId = vm.assigned_to as string;
  const initiatorVmId = vm.id as string;
  const initiatorXmtp = vm.xmtp_address as string | null;
  if (!initiatorXmtp) {
    return NextResponse.json({ error: "VM has no xmtp_address" }, { status: 409 });
  }

  // ─ Kill switch ─
  if (!isOutreachEnabled()) {
    return NextResponse.json({
      ok: true,
      allowed: false,
      reason: "feature_disabled",
      flag: flagName(),
    });
  }

  // ─ Body validation ─
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

  const targetUserId = b.target_user_id;
  const anchorV2Raw = b.anchor_v2;
  const topicRaw = b.topic;
  const rationaleRaw = b.rationale;
  const windowsRaw = b.proposed_windows;
  const scoreRaw = b.deliberation_score;

  if (!isUUID(targetUserId)) {
    return NextResponse.json({ error: "target_user_id must be UUID" }, { status: 400 });
  }
  if (targetUserId === initiatorUserId) {
    return NextResponse.json({ error: "cannot negotiate with self" }, { status: 400 });
  }
  if (typeof anchorV2Raw !== "string" || anchorV2Raw.length === 0 || anchorV2Raw.length > 200) {
    return NextResponse.json({ error: "anchor_v2 must be 1..200 chars" }, { status: 400 });
  }
  const anchorV2 = anchorV2Raw;

  if (typeof topicRaw !== "string" || topicRaw.length === 0) {
    return NextResponse.json({ error: "topic required" }, { status: 400 });
  }
  if (typeof rationaleRaw !== "string" || rationaleRaw.length === 0) {
    return NextResponse.json({ error: "rationale required" }, { status: 400 });
  }
  const topic = topicRaw.slice(0, MAX_TOPIC_CHARS);
  const rationale = rationaleRaw.slice(0, MAX_RATIONALE_CHARS);

  if (!Array.isArray(windowsRaw)) {
    return NextResponse.json({ error: "proposed_windows must be array" }, { status: 400 });
  }
  if (windowsRaw.length < MIN_PROPOSED_WINDOWS || windowsRaw.length > MAX_PROPOSED_WINDOWS) {
    return NextResponse.json({
      error: `proposed_windows must have ${MIN_PROPOSED_WINDOWS}..${MAX_PROPOSED_WINDOWS} entries`,
    }, { status: 400 });
  }
  const windows: string[] = [];
  for (const w of windowsRaw) {
    if (typeof w !== "string" || w.length === 0) {
      return NextResponse.json({ error: "proposed_windows entries must be non-empty strings" }, { status: 400 });
    }
    windows.push(w.slice(0, MAX_WINDOW_CHARS));
  }

  // deliberation_score 0..1
  let score: number;
  if (typeof scoreRaw === "number" && Number.isFinite(scoreRaw) && scoreRaw >= 0 && scoreRaw <= 1) {
    score = scoreRaw;
  } else {
    return NextResponse.json({ error: "deliberation_score must be 0.0..1.0" }, { status: 400 });
  }

  const supabase = getSupabase();

  // ─ Idempotency check (PRD §3.6 layer 1) ─
  // Same (initiator, receiver, anchor_v2) → return existing thread.
  // Replays of the same pipeline cycle don't create duplicate threads.
  const { data: existing } = await supabase
    .from("negotiation_threads")
    .select("id, state, receiver_xmtp_address")
    .eq("initiator_user_id", initiatorUserId)
    .eq("receiver_user_id", targetUserId)
    .eq("anchor_v2", anchorV2)
    .maybeSingle();
  if (existing) {
    // Look up the turn-1 message id to return.
    const { data: m1 } = await supabase
      .from("negotiation_messages")
      .select("id")
      .eq("thread_id", existing.id as string)
      .eq("turn", 1)
      .maybeSingle();
    return NextResponse.json({
      ok: true,
      allowed: false,
      reason: "duplicate",
      existing_thread_id: existing.id,
      existing_message_id: m1?.id ?? null,
      existing_state: existing.state,
    });
  }

  // ─ Mutual-thread soft dedup (PRD §7.1) ─
  // If target user already has an active thread where they're INITIATOR
  // and we're receiver, refuse. Best-effort — race conditions can still
  // create both, but this catches the common case.
  const { data: mutual } = await supabase
    .from("negotiation_threads")
    .select("id, state")
    .eq("initiator_user_id", targetUserId)
    .eq("receiver_user_id", initiatorUserId)
    .in("state", ["proposed", "countered"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (mutual) {
    return NextResponse.json({
      ok: true,
      allowed: false,
      reason: "mutual_thread_active",
      existing_thread_id: mutual.id,
      existing_state: mutual.state,
    });
  }

  // ─ Rate limit (per-initiator) ─
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: senderCount, error: rateErr } = await supabase
    .from("negotiation_messages")
    .select("id", { count: "exact", head: true })
    .eq("sender_user_id", initiatorUserId)
    .eq("envelope_type", "propose")
    .gte("sent_at", sinceIso);
  if (rateErr) {
    return NextResponse.json({ error: "rate-limit query failed" }, { status: 503 });
  }
  if ((senderCount ?? 0) >= MAX_PROPOSE_PER_24H) {
    return NextResponse.json({
      ok: true,
      allowed: false,
      reason: "rate_limited",
      window_count: senderCount,
      window_cap: MAX_PROPOSE_PER_24H,
    });
  }

  // ─ Per-receiver cap ─
  // Counts ACTIVE threads where target is receiver (proposed or
  // countered). Once a thread terminates, it stops counting against
  // the cap — declined/expired/cancelled threads don't keep the inbox
  // "full". This is a stricter interpretation than v1 (which counted
  // pending+sent within 24h regardless of terminal state) but matches
  // the user-facing semantics: "you have N pending intros to act on."
  const perReceiverCap = getPerReceiverCap();
  if (perReceiverCap === 0) {
    return NextResponse.json({
      ok: true,
      allowed: false,
      reason: "target_inbound_disabled",
      env: "CONSENSUS_INTRO_PER_RECEIVER_CAP_24H=0",
    });
  }
  const { count: targetCount, error: targetErr } = await supabase
    .from("negotiation_threads")
    .select("id", { count: "exact", head: true })
    .eq("receiver_user_id", targetUserId)
    .in("state", ["proposed", "countered"]);
  if (targetErr) {
    return NextResponse.json({ error: "target-cap query failed" }, { status: 503 });
  }
  if ((targetCount ?? 0) >= perReceiverCap) {
    return NextResponse.json({
      ok: true,
      allowed: false,
      reason: "target_inbox_full",
      target_count: targetCount,
      target_cap: perReceiverCap,
    });
  }

  // ─ Resolve target reachability ─
  // Same gate the contact-info endpoint applies. Reachable agent =
  // healthy VM + non-null xmtp_address. Defense in depth against
  // matchpool-vs-VMs drift (Path A migration also gates retrieval,
  // but it might not be applied yet).
  const { data: targetVms, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("xmtp_address")
    .eq("assigned_to", targetUserId)
    .eq("health_status", "healthy")
    .not("xmtp_address", "is", null)
    .limit(1);
  if (vmErr) {
    return NextResponse.json({ error: "target VM lookup failed" }, { status: 503 });
  }
  const targetVm = (targetVms || [])[0];
  if (!targetVm) {
    return NextResponse.json({
      ok: true,
      allowed: false,
      reason: "target_not_found",
    });
  }
  const targetXmtp = (targetVm.xmtp_address as string).toLowerCase();

  // ─ Insert thread + turn-1 message ─
  // We do NOT use a transaction here because Supabase JS doesn't
  // support multi-statement tx. Instead: if the message INSERT fails
  // after the thread INSERT succeeded, the thread is orphaned but
  // harmless (state=proposed with no turn-1 message). Cron expiry will
  // eventually clean it up. The UNIQUE on threads still protects
  // against duplicate threads from retries.
  const { data: thread, error: threadErr } = await supabase
    .from("negotiation_threads")
    .insert({
      initiator_user_id: initiatorUserId,
      receiver_user_id: targetUserId,
      initiator_xmtp_address: initiatorXmtp.toLowerCase(),
      receiver_xmtp_address: targetXmtp,
      initiator_vm_id: initiatorVmId,
      anchor_v2: anchorV2,
      topic,
      rationale,
      proposed_windows: windows,
      deliberation_score: score,
      // state, current_turn, started_at, expires_at use defaults.
    })
    .select("id, expires_at")
    .single();

  if (threadErr) {
    // 23505 = unique violation on (initiator, receiver, anchor_v2)
    // Treat as duplicate (race with concurrent reserve).
    if ((threadErr as { code?: string }).code === "23505") {
      const { data: existingDup } = await supabase
        .from("negotiation_threads")
        .select("id, state")
        .eq("initiator_user_id", initiatorUserId)
        .eq("receiver_user_id", targetUserId)
        .eq("anchor_v2", anchorV2)
        .maybeSingle();
      return NextResponse.json({
        ok: true,
        allowed: false,
        reason: "duplicate",
        existing_thread_id: existingDup?.id ?? null,
        existing_state: existingDup?.state ?? null,
      });
    }
    return NextResponse.json({ error: "thread insert failed", detail: threadErr.message }, { status: 503 });
  }

  const messagePreview = `${topic}\n\n${rationale}`.slice(0, MESSAGE_PREVIEW_MAX_CHARS);

  const { data: msg, error: msgErr } = await supabase
    .from("negotiation_messages")
    .insert({
      thread_id: thread.id as string,
      turn: 1,
      envelope_type: "propose",
      sender_user_id: initiatorUserId,
      sender_xmtp_address: initiatorXmtp.toLowerCase(),
      payload: {
        topic,
        rationale,
        proposed_windows: windows,
        deliberation_score: score,
      },
      prose: messagePreview,
      status: "pending",
    })
    .select("id")
    .single();

  if (msgErr) {
    // Orphan thread (turn-1 message insert failed). Log but don't
    // attempt cleanup — the cron expiry path will handle it within
    // 24h. Return error so caller knows reserve didn't fully succeed.
    return NextResponse.json({
      ok: false,
      error: "message insert failed after thread created",
      detail: msgErr.message,
      orphan_thread_id: thread.id,
    }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    allowed: true,
    thread_id: thread.id,
    message_id: msg.id,
    target_xmtp_address: targetXmtp,
    expires_at: thread.expires_at,
  });
}
