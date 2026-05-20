"use client";

/**
 * ChatGPTConnectModal
 *
 * Full UX for the ChatGPT subscription OAuth device-code flow.
 *
 * Calls (Day 1-2.5 API surface):
 *   - POST /api/auth/openai/device-code/start   on mount, when "Connect" clicked
 *   - POST /api/auth/openai/device-code/poll    every interval_seconds while pending
 *   - DELETE /api/auth/openai/disconnect        on Disconnect (from "connected" state)
 *
 * All responses use the P2-A standard shape: `{ status, message?, ...extras }`
 * so the state-machine reducer is a single `switch(response.status)`.
 *
 * State machine (10 visible states):
 *   initial-loading  → starting / polling start route
 *   polling          → showing user_code, polling for completion
 *   connected        → user is already connected; "Disconnect" available
 *   success          → just finished connecting; auto-closes after 2.5s
 *   expired          → 15-min device-code window passed; Start Over
 *   denied           → user declined at OpenAI; Try Again
 *   codex-not-enabled→ user's OpenAI account lacks device-code; explainer
 *   feature-disabled → kill switch on; informational
 *   upstream-timeout → OpenAI auth endpoint slow; auto-retries
 *   error            → generic; surfaces message; Try Again
 *
 * Lifecycle hygiene:
 *   - Polling cleanup on unmount + state-change
 *   - Countdown timer cleanup
 *   - upstream-timeout auto-retry cleanup
 *
 * Dev-only injection: `__devForceState` lets the dev catalog page
 * render any state without hitting real APIs. Gated to development
 * via the `process.env.NODE_ENV === "development"` check at the
 * top of the effect that would normally fetch.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  X,
  Copy,
  Check,
  ExternalLink,
  Sparkles,
  AlertTriangle,
  Loader2,
  LogOut,
  CheckCircle2,
  Clock,
  Ban,
} from "lucide-react";

// ─── Public types ────────────────────────────────────────────────────────

export interface ConnectedSummary {
  connected: boolean;
  expiresAt?: string;
  planType?: string | null;
  email?: string | null;
  accountId?: string | null;
}

interface FlowData {
  id: string;
  user_code: string;
  verification_uri: string;
  interval_seconds: number;
  expires_at: string;
}

/**
 * Exhaustive state machine. Each variant carries exactly the data its
 * view needs — no nullable fields, no "is this state X" booleans.
 */
export type ModalState =
  | { kind: "initial-loading" }
  | {
      kind: "polling";
      flow: FlowData;
    }
  | {
      kind: "connected";
      summary: ConnectedSummary;
      /** true when status came back as "connected" from /start (vs /status) */
      justOpened: boolean;
    }
  | {
      kind: "success";
      planType: string | null;
      summary?: ConnectedSummary;
    }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "codex-not-enabled" }
  | { kind: "feature-disabled"; message: string }
  | { kind: "upstream-timeout" }
  | { kind: "error"; message: string };

interface ChatGPTConnectModalProps {
  /** Modal is rendered conditionally — parent controls open/close. */
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful connection (so parent can refresh status). */
  onConnected?: (summary?: ConnectedSummary) => void;
  /** Called after the user successfully disconnects. */
  onDisconnected?: () => void;
  /**
   * Dev-only: bypass API calls and render the modal in this state.
   * The component refuses to honor this in production (NODE_ENV check).
   */
  __devForceState?: ModalState;
}

// ─── Brand tokens ────────────────────────────────────────────────────────

const BRAND = "#DC6743";
const BRAND_GRADIENT =
  "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)";
const BRAND_BUTTON_SHADOW =
  "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(255,255,255,0.3) 0px -1px 1px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px";
const DANGER_BG = "rgba(239,68,68,0.1)";
const DANGER_TEXT = "#ef4444";
const DANGER_BORDER = "rgba(239,68,68,0.3)";
const GREEN = "#16a34a";

