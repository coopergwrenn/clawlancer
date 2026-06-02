"use client";

/**
 * Dev-only preview for the AgentChat component on /deploying.
 *
 * Renders the chat sequence with controllable inputs (channel,
 * userFirstName, isComplete trigger) so the timing + visual design
 * can be reviewed without standing up a real deploy. Each screen-
 * shot capture session can use ?fast=1 to compress the sequence
 * timings 5×, or the ?complete=1 to fire isComplete=true on mount
 * (skipping straight to the final message + CTA — useful for
 * checking the climax frame).
 *
 * Visit:
 *   /dev/agent-chat-preview                — natural-pace, telegram
 *   /dev/agent-chat-preview?fast=1         — 5× faster sequence
 *   /dev/agent-chat-preview?complete=1     — pre-fire isComplete
 *   /dev/agent-chat-preview?channel=imessage
 *   /dev/agent-chat-preview?noname=1       — skip "learning your name."
 *
 * Production-gated to a no-op string.
 */

import { useEffect, useState } from "react";
import { AgentChat } from "@/components/onboarding/agent-chat";

const CREAM_BG = "#f8f7f4";

export default function AgentChatPreview() {
  const [channel, setChannel] = useState<
    "telegram" | "imessage" | "web" | "discord" | "slack"
  >("telegram");
  const [userFirstName, setUserFirstName] = useState<string | null>("Cooper");
  const [isComplete, setIsComplete] = useState(false);
  // Edge attendee toggle — ?edge=1 → CTA becomes "enter the village →
  // /edge/intents" with the olive .cta-edge tint, superseding the
  // channel-based CTA.
  const [isEdge, setIsEdge] = useState(false);
  // Auto-complete after a delay so the sequence plays out naturally
  // and the CTA appears. Disabled if ?complete=1 (fires on mount) or
  // ?manual=1 (user controls via button).
  const [manualMode, setManualMode] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const url = new URL(window.location.href);
    const qsChannel = url.searchParams.get("channel");
    if (qsChannel === "imessage" || qsChannel === "web" || qsChannel === "discord" || qsChannel === "slack") {
      setChannel(qsChannel);
    }
    if (url.searchParams.get("noname") === "1") {
      setUserFirstName(null);
    }
    if (url.searchParams.get("edge") === "1") {
      setIsEdge(true);
    }
    if (url.searchParams.get("complete") === "1") {
      setIsComplete(true);
    } else if (url.searchParams.get("manual") === "1") {
      setManualMode(true);
    } else {
      // Default: fire isComplete after 22s (which is right after the
      // trailing typing indicator settles) so the natural-pace sequence
      // shows the full chat → final message → CTA arc.
      const t = setTimeout(() => setIsComplete(true), 22000);
      return () => clearTimeout(t);
    }
  }, []);

  if (process.env.NODE_ENV === "production") {
    return (
      <p style={{ padding: 24, fontFamily: "monospace" }}>
        /dev/agent-chat-preview is dev-only.
      </p>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `
          radial-gradient(1200px 700px at 50% -10%, rgba(233, 111, 77, 0.18), transparent 65%),
          radial-gradient(900px 600px at 8% 95%, rgba(34, 158, 217, 0.14), transparent 70%),
          radial-gradient(700px 500px at 95% 25%, rgba(31, 173, 62, 0.08), transparent 75%),
          linear-gradient(180deg, #f5f3ee 0%, #f8f7f4 60%, #f9f7f2 100%),
          ${CREAM_BG}
        `,
        paddingTop: 80,
        paddingBottom: 80,
      }}
    >
      <AgentChat
        channel={channel}
        userFirstName={userFirstName}
        botUsername="myinstaclaw_bot"
        isComplete={isComplete}
        isEdge={isEdge}
      />

      {/* Debug overlay — bottom-left, dev only. */}
      <div
        style={{
          position: "fixed",
          bottom: 16,
          left: 16,
          background: "rgba(255,255,255,0.94)",
          padding: "10px 14px",
          borderRadius: 10,
          fontSize: 11,
          fontFamily: "monospace",
          boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
          zIndex: 9999,
          maxWidth: 320,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          dev preview — channel:{" "}
          <span style={{ color: "#DC6743" }}>{channel}</span>{" "}
          · complete:{" "}
          <span style={{ color: isComplete ? "#16a34a" : "#999" }}>
            {String(isComplete)}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ marginTop: 4, color: "#666" }}>channel:</div>
          {(["telegram", "imessage", "web", "discord", "slack"] as const).map(
            (c) => (
              <a
                key={c}
                href={`/dev/agent-chat-preview?channel=${c}${userFirstName ? "" : "&noname=1"}${isComplete ? "&complete=1" : ""}`}
                style={{
                  color: c === channel ? "#DC6743" : "#333",
                  textDecoration: "underline",
                }}
              >
                {c}
              </a>
            ),
          )}
          <div style={{ marginTop: 4, color: "#666" }}>actions:</div>
          {manualMode && !isComplete && (
            <button
              onClick={() => setIsComplete(true)}
              style={{
                padding: "4px 8px",
                background: "#DC6743",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "monospace",
                fontSize: 11,
              }}
            >
              fire isComplete=true
            </button>
          )}
          <a href="/dev/agent-chat-preview?complete=1" style={{ color: "#333", textDecoration: "underline" }}>
            jump to final + CTA
          </a>
          <a href="/dev/agent-chat-preview?manual=1" style={{ color: "#333", textDecoration: "underline" }}>
            manual fire mode
          </a>
          <a href="/dev/agent-chat-preview" style={{ color: "#333", textDecoration: "underline" }}>
            natural pace (auto-fires at 22s)
          </a>
        </div>
      </div>
    </div>
  );
}
