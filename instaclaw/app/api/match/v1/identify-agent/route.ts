/**
 * POST /api/match/v1/identify-agent
 *
 * Receiver-side resolver. When User B's XMTP agent gets a DM tagged
 * with the [INSTACLAW_AGENT_INTRO_V1] envelope from sender wallet X_A,
 * the agent calls this endpoint to verify:
 *   1. X_A actually belongs to a known InstaClaw VM.
 *   2. There is a matching `agent_outreach_log` row indicating that
 *      sender's matching pipeline reserved this exact intro to B.
 *      That ledger row is the source of truth — without it, the
 *      sender is either spoofing, racing the rate limiter, or has
 *      hit a bug. Either way, drop the message.
 *
 * If both checks pass, returns the sender's display info (name,
 * agent name, bot handle, identity wallet) so B's agent can compose
 * a meaningful Telegram intro for B's human:
 *
 *   "Cooper's agent (@edgecitybot) just reached out about meeting up
 *    at Consensus..."
 *
 * Body:
 *   { "sender_xmtp_address": "0x..." }
 *
 * Auth: Bearer <gateway_token>. Caller is the receiving VM.
 *
 * Returns:
 *   {
 *     ok: true,
 *     is_instaclaw_agent: true,
 *     verified_outreach: true,
 *     log_id: "<uuid>",
 *     user_id: "<uuid of sender's human>",
 *     name: "Cooper",
 *     agent_name: "Edge City Bot",
 *     telegram_bot_username: "edgecitybot",
 *     identity_wallet: "0x..."
 *   }
 *   { ok: true, is_instaclaw_agent: false }                       -- unknown wallet
 *   { ok: true, is_instaclaw_agent: true, verified_outreach: false } -- known but no ledger row
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LEDGER_VERIFY_WINDOW_HOURS = 6;

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

function isXmtpAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

export async function POST(req: NextRequest) {
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }

  const receiverVm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to, telegram_chat_id");
  if (!receiverVm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!receiverVm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const receiverUserId = receiverVm.assigned_to as string;
  const receiverTelegramChatId = (receiverVm.telegram_chat_id as string | null) || null;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const senderXmtp = (body as Record<string, unknown> | null)?.sender_xmtp_address;
  if (!isXmtpAddress(senderXmtp)) {
    return NextResponse.json({ error: "sender_xmtp_address must be 0x + 40 hex" }, { status: 400 });
  }
  // Normalize for case-insensitive match (XMTP addresses are EVM, lowercase canonical).
  const senderXmtpLc = senderXmtp.toLowerCase();

  const supabase = getSupabase();

  // 1. Resolve sender VM by xmtp_address. Use select("*") per Rule 19 —
  //    the surface is small and we benefit from total-column safety.
  const { data: senderVms, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .ilike("xmtp_address", senderXmtpLc);
  if (vmErr) {
    return NextResponse.json({ error: "vm lookup failed" }, { status: 503 });
  }
  const senderVm = (senderVms || []).find(
    (v) => typeof v.xmtp_address === "string" && v.xmtp_address.toLowerCase() === senderXmtpLc
  );
  if (!senderVm) {
    return NextResponse.json({ ok: true, is_instaclaw_agent: false });
  }
  const senderUserId = senderVm.assigned_to as string | null;
  if (!senderUserId) {
    return NextResponse.json({ ok: true, is_instaclaw_agent: false });
  }

  // 2. Verify a recent agent_outreach_log row exists for this sender→receiver
  //    pair. The pending row is inserted in the reserve phase BEFORE the XMTP
  //    send, so it's present by the time the receiver checks.
  const sinceIso = new Date(Date.now() - LEDGER_VERIFY_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data: ledgerRow } = await supabase
    .from("agent_outreach_log")
    .select("id, status")
    .eq("outbound_user_id", senderUserId)
    .eq("target_user_id", receiverUserId)
    .in("status", ["pending", "sent"])
    .gte("sent_at", sinceIso)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!ledgerRow) {
    return NextResponse.json({
      ok: true,
      is_instaclaw_agent: true,
      verified_outreach: false,
    });
  }

  // 3. Resolve sender's display info.
  const { data: senderUser } = await supabase
    .from("instaclaw_users")
    .select("id, name, world_wallet_address")
    .eq("id", senderUserId)
    .maybeSingle();

  const identityWallet =
    (senderVm.bankr_evm_address as string | null) ||
    (senderUser?.world_wallet_address as string | null) ||
    null;
  const tgUsername = (senderVm.telegram_bot_username as string | null) || null;

  return NextResponse.json({
    ok: true,
    is_instaclaw_agent: true,
    verified_outreach: true,
    log_id: ledgerRow.id,
    user_id: senderUserId,
    name: (senderUser?.name as string | null) || (senderVm.agent_name as string | null) || "InstaClaw user",
    agent_name: (senderVm.agent_name as string | null) || null,
    telegram_bot_username: tgUsername ? tgUsername.replace(/^@/, "") : null,
    identity_wallet: identityWallet,
    vm_name: (senderVm.name as string | null) || null,
    // Receiver's own telegram_chat_id, so the receiving xmtp-agent.mjs
    // can pass it as TELEGRAM_CHAT_ID env to notify_user.sh. Discovery
    // via sessions.json + getUpdates is unreliable on VMs whose users
    // haven't recently DM'd the bot — DB is the canonical source.
    receiver_telegram_chat_id: receiverTelegramChatId,
  });
}
