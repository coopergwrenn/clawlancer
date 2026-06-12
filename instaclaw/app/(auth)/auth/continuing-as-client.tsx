"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * /auth "continuing as <email>" confirmation (2026-06-10 identity hardening).
 *
 * Rendered by app/(auth)/auth/page.tsx Branch 1 when an existing NextAuth
 * session is reused (and NOT short-circuited by the re-onboarding guard).
 * Before this, /auth auto-bound the pending row + provisioned a VM the instant
 * it saw a session — so on a shared / borrowed / stale-session device a new
 * person silently bound their agent + phone to the wrong account, with no
 * signal. This screen is that signal.
 *
 * The binding does NOT fire on render. It fires only when the user taps
 * "continue" → POST /api/auth/channel-confirm → bind + provision + redirect.
 * "not you?" signs out and returns to /auth?session=… which re-renders the
 * OAuth picker, forcing a fresh account choice.
 *
 * Design language mirrors auth-client.tsx exactly (cream bg, lowercase
 * period-terminated serif headline, single coral accent, glass pill,
 * mobile-first at 375px).
 */

const CORAL = "#E96F4D";
const CREAM_BG = "#f8f7f4";
const CARD_INK = "#333334";
const MUTED_INK = "#6b6b6b";
const SUBTLE_INK = "#9a9892";

interface ContinuingAsClientProps {
  /** The authed user's email — the identity we're about to bind to. */
  email: string | null;
  /** pending_users.id, preserved so the picker can re-bind after "not you?". */
  sessionId: string;
}

export function ContinuingAsClient({ email, sessionId }: ContinuingAsClientProps) {
  const router = useRouter();
  const [working, setWorking] = useState<"continue" | "switch" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onContinue = async () => {
    if (working) return;
    setWorking("continue");
    setError(null);
    try {
      const res = await fetch("/api/auth/channel-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json().catch(() => ({}))) as { next?: string; error?: string };
      if (!res.ok || !data.next) {
        setError("something went wrong. try again.");
        setWorking(null);
        return;
      }
      // Hard navigation so the destination (/plan or /onboarding/done) gets a
      // clean server render with the freshly-bound pending row.
      window.location.href = data.next;
    } catch {
      setError("network error. try again.");
      setWorking(null);
    }
  };

  const onSwitch = async () => {
    if (working) return;
    setWorking("switch");
    // Sign out, then land back on /auth with the same session id — the page
    // re-renders the OAuth picker (unauthenticated branch) so they pick the
    // right account. The pending row is untouched (never bound to the wrong
    // user because the bind only happens on "continue").
    await signOut({ callbackUrl: `/auth?session=${encodeURIComponent(sessionId)}` });
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: CREAM_BG, color: CARD_INK }}>
      <main className="flex-1 flex flex-col items-center justify-center px-5 py-12">
        <div className="w-full" style={{ maxWidth: 420 }}>
          <Link
            href="/"
            className="inline-block mb-12"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 22,
              letterSpacing: "-0.5px",
              color: CORAL,
              textDecoration: "none",
            }}
          >
            instaclaw
          </Link>

          {/* Agent-voice headline. The email is the load-bearing word — it's
              what we're about to bind this agent to. */}
          <h1
            className="font-normal mb-3"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(30px, 8vw, 40px)",
              lineHeight: 1.08,
              letterSpacing: "-1px",
              color: CARD_INK,
              wordBreak: "break-word",
            }}
          >
            continuing as{" "}
            <span style={{ color: CORAL }}>{email ?? "your account"}</span>.
          </h1>

          <p className="mb-10" style={{ fontSize: 16, lineHeight: 1.45, color: MUTED_INK }}>
            this is the account your agent gets tied to.
          </p>

          {error && (
            <div
              className="mb-5 px-4 py-3 rounded-xl text-sm"
              style={{
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.20)",
                color: "#b14444",
              }}
            >
              {error}
            </div>
          )}

          {/* Primary: continue. Glass-coral pill, matching the onboarding
              family (.liquid-glass-signin cta-coral). */}
          <div className="liquid-glass-signin-root cta-coral w-full" style={{ maxWidth: 420 }}>
            <button
              type="button"
              onClick={onContinue}
              disabled={working !== null}
              className="liquid-glass-signin"
              style={working === "continue" ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
            >
              {working === "continue" ? "setting up…" : "yes, that's me"}
              {working !== "continue" && (
                <span aria-hidden style={{ marginLeft: 4 }}>→</span>
              )}
            </button>
            <div aria-hidden className="liquid-glass-signin-shadow" />
          </div>

          {/* Secondary, quiet: not you? Forces the picker. Subordinate weight
              (muted underline), same treatment as the other onboarding
              escape links. */}
          <div className="mt-5 text-center">
            <button
              type="button"
              onClick={onSwitch}
              disabled={working !== null}
              className="transition-colors duration-150 underline disabled:cursor-default"
              style={{
                background: "transparent",
                border: "none",
                color: MUTED_INK,
                fontSize: 13,
                letterSpacing: "-0.1px",
                textUnderlineOffset: 3,
                cursor: working ? "default" : "pointer",
              }}
              onMouseEnter={(e) => {
                if (!working) e.currentTarget.style.color = CARD_INK;
              }}
              onMouseLeave={(e) => {
                if (!working) e.currentTarget.style.color = MUTED_INK;
              }}
            >
              {working === "switch" ? "switching…" : "not you? sign in differently"}
            </button>
          </div>

          <p className="mt-10 text-center" style={{ fontSize: 12, color: SUBTLE_INK, lineHeight: 1.5 }}>
            shared device? tap “not you?” above.
          </p>
        </div>
      </main>
    </div>
  );
}
