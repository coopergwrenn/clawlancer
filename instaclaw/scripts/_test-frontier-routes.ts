#!/usr/bin/env tsx
/**
 * P2-1 — route-layer tests for the two MONEY routes. These cover the pure,
 * deterministic decision logic that gates real spend:
 *
 *   /api/agent-economy/authorize : validate(), extractGatewayToken(), classifyExistingHold()
 *   /api/agent-economy/settle    : validateSettleBody(), classifySettleOutcome()
 *
 * What's NOT here (by design): the DB-glue branches — authorize's vm-lookup/401,
 * the RPC reserve, settle's hold-not-found (404), wrong-VM (403), and CAS-won
 * paths. Those require a live Postgres + the advisory lock and are covered by the
 * canary (vm-1075) integration runs. Everything pure is exhaustively asserted here:
 * every 400, the idempotent-reply taxonomy, and the terminal-state disambiguation.
 *
 * Run: npx tsx scripts/_test-frontier-routes.ts   (exit 0 = all pass)
 */
import type { NextRequest } from "next/server";
import { validate, extractGatewayToken, classifyExistingHold } from "../app/api/agent-economy/authorize/route";
import { validateSettleBody, classifySettleOutcome } from "../app/api/agent-economy/settle/route";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}
const isErr = (r: unknown): r is { error: string } =>
  !!r && typeof r === "object" && "error" in (r as Record<string, unknown>);

// A minimal NextRequest stub — extractGatewayToken only touches req.headers.get().
function reqWith(headers: Record<string, string>): NextRequest {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: { get: (k: string) => lower[k.toLowerCase()] ?? null } } as unknown as NextRequest;
}

// ───────────────────────────── authorize: extractGatewayToken ─────────────────────────────
check("auth: Bearer token", extractGatewayToken(reqWith({ authorization: "Bearer abc123" })) === "abc123");
check("auth: Bearer trims", extractGatewayToken(reqWith({ authorization: "Bearer   tok  " })) === "tok");
check(
  "auth: empty Bearer falls through to x-gateway-token",
  extractGatewayToken(reqWith({ authorization: "Bearer ", "x-gateway-token": "xg" })) === "xg",
);
check("auth: x-gateway-token", extractGatewayToken(reqWith({ "x-gateway-token": "gtok" })) === "gtok");
check("auth: x-gateway-token trims", extractGatewayToken(reqWith({ "x-gateway-token": "  gt  " })) === "gt");
check(
  "auth: non-Bearer scheme falls through",
  extractGatewayToken(reqWith({ authorization: "Basic Zm9v", "x-gateway-token": "xg2" })) === "xg2",
);
check("auth: nothing → null", extractGatewayToken(reqWith({})) === null);
check("auth: Bearer wins over x-gateway-token", extractGatewayToken(reqWith({ authorization: "Bearer b", "x-gateway-token": "x" })) === "b");

// ───────────────────────────── authorize: classifyExistingHold ─────────────────────────────
check("hold: pending → live", classifyExistingHold("pending") === "live");
check("hold: settled → settled", classifyExistingHold("settled") === "settled");
check("hold: failed → consumed", classifyExistingHold("failed") === "consumed");
check("hold: refunded → consumed", classifyExistingHold("refunded") === "consumed");
check("hold: disputed → consumed", classifyExistingHold("disputed") === "consumed");
check("hold: garbage → consumed", classifyExistingHold("anything_else") === "consumed");

