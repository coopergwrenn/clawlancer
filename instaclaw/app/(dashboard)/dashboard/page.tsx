"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  ExternalLink,
  RefreshCw,
  Send,
  Activity,
  Server,
  Calendar,
  Cpu,
  CreditCard,
  AlertTriangle,
  Zap,
  Eraser,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { WorldIDBanner } from "@/components/dashboard/world-id-banner";
import { GmailConnectPopup } from "@/components/dashboard/gmail-connect-popup";

const MODEL_OPTIONS = [
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-5-20250820", label: "Claude Opus 4.5" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
];

const CREDIT_PACKS = [
  { id: "50", credits: 50, price: "$5" },
  { id: "200", credits: 200, price: "$15" },
  { id: "500", credits: 500, price: "$30" },
];

interface VMStatus {
  status: string;
  vm?: {
    gatewayUrl: string;
    controlUiUrl: string;
    healthStatus: string;
    lastHealthCheck: string;
    assignedAt: string;
    telegramBotUsername: string | null;
    model: string | null;
    apiMode: string | null;
    channelsEnabled: string[];
    hasDiscord: boolean;
    hasBraveSearch: boolean;
    agdpEnabled: boolean;
    gmailConnected: boolean;
    gmailPopupDismissed: boolean;
  };
  billing?: {
    tier: string;
    tierName: string;
    apiMode: string;
    price: number | null;
    status: string;
    paymentStatus: string;
    renewalDate: string | null;
    trialEndsAt: string | null;
  };
}

interface UsageData {
  today: number;
  week: number;
  month: number;
  dailyLimit: number;
  creditBalance: number;
}

