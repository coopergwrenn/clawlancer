import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { auth } from "@/lib/auth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("gateway_url")
      .eq("assigned_user_id", session.user.id)
      .eq("status", "assigned")
      .single();

    if (!vm?.gateway_url) {
      return NextResponse.json({ connected: false, error: "No VM assigned" });
    }

    const gwUrl = vm.gateway_url.replace(/\/+$/, "");
    const res = await fetch(`${gwUrl}/relay/extension/status`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({ connected: false });
    }

    const data = await res.json();
    return NextResponse.json({ connected: !!data.connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
