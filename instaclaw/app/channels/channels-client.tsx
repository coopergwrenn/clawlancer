"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * /channels — the channel-selection front door (v3, liquid-glass).
 *
 * Visual recipe is identical to .liquid-glass-btn family from
 * app/globals.css. Every card uses the 3-element pattern:
 *
 *   <div class="channel-card-root is-<channel>">
 *     <[a|div] class="channel-card-surface">
 *       {/* content with inline 28-30px brand icon *\/}
 *     </[a|div]>
 *     <div class="channel-card-shadow"></div>
 *   </div>
 *
 * Channel-specific tints on .is-imessage and .is-telegram give each
 * card a brand-hued refraction substrate so it reads green/blue without
 * resorting to a heavy colored box-shadow on the icon itself.
 *
 * Icons are INLINE accents (28px for active, 24px for muted) — not
 * iOS-home-screen-sized tiles. The icon helps recognize the channel
 * at a glance; the text + card glass carry the visual weight.
 *
 * Background atmosphere on the page provides the color field that the
 * cards refract through their backdrop-filter blur. Without sufficient
 * color behind the glass, backdrop-filter has nothing to refract and
 * the cards read as flat white.
 */

const CORAL = "#E96F4D";
const CREAM_BG = "#f8f7f4";
const CARD_INK = "#333334";
const MUTED_INK = "#6b6b6b";
const SUBTLE_INK = "#9a9892";

const SENDBLUE_NUMBER = "+14072425197";
const SMS_HREF = `sms:${SENDBLUE_NUMBER}`;
const TELEGRAM_HREF = "https://t.me/myinstaclaw_bot";
const VCARD_HREF = "/api/imessage/vcard";

type WaitlistChannel = "discord" | "slack";

export function ChannelsClient() {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        color: CARD_INK,
        /* Rich background atmosphere — the color field the glass cards
         * refract through. Coral warmth from top, ambient blue from
         * bottom-left, a faint green hint near top-right (where the
         * iMessage card lives). Layered radial gradients over the cream
         * base. Opacity values chosen so the atmosphere is VISIBLE
         * without overpowering the cards themselves. */
        background: `
          radial-gradient(1200px 700px at 50% -10%, rgba(233, 111, 77, 0.18), transparent 65%),
          radial-gradient(900px 600px at 8% 95%, rgba(34, 158, 217, 0.14), transparent 70%),
          radial-gradient(700px 500px at 95% 25%, rgba(31, 173, 62, 0.08), transparent 75%),
          linear-gradient(180deg, #f5f3ee 0%, #f8f7f4 60%, #f9f7f2 100%),
          ${CREAM_BG}
        `,
      }}
    >
      <main className="relative flex-1 flex flex-col items-center px-5 py-12">
        <div className="w-full" style={{ maxWidth: 460 }}>
          {/* Wordmark */}
          <Link
            href="/"
            className="inline-block mb-14"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 24,
              letterSpacing: "-0.5px",
              color: CORAL,
              textDecoration: "none",
            }}
          >
            instaclaw
          </Link>

          {/* Headline */}
          <h1
            className="font-normal mb-4"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(44px, 12vw, 60px)",
              lineHeight: 1.0,
              letterSpacing: "-1.8px",
              color: CARD_INK,
            }}
          >
            pick a channel.
          </h1>

          {/* Subtitle — two-beat with italic serif promise on line 2 */}
          {/* Consolidated subtitle — single line, single voice. Earlier
              iteration had three lines (qualifier + italic promise + quiet
              reassurance) that read as cluttered with three competing
              voices. The italic "i'll meet you there." was redundant — the
              same brand promise is delivered TWICE in the card subtitles
              below ("the agent meets you there" appears in both iMessage
              and Telegram cards). Removing it deduplicates without losing
              warmth, and folding the reassurance into the single line
              reduces the subtitle to one breath. */}
          <p
            className="mb-12"
            style={{
              fontSize: 17,
              lineHeight: 1.5,
              color: MUTED_INK,
              maxWidth: 380,
            }}
          >
            wherever you&apos;d rather text from. add more anytime.
          </p>

          {/* ─── ACTIVE: iMessage (two-action card) ───────────────── */}
          <div className="channel-card-root is-imessage mb-3.5">
            <div className="channel-card-surface">
              {/* Primary tap — text our number */}
              <a
                href={SMS_HREF}
                className="channel-card-primary-link px-5 pt-4 pb-3.5"
              >
                <div className="flex items-center gap-3.5">
                  <IMessageIcon size={30} />
                  <div className="flex-1 min-w-0">
                    <div
                      className="font-normal"
                      style={{
                        fontFamily: "var(--font-serif)",
                        fontSize: 20,
                        letterSpacing: "-0.3px",
                        color: CARD_INK,
                        marginBottom: 2,
                      }}
                    >
                      iMessage
                    </div>
                    <div
                      style={{
                        fontSize: 13.5,
                        lineHeight: 1.4,
                        color: MUTED_INK,
                      }}
                    >
                      text our number. the agent meets you there.
                    </div>
                  </div>
                  <ChevronArrow color={SUBTLE_INK} />
                </div>
              </a>

              {/* Inner divider */}
              <div className="channel-card-inner-divider mx-5" />

              {/* Secondary tap — save our contact first.
                  Glass pill button (.channel-card-secondary-pill in
                  globals.css). Same recipe family as .liquid-glass-pill
                  scaled to 28px height so it stays subordinate to the
                  primary iMessage row above. Single tappable element;
                  "(recommended)" lives inside the pill at lower
                  opacity so the whole thing reads as one button.

                  .channel-card-secondary-link class preserved on the
                  <a> so the existing :has() card-surface hover cascade
                  still fires when the pill is hovered (the whole card
                  surface lifts subtly, reinforcing that the pill is
                  part of the card's interaction set). */}
              <div className="px-5 pt-2 pb-3">
                <a
                  href={VCARD_HREF}
                  className="channel-card-secondary-link channel-card-secondary-pill"
                >
                  <span className="pill-plus">+</span>
                  <span className="pill-label">save our contact first</span>
                  <span className="pill-trail">(recommended)</span>
                </a>
              </div>
            </div>
            <div aria-hidden className="channel-card-shadow" />
          </div>

          {/* ─── ACTIVE: Telegram (single-action card) ────────────── */}
          <div className="channel-card-root is-telegram mb-10">
            <a
              href={TELEGRAM_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="channel-card-surface px-5 py-4"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div className="flex items-center gap-3.5">
                <TelegramIcon size={30} />
                <div className="flex-1 min-w-0">
                  <div
                    className="font-normal"
                    style={{
                      fontFamily: "var(--font-serif)",
                      fontSize: 20,
                      letterSpacing: "-0.3px",
                      color: CARD_INK,
                      marginBottom: 2,
                    }}
                  >
                    Telegram
                  </div>
                  <div
                    style={{
                      fontSize: 13.5,
                      lineHeight: 1.4,
                      color: MUTED_INK,
                    }}
                  >
                    open telegram. the agent meets you there.
                  </div>
                </div>
                <ChevronArrow color={SUBTLE_INK} />
              </div>
            </a>
            <div aria-hidden className="channel-card-shadow" />
          </div>

          {/* ─── COMING SOON ─────────────────────────────────────── */}
          <div className="channel-section-label mb-3.5">coming soon</div>

          <WaitlistCard channel="discord" />
          <div className="h-2.5" />
          <WaitlistCard channel="slack" />

          {/* Footer — BYOB Telegram escape hatch */}
          <p
            className="mt-12 text-center"
            style={{ fontSize: 13, color: SUBTLE_INK, lineHeight: 1.5 }}
          >
            advanced: prefer your own Telegram bot?{" "}
            <Link
              href="/signup"
              style={{
                color: MUTED_INK,
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              use the legacy setup
            </Link>
            .
          </p>
        </div>
      </main>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/* WAITLIST CARD (muted glass — Discord, Slack)                       */
/* ────────────────────────────────────────────────────────────────── */

function WaitlistCard({ channel }: { channel: WaitlistChannel }) {
  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const channelLabel = channel === "discord" ? "Discord" : "Slack";

  const onSubmit = async () => {
    if (state === "submitting") return;
    setState("submitting");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/channels/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          requested_channel: channel,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setErrorMessage(data?.error || "couldn't save. try again.");
        setState("error");
        return;
      }
      setSuccessMessage(data.message || "on the list.");
      setState("done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "network error.");
      setState("error");
    }
  };

  return (
    <div className={`channel-card-root is-muted is-${channel}`}>
      <div className="channel-card-surface overflow-hidden">
        <button
          type="button"
          onClick={() => state !== "done" && setExpanded((v) => !v)}
          disabled={state === "done"}
          className="w-full text-left px-5 py-3.5 transition-colors duration-150 cursor-pointer disabled:cursor-default"
          style={{ background: "transparent", border: "none" }}
        >
          <div className="flex items-center gap-3.5">
            {channel === "discord" ? <DiscordIcon size={26} /> : <SlackIcon size={26} />}
            <div className="flex-1 min-w-0">
              <div
                className="font-normal"
                style={{
                  fontFamily: "var(--font-serif)",
                  fontSize: 18,
                  letterSpacing: "-0.3px",
                  color: CARD_INK,
                  opacity: state === "done" ? 1 : 0.85,
                }}
              >
                {channelLabel}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: state === "done" ? CORAL : MUTED_INK,
                  marginTop: 1,
                  opacity: state === "done" ? 1 : 0.85,
                }}
              >
                {state === "done"
                  ? successMessage
                  : "soon. tap to join the waitlist."}
              </div>
            </div>
            {state !== "done" && (
              <span
                aria-hidden
                className="shrink-0 transition-transform duration-200 ease-out"
                style={{
                  fontSize: 14,
                  color: SUBTLE_INK,
                  transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                }}
              >
                →
              </span>
            )}
          </div>
        </button>

        {expanded && state !== "done" && (
          <div
            className="px-5 pb-4 pt-1"
            style={{
              borderTop: "1px solid rgba(51, 51, 52, 0.06)",
            }}
          >
            <div className="flex gap-2 mt-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email"
                autoComplete="email"
                className="flex-1 px-4 py-2.5 rounded-xl outline-none transition-all duration-150"
                style={{
                  background: "rgba(255, 255, 255, 0.85)",
                  border: "1px solid rgba(51, 51, 52, 0.10)",
                  fontSize: 14.5,
                  color: CARD_INK,
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = CORAL;
                  e.currentTarget.style.boxShadow = `0 0 0 3px rgba(233, 111, 77, 0.12)`;
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "rgba(51, 51, 52, 0.10)";
                  e.currentTarget.style.boxShadow = "none";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmit();
                }}
              />
              <button
                type="button"
                onClick={onSubmit}
                disabled={state === "submitting" || email.trim().length === 0}
                className="rounded-xl transition-all duration-150 ease-out active:scale-[0.97] cursor-pointer disabled:cursor-default disabled:opacity-50"
                style={{
                  background: CORAL,
                  color: "#ffffff",
                  border: "none",
                  padding: "0 16px",
                  fontSize: 14,
                  fontFamily: "var(--font-serif)",
                  letterSpacing: "-0.2px",
                }}
              >
                {state === "submitting" ? "..." : "notify me"}
              </button>
            </div>
            {errorMessage && (
              <p
                className="mt-2"
                style={{ fontSize: 13, color: "#b14444" }}
                role="alert"
              >
                {errorMessage}
              </p>
            )}
          </div>
        )}
      </div>
      <div aria-hidden className="channel-card-shadow" />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/* ICONS — inline accents at 24-30px. No colored box-shadows; the    */
/* card glass carries the depth, not the icons.                       */
/* ────────────────────────────────────────────────────────────────── */

function IMessageIcon({ size = 30 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="channel-brand-icon shrink-0 inline-flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.25,
        overflow: "hidden",
      }}
    >
      <svg viewBox="0 0 60 60" width={size} height={size} style={{ display: "block" }}>
        <defs>
          <linearGradient id="ic-imessage-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5BF675" />
            <stop offset="100%" stopColor="#1FAD3E" />
          </linearGradient>
        </defs>
        <rect width="60" height="60" rx="15" fill="url(#ic-imessage-grad)" />
        <path
          d="M30 14c-10.49 0-19 6.52-19 14.56 0 4.27 2.47 8.12 6.37 10.73L14.5 47l8.85-4.73c2.05.48 4.21.74 6.45.74 10.49 0 19-6.52 19-14.56S40.49 14 30 14z"
          fill="#ffffff"
        />
      </svg>
    </span>
  );
}

