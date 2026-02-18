"use client";

import { useState, useEffect } from "react";
import { CreditCard } from "lucide-react";
import { motion } from "motion/react";

const tiers = [
  {
    id: "starter" as const,
    name: "Starter",
    allInclusive: 29,
    byok: 14,
    description: "Perfect for getting started",
    dailyUnits: 600,
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
  },
  {
    id: "pro" as const,
    name: "Pro",
    allInclusive: 99,
    byok: 39,
    description: "For everyday use",
    dailyUnits: 1000,
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
  },
];

export default function BillingPage() {
  const [loading, setLoading] = useState(false);
  const [billingStatus, setBillingStatus] = useState<{
    subscription: {
      tier: string;
      status: string;
      paymentStatus: string;
      hasVm: boolean;
    } | null;
  } | null>(null);
  const [fetching, setFetching] = useState(true);
  const [selectedTier, setSelectedTier] = useState<string>("pro");
  const [apiMode, setApiMode] = useState<"all_inclusive" | "byok">("all_inclusive");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/billing/status")
      .then((res) => res.json())
      .then((data) => setBillingStatus(data))
      .catch(() => {})
      .finally(() => setFetching(false));
  }, []);

  const isActive =
    billingStatus?.subscription?.status === "active" &&
    billingStatus.subscription.hasVm;

  async function openPortal() {
    setLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      // Handle error
    } finally {
      setLoading(false);
    }
  }

  async function handleResubscribe() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: selectedTier,
          apiMode,
          trial: false,
          cancelUrl: "/billing",
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setError(err.error || `Checkout failed (${res.status}). Please try again.`);
        setLoading(false);
        return;
      }

      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError("Stripe checkout URL not received. Please try again.");
        setLoading(false);
      }
    } catch {
      setError("Network error. Please check your connection and try again.");
      setLoading(false);
    }
  }

  if (fetching) {
    return (
      <div className="space-y-10" data-tour="page-billing">
        <div>
          <h1
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Billing
          </h1>
          <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
            Loading billing information...
          </p>
        </div>
      </div>
    );
  }

  // Active subscription — show existing portal button
  if (isActive) {
    return (
      <div className="space-y-10" data-tour="page-billing">
        <div>
          <h1
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Billing
          </h1>
          <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
            Manage your subscription and payment details.
          </p>
        </div>

        <div data-tour="page-billing-card" className="glass rounded-xl p-6 space-y-4">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Manage your subscription, update payment methods, and view invoices
            through the Stripe customer portal.
          </p>
          <button
            onClick={openPortal}
            disabled={loading}
            className="px-6 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-50 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]"
            style={{ background: "#ffffff", color: "#000000" }}
          >
            <CreditCard className="inline-block w-4 h-4 mr-2 -mt-0.5" />
            {loading ? "Opening..." : "Manage Subscription"}
          </button>
        </div>
      </div>
    );
  }

  // Inactive / canceled — show resubscribe UI
  return (
    <div className="space-y-8" data-tour="page-billing">
      <div>
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Billing
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Manage your subscription and payment details.
        </p>
      </div>

      {/* Inactive banner */}
      <div
        className="glass rounded-xl p-6"
        style={{ borderLeft: "3px solid var(--accent)" }}
      >
        <h2
          className="text-lg font-normal mb-1"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Your subscription is inactive
        </h2>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Pick a plan below to resubscribe and get a new VM provisioned automatically.
        </p>
      </div>

      {/* BYOK toggle */}
      <div className="flex justify-center">
        <div
          className="inline-flex items-center gap-3 text-sm px-6 py-2.5 rounded-full glass"
        >
          <span
            className="font-medium"
            style={{ color: apiMode === "byok" ? "var(--muted)" : "var(--foreground)" }}
          >
            All-Inclusive
          </span>
          <button
            type="button"
            onClick={() => setApiMode(apiMode === "all_inclusive" ? "byok" : "all_inclusive")}
            className="relative w-12 h-6 rounded-full transition-all cursor-pointer"
            style={{
              background: "linear-gradient(-75deg, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.1))",
              boxShadow: "rgba(0, 0, 0, 0.15) 0px 1px 2px 0px inset, rgba(255, 255, 255, 0.1) 0px -1px 1px 0px inset",
            }}
          >
            <motion.span
              className="absolute top-1 w-4 h-4 rounded-full"
              style={{
                background: apiMode === "byok"
                  ? "linear-gradient(-75deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 1), rgba(255, 255, 255, 0.9))"
                  : "linear-gradient(-75deg, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.8))",
                boxShadow: "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(255, 255, 255, 0.4) 0px -1px 1px 0px inset, rgba(0, 0, 0, 0.05) 0px 1px 1px 0px inset",
              }}
              animate={{ left: apiMode === "byok" ? "28px" : "4px" }}
              transition={{ type: "spring", stiffness: 500, damping: 25 }}
            />
          </button>
          <span
            className="font-medium"
            style={{ color: apiMode === "byok" ? "var(--foreground)" : "var(--muted)" }}
          >
            BYOK
          </span>
        </div>
      </div>
      {apiMode === "byok" && (
        <p className="text-xs text-center" style={{ color: "var(--muted)" }}>
          Bring Your Own Anthropic API Key — lower monthly cost, you pay Anthropic directly.
        </p>
      )}

      {/* Tier cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {tiers.map((tier) => {
          const price = apiMode === "byok" ? tier.byok : tier.allInclusive;
          const isSelected = selectedTier === tier.id;
          const features = apiMode === "byok" ? tier.byokFeatures : tier.features;

          const cardContent = (
            <div className="text-left relative rounded-lg p-6" style={{ background: "var(--card)" }}>
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

              <div className="mb-4">
                <h3
                  className="text-xl font-normal mb-1"
                  style={{ fontFamily: "var(--font-serif)", color: "var(--foreground)" }}
                >
                  {tier.name}
                </h3>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  {tier.description}
                </p>
              </div>

              <div className="mb-6">
                <div className="flex items-baseline">
                  <span
                    className="text-4xl font-normal"
                    style={{
                      fontFamily: "var(--font-serif)",
                      color: isSelected ? "var(--accent)" : "var(--foreground)",
                    }}
                  >
                    ${price}
                  </span>
                  <span className="text-sm ml-1" style={{ color: "var(--muted)" }}>
                    /mo
                  </span>
                </div>
              </div>

              {apiMode === "all_inclusive" ? (
                <div className="mb-4 py-2.5 px-3 rounded-md glass">
                  <p className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
                    {tier.dailyUnits.toLocaleString()} units/day
                  </p>
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--muted)" }}>
                    ~{tier.dailyUnits.toLocaleString()} Haiku or ~{Math.floor(tier.dailyUnits / 4)} Sonnet messages
                  </p>
                </div>
              ) : (
                <div className="mb-4 py-2.5 px-3 rounded-md glass">
                  <p className="text-xs font-semibold" style={{ color: "var(--foreground)" }}>
                    Unlimited usage
                  </p>
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--muted)" }}>
                    Pay Anthropic directly for what you use
                  </p>
                </div>
              )}

              <div className="space-y-2">
                {features.map((f) => (
                  <div key={f} className="text-xs flex items-start" style={{ color: "var(--muted)" }}>
                    <span className="mr-2" style={{ color: "var(--accent)" }}>
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
              style={{ border: "none", background: "transparent", padding: 0 }}
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
                    border: "1px solid var(--border)",
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
        <p className="text-sm text-center" style={{ color: "var(--error)" }}>
          {error}
        </p>
      )}

      {/* Resubscribe button */}
      <button
        onClick={handleResubscribe}
        disabled={loading}
        className="w-full px-6 py-4 rounded-lg font-semibold transition-all cursor-pointer disabled:opacity-50"
        style={{
          background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
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
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Creating checkout session...
          </span>
        ) : (
          "Resubscribe"
        )}
      </button>
    </div>
  );
}
