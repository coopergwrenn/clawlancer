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
  CreditCard,
  Store,
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
    agdpEnabled: boolean;
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
  const [agdpEnabled, setAgdpEnabled] = useState(false);
  const [togglingAgdp, setTogglingAgdp] = useState(false);
  const [agdpConfirm, setAgdpConfirm] = useState<"enable" | "disable" | null>(null);
  const [agdpSuccess, setAgdpSuccess] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/vm/status")
      .then((r) => r.json())
      .then((data) => {
        setVmStatus(data);
        if (data.vm?.systemPrompt) {
          setSystemPrompt(data.vm.systemPrompt);
        }
        if (data.vm?.agdpEnabled != null) {
          setAgdpEnabled(data.vm.agdpEnabled);
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

  async function handleToggleAgdp(enabled: boolean) {
    setTogglingAgdp(true);
    setError("");
    setAgdpConfirm(null);
    setAgdpSuccess(false);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle_agdp", enabled }),
      });
      if (res.ok) {
        setAgdpEnabled(enabled);
        setAgdpSuccess(true);
        setTimeout(() => setAgdpSuccess(false), 3000);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to toggle aGDP");
      }
    } catch {
      setError("Network error");
    } finally {
      setTogglingAgdp(false);
    }
  }

  const vm = vmStatus?.vm;
  const billing = vmStatus?.billing;

  if (!vm) {
    return (
      <div className="space-y-10">
        <div>
          <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>Settings</h1>
          <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
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

  async function openBillingPortal() {
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setError("Failed to open billing portal");
    }
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>Settings</h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Configure your OpenClaw instance.
        </p>
      </div>

      {/* Current Plan Section */}
      {vmStatus?.billing && (
        <div className="glass rounded-xl p-6 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <CreditCard className="w-5 h-5" style={{ color: "var(--muted)" }} />
                <h2 className="text-base font-medium">Current Plan</h2>
              </div>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {vmStatus.billing.tierName} • {vmStatus.billing.apiMode === "byok" ? "BYOK" : "All-Inclusive"}
              </p>
            </div>
            <button
              onClick={openBillingPortal}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:shadow-[0_0_20px_rgba(255,255,255,0.15)] flex items-center gap-2"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
              }}
            >
              <ExternalLink className="w-4 h-4" />
              Manage Plan
            </button>
          </div>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Change your plan, update payment methods, or view invoices in the Stripe billing portal.
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm" style={{ color: "var(--error)" }}>
          {error}
        </p>
      )}

      {/* Marketplace Integrations */}
      <div>
        <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
          <Store className="w-5 h-5" /> Marketplace Integrations
          {agdpSuccess && (
            <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
              {agdpEnabled ? "Enabled" : "Disabled"}
            </span>
          )}
        </h2>
        <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between">
            <div className="flex-1 mr-4">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-medium">aGDP Marketplace</h3>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{
                    background: "rgba(168,85,247,0.15)",
                    color: "rgb(168,85,247)",
                  }}
                >
                  Beta
                </span>
              </div>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Connect to the Virtuals Protocol Agent Commerce marketplace as a secondary bounty source.
                Clawlancer remains your primary marketplace.
              </p>
            </div>
            <button
              onClick={() => {
                if (togglingAgdp) return;
                setAgdpConfirm(agdpEnabled ? "disable" : "enable");
              }}
              disabled={togglingAgdp}
              className="relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 cursor-pointer disabled:opacity-50"
              style={{
                background: agdpEnabled ? "rgb(168,85,247)" : "var(--border)",
              }}
              aria-label={agdpEnabled ? "Disable aGDP" : "Enable aGDP"}
            >
              <span
                className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform duration-200"
                style={{
                  background: "#fff",
                  transform: agdpEnabled ? "translateX(20px)" : "translateX(0)",
                }}
              />
            </button>
          </div>

          {togglingAgdp && (
            <div className="mt-4 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
              <RotateCw className="w-3 h-3 animate-spin" />
              {agdpEnabled ? "Disabling" : "Enabling"} aGDP... This may take a moment while we configure your VM.
            </div>
          )}

          {/* Confirmation dialog */}
          {agdpConfirm && (
            <div
              className="mt-4 rounded-lg p-4"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
              }}
            >
              <p className="text-sm mb-3">
                {agdpConfirm === "enable"
                  ? "Enable aGDP? This will install the Virtuals Protocol Agent Commerce skill on your VM. Clawlancer will remain your primary marketplace."
                  : "Disable aGDP? This will remove the Agent Commerce skill from your VM."}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleToggleAgdp(agdpConfirm === "enable")}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    background: agdpConfirm === "enable" ? "rgb(168,85,247)" : "rgba(239,68,68,0.1)",
                    color: agdpConfirm === "enable" ? "#fff" : "#ef4444",
                    border: agdpConfirm === "enable" ? "none" : "1px solid rgba(239,68,68,0.3)",
                  }}
                >
                  {agdpConfirm === "enable" ? "Enable" : "Disable"}
                </button>
                <button
                  onClick={() => setAgdpConfirm(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bot Info (read-only) */}
      <div>
        <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
          <Bot className="w-5 h-5" /> Bot Info
        </h2>
        <div className="glass rounded-xl p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
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
          <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
            <MessageCircle className="w-5 h-5" /> Discord Token
            {discordSuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Updated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
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
          <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
            <Hash className="w-5 h-5" /> Slack Token
            {slackSuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Updated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
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
          <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
            <Phone className="w-5 h-5" /> WhatsApp Token
            {whatsappSuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Updated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
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
          <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
            <Cpu className="w-5 h-5" /> Default Model
            {modelSuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Updated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
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
        <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
          <MessageSquare className="w-5 h-5" /> Bot Personality
          {promptSuccess && (
            <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
              Saved
            </span>
          )}
        </h2>
        <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>
          <strong>This is optional.</strong> You don&apos;t even have to do this to begin with. Honestly, it&apos;s best to just chat with your bot and tell it how you want it to be. It will learn. Every day it will learn and get better and better.
        </p>
        <div className="glass rounded-xl p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
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
          <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
            <Key className="w-5 h-5" /> API Key
            {keySuccess && (
              <span className="text-xs ml-auto font-normal" style={{ color: "var(--success)" }}>
                Rotated
              </span>
            )}
          </h2>
          <div className="glass rounded-xl p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
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
        <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5" style={{ fontFamily: "var(--font-serif)", color: "var(--error)" }}>
          Danger Zone
        </h2>
        <div
          className="glass rounded-xl p-6"
          style={{ border: "1px solid rgba(220,38,38,0.2)" }}
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
