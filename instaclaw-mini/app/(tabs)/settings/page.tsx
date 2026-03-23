import { getSession } from "@/lib/auth";
import {
  getAgentStatus,
  getDelegationHistory,
  getPaymentHistory,
} from "@/lib/supabase";
import { redirect } from "next/navigation";
import SettingsClient from "./settings-client";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const agent = await getAgentStatus(session.userId);
  const delegations = await getDelegationHistory(session.userId);
  const payments = await getPaymentHistory(session.userId);

  return (
    <SettingsClient
      walletAddress={session.walletAddress}
      agent={agent}
      delegations={delegations}
      payments={payments}
    />
  );
}
