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

  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("*")
    .eq("id", id)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", id)
    .single();

  const { data: subscription } = await supabase
    .from("instaclaw_subscriptions")
    .select("*")
    .eq("user_id", id)
    .single();

  const { data: pending } = await supabase
    .from("instaclaw_pending_users")
    .select("*")
    .eq("user_id", id)
    .single();

  return NextResponse.json({ user, vm, subscription, pending });
}
