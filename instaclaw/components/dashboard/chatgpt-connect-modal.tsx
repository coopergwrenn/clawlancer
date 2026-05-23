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
import { signIn } from "next-auth/react";
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
      /**
       * Set ONLY when mode="signup". Carries the one-shot JWT minted by
       * /api/auth/openai/signup/poll. The success-state effect uses this
       * to invoke `signIn(OPENAI_DEVICE_CODE_PROVIDER_ID, { signupToken })`
       * which establishes a real NextAuth session via the Credentials
       * provider in lib/auth.ts. Undefined in connect mode (the user
       * already has a session; nothing to bridge).
       */
      signupToken?: string;
    }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "codex-not-enabled" }
  | { kind: "feature-disabled"; message: string }
  | { kind: "upstream-timeout" }
  | { kind: "error"; message: string };

/**
 * Modal mode — controls endpoint URLs, allowed initial states, and the
 * success-state action.
 *
 *   "connect": post-signup. User has a session. Endpoints are
 *     /api/auth/openai/device-code/{start,poll}. /start can return
 *     "connected" if the user is already linked. Success → onConnected
 *     callback + close (parent refreshes status).
 *
 *   "signup": session-less. User does NOT have a session yet. Endpoints
 *     are /api/auth/openai/signup/{start,poll}. /start never returns
 *     "connected" (the concept doesn't apply — no known user). Success →
 *     signIn(OPENAI_DEVICE_CODE_PROVIDER_ID, { signupToken, callbackUrl })
 *     which establishes a NextAuth session and redirects.
 *
 * Default is "connect" so existing callsites (settings page) work
 * unchanged.
 */
export type ChatGPTModalMode = "connect" | "signup";

interface ChatGPTConnectModalProps {
  /** Modal is rendered conditionally — parent controls open/close. */
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful connection (so parent can refresh status). Connect mode only. */
  onConnected?: (summary?: ConnectedSummary) => void;
  /** Called after the user successfully disconnects. Connect mode only. */
  onDisconnected?: () => void;
  /**
   * Which path the modal serves. Default "connect" preserves existing
   * /settings behavior. Pass "signup" to use the session-less path that
   * creates a user account on completion.
   */
  mode?: ChatGPTModalMode;
  /**
   * Required when mode="signup". The URL to redirect to after the
   * NextAuth signIn() call succeeds — typically /connect for the Edge
   * onboarding flow. Ignored in connect mode.
   */
  signupCallbackUrl?: string;
  /**
   * Visual theme. Default `"dark"` preserves the existing /settings +
   * /signin appearance (black surfaces, brand-orange accents). Pass
   * `"edge"` from /edge/claim so the modal renders against the Edge
   * cream + olive palette without visually breaking the page behind it.
   *
   * See THEME_TOKENS at the top of this file for the palette. Adding a
   * future partner theme is one new object in that record.
   */
  theme?: ChatGPTConnectModalTheme;
  /**
   * Dev-only: bypass API calls and render the modal in this state.
   * The component refuses to honor this in production (NODE_ENV check).
   */
  __devForceState?: ModalState;
}

// ─── Theme tokens ────────────────────────────────────────────────────────
//
// 2026-05-22 — added `edge` theme variant alongside the original `dark`.
// Edge attendees on /edge/claim open this modal inline against a
// cream/olive page; the default dark theme (black surfaces, brand-orange
// accents) reads as visually broken against that backdrop.
//
// Architecture: one palette object per theme. Components read tokens via
// `useThemeTokens(theme)` and pass through to style props. The dark
// palette is byte-identical to the pre-2026-05-22 constants — no behavior
// change for /settings or any other consumer that doesn't pass `theme`.
//
// Why CSS-var overrides at the outer wrapper: the modal references
// var(--card), var(--border), var(--muted), var(--foreground) in 20+
// places (success/error/connected sub-views, info rows, etc.). Overriding
// these at the modal-scope inside an `edge`-themed CSSProperties payload
// resolves them all without touching every callsite. Brand-orange
// hardcodes (BRAND, BRAND_GRADIENT, rgba(220,103,67,*)) still need
// per-token swaps because they bypass the CSS-var system. Semantic
// status colors (green=success, yellow=warning, red=danger) stay the
// same in both themes — they convey meaning, not brand.
//
// To add a future partner theme (e.g., Consensus): add a third object
// to THEME_TOKENS with that partner's palette + cssVarOverrides. Zero
// other code changes required.

