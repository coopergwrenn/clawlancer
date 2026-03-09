"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Package,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Info,
} from "lucide-react";

interface Dep {
  id: string;
  name: string;
  description: string | null;
  category: string;
  check_type: string;
  check_target: string | null;
  repo_url: string | null;
  our_version: string | null;
  latest_version: string | null;
  is_behind: boolean;
  status: string;
  update_impact: string;
  auto_update_enabled: boolean;
  notes: string | null;
  last_checked_at: string | null;
}

type Category = "all" | "core" | "skill" | "npm" | "api" | "infra";

const CATEGORY_LABELS: Record<Category, string> = {
  all: "All",
  core: "Core",
  skill: "Skills",
  npm: "NPM",
  api: "APIs",
  infra: "Infra",
};

const STATUS_COLORS: Record<string, string> = {
  current: "#22c55e",
  behind: "#eab308",
  anomaly: "#ef4444",
  unknown: "#9ca3af",
  manual: "#9ca3af",
};

const IMPACT_COLORS: Record<string, { bg: string; text: string }> = {
  high: { bg: "rgba(239,68,68,0.1)", text: "#ef4444" },
  medium: { bg: "rgba(234,179,8,0.1)", text: "#ca8a04" },
  low: { bg: "rgba(34,197,94,0.1)", text: "#16a34a" },
};

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function DependenciesPage() {
  const [deps, setDeps] = useState<Dep[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkingSingle, setCheckingSingle] = useState<string | null>(null);
  const [filter, setFilter] = useState<Category>("all");
  const [tooltip, setTooltip] = useState<string | null>(null);

  const fetchDeps = useCallback(async () => {
    try {
      const res = await fetch("/api/hq/dependencies/check");
      if (!res.ok) return;
      const data = await res.json();
      setDeps(data.dependencies || []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDeps();
    const interval = setInterval(fetchDeps, 30000);
    return () => clearInterval(interval);
  }, [fetchDeps]);

  async function checkAll() {
    setChecking(true);
    try {
      await fetch("/api/hq/dependencies/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      await fetchDeps();
    } finally {
      setChecking(false);
    }
  }

  async function checkOne(id: string) {
    setCheckingSingle(id);
    try {
      await fetch("/api/hq/dependencies/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await fetchDeps();
    } finally {
      setCheckingSingle(null);
    }
  }

  const filtered = filter === "all" ? deps : deps.filter((d) => d.category === filter);

  const counts = {
    current: deps.filter((d) => d.status === "current").length,
    behind: deps.filter((d) => d.status === "behind").length,
    anomaly: deps.filter((d) => d.status === "anomaly").length,
    unknown: deps.filter((d) => d.status === "unknown" || d.status === "manual").length,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background: "rgba(0,0,0,0.04)" }}
          >
            <Package className="w-5 h-5" style={{ color: "var(--muted)" }} />
          </div>
          <div>
            <h1 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
              Dependencies
            </h1>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              External projects, APIs, and packages InstaClaw depends on
            </p>
          </div>
        </div>
        <button
          onClick={checkAll}
          disabled={checking}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-50"
          style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)" }}
        >
          {checking ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          {checking ? "Checking..." : "Check All"}
        </button>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-4 gap-3">
        {([
          { label: "Current", count: counts.current, color: "#22c55e" },
          { label: "Behind", count: counts.behind, color: "#eab308" },
          { label: "Anomaly", count: counts.anomaly, color: "#ef4444" },
          { label: "Unknown", count: counts.unknown, color: "#9ca3af" },
        ] as const).map((s) => (
          <div
            key={s.label}
            className="rounded-xl p-4 text-center"
            style={{ background: "#ffffff", border: "1px solid var(--border)" }}
          >
            <div className="text-2xl font-semibold" style={{ color: s.color }}>
              {s.count}
            </div>
            <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1">
        {(Object.keys(CATEGORY_LABELS) as Category[]).map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className="px-3 py-1.5 rounded-lg text-sm transition-colors"
            style={{
              background: filter === cat ? "rgba(0,0,0,0.06)" : "transparent",
              color: filter === cat ? "var(--foreground)" : "var(--muted)",
            }}
          >
            {CATEGORY_LABELS[cat]}
          </button>
        ))}
      </div>

      {/* Table */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: "#ffffff", border: "1px solid var(--border)" }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th className="text-left px-4 py-3 font-medium" style={{ color: "var(--muted)" }}>
                Name
              </th>
              <th className="text-left px-4 py-3 font-medium" style={{ color: "var(--muted)" }}>
                Description
              </th>
              <th className="text-left px-4 py-3 font-medium" style={{ color: "var(--muted)" }}>
                Ours
              </th>
              <th className="text-left px-4 py-3 font-medium" style={{ color: "var(--muted)" }}>
                Latest
              </th>
              <th className="text-left px-4 py-3 font-medium" style={{ color: "var(--muted)" }}>
                Status
              </th>
              <th className="text-left px-4 py-3 font-medium" style={{ color: "var(--muted)" }}>
                Impact
              </th>
              <th className="text-left px-4 py-3 font-medium" style={{ color: "var(--muted)" }}>
                Checked
              </th>
              <th className="text-right px-4 py-3 font-medium" style={{ color: "var(--muted)" }}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((dep) => {
              const rowBorder =
                dep.status === "anomaly"
                  ? "3px solid #ef4444"
                  : dep.is_behind && dep.update_impact === "high"
                    ? "3px solid #eab308"
                    : "3px solid transparent";
              const impactStyle = IMPACT_COLORS[dep.update_impact] || IMPACT_COLORS.low;

              return (
                <tr
                  key={dep.id}
                  style={{
                    borderBottom: "1px solid var(--border)",
                    borderLeft: rowBorder,
                  }}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium" style={{ color: "var(--foreground)" }}>
                        {dep.name}
                      </span>
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] uppercase font-medium"
                        style={{ background: "rgba(0,0,0,0.04)", color: "var(--muted)" }}
                      >
                        {dep.category}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3" style={{ color: "var(--muted)" }}>
                    {dep.description || "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: "var(--foreground)" }}>
                    {dep.our_version || "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: "var(--foreground)" }}>
                    {dep.latest_version || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5">
                      {dep.status === "current" && (
                        <CheckCircle2 className="w-3.5 h-3.5" style={{ color: STATUS_COLORS.current }} />
                      )}
                      {dep.status === "behind" && (
                        <AlertTriangle className="w-3.5 h-3.5" style={{ color: STATUS_COLORS.behind }} />
                      )}
                      {dep.status === "anomaly" && (
                        <AlertTriangle className="w-3.5 h-3.5" style={{ color: STATUS_COLORS.anomaly }} />
                      )}
                      <span
                        className="text-xs capitalize"
                        style={{ color: STATUS_COLORS[dep.status] || "#9ca3af" }}
                      >
                        {dep.status}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="px-2 py-0.5 rounded-full text-[11px] font-medium uppercase"
                      style={{ background: impactStyle.bg, color: impactStyle.text }}
                    >
                      {dep.update_impact}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: "var(--muted)" }}>
                    {timeAgo(dep.last_checked_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => checkOne(dep.id)}
                        disabled={checkingSingle === dep.id || checking}
                        className="p-1.5 rounded transition-colors hover:bg-black/5 disabled:opacity-40"
                        title="Check now"
                      >
                        {checkingSingle === dep.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--muted)" }} />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
                        )}
                      </button>
                      {dep.repo_url && (
                        <a
                          href={dep.repo_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded transition-colors hover:bg-black/5"
                          title="Open repo"
                        >
                          <ExternalLink className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
                        </a>
                      )}
                      {dep.notes && (
                        <button
                          className="p-1.5 rounded transition-colors hover:bg-black/5 relative"
                          onMouseEnter={() => setTooltip(dep.id)}
                          onMouseLeave={() => setTooltip(null)}
                          title={dep.notes}
                        >
                          <Info className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
                          {tooltip === dep.id && (
                            <div
                              className="absolute right-0 top-8 z-10 w-64 p-2.5 rounded-lg text-xs text-left"
                              style={{
                                background: "#1a1a1a",
                                color: "#fff",
                                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                              }}
                            >
                              {dep.notes}
                            </div>
                          )}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center" style={{ color: "var(--muted)" }}>
                  No dependencies in this category.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
