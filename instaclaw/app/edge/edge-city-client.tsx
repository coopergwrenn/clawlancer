"use client";

import { useRouter } from "next/navigation";
import type { EdgeUserState } from "./edge-user-state";

/**
 * Edge attendee CTA card — three shapes driven by SSR-resolved userState.
 *
 *   logged_out  — primary "Claim your agent →" button that routes to
 *                 the /edge/claim verification gate. The gate handles
 *                 EdgeOS attendee lookup, signed-cookie minting, and
 *                 the eventual partner-tag write. We DO NOT post to
 *                 /api/partner/tag directly here — that path was a
 *                 gate bypass before the EdgeOS verification gate
 *                 shipped (a non-attendee could tag themselves
 *                 edge_city without proving ticket ownership).
 *
 *   in_progress — single "Complete setup →" pill routing to the
 *                 user's resumePath (where they dropped off mid-flow).
 *
 *   live        — celebratory sage card with @botUsername + a
 *                 deep-link to Telegram.
 *
 * SSR resolves userState so there's no flash of the wrong CTA on
 * hydration — first paint shows the right state.
 *
 * History: this component used to host a "notify-me" email capture
 * fallback for non-attendees. That served its purpose during the
 * pre-launch waitlist phase; it was removed 2026-05-20 as part of
 * shipping the EdgeOS ticket gate (which replaces email capture with
 * actual verification). For pre-launch waitlist needs going forward,
 * use the dedicated waitlist surfaces elsewhere — this component is
 * Edge-onboarding-only now.
 */

interface EdgeCityClientProps {
  state: EdgeUserState;
}

export function EdgeCityClient({ state }: EdgeCityClientProps) {
  const router = useRouter();

  // ── State C: live agent ── sage card + deep-link to Telegram.
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

  // ── State A: logged out ── route to the EdgeOS verification gate.
  // Single-button shape; the gate at /edge/claim handles email lookup,
  // signed-cookie minting, the partner-tag write, and the OAuth hand-off.
  return (
    <div className="w-full">
      <button
        onClick={() => router.push("/edge/claim")}
        className="w-full px-6 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] inline-flex items-center justify-center gap-2"
        style={{ background: "var(--edge-olive)", color: "#FFFFFF", letterSpacing: "0.12em" }}
      >
        Claim your agent <span aria-hidden>→</span>
      </button>
    </div>
  );
}
