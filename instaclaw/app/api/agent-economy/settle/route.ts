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
 *     "result":     "success"|"failed"|"disputed",  // required ("disputed" = paid but bad delivery; W27)
 *     "tx_hash":    <string>,      // optional — on-chain hash (claim, verified later)
 *     "result_used":<bool>,        // optional — was the result useful? (success only; §7.3.2)
 *     "response_summary": <string>,// optional — short note
 *     "protocol_fee_usd": <number >= 0>, // optional — final fee, <= the hold amount
 *     "latency_ms":   <number >= 0>,     // optional — supplier delivery time (write-once; W10/ranking)
 *     "pay_error":    <string>           // optional — failure reason (write-once; spend-health drill-down)
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
const MAX_PAY_ERROR = 200;
const MAX_LATENCY_MS = 24 * 60 * 60 * 1000; // 24h sanity ceiling — anything larger is a bad client value

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

export interface CleanSettle {
  result: "success" | "failed" | "disputed";
  holdId: string | null;
  requestId: string | null;
  txHash: string | null;
  summary: string | null;
  resultUsed: boolean;
  protocolFee: number | null;
  latencyMs: number | null; // write-once supplier-delivery time (W10 p50_latency / W2 ranking)
  payError: string | null; // write-once failure reason (spend-health drill-down)
}

/**
 * Validate + normalize the settle body. Pure — tested in P2-1. Returns the
 * cleaned shape, or { error } for any 400. Does NOT include the
 * protocol-fee-vs-hold-amount check (that needs the hold from the DB) — that
 * stays in POST after the hold is loaded.
 */
export function validateSettleBody(raw: unknown): CleanSettle | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be a JSON object" };
  const b = raw as Record<string, unknown>;

  // result — required. "disputed" (W27) = paid but the delivery was bad: money DID
  // move (x402 settles-then-serves) but the agent flags garbage → status 'disputed',
  // which tanks the supplier posterior to "avoid" (stronger than a not-used "waste").
  if (b.result !== "success" && b.result !== "failed" && b.result !== "disputed") {
    return { error: 'result must be "success", "failed", or "disputed"' };
  }
  const result = b.result as "success" | "failed" | "disputed";

  // Hold identity — hold_id preferred, else request_id; at least one.
  let holdId: string | null = null;
  if (b.hold_id !== undefined && b.hold_id !== null) {
    if (!isUUID(b.hold_id)) return { error: "hold_id must be a UUID" };
    holdId = b.hold_id;
  }
  let requestId: string | null = null;
  if (b.request_id !== undefined && b.request_id !== null) {
    if (typeof b.request_id !== "string" || !b.request_id.trim()) {
      return { error: "request_id must be a non-empty string" };
    }
    requestId = b.request_id.trim().slice(0, MAX_REQUEST_ID);
  }
  if (!holdId && !requestId) {
    return { error: "hold_id or request_id is required" };
  }

  // Optional fields.
  let txHash: string | null = null;
  if (b.tx_hash !== undefined && b.tx_hash !== null) {
    if (typeof b.tx_hash !== "string") return { error: "tx_hash must be a string" };
    const t = b.tx_hash.trim().slice(0, MAX_TX_HASH);
    txHash = t === "" ? null : t;
  }
  let summary: string | null = null;
  if (b.response_summary !== undefined && b.response_summary !== null) {
    if (typeof b.response_summary !== "string") {
      return { error: "response_summary must be a string" };
    }
    const s = b.response_summary.trim().slice(0, MAX_SUMMARY);
    summary = s === "" ? null : s;
  }
  // result_used only carries meaning on success (a failed/disputed spend delivered nothing usable).
  const resultUsed = result === "success" && b.result_used === true;

  let protocolFee: number | null = null;
  if (b.protocol_fee_usd !== undefined && b.protocol_fee_usd !== null) {
    if (typeof b.protocol_fee_usd !== "number" || !Number.isFinite(b.protocol_fee_usd) || b.protocol_fee_usd < 0) {
      return { error: "protocol_fee_usd must be a non-negative finite number" };
    }
    protocolFee = round6(b.protocol_fee_usd);
  }

  // Write-once supplier-quality signals (optional). Validated leniently — a bad value
  // is dropped (null), never a 400, because losing the settle over a metadata field
  // would be worse than losing the field.
  let latencyMs: number | null = null;
  if (typeof b.latency_ms === "number" && Number.isFinite(b.latency_ms) && b.latency_ms >= 0 && b.latency_ms <= MAX_LATENCY_MS) {
    latencyMs = Math.round(b.latency_ms);
  }
  let payError: string | null = null;
  if (typeof b.pay_error === "string") {
    const e = b.pay_error.trim().slice(0, MAX_PAY_ERROR);
    payError = e === "" ? null : e;
  }

  return { result, holdId, requestId, txHash, summary, resultUsed, protocolFee, latencyMs, payError };
}

/**
 * Disambiguate a settle against a hold's current status. Pure — tested in P2-1.
 *   proceed       — pending: this call may attempt the CAS flip.
 *   idempotent    — already in the requested terminal state: 200, no-op.
 *   contradictory — terminal but a DIFFERENT state: 409 (e.g. settle-success on a failed hold).
 */
export function classifySettleOutcome(
  currentStatus: string,
  intendedStatus: "settled" | "failed" | "disputed",
): "proceed" | "idempotent" | "contradictory" {
  if (currentStatus === "pending") return "proceed";
  if (currentStatus === intendedStatus) return "idempotent";
  return "contradictory";
}

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
  const v = validateSettleBody(bodyJson);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });
  const { result, holdId, requestId, txHash, summary, resultUsed, protocolFee, latencyMs, payError } = v;
  // "success" and "disputed" both PAID (money moved; x402 settles-then-serves) → set
  // settled_at. "failed" = the pay leg never completed → no money, no settled_at.
  const paid = result !== "failed";

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

  const intendedStatus: "settled" | "failed" | "disputed" =
    result === "success" ? "settled" : result === "disputed" ? "disputed" : "failed";

  // Already terminal — disambiguate idempotent vs contradictory.
  const preOutcome = classifySettleOutcome(hold.status as string, intendedStatus);
  if (preOutcome === "idempotent") {
    return NextResponse.json({ ok: true, hold_id: hold.id, status: hold.status, idempotent: true }, { status: 200 });
  }
  if (preOutcome === "contradictory") {
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
    // Write-once supplier-quality signals (only when supplied) — W10 / spend-health read these.
    ...(latencyMs !== null ? { latency_ms: latencyMs } : {}),
    ...(payError !== null ? { pay_error: payError } : {}),
  };
  const update: Record<string, unknown> = {
    status: intendedStatus,
    settled_at: paid ? new Date().toISOString() : null,
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
