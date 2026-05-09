import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Per-user response — never CDN-cache.
export const dynamic = "force-dynamic";

const DISMISSAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Resolve userId from either a logged-in web session OR a mini app token.
 * Mirrors the dual-auth pattern used in /api/agentbook/check-registration.
 */
async function resolveUserId(req: NextRequest): Promise<string | null> {
  const session = await auth();
  if (session?.user?.id) return session.user.id;
  const { validateMiniAppToken } = await import("@/lib/security");
  return (await validateMiniAppToken(req)) ?? null;
}

/**
 * GET /api/agentbook/banner-state
 *
 * Returns whether the AgentBook hat-claim banner should be shown for this
 * user. Server-side state only — the client owns the "first visit" gate
 * (Cooper's spec: don't show on first-ever dashboard load) via localStorage,
 * keeping that decision out of the DB.
 *
 * Response:
 *   { registered: boolean,   // user's VM has agentbook_registered=true
 *     dismissed: boolean,    // user dismissed within the last 30 days
 *     shouldShow: boolean }  // !registered && !dismissed (server-side only)
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Per Rule 19 — use select("*") for safety-critical reads. Two cheap
    // queries; both gate the banner so neither can be skipped.
    const [vmRes, userRes] = await Promise.all([
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
    ]);

    const registered = Boolean(vmRes.data?.agentbook_registered);
    const dismissedAtRaw = userRes.data?.agentbook_banner_dismissed_at as
      | string
      | null
      | undefined;
    const dismissedAt = dismissedAtRaw ? new Date(dismissedAtRaw).getTime() : null;
    const dismissed =
      dismissedAt !== null && Date.now() - dismissedAt < DISMISSAL_WINDOW_MS;

    return NextResponse.json({
      registered,
      dismissed,
      shouldShow: !registered && !dismissed,
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
 * Marks the banner dismissed for this user. Idempotent — sets
 * agentbook_banner_dismissed_at to now(), overwriting any prior dismissal.
 * Re-dismissing within the 30-day window is a no-op from the user's
 * perspective; outside the window it resets the timer.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();
    const { error } = await supabase
      .from("instaclaw_users")
      .update({ agentbook_banner_dismissed_at: new Date().toISOString() })
      .eq("id", userId);

    if (error) {
      logger.error("Failed to dismiss AgentBook banner", {
        error: String(error),
        userId,
        route: "agentbook/banner-state",
      });
      return NextResponse.json({ error: "Failed to dismiss" }, { status: 500 });
    }

    return NextResponse.json({ dismissed: true });
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
