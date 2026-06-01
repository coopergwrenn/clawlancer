/**
 * POST /api/agent-economy/transaction
 *
 * VM-side ingestion for a settled Frontier transaction. The agent's
 * `frontier.report_transaction` tool calls this after a settlement on any rail
 * (x402 / compute / card / stripe_mcp / ap2 / base_mcp). One row per VM per
 * transaction — an agent-to-agent sale produces two independent rows (seller
 * `earn`, buyer `spend`), each reported by its own VM, linked by
 * counterparty_vm_id.
 *
 * SCOPE — this endpoint RECORDS a claim; it does NOT move credits.
 *   Crediting the ledger or routing a protocol fee to the burn queue off a
 *   *self-reported* row would be a credit-minting vector: the VM is authenticated,
 *   but the contents (amount, counterparty, tx_hash) are attacker-controlled. The
 *   authoritative record is on-chain (tx_hash on Base). A separate chain-verified
 *   path stamps `verified_on_chain_at` and applies any credit/burn side effects.
 *   Until then every row here is "claimed, unverified". This is a deliberate
 *   deviation from PRD §5.2 (which folded crediting into settlement) — recording
 *   and value-movement are split so an unverified claim can never mint value.
 *
 * Idempotency — keyed on (vm_id, request_id). First write wins; a retry returns
 * the original row unchanged (we never let a replay mutate a settled record).
 *
 * Auth — Authorization: Bearer <gateway_token> OR x-gateway-token. vm_id is taken
 * from the authenticated token, never the body, so a VM cannot file a transaction
 * on another VM's behalf.
 *
 * Request body:
 *   {
 *     "request_id":        <string>,                 // required — idempotency key
 *     "rail":              "x402"|"compute"|"card"|"stripe_mcp"|"ap2"|"base_mcp",
 *     "direction":         "earn"|"spend",
 *     "amount_usdc":       <number > 0>,
 *     "status":            "pending"|"settled"|"failed"|"disputed"|"refunded", // default "settled"
 *     "protocol_fee_usdc": <number >= 0>,            // optional, default 0, <= amount
 *     "counterparty_address":          <string>,     // optional, 0x… (<=42)
 *     "counterparty_vm_id":            <uuid>,       // optional — must be a real, different VM
 *     "counterparty_erc8004_agent_id": <int >= 0>,   // optional
 *     "offering_id":       <uuid>,                   // optional — must exist
 *     "match_log_id":      <uuid>,                   // optional
 *     "external_invoice_id": <string>,              // optional (stripe)
 *     "ap2_mandate_id":    <string>,                // optional (ap2)
 *     "tx_hash":           <string>,                // optional — on-chain hash
 *     "facilitator":       <string>,                // optional, default "coinbase"
 *     "response_summary":  <string>,                // optional, short
 *     "request_body":      <object>,                // optional — what was requested
 *     "metadata":          <object>                 // optional
 *   }
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §6.5, §9.2, §10.1
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // pure DB writes, no LLM — 30s is generous (Rule 11 short tier)

// Field caps. Money columns are numeric(14,6) → 8 integer digits → < 1e8.
const MAX_REQUEST_ID = 200;
const MAX_TX_HASH = 80;            // 0x + 64 hex = 66; headroom for non-EVM ids
const MAX_ADDRESS = 42;            // matches varchar(42)
const MAX_RESPONSE_SUMMARY = 1000;
const MAX_FACILITATOR = 40;
const MAX_EXTERNAL_ID = 200;       // invoice / mandate ids
const MAX_AMOUNT = 99_999_999;     // fits numeric(14,6) integer part; reject overflow with a clean 400
const MAX_REQUEST_BODY_BYTES = 200_000; // under the 262144 DB CHECK, with margin
const MAX_METADATA_BYTES = 8_000;

const RAILS = ["x402", "compute", "card", "stripe_mcp", "ap2", "base_mcp"] as const;
const DIRECTIONS = ["earn", "spend"] as const;
const STATUSES = ["pending", "settled", "failed", "disputed", "refunded"] as const;
type Rail = (typeof RAILS)[number];
type Direction = (typeof DIRECTIONS)[number];
type Status = (typeof STATUSES)[number];

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

/** byte length of a value's JSON, or Infinity if it can't be serialized. */
function jsonBytes(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v), "utf8");
  } catch {
    return Infinity;
  }
}

interface CleanTxn {
  request_id: string;
  rail: Rail;
  direction: Direction;
  amount_usdc: number;
  status: Status;
  protocol_fee_usdc: number;
  counterparty_address: string | null;
  counterparty_vm_id: string | null;
  counterparty_erc8004_agent_id: number | null;
  offering_id: string | null;
  match_log_id: string | null;
  external_invoice_id: string | null;
  ap2_mandate_id: string | null;
  tx_hash: string | null;
  facilitator: string;
  response_summary: string | null;
  request_body: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

/** Optional string field: must be a string if present; trimmed + capped; "" → null. */
function optStr(v: unknown, cap: number): string | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return { error: "must be a string" };
  const t = v.trim().slice(0, cap);
  return t === "" ? null : t;
}

