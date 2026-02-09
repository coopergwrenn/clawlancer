"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { WaitlistForm } from "./waitlist-form";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

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
};

const tiers = [
  {
    name: "Starter",
    allInclusive: "$29",
    byok: "$14",
    description: "Perfect for personal use",
    features: [
      "Your own OpenClaw instance",
      "Dedicated VM",
      "All channels included",
      "1,000 credits/month",
    ],
    highlighted: false,
    badge: "7-Day Free Trial",
  },
  {
    name: "Pro",
    allInclusive: "$79",
    byok: "$39",
    description: "For power users",
    features: [
      "Everything in Starter",
      "5,000 credits/month",
      "Priority support",
    ],
    highlighted: true,
    badge: "Most Popular \u00B7 7-Day Free Trial",
  },
  {
    name: "Power",
    allInclusive: "$199",
    byok: "$99",
    description: "Maximum performance",
    features: [
      "Everything in Pro",
      "25,000 credits/month",
      "Upgraded server resources",
      "Dedicated support",
    ],
    highlighted: false,
    badge: "7-Day Free Trial",
  },
];

export function Pricing() {
  const [isByok, setIsByok] = useState(false);

  return (
    <section className="py-16 sm:py-[12vh] px-4">
      <div className="max-w-5xl mx-auto">
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
            Simple, Transparent Pricing
          </h2>
          <p style={{ color: "var(--muted)" }} className="mb-2">
            Every plan includes a full OpenClaw instance on a dedicated VM.
          </p>
          <p className="text-sm mb-8" style={{ color: "var(--muted)" }}>
            Credits determine how much your AI can do each month. You configure everything else.
          </p>

          {/* BYOK toggle */}
          <div
            className="inline-flex items-center gap-3 text-sm px-6 py-2.5 rounded-full"
            style={glassStyle}
          >
            <span style={{ color: isByok ? "var(--muted)" : "var(--foreground)" }}>
              All-Inclusive
            </span>
            <button
              onClick={() => setIsByok(!isByok)}
              className="relative w-12 h-6 rounded-full transition-all cursor-pointer"
              style={{
                background: "linear-gradient(-75deg, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.1))",
                boxShadow: `
                  rgba(0, 0, 0, 0.15) 0px 1px 2px 0px inset,
                  rgba(255, 255, 255, 0.1) 0px -1px 1px 0px inset
                `,
              }}
            >
              <span
                className="absolute top-1 w-4 h-4 rounded-full transition-all"
                style={{
                  background: isByok
                    ? "linear-gradient(-75deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 1), rgba(255, 255, 255, 0.9))"
                    : "linear-gradient(-75deg, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.8))",
                  boxShadow: `
                    rgba(0, 0, 0, 0.1) 0px 1px 3px 0px,
                    rgba(255, 255, 255, 0.4) 0px -1px 1px 0px inset,
                    rgba(0, 0, 0, 0.05) 0px 1px 1px 0px inset
                  `,
                  backdropFilter: "blur(4px)",
                  WebkitBackdropFilter: "blur(4px)",
                  left: isByok ? "28px" : "4px",
                }}
              />
            </button>
            <span style={{ color: isByok ? "var(--foreground)" : "var(--muted)" }}>
              BYOK
            </span>
          </div>
        </motion.div>

        <div className="grid gap-6 sm:grid-cols-3">
          {tiers.map((tier, i) => (
            <motion.div
              key={tier.name}
              className="rounded-xl p-8 relative"
              style={{
                ...glassStyle,
                ...(tier.highlighted
                  ? { border: "2px solid var(--accent)" }
                  : {}),
              }}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ delay: i * 0.15, duration: 0.6, ease: SNAPPY }}
            >
              <span
                className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
                style={{
                  background: "var(--accent)",
                  color: "#ffffff",
                }}
              >
                {tier.badge}
              </span>
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
                <p className="text-xs mt-1" style={{ color: "var(--accent)" }}>
                  Free for 7 days
                </p>
              </div>
              <ul className="space-y-3 text-sm">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2">
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: "var(--accent)" }}
                    />
                    {feature}
                  </li>
                ))}
              </ul>

              {/* Channel logos */}
              <div className="flex items-center gap-2 mt-4 pt-4" style={{ borderTop: "1px solid var(--border)" }}>
                <span className="text-xs" style={{ color: "var(--muted)" }}>Channels:</span>
                <div className="flex gap-1.5">
                  {/* Telegram */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {/* Discord */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M20.317 4.369A19.791 19.791 0 0015.362 3c-.213.378-.46.886-.63 1.285a18.36 18.36 0 00-5.464 0A12.685 12.685 0 008.638 3 19.776 19.776 0 003.683 4.37C.533 9.046-.327 13.58.103 18.057A19.906 19.906 0 006.07 21c.48-.65.905-1.34 1.272-2.065a12.876 12.876 0 01-2.005-.965c.168-.122.333-.25.492-.376a14.173 14.173 0 0012.142 0c.16.131.325.258.492.376a12.92 12.92 0 01-2.008.966c.367.725.792 1.415 1.272 2.064a19.852 19.852 0 005.97-2.942c.506-5.27-.86-9.764-3.38-13.689zM8.013 15.279c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.955 2.418-2.157 2.418zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" fill="currentColor" />
                  </svg>
                  {/* Slack */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 9H20M4 15H20M9 4V20M15 4V20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {/* WhatsApp */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M22 16.92V19.92C22 20.48 21.56 20.93 21 20.97C20.65 21 20.3 21 19.95 21C10.99 21 3.72 14.26 3.03 5.55C3 5.2 3 4.85 3 4.5C3 3.67 3.67 3 4.5 3H7.5C7.91 3 8.28 3.27 8.41 3.66L9.59 7.34C9.71 7.7 9.59 8.1 9.29 8.34L7.64 9.68C9.07 12.53 11.47 14.93 14.32 16.36L15.66 14.71C15.9 14.41 16.3 14.29 16.66 14.41L20.34 15.59C20.73 15.72 21 16.09 21 16.5L22 16.92Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Powered by OpenClaw badge */}
        <motion.div
          className="text-center mt-8"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4, duration: 0.6, ease: SNAPPY }}
        >
          <div
            className="inline-flex items-center gap-2 px-6 py-2 rounded-full"
            style={glassStyle}
          >
            <span className="text-xs" style={{ color: "var(--foreground)" }}>Powered by</span>
            <span className="text-xs font-semibold" style={{ color: "var(--foreground)" }}>OpenClaw</span>
          </div>
        </motion.div>

        {/* BYOK note */}
        <motion.div
          className="text-center mt-8 space-y-2"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.5, duration: 0.6, ease: SNAPPY }}
        >
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            BYOK = Bring Your Own Key. Use your Anthropic API key and pay less.
          </p>
        </motion.div>

        {/* Second waitlist form */}
        <motion.div
          id="waitlist"
          className="mt-16 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3, duration: 0.6, ease: SNAPPY }}
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
