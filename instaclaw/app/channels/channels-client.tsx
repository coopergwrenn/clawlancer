"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * /channels — the channel-selection front door.
 *
 * Visual design language matches the rest of instaclaw.io (the
 * liquid-glass family from app/globals.css):
 *   - Active channels (iMessage, Telegram): full glass cards with
 *     refractive iridescent rim, inset highlights, soft outer shadows,
 *     hover lift. Same recipe as .liquid-glass-btn adapted to a
 *     rectangular geometry. Uses .channel-card from globals.css.
 *   - Coming-soon channels (Discord, Slack): same architecture but
 *     reduced opacity, smaller shadows, brand mark desaturated.
 *     Reads as visually subordinate without needing a "coming soon"
 *     label to disambiguate. (Label included anyway, as a section
 *     marker.) Uses .channel-card-muted.
 *
 * Coral (#E96F4D) is used ONLY for: wordmark accent, italic flourish
 * in the subtitle, and the secondary "save our contact first" link
 * inside the iMessage card. Brand-channel colors (Apple green,
 * Telegram blue) carry the channel cards themselves.
 *
 * Icons are inline SVGs — clean, unambiguous representations of each
 * service. Apple Messages and Telegram render in full brand color;
 * Discord and Slack render with reduced saturation to match the
 * "coming soon" treatment.
 *
 * Mobile-first: tested on 375px iPhone 12 mini. Tap targets generous,
 * vertical rhythm consistent, no horizontal scroll.
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
      style={{ background: CREAM_BG, color: CARD_INK }}
    >
      {/* Subtle background atmosphere — a soft radial glow that gives
          the cream backdrop something for the glass cards to refract
          against. Lives behind everything; not interactive. */}
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(900px 600px at 50% 5%, rgba(233, 111, 77, 0.06), transparent 70%), radial-gradient(700px 500px at 20% 100%, rgba(34, 158, 217, 0.04), transparent 70%)",
          zIndex: 0,
        }}
      />

      <main className="relative flex-1 flex flex-col items-center px-5 py-12" style={{ zIndex: 1 }}>
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

          {/* Subtitle — two-line treatment so each beat lands.
              First line declarative, second italic for warmth (matches
              the v122 voice's quiet promises). */}
          <p
            className="mb-12"
            style={{
              fontSize: 17,
              lineHeight: 1.5,
              color: MUTED_INK,
              maxWidth: 380,
            }}
          >
            wherever you&apos;d rather text from.
            <br />
            <span
              style={{
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
                fontSize: 18,
                color: CARD_INK,
              }}
            >
              i&apos;ll meet you there.
            </span>
          </p>

          {/* ─── ACTIVE CHANNELS ───────────────────────────────────── */}

          {/* iMessage — primary card, two-action layout */}
          <div className="channel-card mb-3.5">
            <a
              href={SMS_HREF}
              className="block px-6 pt-6 pb-5 transition-colors duration-150"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div className="flex items-center gap-4">
                <IMessageIcon />
                <div className="flex-1 min-w-0">
                  <div
                    className="font-normal mb-1"
                    style={{
                      fontFamily: "var(--font-serif)",
                      fontSize: 22,
                      letterSpacing: "-0.4px",
                      color: CARD_INK,
                    }}
                  >
                    iMessage
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      lineHeight: 1.45,
                      color: MUTED_INK,
                    }}
                  >
                    text our number. the agent meets you there.
                  </div>
                </div>
                <ChevronArrow color={SUBTLE_INK} />
              </div>
            </a>

            {/* Divider — subtle inner separator between primary tap
                area and the secondary Save Contact action. */}
            <div
              className="channel-card-inner-divider mx-6"
              style={{ position: "relative", zIndex: 1 }}
            />

            {/* Secondary action — save our contact first.
                Coral so the user knows "this is the brand
                recommendation," but small and below the primary CTA. */}
            <a
              href={VCARD_HREF}
              className="block px-6 py-3.5 transition-opacity duration-150 hover:opacity-80"
              style={{
                textDecoration: "none",
                color: CORAL,
                position: "relative",
                zIndex: 1,
              }}
            >
              <div className="flex items-center gap-2.5">
                <span style={{ fontSize: 13, lineHeight: 1 }}>+</span>
                <span style={{ fontSize: 13.5, fontWeight: 500 }}>
                  save our contact first
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: SUBTLE_INK,
                    fontWeight: 400,
                  }}
                >
                  — recommended
                </span>
              </div>
            </a>
          </div>

          {/* Telegram — single-action card */}
          <a
            href={TELEGRAM_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="channel-card block px-6 py-6 mb-10"
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <div className="flex items-center gap-4">
              <TelegramIcon />
              <div className="flex-1 min-w-0">
                <div
                  className="font-normal mb-1"
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontSize: 22,
                    letterSpacing: "-0.4px",
                    color: CARD_INK,
                  }}
                >
                  Telegram
                </div>
                <div
                  style={{
                    fontSize: 14,
                    lineHeight: 1.45,
                    color: MUTED_INK,
                  }}
                >
                  open <span style={{ fontWeight: 500 }}>@myinstaclaw_bot</span>
                  . tap start.
                </div>
              </div>
              <ChevronArrow color={SUBTLE_INK} />
            </div>
          </a>

          {/* ─── COMING SOON ─────────────────────────────────────── */}

          <div className="channel-section-label mb-3.5">coming soon</div>

          <WaitlistCard channel="discord" />
          <div className="h-2.5" />
          <WaitlistCard channel="slack" />

          {/* Footer — BYOB Telegram escape hatch for advanced users */}
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
/* WAITLIST CARD (muted — Discord, Slack)                             */
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
    <div className="channel-card-muted channel-card overflow-hidden">
      <button
        type="button"
        onClick={() => state !== "done" && setExpanded((v) => !v)}
        disabled={state === "done"}
        className="w-full text-left transition-colors duration-150 cursor-pointer disabled:cursor-default"
        style={{ background: "transparent", border: "none", padding: "16px 22px" }}
      >
        <div className="flex items-center gap-4">
          {channel === "discord" ? <DiscordIcon muted /> : <SlackIcon muted />}
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
                fontSize: 13,
                color: state === "done" ? CORAL : MUTED_INK,
                marginTop: 1,
                opacity: state === "done" ? 1 : 0.85,
              }}
            >
              {state === "done" ? successMessage : "soon. tap to join the waitlist."}
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
          className="px-5 pb-5 pt-1"
          style={{
            borderTop: "1px solid rgba(51, 51, 52, 0.06)",
            position: "relative",
            zIndex: 1,
          }}
        >
          <div className="flex gap-2 mt-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email"
              autoComplete="email"
              className="flex-1 px-4 py-3 rounded-xl outline-none transition-all duration-150"
              style={{
                background: "rgba(255, 255, 255, 0.95)",
                border: "1px solid rgba(51, 51, 52, 0.10)",
                fontSize: 15,
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
                padding: "0 18px",
                fontSize: 15,
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
  );
}

