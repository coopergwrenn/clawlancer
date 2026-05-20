"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { ArrowLeft, ExternalLink, Save, Eye, EyeOff, Check, Loader2 } from "lucide-react";
import { IntentForm } from "./intent-form";

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
}: {
  userId: string;
  userName: string | null;
  initialOverlay: OverlayShape;
  initialRendered: RenderedShape;
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
      </section>

      {/* ─── Intent submission form (#3) ────────────────────────────── */}
      {/*
        Placed BEFORE the spectator view because submitting an intent is
        the primary action that makes things happen IN the village (other
        attendees' agents discover the overlap → matchpool_outcomes row →
        encounter renders). Settings (nickname, visibility) are secondary.
      */}
      <section style={{ marginBottom: "40px" }}>
        <IntentForm />
      </section>

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
