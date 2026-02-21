import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = getSupabase();

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("id", id)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  // Get assigned user info if assigned
  let user = null;
  if (vm.assigned_to) {
    const { data } = await supabase
      .from("instaclaw_users")
      .select("id, email, name, created_at")
      .eq("id", vm.assigned_to)
      .single();
    user = data;
  }

  // Get subscription info
  let subscription = null;
  if (vm.assigned_to) {
    const { data } = await supabase
      .from("instaclaw_subscriptions")
      .select("*")
      .eq("user_id", vm.assigned_to)
      .single();
    subscription = data;
  }

  return NextResponse.json({ vm, user, subscription });
}
