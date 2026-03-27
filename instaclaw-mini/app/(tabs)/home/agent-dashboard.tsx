"use client";

import { MiniKit, Tokens } from "@worldcoin/minikit-js";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Wallet,
  MessageCircle,
  Share2,
  Zap,
  TrendingUp,
  Mail,
  Pencil,
} from "lucide-react";
import GoogleConnectCard from "@/components/google-connect-card";
import GooglePersonalizationModal from "@/components/google-personalization-modal";
import type { SubscriptionInfo } from "@/lib/supabase";

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
  gmailConnected: initialGmailConnected,
  subscription,
}: {
  agent: Agent;
  usage: Usage | null;
  walletAddress: string;
  gmailConnected: boolean;
  subscription: SubscriptionInfo;
}) {
  const router = useRouter();
  const [showDiscovery, setShowDiscovery] = useState(true);
  const [gmailConnected, setGmailConnected] = useState(initialGmailConnected);
  const [googleCardDismissed, setGoogleCardDismissed] = useState(false);
  const [showPersonalization, setShowPersonalization] = useState(false);
  const [waitingForOAuth, setWaitingForOAuth] = useState(false);
  const [waitingForSubscribe, setWaitingForSubscribe] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(subscription.hasSubscription);
  const [editingName, setEditingName] = useState(false);
  const [agentName, setAgentName] = useState<string>((agent as Record<string, unknown>).agent_name as string || "");
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Subscribers with daily limits aren't paused even at 0 credit_balance
  const isPaused = agent.credit_balance <= 0 && !isSubscribed;

  // Check session dismissal
  useEffect(() => {
    try {
      if (sessionStorage.getItem("google-card-dismissed")) setGoogleCardDismissed(true);
    } catch {}
  }, []);

  // Poll for Google connection when user returns from OAuth in external browser
  const checkGoogleStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/google/status");
      if (res.ok) {
        const data = await res.json();
        if (data.connected) {
          setGmailConnected(true);
          setWaitingForOAuth(false);
          // Trigger personalization modal
          setShowPersonalization(true);
          return true;
        }
      }
    } catch {}
    return false;
  }, []);

  // When waiting for OAuth, poll on visibility change (user returns to app)
  useEffect(() => {
    if (!waitingForOAuth) return;

    async function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        // Small delay to let the callback finish on instaclaw.io
        await new Promise((r) => setTimeout(r, 1500));
        const connected = await checkGoogleStatus();
        if (!connected) {
          // Try again after a bit more time
          setTimeout(checkGoogleStatus, 3000);
        }
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    // Also poll periodically while waiting
    const interval = setInterval(checkGoogleStatus, 5000);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInterval(interval);
    };
  }, [waitingForOAuth, checkGoogleStatus]);
  const isHealthy = agent.health_status === "healthy";
  const creditPct = Math.min(100, (agent.credit_balance / 25) * 100);

  function handleChat() {
    router.push("/chat");
  }

  async function handleAddCredits() {
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
        description: "Add credits to your InstaClaw agent",
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
      console.error("Payment error:", err);
    }
  }

  async function handleSubscribe() {
    try {
      const res = await fetch("/api/subscription/checkout-url?tier=starter");
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "_blank");
        setWaitingForSubscribe(true);
      }
    } catch {
      window.open("https://instaclaw.io/upgrade?from=mini-app", "_blank");
      setWaitingForSubscribe(true);
    }
  }

  // Poll for subscription when user returns from external browser
  useEffect(() => {
    if (!waitingForSubscribe) return;

    async function checkSubscription() {
      try {
        const res = await fetch("/api/subscription/status");
        if (res.ok) {
          const data = await res.json();
          if (data.hasSubscription) {
            setIsSubscribed(true);
            setWaitingForSubscribe(false);
            router.refresh();
          }
        }
      } catch {}
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        setTimeout(checkSubscription, 1500);
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    const interval = setInterval(checkSubscription, 5000);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInterval(interval);
    };
  }, [waitingForSubscribe, router]);

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
          <p className="text-[11px] text-muted mb-3">
            Add more with WLD (instant) or subscribe for daily credit refresh.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleAddCredits}
              className="btn-wld flex-1 rounded-xl py-2.5 text-sm font-bold"
            >
              Pay 25 WLD
            </button>
            <button
              onClick={handleSubscribe}
              className="glass-button flex-1 rounded-xl py-2.5 text-sm font-semibold"
            >
              From $29/mo
            </button>
          </div>
        </div>
      )}

      {/* ── Agent Status Card ── */}
      <div className="animate-fade-in-up glass-card rounded-2xl p-5 stagger-1" style={{ opacity: 0 }}>
        <div className="mb-4 flex items-center justify-between">
          {editingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value.slice(0, 40))}
              onBlur={async () => {
                setEditingName(false);
                try {
                  await fetch("/api/agent/name", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: agentName }),
                  });
                } catch {}
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="text-lg font-bold tracking-tight bg-transparent border-b border-accent/40 outline-none w-40"
              placeholder="Your Agent"
              autoFocus
            />
          ) : (
            <button
              onClick={() => {
                setEditingName(true);
                setTimeout(() => nameInputRef.current?.focus(), 50);
              }}
              className="flex items-center gap-1.5 group"
            >
              <h2 className="text-lg font-bold tracking-tight">{agentName || "Your Agent"}</h2>
              <Pencil size={12} className="text-muted opacity-0 group-hover:opacity-100 transition-opacity" style={{ opacity: 0.4 }} />
            </button>
          )}
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
        <div className="mb-4 glass-inner p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap size={16} className="text-accent" />
              <span className="text-xs font-medium text-muted">Credits</span>
            </div>
            <button
              onClick={handleAddCredits}
              className="glass-button rounded-lg px-3 py-1 text-[11px] font-semibold"
            >
              + Add
            </button>
          </div>

          {isSubscribed ? (
            <>
              {/* Subscriber: show daily limit usage */}
              <div className="flex items-baseline gap-2 mb-1">
                <p className="text-2xl font-bold">{Math.round(subscription.dailyUsed)}</p>
                <p className="text-sm text-muted">/ {subscription.dailyLimit}</p>
              </div>
              <p className="text-[10px] text-muted mb-2">
                Daily usage ({subscription.tier} plan) — resets at midnight
              </p>
              <div className="progress-track">
                <div
                  className={`progress-fill ${subscription.dailyUsed / subscription.dailyLimit > 0.8 ? "progress-fill-low" : ""}`}
                  style={{ width: `${Math.min(100, (subscription.dailyUsed / subscription.dailyLimit) * 100)}%` }}
                />
              </div>
              {agent.credit_balance > 0 && (
                <p className="text-[10px] text-muted mt-2">
                  + {agent.credit_balance} overflow credits
                </p>
              )}
            </>
          ) : (
            <>
              {/* WLD user: show credit balance */}
              <p className="mb-2 text-2xl font-bold">{agent.credit_balance}</p>
              <div className="progress-track">
                <div
                  className={`progress-fill ${creditPct < 20 ? "progress-fill-low" : ""}`}
                  style={{ width: `${creditPct}%` }}
                />
              </div>
            </>
          )}
        </div>

        {/* Low credit warning for WLD users */}
        {!subscription.hasSubscription && agent.credit_balance > 0 && creditPct < 20 && (
          <div className="rounded-xl p-3 mb-1" style={{ background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.15)" }}>
            <p className="text-[11px]" style={{ color: "#ca8a04" }}>
              Credits running low. Top up with WLD or subscribe for daily credit refresh.
            </p>
          </div>
        )}

        {/* Today's stats */}
        <div className="flex gap-3">
          <div className="flex-1 glass-inner p-3">
            <div className="mb-1 flex items-center gap-1.5">
              <MessageCircle size={12} className="text-muted" />
              <span className="text-[10px] font-medium tracking-wide text-muted">MESSAGES</span>
            </div>
            <p className="text-xl font-bold">{usage?.message_count ?? 0}</p>
          </div>
          <div className="flex-1 glass-inner p-3">
            <div className="mb-1 flex items-center gap-1.5">
              <Activity size={12} className="text-muted" />
              <span className="text-[10px] font-medium tracking-wide text-muted">HEARTBEATS</span>
            </div>
            <p className="text-xl font-bold">{usage?.heartbeat_count ?? 0}</p>
          </div>
        </div>

        {/* Agent earnings */}
        <div className="mt-3 flex items-center gap-3 glass-inner p-3">
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

      {/* ── Google Connection Status ── */}
      {gmailConnected ? (
        <div className="animate-fade-in-up glass-card flex items-center gap-3 rounded-2xl p-4" style={{ opacity: 0 }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: "rgba(34,197,94,0.1)" }}>
            <Mail size={16} style={{ color: "#22c55e" }} />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">Google connected</p>
            <p className="text-[10px]" style={{ color: "#888" }}>Personalized suggestions active</p>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        </div>
      ) : !googleCardDismissed ? (
        <GoogleConnectCard
          variant="home"
          onConnectStart={() => setWaitingForOAuth(true)}
          onDismiss={() => {
            setGoogleCardDismissed(true);
            try { sessionStorage.setItem("google-card-dismissed", "1"); } catch {}
          }}
        />
      ) : null}

      {/* Waiting indicator */}
      {waitingForOAuth && !gmailConnected && (
        <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "rgba(220,103,67,0.3)", borderTopColor: "transparent" }} />
            <p className="text-xs text-muted">Waiting for Google connection... Come back after completing OAuth.</p>
          </div>
        </div>
      )}

      {/* ── Discovery / Upgrade Prompt ── */}
      {showDiscovery && (
        <div className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-3" style={{ opacity: 0 }}>
          {isSubscribed ? (
            <p className="mb-3 text-sm leading-relaxed text-muted">
              {subscription.tier?.charAt(0).toUpperCase()}{subscription.tier?.slice(1)} plan active.
              Manage your subscription or browse skills on instaclaw.io.
            </p>
          ) : (
            <p className="mb-3 text-sm leading-relaxed text-muted">
              Want daily credit refresh and the full dashboard? Plans start at $29/mo.
            </p>
          )}
          <div className="flex items-center justify-between">
            {!isSubscribed && (
              <button
                onClick={handleSubscribe}
                className="text-xs font-medium transition-colors"
                style={{ color: "#DC6743" }}
              >
                View plans
              </button>
            )}
            <button
              onClick={() => setShowDiscovery(false)}
              className="text-xs text-muted transition-colors hover:text-foreground ml-auto"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* ── Personalization Modal ── */}
      {showPersonalization && (
        <GooglePersonalizationModal
          onDone={() => {
            setShowPersonalization(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
