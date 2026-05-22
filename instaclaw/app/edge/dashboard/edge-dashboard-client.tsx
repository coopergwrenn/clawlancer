"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { ArrowLeft, ExternalLink, Save, Eye, EyeOff, Check, Loader2 } from "lucide-react";
import { IntentSection } from "./intent-section";
import { MatchHistorySection } from "./match-history-section";
import type { CounterpartMatch, CurrentIntent } from "@/lib/edge-dashboard-data";

type OverlayShape = {
  display_name: string | null;
  spectator_visible: boolean;
  larry_atlas_index: number;
  home_tile_x: number;
  home_tile_y: number;
} | null;

type RenderedShape = {
  display_name: string;
  full_name: string | null;
  spectator_visible: boolean;
};

export function EdgeDashboardClient({
  userId,
  userName,
  initialOverlay,
  initialRendered,
  matches,
  currentIntent,
  userHasIndexKey,
  intentFetchSucceeded,
  trialEndsAt,
  telegramBotUsername,
}: {
  userId: string;
  userName: string | null;
  initialOverlay: OverlayShape;
  initialRendered: RenderedShape;
  matches: CounterpartMatch[];
  currentIntent: CurrentIntent | null;
  userHasIndexKey: boolean;
  intentFetchSucceeded: boolean;
  /**
   * ISO timestamp string of the user's Stripe trial end, or null if no
   * active trial. For Edge attendees this is the fixed June 30 2026
   * timestamp set by app/api/billing/checkout/route.ts. When non-null
   * the dashboard surfaces a small "trial ends X" indicator below the
   * hero so attendees know what to expect on billing day.
   */
  trialEndsAt: string | null;
  /**
   * The user's Telegram bot username (without the @). When present, the
   * dashboard surfaces a prominent "Open in Telegram" CTA between the
   * hero and the matches feed — the most important recovery surface
   * for attendees who lost the deep-link via thread deletion, device
   * switch, or bookmark-only navigation. NULL when the VM hasn't yet
   * completed Telegram provisioning (rare on a fully-onboarded user
   * who reached this page through the normal funnel).
   */
  telegramBotUsername: string | null;
}) {
  const [overlay, setOverlay] = useState<OverlayShape>(initialOverlay);
  const [rendered, setRendered] = useState<RenderedShape>(initialRendered);

  // Display-name field: tracks the user's nickname input. Empty string = fall
  // back to real name (server treats this as null on save).
  const [nicknameInput, setNicknameInput] = useState<string>(
    initialOverlay?.display_name ?? "",
  );
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameSavedAt, setNicknameSavedAt] = useState<number | null>(null);
  const [nicknameError, setNicknameError] = useState<string | null>(null);

  // Visibility toggle: auto-saves on change.
  const [visToggling, setVisToggling] = useState(false);
  const [visError, setVisError] = useState<string | null>(null);

  // Toast for the nickname save (briefly visible after success)
  useEffect(() => {
    if (nicknameSavedAt === null) return;
    const t = setTimeout(() => setNicknameSavedAt(null), 2500);
    return () => clearTimeout(t);
  }, [nicknameSavedAt]);

  async function saveNickname() {
    setNicknameError(null);
    setNicknameSaving(true);
    try {
      const trimmed = nicknameInput.trim();
      const body = { display_name: trimmed.length === 0 ? null : trimmed };
      const res = await fetch("/api/village/overlay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "save failed" }));
        setNicknameError(err.error ?? "save failed");
        return;
      }
      const data = (await res.json()) as { rendered: RenderedShape };
      setRendered(data.rendered);
      setOverlay((prev) => ({
        ...(prev ?? {
          display_name: null,
          spectator_visible: true,
          larry_atlas_index: 0,
          home_tile_x: 30,
          home_tile_y: 37,
        }),
        display_name: trimmed.length === 0 ? null : trimmed,
      }));
      setNicknameSavedAt(Date.now());
    } catch (e) {
      setNicknameError(String(e instanceof Error ? e.message : e));
    } finally {
      setNicknameSaving(false);
    }
  }

  async function toggleVisibility(next: boolean) {
    setVisError(null);
    setVisToggling(true);
    try {
      const res = await fetch("/api/village/overlay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spectator_visible: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "toggle failed" }));
        setVisError(err.error ?? "toggle failed");
        return;
      }
      const data = (await res.json()) as { rendered: RenderedShape };
      setRendered(data.rendered);
      setOverlay((prev) => ({
        ...(prev ?? {
          display_name: null,
          spectator_visible: next,
          larry_atlas_index: 0,
          home_tile_x: 30,
          home_tile_y: 37,
        }),
        spectator_visible: next,
      }));
    } catch (e) {
      setVisError(String(e instanceof Error ? e.message : e));
    } finally {
      setVisToggling(false);
    }
  }

  return (
    <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "32px 24px 80px" }}>
      {/* ─── Slim header with back-link ─────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
          flexWrap: "wrap",
          paddingBottom: "20px",
          borderBottom: "1px solid var(--edge-line)",
          marginBottom: "32px",
        }}
      >
        <Link
          href="/dashboard"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "13px",
            color: "var(--edge-ink-soft)",
            textDecoration: "none",
          }}
        >
          <ArrowLeft size={14} />
          My Dashboard
        </Link>
        <div style={{ fontSize: "12px", color: "var(--edge-ink-soft)", letterSpacing: "0.04em" }}>
          Edge Esmeralda · May 30 → June 27, 2026
        </div>
      </header>

      {/* ─── Hero ────────────────────────────────────────────────────── */}
      <section style={{ marginBottom: "40px" }}>
        <h1
          style={{
            fontSize: "32px",
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--edge-ink)",
            marginBottom: "8px",
            lineHeight: 1.15,
          }}
        >
          Your village
        </h1>
        <p style={{ fontSize: "16px", color: "var(--edge-ink-soft)", lineHeight: 1.55, maxWidth: "640px" }}>
          Your agent walks Healdsburg in real time. Set your nickname or toggle
          your visibility from the public view below.
        </p>

        {/* Trial indicator — visible only when the user is on a non-expired
           trial. For Edge attendees this surfaces "trial ends June 30 ·
           manage" continuously through the village. Reads trialEndsAt
           from props (server-fetched from instaclaw_subscriptions). The
           Manage link POSTs to /api/billing/portal which returns a
           Stripe billing-portal session URL; we then navigate to it.

           Placement reasoning: directly under the welcome paragraph,
           NOT above the matches feed, because (a) matches are the
           primary engagement surface for attendees during the village
           and shouldn't be visually pushed down by billing info, and
           (b) the indicator is informational, not actionable — its job
           is to set expectations, not to interrupt the flow. Compact
           styling (12px font, ink-soft color, single line on desktop)
           keeps it deferential. */}
        {trialEndsAt ? <TrialIndicator trialEndsAt={trialEndsAt} /> : null}
      </section>

      {/* ─── Open in Telegram CTA (F2 audit fix 2026-05-22) ────────── */}
      {/*
        The most important recovery surface on this page. Attendees who
        lose the Telegram deep-link (thread deletion, device switch,
        bookmark-only navigation) have no other way to get back to
        their agent. The bot's username lives on instaclaw_vms.
        telegram_bot_username — we render it here as a prominent CTA.

        Placement: between hero and matches. Above matches because for
        an attendee who arrived from a bookmark, the bot link IS the
        primary action; matches are the secondary surface. Below the
        hero because the trial indicator already lives in the hero's
        flow and bumping the bot CTA above it would feel like billing
        anxiety is the top concern (it isn't — the bot link is).

        Empty state: when telegramBotUsername is null (VM not yet
        finished provisioning Telegram), we render NOTHING rather than
        a "still deploying" placeholder. Users in that state will
        instead be redirected to /deploying by the dashboard's
        upstream layout-level provisioning gate before they ever see
        this page in the unhealthy state.
      */}
      {telegramBotUsername ? (
        <section style={{ marginBottom: "40px" }}>
          <a
            href={`https://t.me/${telegramBotUsername}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "10px",
              width: "100%",
              maxWidth: "420px",
              padding: "16px 24px",
              borderRadius: "999px",
              background: "var(--edge-olive)",
              color: "#FFFFFF",
              fontSize: "14px",
              fontWeight: 500,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              textDecoration: "none",
              transition: "background 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--edge-olive-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--edge-olive)";
            }}
          >
            {/* Telegram paper-plane icon — same path as elsewhere in
               the codebase (inline SVG to avoid an extra dependency). */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
            >
              <path
                d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM16.64 8.8C16.49 10.38 15.84 14.22 15.51 15.98C15.37 16.74 15.09 16.99 14.83 17.02C14.25 17.07 13.81 16.64 13.25 16.27C12.37 15.69 11.87 15.33 11.02 14.77C10.03 14.12 10.67 13.76 11.24 13.18C11.39 13.03 13.95 10.7 14 10.49C14.0069 10.4582 14.006 10.4252 13.9973 10.3938C13.9886 10.3624 13.9724 10.3337 13.95 10.31C13.89 10.26 13.81 10.28 13.74 10.29C13.65 10.31 12.25 11.24 9.52 13.08C9.12 13.35 8.76 13.49 8.44 13.48C8.08 13.47 7.4 13.28 6.89 13.11C6.26 12.91 5.77 12.8 5.81 12.45C5.83 12.27 6.08 12.09 6.55 11.9C9.47 10.63 11.41 9.79 12.38 9.39C15.16 8.23 15.73 8.03 16.11 8.03C16.19 8.03 16.38 8.05 16.5 8.15C16.6 8.23 16.63 8.34 16.64 8.42C16.63 8.48 16.65 8.66 16.64 8.8Z"
                fill="#FFFFFF"
              />
            </svg>
            Open in Telegram
            <span aria-hidden style={{ marginLeft: "2px" }}>→</span>
          </a>
          <p
            style={{
              marginTop: "10px",
              fontSize: "13px",
              color: "var(--edge-ink-soft)",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            @{telegramBotUsername}
          </p>
        </section>
      ) : null}

      {/* ─── Match history + current intent (#12 Phase A) ──────────── */}
      {/*
        Placed RIGHT AFTER the hero because this is the section every
        attendee lands on when they tap "live in the village" from a
        Telegram notification. Their primary mental model is "where's
        MY match?" — the village viz (spectator iframe below) is
        ambient context; the match feed is the answer.

        Server-rendered data is passed as props (matches, currentIntent,
        userHasIndexKey, intentFetchSucceeded). No client interactivity
        in Phase A — realtime subscription for new matches lands in
        Phase B post-launch.
      */}
      <MatchHistorySection
        matches={matches}
        currentIntent={currentIntent}
        userHasIndexKey={userHasIndexKey}
        intentFetchSucceeded={intentFetchSucceeded}
      />

      {/* ─── Intent submission section (#3) — adaptive per FUP-3b ──── */}
      {/*
        Placed BEFORE the spectator view because submitting an intent is
        the primary action that makes things happen IN the village (other
        attendees' agents discover the overlap → matchpool_outcomes row →
        encounter renders). Settings (nickname, visibility) are secondary.

        FUP-3b (2026-05-20): replaced the static <IntentForm /> with
        IntentSection — adaptive on currentIntent. STATE A (no intent —
        rare, only via /edge/intents service-degradation escape):
        prominent olive-bordered panel with the form visible. STATE B
        (has intent — 99.9% case): compact view of current intent text
        with "Update intent" expand affordance. Form stays collapsed
        until clicked.

        The currentIntent prop is already wired by the Consensus
        terminal via lib/edge-dashboard-data.ts:fetchUserCurrentIntent.
        IntentSection just adapts to it.
      */}
      <IntentSection currentIntent={currentIntent} />

      {/* ─── Embedded spectator view ─────────────────────────────────── */}
      <section style={{ marginBottom: "40px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "12px",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <h2
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--edge-ink-soft)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              margin: 0,
            }}
          >
            Live spectator view
          </h2>
          <a
            href="https://edgeclaw-village.vercel.app/spectator"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "12px",
              color: "var(--edge-olive)",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Open full view <ExternalLink size={12} />
          </a>
        </div>
        <div
          style={{
            position: "relative",
            width: "100%",
            paddingBottom: "62.5%",
            borderRadius: "10px",
            overflow: "hidden",
            border: "1px solid var(--edge-line)",
            background: "#0a0d12",
          }}
        >
          <iframe
            src="https://edgeclaw-village.vercel.app/spectator"
            title="Edge Esmeralda spectator view"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              border: "none",
            }}
            sandbox="allow-scripts allow-same-origin"
          />
        </div>
      </section>

      {/* ─── Settings grid ──────────────────────────────────────────── */}
      <section style={{ display: "grid", gap: "20px", gridTemplateColumns: "1fr" }}>
        {/* — Nickname — */}
        <div
          style={{
            padding: "24px",
            border: "1px solid var(--edge-line)",
            borderRadius: "10px",
            background: "rgba(255,255,255,0.5)",
          }}
        >
          <h3
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--edge-ink-soft)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              margin: "0 0 4px",
            }}
          >
            Display name
          </h3>
          <p style={{ fontSize: "13.5px", color: "var(--edge-ink-soft)", margin: "0 0 14px", lineHeight: 1.55 }}>
            The label above your sprite on the spectator view. Leave blank to use
            your real name ({userName ?? "—"}). 1–30 characters.
          </p>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <input
              type="text"
              value={nicknameInput}
              onChange={(e) => setNicknameInput(e.target.value)}
              maxLength={30}
              placeholder={userName ?? "Agent"}
              style={{
                flex: "1 1 240px",
                padding: "10px 14px",
                fontSize: "14px",
                border: "1px solid var(--edge-line)",
                borderRadius: "7px",
                background: "var(--edge-bg)",
                color: "var(--edge-ink)",
                outline: "none",
                fontFamily: "inherit",
              }}
            />
            <button
              onClick={saveNickname}
              disabled={nicknameSaving || nicknameInput.trim() === (overlay?.display_name ?? "")}
              style={{
                padding: "10px 18px",
                fontSize: "14px",
                fontWeight: 500,
                background: "var(--edge-olive)",
                color: "var(--edge-bg)",
                border: "none",
                borderRadius: "7px",
                cursor: nicknameSaving ? "wait" : "pointer",
                opacity: nicknameSaving ? 0.5 : 1,
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {nicknameSaving ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Saving…
                </>
              ) : nicknameSavedAt ? (
                <>
                  <Check size={14} /> Saved
                </>
              ) : (
                <>
                  <Save size={14} /> Save
                </>
              )}
            </button>
          </div>
          {nicknameError && (
            <div style={{ fontSize: "12.5px", color: "#a83232", marginTop: "8px" }}>
              {nicknameError}
            </div>
          )}
          <div style={{ fontSize: "12px", color: "var(--edge-ink-soft)", marginTop: "10px" }}>
            Currently rendering as:{" "}
            <strong style={{ color: "var(--edge-ink)" }}>{rendered.display_name}</strong>
          </div>
        </div>

        {/* — Visibility — */}
        <div
          style={{
            padding: "24px",
            border: "1px solid var(--edge-line)",
            borderRadius: "10px",
            background: "rgba(255,255,255,0.5)",
          }}
        >
          <h3
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--edge-ink-soft)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              margin: "0 0 4px",
            }}
          >
            Spectator visibility
          </h3>
          <p style={{ fontSize: "13.5px", color: "var(--edge-ink-soft)", margin: "0 0 14px", lineHeight: 1.55 }}>
            When off, your agent disappears entirely from the public spectator
            view — no sprite, no name, no position. You stay visible to other
            Edge attendees in the authenticated village view.
          </p>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button
              onClick={() => toggleVisibility(true)}
              disabled={visToggling || rendered.spectator_visible}
              style={{
                flex: "1 1 0",
                padding: "12px 16px",
                fontSize: "14px",
                fontWeight: 500,
                background: rendered.spectator_visible ? "var(--edge-olive)" : "transparent",
                color: rendered.spectator_visible ? "var(--edge-bg)" : "var(--edge-ink)",
                border: `1px solid ${rendered.spectator_visible ? "var(--edge-olive)" : "var(--edge-line)"}`,
                borderRadius: "7px",
                cursor: visToggling || rendered.spectator_visible ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
              }}
            >
              <Eye size={14} /> Visible
            </button>
            <button
              onClick={() => toggleVisibility(false)}
              disabled={visToggling || !rendered.spectator_visible}
              style={{
                flex: "1 1 0",
                padding: "12px 16px",
                fontSize: "14px",
                fontWeight: 500,
                background: !rendered.spectator_visible ? "var(--edge-ink)" : "transparent",
                color: !rendered.spectator_visible ? "var(--edge-bg)" : "var(--edge-ink)",
                border: `1px solid ${!rendered.spectator_visible ? "var(--edge-ink)" : "var(--edge-line)"}`,
                borderRadius: "7px",
                cursor: visToggling || !rendered.spectator_visible ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
              }}
            >
              <EyeOff size={14} /> Hidden
            </button>
          </div>
          {visError && (
            <div style={{ fontSize: "12.5px", color: "#a83232", marginTop: "8px" }}>
              {visError}
            </div>
          )}
        </div>
      </section>

      {/* ─── Footer ─────────────────────────────────────────────────── */}
      <footer
        style={{
          marginTop: "48px",
          paddingTop: "20px",
          borderTop: "1px solid var(--edge-line)",
          fontSize: "12px",
          color: "var(--edge-ink-soft)",
        }}
      >
        Your agent lives at <span style={{ fontFamily: "monospace" }}>instaclaw.io</span>.
        Discovery + matchmaking by{" "}
        <a
          href="https://index.network"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--edge-olive)" }}
        >
          Index Network
        </a>
        . More features (Index match history, agent activity) ship before May 30.
      </footer>
    </div>
  );
}

/**
 * TrialIndicator — small "trial ends X · manage" line shown on the
 * dashboard for users on an active Stripe trial.
 *
 * For Edge attendees this surfaces the June 30 trial end date so they
 * know exactly when their card will be charged. The Manage link opens
 * Stripe's billing portal where they can update their card or cancel
 * the subscription.
 *
 * Date formatting: "June 30" without year (the village context makes
 * the year unambiguous — no attendee is confused about whether we
 * mean June 30 next year). Falls back to ISO if Intl.DateTimeFormat
 * fails for any reason.
 */
function TrialIndicator({ trialEndsAt }: { trialEndsAt: string }) {
  const [opening, setOpening] = useState(false);

  // Format the trial end date in user-friendly form. "June 30" is
  // unambiguous within the Edge village context (May 30 – June 27);
  // including the year would feel over-engineered. Pacific time zone
  // explicitly because the trial_end timestamp is anchored to PT and
  // displaying it as the attendee's local time would create off-by-one
  // confusion for international attendees.
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "America/Los_Angeles",
    }).format(new Date(trialEndsAt));
  } catch {
    formatted = new Date(trialEndsAt).toISOString().slice(0, 10);
  }

  async function handleManage() {
    if (opening) return;
    setOpening(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      if (!res.ok) {
        setOpening(false);
        return;
      }
      const data = (await res.json()) as { url?: string };
      if (data.url) {
        window.location.href = data.url;
      } else {
        setOpening(false);
      }
    } catch {
      setOpening(false);
    }
  }

  return (
    <div
      style={{
        marginTop: "16px",
        fontSize: "12px",
        color: "var(--edge-ink-soft)",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px",
        letterSpacing: "0.02em",
      }}
    >
      <span>Sponsor-funded trial ends {formatted}.</span>
      <button
        type="button"
        onClick={handleManage}
        disabled={opening}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          color: "var(--edge-ink)",
          textDecoration: "underline",
          textUnderlineOffset: "3px",
          cursor: opening ? "wait" : "pointer",
          fontSize: "12px",
          letterSpacing: "0.02em",
          opacity: opening ? 0.6 : 1,
        }}
      >
        {opening ? "Opening…" : "Manage"}
      </button>
    </div>
  );
}
