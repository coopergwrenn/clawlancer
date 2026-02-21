import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getConversations, getConversation } from "@/lib/ssh";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    const sessionId = req.nextUrl.searchParams.get("sessionId");

    if (sessionId) {
      // Get specific conversation
      const conversation = await getConversation(vm, sessionId);
      return NextResponse.json(conversation);
    }

    // Get conversation list
    const result = await getConversations(vm);
    return NextResponse.json(result);
  } catch (err) {
    logger.error("Conversations error", { error: String(err), route: "vm/conversations" });
    return NextResponse.json(
      { error: "Failed to fetch conversations" },
      { status: 500 }
    );
  }
}
