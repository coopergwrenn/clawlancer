/**
 * GET /api/toolrouter/balance — read-only allocation state for the
 * dashboard "Premium tools" card. PRD §7.11 Task K.9.
 *
 * Reads from instaclaw_users + instaclaw_subscriptions to compute:
 *   - balance: this month's included grant remaining
 *   - grant_total: the tier-default OR per-user override
 *   - topup_balance: purchased Stripe top-up packs remaining (stacks)
 *   - period_start: when the current monthly cycle began
 *   - reset_at: when the next monthly cycle starts (period_start + 1mo)
 *   - tier: commercial tier from instaclaw_subscriptions
 *
 * Auth: NextAuth session. Returns 401 unauthenticated.
 *
 * The UI card lives in app/(dashboard)/dashboard/credits/page.tsx (or
 * a sibling). v1 ships this endpoint; the React card is a follow-up
 * with the design team (premium-tools-card spec in PRD §5.3.3).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { toolrouterTierGrant, TOOLROUTER_TOPUP_PACK } from "@/lib/toolrouter-credits";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supabase = getSupabase();

  const { data: userRow, error: userErr } = await supabase
    .from("instaclaw_users")
    .select("toolrouter_balance, toolrouter_grant_override, toolrouter_grant_period_start, toolrouter_topup_balance, timezone")
    .eq("id", session.user.id)
    .maybeSingle();
  if (userErr || !userRow) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const { data: subRow } = await supabase
    .from("instaclaw_subscriptions")
    .select("tier")
    .eq("user_id", session.user.id)
    .maybeSingle();
  const tier = (subRow?.tier as string | undefined) ?? "starter";
  const tierGrant = toolrouterTierGrant(tier);
  const grantTotal = userRow.toolrouter_grant_override ?? tierGrant;
  const periodStart = userRow.toolrouter_grant_period_start as string | null;
  const resetAt = periodStart
    ? new Date(new Date(periodStart).getTime() + 30 * 86400_000).toISOString()
    : null;

  return NextResponse.json({
    tier,
    balance: Number(userRow.toolrouter_balance ?? 0),
    grant_total: Number(grantTotal),
    topup_balance: Number(userRow.toolrouter_topup_balance ?? 0),
    period_start: periodStart,
    reset_at: resetAt,
    timezone: userRow.timezone ?? "UTC",
    topup_pack: {
      slug: TOOLROUTER_TOPUP_PACK.pack_slug,
      credits: TOOLROUTER_TOPUP_PACK.credits,
      price_usd: TOOLROUTER_TOPUP_PACK.price_usd,
      label: TOOLROUTER_TOPUP_PACK.label,
    },
  });
}
