import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAgentStatus, supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ user: null }, { status: 401 });
    }

    let agent = null;
    try {
      agent = await getAgentStatus(session.userId);
    } catch { /* no agent */ }

    let userData = null;
    try {
      const { data } = await supabase()
        .from("instaclaw_users")
        .select("world_id_verified, email")
        .eq("id", session.userId)
        .single();
      userData = data;
    } catch { /* no user data */ }

    return NextResponse.json({
      user: {
        id: session.userId,
        walletAddress: session.walletAddress,
        hasAgent: !!agent,
        xmtpAddress: agent?.xmtp_address ?? null,
        worldIdVerified: userData?.world_id_verified ?? false,
        hasEmail: !!userData?.email,
      },
    });
  } catch (err) {
    console.error("[/api/auth/me] Error:", err);
    return NextResponse.json({ user: null, error: "Internal error" }, { status: 500 });
  }
}
