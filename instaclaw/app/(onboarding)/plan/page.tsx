"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { LenisProvider } from "@/components/landing/lenis-provider";

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

const tiers = [
  {
    id: "starter" as const,
    name: "Starter",
    allInclusive: 29,
    byok: 14,
    description: "Perfect for getting started",
    dailyUnits: 400,
    features: [
      "Always-on AI that works while you sleep",
      "Learns your preferences over time",
      "Connect Telegram, Discord & more",
    ],
    byokFeatures: [
      "Always-on AI that works while you sleep",
      "Learns your preferences over time",
      "Unlimited usage with your API key",
    ],
    trial: true,
  },
  {
    id: "pro" as const,
    name: "Pro",
    allInclusive: 99,
    byok: 39,
    description: "For everyday use",
    dailyUnits: 700,
    features: [
      "Nearly 2x more daily AI capacity",
      "Handles complex, multi-step tasks",
      "Priority support when you need it",
    ],
    byokFeatures: [
      "Faster VM for quicker responses",
      "Handles complex, multi-step tasks",
      "Priority support when you need it",
    ],
    popular: true,
    trial: true,
  },
  {
    id: "power" as const,
    name: "Power",
    allInclusive: 299,
    byok: 99,
    description: "For heavy workflows",
    dailyUnits: 2500,
    features: [
      "Over 6x capacity for power users",
      "Run multiple tasks at once",
      "Dedicated 1-on-1 support",
    ],
    byokFeatures: [
      "Top-tier speed and performance",
      "Run multiple tasks at once",
      "Dedicated 1-on-1 support",
    ],
    trial: true,
  },
];

