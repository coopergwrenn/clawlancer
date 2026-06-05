"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Check, RotateCw, Tag, Lock, Sparkles, Hand, Wallet, TrendingUp } from "lucide-react";

/**
 * The "see + control your agent's money" surface on /economy.
 *
 * Reads /api/agent-economy/policy — which now returns BOTH the editable policy
 * (bands + category allowlist, the same the gate enforces via the one canonical
 * reader) AND a LIVE autonomy snapshot (what the agent can actually spend on its
 * own right now: the binding minimum of earned-budget / daily-band / wallet,
 * gated by opt-in + known-balance; computed by lib/frontier-headroom, which is
 * gate-consistency-tested so it can't lie about what authorize will do).
 *
 * Three parts, one story:
 *   1. GAP-1 headline — "what your agent can spend on its own today" + WHY (the
 *      binding factor). The honest number; never implies more autonomy than real.
 *   2. GAP-2 ceilings — tighten-only no-ask thresholds (per purchase, per day).
 *      Framed as ceilings the agent grows TOWARD; the gate uses whichever is lower
 *      (the earned budget or your ceiling). Can never widen past the tier.
 *   3. Categories — tighten-only allowlist (market stays approval-only by design).
 */

const CATEGORY_LABELS: Record<string, string> = {
  data: "Data & feeds",
  search: "Web search",
  inference: "AI inference",
  compute: "Compute & sandboxes",
  market: "Trading & market data",
  media: "Image / audio / video",
  agent: "Hiring other agents",
  other: "Other",
};

type Bands = {
  justDoItPerTx: number;
  justDoItPerDay: number;
  neverPerTx: number;
  neverPerDay: number;
  minWalletBalance: number;
};

interface Autonomy {
  spendEnabled: boolean;
  earnedDailyBudgetUsd: number;
  spentTodayUsd: number;
  walletBalanceUsd: number | null;
  earnedRemainingUsd: number;
  dailyLimitRemainingUsd: number;
  walletHeadroomUsd: number;
  perPurchaseCapUsd: number;
  potentialMaxTodayUsd: number;
  effectiveMaxTodayUsd: number;
  binding: "spend_disabled" | "balance_unknown" | "wallet" | "earned" | "daily_limit";
}

