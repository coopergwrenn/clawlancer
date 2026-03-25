import { getSession } from "@/lib/auth";
import { getAgentStatus, getDailyUsage } from "@/lib/supabase";
import { redirect } from "next/navigation";
import AgentDashboard from "./agent-dashboard";
import ProvisioningStatus from "./provisioning-status";

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/");

  let agent = null;
  let usage = null;

  console.log("[Home] Session userId:", session.userId, "walletAddress:", session.walletAddress);

  try {
    agent = await getAgentStatus(session.userId);
    console.log("[Home] Agent result:", agent ? `${agent.id} (${agent.status})` : "null");
    if (agent) {
      try {
        usage = await getDailyUsage(agent.id);
      } catch { /* usage fetch failed — not critical */ }
    }
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
        // Returning verified user — show simple status, not provisioning loop
        return (
          <div className="flex h-full flex-col items-center justify-center px-8" style={{ background: "#f8f7f4", color: "#333334" }}>
            <h2 className="text-xl font-medium mb-2" style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}>
              Your agent is being configured
            </h2>
            <p className="text-center text-sm mb-6" style={{ color: "#6b6b6b" }}>
              This can take a few minutes. Try the Chat or Settings tabs while you wait.
            </p>
            <p className="text-xs" style={{ color: "#aaa" }}>
              Session: {session.userId.slice(0, 8)}...
            </p>
          </div>
        );
      }
    } catch { /* fall through to provisioning */ }

    return <ProvisioningStatus />;
  }

  return (
    <AgentDashboard
      agent={agent}
      usage={usage}
      walletAddress={session.walletAddress}
    />
  );
}