function validateBody(raw: unknown): CleanTxn | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const b = raw as Record<string, unknown>;

  // request_id (idempotency key) — required, non-empty, capped.
  if (typeof b.request_id !== "string" || !b.request_id.trim()) {
    return { error: "request_id must be a non-empty string" };
  }
  const request_id = b.request_id.trim().slice(0, MAX_REQUEST_ID);

  // rail / direction — required enums.
  if (!RAILS.includes(b.rail as Rail)) {
    return { error: `rail must be one of ${RAILS.join(", ")}` };
  }
  if (!DIRECTIONS.includes(b.direction as Direction)) {
    return { error: `direction must be one of ${DIRECTIONS.join(", ")}` };
  }
  const rail = b.rail as Rail;
  const direction = b.direction as Direction;

  // amount — required, finite, > 0, <= max (overflow guard for numeric(14,6)).
  if (typeof b.amount_usdc !== "number" || !Number.isFinite(b.amount_usdc) || b.amount_usdc <= 0) {
    return { error: "amount_usdc must be a positive finite number" };
  }
  if (b.amount_usdc > MAX_AMOUNT) {
    return { error: `amount_usdc exceeds ${MAX_AMOUNT}` };
  }
  const amount_usdc = b.amount_usdc;

  // protocol_fee — optional, >= 0, <= amount (a fee larger than the trade is nonsensical/hostile).
  let protocol_fee_usdc = 0;
  if (b.protocol_fee_usdc !== undefined && b.protocol_fee_usdc !== null) {
    if (typeof b.protocol_fee_usdc !== "number" || !Number.isFinite(b.protocol_fee_usdc) || b.protocol_fee_usdc < 0) {
      return { error: "protocol_fee_usdc must be a non-negative finite number" };
    }
    if (b.protocol_fee_usdc > amount_usdc) {
      return { error: "protocol_fee_usdc cannot exceed amount_usdc" };
    }
    protocol_fee_usdc = b.protocol_fee_usdc;
  }

  // status — optional enum, default "settled".
  let status: Status = "settled";
  if (b.status !== undefined && b.status !== null) {
    if (!STATUSES.includes(b.status as Status)) {
      return { error: `status must be one of ${STATUSES.join(", ")}` };
    }
    status = b.status as Status;
  }

  // counterparty_vm_id — optional uuid; FK-enforced to be a real VM at insert.
  let counterparty_vm_id: string | null = null;
  if (b.counterparty_vm_id !== undefined && b.counterparty_vm_id !== null) {
    if (!isUUID(b.counterparty_vm_id)) return { error: "counterparty_vm_id must be a UUID" };
    counterparty_vm_id = b.counterparty_vm_id;
  }

  let offering_id: string | null = null;
  if (b.offering_id !== undefined && b.offering_id !== null) {
    if (!isUUID(b.offering_id)) return { error: "offering_id must be a UUID" };
    offering_id = b.offering_id;
  }

  let match_log_id: string | null = null;
  if (b.match_log_id !== undefined && b.match_log_id !== null) {
    if (!isUUID(b.match_log_id)) return { error: "match_log_id must be a UUID" };
    match_log_id = b.match_log_id;
  }

  // counterparty_erc8004_agent_id — optional, non-negative safe integer (column is bigint).
  let counterparty_erc8004_agent_id: number | null = null;
  if (b.counterparty_erc8004_agent_id !== undefined && b.counterparty_erc8004_agent_id !== null) {
    const n = b.counterparty_erc8004_agent_id;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
      return { error: "counterparty_erc8004_agent_id must be a non-negative integer" };
    }
    counterparty_erc8004_agent_id = n;
  }

  // Capped optional strings.
  const counterparty_address = optStr(b.counterparty_address, MAX_ADDRESS);
  if (counterparty_address && typeof counterparty_address === "object") return counterparty_address;
  const external_invoice_id = optStr(b.external_invoice_id, MAX_EXTERNAL_ID);
  if (external_invoice_id && typeof external_invoice_id === "object") return external_invoice_id;
  const ap2_mandate_id = optStr(b.ap2_mandate_id, MAX_EXTERNAL_ID);
  if (ap2_mandate_id && typeof ap2_mandate_id === "object") return ap2_mandate_id;
  const tx_hash = optStr(b.tx_hash, MAX_TX_HASH);
  if (tx_hash && typeof tx_hash === "object") return tx_hash;
  const response_summary = optStr(b.response_summary, MAX_RESPONSE_SUMMARY);
  if (response_summary && typeof response_summary === "object") return response_summary;

  // facilitator — optional, default "coinbase".
  let facilitator = "coinbase";
  const facRaw = optStr(b.facilitator, MAX_FACILITATOR);
  if (facRaw && typeof facRaw === "object") return facRaw;
  if (typeof facRaw === "string") facilitator = facRaw;

  // request_body — optional object, capped by serialized size (mirrors the DB CHECK).
  let request_body: Record<string, unknown> | null = null;
  if (b.request_body !== undefined && b.request_body !== null) {
    if (typeof b.request_body !== "object" || Array.isArray(b.request_body)) {
      return { error: "request_body must be a JSON object" };
    }
    if (jsonBytes(b.request_body) > MAX_REQUEST_BODY_BYTES) {
      return { error: `request_body exceeds ${MAX_REQUEST_BODY_BYTES} bytes` };
    }
    request_body = b.request_body as Record<string, unknown>;
  }

  // metadata — optional object, small cap.
  let metadata: Record<string, unknown> = {};
  if (b.metadata !== undefined && b.metadata !== null) {
    if (typeof b.metadata !== "object" || Array.isArray(b.metadata)) {
      return { error: "metadata must be a JSON object" };
    }
    if (jsonBytes(b.metadata) > MAX_METADATA_BYTES) {
      return { error: `metadata exceeds ${MAX_METADATA_BYTES} bytes` };
    }
    metadata = b.metadata as Record<string, unknown>;
  }

  return {
    request_id,
    rail,
    direction,
    amount_usdc,
    status,
    protocol_fee_usdc,
    counterparty_address: counterparty_address as string | null,
    counterparty_vm_id,
    counterparty_erc8004_agent_id,
    offering_id,
    match_log_id,
    external_invoice_id: external_invoice_id as string | null,
    ap2_mandate_id: ap2_mandate_id as string | null,
    tx_hash: tx_hash as string | null,
    facilitator,
    response_summary: response_summary as string | null,
    request_body,
    metadata,
  };
}

