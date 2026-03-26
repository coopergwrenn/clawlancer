import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/subscription/checkout-url?tier=starter
 *
 * Generates the URL for the mini app to open in the system browser.
 * Routes to instaclaw.io/upgrade which handles Google sign-in + Stripe checkout.
 * Passes the user's email as a hint so Google OAuth pre-fills it.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession();
    const tier = req.nextUrl.searchParams.get("tier") || "starter";

    // Get the user's email to pass as a login hint
    const { data: user } = await supabase()
      .from("instaclaw_users")
      .select("email")
      .eq("id", session.userId)
      .single();

    const baseUrl = process.env.INSTACLAW_API_URL || "https://instaclaw.io";
    const params = new URLSearchParams({
      tier,
      from: "mini-app",
    });
    if (user?.email) {
      params.set("email", user.email);
    }

    const url = `${baseUrl}/upgrade?${params.toString()}`;
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to generate checkout URL" }, { status: 500 });
  }
}
