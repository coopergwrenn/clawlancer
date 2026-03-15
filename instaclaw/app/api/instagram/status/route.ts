import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/instagram/status
 * Returns the current user's Instagram connection status.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data } = await supabase
    .from("instaclaw_instagram_integrations")
    .select("instagram_username, token_expires_at, status, scopes, connected_at, last_webhook_at")
    .eq("user_id", session.user.id)
    .single();

  if (!data) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    username: data.instagram_username,
    token_expires_at: data.token_expires_at,
    status: data.status,
    scopes: data.scopes,
    connected_at: data.connected_at,
    last_webhook_at: data.last_webhook_at,
  });
}
