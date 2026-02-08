"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const tiers = [
  {
    id: "starter" as const,
    name: "Starter",
    allInclusive: 29,
    byok: 14,
    description: "Perfect for personal use",
    features: ["Full OpenClaw instance", "Dedicated VM", "Telegram integration"],
    trial: true,
  },
  {
    id: "pro" as const,
    name: "Pro",
    allInclusive: 79,
    byok: 39,
    description: "For power users",
    features: ["Everything in Starter", "More CPU & RAM", "Priority support"],
    popular: true,
    trial: true,
  },
  {
    id: "power" as const,
    name: "Power",
    allInclusive: 199,
    byok: 99,
    description: "Maximum performance",
    features: ["Everything in Pro", "Top-tier resources", "Dedicated support"],
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
      const data = await res.json();

      if (data.url) {
        window.location.href = data.url;
      } else {
        setLoading(false);
        setError(data.error || "Failed to create checkout session. Please try again.");
      }
    } catch {
      setLoading(false);
      setError("Network error creating checkout. Please try again.");
    }
  }

  return (
    <div className="min-h-screen" style={{ background: "#f8f7f4" }}>
      <div className="max-w-5xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h1
            className="text-4xl font-normal mb-4"
            style={{
              fontFamily: "var(--font-serif)",
              color: "#333334",
            }}
          >
            Choose Your Plan
          </h1>
          <p className="text-base" style={{ color: "#666666" }}>
            All plans include a full OpenClaw instance on a dedicated VM.
          </p>

          {/* BYOK toggle */}
          <div className="inline-flex items-center gap-3 text-sm mt-6">
            <span
              className="font-medium"
              style={{ color: apiMode === "byok" ? "#999999" : "#333334" }}
            >
              All-Inclusive
            </span>
            <button
              type="button"
              onClick={handleToggleApiMode}
              className="relative w-12 h-6 rounded-full transition-colors cursor-pointer"
              style={{
                background: apiMode === "byok" ? "#DC6743" : "#E5E5E5",
              }}
            >
              <span
                className="absolute top-1 w-4 h-4 rounded-full transition-all duration-200"
                style={{
                  background: "#ffffff",
                  left: apiMode === "byok" ? "28px" : "4px",
                }}
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

            return (
              <button
                key={tier.id}
                type="button"
                onClick={() => setSelectedTier(tier.id)}
                className="text-left transition-all cursor-pointer relative rounded-lg p-6"
                style={{
                  background: "#ffffff",
                  border: isSelected
                    ? "2px solid #DC6743"
                    : "1px solid rgba(0, 0, 0, 0.1)",
                  boxShadow: isSelected
                    ? "0 4px 12px rgba(220, 103, 67, 0.1)"
                    : "0 1px 3px rgba(0, 0, 0, 0.05)",
                }}
              >
                {tier.popular && (
                  <span
                    className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-semibold"
                    style={{ background: "#DC6743", color: "#ffffff" }}
                  >
                    Popular
                  </span>
                )}
                {tier.trial && (
                  <div
                    className="text-xs mb-4 pb-4"
                    style={{
                      color: "#666666",
                      borderBottom: "1px solid #F0F0F0",
                    }}
                  >
                    7-Day Free Trial
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
                      Free for 7 days
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  {tier.features.map((f) => (
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
            background: "#DC6743",
            color: "#ffffff",
            fontSize: "15px",
            letterSpacing: "0.01em",
          }}
        >
          {loading ? "Redirecting to checkout..." : "Start Free Trial"}
        </button>
      </div>
    </div>
  );
}
