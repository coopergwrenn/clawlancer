"use client";

import { signIn } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ChatGPTConnectModal } from "@/components/dashboard/chatgpt-connect-modal";
import { EdgePartnerBanner } from "@/components/marketing/edge-partner-banner";

// Brand constants — copied from /channels to keep the two pages
// visually paired. /channels is the design-language reference for the
// entire onboarding funnel (2026-05 polish pass). If these values
// change there, change here too.
const CORAL = "#E96F4D";
const CREAM_BG = "#f8f7f4";
const CARD_INK = "#333334";
const MUTED_INK = "#6b6b6b";
const SUBTLE_INK = "#9a9892";

// localStorage key for cross-visit ref preservation (legacy /signup
// behavior — a user who arrived at /signup?ref=X last week, didn't
// sign up, comes back this week to /signin: we restore their ref so
// the ambassador still gets credit on signup).
const REFERRAL_STORAGE_KEY = "instaclaw_ref";

/**
 * /signin client view.
 *
 * Receives `callbackUrl` + `initialRef` as props from the server
 * component wrapper. The wrapper parses + validates ?callbackUrl=
 * and ?ref=, checks the NextAuth session, and redirects authenticated
 * users to callbackUrl BEFORE this component ever renders. By the
 * time we mount, we know:
 *
 *   - User is NOT authenticated (server redirected if they were)
 *   - callbackUrl is safe (relative path, not /signin itself)
 *   - initialRef (if present) matches /^[a-zA-Z0-9_-]{1,64}$/
 *
 * No useSearchParams here; no Suspense boundary needed. The previous
 * client-only implementation used useSearchParams + Suspense; W5
 * (2026-05-22 audit fix) moved the session check + URL parsing to
 * the server, which also dropped the suspended-on-mount flicker.
 *
 * Referral expand (Move 2 + 5, 2026-05-28):
 *
 * The footer "have an invite code? use it here." toggles a pill-
 * shaped input below the OAuth buttons. When a user arrives with
 * ?ref= (or has localStorage.instaclaw_ref from a previous visit),
 * the expand auto-opens with the code pre-filled and validated.
 * The validated code is written to /api/invite/store as a cookie
 * BEFORE the OAuth call, so lib/auth.ts's Google signIn callback
 * (and the ChatGPT modal's eventual signIn() call) can read it
 * during user creation and apply the 25%-off referral discount.
 *
 * This consolidates /signup's only remaining unique feature into
 * /signin, so /signup can be a thin redirect (Move 3) without
 * losing the ambassador attribution flow.
 */
