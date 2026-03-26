"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Monitor,
  Wifi,
  WifiOff,
  Copy,
  CheckCircle2,
  ChevronDown,
  Terminal as TerminalIcon,
  Clipboard,
} from "lucide-react";

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
  const [showSteps, setShowSteps] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [os] = useState(detectOS);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/vm/dispatch-status");
      const status = await res.json();
      setRelayConnected(!!status.relayConnected);
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

  // Countdown for pairing code
  useEffect(() => {
    if (expiresIn <= 0) return;
    const timer = setInterval(() => {
      setExpiresIn((prev) => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresIn]);

  // Fetch full command fallback
  useEffect(() => {
    async function getCommand() {
      try {
        const res = await fetch("/api/vm/live-session");
        const data = await res.json();
        if (data.token && data.vmIp) {
          setFullCommand(
            `npx @instaclaw/dispatch --token ${data.token} --vm ${data.vmIp}`
          );
        }
      } catch {}
    }
    if (!fullCommand) getCommand();
  }, [fullCommand]);

  function copyToClipboard(text: string, field: string) {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 3000);
  }

  /** Generate pairing code, build npx command, copy to clipboard, show steps */
  async function handleConnect() {
    setGenerating(true);
    try {
      const res = await fetch("/api/vm/dispatch-pair", { method: "POST" });
      const data = await res.json();

      if (data.code) {
        setPairingCode(data.code);
        setExpiresIn(data.expiresIn || 600);
        const cmd = `npx @instaclaw/dispatch@0.5.0 --pair ${data.code}`;
        await navigator.clipboard.writeText(cmd);
        setCopiedField("connect");
        setTimeout(() => setCopiedField(null), 4000);
        setShowSteps(true);
      } else if (data.fallbackCommand) {
        // Pairing table not migrated — use full command
        setFullCommand(data.fallbackCommand);
        await navigator.clipboard.writeText(data.fallbackCommand);
        setCopiedField("connect");
        setTimeout(() => setCopiedField(null), 4000);
        setShowSteps(true);
      }
    } catch {
      // Fallback: just show manual section
      setShowSteps(true);
    } finally {
      setGenerating(false);
    }
  }

  const npxCommand = pairingCode
    ? `npx @instaclaw/dispatch@0.5.0 --pair ${pairingCode}`
    : fullCommand || "npx @instaclaw/dispatch";

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  const pasteKey = os === "mac" ? "Cmd + V" : "Ctrl + V";
  const spotlightKey = os === "mac" ? "Cmd + Space" : "";

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor className="w-5 h-5 text-[var(--accent)] shrink-0" />
          <h3 className="font-semibold whitespace-nowrap">Remote Control</h3>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {checking ? (
            <span className="text-xs text-[var(--muted)]">Checking...</span>
          ) : relayConnected ? (
            <>
              <Wifi className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-xs font-medium text-emerald-600">
                Connected
              </span>
            </>
          ) : (
            <>
              <WifiOff className="w-3.5 h-3.5 text-[var(--muted)]" />
              <span className="text-xs text-[var(--muted)]">Not Connected</span>
            </>
          )}
        </div>
      </div>

      {relayConnected ? (
        <div>
          <p className="text-sm text-emerald-600 mb-2">
            Your agent is connected to your computer and can take screenshots,
            click, and type.
          </p>
          <p className="text-xs text-[var(--muted)]">
            To disconnect, press Ctrl+C in the terminal running the dispatch
            relay.
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-[var(--muted)] mb-5">
            Let your agent control your computer. Take screenshots, click, type,
            and more.
          </p>

          {/* ── Primary: Copy-to-clipboard button ── */}
          {!showSteps ? (
            <button
              onClick={handleConnect}
              disabled={generating}
              className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-xl text-white font-semibold text-base transition-all hover:opacity-90 disabled:opacity-60"
              style={{
                background: "linear-gradient(135deg, var(--accent), #c0553a)",
                boxShadow: "0 4px 12px rgba(220, 103, 67, 0.3)",
              }}
            >
              <Clipboard className="w-5 h-5" />
              {generating ? "Generating..." : "Connect Your Computer"}
            </button>
          ) : (
            /* ── Steps modal (inline) ── */
            <div className="w-full rounded-xl border-2 border-emerald-200 bg-emerald-50/50 dark:bg-emerald-900/10 dark:border-emerald-800 p-5">
              {/* Success header */}
              <div className="flex items-center gap-2 mb-5">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                  Command copied to clipboard!
                </span>
              </div>

              {/* 3 steps */}
              <div className="space-y-4 mb-5">
                <Step
                  number={1}
                  title="Open Terminal"
                  subtitle={
                    os === "mac"
                      ? `Press ${spotlightKey}, type "Terminal", press Enter`
                      : os === "windows"
                      ? 'Press Win + R, type "cmd", press Enter'
                      : "Open your terminal application"
                  }
                  icon={<TerminalIcon className="w-4 h-4" />}
                />
                <Step
                  number={2}
                  title="Paste the command"
                  subtitle={`Press ${pasteKey} in Terminal`}
                  icon={<Clipboard className="w-4 h-4" />}
                />
                <Step
                  number={3}
                  title="Press Enter"
                  subtitle="Your agent will connect automatically"
                  icon={
                    <span className="text-xs font-bold font-mono">⏎</span>
                  }
                />
              </div>

              {/* Command reference block with copy button */}
              <div className="relative">
                <pre className="bg-black/10 dark:bg-black/30 rounded-lg p-3 pr-10 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all text-[var(--foreground)]">
                  {npxCommand}
                </pre>
                <button
                  onClick={() => copyToClipboard(npxCommand, "ref")}
                  className="absolute top-2.5 right-2.5 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                  title="Copy command"
                >
                  {copiedField === "ref" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="w-3.5 h-3.5 text-[var(--muted)]" />
                  )}
                </button>
              </div>

              {/* Pairing code timer */}
              {pairingCode && expiresIn > 0 && (
                <p className="text-xs text-[var(--muted)] mt-2 text-center">
                  Code expires in {formatTime(expiresIn)}
                </p>
              )}
              {pairingCode && expiresIn <= 0 && (
                <button
                  onClick={handleConnect}
                  className="text-xs text-[var(--accent)] underline mt-2 block mx-auto"
                >
                  Generate new code
                </button>
              )}

              {/* macOS permission note */}
              {os === "mac" && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-3 text-center">
                  macOS: You&apos;ll need to grant Accessibility + Screen
                  Recording permissions to Terminal.app.
                </p>
              )}

              {/* Requires Node.js note */}
              <p className="text-xs text-[var(--muted)] mt-2 text-center">
                Requires{" "}
                <a
                  href="https://nodejs.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Node.js 18+
                </a>
              </p>
            </div>
          )}

          {/* ── Collapsed fallback: download .command file ── */}
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <button
              onClick={() => setShowFallback(!showFallback)}
              className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
            >
              <ChevronDown
                className={`w-3 h-3 transition-transform ${
                  showFallback ? "rotate-180" : ""
                }`}
              />
              Or download a connect script
            </button>

            {showFallback && (
              <div className="mt-3 space-y-2">
                <button
                  onClick={() => {
                    window.location.href = `/api/vm/dispatch-connect?os=${os}`;
                  }}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-[var(--border)] hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  Download{" "}
                  {os === "mac"
                    ? ".command"
                    : os === "windows"
                    ? ".bat"
                    : ".sh"}{" "}
                  file
                </button>
                <p className="text-[10px] text-[var(--muted)] text-center">
                  {os === "mac"
                    ? "Note: macOS may show a security warning. Right-click → Open to bypass."
                    : "Double-click to run."}
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Step({
  number,
  title,
  subtitle,
  icon,
}: {
  number: number;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shrink-0 mt-0.5">
        <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
          {number}
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--muted)]">{icon}</span>
          <span className="text-sm font-semibold">{title}</span>
        </div>
        <p className="text-xs text-[var(--muted)] mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}
