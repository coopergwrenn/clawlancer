"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const tiers = [
  {
    id: "starter" as const,
    name: "Starter",
    allInclusive: 19,
    byok: 9,
    description: "Perfect for personal use",
    features: ["Full OpenClaw instance", "Dedicated VM", "Telegram integration"],
  },
  {
    id: "pro" as const,
    name: "Pro",
    allInclusive: 39,
    byok: 19,
    description: "For power users",
    features: ["Everything in Starter", "More CPU & RAM", "Priority support"],
    popular: true,
  },
  {
    id: "power" as const,
    name: "Power",
    allInclusive: 79,
    byok: 39,
    description: "Maximum performance",
    features: ["Everything in Pro", "Top-tier resources", "Dedicated support"],
  },
];

export default function PlanPage() {
  const router = useRouter();
  const [selectedTier, setSelectedTier] = useState<string>("pro");
  const [apiMode, setApiMode] = useState<"all_inclusive" | "byok">(
    "all_inclusive"
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem("instaclaw_onboarding");
    if (!stored) {
      router.push("/connect");
      return;
    }
    const data = JSON.parse(stored);
    setApiMode(data.apiMode);
  }, [router]);

  async function handleCheckout() {
    setLoading(true);

    // Store tier selection
    const stored = sessionStorage.getItem("instaclaw_onboarding");
    if (stored) {
      const data = JSON.parse(stored);
      data.tier = selectedTier;
      sessionStorage.setItem("instaclaw_onboarding", JSON.stringify(data));
    }

    // Save pending user config before checkout
    try {
      const onboarding = JSON.parse(
        sessionStorage.getItem("instaclaw_onboarding") ?? "{}"
      );

      await fetch("/api/vm/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telegramBotToken: onboarding.botToken,
          apiMode: onboarding.apiMode,
          apiKey: onboarding.apiKey,
          tier: selectedTier,
        }),
      });
    } catch {
      // Non-blocking — the webhook will also handle this
    }

    // Create Stripe checkout
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: selectedTier, apiMode }),
      });
      const data = await res.json();

      if (data.url) {
        window.location.href = data.url;
      } else {
        setLoading(false);
      }
    } catch {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Choose Your Plan</h1>
        <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
          All plans include a full OpenClaw instance on a dedicated VM.
        </p>
      </div>

      <div className="space-y-3">
        {tiers.map((tier) => {
          const price =
            apiMode === "byok" ? tier.byok : tier.allInclusive;

          return (
            <button
              key={tier.id}
              type="button"
              onClick={() => setSelectedTier(tier.id)}
              className="w-full glass rounded-xl p-5 text-left transition-all cursor-pointer relative"
              style={{
                border:
                  selectedTier === tier.id
                    ? "1px solid #ffffff"
                    : "1px solid var(--border)",
                boxShadow:
                  selectedTier === tier.id
                    ? "0 0 20px rgba(255,255,255,0.08)"
                    : undefined,
              }}
            >
              {tier.popular && (
                <span
                  className="absolute -top-2.5 right-4 px-2 py-0.5 rounded-full text-xs font-semibold"
                  style={{ background: "#ffffff", color: "#000000" }}
                >
                  Popular
                </span>
              )}
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold">{tier.name}</p>
                  <p
                    className="text-xs mt-0.5"
                    style={{ color: "var(--muted)" }}
                  >
                    {tier.description}
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-2xl font-bold">${price}</span>
                  <span
                    className="text-sm"
                    style={{ color: "var(--muted)" }}
                  >
                    /mo
                  </span>
                </div>
              </div>
              <div className="flex gap-3 mt-3 flex-wrap">
                {tier.features.map((f) => (
                  <span
                    key={f}
                    className="text-xs px-2 py-0.5 rounded-full"
                    style={{
                      background: "rgba(255,255,255,0.05)",
                      color: "var(--muted)",
                    }}
                  >
                    {f}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      <button
        onClick={handleCheckout}
        disabled={loading}
        className="w-full px-6 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-50 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]"
        style={{ background: "#ffffff", color: "#000000" }}
      >
        {loading ? "Redirecting to checkout..." : "Continue to Checkout"}
      </button>
    </div>
  );
}
