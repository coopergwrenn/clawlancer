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

export const maxDuration = 300; // MCP-over-HTTP + OAuth mint, external (Rule 11)

const OPS = new Set(["search-hotel", "search-package", "book-quote", "book-status"]);

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

  // ── book-quote: the gated money path ──
  const supabase = getSupabase();

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