const UPSTREAM_RETRY_MS = 3_000;
const SUCCESS_AUTO_CLOSE_MS = 2_500;

// ─── Component ───────────────────────────────────────────────────────────

export function ChatGPTConnectModal({
  isOpen,
  onClose,
  onConnected,
  onDisconnected,
  __devForceState,
}: ChatGPTConnectModalProps) {
  const [state, setState] = useState<ModalState>(
    __devForceState ?? { kind: "initial-loading" },
  );
  // Re-sync state when devForceState changes (dev catalog page jumps between states).
  useEffect(() => {
    if (
      process.env.NODE_ENV === "development" &&
      __devForceState !== undefined
    ) {
      setState(__devForceState);
    }
  }, [__devForceState]);

  // ─── Start the OAuth flow (POST /start) ────────────────────────────────
  const triggerStart = useCallback(async (): Promise<void> => {
    setState({ kind: "initial-loading" });
    try {
      const res = await fetch("/api/auth/openai/device-code/start", {
        method: "POST",
      });
      const data = (await res.json()) as Record<string, unknown>;
      const status = data.status as string | undefined;

      switch (status) {
        case "pending":
          setState({ kind: "polling", flow: data.flow as FlowData });
          return;
        case "connected":
          setState({
            kind: "connected",
            summary: data.summary as ConnectedSummary,
            justOpened: true,
          });
          return;
        case "feature_disabled":
          setState({
            kind: "feature-disabled",
            message: String(data.message ?? "Temporarily unavailable."),
          });
          return;
        case "codex_not_enabled":
          setState({ kind: "codex-not-enabled" });
          return;
        case "upstream_timeout":
          setState({ kind: "upstream-timeout" });
          return;
        case "unauthorized":
          setState({
            kind: "error",
            message:
              "Your session expired. Please refresh the page and sign in again.",
          });
          return;
        case "service_unavailable":
        default:
          setState({
            kind: "error",
            message: String(
              data.message ??
                "Couldn't start the connection. Please try again in a minute.",
            ),
          });
      }
    } catch {
      setState({
        kind: "error",
        message:
          "Couldn't reach InstaClaw to start the connection. Check your network and try again.",
      });
    }
  }, []);

  // ─── Auto-start when modal opens (production path; skipped under dev force) ──
  const lastIsOpenRef = useRef(false);
  useEffect(() => {
    // Dev-force: respect injected state, don't fetch.
    if (process.env.NODE_ENV === "development" && __devForceState !== undefined) {
      return;
    }
    // On transition from closed → open, start the flow.
    if (isOpen && !lastIsOpenRef.current) {
      void triggerStart();
    }
    lastIsOpenRef.current = isOpen;
  }, [isOpen, triggerStart, __devForceState]);

  // ─── Polling loop ──────────────────────────────────────────────────────
  useEffect(() => {
    if (state.kind !== "polling") return;
    // Dev-force: don't actually poll.
    if (process.env.NODE_ENV === "development" && __devForceState !== undefined) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    async function pollOnce(): Promise<void> {
      if (cancelled) return;
      const currentState = state;
      if (currentState.kind !== "polling") return;
      try {
        const res = await fetch("/api/auth/openai/device-code/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flow_id: currentState.flow.id }),
        });
        if (cancelled) return;
        const data = (await res.json()) as Record<string, unknown>;
        const status = data.status as string | undefined;

        switch (status) {
          case "pending":
            // Schedule next poll. interval_seconds is per-flow from OpenAI.
            timeoutId = setTimeout(
              pollOnce,
              currentState.flow.interval_seconds * 1000,
            );
            return;
          case "completed":
            setState({
              kind: "success",
              planType: (data.plan_type as string | null) ?? null,
              summary: data.summary as ConnectedSummary | undefined,
            });
            return;
          case "expired":
          case "not_found":
            setState({ kind: "expired" });
            return;
          case "denied":
            setState({ kind: "denied" });
            return;
          case "feature_disabled":
            setState({
              kind: "feature-disabled",
              message: String(data.message ?? "Temporarily unavailable."),
            });
            return;
          case "unauthorized":
            setState({
              kind: "error",
              message:
                "Your session expired. Please refresh the page and sign in again.",
            });
            return;
          case "bad_request":
          case "error":
          default:
            setState({
              kind: "error",
              message: String(
                data.message ??
                  "Something went wrong while checking the connection.",
              ),
            });
        }
      } catch {
        if (cancelled) return;
        // Network blip — retry after the normal interval. Don't surface
        // every transient failure to the user; let the next poll recover.
        timeoutId = setTimeout(
          pollOnce,
          state.kind === "polling" ? state.flow.interval_seconds * 1000 : 5000,
        );
      }
    }

    // First poll after the initial interval (don't immediately re-poll the
    // server right after /start returned the flow — that's wasted work).
    timeoutId = setTimeout(pollOnce, state.flow.interval_seconds * 1000);

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
    // We depend on flow.id (not state) so polling restarts cleanly if the
    // user retries (new flow → new effect run).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind === "polling" ? state.flow.id : null, __devForceState]);

  // ─── Upstream-timeout auto-retry ───────────────────────────────────────
  useEffect(() => {
    if (state.kind !== "upstream-timeout") return;
    if (process.env.NODE_ENV === "development" && __devForceState !== undefined) return;
    const id = setTimeout(() => {
      void triggerStart();
    }, UPSTREAM_RETRY_MS);
    return () => clearTimeout(id);
  }, [state.kind, triggerStart, __devForceState]);

  // ─── Success auto-close ────────────────────────────────────────────────
  useEffect(() => {
    if (state.kind !== "success") return;
    if (process.env.NODE_ENV === "development" && __devForceState !== undefined) return;
    const summary = state.summary;
    const id = setTimeout(() => {
      onConnected?.(summary);
      onClose();
    }, SUCCESS_AUTO_CLOSE_MS);
    return () => clearTimeout(id);
  }, [state.kind, onClose, onConnected, __devForceState]);

  // ─── Disconnect (from connected state) ─────────────────────────────────
  const [disconnecting, setDisconnecting] = useState(false);
  const handleDisconnect = useCallback(async (): Promise<void> => {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/auth/openai/disconnect", {
        method: "DELETE",
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (data.status === "ok") {
        onDisconnected?.();
        onClose();
      } else {
        setState({
          kind: "error",
          message: String(
            data.message ??
              "Couldn't disconnect. Please try again.",
          ),
        });
      }
    } catch {
      setState({
        kind: "error",
        message: "Couldn't reach InstaClaw to disconnect. Check your network and try again.",
      });
    } finally {
      setDisconnecting(false);
    }
  }, [onClose, onDisconnected]);

  // ─── Render ────────────────────────────────────────────────────────────
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      data-testid="chatgpt-connect-modal"
      data-state={state.kind}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
        onClick={() => {
          // Allow click-outside-to-close in safe states only.
          if (
            state.kind === "polling" ||
            state.kind === "connected" ||
            state.kind === "expired" ||
            state.kind === "denied" ||
            state.kind === "codex-not-enabled" ||
            state.kind === "feature-disabled" ||
            state.kind === "error"
          ) {
            onClose();
          }
        }}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3 }}
        className="relative w-full max-w-lg rounded-2xl overflow-hidden"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.2)",
        }}
      >
        {/* Close button — always visible except during success auto-close countdown */}
        {state.kind !== "success" && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full transition-colors cursor-pointer z-10 hover:opacity-70"
            style={{ background: "rgba(0,0,0,0.06)", color: "var(--muted)" }}
          >
            <X className="w-4 h-4" />
          </button>
        )}

        <div className="p-6 sm:p-8">
          <AnimatePresence mode="wait">
            <StateView
              key={state.kind}
              state={state}
              onRetry={triggerStart}
              onDisconnect={handleDisconnect}
              onClose={onClose}
              disconnecting={disconnecting}
            />
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