function TelegramIcon({ size = 30 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="channel-brand-icon shrink-0 inline-flex items-center justify-center"
      style={{
        width: size,
        height: size,
        // Squircle to match IMessageIcon — both active-channel marks
        // now read as the same shape family. iOS app-icon convention.
        borderRadius: size * 0.25,
        overflow: "hidden",
      }}
    >
      <svg viewBox="0 0 60 60" width={size} height={size} style={{ display: "block" }}>
        <defs>
          <linearGradient id="ic-telegram-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#37BBFE" />
            <stop offset="100%" stopColor="#1E96C8" />
          </linearGradient>
        </defs>
        {/* Background switched from <circle r=30> to <rect rx=15> so
            the fill matches the squircle clip on the container.
            rx=15 = 60 * 0.25, same ratio as the container's borderRadius. */}
        <rect width="60" height="60" rx="15" fill="url(#ic-telegram-grad)" />
        {/* Plane path with optical-center offset BAKED into the absolute
            coords — no <g transform> wrapper. Total shift from the
            original Telegram brand SVG: dx=-3, dy=-2.

            Why not bbox-center (which would be dx=+0.73, dy=-3.15):
            the plane is an asymmetric arrow shape — the visual weight
            is concentrated in the body/tip (upper-right of the path)
            and the wing+tail are thin outline on the left. The eye
            tracks the leading direction of arrow shapes (the TIP) as
            the focal point, not the geometric bbox. With strict
            bbox-center the plane reads as biased upper-right because
            the tip hugs the corner.

            Compensating with dx=-3, dy=-2 (cumulative from original;
            bbox center post-bake at (26.27, 31.15) — 3.73 left and
            1.15 below viewBox center) pulls the tip back from the
            corner AND keeps the plane's body crossing the icon's
            vertical center cleanly.

            Tuning history: (+0.73, -3.15) bbox-center read as
            right-biased; (-3, -1) per first sweep read as too-far-
            down (empty space at top); (-3, -2) is Cooper's final
            pick after a y-axis sweep with crosshair at viewBox
            center — plane mass distributes evenly above + below
            the horizontal midline. */}
        <path
          d="M41.94 15.32 9.93 27.62c-2.18.85-2.16 2.05-.4 2.59l8.21 2.56 19.04-12.01c.9-.5 1.71-.24 1.04.32L22.4 36.14l-.6 9c.85 0 1.21-.39 1.67-.85l4-3.87 8.31 6.15c1.52.85 2.62.4 2.98-1.41l5.41-25.49c.53-2.2-.78-3.19-2.23-2.35z"
          fill="#ffffff"
        />
      </svg>
    </span>
  );
}

