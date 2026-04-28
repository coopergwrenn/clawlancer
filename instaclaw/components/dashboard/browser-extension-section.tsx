"use client";

import { useState, useEffect } from "react";
import { Globe, Copy, CheckCircle2, ExternalLink } from "lucide-react";

interface Props {
  gatewayUrl: string;
}

export function BrowserExtensionSection({ gatewayUrl }: Props) {
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/vm/extension-status");
        const data = await res.json();
        if (!cancelled) setConnected(!!data.connected);
      } catch {
        if (!cancelled) setConnected(false);
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

  // Derive gateway token display (masked)
  const gatewayTokenDisplay = "••••••••••••";

  return (
    <div>
      <h2
        className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        <Globe className="w-5 h-5" /> Connect Your Browser
      </h2>
      <div className="glass rounded-xl p-6 space-y-5" style={{ border: "1px solid var(--border)" }}>
        {/* Status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{
                background: checking ? "#f59e0b" : connected ? "#22c55e" : "#6b7280",
                boxShadow: connected ? "0 0 8px rgba(34,197,94,0.4)" : "none",
              }}
            />
            <span className="text-sm font-medium">
              {checking ? "Checking..." : connected ? "Extension Connected" : "Not Connected"}
            </span>
          </div>
          {connected && (
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: "rgba(34,197,94,0.1)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.2)" }}
            >
              Live
            </span>
          )}
        </div>

        {/* Description */}
        <p className="text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
          Connect your Chrome browser so your agent can browse sites you&apos;re logged into —
          Instagram, Facebook, banking, and more. Install the extension, enter your Gateway URL below,
          and your agent will use your real browser sessions.
        </p>

        {/* Install Options */}
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            Install Extension
          </p>

          {/* Option 1: InstaClaw Extension */}
          <div
            className="rounded-lg p-4 flex items-center justify-between"
            style={{ background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.15)" }}
          >
            <div className="flex-1 mr-4">
              <p className="text-sm font-medium">InstaClaw Browser Relay</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Our official extension. Auto-connects all tabs.
              </p>
            </div>
            <a
              href="https://chromewebstore.google.com/detail/ondclglahfaiajfomkhmpdnocadfkdpo"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5"
              style={{ background: "var(--accent)", color: "#fff" }}
            >
              Chrome Store <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {/* Option 2: OpenClaw Extension (community) */}
          <div
            className="rounded-lg p-4 flex items-center justify-between"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}
          >
            <div className="flex-1 mr-4">
              <p className="text-sm font-medium">OpenClaw Browser Relay</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Community extension. Click-to-attach individual tabs.
              </p>
            </div>
            <a
              href="https://chromewebstore.google.com/detail/clawbot-browser-relay/eghcbfdmabkgekppcigoclfgncjakbci"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5"
              style={{ background: "rgba(255,255,255,0.06)", color: "var(--foreground)", border: "1px solid var(--border)" }}
            >
              Chrome Store <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {/* Gateway URL for extension config */}
        {gatewayUrl && (
          <div className="space-y-3 pt-2">
            <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Extension Settings
            </p>
            <div
              className="rounded-lg p-3 flex items-center justify-between"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs" style={{ color: "var(--muted)" }}>Gateway URL</p>
                <p className="text-sm font-mono truncate mt-0.5">{gatewayUrl}</p>
              </div>
              <button
                onClick={() => copyToClipboard(gatewayUrl, "url")}
                className="ml-3 p-1.5 rounded-md transition-colors shrink-0 cursor-pointer"
                style={{ background: "rgba(255,255,255,0.06)" }}
                title="Copy Gateway URL"
              >
                {copiedField === "url" ? (
                  <CheckCircle2 className="w-4 h-4" style={{ color: "#22c55e" }} />
                ) : (
                  <Copy className="w-4 h-4" style={{ color: "var(--muted)" }} />
                )}
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Paste this URL into the extension&apos;s options page. For the Gateway Token,
              find it in your VM&apos;s control panel or ask your agent to check its token.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
