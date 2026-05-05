/**
 * POST /api/match/v1/outreach
 *
 * Four-phase ledger for agent-to-agent intro DMs. The phases together
 * make XMTP delivery exactly-once-perceived even when the underlying
 * transport drops messages or peers are briefly offline:
 *
 *   reserve  →  finalize  →  ack         (happy path, sender + receiver)
 *               retry → ack              (XMTP redelivery loop)
 *
 * Phase 1 — reserve (default if `phase` omitted):
 *   Sender's pre-flight rate-limit + idempotency check. INSERT pending.
 *   Returns log_id used by every subsequent phase.
 *
 *   Body:
 *     { phase: "reserve", target_user_id, target_xmtp_address,
 *       top1_anchor, message_preview }
 *   Returns:
 *     { ok, allowed, log_id }
 *     { ok, allowed: false, reason: "rate_limited" | "duplicate", existing_log_id? }
 *
 * Phase 2 — finalize (sender):
 *   After the first XMTP send, sender records terminal status.
 *
 *   Body:
 *     { phase: "finalize", log_id, status: "sent"|"failed", error_message? }
 *   Returns:
 *     { ok }
 *
 * Phase 3 — retry (sender, NEW):
 *   When a row sits at status=sent + ack_received_at IS NULL for >15 min,
 *   the sender's pipeline re-fires the XMTP send and records the
 *   attempt here. Increments retry_count, sets last_retry_at. Capped
 *   at 3 retries by the client.
 *
 *   Body:
 *     { phase: "retry", log_id }
 *   Returns:
 *     { ok, retry_count }
 *
 * Phase 4 — ack (receiver, NEW):
 *   When the receiver successfully surfaces the intro to its human
 *   (Telegram, XMTP user channel, or pending-intros.jsonl), it marks
 *   ack_received_at so sender retries stop. Idempotent — a second
 *   ack is a no-op.
 *
 *   Body:
 *     { phase: "ack", log_id, channel: "telegram"|"xmtp_user"|"pending"|"polled" }
 *   Returns:
 *     { ok, already_acked? }
 *
 * Auth: Bearer <gateway_token>. Each phase enforces caller identity
 * against the appropriate side of the ledger row (outbound for retry,
 * target for ack).
 *
 * Rate limit on reserve: MAX_OUTREACH_PER_24H per outbound_user_id.
 * Per CLAUDE.md Rule 14, billing classification is NOT consulted here —
 * outreach is a feature, not a paid action.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { isOutreachEnabled, flagName } from "@/lib/outreach-feature-flag";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Rate limit picked to allow ~one fresh top-1 per pipeline cycle (every
// 30 min) for a full 8-hour conference day, with headroom. 5 is too
// tight: a user whose match feed shifts hourly during a busy day will
// hit the cap by lunch and miss real intros for the rest of the day.
// 20 gives one intro every 24 minutes on average — well above the
// natural shift rate of a careful matching pipeline.
const MAX_OUTREACH_PER_24H = 20;
// Stored on the row so the receiver-poll fallback can render the same
// content the XMTP envelope would have given. 4000 = Telegram's text
// cap; longer prose is truncated by the receiving renderer anyway.
const MESSAGE_PREVIEW_MAX_CHARS = 4000;
// Hard cap on retries — beyond this we give up and accept the intro
// ended in the pending-intros recovery file.
const MAX_RETRIES = 3;

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

function isXmtpAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

export async function POST(req: NextRequest) {
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json(
      { error: "Missing authentication" },
      { status: 401 }
    );
  }

  const vm = await lookupVMByGatewayToken(
    gatewayToken,
    "id, assigned_to, xmtp_address"
  );
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const outboundUserId = vm.assigned_to as string;
  const outboundVmId = vm.id as string;
  const outboundXmtpAddress = vm.xmtp_address as string | null;
  if (!outboundXmtpAddress) {
    return NextResponse.json({ error: "VM has no xmtp_address" }, { status: 409 });
  }

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
  const phase = (typeof b.phase === "string" ? b.phase : "reserve").toLowerCase();

  const supabase = getSupabase();

  // ── Phase: finalize (sender) ──
  if (phase === "finalize") {
    const logId = b.log_id;
    const status = b.status;
    const errorMessage = typeof b.error_message === "string" ? b.error_message.slice(0, 500) : null;
    if (!isUUID(logId)) return NextResponse.json({ error: "log_id must be UUID" }, { status: 400 });
    if (status !== "sent" && status !== "failed") {
      return NextResponse.json({ error: 'status must be "sent" or "failed"' }, { status: 400 });
    }

    // Only the original outbound user may finalize. Defensive — prevents
    // a different VM from flipping someone else's pending row.
    const { data: existing, error: lookupErr } = await supabase
      .from("agent_outreach_log")
      .select("id, outbound_user_id, status")
      .eq("id", logId)
      .single();
    if (lookupErr || !existing) {
      return NextResponse.json({ error: "log_id not found" }, { status: 404 });
    }
    if (existing.outbound_user_id !== outboundUserId) {
      return NextResponse.json({ error: "log_id belongs to a different user" }, { status: 403 });
    }
    if (existing.status !== "pending") {
      return NextResponse.json({ ok: true, already_terminal: existing.status });
    }

    const { error: updErr } = await supabase
      .from("agent_outreach_log")
      .update({ status, error_message: errorMessage })
      .eq("id", logId);
    if (updErr) {
      return NextResponse.json({ error: "update failed" }, { status: 503 });
    }
    return NextResponse.json({ ok: true });
  }

  // ── Phase: retry (sender) ──
  if (phase === "retry") {
    if (!isOutreachEnabled()) {
      // Kill-switch: don't bump retry counters when the feature is
      // disabled. The sender's pipeline will see allowed=false and
      // skip; ledger rows freeze at their current state until the
      // flag flips back.
      return NextResponse.json({
        ok: true,
        allowed: false,
        reason: "feature_disabled",
        flag: flagName(),
      });
    }
    const logId = b.log_id;
    if (!isUUID(logId)) return NextResponse.json({ error: "log_id must be UUID" }, { status: 400 });

    const { data: existing, error: lookupErr } = await supabase
      .from("agent_outreach_log")
      .select("id, outbound_user_id, status, retry_count, ack_received_at")
      .eq("id", logId)
      .single();
    if (lookupErr || !existing) {
      return NextResponse.json({ error: "log_id not found" }, { status: 404 });
    }
    if (existing.outbound_user_id !== outboundUserId) {
      return NextResponse.json({ error: "log_id belongs to a different user" }, { status: 403 });
    }
    if (existing.ack_received_at) {
      // Receiver already acked — no point retrying. Tell the sender
      // so it stops the loop.
      return NextResponse.json({ ok: true, already_acked: true, retry_count: existing.retry_count });
    }
    if ((existing.retry_count as number) >= MAX_RETRIES) {
      return NextResponse.json({ ok: true, capped: true, retry_count: existing.retry_count });
    }
    const { data: updated, error: updErr } = await supabase
      .from("agent_outreach_log")
      .update({
        retry_count: ((existing.retry_count as number) || 0) + 1,
        last_retry_at: new Date().toISOString(),
      })
      .eq("id", logId)
      .select("retry_count")
      .single();
    if (updErr || !updated) {
      return NextResponse.json({ error: "update failed" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, retry_count: updated.retry_count });
  }

  // ── Phase: ack (receiver) ──
  if (phase === "ack") {
    const logId = b.log_id;
    const channel = typeof b.channel === "string" ? b.channel : null;
    if (!isUUID(logId)) return NextResponse.json({ error: "log_id must be UUID" }, { status: 400 });
    const ALLOWED_CHANNELS = ["telegram", "xmtp_user", "pending", "polled"] as const;
    if (!channel || !ALLOWED_CHANNELS.includes(channel as (typeof ALLOWED_CHANNELS)[number])) {
      return NextResponse.json({ error: `channel must be one of ${ALLOWED_CHANNELS.join("|")}` }, { status: 400 });
    }

    // The "outboundUserId" var in this scope is the CALLER. For ack the
    // caller is the RECEIVER, so we check target_user_id matches.
    const { data: existing, error: lookupErr } = await supabase
      .from("agent_outreach_log")
      .select("id, target_user_id, ack_received_at")
      .eq("id", logId)
      .single();
    if (lookupErr || !existing) {
      return NextResponse.json({ error: "log_id not found" }, { status: 404 });
    }
    if (existing.target_user_id !== outboundUserId) {
      return NextResponse.json({ error: "log_id does not target this caller" }, { status: 403 });
    }
    if (existing.ack_received_at) {
      return NextResponse.json({ ok: true, already_acked: true });
    }

    const { error: updErr } = await supabase
      .from("agent_outreach_log")
      .update({
        ack_received_at: new Date().toISOString(),
        ack_channel: channel,
      })
      .eq("id", logId)
      // Race-tight: only update if still NULL (the partial-index
      // optimisation; second ACK becomes a no-op).
      .is("ack_received_at", null);
    if (updErr) {
      return NextResponse.json({ error: "update failed" }, { status: 503 });
    }
    return NextResponse.json({ ok: true });
  }

  // ── Phase: reserve (default) ──
  if (!isOutreachEnabled()) {
    // Kill-switch — refuse new outreach. Default response shape mirrors
    // the rate-limit / duplicate denial so the sender's pipeline treats
    // it as a soft skip instead of a hard error.
    return NextResponse.json({
      ok: true,
      allowed: false,
      reason: "feature_disabled",
      flag: flagName(),
    });
  }
  const targetUserId = b.target_user_id;
  const targetXmtpAddress = b.target_xmtp_address;
  const top1Anchor = b.top1_anchor;
  const messagePreviewRaw = typeof b.message_preview === "string" ? b.message_preview : "";

  if (!isUUID(targetUserId)) {
    return NextResponse.json({ error: "target_user_id must be UUID" }, { status: 400 });
  }
  if (!isXmtpAddress(targetXmtpAddress)) {
    return NextResponse.json({ error: "target_xmtp_address must be 0x + 40 hex" }, { status: 400 });
  }
  if (typeof top1Anchor !== "string" || top1Anchor.length === 0 || top1Anchor.length > 200) {
    return NextResponse.json({ error: "top1_anchor must be 1..200 chars" }, { status: 400 });
  }
  if (targetUserId === outboundUserId) {
    return NextResponse.json({ error: "cannot DM self" }, { status: 400 });
  }
  const messagePreview = messagePreviewRaw.slice(0, MESSAGE_PREVIEW_MAX_CHARS);

  // Rate limit: 5 outreach per 24h per outbound user.
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error: countErr } = await supabase
    .from("agent_outreach_log")
    .select("id", { count: "exact", head: true })
    .eq("outbound_user_id", outboundUserId)
    .gte("sent_at", sinceIso);
  if (countErr) {
    return NextResponse.json({ error: "rate-limit query failed" }, { status: 503 });
  }
  if ((count ?? 0) >= MAX_OUTREACH_PER_24H) {
    return NextResponse.json({
      ok: true,
      allowed: false,
      reason: "rate_limited",
      window_count: count,
      window_cap: MAX_OUTREACH_PER_24H,
    });
  }

  // Insert pending row. Unique index on (outbound_user_id, target_user_id, top1_anchor)
  // gives idempotency: same anchor on a re-run -> 23505 -> duplicate.
  const { data: inserted, error: insErr } = await supabase
    .from("agent_outreach_log")
    .insert({
      outbound_user_id: outboundUserId,
      outbound_vm_id: outboundVmId,
      outbound_xmtp_address: outboundXmtpAddress,
      target_user_id: targetUserId,
      target_xmtp_address: targetXmtpAddress,
      top1_anchor: top1Anchor,
      message_preview: messagePreview,
      status: "pending",
    })
    .select("id")
    .single();

  if (insErr) {
    // 23505 = unique_violation
    if ((insErr as { code?: string }).code === "23505") {
      const { data: existingDup } = await supabase
        .from("agent_outreach_log")
        .select("id")
        .eq("outbound_user_id", outboundUserId)
        .eq("target_user_id", targetUserId)
        .eq("top1_anchor", top1Anchor)
        .single();
      return NextResponse.json({
        ok: true,
        allowed: false,
        reason: "duplicate",
        existing_log_id: existingDup?.id ?? null,
      });
    }
    return NextResponse.json({ error: "insert failed" }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    allowed: true,
    log_id: inserted.id,
  });
}
