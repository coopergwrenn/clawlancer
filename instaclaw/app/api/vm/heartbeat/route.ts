import { NextRequest, NextResponse } from "next/server";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { getSupabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const vm = await lookupVMByGatewayToken(token, "id, name");
  if (!vm) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getSupabase();
  await supabase
    .from("instaclaw_vms")
    .update({ heartbeat_last_at: new Date().toISOString() })
    .eq("id", vm.id);

  return NextResponse.json({ ok: true });
}
