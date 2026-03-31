import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/delegate/status?reference=xxx
 *
 * Polls the status of a WLD delegation. Used by the client when
 * a payment is pending on-chain confirmation.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession();
    const reference = req.nextUrl.searchParams.get("reference");

    if (!reference) {
      return NextResponse.json({ error: "reference required" }, { status: 400 });
    }

    const { data: delegation } = await supabase()
      .from("instaclaw_wld_delegations")
      .select("status, credits_granted")
      .eq("transaction_id", reference)
      .eq("user_id", session.userId)
      .single();

    if (!delegation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      status: delegation.status,
      credits: delegation.credits_granted,
      confirmed: delegation.status === "confirmed",
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
