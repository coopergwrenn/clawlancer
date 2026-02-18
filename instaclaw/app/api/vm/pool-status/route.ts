import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const maxDuration = 10;

/**
 * GET /api/vm/pool-status
 * Returns the count of available VMs in the pool
 */
export async function GET() {
  try {
    const supabase = getSupabase();

    const { count: availableVMs } = await supabase
      .from("instaclaw_vms")
      .select("*", { count: "exact", head: true })
      .eq("status", "ready");

    return NextResponse.json({
      availableVMs: availableVMs ?? 0,
    });
  } catch (error) {
    console.error("Error checking VM pool status:", error);
    return NextResponse.json(
      { error: "Failed to check pool status" },
      { status: 500 }
    );
  }
}
