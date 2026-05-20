"use client";

/**
 * ChatGPTConnectionSection
 *
 * Settings-page panel for managing the ChatGPT subscription connection.
 *
 * Layout mirrors the existing Gmail panel in /settings: a section header
 * with icon + glass card. Shows the user's current state (connected vs
 * not-connected vs feature-disabled) and a Connect or Disconnect button.
 *
 * Connect → opens ChatGPTConnectModal which handles the full OAuth flow.
 * Disconnect → opens the modal in its "connected" state so the user
 *              sees account details before confirming. (Mirrors Stripe's
 *              "Manage connection" → details → "Disconnect" pattern.)
 *
 * Fetches /api/auth/openai/status on mount and after the modal closes.
 */

import { useState, useEffect, useCallback } from "react";
import { Sparkles, ExternalLink } from "lucide-react";
import {
  ChatGPTConnectModal,
  type ConnectedSummary,
} from "./chatgpt-connect-modal";

type ConnectionState =
  | { kind: "loading" }
  | { kind: "connected"; summary: ConnectedSummary }
  | { kind: "not-connected"; reason: "no_tokens" | "feature_disabled" }
  | { kind: "error"; message: string };

export function ChatGPTConnectionSection() {
  const [state, setState] = useState<ConnectionState>({ kind: "loading" });
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/auth/openai/status");
      const data = (await res.json()) as Record<string, unknown>;
      const status = data.status as string | undefined;
      if (status === "connected") {
        setState({
          kind: "connected",
          summary: data.summary as ConnectedSummary,
        });
      } else if (status === "not_connected") {
        setState({
          kind: "not-connected",
          reason:
            (data.reason as "no_tokens" | "feature_disabled" | undefined) ?? "no_tokens",
        });
      } else if (status === "unauthorized") {
        setState({
          kind: "error",
          message: "Sign in to manage your ChatGPT connection.",
        });
      } else {
        setState({
          kind: "error",
          message: String(data.message ?? "Couldn't read connection state."),
        });
      }
    } catch {
      setState({
        kind: "error",
        message: "Couldn't reach InstaClaw. Refresh the page to retry.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleModalClose = useCallback(() => {
    setModalOpen(false);
    // Re-fetch status so the panel reflects any change (connected or disconnected).
    void refresh();
  }, [refresh]);

  return (
    <div data-tour="settings-chatgpt">
      <h2
        className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        <Sparkles className="w-5 h-5" /> ChatGPT Subscription
      </h2>
      <div
        className="glass rounded-xl p-6"
        style={{ border: "1px solid var(--border)" }}
      >
        <SectionBody
          state={state}
          onConnect={() => setModalOpen(true)}
          onManage={() => setModalOpen(true)}
        />
      </div>

      <ChatGPTConnectModal
        isOpen={modalOpen}
        onClose={handleModalClose}
        onConnected={() => {
          // Status refresh happens on modal close.
        }}
        onDisconnected={() => {
          // Status refresh happens on modal close.
        }}
      />
    </div>
  );
}

function SectionBody({
  state,
  onConnect,
  onManage,
}: {
  state: ConnectionState;
  onConnect: () => void;
  onManage: () => void;
}) {
  switch (state.kind) {
    case "loading":
      return (
        <div className="flex items-center justify-between">
          <div className="flex-1 mr-4">
            <p
              className="text-sm font-medium mb-1"
              style={{ color: "var(--muted)" }}
            >
              Loading…
            </p>
          </div>
          <div
            className="w-20 h-7 rounded-lg"
            style={{ background: "rgba(0,0,0,0.04)" }}
          />
        </div>
      );

    case "connected": {
      const plan = state.summary.planType
        ? state.summary.planType.charAt(0).toUpperCase() +
          state.summary.planType.slice(1)
        : null;
      return (
        <div className="flex items-center justify-between">
          <div className="flex-1 mr-4">
            <p className="text-sm font-medium mb-1">
              {plan ? `Connected — ChatGPT ${plan}` : "ChatGPT Connected"}
            </p>
            <p
              className="text-xs"
              style={{ color: "var(--muted)" }}
            >
              {state.summary.email
                ? `Using ${state.summary.email}. Your agent uses ChatGPT for responses.`
                : "Your agent uses ChatGPT for responses."}
            </p>
          </div>
          <button
            onClick={onManage}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer shrink-0"
            style={{ background: "rgba(0,0,0,0.04)", border: "1px solid var(--border)", color: "var(--foreground)" }}
          >
            Manage
          </button>
        </div>
      );
    }

    case "not-connected":
      if (state.reason === "feature_disabled") {
        return (
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium mb-1">Temporarily unavailable</p>
              <p
                className="text-xs"
                style={{ color: "var(--muted)" }}
              >
                ChatGPT connection is temporarily disabled across InstaClaw.
                Your agent uses Claude in the meantime.
              </p>
            </div>
          </div>
        );
      }
      return (
        <div className="flex items-center justify-between">
          <div className="flex-1 mr-4">
            <p className="text-sm font-medium mb-1">ChatGPT Not Connected</p>
            <p
              className="text-xs"
              style={{ color: "var(--muted)" }}
            >
              Connect your ChatGPT Plus or Pro subscription so your agent uses
              GPT-5.5 powered by your own account.
            </p>
          </div>
          <button
            onClick={onConnect}
            data-testid="open-chatgpt-modal"
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer inline-flex items-center gap-1.5"
            style={{
              background:
                "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
              boxShadow:
                "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(255,255,255,0.3) 0px -1px 1px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
              color: "#fff",
            }}
          >
            <ExternalLink className="w-3 h-3" />
            Connect
          </button>
        </div>
      );

    case "error":
      return (
        <div className="flex items-center justify-between">
          <div className="flex-1 mr-4">
            <p className="text-sm font-medium mb-1" style={{ color: "#b45309" }}>
              Couldn&apos;t load connection state
            </p>
            <p
              className="text-xs"
              style={{ color: "var(--muted)" }}
            >
              {state.message}
            </p>
          </div>
        </div>
      );
  }
}
