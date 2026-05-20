"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { EdgeUserState } from "../edge-user-state";

/**
 * /edge/claim gate state machine.
 *
 * Renders the hero content (headline + body + form) and owns the
 * verified-state reveal. Page-level chrome (top bar, footer) stays in
 * the server-rendered page.tsx.
 *
 * Why the headline lives here: the verified-state reveal restructures
 * the page — the CLAIM YOUR AGENT headline morphs into "Reserved for /
 * the village." at the same visual weight. That transformation is what
 * Cooper called "the page restructures for you" — the difference
 * between a verified-checkmark UX and an invitation-accepted UX.
 *
 * Timing discipline (Cooper's "luxury reveal" guidance):
 *   - 1.2s MIN loading hold even if the API returns faster. The
 *     deliberate "checking" beat prevents the UI from feeling jittery.
 *   - 600ms post-API anticipation pause before the reveal animates in.
 *   - 600ms fade+rise on the verified content.
 *   - 500ms slide-in on the Continue button, delayed 400ms after the
 *     reveal content. Continue button feels earned, not auto-enabled.
 */

const MIN_LOADING_MS = 1200;
const REVEAL_HOLD_MS = 600;

type GateState =
  | { kind: "initial" }
  | { kind: "verifying" }
  | { kind: "verified"; email: string; degraded?: boolean }
  | { kind: "not_found" }
  | { kind: "already_claimed" }
  | { kind: "invalid_email" }
  | { kind: "rate_limited" }
  | { kind: "error" };

interface VerifyResponse {
  verified: boolean;
  email?: string;
  reason?:
    | "invalid_email"
    | "not_found"
    | "already_claimed"
    | "rate_limited"
    | "api_error"
    | "server_error";
  degraded?: boolean;
}

