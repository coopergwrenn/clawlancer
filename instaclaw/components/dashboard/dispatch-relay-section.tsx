"use client";

import { useState, useEffect, useCallback } from "react";
import { Monitor, Wifi, WifiOff, Copy, CheckCircle2, RefreshCw, ChevronDown } from "lucide-react";

export function DispatchRelaySection() {
  const [relayConnected, setRelayConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [fullCommand, setFullCommand] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const [statusRes, pairRes] = await Promise.all([
        fetch("/api/vm/dispatch-status"),
        fetch("/api/vm/dispatch-pair"),
      ]);
      const status = await statusRes.json();
      const pair = await pairRes.json();

      setRelayConnected(!!status.relayConnected);
      if (pair.code) {
        setPairingCode(pair.code);
        setExpiresIn(pair.expiresIn || 0);
      }
      if (pair.fallbackCommand) {
        setFullCommand(pair.fallbackCommand);
      }
    } catch {
      setRelayConnected(false);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Countdown timer
  useEffect(() => {
    if (expiresIn <= 0) return;
    const timer = setInterval(() => {
      setExpiresIn((prev) => {
        if (prev <= 1) {
          // Code expired — fetch new one
          fetchStatus();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresIn, fetchStatus]);

  // Fetch full command for advanced section
  useEffect(() => {
    async function getCommand() {
      try {
        const res = await fetch("/api/vm/live-session");
        const data = await res.json();
        if (data.token && data.vmIp) {
          setFullCommand(`npx @instaclaw/dispatch --token ${data.token} --vm ${data.vmIp}`);
        }
      } catch {}
    }
    getCommand();
  }, []);

  function copyToClipboard(text: string, field: string) {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Monitor className="w-5 h-5 text-[var(--accent)]" />
          <h3 className="font-semibold">Remote Computer Control</h3>
        </div>
        <div className="flex items-center gap-2">
          {checking ? (
            <span className="text-xs text-[var(--muted)]">Checking...</span>
          ) : relayConnected ? (
            <>
              <Wifi className="w-4 h-4 text-emerald-500" />
              <span className="text-xs font-medium text-emerald-600">Relay Connected</span>
            </>
          ) : (
            <>
              <WifiOff className="w-4 h-4 text-[var(--muted)]" />
              <span className="text-xs text-[var(--muted)]">Not Connected</span>
            </>
          )}
        </div>
      </div>

      {relayConnected ? (
        <p className="text-sm text-emerald-600 mb-4">
          Your agent is connected to your computer and can take screenshots, click, and type.
        </p>
      ) : (
        <>
          <p className="text-sm text-[var(--muted)] mb-4">
            Let your agent control your computer. Run this in your terminal:
          </p>

          {/* Step 1: Pairing Code */}
          {pairingCode && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-[var(--muted)]">Your pairing code:</span>
                {expiresIn > 0 && (
                  <span className="text-xs text-[var(--muted)]">expires in {formatTime(expiresIn)}</span>
                )}
              </div>

              {/* Big pairing code + copy button */}
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <pre className="bg-black/5 rounded-lg p-4 text-center text-2xl font-mono font-bold tracking-widest">
                    {pairingCode}
                  </pre>
                  <button
                    onClick={() => copyToClipboard(`npx @instaclaw/dispatch --pair ${pairingCode}`, "pair")}
                    className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-black/10 transition-colors"
                    title="Copy command with pairing code"
                  >
                    {copiedField === "pair" ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <Copy className="w-4 h-4 text-[var(--muted)]" />
                    )}
                  </button>
                </div>
              </div>

              <p className="text-xs text-[var(--muted)] mt-2">
                Run <code className="bg-black/5 px-1 rounded">npx @instaclaw/dispatch --pair {pairingCode}</code> in your terminal
              </p>
            </div>
          )}

          {/* Advanced: Full command */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors mt-2"
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
            Advanced: copy full command
          </button>

          {showAdvanced && fullCommand && (
            <div className="relative mt-2">
              <pre className="bg-black/5 rounded-lg p-3 pr-10 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
                {fullCommand}
              </pre>
              <button
                onClick={() => copyToClipboard(fullCommand, "cmd")}
                className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-black/10 transition-colors"
              >
                {copiedField === "cmd" ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                ) : (
                  <Copy className="w-4 h-4 text-[var(--muted)]" />
                )}
              </button>
            </div>
          )}

          {/* Platform-specific note */}
          <p className="text-xs text-[var(--muted)] mt-3">
            {typeof navigator !== "undefined" && navigator.platform?.includes("Mac")
              ? "Requires Node.js 18+. macOS: grant Accessibility + Screen Recording to your terminal app."
              : "Requires Node.js 18+."}
          </p>
        </>
      )}
    </div>
  );
}
