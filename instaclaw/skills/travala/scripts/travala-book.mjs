#!/usr/bin/env node
/**
 * travala-book.mjs — the VM-side booking wrapper. Composes the PROVEN frontier
 * x402 payer rail (frontier-spend-core.mjs) with Travala's OAuth-gated booking
 * quote (obtained backend-side, token kept off-VM).
 *
 * THE FLOW (PRD §14-C/D/G/H, reworked for frontier F2 session-required travel):
 *   1. QUOTE   — POST /api/travala/book-quote (gateway-token auth). The backend
 *                mints the mcp:book token, calls travala_book, and returns the
 *                402 next_action {baseURL,path,method,body} + paymentRequirements
 *                + the canonical `resource` (baseURL+path; Travala's own field is
 *                malformed — P0 wrinkle i, fixed backend-side). Token NEVER here.
 *   2. SELECT  — selectPaymentRequirement over paymentRequirements. The amount is
 *                read from maxAmountRequired (the on-chain amount), NOT a display
 *                price (P0 wrinkle ii). over_max if it exceeds --max-usd.
 *   3. APPROVE — /api/agent-economy/authorize with category:"travel". Travel is a
 *                SESSION-REQUIRED category (frontier red-team F2, d1577583): the
 *                forgeable `human_approved` body bool NEVER authorizes it, at any
 *                amount, by design. The ONLY path is an unforgeable browser-session
 *                approval. So authorize returns ask_first/needs_session_approval +
 *                an `approval_url`; we surface it to the user ("approve from your
 *                dashboard — one tap"), then re-authorize the SAME request_id after
 *                they tap → the route returns authorized, mode:human_approved,
 *                reason:human_approved_session → proceed. The approval is single-use
 *                with a 15-min TTL; re-authorize re-mints a fresh url on expiry, so
 *                we never fail the booking — we re-surface. (A hard deny — over the
 *                §6 travel ceiling / banned / drain / privacy / operator kill switch
 *                (spend_kill_switch, _unverifiable) / spend_not_enabled /
 *                request_id_consumed — has NO url and can't
 *                be overridden; we report it.)
 *   4. PAY     — buildAuthorization → buildTransferTypedData → Bankr /wallet/sign
 *                → buildXPaymentHeader(resource = baseURL+path) → POST X-PAYMENT
 *                to baseURL+path with next_action.body → read settlement tx.
 *   5. SETTLE  — /api/agent-economy/settle (flip the hold, record the outcome).
 *
 * Gating (2026-06-12 north-star ruling): the door is open — book-quote is gated
 * only by the operator kill switch. The MONEY gates are the frontier layer's:
 * spend opt-in, the per-booking session tap, the funded wallet (the funding ask
 * + paywall narrations in denyNarrationFor), and the §6 ceiling. The frontier §6
 * travel ceiling is LIVE (f8b79d9e) — a real-priced hotel under the per-tx ceiling
 * authorizes once the user taps; over the ceiling hard-denies. First real run is
 * the P3 vm-1043 canary — a separate, explicit go.
 *
 * Secrets: reads GATEWAY_TOKEN, BANKR_API_KEY, BANKR_WALLET_ADDRESS from
 * ~/.openclaw/.env. The OAuth client_secret is NEVER on the VM (backend-only).
 * Node ESM, built-ins only + a dynamic import of the frontier skill's core.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const API_BASE = process.env.INSTACLAW_API_BASE || "https://instaclaw.io";
const BANKR_SIGN_URL = "https://api.bankr.bot/wallet/sign";
const CORE_PATH = `${homedir()}/.openclaw/skills/frontier/scripts/frontier-spend-core.mjs`;

function loadEnv() {
  const out = {};
  try {
    const raw = readFileSync(`${homedir()}/.openclaw/.env`, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* env optional in some contexts */ }
  return out;
}

function fail(msg, extra) {
  console.error(JSON.stringify({ ok: false, error: msg, ...extra }));
  process.exit(1);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { a[key] = true; }
      else { a[key] = next; i++; }
    }
  }
  return a;
}