function DiscordIcon({ size = 26 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="channel-brand-icon shrink-0 inline-flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.25,
        overflow: "hidden",
        opacity: 0.7,
      }}
    >
      <svg viewBox="0 0 60 60" width={size} height={size} style={{ display: "block" }}>
        <rect width="60" height="60" rx="15" fill="#5865F2" />
        {/* Mascot path with EYE-PICKED offset baked into the absolute
            M commands. Earlier bbox-center math (commit 4236014a)
            shipped at (-1.74, +2.35) which Cooper read as still
            right-biased on prod. Re-tested by rendering a 9x9 grid
            at actual 30px in real card mocks + a focused 5x3 at
            100px with crosshair overlay.

            Eye-picked at (-3, +2). Mascot's eyes land on the
            horizontal crosshair; horns extend slightly upper-left;
            body+chin extend slightly lower-right. Balanced diagonal
            composition.

            Lesson from earlier attempts: for asymmetric shapes
            (this mascot has a wider head than body), geometric
            bbox center isn't optical center. Eye-test at render
            size wins.

            Bake (-3, +2) into the two absolute moveTo commands:
              original M 42.07 18.4  → M 39.07 20.4
              original M 24.74 32.32 → M 21.74 34.32 */}
        <path
          d="M39.07 20.4a23.6 23.6 0 0 0-5.95-1.85.09.09 0 0 0-.1.04c-.26.46-.55 1.05-.74 1.52a21.86 21.86 0 0 0-6.56 0c-.2-.48-.49-1.06-.76-1.52a.09.09 0 0 0-.1-.04 23.5 23.5 0 0 0-5.95 1.85.08.08 0 0 0-.04.03c-3.8 5.66-4.84 11.18-4.33 16.63 0 .03.02.05.04.07a23.7 23.7 0 0 0 7.16 3.62.09.09 0 0 0 .1-.03 17 17 0 0 0 1.47-2.39.09.09 0 0 0-.05-.12 15.6 15.6 0 0 1-2.23-1.06.09.09 0 0 1-.01-.15c.15-.11.3-.23.44-.35a.09.09 0 0 1 .09-.01c4.68 2.14 9.74 2.14 14.36 0a.09.09 0 0 1 .09.01c.14.12.29.24.45.35a.09.09 0 0 1-.01.15c-.71.42-1.46.78-2.24 1.06a.09.09 0 0 0-.05.12c.43.83.93 1.62 1.47 2.39a.09.09 0 0 0 .1.03 23.6 23.6 0 0 0 7.17-3.62.09.09 0 0 0 .04-.07c.61-6.31-1.02-11.78-4.34-16.63a.07.07 0 0 0-.04-.03zM21.74 34.32c-1.44 0-2.63-1.33-2.63-2.96 0-1.63 1.17-2.96 2.63-2.96 1.48 0 2.66 1.34 2.63 2.96 0 1.63-1.17 2.96-2.63 2.96zm9.74 0c-1.44 0-2.63-1.33-2.63-2.96 0-1.63 1.17-2.96 2.63-2.96 1.48 0 2.66 1.34 2.63 2.96 0 1.63-1.16 2.96-2.63 2.96z"
          fill="#ffffff"
        />
      </svg>
    </span>
  );
}