// ─── StateView — per-state UI ────────────────────────────────────────────

function StateView({
  state,
  onRetry,
  onDisconnect,
  onClose,
  disconnecting,
}: {
  state: ModalState;
  onRetry: () => void;
  onDisconnect: () => void;
  onClose: () => void;
  disconnecting: boolean;
}) {
  switch (state.kind) {
    case "initial-loading":
      return <ViewInitialLoading />;
    case "polling":
      return <ViewPolling flow={state.flow} />;
    case "connected":
      return (
        <ViewConnected
          summary={state.summary}
          justOpened={state.justOpened}
          onDisconnect={onDisconnect}
          onClose={onClose}
          disconnecting={disconnecting}
        />
      );
    case "success":
      return <ViewSuccess planType={state.planType} />;
    case "expired":
      return <ViewExpired onRetry={onRetry} onClose={onClose} />;
    case "denied":
      return <ViewDenied onRetry={onRetry} onClose={onClose} />;
    case "codex-not-enabled":
      return <ViewCodexNotEnabled onClose={onClose} />;
    case "feature-disabled":
      return <ViewFeatureDisabled message={state.message} onClose={onClose} />;
    case "upstream-timeout":
      return <ViewUpstreamTimeout />;
    case "error":
      return <ViewError message={state.message} onRetry={onRetry} onClose={onClose} />;
  }
}