export type ChatGPTConnectModalTheme = "dark" | "edge";

interface ThemeTokens {
  /** Primary brand color — solid (used for icon glyphs, accent text). */
  brand: string;
  /** Brand gradient — primary CTA fill (e.g., the device-code URL button). */
  brandGradient: string;
  /** Drop shadow on primary CTA — kept in-token because it carries brand
   *  color in its glow. */
  brandButtonShadow: string;
  /** Brand-tinted surface: very subtle (code-display background). */
  brandSurfaceWeak: string;
  /** Brand-tinted surface: medium (numbered-step circle background). */
  brandSurfaceMed: string;
  /** Brand-tinted border: subtle (code-display border, info-pill border). */
  brandBorderWeak: string;
  /** Brand-tinted border: medium (info-pill stronger). */
  brandBorderMed: string;
  /** CSS-variable overrides applied at the outer-wrapper scope. Resolves
   *  every var(--card), var(--border), var(--muted), var(--foreground)
   *  reference inside the modal to the theme's palette. */
  cssVarOverrides?: React.CSSProperties;
}

const THEME_TOKENS: Record<ChatGPTConnectModalTheme, ThemeTokens> = {
  dark: {
    brand: "#DC6743",
    brandGradient:
      "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
    brandButtonShadow:
      "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(255,255,255,0.3) 0px -1px 1px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
    brandSurfaceWeak: "rgba(220,103,67,0.06)",
    brandSurfaceMed: "rgba(220,103,67,0.12)",
    brandBorderWeak: "rgba(220,103,67,0.15)",
    brandBorderMed: "rgba(220,103,67,0.2)",
    // cssVarOverrides intentionally undefined — dark theme inherits the
    // page's existing --card / --border / --muted / --foreground.
  },
  edge: {
    // Edge olive (#0f1a12 → #4a5a2b range — same palette claim-client.tsx
    // and lib/partner-content.ts use). Slightly lighter than the deepest
    // Edge ink so the gradient surfaces stay readable on cream.
    brand: "#4a5a2b",
    brandGradient: "linear-gradient(135deg, #4a5a2b 0%, #5a6a3b 100%)",
    brandButtonShadow:
      "rgba(255,255,255,0.18) 0px -1px 1px 0px inset, rgba(74,90,43,0.35) 0px 4px 16px 0px",
    brandSurfaceWeak: "rgba(74,90,43,0.05)",
    brandSurfaceMed: "rgba(74,90,43,0.12)",
    brandBorderWeak: "rgba(74,90,43,0.18)",
    brandBorderMed: "rgba(74,90,43,0.28)",
    cssVarOverrides: {
      // CSS custom properties accepted by React when typed as a CSS-vars
      // object. The `as React.CSSProperties` cast lets TS accept the
      // non-standard property names without complaint.
      ["--card" as string]: "#FDFAF5",
      ["--border" as string]: "#e8e3d8",
      ["--muted" as string]: "#5a6240",
      ["--foreground" as string]: "#0f1a12",
      // Modal-scope text color so any unstyled text inherits Edge ink.
      color: "#0f1a12",
    } as React.CSSProperties,
  },
};

// Dark-theme aliases for sub-views that haven't been threaded with the
// `tokens` prop yet. ViewPolling (the only state Edge attendees see — the
// device-code entry screen) is fully tokenized. ViewConnected /
// ViewCodexNotEnabled / ViewFeatureDisabled etc. are dashboard-only or
// post-success states that Edge users never reach inline, so they keep
// the dark palette via these aliases. Threading `tokens` through them is
// a clean follow-up when an Edge-context "modal stays open longer" use
// case justifies it.
const BRAND = THEME_TOKENS.dark.brand;
const BRAND_GRADIENT = THEME_TOKENS.dark.brandGradient;
const BRAND_BUTTON_SHADOW = THEME_TOKENS.dark.brandButtonShadow;

const DANGER_BG = "rgba(239,68,68,0.1)";
const DANGER_TEXT = "#ef4444";
const DANGER_BORDER = "rgba(239,68,68,0.3)";
const GREEN = "#16a34a";

