"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * /channels client view.
 *
 * Mobile-first card layout matching the /auth + /onboarding/done
 * aesthetic (cream + serif headlines + glass cards). Each card is
 * full-width on mobile, stacked. Coral accent reserved for the
 * agent-voice headline + the primary CTA inside the Discord/Slack
 * expanded forms; the channel cards use brand-color accents (Apple
 * blue, Telegram blue) so each option is visually distinct without
 * the coral becoming background noise.
 *
 * Four channel cards:
 *   1. iMessage  — sms: scheme link, opens Messages on iPhone /
 *                  default SMS app on Android (Sendblue downgrades
 *                  to SMS for Android automatically).
 *   2. Telegram  — https://t.me/myinstaclaw_bot opens the shared
 *                  bot in the Telegram app (or web on desktop).
 *   3. Discord   — inline expandable waitlist form.
 *   4. Slack     — inline expandable waitlist form.
 *
 * Plus a small "advanced: bring your own Telegram bot" link at the
 * bottom for legacy BYOB users.
 */

const CORAL = "#E96F4D";
const APPLE_BLUE = "#007AFF";
const TELEGRAM_BLUE = "#0088cc";
const DISCORD_INK = "#5865f2";
const SLACK_INK = "#4a154b";

const CREAM_BG = "#f8f7f4";
const CARD_INK = "#333334";
const MUTED_INK = "#6b6b6b";
const SUBTLE_INK = "#9a9892";
const CARD_BORDER = "rgba(51, 51, 52, 0.08)";

const SENDBLUE_NUMBER = "+14072425197";

// SMS deep link. iOS uses ?body= for the prefilled message.
// Empty body → user types whatever they want.
const SMS_HREF = `sms:${SENDBLUE_NUMBER}`;
const TELEGRAM_HREF = "https://t.me/myinstaclaw_bot";

type WaitlistChannel = "discord" | "slack";

export function ChannelsClient() {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: CREAM_BG, color: CARD_INK }}
    >
      <main className="flex-1 flex flex-col items-center px-5 py-12">
        <div className="w-full" style={{ maxWidth: 460 }}>
          {/* Wordmark */}
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

          {/* Headline */}
          <h1
            className="font-normal mb-3"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(36px, 10vw, 48px)",
              lineHeight: 1.05,
              letterSpacing: "-1.2px",
              color: CARD_INK,
            }}
          >
            pick a channel.
          </h1>

          <p
            className="mb-10"
            style={{
              fontSize: 16,
              lineHeight: 1.5,
              color: MUTED_INK,
              maxWidth: 380,
            }}
          >
            wherever you&apos;d rather text from. i&apos;ll meet you there.
          </p>

          {/* iMessage card */}
          <ChannelLinkCard
            href={SMS_HREF}
            accent={APPLE_BLUE}
            icon={<AppleMessagesIcon />}
            title="iMessage"
            subtitle="text our number. the agent meets you there."
          />

          {/* Save Contact link — secondary affordance under iMessage.
              Per spec §9 (spam-filter avoidance), saving the contact
              before the first text preempts iMessage's Unknown Senders
              quarantine. Downloads instaclaw.vcf which iOS prompts to
              "Add to Contacts." */}
          <a
            href="/api/imessage/vcard"
            className="block text-center mb-6 transition-colors duration-150"
            style={{
              fontSize: 13,
              color: SUBTLE_INK,
              textDecoration: "none",
              padding: "8px 16px",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = APPLE_BLUE;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = SUBTLE_INK;
            }}
          >
            tip: save our contact first.{" "}
            <span style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>
              instaclaw.vcf
            </span>
          </a>

          {/* Telegram card */}
          <ChannelLinkCard
            href={TELEGRAM_HREF}
            external
            accent={TELEGRAM_BLUE}
            icon={<TelegramIcon />}
            title="Telegram"
            subtitle="open @myinstaclaw_bot. tap start. same flow."
          />

          {/* Discord — waitlist */}
          <WaitlistCard channel="discord" accent={DISCORD_INK} icon={<DiscordIcon />} />

          {/* Slack — waitlist */}
          <WaitlistCard channel="slack" accent={SLACK_INK} icon={<SlackIcon />} />

          {/* Advanced: BYOB Telegram (legacy flow) */}
          <p
            className="mt-10 text-center"
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
/* CARD — link (iMessage, Telegram)                                    */
/* ────────────────────────────────────────────────────────────────── */

interface ChannelLinkCardProps {
  href: string;
  external?: boolean;
  accent: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}

