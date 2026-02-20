"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Loader2,
  AlertCircle,
  Server,
  DollarSign,
  TrendingUp,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface ProviderData {
  name: string;
  vmCount: number;
  assignedCount: number;
  readyCount: number;
  provisioningCount: number;
  monthlyCost: number;
}

interface TierData {
  tier: string;
  apiMode: string;
  count: number;
  revenuePerVm: number;
  totalRevenue: number;
}

interface VmDetail {
  id: string;
  provider: string;
  serverType: string | null;
  status: string;
  tier: string | null;
  apiMode: string | null;
  createdAt: string;
  monthlyCost: number;
}

interface ModelCost {
  model: string;
  units: number;
  calls: number;
  cost: number;
}

interface VmCostDetail {
  vmId: string;
  tier: string | null;
  model: string;
  userUnits: number;
  userCost: number;
  heartbeatUnits: number;
  heartbeatCost: number;
  totalCost: number;
}

interface ApiCosts {
  periodStart: string;
  daysElapsed: number;
  daysInMonth: number;
  totalSpend: number;
  projectedMonthly: number;
  userMessages: number;
  heartbeats: number;
  heartbeatCalls: number;
  byModel: ModelCost[];
  byVm: VmCostDetail[];
}

interface MarginsData {
  providers: ProviderData[];
  tiers: TierData[];
  apiCosts: ApiCosts;
  totals: {
    totalVms: number;
    activeSubscribers: number;
    assignedVms: number;
    availableVms: number;
    monthlyInfraCost: number;
    monthlyRevenue: number;
    grossMargin: number;
    marginPercent: number;
    projectedApiSpend: number;
    trueGrossMargin: number;
    trueMarginPercent: number;
  };
  vms: VmDetail[];
}

const PROVIDER_COLORS: Record<string, string> = {
  hetzner: "#DC2626",
  digitalocean: "#0080FF",
  linode: "#00B050",
};

function fmt(n: number): string {
  if (Math.abs(n) < 1 && n !== 0) return "$" + n.toFixed(2);
  return "$" + Math.round(n).toLocaleString();
}

function fmtCents(n: number): string {
  return "$" + n.toFixed(2);
}

const MODEL_LABELS: Record<string, string> = {
  minimax: "MiniMax M2.5",
  haiku: "Haiku 4.5",
  sonnet: "Sonnet 4.5",
  opus: "Opus 4.6",
};

const MODEL_COLORS: Record<string, string> = {
  minimax: "#8B5CF6",
  haiku: "#3B82F6",
  sonnet: "#F59E0B",
  opus: "#DC2626",
};

