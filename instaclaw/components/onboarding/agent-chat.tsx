"use client";

/**
 * AgentChat — the agent's first words on /deploying.
 *
 * Cooper's directive (2026-05-30):
 *
 *   "Direction B is the entire product thesis distilled into one
 *    moment. The user just paid for a personal AI agent. And then...
 *    it talks to them. For the first time. That IS the product. That
 *    IS the screenshot."
 *
 * Sequence (decoupled from polling — early messages run on a fixed
 * timer; final message gated on deploy-complete):
 *
 *   t+0ms:    typing indicator appears
 *   t+2000:   "hi."
 *   t+5000:   "i'm waking up right now."
 *   t+8000:   typing indicator (natural pause)
 *   t+12000:  "setting up my workspace..."
 *   t+18000:  "learning your name." (only if userFirstName is present)
 *   t+19000+: typing indicator persists until deploy completes
 *   when isComplete=true AND past early sequence: "okay. i'm ready."
 *   +1500ms:  CTA fades in below the final message
 *
 * If deploy completes fast (<19s): final message + CTA fire as soon
 * as the early sequence has played past message 4. The user still
 * gets the full ~20s emotional arc even when the technical work was
 * 5 seconds. If deploy completes slow (>19s): the typing indicator
 * holds naturally, signaling "the agent is still preparing." The
 * payoff lands bigger because the wait earned it.
 *
 * Mobile-primary. Messages styled like an iMessage thread where only
 * one person is talking — wabi-sabi lowercase serif on cream, no
 * speech bubbles, no input field. Larry the pixel-crab sits ONCE at
 * the top of the thread as the speaker label.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

const CARD_INK = "#333334";
const SUBTLE_INK = "#9a9892";

interface AgentChatProps {
  /**
   * First name of the user (from session.user.name → split → first
   * token). When non-empty, the "learning your name." line fires; when
   * empty/null, that message is skipped from the sequence (the user
   * is anonymous and the agent has nothing to learn). The name itself
   * doesn't appear in this message — the agent is in the ACT of
   * learning; the name's actual reveal happens off-screen in the
   * agent's first Telegram greeting.
   */
  userFirstName?: string | null;
  /**
   * Channel the user signed up via — drives the final CTA's text +
   * destination. Telegram with a bot username → t.me deep link.
   * iMessage → sms: URI. Web/discord/slack → /dashboard. Unknown →
   * generic "say hi when you're ready." copy without action.
   */
  channel?: "telegram" | "imessage" | "discord" | "slack" | "web" | null;
  /**
   * Telegram bot username (no @). Required when channel === "telegram"
   * for the deep link to work; null otherwise. When channel is
   * telegram but this is null (rare — channel-first imessage signups,
   * or pool VMs mid-configure), CTA falls back to /dashboard.
   */
  botUsername?: string | null;
  /**
   * Gate for the final message. The deploy is "complete" once
   * gateway is healthy + the agent can receive its first message.
   * The chat sequence runs ahead of this; when it's done early it
   * holds on the typing indicator. When the gate flips true AND the
   * early sequence has played to its end, the final message fires.
   */
  isComplete: boolean;
}

interface ChatEvent {
  kind: "message" | "typing";
  text?: string;
  /** Time (ms since chat start) when this event becomes visible. */
  appearsAt: number;
}

/**
 * Build the early-sequence event list. Skipped messages don't take
 * up time slots — the next message slides up to fill. (Otherwise
 * we'd have an awkward gap when the user is anonymous.)
 */
