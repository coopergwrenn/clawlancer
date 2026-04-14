"use client";

import { MiniKit, Tokens } from "@worldcoin/minikit-js";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import AgentBookCard from "@/components/agentbook-card";
import AgentBookOnboardModal from "@/components/agentbook-onboard-modal";
import BankrTokenizeCard from "@/components/bankr-tokenize-card";
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
  const searchParams = useSearchParams();
  const [showDiscovery, setShowDiscovery] = useState(true);
  const [gmailConnected, setGmailConnected] = useState(initialGmailConnected);
  const [googleCardDismissed, setGoogleCardDismissed] = useState(false);
  const [showPersonalization, setShowPersonalization] = useState(false);
  const [waitingForOAuth, setWaitingForOAuth] = useState(false);

  // Detect return from Google OAuth via URL parameter
  useEffect(() => {
    const gmailParam = searchParams.get("gmail");
    const gmailError = searchParams.get("gmail_error");
    if (gmailParam === "connected") {
      // Returned from OAuth — check status and show personalization modal
      (async () => {
        try {
          const res = await fetch("/api/google/status");
          if (res.ok) {
            const data = await res.json();
            if (data.connected) {
              setGmailConnected(true);
              setShowPersonalization(true);
            }
          }
        } catch {}
      })();
      // Clean URL without full reload
      window.history.replaceState({}, "", "/home");
    } else if (gmailError) {
      // OAuth failed — could show a toast here
      console.error("[Home] Gmail OAuth error:", gmailError);
      window.history.replaceState({}, "", "/home");
    }
  }, [searchParams]);
  const [waitingForSubscribe, setWaitingForSubscribe] = useState(false);
  const [paymentProcessing, setPaymentProcessing] = useState(false);
  const [paymentPending, setPaymentPending] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(subscription.hasSubscription);
  const [editingName, setEditingName] = useState(false);
  const [agentName, setAgentName] = useState<string>((agent as Record<string, unknown>).agent_name as string || "");
  const [showAgentBookModal, setShowAgentBookModal] = useState(true);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Subscribers with daily limits aren't paused even at 0 credit_balance
  const isPaused = agent.credit_balance <= 0 && !isSubscribed;
  const isHibernating = agent.health_status === "hibernating";

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
    if (paymentProcessing) return; // Prevent duplicate submissions
    MiniKit.commands.sendHapticFeedback({ hapticsType: "impact", style: "medium" });
    setPaymentProcessing(true);
    setPaymentPending(false);

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
        setPaymentProcessing(false);
        return;
      }

      const payResult = await MiniKit.commandsAsync.pay({
        reference,
        to: recipientAddress,
        tokens: [{ symbol: Tokens.WLD, token_amount: tokenAmount }],
        description: "Add credits to your InstaClaw agent",
      });

      if (payResult.finalPayload.status === "success") {
        const confirmRes = await fetch("/api/delegate/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reference,
            transactionId: (payResult.finalPayload as Record<string, unknown>).transaction_id,
          }),
        });
        const confirmData = await confirmRes.json();

        if (confirmData.success) {
          // Credits added immediately
          setPaymentProcessing(false);
          router.refresh();
        } else if (confirmData.pending) {
          // Transaction still confirming on-chain — poll for confirmation
          setPaymentPending(true);
          const maxPolls = 20; // 60 seconds total
          for (let i = 0; i < maxPolls; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            try {
              const statusRes = await fetch(`/api/delegate/status?reference=${reference}`);
              const statusData = await statusRes.json();
              if (statusData.confirmed) {
                setPaymentPending(false);
                setPaymentProcessing(false);
                router.refresh();
                return;
              }
              if (statusData.status === "failed" || statusData.status === "amount_mismatch") {
                setPaymentPending(false);
                setPaymentProcessing(false);
                return;
              }
            } catch { /* keep polling */ }
          }
          // Still pending after 60s — tell user it'll arrive
          setPaymentPending(false);
          setPaymentProcessing(false);
        } else {
          // Error from confirm
          setPaymentProcessing(false);
        }
      } else {
        // User cancelled or payment failed in World App
        setPaymentProcessing(false);
      }
    } catch (err) {
      console.error("Payment error:", err);
      setPaymentProcessing(false);
      setPaymentPending(false);
    }
  }

  async function handleSubscribe() {
    try {
      const res = await fetch("/api/subscription/checkout-url?tier=starter");
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        window.location.href = "https://instaclaw.io/upgrade?from=mini-app";
      }
    } catch {
      window.location.href = "https://instaclaw.io/upgrade?from=mini-app";
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
      {/* ── AgentBook Registration Modal (shown once on first load) ── */}
      {showAgentBookModal && (
        <AgentBookOnboardModal onComplete={() => setShowAgentBookModal(false)} />
      )}

      {/* ── Hibernation Banner ── */}
      {isHibernating && (
        <div className="animate-fade-in-up glass-card rounded-2xl p-5" style={{ opacity: 0, border: "1px solid rgba(139,92,246,0.15)" }}>
          <div className="flex flex-col items-center text-center gap-3">
            <div style={{
              width: 56, height: 56, borderRadius: 16,
              background: "linear-gradient(135deg, rgba(139,92,246,0.12), rgba(139,92,246,0.04))",
              border: "1px solid rgba(139,92,246,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28,
            }}>
              <span>&#x1F4A4;</span>
            </div>
            <div>
              <p className="text-base font-bold mb-1">Your agent is sleeping</p>
              <p className="text-[12px]" style={{ color: "#888", lineHeight: 1.6 }}>
                It ran out of credits and is taking a nap. Add credits to wake it up instantly — all your data is safe.
              </p>
            </div>
            <button
              onClick={handleAddCredits}
              disabled={paymentProcessing}
              className="w-full rounded-xl py-3 text-sm font-bold transition-all active:scale-[0.97] disabled:opacity-50"
              style={{
                background: "linear-gradient(170deg, #8b5cf6, #7c3aed)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.12)",
                boxShadow: "0 4px 16px rgba(139,92,246,0.35), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
            >
              {paymentPending ? "Confirming..." : paymentProcessing ? "Processing..." : "Wake up — 25 WLD"}
            </button>
            <button
              onClick={handleSubscribe}
              className="text-[12px] font-medium"
              style={{ color: "#8b5cf6", background: "none", border: "none" }}
            >
              Or subscribe for $29/mo
            </button>
          </div>
        </div>
      )}

      {/* ── Credits Exhausted Banner ── */}
      {isPaused && !isHibernating && (
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
              disabled={paymentProcessing}
              className="btn-wld flex-1 rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
            >
              {paymentPending ? "Confirming..." : paymentProcessing ? "Processing..." : "Pay 25 WLD"}
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
            className="status-badge flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium"
            style={{
              color: isPaused ? "#eab308" : isHealthy ? "#22c55e" : "#ef4444",
              background: isPaused
                ? "rgba(234,179,8,0.08)"
                : isHealthy
                  ? "rgba(34,197,94,0.08)"
                  : "rgba(239,68,68,0.08)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: "1px solid",
              borderColor: isPaused
                ? "rgba(234,179,8,0.15)"
                : isHealthy
                  ? "rgba(34,197,94,0.15)"
                  : "rgba(239,68,68,0.15)",
              boxShadow: "0 1px 4px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.04)",
            }}
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
              <div className="relative flex h-7 w-7 items-center justify-center rounded-full overflow-hidden" style={{ background: "radial-gradient(circle at 35% 30%, rgba(218,119,86,0.7), rgba(218,119,86,0.3) 50%, rgba(180,70,40,0.6) 100%)", boxShadow: "0 2px 8px rgba(218,119,86,0.35), inset 0 1px 2px rgba(255,255,255,0.2)" }}>
                <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)" }} />
                <Zap size={13} className="relative z-10" style={{ color: "#fff" }} />
              </div>
              <span className="text-xs font-medium text-muted">Credits</span>
            </div>
            <button
              onClick={handleAddCredits}
              disabled={paymentProcessing}
              className="glass-button rounded-lg px-3 py-1 text-[11px] font-semibold disabled:opacity-50"
            >
              {paymentProcessing ? "..." : "+ Add"}
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
          <div className="relative flex h-8 w-8 items-center justify-center rounded-full overflow-hidden" style={{ background: "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.7), rgba(34,197,94,0.3) 50%, rgba(22,163,74,0.6) 100%)", boxShadow: "0 2px 8px rgba(34,197,94,0.3), inset 0 1px 2px rgba(255,255,255,0.2)" }}>
            <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)" }} />
            <TrendingUp size={14} className="relative z-10" style={{ color: "#fff" }} />
          </div>
          <div className="flex-1">
            <span className="text-[10px] font-medium tracking-wide text-muted">AGENT EARNINGS</span>
            <p className="text-sm font-bold text-success">$0.00</p>
          </div>
          <Wallet size={14} className="text-muted" />
        </div>
      </div>

      {/* ── Bankr Tokenization ── */}
      <BankrTokenizeCard
        walletId={(agent.bankr_wallet_id as string) ?? null}
        evmAddress={(agent.bankr_evm_address as string) ?? null}
        tokenAddress={(agent.bankr_token_address as string) ?? null}
        tokenSymbol={(agent.bankr_token_symbol as string) ?? null}
        tokenizationPlatform={(agent.tokenization_platform as string) ?? null}
      />

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

      {/* ── AgentBook Registration (before Google so both visible on first load) ── */}
      <AgentBookCard />

      {/* ── Google Connection Status ── */}
      {gmailConnected ? (
        <div className="animate-fade-in-up glass-card flex items-center gap-3 rounded-2xl p-4" style={{ opacity: 0 }}>
          <div className="relative flex h-8 w-8 items-center justify-center rounded-full overflow-hidden" style={{ background: "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.7), rgba(34,197,94,0.3) 50%, rgba(22,163,74,0.6) 100%)", boxShadow: "0 2px 8px rgba(34,197,94,0.3), inset 0 1px 2px rgba(255,255,255,0.2)" }}>
            <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)" }} />
            <svg className="relative z-10" width={14} height={14} viewBox="0 0 24 24" fill="none">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09A6.97 6.97 0 0 1 5.47 12c0-.72.13-1.43.37-2.09V7.07H2.18A11.96 11.96 0 0 0 .96 12c0 1.94.46 3.77 1.22 5.33l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.09 14.97 0 12 0 7.7 0 3.99 2.47 2.18 6.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
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
            <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "rgba(218,119,86,0.3)", borderTopColor: "transparent" }} />
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
                style={{ color: "#da7756" }}
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
