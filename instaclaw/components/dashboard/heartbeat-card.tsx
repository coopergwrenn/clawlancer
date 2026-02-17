"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Send } from "lucide-react";

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
  "1h": "1h",
  "3h": "3h",
  "6h": "6h",
  "12h": "12h",
  off: "Off",
};

// CSS animation duration per interval (faster heartbeat = shorter duration)
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
  if (!iso) return "Never";
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
  if (!iso) return "--";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "Soon";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

// ── Heart SVG ───────────────────────────────────────

function HeartIcon({
  color,
  className,
}: {
  color: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={color}
      className={className}
      style={{ width: 32, height: 32 }}
    >
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
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // ── Fetch heartbeat status ──
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/heartbeat/status");
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch {
      // Silent fail — will retry on next poll
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll every 30s
  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, POLL_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [fetchStatus]);

  // Rotate hint placeholder
  useEffect(() => {
    const t = setInterval(
      () => setHintIdx((i) => (i + 1) % HINT_EXAMPLES.length),
      4000
    );
    return () => clearInterval(t);
  }, []);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Interval change ──
  const changeInterval = async (interval: string) => {
    if (updating || interval === data?.interval) return;
    setUpdating(interval);
    try {
      const res = await fetch("/api/heartbeat/update-interval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval }),
      });
      if (res.ok) {
        setToast(
          interval === "off" ? "Heartbeats paused" : `Interval → ${interval}`
        );
        await fetchStatus();
      } else {
        setToast("Failed to update");
      }
    } catch {
      setToast("Failed to update");
    } finally {
      setUpdating(null);
    }
  };

  // ── NL configure ──
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

  // ── Derived values ──
  const heartColor =
    data?.healthStatus === "healthy"
      ? "#DC6743"
      : data?.healthStatus === "unhealthy"
        ? "#ef4444"
        : "#9ca3af";
  const isPaused =
    data?.healthStatus === "paused" || data?.interval === "off";
  const animDuration = isPaused
    ? "0s"
    : INTERVAL_DURATION[data?.interval ?? "3h"] ?? "1.4s";

  if (loading) {
    return (
      <div
        className="glass rounded-xl p-5 mb-4"
        style={{ border: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full animate-pulse"
            style={{ background: "var(--border)" }}
          />
          <div
            className="h-4 w-32 rounded animate-pulse"
            style={{ background: "var(--border)" }}
          />
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div
      className="glass rounded-xl overflow-hidden relative mb-4"
      style={{ border: "1px solid var(--border)" }}
    >
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="absolute top-2 right-2 z-10 px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{
              background: "var(--foreground)",
              color: "var(--background)",
            }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="p-4 sm:p-5">
        {/* ── Header: Heart + Title ── */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex items-center justify-center">
            {/* Glow ring */}
            {!isPaused && (
              <div
                className="absolute inset-0 rounded-full"
                style={{
                  animation: `heartbeat-glow var(--hb-duration) ease-in-out infinite`,
                  ["--hb-duration" as string]: animDuration,
                  background: heartColor,
                  filter: "blur(8px)",
                  opacity: 0,
                }}
              />
            )}
            {/* Heart */}
            <div
              style={{
                animation: isPaused
                  ? "none"
                  : `heartbeat-pulse var(--hb-duration) ease-in-out infinite`,
                ["--hb-duration" as string]: animDuration,
              }}
            >
              <HeartIcon color={heartColor} />
            </div>
          </div>
          <div>
            <h3
              className="text-sm font-semibold"
              style={{ color: "var(--foreground)" }}
            >
              Heartbeat
            </h3>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {isPaused
                ? "Paused"
                : data.healthStatus === "unhealthy"
                  ? "Missed check-in"
                  : `Every ${data.interval}`}
            </p>
          </div>
        </div>

        {/* ── Stats Row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <StatCell label="Last" value={relativeTime(data.lastAt)} />
          <StatCell label="Next" value={isPaused ? "--" : countdown(data.nextAt)} />
          <StatCell label="Today" value={`${data.creditsUsedToday}`} />
          {/* Buffer usage bar */}
          <div>
            <p
              className="text-[10px] uppercase tracking-wider mb-1"
              style={{ color: "var(--muted)" }}
            >
              Buffer
            </p>
            <div className="flex items-center gap-2">
              <div
                className="flex-1 h-1.5 rounded-full overflow-hidden"
                style={{ background: "var(--border)" }}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, (data.creditsUsedToday / data.bufferTotal) * 100)}%`,
                    background:
                      data.creditsUsedToday / data.bufferTotal > 0.8
                        ? "#ef4444"
                        : "#DC6743",
                  }}
                />
              </div>
              <span
                className="text-[10px] tabular-nums"
                style={{ color: "var(--muted)" }}
              >
                {data.creditsUsedToday}/{data.bufferTotal}
              </span>
            </div>
          </div>
        </div>

        {/* ── Interval Pills ── */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {INTERVALS.map((iv) => {
            const isActive = data.interval === iv;
            const isLoading = updating === iv;
            return (
              <button
                key={iv}
                onClick={() => changeInterval(iv)}
                disabled={!!updating}
                className="px-3 py-1 rounded-full text-xs font-medium transition-all cursor-pointer"
                style={{
                  background: isActive
                    ? "var(--foreground)"
                    : "rgba(0,0,0,0.04)",
                  color: isActive
                    ? "var(--background)"
                    : "var(--muted)",
                  border: isActive
                    ? "1px solid var(--foreground)"
                    : "1px solid var(--border)",
                  opacity: isLoading ? 0.5 : 1,
                }}
              >
                {isLoading ? "..." : INTERVAL_LABELS[iv]}
                {isActive && !isLoading ? " \u2713" : ""}
              </button>
            );
          })}
        </div>

        {/* ── NL Mini-Chat ── */}
        <div>
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-2"
            style={{
              background: "rgba(0,0,0,0.02)",
              border: "1px solid var(--border)",
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
              style={{
                color: "var(--foreground)",
              }}
            />
            <button
              onClick={sendNlConfig}
              disabled={nlSending || !nlInput.trim()}
              className="shrink-0 p-1 rounded-md transition-opacity cursor-pointer"
              style={{
                opacity: nlInput.trim() ? 1 : 0.3,
                color: "var(--muted)",
              }}
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Response bubble */}
          <AnimatePresence>
            {nlResponse && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                className="mt-2 px-3 py-2 rounded-lg text-xs"
                style={{
                  background: "rgba(220,103,67,0.06)",
                  border: "1px solid rgba(220,103,67,0.15)",
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
  );
}

// ── Stat Cell ───────────────────────────────────────

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p
        className="text-[10px] uppercase tracking-wider mb-0.5"
        style={{ color: "var(--muted)" }}
      >
        {label}
      </p>
      <p
        className="text-sm font-medium tabular-nums"
        style={{ color: "var(--foreground)" }}
      >
        {value}
      </p>
    </div>
  );
}
