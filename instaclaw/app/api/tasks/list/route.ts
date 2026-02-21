import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/tasks/list
 *
 * Returns the user's tasks with optional filtering.
 * Query params: ?status=completed&limit=50&offset=0
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const statusFilter = params.get("status");
  const limit = Math.min(
    Math.max(1, parseInt(params.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
    MAX_LIMIT
  );
  const offset = Math.max(0, parseInt(params.get("offset") ?? "0", 10) || 0);

  const supabase = getSupabase();

  // Build query
  let query = supabase
    .from("instaclaw_tasks")
    .select("*", { count: "exact" })
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // Apply status filter — support multiple statuses with comma separation
  if (statusFilter) {
    const statuses = statusFilter.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      query = query.eq("status", statuses[0]);
    } else if (statuses.length > 1) {
      query = query.in("status", statuses);
    }
  }

  // Filter recurring tasks
  const recurring = params.get("recurring");
  if (recurring === "true") {
    query = query.eq("is_recurring", true);
  }

  const { data: tasks, error, count } = await query;

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch tasks" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    tasks: tasks ?? [],
    total: count ?? 0,
  });
}
