"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { EdgeUserState } from "./edge-user-state";

interface EdgeCityClientProps {
  /**
   * Server-resolved user state. Three variants drive three CTA shapes:
   *
   *   logged_out  — claim CTA + email-notify fallback.
   *   in_progress — single "Complete setup →" pill routing to wherever the
   *                 user dropped off in the onboarding state machine.
   *   live        — celebratory card with the bot username and a deep-link
   *                 to Telegram.
   *
   * SSR resolves this so there's no flash of the wrong CTA on hydration —
   * the user sees the right state on first paint.
   */
  state: EdgeUserState;

  /**
   * Optional secondary action rendered between the primary "Claim" button
   * and the "OR" divider, ONLY in the logged_out state. Used on /edge/claim
   * to surface the existing-account BYO link directly under the primary
   * CTA so it reads as a parallel option, not a buried afterthought.
   *
   * Not rendered in in_progress (single-pill state) or live (celebratory
   * card) — those layouts don't have a divider for a secondary slot to
   * sit above.
   */
  secondaryActionSlot?: ReactNode;
}

export function EdgeCityClient({ state, secondaryActionSlot }: EdgeCityClientProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");

  // ── State C: live agent ── deep-link straight into Telegram.
  if (state.kind === "live") {
    const tmeUrl = `https://t.me/${state.botUsername}`;
    return (
      <div className="w-full">
        <div
          className="rounded-2xl p-6 sm:p-7"
          style={{
            background: "var(--edge-sage)",
            border: "1px solid var(--edge-olive)",
          }}
        >
          <p
            className="text-[11px] uppercase tracking-[0.18em] inline-flex items-center gap-2 mb-3"
            style={{ color: "var(--edge-olive)" }}
          >
            <span
              aria-hidden
              className="inline-block w-2 h-2 rounded-full"
              style={{
                background: "var(--edge-olive)",
                animation: "edge-live-pulse 2.4s ease-in-out infinite",
              }}
            />
            Your agent is live
          </p>
          <p
            className="font-bold tracking-[-0.01em] text-[26px] sm:text-[32px] mb-4 break-all"
            style={{ color: "var(--edge-ink)", fontVariantLigatures: "none" }}
          >
            @{state.botUsername}
          </p>
          <a
            href={tmeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full px-6 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] inline-flex items-center justify-center gap-2"
            style={{
              background: "var(--edge-olive)",
              color: "#FFFFFF",
              letterSpacing: "0.12em",
            }}
          >
            Open in Telegram <span aria-hidden>→</span>
          </a>
        </div>
        <style jsx>{`
          @keyframes edge-live-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.85); }
          }
        `}</style>
      </div>
    );
  }

  // ── State B: in-progress ── single pill back into the onboarding flow.
  if (state.kind === "in_progress") {
    return (
      <div className="w-full">
        <button
          onClick={() => router.push(state.resumePath)}
          className="w-full px-6 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] inline-flex items-center justify-center gap-2"
          style={{
            background: "var(--edge-olive)",
            color: "#FFFFFF",
            letterSpacing: "0.12em",
          }}
        >
          Complete setup <span aria-hidden>→</span>
        </button>
        <p
          className="text-[11px] uppercase tracking-[0.14em] mt-4"
          style={{ color: "var(--edge-ink-soft)" }}
        >
          You started — pick up where you left off
        </p>
      </div>
    );
  }

  // ── State A: logged out ── original claim CTA + notify-me fallback.
  // The two interaction paths (claim now / notify-me) are preserved verbatim
  // from the pre-state-aware version. Only logged-out users see them.

  async function handleClaim() {
    setClaiming(true);
    setError("");
    try {
      const res = await fetch("/api/partner/tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partner: "edge_city" }),
      });
      const data = await res.json().catch(() => ({}));
      router.push(data.redirect_to ?? "/signup");
    } catch {
      document.cookie =
        "instaclaw_partner=edge_city; path=/; max-age=604800; SameSite=Lax";
      router.push("/signup");
    } finally {
      setClaiming(false);
    }
  }

  async function handleNotify(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source: "edge_city" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong");
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div
        className="max-w-md px-5 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] inline-flex items-center gap-2"
        style={{ background: "var(--edge-sage)", color: "var(--edge-olive)" }}
      >
        <span aria-hidden>✓</span>
        You&apos;re on the list — we&apos;ll email when claim opens
      </div>
    );
  }

  return (
    <div className="w-full">
      <button
        onClick={handleClaim}
        disabled={claiming}
        className="w-full px-6 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] disabled:opacity-60 inline-flex items-center justify-center gap-2"
        style={{ background: "var(--edge-olive)", color: "#FFFFFF", letterSpacing: "0.12em" }}
      >
        {claiming ? "Claiming…" : <>Claim your agent <span aria-hidden>→</span></>}
      </button>

      {/* Optional secondary action slot — small text affordance directly
       *  under the primary CTA. Used on /edge/claim for the existing-account
       *  BYO link. Sits BEFORE the OR divider so it reads as "secondary
       *  option" not "fallback to a different funnel."
       */}
      {secondaryActionSlot && (
        <div className="mt-3 mb-1">{secondaryActionSlot}</div>
      )}

      <div className="flex items-center gap-3 my-5">
        <div className="flex-1 h-px" style={{ background: "var(--edge-line)" }} />
        <span className="text-[11px] uppercase tracking-[0.16em]" style={{ color: "var(--edge-ink-soft)" }}>
          or
        </span>
        <div className="flex-1 h-px" style={{ background: "var(--edge-line)" }} />
      </div>

      <form onSubmit={handleNotify} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          disabled={loading}
          aria-label="email"
          className="flex-1 px-5 py-3.5 rounded-full text-[14px] outline-none transition-colors focus:border-[var(--edge-olive)]"
          style={{
            background: "#FFFFFF",
            border: "1px solid var(--edge-line)",
            color: "var(--edge-ink)",
          }}
        />
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-3.5 rounded-full text-[13px] uppercase tracking-[0.12em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] disabled:opacity-60"
          style={{ background: "var(--edge-olive)", color: "#FFFFFF" }}
        >
          {loading ? "…" : "Notify me"}
        </button>
      </form>

      {error && (
        <p className="text-[12px] mt-3" style={{ color: "#B83D01" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
