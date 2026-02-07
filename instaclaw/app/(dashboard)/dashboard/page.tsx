"use client";

import { useState, useEffect } from "react";
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
} from "lucide-react";
import { WorldIDBanner } from "@/components/dashboard/world-id-banner";

const MODEL_OPTIONS = [
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-5-20250820", label: "Claude Opus 4.5" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
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

export default function DashboardPage() {
  const [vmStatus, setVmStatus] = useState<VMStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [modelSuccess, setModelSuccess] = useState(false);
  const [usage, setUsage] = useState<{ today: number; week: number; month: number } | null>(null);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/vm/status");
      const data = await res.json();
      setVmStatus(data);
    } catch {
      // Silently handle
    }
  }

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    // Fetch usage stats once on mount (not on the polling interval)
    fetch("/api/vm/usage")
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => {});
    return () => clearInterval(interval);
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Manage your OpenClaw instance.
        </p>
      </div>

      {/* Payment past_due banner */}
      {billing?.paymentStatus === "past_due" && (
        <div
          className="rounded-xl p-4 flex items-center gap-3"
          style={{
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
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
          className="rounded-xl p-4 flex items-center gap-3"
          style={{
            background: "rgba(59,130,246,0.1)",
            border: "1px solid rgba(59,130,246,0.3)",
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
          {/* Status + Stats */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="glass rounded-xl p-5">
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

            <div className="glass rounded-xl p-5">
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

            <div className="glass rounded-xl p-5">
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
                  : "—"}
              </span>
            </div>
          </div>

          {/* Usage Stats */}
          {usage && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="glass rounded-xl p-5">
                <p
                  className="text-xs uppercase tracking-wide mb-1"
                  style={{ color: "var(--muted)" }}
                >
                  Today
                </p>
                <p className="text-2xl font-bold">{usage.today}</p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  conversations
                </p>
                <div
                  className="mt-2 h-1.5 rounded-full overflow-hidden"
                  style={{ background: "rgba(255,255,255,0.06)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (usage.today / Math.max(usage.week / 7, 1)) * 100)}%`,
                      background: "var(--success)",
                      transition: "width 0.5s ease",
                    }}
                  />
                </div>
              </div>
              <div className="glass rounded-xl p-5">
                <p
                  className="text-xs uppercase tracking-wide mb-1"
                  style={{ color: "var(--muted)" }}
                >
                  7 Days
                </p>
                <p className="text-2xl font-bold">{usage.week}</p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  conversations
                </p>
              </div>
              <div className="glass rounded-xl p-5">
                <p
                  className="text-xs uppercase tracking-wide mb-1"
                  style={{ color: "var(--muted)" }}
                >
                  30 Days
                </p>
                <p className="text-2xl font-bold">{usage.month}</p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  conversations
                </p>
              </div>
            </div>
          )}

          {/* Billing Summary */}
          {billing && (
            <div className="glass rounded-xl p-5" style={{ border: "1px solid var(--border)" }}>
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
                        <> — Renews {new Date(billing.renewalDate).toLocaleDateString()}</>
                      )}
                    </p>
                  )}
                </div>
                <Link
                  href="/billing"
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    color: "var(--muted)",
                    border: "1px solid var(--border)",
                  }}
                >
                  Manage
                </Link>
              </div>
            </div>
          )}

          {/* Quick Actions */}
          <div>
            <h2 className="text-lg font-semibold mb-4">Quick Actions</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {vm.controlUiUrl && (
                <a
                  href={vm.controlUiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="glass rounded-xl p-4 flex items-center gap-3 transition-all hover:border-white/30"
                  style={{ border: "1px solid var(--border)" }}
                >
                  <ExternalLink className="w-5 h-5 text-white" />
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
                  <Send className="w-5 h-5 text-white" />
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
                  className={`w-5 h-5 text-white ${restarting ? "animate-spin" : ""}`}
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
              <h2 className="text-lg font-semibold mb-4">Model</h2>
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
                    : "Select the Claude model your bot uses."}
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
