import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { getSupabase } from "@/lib/supabase";

export async function GET() {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .order("created_at", { ascending: false });

  return NextResponse.json({ vms: vms ?? [] });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { ip_address, region, ssh_port, ssh_user } = await req.json();

  if (!ip_address) {
    return NextResponse.json(
      { error: "ip_address is required" },
      { status: 400 }
    );
  }

  const supabase = getSupabase();
  const { data: vm, error } = await supabase
    .from("instaclaw_vms")
    .insert({
      ip_address,
      region: region || null,
      ssh_port: ssh_port ?? 22,
      ssh_user: ssh_user ?? "openclaw",
      status: "provisioning",
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ vm });
}
