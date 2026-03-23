import { getSession } from "@/lib/auth";
import { getAgentStatus, getDailyUsage } from "@/lib/supabase";
import { redirect } from "next/navigation";
import AgentDashboard from "./agent-dashboard";

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/");

  const agent = await getAgentStatus(session.userId);
  if (!agent) redirect("/");

  const usage = await getDailyUsage(agent.id);

  return (
    <AgentDashboard
      agent={agent}
      usage={usage}
      walletAddress={session.walletAddress}
    />
  );
}
