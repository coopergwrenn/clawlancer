/**
 * /edge/dashboard — Edge City attendee dashboard.
 *
 * Server component. Gates by NextAuth session + `instaclaw_users.partner ===
 * "edge_city"`. Non-edge_city users get redirected to /edge (the marketing
 * page). Unauthenticated users get sent to /signin.
 *
 * Sibling to /edge (marketing) and /edge/plaza (public funnel dashboard).
 * Inherits the Edge theme from app/edge/layout.tsx (olive/sage on off-white)
 * which deliberately escapes the InstaClaw dashboard chrome — the page
 * carries its own slim back-link to /dashboard at the top.
 *
 * Phase 4 MVP scope: display_name + spectator_visible toggles + embedded
 * spectator iframe + link to full spectator. Index Network match history,
 * agent status detail, etc. land after May 30.
 */
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { createMetadata } from "@/lib/seo";
import { EdgeDashboardClient } from "./edge-dashboard-client";
import {
  fetchUserMatchHistory,
  fetchUserCurrentIntent,
} from "@/lib/edge-dashboard-data";

export const dynamic = "force-dynamic";

export const metadata = createMetadata({
  title: "My Village — Edge Esmeralda 2026",
  description: "Manage your agent's village presence at Edge Esmeralda.",
  path: "/edge/dashboard",
});

export default async function EdgeDashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/signin?next=/edge/dashboard");
  }

  // Gate: partner must be edge_city. Non-Edge users land on the marketing
  // page, where they can claim an agent or learn more.
  if (session.user.partner !== "edge_city") {
    redirect("/edge");
  }

  const supabase = getSupabase();

  // Fetch the user's edge VM. Used for:
  //   - index_api_key: drives the current-intent fetch + the
  //     "setup complete" empty-state branching.
  //   - telegram_bot_username: drives the "Open in Telegram" CTA at
  //     the top of the dashboard (F2 audit fix 2026-05-22 — recovery
  //     surface for attendees who lost the Telegram deep-link via
  //     thread deletion, device switch, or bookmark-only navigation).
  const { data: edgeVm } = await supabase
    .from("instaclaw_vms")
    .select("index_api_key, telegram_bot_username")
    .eq("assigned_to", session.user.id)
    .eq("partner", "edge_city")
    .maybeSingle();
  const indexApiKey = (edgeVm?.index_api_key as string | null) ?? null;
  const telegramBotUsername =
    (edgeVm?.telegram_bot_username as string | null) ?? null;

  // Parallel fetch: village overlay + rendered name + match history +
  // current intent + trial state. The MCP call for current-intent is
  // the slowest leg (~1-2s); everything else is sub-200ms. Promise.all
  // overlaps the wait. If Yanek's MCP fails, fetchUserCurrentIntent
  // returns null and the dashboard renders without the intent line —
  // no crash.
  //
  // trial query: Edge attendees get a fixed trial_end through June 30
  // (see app/api/billing/checkout/route.ts:EDGE_TRIAL_END_UTC). We
  // surface this on the dashboard so they know what to expect on the
  // day-after-the-village billing event. Pulls the most-recent
  // subscription row with a non-null trial_ends_at; any active or
  // trialing sub qualifies. If the user has no sub (admin-comped or
  // similar edge case), trialSub is null and we just don't render the
  // indicator.
  const [overlay, viewRow, matches, currentIntent, trialSub] = await Promise.all([
    supabase
      .from("village_attendee_overlay")
      .select("display_name, spectator_visible, larry_atlas_index, home_tile_x, home_tile_y")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then((r) => r.data),
    supabase
      .from("village_attendees")
      .select("display_name, full_name, spectator_visible")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then((r) => r.data),
    fetchUserMatchHistory(session.user.id),
    fetchUserCurrentIntent(session.user.id, indexApiKey),
    supabase
      .from("instaclaw_subscriptions")
      .select("trial_ends_at, status")
      .eq("user_id", session.user.id)
      .in("status", ["active", "trialing"])
      .not("trial_ends_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then((r) => r.data),
  ]);

  // Only surface the indicator if the trial is still in the future —
  // post-June-30 there's no point showing "trial ends June 30" to
  // attendees who are now on the paid plan; the renewal-date field
  // takes over at that point.
  const trialEndsAt =
    trialSub?.trial_ends_at &&
    new Date(trialSub.trial_ends_at).getTime() > Date.now()
      ? (trialSub.trial_ends_at as string)
      : null;

  return (
    <EdgeDashboardClient
      userId={session.user.id}
      userName={session.user.name ?? null}
      initialOverlay={overlay ?? null}
      initialRendered={{
        display_name: viewRow?.display_name ?? "Agent",
        full_name: viewRow?.full_name ?? null,
        spectator_visible: viewRow?.spectator_visible ?? true,
      }}
      matches={matches}
      currentIntent={currentIntent}
      userHasIndexKey={!!indexApiKey}
      // intentFetchSucceeded distinguishes "no intent yet" (succeeded,
      // empty) from "couldn't load" (call failed). When indexApiKey is
      // present AND fetchUserCurrentIntent returned null, we treat that
      // as either "no intent" (success, empty array) or "fetch failed"
      // — the fetcher logs the distinction but the boolean we surface
      // here is conservative: true ONLY if we had a key AND null comes
      // back. The UX collapses both into a single "no intent" prompt
      // since either way the user's actionable next step is the same.
      intentFetchSucceeded={!!indexApiKey}
      trialEndsAt={trialEndsAt}
      telegramBotUsername={telegramBotUsername}
    />
  );
}