const UPSTREAM_RETRY_MS = 3_000;
const SUCCESS_AUTO_CLOSE_MS = 2_500;

/**
 * Focus ring applied to every interactive element in the modal. Tailwind
 * `focus-visible:` only fires for keyboard focus (not mouse click), so
 * sighted-mouse users don't see distracting rings. Sighted-keyboard users
 * get a 2px brand-orange ring offset 2px from the element. WCAG 2.4.7 fix.
 */
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#DC6743] focus:outline-none";

/**
 * Stable id used by `aria-labelledby` on the modal container. Only one
 * state view renders at a time, so attaching this id to each view's <h2>
 * is unique-per-render and the dialog announces the right title.
 */
const MODAL_TITLE_ID = "chatgpt-modal-title";

/**
 * For aria-label on the user_code — screen readers pronounce "92PM-PLU8N"
 * as "ninety-two-pmplu-eight-N" by default. Spacing each character and
 * naming the hyphen lets them spell it out: "9 2 P M dash P L U 8 N".
 * Critical for users who can't see the code visually.
 */
function spellOut(code: string): string {
  return code
    .split("")
    .map((c) => (c === "-" ? "dash" : c))
    .join(" ");
}

/**
 * Selector for "tabbable" elements per common a11y conventions. Excludes
 * disabled buttons and explicit tabindex=-1. Used by the focus trap.
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** States in which Escape and backdrop-click should NOT dismiss the modal. */
function isDismissalBlocked(kind: ModalState["kind"]): boolean {
  return (
    kind === "initial-loading" || kind === "success" || kind === "upstream-timeout"
  );
}

// ─── Component ───────────────────────────────────────────────────────────