function ChannelLinkCard(props: ChannelLinkCardProps) {
  const { href, external, accent, icon, title, subtitle } = props;
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="group relative block rounded-2xl mb-3 transition-all duration-150 ease-out active:scale-[0.995]"
      style={{
        background: "rgba(255, 255, 255, 0.85)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: `1px solid ${CARD_BORDER}`,
        boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.6), 0 1px 2px rgba(51, 51, 52, 0.04), 0 4px 12px rgba(51, 51, 52, 0.04)`,
        padding: "20px 22px 20px 26px",
        textDecoration: "none",
        color: "inherit",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow = `inset 0 1px 0 rgba(255, 255, 255, 0.6), 0 1px 2px rgba(51, 51, 52, 0.06), 0 8px 24px rgba(51, 51, 52, 0.08)`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = `inset 0 1px 0 rgba(255, 255, 255, 0.6), 0 1px 2px rgba(51, 51, 52, 0.04), 0 4px 12px rgba(51, 51, 52, 0.04)`;
      }}
    >
      {/* Brand-color accent — 3px bar inset from the left edge */}
      <span
        aria-hidden
        className="absolute left-0 top-4 bottom-4 rounded-full"
        style={{ width: 3, background: accent }}
      />

      <div className="flex items-center gap-4">
        <span
          className="shrink-0 flex items-center justify-center"
          style={{ width: 28, height: 28, color: accent }}
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div
            className="font-normal mb-0.5"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 19,
              letterSpacing: "-0.3px",
              color: CARD_INK,
            }}
          >
            {title}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.4, color: MUTED_INK }}>
            {subtitle}
          </div>
        </div>
        <span
          aria-hidden
          className="shrink-0 transition-transform duration-150 ease-out group-hover:translate-x-0.5"
          style={{ fontSize: 18, color: SUBTLE_INK, marginTop: 2 }}
        >
          →
        </span>
      </div>
    </a>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/* CARD — waitlist (Discord, Slack)                                    */
/* ────────────────────────────────────────────────────────────────── */

interface WaitlistCardProps {
  channel: WaitlistChannel;
  accent: string;
  icon: React.ReactNode;
}

function WaitlistCard({ channel, accent, icon }: WaitlistCardProps) {
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
    <div
      className="rounded-2xl mb-3 transition-all duration-200 ease-out overflow-hidden"
      style={{
        background: "rgba(255, 255, 255, 0.7)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: `1px solid ${CARD_BORDER}`,
        boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 1px 2px rgba(51, 51, 52, 0.03)`,
      }}
    >
      {/* Header — always visible, toggles expansion */}
      <button
        type="button"
        onClick={() => state !== "done" && setExpanded((v) => !v)}
        disabled={state === "done"}
        className="w-full text-left transition-all duration-150 ease-out cursor-pointer disabled:cursor-default"
        style={{
          background: "transparent",
          border: "none",
          padding: "18px 22px",
        }}
      >
        <div className="flex items-center gap-4">
          <span
            className="shrink-0 flex items-center justify-center"
            style={{ width: 26, height: 26, color: accent, opacity: 0.7 }}
          >
            {icon}
          </span>
          <div className="flex-1 min-w-0">
            <div
              className="font-normal"
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 18,
                letterSpacing: "-0.3px",
                color: CARD_INK,
              }}
            >
              {channelLabel}
            </div>
            <div
              style={{
                fontSize: 13,
                color: state === "done" ? CORAL : MUTED_INK,
                marginTop: 2,
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

      {/* Expanded form */}
      {expanded && state !== "done" && (
        <div
          className="px-5 pb-5 pt-1"
          style={{ borderTop: `1px solid ${CARD_BORDER}` }}
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
                border: `1px solid ${CARD_BORDER}`,
                fontSize: 15,
                color: CARD_INK,
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = CORAL;
                e.currentTarget.style.boxShadow = `0 0 0 3px rgba(233, 111, 77, 0.12)`;
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = CARD_BORDER;
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
/* ICONS                                                               */
/* ────────────────────────────────────────────────────────────────── */

function AppleMessagesIcon() {
  // Simplified speech bubble — read as iMessage at a glance without
  // shipping Apple's trademarked logo mark.
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
      <path
        d="M11 2.5c4.97 0 9 3.32 9 7.42 0 4.1-4.03 7.42-9 7.42-1.06 0-2.07-.15-3.01-.43L4 19l1.2-3.06A6.74 6.74 0 0 1 2 9.92C2 5.82 6.03 2.5 11 2.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m9.04 14.31-.38 4.16c.55 0 .8-.24 1.1-.52l2.64-2.5 5.47 4c1 .55 1.71.26 1.96-.93l3.55-16.6c.31-1.47-.53-2.05-1.5-1.7L1.36 8.61c-1.44.56-1.42 1.36-.25 1.72l5.13 1.6L18.16 4.4c.56-.36 1.07-.16.65.2L9.04 14.31Z"
        fill="currentColor"
      />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20.32 4.37A19.79 19.79 0 0 0 15.42 3l-.24.51c1.65.4 2.4.97 3.19 1.66A12.27 12.27 0 0 0 12 4c-2.3 0-4.36.6-6.37 1.17.8-.69 1.6-1.27 3.26-1.66L8.65 3a19.79 19.79 0 0 0-4.97 1.37C1.04 8.4.32 12.31.68 16.17a17.79 17.79 0 0 0 5.5 2.78c.45-.61.84-1.27 1.18-1.97-.66-.25-1.3-.55-1.91-.91.16-.12.32-.24.47-.36 3.69 1.71 7.69 1.71 11.32 0 .15.12.31.24.47.36-.61.36-1.25.66-1.91.91.34.7.73 1.36 1.18 1.97a17.79 17.79 0 0 0 5.5-2.78c.43-4.46-.74-8.34-3.16-11.8ZM8.52 14c-1.1 0-2-1.02-2-2.27 0-1.25.88-2.27 2-2.27s2.02 1.02 2 2.27c0 1.25-.88 2.27-2 2.27Zm6.96 0c-1.1 0-2-1.02-2-2.27 0-1.25.88-2.27 2-2.27s2.02 1.02 2 2.27c0 1.25-.88 2.27-2 2.27Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SlackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5.5 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0-1a2 2 0 0 1-2-2 2 2 0 0 1 2-2H10a2 2 0 0 1 2 2 2 2 0 0 1-2 2H5.5Zm3.5-9a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm5 0a2 2 0 0 1 2-2 2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2 2 2 0 0 1-2-2V5Zm5 4.5a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 1a2 2 0 0 1 2 2 2 2 0 0 1-2 2H14a2 2 0 0 1-2-2 2 2 0 0 1 2-2h5Zm-3.5 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm-5 0a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-4.5a2 2 0 0 1 2-2 2 2 0 0 1 2 2V19Z"
        fill="currentColor"
      />
    </svg>
  );
}
