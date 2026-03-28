import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/library/list — Fetch library items (run history for recurring tasks).
 * Query params: ?source_task_id=xxx&limit=100&sort=created_at&order=desc
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession();
    const params = req.nextUrl.searchParams;

    const sourceTaskId = params.get("source_task_id");
    const limit = Math.min(parseInt(params.get("limit") || "20"), 100);
    const offset = parseInt(params.get("offset") || "0");
    const sortField = params.get("sort") === "title" ? "title" : "created_at";
    const ascending = params.get("order") === "asc";

    let query = supabase()
      .from("instaclaw_library")
      .select("*", { count: "exact" })
      .eq("user_id", session.userId)
      .order(sortField, { ascending })
      .range(offset, offset + limit - 1);

    if (sourceTaskId) {
      query = query.eq("source_task_id", sourceTaskId);
    }

    const { data, count, error } = await query;

    if (error) {
      console.error("[Library/List] Error:", error);
      return NextResponse.json({ error: "Failed to fetch library" }, { status: 500 });
    }

    return NextResponse.json({
      items: data || [],
      total: count || 0,
      hasMore: (count || 0) > offset + limit,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch library" }, { status: 500 });
  }
}