export async function POST(req: NextRequest) {
  // ─ Auth: gateway token → vm_id (never trust a body-supplied vm_id) ─
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

  // ─ Body ─
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
  const t = validated;

  // No self-dealing — a VM transacting with itself is wash activity, not commerce.
  if (t.counterparty_vm_id === vmId) {
    return NextResponse.json({ error: "counterparty_vm_id cannot be the reporting VM" }, { status: 400 });
  }

  const supabase = getSupabase();

  // settled_at is server-authoritative: stamped now iff terminally settled.
  const settledAt = t.status === "settled" ? new Date().toISOString() : null;

  const row = {
    request_id: t.request_id,
    rail: t.rail,
    direction: t.direction,
    vm_id: vmId, // from the authed token
    counterparty_address: t.counterparty_address,
    counterparty_vm_id: t.counterparty_vm_id,
    counterparty_erc8004_agent_id: t.counterparty_erc8004_agent_id,
    amount_usdc: t.amount_usdc,
    protocol_fee_usdc: t.protocol_fee_usdc,
    offering_id: t.offering_id,
    match_log_id: t.match_log_id,
    external_invoice_id: t.external_invoice_id,
    ap2_mandate_id: t.ap2_mandate_id,
    tx_hash: t.tx_hash,
    facilitator: t.facilitator,
    status: t.status,
    request_body: t.request_body,
    response_summary: t.response_summary,
    settled_at: settledAt,
    metadata: t.metadata,
    // verified_on_chain_at intentionally left NULL — set only by the chain-verify path.
  };

  // Insert. Idempotency + integrity are enforced by the DB, not a check-then-act:
  //   23505 unique_violation  → retry of an existing (vm_id, request_id): return original.
  //   23503 foreign_key       → counterparty_vm_id / offering_id doesn't exist: 400.
  //   23514 check_violation   → defensive (validateBody should prevent): 400.
  const { data: inserted, error: insertErr } = await supabase
    .from("frontier_transactions")
    .insert(row)
    .select("id")
    .single();

  if (!insertErr && inserted) {
    return NextResponse.json({ ok: true, transaction_id: inserted.id, idempotent: false }, { status: 201 });
  }

  if (insertErr?.code === "23505") {
    // Idempotent retry. Return the original row WITHOUT mutating it (first write wins).
    // If the replay's amount/rail/direction differ, that's a replay/tamper signal — log it.
    const { data: existing } = await supabase
      .from("frontier_transactions")
      .select("id, amount_usdc, rail, direction")
      .eq("vm_id", vmId)
      .eq("request_id", t.request_id)
      .single();
    if (existing) {
      const drifted =
        Number(existing.amount_usdc) !== t.amount_usdc ||
        existing.rail !== t.rail ||
        existing.direction !== t.direction;
      if (drifted) {
        console.warn(
          "[/api/agent-economy/transaction] idempotency replay with differing fields",
          { vmId, request_id: t.request_id, txId: existing.id },
        );
      }
      return NextResponse.json({ ok: true, transaction_id: existing.id, idempotent: true });
    }
    // Lost the row between conflict and re-read (extremely rare) — surface as a retry.
    return NextResponse.json({ error: "conflict re-read failed, retry" }, { status: 503 });
  }

  if (insertErr?.code === "23503") {
    return NextResponse.json(
      { error: "counterparty_vm_id or offering_id does not exist" },
      { status: 400 },
    );
  }

  if (insertErr?.code === "23514") {
    return NextResponse.json({ error: "value failed a database constraint" }, { status: 400 });
  }

  console.error("[/api/agent-economy/transaction] insert failed:", insertErr);
  return NextResponse.json({ error: "failed to record transaction" }, { status: 500 });
}
