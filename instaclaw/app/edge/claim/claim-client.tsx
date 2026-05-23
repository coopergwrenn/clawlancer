"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import type { EdgeUserState } from "../edge-user-state";
import { ChatGPTConnectModal } from "@/components/dashboard/chatgpt-connect-modal";

/**
 * /edge/claim — three-auth-paths gate (2026-05-22 Timour refactor).
 *
 * The state machine the user walks through:
 *
 *   email_entry      → user types email + clicks "unlock"
 *   verifying        → silent /api/edge/verify-ticket (no OTP fired)
 *   auth_choice      → email confirmed; choose ChatGPT / Google / Email
 *   email_otp_*      → only fires the OTP if user picks Email code
 *   not_found, etc.  → error states with inline retry
 *
 * Copy progression (Cooper spec): waiting → unlock → unlocked → activate.
 * Each beat is forward motion, not form-filling. The user never thinks
 * "why am I entering my email again" because the framing is unlocking
 * something already reserved for them, not signing up for a new account.
 *
 * Verification is invisible:
 *   /api/edge/verify-ticket calls SimpleFi /citizens/email/{email}
 *   (read-only, no OTP). Returns first_name + telegram for personalization.
 *
 * OTP is fired ONLY for the Email-code path:
 *   When the user clicks "Email code", /api/edge/start-email-login fires
 *   the EdgeOS third-party-login OTP. The other two paths (ChatGPT,
 *   Google) never trigger an OTP email — they go straight to OAuth.
 *
 * Auth-hierarchy on Edge: ChatGPT PRIMARY (full-width), Google + Email
 * SECONDARY (side-by-side below). Inverted from the normal /signin page
 * — Edge attendees skew AI-native, so ChatGPT is the natural primary
 * here. We can A/B-compare conversion rates against the normal signup
 * after launch (Cooper directive 2026-05-22).
 */

import {
  EDGE_VERIFIED_COOKIE_NAME as _COOKIE_NAME_UNUSED,
} from "@/lib/edge-verified-cookie";
// (Cookie name imported for grep-discoverability; client doesn't read it
// directly — the chain-of-custody check lives in the verify-ticket and
// verify-otp routes.)
void _COOKIE_NAME_UNUSED;

type GateState =
  // Pre-verify
  | { kind: "email_entry" }
  | { kind: "verifying" }
  // Verified — pick how to sign in
  | {
      kind: "auth_choice";
      email: string;
      firstName: string | null;
      telegram: string | null;
      degraded?: boolean;
    }
  // Email-OTP path sub-states
  | {
      kind: "email_otp_sending"; // POSTing /api/edge/start-email-login
      email: string;
      firstName: string | null;
    }
  | {
      kind: "email_otp_entry"; // user typing the 6-digit code
      email: string;
      firstName: string | null;
      otpExpiresInMinutes: number | null;
      resendCooldownUntil: number; // epoch ms — when "Resend" becomes clickable
      codeError?: string; // inline error under the code input
    }
  | {
      kind: "email_otp_verifying"; // POSTing /api/edge/verify-otp
      email: string;
      firstName: string | null;
    }
  | {
      kind: "email_otp_signing_in"; // calling signIn() with the otpToken
      email: string;
      firstName: string | null;
    }
  // OAuth path transitional (after click, before NextAuth redirect)
  | { kind: "oauth_redirecting"; provider: "chatgpt" | "google" }
  // Error states
  | { kind: "not_found" }
  | { kind: "already_claimed" }
  | { kind: "invalid_email" }
  | { kind: "rate_limited" }
  | { kind: "must_verify_first" }
  | { kind: "email_mismatch" }
  | { kind: "error" };

interface VerifyTicketResponse {
  verified: boolean;
  email?: string;
  firstName?: string | null;
  telegram?: string | null;
  degraded?: boolean;
  reason?:
    | "invalid_email"
    | "not_found"
    | "already_claimed"
    | "rate_limited"
    | "api_error"
    | "server_error";
}

interface StartEmailLoginResponse {
  ok: boolean;
  expiresInMinutes?: number | null;
  reason?:
    | "no_cookie"
    | "email_mismatch"
    | "invalid_email"
    | "rate_limited"
    | "api_error";
}

interface VerifyOtpResponse {
  ok: boolean;
  otpToken?: string;
  reason?:
    | "no_cookie"
    | "email_mismatch"
    | "invalid_email"
    | "invalid_code"
    | "code_expired"
    | "rate_limited"
    | "api_error"
    | "server_error";
}

