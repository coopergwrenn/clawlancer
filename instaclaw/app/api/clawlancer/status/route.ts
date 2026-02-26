import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CLAWLANCER_BASE = "https://clawlancer.ai";

interface ClawlancerConfig {
  api_key: string;
  base_url: string;
  agent_id: string;
  agent_name: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Fetch VM + preferences in parallel
    const [vmResult, prefsResult] = await Promise.all([
      supabase
        .from("instaclaw_vms")
        .select("id, ip_address, ssh_port, ssh_user, telegram_bot_username")
        .eq("assigned_to", session.user.id)
        .single(),
      // Preferences may not exist yet — that's fine
      supabase
        .from("instaclaw_clawlancer_preferences")
        .select("auto_claim, approval_threshold_usdc")
        .eq(
          "vm_id",
          // We need the vm_id but don't have it yet — we'll query after
          // For now just attempt with a subquery approach
          session.user.id
        )
        .limit(0), // placeholder, we'll query properly below
    ]);

    const vm = vmResult.data;
    if (!vm) {
      return NextResponse.json({ registered: false, error: "No VM assigned" });
    }

    // Now fetch preferences with actual vm_id
    const { data: prefs } = await supabase
      .from("instaclaw_clawlancer_preferences")
      .select("auto_claim, approval_threshold_usdc")
      .eq("vm_id", vm.id)
      .single();

    // SSH to VM and read Clawlancer config
    let config: ClawlancerConfig | null = null;
    try {
      const ssh = await connectSSH(vm as VMRecord);
      const result = await ssh.execCommand(
        "cat ~/.clawdbot/skills/clawlancer/config.json 2>/dev/null"
      );
      ssh.dispose();

      if (result.stdout && result.stdout.trim()) {
        config = JSON.parse(result.stdout.trim());
      }
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

    if (!config?.api_key || !config?.agent_id) {
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

    // Fetch profile + wallet balance + transactions in parallel
    const headers = { Authorization: `Bearer ${config.api_key}` };

    const [profileRes, balanceRes, transactionsRes] = await Promise.allSettled([
      fetch(`${CLAWLANCER_BASE}/api/agents/me`, { headers }),
      fetch(
        `${CLAWLANCER_BASE}/api/wallet/balance?agent_id=${config.agent_id}`,
        { headers }
      ),
      fetch(
        `${CLAWLANCER_BASE}/api/transactions?agent_id=${config.agent_id}`,
        { headers }
      ),
    ]);

    // Parse profile
    let profile: any = null;
    if (profileRes.status === "fulfilled" && profileRes.value.ok) {
      profile = await profileRes.value.json();
    }

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
      agentName: profile?.name ?? config.agent_name,
      agentId: config.agent_id,
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
