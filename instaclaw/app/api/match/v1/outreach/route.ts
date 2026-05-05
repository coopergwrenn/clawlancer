/**
 * POST /api/match/v1/outreach
 *
 * Two-phase ledger for agent-to-agent intro DMs.
 *
 * Phase 1 — reserve (default if `phase` omitted):
 *   Pre-flight rate-limit + idempotency check. If allowed, INSERT a
 *   pending row in agent_outreach_log and return the log_id. The
 *   caller then attempts the XMTP send and reports back via phase=finalize.
 *
 *   Body:
 *     {
 *       "phase": "reserve",                    -- optional, default
 *       "target_user_id": "<uuid>",
 *       "target_xmtp_address": "0x...",
 *       "top1_anchor": "<pv>:<target_user_id>", -- idempotency key
 *       "message_preview": "..."               -- first ~280 chars for forensics
 *     }
 *
 *   Returns:
 *     { ok: true, allowed: true, log_id: "<uuid>" }
 *     { ok: true, allowed: false, reason: "rate_limited" | "duplicate" }
 *     -- duplicate may include existing_log_id for forensics
 *
 * Phase 2 — finalize:
 *   After the XMTP send, the caller updates the log to its terminal
 *   state. Required so we can answer "did the intro actually arrive?"
 *   without polling XMTP.
 *
 *   Body:
 *     {
 *       "phase": "finalize",
 *       "log_id": "<uuid>",
 *       "status": "sent" | "failed",
 *       "error_message": "..."   -- optional, only when status=failed
 *     }
 *
 *   Returns:
 *     { ok: true }
 *
 * Auth: Bearer <gateway_token>. Caller must be the outbound VM.
 *
 * Rate limit: MAX_OUTREACH_PER_24H per outbound_user_id (5 to start).
 *
 * Per CLAUDE.md Rule 14, billing classification is NOT consulted here —
 * outreach is a feature, not a paid action. Rate limit is the abuse gate.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Rate limit picked to allow ~one fresh top-1 per pipeline cycle (every
// 30 min) for a full 8-hour conference day, with headroom. 5 is too
// tight: a user whose match feed shifts hourly during a busy day will
// hit the cap by lunch and miss real intros for the rest of the day.
// 20 gives one intro every 24 minutes on average — well above the
// natural shift rate of a careful matching pipeline.
const MAX_OUTREACH_PER_24H = 20;
const MESSAGE_PREVIEW_MAX_CHARS = 500;

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

  // ── Phase: finalize ──
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

  // ── Phase: reserve (default) ──
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