/* ────────────────────────────────────────────────────────────────── */
/* ICONS — clean, unambiguous brand representations                   */
/* ────────────────────────────────────────────────────────────────── */

/**
 * Apple Messages icon — green-gradient rounded square (squircle-ish)
 * with the white chat-bubble glyph. Apple's actual Messages icon mark
 * is trademarked, so we render a clean representation: the same green
 * gradient, the same speech-bubble shape, sized to read identically
 * at a glance.
 */
function IMessageIcon() {
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        display: "inline-flex",
        width: 56,
        height: 56,
        borderRadius: 14,
        overflow: "hidden",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.4), 0 2px 8px rgba(31, 173, 62, 0.25), 0 6px 16px -4px rgba(31, 173, 62, 0.20)",
      }}
    >
      <svg
        viewBox="0 0 60 60"
        width="56"
        height="56"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id="ic-imessage-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5BF675" />
            <stop offset="100%" stopColor="#1FAD3E" />
          </linearGradient>
        </defs>
        <rect width="60" height="60" rx="14" fill="url(#ic-imessage-grad)" />
        <path
          d="M30 13.5c-10.49 0-19 6.52-19 14.56 0 4.27 2.47 8.12 6.37 10.73L14.5 47l8.85-4.73c2.05.48 4.21.74 6.45.74 10.49 0 19-6.52 19-14.56S40.49 13.5 30 13.5z"
          fill="#ffffff"
        />
      </svg>
    </span>
  );
}

/**
 * Telegram icon — blue-gradient circle with the signature white
 * paper-plane glyph. The paper plane is Telegram's defining mark;
 * no Apple-trademark concerns since Telegram's brand is openly
 * documented for developer use.
 */
function TelegramIcon() {
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        display: "inline-flex",
        width: 56,
        height: 56,
        borderRadius: "50%",
        overflow: "hidden",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.4), 0 2px 8px rgba(34, 158, 217, 0.25), 0 6px 16px -4px rgba(34, 158, 217, 0.20)",
      }}
    >
      <svg
        viewBox="0 0 60 60"
        width="56"
        height="56"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id="ic-telegram-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#37BBFE" />
            <stop offset="100%" stopColor="#1E96C8" />
          </linearGradient>
        </defs>
        <circle cx="30" cy="30" r="30" fill="url(#ic-telegram-grad)" />
        <path
          d="M44.94 17.32 12.93 29.62c-2.18.85-2.16 2.05-.4 2.59l8.21 2.56 19.04-12.01c.9-.5 1.71-.24 1.04.32L25.4 38.14l-.6 9c.85 0 1.21-.39 1.67-.85l4-3.87 8.31 6.15c1.52.85 2.62.4 2.98-1.41l5.41-25.49c.53-2.2-.78-3.19-2.23-2.35z"
          fill="#ffffff"
        />
      </svg>
    </span>
  );
}

