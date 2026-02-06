"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

export default function ConnectPage() {
  const router = useRouter();
  const [botToken, setBotToken] = useState("");
  const [apiMode, setApiMode] = useState<"all_inclusive" | "byok">(
    "all_inclusive"
  );
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");

  function handleContinue() {
    setError("");

    if (!TOKEN_RE.test(botToken.trim())) {
      setError("Invalid bot token format. It should look like 123456789:ABC...");
      return;
    }

    if (apiMode === "byok" && !apiKey.trim()) {
      setError("Please enter your Anthropic API key.");
      return;
    }

    // Store in sessionStorage for the plan page
    sessionStorage.setItem(
      "instaclaw_onboarding",
      JSON.stringify({
        botToken: botToken.trim(),
        apiMode,
        apiKey: apiMode === "byok" ? apiKey.trim() : undefined,
      })
    );

    router.push("/plan");
  }

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Connect Your Bot</h1>
        <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
          Set up your Telegram bot and choose your API mode.
        </p>
      </div>

      {/* Telegram Bot Token */}
      <div className="space-y-3">
        <label className="block text-sm font-medium">Telegram Bot Token</label>
        <div
          className="glass rounded-lg p-4 text-xs space-y-2"
          style={{ color: "var(--muted)" }}
        >
          <p>1. Open Telegram and message @BotFather</p>
          <p>2. Send /newbot and follow the prompts</p>
          <p>3. Copy the bot token and paste it below</p>
        </div>
        <input
          type="text"
          placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          className="w-full px-4 py-3 rounded-lg text-sm font-mono outline-none"
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
          }}
        />
      </div>

      {/* API Mode */}
      <div className="space-y-3">
        <label className="block text-sm font-medium">API Mode</label>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setApiMode("all_inclusive")}
            className="glass rounded-lg p-4 text-left transition-all cursor-pointer"
            style={{
              border:
                apiMode === "all_inclusive"
                  ? "1px solid #ffffff"
                  : "1px solid var(--border)",
            }}
          >
            <p className="text-sm font-semibold">All-Inclusive</p>
            <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
              We handle everything. Recommended.
            </p>
          </button>
          <button
            type="button"
            onClick={() => setApiMode("byok")}
            className="glass rounded-lg p-4 text-left transition-all cursor-pointer"
            style={{
              border:
                apiMode === "byok"
                  ? "1px solid #ffffff"
                  : "1px solid var(--border)",
            }}
          >
            <p className="text-sm font-semibold">BYOK</p>
            <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
              Bring your own Anthropic key. Save more.
            </p>
          </button>
        </div>
      </div>

      {/* BYOK API Key */}
      {apiMode === "byok" && (
        <div className="space-y-3">
          <label className="block text-sm font-medium">
            Anthropic API Key
          </label>
          <input
            type="password"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-4 py-3 rounded-lg text-sm font-mono outline-none"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          />
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Your key is encrypted and only used on your dedicated VM.
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm" style={{ color: "var(--error)" }}>
          {error}
        </p>
      )}

      <button
        onClick={handleContinue}
        className="w-full px-6 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]"
        style={{ background: "#ffffff", color: "#000000" }}
      >
        Continue to Plan Selection
      </button>
    </div>
  );
}