export function ChatGPTConnectModal({
  isOpen,
  onClose,
  onConnected,
  onDisconnected,
  mode = "connect",
  signupCallbackUrl,
  theme = "dark",
  __devForceState,
}: ChatGPTConnectModalProps) {
  // Pull the active palette once per render. Cheap reference — no useMemo
  // needed (THEME_TOKENS is a module-level frozen object). Pass `tokens`
  // through to StateView via prop so child sub-views also resolve theme.
  const tokens = THEME_TOKENS[theme];
  // Endpoint URLs are mode-dependent. In signup mode the routes are
  // session-less and the cookie-set side effect on /signup/start sets the
  // anonymous_session_id used by /signup/poll. Connect mode uses the
  // existing session-protected device-code endpoints.
  const START_ENDPOINT =
    mode === "signup"
      ? "/api/auth/openai/signup/start"
      : "/api/auth/openai/device-code/start";
  const POLL_ENDPOINT =
    mode === "signup"
      ? "/api/auth/openai/signup/poll"
      : "/api/auth/openai/device-code/poll";

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
      const res = await fetch(START_ENDPOINT, {
        method: "POST",
      });
      const data = (await res.json()) as Record<string, unknown>;
      const status = data.status as string | undefined;

      switch (status) {
        case "pending":
          setState({ kind: "polling", flow: data.flow as FlowData });
          return;
        case "connected":
          // Signup mode: this status is never returned by /signup/start
          // (the signup path has no notion of "already connected" — there's
          // no user yet). If it somehow arrives, treat as an error.
          if (mode === "signup") {
            setState({
              kind: "error",
              message:
                "Unexpected response from server. Please refresh and try again.",
            });
            return;
          }
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
  // Defensive: if mode is "signup" and signupCallbackUrl is missing, refuse
  // to start. Signup mode must have a destination to redirect to after
  // signIn() succeeds; without one the user would land on /api/auth/signin
  // by default which would just bounce them right back. Caller bug, not
  // a runtime user-visible error.
  const lastIsOpenRef = useRef(false);
  useEffect(() => {
    // Dev-force: respect injected state, don't fetch.
    if (process.env.NODE_ENV === "development" && __devForceState !== undefined) {
      return;
    }
    if (mode === "signup" && isOpen && !signupCallbackUrl) {
      setState({
        kind: "error",
        message: "Sign-in misconfigured (missing callback URL). Please reload the page.",
      });
      lastIsOpenRef.current = isOpen;
      return;
    }
    // On transition from closed → open, start the flow.
    if (isOpen && !lastIsOpenRef.current) {
      void triggerStart();
    }
    lastIsOpenRef.current = isOpen;
  }, [isOpen, triggerStart, mode, signupCallbackUrl, __devForceState]);

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
        // Signup mode uses cookie-based session identification (the
        // anonymous_session_id HTTPOnly cookie set by /signup/start).
        // No flow_id needs to go in the body — the poll route reads
        // the cookie directly. Connect mode still passes flow_id since
        // the device-code/poll route's body-validate gate requires it.
        const pollBody =
          mode === "signup" ? "{}" : JSON.stringify({ flow_id: currentState.flow.id });
        const res = await fetch(POLL_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: pollBody,
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
            // In signup mode, the response carries a one-shot signupToken.
            // The success effect picks it up and calls signIn() to
            // establish the NextAuth session. In connect mode the field
            // is absent and the success effect closes the modal normally.
            setState({
              kind: "success",
              planType: (data.plan_type as string | null) ?? null,
              summary: data.summary as ConnectedSummary | undefined,
              signupToken:
                typeof data.signupToken === "string"
                  ? data.signupToken
                  : undefined,
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

  // ─── Success: connect-mode auto-close OR signup-mode signIn() ──────────
  //
  // Two distinct behaviors gated on mode:
  //
  //   connect mode (default): the user already has a session. We just
  //     fire the onConnected callback (so the settings panel refreshes
  //     status) and close the modal after a short delay (the user sees
  //     the success state for ~2.5s before the modal dismisses).
  //
  //   signup mode: the user does NOT have a session yet. The success
  //     state's signupToken is a one-shot HMAC-signed JWT (60s exp)
  //     pointing at the freshly created/linked instaclaw_users.id.
  //     Calling signIn() with this token invokes the Credentials
  //     provider's authorize() in lib/auth.ts which verifies the token
  //     and returns the user object, establishing a real NextAuth
  //     session. On success NextAuth redirects to signupCallbackUrl.
  //
  // In signup mode we DON'T auto-close the modal — signIn() either
  // redirects (success) or reloads /signin (failure). The modal unmounts
  // either way because the page changes.
  useEffect(() => {
    if (state.kind !== "success") return;
    if (process.env.NODE_ENV === "development" && __devForceState !== undefined) return;

    if (mode === "signup") {
      // Signup path — establish NextAuth session via Credentials provider.
      const token = state.signupToken;
      if (!token) {
        // Defensive: should never happen because /signup/poll always
        // returns signupToken on completed status. If it does, surface
        // as error so the user can retry rather than being stuck on
        // a perpetual success screen.
        setState({
          kind: "error",
          message:
            "Sign-in token missing from response. Please try signing in again.",
        });
        return;
      }
      if (!signupCallbackUrl) {
        // Same defensive class — caller should have provided this on
        // mount, but if not, fail loudly rather than silently.
        setState({
          kind: "error",
          message:
            "Sign-in misconfigured (missing callback URL). Please reload the page.",
        });
        return;
      }
      // signIn returns a promise that resolves with { ok, url } on success
      // and dispatches a navigation if `redirect: true` (default). We
      // explicitly set `redirect: true` and let NextAuth handle the
      // post-signin navigation to callbackUrl. The modal unmounts as
      // the page transitions.
      void signIn("openai-device-code", {
        signupToken: token,
        callbackUrl: signupCallbackUrl,
        redirect: true,
      });
      return;
    }

    // Connect path — original behavior.
    const summary = state.summary;
    const id = setTimeout(() => {
      onConnected?.(summary);
      onClose();
    }, SUCCESS_AUTO_CLOSE_MS);
    return () => clearTimeout(id);
  }, [state.kind, mode, signupCallbackUrl, onClose, onConnected, __devForceState]);

  // ─── Trigger-focus restoration (P1-D) ─────────────────────────────────
  //
  // On open: capture the element that had focus right before the modal
  // opened (typically the Connect/Manage button on /settings). On close:
  // restore focus to that element so keyboard users return to their
  // place in the page.
  //
  // We use a ref + prevIsOpen pattern instead of a useEffect that runs
  // on every render because document.activeElement at "render time" can
  // be unreliable; capturing it on the false→true edge is the only way
  // to get the true trigger.
  const triggerRef = useRef<HTMLElement | null>(null);
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      const active = document.activeElement;
      triggerRef.current = active instanceof HTMLElement ? active : null;
    }
    if (!isOpen && prevIsOpenRef.current && triggerRef.current) {
      // Defer one tick so the modal's unmount finishes before focus moves.
      const target = triggerRef.current;
      requestAnimationFrame(() => target.focus());
      triggerRef.current = null;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  // ─── Auto-focus inside modal on open + state change (P1-D) ────────────
  //
  // Move focus to the first focusable element inside the modal so keyboard
  // users immediately interact with the modal content. Only steal focus if
  // it's NOT already inside the modal (avoids stealing during Tab cycling).
  //
  // Why the rAF delay: motion.div mounts asynchronously after the React
  // render commits, so the focusable elements aren't queryable until the
  // next frame. requestAnimationFrame is the smallest reliable delay.
  useEffect(() => {
    if (!isOpen) return;
    const raf = requestAnimationFrame(() => {
      const modal = document.querySelector('[data-testid="chatgpt-connect-modal"]');
      if (!modal) return;
      const active = document.activeElement;
      // Don't steal focus if it's already in the modal (mid-interaction).
      if (active instanceof HTMLElement && modal.contains(active)) return;
      const first = modal.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, state.kind]);

  // ─── Keyboard handler — Escape (P1-B) + focus trap (P1-E) ─────────────
  //
  // Single document-level keydown listener. Two responsibilities:
  //
  //   1. Escape: dismiss the modal IF the current state allows dismissal
  //      (same allow-list as backdrop-click — see isDismissalBlocked).
  //
  //   2. Tab: trap focus inside the modal. On Tab from the LAST focusable
  //      element, jump to FIRST. On Shift-Tab from FIRST, jump to LAST.
  //      If focus has drifted outside the modal entirely (browser
  //      keyboard shortcut, user clicked an iframe, etc.), pull it back
  //      to the first focusable.
  //
  // Re-queries focusables on every Tab so state transitions are handled
  // correctly (focusable set differs per state). The handler depends on
  // state.kind so the closure has the current value — slight re-register
  // cost per transition, acceptable.
  useEffect(() => {
    if (!isOpen) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (!isDismissalBlocked(state.kind)) {
          e.preventDefault();
          onClose();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const modal = document.querySelector('[data-testid="chatgpt-connect-modal"]');
      if (!modal) return;
      const focusables = Array.from(
        modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => {
        // Visible only — offsetParent is null when display:none on self or
        // any ancestor. getClientRects fallback catches position:fixed
        // edge cases (unlikely inside modal but defensive).
        return el.offsetParent !== null || el.getClientRects().length > 0;
      });
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inModal = active instanceof Node && modal.contains(active);
      // Focus escaped the modal — pull it back.
      if (!inModal) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, state.kind, onClose]);

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
        role="dialog"
        aria-modal="true"
        aria-labelledby={MODAL_TITLE_ID}
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3 }}
        className="relative w-full max-w-lg rounded-2xl overflow-hidden"
        // Spread the theme's CSS-var overrides FIRST so they apply to the
        // modal scope, then the visual properties below (background, border,
        // boxShadow) — which read the overridden vars — resolve to the
        // edge palette automatically when theme="edge". The pattern is:
        // (1) override vars, (2) reference them. var(--card) inside this
        // modal will be Edge cream if edge, dark card if dark.
        style={{
          ...(tokens.cssVarOverrides ?? {}),
          background: "var(--card)",
          border: "1px solid var(--border)",
          boxShadow:
            theme === "edge"
              ? "0 24px 64px rgba(15,26,18,0.18)"
              : "0 24px 64px rgba(0,0,0,0.2)",
        }}
      >
        {/* Close button — always visible except during success auto-close countdown */}
        {state.kind !== "success" && (
          <button
            onClick={onClose}
            aria-label="Close"
            className={`absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full transition-colors cursor-pointer z-10 hover:opacity-70 ${FOCUS_RING}`}
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
              tokens={tokens}
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
  tokens,
}: {
  state: ModalState;
  onRetry: () => void;
  onDisconnect: () => void;
  onClose: () => void;
  disconnecting: boolean;
  tokens: ThemeTokens;
}) {
  switch (state.kind) {
    case "initial-loading":
      return <ViewInitialLoading />;
    case "polling":
      return <ViewPolling flow={state.flow} tokens={tokens} />;
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
        aria-hidden="true"
      />
      <h2
        id={MODAL_TITLE_ID}
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

type CopyState = "idle" | "copied" | "fallback";

function ViewPolling({ flow, tokens }: { flow: FlowData; tokens: ThemeTokens }) {
  // P1-G: three-state copy. "idle" → "copied" on Clipboard API success;
  // "idle" → "fallback" when writeText throws (HTTP, denied permission,
  // in-app webview, etc.). Both non-idle states show user-visible
  // feedback so the click never feels like a no-op.
  const [copyState, setCopyState] = useState<CopyState>("idle");

  // P2-C: compute remaining from expires_at on every tick (no drift on
  // backgrounded tabs, handles sleep/wake correctly). Initial state uses
  // the same formula so first render matches the steady-state behavior.
  const [secondsRemaining, setSecondsRemaining] = useState(() =>
    Math.max(0, Math.floor((new Date(flow.expires_at).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const expiresMs = new Date(flow.expires_at).getTime();
    const id = setInterval(() => {
      setSecondsRemaining(Math.max(0, Math.floor((expiresMs - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [flow.expires_at]);

  // Copy-state auto-clear back to idle after 1.8s
  useEffect(() => {
    if (copyState === "idle") return;
    const id = setTimeout(() => setCopyState("idle"), 1800);
    return () => clearTimeout(id);
  }, [copyState]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(flow.user_code);
      setCopyState("copied");
    } catch {
      // Clipboard API blocked (non-secure context, denied permission, in-app
      // webview, etc.). Select the text so the user can press ⌘C/Ctrl+C
      // manually, AND tell them to do that.
      const el = document.querySelector("[data-user-code]");
      if (el instanceof HTMLElement) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setCopyState("fallback");
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
            background: `linear-gradient(135deg, ${tokens.brandSurfaceWeak}, ${tokens.brandSurfaceMed})`,
            border: `1px solid ${tokens.brandBorderWeak}`,
          }}
          aria-hidden="true"
        >
          <Sparkles className="w-6 h-6" style={{ color: tokens.brand }} />
        </div>
        <h2
          id={MODAL_TITLE_ID}
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
          row layout on sm: breakpoint+ where horizontal space exists.
          aria-live="polite" on the parent so screen readers announce when
          the code appears or changes. */}
      <div
        className="rounded-2xl p-5 mb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        style={{
          background: tokens.brandSurfaceWeak,
          border: `1px solid ${tokens.brandBorderMed}`,
        }}
        aria-live="polite"
      >
        <div
          data-user-code
          // whitespace-nowrap is load-bearing: without it the "-" between
          // code groups (e.g., "92PM-PLU8N") becomes a wrap point and the
          // code splits across two lines.
          // aria-label spells the code out so SR announces "9 2 P M dash
          // P L U 8 N" instead of mangling pronunciation.
          className="font-mono text-3xl tracking-[0.15em] select-all whitespace-nowrap"
          style={{ fontVariantNumeric: "tabular-nums", color: "var(--foreground)" }}
          aria-label={`Authorization code: ${spellOut(flow.user_code)}`}
        >
          {flow.user_code}
        </div>
        <button
          onClick={handleCopy}
          aria-label={
            copyState === "fallback"
              ? "Copy unavailable — please press Command-C or Control-C to copy manually"
              : copyState === "copied"
              ? "Code copied to clipboard"
              : "Copy code to clipboard"
          }
          data-testid="copy-button"
          data-copy-state={copyState}
          className={`self-start sm:self-auto shrink-0 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${FOCUS_RING}`}
          style={{
            background:
              copyState === "copied"
                ? "rgba(22,163,74,0.1)"
                : copyState === "fallback"
                ? "rgba(234,179,8,0.1)"
                : "rgba(0,0,0,0.04)",
            border: `1px solid ${
              copyState === "copied"
                ? "rgba(22,163,74,0.3)"
                : copyState === "fallback"
                ? "rgba(234,179,8,0.3)"
                : "var(--border)"
            }`,
            color:
              copyState === "copied"
                ? GREEN
                : copyState === "fallback"
                ? "#b45309"
                : "var(--foreground)",
          }}
        >
          {copyState === "copied" ? (
            <>
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              Copied
            </>
          ) : copyState === "fallback" ? (
            <>
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              Press ⌘C
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" aria-hidden="true" />
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
            style={{ background: tokens.brandSurfaceMed, color: tokens.brand }}
          >
            1
          </span>
          <div className="flex-1">
            <p className="leading-snug mb-2">Open OpenAI&apos;s device-code page:</p>
            <a
              href={flow.verification_uri}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${FOCUS_RING}`}
              style={{
                background: tokens.brandGradient,
                boxShadow: tokens.brandButtonShadow,
                color: "#fff",
              }}
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              {flow.verification_uri.replace(/^https?:\/\//, "")}
            </a>
          </div>
        </li>
        <li className="flex items-start gap-3">
          <span
            className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold"
            style={{ background: tokens.brandSurfaceMed, color: tokens.brand }}
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
            style={{ background: tokens.brandSurfaceMed, color: tokens.brand }}
          >
            3
          </span>
          <p className="leading-snug">
            Come back here — we&apos;ll detect when you&apos;re done.
          </p>
        </li>
      </ol>

      {/* Status row — live waiting indicator + countdown.
          aria-live="off" on the countdown to avoid spamming screen readers
          every second; aria-label gives a meaningful name when SR navigates
          to it via Tab/arrow keys. */}
      <div
        className="rounded-xl px-4 py-3 flex items-center justify-between text-xs"
        style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
      >
        <span className="flex items-center gap-2" style={{ color: "var(--muted)" }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: tokens.brand }} aria-hidden="true" />
          Waiting for authorization…
        </span>
        <span
          className="flex items-center gap-1 font-mono"
          style={{ color: secondsRemaining < 60 ? DANGER_TEXT : "var(--muted)" }}
          data-testid="countdown"
          aria-live="off"
          aria-label={`Time remaining: ${mm} minutes ${ss} seconds`}
        >
          <Clock className="w-3 h-3" aria-hidden="true" />
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
          aria-hidden="true"
        >
          <CheckCircle2 className="w-6 h-6" style={{ color: GREEN }} />
        </div>
        <h2
          id={MODAL_TITLE_ID}
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
          className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer ${FOCUS_RING}`}
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
          className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 ${FOCUS_RING}`}
          style={{
            background: DANGER_BG,
            color: DANGER_TEXT,
            border: `1px solid ${DANGER_BORDER}`,
          }}
        >
          {disconnecting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              Disconnecting…
            </>
          ) : (
            <>
              <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
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
        aria-hidden="true"
      >
        <CheckCircle2 className="w-8 h-8" style={{ color: GREEN }} />
      </motion.div>
      <h2
        id={MODAL_TITLE_ID}
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
        aria-hidden="true"
      >
        <AlertTriangle className="w-6 h-6" style={{ color: "#b45309" }} />
      </div>
      <h2
        id={MODAL_TITLE_ID}
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
          className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer text-center inline-flex items-center justify-center gap-2 ${FOCUS_RING}`}
          style={{
            background: BRAND_GRADIENT,
            boxShadow: BRAND_BUTTON_SHADOW,
            color: "#fff",
          }}
        >
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          ChatGPT Settings
        </a>
        <button
          onClick={onClose}
          className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer ${FOCUS_RING}`}
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
        aria-hidden="true"
      >
        <Clock className="w-6 h-6" style={{ color: "var(--muted)" }} />
      </div>
      <h2
        id={MODAL_TITLE_ID}
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
        className={`px-6 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer ${FOCUS_RING}`}
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
        aria-hidden="true"
      />
      <h2
        id={MODAL_TITLE_ID}
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
        aria-hidden="true"
      >
        {icon}
      </div>
      <h2
        id={MODAL_TITLE_ID}
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
          className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all cursor-pointer ${FOCUS_RING}`}
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
          className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer ${FOCUS_RING}`}
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
