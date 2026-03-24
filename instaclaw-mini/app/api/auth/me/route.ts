import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAgentStatus, supabase } from "@/lib/supabase";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  const agent = await getAgentStatus(session.userId);

  // Check if user is already World ID verified
  const { data: userData } = await supabase()
    .from("instaclaw_users")
    .select("world_id_verified, email")
    .eq("id", session.userId)
    .single();

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
}
