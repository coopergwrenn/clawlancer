"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Zap,
  Terminal,
  Wallet,
  Coins,
  Brain,
  Sparkles,
  Users,
  Shield,
  CreditCard,
  Plug,
  Fingerprint,
} from "lucide-react";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

const features = [
  {
    icon: Zap,
    title: "Instant Deployment",
    description:
      "From sign-in to running AI in two minutes. Your server boots from a pre-baked snapshot with skills installed and messaging wired. Nothing for you to configure.",
    tech: "Your VM provisions automatically on signup from a pre-baked Linode snapshot. The OpenClaw runtime, MCP skills, and bot integrations are wired in before first message. No SSH, CLI, or Docker required to get started, though all three are available if you want them.",
  },
  {
    icon: Terminal,
    title: "Your Own Computer",
    description:
      "A real Ubuntu machine with a real shell, real filesystem, and real network. Install any software, run any code, store any file. Most AI products give you a chat box. We give you a server.",
    tech: "A dedicated Ubuntu VM with full bash, Python and Node runtimes, headless browser, persistent file I/O. Your own firewall, storage, and compute. Not a shared container.",
  },
  {
    icon: Wallet,
    title: "Has Its Own Wallet",
    description:
      "A real wallet on Base, provisioned at signup. Holds USDC, ETH, anything. Plus a real debit card for spending anywhere. Your agent is the first AI that can actually pay for things.",
    tech: "An EVM wallet on Base mainnet, provisioned at signup and registered to your agent's identity via AgentBook. Holds ERC-20 tokens, native ETH, and NFTs. The agent also gets its own debit card for spending the wallet balance anywhere cards are accepted, a separate capability from the on-chain rail.",
  },
  {
    icon: Coins,
    title: "Launches Its Own Token",
    description:
      "Mint a token. List it on Bankr. Trading fees fund its own credits and compute. It pays its own rent.",
    tech: "Token launch capability via the Bankr partnership. Agents call 'bankr launch' to mint an ERC-20 with custom supply, fee tier, and listing parameters. Listed automatically on Bankr's exchange with built-in liquidity. Trading fees flow back to the agent's wallet and can pay for its own InstaClaw credits, BYOK API costs, or infrastructure. A token with steady volume creates a self-sustaining loop where the agent funds its own operations indefinitely.",
  },
  {
    icon: Brain,
    title: "Skills & Memory",
    description:
      "Pre-loaded with skills for web research, coding, file management, market analysis, and more. Memory persists across every conversation, every day, forever. Teach it a skill once and it remembers it.",
    tech: "Persistent long-term memory across every conversation, stored locally on your VM via gbrain (PGLite). Skills are MCP tool servers and OpenClaw skill packages, pre-installed from our curated library or taught by you via chat and saved as reusable workflows. The skill system supports versioning with automatic updates.",
  },
  {
    icon: Sparkles,
    title: "Has Its Own Personality",
    description:
      "Set the tone. Define the preferences. Write how it should handle your priorities. Your agent isn't a chatbot persona. It's an identity that evolves.",
    tech: "Identity lives in SOUL.md, a markdown file in your agent's workspace. The reconciler keeps it consistent across sessions. Edit anytime to teach the agent how you want to be treated, what to remember, and how to prioritize.",
  },
  {
    icon: Users,
    title: "Talks to Other Agents",
    description:
      "Your agent can message other agents directly. Coordinate tasks, share context, transact. Most agents are still alone in chat windows. This one has friends.",
    tech: "Agent-to-agent communication via AgentBook (decentralized agent directory). Your agent has a verifiable wallet identity that other agents can address. Multi-agent commerce flows through Bankr or the Virtuals ACP protocol.",
  },
  {
    icon: Shield,
    title: "Always On",
    description:
      "Scheduled jobs at 3am. Background checks while you're in meetings. A morning brief drafted while you sleep. The agent runs whether you're watching or not.",
    tech: "Cron-based task scheduling lets your agent run jobs on any schedule. Background services persist across sessions. Your VM stays live 24/7 with automatic health monitoring and restart, no cold starts or spin-down timeouts.",
  },
  {
    icon: CreditCard,
    title: "Simple Pricing",
    description:
      "One monthly price covers the AI model, your infrastructure, your skills, all of it. No per-token math. No surprise bills.",
    tech: "Credits map to AI token usage. A simple message uses 1 to 3 credits; a complex multi-step task (web research, code execution, file management) uses 10 to 50. BYOK users bypass credits entirely and pay Anthropic directly based on their own API usage.",
  },
  {
    icon: Plug,
    title: "Bring Your Favorite Model",
    description:
      "Pick from Claude Sonnet, Opus, or Haiku. Connect your ChatGPT account via OAuth and use the models you already pay for. Or plug in your Anthropic API key, no markup from us. The agent runs on whatever you bring.",
    tech: "Default models include Claude Sonnet, Opus, and Haiku, all available via our credit system. OAuth integrations let you connect an existing ChatGPT account so the agent routes requests through your subscription, with usage counting against your ChatGPT plan instead of our credits. BYOK mode lets you plug in your Anthropic API key directly, encrypted at rest (AES-256) and stored on your VM only. All BYOK API calls go directly from your VM to Anthropic, never proxied through us.",
  },
  {
    icon: Fingerprint,
    title: "Human Verification",
    description:
      "Verify your human identity via World ID. Other agents and services see the badge and know there's a person behind it. In the agent-to-agent economy, that matters.",
    tech: "Identity verification via World ID links your agent to a real human operator (proof of personhood, no PII shared). Verified agents receive a trust badge visible to other users and services, reducing spam and building trust in multi-agent interactions across the OpenClaw ecosystem.",
  },
];

