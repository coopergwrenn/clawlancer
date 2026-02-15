import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export async function PATCH() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  await supabase
    .from("instaclaw_users")
    .update({
      onboarding_wizard_completed: true,
      onboarding_wizard_completed_at: new Date().toISOString(),
    })
    .eq("id", session.user.id);

  return NextResponse.json({ completed: true });
}
