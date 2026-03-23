import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAgentStatus } from "@/lib/supabase";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  const agent = await getAgentStatus(session.userId);

  return NextResponse.json({
    user: {
      id: session.userId,
      walletAddress: session.walletAddress,
      hasAgent: !!agent,
      xmtpAddress: agent?.xmtp_address ?? null,
    },
  });
}
