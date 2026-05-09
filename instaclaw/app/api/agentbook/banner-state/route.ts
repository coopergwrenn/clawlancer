import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Per-user response — never CDN-cache.
export const dynamic = "force-dynamic";

const HAT_TOTAL = 500;
const SOLD_OUT_CELEBRATION_HOURS = 24;

/**
 * Banner state machine.  Returned to the client; drives copy + CTA.
 *
 *   nudge_verify   — user not yet World-ID-verified (prereq for AgentBook).
 *                    Pitch: get verified to claim a hat.
 *   nudge_register — verified, has wallet, NOT yet registered in AgentBook.
 *                    Pitch: register to claim a hat.
 *   nudge_claim    — registered, hat NOT yet claimed.
 *                    Action: claim your hat.
 *   sold_out       — all 500 claimed, within last-claim + 24h celebration window.
 *                    Show "all 500 claimed" banner with no CTA / no dismiss.
 *   hidden         — anything else (claimed, sold-out beyond 24h celebration,
 *                    no wallet provisioned, etc.). Don't render.
 */
export type BannerState =
  | "nudge_verify"
  | "nudge_register"
  | "nudge_claim"
  | "sold_out"
  | "hidden";

interface UserRow {
  id?: string;
  world_id_verified?: boolean | null;
  hat_claimed_at?: string | null;
  agentbook_banner_dismissed_state?: string | null;
}

interface VmRow {
  agentbook_wallet_address?: string | null;
  agentbook_registered?: boolean | null;
}

/**
 * Resolve userId from web session OR mini-app token.
 * Mirrors /api/agentbook/check-registration's dual-auth pattern.
 */
async function resolveUserId(req: NextRequest): Promise<string | null> {
  const session = await auth();
  if (session?.user?.id) return session.user.id;
  const { validateMiniAppToken } = await import("@/lib/security");
  return (await validateMiniAppToken(req)) ?? null;
}

function computeState(
  user: UserRow | null,
  vm: VmRow | null,
  totalClaimed: number,
  lastClaimedAt: number | null,
): BannerState {
  // Job done — this user already has a hat.
  if (user?.hat_claimed_at) return "hidden";

  // Sold out
  if (totalClaimed >= HAT_TOTAL) {
    // 24h celebration window after the last claim
    if (
      lastClaimedAt !== null &&
      Date.now() - lastClaimedAt < SOLD_OUT_CELEBRATION_HOURS * 60 * 60 * 1000
    ) {
      return "sold_out";
    }
    return "hidden";
  }

  // No World-ID verification yet — push the hat as the carrot
  if (!user?.world_id_verified) return "nudge_verify";

  // Verified but no wallet provisioned — broken backend state, can't fix
  // from a banner CTA.  Hide rather than confuse.
  if (!vm?.agentbook_wallet_address) return "hidden";

  // Verified + wallet, NOT registered → nudge to register
  if (!vm?.agentbook_registered) return "nudge_register";

  // Registered, hat not claimed → nudge to claim
  return "nudge_claim";
}

/**
 * GET /api/agentbook/banner-state
 *
 * Returns:
 *   { state: BannerState,
 *     dismissed: boolean,    // dismissed_state === current state (state-scoped)
 *     shouldShow: boolean,
 *     hatsRemaining: number, // for caller-side hints (sold_out copy etc.)
 *     totalHats: number,
 *   }
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Per Rule 19: select("*") for safety-critical reads.
    const [vmRes, userRes, claimCountRes, lastClaimRes] = await Promise.all([
      supabase
        .from("instaclaw_vms")
        .select("*")
        .eq("assigned_to", userId)
        .maybeSingle(),
      supabase
        .from("instaclaw_users")
        .select("*")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("instaclaw_users")
        .select("id", { count: "exact", head: true })
        .not("hat_claimed_at", "is", null),
      supabase
        .from("instaclaw_users")
        .select("hat_claimed_at")
        .not("hat_claimed_at", "is", null)
        .order("hat_claimed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const totalClaimed = claimCountRes.count ?? 0;
    const lastClaimedAt = lastClaimRes.data?.hat_claimed_at
      ? new Date(lastClaimRes.data.hat_claimed_at).getTime()
      : null;

    const state = computeState(
      userRes.data as UserRow | null,
      vmRes.data as VmRow | null,
      totalClaimed,
      lastClaimedAt,
    );

    // State-scoped dismissal: banner is dismissed only if the user
    // dismissed AT THIS STATE.  Once state advances, dismissal resets.
    const dismissedState = (userRes.data as UserRow | null)?.agentbook_banner_dismissed_state ?? null;
    const dismissed = dismissedState === state;

    // sold_out has no dismiss affordance (auto-hides after 24h), so
    // dismissal doesn't apply.
    const shouldShow =
      state !== "hidden" && (state === "sold_out" ? true : !dismissed);

    return NextResponse.json({
      state,
      dismissed,
      shouldShow,
      hatsRemaining: Math.max(0, HAT_TOTAL - totalClaimed),
      totalHats: HAT_TOTAL,
    });
  } catch (err) {
    logger.error("AgentBook banner-state GET error", {
      error: String(err),
      route: "agentbook/banner-state",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/agentbook/banner-state
 *
 * Body: { state: BannerState }
 *
 * Records that the user dismissed the banner WHILE IN this state.
 * Banner re-emerges when state advances to something else (state-scoped
 * dismissal — Cooper's call).
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { state?: string };
    const state = body.state;

    // Allow-list valid dismissable states (sold_out NOT included — no
    // dismiss button on that state).
    const validStates: BannerState[] = ["nudge_verify", "nudge_register", "nudge_claim"];
    if (!state || !validStates.includes(state as BannerState)) {
      return NextResponse.json(
        { error: "Missing or invalid state" },
        { status: 400 }
      );
    }

    const supabase = getSupabase();
    const { error } = await supabase
      .from("instaclaw_users")
      .update({
        agentbook_banner_dismissed_state: state,
        // Keep the legacy timestamp updated too — useful for audit/forensics
        // even though the new state-scoped logic doesn't read it.
        agentbook_banner_dismissed_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (error) {
      logger.error("Failed to dismiss AgentBook banner", {
        error: String(error),
        userId,
        state,
        route: "agentbook/banner-state",
      });
      return NextResponse.json({ error: "Failed to dismiss" }, { status: 500 });
    }

    return NextResponse.json({ dismissed: true, state });
  } catch (err) {
    logger.error("AgentBook banner-state POST error", {
      error: String(err),
      route: "agentbook/banner-state",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