// ── backend ops (gateway-token auth; token-secret stays backend-side) ──
async function backend(path, gatewayToken, body) {
  const res = await fetch(`${API_BASE}/api/travala/${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${gatewayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function authorize(gatewayToken, body) {
  const res = await fetch(`${API_BASE}/api/agent-economy/authorize`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${gatewayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function settle(gatewayToken, body) {
  const res = await fetch(`${API_BASE}/api/agent-economy/settle`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${gatewayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function bankrSign(apiKey, typedData) {
  const res = await fetch(BANKR_SIGN_URL, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ signatureType: "eth_signTypedData_v4", typedData }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`bankr_sign_http_${res.status}`);
  const j = await res.json();
  const sig = j?.signature || j?.data?.signature || j?.result?.signature;
  if (!sig) throw new Error("bankr_sign_no_signature");
  return sig;
}

// Travala booking text usually carries a structured confirmation; pull a ref if present.
function bookingRefFrom(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/\b([A-Z]{2,}[-_]?[A-Z0-9]{5,})\b/);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Honest deny narration by REASON CLASS (GAP-1, 2026-06-11 full-lane audit).
// Every deny tells the user the TRUE state and the TRUE remedy. The old single
// narration claimed "over your spending limit" for ALL denies — false for the
// operator kill, the spend toggle, and a consumed/revoked request_id.
// Exported for the decision-tests.
export function denyNarrationFor(reason, amountUsd, consumedStatus, wallet) {
  if (reason === "spend_kill_switch" || reason === "spend_kill_switch_unverifiable") {
    return reason === "spend_kill_switch"
      ? `I can't book right now — spending is paused by the platform operator (an emergency stop, not your limits). Nothing was charged. Try again later.`
      : `I can't book right now — the platform couldn't verify its safety stop, so it pauses spending as a precaution (not your limits). Nothing was charged. Try again in a few minutes.`;
  }
  if (reason === "spend_not_enabled") {
    return `I can't book — autonomous spending is turned off for me. Nothing was charged. Turn it on in your dashboard (Spending settings) and ask me again.`;
  }
  // THE FUNDING ASK (Finding 2, north-star ruling 2026-06-12) — the gate with no
  // UI: it speaks. Motivation first, exact need, exact path, no charge, no shame.
  // Full address (not truncated): a send-to address must be copyable in one step.
  if (reason === "would_drain_wallet") {
    const need = Math.ceil(amountUsd + 1); // the room + a small cushion for fees
    const addr = wallet ? `Send USDC to ${wallet} (it's also in your dashboard under Wallet), ` : `Send USDC to your agent wallet (the address is in your dashboard under Wallet), `;
    return `I found your room. To book it, your agent wallet needs about $${need} USDC on Base and it doesn't have enough right now. ${addr}then ask me to book it again. Nothing was charged.`;
  }
  // THE PAYWALL MOMENT (Finding 3 / Q1 ruling) — the first upsell ever delivered
  // by an autonomous agent that just did real work. Proud of the search, honest
  // about the tier, exact path, zero shame, zero "unfortunately".
  if (reason === "category_not_allowed") {
    return `I did the search and found your room. Booking it for you autonomously, with my wallet and your one-tap approval, is where the Pro plan starts. Upgrade in your dashboard under Billing, then tell me to book it and I'll handle the rest. Searching stays free either way. Nothing was charged.`;
  }
  if (reason === "request_id_consumed") {
    return `That booking attempt was already finalized${consumedStatus ? ` (${consumedStatus})` : ""} — most likely you revoked spending or it already settled. I have NOT charged you again. If you still want the room, ask me to search fresh and I'll start a new booking.`;
  }
  // limit-class (travel ceiling / banned / drain / privacy) — the original copy.
  return `I can't book this — $${amountUsd} is over your travel spending limit (${reason}). You'd need to raise the limit in your dashboard.`;
}

// Did settle report the hold was REVOKED mid-flight? (the revoked-but-paid
// collision — settle returns 409 "hold is now revoked"). Exported for tests.
export function isRevokedSettleConflict(status, json) {
  return status === 409 && /revoked/i.test(String(json?.error ?? ""));
}