export function ClaimClient({ userState }: { userState: EdgeUserState }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [gateState, setGateState] = useState<GateState>({ kind: "initial" });

  // Surface ?error=not-verified inline on first render (e.g. when the
  // auth callback rejects an expired cookie and redirects back here).
  useEffect(() => {
    if (searchParams.get("error") === "not-verified") {
      setGateState({ kind: "not_found" });
    }
  }, [searchParams]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) {
      setGateState({ kind: "invalid_email" });
      return;
    }

    setGateState({ kind: "verifying" });
    const start = Date.now();

    let data: VerifyResponse;
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

    // Min loading hold for deliberate-feel even if API was fast.
    const elapsed = Date.now() - start;
    if (elapsed < MIN_LOADING_MS) {
      await new Promise((r) => setTimeout(r, MIN_LOADING_MS - elapsed));
    }

    if (data.verified) {
      // Anticipation beat before the reveal animates in.
      await new Promise((r) => setTimeout(r, REVEAL_HOLD_MS));
      setGateState({
        kind: "verified",
        email: data.email ?? trimmed,
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
  }

  function handleContinue() {
    // Live users already have a working agent; route to their bot
    // immediately. Otherwise default to /connect, where the existing
    // onboarding flow handles fresh-signup OR already-signed-in
    // (other terminal is wiring OpenAI OAuth there).
    if (userState.kind === "live") {
      window.location.href = `https://t.me/${userState.botUsername}`;
      return;
    }
    if (userState.kind === "in_progress") {
      router.push(userState.resumePath);
      return;
    }
    router.push("/connect");
  }

  const isVerified = gateState.kind === "verified";
  const isVerifying = gateState.kind === "verifying";
  const isAlreadyClaimed = gateState.kind === "already_claimed";

  return (
    <section className="relative z-10 flex-1 px-4 sm:px-8 pt-12 sm:pt-20 pb-16 sm:pb-24">
      <div className="max-w-[680px] mx-auto">
        {/* ─── Eyebrow / status ticker ─── */}
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.18em] mb-8 sm:mb-10 transition-opacity duration-500"
          style={{ color: "var(--edge-ink-soft)" }}
          key={isVerified ? "ticker-verified" : "ticker-default"}
        >
          {isVerified ? (
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

        {/* ─── Headline — morphs into "Reserved for the village." on verified ─── */}
        <h1
          className="font-bold uppercase tracking-[-0.02em] leading-[0.92] text-[clamp(44px,11vw,96px)] mb-7 sm:mb-9 reveal-anim"
          style={{ color: "var(--edge-ink)" }}
          key={isVerified ? "h1-verified" : "h1-default"}
        >
          {isVerified ? (
            <>
              Reserved
              <br />
              for the village.
            </>
          ) : (
            <>
              Claim your
              <br />
              agent.
            </>
          )}
        </h1>

        {/* ─── Body / instructions ─── */}
        <p
          className="text-[17px] sm:text-[19px] leading-[1.55] max-w-[40ch] mb-10 sm:mb-12 reveal-anim"
          style={{ color: "var(--edge-ink-soft)" }}
          key={isVerified ? "body-verified" : "body-default"}
        >
          {isVerified ? (
            <>Your agent is waiting.</>
          ) : (
            <>
              Your personal agent for the 28-day village.{" "}
              <span style={{ color: "var(--edge-ink)" }}>
                One Telegram message every morning.
              </span>{" "}
              Yours for the full village.
            </>
          )}
        </p>

        {/* ─── Verified reveal — Continue button + email confirmation ─── */}
        {isVerified ? (
          <div className="max-w-md">
            <button
              type="button"
              onClick={handleContinue}
              className="continue-anim w-full px-6 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] inline-flex items-center justify-center gap-2"
              style={{
                background: "var(--edge-olive)",
                color: "#FFFFFF",
                letterSpacing: "0.12em",
              }}
            >
              Continue <span aria-hidden>→</span>
            </button>
            <p
              className="continue-anim text-[12px] leading-[1.55] mt-5"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              {gateState.kind === "verified" && gateState.degraded
                ? "Your spot is held. EdgeOS is briefly unavailable — proceeding without remote confirmation."
                : `Your spot is held under ${gateState.kind === "verified" ? gateState.email : ""}.`}
            </p>
          </div>
        ) : (
          <>
            {/* ─── Verification form ─── */}
            <form onSubmit={handleVerify} className="max-w-md mb-7">
              <label
                htmlFor="ticket-email"
                className="block text-[11px] uppercase tracking-[0.16em] mb-3"
                style={{ color: "var(--edge-ink-soft)" }}
              >
                Verify your ticket
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  id="ticket-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email you registered with"
                  required
                  disabled={isVerifying || isAlreadyClaimed}
                  aria-label="email registered with Edge Esmeralda"
                  autoComplete="email"
                  className="flex-1 px-5 py-3.5 rounded-full text-[14px] outline-none transition-colors focus:border-[var(--edge-olive)] disabled:opacity-60"
                  style={{
                    background: "#FFFFFF",
                    border: "1px solid var(--edge-line)",
                    color: "var(--edge-ink)",
                  }}
                />
                <button
                  type="submit"
                  disabled={isVerifying || isAlreadyClaimed || !email.trim()}
                  className="px-6 py-3.5 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] disabled:opacity-60 inline-flex items-center justify-center gap-2"
                  style={{
                    background: "var(--edge-olive)",
                    color: "#FFFFFF",
                    letterSpacing: "0.12em",
                  }}
                >
                  {isVerifying ? (
                    <span className="checking-pulse">Checking…</span>
                  ) : (
                    <>
                      Verify <span aria-hidden>→</span>
                    </>
                  )}
                </button>
              </div>

              {/* ─── Inline error states ─── */}
              {gateState.kind === "not_found" && (
                <p
                  className="text-[13px] leading-[1.55] mt-3"
                  style={{ color: "var(--edge-olive)" }}
                  role="alert"
                >
                  We couldn&apos;t find that email. Make sure you&apos;re using
                  the email you registered with for Edge Esmeralda.
                </p>
              )}
              {gateState.kind === "invalid_email" && (
                <p
                  className="text-[13px] leading-[1.55] mt-3"
                  style={{ color: "var(--edge-olive)" }}
                  role="alert"
                >
                  That doesn&apos;t look like an email — double-check and try
                  again.
                </p>
              )}
              {gateState.kind === "already_claimed" && (
                <p
                  className="text-[13px] leading-[1.55] mt-3"
                  style={{ color: "var(--edge-olive)" }}
                  role="alert"
                >
                  This email has already been used to claim an agent. If
                  that&apos;s yours, sign in via the link below.
                </p>
              )}
              {gateState.kind === "rate_limited" && (
                <p
                  className="text-[13px] leading-[1.55] mt-3"
                  style={{ color: "var(--edge-olive)" }}
                  role="alert"
                >
                  Too many attempts in a short window. Give it a minute and
                  try again.
                </p>
              )}
              {gateState.kind === "error" && (
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
              )}
            </form>

            {/* ─── Secondary path: existing InstaClaw account ─── */}
            {userState.kind === "logged_out" && (
              <p
                className="text-[13px] leading-[1.55] mb-7 max-w-md"
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

            {/* ─── Consent ─── */}
            <p
              className="text-[12px] leading-[1.55] mb-5 max-w-md"
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

            {/* ─── Self-hosted BYOB branch — unchanged ─── */}
            <p
              className="text-[14px] leading-[1.55] mb-7 max-w-md"
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

            {/* ─── Trust band ─── */}
            <div
              className="pt-5 mt-3 text-[11px] uppercase tracking-[0.16em] max-w-md"
              style={{
                color: "var(--edge-ink-soft)",
                borderTop: "1px solid var(--edge-line-soft)",
              }}
            >
              Free for verified ticket holders.
            </div>
          </>
        )}
      </div>

      {/* Keyframes — the load-bearing 50 lines of CSS Cooper budgeted */}
      <style jsx>{`
        :global(.reveal-anim) {
          animation: gate-fade-rise 600ms cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        :global(.continue-anim) {
          animation: gate-continue-slide 500ms cubic-bezier(0.16, 1, 0.3, 1) 400ms both;
        }
        :global(.checking-pulse) {
          animation: gate-checking 1.4s ease-in-out infinite;
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
        @keyframes gate-checking {
          0%,
          100% {
            opacity: 0.65;
          }
          50% {
            opacity: 1;
          }
        }
      `}</style>
    </section>
  );
}
