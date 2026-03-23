"use client";

import { MiniKit, Tokens, tokenToDecimals } from "@worldcoin/minikit-js";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Wallet,
  MessageCircle,
  Share2,
  Zap,
} from "lucide-react";

interface Agent {
  id: string;
  status: string;
  health_status: string;
  credit_balance: number;
  model: string;
  xmtp_address: string | null;
  telegram_bot_token: string | null;
  assigned_at: string;
  last_health_check: string;
}

interface Usage {
  message_count: number;
  heartbeat_count: number;
}

export default function AgentDashboard({
  agent,
  usage,
  walletAddress,
}: {
  agent: Agent;
  usage: Usage | null;
  walletAddress: string;
}) {
  const router = useRouter();
  const [showBanner, setShowBanner] = useState(true);
  const isPaused = agent.credit_balance <= 0;
  const isHealthy = agent.health_status === "healthy";

  async function handleChat() {
    if (agent.xmtp_address) {
      try {
        await MiniKit.commandsAsync.chat({
          message: "Hey! What's happening today?",
          to: [agent.xmtp_address],
        });
      } catch {
        // Fallback — stay on dashboard
      }
    }
  }

  async function handleStakeWld() {
    try {
      const res = await fetch("/api/delegate/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "try_it" }),
      });
      const { reference, tokenAmount } = await res.json();

      const payResult = await MiniKit.commandsAsync.pay({
        reference,
        to: process.env.NEXT_PUBLIC_RECIPIENT_ADDRESS!,
        tokens: [{ symbol: Tokens.WLD, token_amount: tokenAmount }],
        description: "Re-stake WLD for your InstaClaw agent",
      });

      if (payResult.finalPayload.status === "success") {
        await fetch("/api/delegate/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reference,
            transactionId: (payResult.finalPayload as Record<string, unknown>).transaction_id,
          }),
        });
        router.refresh();
      }
    } catch (err) {
      console.error("Stake error:", err);
    }
  }

  async function handleShare() {
    try {
      const appId = process.env.NEXT_PUBLIC_APP_ID;
      await MiniKit.commandsAsync.share({
        title: "InstaClaw - My AI Agent",
        text: "I got a free AI agent on World App! Get yours too.",
        url: `https://world.org/mini-app?app_id=${appId}`,
      });
    } catch {
      // Share cancelled
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 pb-6">
      {/* Credits exhausted banner */}
      {isPaused && (
        <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4">
          <p className="mb-3 text-sm font-semibold text-warning">
            Agent paused — credits ran out
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleStakeWld}
              className="flex-1 rounded-xl bg-wld py-2.5 text-sm font-bold text-black"
            >
              Stake 5 WLD
            </button>
            <button
              onClick={() =>
                window.open("https://instaclaw.io/billing", "_blank")
              }
              className="flex-1 rounded-xl border border-border py-2.5 text-sm font-semibold"
            >
              Subscribe
            </button>
          </div>
        </div>
      )}

      {/* Agent status card */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">Your Agent</h2>
          <span
            className={`flex items-center gap-1.5 text-xs font-medium ${
              isPaused
                ? "text-warning"
                : isHealthy
                  ? "text-success"
                  : "text-error"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                isPaused
                  ? "bg-warning"
                  : isHealthy
                    ? "bg-success"
                    : "bg-error"
              }`}
            />
            {isPaused ? "Paused" : isHealthy ? "Online" : "Offline"}
          </span>
        </div>

        {/* Credit balance */}
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-background p-3">
          <Zap size={18} className="text-accent" />
          <div className="flex-1">
            <p className="text-xs text-muted">Credits</p>
            <p className="text-lg font-bold">{agent.credit_balance}</p>
          </div>
          <button
            onClick={handleStakeWld}
            className="rounded-lg bg-card-hover px-3 py-1.5 text-xs font-medium"
          >
            + Add
          </button>
        </div>

        {/* Today's usage */}
        <div className="flex gap-3">
          <div className="flex-1 rounded-xl bg-background p-3">
            <div className="flex items-center gap-2">
              <MessageCircle size={14} className="text-muted" />
              <span className="text-xs text-muted">Messages</span>
            </div>
            <p className="mt-1 text-lg font-bold">
              {usage?.message_count ?? 0}
            </p>
          </div>
          <div className="flex-1 rounded-xl bg-background p-3">
            <div className="flex items-center gap-2">
              <Activity size={14} className="text-muted" />
              <span className="text-xs text-muted">Heartbeats</span>
            </div>
            <p className="mt-1 text-lg font-bold">
              {usage?.heartbeat_count ?? 0}
            </p>
          </div>
        </div>

        {/* Agent earnings */}
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-background p-3">
          <Wallet size={14} className="text-success" />
          <span className="text-xs text-muted">Agent earnings</span>
          <span className="ml-auto text-sm font-medium text-success">
            $0.00
          </span>
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex gap-3">
        <button
          onClick={handleChat}
          className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-bold text-black active:scale-[0.98] transition-transform"
        >
          <MessageCircle size={18} />
          Chat
        </button>
        <button
          onClick={handleShare}
          className="flex items-center justify-center gap-2 rounded-2xl border border-border px-5 py-3.5 font-semibold active:scale-[0.98] transition-transform"
        >
          <Share2 size={18} />
        </button>
      </div>

      {/* Post-onboarding discovery prompt */}
      {showBanner && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="mb-2 text-sm text-muted">
            Want more from your agent? Browse skills, connect Telegram,
            or visit instaclaw.io for the full dashboard.
          </p>
          <button
            onClick={() => setShowBanner(false)}
            className="text-xs text-muted underline"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