// Map a book-status result body to a terminal verdict for the --retry guard.
// Exported for the decision-tests (the four retry timings). "in_progress" is the
// non-terminal state we must NOT re-pay on.
export function bookStatusVerdict(text) {
  const t = String(text || "").toLowerCase();
  if (/confirmed|booked|success|complete/.test(t)) return "confirmed";
  if (/not.?found|invalid|no booking|expired|cancell?ed/.test(t)) return "not_found";
  return "in_progress";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const json = !!args.json;
  const out = (obj) => { if (json) console.log(JSON.stringify(obj)); else console.log(obj.narration ?? JSON.stringify(obj, null, 2)); };

  const env = loadEnv();
  const gatewayToken = env.GATEWAY_TOKEN;
  const bankrKey = env.BANKR_API_KEY;
  const wallet = env.BANKR_WALLET_ADDRESS;
  if (!gatewayToken) fail("not_configured: GATEWAY_TOKEN missing in ~/.openclaw/.env");

  // Required booking inputs.
  const packageId = args["package-id"];
  const sessionId = args["session-id"];
  const why = args.why || "a hotel booking";
  const maxUsd = args["max-usd"] !== undefined ? Number(args["max-usd"]) : Infinity;
  let customer;
  try { customer = args.customer ? JSON.parse(args.customer) : undefined; }
  catch { fail("bad_customer_json", { detail: "--customer must be valid JSON {firstName,lastName,email,phone}" }); }
  if (!packageId || !sessionId) fail("missing_args", { detail: "--package-id and --session-id are required (from travala search)" });
  if (!customer) fail("missing_args", { detail: "--customer '{\"firstName\":..,\"lastName\":..,\"email\":..,\"phone\":..}' is required" });

  // Load the PROVEN frontier payer core (composition; never re-implement the math).
  let core;
  try { core = await import(pathToFileURL(CORE_PATH).href); }
  catch { fail("frontier_skill_missing", { detail: `travala booking requires the frontier skill's payer core at ${CORE_PATH}` }); }
  const { selectPaymentRequirement, buildAuthorization, buildTransferTypedData, buildXPaymentHeader, newRequestId, tagsFromResource, nonceForRequest } = core;

  // the search-option snapshot the agent threads through (hotel/dates/policy/
  // free-cancel deadline) — captured at record time, irretrievable later.
  let snapshot;
  try { snapshot = args.snapshot ? JSON.parse(args.snapshot) : undefined; }
  catch { snapshot = undefined; }

  // ── G (recovery): on an explicit retry, settle book-status to a TERMINAL verdict
  // before deciding to re-pay. Primary double-charge guard is the deterministic
  // nonce (a redundant pay is an on-chain no-op); polling to terminal is defense
  // in depth on the 2026-06-11 audit "B-window" — it avoids even attempting a
  // redundant pay (which would revert on the consumed nonce and read as a
  // confusing failure). ──
  if (args.retry) {
    let verdict = "in_progress", lastResult = null;
    for (let i = 0; i < 4 && verdict === "in_progress"; i++) {
      if (i > 0) await sleep(3000);
      const st = await backend("book-status", gatewayToken, { packageId, sessionId });
      if (st.status === 200 && st.json?.ok) {
        lastResult = st.json.result;
        verdict = bookStatusVerdict(JSON.stringify(lastResult ?? ""));
      }
    }
    if (verdict === "confirmed") {
      // already booked → record (so it's cancellable) + never charge again.
      const txt = JSON.stringify(lastResult ?? "");
      const rr = await backend("book-record", gatewayToken, { packageId, sessionId, customer, snapshot, pay_response_raw: txt });
      const ref = rr.json?.booking_id || bookingRefFrom(txt);
      return out({ ok: true, already_booked: true, recorded: !!rr.json?.recorded, booking_ref: ref, booking_status: lastResult,
        narration: `This booking already went through — not charging again.${ref ? ` Ref ${ref}.` : ""}${rr.json?.recorded ? ` It's saved to your trips — ask me to cancel anytime.` : ` (Heads up: I couldn't save it to my cancellation list — keep your Travala confirmation email.)`}` });
    }
    if (verdict === "in_progress") {
      // status never settled → do NOT re-pay. The nonce would make it safe, but a
      // redundant submit reverting on the consumed nonce reads as a confusing "pay
      // failed". Let the user retry once Travala's status resolves.
      return out({ ok: false, paid: false, pending: true, request_id: args["request-id"],
        narration: `That booking is still processing on Travala's side — I have NOT re-charged you. Give it a minute, then tell me to retry.` });
    }
    // verdict === "not_found" → the prior attempt didn't take; safe to pay below
    // (and the deterministic nonce makes even a late-settling first attempt a no-op).
  }

  // ── 1. QUOTE: backend mints the token, calls travala_book, returns the 402. ──
  const q = await backend("book-quote", gatewayToken, { packageId, sessionId, customer, agentId: args["agent-id"] || undefined });
  if (q.status !== 200) fail("quote_failed", { status: q.status, detail: q.json });
  if (q.json?.gated) {
    // gated now means exactly one thing: the operator paused booking fleet-wide
    // (the per-VM toggle was removed 2026-06-12 — the money gates live in the
    // frontier layer and speak through denyNarrationFor below).
    return out({ ok: false, gated: true, reason: q.json.reason,
      narration: "Booking is paused platform-wide right now (an operator stop, not your account). Nothing was charged. Try again later." });
  }
  if (!q.json?.ok || !q.json.next_action || !Array.isArray(q.json.paymentRequirements)) {
    fail("quote_unexpected", { detail: q.json });
  }
  const nextAction = q.json.next_action;
  const x402Version = typeof q.json.x402Version === "number" ? q.json.x402Version : 1;
  // resource: ALWAYS the backend-rebuilt baseURL+path (P0 wrinkle i). Never trust Travala's field.
  const resource = q.json.resource || `${String(nextAction.baseURL).replace(/\/$/, "")}${nextAction.path}`;

  // ── 2. SELECT: amount from maxAmountRequired (P0 wrinkle ii), bounded by --max-usd. ──
  const sel = selectPaymentRequirement(q.json.paymentRequirements, { maxAmountUsd: maxUsd });
  if ("error" in sel) {
    return out({ ok: false, paid: false, reason: sel.error,
      narration: sel.error.startsWith("over_max")
        ? `That booking costs more than your --max-usd cap. (${sel.error})`
        : `Travala's payment offer isn't one I can pay (${sel.error}).` });
  }
  const { amountUsd, amountAtomic, payTo, asset, requirement } = sel.selected;
  const tags = [...new Set(["travel", "hotel", "travala", ...tagsFromResource(resource)])].slice(0, 12);

  if (args["dry-run"]) {
    return out({ ok: true, dry_run: true, would_pay_usd: amountUsd, pay_to: payTo, resource,
      narration: `Dry run: this booking would charge $${amountUsd} (USDC on Base) to Travala. Nothing signed, reserved, or paid.` });
  }

  // ── 3. APPROVE (session-required for travel — frontier red-team F2). ──
  // Travel NEVER honors the forgeable human_approved bool (a prompt-injected agent
  // could forge it); only an unforgeable browser-session approval authorizes it.
  // authorize → ask_first/needs_session_approval + approval_url → user taps in
  // their dashboard → re-authorize the SAME request_id → authorized via
  // reason:human_approved_session. The approval is single-use, 15-min TTL;
  // re-authorize re-mints a fresh url on expiry, so we re-surface, never fail.
  const requestId = args["request-id"] || newRequestId({ nowMs: Date.now(), rand: randomBytes(6).toString("hex") });
  const authorizeOnce = () => authorize(gatewayToken, {
    request_id: requestId,
    amount_usd: amountUsd,
    endpoint: resource,
    counterparty_address: payTo,
    category: "travel",
    tags,
    human_approved: false, // travel ignores the forgeable bool — the dashboard tap is the only consent
    rail: "x402",
  });

  let az = await authorizeOnce();
  if (az.status !== 201 && az.status !== 200) fail("authorize_failed", { status: az.status, detail: az.json });
  let d = az.json;

  const denyOut = () => out({ ok: true, paid: false, authorized: false, outcome: "deny", reason: d.reason,
    spent_today_usd: d.spent_today_usd, earned_daily_budget_usd: d.earned_daily_budget_usd,
    narration: denyNarrationFor(d.reason, amountUsd, d.consumed_status, wallet) });

  // Hard deny — no url, can't be overridden. Reasons: §6 travel ceiling / banned /
  // drain / privacy (limit-class), operator kill switch (spend_kill_switch,
  // _unverifiable), spend_not_enabled, request_id_consumed (revoked/settled id).
  // denyNarrationFor names the TRUE cause + remedy per class (GAP-1, 2026-06-11).
  if (!d.authorized && d.outcome === "deny") return denyOut();

  // ask_first → needs the browser-session tap. Surface the url; bounded in-turn poll for a fast tap.
  if (!d.authorized) {
    if (d.reason === "approval_identity_mismatch") {
      return out({ ok: false, paid: false, reason: "approval_identity_mismatch",
        narration: `The booking price/details changed since the last approval. Search again for a fresh quote and I'll ask you to approve the new total.` });
    }
    const approvalUrl = d.approval_url;
    if (!approvalUrl) fail("ask_first_no_url", { detail: d }); // route always mints a url on ask_first
    const deadline = Date.now() + 75000; // ~75s in-turn wait to catch a fast tap (well under the 15-min TTL)
    while (!d.authorized && Date.now() < deadline) {
      await sleep(5000);
      az = await authorizeOnce();
      d = az.json;
      if (!d.authorized && d.outcome === "deny") return denyOut();
    }
    if (!d.authorized) {
      // Not tapped within the window — exit and let the agent resume after the user confirms.
      return out({ ok: true, paid: false, awaiting_approval: true, approval_url: approvalUrl, request_id: requestId, amount_usd: amountUsd,
        narration: `One tap to confirm — approve this $${amountUsd} booking from your dashboard:\n${approvalUrl}\nThen tell me to continue and I'll book it. (The link expires in 15 min; I'll send a fresh one if it does.)` });
    }
  }

  // Authorized — for travel this is reason:"human_approved_session" (the user tapped). Proceed to pay.
  const holdId = d.hold_id;

  // ── 4. PAY: sign EIP-3009 via Bankr, send X-PAYMENT to the Travala pay endpoint. ──
  let paid = false, txHash = null, resultBody = null, payErr = null, payErrBody = null;
  let latencyMs = null, payStart = null;
  const payUrl = resource; // baseURL+path
  try {
    if (!bankrKey || !wallet) throw new Error("bankr_not_configured");
    const authorizationMsg = buildAuthorization({
      // Deterministic nonce from request_id → on-chain exactly-once on retry
      // (USDC authorizationState reverts a 2nd submit of the same nonce). See
      // frontier-spend-core.mjs nonceForRequest. Never randomBytes here.
      from: wallet, to: payTo, amountAtomic, nonceHex: nonceForRequest(requestId, wallet),
      nowSec: Math.floor(Date.now() / 1000), maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    });
    const typedData = buildTransferTypedData(authorizationMsg, { asset, name: requirement.extra?.name, version: requirement.extra?.version });
    const signature = await bankrSign(bankrKey, typedData);
    const xPayment = buildXPaymentHeader({
      signature, authorization: authorizationMsg, requirement,
      resource, // P0 wrinkle i: canonical baseURL+path, NOT Travala's malformed value
      network: requirement.network, scheme: requirement.scheme, x402Version,
    });
    payStart = Date.now();
    const payRes = await fetch(payUrl, {
      method: nextAction.method || "POST",
      headers: { "PAYMENT-SIGNATURE": xPayment, "X-PAYMENT": xPayment, "Content-Type": "application/json" },
      body: JSON.stringify(nextAction.body ?? {}),
      signal: AbortSignal.timeout(60000),
    });
    latencyMs = Date.now() - payStart;
    if (payRes.ok) {
      paid = true;
      resultBody = await payRes.text();
      const xpr = payRes.headers.get("payment-response") || payRes.headers.get("x-payment-response");
      if (xpr) { try { txHash = JSON.parse(Buffer.from(xpr, "base64").toString("utf8"))?.transaction ?? null; } catch { /* best-effort */ } }
    } else {
      // The X-PAYMENT header is the SOLE authorization for the x402 pay leg — no
      // Bearer (KNOWN, 2026-06-10 doc research): the x402 protocol authorizes the
      // paid request by the signed payment header, "not an Authorization Bearer
      // token or API key" (Stripe/Coinbase x402 docs), and Travala's own travel-mcp
      // README delegates the 402 to @coinbase/payments-mcp (an X-PAYMENT-only
      // client). The OAuth Bearer gates only the travala_book TOOL call (the quote
      // step), never this pay POST. So a 401 here is an unexpected protocol
      // violation, not a "needs a Bearer" signal — surface it as a normal pay error.
      payErr = `pay_http_${payRes.status}`;
      payErrBody = (await payRes.text().catch(() => "")).slice(0, 800);
    }
  } catch (e) {
    payErr = String(e?.message ?? e);
    if (payStart !== null && latencyMs === null) latencyMs = Date.now() - payStart;
  }

  // ── 5. SETTLE: flip the hold, record the outcome (H). ──
  const settleResult = paid ? "success" : "failed";
  const resultUsed = paid && !!resultBody && resultBody.trim().length > 0;
  // READ the settle verdict (GAP-1 companion, 2026-06-11 audit): a 409
  // "hold is now revoked" means the user revoked spending while the payment was
  // already in flight — the booking completed anyway (X-PAYMENT can't be recalled).
  // The user must hear that truth, not a plain "Booked."
  const settleRes = await settle(gatewayToken, {
    hold_id: holdId,
    request_id: requestId,
    result: settleResult,
    tx_hash: txHash ?? undefined,
    result_used: resultUsed,
    response_summary: why.slice(0, 1000),
    latency_ms: latencyMs ?? undefined,
    pay_error: payErr ?? undefined,
  });
  const revokedCollision = isRevokedSettleConflict(settleRes.status, settleRes.json);
  const revokedLine = revokedCollision
    ? ` Heads up: your spending revoke arrived after this payment was already in flight, so the booking completed — I can cancel it for you if you'd like.`
    : "";

  if (paid) {
    const refRegex = bookingRefFrom(resultBody);
    // ── 6. RECORD: persist the booking — the ONLY record it happened (the MCP
    // can't list bookings; cancel needs the row). Retry 3×; the backend validates
    // the bookingId via book-status (never the bare regex). PARTIAL-FAILURE: if
    // recording ultimately fails, the booking is REAL (paid, irreversible) but
    // uncancellable-through-us — we tell the user the truth + how to recover. ──
    let recorded = false, recordedRef = refRegex, recordErr = null;
    for (let attempt = 0; attempt < 3 && !recorded; attempt++) {
      if (attempt > 0) await sleep(1500 * attempt);
      try {
        const rr = await backend("book-record", gatewayToken, {
          packageId, sessionId, customer,
          amount_usd: amountUsd, tx_hash: txHash, hold_id: holdId, request_id: requestId,
          pay_response_raw: resultBody, snapshot,
        });
        if (rr.status === 200 && rr.json?.ok && rr.json?.recorded) {
          recorded = true; recordedRef = rr.json.booking_id || refRegex;
        } else { recordErr = rr.json?.reason || `http_${rr.status}`; }
      } catch (e) { recordErr = String(e?.message ?? e); }
    }
    if (recorded) {
      return out({ ok: true, paid: true, recorded: true, revoked_collision: revokedCollision || undefined, hold_id: holdId, tx_hash: txHash, amount_usd: amountUsd, booking_ref: recordedRef, result: resultBody,
        narration: `Booked. $${amountUsd} paid in USDC on Base${txHash ? ` (tx ${String(txHash).slice(0, 12)}…)` : ""}.${recordedRef ? ` Booking ref ${recordedRef}.` : ""} Saved to your trips — ask me to cancel it anytime (refunds come back as Travala credit, not to your wallet).${revokedLine}` });
    }
    return out({ ok: true, paid: true, recorded: false, revoked_collision: revokedCollision || undefined, record_error: recordErr, hold_id: holdId, tx_hash: txHash, amount_usd: amountUsd, booking_ref: refRegex, result: resultBody,
      narration: `Booked and paid ($${amountUsd} USDC on Base${txHash ? `, tx ${String(txHash).slice(0, 12)}…` : ""})${refRegex ? `, ref ${refRegex}` : ""}. One caveat: I couldn't save it to my cancellation list just now, so I can't cancel it through me yet — please keep your Travala confirmation email. Ask me to "retry recording this booking" and I'll try again.${revokedLine}` });
  }
  return out({ ok: false, paid: false, hold_id: holdId, reason: payErr, pay_error_body: payErrBody,
    narration: `The booking payment failed (${payErr}). Your hold is recorded; re-run with --retry --request-id ${requestId} to resume safely.` });
}

// Run as a script, not when imported (the decision-tests import bookStatusVerdict).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail("unexpected_error", { detail: String(e?.stack ?? e) }));
}