function buildSequence(userFirstName: string | null | undefined): ChatEvent[] {
  const events: ChatEvent[] = [];
  events.push({ kind: "typing", appearsAt: 0 });
  events.push({ kind: "message", text: "hi.", appearsAt: 2000 });
  events.push({
    kind: "message",
    text: "i'm waking up right now.",
    appearsAt: 5000,
  });
  events.push({ kind: "typing", appearsAt: 8000 });
  events.push({
    kind: "message",
    text: "setting up my workspace...",
    appearsAt: 12000,
  });
  if (userFirstName && userFirstName.length > 0) {
    events.push({
      kind: "message",
      text: "learning your name.",
      appearsAt: 18000,
    });
    // Trailing typing indicator — held until isComplete.
    events.push({ kind: "typing", appearsAt: 19000 });
  } else {
    // No name → no "learning your name." message → trailing typing
    // indicator after "setting up my workspace..." instead.
    events.push({ kind: "typing", appearsAt: 13000 });
  }
  return events;
}

/**
 * Final-message + CTA copy per channel. The agent's last word during
 * /deploying is the bridge to the rest of the product — channel-
 * appropriate phrasing matters.
 */
function buildFinalCta(
  channel: AgentChatProps["channel"],
  botUsername: string | null | undefined,
): {
  label: string;
  href: string | null;
  external: boolean;
  modifier: string;
} {
  if (channel === "telegram" && botUsername) {
    return {
      label: "open telegram and say hi",
      // ?start=hi → Telegram bot's /start handler fires with payload
      // "hi", giving the agent its trigger to dispatch the welcome
      // message immediately on tap.
      href: `https://t.me/${botUsername}?start=hi`,
      external: true,
      modifier: "cta-telegram",
    };
  }
  if (channel === "imessage") {
    return {
      label: "open messages and say hi",
      // sms: URI. iOS Messages opens with our number ready; body
      // pre-fill is stripped by some carriers so we leave it off.
      href: "sms:+14072425197",
      external: true,
      modifier: "cta-coral",
    };
  }
  if (channel === "web") {
    return {
      label: "open your command center",
      href: "/dashboard",
      external: false,
      modifier: "cta-coral",
    };
  }
  // Discord / Slack / unknown — fall through to dashboard. The
  // dashboard's own first-run state surfaces the relevant next steps
  // for these channels (separate work, out of scope tonight).
  return {
    label: "open your command center",
    href: "/dashboard",
    external: false,
    modifier: "cta-coral",
  };
}

