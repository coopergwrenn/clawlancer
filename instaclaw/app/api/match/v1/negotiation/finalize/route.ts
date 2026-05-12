/**
 * POST /api/match/v1/negotiation/finalize
 *
 * Sender's local mjs reports the outcome of an XMTP send. Updates
 * negotiation_messages.status from 'pending' to 'sent' or 'failed'
 * with optional error_message. Mirror of v1's `phase=finalize`.
 *
 * Body:
 *   { message_id: "<uuid>", status: "sent" | "failed", error_message?: "..." }
 *
 * Auth: gateway_token Bearer (caller is the sender's VM — must own
 *       the message via thread.initiator_vm_id OR be the message's
 *       sender_user_id).
 *
 * Idempotent: re-finalizing with same status is a no-op. Re-finalizing
 * with different status (e.g., a retry that succeeded after originally
 * being marked failed) updates the row.
 *
 * PRD: instaclaw/docs/prd/PRD-v2-agent-negotiation.md §5.4.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const VALID_STATUS = new Set(["sent", "failed"]);
const MAX_ERROR_MESSAGE_CHARS = 2000;

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
  const callerUserId = vm.assigned_to as string;

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
  const messageId = b.message_id;
  const statusRaw = b.status;
  const errorMessageRaw = b.error_message;

  if (!isUUID(messageId)) {
    return NextResponse.json({ error: "message_id must be UUID" }, { status: 400 });
  }
  if (typeof statusRaw !== "string" || !VALID_STATUS.has(statusRaw)) {
    return NextResponse.json({
      error: `status must be one of: ${Array.from(VALID_STATUS).join(", ")}`,
    }, { status: 400 });
  }
  const status = statusRaw as "sent" | "failed";
  let errorMessage: string | null = null;
  if (errorMessageRaw !== undefined && errorMessageRaw !== null) {
    if (typeof errorMessageRaw !== "string") {
      return NextResponse.json({ error: "error_message must be string" }, { status: 400 });
    }
    errorMessage = errorMessageRaw.slice(0, MAX_ERROR_MESSAGE_CHARS);
  }

  const supabase = getSupabase();

  // Verify caller owns this message (sender of the row).
  const { data: msg, error: msgErr } = await supabase
    .from("negotiation_messages")
    .select("id, sender_user_id, status, thread_id")
    .eq("id", messageId)
    .maybeSingle();
  if (msgErr) {
    return NextResponse.json({ error: "message lookup failed" }, { status: 503 });
  }
  if (!msg) {
    return NextResponse.json({ error: "message not found" }, { status: 404 });
  }
  if (msg.sender_user_id !== callerUserId) {
    return NextResponse.json({ error: "caller is not the sender of this message" }, { status: 403 });
  }

  // Idempotency: re-finalizing with same status is a no-op.
  if (msg.status === status) {
    return NextResponse.json({ ok: true, no_op: true, message_id: messageId, status });
  }

  // Apply the transition.
  const updateBody: Record<string, unknown> = { status };
  if (errorMessage) updateBody.error_message = errorMessage;
  // Reset error_message when transitioning to 'sent' from 'failed'
  // so the row reflects only the final state.
  if (status === "sent" && !errorMessage) updateBody.error_message = null;

  const { error: updErr } = await supabase
    .from("negotiation_messages")
    .update(updateBody)
    .eq("id", messageId);
  if (updErr) {
    return NextResponse.json({ error: "update failed", detail: updErr.message }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    no_op: false,
    message_id: messageId,
    status,
    thread_id: msg.thread_id,
  });
}