interface PolicyResponse {
  tier: string;
  bands: Bands;
  tier_default_bands: Bands;
  all_categories: string[];
  tier_default_categories: string[];
  allowed_categories: string[];
  allowed_categories_persisted?: boolean;
  autonomy: Autonomy | null;
  autonomy_error?: boolean;
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n < 10 && n % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 })}`;

const ACCENT = "rgb(34,197,94)";

export function EconomyPolicyControls() {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [perTx, setPerTx] = useState<number>(0);
  const [perDay, setPerDay] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hydrate = useCallback((d: PolicyResponse) => {
    setData(d);
    setSelected(new Set(d.allowed_categories));
    setPerTx(d.bands.justDoItPerTx);
    setPerDay(d.bands.justDoItPerDay);
  }, []);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-economy/policy");
      if (res.ok) hydrate(await res.json());
    } catch {
      /* leave null → neutral state */
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => {
    fetchPolicy();
  }, [fetchPolicy]);

  const toggle = useCallback((cat: string) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // Tighten-only clamp: [0, tier ceiling]. Typed values above the plan snap down.
  const clampBand = useCallback((v: number, max: number) => {
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.min(v, max);
  }, []);

  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setError(null);
    setPending(false);
    setSaved(false);
    try {
      const td = data.tier_default_bands;
      // Send a band only if it's tightened BELOW the tier ceiling; otherwise null
      // (clear → tier default). Replace-semantics on the PUT means the never-bands
      // + floor (which we don't expose) revert to the tier default — intended.
      const body = {
        justDoItPerTx: perTx < td.justDoItPerTx ? perTx : null,
        justDoItPerDay: perDay < td.justDoItPerDay ? perDay : null,
        allowed_categories: data.tier_default_categories.filter((c) => selected.has(c)),
      };
      const res = await fetch("/api/agent-economy/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (res.ok && j.ok) {
        if (j.allowed_categories_persisted === false) setPending(true);
        else setSaved(true);
        // Re-fetch so the live headline (autonomy) + effective bands reflect the save.
        await fetchPolicy();
      } else {
        setError("Couldn't save — try again in a moment.");
      }
    } catch {
      setError("Couldn't save — try again in a moment.");
    } finally {
      setSaving(false);
    }
  }, [data, perTx, perDay, selected, fetchPolicy]);

  const dirty = useMemo(() => {
    if (!data) return false;
    const catsDiff =
      selected.size !== data.allowed_categories.length ||
      data.allowed_categories.some((c) => !selected.has(c));
    return catsDiff || perTx !== data.bands.justDoItPerTx || perDay !== data.bands.justDoItPerDay;
  }, [data, selected, perTx, perDay]);

  if (loading) {
    return (
      <div
        className="glass rounded-2xl p-6 animate-pulse"
        style={{ border: "1px solid var(--border)", height: 320 }}
      />
    );
  }
  if (!data) return null;

  const a = data.autonomy;
  const td = data.tier_default_bands;
  const aboveTier = data.all_categories.filter((c) => !data.tier_default_categories.includes(c));

  // ── GAP-1 headline content ──
  const bindingMsg: Record<string, string> = {
    earned: "its earned trust — this grows as it makes good decisions",
    daily_limit: "your daily ceiling",
    wallet: "its wallet balance",
  };

  return (
    <div className="glass rounded-2xl p-6 sm:p-7" style={{ border: "1px solid var(--border)" }}>
      {/* ── GAP-1: the honest "what it can spend on its own today" headline ── */}
      <div
        className="rounded-xl p-5 mb-6"
        style={{
          background:
            a && a.effectiveMaxTodayUsd > 0
              ? "linear-gradient(135deg, rgba(34,197,94,0.10), rgba(255,255,255,0.85))"
              : "rgba(0,0,0,0.025)",
          border:
            a && a.effectiveMaxTodayUsd > 0
              ? "1px solid rgba(34,197,94,0.22)"
              : "1px solid rgba(0,0,0,0.06)",
        }}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <TrendingUp className="w-4 h-4" style={{ color: "var(--muted)" }} />
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>
            What your agent can spend on its own today
          </span>
        </div>

        {!a ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {data.autonomy_error
              ? "Couldn't load your agent's current spending power — refresh in a moment."
              : "Loading…"}
          </p>
        ) : a.binding === "spend_disabled" ? (
          <>
            <p className="text-2xl font-semibold tracking-tight">Off</p>
            <p className="text-xs mt-1 leading-snug" style={{ color: "var(--muted)" }}>
              Autonomous spending is off — your agent asks before every purchase.
              {a.potentialMaxTodayUsd > 0
                ? ` Turn it on above and it could handle up to ${usd(a.potentialMaxTodayUsd)}/day on its own.`
                : ""}
            </p>
          </>
        ) : a.binding === "balance_unknown" ? (
          <>
            <p className="text-2xl font-semibold tracking-tight">—</p>
            <p className="text-xs mt-1 leading-snug" style={{ color: "var(--muted)" }}>
              Can&apos;t read the wallet balance right now. To stay safe, your agent will ask before any purchase.
            </p>
          </>
        ) : a.effectiveMaxTodayUsd === 0 ? (
          <>
            <p className="text-2xl font-semibold tracking-tight">{usd(0)}</p>
            <p className="text-xs mt-1 leading-snug" style={{ color: "var(--muted)" }}>
              {a.binding === "wallet"
                ? `Its wallet is below the ${usd(data.bands.minWalletBalance)} floor it keeps in reserve. Add USDC to the wallet above and it can spend up to ${usd(a.potentialMaxTodayUsd)}/day on its own.`
                : a.binding === "daily_limit"
                  ? "It's used its autonomous budget for today — resets on a rolling 24 hours."
                  : "It hasn't earned spending room yet — this grows as it makes good decisions."}
            </p>
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-3xl font-semibold tracking-tight" style={{ color: ACCENT }}>
                {usd(a.effectiveMaxTodayUsd)}
              </span>
              {a.perPurchaseCapUsd < a.effectiveMaxTodayUsd && (
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  · single purchases under {usd(a.perPurchaseCapUsd)}
                </span>
              )}
            </div>
            <p className="text-xs mt-1 leading-snug" style={{ color: "var(--muted)" }}>
              Limited right now by {bindingMsg[a.binding] ?? "its current limits"}. Anything above this still comes to you for approval.
            </p>
          </>
        )}

        {/* the three components, so the number is never a black box */}
        {a && a.binding !== "spend_disabled" && a.binding !== "balance_unknown" && (
          <div className="grid grid-cols-3 gap-2 mt-3">
            {[
              { icon: Sparkles, label: "Earned budget", value: a.earnedDailyBudgetUsd, hint: "/day" },
              { icon: TrendingUp, label: "Spent today", value: a.spentTodayUsd, hint: "" },
              { icon: Wallet, label: "Wallet", value: a.walletBalanceUsd ?? 0, hint: "" },
            ].map((c) => (
              <div key={c.label} className="rounded-lg p-2.5" style={{ background: "rgba(0,0,0,0.025)", border: "1px solid rgba(0,0,0,0.05)" }}>
                <div className="flex items-center gap-1 mb-0.5">
                  <c.icon className="w-3 h-3" style={{ color: "var(--muted)" }} />
                  <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                    {c.label}
                  </span>
                </div>
                <span className="text-sm font-semibold tracking-tight">
                  {usd(c.value)}
                  <span className="text-[10px] font-normal" style={{ color: "var(--muted)" }}>{c.hint}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── GAP-2: tighten-only no-ask ceilings ── */}
      <div className="flex items-center gap-2 mb-1">
        <Hand className="w-4 h-4" style={{ color: "var(--muted)" }} />
        <h3 className="text-sm font-medium">Ask-first ceilings</h3>
      </div>
      <p className="text-[11px] mb-4 leading-snug" style={{ color: "var(--muted)" }}>
        The most your agent will ever spend without asking. It grows toward these as it earns trust — the gate always
        uses whichever is lower (what it&apos;s earned, or your ceiling). Lower these anytime; you can&apos;t raise them above your plan.
      </p>

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <BandInput
          label="Any single purchase over"
          value={perTx}
          max={td.justDoItPerTx}
          onChange={(v) => {
            setSaved(false);
            setPerTx(clampBand(v, td.justDoItPerTx));
          }}
        />
        <BandInput
          label="Total daily spend over"
          value={perDay}
          max={td.justDoItPerDay}
          onChange={(v) => {
            setSaved(false);
            setPerDay(clampBand(v, td.justDoItPerDay));
          }}
        />
      </div>

      <p className="text-[11px] mb-6 flex items-start gap-1.5" style={{ color: "var(--muted)" }}>
        <Lock className="w-3 h-3 mt-0.5 shrink-0" />
        <span>
          Hard limits (set by your {data.tier} plan, can&apos;t be exceeded): never over {usd(data.bands.neverPerTx)} per
          purchase or {usd(data.bands.neverPerDay)} per day · always keep {usd(data.bands.minWalletBalance)} in the wallet.
        </span>
      </p>

      {/* ── Categories (tighten-only allowlist) ── */}
      <div className="flex items-center gap-2 mb-1">
        <Tag className="w-4 h-4" style={{ color: "var(--muted)" }} />
        <h3 className="text-sm font-medium">What it may buy on its own</h3>
      </div>
      <p className="text-[11px] mb-3 leading-snug" style={{ color: "var(--muted)" }}>
        Uncheck anything you&apos;d rather approve case by case — those still work, your agent just asks first.
      </p>
      <div className="grid sm:grid-cols-2 gap-2">
        {data.tier_default_categories.map((cat) => {
          const on = selected.has(cat);
          return (
            <button
              key={cat}
              onClick={() => toggle(cat)}
              className="flex items-center gap-2.5 rounded-lg p-2.5 text-left transition-colors cursor-pointer"
              style={{
                background: on ? "rgba(34,197,94,0.08)" : "rgba(0,0,0,0.025)",
                border: on ? "1px solid rgba(34,197,94,0.22)" : "1px solid rgba(0,0,0,0.06)",
              }}
            >
              <span
                className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                style={{ background: on ? ACCENT : "transparent", border: on ? "none" : "1px solid var(--border)" }}
              >
                {on && <Check className="w-3 h-3" style={{ color: "#fff" }} />}
              </span>
              <span className="text-xs font-medium">{CATEGORY_LABELS[cat] ?? cat}</span>
            </button>
          );
        })}
      </div>
      {aboveTier.length > 0 && (
        <div className="mt-3 flex items-start gap-2">
          <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--muted)" }} />
          <p className="text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
            Not available for autonomous spend: {aboveTier.map((c) => CATEGORY_LABELS[c] ?? c).join(", ")}
            {aboveTier.includes("market") ? " — trading stays approval-only by design." : "."}
          </p>
        </div>
      )}

      {/* ── Save ── */}
      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-default"
          style={{ background: "rgba(0,0,0,0.05)", border: "1px solid var(--border)" }}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saving && <RotateCw className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--muted)" }} />}
        {saved && (
          <span className="text-xs flex items-center gap-1" style={{ color: ACCENT }}>
            <Check className="w-3.5 h-3.5" /> Saved
          </span>
        )}
        {pending && (
          <span className="text-xs" style={{ color: "rgb(234,179,8)" }}>
            Categories are being set up — check back shortly.
          </span>
        )}
        {error && <span className="text-xs" style={{ color: "rgb(239,68,68)" }}>{error}</span>}
      </div>
    </div>
  );
}

/** A glass-styled "$___" tighten-only number input with a tier-ceiling hint. */
function BandInput({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const tightened = value < max;
  return (
    <label className="block rounded-xl p-3" style={{ background: "rgba(0,0,0,0.025)", border: "1px solid rgba(0,0,0,0.06)" }}>
      <span className="text-[11px] block mb-1.5" style={{ color: "var(--muted)" }}>
        Ask before {label}
      </span>
      <div className="flex items-center gap-1">
        <span className="text-lg font-semibold" style={{ color: tightened ? "rgb(34,197,94)" : "var(--foreground)" }}>$</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={max}
          step={max <= 5 ? 0.25 : 1}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full bg-transparent text-lg font-semibold tracking-tight outline-none"
          style={{ color: tightened ? "rgb(34,197,94)" : "var(--foreground)" }}
        />
      </div>
      <span className="text-[10px]" style={{ color: "var(--muted)" }}>
        your plan allows up to {`$${max.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
      </span>
    </label>
  );
}
