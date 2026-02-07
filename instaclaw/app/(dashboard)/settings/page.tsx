"use client";

import { useState, useEffect } from "react";
import {
  Bot,
  Key,
  Cpu,
  MessageSquare,
  ExternalLink,
  Save,
  RotateCw,
  MessageCircle,
  Hash,
  Phone,
} from "lucide-react";
import { WorldIDSection } from "@/components/dashboard/world-id-section";

const MODEL_OPTIONS = [
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-5-20250820", label: "Claude Opus 4.5" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
];

interface VMStatus {
  status: string;
  vm?: {
    gatewayUrl: string;
    controlUiUrl: string;
    healthStatus: string;
    telegramBotUsername: string | null;
    model: string | null;
    apiMode: string | null;
    systemPrompt: string | null;
    channelsEnabled: string[];
    hasDiscord: boolean;
    hasBraveSearch: boolean;
  };
  billing?: {
    tier: string;
    tierName: string;
    apiMode: string;
  };
}

export default function SettingsPage() {
  const [vmStatus, setVmStatus] = useState<VMStatus | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [promptSuccess, setPromptSuccess] = useState(false);
  const [newApiKey, setNewApiKey] = useState("");
  const [rotatingKey, setRotatingKey] = useState(false);
  const [keySuccess, setKeySuccess] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [modelSuccess, setModelSuccess] = useState(false);
  const [discordToken, setDiscordToken] = useState("");
  const [savingDiscord, setSavingDiscord] = useState(false);
  const [discordSuccess, setDiscordSuccess] = useState(false);
  const [slackToken, setSlackToken] = useState("");
  const [savingSlack, setSavingSlack] = useState(false);
  const [slackSuccess, setSlackSuccess] = useState(false);
  const [whatsappToken, setWhatsappToken] = useState("");
  const [savingWhatsapp, setSavingWhatsapp] = useState(false);
  const [whatsappSuccess, setWhatsappSuccess] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/vm/status")
      .then((r) => r.json())
      .then((data) => {
        setVmStatus(data);
        if (data.vm?.systemPrompt) {
          setSystemPrompt(data.vm.systemPrompt);
        }
      })
      .catch(() => {});
  }, []);

  async function handleSavePrompt() {
    setSavingPrompt(true);
    setError("");
    setPromptSuccess(false);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_system_prompt",
          systemPrompt,
        }),
      });
      if (res.ok) {
        setPromptSuccess(true);
        setTimeout(() => setPromptSuccess(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to save");
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingPrompt(false);
    }
  }

  async function handleRotateKey() {
    if (!newApiKey.trim()) return;
    setRotatingKey(true);
    setError("");
    setKeySuccess(false);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rotate_api_key",
          apiKey: newApiKey.trim(),
        }),
      });
      if (res.ok) {
        setKeySuccess(true);
        setNewApiKey("");
        setTimeout(() => setKeySuccess(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to rotate key");
      }
    } catch {
      setError("Network error");
    } finally {
      setRotatingKey(false);
    }
  }

  async function handleModelChange(newModel: string) {
    setUpdatingModel(true);
    setModelSuccess(false);
    try {
      const res = await fetch("/api/vm/update-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newModel }),
      });
      if (res.ok) {
        setModelSuccess(true);
        setTimeout(() => setModelSuccess(false), 3000);
        // Refresh status
        const statusRes = await fetch("/api/vm/status");
        const data = await statusRes.json();
        setVmStatus(data);
      }
    } finally {
      setUpdatingModel(false);
    }
  }

  async function handleUpdateDiscord() {
    if (!discordToken.trim()) return;
    setSavingDiscord(true);
    setError("");
    setDiscordSuccess(false);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_discord_token",
          discordToken: discordToken.trim(),
        }),
      });
      if (res.ok) {
        setDiscordSuccess(true);
        setDiscordToken("");
        setTimeout(() => setDiscordSuccess(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to update Discord token");
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingDiscord(false);
    }
  }

  async function handleUpdateSlack() {
    if (!slackToken.trim()) return;
    setSavingSlack(true);
    setError("");
    setSlackSuccess(false);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_slack_token",
          slackToken: slackToken.trim(),
        }),
      });
      if (res.ok) {
        setSlackSuccess(true);
        setSlackToken("");
        setTimeout(() => setSlackSuccess(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to update Slack token");
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingSlack(false);
    }
  }

  async function handleUpdateWhatsapp() {
    if (!whatsappToken.trim()) return;
    setSavingWhatsapp(true);
    setError("");
    setWhatsappSuccess(false);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_whatsapp_token",
          whatsappToken: whatsappToken.trim(),
        }),
      });
      if (res.ok) {
        setWhatsappSuccess(true);
        setWhatsappToken("");
        setTimeout(() => setWhatsappSuccess(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to update WhatsApp token");
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingWhatsapp(false);
    }
  }

  const vm = vmStatus?.vm;
  const billing = vmStatus?.billing;

  if (!vm) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
            Configure your OpenClaw instance.
          </p>
        </div>
        <div className="glass rounded-xl p-8 text-center">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {vmStatus === null
              ? "Loading..."
              : "Deploy an instance first to access settings."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Configure your OpenClaw instance.
        </p>
      </div>

      {error && (
        <p className="text-sm" style={{ color: "var(--error)" }}>
          {error}
        </p>
      )}

      {/* Bot Info (read-only) */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Bot className="w-5 h-5" /> Bot Info
        </h2>
        <div className="glass rounded-xl p-5 space-y-3" style={{ border: "1px solid var(--border)" }}>
          <div className="flex justify-between items-center">
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Bot Username
            </span>
            <span className="text-sm font-mono">
              {vm.telegramBotUsername ? `@${vm.telegramBotUsername}` : "—"}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Instance
            </span>
            <span className="text-sm font-mono" style={{ color: "var(--muted)" }}>
              {vm.gatewayUrl || "—"}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Plan
            </span>
            <span className="text-sm">
              {billing?.tierName ?? "—"}{" "}
              <span style={{ color: "var(--muted)" }}>
                ({vm.apiMode === "byok" ? "BYOK" : "All-Inclusive"})
              </span>
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Channels
            </span>
            <span className="text-sm capitalize">
              {vm.channelsEnabled?.join(", ") ?? "telegram"}
            </span>
          </div>
        </div>
      </div>

      {/* World ID Verification */}
      <WorldIDSection />

      {/* Channel Token Management */}
      {vm.channelsEnabled?.includes("discord") && (
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <MessageCircle className="w-5 h-5" /> Discord Token
            {discordSuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Updated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-5 space-y-3" style={{ border: "1px solid var(--border)" }}>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="New Discord bot token..."
                value={discordToken}
                onChange={(e) => setDiscordToken(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono outline-none"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <button
                onClick={handleUpdateDiscord}
                disabled={savingDiscord || !discordToken.trim()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              >
                <Save className="w-3 h-3" />
                {savingDiscord ? "Saving..." : "Save"}
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Update your Discord bot token. The new token will take effect immediately.
            </p>
          </div>
        </div>
      )}

      {vm.channelsEnabled?.includes("slack") && (
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Hash className="w-5 h-5" /> Slack Token
            {slackSuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Updated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-5 space-y-3" style={{ border: "1px solid var(--border)" }}>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="New Slack bot token (xoxb-...)..."
                value={slackToken}
                onChange={(e) => setSlackToken(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono outline-none"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <button
                onClick={handleUpdateSlack}
                disabled={savingSlack || !slackToken.trim()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              >
                <Save className="w-3 h-3" />
                {savingSlack ? "Saving..." : "Save"}
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Update your Slack Bot User OAuth Token. The new token will take effect immediately.
            </p>
          </div>
        </div>
      )}

      {vm.channelsEnabled?.includes("whatsapp") && (
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Phone className="w-5 h-5" /> WhatsApp Token
            {whatsappSuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Updated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-5 space-y-3" style={{ border: "1px solid var(--border)" }}>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="New WhatsApp access token..."
                value={whatsappToken}
                onChange={(e) => setWhatsappToken(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono outline-none"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <button
                onClick={handleUpdateWhatsapp}
                disabled={savingWhatsapp || !whatsappToken.trim()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              >
                <Save className="w-3 h-3" />
                {savingWhatsapp ? "Saving..." : "Save"}
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Update your WhatsApp access token. The new token will take effect immediately.
            </p>
          </div>
        </div>
      )}

      {/* Model Selector (all-inclusive only) */}
      {vm.apiMode === "all_inclusive" && (
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Cpu className="w-5 h-5" /> Default Model
            {modelSuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Updated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-5" style={{ border: "1px solid var(--border)" }}>
            <select
              value={vm.model ?? "claude-sonnet-4-5-20250929"}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={updatingModel}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none cursor-pointer disabled:opacity-50"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                color: "var(--foreground)",
              }}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
              {updatingModel ? "Updating..." : "The Claude model your bot uses for responses."}
            </p>
          </div>
        </div>
      )}

      {/* System Prompt / Bot Personality */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <MessageSquare className="w-5 h-5" /> Bot Personality
          {promptSuccess && (
            <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
              Saved
            </span>
          )}
        </h2>
        <div className="glass rounded-xl p-5 space-y-3" style={{ border: "1px solid var(--border)" }}>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            maxLength={2000}
            rows={6}
            placeholder="Enter a custom system prompt for your bot... (leave empty for OpenClaw's default)"
            className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-y"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
              minHeight: 120,
            }}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {systemPrompt.length}/2000 characters
            </p>
            <button
              onClick={handleSavePrompt}
              disabled={savingPrompt}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors"
              style={{
                background: "#ffffff",
                color: "#000000",
              }}
            >
              <Save className="w-3 h-3" />
              {savingPrompt ? "Saving..." : "Save Prompt"}
            </button>
          </div>
        </div>
      </div>

      {/* API Key Rotation (BYOK only) */}
      {vm.apiMode === "byok" && (
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Key className="w-5 h-5" /> API Key
            {keySuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Rotated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-5 space-y-3" style={{ border: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                Current key:
              </span>
              <span className="text-sm font-mono" style={{ color: "var(--muted)" }}>
                sk-ant-••••••••••••
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="New Anthropic API key"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono outline-none"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <button
                onClick={handleRotateKey}
                disabled={rotatingKey || !newApiKey.trim()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              >
                <RotateCw className={`w-3 h-3 ${rotatingKey ? "animate-spin" : ""}`} />
                {rotatingKey ? "Rotating..." : "Rotate"}
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Your key is encrypted and stored securely.
            </p>
          </div>
        </div>
      )}

      {/* Danger Zone */}
      <div>
        <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--error)" }}>
          Danger Zone
        </h2>
        <div
          className="glass rounded-xl p-5"
          style={{ border: "1px solid rgba(239,68,68,0.3)" }}
        >
          <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
            Cancel your subscription or manage payment methods through Stripe.
          </p>
          <a
            href="/billing"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: "rgba(239,68,68,0.1)",
              color: "#ef4444",
              border: "1px solid rgba(239,68,68,0.3)",
            }}
          >
            <ExternalLink className="w-3 h-3" />
            Manage Subscription
          </a>
        </div>
      </div>
    </div>
  );
}
