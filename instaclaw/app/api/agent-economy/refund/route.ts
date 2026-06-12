/**
 * POST /api/agent-economy/refund
 *
 * The seller refunds the buyer when it can't deliver (handler error, abuse,
 * timeout). The agent's frontier.refund(transaction_id) tool calls this.
 *
 * This endpoint does NOT move USDC — same record-vs-value split as /transaction.
 * It (a) flips the seller's transaction to status='refunded' and (b) queues a
 * frontier_settlement_retry_queue row (action='refund') that a verified worker
 * executes on-chain. The API never returns funds directly; an unverified caller
 * must not be able to trigger a real transfer from here.
 *
 * Double-refund is the catastrophic direction (irreversible). It's prevented by
 * an atomic compare-and-set: the status flip is
 *   UPDATE … SET status='refunded' WHERE id=? AND vm_id=? AND status='settled'
 * so exactly ONE call ever wins the settled→refunded transition and proceeds to
 * queue the refund. A retry finds status='refunded' and no-ops (idempotent).
 *
 * Asymmetric failure handling: we flip first, THEN queue. If the queue insert
 * fails after a successful flip, the result is "refund owed but not queued" — a
 * recoverable state a reconciliation cron catches (status='refunded' with no
 * action='refund' retry row). We never end up double-paying. (The fully-atomic
 * version is a Postgres RPC doing flip+queue in one txn — the hardening path.)
 *
 * Auth: Authorization: Bearer <gateway_token> OR x-gateway-token. The refund can
 * only be issued by the VM that owns the transaction (enforced in the WHERE).
 *
 * Request body: { "transaction_id": <uuid>, "reason": <string, optional> }
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §6.7, §9.2, §10.1
 */
import { NextRequest, NextResponse, after } from "next/server";
import { recordSpendEvent } from "@/lib/frontier-spend-log";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_REASON = 500;

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
  const vmId = vm.id as string;

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  if (!bodyJson || typeof bodyJson !== "object" || Array.isArray(bodyJson)) {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const b = bodyJson as Record<string, unknown>;
  if (!isUUID(b.transaction_id)) {
    return NextResponse.json({ error: "transaction_id must be a UUID" }, { status: 400 });
  }
  const transactionId = b.transaction_id;
  const reason =
    typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, MAX_REASON) : null;

  const supabase = getSupabase();

  // Atomic compare-and-set: only the call that flips settled→refunded wins.
  // Ownership (vm_id) and refundability (status='settled') are both enforced here.
  const { data: flipped, error: flipErr } = await supabase
    .from("frontier_transactions")
    .update({ status: "refunded" })
    .eq("id", transactionId)
    .eq("vm_id", vmId)
    .eq("status", "settled")
    .select("id");

  if (flipErr) {
    console.error("[/api/agent-economy/refund] status flip failed:", flipErr);
    return NextResponse.json({ error: "failed to process refund" }, { status: 500 });
  }

  if (flipped && flipped.length === 1) {
    // Tier-0 A: this call won the settled→refunded flip — log it once. (The
    // idempotent-already-refunded return below is NOT logged; the winner records it.)
    // Best-effort, post-response, never blocks.
    after(() =>
      recordSpendEvent(supabase, {
        decision_point: "refund", vm_id: vmId, owner_id: (vm.assigned_to as string) ?? null,
        verdict: "refund_queued", reason: reason ? `refund: ${reason}` : "refund",
        transaction_id: transactionId,
      }),
    );
    // We are the single winner — queue the on-chain refund for the worker.
    const { error: queueErr } = await supabase.from("frontier_settlement_retry_queue").insert({
      transaction_id: transactionId,
      action: "refund",
      status: "queued",
      last_error: reason ? `refund reason: ${reason}` : null,
    });
    if (queueErr) {
      // Refund is marked but not queued. Never a double-pay; a reconciliation
      // sweep (status='refunded' lacking an action='refund' row) recovers it.
      console.error(
        "[/api/agent-economy/refund] CRITICAL: txn flipped to refunded but queue insert failed — reconciliation needed",
        { transactionId, vmId, error: queueErr.message },
      );
      return NextResponse.json(
        { ok: true, refund_queued: false, note: "refund recorded; on-chain queue pending reconciliation" },
        { status: 202 },
      );
    }
    return NextResponse.json({ ok: true, refund_queued: true, idempotent: false }, { status: 201 });
  }

  // 0 rows flipped — disambiguate why.
  const { data: txn } = await supabase
    .from("frontier_transactions")
    .select("id, vm_id, status")
    .eq("id", transactionId)
    .maybeSingle();

  if (!txn) {
    return NextResponse.json({ error: "transaction not found" }, { status: 404 });
  }
  if (txn.vm_id !== vmId) {
    return NextResponse.json({ error: "transaction does not belong to this VM" }, { status: 403 });
  }
  if (txn.status === "refunded") {
    // Already refunded by a prior call — idempotent success.
    return NextResponse.json({ ok: true, refund_queued: true, idempotent: true });
  }
  return NextResponse.json(
    { error: `only settled transactions can be refunded (status=${txn.status})` },
    { status: 409 },
  );
}