// ─── Individual state views ──────────────────────────────────────────────

function ViewInitialLoading() {
  return (
    <motion.div
      key="initial-loading"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      className="text-center py-8"
    >
      <Loader2
        className="w-8 h-8 mx-auto mb-4 animate-spin"
        style={{ color: BRAND }}
        data-testid="loading-spinner"
      />
      <h2
        className="text-xl mb-1"
        style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
      >
        Starting connection…
      </h2>
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        Talking to OpenAI
      </p>
    </motion.div>
  );
}

function ViewPolling({ flow }: { flow: FlowData }) {
  const [copied, setCopied] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(() =>
    Math.max(0, Math.floor((new Date(flow.expires_at).getTime() - Date.now()) / 1000)),
  );

  // Countdown
  useEffect(() => {
    const id = setInterval(() => {
      setSecondsRemaining((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Copy feedback
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(id);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(flow.user_code);
      setCopied(true);
    } catch {
      // Fallback for non-secure contexts — select the text element for manual copy
      const el = document.querySelector("[data-user-code]");
      if (el instanceof HTMLElement) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }, [flow.user_code]);

  const mm = Math.floor(secondsRemaining / 60);
  const ss = String(secondsRemaining % 60).padStart(2, "0");

  return (
    <motion.div
      key="polling"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
    >
      <div className="mb-5">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
          style={{
            background: "linear-gradient(135deg, rgba(220,103,67,0.1), rgba(220,103,67,0.2))",
            border: "1px solid rgba(220,103,67,0.15)",
          }}
        >
          <Sparkles className="w-6 h-6" style={{ color: BRAND }} />
        </div>
        <h2
          className="text-2xl mb-1.5"
          style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
        >
          Connect ChatGPT
        </h2>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Use this code to authorize InstaClaw to use your ChatGPT subscription.
        </p>
      </div>

      {/* The code — visually dominant. Stacks vertically on mobile so the
          code gets full container width and never wraps mid-hyphen; goes
          row layout on sm: breakpoint+ where horizontal space exists. */}
      <div
        className="rounded-2xl p-5 mb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        style={{
          background: "rgba(220,103,67,0.06)",
          border: `1px solid rgba(220,103,67,0.2)`,
        }}
      >
        <div
          data-user-code
          // whitespace-nowrap is load-bearing: without it the "-" between
          // code groups (e.g., "92PM-PLU8N") becomes a wrap point and the
          // code splits across two lines.
          className="font-mono text-3xl tracking-[0.15em] select-all whitespace-nowrap"
          style={{ fontVariantNumeric: "tabular-nums", color: "var(--foreground)" }}
        >
          {flow.user_code}
        </div>
        <button
          onClick={handleCopy}
          aria-label="Copy code"
          data-testid="copy-button"
          className="self-start sm:self-auto shrink-0 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5"
          style={{
            background: copied ? "rgba(22,163,74,0.1)" : "rgba(0,0,0,0.04)",
            border: `1px solid ${copied ? "rgba(22,163,74,0.3)" : "var(--border)"}`,
            color: copied ? GREEN : "var(--foreground)",
          }}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              Copy
            </>
          )}
        </button>
      </div>

      {/* Steps */}
      <ol className="space-y-3 mb-5 text-sm">
        <li className="flex items-start gap-3">
          <span
            className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold"
            style={{ background: "rgba(220,103,67,0.12)", color: BRAND }}
          >
            1
          </span>
          <div className="flex-1">
            <p className="leading-snug mb-2">Open OpenAI&apos;s device-code page:</p>
            <a
              href={flow.verification_uri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer"
              style={{
                background: BRAND_GRADIENT,
                boxShadow: BRAND_BUTTON_SHADOW,
                color: "#fff",
              }}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {flow.verification_uri.replace(/^https?:\/\//, "")}
            </a>
          </div>
        </li>
        <li className="flex items-start gap-3">
          <span
            className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold"
            style={{ background: "rgba(220,103,67,0.12)", color: BRAND }}
          >
            2
          </span>
          <p className="leading-snug">
            Paste the code above and click <strong>Continue</strong>.
          </p>
        </li>
        <li className="flex items-start gap-3">
          <span
            className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold"
            style={{ background: "rgba(220,103,67,0.12)", color: BRAND }}
          >
            3
          </span>
          <p className="leading-snug">
            Come back here — we&apos;ll detect when you&apos;re done.
          </p>
        </li>
      </ol>

      {/* Status row — live waiting indicator + countdown */}
      <div
        className="rounded-xl px-4 py-3 flex items-center justify-between text-xs"
        style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
      >
        <span className="flex items-center gap-2" style={{ color: "var(--muted)" }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: BRAND }} />
          Waiting for authorization…
        </span>
        <span
          className="flex items-center gap-1 font-mono"
          style={{ color: secondsRemaining < 60 ? DANGER_TEXT : "var(--muted)" }}
          data-testid="countdown"
        >
          <Clock className="w-3 h-3" />
          {mm}:{ss}
        </span>
      </div>
    </motion.div>
  );
}

function ViewConnected({
  summary,
  justOpened,
  onDisconnect,
  onClose,
  disconnecting,
}: {
  summary: ConnectedSummary;
  justOpened: boolean;
  onDisconnect: () => void;
  onClose: () => void;
  disconnecting: boolean;
}) {
  const plan = summary.planType
    ? summary.planType.charAt(0).toUpperCase() + summary.planType.slice(1)
    : null;
  return (
    <motion.div
      key="connected"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
    >
      <div className="mb-5">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
          style={{
            background: "linear-gradient(135deg, rgba(22,163,74,0.1), rgba(22,163,74,0.2))",
            border: "1px solid rgba(22,163,74,0.2)",
          }}
        >
          <CheckCircle2 className="w-6 h-6" style={{ color: GREEN }} />
        </div>
        <h2
          className="text-2xl mb-1.5"
          style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
        >
          {justOpened ? "Already connected" : "ChatGPT connected"}
        </h2>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Your agent is using ChatGPT for responses.
        </p>
      </div>

      <div
        className="rounded-xl p-4 mb-5 space-y-2"
        style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
      >
        {summary.email && (
          <Row label="Account" value={summary.email} mono />
        )}
        {plan && <Row label="Plan" value={`ChatGPT ${plan}`} />}
        {summary.expiresAt && (
          <Row
            label="Token expires"
            value={new Date(summary.expiresAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          />
        )}
      </div>

      <div className="flex flex-col sm:flex-row-reverse gap-2">
        <button
          onClick={onClose}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer"
          style={{
            background: "rgba(0,0,0,0.04)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
          }}
        >
          Close
        </button>
        <button
          onClick={onDisconnect}
          disabled={disconnecting}
          data-testid="disconnect-button"
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
          style={{
            background: DANGER_BG,
            color: DANGER_TEXT,
            border: `1px solid ${DANGER_BORDER}`,
          }}
        >
          {disconnecting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Disconnecting…
            </>
          ) : (
            <>
              <LogOut className="w-3.5 h-3.5" />
              Disconnect
            </>
          )}
        </button>
      </div>
    </motion.div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm gap-3">
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span
        className={`${mono ? "font-mono" : ""} truncate`}
        style={{ color: "var(--foreground)" }}
      >
        {value}
      </span>
    </div>
  );
}

function ViewSuccess({ planType }: { planType: string | null }) {
  const plan = planType
    ? planType.charAt(0).toUpperCase() + planType.slice(1)
    : null;
  return (
    <motion.div
      key="success"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.35 }}
      className="text-center py-8"
    >
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.1, type: "spring", stiffness: 260, damping: 20 }}
        className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5"
        style={{
          background: "linear-gradient(135deg, rgba(22,163,74,0.15), rgba(22,163,74,0.25))",
          border: "1px solid rgba(22,163,74,0.3)",
        }}
      >
        <CheckCircle2 className="w-8 h-8" style={{ color: GREEN }} />
      </motion.div>
      <h2
        className="text-2xl mb-2"
        style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
      >
        Connected!
      </h2>
      <p className="text-sm leading-relaxed max-w-xs mx-auto" style={{ color: "var(--muted)" }}>
        {plan
          ? `Your agent will use ChatGPT ${plan} within a few minutes.`
          : "Your agent will use ChatGPT within a few minutes."}
      </p>
    </motion.div>
  );
}

