"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Wrench,
  ChevronDown,
  ChevronRight,
  Activity,
} from "lucide-react";

interface CheckResult {
  category: string;
  name: string;
  status: "pass" | "fail" | "warning";
  severity: "critical" | "warning" | "info";
  detail?: string;
  fixable?: boolean;
}

interface AuditRow {
  id: string;
  vm_id: string;
  created_at: string;
  overall_status: "pass" | "fail" | "degraded";
  critical_count: number;
  warning_count: number;
  checks: CheckResult[];
  fixed_count: number;
  vm_name?: string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  pass: { bg: "rgba(34,197,94,0.08)", text: "#16a34a", border: "rgba(34,197,94,0.2)" },
  degraded: { bg: "rgba(234,179,8,0.08)", text: "#ca8a04", border: "rgba(234,179,8,0.2)" },
  fail: { bg: "rgba(239,68,68,0.08)", text: "#dc2626", border: "rgba(239,68,68,0.2)" },
};

const CHECK_STATUS_ICON: Record<string, React.ReactNode> = {
  pass: <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "#16a34a" }} />,
  fail: <XCircle className="w-3.5 h-3.5" style={{ color: "#dc2626" }} />,
  warning: <AlertTriangle className="w-3.5 h-3.5" style={{ color: "#ca8a04" }} />,
};

export default function FleetHealthPage() {
  const [audits, setAudits] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [fixingVm, setFixingVm] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const fetchAudits = useCallback(async () => {
    try {
      const res = await fetch("/api/hq/fleet-health");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setAudits(data.audits ?? []);
      setError("");
    } catch {
      setError("Failed to load audit data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAudits();
  }, [fetchAudits]);

  async function handleValidateAll() {
    setValidating(true);
    try {
      const res = await fetch("/api/hq/fleet-health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "validate_all" }),
      });
      if (!res.ok) throw new Error("Validation failed");
      await fetchAudits();
    } catch {
      setError("Validation request failed");
    } finally {
      setValidating(false);
    }
  }

  async function handleFixVM(vmId: string) {
    setFixingVm(vmId);
    try {
      const res = await fetch("/api/hq/fleet-health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fix_vm", vmId }),
      });
      if (!res.ok) throw new Error("Fix failed");
      await fetchAudits();
    } catch {
      setError(`Fix failed for ${vmId}`);
    } finally {
      setFixingVm(null);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  const summary = {
    total: audits.length,
    pass: audits.filter((a) => a.overall_status === "pass").length,
    degraded: audits.filter((a) => a.overall_status === "degraded").length,
    fail: audits.filter((a) => a.overall_status === "fail").length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="w-5 h-5" style={{ color: "var(--muted)" }} />
          <h1 className="text-lg font-semibold">Fleet Health</h1>
        </div>
        <button
          onClick={handleValidateAll}
          disabled={validating}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-40"
          style={{ background: "rgba(0,0,0,0.06)" }}
        >
          <RefreshCw className={`w-4 h-4 ${validating ? "animate-spin" : ""}`} />
          {validating ? "Validating..." : "Validate All"}
        </button>
      </div>

      {error && (
        <p className="text-sm px-3 py-2 rounded" style={{ background: "rgba(239,68,68,0.08)", color: "#dc2626" }}>
          {error}
        </p>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Total", value: summary.total, color: "var(--muted)" },
          { label: "Pass", value: summary.pass, color: "#16a34a" },
          { label: "Degraded", value: summary.degraded, color: "#ca8a04" },
          { label: "Fail", value: summary.fail, color: "#dc2626" },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-lg px-4 py-3 text-center"
            style={{ border: "1px solid var(--border)" }}
          >
            <div className="text-2xl font-semibold" style={{ color: card.color }}>
              {card.value}
            </div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              {card.label}
            </div>
          </div>
        ))}
      </div>

      {/* Audit table */}
      {audits.length === 0 ? (
        <p className="text-sm text-center py-10" style={{ color: "var(--muted)" }}>
          No audit data yet. Click &quot;Validate All&quot; to run the first fleet validation.
        </p>
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "rgba(0,0,0,0.02)", borderBottom: "1px solid var(--border)" }}>
                <th className="text-left px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>VM</th>
                <th className="text-center px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>Status</th>
                <th className="text-center px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>Critical</th>
                <th className="text-center px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>Warnings</th>
                <th className="text-center px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>Fixed</th>
                <th className="text-left px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>Last Audit</th>
                <th className="text-center px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {audits.map((audit) => {
                const colors = STATUS_COLORS[audit.overall_status] ?? STATUS_COLORS.fail;
                const isExpanded = expanded.has(audit.id);
                return (
                  <Fragment key={audit.id}>
                    <tr
                      className="cursor-pointer transition-colors hover:opacity-80"
                      style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}` }}
                      onClick={() => toggleExpand(audit.id)}
                    >
                      <td className="px-4 py-2.5 font-medium flex items-center gap-2">
                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        {audit.vm_name ?? audit.vm_id.slice(0, 8)}
                      </td>
                      <td className="text-center px-4 py-2.5">
                        <span
                          className="px-2 py-0.5 rounded-full text-xs font-medium"
                          style={{ background: colors.border, color: colors.text }}
                        >
                          {audit.overall_status}
                        </span>
                      </td>
                      <td className="text-center px-4 py-2.5" style={{ color: audit.critical_count > 0 ? "#dc2626" : "var(--muted)" }}>
                        {audit.critical_count}
                      </td>
                      <td className="text-center px-4 py-2.5" style={{ color: audit.warning_count > 0 ? "#ca8a04" : "var(--muted)" }}>
                        {audit.warning_count}
                      </td>
                      <td className="text-center px-4 py-2.5" style={{ color: audit.fixed_count > 0 ? "#16a34a" : "var(--muted)" }}>
                        {audit.fixed_count}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: "var(--muted)" }}>
                        {new Date(audit.created_at).toLocaleString()}
                      </td>
                      <td className="text-center px-4 py-2.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleFixVM(audit.vm_id);
                          }}
                          disabled={fixingVm === audit.vm_id || audit.overall_status === "pass"}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-opacity disabled:opacity-30"
                          style={{ background: "rgba(0,0,0,0.06)" }}
                        >
                          <Wrench className={`w-3 h-3 ${fixingVm === audit.vm_id ? "animate-spin" : ""}`} />
                          Fix
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} className="px-8 py-3" style={{ background: "rgba(0,0,0,0.01)" }}>
                          <div className="grid gap-1 text-xs">
                            {audit.checks.map((check, i) => (
                              <div key={i} className="flex items-center gap-2 py-0.5">
                                {CHECK_STATUS_ICON[check.status]}
                                <span className="font-mono" style={{ color: "var(--muted)", minWidth: 80 }}>
                                  {check.category}
                                </span>
                                <span className="font-medium">{check.name}</span>
                                {check.detail && (
                                  <span style={{ color: "var(--muted)" }}>— {check.detail}</span>
                                )}
                                {check.fixable && check.status === "fail" && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: "rgba(34,197,94,0.1)", color: "#16a34a" }}>
                                    auto-fixable
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

