import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const NO_CACHE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Vary: "Cookie",
};

/**
 * GET /api/credits/media
 *
 * Returns the authenticated user's media credit balance.
 * Uses the same credit_balance pool on instaclaw_vms that
 * the gateway muapi/credits endpoint reads.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { balance: null, error: "Unauthorized" },
        { status: 401, headers: NO_CACHE_HEADERS },
      );
    }

    const supabase = getSupabase();
    const { data: vm, error } = await supabase
      .from("instaclaw_vms")
      .select("credit_balance, updated_at")
      .eq("assigned_to", session.user.id)
      .single();

    if (error || !vm) {
      return NextResponse.json(
        { balance: 0, updated_at: new Date().toISOString() },
        { headers: NO_CACHE_HEADERS },
      );
    }

    return NextResponse.json(
      {
        balance: vm.credit_balance ?? 0,
        updated_at: vm.updated_at ?? new Date().toISOString(),
      },
      { headers: NO_CACHE_HEADERS },
    );
  } catch (err) {
    logger.error("Media credit balance fetch error", {
      error: String(err),
      route: "credits/media",
    });
    return NextResponse.json(
      { balance: null, error: "Unable to fetch balance" },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }
}