export function AgentChat({
  userFirstName,
  channel,
  botUsername,
  isComplete,
}: AgentChatProps) {
  const sequence = buildSequence(userFirstName);
  /**
   * Index into `sequence` of the LAST event that has appeared. -1 = no
   * events yet; the chat shows nothing on first render and the first
   * typing indicator fades in on its scheduled appearsAt timer.
   */
  const [visibleUntil, setVisibleUntil] = useState<number>(-1);
  /** Whether the final "okay. i'm ready." message has fired. */
  const [showFinal, setShowFinal] = useState(false);
  /** Whether the CTA has fired (1.5s after final message). */
  const [showCta, setShowCta] = useState(false);

  // Schedule the early sequence on mount. Each event has its own
  // setTimeout; we collect them and clear on unmount.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    sequence.forEach((evt, idx) => {
      const t = setTimeout(() => {
        setVisibleUntil((cur) => (idx > cur ? idx : cur));
      }, evt.appearsAt);
      timers.push(t);
    });
    return () => {
      for (const t of timers) clearTimeout(t);
    };
    // sequence is built from userFirstName which is stable per mount;
    // we deliberately don't re-run when sequence changes (it wouldn't).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Final-message gate (effect 1 of 2): fires when (a) deploy is
  // complete AND (b) the early sequence has played past its last
  // event. The second gate prevents a fast deploy (<19s) from
  // cutting off the sequence mid-stream — the agent finishes its
  // preparation monologue before announcing readiness.
  //
  // 800ms beat after the last typing-indicator before "okay. i'm
  // ready." lands. Gives the user a moment to register that the
  // agent has stopped working — "wait, something's about to
  // happen."
  useEffect(() => {
    if (!isComplete) return;
    if (visibleUntil < sequence.length - 1) return;
    if (showFinal) return;
    const t = setTimeout(() => setShowFinal(true), 800);
    return () => clearTimeout(t);
  }, [isComplete, visibleUntil, sequence.length, showFinal]);

  // CTA gate (effect 2 of 2): SEPARATE from the final-message effect
  // because the previous implementation included `showFinal` in the
  // deps array, so when showFinal flipped true the effect re-ran
  // and its cleanup() cleared the pending showCta timer BEFORE it
  // could fire. Splitting into a dedicated effect keyed on
  // `showFinal` only means the CTA timer fires once and stays
  // scheduled. 1500ms delay after the final message lands —
  // long enough for the user's eyes to read "okay. i'm ready."
  // before the action appears below. Climax pacing.
  useEffect(() => {
    if (!showFinal) return;
    if (showCta) return;
    const t = setTimeout(() => setShowCta(true), 1500);
    return () => clearTimeout(t);
  }, [showFinal, showCta]);

  // The currently-visible event list = all events whose appearsAt
  // has elapsed (idx <= visibleUntil).
  const visibleEvents = sequence.slice(0, visibleUntil + 1);
  // Show the trailing typing indicator only when it's the most-
  // recent visible event AND we haven't fired the final message
  // yet. Once final fires, the typing indicator transforms into the
  // final message visually.
  const lastEvent = visibleEvents[visibleEvents.length - 1];
  const showTrailingTyping =
    lastEvent?.kind === "typing" && !showFinal;
  const finalCta = buildFinalCta(channel, botUsername);

  return (
    <div className="agent-chat-root">
      {/* Larry — speaker label. Renders once at the top of the
          thread. Static (no animation) during the typing sequence
          so he's not competing for attention with the messages.
          Pixel-art rendering preserved via image-rendering:pixelated
          on the .agent-chat-larry CSS. */}
      <div
        aria-hidden
        className="agent-chat-larry"
      />

      {/* Messages thread. Lowercase serif on cream. Each message
          fades in (opacity + slight upward translate) on its
          scheduled timer. Typing indicators replace themselves with
          the next message when it appears. */}
      <div className="agent-chat-messages" aria-live="polite">
        {visibleEvents.map((evt, idx) => {
          // Hide trailing typing once the final message fires.
          if (
            idx === visibleEvents.length - 1 &&
            evt.kind === "typing" &&
            !showTrailingTyping
          ) {
            return null;
          }
          if (evt.kind === "typing") {
            // Only render typing indicator if it's the most-recent
            // event (otherwise an earlier typing indicator becomes
            // stale clutter once subsequent messages appeared).
            if (idx !== visibleEvents.length - 1) return null;
            return <TypingIndicator key={`typing-${idx}`} />;
          }
          return (
            <p key={`msg-${idx}`} className="agent-chat-message">
              {evt.text}
            </p>
          );
        })}

        {showFinal && (
          <p className="agent-chat-message agent-chat-message-final">
            okay. i&apos;m ready.
          </p>
        )}

        {showCta && finalCta.href && (
          <div
            className={`liquid-glass-signin-root ${finalCta.modifier} agent-chat-cta`}
          >
            {finalCta.external ? (
              <a
                href={finalCta.href}
                target={finalCta.href.startsWith("http") ? "_blank" : undefined}
                rel={
                  finalCta.href.startsWith("http")
                    ? "noopener noreferrer"
                    : undefined
                }
                className="liquid-glass-signin"
                style={{ textDecoration: "none", fontFamily: "inherit" }}
              >
                {finalCta.label}
                <span aria-hidden style={{ marginLeft: 6 }}>→</span>
              </a>
            ) : (
              <Link
                href={finalCta.href}
                className="liquid-glass-signin"
                style={{ textDecoration: "none", fontFamily: "inherit" }}
              >
                {finalCta.label}
                <span aria-hidden style={{ marginLeft: 6 }}>→</span>
              </Link>
            )}
            <div aria-hidden className="liquid-glass-signin-shadow" />
          </div>
        )}
      </div>

      <style jsx>{`
        .agent-chat-root {
          display: flex;
          flex-direction: row;
          align-items: flex-start;
          gap: 18px;
          max-width: 520px;
          margin: 0 auto;
          padding: 0 16px;
        }

        @media (max-width: 480px) {
          .agent-chat-root {
            gap: 12px;
            padding: 0 12px;
          }
        }

        /* Larry — first frame of the wave sprite, statically. The
           sprite is /images/larry-wave-sprite.png — 4 frames
           horizontal, each 256×113 source. Scaling the strip to
           (display-width × 4) wide × display-height tall + setting
           background-position to 0 0 isolates frame 1.
           Pixel-rendered to preserve the pixel-art aesthetic. */
        .agent-chat-larry {
          flex-shrink: 0;
          width: 100px;
          height: 44px; /* 100 * (113/256) ≈ 44 — frame aspect */
          background-image: url("/images/larry-wave-sprite.png");
          background-size: 400px 44px; /* 4 frames * 100px = 400 */
          background-position: 0 0;
          background-repeat: no-repeat;
          image-rendering: pixelated;
          image-rendering: -moz-crisp-edges;
          margin-top: 6px;
        }

        @media (max-width: 480px) {
          .agent-chat-larry {
            width: 76px;
            height: 34px;
            background-size: 304px 34px;
          }
        }

        .agent-chat-messages {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        @media (max-width: 480px) {
          .agent-chat-messages {
            gap: 12px;
          }
        }

        /* Each message — wabi-sabi lowercase serif on cream. No
           bubble, no border. The text IS the message. Fades in with
           slight upward translate when it first appears. */
        :global(.agent-chat-message) {
          font-family: var(--font-serif);
          font-size: 22px;
          line-height: 1.35;
          letter-spacing: -0.3px;
          color: ${CARD_INK};
          margin: 0;
          opacity: 0;
          transform: translateY(6px);
          animation: agent-chat-message-in 500ms ease-out forwards;
        }

        @media (max-width: 480px) {
          :global(.agent-chat-message) {
            font-size: 19px;
          }
        }

        /* The final "okay. i'm ready." message — same style, a
           touch louder via tracking. The agent has arrived. */
        :global(.agent-chat-message-final) {
          letter-spacing: -0.4px;
        }

        @keyframes agent-chat-message-in {
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        /* CTA wrapper — fades in below the final message after the
           climax beat. The wrapper itself fades; the inner glass pill
           handles its own visual recipe via .liquid-glass-signin. */
        :global(.agent-chat-cta) {
          margin-top: 8px;
          opacity: 0;
          transform: translateY(8px);
          animation: agent-chat-cta-in 700ms ease-out forwards;
        }

        @keyframes agent-chat-cta-in {
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}

/**
 * Three-dot typing indicator. Each dot pulses on a staggered cycle.
 * iMessage's rhythm: ~1.2s full cycle per dot, 200ms offset between
 * dots, dots grow ~20% at peak. The exact numbers don't matter as
 * much as the rhythm feeling NATURAL — not perfectly even, not
 * frantic. Slight asymmetry mimics how real people pause mid-thought.
 */
function TypingIndicator() {
  return (
    <div
      className="typing-indicator"
      role="status"
      aria-label="Agent is typing"
    >
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
      <style jsx>{`
        .typing-indicator {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 2px 0;
          opacity: 0;
          animation: typing-fade-in 350ms ease-out forwards;
        }
        @keyframes typing-fade-in {
          to {
            opacity: 1;
          }
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: ${SUBTLE_INK};
          opacity: 0.55;
          animation: typing-pulse 1.2s ease-in-out infinite;
        }
        .dot:nth-child(1) {
          animation-delay: 0ms;
        }
        .dot:nth-child(2) {
          animation-delay: 200ms;
        }
        .dot:nth-child(3) {
          animation-delay: 400ms;
        }
        @keyframes typing-pulse {
          0%,
          60%,
          100% {
            transform: scale(1);
            opacity: 0.45;
          }
          30% {
            transform: scale(1.35);
            opacity: 0.95;
          }
        }
      `}</style>
    </div>
  );
}
