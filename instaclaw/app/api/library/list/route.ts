import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/library/list
 *
 * Returns user's library items with filtering, search, sort, pagination.
 * Query params: ?type=research&pinned=true&limit=20&offset=0&search=keyword&sort=created_at&order=desc
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const typeFilter = params.get("type");
  const pinnedOnly = params.get("pinned") === "true";
  const search = params.get("search")?.trim();
  const sortField = params.get("sort") === "title" ? "title" : "created_at";
  const sortOrder = params.get("order") === "asc";
  const limit = Math.min(
    Math.max(1, parseInt(params.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
    MAX_LIMIT
  );
  const offset = Math.max(0, parseInt(params.get("offset") ?? "0", 10) || 0);
  const sourceTaskId = params.get("source_task_id");

  const supabase = getSupabase();

  // Build query — select all columns except search_vector (internal)
  let query = supabase
    .from("instaclaw_library")
    .select(
      "id, user_id, title, type, content, preview, source_task_id, source_chat_message_id, run_number, tags, is_pinned, created_at, updated_at",
      { count: "exact" }
    )
    .eq("user_id", session.user.id);

  if (typeFilter) {
    query = query.eq("type", typeFilter);
  }

  if (pinnedOnly) {
    query = query.eq("is_pinned", true);
  }

  if (sourceTaskId) {
    query = query.eq("source_task_id", sourceTaskId);
  }

  if (search && search.length > 0) {
    if (search.length <= 2) {
      // Short query: use ILIKE for prefix matching
      query = query.or(`title.ilike.%${search}%,preview.ilike.%${search}%`);
    } else {
      // Full-text search using the search_vector column
      const tsQuery = search
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => `${w}:*`)
        .join(" & ");
      query = query.textSearch("search_vector", tsQuery);
    }
  }

  // Sort: pinned first, then by sort field
  query = query
    .order("is_pinned", { ascending: false })
    .order(sortField, { ascending: sortOrder })
    .range(offset, offset + limit - 1);

  const { data: items, error, count } = await query;

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch library items" },
      { status: 500 }
    );
  }

  const total = count ?? 0;

  return NextResponse.json({
    items: items ?? [],
    total,
    hasMore: total > offset + limit,
  });
}
