"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

const steps = [
  {
    number: "1",
    title: "Sign Up",
    description:
      "Join the waitlist and grab your invite. Takes about 30 seconds.",
    tech: "Invites are distributed in waves via our waitlist. Once activated, your account automatically provisions a dedicated cloud instance with the full OpenClaw runtime pre-installed.",
  },
  {
    number: "2",
    title: "Connect",
    description:
      "Link your Telegram, Discord, Slack, or WhatsApp. Pick a plan. No coding, no configuration. That's the whole setup.",
    tech: "OAuth-based bot linking for all supported platforms. Plan selection configures credit allocation and optional BYOK (Bring Your Own Key) mode for direct Anthropic API access with your choice of Claude model.",
  },
  {
    number: "3",
    title: "You're Live",
    description:
      "Your personal AI launches on its own dedicated machine with real computing power, persistent memory, and pre-loaded skills. It starts working immediately and gets smarter every day.",
    tech: "A dedicated Ubuntu VM spins up with full SSH access, shell execution, Python/Node runtimes, MCP tool servers, cron scheduling, and persistent memory across conversations. You can install any software, run background services, and extend the agent however you want.",
  },
];

export function HowItWorks() {
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
            How It Works
          </h2>
        </motion.div>

        {/* Clean-line vertical steps — no cards.
            Per-step wrapper is a plain div (NOT motion.div). The hero work
            (2026-05-24) established that opacity AND transform on an
            ancestor of a backdrop-filter surface produce a visible darker→
            lighter snap when the entrance animation settles. The numbered
            orb here is a glass circle, so the wrapper can't animate either. */}
        <div className="space-y-0">
          {steps.map((step, i) => (
            <div key={step.number} className="relative">
              {/* Top border line */}
              <div
                className="h-px w-full"
                style={{ background: "var(--border)" }}
              />

              <div className="flex gap-6 sm:gap-10 py-10 sm:py-14 items-start">
                {/* Step number in neutral liquid-glass circle.
                    3-element architecture mirroring .liquid-glass-pill —
                    root (refraction substrate + isolation) + surface
                    (sheen + conic rim) + sibling shadow proxy. Diameter
                    set by tailwind w-12 h-12 / sm:w-14 sm:h-14. */}
                <span className="liquid-glass-circle-root shrink-0 mt-1 w-12 h-12 sm:w-14 sm:h-14">
                  <span className="liquid-glass-circle">
                    <span
                      className="text-xl sm:text-2xl font-medium tracking-[-0.5px]"
                      style={{
                        fontFamily: "var(--font-serif)",
                        color: "var(--foreground)",
                      }}
                    >
                      {step.number}
                    </span>
                  </span>
                  <div aria-hidden="true" className="liquid-glass-circle-shadow"></div>
                </span>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <h3
                    className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-3"
                    style={{ fontFamily: "var(--font-serif)" }}
                  >
                    {step.title}
                  </h3>
                  <p
                    className="text-base leading-relaxed max-w-md"
                    style={{ color: "var(--muted)" }}
                  >
                    {step.description}
                  </p>

                  {/* Technical details toggle */}
                  {step.tech && (
                    <div className="mt-3">
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
                              {step.tech}
                            </p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </div>
              </div>

              {/* Bottom border on last item */}
              {i === steps.length - 1 && (
                <div
                  className="h-px w-full"
                  style={{ background: "var(--border)" }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
