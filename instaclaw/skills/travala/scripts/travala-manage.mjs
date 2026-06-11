#!/usr/bin/env node
/**
 * travala-manage.mjs — the VM-side booking-lookup wrapper. Thin two-step OTP
 * shell over POST /api/travala/manage-booking. Use to show the user their
 * booking details + cancellation policy/deadline (Travala's recommended step
 * before any cancellation). Read-only: it never cancels or moves money.
 *
 * STEP 1 (no --otp): backend confirms gate-2 ownership, then asks Travala to
 *   email a 6-digit code to the booking email. We tell the user to read it back.
 * STEP 2 (--otp <code>): backend returns the booking details (status, hotel,
 *   room, dates, price, cancellation policy + free-cancellation deadline).
 *
 * Stateless-across-turns (Travala holds the OTP). Reads GATEWAY_TOKEN from
 * ~/.openclaw/.env. Node ESM, built-ins only.
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
  if (!bookingId) fail("missing_args", { detail: "--booking-id is required" });

  const r = await backend("manage-booking", gatewayToken, otp ? { bookingId, otp } : { bookingId });
  if (r.status !== 200) fail("manage_request_failed", { status: r.status, detail: r.json });
  const d = r.json;

  if (d.gated && d.reason === "not_your_booking") {
    return out({ ok: false, gated: true, reason: d.reason,
      narration: `I don't have a record of that booking under this agent, so I can't look it up. If you booked it elsewhere, check it on travala.com.` });
  }

  const state = d.state;
  if (!otp) {
    if (state === "ok") {
      return out({ ok: true, state, step: 1, booking_id: d.booking_id,
        narration: `To pull up that booking's details, Travala emailed a 6-digit code to the booking email. Read it back to me and I'll show you the status, dates, price, and cancellation policy.` });
    }
    if (state === "not_found") {
      return out({ ok: false, state, step: 1, booking_id: d.booking_id,
        narration: `Travala couldn't find that booking to look it up — the reference may be off. Check travala.com.` });
    }
    return out({ ok: false, state, step: 1, booking_id: d.booking_id, narration: `Couldn't look that up. Travala said: ${d.message || state}.` });
  }

  // step 2: details (or an error)
  if (state === "ok") {
    return out({ ok: true, state, step: 2, booking_id: d.booking_id, details: d.message,
      narration: `Here are your booking details:\n${d.message}` });
  }
  if (state === "bad_otp") {
    return out({ ok: false, state, step: 2, booking_id: d.booking_id,
      narration: `That code didn't work (wrong or expired). Want me to send a fresh one?` });
  }
  return out({ ok: false, state, step: 2, booking_id: d.booking_id, narration: `Couldn't retrieve the booking. Travala said: ${d.message || state}.` });
}

main().catch((e) => fail("unexpected_error", { detail: String(e?.stack ?? e) }));
