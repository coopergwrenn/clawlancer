"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  AlertCircle,
  RefreshCw,
  Award,
  Users,
  DollarSign,
  CheckCircle2,
  Clock,
  XCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  Banknote,
} from "lucide-react";

// ── Types ───────────────────────────────────────────

interface ReferralRow {
  id: string;
  ambassador_id: string;
  referred_user_id: string | null;
  ref_code: string;
  waitlisted_at: string | null;
  signed_up_at: string | null;
  converted_at: string | null;
  paid_at: string | null;
  paid_out_at: string | null;
  commission_amount: number;
  commission_status: "pending" | "paid" | "void";
  created_at: string;
  instaclaw_users: { email: string; name: string | null } | null;
}

interface ReferralStats {
  waitlist_count: number;
  signup_count: number;
  paid_count: number;
  pending_earnings: number;
}

interface AmbassadorRow {
  id: string;
  user_id: string;
  status: "pending" | "approved" | "rejected" | "revoked";
  ambassador_name: string;
  ambassador_number: number | null;
  wallet_address: string;
  application_text: string;
  social_handles: Record<string, string>;
  referral_code: string | null;
  referral_count: number;
  earnings_total: number;
  applied_at: string;
  approved_at: string | null;
  revoked_at: string | null;
  instaclaw_users: { email: string; name: string | null } | null;
  referrals: ReferralRow[];
  referral_stats: ReferralStats;
}

interface Stats {
  total: number;
  approved: number;
  pending: number;
  totalReferrals: number;
  totalEarnings: number;
  totalPendingPayouts: number;
}

// ── Status badge ────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; icon: React.ReactNode }> = {
    pending: {
      bg: "rgba(245,158,11,0.12)",
      color: "#d97706",
      icon: <Clock className="w-3 h-3" />,
    },
    approved: {
      bg: "rgba(34,197,94,0.12)",
      color: "#16a34a",
      icon: <CheckCircle2 className="w-3 h-3" />,
    },
    rejected: {
      bg: "rgba(239,68,68,0.12)",
      color: "#dc2626",
      icon: <XCircle className="w-3 h-3" />,
    },
    revoked: {
      bg: "rgba(107,107,107,0.12)",
      color: "#6b6b6b",
      icon: <Ban className="w-3 h-3" />,
    },
  };
  const s = map[status] ?? map.pending;
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: s.bg, color: s.color }}
    >
      {s.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function CommissionBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    pending: { bg: "rgba(245,158,11,0.12)", color: "#d97706" },
    paid: { bg: "rgba(34,197,94,0.12)", color: "#16a34a" },
    void: { bg: "rgba(239,68,68,0.12)", color: "#dc2626" },
  };
  const s = map[status] ?? map.pending;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: s.bg, color: s.color }}
    >
      {status}
    </span>
  );
}

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// ── Page ────────────────────────────────────────────

