"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

const steps = [
  {
    number: "1",
    title: "Sign Up",
    description:
      "Sign in with Google. We spin up a server for you. About thirty seconds.",
    tech: "Signing in provisions a dedicated Ubuntu VM tied to your account (2 vCPU, 4GB RAM, 80GB disk) on Linode, with the OpenClaw runtime pre-installed. The machine is yours alone, not a shared inference service like ChatGPT or Claude.",
  },
  {
    number: "2",
    title: "Connect",
    description:
      "Connect Telegram, Discord, or iMessage. Pick your Claude model. No coding, no configuration. Your agent now has a body.",
    tech: "You connect by pasting a bot token from BotFather (Telegram), the Developer Portal (Discord), or by linking iMessage during setup. Plan selection sets your monthly credit allocation and default Claude model. BYOK mode routes through your own Anthropic API key for direct billing if you prefer.",
  },
  {
    number: "3",
    title: "You're Live",
    description:
      "Your agent goes to work on its own machine. Real browser, real wallet, working while you sleep. Skills and memory are the floor, not the ceiling. The chat window is the smallest part of what it does.",
    tech: "Your VM has full SSH access, shell execution, Python and Node runtimes, MCP tool servers for skills, cron scheduling, and persistent memory that survives every conversation. The agent runs 24/7 even when you're offline. You can install software, run background services, and extend the agent however you want.",
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
                {/* Step number in liquid-glass orb — same wabi recipe
                    as .liquid-glass-pill (refraction substrate + sheen
                    + conic rim + 4-layer box-shadow + sibling masked-
                    ring shadow), border-radius: 50%. Diameter set by
                    tailwind w-12 h-12 / sm:w-14 sm:h-14. */}
                <span className="liquid-glass-orb-root shrink-0 mt-1 w-12 h-12 sm:w-14 sm:h-14">
                  <span className="liquid-glass-orb">
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
                  <div aria-hidden="true" className="liquid-glass-orb-shadow"></div>
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

                  {/* Technical details toggle.
                      Cooper 2026-05-25: was var(--accent) orange,
                      moved to var(--muted) gray so it reads as a
                      standard supporting disclosure, not a primary
                      CTA. Triangle inherits color (gray too). The
                      expanded text matches the toggle color so the
                      whole disclosure feels like one continuous
                      muted aside. hover:opacity-70 provides the
                      subtle interactive cue. */}
                  {step.tech && (
                    <div className="mt-3">
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
