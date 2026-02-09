"use client";

import { motion } from "motion/react";
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
  },
  {
    icon: Terminal,
    title: "Your Own Computer",
    description:
      "Your AI gets its own private machine. It can browse the web, manage files, and run tasks. Just like you would.",
  },
  {
    icon: Shield,
    title: "Always On",
    description:
      "Your AI works around the clock. It never takes a break, even while you sleep.",
  },
  {
    icon: Brain,
    title: "Skills & Memory",
    description:
      "It learns what you like, remembers past conversations, and picks up new abilities over time. The more you use it, the better it gets.",
  },
  {
    icon: CreditCard,
    title: "Simple Pricing",
    description:
      "One flat monthly price, everything included. No hidden fees, no surprises.",
  },
  {
    icon: Globe,
    title: "Power User Friendly",
    description:
      "Already have your own AI account? Connect it directly and save on costs.",
  },
  {
    icon: Fingerprint,
    title: "Human Verification",
    description:
      "Prove there's a real person behind your AI. Get a verified trust badge so others know your agent is legit.",
  },
];

export function Features() {
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
                <div>
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
