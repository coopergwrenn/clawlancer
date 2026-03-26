import { getSession } from "@/lib/auth";
import {
  getAgentStatus,
  getDelegationHistory,
  getPaymentHistory,
  getGoogleStatus,
  getSubscriptionStatus,
  type SubscriptionInfo,
} from "@/lib/supabase";
import { redirect } from "next/navigation";
import SettingsClient from "./settings-client";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/");

  let agent = null;
  let delegations: Awaited<ReturnType<typeof getDelegationHistory>> = [];
  let payments: Awaited<ReturnType<typeof getPaymentHistory>> = [];
  let gmailConnected = false;
  let subscription: SubscriptionInfo = {
    hasSubscription: false, tier: null, status: null,
    paymentStatus: null, currentPeriodEnd: null, dailyLimit: 0, dailyUsed: 0,
  };

  try {
    agent = await getAgentStatus(session.userId);
  } catch (err) {
    console.error("[Settings] Error fetching agent:", err);
  }

  try {
    delegations = await getDelegationHistory(session.userId);
  } catch (err) {
    console.error("[Settings] Error fetching delegations:", err);
  }

  try {
    payments = await getPaymentHistory(session.userId);
  } catch (err) {
    console.error("[Settings] Error fetching payments:", err);
  }

  try {
    const googleStatus = await getGoogleStatus(session.userId);
    gmailConnected = googleStatus.connected;
  } catch { /* not critical */ }

  try {
    subscription = await getSubscriptionStatus(session.userId);
  } catch { /* not critical */ }

  return (
    <SettingsClient
      walletAddress={session.walletAddress}
      agent={agent}
      delegations={delegations}
      payments={payments}
      gmailConnected={gmailConnected}
      subscription={subscription}
    />
  );
}
