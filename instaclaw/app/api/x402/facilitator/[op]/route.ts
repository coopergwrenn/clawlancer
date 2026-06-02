/**
 * x402 facilitator proxy — thin authenticated relay to the Coinbase CDP facilitator.
 *
 * Production architecture (Frontier x402 rail): an agent's Bankr wallet signs the
 * EIP-3009 payment authorization on the VM via Bankr's /wallet/sign (no private key
 * or CDP secret on the VM). The X-PAYMENT then needs verify+settle against a
 * facilitator. The CDP facilitator requires `CDP_API_KEY_SECRET`, which must NEVER
 * live on a fleet VM. This route is the bridge: the VM's x402 resource server points
 * its facilitator URL at `<app>/api/x402/facilitator`, authenticating with a shared
 * `X-X402-Proxy-Secret`; we regenerate the CDP auth headers here (backend-side) and
 * forward verify/settle/supported to the real CDP facilitator.
 *
 * The CDP Authorization is a JWT bound to the CDP host + path + method, so we forward
 * to the exact `${CDP_BASE}/${op}` with the per-op headers from createCdpAuthHeaders.
 *
 * Auth: X-X402-Proxy-Secret (own auth) — added to middleware selfAuthAPIs (Rule 13).
 * maxDuration: 300 (Rule 11 — relays to an external settlement API).
 */
import { NextRequest, NextResponse } from "next/server";
import { createCdpAuthHeaders } from "@coinbase/x402";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CDP_BASE = "https://api.cdp.coinbase.com/platform/v2/x402";
const VALID_OPS = new Set(["verify", "settle", "supported", "list"]);

async function relay(req: NextRequest, op: string): Promise<NextResponse> {
  if (!VALID_OPS.has(op)) {
    return NextResponse.json({ error: "unknown facilitator op" }, { status: 404 });
  }

  // Our-VM auth. The VM holds only this shared secret; CDP creds stay backend-side.
  const provided = req.headers.get("x-x402-proxy-secret");
  const expected = process.env.X402_PROXY_SECRET;
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
    return NextResponse.json({ error: "facilitator proxy not configured" }, { status: 503 });
  }

  // Per-op CDP auth headers (JWT bound to CDP host+path+method).
  let cdpHeaders: Record<string, string> = {};
  try {
    const authFn = createCdpAuthHeaders(
      process.env.CDP_API_KEY_ID,
      process.env.CDP_API_KEY_SECRET,
    );
    if (!authFn) {
      return NextResponse.json({ error: "CDP auth header builder unavailable" }, { status: 500 });
    }
    const all = await authFn();
    cdpHeaders = (all as Record<string, Record<string, string>>)[op] ?? {};
  } catch (e) {
    return NextResponse.json(
      { error: "failed to build CDP auth headers", detail: String(e).slice(0, 200) },
      { status: 500 },
    );
  }

  const body = req.method === "POST" ? await req.text() : undefined;
  let cdpRes: Response;
  try {
    cdpRes = await fetch(`${CDP_BASE}/${op}`, {
      method: req.method,
      headers: { "Content-Type": "application/json", ...cdpHeaders },
      ...(body !== undefined ? { body } : {}),
    });
  } catch (e) {
    return NextResponse.json(
      { error: "CDP facilitator unreachable", detail: String(e).slice(0, 200) },
      { status: 502 },
    );
  }

  const text = await cdpRes.text();
  return new NextResponse(text, {
    status: cdpRes.status,
    headers: { "Content-Type": cdpRes.headers.get("content-type") || "application/json" },
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string }> }) {
  return relay(req, (await ctx.params).op);
}
export async function GET(req: NextRequest, ctx: { params: Promise<{ op: string }> }) {
  return relay(req, (await ctx.params).op);
}
