import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/security";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/instagram/token
 * Returns the decrypted Instagram access token + user ID for a VM.
 * Authenticated via X-Gateway-Token header (same as other gateway endpoints).
 *
 * This is called by VM scripts (instagram-*.py) to get a fresh token
 * without storing the raw token on disk (it rotates every 60 days).
 */
export async function GET(req: NextRequest) {
  const gatewayToken = req.headers.get("x-gateway-token");
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing X-Gateway-Token" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Find the VM by gateway token
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, gateway_token")
    .eq("gateway_token", gatewayToken)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  }

  // Find the Instagram integration for this user
  const { data: ig } = await supabase
    .from("instaclaw_instagram_integrations")
    .select("instagram_user_id, instagram_username, access_token, token_expires_at, status")
    .eq("user_id", vm.assigned_to)
    .single();

  if (!ig) {
    return NextResponse.json({ error: "No Instagram connection found" }, { status: 404 });
  }

  if (ig.status !== "active") {
    return NextResponse.json({ error: "Instagram connection is not active", status: ig.status }, { status: 403 });
  }

  // Check token expiry
  if (ig.token_expires_at && new Date(ig.token_expires_at) < new Date()) {
    return NextResponse.json({ error: "Instagram token expired", expires_at: ig.token_expires_at }, { status: 403 });
  }

  try {
    const decryptedToken = await decryptApiKey(ig.access_token);

    logger.info("Instagram token fetched by VM", {
      route: "instagram/token",
      vmId: vm.id,
      userId: vm.assigned_to,
      igUsername: ig.instagram_username,
    });

    return NextResponse.json({
      access_token: decryptedToken,
      instagram_user_id: ig.instagram_user_id,
      instagram_username: ig.instagram_username,
      token_expires_at: ig.token_expires_at,
    });
  } catch (err) {
    logger.error("Failed to decrypt Instagram token", {
      route: "instagram/token",
      vmId: vm.id,
      error: String(err),
    });
    return NextResponse.json({ error: "Token decryption failed" }, { status: 500 });
  }
}