function ViewExpired({ onRetry, onClose }: { onRetry: () => void; onClose: () => void }) {
  return (
    <TerminalView
      key="expired"
      icon={<Clock className="w-7 h-7" style={{ color: "#b45309" }} />}
      iconBg="rgba(245,158,11,0.12)"
      iconBorder="rgba(245,158,11,0.25)"
      title="Code expired"
      body="The 15-minute window passed without authorization. Start a new connection?"
      primaryLabel="Start Over"
      onPrimary={onRetry}
      onClose={onClose}
    />
  );
}

function ViewDenied({ onRetry, onClose }: { onRetry: () => void; onClose: () => void }) {
  return (
    <TerminalView
      key="denied"
      icon={<Ban className="w-7 h-7" style={{ color: DANGER_TEXT }} />}
      iconBg={DANGER_BG}
      iconBorder={DANGER_BORDER}
      title="Authorization declined"
      body="You clicked Deny on OpenAI's authorization screen. Want to try again?"
      primaryLabel="Try Again"
      onPrimary={onRetry}
      onClose={onClose}
    />
  );
}

function ViewCodexNotEnabled({ onClose }: { onClose: () => void }) {
  return (
    <motion.div
      key="codex-not-enabled"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
    >
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
        style={{
          background: "rgba(234,179,8,0.1)",
          border: "1px solid rgba(234,179,8,0.25)",
        }}
      >
        <AlertTriangle className="w-6 h-6" style={{ color: "#b45309" }} />
      </div>
      <h2
        className="text-2xl mb-2"
        style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
      >
        Codex login not enabled
      </h2>
      <p className="text-sm mb-5 leading-relaxed" style={{ color: "var(--muted)" }}>
        Your ChatGPT account doesn&apos;t have device-code authorization for Codex
        enabled. Here&apos;s how to turn it on:
      </p>
      <ol className="space-y-2 mb-5 text-sm">
        <li className="flex items-start gap-2">
          <span style={{ color: BRAND }}>1.</span>
          <span>
            Open <strong>ChatGPT → Settings → Security</strong>
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span style={{ color: BRAND }}>2.</span>
          <span>
            Enable <strong>&quot;Device code authorization for Codex&quot;</strong>
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span style={{ color: BRAND }}>3.</span>
          <span>Come back here and try again</span>
        </li>
      </ol>
      <div className="flex flex-col sm:flex-row-reverse gap-2">
        <a
          href="https://chatgpt.com/#settings/Security"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer text-center inline-flex items-center justify-center gap-2"
          style={{
            background: BRAND_GRADIENT,
            boxShadow: BRAND_BUTTON_SHADOW,
            color: "#fff",
          }}
        >
          <ExternalLink className="w-3.5 h-3.5" />
          ChatGPT Settings
        </a>
        <button
          onClick={onClose}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer"
          style={{
            background: "rgba(0,0,0,0.04)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
          }}
        >
          Close
        </button>
      </div>
    </motion.div>
  );
}