const MIN_VERIFYING_MS = 700; // "unlocking..." beat
const REVEAL_HOLD_MS = 400; // anticipation before auth_choice fades in
const OTP_RESEND_COOLDOWN_MS = 60_000;

// Per Cooper directive 2026-05-22: ChatGPT primary on Edge.
// Edge attendees skew AI-native; ChatGPT is the natural primary here.
// Google + Email are secondary — side-by-side below the primary CTA.

export function ClaimClient({ userState }: { userState: EdgeUserState }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [gateState, setGateState] = useState<GateState>({ kind: "email_entry" });

  // ChatGPT device-code modal — opened inline when the user picks the
  // ChatGPT auth path. Mirrors the /signin pattern (signin-client.tsx:165)
  // so we don't redirect users to /signin where they'd see the SAME
  // chooser they just picked from. The modal owns the full device-code
  // lifecycle: start → polling UI → completion → signIn() → /connect.
  // The edge_verified_email signed cookie set by /api/edge/verify-ticket
  // is already in place by the time this opens, so the OAuth callback in
  // lib/auth.ts honors it and tags the user as partner=edge_city.
  const [chatgptModalOpen, setChatgptModalOpen] = useState(false);

  // Surface ?error=... inline on first render.
  useEffect(() => {
    const err = searchParams.get("error");
    if (err === "not-verified") setGateState({ kind: "not_found" });
    else if (err === "must-verify-first")
      setGateState({ kind: "must_verify_first" });
    else if (err === "email-mismatch") setGateState({ kind: "email_mismatch" });
  }, [searchParams]);

  // Synchronous in-flight guard — prevents double-clicks from firing two
  // parallel verify-ticket requests. Mirrors the pattern already proven on
  // this page (2026-05-22 demo double-click incident).
  const verifyInFlightRef = useRef(false);

  // ── handlers ──────────────────────────────────────────────────────────

  const handleVerify = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (verifyInFlightRef.current) return;
      verifyInFlightRef.current = true;
      try {
        const trimmed = email.trim().toLowerCase();
        if (!trimmed || !trimmed.includes("@")) {
          setGateState({ kind: "invalid_email" });
          return;
        }

        setGateState({ kind: "verifying" });
        const start = Date.now();

        let data: VerifyTicketResponse;
        try {
          const res = await fetch("/api/edge/verify-ticket", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: trimmed }),
          });
          data = await res.json();
        } catch {
          setGateState({ kind: "error" });
          return;
        }

        // Minimum hold so "unlocking..." reads as a deliberate moment.
        const elapsed = Date.now() - start;
        if (elapsed < MIN_VERIFYING_MS) {
          await new Promise((r) => setTimeout(r, MIN_VERIFYING_MS - elapsed));
        }

        if (data.verified) {
          // Brief reveal hold before auth_choice fades in. This is the
          // beat where the headline morphs "your agent is waiting" →
          // "unlocked."
          await new Promise((r) => setTimeout(r, REVEAL_HOLD_MS));
          setGateState({
            kind: "auth_choice",
            email: data.email ?? trimmed,
            firstName: data.firstName ?? null,
            telegram: data.telegram ?? null,
            degraded: data.degraded,
          });
          return;
        }

        switch (data.reason) {
          case "already_claimed":
            setGateState({ kind: "already_claimed" });
            break;
          case "not_found":
            setGateState({ kind: "not_found" });
            break;
          case "invalid_email":
            setGateState({ kind: "invalid_email" });
            break;
          case "rate_limited":
            setGateState({ kind: "rate_limited" });
            break;
          default:
            setGateState({ kind: "error" });
        }
      } finally {
        verifyInFlightRef.current = false;
      }
    },
    [email],
  );

  /**
   * Logged-in users (live / in_progress) skip the auth-choice screen
   * entirely — they already have a session. Route through
   * /api/partner/tag-redirect to tag their existing user + VM as
   * edge_city, then land on the right destination per the GET handler's
   * routing rules.
   */
  const handleLoggedInContinue = useCallback(() => {
    if (userState.kind === "live" || userState.kind === "in_progress") {
      window.location.href = "/api/partner/tag-redirect";
    }
  }, [userState.kind]);

  /**
   * ChatGPT path — open the device-code modal INLINE on this page.
   *
   * Why inline (vs. routing to /signin): ChatGPT is a multi-step device-
   * code flow (start → user_code display → polling → signupToken →
   * signIn(OPENAI_DEVICE_CODE_PROVIDER_ID)). The /signin page wraps the
   * same ChatGPTConnectModal but presents the Google + ChatGPT chooser
   * BEFORE opening it. Routing Edge users to /signin shows them the
   * chooser they just made a choice from — exactly the double-screen UX
   * Timour flagged on the 2026-05-22 call.
   *
   * Mounting the modal here means the user clicks "Continue with
   * ChatGPT" → sees the device-code instructions immediately → no
   * intermediate chooser screen. On success the modal's internal
   * signIn() honors our edge_verified cookie chain and lands on /connect.
   *
   * We don't transition gateState to `oauth_redirecting` because the
   * modal owns its own loading UI. Setting that state would hide the
   * auth_choice screen behind the modal, looking odd if the user
   * dismisses the modal (we want them back at the auth_choice screen
   * with all three options visible).
   */
  const handleSignInChatGPT = useCallback(() => {
    setChatgptModalOpen(true);
  }, []);

  /**
   * Google path — direct signIn() invocation. NextAuth handles the
   * provider redirect; the OAuth callback in lib/auth.ts honors the
   * edge_verified cookie and creates/links the user with
   * partner=edge_city + edge_verified_email = <email>.
   */
  const handleSignInGoogle = useCallback(() => {
    setGateState({ kind: "oauth_redirecting", provider: "google" });
    signIn("google", { callbackUrl: "/connect" });
  }, []);

  /**
   * Email-code path — fire /api/edge/start-email-login, which calls
   * EdgeOS third-party-login (the ONLY place we trigger an OTP email).
   * On success transition to email_otp_entry. On EdgeOS rate-limit
   * AT THE EDGE within 60s of the previous fire we skip the network
   * call and reuse the prior OTP entry state (per Cooper directive
   * 2026-05-22: "don't re-fire OTP on retries within 60s").
   */
  const handleStartEmailOtp = useCallback(async () => {
    if (gateState.kind !== "auth_choice") return;

    const authChoice = gateState; // capture for type narrowing
    setGateState({
      kind: "email_otp_sending",
      email: authChoice.email,
      firstName: authChoice.firstName,
    });

    let data: StartEmailLoginResponse;
    try {
      const res = await fetch("/api/edge/start-email-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authChoice.email }),
      });
      data = await res.json();
    } catch {
      setGateState({ kind: "error" });
      return;
    }

    if (data.ok) {
      setGateState({
        kind: "email_otp_entry",
        email: authChoice.email,
        firstName: authChoice.firstName,
        otpExpiresInMinutes: data.expiresInMinutes ?? null,
        resendCooldownUntil: Date.now() + OTP_RESEND_COOLDOWN_MS,
      });
      return;
    }

    // Failure — most reasons are recoverable from the auth_choice screen.
    // Surface a top-level error and let them re-try the flow.
    switch (data.reason) {
      case "rate_limited":
        setGateState({ kind: "rate_limited" });
        break;
      case "no_cookie":
      case "email_mismatch":
        // Cookie expired or got out of sync — re-verify from scratch.
        setGateState({ kind: "must_verify_first" });
        break;
      default:
        setGateState({ kind: "error" });
    }
  }, [gateState]);

  /**
   * OTP code submit. Validates with /api/edge/verify-otp, receives a
   * one-shot HMAC token, then calls signIn(EDGE_EMAIL_OTP_PROVIDER_ID,
   * { otpToken }) to mint the NextAuth session.
   */
  const handleVerifyOtp = useCallback(
    async (code: string) => {
      if (gateState.kind !== "email_otp_entry") return;
      const otpEntry = gateState; // type narrow

      const cleanCode = code.trim();
      if (!/^\d{6}$/.test(cleanCode)) {
        setGateState({ ...otpEntry, codeError: "Enter the 6-digit code." });
        return;
      }

      setGateState({
        kind: "email_otp_verifying",
        email: otpEntry.email,
        firstName: otpEntry.firstName,
      });

      let data: VerifyOtpResponse;
      try {
        const res = await fetch("/api/edge/verify-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: otpEntry.email, code: cleanCode }),
        });
        data = await res.json();
      } catch {
        setGateState({ kind: "error" });
        return;
      }

      if (!data.ok || !data.otpToken) {
        const errorMap: Record<string, string> = {
          invalid_code: "That code doesn't match. Check your inbox and try again.",
          code_expired: "That code expired. Tap resend below for a fresh one.",
          rate_limited:
            "Too many attempts. Wait a minute, then try the resend below.",
        };
        const codeError =
          data.reason && errorMap[data.reason]
            ? errorMap[data.reason]
            : "Something on our end failed. Try again.";
        // Bounce back to entry state with the inline error.
        setGateState({
          kind: "email_otp_entry",
          email: otpEntry.email,
          firstName: otpEntry.firstName,
          otpExpiresInMinutes: otpEntry.otpExpiresInMinutes,
          resendCooldownUntil: otpEntry.resendCooldownUntil,
          codeError,
        });
        return;
      }

      // Code verified server-side, user upserted, otpToken minted.
      // Hand off to NextAuth — signIn() will redirect to /connect.
      setGateState({
        kind: "email_otp_signing_in",
        email: otpEntry.email,
        firstName: otpEntry.firstName,
      });
      // Use redirect:false so we can detect signIn errors + own the
      // navigation. NextAuth returns { ok, error, url } when redirect is
      // disabled; we trigger the navigation manually only on success.
      const signInResult = await signIn("edge-email-otp", {
        otpToken: data.otpToken,
        callbackUrl: "/connect",
        redirect: false,
      });
      if (!signInResult || signInResult.error) {
        setGateState({ kind: "error" });
        return;
      }
      // Navigate to the callback URL ourselves (NextAuth would normally
      // do this with redirect:true). window.location preserves the
      // session cookie write that just happened.
      window.location.href = signInResult.url ?? "/connect";
    },
    [gateState],
  );

  const handleResendOtp = useCallback(async () => {
    if (gateState.kind !== "email_otp_entry") return;
    if (Date.now() < gateState.resendCooldownUntil) return;

    // Transition to sending, then re-enter on success/failure.
    const prev = gateState;
    setGateState({
      kind: "email_otp_sending",
      email: prev.email,
      firstName: prev.firstName,
    });
    try {
      const res = await fetch("/api/edge/start-email-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: prev.email }),
      });
      const data: StartEmailLoginResponse = await res.json();
      if (data.ok) {
        setGateState({
          kind: "email_otp_entry",
          email: prev.email,
          firstName: prev.firstName,
          otpExpiresInMinutes: data.expiresInMinutes ?? null,
          resendCooldownUntil: Date.now() + OTP_RESEND_COOLDOWN_MS,
        });
      } else if (data.reason === "rate_limited") {
        setGateState({
          kind: "email_otp_entry",
          email: prev.email,
          firstName: prev.firstName,
          otpExpiresInMinutes: prev.otpExpiresInMinutes,
          resendCooldownUntil: Date.now() + OTP_RESEND_COOLDOWN_MS,
          codeError: "Too many resend attempts. Wait a minute and try again.",
        });
      } else {
        setGateState({ kind: "error" });
      }
    } catch {
      setGateState({ kind: "error" });
    }
  }, [gateState]);

  const handleResetToEntry = useCallback(() => {
    setGateState({ kind: "email_entry" });
  }, []);

  // ── derived ──────────────────────────────────────────────────────────

  const isVerifying = gateState.kind === "verifying";
  const isEmailEntry = gateState.kind === "email_entry";
  const isAuthChoice = gateState.kind === "auth_choice";
  const isOtpFlow =
    gateState.kind === "email_otp_sending" ||
    gateState.kind === "email_otp_entry" ||
    gateState.kind === "email_otp_verifying" ||
    gateState.kind === "email_otp_signing_in";
  const isOauthRedirecting = gateState.kind === "oauth_redirecting";
  const isErrorState =
    gateState.kind === "not_found" ||
    gateState.kind === "already_claimed" ||
    gateState.kind === "invalid_email" ||
    gateState.kind === "rate_limited" ||
    gateState.kind === "must_verify_first" ||
    gateState.kind === "email_mismatch" ||
    gateState.kind === "error";

  // Headline morphs per state. Copy progression per Cooper spec:
  // waiting → unlocking → unlocked → almost there.
  const headlineText = (() => {
    if (isVerifying) return "Unlocking…";
    if (isAuthChoice || isOauthRedirecting) return "Unlocked.";
    if (isOtpFlow) return "Almost there.";
    return "Your agent is waiting.";
  })();

  return (
    <>
    <section className="relative z-10 flex-1 px-4 sm:px-8 pt-12 sm:pt-20 pb-16 sm:pb-24">
      <div className="max-w-[680px] mx-auto">
        {/* ─── Eyebrow ─── */}
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.18em] mb-8 sm:mb-10 transition-opacity duration-500"
          style={{ color: "var(--edge-ink-soft)" }}
          key={isAuthChoice ? "ticker-verified" : "ticker-default"}
        >
          {isAuthChoice ? (
            <span style={{ color: "var(--edge-olive)" }}>
              ✓ Verified · Edge Esmeralda 2026
            </span>
          ) : (
            <>
              <span style={{ color: "var(--edge-olive)" }}>● Live</span>
              <span aria-hidden style={{ opacity: 0.35 }}>
                /
              </span>
              <span>May 30 – Jun 27, 2026</span>
              <span aria-hidden style={{ opacity: 0.35 }}>
                /
              </span>
              <span>Healdsburg, CA</span>
            </>
          )}
        </div>

        {/* ─── Headline ─── */}
        <h1
          className="font-bold uppercase tracking-[-0.02em] leading-[0.92] text-[clamp(44px,11vw,96px)] mb-6 sm:mb-7 reveal-anim"
          style={{ color: "var(--edge-ink)" }}
          key={`h1-${gateState.kind}`}
        >
          {headlineText}
        </h1>

        {/* ─── Personalization line (verified state only) ─── */}
        {(isAuthChoice || isOtpFlow || isOauthRedirecting) && (
          <p
            className="text-[18px] sm:text-[20px] leading-[1.45] mb-5 reveal-anim"
            style={{ color: "var(--edge-ink)" }}
            key={`personalize-${gateState.kind}`}
          >
            {(() => {
              // Pull firstName from whatever variant is active.
              const fn =
                "firstName" in gateState ? gateState.firstName : null;
              if (fn) return <>Welcome back, {fn}.</>;
              return <>You&apos;re in.</>;
            })()}
          </p>
        )}

        {/* ─── Body ─── */}
        <p
          className="text-[16px] sm:text-[18px] leading-[1.55] max-w-[40ch] mb-9 sm:mb-11 reveal-anim"
          style={{ color: "var(--edge-ink-soft)" }}
          key={`body-${gateState.kind}`}
        >
          {isEmailEntry || isVerifying ? (
            <>Enter the email you registered with to unlock it.</>
          ) : isAuthChoice ? (
            <>Choose how to sign in to activate your agent:</>
          ) : isOtpFlow && gateState.kind !== "email_otp_signing_in" ? (
            <>
              We sent a code to{" "}
              <span style={{ color: "var(--edge-ink)" }}>
                {"email" in gateState ? gateState.email : ""}
              </span>
              .
            </>
          ) : gateState.kind === "email_otp_signing_in" ? (
            <>Signing you in…</>
          ) : gateState.kind === "oauth_redirecting" ? (
            <>
              Redirecting to{" "}
              {gateState.provider === "chatgpt" ? "ChatGPT" : "Google"}…
            </>
          ) : (
            <>&nbsp;</>
          )}
        </p>

        {/* ─── Logged-in shortcut — bypass auth choice ─── */}
        {(userState.kind === "live" || userState.kind === "in_progress") &&
          isEmailEntry && (
            <div className="max-w-md mb-7">
              <button
                type="button"
                onClick={handleLoggedInContinue}
                className="continue-anim w-full px-6 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: "var(--edge-olive)",
                  color: "#FFFFFF",
                  letterSpacing: "0.12em",
                }}
              >
                Continue as signed-in user →
              </button>
              <p
                className="mt-3 text-[12px] leading-[1.6]"
                style={{ color: "var(--edge-ink-soft)" }}
              >
                Or enter the email you registered with for Edge Esmeralda
                below to claim it for a different account.
              </p>
            </div>
          )}

        {/* ─── State A + B: Email entry / Verifying ─── */}
        {(isEmailEntry || isVerifying) && (
          <form onSubmit={handleVerify} className="max-w-md mb-7">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="ticket-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your Edge Esmeralda email"
                required
                disabled={isVerifying}
                aria-label="email you registered with for Edge Esmeralda"
                autoComplete="email"
                inputMode="email"
                className="flex-1 px-5 py-3.5 rounded-full text-[14px] outline-none transition-colors focus:border-[var(--edge-olive)] disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: "#FFFFFF",
                  border: "1px solid var(--edge-line)",
                  color: "var(--edge-ink)",
                }}
              />
              <button
                type="submit"
                disabled={isVerifying || !email.trim()}
                aria-busy={isVerifying}
                className="px-6 py-3.5 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
                style={{
                  background: "var(--edge-olive)",
                  color: "#FFFFFF",
                  letterSpacing: "0.12em",
                }}
              >
                {isVerifying ? (
                  <>
                    <Spinner />
                    Unlocking…
                  </>
                ) : (
                  <>
                    Unlock <span aria-hidden>→</span>
                  </>
                )}
              </button>
            </div>
            <ErrorLine gateState={gateState} />
          </form>
        )}

        {/* ─── State C: Auth choice (the new core of the flow) ─── */}
        {isAuthChoice && (
          <div className="max-w-md mb-7 continue-anim">
            {/* Primary CTA — ChatGPT (Edge inverts the default). Full-width. */}
            <button
              type="button"
              onClick={handleSignInChatGPT}
              className="w-full px-6 py-4 rounded-full text-[14px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] inline-flex items-center justify-center gap-2.5 mb-3"
              style={{
                background: "var(--edge-olive)",
                color: "#FFFFFF",
                letterSpacing: "0.12em",
              }}
            >
              <ChatGPTIcon />
              Continue with ChatGPT
            </button>

            {/* Secondary row — Google + Email side-by-side */}
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button
                type="button"
                onClick={handleSignInGoogle}
                className="px-4 py-3 rounded-full text-[13px] font-medium transition-colors inline-flex items-center justify-center gap-2 hover:bg-[rgba(0,0,0,0.04)]"
                style={{
                  background: "#FFFFFF",
                  border: "1px solid var(--edge-line)",
                  color: "var(--edge-ink)",
                }}
              >
                <GoogleIcon />
                Google
              </button>
              <button
                type="button"
                onClick={handleStartEmailOtp}
                className="px-4 py-3 rounded-full text-[13px] font-medium transition-colors inline-flex items-center justify-center gap-2 hover:bg-[rgba(0,0,0,0.04)]"
                style={{
                  background: "#FFFFFF",
                  border: "1px solid var(--edge-line)",
                  color: "var(--edge-ink)",
                }}
              >
                <EmailIcon />
                Email code
              </button>
            </div>

            {/* Degraded note */}
            {gateState.degraded && (
              <p
                className="text-[12px] leading-[1.6] mt-2"
                style={{ color: "var(--edge-ink-soft)" }}
              >
                Your spot is held. EdgeOS is briefly unavailable; proceeding
                without remote confirmation.
              </p>
            )}

            <p
              className="text-[12px] leading-[1.6] mt-4"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              Held under{" "}
              <span className="font-mono" style={{ color: "var(--edge-ink)" }}>
                {gateState.email}
              </span>
              .
            </p>
          </div>
        )}

        {/* ─── State D-F: OAuth redirecting (transitional) ─── */}
        {isOauthRedirecting && (
          <div className="max-w-md mb-7 flex items-center gap-3 continue-anim">
            <Spinner large />
            <span
              className="text-[14px]"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              Opening{" "}
              {gateState.provider === "chatgpt" ? "ChatGPT" : "Google"}…
            </span>
          </div>
        )}

        {/* ─── State E: Email OTP entry ─── */}
        {gateState.kind === "email_otp_sending" && (
          <div className="max-w-md mb-7 flex items-center gap-3 continue-anim">
            <Spinner large />
            <span
              className="text-[14px]"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              Sending your code…
            </span>
          </div>
        )}

        {gateState.kind === "email_otp_entry" && (
          <OtpEntryForm
            state={gateState}
            onSubmit={handleVerifyOtp}
            onResend={handleResendOtp}
            onBackToChoices={() => {
              // Re-show the auth_choice without re-verifying email — the
              // cookie is still valid; reconstruct state from the existing
              // OTP-entry context. (firstName is preserved.)
              setGateState({
                kind: "auth_choice",
                email: gateState.email,
                firstName: gateState.firstName,
                // We don't have telegram on entry state; pass-through null.
                telegram: null,
                degraded: false,
              });
            }}
          />
        )}

        {gateState.kind === "email_otp_verifying" && (
          <div className="max-w-md mb-7 flex items-center gap-3 continue-anim">
            <Spinner large />
            <span
              className="text-[14px]"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              Verifying…
            </span>
          </div>
        )}

        {gateState.kind === "email_otp_signing_in" && (
          <div className="max-w-md mb-7 flex items-center gap-3 continue-anim">
            <Spinner large />
            <span
              className="text-[14px]"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              Activating your agent…
            </span>
          </div>
        )}

        {/* ─── Error states with reset CTA ─── */}
        {isErrorState && (
          <div className="max-w-md mb-7">
            <ErrorLine gateState={gateState} />
            <button
              type="button"
              onClick={handleResetToEntry}
              className="mt-4 px-5 py-3 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)]"
              style={{
                background: "var(--edge-olive)",
                color: "#FFFFFF",
                letterSpacing: "0.12em",
              }}
            >
              Try again
            </button>
          </div>
        )}

        {/* ─── Secondary links (always visible) ─── */}
        {(isEmailEntry || isErrorState) && (
          <>
            {userState.kind === "logged_out" && (
              <p
                className="text-[13px] leading-[1.55] mb-5 max-w-md"
                style={{ color: "var(--edge-ink-soft)" }}
              >
                Already have an InstaClaw agent?{" "}
                <Link
                  href="/signin?callbackUrl=%2Fapi%2Fpartner%2Ftag-redirect"
                  className="underline underline-offset-2 font-medium"
                  style={{ color: "var(--edge-ink)" }}
                >
                  Sign in to claim it for Edge →
                </Link>
              </p>
            )}

            <p
              className="text-[12px] leading-[1.55] mb-4 max-w-md"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              By verifying you agree to participate in the EE26 research
              program.{" "}
              <Link
                href="/edge/consent"
                className="underline underline-offset-2"
                style={{ color: "var(--edge-ink)" }}
              >
                Read the consent brief.
              </Link>
            </p>

            <p
              className="text-[13px] leading-[1.55] mb-6 max-w-md"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              Already have your own agent?{" "}
              <Link
                href="/edge/byob"
                className="underline underline-offset-2 font-medium"
                style={{ color: "var(--edge-ink)" }}
              >
                Install the Edge skill manually →
              </Link>
            </p>

            <div
              className="pt-5 mt-3 text-[11px] uppercase tracking-[0.16em] max-w-md"
              style={{
                color: "var(--edge-ink-soft)",
                borderTop: "1px solid var(--edge-line-soft)",
              }}
            >
              Sponsor-funded through June 30.
            </div>
          </>
        )}
      </div>

      <style jsx>{`
        :global(.reveal-anim) {
          animation: gate-fade-rise 600ms cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        :global(.continue-anim) {
          animation: gate-continue-slide 500ms cubic-bezier(0.16, 1, 0.3, 1) 200ms both;
        }
        @keyframes gate-fade-rise {
          0% {
            opacity: 0;
            transform: translateY(8px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes gate-continue-slide {
          0% {
            opacity: 0;
            transform: translateY(12px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </section>

    {/* ChatGPT signup-mode modal — mounted inline so the device-code flow
        runs without redirecting users to /signin (which would re-show the
        Google + ChatGPT chooser they just made a choice from — exactly the
        double-screen UX Timour flagged 2026-05-22). The modal owns its own
        backdrop + focus trap; closing returns the user to the auth_choice
        screen with all three buttons still visible.
        On success the modal calls signIn(OPENAI_DEVICE_CODE_PROVIDER_ID,
        {signupToken, callbackUrl: "/connect"}). The edge_verified_email
        signed cookie set by /api/edge/verify-ticket is honored by the
        OAuth callback in lib/auth.ts. */}
    <ChatGPTConnectModal
      isOpen={chatgptModalOpen}
      onClose={() => setChatgptModalOpen(false)}
      mode="signup"
      signupCallbackUrl="/connect"
    />
    </>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

function Spinner({ large }: { large?: boolean }) {
  const size = large ? "h-5 w-5" : "h-3.5 w-3.5";
  return (
    <svg
      className={`animate-spin ${size}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function ChatGPTIcon() {
  // Inlined OpenAI mark — 16px, currentColor. Avoids any external dep.
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}

function OtpEntryForm({
  state,
  onSubmit,
  onResend,
  onBackToChoices,
}: {
  state: Extract<GateState, { kind: "email_otp_entry" }>;
  onSubmit: (code: string) => void;
  onResend: () => void;
  onBackToChoices: () => void;
}) {
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(Date.now());

  // Tick the cooldown counter every second so "Resend in Ns" decrements.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const secondsUntilResend = Math.max(
    0,
    Math.ceil((state.resendCooldownUntil - now) / 1000),
  );
  const canResend = secondsUntilResend === 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
      className="max-w-md mb-7 continue-anim"
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        value={code}
        onChange={(e) =>
          setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
        }
        placeholder="123456"
        aria-label="6-digit code"
        className="w-full text-center text-[28px] font-mono tracking-[0.4em] px-5 py-4 rounded-2xl outline-none transition-colors focus:border-[var(--edge-olive)]"
        style={{
          background: "#FFFFFF",
          border: "1px solid var(--edge-line)",
          color: "var(--edge-ink)",
        }}
      />

      {state.codeError && (
        <p
          className="text-[13px] leading-[1.55] mt-3"
          style={{ color: "var(--edge-olive)" }}
          role="alert"
        >
          {state.codeError}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-2 mt-4">
        <button
          type="submit"
          disabled={code.length !== 6}
          className="flex-1 px-6 py-3.5 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          style={{
            background: "var(--edge-olive)",
            color: "#FFFFFF",
            letterSpacing: "0.12em",
          }}
        >
          Verify <span aria-hidden>→</span>
        </button>
      </div>

      <div className="flex items-center justify-between mt-4 text-[12px]">
        <button
          type="button"
          onClick={onResend}
          disabled={!canResend}
          className="underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
          style={{ color: canResend ? "var(--edge-ink)" : "var(--edge-ink-soft)" }}
        >
          {canResend
            ? "Resend code"
            : `Resend code in ${secondsUntilResend}s`}
        </button>
        <button
          type="button"
          onClick={onBackToChoices}
          className="underline underline-offset-2"
          style={{ color: "var(--edge-ink-soft)" }}
        >
          ← Use different sign-in
        </button>
      </div>
    </form>
  );
}

