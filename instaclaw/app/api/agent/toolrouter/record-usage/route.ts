/**
 * POST /api/agent/toolrouter/record-usage
 *
 * K.4 wrapper ingress. Called by ~/.openclaw/scripts/toolrouter-wrapper.mjs
 * on each VM after observing the MCP `tools/call` response from the
 * `toolrouter` binary. The wrapper extracts trace_id, charged, path,
 * credit_captured_usd, status_code, and latency from the structuredContent
 * block of the response (see /tmp/tr-fetch/package/dist/server.js:776-790),
 * then POSTs them here.
 *
 * Trust posture (Cooper, "never trust self-reported data"):
 *   - vm_id and user_id are RESOLVED from the gateway_token via
 *     lookupVMByGatewayToken — NOT taken from the request body. A VM
 *     cannot report usage on another VM's behalf.
 *   - `charged`, `trace_id`, `path` come from ToolRouter's response,
 *     which the wrapper observes verbatim on the wire. The agent has
 *     no opportunity to fabricate these — they originate from upstream.
 *   - `weight` is recomputed server-side from endpoint_id (and optional
 *     args for depth-priced endpoints) using TOOLROUTER_ENDPOINT_WEIGHTS
 *     in lib/toolrouter-credits.ts. The wrapper's claimed weight is
 *     ignored if it differs from the server-side computation.
 *
 * Idempotency: the RPC checks call_log.trace_id at the top. A duplicate
 * call (wrapper retry, cron backstop replay) returns
 * {idempotent_replay: true} without decrementing or inserting.
 *
 * Failure mode: if this endpoint is unreachable, the wrapper swallows
 * the error and the tool call still succeeds (Cooper's mandate:
 * metering is secondary to functionality). The cron backstop at
 * /api/cron/reconcile-toolrouter-usage will detect the missed
 * record from ToolRouter's GET /v1/requests audit log and replay it.
 *
 * Auth: Authorization: Bearer <gateway_token> OR x-gateway-token
 * (mirroring the gateway proxy + agent-economy/transaction patterns).
 *
 * Per Rule 13: registered in middleware.ts:selfAuthAPIs.
 * Per Rule 11: maxDuration = 30 (RPC + insert; fast normal path).
 *
 * PRD: docs/prd/toolrouter-integration.md §7.11 Task K.4.
 */

import { NextRequest, NextResponse } from "next/server";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { toolrouterWeight } from "@/lib/toolrouter-credits";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // Rule 11: RPC + insert, well under the 60s default

// ── Field caps + enums (input validation per Cooper's trust posture) ──

const MAX_ENDPOINT_ID = 80;
const MAX_TRACE_ID = 200;
const MAX_PATH = 60;
const MAX_ERROR_CLASS = 100;

// Mirrors the migration's allocation_source documented enum + the
// toolrouter binary's structuredContent.path values (server.js:779).
// We DON'T enforce a strict enum on path because Andy's binary may
// add new values in future versions; just cap the length.
const PATH_HINT = ["agentkit", "agentkit_to_x402", "x402", "dev_stub", "timeout", "unknown"];

function extractGatewayToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const xGate = req.headers.get("x-gateway-token");
  if (xGate?.trim()) return xGate.trim();
  return null;
}

function asString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

function asPositiveInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

function asNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

interface RecordUsageBody {
  endpoint_id: string;
  trace_id?: string | null;
  charged: boolean;
  path?: string | null;
  status_code?: number | null;
  credit_captured_usd?: number | null;
  latency_ms?: number | null;
  error_class?: string | null;
  // The wrapper claims a weight, but we recompute server-side from
  // endpoint_id + args. The claimed value is ignored for security;
  // accepted only as an additional sanity check (we log if they differ).
  weight_claimed?: number | null;
  args?: Record<string, unknown> | null;
}

