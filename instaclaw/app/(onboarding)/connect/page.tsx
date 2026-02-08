"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

const FAQ_ITEMS = [
  {
    q: "What is a Telegram bot?",
    a: "It's your personal AI assistant that lives inside Telegram. You message it like a friend and it responds using AI — but unlike ChatGPT, it can actually run code, search the web, manage files, and take actions on your behalf.",
  },
  {
    q: "Is creating the bot free?",
    a: "Yes. The bot itself is free on Telegram. InstaClaw hosts and powers it with a dedicated server and AI model.",
  },
  {
    q: "Can I change the bot's name later?",
    a: "Yes — message @BotFather and use /setname or /setusername anytime.",
  },
  {
    q: "What can my bot do?",
    a: "Shell commands, file management, web search, code execution, Python scripts, and more. It's a real AI agent on a dedicated server, not just a chatbot.",
  },
  {
    q: "Can I use both Telegram and Discord?",
    a: "Yes! You can enable both channels. Your bot will be accessible from both platforms simultaneously, sharing the same AI agent and workspace.",
  },
];

export default function ConnectPage() {
  const router = useRouter();
  const [botToken, setBotToken] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [slackToken, setSlackToken] = useState("");
  const [slackSigningSecret, setSlackSigningSecret] = useState("");
  const [whatsappToken, setWhatsappToken] = useState("");
  const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = useState("");
  const [channels, setChannels] = useState<string[]>(["telegram"]);
  const [apiMode, setApiMode] = useState<"all_inclusive" | "byok">(
    "all_inclusive"
  );
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-5-20250929");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [verified, setVerified] = useState(false);
  const [botUsername, setBotUsername] = useState("");
  const [faqOpen, setFaqOpen] = useState(false);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);

  function toggleChannel(channel: string) {
    setChannels((prev) =>
      prev.includes(channel)
        ? prev.filter((c) => c !== channel)
        : [...prev, channel]
    );
  }

  async function handleContinue() {
    setError("");

    if (channels.includes("telegram") && !verified) {
      setError("Please verify your Telegram bot token first.");
      return;
    }

    if (channels.includes("discord") && !discordToken.trim()) {
      setError("Please enter your Discord bot token.");
      return;
    }

    if (channels.includes("slack") && !slackToken.trim()) {
      setError("Please enter your Slack bot token.");
      return;
    }

    if (channels.includes("whatsapp") && !whatsappToken.trim()) {
      setError("Please enter your WhatsApp access token.");
      return;
    }

    if (channels.length === 0) {
      setError("Please select at least one channel.");
      return;
    }

    if (apiMode === "byok" && !apiKey.trim()) {
      setError("Please enter your Anthropic API key.");
      return;
    }

    sessionStorage.setItem(
      "instaclaw_onboarding",
      JSON.stringify({
        botToken: channels.includes("telegram") ? botToken.trim() : undefined,
        discordToken: channels.includes("discord") ? discordToken.trim() : undefined,
        slackToken: channels.includes("slack") ? slackToken.trim() : undefined,
        slackSigningSecret: channels.includes("slack") ? slackSigningSecret.trim() : undefined,
        whatsappToken: channels.includes("whatsapp") ? whatsappToken.trim() : undefined,
        whatsappPhoneNumberId: channels.includes("whatsapp") ? whatsappPhoneNumberId.trim() : undefined,
        channels,
        apiMode,
        apiKey: apiMode === "byok" ? apiKey.trim() : undefined,
        model: apiMode === "all_inclusive" ? model : undefined,
      })
    );

    router.push("/plan");
  }

  async function handleVerifyToken() {
    if (!TOKEN_RE.test(botToken.trim())) {
      setError("Invalid token format. It should look like 123456789:ABC...");
      return;
    }

    setLoading(true);
    setError("");
    setVerified(false);
    setBotUsername("");

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken.trim()}/getMe`
      );
      const data = await res.json();

      if (data.ok && data.result?.username) {
        setVerified(true);
        setBotUsername(data.result.username);
        setError("");
      } else {
        setError(
          "Invalid token — check that you copied the full token from BotFather."
        );
      }
    } catch {
      setError("Network error verifying bot token. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleTokenChange(value: string) {
    setBotToken(value);
    if (verified) {
      setVerified(false);
      setBotUsername("");
    }
  }

  return (
    <div className="min-h-screen" style={{ background: "#f8f7f4" }}>
      <div className="max-w-2xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="text-center mb-12">
          <h1
            className="text-4xl mb-4"
            style={{
              fontFamily: "var(--font-serif)",
              color: "#333334",
              fontWeight: 400
            }}
          >
            Connect Your Bot
          </h1>
          <p className="text-base" style={{ color: "#666" }}>
            Choose your channels and configure your AI agent.
          </p>
        </div>

        {/* Channel Selection */}
        <div className="mb-10">
          <label
            className="block text-sm font-medium mb-4"
            style={{ color: "#333334" }}
          >
            Channels
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <button
              type="button"
              onClick={() => toggleChannel("telegram")}
              className="bg-white rounded-lg p-4 text-left transition-all"
              style={{
                border: channels.includes("telegram")
                  ? "2px solid #DC6743"
                  : "1px solid rgba(0, 0, 0, 0.1)",
              }}
            >
              <p className="text-sm font-semibold" style={{ color: "#333334" }}>
                Telegram
              </p>
              <p className="text-xs mt-1" style={{ color: "#666" }}>
                Bot via @BotFather
              </p>
            </button>
            <button
              type="button"
              onClick={() => toggleChannel("discord")}
              className="bg-white rounded-lg p-4 text-left transition-all"
              style={{
                border: channels.includes("discord")
                  ? "2px solid #DC6743"
                  : "1px solid rgba(0, 0, 0, 0.1)",
              }}
            >
              <p className="text-sm font-semibold" style={{ color: "#333334" }}>
                Discord
              </p>
              <p className="text-xs mt-1" style={{ color: "#666" }}>
                Discord bot token
              </p>
            </button>
            <button
              type="button"
              onClick={() => toggleChannel("slack")}
              className="bg-white rounded-lg p-4 text-left transition-all"
              style={{
                border: channels.includes("slack")
                  ? "2px solid #DC6743"
                  : "1px solid rgba(0, 0, 0, 0.1)",
              }}
            >
              <p className="text-sm font-semibold" style={{ color: "#333334" }}>
                Slack
              </p>
              <p className="text-xs mt-1" style={{ color: "#666" }}>
                Slack workspace bot
              </p>
            </button>
            <button
              type="button"
              onClick={() => toggleChannel("whatsapp")}
              className="bg-white rounded-lg p-4 text-left transition-all"
              style={{
                border: channels.includes("whatsapp")
                  ? "2px solid #DC6743"
                  : "1px solid rgba(0, 0, 0, 0.1)",
              }}
            >
              <p className="text-sm font-semibold" style={{ color: "#333334" }}>
                WhatsApp
              </p>
              <p className="text-xs mt-1" style={{ color: "#666" }}>
                Meta Business API
              </p>
            </button>
          </div>
        </div>

        {/* Telegram Bot Token */}
        {channels.includes("telegram") && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              Telegram Bot Token
            </label>

            {/* Step-by-step instructions */}
            <div
              className="bg-white rounded-lg p-6 mb-4 text-sm"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#666"
              }}
            >
              <p
                className="font-semibold mb-3"
                style={{ color: "#333334" }}
              >
                How to get your bot token:
              </p>
              <div className="space-y-2">
                <p>1. Open Telegram on your phone or desktop</p>
                <p>
                  2. Search for{" "}
                  <span className="font-semibold" style={{ color: "#333334" }}>
                    @BotFather
                  </span>{" "}
                  (blue checkmark)
                </p>
                <p>
                  3. Tap <strong>Start</strong>, then send:{" "}
                  <code
                    className="px-2 py-1 rounded text-xs"
                    style={{ background: "#f8f7f4", color: "#333334" }}
                  >
                    /newbot
                  </code>
                </p>
                <p>4. Pick a display name (anything — e.g. "My AI Agent")</p>
                <p>
                  5. Pick a username ending in "bot" (e.g.{" "}
                  <span className="font-mono">myagent_bot</span>)
                </p>
                <p>
                  6. BotFather sends you a token like:{" "}
                  <span className="font-mono">123456789:ABCdef...</span>
                </p>
                <p className="font-semibold" style={{ color: "#333334" }}>
                  7. Copy that ENTIRE line and paste it below
                </p>
              </div>
            </div>

            {/* FAQ accordion */}
            <div className="mb-4">
              <button
                type="button"
                onClick={() => {
                  setFaqOpen(!faqOpen);
                  if (faqOpen) setOpenFaqIndex(null);
                }}
                className="flex items-center gap-2 text-sm transition-colors"
                style={{ color: "#666" }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    transform: faqOpen ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 0.2s ease",
                  }}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                What's this? — Common questions
              </button>
              {faqOpen && (
                <div className="mt-3 space-y-2">
                  {FAQ_ITEMS.map((item, i) => (
                    <div
                      key={i}
                      className="bg-white rounded-lg overflow-hidden"
                      style={{ border: "1px solid rgba(0, 0, 0, 0.1)" }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setOpenFaqIndex(openFaqIndex === i ? null : i)
                        }
                        className="w-full text-left px-4 py-3 text-sm font-medium flex items-center justify-between transition-colors"
                        style={{ color: "#333334" }}
                      >
                        {item.q}
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="shrink-0 ml-2"
                          style={{
                            transform:
                              openFaqIndex === i
                                ? "rotate(90deg)"
                                : "rotate(0deg)",
                            transition: "transform 0.2s ease",
                          }}
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>
                      {openFaqIndex === i && (
                        <p
                          className="px-4 pb-3 text-sm leading-relaxed"
                          style={{ color: "#666" }}
                        >
                          {item.a}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Token input + verify button */}
            {verified && botUsername ? (
              <div
                className="rounded-lg p-6 text-center"
                style={{
                  background: "rgba(34,197,94,0.08)",
                  border: "1px solid rgba(34,197,94,0.3)",
                  animation: "token-glow 2s ease-in-out",
                }}
              >
                <p
                  className="text-lg font-semibold"
                  style={{ color: "#22c55e" }}
                >
                  ✓ Your bot @{botUsername} is ready!
                </p>
                <p
                  className="text-sm mt-1"
                  style={{ color: "rgba(34,197,94,0.7)" }}
                >
                  This is where your AI agent will live
                </p>
                <button
                  type="button"
                  onClick={() => handleTokenChange("")}
                  className="text-xs mt-3 underline underline-offset-2"
                  style={{ color: "#666" }}
                >
                  Use a different bot
                </button>
              </div>
            ) : (
              <div className="flex gap-3">
                <input
                  type="text"
                  placeholder="123456789:ABCdefGHIjklMNOpqrs..."
                  value={botToken}
                  onChange={(e) => handleTokenChange(e.target.value)}
                  className="flex-1 px-4 py-3 bg-white rounded-lg text-sm font-mono outline-none transition-all"
                  style={{
                    border: error
                      ? "1px solid #DC6743"
                      : "1px solid rgba(0, 0, 0, 0.1)",
                    color: "#333334",
                  }}
                />
                <button
                  type="button"
                  onClick={handleVerifyToken}
                  disabled={loading || !botToken.trim()}
                  className="px-6 py-3 bg-white rounded-lg text-sm font-medium transition-all disabled:opacity-50 min-w-[100px]"
                  style={{
                    border: "1px solid rgba(0, 0, 0, 0.1)",
                    color: "#333334",
                  }}
                >
                  {loading ? (
                    <span className="flex items-center gap-2 justify-center">
                      <svg
                        className="animate-spin h-3 w-3"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      Verifying...
                    </span>
                  ) : (
                    "Verify"
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Discord Bot Token */}
        {channels.includes("discord") && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              Discord Bot Token
            </label>
            <div
              className="bg-white rounded-lg p-6 mb-4 text-sm"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#666"
              }}
            >
              <p
                className="font-semibold mb-3"
                style={{ color: "#333334" }}
              >
                How to get your Discord bot token:
              </p>
              <div className="space-y-2">
                <p>1. Go to the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "#DC6743" }}>Discord Developer Portal</a></p>
                <p>2. Click "New Application" and name it</p>
                <p>3. Go to the Bot tab and click "Reset Token"</p>
                <p>4. Copy the token and paste it below</p>
                <p>5. Enable "Message Content Intent" under Privileged Intents</p>
                <p className="font-semibold" style={{ color: "#333334" }}>
                  6. Invite the bot to your server using OAuth2 URL Generator
                </p>
              </div>
            </div>
            <input
              type="password"
              placeholder="Discord bot token..."
              value={discordToken}
              onChange={(e) => setDiscordToken(e.target.value)}
              className="w-full px-4 py-3 bg-white rounded-lg text-sm font-mono outline-none"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#333334",
              }}
            />
            <p className="text-xs mt-2" style={{ color: "#666" }}>
              Your token is encrypted and stored securely.
            </p>
          </div>
        )}

        {/* Slack Bot Token */}
        {channels.includes("slack") && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              Slack Bot Token
            </label>
            <div
              className="bg-white rounded-lg p-6 mb-4 text-sm"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#666"
              }}
            >
              <p
                className="font-semibold mb-3"
                style={{ color: "#333334" }}
              >
                How to get your Slack bot token:
              </p>
              <div className="space-y-2">
                <p>1. Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "#DC6743" }}>api.slack.com/apps</a></p>
                <p>2. Click "Create New App" and choose "From scratch"</p>
                <p>3. Go to the Bot tab under "OAuth & Permissions"</p>
                <p>4. Add required bot scopes (chat:write, channels:read, etc.)</p>
                <p>5. Click "Install to Workspace" and authorize</p>
                <p className="font-semibold" style={{ color: "#333334" }}>
                  6. Copy the Bot User OAuth Token and paste it below
                </p>
              </div>
            </div>
            <input
              type="password"
              placeholder="xoxb-..."
              value={slackToken}
              onChange={(e) => setSlackToken(e.target.value)}
              className="w-full px-4 py-3 bg-white rounded-lg text-sm font-mono outline-none mb-3"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#333334",
              }}
            />
            <input
              type="password"
              placeholder="Slack Signing Secret..."
              value={slackSigningSecret}
              onChange={(e) => setSlackSigningSecret(e.target.value)}
              className="w-full px-4 py-3 bg-white rounded-lg text-sm font-mono outline-none"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#333334",
              }}
            />
            <p className="text-xs mt-2" style={{ color: "#666" }}>
              Your tokens are encrypted and stored securely.
            </p>
          </div>
        )}

        {/* WhatsApp Access Token */}
        {channels.includes("whatsapp") && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              WhatsApp Access Token
            </label>
            <div
              className="bg-white rounded-lg p-6 mb-4 text-sm"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#666"
              }}
            >
              <p
                className="font-semibold mb-3"
                style={{ color: "#333334" }}
              >
                How to get your WhatsApp access token:
              </p>
              <div className="space-y-2">
                <p>1. Go to the <a href="https://developers.facebook.com/" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "#DC6743" }}>Meta Developer Console</a></p>
                <p>2. Create a new App and select "Business" type</p>
                <p>3. Add the WhatsApp product to your app</p>
                <p>4. Navigate to WhatsApp &gt; API Setup</p>
                <p className="font-semibold" style={{ color: "#333334" }}>
                  5. Copy the access token and Phone Number ID below
                </p>
                <p
                  className="mt-3 px-3 py-2 rounded text-xs"
                  style={{ background: "#f8f7f4", color: "#333334" }}
                >
                  Note: Meta Business verification is required for production access. You can use the test number during development.
                </p>
              </div>
            </div>
            <input
              type="password"
              placeholder="WhatsApp access token..."
              value={whatsappToken}
              onChange={(e) => setWhatsappToken(e.target.value)}
              className="w-full px-4 py-3 bg-white rounded-lg text-sm font-mono outline-none mb-3"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#333334",
              }}
            />
            <input
              type="text"
              placeholder="Phone Number ID..."
              value={whatsappPhoneNumberId}
              onChange={(e) => setWhatsappPhoneNumberId(e.target.value)}
              className="w-full px-4 py-3 bg-white rounded-lg text-sm font-mono outline-none"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#333334",
              }}
            />
            <p className="text-xs mt-2" style={{ color: "#666" }}>
              Your tokens are encrypted and stored securely.
            </p>
          </div>
        )}

        {/* API Mode */}
        <div className="mb-10">
          <label
            className="block text-sm font-medium mb-4"
            style={{ color: "#333334" }}
          >
            API Mode
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setApiMode("all_inclusive")}
              className="bg-white rounded-lg p-4 text-left transition-all"
              style={{
                border:
                  apiMode === "all_inclusive"
                    ? "2px solid #DC6743"
                    : "1px solid rgba(0, 0, 0, 0.1)",
              }}
            >
              <p className="text-sm font-semibold" style={{ color: "#333334" }}>
                All-Inclusive
              </p>
              <p className="text-xs mt-1" style={{ color: "#666" }}>
                We handle everything. Recommended.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setApiMode("byok")}
              className="bg-white rounded-lg p-4 text-left transition-all"
              style={{
                border:
                  apiMode === "byok"
                    ? "2px solid #DC6743"
                    : "1px solid rgba(0, 0, 0, 0.1)",
              }}
            >
              <p className="text-sm font-semibold" style={{ color: "#333334" }}>
                BYOK
              </p>
              <p className="text-xs mt-1" style={{ color: "#666" }}>
                Bring your own Anthropic key. Save more.
              </p>
            </button>
          </div>
        </div>

        {/* BYOK API Key */}
        {apiMode === "byok" && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              Anthropic API Key
            </label>
            <input
              type="password"
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full px-4 py-3 bg-white rounded-lg text-sm font-mono outline-none"
              style={{
                border: "1px solid rgba(0, 0, 0, 0.1)",
                color: "#333334",
              }}
            />
            <p className="text-xs mt-2" style={{ color: "#666" }}>
              Your key is encrypted and only used on your dedicated VM.
            </p>
          </div>
        )}

        {/* Model Selection (all-inclusive only) */}
        {apiMode === "all_inclusive" && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              Default Model
            </label>
            <div className="grid grid-cols-2 gap-3">
              {[
                {
                  id: "claude-haiku-4-5-20251001",
                  label: "Claude Haiku 4.5",
                  desc: "Fast & affordable",
                },
                {
                  id: "claude-sonnet-4-5-20250929",
                  label: "Claude Sonnet 4.5",
                  desc: "Recommended — best balance",
                },
                {
                  id: "claude-opus-4-5-20250820",
                  label: "Claude Opus 4.5",
                  desc: "Premium intelligence",
                },
                {
                  id: "claude-opus-4-6",
                  label: "Claude Opus 4.6",
                  desc: "Most advanced",
                },
              ].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModel(m.id)}
                  className="bg-white rounded-lg p-4 text-left transition-all"
                  style={{
                    border:
                      model === m.id
                        ? "2px solid #DC6743"
                        : "1px solid rgba(0, 0, 0, 0.1)",
                  }}
                >
                  <p className="text-sm font-semibold" style={{ color: "#333334" }}>
                    {m.label}
                  </p>
                  <p className="text-xs mt-1" style={{ color: "#666" }}>
                    {m.desc}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm mb-6" style={{ color: "#DC6743" }}>
            {error}
          </p>
        )}

        <button
          onClick={handleContinue}
          disabled={channels.length === 0 || (channels.includes("telegram") && !verified)}
          className="w-full px-6 py-3.5 rounded-lg text-base font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: "#DC6743",
            color: "#ffffff",
          }}
        >
          Continue to Plan Selection
        </button>

        {/* Glow animation for verified state */}
        <style jsx>{`
          @keyframes token-glow {
            0% {
              box-shadow: 0 0 0 rgba(34, 197, 94, 0);
            }
            30% {
              box-shadow: 0 0 20px rgba(34, 197, 94, 0.25);
            }
            100% {
              box-shadow: 0 0 0 rgba(34, 197, 94, 0);
            }
          }
        `}</style>
      </div>
    </div>
  );
}
