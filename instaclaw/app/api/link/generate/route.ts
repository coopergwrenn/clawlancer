import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

/**
 * POST /api/link/generate — Generate a one-time linking code.
 * The user enters this code in the World mini app to link their
 * instaclaw.io account (Google auth) with their World wallet.
 * Code expires in 10 minutes.
 */
export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Generate 8-char uppercase code
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

    const { error } = await supabase
      .from("instaclaw_users")
      .update({
        linking_code: code,
        linking_code_expires_at: new Date(
          Date.now() + 10 * 60 * 1000
        ).toISOString(),
      })
      .eq("id", session.user.id);

    if (error) throw error;

    return NextResponse.json({ code, expiresIn: 600 });
  } catch (err) {
    console.error("Link generate error:", err);
    return NextResponse.json(
      { error: "Failed to generate code" },
      { status: 500 }
    );
  }
}
