"use client";

import { useState, useEffect } from "react";
import { Globe, Copy, CheckCircle2, ExternalLink, Info, ShieldCheck, AlertTriangle } from "lucide-react";
import Link from "next/link";

interface Props {
  gatewayUrl: string;
}

type ExtensionStatus = "checking" | "connected" | "disconnected" | "unavailable" | "no_vm";

export function BrowserExtensionSection({ gatewayUrl }: Props) {
  const [status, setStatus] = useState<ExtensionStatus>("checking");
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/vm/extension-status");
        const data = await res.json();
        if (cancelled) return;
        if (data?.status === "unavailable" || data?.available === false && data?.status !== "no_vm") {
          setStatus("unavailable");
        } else if (data?.status === "no_vm") {
          setStatus("no_vm");
        } else if (data?.connected) {
          setStatus("connected");
        } else {
          setStatus("disconnected");
        }
      } catch {
        if (!cancelled) setStatus("unavailable");
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

  const isUnavailable = status === "unavailable";
  const isConnected = status === "connected";
  const isChecking = status === "checking";

  return (
    <div>
      <h2
        className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        <Globe className="w-5 h-5" /> Connect Your Browser
        <span
          className="text-[10px] uppercase tracking-[0.12em] font-medium px-1.5 py-0.5 rounded-md ml-1"
          style={{
            background: "rgba(245,158,11,0.12)",
            color: "#f59e0b",
            border: "1px solid rgba(245,158,11,0.25)",
            letterSpacing: "0.12em",
          }}
        >
          Beta
        </span>
      </h2>
      <div className="glass rounded-xl p-6 space-y-5" style={{ border: "1px solid var(--border)" }}>
        {/* Beta risk disclosure */}
        <div
          className="flex gap-3 p-3.5 rounded-lg"
          style={{
            background: "rgba(245,158,11,0.06)",
            border: "1px solid rgba(245,158,11,0.2)",
          }}
        >
          <Info
            className="w-4 h-4 shrink-0 mt-0.5"
            style={{ color: "#f59e0b" }}
            aria-hidden="true"
          />
          <p className="text-xs leading-relaxed" style={{ color: "var(--foreground)" }}>
            <span className="font-medium">Browser Relay is in beta.</span>{" "}
            <span style={{ color: "var(--muted)" }}>
              When you attach a tab, your agent has full access to whatever you&apos;re
              logged into — it can read what you can read and click what you can click. Be
              mindful which tabs you attach.{" "}
            </span>
            <Link
              href="/browser-relay"
              className="underline underline-offset-2"
              style={{ color: "#f59e0b" }}
            >
              Read the safety guide
            </Link>
            <span style={{ color: "var(--muted)" }}> before connecting sensitive accounts.</span>
          </p>
        </div>

        {/* Status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{
                background: isChecking
                  ? "#f59e0b"
                  : isConnected
                  ? "#22c55e"
                  : isUnavailable
                  ? "#f59e0b"
                  : "#6b7280",
                boxShadow: isConnected ? "0 0 8px rgba(34,197,94,0.4)" : "none",
              }}
            />
            <span className="text-sm font-medium">
              {isChecking
                ? "Checking..."
                : isConnected
                ? "Extension Connected"
                : isUnavailable
                ? "Service Temporarily Unavailable"
                : "Not Connected"}
            </span>
          </div>
          {isConnected && (
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: "rgba(34,197,94,0.1)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.2)" }}
            >
              Live
            </span>
          )}
        </div>

        {/* Maintenance banner — shown only when the relay backend isn't reachable */}
        {isUnavailable && (
          <div
            className="flex gap-3 p-3.5 rounded-lg"
            style={{
              background: "rgba(245,158,11,0.06)",
              border: "1px solid rgba(245,158,11,0.25)",
            }}
          >
            <AlertTriangle
              className="w-4 h-4 shrink-0 mt-0.5"
              style={{ color: "#b8770b" }}
              aria-hidden="true"
            />
            <div className="text-xs leading-relaxed">
              <p className="font-medium mb-1" style={{ color: "var(--foreground)" }}>
                We&apos;re upgrading the relay backend.
              </p>
              <p style={{ color: "var(--muted)" }}>
                If you&apos;ve already installed the extension and it shows
                &ldquo;Cannot reach relay&rdquo; — that&apos;s on us, not your URL or
                token. We&apos;ll surface here when it&apos;s back. Hold off
                installing for now.{" "}
                <a
                  href="mailto:help@instaclaw.io?subject=Browser%20Relay%20status"
                  className="underline underline-offset-2"
                  style={{ color: "var(--foreground)" }}
                >
                  Email us
                </a>{" "}
                if you have questions or want a heads-up when it&apos;s live.
              </p>
            </div>
          </div>
        )}

        {/* Description — only shown when service is available */}
        {!isUnavailable && (
          <p className="text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
            Connect your Chrome browser so your agent can browse sites you&apos;re logged into —
            Instagram, Facebook, banking, and more. Install the extension, enter your Gateway URL below,
            and your agent will use your real browser sessions.
          </p>
        )}

        {/* Install Options — hidden during maintenance to avoid wasted installs */}
        {!isUnavailable && (
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
        )}

        {/* Gateway URL for extension config */}
        {!isUnavailable && gatewayUrl && (
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

        {/* Safety tips */}
        <div className="space-y-3 pt-4" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" style={{ color: "var(--muted)" }} aria-hidden="true" />
            <p
              className="text-xs font-medium uppercase tracking-wider"
              style={{ color: "var(--muted)" }}
            >
              Tips for safe use
            </p>
          </div>
          <ul
            className="space-y-2 text-xs leading-relaxed pl-1"
            style={{ color: "var(--muted)" }}
          >
            <li className="flex gap-2">
              <span style={{ color: "var(--accent)" }} aria-hidden="true">·</span>
              <span>
                Start with low-stakes tabs (search, news, docs) before attaching email,
                banking, or exchange accounts.
              </span>
            </li>
            <li className="flex gap-2">
              <span style={{ color: "var(--accent)" }} aria-hidden="true">·</span>
              <span>
                Review every action before approving in supervised mode. Detach
                sensitive tabs before large purchases or transfers — re-attach when
                you want the agent involved again.
              </span>
            </li>
            <li className="flex gap-2">
              <span style={{ color: "var(--accent)" }} aria-hidden="true">·</span>
              <span>
                Websites can hide instructions in their content trying to redirect your
                agent. Watch for unexpected actions and disconnect if something feels
                off.
              </span>
            </li>
            <li className="flex gap-2">
              <span style={{ color: "var(--accent)" }} aria-hidden="true">·</span>
              <span>
                Something looks wrong?{" "}
                <a
                  href="mailto:help@instaclaw.io?subject=Browser%20Relay%20issue"
                  className="underline underline-offset-2"
                  style={{ color: "var(--foreground)" }}
                >
                  Email help@instaclaw.io
                </a>{" "}
                or read the{" "}
                <Link
                  href="/browser-relay"
                  className="underline underline-offset-2"
                  style={{ color: "var(--foreground)" }}
                >
                  full guide
                </Link>
                .
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