export function SignInClient({
  callbackUrl,
  initialRef,
  isNewUser,
}: {
  callbackUrl: string;
  initialRef?: string;
  /**
   * Server-resolved from `?new=1` query param appended by the landing-
   * page "Claim My Agent" / "get started" CTAs. When true, swap the
   * headline from "sign in." to "claim your agent." so the energy of
   * the click survives the navigation. Default false — direct visits
   * and nav-"sign in" clicks keep the original copy. See page.tsx for
   * the param parsing.
   */
  isNewUser?: boolean;
}) {
  // ChatGPT-as-signin opens the device-code modal in signup mode. The
  // modal handles the full polling + identity-resolution + signIn() flow
  // (chatgpt-connect-modal.tsx + lib/openai-signup-*). On success the
  // modal calls signIn("openai-device-code", {signupToken, callbackUrl})
  // which establishes a NextAuth session via the Credentials provider
  // and redirects to callbackUrl.
  const [chatgptModalOpen, setChatgptModalOpen] = useState(false);

  // Referral expand state. Toggled by the footer button below.
  // - referralExpanded: is the input visible?
  // - referralCode: current input value
  // - referralValid: null = unknown, true = ambassador-validated,
  //   false = unrecognized (gates the pre-OAuth /api/invite/store
  //   call so a typo doesn't burn the user's signup with a phantom
  //   referrer)
  // - referralName: ambassador display name on success
  // - inputFocused: drives the focus-ring + neutral-border styling
  //   without mutating the DOM (we need state-driven render so the
  //   validation-color rules override the focus-color rules cleanly)
  const [referralExpanded, setReferralExpanded] = useState(false);
  const [referralCode, setReferralCode] = useState("");
  const [referralValid, setReferralValid] = useState<boolean | null>(null);
  const [referralName, setReferralName] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Hydrate on mount. ?ref= (passed via initialRef prop) wins over
  // localStorage — represents the user's most recent intent (they
  // just clicked an ambassador link). localStorage is the fallback
  // for users who saw an ambassador link in a previous visit and
  // are returning now without the URL param. Either source: pre-
  // fill input, open expand, validate immediately. Empty source:
  // expand stays collapsed, footer toggle is the only way in.
  useEffect(() => {
    let code: string | null = null;
    if (initialRef) {
      code = initialRef;
    } else {
      try {
        code = localStorage.getItem(REFERRAL_STORAGE_KEY);
      } catch {
        /* localStorage unavailable (SSR snapshot, private mode) */
      }
    }
    if (code) {
      setReferralCode(code);
      setReferralExpanded(true);
      validateReferral(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRef]);

  // Validate against /api/ambassador/validate-referral. Called on:
  //   - mount (when ?ref= or localStorage hydrates the input)
  //   - input blur
  //   - Enter key in input
  // NOT called on every keystroke — /signup's pattern did that and
  // hammered the API for nothing. Out-of-order responses are
  // tolerated: the latest response wins via the standard React
  // state update.
  async function validateReferral(code: string) {
    const trimmed = code.trim();
    if (!trimmed) {
      setReferralValid(null);
      setReferralName("");
      return;
    }
    try {
      const res = await fetch("/api/ambassador/validate-referral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = (await res.json()) as {
        valid?: boolean;
        ambassadorName?: string;
      };
      setReferralValid(!!data.valid);
      setReferralName(data.ambassadorName || "");
      // Persist on success — mirror /signup's legacy behavior so a
      // user who validates then doesn't sign in immediately retains
      // the code on next visit.
      if (data.valid) {
        try {
          localStorage.setItem(REFERRAL_STORAGE_KEY, trimmed);
        } catch {
          /* private mode */
        }
      }
    } catch {
      setReferralValid(false);
      setReferralName("");
    }
  }

  // Pre-OAuth referral cookie write. Sets instaclaw_referral_code via
  // /api/invite/store so that lib/auth.ts's Google signIn callback
  // can read it from the request cookies and apply the 25%-off
  // referral during user-row INSERT. Gated on referralValid === true:
  // an unvalidated or invalid code is silently dropped (same
  // graceful fallback /signup had). Non-fatal — if the fetch fails
  // the OAuth still proceeds, the user just signs in without
  // the referral applied.
  async function storeReferralBeforeOAuth() {
    if (referralCode.trim() && referralValid === true) {
      try {
        await fetch("/api/invite/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ referralCode: referralCode.trim() }),
        });
      } catch {
        /* non-fatal — let auth proceed without referral */
      }
    }
  }

  async function handleGoogleClick() {
    await storeReferralBeforeOAuth();
    signIn("google", { callbackUrl });
  }

  async function handleChatGPTClick() {
    await storeReferralBeforeOAuth();
    setChatgptModalOpen(true);
  }

  // Footer toggle handler. Toggle pattern (open ↔ close) so the
  // user can dismiss the expand if they changed their mind. State
  // (code, validity) is preserved across collapses so re-opening
  // restores the previous input — no surprise resets. On open we
  // focus the input via requestAnimationFrame so the DOM has
  // settled by the time .focus() runs.
  function toggleReferralExpand() {
    setReferralExpanded((prev) => {
      const next = !prev;
      if (next) {
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      return next;
    });
  }

  // Border color is state-driven so validation results override focus
  // styling without DOM mutations fighting React re-renders. The
  // precedence: valid (green) > invalid (red) > focused (coral) >
  // default neutral. Focus ring only when neutral so a valid/invalid
  // pill doesn't get a noisy coral halo on top of its result color.
  const inputBorderColor =
    referralValid === true
      ? "rgba(34, 197, 94, 0.5)"
      : referralValid === false && referralCode.trim()
        ? "rgba(193, 92, 92, 0.4)"
        : inputFocused
          ? CORAL
          : "rgba(0, 0, 0, 0.08)";
  const inputBoxShadow =
    inputFocused && referralValid === null
      ? "0 0 0 3px rgba(233, 111, 77, 0.10)"
      : "none";

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        color: CARD_INK,
        /* Warm-sand atmosphere — verbatim from /channels (lines 58-64
         * of channels-client.tsx). Layered radial gradients (coral 18%
         * top / blue 14% bottom-left / faint green 8% top-right) over
         * the cream linear base. Establishes the funnel's identity
         * before the user reads a word. Pairs /signin visually with
         * /channels so the OAuth bounce mid-skip-flow doesn't feel
         * like a context switch. */
        background: `
          radial-gradient(1200px 700px at 50% -10%, rgba(233, 111, 77, 0.18), transparent 65%),
          radial-gradient(900px 600px at 8% 95%, rgba(34, 158, 217, 0.14), transparent 70%),
          radial-gradient(700px 500px at 95% 25%, rgba(31, 173, 62, 0.08), transparent 75%),
          linear-gradient(180deg, #f5f3ee 0%, #f8f7f4 60%, #f9f7f2 100%),
          ${CREAM_BG}
        `,
      }}
    >
      {/* EdgePartnerBanner. Closes the brand seam between /edge/setup
          (olive Edge palette) and /signin. Renders nothing for non-Edge
          visitors (no partner cookie) — invisible to 99% of /signin
          traffic and load-bearing for the 1% who came through Edge. */}
      <EdgePartnerBanner />

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        {/* Vertical hierarchy is deliberate. space-y-12 (48px) puts
            breathing room between the four major sections (wordmark,
            heading, OAuth, footer trio) so the eye rests between
            decisions. Within each section the gap is tighter — see
            inner space-y values. Spacious even on mobile. */}
        <div className="w-full max-w-md space-y-12">
        {/* Logo */}
        <Link href="/" className="flex items-center justify-center gap-2">
          <Image src="/logo.png" alt="Instaclaw" width={40} height={40} unoptimized style={{ imageRendering: "pixelated" }} />
          <span
            className="text-2xl tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            Instaclaw
          </span>
        </Link>

        {/* Heading only — no subtitle (Move 1, 2026-05-28). The prior
            two-beat subtitle ("welcome back. or come in for the first
            time.") tried to serve both returning and new users at
            once and landed wrong on both: returning users read
            "welcome back" then a confusing "or come in for the
            first time"; new users read "welcome back" first as if
            they'd been here before. Google OAuth on this page handles
            both new accounts (lib/auth.ts:194-548 INSERTs the user
            row on first sign-in) and returning users transparently,
            so the dual-audience copy was solving a problem that
            doesn't exist at the auth layer. Dropping it removes
            noise; the headline + buttons + footnotes communicate
            everything needed. Typography spec preserved verbatim
            from the pre-Move-1 version (serif clamp, line-height
            1.0, letter-spacing -1.8px). */}
        {/* Headline. Intent-aware (2026-05-30):
              - Newcomer (isNewUser=true, set by ?new=1 from landing
                "Claim My Agent" CTA): "claim your agent." — preserves
                the verb the user just clicked. They came here CLAIMING
                a thing, not signing in.
              - Default ("sign in."): users who clicked a "sign in" link
                in nav/marketing, middleware redirects, direct URL.
            No subtitle in either case. The two OAuth pills below are
            self-explanatory ("sign in with Google" / "sign in with
            ChatGPT") — adding a tutorial line would be cognitive
            overhead at a moment that should feel light. */}
        <div className="text-center">
          <h1
            className="font-normal"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(44px, 12vw, 60px)",
              lineHeight: 1.0,
              letterSpacing: "-1.8px",
              color: CARD_INK,
            }}
          >
            {isNewUser ? "claim your agent." : "sign in."}
          </h1>
        </div>

        {/* Auth choices. Google and ChatGPT are equal-weight options
            rendered as REAL liquid-glass pills — same material as
            /channels' channel cards, the home-page CTAs, and the spots
            counter. The visual recipe is in app/globals.css under
            .liquid-glass-signin (port of wabi's 5-ingredient liquid
            glass: refraction substrate, transparent surface with
            -75deg sheen, 4-layer box-shadow, conic-gradient rim,
            sibling drop-shadow ring). Two earlier passes failed
            because they tried to fake glass with bg-white/X opacity +
            backdrop-blur-md + a tailwind hover ring — that reads as a
            flat white card with a faint border, NOT as glass floating
            in atmosphere. The 3-DOM-element architecture (root +
            surface + sibling shadow) is the recipe that actually works
            on this product; we use it everywhere else and we use it
            here.

            Architecture per button:
              <div .liquid-glass-signin-root>
                <button .liquid-glass-signin>icon + label</button>
                <div .liquid-glass-signin-shadow aria-hidden />
              </div>

            The root wraps + provides the refraction substrate ::before;
            the button is the transparent surface; the sibling shadow
            div sits OUTSIDE the surface's stacking context so its dark
            gradient doesn't bleed through. Hover state is owned by CSS
            (.liquid-glass-signin:hover) — coral tint at 8% bg + coral
            drop-shadow at 25% — "heat appearing on cold glass" rather
            than the wabi-default brighter-cool-tone lift. */}
        <div className="space-y-3">
          {/* Google sign-in. handleGoogleClick wraps the signIn() call
              with a pre-OAuth /api/invite/store cookie write when a
              valid referral code is present in the expand below. */}
          <div className="liquid-glass-signin-root">
            <button
              onClick={handleGoogleClick}
              className="liquid-glass-signin"
            >
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden>
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.10z"
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
              sign in with Google
            </button>
            <div aria-hidden className="liquid-glass-signin-shadow" />
          </div>

          {/* ChatGPT sign-in + Plus nudge bundled as one logical unit.
              The outer space-y-3 (12px) applies between the Google
              pill and this <div>; inside the unit the nudge sits 8px
              (mt-2) below the button so it feels attached to the
              ChatGPT path rather than as a third equal option.
              handleChatGPTClick wraps setChatgptModalOpen with the
              same pre-OAuth referral-store call so the cookie is set
              before the modal's eventual signIn() call. */}
          <div>
            <div className="liquid-glass-signin-root">
              <button
                onClick={handleChatGPTClick}
                className="liquid-glass-signin"
              >
                <Sparkles className="w-5 h-5 shrink-0" style={{ color: "#10a37f" }} aria-hidden />
                sign in with ChatGPT
              </button>
              <div aria-hidden className="liquid-glass-signin-shadow" />
            </div>
            {/* ChatGPT Plus nudge. Informational, no link — just a
                gentle aside for the audience who already pays $20/mo
                for ChatGPT Plus and qualifies for a lower Instaclaw
                plan price under BYOK billing. Voice mirrors /channels'
                question-then-benefit shape ("prefer the web?", "have
                an invite code?"): the rhetorical question primes
                self-identification; the comma-period rhythm lands the
                benefit. 12px subtle-ink — one step quieter than the
                13px footer footnotes below, so this reads as a
                button-aside rather than a third action. */}
            <p
              className="mt-2 text-center"
              style={{ fontSize: 12, color: SUBTLE_INK, lineHeight: 1.4 }}
            >
              have ChatGPT Plus? get a lower plan price.
            </p>
          </div>

          {/* Referral expand (Move 2, 2026-05-28). Third sibling in
              the OAuth space-y-3 group — reads as "still part of the
              OAuth flow, here's the optional layer for users who came
              with a code" rather than a separate form field. Hidden
              by default; opened by the "have an invite code? use it
              here." footer button below OR auto-opened on mount if
              ?ref= (initialRef prop) or localStorage carries a code.

              Input is a flatter, lower-opacity sibling of the OAuth
              pill (border-radius 9999px to match material vocabulary,
              48px height vs 56px buttons to read as subordinate, bg
              white/0.5 vs the OAuth buttons' transparent + sheen so
              text is readable while the gradient still shows
              through). Border color is state-driven:

                valid    → green   (rgba(34,197,94,0.5))
                invalid  → red     (rgba(193,92,92,0.4))  — quiet, not alarming
                focused  → coral   (matches the OAuth hover hue)
                default  → neutral (6%-black hairline, matches OAuth buttons)

              Validation runs on blur + Enter (NOT on every keystroke
              — /signup did that and was wasteful). On success, the
              code is also written to localStorage.instaclaw_ref so a
              user who validates without signing in retains the code
              on next visit (legacy /signup behavior). */}
          {referralExpanded && (
            <div className="pt-1">
              <input
                ref={inputRef}
                type="text"
                value={referralCode}
                placeholder="enter your referral code"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label="referral code"
                className="w-full outline-none transition-all duration-200"
                style={{
                  background: "rgba(255, 255, 255, 0.5)",
                  backdropFilter: "blur(2px)",
                  WebkitBackdropFilter: "blur(2px)",
                  border: `1px solid ${inputBorderColor}`,
                  borderRadius: 9999,
                  padding: "12px 20px",
                  fontSize: 15,
                  color: CARD_INK,
                  boxShadow: inputBoxShadow,
                  textAlign: "center",
                }}
                onFocus={() => setInputFocused(true)}
                onBlur={() => {
                  setInputFocused(false);
                  validateReferral(referralCode);
                }}
                onChange={(e) => {
                  setReferralCode(e.target.value);
                  // Clear stale validation while the user is typing —
                  // re-checked on blur. Skip the state update when
                  // already null so we don't trigger useless re-renders.
                  if (referralValid !== null) {
                    setReferralValid(null);
                    setReferralName("");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    validateReferral(referralCode);
                  }
                }}
              />
              {/* Validation message — 12px subtle-ink, matches the
                  ChatGPT Plus nudge style above so the two aside-
                  notes carry the same visual weight. Mirrors
                  /signup's success ("✓ 25% off your first month...")
                  but at the quieter voice level appropriate to /signin
                  (/signup's was 14px green banner; ours is a 12px
                  subtle line — the OAuth buttons are still the
                  hero). */}
              {referralValid === true && referralName && (
                <p
                  className="mt-2 text-center"
                  style={{ fontSize: 12, color: SUBTLE_INK, lineHeight: 1.4 }}
                >
                  ✓ referred by {referralName}.
                </p>
              )}
              {referralValid === false && referralCode.trim() && (
                <p
                  className="mt-2 text-center"
                  style={{ fontSize: 12, color: SUBTLE_INK, lineHeight: 1.4 }}
                >
                  referral code not found.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Invite + support footers, paired as one unit. Both mirror
            /channels' footnote zone exactly: 13px subtle-ink, lowercase,
            single inline trigger in muted-ink underlined. Wrapped in a
            space-y-2 div so they share consistent 8px internal spacing
            and ONE 48px gap above (from the outer space-y-12) rather
            than two competing margin sources. Reads as a paired
            escape-hatch (broader option first — invite code — then
            narrower — help). Replaces the SupportFooter component
            inline because Cooper-voice on this page means lowercase
            ("need help?") while SupportFooter ships the legacy
            Title-case copy used by 5 other surfaces; flipping the
            shared component would cascade visual changes we don't
            want today.

            Move 5 (2026-05-28): the "use it here" anchor was a
            <Link href="/signup">. After Move 3 made /signup a thin
            redirect to /signin, that link would have produced a
            no-op loop (/signin → /signup → /signin same page). It's
            now a <button> that toggles the referral expand defined
            in the OAuth group above. Text flips to "hide" when the
            expand is open — visible signal for the toggle's
            reciprocal action without breaking the lowercase voice. */}
        <div className="space-y-2">
          <p
            className="text-center"
            style={{ fontSize: 13, color: SUBTLE_INK, lineHeight: 1.5 }}
          >
            have an invite code?{" "}
            <button
              type="button"
              onClick={toggleReferralExpand}
              aria-expanded={referralExpanded}
              className="transition-opacity hover:opacity-70 cursor-pointer"
              style={{
                color: MUTED_INK,
                textDecoration: "underline",
                textUnderlineOffset: 2,
                background: "transparent",
                border: 0,
                padding: 0,
                font: "inherit",
              }}
            >
              {referralExpanded ? "hide" : "use it here"}
            </button>
            .
          </p>
          <p
            className="text-center"
            style={{ fontSize: 13, color: SUBTLE_INK, lineHeight: 1.5 }}
          >
            need help?{" "}
            <a
              href="mailto:help@instaclaw.io"
              className="transition-opacity hover:opacity-70"
              style={{
                color: MUTED_INK,
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              help@instaclaw.io
            </a>
          </p>
        </div>
        </div>
      </div>

      {/* ChatGPT signup-mode modal. Mounted at this level so it can
          render over the entire /signin viewport (its own backdrop +
          focus trap handle modal etiquette). Closed initially; opened
          by the ChatGPT button above. */}
      <ChatGPTConnectModal
        isOpen={chatgptModalOpen}
        onClose={() => setChatgptModalOpen(false)}
        mode="signup"
        signupCallbackUrl={callbackUrl}
      />
    </div>
  );
}
