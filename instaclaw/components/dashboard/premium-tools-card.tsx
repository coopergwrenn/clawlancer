"use client";

/**
 * Premium Tools Card
 *
 * Shows the user's monthly allocation of "premium searches" routed through
 * ToolRouter — web search, browser automation, deep research, agent mail.
 * Reads from GET /api/toolrouter/balance.
 *
 * Mounted on the dashboard after AgentWalletFundingCard, gated on `vm`
 * existing (agents are the only consumers of the allocation).
 *
 * Style mirrors AgentWalletFundingCard + the inline Today's Usage card:
 *   glass + var(--border) + var(--muted) tokens. Big X/Y baseline-aligned
 *   numerals, motion-animated progress bar, full-width top-up CTA below.
 *
 * Top-up flow uses the existing POST /api/billing/credit-pack endpoint
 * with pack = "toolrouter_100" (see app/api/billing/credit-pack/route.ts).
 *
 * If the GET fails the card hides silently — same pattern as other
 * non-critical dashboard cards. Loading state is animate-pulse blocks.
 */

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { motion } from "motion/react";

interface ToolRouterBalance {
  tier: string;
  balance: number;
  grant_total: number;
  topup_balance: number;
  period_start: string | null;
  reset_at: string | null;
  timezone: string;
  topup_pack: {
    slug: string;
    credits: number;
    price_usd: number;
    label: string;
  };
}

function formatResetDate(isoString: string | null): string | null {
  if (!isoString) return null;
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return null;
  }
}

export function PremiumToolsCard() {
  const [data, setData] = useState<ToolRouterBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    (async () => {
      try {
        const res = await fetch("/api/toolrouter/balance", { signal: ctrl.signal });
        if (!res.ok) {
          if (!cancelled) setHidden(true);
          return;
        }
        const json = (await res.json()) as ToolRouterBalance;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setHidden(true);
      } finally {
        clearTimeout(timer);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, []);

  async function handleTopUp() {
    if (!data) return;
    setBuying(true);
    try {
      const res = await fetch("/api/billing/credit-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack: data.topup_pack.slug }),
      });
      const json = await res.json();
      if (json.url) {
        window.location.href = json.url;
        return;
      }
    } catch {
      // swallow — button returns to idle, user can retry
    } finally {
      setBuying(false);
    }
  }

  if (hidden) return null;

  if (loading) {
    return (
      <div
        className="glass rounded-xl p-6"
        style={{ border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: "var(--muted)" }} />
            <span className="text-sm font-medium" style={{ color: "var(--muted)" }}>
              Premium Tools
            </span>
          </div>
        </div>
        <div className="space-y-3">
          <div
            className="h-8 w-32 rounded-md animate-pulse"
            style={{ background: "rgba(0,0,0,0.06)" }}
          />
          <div
            className="h-2 w-full rounded-full animate-pulse"
            style={{ background: "rgba(0,0,0,0.06)" }}
          />
          <div
            className="h-4 w-48 rounded-md animate-pulse"
            style={{ background: "rgba(0,0,0,0.06)" }}
          />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const monthlyRemaining = data.balance;
  const grantTotal = data.grant_total;
  const topup = data.topup_balance;
  const totalAvailable = monthlyRemaining + topup;
  // Progress bar shows monthly bucket fill. Topup is additive and never
  // resets, so it doesn't belong on the same axis as the monthly cycle.
  const fillPct =
    grantTotal > 0
      ? Math.max(0, Math.min(100, (monthlyRemaining / grantTotal) * 100))
      : 0;
  const isLow = grantTotal > 0 && monthlyRemaining / grantTotal < 0.2;
  const resetLabel = formatResetDate(data.reset_at);
  const tierLabel = data.tier.charAt(0).toUpperCase() + data.tier.slice(1);

  return (
    <div
      className="glass rounded-xl p-6"
      style={{ border: "1px solid var(--border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4" style={{ color: "var(--muted)" }} />
          <span className="text-sm font-medium" style={{ color: "var(--muted)" }}>
            Premium Tools
          </span>
        </div>
        <span
          className="px-2 py-0.5 rounded-full text-xs font-medium"
          style={{
            background: "rgba(0,0,0,0.04)",
            border: "1px solid var(--border)",
            color: "var(--muted)",
          }}
        >
          {tierLabel}
        </span>
      </div>

      {/* Explanation */}
      <p className="text-sm mb-4" style={{ color: "var(--muted)", lineHeight: 1.55 }}>
        Web search, browser automation, deep research, and agent mail — covered by
        your plan&apos;s monthly allocation.
      </p>

      {/* Big number — monthly remaining vs grant total */}
      <div className="flex items-baseline gap-1.5 mb-3">
        <span
          className="text-3xl font-semibold tracking-tight"
          style={isLow ? { color: "#ef4444" } : undefined}
        >
          {monthlyRemaining}
        </span>
        <span className="text-lg" style={{ color: "var(--muted)" }}>/</span>
        <span className="text-lg" style={{ color: "var(--muted)" }}>{grantTotal}</span>
        <span className="text-sm ml-1" style={{ color: "var(--muted)" }}>
          remaining this month
        </span>
      </div>

      {/* Progress bar */}
      <div
        className="h-2 rounded-full overflow-hidden mb-3"
        style={{ background: "rgba(0,0,0,0.06)" }}
      >
        <motion.div
          className="h-full rounded-full"
          style={{
            background: isLow
              ? "linear-gradient(90deg, #ef4444, #f87171)"
              : "linear-gradient(90deg, #3b82f6, #60a5fa)",
          }}
          initial={{ width: 0 }}
          animate={{ width: `${fillPct}%` }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      </div>

      {/* Topup balance subline — only shown when user has top-ups */}
      {topup > 0 && (
        <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
          + {topup} from top-ups · {totalAvailable} total available
        </p>
      )}

      {/* Top-up CTA */}
      <button
        onClick={handleTopUp}
        disabled={buying}
        className="w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all hover:opacity-85 disabled:opacity-50"
        style={{
          // Same blue gradient token used by polymarket-panel.tsx for primary
          // CTAs — keeps the dashboard's "primary action" color consistent.
          background:
            "linear-gradient(135deg, rgba(59,130,246,0.85), rgba(37,99,235,0.95))",
          color: "#fff",
        }}
      >
        {buying ? "Redirecting to checkout…" : `Top up ${data.topup_pack.credits} searches — $${data.topup_pack.price_usd}`}
      </button>

      {/* Reset hint */}
      <p
        className="text-xs mt-3"
        style={{ color: "var(--muted)", opacity: 0.65 }}
      >
        {resetLabel
          ? `Monthly allocation resets ${resetLabel}. Top-ups never expire.`
          : "Top-ups never expire."}
      </p>
    </div>
  );
}
