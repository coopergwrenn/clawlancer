/**
 * /api/travala/[op] — the backend half of the Travala booking bridge.
 *
 * Self-auth like the x402 facilitator: a fleet VM authenticates with its
 * gateway token (Bearer or x-gateway-token); we resolve the vm row and act on
 * its behalf. The OAuth client_secret stays in Vercel env — it NEVER reaches a
 * VM. The backend mints a short-lived `mcp:book` token, drives the Travala MCP,
 * and hands the VM only the 402 `next_action` + `paymentRequirements`. The VM
 * signs + pays with its own Bankr wallet (see skills/travala/scripts/travala-book.mjs).
 *
 * Ops:
 *   - search-hotel / search-package — PUBLIC Travala tools (mcp:read, no token).
 *       No booking gates: discovery is free and reveals no money path.
 *   - book-quote — gated (kill switch + per-VM travala_booking_enabled, both
 *       fail-checked). Mints mcp:book, calls travala_book, returns the 402.
 *   - book-status — read-only recovery (G). NOT gated by the booking toggle: a
 *       status check exists precisely to AVOID a double charge after a failed
 *       pay, so it must work even if booking was just turned off / killed.
 *
 * Auth requirement (Rule 13): this path is in middleware `selfAuthAPIs`; the
 * gateway-token check below is the real auth.
 * PRD: instaclaw/docs/prd/travala-x402-booking-2026-06-10.md §14-C, §3.5.
 */
import { NextRequest, NextResponse } from "next/server";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { getSupabase } from "@/lib/supabase";
import {
  isTravalaBookingEnabled,
  isTravalaBookingKilled,
} from "@/lib/travala-kill-switch";
import {
  mintTravalaToken,
  mcpToolsCall,
  extractBookQuote,
} from "@/lib/travala-mcp";
import {
  lookupOwnedBooking,
  recordConfirmedBooking,
  classifyToolResult,
  parseCancelOutcome,
  markCancelRequested,
  markCancelled,
  markCancelFailed,
  type TravalaBookingSnapshot,
} from "@/lib/travala-bookings";
import { sendPerVmAlertDeduped } from "@/lib/admin-alert";

export const maxDuration = 300; // MCP-over-HTTP + OAuth mint, external (Rule 11)

const OPS = new Set([
  "search-hotel",
  "search-package",
  "book-quote",
  "book-status",
  "book-record", // persist a confirmed booking (the only record it happened)
  "manage-booking", // OTP-gated booking lookup (read)
  "cancel-booking", // OTP-gated cancellation
]);

function extractGatewayToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const xg = req.headers.get("x-gateway-token");
  return xg?.trim() || null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string }> }) {
  const { op } = await ctx.params;
  if (!OPS.has(op)) {
    return NextResponse.json({ error: `unknown op: ${op}` }, { status: 404 });
  }

  // ── Auth: gateway token → vm row (Rule 19 safety-critical read) ──
  const token = extractGatewayToken(req);
  if (!token) return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  const vm = await lookupVMByGatewayToken(token, "*");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });

  // ── Body ──
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }

  // ── Public search ops: no booking gates, no token ──
  if (op === "search-hotel" || op === "search-package") {
    const toolName = op === "search-hotel" ? "travala_search_hotel" : "travala_search_package";
    const args = (body.arguments as Record<string, unknown>) ?? body;
    const r = await mcpToolsCall(null, toolName, args);
    if (!r.ok) {
      return NextResponse.json(
        { error: "travala_search_failed", detail: r.error, http_code: r.http_code },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, result: r.result }, { status: 200 });
  }

  // ── book-status: read-only recovery (G). No booking gates — it exists to
  // PREVENT a double charge, so it must work even when booking is disabled. ──
  if (op === "book-status") {
    const args = (body.arguments as Record<string, unknown>) ?? body;
    const tok = await mintTravalaToken("mcp:read mcp:book");
    if (!tok.ok || !tok.access_token) {
      return NextResponse.json(
        { error: "travala_token_mint_failed", detail: tok.status, http_code: tok.http_code },
        { status: 502 },
      );
    }
    const r = await mcpToolsCall(tok.access_token, "travala_book_status", args);
    if (!r.ok) {
      return NextResponse.json(
        { error: "travala_book_status_failed", detail: r.error, http_code: r.http_code },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, result: r.result }, { status: 200 });
  }

  // ── DB-backed ops share one client (book-record / manage / cancel / book-quote) ──
  const supabase = getSupabase();

  // ── book-record: persist a CONFIRMED booking — the ONLY record it happened.
  // Called by travala-book.mjs AFTER a successful pay. NOT gated by toggle/kill:
  // recording a paid booking must always succeed so the user can later cancel it.
  // PARTIAL-FAILURE POSTURE (deliberate): if this write fails, the booking is REAL
  // (paid, irreversible) but untracked — the VM-side script surfaces record_failed
  // to the user truthfully (with the Travala link) AND retries; a confirmed-but-
  // unrecorded booking is recoverable via travala-book.mjs --retry (book-status +
  // re-record). See lib/travala-bookings.ts recordConfirmedBooking. ──
  if (op === "book-record") {
    const a = (body.arguments as Record<string, unknown>) ?? body;
    const packageId = String(a.packageId ?? a.package_id ?? "");
    const sessionId = String(a.sessionId ?? a.session_id ?? "");
    const customer = (a.customer ?? a.contact) as
      | { firstName?: string; lastName?: string; email?: string; phone?: string }
      | undefined;
    if (!packageId || !sessionId) {
      return NextResponse.json({ error: "packageId and sessionId are required" }, { status: 400 });
    }
    if (!customer?.lastName || !customer?.email) {
      return NextResponse.json({ error: "customer.lastName and customer.email are required" }, { status: 400 });
    }
    const rec = await recordConfirmedBooking(supabase, {
      vmId: vm.id,
      userId: vm.assigned_to as string,
      customer: { firstName: customer.firstName, lastName: customer.lastName, email: customer.email, phone: customer.phone },
      packageId,
      sessionId,
      amountUsd: typeof a.amount_usd === "number" ? a.amount_usd : null,
      txHash: (a.tx_hash as string) ?? null,
      holdId: (a.hold_id as string) ?? null,
      requestId: (a.request_id as string) ?? null,
      payResponseRaw: (a.pay_response_raw as string) ?? null,
      snapshot: (a.snapshot as TravalaBookingSnapshot) ?? null,
    });
    if (!rec.recorded) {
      // PARTIAL-FAILURE: the booking is REAL (paid, irreversible) but untracked —
      // uncancellable through the agent until backfilled. Alert the operator
      // (per VM+package dedup) so it's visible beyond the user-driven --retry path.
      // The reconcile-travala-bookings cron is the periodic net; this is immediate.
      await sendPerVmAlertDeduped({
        alertKey: `travala_record_failed:${vm.id}:${packageId}`,
        subject: `[P1] Travala booking PAID but NOT recorded — ${vm.name ?? vm.id}`,
        body:
          `A confirmed (paid, irreversible) Travala booking failed to record — it is ` +
          `uncancellable through the agent until backfilled.\n\n` +
          `vm: ${vm.name ?? vm.id} (${vm.id})\nuser: ${vm.assigned_to}\n` +
          `packageId: ${packageId}\nsessionId: ${sessionId}\n` +
          `customer: ${customer.lastName} <${customer.email}>\n` +
          `booking_id (best-effort): ${rec.bookingId ?? "none"}\nreason: ${rec.reason}\n\n` +
          `Recovery: re-run travala-book.mjs --retry on the VM (it re-checks book-status ` +
          `and re-records), or insert the row manually from the frontier hold + pay response.`,
        dedupHours: 6,
      }).catch(() => {});
      return NextResponse.json(
        { ok: false, recorded: false, reason: rec.reason, booking_id: rec.bookingId },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { ok: true, recorded: true, booking_id: rec.bookingId, ref_source: rec.refSource },
      { status: 200 },
    );
  }

  // ── manage-booking: OTP-gated booking lookup (read). Gate chain: gateway auth →
  // gate-2 ownership (bookingId in our table AND vm_id match) BEFORE any MCP call,
  // so VM-A can never trigger an OTP email to VM-B's user. lastName/email come from
  // the stored row (canonical), never trusted from the caller. Two-step OTP shape:
  // call without otp → "code emailed"; call again with otp → booking details. ──
  if (op === "manage-booking") {
    const a = (body.arguments as Record<string, unknown>) ?? body;
    const bookingId = String(a.bookingId ?? a.booking_id ?? "");
    if (!bookingId) return NextResponse.json({ error: "bookingId is required" }, { status: 400 });
    const row = await lookupOwnedBooking(supabase, vm.id, bookingId);
    if (!row) {
      return NextResponse.json({ ok: false, gated: true, reason: "not_your_booking" }, { status: 200 });
    }
    const tok = await mintTravalaToken("mcp:read mcp:book");
    if (!tok.ok || !tok.access_token) {
      return NextResponse.json({ error: "travala_token_mint_failed", detail: tok.status }, { status: 502 });
    }
    const mcpArgs: Record<string, unknown> = { bookingId, lastName: row.last_name, email: row.email };
    if (a.otp) mcpArgs.otp = String(a.otp);
    const r = await mcpToolsCall(tok.access_token, "travala_manage_bookings", mcpArgs);
    const cls = classifyToolResult(r);
    return NextResponse.json(
      { ok: cls.state === "ok", state: cls.state, step: a.otp ? 2 : 1, booking_id: bookingId, message: cls.text },
      { status: 200 },
    );
  }

  // ── cancel-booking: OTP-gated cancellation. KILL-SWITCH BYPASS + NO TOGGLE:
  // cancel IS the protection — only identity (gateway auth) and ownership (gate-2)
  // may gate it. An emergency stop is exactly when users need cancel most, and a
  // toggle must never trap a user's funds in a booking they own. This NEVER touches
  // the frontier ledger (/authorize, /settle, /refund) and NEVER credits a budget:
  // the USDC spend is permanent; the refund posts as Travala Travel Credit off-
  // ledger and is recorded here as an informational snapshot only. ──
  if (op === "cancel-booking") {
    const a = (body.arguments as Record<string, unknown>) ?? body;
    const bookingId = String(a.bookingId ?? a.booking_id ?? "");
    if (!bookingId) return NextResponse.json({ error: "bookingId is required" }, { status: 400 });
    // Gate-2 ownership FIRST — before any MCP call (no OTP email for someone else's booking).
    const row = await lookupOwnedBooking(supabase, vm.id, bookingId);
    if (!row) {
      return NextResponse.json({ ok: false, gated: true, reason: "not_your_booking" }, { status: 200 });
    }
    // Honest cached short-circuit — no MCP call needed.
    if (row.status === "cancelled") {
      return NextResponse.json(
        { ok: true, state: "already_cancelled", booking_id: bookingId, message: "This booking is already cancelled." },
        { status: 200 },
      );
    }
    const tok = await mintTravalaToken("mcp:read mcp:book mcp:cancel");
    if (!tok.ok || !tok.access_token) {
      return NextResponse.json({ error: "travala_token_mint_failed", detail: tok.status }, { status: 502 });
    }
    const mcpArgs: Record<string, unknown> = { bookingId, lastName: row.last_name, email: row.email };
    const hasOtp = !!a.otp;
    if (hasOtp) mcpArgs.otp = String(a.otp);
    const r = await mcpToolsCall(tok.access_token, "travala_cancel_booking", mcpArgs);
    const cls = classifyToolResult(r);

    if (!hasOtp) {
      // STEP 1: request OTP. Success ⇒ Travala emailed a code to row.email.
      if (cls.state === "ok") {
        await markCancelRequested(supabase, row.id);
        return NextResponse.json(
          { ok: true, state: "otp_sent", step: 1, booking_id: bookingId, email: row.email, message: cls.text },
          { status: 200 },
        );
      }
      return NextResponse.json({ ok: false, state: cls.state, step: 1, booking_id: bookingId, message: cls.text }, { status: 200 });
    }

    // STEP 2: confirm with the OTP the user read back.
    if (cls.state === "ok") {
      const outcome = parseCancelOutcome(cls.text);
      await markCancelled(supabase, row.id, { ...outcome, raw: r.result });
      return NextResponse.json(
        {
          ok: true,
          state: "cancelled",
          step: 2,
          booking_id: bookingId,
          refund_amount: outcome.refundAmount,
          cancellation_fee: outcome.cancellationFee,
          refund_destination: "travala_credit",
          message: cls.text,
        },
        { status: 200 },
      );
    }
    if (cls.state === "bad_otp") {
      // leave status at cancel_requested so the user can retry with a fresh code.
      return NextResponse.json({ ok: false, state: "bad_otp", step: 2, booking_id: bookingId, message: cls.text }, { status: 200 });
    }
    await markCancelFailed(supabase, row.id, cls.text);
    return NextResponse.json({ ok: false, state: cls.state, step: 2, booking_id: bookingId, message: cls.text }, { status: 200 });
  }

  // ── book-quote: the gated money path ──

  // Gate 2 (global emergency kill) — checked first, cheap, fleet-wide.
  if (await isTravalaBookingKilled(supabase)) {
    return NextResponse.json(
      { ok: false, gated: true, reason: "travala_booking_kill_switch" },
      { status: 200 },
    );
  }
  // Gate 1 (per-VM opt-in, FAIL-CLOSED) — the "Travel Agent" card toggle.
  if (!isTravalaBookingEnabled(vm)) {
    return NextResponse.json(
      { ok: false, gated: true, reason: "travala_booking_not_enabled" },
      { status: 200 },
    );
  }

  const args = (body.arguments as Record<string, unknown>) ?? body;
  // Minimal shape guard — travala_book needs the package + session + a guest.
  if (!args.packageId && !args.package_id) {
    return NextResponse.json({ error: "packageId is required" }, { status: 400 });
  }
  if (!args.sessionId && !args.session_id) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!args.customer && !args.contact) {
    return NextResponse.json({ error: "customer is required" }, { status: 400 });
  }

  const tok = await mintTravalaToken("mcp:read mcp:book");
  if (!tok.ok || !tok.access_token) {
    return NextResponse.json(
      { error: "travala_token_mint_failed", detail: tok.status, http_code: tok.http_code },
      { status: 502 },
    );
  }

  const r = await mcpToolsCall(tok.access_token, "travala_book", args);
  if (!r.ok) {
    // 401 here would mean the minted token lacks mcp:book or the wall moved.
    return NextResponse.json(
      { error: "travala_book_failed", detail: r.error, http_code: r.http_code },
      { status: 502 },
    );
  }

  const quote = extractBookQuote(r.result);
  if (!quote.ok) {
    return NextResponse.json(
      { error: "travala_quote_parse_failed", detail: quote.error },
      { status: 502 },
    );
  }

  // Token is NOT returned — only the 402 next_action + paymentRequirements.
  return NextResponse.json(
    {
      ok: true,
      next_action: quote.next_action,
      paymentRequirements: quote.paymentRequirements,
      x402Version: quote.x402Version,
      resource: quote.resource, // canonical baseURL+path (P0 wrinkle i handled)
    },
    { status: 200 },
  );
}