function ViewFeatureDisabled({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <motion.div
      key="feature-disabled"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      className="text-center py-2"
    >
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
        style={{
          background: "rgba(0,0,0,0.04)",
          border: "1px solid var(--border)",
        }}
      >
        <Clock className="w-6 h-6" style={{ color: "var(--muted)" }} />
      </div>
      <h2
        className="text-2xl mb-2"
        style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
      >
        Temporarily unavailable
      </h2>
      <p
        className="text-sm mb-6 leading-relaxed max-w-sm mx-auto"
        style={{ color: "var(--muted)" }}
      >
        {message}
      </p>
      <button
        onClick={onClose}
        className="px-6 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer"
        style={{
          background: "rgba(0,0,0,0.04)",
          border: "1px solid var(--border)",
          color: "var(--foreground)",
        }}
      >
        Close
      </button>
    </motion.div>
  );
}

function ViewUpstreamTimeout() {
  return (
    <motion.div
      key="upstream-timeout"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      className="text-center py-8"
    >
      <Loader2
        className="w-8 h-8 mx-auto mb-4 animate-spin"
        style={{ color: BRAND }}
      />
      <h2
        className="text-xl mb-1"
        style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
      >
        OpenAI is slow…
      </h2>
      <p className="text-sm leading-relaxed max-w-xs mx-auto" style={{ color: "var(--muted)" }}>
        Their auth service is taking longer than usual. We&apos;re retrying automatically.
      </p>
    </motion.div>
  );
}

