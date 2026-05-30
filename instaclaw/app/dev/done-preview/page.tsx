"use client";

/**
 * Dev-only preview for /onboarding/done.
 *
 * Renders the client component directly with mocked props so the visual
 * design can be reviewed without needing a real pending_users row +
 * authenticated session.
 *
 * Visit /dev/done-preview?screen=<key>&channel=<key> to switch states.
 *
 *   screen=form|post-submit|expired
 *   channel=imessage|telegram|discord|slack|web
 *
 * NOT linked from anywhere in the app. Production-gated to a no-op
 * string. Mirrors the /dev/chatgpt-modal + /dev/provider-preview pattern.
 */

import { useEffect, useState } from "react";
import { OnboardingDoneClient } from "@/app/(onboarding)/onboarding/done/done-client";

type Screen = "form" | "post-submit" | "expired";
type Channel = "imessage" | "telegram" | "discord" | "slack" | "web";

export default function DonePreviewPage() {
  const [screen, setScreen] = useState<Screen>("form");
  const [channel, setChannel] = useState<Channel>("imessage");

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const url = new URL(window.location.href);
    const qsScreen = url.searchParams.get("screen") as Screen | null;
    const qsChannel = url.searchParams.get("channel") as Channel | null;
    if (qsScreen && ["form", "post-submit", "expired"].includes(qsScreen)) {
      setScreen(qsScreen);
    }
    if (
      qsChannel &&
      ["imessage", "telegram", "discord", "slack", "web"].includes(qsChannel)
    ) {
      setChannel(qsChannel);
    }
  }, []);

  if (process.env.NODE_ENV === "production") {
    return (
      <p style={{ padding: 24, fontFamily: "monospace" }}>
        /dev/done-preview is dev-only.
      </p>
    );
  }

  return (
    <div>
      <OnboardingDoneClient
        // 2026-05-30 — key={...} forces re-mount on screen/channel
        // change so OnboardingDoneClient's useState(initialState)
        // initializer runs again. Without key, switching from "form"
        // to "post-submit" via the case picker has no effect because
        // useState only seeds on mount.
        key={`${screen}-${channel}`}
        sessionId="00000000-0000-4000-8000-000000000001"
        initialState={screen}
        channel={channel}
        partner={null}
        suggestedName="Cooper"
        telegramBotUsername="myinstaclaw_bot"
        existingProfile={
          // For post-submit preview, fake an existingProfile so the
          // memory card has data to render. Without this, post-
          // submit shows no card (full-skip path).
          screen === "post-submit"
            ? {
                name: "Cooper",
                intended_use: "work",
                vibe: "wry-and-minimal",
              }
            : null
        }
      />
      {/* Case-picker overlay. Fixed bottom-left so it doesn't interfere
          with the rendered page above. Links rebuild the URL so the
          useEffect-driven case-from-url path picks up the new combo. */}
      <div
        style={{
          position: "fixed",
          bottom: 16,
          left: 16,
          background: "rgba(255,255,255,0.94)",
          padding: "10px 14px",
          borderRadius: 10,
          fontSize: 11,
          fontFamily: "monospace",
          boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
          zIndex: 9999,
          maxWidth: 320,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          dev preview — screen:{" "}
          <span style={{ color: "#DC6743" }}>{screen}</span> · channel:{" "}
          <span style={{ color: "#DC6743" }}>{channel}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ marginTop: 4, color: "#666" }}>screen:</div>
          {(["form", "post-submit", "expired"] as Screen[]).map((s) => (
            <a
              key={s}
              href={`/dev/done-preview?screen=${s}&channel=${channel}`}
              style={{
                color: s === screen ? "#DC6743" : "#333",
                textDecoration: "underline",
              }}
            >
              {s}
            </a>
          ))}
          <div style={{ marginTop: 4, color: "#666" }}>channel:</div>
          {(
            ["imessage", "telegram", "discord", "slack", "web"] as Channel[]
          ).map((c) => (
            <a
              key={c}
              href={`/dev/done-preview?screen=${screen}&channel=${c}`}
              style={{
                color: c === channel ? "#DC6743" : "#333",
                textDecoration: "underline",
              }}
            >
              {c}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