export default function DashboardPage() {
  const [vmStatus, setVmStatus] = useState<VMStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [modelSuccess, setModelSuccess] = useState(false);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);
  const [showCreditPacks, setShowCreditPacks] = useState(false);
  const [creditsPurchased, setCreditsPurchased] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(true);
  const [togglingAgdp, setTogglingAgdp] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetToast, setResetToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const creditPackRef = useRef<HTMLDivElement>(null);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/vm/status");
      const data = await res.json();
      setVmStatus(data);
    } catch {
      // Silently handle
    }
  }

  async function fetchUsage() {
    try {
      const res = await fetch("/api/vm/usage");
      const data = await res.json();
      setUsage(data);
    } catch {
      // Silently handle
    }
  }

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    fetchUsage();
    return () => clearInterval(interval);
  }, []);

  // Auto-expand credit packs when ?buy=credits is in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("buy") === "credits") {
      setShowCreditPacks(true);
      setTimeout(() => {
        creditPackRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 300);
    }
    if (params.get("credits") === "purchased") {
      setCreditsPurchased(true);
      fetchUsage(); // Refresh to show new balance
      setTimeout(() => setCreditsPurchased(false), 5000);
      // Clean URL without reload
      window.history.replaceState({}, "", "/dashboard");
    }
  }, []);

  // Auto-expand credit packs when at daily limit with 0 credits
  useEffect(() => {
    if (usage && usage.today >= usage.dailyLimit && usage.creditBalance <= 0) {
      setShowCreditPacks(true);
    }
  }, [usage]);

  // Show welcome card on first visit
  useEffect(() => {
    if (!localStorage.getItem("instaclaw_welcome_dismissed")) {
      setWelcomeDismissed(false);
    }
  }, []);

  async function handleRestart() {
    setRestarting(true);
    try {
      await fetch("/api/vm/restart", { method: "POST" });
      setTimeout(fetchStatus, 3000);
    } finally {
      setRestarting(false);
    }
  }

  async function handleModelChange(newModel: string) {
    setUpdatingModel(true);
    setModelSuccess(false);
    try {
      const res = await fetch("/api/vm/update-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newModel }),
      });
      if (res.ok) {
        setModelSuccess(true);
        setTimeout(() => setModelSuccess(false), 3000);
        fetchStatus();
      }
    } finally {
      setUpdatingModel(false);
    }
  }

  async function handleBuyCredits(pack: string) {
    setBuyingPack(pack);
    try {
      const res = await fetch("/api/billing/credit-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } finally {
      setBuyingPack(null);
    }
  }

  function dismissWelcome() {
    setWelcomeDismissed(true);
    localStorage.setItem("instaclaw_welcome_dismissed", "1");
  }

  async function handleToggleAgdp() {
    if (!vm || togglingAgdp) return;
    const newState = !vm.agdpEnabled;
    setTogglingAgdp(true);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle_agdp", enabled: newState }),
      });
      if (res.ok) {
        fetchStatus();
      }
    } finally {
      setTogglingAgdp(false);
    }
  }

  async function handleResetAgent() {
    setShowResetConfirm(false);
    setResetting(true);
    try {
      const res = await fetch("/api/vm/reset-agent", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setResetToast({ message: `Memory reset — ${data.filesDeleted} files cleared`, type: "success" });
        setTimeout(fetchStatus, 3000);
      } else {
        setResetToast({ message: data.error || data.message || "Reset failed", type: "error" });
      }
    } catch {
      setResetToast({ message: "Network error — could not reach server", type: "error" });
    } finally {
      setResetting(false);
      setTimeout(() => setResetToast(null), 4000);
    }
  }

  const vm = vmStatus?.vm;
  const billing = vmStatus?.billing;
  const healthColor =
    vm?.healthStatus === "healthy"
      ? "var(--success)"
      : vm?.healthStatus === "unhealthy"
      ? "var(--error)"
      : "var(--muted)";

  // Trial days remaining
  const trialDaysLeft = billing?.trialEndsAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(billing.trialEndsAt).getTime() - Date.now()) /
            (1000 * 60 * 60 * 24)
        )
      )
    : null;

  const usagePct = usage ? Math.min(100, (usage.today / usage.dailyLimit) * 100) : 0;
  const usageBarColor = usagePct >= 90 ? "#ef4444" : usagePct >= 70 ? "#f59e0b" : "var(--success)";

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>
          Dashboard
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Manage your OpenClaw instance.
        </p>
      </div>

      {/* Welcome card (first visit only) */}
      {!welcomeDismissed && vmStatus?.status === "assigned" && (
        <div
          className="glass rounded-xl p-6 relative"
          style={{ border: "1px solid var(--border)" }}
        >
          <button
            onClick={dismissWelcome}
            className="absolute top-4 right-4 w-6 h-6 flex items-center justify-center rounded-full cursor-pointer"
            style={{ color: "var(--muted)", background: "rgba(0,0,0,0.04)" }}
          >
            <span className="text-sm leading-none">&times;</span>
          </button>
          <h2 className="text-lg font-semibold mb-2">Welcome to InstaClaw!</h2>
          <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
            Your AI agent is live on a dedicated server. Here&apos;s what to know:
          </p>
          <div className="space-y-2 text-sm" style={{ color: "var(--muted)" }}>
            <p><strong style={{ color: "var(--foreground)" }}>Daily units</strong> — Your plan includes a daily unit allowance that resets at midnight UTC. Haiku costs 1 unit, Sonnet 4, Opus 19. Background tasks don&apos;t count against your limit.</p>
            <p><strong style={{ color: "var(--foreground)" }}>Switch models anytime</strong> — Just tell your bot &quot;use Sonnet&quot; or &quot;switch to Opus&quot; in chat.</p>
            <p><strong style={{ color: "var(--foreground)" }}>Credit packs</strong> — Need more after your daily limit? Buy credits below — they kick in instantly.</p>
          </div>
        </div>
      )}

      {/* Credits purchased success banner */}
      {creditsPurchased && (
        <div
          className="rounded-xl p-4 flex items-center gap-3 transition-snappy"
          style={{
            background: "rgba(22,163,74,0.08)",
            border: "1px solid rgba(22,163,74,0.2)",
          }}
        >
          <Zap className="w-5 h-5 shrink-0" style={{ color: "var(--success)" }} />
          <p className="text-sm font-medium" style={{ color: "var(--success)" }}>
            Credits added! They&apos;re ready to use now.
          </p>
        </div>
      )}

      {/* Payment past_due banner */}
      {billing?.paymentStatus === "past_due" && (
        <div
          className="rounded-xl p-5 flex items-center gap-4 transition-snappy"
          style={{
            background: "rgba(220,38,38,0.08)",
            border: "1px solid rgba(220,38,38,0.2)",
          }}
        >
          <AlertTriangle className="w-5 h-5 shrink-0" style={{ color: "#ef4444" }} />
          <div className="flex-1">
            <p className="text-sm font-semibold" style={{ color: "#ef4444" }}>
              Payment Failed
            </p>
            <p className="text-xs" style={{ color: "rgba(239,68,68,0.7)" }}>
              Please update your payment method to keep your instance running.
            </p>
          </div>
          <Link
            href="/billing"
            className="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0"
            style={{ background: "#ef4444", color: "#fff" }}
          >
            Fix Payment
          </Link>
        </div>
      )}

      {/* Trial banner */}
      {trialDaysLeft !== null && billing?.status === "trialing" && (
        <div
          className="rounded-xl p-5 flex items-center gap-4 transition-snappy"
          style={{
            background: "rgba(59,130,246,0.08)",
            border: "1px solid rgba(59,130,246,0.2)",
          }}
        >
          <CreditCard className="w-5 h-5 shrink-0" style={{ color: "#3b82f6" }} />
          <div className="flex-1">
            <p className="text-sm font-semibold" style={{ color: "#3b82f6" }}>
              Free Trial: {trialDaysLeft} day{trialDaysLeft !== 1 ? "s" : ""} remaining
            </p>
            <p className="text-xs" style={{ color: "rgba(59,130,246,0.7)" }}>
              Your trial will automatically convert to a paid plan.
            </p>
          </div>
          <Link
            href="/billing"
            className="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0"
            style={{ background: "rgba(59,130,246,0.15)", color: "#3b82f6" }}
          >
            Manage
          </Link>
        </div>
      )}

      {/* World ID nudge banner */}
      <div data-tour="dash-verify">
        <WorldIDBanner />
      </div>

      {vmStatus?.status === "assigned" && vm ? (
        <>
          {/* ── Usage + Credits (merged card, all-inclusive only) ── */}
          {usage && vm.apiMode === "all_inclusive" && (
            <div data-tour="dash-usage" className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium" style={{ color: "var(--muted)" }}>
                  Today&apos;s Usage
                </span>
                {billing && (
                  <span
                    className="px-2 py-0.5 rounded-full text-xs font-medium"
                    style={{
                      background: "rgba(0,0,0,0.04)",
                      border: "1px solid var(--border)",
                      color: "var(--muted)",
                    }}
                  >
                    {billing.tierName}
                  </span>
                )}
              </div>

              {/* Usage fraction */}
              <div className="flex items-baseline gap-1.5 mb-3">
                <span
                  className="text-3xl font-semibold tracking-tight"
                  style={usagePct >= 100 ? { color: "#ef4444" } : undefined}
                >
                  {usage.today}
                </span>
                <span className="text-lg" style={{ color: "var(--muted)" }}>/</span>
                <span className="text-lg" style={{ color: "var(--muted)" }}>{usage.dailyLimit}</span>
                <span className="text-sm ml-1" style={{ color: "var(--muted)" }}>units used</span>
              </div>

              {/* Progress bar */}
              <div
                className="h-2 rounded-full overflow-hidden mb-4"
                style={{ background: "rgba(0,0,0,0.06)" }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${usagePct}%`,
                    background: usageBarColor,
                    transition: "width 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
                  }}
                />
              </div>

              {/* Week / Month stats */}
              <div className="flex gap-6 mb-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: "var(--muted)" }}>7d</span>
                  <span className="text-sm font-semibold">{usage.week}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: "var(--muted)" }}>30d</span>
                  <span className="text-sm font-semibold">{usage.month}</span>
                </div>
              </div>

              {/* At-limit banner */}
              {usage.today >= usage.dailyLimit && usage.creditBalance <= 0 && (
                <div
                  className="mt-4 rounded-lg p-3 text-center"
                  style={{
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.2)",
                  }}
                >
                  <p className="text-sm font-semibold" style={{ color: "#ef4444" }}>
                    Daily limit reached
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "rgba(239,68,68,0.7)" }}>
                    Buy credits to keep chatting — they kick in instantly.
                  </p>
                </div>
              )}

              {/* ── Credit balance row (inside usage card) ── */}
              <div
                data-tour="dash-credits"
                className="flex items-center justify-between mt-5 pt-5"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <div className="flex items-center gap-3">
                  <Zap className="w-4 h-4" style={{ color: "var(--accent)" }} />
                  <div>
                    <span className="text-sm font-semibold">{usage.creditBalance} credits</span>
                    <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>
                      {usage.creditBalance > 0 ? "available after daily limit" : "none remaining"}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setShowCreditPacks(!showCreditPacks);
                    if (!showCreditPacks) {
                      setTimeout(() => {
                        creditPackRef.current?.scrollIntoView({
                          behavior: "smooth",
                          block: "center",
                        });
                      }, 100);
                    }
                  }}
                  className="px-5 py-2.5 rounded-full text-sm font-semibold transition-all cursor-pointer shrink-0 active:scale-95"
                  style={{
                    background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                    color: "#fff",
                    boxShadow: "0 0 0 1px rgba(249,115,22,0.3), 0 2px 8px rgba(249,115,22,0.25), inset 0 1px 0 rgba(255,255,255,0.2)",
                    backdropFilter: "blur(8px)",
                    textShadow: "0 1px 2px rgba(0,0,0,0.15)",
                  }}
                >
                  <Zap className="w-3.5 h-3.5 inline -mt-px mr-1" fill="currentColor" />
                  Buy Credits
                </button>
              </div>
            </div>
          )}

          {/* ── Plan ── */}
          {usage && vm.apiMode === "all_inclusive" ? (
            billing && (
              <div data-tour="dash-plan" className="glass rounded-xl p-5" style={{ border: "1px solid var(--border)" }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CreditCard className="w-4 h-4" style={{ color: "var(--muted)" }} />
                    <div>
                      <span className="text-sm font-bold">{billing.tierName}</span>
                      <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>
                        {billing.apiMode === "byok" ? "BYOK" : "All-Inclusive"}
                        {billing.price !== null && <> &middot; ${billing.price}/mo</>}
                        {billing.renewalDate && (
                          <> &middot; Renews {new Date(billing.renewalDate).toLocaleDateString()}</>
                        )}
                      </span>
                    </div>
                  </div>
                  <Link
                    href="/billing"
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0"
                    style={{
                      background: "rgba(0,0,0,0.04)",
                      color: "var(--muted)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    Manage
                  </Link>
                </div>
              </div>
            )
          ) : (
            billing && (
              <div data-tour="dash-plan" className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
                <div className="flex items-center gap-2 mb-3">
                  <CreditCard className="w-4 h-4" style={{ color: "var(--muted)" }} />
                  <span className="text-sm font-medium">Plan</span>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-lg font-bold">
                      {billing.tierName}{" "}
                      <span className="text-sm font-normal" style={{ color: "var(--muted)" }}>
                        {billing.apiMode === "byok" ? "BYOK" : "All-Inclusive"}
                      </span>
                    </p>
                    {billing.price !== null && (
                      <p className="text-sm" style={{ color: "var(--muted)" }}>
                        ${billing.price}/mo
                        {billing.renewalDate && (
                          <> &mdash; Renews {new Date(billing.renewalDate).toLocaleDateString()}</>
                        )}
                      </p>
                    )}
                  </div>
                  <Link
                    href="/billing"
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    style={{
                      background: "rgba(0,0,0,0.04)",
                      color: "var(--muted)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    Manage
                  </Link>
                </div>
              </div>
            )
          )}

          {/* ── Credit Pack Selector ── */}
          {showCreditPacks && vm.apiMode === "all_inclusive" && (
            <div
              ref={creditPackRef}
              className="glass rounded-xl p-6"
              style={{ border: "1px solid var(--border)" }}
            >
              <p className="text-sm font-medium mb-4">Credit Packs</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {CREDIT_PACKS.map((pack) => (
                  <button
                    key={pack.id}
                    onClick={() => handleBuyCredits(pack.id)}
                    disabled={buyingPack !== null}
                    className="glass rounded-lg p-4 text-left cursor-pointer transition-all hover:border-white/30 disabled:opacity-50"
                    style={{ border: "1px solid var(--border)" }}
                  >
                    <p className="text-2xl font-bold">{pack.credits}</p>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      message units
                    </p>
                    <p className="text-sm font-semibold mt-2" style={{ color: "#3b82f6" }}>
                      {buyingPack === pack.id ? "Redirecting..." : pack.price}
                    </p>
                  </button>
                ))}
              </div>
              <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
                Credits never expire and are used automatically after your daily limit is reached.
              </p>
            </div>
          )}

          {/* ── Instance Status ── */}
          <div data-tour="dash-status" className="grid gap-5 sm:grid-cols-3">
            <div className="glass rounded-xl p-6">
              <div className="flex items-center gap-2 mb-2">
                <Activity className="w-4 h-4" style={{ color: healthColor }} />
                <span className="text-sm font-medium">Status</span>
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: healthColor }}
                />
                <span className="text-lg font-bold capitalize">
                  {vm.healthStatus}
                </span>
              </div>
            </div>

            <div className="glass rounded-xl p-6">
              <div className="flex items-center gap-2 mb-2">
                <Server className="w-4 h-4" style={{ color: "var(--muted)" }} />
                <span className="text-sm font-medium">Instance</span>
              </div>
              <span
                className="text-sm font-mono"
                style={{ color: "var(--muted)" }}
              >
                {vm.gatewayUrl || "Configuring..."}
              </span>
            </div>

            <div className="glass rounded-xl p-6">
              <div className="flex items-center gap-2 mb-2">
                <Calendar
                  className="w-4 h-4"
                  style={{ color: "var(--muted)" }}
                />
                <span className="text-sm font-medium">Active Since</span>
              </div>
              <span
                className="text-sm"
                style={{ color: "var(--muted)" }}
              >
                {vm.assignedAt
                  ? new Date(vm.assignedAt).toLocaleDateString()
                  : "\u2014"}
              </span>
            </div>
          </div>

          {/* Quick Actions */}
          <div data-tour="dash-pro-tip">
            <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5" style={{ fontFamily: "var(--font-serif)" }}>
              Quick Actions
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {vm.controlUiUrl && (
                <a
                  href={vm.controlUiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="glass rounded-xl p-4 flex items-center gap-3 transition-all hover:border-white/30"
                  style={{ border: "1px solid var(--border)" }}
                >
                  <ExternalLink className="w-5 h-5" style={{ color: "#333334" }} />
                  <div>
                    <p className="text-sm font-semibold">Control Panel</p>
                    <p
                      className="text-xs"
                      style={{ color: "var(--muted)" }}
                    >
                      Open OpenClaw UI
                    </p>
                  </div>
                </a>
              )}

              {vm.telegramBotUsername && (
                <a
                  href={`https://t.me/${vm.telegramBotUsername}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="glass rounded-xl p-4 flex items-center gap-3 transition-all hover:border-white/30"
                  style={{ border: "1px solid var(--border)" }}
                >
                  <Send className="w-5 h-5" style={{ color: "#333334" }} />
                  <div>
                    <p className="text-sm font-semibold">Open Telegram</p>
                    <p
                      className="text-xs"
                      style={{ color: "var(--muted)" }}
                    >
                      @{vm.telegramBotUsername}
                    </p>
                  </div>
                </a>
              )}

              <button
                onClick={handleRestart}
                disabled={restarting}
                className="glass rounded-xl p-4 flex items-center gap-3 transition-all hover:border-white/30 cursor-pointer disabled:opacity-50 text-left"
                style={{ border: "1px solid var(--border)" }}
              >
                <RefreshCw
                  className={`w-5 h-5 ${restarting ? "animate-spin" : ""}`}
                  style={{ color: "#333334" }}
                />
                <div>
                  <p className="text-sm font-semibold">Restart Bot</p>
                  <p
                    className="text-xs"
                    style={{ color: "var(--muted)" }}
                  >
                    {restarting ? "Restarting..." : "Use if your bot is unresponsive"}
                  </p>
                </div>
              </button>
            </div>

            {/* Reset Agent Memory — destructive action */}
            <button
              data-tour="dash-reset"
              onClick={() => setShowResetConfirm(true)}
              disabled={resetting}
              className="mt-4 w-full rounded-xl p-4 flex items-center gap-3 transition-all cursor-pointer disabled:opacity-50 text-left"
              style={{
                background: "rgba(220,38,38,0.04)",
                border: "1px solid rgba(220,38,38,0.2)",
              }}
            >
              <Eraser
                className={`w-5 h-5 shrink-0 ${resetting ? "animate-pulse" : ""}`}
                style={{ color: "#ef4444" }}
              />
              <div>
                <p className="text-sm font-semibold" style={{ color: "#ef4444" }}>
                  {resetting ? "Resetting..." : "Reset Agent Memory"}
                </p>
                <p className="text-xs" style={{ color: "rgba(239,68,68,0.6)" }}>
                  Wipe memory, identity &amp; conversation history
                </p>
              </div>
            </button>
          </div>

          {/* Model Selector (all-inclusive only) */}
          {vm.apiMode === "all_inclusive" && (
            <div data-tour="dash-model">
              <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5" style={{ fontFamily: "var(--font-serif)" }}>
                Model
              </h2>
              <div
                className="glass rounded-xl p-5"
                style={{ border: "1px solid var(--border)" }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <Cpu className="w-4 h-4" style={{ color: "var(--muted)" }} />
                  <span className="text-sm font-medium">Default Model</span>
                  {modelSuccess && (
                    <span
                      className="text-xs ml-auto"
                      style={{ color: "var(--success)" }}
                    >
                      Updated
                    </span>
                  )}
                </div>
                <select
                  value={vm.model ?? "claude-sonnet-4-5-20250929"}
                  onChange={(e) => handleModelChange(e.target.value)}
                  disabled={updatingModel}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none cursor-pointer disabled:opacity-50"
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                  }}
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p
                  className="text-xs mt-2"
                  style={{ color: "var(--muted)" }}
                >
                  {updatingModel
                    ? "Updating model..."
                    : "Select the Claude model your bot uses. Cost per message varies by model."}
                </p>
              </div>
            </div>
          )}

          {/* ── aGDP Marketplace Toggle ── */}
          <div data-tour="dash-marketplace">
            <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5" style={{ fontFamily: "var(--font-serif)" }}>
              Marketplaces
            </h2>
            <div
              className="glass rounded-xl p-6"
              style={{ border: "1px solid var(--border)" }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                    style={{
                      background: vm.agdpEnabled
                        ? "linear-gradient(-75deg, rgba(220,103,67,0.1), rgba(220,103,67,0.2), rgba(220,103,67,0.1))"
                        : "rgba(0,0,0,0.04)",
                      border: vm.agdpEnabled
                        ? "1px solid rgba(220,103,67,0.2)"
                        : "1px solid var(--border)",
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={vm.agdpEnabled ? "#DC6743" : "var(--muted)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M2 12h20" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold">aGDP Agent Commerce</p>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      {vm.agdpEnabled
                        ? "Active — your bot can accept jobs from the aGDP marketplace"
                        : "Connect to the aGDP marketplace for additional bounties"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleToggleAgdp}
                  disabled={togglingAgdp}
                  className="relative w-12 h-7 rounded-full transition-all cursor-pointer shrink-0 disabled:opacity-50"
                  style={{
                    background: vm.agdpEnabled
                      ? "linear-gradient(135deg, rgba(22,22,22,0.7), rgba(40,40,40,0.8))"
                      : "rgba(0,0,0,0.08)",
                    boxShadow: vm.agdpEnabled
                      ? "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.05)"
                      : "0 0 0 1px rgba(0,0,0,0.08), inset 0 1px 2px rgba(0,0,0,0.06)",
                    backdropFilter: "blur(8px)",
                  }}
                >
                  <span
                    className="absolute top-1 w-5 h-5 rounded-full transition-all"
                    style={{
                      left: vm.agdpEnabled ? "24px" : "4px",
                      background: vm.agdpEnabled
                        ? "linear-gradient(135deg, rgba(255,255,255,0.95), rgba(240,240,240,0.9))"
                        : "linear-gradient(135deg, rgba(255,255,255,0.85), rgba(230,230,230,0.8))",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.5)",
                      transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
                    }}
                  />
                </button>
              </div>
              {vm.agdpEnabled && (
                <p className="text-xs mt-4 pt-4" style={{ color: "var(--muted)", borderTop: "1px solid var(--border)" }}>
                  Clawlancer bounties are prioritized first. aGDP jobs are only picked up when no Clawlancer work is available.
                </p>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="glass rounded-xl p-8 text-center">
          <p className="text-lg font-medium">No Instance Active</p>
          <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
            {vmStatus?.status === "pending"
              ? "Your instance is being provisioned. This may take a few minutes."
              : "Complete onboarding to deploy your OpenClaw instance."}
          </p>
        </div>
      )}

      {/* Gmail connect popup */}
      {vmStatus?.status === "assigned" && vm && (
        <GmailConnectPopup
          gmailConnected={vm.gmailConnected}
          gmailPopupDismissed={vm.gmailPopupDismissed}
          onClose={() => fetchStatus()}
          onConnected={() => fetchStatus()}
        />
      )}

      {/* Reset confirmation modal */}
      <AnimatePresence>
        {showResetConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
            onClick={() => setShowResetConfirm(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="rounded-2xl p-6 w-full max-w-sm"
              style={{ background: "var(--card)", border: "1px solid var(--border)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-center mb-4">
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center"
                  style={{ background: "rgba(239,68,68,0.1)" }}
                >
                  <AlertTriangle className="w-6 h-6" style={{ color: "#ef4444" }} />
                </div>
              </div>
              <h3 className="text-lg font-semibold text-center mb-2">Reset Agent Memory?</h3>
              <p className="text-sm text-center mb-6" style={{ color: "var(--muted)" }}>
                This will permanently delete your agent&apos;s memory, identity, and conversation
                history. Your agent will start fresh as if it was just deployed. This cannot be undone.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium cursor-pointer"
                  style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)" }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleResetAgent}
                  className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium cursor-pointer"
                  style={{ background: "#ef4444", color: "#fff" }}
                >
                  Yes, Reset Everything
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reset toast */}
      <AnimatePresence>
        {resetToast && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-6 right-6 z-50 px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg"
            style={{
              background: resetToast.type === "success" ? "#16a34a" : "#ef4444",
              color: "#fff",
            }}
          >
            {resetToast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
