import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

/**
 * Three buckets /edge cares about for choosing which CTA to show.
 *
 * The shape mirrors the dashboard layout's data-driven routing decision
 * (see app/(dashboard)/layout.tsx) — we deliberately avoid leaning on
 * `session.user.onboardingComplete` alone, because that flag can lag VM
 * state by minutes when configure partially commits (Rule 33). VM state is
 * the source of truth.
 *
 *   logged_out   — no session, render the canonical claim CTA.
 *   in_progress  — session exists but VM is not yet usable. `resumePath`
 *                  is the next step in the onboarding state machine,
 *                  picked so the user lands exactly where they dropped off.
 *   live         — a usable VM with a verified bot. Surface the bot
 *                  username and a deep-link to Telegram.
 */
export type EdgeUserState =
  | { kind: "logged_out" }
  | {
      kind: "in_progress";
      resumePath: "/connect" | "/plan" | "/deploying" | "/dashboard";
    }
  | { kind: "live"; botUsername: string };

export async function getEdgeUserState(): Promise<EdgeUserState> {
  const session = await auth();
  if (!session?.user?.id) return { kind: "logged_out" };

  // Defensive: treat non-Edge-tagged authenticated users as logged_out
  // for /edge's CTA derivation.
  //
  // The 2026-05-22 Cooper-shelpinc-incognito case: a non-Edge InstaClaw
  // user (shelpinc, partner=null) opened /edge in a "fresh" incognito
  // that still had a stale NextAuth session from earlier testing. The
  // page showed "COMPLETE SETUP" pointing at /connect — wrong CTA for
  // a user who isn't actually mid-Edge-onboarding. They're either (a)
  // a real InstaClaw user curious about Edge, in which case "Claim
  // your agent" inviting them into the Edge flow is right, or (b) a
  // truly logged-out visitor whose browser is leaking, in which case
  // same CTA still works.
  //
  // For partner=edge_city users (the actual Edge cohort), this check
  // falls through to the existing VM/pending logic — they get "Complete
  // setup" or "Open agent" as appropriate.
  //
  // Their existing non-Edge onboarding remains reachable via /dashboard.
  // We're only changing what /edge specifically shows them. Per Cooper's
  // directive: "treat as logged_out for CTA derivation."
  if (session.user.partner !== "edge_city") {
    return { kind: "logged_out" };
  }

  const supabase = getSupabase();

  // Most recent assigned VM. Multi-VM users (rare — typically internal/test)
  // get the freshest one; that matches what /api/vm/status returns for the
  // dashboard, so the two redirect paths agree.
  // Using .select("*") for safety-critical reads per Rule 19 — column-grant
  // misconfig would otherwise return silent nulls and break detection.
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", session.user.id)
    .order("created_at", { ascending: false })
    .limit(1);

  const vm = vms?.[0];

  if (vm) {
    // Frozen VMs (90+ day inactive — Linode instance deleted, snapshot only)
    // require thaw via /dashboard. Don't surface "your agent is live."
    if (vm.health_status === "frozen") {
      return { kind: "in_progress", resumePath: "/dashboard" };
    }

    // Healthy or sleeping. Per Rule 15, "hibernating" and "suspended" are
    // operationally identical — both have stopped gateways but running
    // Linode instances, and wake-paid-hibernating (or the first inbound
    // Telegram message) brings them back. Show the bot link either way.
    const isLive =
      !!vm.telegram_bot_username &&
      !!vm.gateway_url &&
      ["healthy", "hibernating", "suspended"].includes(
        vm.health_status ?? ""
      );

    if (isLive) {
      return { kind: "live", botUsername: vm.telegram_bot_username! };
    }

    // VM exists but isn't usable yet. /deploying has the right UI for both
    // mid-configure (progress) and configure_failed (retry) — don't try to
    // re-derive that distinction here.
    return { kind: "in_progress", resumePath: "/deploying" };
  }

  // No VM. Did they make it past signup into pending state?
  const { data: pending } = await supabase
    .from("instaclaw_pending_users")
    .select("telegram_bot_token")
    .eq("user_id", session.user.id)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (pending?.[0]?.telegram_bot_token) {
    // They provided a bot token via the legacy /connect flow; next
    // step is plan / checkout. Preserved for users who started
    // pre-2026-05-29 when /connect was a required step.
    return { kind: "in_progress", resumePath: "/plan" };
  }

  // Logged in but no pending row. 2026-05-29: previously resumed
  // at /connect; new flow sends every user (Edge included) straight
  // to /plan. /connect is now a power-user opt-in path only, reachable
  // via the "use the legacy setup" footnote on /plan and /channels.
  return { kind: "in_progress", resumePath: "/plan" };
}
