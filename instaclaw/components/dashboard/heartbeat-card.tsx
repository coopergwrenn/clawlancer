"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowUp } from "lucide-react";

// ── Types ───────────────────────────────────────────

interface HeartbeatStatus {
  interval: string;
  lastAt: string | null;
  nextAt: string | null;
  creditsUsedToday: number;
  bufferTotal: number;
  status: string;
  healthStatus: "healthy" | "unhealthy" | "paused";
  vmStatus: string;
}

// ── Constants ───────────────────────────────────────

const INTERVALS = ["1h", "3h", "6h", "12h", "off"] as const;

const INTERVAL_LABELS: Record<string, string> = {
  "1h": "Every hour",
  "3h": "Every 3h",
  "6h": "Every 6h",
  "12h": "Twice a day",
  off: "Off",
};

const INTERVAL_SHORT: Record<string, string> = {
  "1h": "1h",
  "3h": "3h",
  "6h": "6h",
  "12h": "12h",
  off: "Off",
};

// CSS animation duration per interval
const INTERVAL_DURATION: Record<string, string> = {
  "1h": "0.8s",
  "3h": "1.4s",
  "6h": "2s",
  "12h": "3s",
  off: "0s",
};

const HINT_EXAMPLES = [
  "check in every hour",
  "slow down to twice a day",
  "pause heartbeats for now",
  "check in more often",
  "only check in every 6 hours",
];

const POLL_INTERVAL = 30_000;

// ── Helpers ─────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "Just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function countdown(iso: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "Soon";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

// ── Heart SVG ───────────────────────────────────────

