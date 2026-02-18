"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Loader2,
  AlertCircle,
  Mail,
  UserCheck,
  Clock,
  TrendingUp,
  Server,
  Users,
} from "lucide-react";

interface InvitesData {
  funnel: {
    total: number;
    redeemed: number;
    activeUnused: number;
    expired: number;
    deactivated: number;
    conversionRate: number;
  };
  urgency: {
    urgent: number;
    moderate: number;
    fresh: number;
    details: { email: string; daysLeft: number; createdAt: string }[];
  };
  activeUsers: {
    email: string;
    createdAt: string;
    vmName: string | null;
    healthStatus: string | null;
  }[];
  fleet: {
    total: number;
    ready: number;
    assigned: number;
    failed: number;
    headroom: number;
  };
  waitlist: {
    total: number;
    invited: number;
    notInvited: number;
  };
}

export default function InvitesPage() {
  const [data, setData] = useState<InvitesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/hq/invites");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invite data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <AlertCircle className="w-8 h-8" style={{ color: "var(--error)" }} />
        <p className="text-sm" style={{ color: "var(--muted)" }}>{error}</p>
        <button
          onClick={fetchData}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
          style={{ background: "rgba(0,0,0,0.08)" }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { funnel, urgency, activeUsers, fleet, waitlist } = data;

  const kpis = [
    {
      label: "Total Invites",
      value: funnel.total.toString(),
      sub: `${funnel.expired} expired · ${funnel.deactivated} deactivated`,
      icon: Mail,
    },
    {
      label: "Redeemed",
      value: funnel.redeemed.toString(),
      sub: "signed up",
      icon: UserCheck,
      color: "#16a34a",
    },
    {
      label: "Active Unredeemed",
      value: funnel.activeUnused.toString(),
      sub: "pending signup",
      icon: Clock,
      color: funnel.activeUnused > 0 ? "#f59e0b" : "var(--muted)",
    },
    {
      label: "Conversion Rate",
      value: `${funnel.conversionRate}%`,
      sub: `${funnel.redeemed}/${funnel.total}`,
      icon: TrendingUp,
    },
  ];

  // Sort urgency details by days left ascending
  const sortedDetails = [...urgency.details].sort((a, b) => a.daysLeft - b.daysLeft);

  const healthColors: Record<string, string> = {
    healthy: "#16a34a",
    unhealthy: "#dc2626",
    unknown: "var(--muted)",
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Invites
        </h1>
        <button
          onClick={fetchData}
          disabled={loading}
          className="glass flex items-center gap-1.5 px-3 sm:px-4 py-2 text-sm font-medium cursor-pointer rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
          style={{
            boxShadow:
              "0 0 12px 2px rgba(220, 103, 67, 0.15), 0 0 24px 4px rgba(220, 103, 67, 0.08), 0 2px 8px rgba(0,0,0,0.06)",
          }}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="glass rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4" style={{ color: "var(--muted)" }} />
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {kpi.label}
                </span>
              </div>
              <p
                className="text-2xl sm:text-3xl font-normal tracking-[-0.5px]"
                style={{
                  fontFamily: "var(--font-serif)",
                  color: kpi.color ?? "inherit",
                }}
              >
                {kpi.value}
              </p>
              <p className="text-xs mt-1" style={{ color: kpi.color ?? "var(--muted)" }}>
                {kpi.sub}
              </p>
            </div>
          );
        })}
      </div>

      {/* Follow-up Status */}
      <div className="glass rounded-xl p-4 sm:p-5 mb-6">
        <h2
          className="text-base font-normal tracking-[-0.3px] mb-4"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Follow-up Status
        </h2>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div
            className="rounded-lg p-3 text-center"
            style={{ background: "rgba(220, 38, 38, 0.08)" }}
          >
            <p
              className="text-2xl font-normal tracking-[-0.5px]"
              style={{ fontFamily: "var(--font-serif)", color: "#dc2626" }}
            >
              {urgency.urgent}
            </p>
            <p className="text-xs mt-1" style={{ color: "#dc2626" }}>
              Expiring ≤2d
            </p>
          </div>
          <div
            className="rounded-lg p-3 text-center"
            style={{ background: "rgba(245, 158, 11, 0.08)" }}
          >
            <p
              className="text-2xl font-normal tracking-[-0.5px]"
              style={{ fontFamily: "var(--font-serif)", color: "#f59e0b" }}
            >
              {urgency.moderate}
            </p>
            <p className="text-xs mt-1" style={{ color: "#f59e0b" }}>
              Expiring 3-5d
            </p>
          </div>
          <div
            className="rounded-lg p-3 text-center"
            style={{ background: "rgba(22, 163, 74, 0.08)" }}
          >
            <p
              className="text-2xl font-normal tracking-[-0.5px]"
              style={{ fontFamily: "var(--font-serif)", color: "#16a34a" }}
            >
              {urgency.fresh}
            </p>
            <p className="text-xs mt-1" style={{ color: "#16a34a" }}>
              Fresh (5+ days)
            </p>
          </div>
        </div>

        {sortedDetails.length > 0 && (
          <div className="overflow-y-auto" style={{ maxHeight: 280 }}>
            <div
              className="grid gap-2 text-xs px-3 py-1.5 sticky top-0"
              style={{
                gridTemplateColumns: "1.5fr 0.5fr 0.8fr",
                color: "var(--muted)",
                background: "var(--background)",
              }}
            >
              <span>Email</span>
              <span className="text-right">Days left</span>
              <span className="text-right">Sent</span>
            </div>
            <div className="space-y-0.5">
              {sortedDetails.map((d) => {
                const color =
                  d.daysLeft <= 2
                    ? "#dc2626"
                    : d.daysLeft <= 5
                      ? "#f59e0b"
                      : "#16a34a";
                return (
                  <div
                    key={d.email}
                    className="grid gap-2 items-center text-xs px-3 py-2 rounded-lg hover:bg-black/[0.02] transition-colors"
                    style={{ gridTemplateColumns: "1.5fr 0.5fr 0.8fr" }}
                  >
                    <span className="truncate">{d.email}</span>
                    <span className="text-right font-medium" style={{ color }}>
                      {d.daysLeft}d
                    </span>
                    <span className="text-right" style={{ color: "var(--muted)" }}>
                      {new Date(d.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Active Users */}
      <div className="glass rounded-xl p-4 sm:p-5 mb-6">
        <h2
          className="text-base font-normal tracking-[-0.3px] mb-4"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Active Users
          <span className="text-xs ml-2" style={{ color: "var(--muted)", fontFamily: "inherit" }}>
            {activeUsers.length} total
          </span>
        </h2>

        {activeUsers.length === 0 ? (
          <p className="text-xs text-center py-8" style={{ color: "var(--muted)" }}>
            No registered users yet
          </p>
        ) : (
          <div className="overflow-y-auto" style={{ maxHeight: 400 }}>
            <div
              className="grid gap-2 text-xs px-3 py-1.5 sticky top-0"
              style={{
                gridTemplateColumns: "1.5fr 0.8fr 0.6fr 0.8fr",
                color: "var(--muted)",
                background: "var(--background)",
              }}
            >
              <span>Email</span>
              <span>VM</span>
              <span>Health</span>
              <span className="text-right">Signed up</span>
            </div>
            <div className="space-y-0.5">
              {activeUsers.map((u) => (
                <div
                  key={u.email}
                  className="grid gap-2 items-center text-xs px-3 py-2 rounded-lg hover:bg-black/[0.02] transition-colors"
                  style={{ gridTemplateColumns: "1.5fr 0.8fr 0.6fr 0.8fr" }}
                >
                  <span className="truncate">{u.email}</span>
                  <span style={{ color: u.vmName ? "inherit" : "var(--muted)" }}>
                    {u.vmName ?? "—"}
                  </span>
                  <span
                    style={{
                      color: u.healthStatus
                        ? (healthColors[u.healthStatus] ?? "var(--muted)")
                        : "var(--muted)",
                    }}
                  >
                    {u.healthStatus ?? "—"}
                  </span>
                  <span className="text-right" style={{ color: "var(--muted)" }}>
                    {new Date(u.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Fleet & Waitlist Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        {/* Fleet */}
        <div className="glass rounded-xl p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-3">
            <Server className="w-4 h-4" style={{ color: "var(--muted)" }} />
            <h2
              className="text-base font-normal tracking-[-0.3px]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Fleet
            </h2>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Total VMs</span>
              <span>{fleet.total}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Ready pool</span>
              <span style={{ color: "#16a34a" }}>{fleet.ready}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Assigned</span>
              <span>{fleet.assigned}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Failed</span>
              <span style={{ color: fleet.failed > 0 ? "#dc2626" : "var(--muted)" }}>
                {fleet.failed}
              </span>
            </div>
            <div
              className="border-t pt-2 mt-2 flex justify-between font-medium"
              style={{ borderColor: "var(--border)" }}
            >
              <span>Headroom</span>
              <span
                style={{
                  color: fleet.headroom >= 0 ? "#16a34a" : "#dc2626",
                }}
              >
                {fleet.headroom >= 0 ? "+" : ""}
                {fleet.headroom} VMs
              </span>
            </div>
          </div>
        </div>

        {/* Waitlist */}
        <div className="glass rounded-xl p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4" style={{ color: "var(--muted)" }} />
            <h2
              className="text-base font-normal tracking-[-0.3px]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Waitlist
            </h2>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Total signups</span>
              <span>{waitlist.total}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Already invited</span>
              <span style={{ color: "#16a34a" }}>{waitlist.invited}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Not yet invited</span>
              <span
                style={{
                  color: waitlist.notInvited > 0 ? "#f59e0b" : "var(--muted)",
                }}
              >
                {waitlist.notInvited}
              </span>
            </div>
          </div>

          {/* Progress bar */}
          {waitlist.total > 0 && (
            <div className="mt-4">
              <div
                className="w-full h-2 rounded-full overflow-hidden"
                style={{ background: "rgba(0,0,0,0.06)" }}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(waitlist.invited / waitlist.total) * 100}%`,
                    background: "var(--accent)",
                  }}
                />
              </div>
              <p className="text-xs mt-1.5" style={{ color: "var(--muted)" }}>
                {((waitlist.invited / waitlist.total) * 100).toFixed(0)}% of waitlist invited
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
