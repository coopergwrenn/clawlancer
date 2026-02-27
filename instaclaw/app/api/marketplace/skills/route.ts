import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("instaclaw_community_skills")
    .select(
      "id, name, description, category, installs, rating_sum, rating_count, featured, author_name, submitted_at"
    )
    .eq("status", "approved")
    .order("featured", { ascending: false })
    .order("submitted_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const skills = (data ?? []).map((s) => ({
    ...s,
    rating:
      s.rating_count > 0
        ? Math.round((Number(s.rating_sum) / s.rating_count) * 10) / 10
        : 0,
  }));

  return NextResponse.json({ skills });
}
