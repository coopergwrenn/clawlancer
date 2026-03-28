import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** GET /api/chat/conversations — List user's conversations (non-archived, newest first) */
export async function GET() {
  try {
    const session = await requireSession();

    const { data } = await supabase()
      .from("instaclaw_conversations")
      .select("*")
      .eq("user_id", session.userId)
      .eq("is_archived", false)
      .order("updated_at", { ascending: false })
      .limit(100);

    return NextResponse.json({ conversations: data || [] });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ conversations: [] });
  }
}

/** POST /api/chat/conversations — Create a new conversation */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const body = await req.json().catch(() => ({}));

    const { data: conv, error } = await supabase()
      .from("instaclaw_conversations")
      .insert({
        user_id: session.userId,
        title: body.title || "New Chat",
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: "Failed to create conversation" }, { status: 500 });
    }

    return NextResponse.json({ conversation: conv });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to create conversation" }, { status: 500 });
  }
}
