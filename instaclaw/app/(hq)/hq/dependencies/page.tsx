"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Package,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Info,
  Upload,
  Zap,
  Server,
  XCircle,
  SkipForward,
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

interface FleetEvent {
  step: string;
  status: "running" | "done" | "error" | "skipped";
  detail?: string;
  error?: string;
  vmId?: string;
  ip?: string;
  batchNum?: number;
  totalBatches?: number;
  succeeded?: number;
  failed?: number;
  totalVms?: number;
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

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--muted)" }} />;
    case "done":
      return <CheckCircle2 className="w-4 h-4" style={{ color: "#22c55e" }} />;
    case "error":
      return <XCircle className="w-4 h-4" style={{ color: "#ef4444" }} />;
    case "skipped":
      return <SkipForward className="w-4 h-4" style={{ color: "var(--muted)" }} />;
    default:
      return null;
  }
}

async function readSSEStream(
  url: string,
  body: Record<string, unknown>,
  onEvent: (evt: FleetEvent) => void,
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6));
          onEvent(data);
        } catch {
          // Skip malformed events
        }
      }
    }
  }
}

export default function DependenciesPage() {
  const [deps, setDeps] = useState<Dep[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkingSingle, setCheckingSingle] = useState<string | null>(null);
  const [filter, setFilter] = useState<Category>("all");
  const [tooltip, setTooltip] = useState<string | null>(null);

  // Update state
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  // Modal state
  const [stripeConfirm, setStripeConfirm] = useState<Dep | null>(null);
  const [markUpdatedDep, setMarkUpdatedDep] = useState<Dep | null>(null);
  const [markUpdatedNote, setMarkUpdatedNote] = useState("");
  const [markUpdatedVersion, setMarkUpdatedVersion] = useState("");
  const [markUpdatedLoading, setMarkUpdatedLoading] = useState(false);

  // Fleet deploy state
  const [fleetDeployDep, setFleetDeployDep] = useState<Dep | null>(null);
  const [fleetDeployPhase, setFleetDeployPhase] = useState<"confirm" | "deploying" | "done">("confirm");
  const [fleetEvents, setFleetEvents] = useState<FleetEvent[]>([]);
  const [fleetResult, setFleetResult] = useState<FleetEvent | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fleetLogRef = useRef<HTMLDivElement>(null);

  function showToast(message: string, type: "success" | "error") {
    setToast({ message, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

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

  async function updateNpm(dep: Dep) {
    setUpdatingId(dep.id);
    try {
      const res = await fetch("/api/hq/dependencies/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: dep.id }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`${dep.name} bumped to ${dep.latest_version} (${data.commit_sha?.slice(0, 7)})`, "success");
        await fetchDeps();
      } else {
        showToast(data.error || "Update failed", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Update failed", "error");
    } finally {
      setUpdatingId(null);
      setStripeConfirm(null);
    }
  }

  async function updateAllSafe() {
    const safeDeps = deps.filter(
      (d) =>
        d.status === "behind" &&
        d.check_type === "npm" &&
        (d.update_impact === "low" || d.update_impact === "medium") &&
        d.name !== "Stripe",
    );
    if (safeDeps.length === 0) return;

    setUpdatingAll(true);
    try {
      const res = await fetch("/api/hq/dependencies/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: safeDeps.map((d) => d.id) }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Bumped ${data.bumped?.length || safeDeps.length} deps (${data.commit_sha?.slice(0, 7)})`, "success");
        await fetchDeps();
      } else {
        showToast(data.error || "Batch update failed", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Batch update failed", "error");
    } finally {
      setUpdatingAll(false);
    }
  }

  async function markUpdated() {
    if (!markUpdatedDep) return;
    setMarkUpdatedLoading(true);
    try {
      const res = await fetch("/api/hq/dependencies/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: markUpdatedDep.id,
          new_version: markUpdatedVersion,
          notes: markUpdatedNote,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`${markUpdatedDep.name} marked as updated`, "success");
        await fetchDeps();
        setMarkUpdatedDep(null);
        setMarkUpdatedNote("");
        setMarkUpdatedVersion("");
      } else {
        showToast(data.error || "Failed to mark updated", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setMarkUpdatedLoading(false);
    }
  }

  async function startFleetDeploy(dep: Dep) {
    setFleetDeployPhase("deploying");
    setFleetEvents([]);
    setFleetResult(null);

    try {
      await readSSEStream(
        "/api/hq/dependencies/fleet-deploy",
        { depId: dep.id },
        (evt) => {
          setFleetEvents((prev) => [...prev, evt]);
          if (evt.step === "complete" || (evt.step === "error" && !evt.vmId)) {
            setFleetResult(evt);
            setFleetDeployPhase("done");
          }
          // Auto-scroll
          setTimeout(() => {
            fleetLogRef.current?.scrollTo({ top: fleetLogRef.current.scrollHeight, behavior: "smooth" });
          }, 50);
        },
      );
    } catch (err) {
      setFleetResult({
        step: "error",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      setFleetDeployPhase("done");
    }

    await fetchDeps();
  }

  const filtered = filter === "all" ? deps : deps.filter((d) => d.category === filter);

  const counts = {
    current: deps.filter((d) => d.status === "current").length,
    behind: deps.filter((d) => d.status === "behind").length,
    anomaly: deps.filter((d) => d.status === "anomaly").length,
    unknown: deps.filter((d) => d.status === "unknown" || d.status === "manual").length,
  };

  const safeBehindCount = deps.filter(
    (d) =>
      d.status === "behind" &&
      d.check_type === "npm" &&
      (d.update_impact === "low" || d.update_impact === "medium") &&
      d.name !== "Stripe",
  ).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-6 right-6 z-50 px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg"
            style={{ background: toast.type === "success" ? "#16a34a" : "#ef4444", color: "#fff" }}
          >
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>

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
        <div className="flex items-center gap-2">
          {safeBehindCount > 0 && (
            <button
              onClick={updateAllSafe}
              disabled={updatingAll || updatingId !== null}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-50"
              style={{ background: "rgba(34,197,94,0.1)", color: "#16a34a" }}
            >
              {updatingAll ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Zap className="w-4 h-4" />
              )}
              {updatingAll ? "Updating..." : `Update All Safe (${safeBehindCount})`}
            </button>
          )}
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
                      {/* Update action buttons */}
                      {dep.status === "behind" && dep.check_type === "npm" && (
                        <button
                          onClick={() => {
                            if (dep.name === "Stripe") {
                              setStripeConfirm(dep);
                            } else {
                              updateNpm(dep);
                            }
                          }}
                          disabled={updatingId === dep.id || updatingAll}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-opacity disabled:opacity-50"
                          style={{ background: "rgba(34,197,94,0.1)", color: "#16a34a" }}
                          title="Update via npm"
                        >
                          {updatingId === dep.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Upload className="w-3 h-3" />
                          )}
                          Update
                        </button>
                      )}
                      {dep.status === "behind" && dep.check_type === "pypi" && (
                        <button
                          onClick={() => {
                            setFleetDeployDep(dep);
                            setFleetDeployPhase("confirm");
                            setFleetEvents([]);
                            setFleetResult(null);
                          }}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
                          style={{ background: "rgba(59,130,246,0.1)", color: "#2563eb" }}
                          title="Deploy to fleet"
                        >
                          <Server className="w-3 h-3" />
                          Fleet Deploy
                        </button>
                      )}
                      {dep.status === "behind" && dep.check_type !== "npm" && dep.check_type !== "pypi" && (
                        <button
                          onClick={() => {
                            setMarkUpdatedDep(dep);
                            setMarkUpdatedVersion(dep.latest_version || "");
                            setMarkUpdatedNote("");
                          }}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
                          style={{ background: "rgba(0,0,0,0.04)", color: "var(--muted)" }}
                          title="Mark as updated"
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Mark Updated
                        </button>
                      )}
                      {/* Existing action buttons */}
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

      {/* Modal 1: Stripe Confirmation */}
      {stripeConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setStripeConfirm(null)}
        >
          <div
            className="rounded-xl p-6 w-full max-w-md space-y-4"
            style={{ background: "#fff" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ background: "rgba(234,179,8,0.1)" }}
              >
                <AlertTriangle className="w-5 h-5" style={{ color: "#ca8a04" }} />
              </div>
              <h2 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
                Update Stripe SDK?
              </h2>
            </div>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Stripe 20.4.x removes <code className="text-xs bg-black/5 px-1 py-0.5 rounded">SubscriptionItemUsageRecord</code>,{" "}
              <code className="text-xs bg-black/5 px-1 py-0.5 rounded">retrieveUpcoming</code>, and{" "}
              <code className="text-xs bg-black/5 px-1 py-0.5 rounded">listUpcomingLines</code>.
              Confirm you&apos;ve verified we don&apos;t use these before updating.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setStripeConfirm(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium"
                style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => updateNpm(stripeConfirm)}
                disabled={updatingId !== null}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-50"
                style={{ background: "#ca8a04", color: "#fff" }}
              >
                {updatingId ? <Loader2 className="w-4 h-4 animate-spin" /> : "Update Anyway"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Mark Updated */}
      {markUpdatedDep && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setMarkUpdatedDep(null)}
        >
          <div
            className="rounded-xl p-6 w-full max-w-md space-y-4"
            style={{ background: "#fff" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
              Mark {markUpdatedDep.name} as Updated
            </h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                  New version / date
                </label>
                <input
                  type="text"
                  value={markUpdatedVersion}
                  onChange={(e) => setMarkUpdatedVersion(e.target.value)}
                  className="w-full mt-1 px-3 py-2 rounded-lg text-sm"
                  style={{ border: "1px solid var(--border)", background: "#fff", color: "var(--foreground)" }}
                  placeholder="e.g. 2026-03-09 or v2.1.0"
                />
              </div>
              <div>
                <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                  What changed?
                </label>
                <textarea
                  value={markUpdatedNote}
                  onChange={(e) => setMarkUpdatedNote(e.target.value)}
                  className="w-full mt-1 px-3 py-2 rounded-lg text-sm"
                  style={{ border: "1px solid var(--border)", background: "#fff", color: "var(--foreground)" }}
                  rows={3}
                  placeholder="Optional notes about the update"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setMarkUpdatedDep(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium"
                style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)" }}
              >
                Cancel
              </button>
              <button
                onClick={markUpdated}
                disabled={markUpdatedLoading || !markUpdatedVersion.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-50"
                style={{ background: "#16a34a", color: "#fff" }}
              >
                {markUpdatedLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 3: Fleet Deploy */}
      {fleetDeployDep && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => {
            if (fleetDeployPhase !== "deploying") {
              setFleetDeployDep(null);
            }
          }}
        >
          <div
            className="rounded-xl p-6 w-full max-w-lg space-y-4"
            style={{ background: "#fff" }}
            onClick={(e) => e.stopPropagation()}
          >
            {fleetDeployPhase === "confirm" && (
              <>
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center"
                    style={{ background: "rgba(59,130,246,0.1)" }}
                  >
                    <Server className="w-5 h-5" style={{ color: "#2563eb" }} />
                  </div>
                  <h2 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
                    Fleet Deploy: {fleetDeployDep.name}
                  </h2>
                </div>
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  This will run the following command on all assigned VMs:
                </p>
                <pre
                  className="px-3 py-2 rounded-lg text-xs overflow-x-auto"
                  style={{ background: "rgba(0,0,0,0.04)", color: "var(--foreground)" }}
                >
                  python3 -m pip install --break-system-packages &quot;{fleetDeployDep.check_target}=={fleetDeployDep.latest_version}&quot;
                </pre>
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    onClick={() => setFleetDeployDep(null)}
                    className="px-4 py-2 rounded-lg text-sm font-medium"
                    style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)" }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => startFleetDeploy(fleetDeployDep)}
                    className="px-4 py-2 rounded-lg text-sm font-medium"
                    style={{ background: "#2563eb", color: "#fff" }}
                  >
                    Deploy to Fleet
                  </button>
                </div>
              </>
            )}

            {(fleetDeployPhase === "deploying" || fleetDeployPhase === "done") && (
              <>
                <h2 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
                  {fleetDeployPhase === "deploying" ? "Deploying..." : "Deploy Complete"}
                </h2>
                <div
                  ref={fleetLogRef}
                  className="max-h-80 overflow-y-auto space-y-1 rounded-lg p-3"
                  style={{ background: "rgba(0,0,0,0.03)" }}
                >
                  {fleetEvents.map((evt, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <StatusIcon status={evt.status} />
                      <span style={{ color: evt.status === "error" ? "#ef4444" : "var(--foreground)" }}>
                        {evt.detail || evt.error || evt.step}
                      </span>
                    </div>
                  ))}
                  {fleetDeployPhase === "deploying" && fleetEvents.length === 0 && (
                    <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Starting...
                    </div>
                  )}
                </div>
                {fleetDeployPhase === "done" && fleetResult && (
                  <div
                    className="rounded-lg p-3 text-sm font-medium"
                    style={{
                      background: fleetResult.status === "done" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      color: fleetResult.status === "done" ? "#16a34a" : "#ef4444",
                    }}
                  >
                    {fleetResult.succeeded !== undefined
                      ? `${fleetResult.succeeded} succeeded, ${fleetResult.failed} failed out of ${fleetResult.totalVms} VMs`
                      : fleetResult.error || "Unknown result"}
                  </div>
                )}
                {fleetDeployPhase === "done" && (
                  <div className="flex items-center justify-end pt-2">
                    <button
                      onClick={() => setFleetDeployDep(null)}
                      className="px-4 py-2 rounded-lg text-sm font-medium"
                      style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)" }}
                    >
                      Close
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
