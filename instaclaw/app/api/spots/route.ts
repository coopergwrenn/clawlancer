import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = getSupabase();

    const { count: available } = await supabase
      .from("instaclaw_vms")
      .select("*", { count: "exact", head: true })
      .eq("status", "ready");

    return NextResponse.json(
      { available: available ?? 0 },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
        },
      }
    );
  } catch (err) {
    logger.error("Spots count error", { error: String(err), route: "spots" });
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
