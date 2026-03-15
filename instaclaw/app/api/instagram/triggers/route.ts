import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const VALID_TRIGGER_TYPES = [
  "comment_keyword",
  "dm_keyword",
  "story_reply",
  "new_follower_dm",
] as const;

/**
 * GET /api/instagram/triggers
 * Lists all Instagram triggers for the current user.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_instagram_triggers")
    .select("*")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ triggers: data });
}

/**
 * POST /api/instagram/triggers
 * Creates a new Instagram trigger.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { trigger_type, keywords, response_template, ai_response } = body;

  if (
    !trigger_type ||
    !VALID_TRIGGER_TYPES.includes(trigger_type as (typeof VALID_TRIGGER_TYPES)[number])
  ) {
    return NextResponse.json(
      {
        error: `trigger_type must be one of: ${VALID_TRIGGER_TYPES.join(", ")}`,
      },
      { status: 400 }
    );
  }

  if (
    trigger_type !== "new_follower_dm" &&
    trigger_type !== "story_reply" &&
    (!keywords || !Array.isArray(keywords) || keywords.length === 0)
  ) {
    return NextResponse.json(
      { error: "keywords array is required for this trigger type" },
      { status: 400 }
    );
  }

  if (!response_template && !ai_response) {
    return NextResponse.json(
      { error: "Either response_template or ai_response must be set" },
      { status: 400 }
    );
  }

  const supabase = getSupabase();

  // Limit triggers per user (prevent abuse)
  const { count } = await supabase
    .from("instaclaw_instagram_triggers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", session.user.id);

  if ((count ?? 0) >= 50) {
    return NextResponse.json(
      { error: "Maximum 50 triggers per account" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("instaclaw_instagram_triggers")
    .insert({
      user_id: session.user.id,
      trigger_type,
      keywords: keywords ?? [],
      response_template: response_template ?? null,
      ai_response: ai_response ?? false,
    })
    .select()
    .single();

  if (error) {
    logger.error("Instagram trigger create failed", {
      route: "instagram/triggers",
      userId: session.user.id,
      error: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ trigger: data }, { status: 201 });
}

/**
 * DELETE /api/instagram/triggers
 * Deletes an Instagram trigger by ID.
 */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from("instaclaw_instagram_triggers")
    .delete()
    .eq("id", id)
    .eq("user_id", session.user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
