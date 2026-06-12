import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getUserVm } from "@/lib/get-user-vm";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const NO_CACHE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Vary: "Cookie",
};

/**
 * GET /api/credits/video
 *
 * Returns the authenticated user's VIDEO credit balance (the Higgsfield
 * cinematic-clip pool on instaclaw_vms.video_credit_balance — separate from
 * message credits and media credits). Mirrors /api/credits/media exactly.
 *
 * Audit finding (2026-06-12 billing-hub rebuild): video_credit_balance had
 * NO UI-readable endpoint — the gate and webhook read/write it server-side,
 * but no dashboard surface could display it. This closes that gap.
 *
 * clips = balance / 13 (one premium render holds/settles 13 vc; see
 * lib/higgsfield-models.ts estimateVideoCredits + the 171==171 COGS
 * reconciliation). Computed server-side so every surface shows the same
 * number and a future per-render cost change edits ONE place.
 *
 * Session-authed (Rule 13.2: middleware session check is the first line; no
 * selfAuthAPIs entry needed).
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
    const vm = await getUserVm<{
      video_credit_balance: number | null;
      updated_at: string | null;
    }>(supabase, session.user.id, { columns: "video_credit_balance, updated_at" });

    if (!vm) {
      return NextResponse.json(
        { balance: 0, clips: 0, updated_at: new Date().toISOString() },
        { headers: NO_CACHE_HEADERS },
      );
    }

    const balance = Number(vm.video_credit_balance ?? 0);
    return NextResponse.json(
      {
        balance,
        clips: Math.floor(balance / 13),
        updated_at: vm.updated_at ?? new Date().toISOString(),
      },
      { headers: NO_CACHE_HEADERS },
    );
  } catch (err) {
    logger.error("Video credit balance fetch error", {
      error: String(err),
      route: "credits/video",
    });
    return NextResponse.json(
      { balance: null, error: "Unable to fetch balance" },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }
}
