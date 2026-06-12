"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

/**
 * /onboarding/done client — celebration + personalization + handoff.
 *
 * Three render states (per spec §6.5.5 + §6.5.6):
 *
 *   "form"        — initial state. Celebration headline + lightweight
 *                   personalization form + Submit/Skip CTAs.
 *   "post-submit" — after Done/Skip succeeds. Calm "head back to
 *                   messages" handoff state. User closes tab; agent
 *                   reaches them.
 *   "expired"     — pending row was reclaimed by Pass 6 while the user
 *                   was on the form (>10 min on the web flow). Gentle
 *                   prompt to text us again.
 *
 * Design language (per docs/prd/onboarding-redesign-2026-05-26.md §14):
 *   - Agent-voice lowercase serif headlines with periods.
 *   - Coral (#E96F4D) for primary action ONLY. Skip is text-link, equal
 *     visual prominence but visually subordinated.
 *   - Mobile-first (iPhone 12 mini at 375px).
 *   - Glass surfaces: backdrop-blur on cards and selected pills.
 *   - State transitions fade in (opacity + slight translateY).
 *   - No spinners. The submit button transforms during the request.
 *
 * Per spec §6.5.7 invariant 4: when the user submits, the server's
 * compare-and-swap on consumed_at is the source of truth. If we lose
 * the race (Pass 6 reclaimed first), the server returns { kind: "expired" }
 * and we transition to that state.
 */

const CORAL = "#E96F4D";
const CORAL_DEEP = "#c75a34";
const CREAM_BG = "#f8f7f4";
const CARD_INK = "#333334";
const MUTED_INK = "#6b6b6b";
const SUBTLE_INK = "#9a9892";
const CARD_BORDER = "rgba(51, 51, 52, 0.08)";

type Channel = "imessage" | "telegram" | "discord" | "slack" | "web";

type IntendedUse = "work" | "personal" | "both";
type Vibe = "just-get-things-done" | "chatty-and-warm" | "wry-and-minimal";

type Screen = "form" | "post-submit" | "expired";

interface ExistingProfile {
  name: string | null;
  intended_use: string | null;
  vibe: string | null;
}

interface OnboardingDoneClientProps {
  sessionId: string;
  initialState: Screen;
  channel: Channel;
  partner?: string | null;
  suggestedName?: string | null;
  existingProfile?: ExistingProfile | null;
  /**
   * Telegram bot username (without @) for the user's assigned bot,
   * passed through from page.tsx's pending row read. When the channel
   * is "telegram" and we have this value, PostSubmitState renders a
   * tappable `https://t.me/<botUsername>?start=hi` deep-link CTA
   * instead of the pulsing-dot ambient signal — one tap → Telegram
   * opens → user sees the agent's first message already there.
   * Null when channel is non-Telegram or the pending row didn't
   * persist a bot username (channel-first imessage signups, for
   * example, where there's no BYOB bot).
   */
  telegramBotUsername?: string | null;
}

const channelDisplayName = (c: Channel): string => {
  switch (c) {
    case "imessage":
      return "messages";
    case "telegram":
      return "Telegram";
    case "discord":
      return "Discord";
    case "slack":
      return "Slack";
    case "web":
      // Web-only users (skipped /channels via /onboarding/web) land in
      // the dashboard's command center rather than a messaging app.
      // "your dashboard" reads naturally in both "head back to X" and
      // "back to X after this" copy positions.
      return "your dashboard";
  }
};

const VIBE_OPTIONS: Array<{ value: Vibe; label: string; hint: string }> = [
  {
    value: "just-get-things-done",
    label: "just get things done",
    hint: "minimal small-talk, action-first.",
  },
  {
    value: "chatty-and-warm",
    label: "chatty and warm",
    hint: "conversational, asks follow-ups.",
  },
  {
    value: "wry-and-minimal",
    label: "wry and minimal",
    hint: "terse with a quiet sense of humor.",
  },
];

const USE_OPTIONS: Array<{ value: IntendedUse; label: string }> = [
  { value: "work", label: "work" },
  { value: "personal", label: "personal" },
  { value: "both", label: "both" },
];

