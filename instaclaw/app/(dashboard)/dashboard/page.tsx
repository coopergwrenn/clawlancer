"use client";

import { useState, useEffect } from "react";
import {
  ExternalLink,
  RefreshCw,
  Send,
  Activity,
  Server,
  Calendar,
  Cpu,
} from "lucide-react";

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
  };
}

export default function DashboardPage() {
  const [vmStatus, setVmStatus] = useState<VMStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [modelSuccess, setModelSuccess] = useState(false);

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
  const healthColor =
    vm?.healthStatus === "healthy"
      ? "var(--success)"
      : vm?.healthStatus === "unhealthy"
      ? "var(--error)"
      : "var(--muted)";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Manage your OpenClaw instance.
        </p>
      </div>

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
