/**
 * POST /api/agent-economy/settle
 *
 * The post-spend record — and the moment the feedback loop closes. After an
 * agent pays for a hold it reserved at /authorize, its `frontier.settle` tool
 * calls this with the outcome. We flip the hold to its terminal state and record
 * the signal that teaches the NEXT decision:
 *
 *   - "success" + result_used:true   → a GOOD decision (§7.3.2): paid, delivered, used.
 *   - "success" + result_used:false  → WASTEFUL: paid and settled, but the result
 *                                      wasn't useful. Discipline drops.
 *   - "failed"                       → a FAILURE: the payment/delivery didn't
 *                                      complete. Reliability drops; the rolodex
 *                                      learns this supplier is unreliable. The
 *                                      reserve is freed (failed holds don't count
 *                                      against today's budget).
 *
 * If /authorize is the gate, /settle is the teacher. Every settle reshapes the
 * track record that the next /authorize reads, so a string of good, non-self-
 * dealt, used, undisputed decisions raises the earned budget and unlocks more
 * autonomy — while a bad settle shrinks it. This is where economic memory forms,
 * where the supplier posteriors update, where the rolodex gets smarter. As far
 * as we know, no other agent platform closes this loop.
 *
 * IMMUTABILITY: settle records status / tx_hash / result_used / summary. It can
 * NEVER change the amount — that was fixed at /authorize and is the commitment.
 * This kills "authorize $0.01, settle $100".
 *
 * tx_hash is a CLAIM, not proof. We record it; we do NOT stamp verified_on_chain_at
 * — a separate chain-verify worker checks the hash on Base and applies any
 * value-moving side effects. Same record-vs-value split as /transaction: an
 * authenticated-but-self-reported settle must never be able to mint value.
 *
 * Stale holds (older than the budget-reserve TTL) CAN still settle: a real
 * on-chain payment must be recorded even if the hold expired from the soft
 * budget. The TTL governs reserve accounting only, never the right to record reality.
 *
 * Single-winner via atomic compare-and-set on status='pending'. A double-settle,
 * or a settle racing another settle, finds the row already terminal and returns
 * idempotently (or 409 on a contradictory terminal state).
 *
 * Auth: Authorization: Bearer <gateway_token> OR x-gateway-token. A VM can only
 * settle its own holds (enforced in the WHERE).
 *
 * Request body:
 *   {
 *     "hold_id":    <uuid>,        // the transaction id from /authorize (preferred), OR
 *     "request_id": <string>,      // the same idempotency key used at /authorize
 *     "result":     "success"|"failed",   // required
 *     "tx_hash":    <string>,      // optional — on-chain hash (claim, verified later)
 *     "result_used":<bool>,        // optional — was the result useful? (success only; §7.3.2)
 *     "response_summary": <string>,// optional — short note
 *     "protocol_fee_usd": <number >= 0>  // optional — final fee, <= the hold amount
 *   }
 *
 * Responses:
 *   200 { ok:true, hold_id, status, result_used, idempotent:false }     (this call won the flip)
 *   200 { ok:true, hold_id, status, idempotent:true }                   (already in the requested terminal state)
 *   404 hold not found · 403 not your hold · 409 contradictory terminal state · 400 bad input · 401 auth
 *
 * PRD: instaclaw/docs/PRD-frontier-economic-agency.md §2 (C-spend), §4 Phase 1 (W5)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // DB read + one compare-and-set, no LLM (Rule 11 short tier)

const MAX_REQUEST_ID = 200;
const MAX_TX_HASH = 80; // 0x + 64 hex = 66; headroom for non-EVM ids
const MAX_SUMMARY = 1000;

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

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export async function POST(req: NextRequest) {
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
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

  // result — required.
  if (b.result !== "success" && b.result !== "failed") {
    return NextResponse.json({ error: 'result must be "success" or "failed"' }, { status: 400 });
  }
  const success = b.result === "success";

  // Hold identity — hold_id preferred, else request_id; at least one.
  let holdId: string | null = null;
  if (b.hold_id !== undefined && b.hold_id !== null) {
    if (!isUUID(b.hold_id)) return NextResponse.json({ error: "hold_id must be a UUID" }, { status: 400 });
    holdId = b.hold_id;
  }
  let requestId: string | null = null;
  if (b.request_id !== undefined && b.request_id !== null) {
    if (typeof b.request_id !== "string" || !b.request_id.trim()) {
      return NextResponse.json({ error: "request_id must be a non-empty string" }, { status: 400 });
    }
    requestId = b.request_id.trim().slice(0, MAX_REQUEST_ID);
  }
  if (!holdId && !requestId) {
    return NextResponse.json({ error: "hold_id or request_id is required" }, { status: 400 });
  }

  // Optional fields.
  let txHash: string | null = null;
  if (b.tx_hash !== undefined && b.tx_hash !== null) {
    if (typeof b.tx_hash !== "string") return NextResponse.json({ error: "tx_hash must be a string" }, { status: 400 });
    const t = b.tx_hash.trim().slice(0, MAX_TX_HASH);
    txHash = t === "" ? null : t;
  }
  let summary: string | null = null;
  if (b.response_summary !== undefined && b.response_summary !== null) {
    if (typeof b.response_summary !== "string") {
      return NextResponse.json({ error: "response_summary must be a string" }, { status: 400 });
    }
    const s = b.response_summary.trim().slice(0, MAX_SUMMARY);
    summary = s === "" ? null : s;
  }
  // result_used only carries meaning on success (a failed spend delivered nothing).
  const resultUsed = success && b.result_used === true;

  let protocolFee: number | null = null;
  if (b.protocol_fee_usd !== undefined && b.protocol_fee_usd !== null) {
    if (typeof b.protocol_fee_usd !== "number" || !Number.isFinite(b.protocol_fee_usd) || b.protocol_fee_usd < 0) {
      return NextResponse.json({ error: "protocol_fee_usd must be a non-negative finite number" }, { status: 400 });
    }
    protocolFee = round6(b.protocol_fee_usd);
  }

  const supabase = getSupabase();

  // ── Load the hold (read-then-CAS; the CAS on status='pending' is the real guard). ──
  let holdQuery = supabase
    .from("frontier_transactions")
    .select("id, vm_id, status, metadata, amount_usdc")
    .eq("direction", "spend");
  holdQuery = holdId ? holdQuery.eq("id", holdId) : holdQuery.eq("vm_id", vmId).eq("request_id", requestId as string);
  const { data: hold, error: holdErr } = await holdQuery.maybeSingle();

  if (holdErr) {
    console.error("[/api/agent-economy/settle] hold read failed:", holdErr);
    return NextResponse.json({ error: "failed to read hold" }, { status: 500 });
  }
  if (!hold) return NextResponse.json({ error: "hold not found" }, { status: 404 });
  if (hold.vm_id !== vmId) {
    return NextResponse.json({ error: "hold does not belong to this VM" }, { status: 403 });
  }

  const intendedStatus = success ? "settled" : "failed";

  // Already terminal — disambiguate idempotent vs contradictory.
  if (hold.status !== "pending") {
    if (hold.status === intendedStatus) {
      return NextResponse.json({ ok: true, hold_id: hold.id, status: hold.status, idempotent: true }, { status: 200 });
    }
    return NextResponse.json(
      { error: `hold is already ${hold.status}; cannot settle as ${intendedStatus}` },
      { status: 409 },
    );
  }

  // protocol fee can't exceed the (immutable) committed amount.
  if (protocolFee !== null && protocolFee > Number(hold.amount_usdc)) {
    return NextResponse.json({ error: "protocol_fee_usd cannot exceed the hold amount" }, { status: 400 });
  }

  // ── Atomic compare-and-set: only the call that flips pending→terminal wins. ──
  const mergedMeta = {
    ...(hold.metadata && typeof hold.metadata === "object" ? (hold.metadata as Record<string, unknown>) : {}),
    result_used: resultUsed,
    settled_via: "settle_endpoint",
  };
  const update: Record<string, unknown> = {
    status: intendedStatus,
    settled_at: success ? new Date().toISOString() : null,
    metadata: mergedMeta,
  };
  if (txHash !== null) update.tx_hash = txHash;
  if (summary !== null) update.response_summary = summary;
  if (protocolFee !== null) update.protocol_fee_usdc = protocolFee;

  const { data: flipped, error: flipErr } = await supabase
    .from("frontier_transactions")
    .update(update)
    .eq("id", hold.id)
    .eq("vm_id", vmId)
    .eq("status", "pending")
    .select("id");

  if (flipErr) {
    console.error("[/api/agent-economy/settle] CAS failed:", flipErr);
    return NextResponse.json({ error: "failed to settle hold" }, { status: 500 });
  }

  if (flipped && flipped.length === 1) {
    return NextResponse.json(
      { ok: true, hold_id: hold.id, status: intendedStatus, result_used: resultUsed, idempotent: false },
      { status: 200 },
    );
  }

  // Lost the race — another settle flipped it between our read and our CAS.
  const { data: now } = await supabase
    .from("frontier_transactions")
    .select("status")
    .eq("id", hold.id)
    .maybeSingle();
  if (now?.status === intendedStatus) {
    return NextResponse.json({ ok: true, hold_id: hold.id, status: now.status, idempotent: true }, { status: 200 });
  }
  return NextResponse.json(
    { error: `hold is now ${now?.status ?? "unknown"}; cannot settle as ${intendedStatus}` },
    { status: 409 },
  );
}
