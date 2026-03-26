"use client";

import { useState, useEffect, useCallback } from "react";
import { Monitor, Wifi, WifiOff, Copy, CheckCircle2, Download, ChevronDown, Apple, Terminal as TerminalIcon } from "lucide-react";

function detectOS(): "mac" | "windows" | "linux" {
  if (typeof navigator === "undefined") return "mac";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("win")) return "windows";
  return "linux";
}

export function DispatchRelaySection() {
  const [relayConnected, setRelayConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [fullCommand, setFullCommand] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [os] = useState(detectOS);

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

  // Countdown
  useEffect(() => {
    if (expiresIn <= 0) return;
    const timer = setInterval(() => {
      setExpiresIn((prev) => {
        if (prev <= 1) { fetchStatus(); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresIn, fetchStatus]);

  // Fetch full command
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
    if (!fullCommand) getCommand();
  }, [fullCommand]);

  function copyToClipboard(text: string, field: string) {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  function handleDownload() {
    // Trigger file download via the API
    window.location.href = `/api/vm/dispatch-connect?os=${os}`;
    setDownloaded(true);
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
        <div>
          <p className="text-sm text-emerald-600 mb-2">
            Your agent is connected to your computer and can take screenshots, click, and type.
          </p>
          <p className="text-xs text-[var(--muted)]">
            To disconnect, press Ctrl+C in the terminal running the dispatch relay.
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-[var(--muted)] mb-5">
            Let your agent control your computer — take screenshots, click, type, and more.
          </p>

          {/* Big "Connect Your Computer" button */}
          {!downloaded ? (
            <button
              onClick={handleDownload}
              className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-xl text-white font-semibold text-base transition-all hover:opacity-90"
              style={{
                background: "linear-gradient(135deg, var(--accent), #c0553a)",
                boxShadow: "0 4px 12px rgba(220, 103, 67, 0.3)",
              }}
            >
              <Download className="w-5 h-5" />
              Connect Your Computer
            </button>
          ) : (
            <div className="w-full rounded-xl border-2 border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-800 p-4 text-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400 mb-1">
                File downloaded!
              </p>
              <p className="text-xs text-emerald-600 dark:text-emerald-500">
                {os === "mac"
                  ? "Double-click instaclaw-connect.command in your Downloads folder."
                  : os === "windows"
                  ? "Double-click instaclaw-connect.bat in your Downloads folder."
                  : "Run: bash ~/Downloads/instaclaw-connect.sh"}
              </p>
              <button
                onClick={() => setDownloaded(false)}
                className="text-xs text-emerald-500 underline mt-2"
              >
                Download again
              </button>
            </div>
          )}

          <p className="text-xs text-[var(--muted)] mt-3 text-center">
            Downloads a small script. {os === "mac" ? "Double-click to open in Terminal." : os === "windows" ? "Double-click to run." : "Run in your terminal."} Requires{" "}
            <a href="https://nodejs.org" target="_blank" rel="noopener noreferrer" className="underline">
              Node.js
            </a>
            .
          </p>

          {/* macOS permission note */}
          {os === "mac" && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 text-center">
              macOS: You&apos;ll need to grant Accessibility + Screen Recording permissions to Terminal.app.
            </p>
          )}

          {/* Manual / power user section */}
          <div className="mt-4 border-t border-[var(--border)] pt-4">
            <button
              onClick={() => setShowManual(!showManual)}
              className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${showManual ? "rotate-180" : ""}`} />
              Or connect manually
            </button>

            {showManual && (
              <div className="mt-3 space-y-3">
                {/* Pairing code */}
                {pairingCode && (
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-[var(--muted)]">Pairing code:</span>
                      {expiresIn > 0 && (
                        <span className="text-xs text-[var(--muted)]">({formatTime(expiresIn)})</span>
                      )}
                    </div>
                    <div className="relative">
                      <pre className="bg-black/5 rounded-lg p-3 text-center text-lg font-mono font-bold tracking-widest">
                        {pairingCode}
                      </pre>
                      <button
                        onClick={() => copyToClipboard(`npx @instaclaw/dispatch --pair ${pairingCode}`, "pair")}
                        className="absolute top-2 right-2 p-1 rounded hover:bg-black/10"
                      >
                        {copiedField === "pair" ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5 text-[var(--muted)]" />
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-[var(--muted)] mt-1">
                      <code className="bg-black/5 px-1 rounded text-[10px]">npx @instaclaw/dispatch --pair {pairingCode}</code>
                    </p>
                  </div>
                )}

                {/* Full command */}
                {fullCommand && (
                  <div>
                    <span className="text-xs font-medium text-[var(--muted)]">Full command:</span>
                    <div className="relative mt-1">
                      <pre className="bg-black/5 rounded-lg p-2 pr-8 text-[10px] font-mono overflow-x-auto whitespace-pre-wrap break-all">
                        {fullCommand}
                      </pre>
                      <button
                        onClick={() => copyToClipboard(fullCommand, "cmd")}
                        className="absolute top-1.5 right-1.5 p-1 rounded hover:bg-black/10"
                      >
                        {copiedField === "cmd" ? (
                          <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                        ) : (
                          <Copy className="w-3 h-3 text-[var(--muted)]" />
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