function ErrorLine({ gateState }: { gateState: GateState }) {
  if (gateState.kind === "not_found") {
    return (
      <p
        className="text-[13px] leading-[1.55] mt-3"
        style={{ color: "var(--edge-olive)" }}
        role="alert"
      >
        We couldn&apos;t find that email in the Edge directory. Check the
        email you registered with, or get a ticket at{" "}
        <a
          href="https://edgecity.live"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          edgecity.live
        </a>
        .
      </p>
    );
  }
  if (gateState.kind === "invalid_email") {
    return (
      <p
        className="text-[13px] leading-[1.55] mt-3"
        style={{ color: "var(--edge-olive)" }}
        role="alert"
      >
        That doesn&apos;t look like an email. Double-check and try again.
      </p>
    );
  }
  if (gateState.kind === "already_claimed") {
    return (
      <p
        className="text-[13px] leading-[1.55] mt-3"
        style={{ color: "var(--edge-olive)" }}
        role="alert"
      >
        This email has already been used to claim an agent. If that&apos;s
        yours, sign in via the link below.
      </p>
    );
  }
  if (gateState.kind === "rate_limited") {
    return (
      <p
        className="text-[13px] leading-[1.55] mt-3"
        style={{ color: "var(--edge-olive)" }}
        role="alert"
      >
        Too many attempts in a short window. Give it a minute and try again.
      </p>
    );
  }
  if (gateState.kind === "must_verify_first") {
    return (
      <p
        className="text-[13px] leading-[1.55] mt-3"
        style={{ color: "var(--edge-olive)" }}
        role="status"
      >
        Verify your Edge Esmeralda email below first. That&apos;s how we
        know your spot in the village is real.
      </p>
    );
  }
  if (gateState.kind === "email_mismatch") {
    return (
      <p
        className="text-[13px] leading-[1.55] mt-3"
        style={{ color: "var(--edge-olive)" }}
        role="alert"
      >
        The email you verified doesn&apos;t match the account you signed in
        with. Re-verify below using the same email you&apos;ll sign in with.
      </p>
    );
  }
  if (gateState.kind === "error") {
    return (
      <p
        className="text-[13px] leading-[1.55] mt-3"
        style={{ color: "var(--edge-olive)" }}
        role="alert"
      >
        Something on our end failed. Try again, or email{" "}
        <a
          href="mailto:coop@valtlabs.com"
          className="underline underline-offset-2"
        >
          coop@valtlabs.com
        </a>
        .
      </p>
    );
  }
  return null;
}