export default function HQAmbassadorsPage() {
  const [ambassadors, setAmbassadors] = useState<AmbassadorRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Filter
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected" | "revoked">("all");

  // Expanded rows
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Detail modal
  const [selected, setSelected] = useState<AmbassadorRow | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/hq/ambassadors");
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setAmbassadors(data.ambassadors);
      setStats(data.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleAction(ambassadorId: string, action: "approve" | "reject" | "revoke") {
    setActionLoading(ambassadorId);
    try {
      const res = await fetch("/api/hq/ambassadors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ambassadorId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Action failed");
      await fetchData();
      setSelected(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePayCommission(referralId: string) {
    setActionLoading(referralId);
    try {
      const res = await fetch("/api/hq/ambassadors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pay_commission", referralId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to mark as paid");
      await fetchData();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to mark as paid");
    } finally {
      setActionLoading(null);
    }
  }

  // ── Loading / Error ──

  if (loading && ambassadors.length === 0) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  if (error && ambassadors.length === 0) {
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

  const filtered = filter === "all" ? ambassadors : ambassadors.filter((a) => a.status === filter);

  const kpis = [
    { label: "Total", value: stats?.total ?? 0, icon: Users },
    { label: "Approved", value: stats?.approved ?? 0, icon: CheckCircle2, color: "#16a34a" },
    { label: "Pending Apps", value: stats?.pending ?? 0, icon: Clock, color: "#d97706" },
    { label: "Referrals", value: stats?.totalReferrals ?? 0, icon: Award, color: "#DC6743" },
    { label: "Total Earnings", value: `$${(stats?.totalEarnings ?? 0).toFixed(2)}`, icon: DollarSign },
  ];

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Ambassadors
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

      {/* Pending Payouts Banner */}
      {(stats?.totalPendingPayouts ?? 0) > 0 && (
        <div
          className="rounded-xl p-4 mb-6 flex items-center gap-3"
          style={{
            background: "linear-gradient(135deg, rgba(245,158,11,0.08), rgba(220,103,67,0.08))",
            border: "1px solid rgba(245,158,11,0.2)",
          }}
        >
          <Banknote className="w-5 h-5 shrink-0" style={{ color: "#d97706" }} />
          <div>
            <p className="text-sm font-medium">
              ${(stats?.totalPendingPayouts ?? 0).toFixed(2)} in pending payouts
            </p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Expand ambassador rows below to mark individual commissions as paid
            </p>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="glass rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4" style={{ color: "var(--muted)" }} />
                <span className="text-xs" style={{ color: "var(--muted)" }}>{kpi.label}</span>
              </div>
              <p
                className="text-2xl font-normal tracking-[-0.5px]"
                style={{
                  fontFamily: "var(--font-serif)",
                  color: kpi.color ?? "inherit",
                }}
              >
                {kpi.value}
              </p>
            </div>
          );
        })}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-4">
        {(["all", "pending", "approved", "rejected", "revoked"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="px-3 py-1.5 rounded-lg text-sm transition-colors cursor-pointer"
            style={{
              background: filter === f ? "rgba(0,0,0,0.07)" : "transparent",
              color: filter === f ? "var(--foreground)" : "var(--muted)",
            }}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            {f !== "all" && (
              <span className="ml-1 text-xs" style={{ opacity: 0.6 }}>
                {ambassadors.filter((a) => a.status === f).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="glass rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
        {/* Header row */}
        <div
          className="grid gap-2 text-xs px-4 py-2.5"
          style={{
            gridTemplateColumns: "20px 1.2fr 1fr 0.6fr 0.6fr 0.6fr 0.6fr 0.7fr",
            color: "var(--muted)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span></span>
          <span>Name</span>
          <span>Ref Slug</span>
          <span>Waitlist</span>
          <span>Paid</span>
          <span>Pending $</span>
          <span>Total $</span>
          <span>Joined</span>
        </div>

        {/* Rows */}
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--muted)" }}>
            No ambassadors found
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
            {filtered.map((amb) => {
              const isExpanded = expandedId === amb.id;
              const paidRefs = amb.referrals.filter((r) => r.paid_at);

              return (
                <div key={amb.id}>
                  {/* Main row */}
                  <div
                    className="grid gap-2 items-center text-sm px-4 py-3 hover:bg-black/[0.02] transition-colors cursor-pointer"
                    style={{ gridTemplateColumns: "20px 1.2fr 1fr 0.6fr 0.6fr 0.6fr 0.6fr 0.7fr" }}
                  >
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : amb.id)}
                      className="cursor-pointer p-0 bg-transparent border-none"
                      style={{ color: "var(--muted)" }}
                    >
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => setSelected(amb)}
                      className="truncate font-medium text-left cursor-pointer bg-transparent border-none p-0 hover:underline"
                    >
                      <span>{amb.ambassador_name}</span>
                      <span className="ml-2 text-xs font-normal" style={{ color: "var(--muted)" }}>
                        {amb.instaclaw_users?.email ?? ""}
                      </span>
                    </button>
                    <span className="font-mono text-xs truncate" style={{ color: "var(--muted)" }}>
                      {amb.referral_code ?? "—"}
                    </span>
                    <span style={{ color: "var(--muted)" }}>{amb.referral_stats.waitlist_count}</span>
                    <span style={{ color: "var(--muted)" }}>{amb.referral_stats.paid_count}</span>
                    <span style={{ color: amb.referral_stats.pending_earnings > 0 ? "#d97706" : "var(--muted)" }}>
                      ${amb.referral_stats.pending_earnings.toFixed(2)}
                    </span>
                    <span style={{ color: "var(--muted)" }}>${Number(amb.earnings_total).toFixed(2)}</span>
                    <span style={{ color: "var(--muted)" }}>{formatDate(amb.applied_at)}</span>
                  </div>

                  {/* Expanded referrals */}
                  {isExpanded && (
                    <div
                      className="px-4 pb-4"
                      style={{ background: "rgba(0,0,0,0.015)" }}
                    >
                      {amb.referrals.length === 0 ? (
                        <p className="text-xs py-3" style={{ color: "var(--muted)" }}>
                          No referrals yet
                        </p>
                      ) : (
                        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                          {/* Sub-header */}
                          <div
                            className="grid gap-2 text-xs px-3 py-2"
                            style={{
                              gridTemplateColumns: "1.5fr 1fr 1fr 1fr 0.7fr 0.8fr",
                              color: "var(--muted)",
                              background: "rgba(0,0,0,0.03)",
                              borderBottom: "1px solid var(--border)",
                            }}
                          >
                            <span>User</span>
                            <span>Waitlisted</span>
                            <span>Signed Up</span>
                            <span>Paid</span>
                            <span>Commission</span>
                            <span>Status</span>
                          </div>

                          {/* Referral rows */}
                          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                            {amb.referrals.map((ref) => (
                              <div
                                key={ref.id}
                                className="grid gap-2 items-center text-xs px-3 py-2.5"
                                style={{
                                  gridTemplateColumns: "1.5fr 1fr 1fr 1fr 0.7fr 0.8fr",
                                  background: "var(--card)",
                                }}
                              >
                                <span className="truncate">
                                  {ref.instaclaw_users?.email ?? ref.instaclaw_users?.name ?? (
                                    <span style={{ color: "var(--muted)" }}>waitlist only</span>
                                  )}
                                </span>
                                <span style={{ color: "var(--muted)" }}>{formatDateTime(ref.waitlisted_at)}</span>
                                <span style={{ color: "var(--muted)" }}>{formatDateTime(ref.signed_up_at)}</span>
                                <span style={{ color: "var(--muted)" }}>{formatDateTime(ref.paid_at)}</span>
                                <span style={{ color: "var(--muted)" }}>
                                  {Number(ref.commission_amount) > 0 ? `$${Number(ref.commission_amount).toFixed(2)}` : "—"}
                                </span>
                                <span className="flex items-center gap-2">
                                  <CommissionBadge status={ref.commission_status} />
                                  {ref.commission_status === "pending" && Number(ref.commission_amount) > 0 && (
                                    <button
                                      onClick={() => handlePayCommission(ref.id)}
                                      disabled={actionLoading === ref.id}
                                      className="px-2 py-1 rounded text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
                                      style={{
                                        background: "rgba(34,197,94,0.1)",
                                        color: "#16a34a",
                                        border: "1px solid rgba(34,197,94,0.25)",
                                      }}
                                    >
                                      {actionLoading === ref.id ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        "Mark Paid"
                                      )}
                                    </button>
                                  )}
                                  {ref.commission_status === "paid" && ref.paid_out_at && (
                                    <span className="text-xs" style={{ color: "var(--muted)" }}>
                                      {formatDate(ref.paid_out_at)}
                                    </span>
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail Sheet (for approve/reject/revoke) */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelected(null);
          }}
          style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)" }}
        >
          <div
            className="w-full sm:max-w-md max-h-[90vh] flex flex-col rounded-t-2xl sm:rounded-xl p-5"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              boxShadow: "0 -4px 32px rgba(0,0,0,0.12)",
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <h3
                className="text-lg font-normal tracking-[-0.3px]"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                {selected.ambassador_name}
              </h3>
              <StatusBadge status={selected.status} />
            </div>

            <div className="space-y-3 text-sm overflow-y-auto min-h-0 flex-1">
              <div>
                <span style={{ color: "var(--muted)" }}>Email: </span>
                {selected.instaclaw_users?.email ?? "—"}
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>Wallet: </span>
                <span className="font-mono text-xs">{selected.wallet_address}</span>
              </div>
              {selected.referral_code && (
                <div>
                  <span style={{ color: "var(--muted)" }}>Referral Code: </span>
                  <span className="font-mono text-xs">{selected.referral_code}</span>
                </div>
              )}
              {selected.ambassador_number && (
                <div>
                  <span style={{ color: "var(--muted)" }}>Number: </span>
                  #{String(selected.ambassador_number).padStart(3, "0")}
                </div>
              )}

              {/* Application text */}
              <div>
                <p className="text-xs mb-1" style={{ color: "var(--muted)" }}>Application</p>
                <div
                  className="rounded-lg p-3 text-sm"
                  style={{
                    background: "rgba(0,0,0,0.03)",
                    border: "1px solid var(--border)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {selected.application_text || "—"}
                </div>
              </div>

              {/* Social handles */}
              {selected.social_handles && Object.keys(selected.social_handles).length > 0 && (
                <div>
                  <p className="text-xs mb-1" style={{ color: "var(--muted)" }}>Socials</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(selected.social_handles).map(([platform, handle]) => (
                      <span
                        key={platform}
                        className="px-2 py-1 rounded text-xs"
                        style={{ background: "rgba(0,0,0,0.05)", color: "var(--muted)" }}
                      >
                        {platform}: {handle}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Stats */}
              <div className="flex gap-4 text-sm flex-wrap">
                <span style={{ color: "var(--muted)" }}>
                  Waitlist: <strong style={{ color: "var(--foreground)" }}>{selected.referral_stats.waitlist_count}</strong>
                </span>
                <span style={{ color: "var(--muted)" }}>
                  Paid: <strong style={{ color: "var(--foreground)" }}>{selected.referral_stats.paid_count}</strong>
                </span>
                <span style={{ color: "var(--muted)" }}>
                  Pending: <strong style={{ color: "#d97706" }}>${selected.referral_stats.pending_earnings.toFixed(2)}</strong>
                </span>
                <span style={{ color: "var(--muted)" }}>
                  Total: <strong style={{ color: "var(--foreground)" }}>${Number(selected.earnings_total).toFixed(2)}</strong>
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 mt-5">
              {selected.status === "pending" && (
                <>
                  <button
                    onClick={() => handleAction(selected.id, "approve")}
                    disabled={!!actionLoading}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                    style={{
                      background: "linear-gradient(135deg, rgba(34,197,94,0.85), rgba(22,163,74,0.95))",
                      color: "#fff",
                      boxShadow: "0 0 0 1px rgba(34,197,94,0.3), 0 2px 8px rgba(34,197,94,0.25), inset 0 1px 0 rgba(255,255,255,0.2)",
                    }}
                  >
                    {actionLoading === selected.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        Approve
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => handleAction(selected.id, "reject")}
                    disabled={!!actionLoading}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                    style={{
                      background: "rgba(239,68,68,0.1)",
                      color: "#ef4444",
                      border: "1px solid rgba(239,68,68,0.3)",
                    }}
                  >
                    <XCircle className="w-4 h-4" />
                    Reject
                  </button>
                </>
              )}
              {selected.status === "approved" && (
                <button
                  onClick={() => handleAction(selected.id, "revoke")}
                  disabled={!!actionLoading}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                  style={{
                    background: "rgba(239,68,68,0.1)",
                    color: "#ef4444",
                    border: "1px solid rgba(239,68,68,0.3)",
                  }}
                >
                  {actionLoading === selected.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Ban className="w-4 h-4" />
                      Revoke
                    </>
                  )}
                </button>
              )}
              <button
                onClick={() => setSelected(null)}
                className="px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer"
                style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
