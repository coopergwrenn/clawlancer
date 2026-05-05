/**
 * GET /api/match/v1/my-intros
 *
 * Server-side delivery fallback. Returns every agent_outreach_log row
 * that targets the caller and has NOT yet been acked. The caller (a
 * receiving VM's pipeline) writes each row to its local
 * pending-intros.jsonl, surfaces it to the user, and acks via
 * POST /api/match/v1/outreach phase=ack.
 *
 * This path closes the receiver-down edge case: even if the original
 * XMTP envelope was sent while the receiver was offline AND XMTP V3
 * store-and-forward dropped it, the row still lives in the ledger and
 * gets picked up on the next pipeline cycle. Worst-case delivery
 * latency = 30 minutes (one cron tick), independent of XMTP transport
 * behaviour.
 *
 * Query params:
 *   limit  — max rows to return, default 50, max 100.
 *
 * Auth: Bearer <gateway_token>. The caller is the RECEIVER (target_user_id).
 *
 * Response:
 *   {
 *     ok: true,
 *     intros: [
 *       {
 *         log_id: "<uuid>",
 *         sender_user_id: "<uuid>",
 *         sender_name: "Cooper",
 *         sender_agent_name: "Edge City Bot",
 *         sender_telegram_bot_username: "edgecitybot",
 *         sender_identity_wallet: "0x...",
 *         sender_xmtp_address: "0x...",
 *         sender_vm_name: "instaclaw-vm-780",
 *         message_preview: "...",          -- the prose the agent sent
 *         sent_at: "<iso>",
 *         retry_count: <int>
 *       },
 *       ...
 *     ]
 *   }
 *
 * The fields mirror identify-agent's response so the receiver can
 * compose pending-intros entries identically whether the row arrived
 * via XMTP envelope or via this poll.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

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
  const receiverUserId = vm.assigned_to as string;

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

  const supabase = getSupabase();

  // Pull unacked rows targeting this user. The partial index
  // idx_outreach_unacked_target accelerates this scan.
  const { data: rows, error: rowsErr } = await supabase
    .from("agent_outreach_log")
    .select("id, outbound_user_id, outbound_xmtp_address, outbound_vm_id, message_preview, sent_at, retry_count")
    .eq("target_user_id", receiverUserId)
    .eq("status", "sent")
    .is("ack_received_at", null)
    .order("sent_at", { ascending: true })
    .limit(limit);

  if (rowsErr) {
    return NextResponse.json({ error: "ledger query failed" }, { status: 503 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, intros: [] });
  }

  // Resolve sender display info in batch. Same shape identify-agent
  // returns so the receiver renders pending-intros entries identically.
  const senderUserIds = Array.from(new Set(rows.map((r) => r.outbound_user_id as string)));
  const senderVmIds = Array.from(new Set(rows.map((r) => r.outbound_vm_id as string).filter(Boolean)));

  const [{ data: senderUsers }, { data: senderVms }] = await Promise.all([
    supabase
      .from("instaclaw_users")
      .select("id, name, world_wallet_address")
      .in("id", senderUserIds),
    senderVmIds.length > 0
      ? supabase
          .from("instaclaw_vms")
          .select("id, name, agent_name, telegram_bot_username, bankr_evm_address")
          .in("id", senderVmIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string; agent_name: string | null; telegram_bot_username: string | null; bankr_evm_address: string | null }> }),
  ]);

  const userById = new Map((senderUsers || []).map((u) => [u.id as string, u]));
  const vmById = new Map((senderVms || []).map((v) => [v.id as string, v]));

  const intros = rows.map((r) => {
    const u = userById.get(r.outbound_user_id as string);
    const v = r.outbound_vm_id ? vmById.get(r.outbound_vm_id as string) : null;
    const tgUsername = (v?.telegram_bot_username as string | null) || null;
    const identityWallet =
      (v?.bankr_evm_address as string | null) ||
      (u?.world_wallet_address as string | null) ||
      null;
    return {
      log_id: r.id,
      sender_user_id: r.outbound_user_id,
      sender_name: (u?.name as string | null) || (v?.agent_name as string | null) || "InstaClaw user",
      sender_agent_name: (v?.agent_name as string | null) || null,
      sender_telegram_bot_username: tgUsername ? tgUsername.replace(/^@/, "") : null,
      sender_identity_wallet: identityWallet,
      sender_xmtp_address: (r.outbound_xmtp_address as string | null) || null,
      sender_vm_name: (v?.name as string | null) || null,
      message_preview: (r.message_preview as string | null) || "",
      sent_at: r.sent_at,
      retry_count: r.retry_count ?? 0,
    };
  });

  return NextResponse.json({ ok: true, intros });
}
