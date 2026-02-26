"use client";

import { useState, useCallback, useRef } from "react";
import {
  Server,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Rocket,
  SkipForward,
  AlertTriangle,
  Copy,
  Check,
} from "lucide-react";

type Phase = "idle" | "checking" | "ready" | "canary" | "canary_done" | "fleet" | "fleet_done";

interface VersionInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

interface StepEvent {
  step: string;
  status: "running" | "done" | "error" | "skipped";
  detail?: string;
  error?: string;
  version?: string;
  vmId?: string;
  ip?: string;
  batchNum?: number;
  totalBatches?: number;
  upgraded?: number;
  skipped?: number;
  failed?: number;
  failedVms?: { id: string; error: string }[];
  totalVms?: number;
  sweepMatched?: number;
  sweepMismatched?: number;
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors"
      style={{ background: "rgba(0,0,0,0.04)" }}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

async function readSSEStream(
  url: string,
  body: Record<string, unknown>,
  onEvent: (evt: StepEvent) => void,
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

export default function FleetUpgradePage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [error, setError] = useState("");
  const [canaryEvents, setCanaryEvents] = useState<StepEvent[]>([]);
  const [fleetEvents, setFleetEvents] = useState<StepEvent[]>([]);
  const [canaryResult, setCanaryResult] = useState<StepEvent | null>(null);
  const [fleetResult, setFleetResult] = useState<StepEvent | null>(null);
  const canaryVmId = useRef<string | null>(null);

  const checkForUpdates = useCallback(async () => {
    setPhase("checking");
    setError("");
    try {
      const res = await fetch("/api/hq/openclaw/check-update");
      if (!res.ok) throw new Error("Failed to check");
      const data = await res.json();
      setVersionInfo(data);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setPhase("idle");
    }
  }, []);

  const startCanary = useCallback(async () => {
    if (!versionInfo) return;
    setPhase("canary");
    setCanaryEvents([]);
    setCanaryResult(null);
    setError("");

    try {
      await readSSEStream(
        "/api/hq/openclaw/upgrade-canary",
        { version: versionInfo.latest },
        (evt) => {
          setCanaryEvents((prev) => {
            const idx = prev.findIndex((e) => e.step === evt.step);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = evt;
              return next;
            }
            return [...prev, evt];
          });

          if (evt.vmId && evt.step === "complete") canaryVmId.current = evt.vmId;

          if (evt.step === "complete" && evt.status === "done") {
            setCanaryResult(evt);
            setPhase("canary_done");
          }
          if (evt.step === "error") {
            setCanaryResult(evt);
            setPhase("canary_done");
          }
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setPhase("canary_done");
    }
  }, [versionInfo]);

  const startFleet = useCallback(async () => {
    if (!versionInfo) return;
    setPhase("fleet");
    setFleetEvents([]);
    setFleetResult(null);
    setError("");

    try {
      await readSSEStream(
        "/api/hq/openclaw/upgrade-fleet",
        {
          version: versionInfo.latest,
          canaryVmId: canaryVmId.current,
        },
        (evt) => {
          setFleetEvents((prev) => {
            const key =
              evt.vmId ? `${evt.step}:${evt.vmId}` :
              evt.batchNum ? `${evt.step}:${evt.batchNum}` :
              evt.step;
            const idx = prev.findIndex((e) => {
              const eKey =
                e.vmId ? `${e.step}:${e.vmId}` :
                e.batchNum ? `${e.step}:${e.batchNum}` :
                e.step;
              return eKey === key;
            });
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = evt;
              return next;
            }
            return [...prev, evt];
          });

          if (evt.step === "complete") {
            setFleetResult(evt);
            setPhase("fleet_done");
          }
          if (evt.step === "error") {
            setFleetResult(evt);
            setPhase("fleet_done");
          }
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setPhase("fleet_done");
    }
  }, [versionInfo]);

  const canaryFailed = canaryResult?.status === "error";
  const pinCommand = versionInfo
    ? `Update the openclaw version pins in lib/ssh.ts, lib/cloud-init.ts, and scripts/open-spots.sh from ${versionInfo.current} to ${versionInfo.latest}, then commit and push.`
    : "";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Server className="w-5 h-5" style={{ color: "var(--muted)" }} />
        <h1 className="text-lg font-semibold">Fleet Upgrade</h1>
      </div>

      {/* Phase 1: Check */}
      <div
        className="rounded-xl p-5 space-y-4"
        style={{ background: "#ffffff", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-medium text-sm">OpenClaw Version</h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
              Check for new releases and manage fleet upgrades
            </p>
          </div>
          <button
            onClick={checkForUpdates}
            disabled={phase === "checking" || phase === "canary" || phase === "fleet"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-opacity disabled:opacity-40"
            style={{ background: "rgba(0,0,0,0.06)" }}
          >
            {phase === "checking" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Check for Updates
          </button>
        </div>

        {error && phase === "idle" && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "#ef4444" }}>
            <AlertTriangle className="w-4 h-4" />
            {error}
          </div>
        )}

        {versionInfo && phase !== "idle" && phase !== "checking" && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="px-2 py-0.5 rounded text-xs font-mono" style={{ background: "rgba(0,0,0,0.04)" }}>
                v{versionInfo.current}
              </span>
              {versionInfo.updateAvailable ? (
                <>
                  <ArrowRight className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
                  <span
                    className="px-2 py-0.5 rounded text-xs font-mono font-medium"
                    style={{ background: "rgba(34,197,94,0.1)", color: "#16a34a" }}
                  >
                    v{versionInfo.latest}
                  </span>
                  <span className="text-xs" style={{ color: "#16a34a" }}>
                    Update available
                  </span>
                </>
              ) : (
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  Fleet is on latest
                </span>
              )}
            </div>

            {versionInfo.updateAvailable && phase === "ready" && (
              <button
                onClick={startCanary}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity"
                style={{ background: "#2563eb" }}
              >
                <Rocket className="w-3.5 h-3.5" />
                Start Canary Upgrade
              </button>
            )}
          </div>
        )}
      </div>

      {/* Phase 2: Canary */}
      {(phase === "canary" || phase === "canary_done" || phase === "fleet" || phase === "fleet_done") && (
        <div
          className="rounded-xl p-5 space-y-3"
          style={{ background: "#ffffff", border: "1px solid var(--border)" }}
        >
          <h2 className="font-medium text-sm">Canary Upgrade</h2>
          <div className="space-y-1.5">
            {canaryEvents.map((evt, i) => (
              <div key={`${evt.step}-${i}`} className="flex items-center gap-2 text-xs">
                <StatusIcon status={evt.status} />
                <span className="font-mono" style={{ color: "var(--muted)" }}>
                  {evt.step}
                </span>
                <span className="truncate">{evt.error ?? evt.detail}</span>
              </div>
            ))}
          </div>

          {canaryResult && !canaryFailed && phase === "canary_done" && (
            <div className="pt-2 space-y-3">
              <div
                className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg"
                style={{ background: "rgba(34,197,94,0.08)", color: "#16a34a" }}
              >
                <CheckCircle2 className="w-4 h-4" />
                Canary passed — ready to deploy fleet
              </div>
              <button
                onClick={startFleet}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity"
                style={{ background: "#2563eb" }}
              >
                <Server className="w-3.5 h-3.5" />
                Deploy to Full Fleet
              </button>
            </div>
          )}

          {canaryFailed && (
            <div
              className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg"
              style={{ background: "rgba(239,68,68,0.08)", color: "#ef4444" }}
            >
              <XCircle className="w-4 h-4" />
              Canary failed — fleet upgrade blocked
            </div>
          )}
        </div>
      )}

      {/* Phase 3: Fleet */}
      {(phase === "fleet" || phase === "fleet_done") && (
        <div
          className="rounded-xl p-5 space-y-3"
          style={{ background: "#ffffff", border: "1px solid var(--border)" }}
        >
          <h2 className="font-medium text-sm">Fleet Upgrade</h2>

          {fleetEvents.some((e) => e.upgraded !== undefined) && (
            <div className="flex gap-4 text-xs">
              <span style={{ color: "#16a34a" }}>
                Upgraded: {fleetEvents.filter((e) => e.step === "batch" && e.status === "done").slice(-1)[0]?.upgraded ?? 0}
              </span>
              <span style={{ color: "var(--muted)" }}>
                Skipped: {fleetEvents.filter((e) => e.step === "batch" && e.status === "done").slice(-1)[0]?.skipped ?? 0}
              </span>
              <span style={{ color: "#ef4444" }}>
                Failed: {fleetEvents.filter((e) => e.step === "batch" && e.status === "done").slice(-1)[0]?.failed ?? 0}
              </span>
            </div>
          )}

          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {fleetEvents.map((evt, i) => (
              <div key={`${evt.step}-${evt.vmId ?? evt.batchNum ?? i}`} className="flex items-center gap-2 text-xs">
                <StatusIcon status={evt.status} />
                <span className="font-mono shrink-0" style={{ color: "var(--muted)" }}>
                  {evt.vmId ? evt.ip : evt.step}
                </span>
                <span className="truncate">{evt.error ?? evt.detail}</span>
              </div>
            ))}
          </div>

          {fleetResult && fleetResult.step === "complete" && (
            <div className="pt-2 space-y-3">
              <div
                className="text-sm px-3 py-2 rounded-lg"
                style={{ background: "rgba(34,197,94,0.08)", color: "#16a34a" }}
              >
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  Fleet upgrade complete
                </div>
                <div className="mt-1 text-xs space-x-3">
                  <span>{fleetResult.upgraded} upgraded</span>
                  <span>{fleetResult.skipped} skipped</span>
                  <span>{fleetResult.failed} failed</span>
                  <span>({fleetResult.totalVms} total)</span>
                </div>
              </div>

              {fleetResult.failedVms && fleetResult.failedVms.length > 0 && (
                <div
                  className="text-xs px-3 py-2 rounded-lg space-y-1"
                  style={{ background: "rgba(239,68,68,0.06)", color: "#ef4444" }}
                >
                  <div className="font-medium">Failed VMs:</div>
                  {fleetResult.failedVms.map((fv) => (
                    <div key={fv.id} className="font-mono">
                      {fv.id}: {fv.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {fleetResult?.step === "error" && (
            <div
              className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg"
              style={{ background: "rgba(239,68,68,0.08)", color: "#ef4444" }}
            >
              <XCircle className="w-4 h-4" />
              Fleet upgrade error: {fleetResult.error}
            </div>
          )}
        </div>
      )}

      {/* Version pin reminder — shown after fleet or canary completes */}
      {(phase === "fleet_done" || (phase === "canary_done" && !canaryFailed)) && versionInfo && (
        <div
          className="rounded-xl p-5 space-y-3"
          style={{ background: "#fffbeb", border: "1px solid #fde68a" }}
        >
          <div className="flex items-center gap-2 text-sm font-medium" style={{ color: "#92400e" }}>
            <AlertTriangle className="w-4 h-4" />
            Version pins need updating
          </div>
          <p className="text-xs" style={{ color: "#92400e" }}>
            Fleet upgraded to v{versionInfo.latest}. Update version pins before provisioning new VMs.
            Paste this into Claude Code:
          </p>
          <div className="flex items-start gap-2">
            <code
              className="flex-1 text-xs p-2.5 rounded-lg block whitespace-pre-wrap"
              style={{ background: "#fef3c7", color: "#78350f" }}
            >
              {pinCommand}
            </code>
            <CopyButton text={pinCommand} />
          </div>
        </div>
      )}

      {error && phase !== "idle" && (
        <div
          className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg"
          style={{ background: "rgba(239,68,68,0.08)", color: "#ef4444" }}
        >
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}
    </div>
  );
}
