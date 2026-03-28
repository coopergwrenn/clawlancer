import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession();

    const params = req.nextUrl.searchParams;
    const statusFilter = params.get("status");
    const recurringFilter = params.get("recurring");
    const limit = Math.min(parseInt(params.get("limit") || "50"), 200);
    const offset = parseInt(params.get("offset") || "0");

    const archivedFilter = params.get("archived");

    let query = supabase()
      .from("instaclaw_tasks")
      .select("*", { count: "exact" })
      .eq("user_id", session.userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    // By default exclude archived; ?archived=true shows only archived
    if (archivedFilter === "true") {
      query = query.not("archived_at", "is", null);
    } else {
      query = query.is("archived_at", null);
    }

    if (statusFilter) {
      const statuses = statusFilter.split(",");
      query = query.in("status", statuses);
    }

    if (recurringFilter === "true") {
      query = query.eq("is_recurring", true);
    }

    const { data, count, error } = await query;

    if (error) {
      console.error("[Tasks/List] Error:", error);
      return NextResponse.json({ error: "Failed to fetch tasks" }, { status: 500 });
    }

    return NextResponse.json({ tasks: data || [], total: count || 0 });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch tasks" }, { status: 500 });
  }
}
