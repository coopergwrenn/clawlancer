import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const HAT_TOTAL = 500;

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const session = await auth();
  if (session?.user?.id) return session.user.id;
  const { validateMiniAppToken } = await import("@/lib/security");
  return (await validateMiniAppToken(req)) ?? null;
}

/**
 * POST /api/agentbook/claim-hat
 *
 * Records that the user clicked "Claim my hat" on the banner. The actual
 * hat fulfillment happens at https://humanrequired.shop/products/human-in-the-loop-hat
 * (external shop — World ID / AgentBook gates are checked there at
 * checkout). We just record the click locally so the banner stops
 * nagging this user.
 *
 * Eligibility:
 *   - World-ID-verified
 *   - VM agentbook_registered = true (humanrequired.shop won't sell to
 *     non-registered agents anyway, but we gate here so the banner can't
 *     advance state for unregistered users)
 *   - hat_claimed_at IS NULL
 *   - total claims < HAT_TOTAL (sold-out gate)
 *
 * No body required. Returns 200 { claimed: true, claimedAt, hatsRemaining }.
 *
 * Note: hat_claimed_at is optimistic — set on click, not on actual
 * shipping confirmation. If we ever need shipping-truth, swap in a
 * webhook from humanrequired.shop. The banner gating is good enough
 * with optimistic for now.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const [userRes, vmRes, claimCountRes] = await Promise.all([
      supabase.from("instaclaw_users").select("*").eq("id", userId).maybeSingle(),
      supabase.from("instaclaw_vms").select("*").eq("assigned_to", userId).maybeSingle(),
      supabase
        .from("instaclaw_users")
        .select("id", { count: "exact", head: true })
        .not("hat_claimed_at", "is", null),
    ]);

    const user = userRes.data as { id?: string; world_id_verified?: boolean | null; hat_claimed_at?: string | null } | null;
    const vm = vmRes.data as { agentbook_registered?: boolean | null } | null;
    const totalClaimed = claimCountRes.count ?? 0;

    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    if (user.hat_claimed_at) return NextResponse.json({ error: "Hat already claimed" }, { status: 409 });
    if (totalClaimed >= HAT_TOTAL) return NextResponse.json({ error: "All hats claimed" }, { status: 410 });
    if (!user.world_id_verified) return NextResponse.json({ error: "World ID verification required" }, { status: 403 });
    if (!vm?.agentbook_registered) return NextResponse.json({ error: "AgentBook registration required" }, { status: 403 });

    const claimedAt = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from("instaclaw_users")
      .update({ hat_claimed_at: claimedAt })
      .eq("id", userId);

    if (updateErr) {
      logger.error("Failed to record hat claim", {
        error: String(updateErr),
        userId,
        route: "agentbook/claim-hat",
      });
      return NextResponse.json({ error: "Failed to record claim" }, { status: 500 });
    }

    return NextResponse.json({
      claimed: true,
      claimedAt,
      hatsRemaining: Math.max(0, HAT_TOTAL - totalClaimed - 1),
    });
  } catch (err) {
    logger.error("AgentBook claim-hat POST error", {
      error: String(err),
      route: "agentbook/claim-hat",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