export default function MarginsPage() {
  const [data, setData] = useState<MarginsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [vmListExpanded, setVmListExpanded] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/hq/margins");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load margins data");
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

  const { totals, providers, tiers, apiCosts, vms } = data;
  const trueMarginPositive = totals.trueGrossMargin >= 0;

  const kpis = [
    {
      label: "Monthly Revenue",
      value: fmt(totals.monthlyRevenue),
      sub: `${totals.activeSubscribers} subscribers`,
      icon: TrendingUp,
    },
    {
      label: "Infra Cost",
      value: fmt(totals.monthlyInfraCost),
      sub: `${fmt(totals.monthlyInfraCost / Math.max(totals.totalVms, 1))} avg/vm · ${totals.totalVms} VMs`,
      icon: Server,
    },
    {
      label: "API Spend (proj.)",
      value: fmtCents(totals.projectedApiSpend),
      sub: `${fmtCents(apiCosts.totalSpend)} MTD · day ${apiCosts.daysElapsed}/${apiCosts.daysInMonth}`,
      icon: DollarSign,
    },
    {
      label: "True Margin",
      value: fmt(totals.trueGrossMargin),
      sub: `${totals.trueMarginPercent.toFixed(1)}% after infra + API`,
      icon: DollarSign,
      color: trueMarginPositive ? "#16a34a" : "#dc2626",
    },
  ];

  // For tier table: compute per-user VM cost (total infra / active subscribers)
  const avgVmCost =
    totals.activeSubscribers > 0 ? totals.monthlyInfraCost / totals.activeSubscribers : 0;

  const maxTierRevenue = Math.max(...tiers.map((t) => t.totalRevenue), 1);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Margins
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

      {/* Provider Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4 mb-6">
        {providers.map((provider) => {
          const color = PROVIDER_COLORS[provider.name] ?? "var(--muted)";
          const assignedPct =
            provider.vmCount > 0
              ? (provider.assignedCount / provider.vmCount) * 100
              : 0;
          return (
            <div key={provider.name} className="glass rounded-xl p-4 sm:p-5">
              <div className="flex items-center gap-2 mb-3">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ background: color }}
                />
                <h3
                  className="text-base font-normal tracking-[-0.3px] capitalize"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  {provider.name}
                </h3>
                <span
                  className="ml-auto text-xs"
                  style={{ color: "var(--muted)" }}
                >
                  {provider.vmCount} VMs
                </span>
              </div>

              <div className="space-y-1.5 text-xs mb-3">
                <div className="flex justify-between">
                  <span style={{ color: "var(--muted)" }}>Assigned</span>
                  <span>{provider.assignedCount}</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "var(--muted)" }}>Available</span>
                  <span>{provider.readyCount}</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "var(--muted)" }}>Provisioning</span>
                  <span>{provider.provisioningCount}</span>
                </div>
              </div>

              {/* Proportional bar */}
              <div
                className="w-full h-2 rounded-full overflow-hidden mb-3"
                style={{ background: "rgba(0,0,0,0.06)" }}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${assignedPct}%`,
                    background: "var(--accent)",
                  }}
                />
              </div>

              <div className="flex justify-between text-xs">
                <span style={{ color: "var(--muted)" }}>Monthly cost</span>
                <span className="font-medium">{fmt(provider.monthlyCost)}</span>
              </div>
            </div>
          );
        })}
        {providers.length === 0 && (
          <div className="lg:col-span-3 glass rounded-xl p-8 text-center">
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              No VMs provisioned
            </p>
          </div>
        )}
      </div>

      {/* API Cost Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4 mb-6">
        {/* By Model */}
        <div className="glass rounded-xl p-4 sm:p-5">
          <h2
            className="text-base font-normal tracking-[-0.3px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            API Cost by Model
            <span className="text-xs ml-2" style={{ color: "var(--muted)", fontFamily: "inherit" }}>
              MTD
            </span>
          </h2>
          <div className="space-y-3">
            {apiCosts.byModel.map((m) => {
              const label = MODEL_LABELS[m.model] ?? m.model;
              const color = MODEL_COLORS[m.model] ?? "var(--muted)";
              const maxCost = Math.max(...apiCosts.byModel.map((x) => x.cost), 0.01);
              const barPct = (m.cost / maxCost) * 100;
              return (
                <div key={m.model}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full" style={{ background: color }} />
                      <span className="font-medium">{label}</span>
                    </div>
                    <span style={{ color: "var(--muted)" }}>
                      {fmtCents(m.cost)} · {Math.round(m.calls)} calls
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full" style={{ background: "rgba(0,0,0,0.06)" }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${barPct}%`, background: color, minWidth: barPct > 0 ? 4 : 0 }}
                    />
                  </div>
                </div>
              );
            })}
            {/* Heartbeat line */}
            <div className="pt-2 border-t" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full" style={{ background: "#10B981" }} />
                  <span className="font-medium">Heartbeats (MiniMax)</span>
                </div>
                <span style={{ color: "var(--muted)" }}>
                  {fmtCents(apiCosts.heartbeats)} · {Math.round(apiCosts.heartbeatCalls)} calls
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* User vs Heartbeat split */}
        <div className="glass rounded-xl p-4 sm:p-5">
          <h2
            className="text-base font-normal tracking-[-0.3px] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Cost Split
          </h2>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span style={{ color: "var(--muted)" }}>User messages</span>
                <span className="font-medium">{fmtCents(apiCosts.userMessages)}</span>
              </div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span style={{ color: "var(--muted)" }}>Heartbeats</span>
                <span className="font-medium">{fmtCents(apiCosts.heartbeats)}</span>
              </div>
              <div className="flex items-center justify-between text-xs font-medium pt-2 border-t" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
                <span>Total MTD</span>
                <span>{fmtCents(apiCosts.totalSpend)}</span>
              </div>
              <div className="flex items-center justify-between text-xs mt-1.5">
                <span style={{ color: "var(--muted)" }}>Projected month</span>
                <span className="font-medium">{fmtCents(apiCosts.projectedMonthly)}</span>
              </div>
            </div>
            {/* Stacked bar */}
            <div>
              <div className="w-full h-4 rounded-full overflow-hidden flex" style={{ background: "rgba(0,0,0,0.06)" }}>
                {apiCosts.totalSpend > 0 && (
                  <>
                    <div
                      className="h-full"
                      style={{
                        width: `${(apiCosts.userMessages / apiCosts.totalSpend) * 100}%`,
                        background: "var(--accent)",
                      }}
                    />
                    <div
                      className="h-full"
                      style={{
                        width: `${(apiCosts.heartbeats / apiCosts.totalSpend) * 100}%`,
                        background: "#10B981",
                      }}
                    />
                  </>
                )}
              </div>
              <div className="flex justify-between text-[10px] mt-1" style={{ color: "var(--muted)" }}>
                <span>User msgs ({apiCosts.totalSpend > 0 ? ((apiCosts.userMessages / apiCosts.totalSpend) * 100).toFixed(0) : 0}%)</span>
                <span>Heartbeats ({apiCosts.totalSpend > 0 ? ((apiCosts.heartbeats / apiCosts.totalSpend) * 100).toFixed(0) : 0}%)</span>
              </div>
            </div>
            {/* Margin waterfall */}
            <div className="pt-3 border-t space-y-1.5" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: "var(--muted)" }}>Revenue</span>
                <span className="font-medium">{fmt(totals.monthlyRevenue)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: "var(--muted)" }}>- Infra</span>
                <span style={{ color: "#dc2626" }}>-{fmt(totals.monthlyInfraCost)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: "var(--muted)" }}>- API (proj.)</span>
                <span style={{ color: "#dc2626" }}>-{fmtCents(totals.projectedApiSpend)}</span>
              </div>
              <div className="flex items-center justify-between text-xs font-medium pt-1.5 border-t" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
                <span>True margin</span>
                <span style={{ color: trueMarginPositive ? "#16a34a" : "#dc2626" }}>
                  {fmt(totals.trueGrossMargin)} ({totals.trueMarginPercent.toFixed(1)}%)
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tier Profitability */}
      <div className="glass rounded-xl p-4 sm:p-5 mb-6">
        <h2
          className="text-base font-normal tracking-[-0.3px] mb-4"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Tier Profitability
        </h2>
        {tiers.length === 0 ? (
          <p className="text-xs text-center py-8" style={{ color: "var(--muted)" }}>
            No active subscribers
          </p>
        ) : (
          <div className="space-y-2">
            {/* Header */}
            <div
              className="grid gap-2 text-xs px-3 py-1.5"
              style={{
                gridTemplateColumns: "1.2fr 0.6fr 0.8fr 0.8fr 0.8fr 0.8fr 1.5fr",
                color: "var(--muted)",
              }}
            >
              <span>Tier</span>
              <span className="text-right">Users</span>
              <span className="text-right">Rev/user</span>
              <span className="text-right">Total rev</span>
              <span className="text-right">VM cost</span>
              <span className="text-right">Margin/user</span>
              <span />
            </div>
            {tiers.map((tier) => {
              const marginPerUser = tier.revenuePerVm - avgVmCost;
              const isPositive = marginPerUser >= 0;
              const revBar = (tier.totalRevenue / maxTierRevenue) * 100;
              const costBar =
                (avgVmCost * tier.count) /
                maxTierRevenue *
                100;
              return (
                <div
                  key={`${tier.tier}-${tier.apiMode}`}
                  className="relative grid gap-2 items-center text-sm px-3 py-2.5 rounded-lg"
                  style={{ gridTemplateColumns: "1.2fr 0.6fr 0.8fr 0.8fr 0.8fr 0.8fr 1.5fr" }}
                >
                  <span className="font-medium">
                    {tier.tier}
                    <span
                      className="text-xs ml-1.5"
                      style={{ color: "var(--muted)" }}
                    >
                      {tier.apiMode === "byok" ? "BYOK" : "All-incl"}
                    </span>
                  </span>
                  <span className="text-right">{tier.count}</span>
                  <span className="text-right">{fmt(tier.revenuePerVm)}</span>
                  <span className="text-right">{fmt(tier.totalRevenue)}</span>
                  <span className="text-right" style={{ color: "var(--muted)" }}>
                    {fmt(Math.round(avgVmCost))}
                  </span>
                  <span
                    className="text-right font-medium"
                    style={{ color: isPositive ? "#16a34a" : "#dc2626" }}
                  >
                    {isPositive ? "+" : ""}
                    {fmt(Math.round(marginPerUser))}
                  </span>
                  {/* Revenue vs cost bar */}
                  <div className="flex items-center gap-1">
                    <div
                      className="h-2 rounded-full"
                      style={{
                        width: `${revBar}%`,
                        background: "var(--accent)",
                        minWidth: revBar > 0 ? 4 : 0,
                      }}
                    />
                    <div
                      className="h-2 rounded-full"
                      style={{
                        width: `${costBar}%`,
                        background: "rgba(0,0,0,0.12)",
                        minWidth: costBar > 0 ? 4 : 0,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* VM List (expandable) */}
      <div className="glass rounded-xl p-4 sm:p-5">
        <button
          onClick={() => setVmListExpanded(!vmListExpanded)}
          className="flex items-center justify-between w-full cursor-pointer"
        >
          <h2
            className="text-base font-normal tracking-[-0.3px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            All VMs
            <span className="text-xs ml-2" style={{ color: "var(--muted)", fontFamily: "inherit" }}>
              {vms.length} total
            </span>
          </h2>
          {vmListExpanded ? (
            <ChevronUp className="w-4 h-4" style={{ color: "var(--muted)" }} />
          ) : (
            <ChevronDown className="w-4 h-4" style={{ color: "var(--muted)" }} />
          )}
        </button>

        {vmListExpanded && (
          <div className="mt-4 overflow-y-auto" style={{ maxHeight: 480 }}>
            {/* Header */}
            <div
              className="grid gap-2 text-xs px-3 py-1.5 sticky top-0"
              style={{
                gridTemplateColumns: "0.6fr 1fr 0.8fr 0.8fr 0.7fr",
                color: "var(--muted)",
                background: "var(--background)",
              }}
            >
              <span>Provider</span>
              <span>Server Type</span>
              <span>Status</span>
              <span>Tier</span>
              <span className="text-right">Cost/mo</span>
            </div>
            <div className="space-y-0.5">
              {vms.map((vm) => {
                const color = PROVIDER_COLORS[vm.provider] ?? "var(--muted)";
                const statusColors: Record<string, string> = {
                  assigned: "var(--accent)",
                  ready: "#16a34a",
                  provisioning: "#f59e0b",
                  failed: "#dc2626",
                  terminated: "var(--muted)",
                };
                return (
                  <div
                    key={vm.id}
                    className="grid gap-2 items-center text-xs px-3 py-2 rounded-lg hover:bg-black/[0.02] transition-colors"
                    style={{ gridTemplateColumns: "0.6fr 1fr 0.8fr 0.8fr 0.7fr" }}
                  >
                    <div className="flex items-center gap-1.5">
                      <div
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: color }}
                      />
                      <span className="capitalize">{vm.provider}</span>
                    </div>
                    <span style={{ color: "var(--muted)" }}>
                      {vm.serverType ?? "—"}
                    </span>
                    <span style={{ color: statusColors[vm.status] ?? "var(--muted)" }}>
                      {vm.status}
                    </span>
                    <span>
                      {vm.tier ? (
                        <>
                          <span className="capitalize">{vm.tier}</span>
                          {vm.apiMode === "byok" && (
                            <span className="ml-1" style={{ color: "var(--muted)" }}>
                              BYOK
                            </span>
                          )}
                        </>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>—</span>
                      )}
                    </span>
                    <span className="text-right">{fmt(vm.monthlyCost)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