// ───────────────────────────── authorize: validate — 400s ─────────────────────────────
check("validate: null → err", isErr(validate(null)));
check("validate: array → err", isErr(validate([1, 2])));
check("validate: string → err", isErr(validate("x")));
check("validate: missing request_id → err", isErr(validate({ amount_usd: 1, endpoint: "https://e" })));
check("validate: empty request_id → err", isErr(validate({ request_id: "", amount_usd: 1, endpoint: "https://e" })));
check("validate: whitespace request_id → err", isErr(validate({ request_id: "   ", amount_usd: 1, endpoint: "https://e" })));
check("validate: missing amount → err", isErr(validate({ request_id: "r", endpoint: "https://e" })));
check("validate: amount 0 → err", isErr(validate({ request_id: "r", amount_usd: 0, endpoint: "https://e" })));
check("validate: amount negative → err", isErr(validate({ request_id: "r", amount_usd: -1, endpoint: "https://e" })));
check("validate: amount NaN → err", isErr(validate({ request_id: "r", amount_usd: NaN, endpoint: "https://e" })));
check("validate: amount Infinity → err", isErr(validate({ request_id: "r", amount_usd: Infinity, endpoint: "https://e" })));
check("validate: amount > MAX → err", isErr(validate({ request_id: "r", amount_usd: 100_000_000, endpoint: "https://e" })));
check("validate: cp_vm_id not uuid → err", isErr(validate({ request_id: "r", amount_usd: 1, counterparty_vm_id: "not-a-uuid" })));
check("validate: cp_address not string → err", isErr(validate({ request_id: "r", amount_usd: 1, counterparty_address: 123 })));
check("validate: endpoint not string → err", isErr(validate({ request_id: "r", amount_usd: 1, endpoint: 99 })));
check("validate: no supplier → err", isErr(validate({ request_id: "r", amount_usd: 1 })));
check("validate: tags not array → err", isErr(validate({ request_id: "r", amount_usd: 1, endpoint: "https://e", tags: "x" })));
check("validate: bad category → err", isErr(validate({ request_id: "r", amount_usd: 1, endpoint: "https://e", category: "nope" })));
check(
  "validate: wallet_balance negative → err",
  isErr(validate({ request_id: "r", amount_usd: 1, endpoint: "https://e", wallet_balance_usd: -5 })),
);
check("validate: bad rail → err", isErr(validate({ request_id: "r", amount_usd: 1, endpoint: "https://e", rail: "wire" })));
check(
  "validate: protocol_fee negative → err",
  isErr(validate({ request_id: "r", amount_usd: 1, endpoint: "https://e", protocol_fee_usd: -1 })),
);
check(
  "validate: protocol_fee > amount → err",
  isErr(validate({ request_id: "r", amount_usd: 1, endpoint: "https://e", protocol_fee_usd: 2 })),
);
check(
  "validate: require_verified non-bool → err",
  isErr(validate({ request_id: "r", amount_usd: 1, endpoint: "https://e", require_verified_counterparty: "yes" })),
);
check(
  "validate: counterparty_verified non-bool → err",
  isErr(validate({ request_id: "r", amount_usd: 1, endpoint: "https://e", counterparty_verified: 1 })),
);
check(
  "validate: human_approved non-bool → err",
  isErr(validate({ request_id: "r", amount_usd: 1, endpoint: "https://e", human_approved: "true" })),
);

// ───────────────────────────── authorize: validate — happy paths ─────────────────────────────
{
  const v = validate({ request_id: "r1", amount_usd: 0.001, endpoint: "https://e" });
  check("validate: minimal ok", !isErr(v));
  if (!isErr(v)) {
    check("validate: minimal category null (unknown)", v.category === null);
    check("validate: minimal rail defaults x402", v.rail === "x402");
    check("validate: minimal not fleet → reqVer false", v.require_verified_counterparty === false);
    check("validate: minimal cpVer false", v.counterparty_verified === false);
    check("validate: minimal human false", v.human_approved === false);
    check("validate: minimal protocol_fee 0", v.protocol_fee_usd === 0);
  }
}
{
  const uuid = "11111111-1111-1111-1111-111111111111";
  const v = validate({ request_id: "r2", amount_usd: 5, counterparty_vm_id: uuid });
  check("validate: fleet ok", !isErr(v));
  if (!isErr(v)) {
    check("validate: fleet reqVer defaults true", v.require_verified_counterparty === true);
    check("validate: fleet cpVer defaults true", v.counterparty_verified === true);
    check("validate: fleet vm id set", v.counterparty_vm_id === uuid);
  }
}
{
  const v = validate({ request_id: "r3", amount_usd: 1, endpoint: "https://e", category: "data" });
  check("validate: explicit category", !isErr(v) && v.category === "data");
}
{
  const v = validate({ request_id: "r4", amount_usd: 1, endpoint: "https://e", tags: ["price"] });
  check("validate: tags→data mapping", !isErr(v) && v.category === "data");
}
{
  const v = validate({ request_id: "r5", amount_usd: 1, endpoint: "https://e", tags: ["zzz_unknown"] });
  check("validate: unknown tag → category null", !isErr(v) && v.category === null);
}
{
  const v = validate({ request_id: "  r6  ", amount_usd: 1.0000004, endpoint: "https://e" });
  check("validate: request_id trimmed", !isErr(v) && v.request_id === "r6");
  check("validate: amount rounded to 6dp", !isErr(v) && v.amount_usd === 1);
}
{
  // protocol_fee == amount is allowed (only > amount errors)
  const v = validate({ request_id: "r7", amount_usd: 2, endpoint: "https://e", protocol_fee_usd: 2 });
  check("validate: protocol_fee == amount ok", !isErr(v) && v.protocol_fee_usd === 2);
}

