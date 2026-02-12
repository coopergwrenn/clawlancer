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
} from "lucide-react";
import { WorldIDBanner } from "@/components/dashboard/world-id-banner";

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
  }, []);

  // Auto-expand credit packs when at daily limit with 0 credits
  useEffect(() => {
    if (usage && usage.today >= usage.dailyLimit && usage.creditBalance <= 0) {
      setShowCreditPacks(true);
    }
  }, [usage]);

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
      <WorldIDBanner />

      {vmStatus?.status === "assigned" && vm ? (
        <>
          {/* ── Usage Hero (all-inclusive only) ── */}
          {usage && vm.apiMode === "all_inclusive" && (
            <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
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
                <span className="text-3xl font-semibold tracking-tight">{usage.today}</span>
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
              <div className="flex gap-6">
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
                    Buy credits below to keep chatting — they kick in instantly.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── Credits & Plan ── */}
          {usage && vm.apiMode === "all_inclusive" ? (
            <div className="grid gap-5 sm:grid-cols-2">
              {/* Credit Balance */}
              <div
                className="glass rounded-xl p-6"
                style={{ border: "1px solid var(--border)" }}
              >
                <div className="flex items-center gap-2 mb-4">
                  <Zap className="w-4 h-4" style={{ color: "var(--accent)" }} />
                  <span className="text-sm font-medium" style={{ color: "var(--muted)" }}>
                    Bonus Credits
                  </span>
                </div>
                <p className="text-3xl font-semibold">
                  {usage.creditBalance}
                </p>
                <p className="text-xs mt-1 mb-5" style={{ color: "var(--muted)" }}>
                  {usage.creditBalance > 0
                    ? "Used after daily limit is reached. Never expire."
                    : "Buy credits to extend past your daily limit."}
                </p>
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
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer"
                  style={{ background: "var(--accent)", color: "#fff" }}
                >
                  Buy Credits
                </button>
              </div>

              {/* Billing Summary */}
              {billing && (
                <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
                  <div className="flex items-center gap-2 mb-4">
                    <CreditCard className="w-4 h-4" style={{ color: "var(--muted)" }} />
                    <span className="text-sm font-medium">Plan</span>
                  </div>
                  <p className="text-xl font-bold">{billing.tierName}</p>
                  <p className="text-xs mt-0.5 mb-1" style={{ color: "var(--muted)" }}>
                    {billing.apiMode === "byok" ? "BYOK" : "All-Inclusive"}
                  </p>
                  {billing.price !== null && (
                    <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>
                      ${billing.price}/mo
                      {billing.renewalDate && (
                        <span className="block text-xs mt-0.5">
                          Renews {new Date(billing.renewalDate).toLocaleDateString()}
                        </span>
                      )}
                    </p>
                  )}
                  <Link
                    href="/billing"
                    className="inline-flex px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    style={{
                      background: "rgba(0,0,0,0.04)",
                      color: "var(--muted)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    Manage Plan
                  </Link>
                </div>
              )}
            </div>
          ) : (
            billing && (
              <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
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
          <div className="grid gap-5 sm:grid-cols-3">
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
          <div>
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
                    {restarting ? "Restarting..." : "Restart OpenClaw gateway"}
                  </p>
                </div>
              </button>
            </div>
          </div>

          {/* Model Selector (all-inclusive only) */}
          {vm.apiMode === "all_inclusive" && (
            <div>
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
    </div>
  );
}
