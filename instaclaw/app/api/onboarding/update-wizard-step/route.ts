import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { step } = await req.json();

  if (typeof step !== "number" || step < 0) {
    return NextResponse.json({ error: "Invalid step" }, { status: 400 });
  }

  const supabase = getSupabase();

  await supabase
    .from("instaclaw_users")
    .update({ onboarding_wizard_step: step })
    .eq("id", session.user.id);

  return NextResponse.json({ updated: true });
}
