#!/usr/bin/env node
/**
 * travala-cancel.mjs — the VM-side cancellation wrapper. Thin two-step OTP shell
 * over POST /api/travala/cancel-booking (gateway-token auth; the backend holds
 * the OAuth secret, runs gate-2 ownership BEFORE any MCP call, mints mcp:cancel,
 * and drives travala_cancel_booking).
 *
 * THE FLOW (stateless-across-turns by design — the user may disappear for an hour
 * between steps; Travala holds the OTP server-side, we hold none):
 *   STEP 1 (no --otp): backend confirms ownership, then asks Travala to email a
 *     6-digit code to the booking's email. We tell the user to read it back.
 *   STEP 2 (--otp <code>): backend submits the code; on success the booking is
 *     cancelled and the refund snapshot is recorded.
 *
 * REFUND TRUTH (never deviate): a cancellation refund posts as Travala Travel
 * CREDIT to the account ~7 business days later — NEVER on-chain USDC to the
 * wallet. The on-chain spend is permanent. We say "expected", never "refunded".
 *
 * Cancel is intentionally NOT gated by the booking toggle or the kill switch:
 * cancel IS the user's money protection; only identity + ownership may gate it.
 *
 * Node ESM, built-ins only. Reads GATEWAY_TOKEN from ~/.openclaw/.env.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const API_BASE = process.env.INSTACLAW_API_BASE || "https://instaclaw.io";

function loadEnv() {
  const out = {};
  try {
    const raw = readFileSync(`${homedir()}/.openclaw/.env`, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* env optional */ }
  return out;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[key] = true;
      else { a[key] = next; i++; }
    }
  }
  return a;
}

function fail(msg, extra) { console.error(JSON.stringify({ ok: false, error: msg, ...extra })); process.exit(1); }

async function backend(path, gatewayToken, body) {
  const res = await fetch(`${API_BASE}/api/travala/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gatewayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const json = !!args.json;
  const out = (obj) => { if (json) console.log(JSON.stringify(obj)); else console.log(obj.narration ?? JSON.stringify(obj, null, 2)); };

  const env = loadEnv();
  const gatewayToken = env.GATEWAY_TOKEN;
  if (!gatewayToken) fail("not_configured: GATEWAY_TOKEN missing in ~/.openclaw/.env");

  const bookingId = args["booking-id"] || args.bookingId;
  const otp = args.otp && args.otp !== true ? String(args.otp) : undefined;
  if (!bookingId) fail("missing_args", { detail: "--booking-id is required (the booking ref from when you booked)" });

  const r = await backend("cancel-booking", gatewayToken, otp ? { bookingId, otp } : { bookingId });
  if (r.status !== 200) fail("cancel_request_failed", { status: r.status, detail: r.json });
  const d = r.json;

  // gate-2 ownership reject (fires before any MCP call — no OTP email was sent).
  if (d.gated && d.reason === "not_your_booking") {
    return out({ ok: false, gated: true, reason: d.reason,
      narration: `I don't have a record of that booking under this agent, so I can't cancel it. Double-check the booking reference, or if you booked it elsewhere you'll need to cancel it on travala.com.` });
  }

  const state = d.state;
  // ── STEP 1 outcomes ──
  if (!otp) {
    if (state === "otp_sent") {
      return out({ ok: true, state, step: 1, booking_id: d.booking_id, email: d.email,
        narration: `To cancel, Travala just emailed a 6-digit verification code to ${d.email || "the booking email"}. Read it back to me and I'll finish the cancellation. (Heads up: any refund comes back as Travala credit, not to your wallet.)` });
    }
    if (state === "already_cancelled") {
      return out({ ok: true, state, step: 1, booking_id: d.booking_id, narration: `That booking is already cancelled — nothing more to do.` });
    }
    if (state === "not_found") {
      return out({ ok: false, state, step: 1, booking_id: d.booking_id,
        narration: `Travala couldn't find that booking to start a cancellation — the reference may have changed or it was already cancelled. You can also check it on travala.com.` });
    }
    // invalid_input / upstream_error — surface truthfully.
    return out({ ok: false, state, step: 1, booking_id: d.booking_id,
      narration: `I couldn't start the cancellation. Travala said: ${d.message || state}.` });
  }

  // ── STEP 2 outcomes ──
  if (state === "cancelled") {
    const fee = d.cancellation_fee, refund = d.refund_amount;
    const refundLine = refund != null
      ? ` A refund of $${refund}${fee != null && fee > 0 ? ` (after a $${fee} cancellation fee)` : ""} is expected as Travala travel credit on your account, typically within ~7 business days — not to your wallet.`
      : ` Any refund will come back as Travala travel credit (not to your wallet); check your Travala account for the amount.`;
    return out({ ok: true, state, step: 2, booking_id: d.booking_id, refund_amount: refund, cancellation_fee: fee,
      narration: `Done — your booking is cancelled.${refundLine}` });
  }
  if (state === "bad_otp") {
    return out({ ok: false, state, step: 2, booking_id: d.booking_id,
      narration: `That code didn't work — it was wrong or it expired. Want me to send a fresh one? Just say "cancel it" again and I'll re-send the code.` });
  }
  if (state === "already_cancelled") {
    return out({ ok: true, state, step: 2, booking_id: d.booking_id, narration: `That booking is already cancelled — nothing more to do.` });
  }
  if (state === "not_found") {
    return out({ ok: false, state, step: 2, booking_id: d.booking_id,
      narration: `Travala couldn't find that booking to cancel — it may already be cancelled. Check travala.com to be sure.` });
  }
  return out({ ok: false, state, step: 2, booking_id: d.booking_id,
    narration: `The cancellation didn't complete. Travala said: ${d.message || state}.` });
}

main().catch((e) => fail("unexpected_error", { detail: String(e?.stack ?? e) }));
