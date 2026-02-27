import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const VALID_CATEGORIES = [
  "creative",
  "productivity",
  "commerce",
  "social",
  "developer",
  "automation",
  "communication",
];

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { name, description, category } = body;

  // Validate name
  if (!name || typeof name !== "string" || name.trim().length < 3) {
    return NextResponse.json(
      { error: "Skill name must be at least 3 characters" },
      { status: 400 }
    );
  }
  if (name.trim().length > 50) {
    return NextResponse.json(
      { error: "Skill name must be under 50 characters" },
      { status: 400 }
    );
  }

  // Validate description
  if (
    !description ||
    typeof description !== "string" ||
    description.trim().length < 20
  ) {
    return NextResponse.json(
      { error: "Description must be at least 20 characters" },
      { status: 400 }
    );
  }
  if (description.trim().length > 500) {
    return NextResponse.json(
      { error: "Description must be under 500 characters" },
      { status: 400 }
    );
  }

  // Validate category
  if (!category || !VALID_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: "Invalid category" },
      { status: 400 }
    );
  }

  const supabase = getSupabase();

  const authorName =
    session.user.name || session.user.email?.split("@")[0] || "Anonymous";

  const { data, error } = await supabase
    .from("instaclaw_community_skills")
    .insert({
      user_id: session.user.id,
      name: name.trim(),
      description: description.trim(),
      category,
      author_name: authorName,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "You already have a skill with that name" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ skill: data });
}
