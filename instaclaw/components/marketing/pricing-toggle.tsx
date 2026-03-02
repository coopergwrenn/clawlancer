"use client";

import { useState } from "react";
import Link from "next/link";

const tiers = [
  {
    name: "Starter",
    allInclusive: "$29",
    byok: "$14",
    description: "Perfect for personal use",
    features: [
      "600 daily units (Haiku = 1, Sonnet = 4, Opus = 19)",
      "All models included — Haiku, Sonnet & Opus",
      "Dedicated VM + all channels",
      "Switch models anytime via your bot",
    ],
    badge: "3-Day Free Trial",
  },
  {
    name: "Pro",
    allInclusive: "$99",
    byok: "$39",
    description: "For power users",
    features: [
      "1,000 daily units — nearly 2x Starter",
      "All models included — Haiku, Sonnet & Opus",
      "Priority support",
      "Early access to new features",
    ],
    highlighted: true,
    badge: "Most Popular \u00B7 3-Day Free Trial",
  },
  {
    name: "Power",
    allInclusive: "$299",
    byok: "$99",
    description: "Maximum performance",
    features: [
      "2,500 daily units — over 4x Starter",
      "All models included — Haiku, Sonnet & Opus",
      "Upgraded server resources",
      "Dedicated support",
    ],
    badge: "3-Day Free Trial",
  },
];

const glassStyle = {
  background:
    "linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow: `
    rgba(0,0,0,0.05) 0px 2px 2px 0px inset,
    rgba(255,255,255,0.5) 0px -2px 2px 0px inset,
    rgba(0,0,0,0.1) 0px 2px 4px 0px,
    rgba(255,255,255,0.2) 0px 0px 1.6px 4px inset
  `,
};

export function PricingToggle() {
  const [isByok, setIsByok] = useState(false);

  return (
    <div>
      {/* Toggle */}
      <div className="text-center mb-12">
        <div
          className="inline-flex items-center gap-3 text-sm px-6 py-2.5 rounded-full"
          style={glassStyle}
        >
          <span style={{ color: isByok ? "#6b6b6b" : "#333334" }}>
            All-Inclusive
          </span>
          <button
            onClick={() => setIsByok(!isByok)}
            className="relative w-12 h-6 rounded-full transition-all cursor-pointer"
            style={{
              background:
                "linear-gradient(-75deg, rgba(0,0,0,0.1), rgba(0,0,0,0.2), rgba(0,0,0,0.1))",
              boxShadow:
                "rgba(0,0,0,0.15) 0px 1px 2px 0px inset, rgba(255,255,255,0.1) 0px -1px 1px 0px inset",
            }}
          >
            <span
              className="absolute top-1 w-4 h-4 rounded-full transition-all"
              style={{
                background: "rgba(255,255,255,0.95)",
                boxShadow: "rgba(0,0,0,0.1) 0px 1px 3px 0px",
                left: isByok ? "28px" : "4px",
              }}
            />
          </button>
          <span style={{ color: isByok ? "#333334" : "#6b6b6b" }}>BYOK</span>
        </div>
        <p className="text-xs mt-3" style={{ color: "#6b6b6b" }}>
          BYOK = Bring Your Own Key. Use your Anthropic API key and pay less.
        </p>
      </div>

      {/* Cards */}
      <div className="grid gap-6 sm:grid-cols-3">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className="rounded-xl p-8 relative"
            style={glassStyle}
          >
            <span
              className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
              style={{ ...glassStyle, color: "#333334" }}
            >
              {tier.badge}
            </span>
            <h3 className="text-lg font-semibold mb-1" style={{ color: "#333334" }}>
              {tier.name}
            </h3>
            <p className="text-xs mb-4" style={{ color: "#6b6b6b" }}>
              {tier.description}
            </p>
            <div className="mb-6">
              <span className="text-4xl font-bold" style={{ color: "#333334" }}>
                {isByok ? tier.byok : tier.allInclusive}
              </span>
              <span className="text-sm" style={{ color: "#6b6b6b" }}>
                /mo
              </span>
              <p className="text-xs mt-1" style={{ color: "#DC6743" }}>
                Free for 3 days
              </p>
            </div>
            <ul className="space-y-3 text-sm" style={{ color: "#333334" }}>
              {tier.features.map((feature) => (
                <li key={feature} className="flex items-center gap-2">
                  <svg
                    className="w-3.5 h-3.5 shrink-0"
                    viewBox="0 0 16 16"
                    fill="none"
                  >
                    <path
                      d="M6 3l5 5-5 5"
                      stroke="#333334"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity="0.45"
                    />
                  </svg>
                  {feature}
                </li>
              ))}
            </ul>
            <div className="mt-6">
              <Link
                href="/signup"
                className="block text-center py-2.5 rounded-lg text-sm font-medium transition-all"
                style={{
                  background: tier.highlighted ? "#DC6743" : "rgba(0,0,0,0.05)",
                  color: tier.highlighted ? "#fff" : "#333334",
                }}
              >
                Start Free Trial
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
