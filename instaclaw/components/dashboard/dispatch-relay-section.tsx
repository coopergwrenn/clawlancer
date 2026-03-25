"use client";

import { useState, useEffect } from "react";
import { Monitor, Wifi, WifiOff, Copy, CheckCircle2 } from "lucide-react";

export function DispatchRelaySection() {
  const [relayConnected, setRelayConnected] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);
  const [checking, setChecking] = useState(true);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/vm/dispatch-status");
        const data = await res.json();
        if (!cancelled) {
          setRelayConnected(!!data.relayConnected);
          setServerRunning(!!data.dispatchServer);
        }
      } catch {
        if (!cancelled) {
          setRelayConnected(false);
          setServerRunning(false);
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    check();
    const interval = setInterval(check, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  function copyToClipboard(text: string, field: string) {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  const installCommand = `npx @instaclaw/dispatch`;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
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

      <p className="text-sm text-[var(--muted)] mb-4">
        Let your agent control your computer — take screenshots, click, type, and more.
        Run this command in your terminal to connect:
      </p>

      <div className="relative">
        <pre className="bg-black/5 rounded-lg p-3 pr-10 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
          {installCommand}
        </pre>
        <button
          onClick={() => copyToClipboard(installCommand, "cmd")}
          className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-black/10 transition-colors"
          title="Copy command"
        >
          {copiedField === "cmd" ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          ) : (
            <Copy className="w-4 h-4 text-[var(--muted)]" />
          )}
        </button>
      </div>

      {!relayConnected && !checking && (
        <p className="text-xs text-[var(--muted)] mt-3">
          Requires Node.js 18+. macOS users need to grant Accessibility and Screen Recording permissions.
        </p>
      )}
    </div>
  );
}