// Body size cap (defense in depth against a malicious/malfunctioning
// wrapper sending oversized payloads). The endpoint receives small
// records — endpoint_id + trace_id + ~6 small fields + optional args.
// 64KB is generous (Vercel's default limit is higher, but we want a
// clear local boundary). Args field has its own cap inside Section 3.
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth ──
  const token = extractGatewayToken(req);
  if (!token) {
    return NextResponse.json({ error: "missing gateway token" }, { status: 401 });
  }

  // ── Body size guard (cheap pre-parse check via Content-Length header) ──
  // Audit finding (2026-06-01): an oversized POST could DoS the endpoint by
  // forcing await req.json() to buffer a large body into memory before
  // validation. Reject early when the wrapper announces a body bigger than
  // the legitimate envelope can possibly need.
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      logger.warn("toolrouter record-usage: oversized body rejected", {
        route: "agent/toolrouter/record-usage",
        content_length: n,
        max: MAX_BODY_BYTES,
      });
      return NextResponse.json(
        { error: "body too large", max_bytes: MAX_BODY_BYTES },
        { status: 413 },
      );
    }
  }

  const vm = (await lookupVMByGatewayToken(
    token,
    "id, assigned_to",
  )) as { id: string; assigned_to: string | null } | null;

  if (!vm) {
    logger.warn("toolrouter record-usage: invalid token", { route: "agent/toolrouter/record-usage" });
    return NextResponse.json({ error: "invalid gateway token" }, { status: 401 });
  }

  if (!vm.assigned_to) {
    // Unassigned pool VM made a tool call. Shouldn't happen (pool VMs
    // don't have agents running), but if it does we have no user to
    // bill against. Return 200 to keep the wrapper happy; log for forensics.
    logger.warn("toolrouter record-usage: vm not assigned", {
      route: "agent/toolrouter/record-usage",
      vm_id: vm.id,
    });
    return NextResponse.json({ ok: true, skipped: "vm_not_assigned" });
  }

  // ── Parse + validate body ──
  let body: RecordUsageBody;
  try {
    body = (await req.json()) as RecordUsageBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const endpointId = asString(body.endpoint_id, MAX_ENDPOINT_ID);
  if (!endpointId) {
    return NextResponse.json({ error: "endpoint_id required" }, { status: 400 });
  }
  if (typeof body.charged !== "boolean") {
    return NextResponse.json({ error: "charged required (boolean)" }, { status: 400 });
  }

  const traceId = body.trace_id !== undefined ? asString(body.trace_id, MAX_TRACE_ID) : null;
  const path = body.path !== undefined ? asString(body.path, MAX_PATH) : null;
  const statusCode = body.status_code !== undefined ? asPositiveInt(body.status_code) : null;
  const latencyMs = body.latency_ms !== undefined ? asPositiveInt(body.latency_ms) : null;
  const errorClass = body.error_class !== undefined ? asString(body.error_class, MAX_ERROR_CLASS) : null;
  const amountUsd = body.credit_captured_usd !== undefined ? asNumber(body.credit_captured_usd) : null;
  // Cap to numeric(8,4): up to 9999.9999. Reject NaN/Infinity.
  const safeAmount = amountUsd !== null && amountUsd >= 0 && amountUsd <= 9999.9999 ? amountUsd : null;

  // ── Server-side weight (Cooper's trust posture: ignore wrapper claim) ──
  // toolrouterWeight handles unknown endpoints by returning a safe default
  // (5, ~$0.05 worst case). The wrapper's args parameter feeds depth-priced
  // endpoints (manus.research, parallel.task) so the weight is accurate
  // even for variable-cost calls.
  const weight = toolrouterWeight(endpointId, body.args ?? null);

  // Sanity-log if wrapper's claim differs from server computation.
  // Not a security alert (wrapper is trusted on our infra) but useful
  // for catching weight-table drift.
  const weightClaimed = body.weight_claimed !== undefined ? asPositiveInt(body.weight_claimed) : null;
  if (weightClaimed !== null && weightClaimed !== weight) {
    logger.info("toolrouter record-usage: weight mismatch (wrapper vs server)", {
      route: "agent/toolrouter/record-usage",
      vm_id: vm.id,
      endpoint_id: endpointId,
      weight_claimed: weightClaimed,
      weight_server: weight,
    });
  }

  // ── Atomic consume + log via the v1.5 RPC ──
  const supabase = getSupabase();
  const { data: rpcResult, error: rpcErr } = await supabase.rpc(
    "instaclaw_consume_toolrouter_searches",
    {
      p_user_id: vm.assigned_to,
      p_weight: weight,
      p_endpoint_id: endpointId,
      p_charged: body.charged,
      p_trace_id: traceId,
      p_vm_id: vm.id,
      p_path: path,
      p_status_code: statusCode,
      p_latency_ms: latencyMs,
      p_error_class: errorClass,
      p_amount_usd: safeAmount,
    },
  );

  if (rpcErr) {
    logger.error("toolrouter record-usage: RPC failed", {
      route: "agent/toolrouter/record-usage",
      vm_id: vm.id,
      user_id: vm.assigned_to,
      endpoint_id: endpointId,
      trace_id: traceId,
      error_code: rpcErr.code,
      error_message: rpcErr.message.slice(0, 240),
    });
    // 5xx so the wrapper sees a real failure. Wrapper's fire-and-forget
    // policy will swallow this; cron backstop catches the drift.
    return NextResponse.json(
      { error: "rpc failed", code: rpcErr.code ?? null },
      { status: 500 },
    );
  }

  // ── Inspect RPC result for in-band errors ──
  // The RPC returns JSON whether or not the consume "succeeded":
  //   {allowed: true, ...}                        ← happy path
  //   {allowed: false, error: "no_user"}          ← user lookup failed (data drift)
  //   {allowed: false, allocation_source: "post_hoc_exceeded", ...} ← call already
  //                                                  happened, user out of allocation
  //   {allowed: true, idempotent_replay: true}    ← duplicate trace_id, no-op
  //
  // Audit finding (2026-06-01): the endpoint previously returned 200 OK for
  // ALL of these. The "no_user" branch hides a real data-drift bug — the
  // gateway_token lookup found a VM whose assigned_to points at a deleted
  // user. The wrapper would swallow this silently and the call would never
  // get accounted. Surface it as a 422 so the wrapper logs a warning and
  // the operator can investigate.
  const rpcShape = rpcResult as
    | { allowed?: boolean; error?: string; allocation_source?: string; idempotent_replay?: boolean }
    | null;
  if (rpcShape?.allowed === false && rpcShape?.error === "no_user") {
    logger.warn("toolrouter record-usage: RPC returned no_user (gateway_token points at orphan VM)", {
      route: "agent/toolrouter/record-usage",
      vm_id: vm.id,
      assigned_to_orphan: vm.assigned_to,
    });
    return NextResponse.json(
      { error: "no_user", vm_id: vm.id, note: "VM.assigned_to points at a deleted user" },
      { status: 422 },
    );
  }

  // RPC returns JSON. Pass through verbatim — the wrapper logs it for
  // debugging but doesn't act on it (tool call has already returned).
  return NextResponse.json({ ok: true, consumed: rpcResult });
}
