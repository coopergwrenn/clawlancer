"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { CreditCard, Check, ArrowRight, Zap, Film, Clapperboard, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import {
  MESSAGE_PACKS,
  MEDIA_PACKS,
  VIDEO_PACKS,
  TOOLROUTER_PACKS,
  type CatalogPack,
} from "@/lib/billing-catalog";
import { useToast, ToastViewport } from "@/components/ui/toast";

interface VideoPlanState {
  status: string;
  clips_remaining: number;
  resets_at: string | null;
}

const tiers = [
  {
    id: "starter" as const,
    name: "Starter",
    // 2026-05-29 pricing update — matches lib/stripe.ts NEW_PRICE_IDS.
    // Existing subs stay on grandfathered Stripe prices; the dashboard
    // tier comparison shows the current advertised price for new
    // checkouts (an existing $99 Pro user upgrading to Power would
    // see Power priced at $349.99, not the old $299).
    allInclusive: 49.99,
    byok: 35.99,
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
    allInclusive: 129.99,
    byok: 49.99,
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
    allInclusive: 349.99,
    byok: 119.99,
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
  // Hub state (active-sub view): balances + pack purchase.
  const [msgBalance, setMsgBalance] = useState<number | null>(null);
  const [mediaBal, setMediaBal] = useState<number | null>(null);
  const [videoClips, setVideoClips] = useState<number | null>(null);
  const [videoPlan, setVideoPlan] = useState<VideoPlanState | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [buyError, setBuyError] = useState("");
  const { toast, showToast, dismissToast } = useToast();

  useEffect(() => {
    fetch("/api/billing/status")
      .then((res) => res.json())
      .then((data) => setBillingStatus(data))
      .catch(() => {})
      .finally(() => setFetching(false));
    // Balances for the hub — fail-soft, each independent.
    fetch("/api/vm/usage")
      .then((r) => r.json())
      .then((d) => setMsgBalance(typeof d.creditBalance === "number" ? d.creditBalance : 0))
      .catch(() => {});
    fetch("/api/credits/media")
      .then((r) => r.json())
      .then((d) => setMediaBal(typeof d.balance === "number" ? d.balance : 0))
      .catch(() => {});
    fetch("/api/credits/video")
      .then((r) => r.json())
      .then((d) => {
        setVideoClips(typeof d.clips === "number" ? d.clips : 0);
        setVideoPlan(d.plan ?? null);
      })
      .catch(() => {});
    // Subscribe confirmation (checkout success_url lands here) — overlay
    // toast, never inline (the layout-shift ban).
    const params = new URLSearchParams(window.location.search);
    if (params.get("plan") === "video_subscribed") {
      window.history.replaceState({}, "", "/billing");
      showToast({ message: "Video creator plan active · 42 premium videos every month" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleBuy(packId: string) {
    setBuying(packId);
    setBuyError("");
    try {
      const res = await fetch("/api/billing/credit-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack: packId }),
      });
      if (!res.ok) {
        const err = await res.json();
        setBuyError(err.error || `Checkout failed (${res.status}). Please try again.`);
        setBuying(null);
        return;
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setBuyError("Stripe checkout URL not received. Please try again.");
        setBuying(null);
      }
    } catch {
      setBuyError("Network error. Please check your connection and try again.");
      setBuying(null);
    }
  }

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

  // ── Pack row (shared by all catalog sections; credits-page idiom) ──
  function renderPackRows(packs: CatalogPack[]) {
    return (
      <div className="grid gap-2.5">
        {packs.map((pack) => (
          <button
            key={pack.id}
            onClick={() => handleBuy(pack.id)}
            disabled={buying !== null}
            className="glass rounded-xl p-4 text-left cursor-pointer transition-all disabled:opacity-50"
            style={{
              border: pack.best ? "1.5px solid rgba(220,103,67,0.3)" : "1px solid var(--border)",
              background: pack.best ? "rgba(220,103,67,0.03)" : undefined,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow =
                "0 2px 12px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.08)";
              e.currentTarget.style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = "";
              e.currentTarget.style.transform = "";
            }}
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-semibold">{pack.title}</span>
                <span className="text-xs block" style={{ color: "var(--muted)" }}>
                  {pack.note} · {pack.perUnit}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {pack.best && (
                  <span
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                    style={{
                      background:
                        "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                      color: "#fff",
                    }}
                  >
                    Best Value
                  </span>
                )}
                <span
                  className="text-sm font-bold px-3 py-1.5 rounded-lg"
                  style={{
                    background: pack.best ? "linear-gradient(135deg, #c75a34, #DC6743)" : "rgba(0,0,0,0.05)",
                    color: pack.best ? "#fff" : "var(--accent)",
                    boxShadow: pack.best ? "0 1px 3px rgba(199,90,52,0.3)" : undefined,
                  }}
                >
                  {buying === pack.id ? "..." : pack.price}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>
    );
  }

  function catalogSection(
    icon: React.ReactNode,
    title: string,
    sub: string,
    packs: CatalogPack[],
  ) {
    return (
      <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2.5 mb-1">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, rgba(199,90,52,0.1), rgba(220,103,67,0.1))" }}
          >
            {icon}
          </div>
          <h2 className="text-lg font-normal" style={{ fontFamily: "var(--font-serif)" }}>
            {title}
          </h2>
        </div>
        <p className="text-xs mb-5 ml-[42px]" style={{ color: "var(--muted)" }}>
          {sub}
        </p>
        {renderPackRows(packs)}
      </div>
    );
  }

  // Active subscription — THE MONEY HUB (rebuilt 2026-06-12, ruled): current
  // plan + status at top, all balances, then the COMPLETE purchasable catalog
  // inline (every credit class — the audit's orphaned-shelf finding closed by
  // the premium-searches section), and the Stripe-portal block demoted to the
  // bottom as the utility it is.
  if (isActive) {
    const tierName = billingStatus?.subscription?.tier
      ? billingStatus.subscription.tier.charAt(0).toUpperCase() + billingStatus.subscription.tier.slice(1)
      : "Active";
    const paymentStatus = billingStatus?.subscription?.paymentStatus;
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
            Your plan, balances, and everything you can add to your agent.
          </p>
        </div>

        {/* ── Current plan + status ── */}
        <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs mb-1" style={{ color: "var(--muted)" }}>
                Current plan
              </p>
              <p className="text-2xl font-normal" style={{ fontFamily: "var(--font-serif)" }}>
                {tierName}
              </p>
            </div>
            <span
              className="text-xs font-semibold px-3 py-1 rounded-full"
              style={
                paymentStatus === "past_due"
                  ? { background: "rgba(220,103,67,0.12)", color: "var(--accent)" }
                  : { background: "rgba(34,197,94,0.1)", color: "#16a34a" }
              }
            >
              {paymentStatus === "past_due" ? "Payment issue" : "Active"}
            </span>
          </div>
          {paymentStatus === "past_due" && (
            <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
              There is a payment issue with your subscription. Update your card in the
              Stripe portal below to keep everything running.
            </p>
          )}
        </div>

        {/* ── Balances ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { icon: <Zap className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />, label: "message units", value: msgBalance },
            { icon: <Film className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />, label: "media credits", value: mediaBal },
            { icon: <Clapperboard className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />, label: "premium videos", value: videoClips },
          ].map((b) => (
            <div key={b.label} className="glass rounded-xl p-4" style={{ border: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2">
                {b.icon}
                <span className="text-2xl font-semibold tracking-tight">
                  {b.value === null ? "–" : b.value.toLocaleString()}
                </span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {b.label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* ── The complete catalog ── */}
        {catalogSection(
          <Zap className="w-4 h-4" style={{ color: "var(--accent)" }} />,
          "Message Units",
          "Top up after your daily limit. Never expire, used automatically.",
          MESSAGE_PACKS,
        )}
        {catalogSection(
          <Film className="w-4 h-4" style={{ color: "var(--accent)" }} />,
          "Media Credits",
          "For AI video, image, and audio generation. Never expire.",
          MEDIA_PACKS,
        )}
        {/* ── THE PLAN — the video section's recurring headliner ── */}
        <div className="glass rounded-xl p-6" style={{ border: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, rgba(199,90,52,0.1), rgba(220,103,67,0.1))" }}
            >
              <Clapperboard className="w-4 h-4" style={{ color: "var(--accent)" }} />
            </div>
            <h2 className="text-lg font-normal" style={{ fontFamily: "var(--font-serif)" }}>
              Video Creator Plan
            </h2>
          </div>
          {videoPlan ? (
            <div className="ml-[42px]">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="text-xs font-semibold px-2.5 py-0.5 rounded-full"
                  style={
                    videoPlan.status === "past_due"
                      ? { background: "rgba(220,103,67,0.12)", color: "var(--accent)" }
                      : { background: "rgba(34,197,94,0.1)", color: "#16a34a" }
                  }
                >
                  {videoPlan.status === "past_due" ? "Payment issue" : "Active"}
                </span>
              </div>
              <p className="text-sm" style={{ color: "var(--foreground)" }}>
                <span className="text-2xl font-semibold tracking-tight">{videoPlan.clips_remaining}</span>
                <span className="text-sm ml-1.5" style={{ color: "var(--muted)" }}>
                  premium videos left this month
                  {videoPlan.resets_at
                    ? ` · resets ${new Date(videoPlan.resets_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                    : ""}
                </span>
              </p>
              {videoPlan.status === "past_due" && (
                <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
                  There is a payment issue with your plan, so the monthly videos are
                  paused. Update your card in the Stripe portal below. Video packs
                  keep working in the meantime.
                </p>
              )}
            </div>
          ) : (
            <div className="ml-[42px]">
              <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
                42 premium videos every month · $1.07 a video, our best rate.
                Cancel anytime, keep the month you paid for.
              </p>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => handleBuy("video_plan_monthly")}
                  disabled={buying !== null}
                  className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-50"
                  style={{
                    background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                    boxShadow:
                      "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(255,255,255,0.3) 0px -1px 1px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
                    color: "#ffffff",
                  }}
                >
                  {buying === "video_plan_monthly" ? "Opening checkout..." : "Subscribe · $44.99/mo"}
                </button>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  Monthly videos always get used before your purchased packs.
                </span>
              </div>
            </div>
          )}
        </div>

        {catalogSection(
          <Clapperboard className="w-4 h-4" style={{ color: "var(--accent)" }} />,
          "Cinematic Video Packs",
          "Premium text-to-video in widescreen 16:9, from 99¢ a video. Your first one is free: just ask your agent for a video.",
          VIDEO_PACKS,
        )}
        {catalogSection(
          <Sparkles className="w-4 h-4" style={{ color: "var(--accent)" }} />,
          "Premium Searches",
          "Web search, browser automation, and deep research for your agent.",
          TOOLROUTER_PACKS,
        )}

        {buyError && (
          <p className="text-sm text-center" style={{ color: "var(--error)" }}>
            {buyError}
          </p>
        )}

        {/* Subscribe/purchase confirmations: overlay toast, never inline. */}
        <ToastViewport toast={toast} onDismiss={dismissToast} />

        {/* ── Manage subscription (the utility, at the bottom where it belongs) ── */}
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
        {/* D6 flywheel — cross-link to Credits & balances */}
        <Link
          href="/dashboard/credits"
          className="inline-flex items-center gap-1.5 text-sm mt-3 transition-opacity hover:opacity-70"
          style={{ color: "var(--muted)" }}
        >
          Credits &amp; balances
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
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
                    ${price.toFixed(2)}
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
                  <div key={f} className="text-xs flex items-start gap-1.5" style={{ color: "var(--muted)" }}>
                    <Check className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: "var(--accent)" }} aria-hidden />
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