function SlackIcon({ size = 26 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="channel-brand-icon shrink-0 inline-flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.25,
        overflow: "hidden",
        opacity: 0.75,
        background: "rgba(255, 255, 255, 0.85)",
      }}
    >
      <svg viewBox="0 0 60 60" width={size} height={size} style={{ display: "block" }}>
        {/* Slack hash — EYE-PICKED offset (dx=-0.5, dy=-0.5) baked into
            each rect. Earlier shipped (-1.5, 0) overcorrected — Cooper
            read it as down-and-left on prod. Re-tested via 7x7 grid
            of dx/dy candidates at 30px in real card mocks + 4x4
            focused at 100px with crosshair.

            (-0.5, -0.5) sits the hash centered on the crosshair
            intersection with balanced top/bottom and modest
            compensation for the wider-right bars (yellow w=16,
            green w=16 vs red w=10, blue w=10 on left).

            Earlier -1.5 shift was math-derived "compensate for visual
            centroid bias" applied too aggressively. Smaller -0.5
            preserves geometric balance while nudging visual mass
            toward icon center.

            All x and y shifted by -0.5 from original:
              x: 11 → 10.5  /  22.5 → 22  /  33 → 32.5
              y: 22 → 21.5  /  10.5 → 10  /  33.8 → 33.3  /  39.5 → 39 */}
        <rect x="10.5" y="21.5" width="10" height="4.2" rx="2.1" fill="#E01E5A" />
        <rect x="22" y="10" width="4.2" height="10" rx="2.1" fill="#E01E5A" />
        <rect x="32.5" y="21.5" width="16" height="4.2" rx="2.1" fill="#ECB22E" />
        <rect x="32.5" y="10" width="4.2" height="10" rx="2.1" fill="#ECB22E" />
        <rect x="10.5" y="33.3" width="10" height="4.2" rx="2.1" fill="#36C5F0" />
        <rect x="22" y="39" width="4.2" height="10" rx="2.1" fill="#36C5F0" />
        <rect x="32.5" y="33.3" width="16" height="4.2" rx="2.1" fill="#2EB67D" />
        <rect x="32.5" y="39" width="4.2" height="10" rx="2.1" fill="#2EB67D" />
      </svg>
    </span>
  );
}

function ChevronArrow({ color }: { color: string }) {
  return (
    <svg
      aria-hidden
      width="18"
      height="18"
      viewBox="0 0 20 20"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M7.5 5 12.5 10 7.5 15"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