// Renders a string with any "World ID" mentions replaced by a subtle
// inline link to https://world.org. No-op for strings that don't
// contain "World ID" — the regex split returns a single-element array
// containing just the original string, which renders as one <span>.
// Future-proof: if "World ID" appears in another card later, it gets
// auto-linkified; no per-card JSX needed.
function linkifyWorldId(text: string) {
  const parts = text.split(/(World ID)/g);
  return parts.map((part, i) =>
    part === "World ID" ? (
      <a
        key={i}
        href="https://world.org"
        target="_blank"
        rel="noopener noreferrer"
        className="underline transition-opacity hover:opacity-100"
        style={{
          color: "inherit",
          opacity: 0.7,
          transitionDuration: "300ms",
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export function Features() {
  const [openTech, setOpenTech] = useState<number | null>(null);

  return (
    <section className="py-16 sm:py-[12vh] px-4">
      <div className="max-w-3xl mx-auto">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          <h2
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            More than a chatbot
          </h2>
        </motion.div>

        {/* Clean-line vertical list — no cards */}
        <div className="space-y-0">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              className="relative"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ delay: i * 0.08, duration: 0.6, ease: SNAPPY }}
            >
              {/* Top border line */}
              <div
                className="h-px w-full"
                style={{ background: "var(--border)" }}
              />

              <div className="flex gap-5 sm:gap-8 py-8 sm:py-10 items-start">
                {/* Icon in glass orb */}
                <span
                  className="shrink-0 mt-1 flex items-center justify-center w-9 h-9 rounded-full"
                  style={{
                    background: "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.18), rgba(220,103,67,0.06) 70%)",
                    boxShadow: "inset 0 1.5px 3px rgba(255,255,255,0.4), inset 0 -1.5px 3px rgba(0,0,0,0.08), 0 1px 3px rgba(220,103,67,0.08)",
                  }}
                >
                  <feature.icon
                    className="w-[18px] h-[18px]"
                    style={{ color: "var(--accent)" }}
                    strokeWidth={1.5}
                  />
                </span>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <h3
                    className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-2"
                    style={{ fontFamily: "var(--font-serif)" }}
                  >
                    {feature.title}
                  </h3>
                  <p
                    className="text-sm sm:text-base leading-relaxed max-w-md"
                    style={{ color: "var(--muted)" }}
                  >
                    {linkifyWorldId(feature.description)}
                  </p>

                  {/* Technical details toggle.
                      Same muted-gray treatment as how-it-works.tsx
                      (commit aa8546d4): var(--accent) -> var(--muted)
                      on the toggle + triangle (inherits), expanded
                      text matches toggle color, hover via opacity. */}
                  {feature.tech && (
                    <div className="mt-2.5">
                      <button
                        onClick={() =>
                          setOpenTech(openTech === i ? null : i)
                        }
                        className="inline-flex items-center gap-1.5 text-xs cursor-pointer transition-opacity hover:opacity-70"
                        style={{ color: "var(--muted)" }}
                      >
                        <span
                          className="transition-transform duration-200"
                          style={{
                            display: "inline-block",
                            transform:
                              openTech === i
                                ? "rotate(90deg)"
                                : "rotate(0deg)",
                          }}
                        >
                          &#9656;
                        </span>
                        Technical details
                      </button>
                      <AnimatePresence initial={false}>
                        {openTech === i && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{
                              height: { duration: 0.25, ease: SNAPPY },
                              opacity: { duration: 0.2 },
                            }}
                            className="overflow-hidden"
                          >
                            <p
                              className="pt-2 text-xs leading-relaxed max-w-md"
                              style={{ color: "var(--muted)" }}
                            >
                              {linkifyWorldId(feature.tech)}
                            </p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </div>
              </div>

              {/* Bottom border on last item */}
              {i === features.length - 1 && (
                <div
                  className="h-px w-full"
                  style={{ background: "var(--border)" }}
                />
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
