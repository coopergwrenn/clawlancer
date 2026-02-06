"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { WaitlistForm } from "./waitlist-form";

const tiers = [
  {
    name: "Starter",
    allInclusive: "$19",
    byok: "$9",
    description: "Perfect for personal use",
    features: ["Full OpenClaw instance", "Dedicated VM", "Telegram integration", "Basic server resources"],
    highlighted: false,
  },
  {
    name: "Pro",
    allInclusive: "$39",
    byok: "$19",
    description: "For power users",
    features: ["Everything in Starter", "More CPU & RAM", "Priority support", "Faster response times"],
    highlighted: true,
  },
  {
    name: "Power",
    allInclusive: "$79",
    byok: "$39",
    description: "Maximum performance",
    features: ["Everything in Pro", "Top-tier resources", "Custom configurations", "Dedicated support"],
    highlighted: false,
  },
];

export function Pricing() {
  const [isByok, setIsByok] = useState(false);

  return (
    <section className="py-24 px-4">
      <div className="max-w-5xl mx-auto">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            Simple, Transparent Pricing
          </h2>
          <p style={{ color: "var(--muted)" }} className="mb-8">
            Every plan includes a full OpenClaw instance on a dedicated VM.
          </p>

          {/* BYOK toggle */}
          <div className="inline-flex items-center gap-3 text-sm">
            <span style={{ color: isByok ? "var(--muted)" : "#ffffff" }}>
              All-Inclusive
            </span>
            <button
              onClick={() => setIsByok(!isByok)}
              className="relative w-12 h-6 rounded-full transition-colors cursor-pointer"
              style={{
                background: isByok ? "#ffffff" : "rgba(255, 255, 255, 0.2)",
              }}
            >
              <span
                className="absolute top-1 w-4 h-4 rounded-full transition-transform"
                style={{
                  background: isByok ? "#000000" : "#ffffff",
                  left: isByok ? "28px" : "4px",
                }}
              />
            </button>
            <span style={{ color: isByok ? "#ffffff" : "var(--muted)" }}>
              BYOK
            </span>
          </div>
        </motion.div>

        <div className="grid gap-6 sm:grid-cols-3">
          {tiers.map((tier, i) => (
            <motion.div
              key={tier.name}
              className="glass rounded-xl p-8 relative"
              style={
                tier.highlighted
                  ? {
                      border: "1px solid rgba(255, 255, 255, 0.4)",
                      boxShadow: "0 0 40px rgba(255, 255, 255, 0.08)",
                    }
                  : undefined
              }
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ delay: i * 0.15, duration: 0.6 }}
            >
              {tier.highlighted && (
                <span
                  className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-xs font-semibold"
                  style={{
                    background: "#ffffff",
                    color: "#000000",
                  }}
                >
                  Most Popular
                </span>
              )}
              <h3 className="text-lg font-semibold mb-1">{tier.name}</h3>
              <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
                {tier.description}
              </p>
              <div className="mb-6">
                <span className="text-4xl font-bold">
                  {isByok ? tier.byok : tier.allInclusive}
                </span>
                <span
                  className="text-sm"
                  style={{ color: "var(--muted)" }}
                >
                  /mo
                </span>
              </div>
              <ul className="space-y-3 text-sm">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2">
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: "#ffffff" }}
                    />
                    {feature}
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>

        {/* BYOK note */}
        <motion.div
          className="text-center mt-8 space-y-2"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.5, duration: 0.6 }}
        >
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            BYOK = Bring Your Own Key. Use your Anthropic API key and pay less.
          </p>
        </motion.div>

        {/* Second waitlist form */}
        <motion.div
          className="mt-16 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3, duration: 0.6 }}
        >
          <p className="text-lg font-medium mb-4">
            Ready to get started?
          </p>
          <WaitlistForm />
        </motion.div>
      </div>
    </section>
  );
}
