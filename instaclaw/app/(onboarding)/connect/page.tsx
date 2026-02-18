"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

const glassStyle = {
  background:
    "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow: `
    rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
    rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
    rgba(0, 0, 0, 0.1) 0px 2px 4px 0px,
    rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
  `,
} as const;

const glassSelectedStyle = {
  ...glassStyle,
  border: "2px solid #DC6743",
  boxShadow: `
    rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
    rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
    rgba(220, 103, 67, 0.2) 0px 2px 12px 0px,
    rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
  `,
} as const;

const glassInputStyle = {
  ...glassStyle,
  color: "#333334",
} as const;

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
  const [selectedChannel, setSelectedChannel] = useState<string>("telegram");
  const [channels, setChannels] = useState<string[]>(["telegram"]);
  const [apiMode, setApiMode] = useState<"all_inclusive" | "byok">(
    "all_inclusive"
  );
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("claude-haiku-4-5-20251001");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [verified, setVerified] = useState(false);
  const [botUsername, setBotUsername] = useState("");
  const [faqOpen, setFaqOpen] = useState(false);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  function selectChannel(channel: string) {
    setSelectedChannel(channel);
    setChannels([channel]);
  }

  // Auto-verify token when pasted/entered
  const verifyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastVerifiedToken = useRef<string>("");

  useEffect(() => {
    // Clear any pending verification
    if (verifyTimeoutRef.current) {
      clearTimeout(verifyTimeoutRef.current);
    }

    // Don't auto-verify if already verified or already loading
    if (verified || loading) return;

    // Check if token matches valid format
    if (TOKEN_RE.test(botToken.trim()) && botToken.trim() !== lastVerifiedToken.current) {
      // Debounce verification by 500ms to avoid too many API calls
      verifyTimeoutRef.current = setTimeout(() => {
        handleVerifyToken();
      }, 500);
    }

    return () => {
      if (verifyTimeoutRef.current) {
        clearTimeout(verifyTimeoutRef.current);
      }
    };
  }, [botToken, verified, loading]);

  async function handleContinue() {
    setError("");

    if (selectedChannel === "telegram" && !verified) {
      setError("Please verify your Telegram bot token first.");
      return;
    }

    if (selectedChannel === "discord" && !discordToken.trim()) {
      setError("Please enter your Discord bot token.");
      return;
    }

    if (selectedChannel === "slack" && !slackToken.trim()) {
      setError("Please enter your Slack bot token.");
      return;
    }

    if (selectedChannel === "whatsapp" && !whatsappToken.trim()) {
      setError("Please enter your WhatsApp access token.");
      return;
    }

    if (selectedChannel === "imessage") {
      setError("iMessage integration coming soon!");
      return;
    }

    if (apiMode === "byok" && !apiKey.trim()) {
      setError("Please enter your Anthropic API key.");
      return;
    }

    if (apiMode === "all_inclusive" && !defaultModel) {
      setError("Please select a default model.");
      return;
    }

    sessionStorage.setItem(
      "instaclaw_onboarding",
      JSON.stringify({
        botToken: selectedChannel === "telegram" ? botToken.trim() : undefined,
        discordToken: selectedChannel === "discord" ? discordToken.trim() : undefined,
        slackToken: selectedChannel === "slack" ? slackToken.trim() : undefined,
        slackSigningSecret: selectedChannel === "slack" ? slackSigningSecret.trim() : undefined,
        whatsappToken: selectedChannel === "whatsapp" ? whatsappToken.trim() : undefined,
        whatsappPhoneNumberId: selectedChannel === "whatsapp" ? whatsappPhoneNumberId.trim() : undefined,
        channels: [selectedChannel],
        apiMode,
        apiKey: apiMode === "byok" ? apiKey.trim() : undefined,
        models: apiMode === "all_inclusive" ? [defaultModel] : undefined,
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
        lastVerifiedToken.current = botToken.trim();
      } else {
        setError(
          "Invalid token — check that you copied the full token from BotFather."
        );
        lastVerifiedToken.current = botToken.trim();
      }
    } catch {
      setError("Network error verifying bot token. Please try again.");
      lastVerifiedToken.current = botToken.trim();
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
      {/* Step Indicator */}
      <div
        className="sticky top-0 z-10 py-4"
        style={{
          background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.6))",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(0, 0, 0, 0.06)",
        }}
      >
        <div className="max-w-2xl mx-auto px-6">
          <div className="flex items-center justify-center gap-2">
            {[
              { num: 1, label: "Connect" },
              { num: 2, label: "Plan" },
              { num: 3, label: "Deploy" },
            ].map((step, i) => (
              <div key={step.num} className="flex items-center">
                <div className="flex flex-col items-center">
                  {step.num === 1 ? (
                    /* Active step — glowing glass orb */
                    <span
                      className="relative flex items-center justify-center w-10 h-10 rounded-full overflow-hidden shrink-0"
                      style={{
                        background: "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.7), rgba(220,103,67,0.4) 50%, rgba(180,70,40,0.75) 100%)",
                        boxShadow: `
                          inset 0 -2px 4px rgba(0,0,0,0.3),
                          inset 0 2px 4px rgba(255,255,255,0.5),
                          inset 0 0 3px rgba(0,0,0,0.15),
                          0 1px 4px rgba(0,0,0,0.15)
                        `,
                      }}
                    >
                      {/* Shimmer sweep */}
                      <span
                        className="absolute inset-0 rounded-full"
                        style={{
                          background: "linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0.4) 55%, transparent 80%)",
                          backgroundSize: "300% 100%",
                          animation: "globe-shimmer 4s linear infinite",
                        }}
                      />
                      {/* Glass highlight */}
                      <span
                        className="absolute top-[3px] left-[5px] w-[14px] h-[8px] rounded-full pointer-events-none"
                        style={{
                          background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
                        }}
                      />
                      {/* Breathing glow */}
                      <span
                        className="absolute inset-[-3px] rounded-full"
                        style={{
                          background: "radial-gradient(circle, rgba(220,103,67,0.4) 0%, transparent 70%)",
                          animation: "globe-glow 4s ease-in-out infinite",
                        }}
                      />
                      <span className="relative text-sm font-semibold" style={{ color: "#ffffff" }}>
                        {step.num}
                      </span>
                    </span>
                  ) : (
                    /* Inactive steps — glass orb */
                    <span
                      className="flex items-center justify-center w-10 h-10 rounded-full text-sm font-semibold"
                      style={{
                        ...glassStyle,
                        color: "#999999",
                      }}
                    >
                      {step.num}
                    </span>
                  )}
                  <span
                    className="text-xs mt-1.5 font-medium"
                    style={{ color: step.num === 1 ? "#333334" : "#999999" }}
                  >
                    {step.label}
                  </span>
                </div>
                {i < 2 && (
                  <div
                    className="w-16 mx-3 mb-5 rounded-full overflow-hidden"
                    style={{
                      height: "3px",
                      background: "rgba(0, 0, 0, 0.06)",
                    }}
                  >
                    {i === 0 && (
                      <div
                        className="h-full w-full"
                        style={{
                          background: "linear-gradient(90deg, rgba(220,103,67,0.15), rgba(220,103,67,0.5), #f0976e, #ffffff, #f0976e, rgba(220,103,67,0.5), rgba(220,103,67,0.15))",
                          backgroundSize: "300% 100%",
                          animation: "step-shimmer 2s ease-in-out infinite",
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

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
          <p className="text-base" style={{ color: "#999" }}>
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
          <div className="grid grid-cols-2 gap-3 mb-3">
            {[
              {
                id: "telegram",
                label: "Telegram",
                desc: "Bot via @BotFather",
                enabled: true,
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM16.64 8.8C16.49 10.38 15.84 14.22 15.51 15.98C15.37 16.74 15.09 16.99 14.83 17.02C14.25 17.07 13.81 16.64 13.25 16.27C12.37 15.69 11.87 15.33 11.02 14.77C10.03 14.12 10.67 13.76 11.24 13.18C11.39 13.03 13.95 10.7 14 10.49C14.0069 10.4582 14.006 10.4252 13.9973 10.3938C13.9886 10.3624 13.9724 10.3337 13.95 10.31C13.89 10.26 13.81 10.28 13.74 10.29C13.65 10.31 12.25 11.24 9.52 13.08C9.12 13.35 8.76 13.49 8.44 13.48C8.08 13.47 7.4 13.28 6.89 13.11C6.26 12.91 5.77 12.8 5.81 12.45C5.83 12.27 6.08 12.09 6.55 11.9C9.47 10.63 11.41 9.79 12.38 9.39C15.16 8.23 15.73 8.03 16.11 8.03C16.19 8.03 16.38 8.05 16.5 8.15C16.6 8.23 16.63 8.34 16.64 8.42C16.63 8.48 16.65 8.66 16.64 8.8Z" fill="#229ED9"/>
                  </svg>
                ),
              },
              {
                id: "discord",
                label: "Discord",
                desc: "Coming soon",
                enabled: false,
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4C14.83 4.31 14.62 4.73 14.48 5.06C12.92 4.83 11.35 4.83 9.82 5.06C9.68 4.73 9.46 4.31 9.29 4C7.78 4.26 6.35 4.71 5.02 5.33C2.44 9.14 1.73 12.86 2.08 16.53C3.87 17.85 5.61 18.65 7.32 19.18C7.72 18.64 8.08 18.07 8.39 17.47C7.82 17.25 7.27 16.98 6.75 16.67C6.89 16.56 7.02 16.45 7.16 16.34C10.18 17.73 13.45 17.73 16.43 16.34C16.57 16.45 16.7 16.56 16.84 16.67C16.32 16.98 15.77 17.25 15.2 17.47C15.51 18.07 15.87 18.64 16.27 19.18C17.98 18.65 19.72 17.85 21.51 16.53C21.92 12.27 20.85 8.59 19.27 5.33ZM8.68 14.18C7.72 14.18 6.93 13.29 6.93 12.19C6.93 11.09 7.7 10.2 8.68 10.2C9.66 10.2 10.45 11.09 10.43 12.19C10.43 13.29 9.66 14.18 8.68 14.18ZM14.91 14.18C13.95 14.18 13.16 13.29 13.16 12.19C13.16 11.09 13.93 10.2 14.91 10.2C15.89 10.2 16.68 11.09 16.66 12.19C16.66 13.29 15.89 14.18 14.91 14.18Z" fill="#5865F2"/>
                  </svg>
                ),
              },
              {
                id: "slack",
                label: "Slack",
                desc: "Coming soon",
                enabled: false,
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M6 15C6 16.1 5.1 17 4 17C2.9 17 2 16.1 2 15C2 13.9 2.9 13 4 13H6V15ZM7 15C7 13.9 7.9 13 9 13C10.1 13 11 13.9 11 15V20C11 21.1 10.1 22 9 22C7.9 22 7 21.1 7 20V15Z" fill="#E01E5A"/>
                    <path d="M9 6C7.9 6 7 5.1 7 4C7 2.9 7.9 2 9 2C10.1 2 11 2.9 11 4V6H9ZM9 7C10.1 7 11 7.9 11 9C11 10.1 10.1 11 9 11H4C2.9 11 2 10.1 2 9C2 7.9 2.9 7 4 7H9Z" fill="#36C5F0"/>
                    <path d="M18 9C18 7.9 18.9 7 20 7C21.1 7 22 7.9 22 9C22 10.1 21.1 11 20 11H18V9ZM17 9C17 10.1 16.1 11 15 11C13.9 11 13 10.1 13 9V4C13 2.9 13.9 2 15 2C16.1 2 17 2.9 17 4V9Z" fill="#2EB67D"/>
                    <path d="M15 18C16.1 18 17 18.9 17 20C17 21.1 16.1 22 15 22C13.9 22 13 21.1 13 20V18H15ZM15 17C13.9 17 13 16.1 13 15C13 13.9 13.9 13 15 13H20C21.1 13 22 13.9 22 15C22 16.1 21.1 17 20 17H15Z" fill="#ECB22E"/>
                  </svg>
                ),
              },
              {
                id: "whatsapp",
                label: "WhatsApp",
                desc: "Coming soon",
                enabled: false,
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" fill="#25D366"/>
                  </svg>
                ),
              },
            ].map((ch) => (
              <button
                key={ch.id}
                type="button"
                onClick={() => ch.enabled && selectChannel(ch.id)}
                disabled={!ch.enabled}
                className="rounded-xl p-4 text-left transition-all flex items-start gap-3"
                style={{
                  ...(selectedChannel === ch.id && ch.enabled ? glassSelectedStyle : glassStyle),
                  opacity: ch.enabled ? 1 : 0.65,
                  cursor: ch.enabled ? "pointer" : "default",
                }}
              >
                {ch.icon}
                <div className="flex-1">
                  <p className="text-sm font-semibold" style={{ color: ch.enabled ? "#333334" : "#999" }}>
                    {ch.label}
                  </p>
                  <p className="text-xs mt-1" style={{ color: ch.enabled ? "#666" : "#aaa" }}>
                    {ch.desc}
                  </p>
                </div>
              </button>
            ))}
          </div>

          {/* iMessage — teaser bubble */}
          <div className="flex flex-col items-end mr-1">
            <div
              className="imessage-bubble py-2 px-3.5"
              style={{ background: "#0B84FE" }}
            >
              <p className="text-[13px] leading-snug" style={{ color: "#ffffff" }}>
                Blue bubbles on iMessage coming soon 😉🍎
              </p>
            </div>
            <p className="text-[10px] mt-0.5 mr-1" style={{ color: "#aaa" }}>
              Delivered
            </p>
          </div>

          {/* Coming Soon Message */}
          <p className="text-xs mt-3 text-center" style={{ color: "#999" }}>
            Multi-channel support coming soon
          </p>
        </div>

        {/* Telegram Bot Token */}
        {selectedChannel === "telegram" && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              Telegram Bot Token
            </label>

            {/* Step-by-step instructions - Collapsible */}
            <div
              className="rounded-xl mb-4 text-sm overflow-hidden"
              style={glassStyle}
            >
              <button
                type="button"
                onClick={() => setInstructionsOpen(!instructionsOpen)}
                className="w-full px-6 py-4 text-left flex items-center justify-between transition-colors"
                style={{ color: "#333334" }}
              >
                <span className="font-semibold">How to get your bot token:</span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    transform: instructionsOpen ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 0.2s ease",
                  }}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              {instructionsOpen && (
                <div className="px-6 pb-6 space-y-2" style={{ color: "#666" }}>
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
              )}
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
                      className="rounded-xl overflow-hidden"
                      style={glassStyle}
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
                  className="flex-1 px-4 py-3 rounded-xl text-sm font-mono outline-none transition-all"
                  style={{
                    ...glassInputStyle,
                    border: error ? "2px solid #DC6743" : "none",
                  }}
                />
                <button
                  type="button"
                  onClick={handleVerifyToken}
                  disabled={loading || !botToken.trim()}
                  className={`px-6 py-3 rounded-xl text-sm font-medium transition-all min-w-[100px] ${!botToken.trim() ? "disabled:opacity-50" : ""}`}
                  style={TOKEN_RE.test(botToken.trim()) && !verified ? {
                    background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                    backdropFilter: "blur(2px)",
                    WebkitBackdropFilter: "blur(2px)",
                    boxShadow: "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(255,255,255,0.3) 0px -1px 1px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px, rgba(255,255,255,0.08) 0px 0px 1.6px 4px inset",
                    color: "#ffffff",
                  } : {
                    ...glassInputStyle,
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
        {selectedChannel === "discord" && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              Discord Bot Token
            </label>
            <div
              className="rounded-xl p-6 mb-4 text-sm"
              style={{ ...glassStyle, color: "#666" }}
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
              className="w-full px-4 py-3 rounded-xl text-sm font-mono outline-none"
              style={glassInputStyle}
            />
            <p className="text-xs mt-2" style={{ color: "#666" }}>
              Your token is encrypted and stored securely.
            </p>
          </div>
        )}

        {/* Slack Bot Token */}
        {selectedChannel === "slack" && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              Slack Bot Token
            </label>
            <div
              className="rounded-xl p-6 mb-4 text-sm"
              style={{ ...glassStyle, color: "#666" }}
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
              className="w-full px-4 py-3 rounded-xl text-sm font-mono outline-none mb-3"
              style={glassInputStyle}
            />
            <input
              type="password"
              placeholder="Slack Signing Secret..."
              value={slackSigningSecret}
              onChange={(e) => setSlackSigningSecret(e.target.value)}
              className="w-full px-4 py-3 rounded-xl text-sm font-mono outline-none"
              style={glassInputStyle}
            />
            <p className="text-xs mt-2" style={{ color: "#666" }}>
              Your tokens are encrypted and stored securely.
            </p>
          </div>
        )}

        {/* WhatsApp Access Token */}
        {selectedChannel === "whatsapp" && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-4"
              style={{ color: "#333334" }}
            >
              WhatsApp Access Token
            </label>
            <div
              className="rounded-xl p-6 mb-4 text-sm"
              style={{ ...glassStyle, color: "#666" }}
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
              className="w-full px-4 py-3 rounded-xl text-sm font-mono outline-none mb-3"
              style={glassInputStyle}
            />
            <input
              type="text"
              placeholder="Phone Number ID..."
              value={whatsappPhoneNumberId}
              onChange={(e) => setWhatsappPhoneNumberId(e.target.value)}
              className="w-full px-4 py-3 rounded-xl text-sm font-mono outline-none"
              style={glassInputStyle}
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
              className="rounded-xl p-4 text-left transition-all"
              style={apiMode === "all_inclusive" ? glassSelectedStyle : glassStyle}
            >
              <p className="text-sm font-semibold flex items-center gap-2" style={{ color: "#333334" }}>
                All-Inclusive
                <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 1px 3px rgba(220,103,67,0.35))" }}>
                  <defs>
                    <linearGradient id="star-glass" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#e8845e" />
                      <stop offset="50%" stopColor="#DC6743" />
                      <stop offset="100%" stopColor="#b84a2a" />
                    </linearGradient>
                  </defs>
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="url(#star-glass)" stroke="rgba(255,255,255,0.3)" />
                </svg>
              </p>
              <p className="text-xs mt-1" style={{ color: "#666" }}>
                We handle everything. Recommended.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setApiMode("byok")}
              className="rounded-xl p-4 text-left transition-all"
              style={apiMode === "byok" ? glassSelectedStyle : glassStyle}
            >
              <p className="text-sm font-semibold flex items-center gap-2" style={{ color: "#333334" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.15))" }}>
                  <defs>
                    <linearGradient id="key-glass" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#888" />
                      <stop offset="50%" stopColor="#666" />
                      <stop offset="100%" stopColor="#444" />
                    </linearGradient>
                  </defs>
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" fill="none" stroke="url(#key-glass)" />
                </svg>
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
              className="w-full px-4 py-3 rounded-xl text-sm font-mono outline-none"
              style={glassInputStyle}
            />
            <p className="text-xs mt-2" style={{ color: "#666" }}>
              Your key is encrypted and only used on your dedicated VM.
            </p>
          </div>
        )}

        {/* Default Model Selection (all-inclusive only) */}
        {apiMode === "all_inclusive" && (
          <div className="mb-10">
            <label
              className="block text-sm font-medium mb-2"
              style={{ color: "#333334" }}
            >
              Default Model
            </label>
            <p className="text-xs mb-4" style={{ color: "#666" }}>
              Pick a starting model. You can switch anytime just by asking your bot.
            </p>

            <div className="space-y-2">
              {[
                {
                  id: "claude-haiku-4-5-20251001",
                  label: "Claude Haiku 4.5",
                  cost: "1 unit/message",
                  desc: "Great for everyday tasks — fast, capable, and stretches your units the furthest.",
                  recommended: true,
                },
                {
                  id: "claude-sonnet-4-5-20250929",
                  label: "Claude Sonnet 4.5",
                  cost: "4 units/message",
                  desc: "Stronger reasoning for complex questions. Good balance of smarts and cost.",
                  recommended: false,
                },
                {
                  id: "claude-opus-4-6",
                  label: "Claude Opus 4.6",
                  cost: "19 units/message",
                  desc: "Most powerful — best for deep analysis, coding, and multi-step tasks.",
                  recommended: false,
                },
              ].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setDefaultModel(m.id)}
                  className="w-full rounded-xl p-4 text-left transition-all flex items-start gap-3"
                  style={defaultModel === m.id ? glassSelectedStyle : glassStyle}
                >
                  {/* Radio indicator */}
                  <div
                    className="w-5 h-5 rounded-full shrink-0 mt-0.5 relative overflow-hidden"
                    style={defaultModel === m.id ? {
                      background: "radial-gradient(circle at 35% 30%, #e8845e, #DC6743 50%, #b84a2a 100%)",
                      boxShadow: "rgba(220,103,67,0.35) 0px 2px 8px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
                    } : {
                      background: "linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))",
                      boxShadow: "rgba(0,0,0,0.05) 0px 1px 1px 0px inset, rgba(255,255,255,0.5) 0px -1px 1px 0px inset, rgba(0,0,0,0.08) 0px 1px 3px 0px, rgba(255,255,255,0.2) 0px 0px 1px 2px inset",
                    }}
                  >
                    {defaultModel === m.id && (
                      <div
                        className="absolute inset-0 rounded-full"
                        style={{
                          background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.5) 0%, transparent 50%)",
                        }}
                      />
                    )}
                  </div>

                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold" style={{ color: "#333334" }}>
                        {m.label}
                      </p>
                      {m.recommended && (
                        <span
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                          style={{
                            background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                            backdropFilter: "blur(2px)",
                            WebkitBackdropFilter: "blur(2px)",
                            boxShadow: "rgba(255,255,255,0.2) 0px 1px 1px 0px inset, rgba(255,255,255,0.25) 0px -1px 1px 0px inset, rgba(220,103,67,0.25) 0px 2px 6px 0px",
                            color: "#ffffff",
                          }}
                        >
                          Recommended
                        </span>
                      )}
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: "#f8f7f4", color: "#666" }}>
                        {m.cost}
                      </span>
                    </div>
                    <p className="text-xs mt-1" style={{ color: "#666" }}>
                      {m.desc}
                    </p>
                  </div>
                </button>
              ))}
            </div>

            <p className="text-xs mt-3" style={{ color: "#999" }}>
              All models are always available — just tell your bot &quot;use Sonnet&quot; or &quot;switch to Opus&quot; anytime.
            </p>
            <p className="text-xs mt-2" style={{ color: "#999" }}>
              Example: On the Pro plan (1,000 units/day), Haiku gets ~1,000 messages/day, Sonnet ~250, Opus ~52.
            </p>
            <p className="text-xs mt-3 px-3 py-2.5 rounded-lg" style={{
              ...glassStyle,
              color: "#666",
            }}>
              <span className="font-semibold" style={{ color: "#DC6743" }}>Pro tip:</span>{" "}
              Start with Haiku for everyday tasks. Say &quot;switch to Sonnet&quot; mid-conversation for harder questions — no restart needed.
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm mb-6" style={{ color: "#DC6743" }}>
            {error}
          </p>
        )}

        <button
          onClick={handleContinue}
          disabled={!selectedChannel || (selectedChannel === "telegram" && !verified)}
          className="w-full px-6 py-3.5 rounded-lg text-base font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            boxShadow: `
              rgba(255,255,255,0.2) 0px 2px 2px 0px inset,
              rgba(255, 255, 255, 0.3) 0px -1px 1px 0px inset,
              rgba(220,103,67,0.35) 0px 4px 16px 0px,
              rgba(255, 255, 255, 0.08) 0px 0px 1.6px 4px inset
            `,
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