export default function PlanPage() {
  const router = useRouter();
  const [selectedTier, setSelectedTier] = useState<string>("pro");
  const [apiMode, setApiMode] = useState<"all_inclusive" | "byok">(
    "all_inclusive"
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const stored = sessionStorage.getItem("instaclaw_onboarding");
    if (!stored) {
      router.push("/connect");
      return;
    }
    const data = JSON.parse(stored);
    setApiMode(data.apiMode ?? "all_inclusive");
  }, [router]);

  function handleToggleApiMode() {
    const newMode = apiMode === "all_inclusive" ? "byok" : "all_inclusive";
    setApiMode(newMode);

    const stored = sessionStorage.getItem("instaclaw_onboarding");
    if (stored) {
      const data = JSON.parse(stored);
      data.apiMode = newMode;
      sessionStorage.setItem("instaclaw_onboarding", JSON.stringify(data));
    }
  }

  async function handleCheckout() {
    setLoading(true);
    setError("");

    const stored = sessionStorage.getItem("instaclaw_onboarding");
    if (stored) {
      const data = JSON.parse(stored);
      data.tier = selectedTier;
      data.apiMode = apiMode;
      sessionStorage.setItem("instaclaw_onboarding", JSON.stringify(data));
    }

    try {
      const onboarding = JSON.parse(
        sessionStorage.getItem("instaclaw_onboarding") ?? "{}"
      );

      const saveRes = await fetch("/api/onboarding/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: onboarding.botToken,
          discordToken: onboarding.discordToken,
          slackToken: onboarding.slackToken,
          slackSigningSecret: onboarding.slackSigningSecret,
          whatsappToken: onboarding.whatsappToken,
          whatsappPhoneNumberId: onboarding.whatsappPhoneNumberId,
          channels: onboarding.channels,
          apiMode,
          apiKey: onboarding.apiKey,
          model: onboarding.model,
          tier: selectedTier,
        }),
      });

      if (!saveRes.ok) {
        const err = await saveRes.json();
        setLoading(false);
        setError(err.error || "Failed to save configuration. Please try again.");
        return;
      }
    } catch {
      setLoading(false);
      setError("Network error saving configuration. Please try again.");
      return;
    }

    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: selectedTier,
          apiMode,
          trial: true,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setLoading(false);
        setError(err.error || `Checkout failed (${res.status}). Please try again or contact support.`);
        return;
      }

      const data = await res.json();

      if (data.url) {
        // Small delay to ensure the user sees the loading state
        // Then redirect to Stripe checkout
        setTimeout(() => {
          window.location.href = data.url;
        }, 500);
      } else {
        setLoading(false);
        setError("Stripe checkout URL not received. Please try again or contact support.");
      }
    } catch (err) {
      setLoading(false);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setError(`Network error creating checkout: ${errorMsg}. Please check your connection and try again.`);
    }
  }

  return (
    <LenisProvider>
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
          <div className="max-w-5xl mx-auto px-6">
            <div className="flex items-center justify-center gap-2">
              {[
                { num: 1, label: "Connect" },
                { num: 2, label: "Plan" },
                { num: 3, label: "Deploy" },
              ].map((step, i) => (
                <div key={step.num} className="flex items-center">
                  <div className="flex flex-col items-center">
                    {step.num === 2 ? (
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
                        <span
                          className="absolute inset-0 rounded-full"
                          style={{
                            background: "linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0.4) 55%, transparent 80%)",
                            backgroundSize: "300% 100%",
                            animation: "globe-shimmer 4s linear infinite",
                          }}
                        />
                        <span
                          className="absolute top-[3px] left-[5px] w-[14px] h-[8px] rounded-full pointer-events-none"
                          style={{
                            background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
                          }}
                        />
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
                    ) : step.num < 2 ? (
                      /* Completed step — green glass orb */
                      <span
                        className="relative flex items-center justify-center w-10 h-10 rounded-full text-sm font-semibold overflow-hidden"
                        style={{
                          background: "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.6), rgba(34,197,94,0.35) 50%, rgba(22,163,74,0.7) 100%)",
                          boxShadow: "rgba(34,197,94,0.3) 0px 2px 8px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
                          color: "#ffffff",
                        }}
                      >
                        <span
                          className="absolute inset-0 rounded-full pointer-events-none"
                          style={{
                            background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
                          }}
                        />
                        <span className="relative">✓</span>
                      </span>
                    ) : (
                      /* Future step — glass orb */
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
                      style={{ color: step.num === 2 ? "#333334" : "#999999" }}
                    >
                      {step.label}
                    </span>
                  </div>
                  {i < 2 && (
                    <div
                      className="w-16 mx-3 mb-5 rounded-full overflow-hidden"
                      style={{
                        height: step.num < 2 ? "2px" : "3px",
                        background: step.num < 2 ? "#22c55e" : "rgba(0, 0, 0, 0.06)",
                      }}
                    >
                      {step.num === 2 && (
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

        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="text-center mb-8">
          <h1
            className="text-4xl font-normal mb-4"
            style={{
              fontFamily: "var(--font-serif)",
              color: "#333334",
            }}
          >
            Choose Your Plan
          </h1>
          {/* Mobile: just the highlight */}
          <p className="text-base sm:hidden" style={{ color: "#666666", textWrap: "balance" }}>
            An AI that never sleeps, never forgets, and gets smarter every day - working{" "}
            <span className="relative inline-block">
              <span className="absolute inset-0 -mx-1 -my-0.5 rounded" style={{ background: "#fef08a" }} />
              <span className="relative">just for you</span>
            </span>
            .
          </p>
          {/* Desktop: all three effects with sequential animation */}
          <p className="text-base hidden sm:block" style={{ color: "#666666" }}>
            An AI that{" "}
            <span className="relative inline-block">
              never sleeps
              <motion.span
                className="absolute pointer-events-none left-0 bottom-0"
                style={{
                  height: "5px",
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='6' viewBox='0 0 20 6'%3E%3Cpath d='M0,3 Q5,0.5 10,3 Q15,5.5 20,3' fill='none' stroke='%23DC6743' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E")`,
                  backgroundRepeat: "repeat-x",
                  backgroundSize: "20px 5px",
                  transformOrigin: "left center",
                }}
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: "100%", opacity: 0.85 }}
                transition={{ delay: 0.5, duration: 0.6, ease: "easeOut" }}
              />
            </span>{", "}
            never forgets, and{" "}
            <span className="relative inline-block">
              <motion.svg
                className="absolute pointer-events-none"
                style={{
                  left: "-10px",
                  top: "-5px",
                  width: "calc(100% + 20px)",
                  height: "calc(100% + 10px)",
                }}
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 200 100"
                preserveAspectRatio="none"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.5 }}
                transition={{ delay: 1.1, duration: 0.1 }}
              >
                <motion.path
                  d="M8,50 Q10,16 55,13 Q120,10 170,20 Q192,35 190,55 Q188,78 150,86 Q100,92 40,84 Q6,74 8,50"
                  fill="none"
                  stroke="#333334"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ delay: 1.1, duration: 0.7, ease: "easeOut" }}
                />
              </motion.svg>
              <span className="relative">gets smarter every day</span>
            </span>
            {" "}- working{" "}
            <span className="relative inline-block">
              <motion.span
                className="absolute inset-0 -mx-1 -my-0.5 rounded"
                style={{ background: "#fef08a" }}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 1.8, duration: 0.4, ease: "easeOut" }}
              />
              <span className="relative">just for you</span>
            </span>
            .
          </p>

          {/* BYOK toggle */}
          <div
            className="inline-flex items-center gap-3 text-sm mt-6 px-6 py-2.5 rounded-full"
            style={glassStyle}
          >
            <span
              className="font-medium"
              style={{ color: apiMode === "byok" ? "#999999" : "#333334" }}
            >
              All-Inclusive
            </span>
            <button
              type="button"
              onClick={handleToggleApiMode}
              className="relative w-12 h-6 rounded-full transition-all cursor-pointer"
              style={{
                background: "linear-gradient(-75deg, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.1))",
                boxShadow: `
                  rgba(0, 0, 0, 0.15) 0px 1px 2px 0px inset,
                  rgba(255, 255, 255, 0.1) 0px -1px 1px 0px inset
                `,
              }}
            >
              <motion.span
                className="absolute top-1 w-4 h-4 rounded-full"
                style={{
                  background: apiMode === "byok"
                    ? "linear-gradient(-75deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 1), rgba(255, 255, 255, 0.9))"
                    : "linear-gradient(-75deg, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.8))",
                  boxShadow: `
                    rgba(0, 0, 0, 0.1) 0px 1px 3px 0px,
                    rgba(255, 255, 255, 0.4) 0px -1px 1px 0px inset,
                    rgba(0, 0, 0, 0.05) 0px 1px 1px 0px inset
                  `,
                  backdropFilter: "blur(4px)",
                  WebkitBackdropFilter: "blur(4px)",
                }}
                animate={{ left: apiMode === "byok" ? "28px" : "4px" }}
                transition={{ type: "spring", stiffness: 500, damping: 25 }}
              />
            </button>
            <span
              className="font-medium"
              style={{ color: apiMode === "byok" ? "#333334" : "#999999" }}
            >
              BYOK
            </span>
          </div>
          {apiMode === "byok" && (
            <p className="text-xs mt-3" style={{ color: "#666666" }}>
              Bring Your Own Anthropic API Key — lower monthly cost, you pay Anthropic directly.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
          {tiers.map((tier) => {
            const price = apiMode === "byok" ? tier.byok : tier.allInclusive;
            const isSelected = selectedTier === tier.id;

            const cardContent = (
              <div className="text-left relative rounded-lg p-6" style={{ background: "#ffffff" }}>
                {tier.popular && (
                  <div className="flex justify-center mb-4">
                    <span
                      className="inline-block px-3 py-1 rounded-full text-xs font-semibold"
                      style={{
                        background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                        boxShadow: "rgba(255,255,255,0.2) 0px 1px 1px 0px inset, rgba(255,255,255,0.25) 0px -1px 1px 0px inset, rgba(220,103,67,0.3) 0px 2px 8px 0px",
                        color: "#ffffff",
                      }}
                    >
                      Popular
                    </span>
                  </div>
                )}
                {tier.trial && (
                  <div
                    className="text-xs mb-4 pb-4"
                    style={{
                      color: "#666666",
                      borderBottom: "1px solid #F0F0F0",
                    }}
                  >
                    3-Day Free Trial
                  </div>
                )}

                <div className="mb-4">
                  <h3
                    className="text-xl font-normal mb-1"
                    style={{
                      fontFamily: "var(--font-serif)",
                      color: "#333334",
                    }}
                  >
                    {tier.name}
                  </h3>
                  <p className="text-xs" style={{ color: "#666666" }}>
                    {tier.description}
                  </p>
                </div>

                <div className="mb-6">
                  <div className="flex items-baseline">
                    <span
                      className="text-4xl font-normal"
                      style={{
                        fontFamily: "var(--font-serif)",
                        color: isSelected ? "#DC6743" : "#333334",
                      }}
                    >
                      ${price}
                    </span>
                    <span className="text-sm ml-1" style={{ color: "#666666" }}>
                      /mo
                    </span>
                  </div>
                  {tier.trial && (
                    <p className="text-xs mt-1" style={{ color: "#999999" }}>
                      Free for 3 days
                    </p>
                  )}
                </div>

                {apiMode === "all_inclusive" ? (
                  <div
                    className="mb-4 py-2.5 px-3 rounded-md"
                    style={{
                      ...glassStyle,
                    }}
                  >
                    <p className="text-xs font-semibold" style={{ color: "#DC6743" }}>
                      {tier.dailyUnits.toLocaleString()} units/day
                    </p>
                    <p className="text-[10px] mt-0.5" style={{ color: "#999" }}>
                      ~{tier.dailyUnits.toLocaleString()} Haiku or ~{Math.floor(tier.dailyUnits / 4)} Sonnet messages
                    </p>
                  </div>
                ) : (
                  <div
                    className="mb-4 py-2.5 px-3 rounded-md"
                    style={{
                      ...glassStyle,
                    }}
                  >
                    <p className="text-xs font-semibold" style={{ color: "#333334" }}>
                      Unlimited usage
                    </p>
                    <p className="text-[10px] mt-0.5" style={{ color: "#999" }}>
                      Pay Anthropic directly for what you use
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  {(apiMode === "byok" ? tier.byokFeatures : tier.features).map((f) => (
                    <div
                      key={f}
                      className="text-xs flex items-start"
                      style={{ color: "#666666" }}
                    >
                      <span className="mr-2" style={{ color: "#DC6743" }}>
                        ✓
                      </span>
                      <span>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            );

            return (
              <button
                key={tier.id}
                type="button"
                onClick={() => setSelectedTier(tier.id)}
                className="transition-all cursor-pointer"
                style={{
                  border: "none",
                  background: "transparent",
                  padding: 0,
                }}
              >
                {isSelected ? (
                  <div className="glow-wrap" style={{ borderRadius: "0.5rem" }}>
                    <div className="glow-border" style={{ borderRadius: "0.5rem" }}>
                      <div className="glow-spinner" />
                      <div className="glow-content" style={{ borderRadius: "calc(0.5rem - 1.5px)" }}>
                        {cardContent}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    className="rounded-lg transition-all"
                    style={{
                      border: "1px solid rgba(0, 0, 0, 0.1)",
                      boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
                    }}
                  >
                    {cardContent}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <p className="text-sm text-center mb-6" style={{ color: "#ef4444" }}>
            {error}
          </p>
        )}

        <button
          onClick={handleCheckout}
          disabled={loading}
          className="w-full px-6 py-4 rounded-lg font-semibold transition-all cursor-pointer disabled:opacity-50"
          style={{
            background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            boxShadow: `
              rgba(255,255,255,0.2) 0px 2px 2px 0px inset,
              rgba(255,255,255,0.3) 0px -1px 1px 0px inset,
              rgba(220,103,67,0.35) 0px 4px 16px 0px,
              rgba(255,255,255,0.08) 0px 0px 1.6px 4px inset
            `,
            color: "#ffffff",
            fontSize: "15px",
            letterSpacing: "0.01em",
          }}
        >
          {loading ? (
            <span className="flex items-center gap-2 justify-center">
              <svg
                className="animate-spin h-4 w-4"
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
              Creating checkout session...
            </span>
          ) : "Start Free Trial"}
        </button>
        </div>
      </div>
    </LenisProvider>
  );
}
