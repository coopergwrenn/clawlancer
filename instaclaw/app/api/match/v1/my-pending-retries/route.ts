/**
 * GET /api/match/v1/my-pending-retries
 *
 * Sender-side companion to /my-intros. Returns the caller's outbound
 * outreach rows that need an XMTP redelivery attempt:
 *
 *   - Same pair (outbound_user_id = caller).
 *   - status = 'sent' (the original send succeeded; the network OR the
 *     receiver dropped the envelope).
 *   - ack_received_at IS NULL (receiver hasn't surfaced it yet).
 *   - last_retry_at IS NULL OR last_retry_at < NOW - 15 min.
 *   - retry_count < 3 (hard cap; 3 attempts spans 90 min, well past
 *     the typical receiver-side outage window).
 *   - sent_at < NOW - 15 min (give XMTP a fair shot at the first
 *     delivery before retrying).
 *
 * The caller's pipeline iterates the response, re-fires the XMTP send
 * via its localhost listener, and POSTs phase=retry to bump retry_count
 * + last_retry_at on each attempt. retry_count cap stops runaways.
 *
 * Auth: Bearer <gateway_token>. The caller is the SENDER (outbound_user_id).
 *
 * Response:
 *   {
 *     ok: true,
 *     pending: [
 *       {
 *         log_id, target_user_id, target_xmtp_address,
 *         message_preview, sent_at, retry_count, last_retry_at
 *       },
 *       ...
 *     ]
 *   }
 *
 * Per-cycle bound: 50 rows max. The 20/24h reserve cap means a single
 * caller can't legitimately have more than 20 pending at once anyway.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MIN_AGE_BEFORE_RETRY_MIN = 15;
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

export async function GET(req: NextRequest) {
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }
  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const senderUserId = vm.assigned_to as string;

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    const n = parseInt(limitParam, 10);
    if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) {
      return NextResponse.json({ error: `limit must be 1..${MAX_LIMIT}` }, { status: 400 });
    }
    limit = n;
  }

  const cutoffIso = new Date(Date.now() - MIN_AGE_BEFORE_RETRY_MIN * 60 * 1000).toISOString();
  const supabase = getSupabase();

  // Pull unacked outbound rows older than the retry-cooldown. Partial
  // index idx_outreach_unacked_outbound covers the hot path. We then
  // filter retry_count + last_retry_at in JS — Postgres OR-with-NULL
  // semantics are easy to get wrong here, and the row count is small.
  const { data: rows, error: rowsErr } = await supabase
    .from("agent_outreach_log")
    .select(
      "id, target_user_id, target_xmtp_address, message_preview, sent_at, retry_count, last_retry_at",
    )
    .eq("outbound_user_id", senderUserId)
    .eq("status", "sent")
    .is("ack_received_at", null)
    .lte("sent_at", cutoffIso)
    .order("sent_at", { ascending: true })
    .limit(limit);

  if (rowsErr) {
    return NextResponse.json({ error: "ledger query failed" }, { status: 503 });
  }

  const pending = (rows || []).filter((r) => {
    const rc = (r.retry_count as number) ?? 0;
    if (rc >= MAX_RETRIES) return false;
    const lra = r.last_retry_at as string | null;
    if (lra && new Date(lra).getTime() > Date.now() - MIN_AGE_BEFORE_RETRY_MIN * 60 * 1000) {
      return false;
    }
    return true;
  });

  return NextResponse.json({ ok: true, pending });
}
