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
      "Early access to new features",
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
          <p className="text-sm sm:text-base max-w-[280px] sm:max-w-lg mx-auto mb-8" style={{ color: "var(--muted)" }}>
            Every plan includes a dedicated VM and full OpenClaw instance. Credits set your monthly usage — you configure the rest.
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
              style={glassStyle}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ delay: i * 0.15, duration: 0.6, ease: SNAPPY }}
            >
              <span
                className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
                style={{
                  ...glassStyle,
                  color: "var(--foreground)",
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
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M6 3l5 5-5 5" stroke="var(--foreground)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              {/* Channel logos */}
              <div className="flex items-center gap-3 mt-4 pt-4" style={{ borderTop: "1px solid var(--border)" }}>
                <span className="text-xs" style={{ color: "var(--muted)" }}>Channels:</span>
                <div className="flex gap-2.5">
                  {[
                    { label: "Telegram", color: "#229ED9", path: "M5.432 11.873l8.772-4.456c.408-.185 1.764-.734 1.764-.734s.629-.245.577.349c-.017.245-.157 1.105-.297 2.04l-.856 5.478s-.07.803-.663.943-.983-.314-.983-.314l-2.19-1.4-1.088-.698s-.455-.314.035-.524c0 0 2.627-2.354 2.697-2.634.07-.28-.21-.07-.21-.07l-3.62 2.285-1.483.035s-.437-.157-.105-.455z" },
                    { label: "Discord", color: "#5865F2", path: "M16.226 8.096a10.618 10.618 0 00-2.627-.815.04.04 0 00-.042.02c-.113.201-.239.463-.327.669a9.81 9.81 0 00-2.46 0 6.403 6.403 0 00-.332-.67.041.041 0 00-.042-.019c-.92.159-1.8.44-2.627.815a.037.037 0 00-.017.015C6.016 10.59 5.55 13.012 5.78 15.403a.044.044 0 00.017.03 10.68 10.68 0 003.216 1.626.041.041 0 00.045-.015c.248-.339.469-.696.658-1.07a.04.04 0 00-.022-.056 7.035 7.035 0 01-1.005-.479.041.041 0 01-.004-.068c.068-.05.135-.103.199-.156a.04.04 0 01.041-.005 7.632 7.632 0 006.55 0 .039.039 0 01.042.004c.064.054.131.106.2.157a.041.041 0 01-.004.068c-.32.187-.656.346-1.005.478a.041.041 0 00-.021.057c.193.374.414.73.657 1.07a.04.04 0 00.045.015 10.644 10.644 0 003.22-1.627.041.041 0 00.016-.029c.274-2.833-.459-5.233-1.942-7.392a.032.032 0 00-.017-.015zM9.684 14.223c-.64 0-1.168-.587-1.168-1.308 0-.722.517-1.309 1.168-1.309.656 0 1.18.593 1.168 1.309 0 .721-.517 1.308-1.168 1.308zm4.316 0c-.64 0-1.168-.587-1.168-1.308 0-.722.517-1.309 1.168-1.309.656 0 1.18.593 1.168 1.309 0 .721-.512 1.308-1.168 1.308z" },
                    { label: "WhatsApp", color: "#25D366", path: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" },
                  ].map((ch) => (
                    <div
                      key={ch.label}
                      className="w-8 h-8 rounded-full flex items-center justify-center"
                      style={glassStyle}
                    >
                      <svg width="30" height="30" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d={ch.path} fill={ch.color} />
                      </svg>
                    </div>
                  ))}
                  {/* Slack - multi-color */}
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center"
                    style={glassStyle}
                  >
                    <svg width="30" height="30" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path d="M8.843 13.2a1.029 1.029 0 01-1.029 1.028A1.029 1.029 0 016.786 13.2a1.029 1.029 0 011.028-1.029h1.029v1.029zm.514 0a1.029 1.029 0 011.029-1.029 1.029 1.029 0 011.028 1.029v2.571a1.029 1.029 0 01-1.028 1.029 1.029 1.029 0 01-1.029-1.029V13.2z" fill="#E01E5A" />
                      <path d="M10.386 8.843a1.029 1.029 0 01-1.029-1.029A1.029 1.029 0 0110.386 6.786a1.029 1.029 0 011.028 1.028v1.029h-1.028zm0 .514a1.029 1.029 0 011.028 1.029 1.029 1.029 0 01-1.028 1.028H7.814a1.029 1.029 0 01-1.028-1.028 1.029 1.029 0 011.028-1.029h2.572z" fill="#36C5F0" />
                      <path d="M14.743 9.357a1.029 1.029 0 011.028-1.028 1.029 1.029 0 011.029 1.028 1.029 1.029 0 01-1.029 1.029h-1.028V9.357zm-.515 0a1.029 1.029 0 01-1.028 1.029 1.029 1.029 0 01-1.029-1.029V6.786a1.029 1.029 0 011.029-1.029 1.029 1.029 0 011.028 1.029v2.571z" fill="#2EB67D" />
                      <path d="M13.2 14.743a1.029 1.029 0 011.028 1.028 1.029 1.029 0 01-1.028 1.029 1.029 1.029 0 01-1.029-1.029v-1.028H13.2zm0-.515a1.029 1.029 0 01-1.029-1.028 1.029 1.029 0 011.029-1.029h2.571a1.029 1.029 0 011.029 1.029 1.029 1.029 0 01-1.029 1.028H13.2z" fill="#ECB22E" />
                    </svg>
                  </div>
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
          <a
            href="https://openclaw.ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-2 rounded-full hover:opacity-80 transition-opacity"
            style={glassStyle}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="OpenClaw" className="w-4 h-4" style={{ imageRendering: "pixelated" }} />
            <span className="text-xs" style={{ color: "var(--foreground)" }}>Powered by</span>
            <span className="text-xs font-semibold" style={{ color: "var(--foreground)" }}>OpenClaw</span>
          </a>
        </motion.div>

        {/* BYOK note */}
        <motion.div
          className="text-center mt-8 space-y-2"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.5, duration: 0.6, ease: SNAPPY }}
        >
          <p className="text-sm max-w-[260px] sm:max-w-none mx-auto" style={{ color: "var(--muted)" }}>
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
