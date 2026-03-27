import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase, getAgentStatus } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/name — Save a custom agent name.
 * Body: { name: string }
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { name } = await req.json();

    if (typeof name !== "string" || name.length > 40) {
      return NextResponse.json({ error: "Name must be under 40 characters" }, { status: 400 });
    }

    const agent = await getAgentStatus(session.userId);
    if (!agent) {
      return NextResponse.json({ error: "No agent assigned" }, { status: 404 });
    }

    const trimmed = name.trim() || null; // empty string → null (revert to default)

    const { error } = await supabase()
      .from("instaclaw_vms")
      .update({ agent_name: trimmed })
      .eq("id", agent.id);

    if (error) {
      console.error("[AgentName] Update error:", error);
      return NextResponse.json({ error: "Failed to update name" }, { status: 500 });
    }

    return NextResponse.json({ success: true, name: trimmed });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to update name" }, { status: 500 });
  }
}
