import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const { code } = await req.json();

  if (!code || typeof code !== "string") {
    return NextResponse.json({ valid: false });
  }

  const supabase = getSupabase();

  const { data: ambassador } = await supabase
    .from("instaclaw_ambassadors")
    .select("id, referral_code, ambassador_name")
    .eq("referral_code", code.trim().toLowerCase())
    .eq("status", "approved")
    .single();

  if (!ambassador) {
    return NextResponse.json({ valid: false });
  }

  return NextResponse.json({
    valid: true,
    discount: "25%",
    ambassadorName: ambassador.ambassador_name,
  });
}
