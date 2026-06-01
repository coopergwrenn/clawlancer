/**
 * POST /api/agent-economy/reputation/queue
 *
 * Queues an ERC-8004 reputation feedback event after a settled transaction. The
 * agent's frontier.reputation.feedback tool calls this; rows land status='queued'
 * and a later batched cron writes them on-chain (gas-amortized, EIP-7702).
 *
 * Integrity:
 *  - from_vm_id is the authenticated VM (gateway token), never the body — a VM
 *    only ever authors feedback as itself.
 *  - the referenced transaction must BELONG to the caller's VM. You can only
 *    anchor feedback to your own transactions (provenance), so a VM can't spray
 *    feedback tied to transactions it had no part in.
 *  - one feedback per (transaction_id, from_vm_id): a queued row is revised in
 *    place (it hasn't hit the chain), an on_chain row is immutable (409), a
 *    failed row is re-queued. (Check-then-act — no unique index yet; the batch
 *    cron is the dedup backstop. A partial unique index is the hardening path.)
 *
 * Auth: Authorization: Bearer <gateway_token> OR x-gateway-token.
 *
 * Request body:
 *   {
 *     "transaction_id":      <uuid>,    // required — must be the caller's txn
 *     "to_erc8004_agent_id": <int>=0>,  // required — counterparty's agent id
 *     "value_0_100":         <int 0-100>,
 *     "tag1":                <string>,  // optional, e.g. "payment_received"
 *     "tag2":                <string>,  // optional, e.g. "on_time"
 *     "feedback_uri":        <string>   // optional — ipfs/https detail pointer
 *   }
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §4.4, §9.2, §10.1
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_TAG = 60;
const MAX_URI = 500;

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

interface CleanFeedback {
  transaction_id: string;
  to_erc8004_agent_id: number;
  value_0_100: number;
  tag1: string | null;
  tag2: string | null;
  feedback_uri: string | null;
}

function optCappedStr(v: unknown, cap: number): string | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return { error: "must be a string" };
  const t = v.trim().slice(0, cap);
  return t === "" ? null : t;
}

function validateBody(raw: unknown): CleanFeedback | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const b = raw as Record<string, unknown>;

  if (!isUUID(b.transaction_id)) return { error: "transaction_id must be a UUID" };

  const agentId = b.to_erc8004_agent_id;
  if (typeof agentId !== "number" || !Number.isInteger(agentId) || agentId < 0 || agentId > Number.MAX_SAFE_INTEGER) {
    return { error: "to_erc8004_agent_id must be a non-negative integer" };
  }

  const value = b.value_0_100;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    return { error: "value_0_100 must be an integer in [0,100]" };
  }

  const tag1 = optCappedStr(b.tag1, MAX_TAG);
  if (tag1 && typeof tag1 === "object") return tag1;
  const tag2 = optCappedStr(b.tag2, MAX_TAG);
  if (tag2 && typeof tag2 === "object") return tag2;
  const feedback_uri = optCappedStr(b.feedback_uri, MAX_URI);
  if (feedback_uri && typeof feedback_uri === "object") return feedback_uri;

  return {
    transaction_id: b.transaction_id,
    to_erc8004_agent_id: agentId,
    value_0_100: value,
    tag1: tag1 as string | null,
    tag2: tag2 as string | null,
    feedback_uri: feedback_uri as string | null,
  };
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
  const validated = validateBody(bodyJson);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const f = validated;

  const supabase = getSupabase();

  // The feedback must anchor to one of the caller's own transactions.
  const { data: txn } = await supabase
    .from("frontier_transactions")
    .select("id, vm_id")
    .eq("id", f.transaction_id)
    .maybeSingle();

  if (!txn) {
    return NextResponse.json({ error: "transaction not found" }, { status: 404 });
  }
  if (txn.vm_id !== vmId) {
    return NextResponse.json({ error: "transaction does not belong to this VM" }, { status: 403 });
  }

  // One feedback per (transaction, author). Revise if still queued; refuse if
  // already on-chain; re-queue if a prior attempt failed.
  const { data: existing } = await supabase
    .from("frontier_reputation_events")
    .select("id, status")
    .eq("transaction_id", f.transaction_id)
    .eq("from_vm_id", vmId)
    .maybeSingle();

  if (existing) {
    if (existing.status === "on_chain") {
      return NextResponse.json(
        { error: "feedback already submitted on-chain; cannot revise" },
        { status: 409 },
      );
    }
    const { error: updErr } = await supabase
      .from("frontier_reputation_events")
      .update({
        to_erc8004_agent_id: f.to_erc8004_agent_id,
        value_0_100: f.value_0_100,
        tag1: f.tag1,
        tag2: f.tag2,
        feedback_uri: f.feedback_uri,
        status: "queued", // re-queue a previously-failed row
      })
      .eq("id", existing.id);
    if (updErr) {
      console.error("[/api/agent-economy/reputation/queue] update failed:", updErr);
      return NextResponse.json({ error: "failed to revise feedback" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, reputation_event_id: existing.id, revised: true });
  }

  const { data: inserted, error: insErr } = await supabase
    .from("frontier_reputation_events")
    .insert({
      transaction_id: f.transaction_id,
      from_vm_id: vmId,
      to_erc8004_agent_id: f.to_erc8004_agent_id,
      value_0_100: f.value_0_100,
      tag1: f.tag1,
      tag2: f.tag2,
      feedback_uri: f.feedback_uri,
      status: "queued",
    })
    .select("id")
    .single();

  if (insErr || !inserted) {
    // FK violation (transaction vanished mid-request) → 409 retry; else 500.
    if (insErr?.code === "23503") {
      return NextResponse.json({ error: "transaction no longer exists" }, { status: 409 });
    }
    console.error("[/api/agent-economy/reputation/queue] insert failed:", insErr);
    return NextResponse.json({ error: "failed to queue feedback" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, reputation_event_id: inserted.id, revised: false }, { status: 201 });
}
