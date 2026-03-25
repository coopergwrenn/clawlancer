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

  try {
    agent = await getAgentStatus(session.userId);
    if (agent) {
      usage = await getDailyUsage(agent.id);
    }
  } catch (err) {
    console.error("[Home] Error fetching agent:", err);
  }

  if (!agent) {
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
