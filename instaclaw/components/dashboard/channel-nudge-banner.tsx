"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { useSession } from "next-auth/react";

/**
 * Channel nudge banner — Phase 2 of the "skip to your command center" flow.
 *
 * Shown to users whose preferred_channel is 'web' (set by /onboarding/web
 * when they clicked Skip on /channels). Encourages them to connect
 * iMessage or Telegram for the full proactive-messaging experience.
 *
 * Visibility rules:
 *   - session.user.preferredChannel === "web"
 *   - AND (dismissedChannelNudgeAt is null OR older than 14 days)
 *
 * The 14-day cadence (vs the 7-day default elsewhere): web-only users
 * chose deliberately at /channels. 7 days = right cadence for accidental
 * states; 14 = right cadence for deliberate ones (Cooper's call).
 *
 * Design language mirrors AgentbookHatBanner exactly — same translucent
 * cream-glass strip, same animation curve (240ms opacity / 300ms height
 * with [0.4, 0, 0.2, 1] easing), same outlined pill CTA, same X-icon
 * dismiss. The two banners stack cleanly when both fire (rare).
 *
 * Dismiss behavior — optimistic:
 *   1. Click [maybe later] → local `hidden` state flips to true → banner
 *      fades + collapses with the same exit animation.
 *   2. POST /api/onboarding/dismiss-channel-nudge fires in background.
 *      Sets instaclaw_users.dismissed_channel_nudge_at = NOW().
 *   3. POST failure is silent. The local state stays hidden (user
 *      experience is unaffected); the banner will resurface on next
 *      session-refresh, which is acceptable degraded behavior.
 *   4. The 14-day re-show is driven entirely by the session callback
 *      reading dismissed_channel_nudge_at on each `auth()` call.
 *
 * Connect-CTA: Link to /channels. Once the user goes through that flow
 * and completes onboarding, /api/onboarding/done/submit sets
 * preferred_channel to 'imessage' or 'telegram', which removes them
 * from the banner's visibility set on next session-refresh.
 *
 * The banner does NOT pre-call the dismiss endpoint when CTA is clicked
 * — the preferred_channel transition handles re-suppression naturally,
 * and pre-calling would set dismissed_channel_nudge_at unnecessarily on
 * users who actually engaged with the CTA (would skew analytics).
 */
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export function ChannelNudgeBanner() {
  const { data: session, status } = useSession();
  const [optimisticallyHidden, setOptimisticallyHidden] = useState(false);

  const shouldShow = useMemo(() => {
    if (status !== "authenticated") return false;
    if (session?.user?.preferredChannel !== "web") return false;
    const dismissedAt = session.user.dismissedChannelNudgeAt;
    if (!dismissedAt) return true;
    const dismissedAge = Date.now() - new Date(dismissedAt).getTime();
    return dismissedAge >= FOURTEEN_DAYS_MS;
  }, [status, session?.user?.preferredChannel, session?.user?.dismissedChannelNudgeAt]);

  const visible = shouldShow && !optimisticallyHidden;

  async function handleDismiss() {
    setOptimisticallyHidden(true);
    try {
      await fetch("/api/onboarding/dismiss-channel-nudge", { method: "POST" });
    } catch {
      // Best-effort. Local state already hidden; the banner reappears on
      // next session-refresh if the POST didn't land — acceptable
      // degraded behavior per Rule 39 (non-critical UX surface).
    }
  }

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{
            opacity: { duration: 0.24, ease: [0.4, 0, 0.2, 1] },
            height: { duration: 0.30, ease: [0.4, 0, 0.2, 1] },
          }}
          style={{ overflow: "hidden" }}
          className="w-full"
        >
          <div
            className="notification-bar flex items-center justify-center gap-3 sm:gap-4 px-4 py-3 text-sm"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            {/* Brand mark chip — stacked iMessage-green + Telegram-blue dots,
                hinting at the two channels without favoring one. Same 22px
                circular footprint as AgentbookHatBanner's hat chip. */}
            <div
              className="shrink-0 w-[22px] h-[22px] rounded-full overflow-hidden flex items-center justify-center"
              style={{
                background: "rgba(255,255,255,0.55)",
                boxShadow: "inset 0 0 0 1px var(--border)",
              }}
              aria-hidden
            >
              <div className="relative w-[14px] h-[10px]">
                {/* iMessage green dot — top-left */}
                <span
                  className="absolute top-0 left-0 w-[8px] h-[8px] rounded-full"
                  style={{
                    background: "#1FAD3E",
                    boxShadow: "0 0 0 1px rgba(255,255,255,0.9)",
                  }}
                />
                {/* Telegram blue dot — bottom-right, overlapping */}
                <span
                  className="absolute bottom-0 right-0 w-[8px] h-[8px] rounded-full"
                  style={{
                    background: "#229ED9",
                    boxShadow: "0 0 0 1px rgba(255,255,255,0.9)",
                  }}
                />
              </div>
            </div>

            {/* Copy — Cooper voice: lowercase, sentence case, two beats.
                Beat 1 is the action; beat 2 is the why. */}
            <p
              className="min-w-0"
              style={{ color: "var(--foreground)" }}
            >
              <span className="hidden sm:inline">
                connect iMessage or Telegram for the full experience.{" "}
                <span style={{ color: "var(--muted)" }}>
                  your agent works best when you can message it like a friend.
                </span>
              </span>
              <span className="sm:hidden">
                connect a channel for proactive messages.
              </span>
            </p>

            {/* Outlined pill CTA. Same shape + spacing as AgentbookHatBanner.
                No orange — orange is reserved for the command-center input
                and primary product CTAs. This is a quieter nudge. */}
            <Link
              href="/channels"
              className="shrink-0 px-4 py-1.5 rounded-full text-xs font-medium transition-snappy hover:opacity-80 cursor-pointer"
              style={{
                border: "1px solid var(--foreground)",
                color: "var(--foreground)",
              }}
            >
              <span className="hidden sm:inline">connect a channel</span>
              <span className="sm:hidden">connect</span>
            </Link>

            {/* Dismiss X. Mirrors AgentbookHatBanner's icon byte-for-byte. */}
            <button
              onClick={handleDismiss}
              className="shrink-0 ml-1 p-1 rounded-full hover:opacity-60 transition-snappy cursor-pointer"
              aria-label="Dismiss for 14 days"
              style={{ color: "var(--foreground)" }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
