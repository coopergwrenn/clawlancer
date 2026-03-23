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
  Mail,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Camera,
  Unlink,
} from "lucide-react";
import { WorldIDSection } from "@/components/dashboard/world-id-section";
import { BrowserExtensionSection } from "@/components/dashboard/browser-extension-section";
import { ConnectWorldWallet } from "@/components/dashboard/connect-world-wallet";

const MODEL_OPTIONS = [
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
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
    gmailConnected: boolean;
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
  const [telegramToken, setTelegramToken] = useState("");
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [telegramSuccess, setTelegramSuccess] = useState(false);
  const [telegramError, setTelegramError] = useState("");
  const [telegramWarning, setTelegramWarning] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [savingDiscord, setSavingDiscord] = useState(false);
  const [discordSuccess, setDiscordSuccess] = useState(false);
  const [discordError, setDiscordError] = useState("");
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
  const [gmailConnected, setGmailConnected] = useState(false);
  const [disconnectingGmail, setDisconnectingGmail] = useState(false);
  const [error, setError] = useState("");

  // Instagram integration state
  const [igConnected, setIgConnected] = useState(false);
  const [igUsername, setIgUsername] = useState<string | null>(null);
  const [igTokenExpiry, setIgTokenExpiry] = useState<string | null>(null);
  const [igStatus, setIgStatus] = useState<string | null>(null);
  const [igLoading, setIgLoading] = useState(true);
  const [igDisconnecting, setIgDisconnecting] = useState(false);
  const [igMessage, setIgMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

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
        if (data.vm?.gmailConnected != null) {
          setGmailConnected(data.vm.gmailConnected);
        }
      })
      .catch(() => {});
  }, []);

  // Smooth-scroll to hash target (e.g. #human-verification from dashboard banner).
  // The target element may render asynchronously after an API fetch, so we poll
  // until it appears in the DOM rather than relying on a fixed timeout.
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (!hash) return;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const el = document.getElementById(hash);
      if (el) {
        clearInterval(interval);
        // Small extra delay so layout fully settles
        setTimeout(() => {
          const y = el.getBoundingClientRect().top + window.scrollY - 20;
          window.scrollTo({ top: y, behavior: "smooth" });
        }, 100);
      }
      if (attempts > 30) clearInterval(interval); // give up after 6s
    }, 200);
    return () => clearInterval(interval);
  }, []);

  // Fetch Instagram connection status on mount
  useEffect(() => {
    fetch("/api/instagram/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.connected) {
          setIgConnected(true);
          setIgUsername(data.username ?? null);
          setIgTokenExpiry(data.token_expires_at ?? null);
          setIgStatus(data.status ?? "active");
        }
      })
      .catch(() => {})
      .finally(() => setIgLoading(false));
  }, []);

  // Handle OAuth callback redirect params (?ig_connected=true or ?ig_error=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("ig_connected") === "true") {
      setIgMessage({ type: "success", text: "Instagram connected successfully!" });
      setIgConnected(true);
      // Refetch to get username
      fetch("/api/instagram/status")
        .then((r) => r.json())
        .then((data) => {
          if (data.connected) {
            setIgUsername(data.username ?? null);
            setIgTokenExpiry(data.token_expires_at ?? null);
            setIgStatus(data.status ?? "active");
          }
        })
        .catch(() => {});
      // Clean URL
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(() => setIgMessage(null), 5000);
    }
    const igError = params.get("ig_error");
    if (igError) {
      const errorMessages: Record<string, string> = {
        denied: "You declined the Instagram permissions.",
        unauthorized: "Please log in first.",
        no_code: "No authorization code received from Instagram.",
        state_mismatch: "Security check failed. Please try again.",
        token_exchange: "Failed to exchange token with Instagram.",
        long_lived_token: "Failed to get a long-lived token.",
        save_failed: "Failed to save the connection. Please try again.",
        unknown: "Something went wrong. Please try again.",
      };
      setIgMessage({ type: "error", text: errorMessages[igError] ?? errorMessages.unknown });
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(() => setIgMessage(null), 8000);
    }
  }, []);

  async function handleDisconnectInstagram() {
    setIgDisconnecting(true);
    try {
      const res = await fetch("/api/instagram/disconnect", { method: "POST" });
      if (res.ok) {
        setIgConnected(false);
        setIgUsername(null);
        setIgTokenExpiry(null);
        setIgStatus(null);
        setIgMessage({ type: "success", text: "Instagram disconnected." });
        setTimeout(() => setIgMessage(null), 3000);
      } else {
        const data = await res.json();
        setIgMessage({ type: "error", text: data.error || "Failed to disconnect." });
        setTimeout(() => setIgMessage(null), 5000);
      }
    } catch {
      setIgMessage({ type: "error", text: "Network error." });
      setTimeout(() => setIgMessage(null), 5000);
    } finally {
      setIgDisconnecting(false);
    }
  }

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

  async function handleUpdateTelegram() {
    if (!telegramToken.trim()) return;
    setSavingTelegram(true);
    setError("");
    setTelegramError("");
    setTelegramWarning("");
    setTelegramSuccess(false);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_telegram_token",
          telegramToken: telegramToken.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setTelegramSuccess(true);
        setTelegramToken("");
        if (data.sshFailed && data.message) {
          setTelegramWarning(data.message);
        }
        // Refresh status to pick up new bot username
        const statusRes = await fetch("/api/vm/status");
        const statusData = await statusRes.json();
        setVmStatus(statusData);
      } else {
        setTelegramError(data.error || "Failed to update Telegram token");
      }
    } catch {
      setTelegramError("Network error — please check your connection and try again.");
    } finally {
      setSavingTelegram(false);
    }
  }

  async function handleUpdateDiscord() {
    if (!discordToken.trim()) return;
    setSavingDiscord(true);
    setDiscordError("");
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
      const data = await res.json();
      if (res.ok) {
        setDiscordSuccess(true);
        setDiscordToken("");
        setTimeout(() => setDiscordSuccess(false), 5000);
      } else {
        setDiscordError(data.error || "Failed to update Discord token");
        setTimeout(() => setDiscordError(""), 8000);
      }
    } catch {
      setDiscordError("Network error — please check your connection and try again.");
      setTimeout(() => setDiscordError(""), 8000);
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
        setError(data.error || "Failed to toggle Virtuals Protocol");
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
    <div className="space-y-10" data-tour="page-settings">
      <div>
        <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>Settings</h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Configure your OpenClaw instance.
        </p>
      </div>

      {/* Current Plan Section */}
      {vmStatus?.billing && (
        <div data-tour="settings-plan" className="glass rounded-xl p-6 space-y-4">
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
              className="px-5 py-2.5 rounded-full text-sm font-semibold transition-all active:scale-95 cursor-pointer flex items-center gap-2"
              style={{
                background: "linear-gradient(135deg, rgba(255,255,255,0.92), rgba(240,240,240,0.88))",
                color: "#000000",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.6)",
                backdropFilter: "blur(8px)",
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
        {/* Clawlancer — primary, always on */}
        <div className="glass rounded-xl p-6 mb-4" style={{ border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between">
            <div className="flex-1 mr-4">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-medium">Clawlancer</h3>
                <span
                  className="text-[10px] px-2.5 py-1 rounded-full font-semibold"
                  style={{
                    background: "linear-gradient(135deg, rgba(34,197,94,0.25), rgba(22,163,74,0.18))",
                    color: "rgb(34,197,94)",
                    boxShadow: "0 0 0 1px rgba(34,197,94,0.25), 0 2px 6px rgba(34,197,94,0.12), inset 0 1px 0 rgba(255,255,255,0.15)",
                    backdropFilter: "blur(8px)",
                    textShadow: "0 1px 2px rgba(0,0,0,0.06)",
                  }}
                >
                  Primary
                </span>
              </div>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Your primary marketplace. Clawlancer bounties are always prioritized first.
              </p>
            </div>
            <div
              className="relative w-12 h-7 rounded-full shrink-0"
              style={{
                background: "linear-gradient(135deg, rgba(22,22,22,0.7), rgba(40,40,40,0.8))",
                boxShadow: "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.05)",
                backdropFilter: "blur(8px)",
                opacity: 0.6,
              }}
            >
              <span
                className="absolute top-1 w-5 h-5 rounded-full"
                style={{
                  left: "24px",
                  background: "linear-gradient(135deg, rgba(255,255,255,0.95), rgba(240,240,240,0.9))",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.5)",
                }}
              />
            </div>
          </div>
        </div>

        {/* Virtuals Protocol (ACP) — secondary, toggleable */}
        <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between">
            <div className="flex-1 mr-4">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-medium">Virtuals Protocol (ACP)</h3>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                  style={{
                    background: "linear-gradient(135deg, rgba(249,115,22,0.2), rgba(234,88,12,0.15))",
                    color: "rgb(249,115,22)",
                    boxShadow: "0 0 0 1px rgba(249,115,22,0.2), inset 0 1px 0 rgba(255,255,255,0.1)",
                    backdropFilter: "blur(6px)",
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
              className="relative w-12 h-7 rounded-full transition-all flex-shrink-0 cursor-pointer disabled:opacity-50"
              style={{
                background: agdpEnabled
                  ? "linear-gradient(135deg, rgba(22,22,22,0.7), rgba(40,40,40,0.8))"
                  : "rgba(0,0,0,0.08)",
                boxShadow: agdpEnabled
                  ? "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.05)"
                  : "0 0 0 1px rgba(0,0,0,0.08), inset 0 1px 2px rgba(0,0,0,0.06)",
                backdropFilter: "blur(8px)",
              }}
              aria-label={agdpEnabled ? "Disable Virtuals Protocol" : "Enable Virtuals Protocol"}
            >
              <span
                className="absolute top-1 w-5 h-5 rounded-full transition-all"
                style={{
                  left: agdpEnabled ? "24px" : "4px",
                  background: agdpEnabled
                    ? "linear-gradient(135deg, rgba(255,255,255,0.95), rgba(240,240,240,0.9))"
                    : "linear-gradient(135deg, rgba(255,255,255,0.85), rgba(230,230,230,0.8))",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.5)",
                  transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
                }}
              />
            </button>
          </div>

          {togglingAgdp && (
            <div className="mt-4 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
              <RotateCw className="w-3 h-3 animate-spin" />
              {agdpEnabled ? "Disabling" : "Enabling"} Virtuals Protocol... This may take a moment while we configure your VM.
            </div>
          )}

          {/* Confirmation dialog */}
          {agdpConfirm && (
            <div
              className="mt-4 rounded-2xl p-5"
              style={{
                background: "linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
                border: agdpConfirm === "enable"
                  ? "1px solid rgba(249,115,22,0.2)"
                  : "1px solid rgba(239,68,68,0.2)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.04)",
                backdropFilter: "blur(12px)",
              }}
            >
              <p className="text-sm font-medium mb-1">
                {agdpConfirm === "enable" ? "Enable Virtuals Protocol?" : "Disable Virtuals Protocol?"}
              </p>
              <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
                {agdpConfirm === "enable"
                  ? "This will install the Virtuals Protocol Agent Commerce skill on your VM. After enabling, message your bot to complete Virtuals authentication. Clawlancer remains your primary marketplace."
                  : "This will remove the Agent Commerce skill from your VM. Your agent will no longer accept jobs from the Virtuals marketplace."}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setAgdpConfirm(null)}
                  className="px-4 py-2 rounded-full text-xs font-medium transition-all active:scale-95 cursor-pointer"
                  style={{
                    background: "linear-gradient(135deg, rgba(255,255,255,0.92), rgba(240,240,240,0.88))",
                    color: "#000",
                    boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.6)",
                    backdropFilter: "blur(8px)",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleToggleAgdp(agdpConfirm === "enable")}
                  className="px-4 py-2 rounded-full text-xs font-semibold transition-all active:scale-95 cursor-pointer"
                  style={agdpConfirm === "enable" ? {
                    background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                    color: "#fff",
                    boxShadow: "0 0 0 1px rgba(249,115,22,0.3), 0 2px 8px rgba(249,115,22,0.25), inset 0 1px 0 rgba(255,255,255,0.2)",
                  } : {
                    background: "linear-gradient(135deg, rgba(239,68,68,0.85), rgba(220,38,38,0.95))",
                    color: "#fff",
                    boxShadow: "0 0 0 1px rgba(239,68,68,0.3), 0 2px 8px rgba(239,68,68,0.25), inset 0 1px 0 rgba(255,255,255,0.2)",
                  }}
                >
                  {agdpConfirm === "enable" ? "Enable" : "Disable"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bot Info (read-only) */}
      <div data-tour="settings-bot-info">
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

      {/* Browser Extension */}
      <BrowserExtensionSection gatewayUrl={vm.gatewayUrl} />

      {/* World ID Verification */}
      <WorldIDSection />

      {/* Connect World Wallet — for linking to World mini app */}
      <ConnectWorldWallet />

      {/* Gmail Connection */}
      <div data-tour="settings-gmail">
        <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
          <Mail className="w-5 h-5" /> Gmail Personalization
        </h2>
        <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between">
            <div className="flex-1 mr-4">
              <p className="text-sm font-medium mb-1">
                {gmailConnected ? "Gmail Connected" : "Gmail Not Connected"}
              </p>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                {gmailConnected
                  ? "Your agent has been personalized based on your inbox patterns."
                  : "Connect Gmail to let your agent learn about you from inbox patterns (metadata only, never full emails)."}
              </p>
            </div>
            {gmailConnected ? (
              <button
                onClick={async () => {
                  setDisconnectingGmail(true);
                  try {
                    const res = await fetch("/api/gmail/disconnect", { method: "POST" });
                    if (res.ok) {
                      setGmailConnected(false);
                    }
                  } finally {
                    setDisconnectingGmail(false);
                  }
                }}
                disabled={disconnectingGmail}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                style={{
                  background: "rgba(239,68,68,0.1)",
                  color: "#ef4444",
                  border: "1px solid rgba(239,68,68,0.3)",
                }}
              >
                {disconnectingGmail ? "Disconnecting..." : "Disconnect"}
              </button>
            ) : (
              <a
                href="/api/gmail/connect"
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                Connect
              </a>
            )}
          </div>
          {!gmailConnected && (
            <div
              className="rounded-lg p-3 mt-4 flex items-start gap-2.5"
              style={{
                background: "rgba(234,179,8,0.06)",
                border: "1px solid rgba(234,179,8,0.15)",
              }}
            >
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#ca8a04" }} />
              <div>
                <p className="text-xs leading-relaxed" style={{ color: "#78716c" }}>
                  Google will show an &quot;unverified app&quot; warning — this is normal while we
                  complete verification. Click{" "}
                  <strong style={{ color: "#92400e" }}>Advanced</strong> &rarr;{" "}
                  <strong style={{ color: "#92400e" }}>Go to instaclaw.io (unsafe)</strong> to
                  proceed. We only request read-only access.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Channel Token Management */}
      {/* Telegram Bot Token — always visible so new users can set up */}
      <div>
        <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
          <Bot className="w-5 h-5" /> Telegram Bot Token
        </h2>
        <div className="glass rounded-xl p-4 sm:p-6 space-y-3" style={{ border: telegramError ? "1px solid rgba(239,68,68,0.4)" : telegramSuccess ? "1px solid rgba(34,197,94,0.4)" : "1px solid var(--border)", transition: "border-color 0.3s ease" }}>
          {vm.telegramBotUsername && (
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                Current bot:
              </span>
              <span className="text-sm font-mono truncate">
                @{vm.telegramBotUsername}
              </span>
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="password"
              placeholder={vm.telegramBotUsername ? "New Telegram bot token..." : "Paste your Telegram bot token from @BotFather..."}
              value={telegramToken}
              onChange={(e) => {
                setTelegramToken(e.target.value);
                if (telegramError) setTelegramError("");
                if (telegramSuccess) setTelegramSuccess(false);
                if (telegramWarning) setTelegramWarning("");
              }}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-mono outline-none min-w-0"
              style={{
                background: "var(--card)",
                border: telegramError ? "1px solid rgba(239,68,68,0.4)" : "1px solid var(--border)",
                color: "var(--foreground)",
              }}
            />
            <button
              onClick={handleUpdateTelegram}
              disabled={savingTelegram || !telegramToken.trim()}
              className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-full text-xs font-semibold cursor-pointer disabled:opacity-50 transition-all active:scale-95 shrink-0"
              style={{
                background: savingTelegram
                  ? "rgba(0,0,0,0.06)"
                  : "linear-gradient(135deg, rgba(255,255,255,0.92), rgba(240,240,240,0.88))",
                color: "#000000",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.6)",
                backdropFilter: "blur(8px)",
              }}
            >
              {savingTelegram ? (
                <RotateCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              {savingTelegram ? "Saving..." : "Save"}
            </button>
          </div>

          {/* Inline feedback — always visible, never at top of page */}
          {telegramSuccess && (
            <div
              className="flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium"
              style={{
                background: "rgba(34,197,94,0.1)",
                border: "1px solid rgba(34,197,94,0.3)",
                color: "rgb(22,163,74)",
              }}
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>Token saved successfully!{vm.telegramBotUsername ? ` Bot: @${vm.telegramBotUsername}` : ""}</span>
            </div>
          )}
          {telegramWarning && (
            <div
              className="flex items-start gap-2.5 px-4 py-3 rounded-xl text-sm leading-relaxed"
              style={{
                background: "rgba(234,179,8,0.1)",
                border: "1px solid rgba(234,179,8,0.3)",
                color: "rgb(161,98,7)",
              }}
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{telegramWarning}</span>
            </div>
          )}
          {telegramError && (
            <div
              className="flex items-start gap-2.5 px-4 py-3 rounded-xl text-sm font-medium leading-relaxed"
              style={{
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                color: "rgb(220,38,38)",
              }}
            >
              <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{telegramError}</span>
            </div>
          )}

          {!telegramSuccess && !telegramError && !telegramWarning && (
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {vm.telegramBotUsername
                ? "Update your Telegram bot token. The gateway will restart with the new token immediately."
                : "Paste the token from @BotFather to connect your Telegram bot. Your bot will start responding to messages immediately."}
            </p>
          )}
        </div>
      </div>

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
          <div className="glass rounded-xl p-4 sm:p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="password"
                placeholder="New Discord bot token..."
                value={discordToken}
                onChange={(e) => setDiscordToken(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono outline-none min-w-0"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <button
                onClick={handleUpdateDiscord}
                disabled={savingDiscord || !discordToken.trim()}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors shrink-0"
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
          <div className="glass rounded-xl p-4 sm:p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="password"
                placeholder="New Slack bot token (xoxb-...)..."
                value={slackToken}
                onChange={(e) => setSlackToken(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono outline-none min-w-0"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <button
                onClick={handleUpdateSlack}
                disabled={savingSlack || !slackToken.trim()}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors shrink-0"
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
          <div className="glass rounded-xl p-4 sm:p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="password"
                placeholder="New WhatsApp access token..."
                value={whatsappToken}
                onChange={(e) => setWhatsappToken(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono outline-none min-w-0"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <button
                onClick={handleUpdateWhatsapp}
                disabled={savingWhatsapp || !whatsappToken.trim()}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors shrink-0"
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
              value={vm.model ?? "claude-sonnet-4-6"}
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
          <div className="glass rounded-xl p-4 sm:p-6 space-y-3" style={{ border: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                Current key:
              </span>
              <span className="text-sm font-mono truncate" style={{ color: "var(--muted)" }}>
                sk-ant-••••••••••••
              </span>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="password"
                placeholder="New Anthropic API key"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-mono outline-none min-w-0"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <button
                onClick={handleRotateKey}
                disabled={rotatingKey || !newApiKey.trim()}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors shrink-0"
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

      {/* Instagram Automation */}
      <div>
        <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
          <Camera className="w-5 h-5" /> Instagram Automation
          {igMessage && (
            <span
              className="text-xs ml-auto font-normal"
              style={{ color: igMessage.type === "success" ? "var(--success)" : "var(--error)" }}
            >
              {igMessage.text}
            </span>
          )}
        </h2>
        <div className="glass rounded-xl p-4 sm:p-6 space-y-4" style={{ border: "1px solid var(--border)" }}>
          {igLoading ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>Loading...</p>
          ) : igConnected ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" style={{ color: "var(--success)" }} />
                  <span className="text-sm font-medium">
                    Connected{igUsername ? ` as @${igUsername}` : ""}
                  </span>
                </div>
                <button
                  onClick={handleDisconnectInstagram}
                  disabled={igDisconnecting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 transition-colors"
                  style={{
                    background: "rgba(239,68,68,0.1)",
                    color: "#ef4444",
                    border: "1px solid rgba(239,68,68,0.3)",
                  }}
                >
                  <Unlink className="w-3 h-3" />
                  {igDisconnecting ? "Disconnecting..." : "Disconnect"}
                </button>
              </div>
              {igStatus === "token_expired" && (
                <div className="flex items-center gap-2 text-xs p-2 rounded-lg" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>
                  <AlertTriangle className="w-3 h-3" />
                  Token expired. Please reconnect to restore Instagram automation.
                </div>
              )}
              <div className="space-y-2">
                {igTokenExpiry && (
                  <div className="flex justify-between text-xs" style={{ color: "var(--muted)" }}>
                    <span>Token expires</span>
                    <span>{new Date(igTokenExpiry).toLocaleDateString()}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs" style={{ color: "var(--muted)" }}>
                  <span>DM rate limit</span>
                  <span>200/hr (Meta enforced)</span>
                </div>
              </div>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Your agent can now reply to Instagram DMs, comments, and story replies. Tell your bot to &quot;check my Instagram DMs&quot; or set up keyword triggers in the Social Command Center.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Connect your Instagram Business or Creator account to let your agent reply to DMs, comments, and story replies automatically.
              </p>
              <a
                href="/api/auth/instagram"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer"
                style={{
                  background: "linear-gradient(135deg, #833AB4, #C13584, #E1306C, #F77737)",
                  color: "#fff",
                  boxShadow: "0 2px 8px rgba(131,58,180,0.3)",
                }}
              >
                <Camera className="w-4 h-4" />
                Connect Instagram
              </a>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Requires an Instagram Business or Creator account.{" "}
                <a
                  href="https://help.instagram.com/502981923235522"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  style={{ color: "var(--muted)" }}
                >
                  How to switch
                </a>
              </p>
            </>
          )}
        </div>
      </div>

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
