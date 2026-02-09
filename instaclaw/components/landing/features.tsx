"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Zap,
  Terminal,
  Shield,
  Brain,
  CreditCard,
  Globe,
  Fingerprint,
} from "lucide-react";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

const features = [
  {
    icon: Zap,
    title: "Instant Deployment",
    description:
      "Sign up and your AI is ready to go. No technical setup, no waiting.",
    tech: "Your dedicated cloud instance is provisioned automatically on signup. The full OpenClaw runtime, pre-configured skills, and messaging integrations are ready in under two minutes — no SSH, no CLI, no Docker.",
  },
  {
    icon: Terminal,
    title: "Your Own Computer",
    description:
      "Your AI gets its own private machine. It can browse the web, manage files, and run tasks. Just like you would.",
    tech: "A dedicated Ubuntu VM with full bash shell execution, Python/Node runtimes, headless browser, file I/O, and the ability to install any software. Not a shared container — an isolated cloud instance with its own firewall, storage, and compute resources.",
  },
  {
    icon: Shield,
    title: "Always On",
    description:
      "Your AI works around the clock. It never takes a break, even while you sleep.",
    tech: "Cron-based task scheduling lets your agent run jobs on any schedule. Background services persist across sessions. Your VM stays live 24/7 with automatic health monitoring and restart — no cold starts, no spin-down timeouts.",
  },
  {
    icon: Brain,
    title: "Skills & Memory",
    description:
      "It learns what you like, remembers past conversations, and picks up new abilities over time. The more you use it, the better it gets.",
    tech: "Persistent long-term memory across all conversations. Skills are MCP tool servers and OpenClaw skill packages — pre-installed from our curated library, or taught by you via chat and saved as reusable workflows. The skill system supports versioning with automatic updates.",
  },
  {
    icon: CreditCard,
    title: "Simple Pricing",
    description:
      "One flat monthly price, everything included. No hidden fees, no surprises.",
    tech: "Credits map roughly to AI token usage. A simple message uses 1–3 credits; a complex multi-step task (web research, code execution, file management) uses 10–50. BYOK users bypass credits entirely and pay Anthropic directly based on their own API usage.",
  },
  {
    icon: Globe,
    title: "Power User Friendly",
    description:
      "Already have your own AI account? Connect it directly and save on costs.",
    tech: "BYOK (Bring Your Own Key) mode lets you connect your Anthropic API key directly. Your key is encrypted at rest (AES-256) and stored on your VM only. All API calls go directly from your VM to Anthropic — never proxied. Choose any Claude model (Sonnet, Opus, Haiku) and configure rate limits, token budgets, and system prompts.",
  },
  {
    icon: Fingerprint,
    title: "Human Verification",
    description:
      "Prove there's a real person behind your AI. Get a verified trust badge so others know your agent is legit.",
    tech: "Identity verification links your agent to a real human operator. Verified agents receive a trust badge visible to other users and services, reducing spam and building trust in multi-agent interactions across the OpenClaw ecosystem.",
  },
];

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
            Effortlessly Simple
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
                    {feature.description}
                  </p>

                  {/* Technical details toggle */}
                  {feature.tech && (
                    <div className="mt-2.5">
                      <button
                        onClick={() =>
                          setOpenTech(openTech === i ? null : i)
                        }
                        className="inline-flex items-center gap-1.5 text-xs cursor-pointer transition-colors"
                        style={{ color: "var(--accent)" }}
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
                              style={{ color: "#999" }}
                            >
                              {feature.tech}
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