export function OnboardingDoneClient({
  sessionId,
  initialState,
  channel,
  suggestedName,
  existingProfile,
  telegramBotUsername,
}: OnboardingDoneClientProps) {
  const [screen, setScreen] = useState<Screen>(initialState);
  const [name, setName] = useState<string>(
    existingProfile?.name ?? suggestedName ?? "",
  );
  const [intendedUse, setIntendedUse] = useState<IntendedUse | null>(
    (existingProfile?.intended_use as IntendedUse | null) ?? null,
  );
  const [vibe, setVibe] = useState<Vibe | null>(
    (existingProfile?.vibe as Vibe | null) ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fadeIn, setFadeIn] = useState(false);

  // Fade-in on mount + every state transition.
  useEffect(() => {
    setFadeIn(false);
    const t = setTimeout(() => setFadeIn(true), 30);
    return () => clearTimeout(t);
  }, [screen]);

  const doSubmit = async (asSkip: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/onboarding/done/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          skipped: asSkip,
          profile: asSkip
            ? undefined
            : {
                name: name.trim() || undefined,
                intended_use: intendedUse ?? undefined,
                vibe: vibe ?? undefined,
              },
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        kind?: "ok" | "expired" | "error";
        error?: string;
      };

      if (!res.ok) {
        setError(
          data?.error || `Submit failed (${res.status}). Try again or skip.`,
        );
        setSubmitting(false);
        return;
      }

      if (data.kind === "expired") {
        setScreen("expired");
        setSubmitting(false);
        return;
      }

      // Happy path — transition to handoff state.
      setScreen("post-submit");
      setSubmitting(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Network error. Try again.",
      );
      setSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        color: CARD_INK,
        /* Warm-sand atmosphere — verbatim from /channels, /signin,
         * /plan, /onboarding/provider, /deploying. Closes the visual
         * loop so /onboarding/done feels like the natural endpoint of
         * the same journey — same room the user signed in from. Prior
         * to 2026-05-30 this page used a flat CREAM_BG which read as
         * "different product" against the rest of the funnel. */
        background: `
          radial-gradient(1200px 700px at 50% -10%, rgba(233, 111, 77, 0.18), transparent 65%),
          radial-gradient(900px 600px at 8% 95%, rgba(34, 158, 217, 0.14), transparent 70%),
          radial-gradient(700px 500px at 95% 25%, rgba(31, 173, 62, 0.08), transparent 75%),
          linear-gradient(180deg, #f5f3ee 0%, #f8f7f4 60%, #f9f7f2 100%),
          ${CREAM_BG}
        `,
      }}
    >
      {/* Three-step indicator at the top — same recipe as /plan,
          /onboarding/provider, /deploying. ALL three steps shown as
          completed (green checkmark orbs) because the user is past
          every stage at this point. The visual closure ("everything
          green") reinforces the celebration without adding new copy.
          Sticky-positioned with backdrop blur so it stays visible
          when content scrolls. */}
      <div
        className="sticky top-0 z-10 py-4"
        style={{
          background:
            "linear-gradient(-75deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.6))",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(0, 0, 0, 0.06)",
        }}
      >
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex items-center justify-center gap-2">
            {[
              { num: 1, label: "Sign in" },
              { num: 2, label: "Plan" },
              { num: 3, label: "Deploy" },
            ].map((step, i) => (
              <div key={step.num} className="flex items-center">
                <div className="flex flex-col items-center">
                  <span
                    className="relative flex items-center justify-center w-10 h-10 rounded-full text-sm font-semibold overflow-hidden"
                    style={{
                      background:
                        "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.6), rgba(34,197,94,0.35) 50%, rgba(22,163,74,0.7) 100%)",
                      boxShadow:
                        "rgba(34,197,94,0.3) 0px 2px 8px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
                      color: "#ffffff",
                    }}
                  >
                    <span
                      className="absolute inset-0 rounded-full pointer-events-none"
                      style={{
                        background:
                          "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
                      }}
                    />
                    <span className="relative">&#10003;</span>
                  </span>
                  <span
                    className="text-xs mt-1.5 font-medium"
                    style={{ color: SUBTLE_INK }}
                  >
                    {step.label}
                  </span>
                </div>
                {i < 2 && (
                  <div
                    className="w-16 mx-3 mb-5 rounded-full"
                    style={{ height: "2px", background: "#22c55e" }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <main className="flex-1 flex flex-col items-center justify-center px-5 py-12">
        <div
          className="w-full transition-all duration-300 ease-out"
          style={{
            maxWidth: 460,
            opacity: fadeIn ? 1 : 0,
            transform: fadeIn ? "translateY(0)" : "translateY(8px)",
          }}
        >
          {screen === "form" && (
            <FormState
              channel={channel}
              name={name}
              setName={setName}
              intendedUse={intendedUse}
              setIntendedUse={setIntendedUse}
              vibe={vibe}
              setVibe={setVibe}
              submitting={submitting}
              error={error}
              onSubmit={() => doSubmit(false)}
              onSkip={() => doSubmit(true)}
            />
          )}

          {screen === "post-submit" && (
            <PostSubmitState
              channel={channel}
              telegramBotUsername={telegramBotUsername ?? null}
              memory={{
                name: name.trim() || null,
                intendedUse,
                vibe,
              }}
            />
          )}

          {screen === "expired" && <ExpiredState />}
        </div>
      </main>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/* FORM STATE                                                          */
/* ────────────────────────────────────────────────────────────────── */

interface FormStateProps {
  channel: Channel;
  name: string;
  setName: (v: string) => void;
  intendedUse: IntendedUse | null;
  setIntendedUse: (v: IntendedUse | null) => void;
  vibe: Vibe | null;
  setVibe: (v: Vibe | null) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
  onSkip: () => void;
}

function FormState(props: FormStateProps) {
  const {
    channel,
    name,
    setName,
    intendedUse,
    setIntendedUse,
    vibe,
    setVibe,
    submitting,
    error,
    onSubmit,
    onSkip,
  } = props;

  return (
    <>
      {/* Celebration headline */}
      <h1
        className="font-normal mb-3"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: "clamp(40px, 11vw, 56px)",
          lineHeight: 1.02,
          letterSpacing: "-1.5px",
          color: CARD_INK,
        }}
      >
        you&apos;re in.
      </h1>

      {/* Subtitle */}
      <p
        className="mb-10"
        style={{
          fontSize: 16,
          lineHeight: 1.5,
          color: MUTED_INK,
          maxWidth: 380,
        }}
      >
        two seconds to tell me about you. or skip, no offense taken.
      </p>

      {/* Fields */}
      <div className="space-y-8">
        {/* Name */}
        <div>
          <label
            className="block mb-2.5"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 18,
              color: CARD_INK,
              letterSpacing: "-0.2px",
            }}
            htmlFor="name"
          >
            what should I call you?
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="first name is fine"
            autoComplete="given-name"
            maxLength={100}
            className="w-full px-4 py-3 rounded-xl outline-none transition-all duration-150"
            style={{
              background: "rgba(255, 255, 255, 0.85)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              border: `1px solid ${CARD_BORDER}`,
              fontSize: 16,
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
          />
        </div>

        {/* Intended use — horizontal pills */}
        <div>
          <label
            className="block mb-2.5"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 18,
              color: CARD_INK,
              letterSpacing: "-0.2px",
            }}
          >
            what do you want to use me for?
          </label>
          <div className="flex gap-2.5">
            {USE_OPTIONS.map((opt) => (
              <PillOption
                key={opt.value}
                label={opt.label}
                selected={intendedUse === opt.value}
                onClick={() =>
                  setIntendedUse(intendedUse === opt.value ? null : opt.value)
                }
              />
            ))}
          </div>
        </div>

        {/* Vibe — vertical stack */}
        <div>
          <label
            className="block mb-2.5"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 18,
              color: CARD_INK,
              letterSpacing: "-0.2px",
            }}
          >
            how should I sound?
          </label>
          <div className="space-y-2">
            {VIBE_OPTIONS.map((opt) => (
              <VibeOption
                key={opt.value}
                label={opt.label}
                hint={opt.hint}
                selected={vibe === opt.value}
                onClick={() => setVibe(vibe === opt.value ? null : opt.value)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Error surface */}
      {error && (
        <div
          className="mt-6 px-4 py-3 rounded-xl text-sm"
          style={{
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.20)",
            color: "#b14444",
          }}
        >
          {error}
        </div>
      )}

      {/* CTAs — primary glass-coral pill + skip text link.
          2026-05-30 polish: upgraded from flat-coral rounded-2xl to the
          .liquid-glass-signin cta-coral recipe used across /signin,
          /plan ("start free trial"), and /onboarding/provider ("save
          and continue"). Same glass surface + coral substrate behind.
          Shared :hover behavior comes from globals.css so the
          per-button onMouseEnter/Leave handlers are gone. */}
      <div className="mt-10 flex flex-col items-center gap-3 w-full">
        <div
          className="liquid-glass-signin-root cta-coral mx-auto w-full"
          style={{ maxWidth: 460 }}
        >
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            className="liquid-glass-signin"
            style={
              submitting
                ? { opacity: 0.5, cursor: "not-allowed" }
                : undefined
            }
          >
            {submitting ? "saving..." : "ok, let's meet."}
          </button>
          <div aria-hidden className="liquid-glass-signin-shadow" />
        </div>

        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          className="transition-colors duration-150 cursor-pointer disabled:cursor-default underline"
          style={{
            background: "transparent",
            border: "none",
            color: MUTED_INK,
            fontSize: 13,
            padding: "10px 20px",
            textUnderlineOffset: 3,
            letterSpacing: "-0.1px",
          }}
          onMouseEnter={(e) => {
            if (submitting) return;
            e.currentTarget.style.color = CARD_INK;
          }}
          onMouseLeave={(e) => {
            if (submitting) return;
            e.currentTarget.style.color = MUTED_INK;
          }}
        >
          {channel === "web"
            ? "skip, i'll meet you in the dashboard."
            : "skip, just text me back when ready."}
        </button>
      </div>

      {/* Quiet footer reinforcing what's about to happen */}
      <p
        className="mt-8 text-center"
        style={{ fontSize: 12, color: SUBTLE_INK, lineHeight: 1.5 }}
      >
        back to {channelDisplayName(channel)} after this.
      </p>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/* POST-SUBMIT STATE                                                   */
/* ────────────────────────────────────────────────────────────────── */

/**
 * Memory card data — the agent's first memory of the user, derived
 * from the FormState inputs. Each line is null when the user skipped
 * or didn't fill that field. The card only renders if AT LEAST one
 * line is non-null; full skip → no card → straight to the CTA.
 */
interface MemoryData {
  name: string | null;
  intendedUse: IntendedUse | null;
  vibe: Vibe | null;
}

/**
 * Human-readable phrases per vibe value, used by the memory card.
 * Matches the FormState's VIBE_OPTIONS labels but reframed as the
 * AGENT's voice ("you like X") rather than the user's choice.
 */
const VIBE_PHRASE: Record<Vibe, string> = {
  "just-get-things-done": "just-get-things-done",
  "chatty-and-warm": "chatty and warm",
  "wry-and-minimal": "wry and minimal",
};
const USE_PHRASE: Record<IntendedUse, string> = {
  work: "for work",
  personal: "for personal stuff",
  both: "for work and personal",
};

function PostSubmitState({
  channel,
  telegramBotUsername,
  memory,
}: {
  channel: Channel;
  telegramBotUsername: string | null;
  memory: MemoryData;
}) {
  const isWeb = channel === "web";

  // 2026-05-30 — channel-specific deep-link CTA construction.
  //
  //   telegram → https://t.me/<botUsername>?start=hi  (deep-link
  //              opens Telegram app; ?start=hi triggers the bot's
  //              /start handler so the agent's first message lands
  //              immediately)
  //   imessage → sms:+1...&body=hi   (sms: scheme opens Messages
  //              with the body pre-filled on iOS/macOS)
  //   discord  → /dashboard          (no deep-link to a specific bot
  //              yet — defer to dashboard until that exists)
  //   slack    → /dashboard          (same as discord)
  //   web      → /dashboard
  //
  // The CTA text + destination are coupled. When a bot username is
  // unavailable for the Telegram channel (rare — channel-first
  // signups skip BYOB) we fall back to a generic "head back to
  // telegram." copy without a deep link.
  let ctaHref: string;
  let ctaLabel: string;
  let ctaModifier: string; // .cta-coral / .cta-telegram / etc.

  if (isWeb) {
    ctaHref = "/dashboard";
    ctaLabel = "open your command center";
    ctaModifier = "cta-coral";
  } else if (channel === "telegram" && telegramBotUsername) {
    // Telegram deep-link with /start payload so the agent's first
    // message dispatches immediately on tap.
    ctaHref = `https://t.me/${telegramBotUsername}?start=hi`;
    ctaLabel = "open telegram and say hi";
    ctaModifier = "cta-telegram";
  } else if (channel === "imessage") {
    // sms: URI with body= for iOS/macOS Messages pre-fill. The
    // number lives in lib/channels OR /channels source — using the
    // same number /channels' iMessage card uses (+14072425197).
    // We don't pre-fill body with "hi" because some carriers strip
    // the body param; user opens Messages with our number ready.
    ctaHref = "sms:+14072425197";
    ctaLabel = "open messages and say hi";
    ctaModifier = "cta-coral";
  } else {
    // Discord / Slack / unknown — fall through to dashboard.
    ctaHref = "/dashboard";
    ctaLabel = "open your command center";
    ctaModifier = "cta-coral";
  }

  // Build the memory card's lines (only the non-null ones render).
  const memoryLines: string[] = [];
  if (memory.name) memoryLines.push(`you go by ${memory.name}.`);
  if (memory.intendedUse)
    memoryLines.push(`you'll use me ${USE_PHRASE[memory.intendedUse]}.`);
  if (memory.vibe) memoryLines.push(`you like ${VIBE_PHRASE[memory.vibe]}.`);
  const showMemoryCard = memoryLines.length > 0;

  return (
    <div className="text-center">
      <h1
        className="font-normal mb-4"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: "clamp(40px, 11vw, 56px)",
          lineHeight: 1.02,
          letterSpacing: "-1.5px",
          color: CARD_INK,
        }}
      >
        you&apos;re all set.
      </h1>

      <p
        className="mb-2"
        style={{
          fontSize: 18,
          lineHeight: 1.45,
          color: MUTED_INK,
          maxWidth: 360,
          margin: "0 auto 16px",
        }}
      >
        {isWeb
          ? "your command center is ready."
          : `head back to ${channelDisplayName(channel)}.`}
      </p>

      {/* 2026-05-30 — Memory card. The agent's first memory of the
          user, written in real time. The user just submitted the
          form; this card visualizes what the agent now knows. Each
          line "appears like ink" — sequential fade-in with a slight
          upward translate at staggered delays (350ms apart, starting
          at 350ms after mount). The card is the visual proof of the
          product's core promise (personal AI with memory). Without
          this, the user has no idea anything happened when they hit
          submit. Hidden if every line is null (full-skip path). */}
      {showMemoryCard && (
        <div
          className="mx-auto mb-10 text-left"
          style={{
            maxWidth: 380,
            padding: "20px 22px 22px",
            borderRadius: 16,
            background:
              "linear-gradient(-75deg, rgba(255,255,255,0.55), rgba(255,255,255,0.78), rgba(255,255,255,0.55))",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(0,0,0,0.06)",
            boxShadow:
              "rgba(0,0,0,0.04) 0px 2px 8px 0px, rgba(255,255,255,0.55) 0px 1px 1px 0px inset",
          }}
        >
          <p
            className="mb-3 memory-line"
            style={{
              fontSize: 13,
              color: SUBTLE_INK,
              letterSpacing: "0.04em",
              textTransform: "lowercase",
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              animationDelay: "0ms",
            }}
          >
            i remember:
          </p>
          {memoryLines.map((line, i) => (
            <p
              key={line}
              className="memory-line"
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 17,
                lineHeight: 1.45,
                color: CARD_INK,
                letterSpacing: "-0.2px",
                margin: i === memoryLines.length - 1 ? 0 : "0 0 8px",
                animationDelay: `${350 + (i + 1) * 350}ms`,
              }}
            >
              {line}
            </p>
          ))}
        </div>
      )}

      {/* Channel-specific deep-link CTA (Telegram / Messages / web /
          fallback). Replaces the pre-2026-05-30 pulsing coral dot —
          ambient signal → clear action. The CTA inherits its glass
          recipe + tint from .cta-coral or .cta-telegram (see
          globals.css). External links use <a target="_blank"> so the
          Telegram / Messages app launches without dropping our
          tab; internal links use <Link>. */}
      <div
        className={`liquid-glass-signin-root ${ctaModifier} mx-auto`}
        style={{ maxWidth: 380 }}
      >
        {ctaHref.startsWith("/") ? (
          <Link
            href={ctaHref}
            className="liquid-glass-signin"
            style={{ textDecoration: "none", fontFamily: "inherit" }}
          >
            {ctaLabel}
            <span aria-hidden style={{ marginLeft: 4 }}>→</span>
          </Link>
        ) : (
          <a
            href={ctaHref}
            target={ctaHref.startsWith("http") ? "_blank" : undefined}
            rel={ctaHref.startsWith("http") ? "noopener noreferrer" : undefined}
            className="liquid-glass-signin"
            style={{ textDecoration: "none", fontFamily: "inherit" }}
          >
            {ctaLabel}
            <span aria-hidden style={{ marginLeft: 4 }}>→</span>
          </a>
        )}
        <div aria-hidden className="liquid-glass-signin-shadow" />
      </div>

      {/* Second step, not an alternative. The framing is sequential: the
          primary CTA above is step 1 (message your agent — the activation
          moment, stays visually dominant), and this is step 2 ("now ...").
          "or explore" read as a fork (do this INSTEAD); "now check out"
          reads as the next move (do this NEXT). A user finishing signup on
          a messaging channel otherwise has NO way to discover the dashboard
          exists (skills, WorldID verification, credits, controls) and would
          reasonably conclude the product is messaging-only. Rendered ONLY
          when the primary CTA does not already go to the dashboard — web /
          discord / slack primary IS the dashboard, so a second link there
          would be redundant. The user is already authenticated (the
          /onboarding/done page requires auth()), so /dashboard lands signed
          in; if their VM is still provisioning, the dashboard layout routes
          them to /deploying. */}
      {ctaHref !== "/dashboard" && (
        <Link
          href="/dashboard"
          className="inline-block transition-colors duration-150"
          style={{
            marginTop: 18,
            color: MUTED_INK,
            fontSize: 13,
            letterSpacing: "-0.1px",
            textDecoration: "underline",
            textUnderlineOffset: 3,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = CARD_INK;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = MUTED_INK;
          }}
        >
          now check out your dashboard →
        </Link>
      )}

      <style>{`
        /* "Ink appearing" — each memory-line fades in with a slight
           upward translate. Combined with the staggered animation-
           delay (set inline per element above) this creates the
           sequential "the agent is writing this down right now"
           feeling Cooper specified. Easing is ease-out so the
           settling motion is calm, not snappy. */
        .memory-line {
          opacity: 0;
          transform: translateY(6px);
          animation: memory-ink-appear 600ms ease-out forwards;
        }
        @keyframes memory-ink-appear {
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/* EXPIRED STATE                                                       */
/* ────────────────────────────────────────────────────────────────── */

function ExpiredState() {
  return (
    <div>
      <h1
        className="font-normal mb-4"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: "clamp(36px, 9.5vw, 48px)",
          lineHeight: 1.05,
          letterSpacing: "-1.2px",
          color: CARD_INK,
        }}
      >
        that one expired.
      </h1>

      <p
        className="mb-8"
        style={{
          fontSize: 17,
          lineHeight: 1.5,
          color: MUTED_INK,
          maxWidth: 380,
        }}
      >
        no problem. text us again and we&apos;ll start over fresh.
      </p>

      {/* 2026-05-30 polish: upgraded from flat-coral rounded-2xl to
          the glass-coral pill recipe so the expired-state recovery
          CTA matches the rest of the onboarding family. */}
      <div
        className="liquid-glass-signin-root cta-coral"
        style={{ maxWidth: 240 }}
      >
        <a
          href="sms:+14072425197"
          className="liquid-glass-signin"
          style={{ textDecoration: "none", fontFamily: "inherit" }}
        >
          text us
          <span aria-hidden style={{ marginLeft: 4 }}>→</span>
        </a>
        <div aria-hidden className="liquid-glass-signin-shadow" />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/* PILL + VIBE OPTION components                                       */
/* ────────────────────────────────────────────────────────────────── */

function PillOption({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-xl transition-all duration-150 cursor-pointer active:scale-[0.97]"
      style={{
        background: selected ? CORAL : "rgba(255, 255, 255, 0.85)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: `1px solid ${selected ? CORAL : CARD_BORDER}`,
        color: selected ? "#ffffff" : CARD_INK,
        fontSize: 15,
        padding: "12px 8px",
        boxShadow: selected
          ? "0 1px 2px rgba(233, 111, 77, 0.30), 0 4px 12px rgba(233, 111, 77, 0.18)"
          : "0 1px 2px rgba(51, 51, 52, 0.03)",
      }}
    >
      {label}
    </button>
  );
}

function VibeOption({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-xl transition-all duration-150 cursor-pointer active:scale-[0.995]"
      style={{
        background: selected ? "rgba(233, 111, 77, 0.10)" : "rgba(255, 255, 255, 0.85)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: `1px solid ${selected ? CORAL : CARD_BORDER}`,
        padding: "14px 18px",
        boxShadow: selected
          ? "0 1px 2px rgba(233, 111, 77, 0.18)"
          : "0 1px 2px rgba(51, 51, 52, 0.03)",
      }}
    >
      <div
        className="font-normal"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 17,
          color: selected ? CORAL_DEEP : CARD_INK,
          letterSpacing: "-0.2px",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          color: selected ? CORAL_DEEP : SUBTLE_INK,
          opacity: selected ? 0.85 : 1,
        }}
      >
        {hint}
      </div>
    </button>
  );
}
