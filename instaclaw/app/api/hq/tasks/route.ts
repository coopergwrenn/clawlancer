import { NextRequest, NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";

export async function GET() {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await getSupabase()
    .from("hq_tasks")
    .select("*")
    .order("position", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { title, description, status, priority, assignee } = body;

  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  // Get the max position for this status column
  const { data: maxRow } = await getSupabase()
    .from("hq_tasks")
    .select("position")
    .eq("status", status || "todo")
    .order("position", { ascending: false })
    .limit(1)
    .single();

  const position = (maxRow?.position ?? -1) + 1;

  const { data, error } = await getSupabase()
    .from("hq_tasks")
    .insert({
      title,
      description: description || "",
      status: status || "todo",
      priority: priority || "medium",
      assignee: assignee || "",
      position,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}
