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

  // Prefetch the user's current overlay + the canonical rendered display
  // name (post-COALESCE), so the client can render without flash.
  const { data: overlay } = await supabase
    .from("village_attendee_overlay")
    .select("display_name, spectator_visible, larry_atlas_index, home_tile_x, home_tile_y")
    .eq("user_id", session.user.id)
    .maybeSingle();

  const { data: viewRow } = await supabase
    .from("village_attendees")
    .select("display_name, full_name, spectator_visible")
    .eq("user_id", session.user.id)
    .maybeSingle();

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
    />
  );
}
