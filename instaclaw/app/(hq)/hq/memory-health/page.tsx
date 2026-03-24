"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Brain, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";

interface Aggregates {
  memoryMdAvgBytes: number;
  memoryMdP95Bytes: number;
  sessionsJsonAvgBytes: number;
  sessionsJsonP95Bytes: number;
  avgSessionFiles: number;
  p95SessionFiles: number;
}

interface Health {
  hygieneOk: number;
  hygieneStale: number;
  hygieneNever: number;
  memoryEmpty: number;
  memoryOversized: number;
  memoryStale: number;
  sjBloated: number;
  activeTasksPresent: number;
  earnMdPresent: number;
}

interface VMStats {
  vmName: string;
  memSizeBytes: number;
  memAgeHours: number;
  sessionsJsonBytes: number;
  sessionFileCount: number;
  hygieneAgeHours: number;
  activeTasksExists: boolean;
  earnMdExists: boolean;
}

interface Data {
  fleetTotal: number;
  sampled: number;
  sshErrors: number;
  aggregates: Aggregates;
  health: Health;
  vms: VMStats[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatHours(hours: number): string {
  if (hours < 0) return "Never";
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function StatusDot({ status }: { status: "ok" | "warn" | "bad" }) {
  const colors = { ok: "#16a34a", warn: "#ca8a04", bad: "#dc2626" };
  return (
    <span
      className="inline-block w-2 h-2 rounded-full"
      style={{ backgroundColor: colors[status] }}
    />
  );
}

export default function MemoryHealthPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/hq/memory-health");
      if (!res.ok) throw new Error("Failed to fetch");
      setData(await res.json());
      setError("");
    } catch {
      setError("Failed to load memory health data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="w-5 h-5" style={{ color: "var(--muted)" }} />
          <h1 className="text-lg font-semibold">Memory Health</h1>
          {data && (
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(0,0,0,0.04)", color: "var(--muted)" }}>
              {data.sampled}/{data.fleetTotal} VMs sampled
            </span>
          )}
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-40"
          style={{ background: "rgba(0,0,0,0.06)" }}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && (
        <p className="text-sm px-3 py-2 rounded" style={{ background: "rgba(239,68,68,0.08)", color: "#dc2626" }}>
          {error}
        </p>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card label="MEMORY.md avg" value={formatBytes(data.aggregates.memoryMdAvgBytes)} sub={`p95: ${formatBytes(data.aggregates.memoryMdP95Bytes)}`} />
            <Card label="sessions.json avg" value={formatBytes(data.aggregates.sessionsJsonAvgBytes)} sub={`p95: ${formatBytes(data.aggregates.sessionsJsonP95Bytes)}`} />
            <Card label="Session files avg" value={String(data.aggregates.avgSessionFiles)} sub={`p95: ${data.aggregates.p95SessionFiles}`} />
            <Card
              label="daily_hygiene()"
              value={`${data.health.hygieneOk}/${data.sampled - data.sshErrors}`}
              sub={data.health.hygieneStale > 0 ? `${data.health.hygieneStale} stale` : "all healthy"}
              status={data.health.hygieneStale > 0 ? "warn" : "ok"}
            />
          </div>

          {/* Health indicators */}
          <div className="rounded-lg p-4" style={{ border: "1px solid var(--border)" }}>
            <h2 className="text-sm font-semibold mb-3">Fleet Health Indicators</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <Indicator
                icon={data.health.memoryEmpty === 0 ? <CheckCircle2 className="w-4 h-4" style={{ color: "#16a34a" }} /> : <AlertTriangle className="w-4 h-4" style={{ color: "#ca8a04" }} />}
                label="Empty MEMORY.md"
                value={data.health.memoryEmpty === 0 ? "None" : `${data.health.memoryEmpty} VMs`}
              />
              <Indicator
                icon={data.health.memoryOversized === 0 ? <CheckCircle2 className="w-4 h-4" style={{ color: "#16a34a" }} /> : <AlertTriangle className="w-4 h-4" style={{ color: "#ca8a04" }} />}
                label="Oversized MEMORY.md (>25KB)"
                value={data.health.memoryOversized === 0 ? "None" : `${data.health.memoryOversized} VMs`}
              />
              <Indicator
                icon={data.health.memoryStale === 0 ? <CheckCircle2 className="w-4 h-4" style={{ color: "#16a34a" }} /> : <AlertTriangle className="w-4 h-4" style={{ color: "#ca8a04" }} />}
                label="Stale MEMORY.md (>72h)"
                value={data.health.memoryStale === 0 ? "None" : `${data.health.memoryStale} VMs`}
              />
              <Indicator
                icon={data.health.sjBloated === 0 ? <CheckCircle2 className="w-4 h-4" style={{ color: "#16a34a" }} /> : <XCircle className="w-4 h-4" style={{ color: "#dc2626" }} />}
                label="Bloated sessions.json (>100KB)"
                value={data.health.sjBloated === 0 ? "None" : `${data.health.sjBloated} VMs`}
              />
              <Indicator
                icon={<CheckCircle2 className="w-4 h-4" style={{ color: "#16a34a" }} />}
                label="active-tasks.md present"
                value={`${data.health.activeTasksPresent}/${data.sampled - data.sshErrors}`}
              />
              <Indicator
                icon={<CheckCircle2 className="w-4 h-4" style={{ color: "#16a34a" }} />}
                label="EARN.md present"
                value={`${data.health.earnMdPresent}/${data.sampled - data.sshErrors}`}
              />
            </div>
          </div>

          {/* Per-VM table */}
          <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "rgba(0,0,0,0.02)", borderBottom: "1px solid var(--border)" }}>
                  <th className="text-left px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>VM</th>
                  <th className="text-right px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>MEMORY.md</th>
                  <th className="text-right px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>sessions.json</th>
                  <th className="text-right px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>Sessions</th>
                  <th className="text-right px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>Hygiene</th>
                  <th className="text-center px-4 py-2.5 font-medium" style={{ color: "var(--muted)" }}>Files</th>
                </tr>
              </thead>
              <tbody>
                {data.vms.map((vm) => {
                  const memStatus: "ok" | "warn" | "bad" =
                    vm.memSizeBytes < 200 ? "bad" : vm.memSizeBytes > 25000 ? "warn" : "ok";
                  const sjStatus: "ok" | "warn" | "bad" =
                    vm.sessionsJsonBytes > 100000 ? "bad" : vm.sessionsJsonBytes > 50000 ? "warn" : "ok";
                  const hygieneStatus: "ok" | "warn" | "bad" =
                    vm.hygieneAgeHours < 0 ? "bad" : vm.hygieneAgeHours > 48 ? "warn" : "ok";

                  return (
                    <tr key={vm.vmName} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td className="px-4 py-2 font-mono text-xs">{vm.vmName}</td>
                      <td className="text-right px-4 py-2">
                        <span className="flex items-center justify-end gap-1.5">
                          <StatusDot status={memStatus} />
                          {formatBytes(vm.memSizeBytes)}
                        </span>
                      </td>
                      <td className="text-right px-4 py-2">
                        <span className="flex items-center justify-end gap-1.5">
                          <StatusDot status={sjStatus} />
                          {formatBytes(vm.sessionsJsonBytes)}
                        </span>
                      </td>
                      <td className="text-right px-4 py-2">{vm.sessionFileCount}</td>
                      <td className="text-right px-4 py-2">
                        <span className="flex items-center justify-end gap-1.5">
                          <StatusDot status={hygieneStatus} />
                          {formatHours(vm.hygieneAgeHours)}
                        </span>
                      </td>
                      <td className="text-center px-4 py-2 text-xs" style={{ color: "var(--muted)" }}>
                        {vm.activeTasksExists ? "tasks" : ""}
                        {vm.activeTasksExists && vm.earnMdExists ? " + " : ""}
                        {vm.earnMdExists ? "earn" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {data.sshErrors > 0 && (
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {data.sshErrors} VM(s) unreachable via SSH during sampling.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Card({ label, value, sub, status }: { label: string; value: string; sub: string; status?: "ok" | "warn" | "bad" }) {
  const valueColor = status === "warn" ? "#ca8a04" : status === "bad" ? "#dc2626" : "var(--foreground)";
  return (
    <div className="rounded-lg px-4 py-3" style={{ border: "1px solid var(--border)" }}>
      <div className="text-2xl font-semibold" style={{ color: valueColor }}>{value}</div>
      <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{sub}</div>
    </div>
  );
}

function Indicator({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <div>
        <div className="font-medium">{value}</div>
        <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
      </div>
    </div>
  );
}
