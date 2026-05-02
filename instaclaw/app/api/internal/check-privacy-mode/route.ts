/**
 * GET /api/internal/check-privacy-mode
 *
 * Read-only state lookup for the VM-side SSH bridge. Authenticates by the
 * VM's gateway token (same header as every other /api/gateway/* route).
 *
 * The bridge calls this on each operator SSH command to decide whether to
 * allow or block the command. Returns the assigned user's privacy state
 * and partner. The bridge enforces; this endpoint just reports.
 *
 * Response is intentionally minimal — no user_id, no email. The bridge
 * doesn't need them and we don't want this endpoint to leak anything an
 * attacker holding a stolen gateway token couldn't already get.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export async function GET(req: NextRequest) {
  const gatewayToken =
    req.headers.get("x-gateway-token") || req.headers.get("x-api-key");
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }

  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to");
  if (!vm) {
    return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  }

  if (!vm.assigned_to) {
    return NextResponse.json(
      { active: false, until: null, partner: null },
      { headers: { "cache-control": "no-store" } }
    );
  }

  const supabase = getSupabase();
  const { data: user, error } = await supabase
    .from("instaclaw_users")
    .select("partner, privacy_mode_until")
    .eq("id", vm.assigned_to)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: "User lookup failed" }, { status: 500 });
  }

  const until = user.privacy_mode_until;
  const active = until !== null && new Date(until).getTime() > Date.now();

  return NextResponse.json(
    {
      active,
      until: active ? until : null,
      partner: user.partner,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