/**
 * Discord — purple-blurple rounded square with the Clyde mark
 * (Discord's mascot face). Rendered slightly desaturated when muted
 * to match the "coming soon" treatment.
 */
function DiscordIcon({ muted = false }: { muted?: boolean }) {
  const opacity = muted ? 0.55 : 1;
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        display: "inline-flex",
        width: 44,
        height: 44,
        borderRadius: 11,
        overflow: "hidden",
        opacity,
        filter: muted ? "saturate(0.7)" : "none",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 4px rgba(88, 101, 242, 0.15)",
      }}
    >
      <svg
        viewBox="0 0 60 60"
        width="44"
        height="44"
        style={{ display: "block" }}
      >
        <rect width="60" height="60" rx="11" fill="#5865F2" />
        <path
          d="M42.07 18.4a23.6 23.6 0 0 0-5.95-1.85.09.09 0 0 0-.1.04c-.26.46-.55 1.05-.74 1.52a21.86 21.86 0 0 0-6.56 0c-.2-.48-.49-1.06-.76-1.52a.09.09 0 0 0-.1-.04 23.5 23.5 0 0 0-5.95 1.85.08.08 0 0 0-.04.03c-3.8 5.66-4.84 11.18-4.33 16.63 0 .03.02.05.04.07a23.7 23.7 0 0 0 7.16 3.62.09.09 0 0 0 .1-.03 17 17 0 0 0 1.47-2.39.09.09 0 0 0-.05-.12 15.6 15.6 0 0 1-2.23-1.06.09.09 0 0 1-.01-.15c.15-.11.3-.23.44-.35a.09.09 0 0 1 .09-.01c4.68 2.14 9.74 2.14 14.36 0a.09.09 0 0 1 .09.01c.14.12.29.24.45.35a.09.09 0 0 1-.01.15c-.71.42-1.46.78-2.24 1.06a.09.09 0 0 0-.05.12c.43.83.93 1.62 1.47 2.39a.09.09 0 0 0 .1.03 23.6 23.6 0 0 0 7.17-3.62.09.09 0 0 0 .04-.07c.61-6.31-1.02-11.78-4.34-16.63a.07.07 0 0 0-.04-.03zM24.74 32.32c-1.44 0-2.63-1.33-2.63-2.96 0-1.63 1.17-2.96 2.63-2.96 1.48 0 2.66 1.34 2.63 2.96 0 1.63-1.17 2.96-2.63 2.96zm9.74 0c-1.44 0-2.63-1.33-2.63-2.96 0-1.63 1.17-2.96 2.63-2.96 1.48 0 2.66 1.34 2.63 2.96 0 1.63-1.16 2.96-2.63 2.96z"
          fill="#ffffff"
        />
      </svg>
    </span>
  );
}

/**
 * Slack — 4-color hash mark. Each of the four colored rounded
 * rectangles is one of Slack's brand colors. Slightly desaturated
 * when muted.
 */
function SlackIcon({ muted = false }: { muted?: boolean }) {
  const opacity = muted ? 0.6 : 1;
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        display: "inline-flex",
        width: 44,
        height: 44,
        borderRadius: 11,
        overflow: "hidden",
        opacity,
        filter: muted ? "saturate(0.65)" : "none",
        background: "rgba(255, 255, 255, 0.92)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.5), 0 1px 4px rgba(51, 51, 52, 0.06)",
      }}
    >
      <svg
        viewBox="0 0 60 60"
        width="44"
        height="44"
        style={{ display: "block" }}
      >
        {/* Slack's signature 4-block hash. Each block is two
            perpendicular rounded bars meeting at a corner, all four
            slot together to form the # outline. */}
        {/* Top-left block (pink) */}
        <rect x="11" y="22" width="10" height="4.2" rx="2.1" fill="#E01E5A" />
        <rect x="22.5" y="10.5" width="4.2" height="10" rx="2.1" fill="#E01E5A" />
        {/* Top-right block (yellow) */}
        <rect x="33" y="22" width="16" height="4.2" rx="2.1" fill="#ECB22E" />
        <rect x="33" y="10.5" width="4.2" height="10" rx="2.1" fill="#ECB22E" />
        {/* Bottom-left block (blue) */}
        <rect x="11" y="33.8" width="10" height="4.2" rx="2.1" fill="#36C5F0" />
        <rect x="22.5" y="39.5" width="4.2" height="10" rx="2.1" fill="#36C5F0" />
        {/* Bottom-right block (green) */}
        <rect x="33" y="33.8" width="16" height="4.2" rx="2.1" fill="#2EB67D" />
        <rect x="33" y="39.5" width="4.2" height="10" rx="2.1" fill="#2EB67D" />
      </svg>
    </span>
  );
}

/** Subtle chevron arrow — used as the affordance hint on each card. */
function ChevronArrow({ color }: { color: string }) {
  return (
    <svg
      aria-hidden
      width="20"
      height="20"
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
