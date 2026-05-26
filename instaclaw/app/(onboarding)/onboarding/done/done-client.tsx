"use client";

import { useState, useEffect } from "react";

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

type Channel = "imessage" | "telegram" | "discord" | "slack";

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
      style={{ background: CREAM_BG, color: CARD_INK }}
    >
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

          {screen === "post-submit" && <PostSubmitState channel={channel} />}

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

      {/* CTAs — submit (coral) + skip (equal-prominence text) */}
      <div className="mt-10 flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="w-full rounded-2xl transition-all duration-150 ease-out active:scale-[0.99] cursor-pointer disabled:cursor-default"
          style={{
            background: submitting ? CORAL_DEEP : CORAL,
            color: "#ffffff",
            fontFamily: "var(--font-serif)",
            fontSize: 20,
            letterSpacing: "-0.3px",
            padding: "16px 24px",
            border: "none",
            boxShadow: submitting
              ? "0 1px 2px rgba(199, 90, 52, 0.20)"
              : "0 1px 2px rgba(233, 111, 77, 0.30), 0 4px 16px rgba(233, 111, 77, 0.20)",
          }}
          onMouseEnter={(e) => {
            if (submitting) return;
            e.currentTarget.style.transform = "translateY(-1px)";
            e.currentTarget.style.boxShadow =
              "0 1px 2px rgba(233, 111, 77, 0.32), 0 8px 24px rgba(233, 111, 77, 0.26)";
          }}
          onMouseLeave={(e) => {
            if (submitting) return;
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow =
              "0 1px 2px rgba(233, 111, 77, 0.30), 0 4px 16px rgba(233, 111, 77, 0.20)";
          }}
        >
          {submitting ? "saving..." : "ok, let's meet."}
        </button>

        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          className="transition-colors duration-150 cursor-pointer disabled:cursor-default"
          style={{
            background: "transparent",
            border: "none",
            color: MUTED_INK,
            fontSize: 15,
            padding: "10px 20px",
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
          skip, just text me back when ready.
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

function PostSubmitState({ channel }: { channel: Channel }) {
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
        head back to {channelDisplayName(channel)}.
      </p>

      <p
        className="mb-12"
        style={{
          fontSize: 16,
          lineHeight: 1.5,
          color: SUBTLE_INK,
          maxWidth: 320,
          margin: "0 auto",
        }}
      >
        i&apos;ll be there.
      </p>

      {/* Subtle visual cue — a coral dot that gently pulses, reinforcing
          "something is happening." Not a spinner; not a progress bar.
          Just a small living signal. */}
      <div className="flex justify-center" aria-hidden>
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: CORAL,
            boxShadow: `0 0 0 4px rgba(233, 111, 77, 0.12)`,
            animation: "onboarding-done-pulse 1.6s ease-in-out infinite",
          }}
        />
      </div>

      <style>{`
        @keyframes onboarding-done-pulse {
          0%, 100% {
            transform: scale(1);
            opacity: 0.95;
            box-shadow: 0 0 0 4px rgba(233, 111, 77, 0.10);
          }
          50% {
            transform: scale(1.18);
            opacity: 1;
            box-shadow: 0 0 0 7px rgba(233, 111, 77, 0.16);
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

      <a
        href="sms:+14072425197"
        className="inline-flex items-center gap-2 rounded-2xl transition-all duration-150 ease-out active:scale-[0.99]"
        style={{
          background: CORAL,
          color: "#ffffff",
          fontFamily: "var(--font-serif)",
          fontSize: 18,
          letterSpacing: "-0.3px",
          padding: "14px 24px",
          textDecoration: "none",
          boxShadow:
            "0 1px 2px rgba(233, 111, 77, 0.30), 0 4px 16px rgba(233, 111, 77, 0.20)",
        }}
      >
        text us
        <span aria-hidden style={{ marginLeft: 4 }}>
          →
        </span>
      </a>
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