// ───────────────────────────── settle: validateSettleBody — 400s ─────────────────────────────
const HOLD = "22222222-2222-2222-2222-222222222222";
check("settle: null → err", isErr(validateSettleBody(null)));
check("settle: array → err", isErr(validateSettleBody([1])));
check("settle: missing result → err", isErr(validateSettleBody({ hold_id: HOLD })));
check("settle: bad result → err", isErr(validateSettleBody({ result: "maybe", hold_id: HOLD })));
check("settle: hold_id not uuid → err", isErr(validateSettleBody({ result: "success", hold_id: "x" })));
check("settle: empty request_id → err", isErr(validateSettleBody({ result: "success", request_id: "  " })));
check("settle: no hold/request id → err", isErr(validateSettleBody({ result: "success" })));
check("settle: tx_hash non-string → err", isErr(validateSettleBody({ result: "success", hold_id: HOLD, tx_hash: 5 })));
check(
  "settle: response_summary non-string → err",
  isErr(validateSettleBody({ result: "success", hold_id: HOLD, response_summary: {} })),
);
check(
  "settle: protocol_fee negative → err",
  isErr(validateSettleBody({ result: "success", hold_id: HOLD, protocol_fee_usd: -1 })),
);
check(
  "settle: protocol_fee NaN → err",
  isErr(validateSettleBody({ result: "success", hold_id: HOLD, protocol_fee_usd: NaN })),
);

// ───────────────────────────── settle: validateSettleBody — happy + semantics ─────────────────────────────
{
  const v = validateSettleBody({ result: "success", hold_id: HOLD });
  check("settle: success ok", !isErr(v));
  if (!isErr(v)) {
    check("settle: result is success", v.result === "success");
    check("settle: result_used defaults false", v.resultUsed === false);
    check("settle: holdId set", v.holdId === HOLD);
  }
}
{
  const v = validateSettleBody({ result: "success", hold_id: HOLD, result_used: true });
  check("settle: result_used true on success", !isErr(v) && v.resultUsed === true);
}
{
  // result_used only carries meaning on success — failed must clamp it to false.
  const v = validateSettleBody({ result: "failed", hold_id: HOLD, result_used: true });
  check("settle: result_used clamped false on failed", !isErr(v) && v.resultUsed === false && v.result === "failed");
}
{
  // W27 — disputed: accepted, paid-but-bad. result_used clamps to false even if asked true.
  const v = validateSettleBody({ result: "disputed", hold_id: HOLD, result_used: true });
  check("settle: disputed accepted", !isErr(v) && v.result === "disputed");
  check("settle: disputed clamps result_used false", !isErr(v) && v.resultUsed === false);
}
check("settle: unknown result (maybe) still errors", isErr(validateSettleBody({ result: "maybe", hold_id: HOLD })));
{
  const v = validateSettleBody({ result: "success", request_id: "req-9" });
  check("settle: request_id path", !isErr(v) && v.requestId === "req-9" && v.holdId === null);
}
{
  const v = validateSettleBody({ result: "success", hold_id: HOLD, tx_hash: "  " });
  check("settle: empty tx_hash → null", !isErr(v) && v.txHash === null);
}
{
  const v = validateSettleBody({ result: "success", hold_id: HOLD, protocol_fee_usd: 0.0000019 });
  check("settle: protocol_fee rounded", !isErr(v) && v.protocolFee === 0.000002);
}

// ───────────────────────────── settle: classifySettleOutcome ─────────────────────────────
check("outcome: pending+settled → proceed", classifySettleOutcome("pending", "settled") === "proceed");
check("outcome: pending+failed → proceed", classifySettleOutcome("pending", "failed") === "proceed");
check("outcome: settled+settled → idempotent", classifySettleOutcome("settled", "settled") === "idempotent");
check("outcome: failed+failed → idempotent", classifySettleOutcome("failed", "failed") === "idempotent");
check("outcome: settled+failed → contradictory", classifySettleOutcome("settled", "failed") === "contradictory");
check("outcome: failed+settled → contradictory", classifySettleOutcome("failed", "settled") === "contradictory");
check("outcome: refunded+settled → contradictory", classifySettleOutcome("refunded", "settled") === "contradictory");
// W27 — disputed terminal
check("outcome: pending+disputed → proceed", classifySettleOutcome("pending", "disputed") === "proceed");
check("outcome: disputed+disputed → idempotent", classifySettleOutcome("disputed", "disputed") === "idempotent");
check("outcome: settled+disputed → contradictory", classifySettleOutcome("settled", "disputed") === "contradictory");
check("outcome: disputed+settled → contradictory", classifySettleOutcome("disputed", "settled") === "contradictory");

console.log(`frontier-routes: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
