import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CLAWLANCER_BASE = "https://clawlancer.ai";

// Possible locations for Clawlancer API key on the VM, checked in order:
// 1. ~/.openclaw/.env  (CLAWLANCER_API_KEY=...)  — current standard
// 2. ~/.clawdbot/skills/clawlancer/config.json   — legacy shell-script path
const CLAWLANCER_KEY_CMD = [
  'grep "^CLAWLANCER_API_KEY=" ~/.openclaw/.env 2>/dev/null | head -1 | sed "s/^CLAWLANCER_API_KEY=//"',
  'cat ~/.clawdbot/skills/clawlancer/config.json 2>/dev/null | grep -o \'"api_key":"[^"]*"\' | head -1 | sed \'s/"api_key":"//;s/"//g\'',
].join(" || ");

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, telegram_bot_username")
      .eq("assigned_to", session.user.id)
      .single();
    if (!vm) {
      return NextResponse.json({ registered: false, error: "No VM assigned" });
    }

    // Now fetch preferences with actual vm_id
    const { data: prefs } = await supabase
      .from("instaclaw_clawlancer_preferences")
      .select("auto_claim, approval_threshold_usdc")
      .eq("vm_id", vm.id)
      .single();

    // SSH to VM and read Clawlancer API key from env file
    let apiKey = "";
    try {
      const ssh = await connectSSH(vm as VMRecord);
      const result = await ssh.execCommand(CLAWLANCER_KEY_CMD);
      ssh.dispose();
      apiKey = (result.stdout ?? "").trim();
    } catch (sshErr) {
      logger.warn("Clawlancer status: SSH failed", {
        vmId: vm.id,
        error: String(sshErr),
      });
      return NextResponse.json({
        registered: false,
        vmId: vm.id,
        botUsername: vm.telegram_bot_username,
        error: "Could not connect to your agent instance. Try again in a moment.",
        preferences: {
          autoClaim: prefs?.auto_claim ?? true,
          approvalThreshold: Number(prefs?.approval_threshold_usdc ?? 50),
        },
      });
    }

    if (!apiKey) {
      return NextResponse.json({
        registered: false,
        vmId: vm.id,
        botUsername: vm.telegram_bot_username,
        preferences: {
          autoClaim: prefs?.auto_claim ?? true,
          approvalThreshold: Number(prefs?.approval_threshold_usdc ?? 50),
        },
      });
    }

    // Fetch profile first (we need agent_id for balance/transactions)
    const headers = { Authorization: `Bearer ${apiKey}` };

    let profile: any = null;
    try {
      const profileRes = await fetch(`${CLAWLANCER_BASE}/api/agents/me`, { headers });
      if (profileRes.ok) profile = await profileRes.json();
    } catch {
      // Clawlancer API may be down — continue with what we have
    }

    const agentId = profile?.id ?? null;

    // Fetch balance + transactions in parallel (need agent_id)
    const [balanceRes, transactionsRes] = await Promise.allSettled([
      agentId
        ? fetch(`${CLAWLANCER_BASE}/api/wallet/balance?agent_id=${agentId}`, { headers })
        : Promise.reject("no agent_id"),
      agentId
        ? fetch(`${CLAWLANCER_BASE}/api/transactions?agent_id=${agentId}`, { headers })
        : Promise.reject("no agent_id"),
    ]);

    // Parse balance
    let balance: any = null;
    if (balanceRes.status === "fulfilled" && balanceRes.value.ok) {
      balance = await balanceRes.value.json();
    }

    // Parse transactions
    let transactions: any = null;
    if (transactionsRes.status === "fulfilled" && transactionsRes.value.ok) {
      transactions = await transactionsRes.value.json();
    }

    // Total earned (lifetime)
    const totalEarnedWei = profile?.total_earned_wei ?? "0";
    const totalEarnedUsdc = Number(totalEarnedWei) / 1_000_000;

    // Balance
    const balanceUsdc = balance?.balance_usdc
      ? Number(balance.balance_usdc)
      : 0;

    // All transactions
    const allTxs: any[] =
      transactions?.transactions ?? profile?.recent_transactions ?? [];

    // Monthly earnings — sum RELEASED transactions from this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let monthlyEarned = 0;
    for (const tx of allTxs) {
      if (tx.state === "RELEASED" && tx.completed_at) {
        const completedDate = new Date(tx.completed_at);
        if (completedDate >= monthStart) {
          monthlyEarned += Number(tx.amount_wei ?? "0") / 1_000_000;
        }
      }
    }

    // Format transactions for frontend (most recent first, limit 20)
    const recentTransactions = allTxs.slice(0, 20).map((tx: any) => ({
      id: tx.id,
      state: tx.state,
      description: tx.description ?? tx.listing?.title ?? "Bounty",
      amount: (Number(tx.amount_wei ?? "0") / 1_000_000).toFixed(2),
      createdAt: tx.created_at,
      deliveredAt: tx.delivered_at,
      completedAt: tx.completed_at,
      buyer: tx.buyer?.name ?? null,
      seller: tx.seller?.name ?? null,
    }));

    return NextResponse.json({
      registered: true,
      vmId: vm.id,
      agentName: profile?.name ?? "Agent",
      agentId: agentId,
      walletAddress:
        profile?.wallet_address ?? balance?.wallet_address ?? null,
      reputationTier: profile?.reputation_tier ?? "NEW",
      transactionCount: profile?.transaction_count ?? 0,
      totalEarnedUsdc: totalEarnedUsdc.toFixed(2),
      monthlyEarnedUsdc: monthlyEarned.toFixed(2),
      balanceUsdc: balanceUsdc.toFixed(2),
      ethBalance: balance?.eth_balance ?? null,
      recentTransactions,
      botUsername: vm.telegram_bot_username,
      preferences: {
        autoClaim: prefs?.auto_claim ?? true,
        approvalThreshold: Number(prefs?.approval_threshold_usdc ?? 50),
      },
    });
  } catch (err) {
    logger.error("Clawlancer status error", {
      error: String(err),
      route: "clawlancer/status",
    });
    return NextResponse.json(
      { error: "Failed to fetch Clawlancer status" },
      { status: 500 }
    );
  }
}