function HeartIcon({ color, size = 40 }: { color: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill={color} style={{ width: size, height: size }}>
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}

// ── Main Component ──────────────────────────────────

export default function HeartbeatCard() {
  const [data, setData] = useState<HeartbeatStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [nlInput, setNlInput] = useState("");
  const [nlSending, setNlSending] = useState(false);
  const [nlResponse, setNlResponse] = useState<string | null>(null);
  const [hintIdx, setHintIdx] = useState(0);
  const [sliderValue, setSliderValue] = useState(3); // hours as decimal
  const [sliderDragging, setSliderDragging] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  // Ref-based lock: prevents poll from overwriting slider while dragging OR while an update is in flight
  const skipSliderSyncRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/heartbeat/status");
      if (res.ok) {
        const json = await res.json();
        setData(json);
        // Only sync slider from server when not dragging and no update in flight
        if (!skipSliderSyncRef.current && json.interval !== "off") {
          const match = json.interval.match(/^(\d+(?:\.\d+)?)h$/);
          if (match) setSliderValue(parseFloat(match[1]));
        }
      }
    } catch {
      /* retry next poll */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, POLL_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [fetchStatus]);

  useEffect(() => {
    const t = setInterval(
      () => setHintIdx((i) => (i + 1) % HINT_EXAMPLES.length),
      4000
    );
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const changeInterval = async (interval: string) => {
    if (updating || interval === data?.interval) return;
    skipSliderSyncRef.current = true;
    setUpdating(interval);
    // Sync slider when a pill is clicked
    if (interval !== "off") {
      const m = interval.match(/^(\d+(?:\.\d+)?)h$/);
      if (m) setSliderValue(parseFloat(m[1]));
    }
    try {
      const res = await fetch("/api/heartbeat/update-interval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval }),
      });
      if (res.ok) {
        setToast(interval === "off" ? "Heartbeats paused" : `Interval → ${interval}`);
        // Unlock sync BEFORE fetching so we pick up the new server value
        skipSliderSyncRef.current = false;
        await fetchStatus();
      } else {
        setToast("Failed to update");
        skipSliderSyncRef.current = false;
      }
    } catch {
      setToast("Failed to update");
      skipSliderSyncRef.current = false;
    } finally {
      setUpdating(null);
    }
  };

  // Commit slider value on release
  const commitSlider = async (hours: number) => {
    setSliderDragging(false);
    // Round to 1 decimal for clean display
    const rounded = Math.round(hours * 10) / 10;
    const interval = `${rounded}h`;
    if (interval === data?.interval) {
      skipSliderSyncRef.current = false;
      return;
    }
    await changeInterval(interval);
  };

  const sendNlConfig = async () => {
    if (nlSending || !nlInput.trim()) return;
    setNlSending(true);
    setNlResponse(null);
    try {
      const res = await fetch("/api/heartbeat/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: nlInput.trim() }),
      });
      const json = await res.json();
      if (res.ok) {
        setNlResponse(json.response);
        setNlInput("");
        await fetchStatus();
      } else {
        setNlResponse(json.response || "Something went wrong.");
      }
    } catch {
      setNlResponse("Something went wrong.");
    } finally {
      setNlSending(false);
    }
  };

  // ── Derived ──
  const heartColor =
    data?.healthStatus === "healthy"
      ? "#DC6743"
      : data?.healthStatus === "unhealthy"
        ? "#ef4444"
        : "#9ca3af";
  const isPaused = data?.healthStatus === "paused" || data?.interval === "off";
  // Compute animation duration — interpolate for custom intervals
  const getAnimDuration = () => {
    if (isPaused) return "0s";
    if (INTERVAL_DURATION[data?.interval ?? "3h"]) return INTERVAL_DURATION[data?.interval ?? "3h"];
    const m = data?.interval?.match(/^(\d+(?:\.\d+)?)h$/);
    if (m) {
      const h = parseFloat(m[1]);
      // Clamp between 0.6s (very fast) and 3.5s (very slow)
      return `${Math.max(0.6, Math.min(3.5, h * 0.35))}s`;
    }
    return "1.4s";
  };
  const animDuration = getAnimDuration();

  // ── Loading skeleton ──
  if (loading) {
    return (
      <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="w-10 h-10 rounded-full animate-pulse" style={{ background: "var(--border)" }} />
          <div className="h-3 w-24 rounded animate-pulse" style={{ background: "var(--border)" }} />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const creditsPercent = Math.min(100, (data.creditsUsedToday / data.bufferTotal) * 100);
  const poolRemaining = data.bufferTotal - data.creditsUsedToday;

  return (
    <div className="space-y-5">
      {/* ═══════════════ Pulse Card ═══════════════ */}
      <div
        className="glass rounded-xl overflow-hidden relative"
        style={{ border: "1px solid var(--border)" }}
      >
        {/* Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="absolute top-3 right-3 z-10 px-3 py-1.5 rounded-lg text-xs font-medium"
              style={{ background: "var(--foreground)", color: "var(--background)" }}
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="p-6">
          {/* ── Heart hero ── */}
          <div className="flex flex-col items-center text-center pt-2 pb-6">
            <div className="relative flex items-center justify-center mb-3">
              {/* Soft radial glow */}
              {!isPaused && (
                <div
                  className="absolute rounded-full"
                  style={{
                    width: 72,
                    height: 72,
                    animation: `heartbeat-glow var(--hb-duration) ease-in-out infinite`,
                    ["--hb-duration" as string]: animDuration,
                    background: `radial-gradient(circle, ${heartColor}40 0%, transparent 70%)`,
                    opacity: 0,
                  }}
                />
              )}
              <div
                style={{
                  animation: isPaused
                    ? "none"
                    : `heartbeat-pulse var(--hb-duration) ease-in-out infinite`,
                  ["--hb-duration" as string]: animDuration,
                }}
              >
                <HeartIcon color={heartColor} size={40} />
              </div>
            </div>

            {/* Status badge */}
            <div
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium mb-1"
              style={{
                background: isPaused
                  ? "rgba(0,0,0,0.04)"
                  : data.healthStatus === "unhealthy"
                    ? "rgba(239,68,68,0.08)"
                    : "rgba(220,103,67,0.08)",
                color: isPaused
                  ? "var(--muted)"
                  : data.healthStatus === "unhealthy"
                    ? "#ef4444"
                    : "#DC6743",
                border: isPaused
                  ? "1px solid var(--border)"
                  : data.healthStatus === "unhealthy"
                    ? "1px solid rgba(239,68,68,0.15)"
                    : "1px solid rgba(220,103,67,0.15)",
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  background: isPaused
                    ? "var(--muted)"
                    : data.healthStatus === "unhealthy"
                      ? "#ef4444"
                      : "#22c55e",
                }}
              />
              {isPaused
                ? "Paused"
                : data.healthStatus === "unhealthy"
                  ? "Missed check-in"
                  : "On schedule"}
            </div>

            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {isPaused
                ? "Your agent won\u2019t check in until you turn this back on."
                : data.healthStatus === "unhealthy"
                  ? "Your agent hasn\u2019t checked in for longer than expected."
                  : `Checking in every ${data.interval}`}
            </p>
          </div>

          {/* ── Stats grid ── */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            <StatTile label="Last check-in" value={relativeTime(data.lastAt)} />
            <StatTile label="Next" value={isPaused ? "—" : countdown(data.nextAt)} />
            <StatTile label="Today" value={`${data.creditsUsedToday}`} />
          </div>

          {/* ── Pool bar ── */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium" style={{ color: "var(--foreground)" }}>
                Daily heartbeat pool
              </span>
              <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                {poolRemaining} of {data.bufferTotal} remaining
              </span>
            </div>
            <div
              className="h-2 rounded-full overflow-hidden"
              style={{ background: "rgba(0,0,0,0.06)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${creditsPercent}%`,
                  background:
                    creditsPercent > 80
                      ? "linear-gradient(90deg, #ef4444, #dc2626)"
                      : "linear-gradient(90deg, #DC6743, #c2553a)",
                  transition: "width 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
                }}
              />
            </div>
            <p className="text-[11px] mt-1.5" style={{ color: "var(--muted)" }}>
              Separate from your daily credits — heartbeats never eat into your quota.
            </p>
          </div>

          {/* ── Divider ── */}
          <div style={{ borderTop: "1px solid var(--border)", margin: "0 -24px", marginBottom: 24 }} />

          {/* ── Frequency picker ── */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium" style={{ color: "var(--foreground)" }}>
                Frequency
              </span>
              {updating ? (
                <span
                  className="text-xs tabular-nums font-medium px-2 py-0.5 rounded-md inline-flex items-center gap-1.5"
                  style={{
                    color: "#DC6743",
                    background: "rgba(220,103,67,0.08)",
                  }}
                >
                  <span
                    className="w-3 h-3 rounded-full border-2 border-current"
                    style={{
                      borderTopColor: "transparent",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                  Updating to {updating}…
                </span>
              ) : (
                <span
                  className="text-xs tabular-nums font-medium px-2 py-0.5 rounded-md"
                  style={{
                    color: sliderDragging ? "#DC6743" : "var(--muted)",
                    background: sliderDragging ? "rgba(220,103,67,0.08)" : "transparent",
                    transition: "all 0.15s ease",
                  }}
                >
                  {isPaused
                    ? "Off"
                    : sliderDragging
                      ? `${(Math.round(sliderValue * 10) / 10).toFixed(1)}h`
                      : INTERVAL_LABELS[data.interval] ?? `${data.interval}`}
                </span>
              )}
            </div>

            {/* Preset pills */}
            <div className="flex gap-2 mb-4">
              {INTERVALS.map((iv) => {
                const isActive = data.interval === iv;
                const isLoading = updating === iv;
                return (
                  <button
                    key={iv}
                    onClick={() => changeInterval(iv)}
                    disabled={!!updating}
                    className="flex-1 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer active:scale-[0.97]"
                    style={{
                      background: isActive
                        ? "linear-gradient(135deg, rgba(22,22,22,0.85), rgba(40,40,40,0.92))"
                        : "rgba(0,0,0,0.03)",
                      color: isActive ? "#fff" : "var(--muted)",
                      boxShadow: isActive
                        ? "0 0 0 1px rgba(255,255,255,0.08), 0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.06)"
                        : "0 0 0 1px rgba(0,0,0,0.06)",
                      backdropFilter: "blur(8px)",
                      opacity: isLoading ? 0.5 : 1,
                      textShadow: isActive ? "0 1px 2px rgba(0,0,0,0.3)" : "none",
                    }}
                  >
                    {isLoading ? "..." : INTERVAL_SHORT[iv]}
                  </button>
                );
              })}
            </div>

            {/* Precision slider */}
            <div className="relative">
              {/* Updating shimmer overlay */}
              {updating && (
                <div
                  className="absolute inset-0 z-10 rounded-lg flex items-center justify-center pointer-events-none"
                  style={{
                    background: "rgba(0,0,0,0.5)",
                    backdropFilter: "blur(1px)",
                  }}
                >
                  <span
                    className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                    style={{
                      color: "#DC6743",
                      background: "rgba(220,103,67,0.08)",
                      border: "1px solid rgba(220,103,67,0.15)",
                    }}
                  >
                    Applying via SSH…
                  </span>
                </div>
              )}
              <input
                type="range"
                min={0.5}
                max={12}
                step={0.1}
                value={sliderValue}
                onChange={(e) => {
                  setSliderValue(parseFloat(e.target.value));
                  setSliderDragging(true);
                  skipSliderSyncRef.current = true;
                }}
                onMouseUp={(e) => commitSlider(parseFloat((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => commitSlider(parseFloat((e.target as HTMLInputElement).value))}
                disabled={!!updating || isPaused}
                className="hb-slider"
                style={{
                  background: `linear-gradient(to right, #DC6743 0%, #c2553a ${((sliderValue - 0.5) / 11.5) * 100}%, rgba(0,0,0,0.06) ${((sliderValue - 0.5) / 11.5) * 100}%, rgba(0,0,0,0.06) 100%)`,
                }}
              />
              {/* Scale labels */}
              <div className="flex justify-between mt-1 px-0.5">
                {["0.5h", "3h", "6h", "9h", "12h"].map((label) => (
                  <span
                    key={label}
                    className="text-[9px] tabular-nums"
                    style={{ color: "var(--muted)", opacity: 0.5 }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>

            <p className="text-[11px] mt-2" style={{ color: "var(--muted)" }}>
              More frequent = more responsive, but uses more of the pool above.
            </p>
          </div>

          {/* ── Divider ── */}
          <div style={{ borderTop: "1px solid var(--border)", margin: "0 -24px", marginBottom: 24 }} />

          {/* ── NL config ── */}
          <div>
            <span className="text-xs font-medium" style={{ color: "var(--foreground)" }}>
              Or just tell your agent
            </span>
            <div
              className="flex items-center gap-2 rounded-xl px-4 py-3 mt-2"
              style={{
                background: "rgba(0,0,0,0.02)",
                border: "1px solid var(--border)",
                boxShadow: "inset 0 1px 2px rgba(0,0,0,0.03)",
              }}
            >
              <input
                type="text"
                value={nlInput}
                onChange={(e) => setNlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendNlConfig();
                  }
                }}
                placeholder={HINT_EXAMPLES[hintIdx]}
                disabled={nlSending}
                className="flex-1 bg-transparent text-sm outline-none"
                style={{ color: "var(--foreground)" }}
              />
              <button
                onClick={sendNlConfig}
                disabled={nlSending || !nlInput.trim()}
                className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 cursor-pointer transition-all hover:opacity-80 disabled:opacity-30 disabled:scale-95"
                style={{ background: "var(--accent)" }}
              >
                <ArrowUp className="w-4 h-4" style={{ color: "#ffffff" }} strokeWidth={2.5} />
              </button>
            </div>

            {/* Response bubble */}
            <AnimatePresence>
              {nlResponse && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  className="mt-3 px-4 py-3 rounded-xl text-xs leading-relaxed"
                  style={{
                    background: "rgba(220,103,67,0.05)",
                    border: "1px solid rgba(220,103,67,0.12)",
                    color: "var(--foreground)",
                  }}
                >
                  {nlResponse}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Stat Tile ───────────────────────────────────────

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-lg px-3 py-2.5 text-center"
      style={{
        background: "rgba(0,0,0,0.02)",
        border: "1px solid rgba(0,0,0,0.05)",
      }}
    >
      <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--muted)" }}>
        {label}
      </p>
      <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--foreground)" }}>
        {value}
      </p>
    </div>
  );
}
