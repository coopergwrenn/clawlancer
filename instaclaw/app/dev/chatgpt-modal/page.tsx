"use client";

/**
 * Dev-only catalog page for the ChatGPTConnectModal.
 *
 * Renders the modal in each of its 10 visible states so the visual
 * design can be reviewed without driving a real OAuth flow. Used by
 * Puppeteer for Day 3 visual regression snapshots.
 *
 * Gated to development: returns a stub in production. The modal's
 * __devForceState prop is also gated to NODE_ENV !== "production".
 *
 * Route: /dev/chatgpt-modal — NOT linked from anywhere in the app.
 */

import { useState } from "react";
import {
  ChatGPTConnectModal,
  type ModalState,
} from "@/components/dashboard/chatgpt-connect-modal";

interface CatalogEntry {
  label: string;
  state: ModalState;
}

const FAKE_FLOW = {
  id: "00000000-0000-0000-0000-000000000abc",
  user_code: "92PM-PLU8N",
  verification_uri: "https://auth.openai.com/codex/device",
  interval_seconds: 5,
  // 14 min 23 sec from now — matches the audit-doc mockup
  expires_at: new Date(Date.now() + (14 * 60 + 23) * 1000).toISOString(),
};

const FAKE_FLOW_NEAR_EXPIRY = {
  ...FAKE_FLOW,
  expires_at: new Date(Date.now() + 45 * 1000).toISOString(),
};

const ENTRIES: CatalogEntry[] = [
  { label: "1. Initial loading", state: { kind: "initial-loading" } },
  { label: "2. Polling (code display)", state: { kind: "polling", flow: FAKE_FLOW } },
  {
    label: "2b. Polling — near expiry (<1 min)",
    state: { kind: "polling", flow: FAKE_FLOW_NEAR_EXPIRY },
  },
  {
    label: "3. Connected (already)",
    state: {
      kind: "connected",
      summary: {
        connected: true,
        email: "cooper@valtlabs.com",
        planType: "pro",
        accountId: "acct_xyz123",
        expiresAt: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString(),
      },
      justOpened: true,
    },
  },
  {
    label: "4. Success (post-connect)",
    state: { kind: "success", planType: "pro" },
  },
  { label: "5. Expired", state: { kind: "expired" } },
  { label: "6. Denied", state: { kind: "denied" } },
  { label: "7. Codex not enabled", state: { kind: "codex-not-enabled" } },
  {
    label: "8. Feature disabled",
    state: {
      kind: "feature-disabled",
      message:
        "ChatGPT subscription connection is temporarily disabled across InstaClaw. Your agent is running on Claude in the meantime. Reconnect later from Settings once ChatGPT support is restored.",
    },
  },
  { label: "9. Upstream timeout", state: { kind: "upstream-timeout" } },
  {
    label: "10. Generic error",
    state: {
      kind: "error",
      message:
        "Couldn't reach OpenAI to check connection status. Please try again.",
    },
  },
];

export default function ChatGPTModalCatalogPage() {
  // Hooks must always run in the same order — keep useState above the
  // production-safety conditional render.
  const [activeIdx, setActiveIdx] = useState(0);
  const active = ENTRIES[activeIdx];

  // Production safety: never expose the live catalog outside dev. Hooks
  // above always run; this is just a render-time gate.
  if (process.env.NODE_ENV === "production") {
    return (
      <div className="min-h-screen p-8 text-sm" style={{ color: "var(--muted)" }}>
        This catalog is dev-only.
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 sm:p-10" style={{ background: "var(--background)" }}>
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <h1
            className="text-3xl mb-2"
            style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
          >
            ChatGPT Modal — State Catalog
          </h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Dev-only visual reference. Click a state to render the modal in
            that exact configuration. Each click changes the URL hash so
            Puppeteer can navigate state-by-state.
          </p>
        </header>

        {/* State picker */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-8">
          {ENTRIES.map((entry, i) => (
            <button
              key={entry.label}
              onClick={() => {
                setActiveIdx(i);
                window.location.hash = `state-${i}`;
              }}
              data-testid={`catalog-state-${entry.state.kind}`}
              className="text-left px-4 py-3 rounded-xl text-sm font-medium transition-all cursor-pointer"
              style={{
                background: i === activeIdx ? "rgba(220,103,67,0.1)" : "rgba(0,0,0,0.03)",
                border: `1px solid ${i === activeIdx ? "rgba(220,103,67,0.3)" : "var(--border)"}`,
                color: i === activeIdx ? "#DC6743" : "var(--foreground)",
              }}
            >
              {entry.label}
              <div
                className="text-xs mt-0.5 font-mono"
                style={{ color: "var(--muted)" }}
              >
                kind: {entry.state.kind}
              </div>
            </button>
          ))}
        </div>

        <div
          className="rounded-xl p-4 text-xs"
          style={{ background: "rgba(0,0,0,0.04)", border: "1px solid var(--border)" }}
        >
          <strong>Currently rendering:</strong> {active.label}
        </div>
      </div>

      {/* The modal itself, frozen in the selected state */}
      <ChatGPTConnectModal
        isOpen
        onClose={() => {
          // In production this would close the modal; in catalog we just
          // re-render the same state so reviewers can click "X" to verify
          // the close interaction without losing the page.
          setActiveIdx(activeIdx);
        }}
        onConnected={() => {}}
        onDisconnected={() => {}}
        __devForceState={active.state}
      />
    </div>
  );
}
