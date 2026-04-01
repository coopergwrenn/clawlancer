import { getSession } from "@/lib/auth";
import { getAgentStatus, getDailyUsage, getGoogleStatus, getSubscriptionStatus, type SubscriptionInfo } from "@/lib/supabase";
import { redirect } from "next/navigation";
import AgentDashboard from "./agent-dashboard";
import ProvisioningStatus from "./provisioning-status";

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/");

  let agent = null;
  let usage = null;
  let gmailConnected = false;
  let subscription: SubscriptionInfo = {
    hasSubscription: false, tier: null, status: null,
    paymentStatus: null, currentPeriodEnd: null, dailyLimit: 0, dailyUsed: 0,
  };

  console.log("[Home] Session userId:", session.userId, "walletAddress:", session.walletAddress);

  try {
    agent = await getAgentStatus(session.userId);
    console.log("[Home] Agent result:", agent ? `${agent.id} (${agent.status})` : "null");
    if (agent) {
      try {
        usage = await getDailyUsage(agent.id);
      } catch { /* usage fetch failed — not critical */ }
    }
    try {
      const googleStatus = await getGoogleStatus(session.userId);
      gmailConnected = googleStatus.connected;
    } catch { /* google status fetch failed — not critical */ }
    try {
      subscription = await getSubscriptionStatus(session.userId);
    } catch { /* subscription fetch failed — not critical */ }
  } catch (err) {
    console.error("[Home] Error fetching agent:", err);
    // Fallback: try a direct query without .single() to see what's there
    try {
      const { supabase: db } = await import("@/lib/supabase");
      const { data: vms } = await db()
        .from("instaclaw_vms")
        .select("id, status, health_status, credit_balance, default_model, xmtp_address, telegram_bot_token, telegram_bot_username, assigned_at, last_health_check")
        .eq("assigned_to", session.userId);
      console.log("[Home] Fallback VM query returned:", vms?.length, "rows");
      if (vms && vms.length > 0) {
        agent = vms[0];
      }
    } catch (fallbackErr) {
      console.error("[Home] Fallback query also failed:", fallbackErr);
    }
  }

  if (!agent) {
    // Check if this is a returning user (has delegations/verified) vs truly new
    // If returning user with no VM visible, show a status message, not the full provisioning animation
    try {
      const { supabase: db } = await import("@/lib/supabase");
      const { data: userData } = await db()
        .from("instaclaw_users")
        .select("world_id_verified")
        .eq("id", session.userId)
        .single();

      if (userData?.world_id_verified) {
        // Verified but no agent — check if they actually have a confirmed delegation
        // If no confirmed delegation, they haven't paid → send back to onboarding
        const { data: confirmedDel } = await db()
          .from("instaclaw_wld_delegations")
          .select("id")
          .eq("user_id", session.userId)
          .eq("status", "confirmed")
          .limit(1)
          .single();

        // Also check for Stripe subscription (web app users)
        const { data: activeSub } = await db()
          .from("instaclaw_subscriptions")
          .select("id")
          .eq("user_id", session.userId)
          .in("status", ["active", "trialing"])
          .limit(1)
          .single();

        if (confirmedDel || activeSub) {
          // Paid — show provisioning UI
          return <ProvisioningStatus />;
        }
        // Verified but never paid → back to onboarding payment step
        redirect("/");
      }
    } catch { /* fall through */ }

    // Check if user has a pending WLD delegation (mid-provisioning)
    try {
      const { supabase: db } = await import("@/lib/supabase");
      const { data: pendingDelegation } = await db()
        .from("instaclaw_wld_delegations")
        .select("id")
        .eq("user_id", session.userId)
        .in("status", ["confirmed", "pending_confirmation"])
        .limit(1)
        .single();

      if (pendingDelegation) {
        // User paid but VM not assigned yet — show provisioning status
        return <ProvisioningStatus />;
      }
    } catch { /* no delegation */ }

    // No agent, not verified, no pending delegation → back to onboarding
    redirect("/");
  }

  return (
    <AgentDashboard
      agent={agent}
      usage={usage}
      walletAddress={session.walletAddress}
      gmailConnected={gmailConnected}
      subscription={subscription}
    />
  );
}