function ViewError({
  message,
  onRetry,
  onClose,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <TerminalView
      key="error"
      icon={<AlertTriangle className="w-7 h-7" style={{ color: DANGER_TEXT }} />}
      iconBg={DANGER_BG}
      iconBorder={DANGER_BORDER}
      title="Connection issue"
      body={message}
      primaryLabel="Try Again"
      onPrimary={onRetry}
      onClose={onClose}
    />
  );
}

function TerminalView({
  icon,
  iconBg,
  iconBorder,
  title,
  body,
  primaryLabel,
  onPrimary,
  onClose,
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconBorder: string;
  title: string;
  body: string;
  primaryLabel: string;
  onPrimary: () => void;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
    >
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
        style={{ background: iconBg, border: `1px solid ${iconBorder}` }}
      >
        {icon}
      </div>
      <h2
        className="text-2xl mb-2"
        style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
      >
        {title}
      </h2>
      <p className="text-sm mb-5 leading-relaxed" style={{ color: "var(--muted)" }}>
        {body}
      </p>
      <div className="flex flex-col sm:flex-row-reverse gap-2">
        <button
          onClick={onPrimary}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all cursor-pointer"
          style={{
            background: BRAND_GRADIENT,
            boxShadow: BRAND_BUTTON_SHADOW,
            color: "#fff",
          }}
        >
          {primaryLabel}
        </button>
        <button
          onClick={onClose}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer"
          style={{
            background: "rgba(0,0,0,0.04)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
          }}
        >
          Close
        </button>
      </div>
    </motion.div>
  );
}
