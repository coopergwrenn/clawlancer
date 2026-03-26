"use client";

import { MiniKit, Tokens } from "@worldcoin/minikit-js";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Wallet,
  MessageCircle,
  Share2,
  Zap,
  TrendingUp,
} from "lucide-react";

interface Agent {
  id: string;
  status: string;
  health_status: string;
  credit_balance: number;
  default_model?: string;
  xmtp_address?: string | null;
  telegram_bot_token?: string | null;
  telegram_bot_username?: string | null;
  assigned_at?: string;
  last_health_check?: string;
  [key: string]: unknown; // allow extra fields from Supabase
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
  const [showDiscovery, setShowDiscovery] = useState(true);
  const isPaused = agent.credit_balance <= 0;
  const isHealthy = agent.health_status === "healthy";
  const creditPct = Math.min(100, (agent.credit_balance / 25) * 100);

  function handleChat() {
    router.push("/chat");
  }

  async function handleStakeWld() {
    MiniKit.commands.sendHapticFeedback({ hapticsType: "impact", style: "medium" });
    try {
      const res = await fetch("/api/delegate/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "try_it" }),
      });
      const { reference, tokenAmount } = await res.json();

      const recipientAddress = process.env.NEXT_PUBLIC_RECIPIENT_ADDRESS?.trim();
      if (!recipientAddress) {
        console.error("NEXT_PUBLIC_RECIPIENT_ADDRESS not configured");
        return;
      }

      const payResult = await MiniKit.commandsAsync.pay({
        reference,
        to: recipientAddress,
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
    } catch { /* share cancelled */ }
  }

  return (
    <div className="flex flex-col gap-4 p-4 pb-6">
      {/* ── Credits Exhausted Banner ── */}
      {isPaused && (
        <div className="animate-fade-in-up glass-card rounded-2xl border-warning/20 p-4" style={{ opacity: 0 }}>
          <div className="mb-3 flex items-center gap-2">
            <span className="status-dot-paused h-2 w-2 rounded-full" />
            <span className="text-sm font-semibold text-warning">
              Agent paused — credits ran out
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleStakeWld}
              className="btn-wld flex-1 rounded-xl py-2.5 text-sm font-bold"
            >
              Stake 25 WLD
            </button>
            <button
              onClick={() => window.open("https://instaclaw.io/billing", "_blank")}
              className="glass-button flex-1 rounded-xl py-2.5 text-sm font-semibold"
            >
              Subscribe
            </button>
          </div>
        </div>
      )}

      {/* ── Agent Status Card ── */}
      <div className="animate-fade-in-up glass-card rounded-2xl p-5 stagger-1" style={{ opacity: 0 }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold tracking-tight">Your Agent</h2>
          <div
            className={`status-badge flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium ${
              isPaused
                ? "border-warning/30 text-warning"
                : isHealthy
                  ? "border-success/30 text-success"
                  : "border-error/30 text-error"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isPaused
                  ? "status-dot-paused"
                  : isHealthy
                    ? "status-dot-healthy"
                    : "status-dot-error"
              }`}
            />
            {isPaused ? "Paused" : isHealthy ? "Online" : "Offline"}
          </div>
        </div>

        {/* Credit balance with progress bar */}
        <div className="mb-4 rounded-xl bg-white/[0.03] p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap size={16} className="text-accent" />
              <span className="text-xs font-medium text-muted">Credits</span>
            </div>
            <button
              onClick={handleStakeWld}
              className="glass-button rounded-lg px-3 py-1 text-[11px] font-semibold"
            >
              + Add
            </button>
          </div>
          <p className="mb-2 text-2xl font-bold">{agent.credit_balance}</p>
          <div className="progress-track">
            <div
              className={`progress-fill ${creditPct < 20 ? "progress-fill-low" : ""}`}
              style={{ width: `${creditPct}%` }}
            />
          </div>
        </div>

        {/* Today's stats */}
        <div className="flex gap-3">
          <div className="flex-1 rounded-xl bg-white/[0.03] p-3">
            <div className="mb-1 flex items-center gap-1.5">
              <MessageCircle size={12} className="text-muted" />
              <span className="text-[10px] font-medium tracking-wide text-muted">MESSAGES</span>
            </div>
            <p className="text-xl font-bold">{usage?.message_count ?? 0}</p>
          </div>
          <div className="flex-1 rounded-xl bg-white/[0.03] p-3">
            <div className="mb-1 flex items-center gap-1.5">
              <Activity size={12} className="text-muted" />
              <span className="text-[10px] font-medium tracking-wide text-muted">HEARTBEATS</span>
            </div>
            <p className="text-xl font-bold">{usage?.heartbeat_count ?? 0}</p>
          </div>
        </div>

        {/* Agent earnings */}
        <div className="mt-3 flex items-center gap-3 rounded-xl bg-white/[0.03] p-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success/10">
            <TrendingUp size={14} className="text-success" />
          </div>
          <div className="flex-1">
            <span className="text-[10px] font-medium tracking-wide text-muted">AGENT EARNINGS</span>
            <p className="text-sm font-bold text-success">$0.00</p>
          </div>
          <Wallet size={14} className="text-muted" />
        </div>
      </div>

      {/* ── Quick Actions ── */}
      <div className="animate-fade-in-up flex gap-3 stagger-2" style={{ opacity: 0 }}>
        <button
          onClick={handleChat}
          className="btn-primary flex flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 font-bold"
        >
          <MessageCircle size={18} />
          Chat
        </button>
        <button
          onClick={handleShare}
          className="glass-button flex items-center justify-center rounded-2xl px-5"
        >
          <Share2 size={18} />
        </button>
      </div>

      {/* ── Discovery Prompt ── */}
      {showDiscovery && (
        <div className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-3" style={{ opacity: 0 }}>
          <p className="mb-3 text-sm leading-relaxed text-muted">
            Want more from your agent? Browse skills or connect Telegram
            to chat with your agent from anywhere.
          </p>
          <div className="flex items-center justify-end">
            <button
              onClick={() => setShowDiscovery(false)}
              className="text-xs text-muted transition-colors hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
