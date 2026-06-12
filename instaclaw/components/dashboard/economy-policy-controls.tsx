"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Check, RotateCw, Tag, Lock, Sparkles, Hand, Wallet, TrendingUp, AlertTriangle } from "lucide-react";

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
 *   2. GAP-2 ceilings: the per-purchase no-ask line is bidirectional (raise it up
 *      to the plan hard cap, or tighten it); the daily line is tighten-only. The
 *      gate uses whichever is lower (the earned budget or your ceiling), so raising
 *      a ceiling never widens the actual autonomous spend past what is earned, and
 *      never past the tier hard cap.
 *   3. Categories — tighten-only allowlist (market stays approval-only by design).
 */

const CATEGORY_LABELS: Record<string, string> = {
  data: "Data & feeds",
  search: "Web search",
  inference: "AI inference",
  compute: "Compute & sandboxes",
  market: "Trading & market data",
  media: "Image / audio / video",
  travel: "Travel & lodging",
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
  // Reserve (minWalletBalance). Bidirectional (Slice B #2b): the control allows 0
  // ("spend it all") up through any cushion; the gate floors the effective value at
  // 0 at read (clampOverrides Math.max(0, ..)), so it is never negative.
  const [reserve, setReserve] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hydrate = useCallback((d: PolicyResponse) => {
    setData(d);
    setSelected(new Set(d.allowed_categories));
    setPerTx(d.bands.justDoItPerTx);
    setPerDay(d.bands.justDoItPerDay);
    setReserve(d.bands.minWalletBalance);
  }, []);

  const fetchPolicy = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent-economy/policy");
      if (res.ok) hydrate(await res.json());
    } catch {
      /* leave null → render the inline error-with-retry below, not a vanished panel */
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

  // Clamp a typed band to [0, max]. For the per-tx line, max is the plan hard cap
  // (raises allowed up to it); for the daily line, max is the tier default
  // (tighten-only). Values above max snap down; negatives snap to 0.
  const clampBand = useCallback((v: number, max: number) => {
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.min(v, max);
  }, []);

  // ── Pre-fill from an agent's /settings suggest deep link (?suggest=field:value).
  //    The agent can only SUGGEST; this pre-fills the control in the UNSAVED state so
  //    the human's explicit Save (session-authed) is the consent. The ?suggest value
  //    is a public identifier, never a capability. FAIL QUIET: an unknown field, a
  //    malformed value, or a change the page can't fulfil (a daily-line raise, which
  //    is lower-only until the perDay-raisable change ships) is ignored silently --
  //    no banner, no error, normal page. Never promise an action the page can't do. ──
  const suggestRef = useRef<{ field: string; value: string } | null | undefined>(undefined);
  const [suggestBanner, setSuggestBanner] = useState<{ field: string; value: string } | null>(null);

  useEffect(() => {
    try {
      const raw = new URLSearchParams(window.location.search).get("suggest");
      const idx = raw ? raw.indexOf(":") : -1;
      suggestRef.current = raw && idx > 0 ? { field: raw.slice(0, idx), value: raw.slice(idx + 1) } : null;
    } catch {
      suggestRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!data || !suggestRef.current) return;
    const s = suggestRef.current;
    suggestRef.current = null; // consume: apply at most once
    const num = parseFloat(s.value);
    let ok = false;
    if (s.field === "minWalletBalance" && Number.isFinite(num) && num >= 0 && num < data.bands.minWalletBalance) {
      setReserve(Math.max(0, num)); // a genuine reserve LOWER
      ok = true;
    } else if (
      s.field === "justDoItPerTx" &&
      Number.isFinite(num) &&
      num > data.bands.justDoItPerTx &&
      num <= data.bands.neverPerTx
    ) {
      setPerTx(clampBand(num, data.bands.neverPerTx)); // a genuine no-ask RAISE within the hard cap
      ok = true;
    } else if (s.field === "allowedCategories") {
      const want = s.value.split(",").map((x) => x.trim());
      const next = data.tier_default_categories.filter((c) => want.includes(c));
      if (next.length > 0 && next.some((c) => !selected.has(c))) {
        setSelected(new Set(next)); // re-enabling at least one category (an ADD)
        ok = true;
      }
    }
    if (ok) {
      setSaved(false);
      setSuggestBanner(s); // banner shows ONLY on a fulfilled suggestion
    }
    // else: fail quiet
  }, [data, clampBand, selected]);

  // The agent-suggestion banner copy (null = nothing to show). Reads the SAVED
  // current values from `data`, so it states the real before/after.
  const suggestMsg = useMemo<string | null>(() => {
    if (!suggestBanner || !data) return null;
    const b = suggestBanner;
    const num = parseFloat(b.value);
    if (b.field === "minWalletBalance") {
      return num === 0
        ? `Your agent suggested lowering your reserve to $0. At $0 it can spend the wallet all the way down to empty. Review and Save below to apply, or ignore to keep your current ${usd(data.bands.minWalletBalance)}.`
        : `Your agent suggested lowering your reserve to ${usd(num)}. Review and Save below to apply, or ignore to keep your current ${usd(data.bands.minWalletBalance)}.`;
    }
    if (b.field === "justDoItPerTx") {
      return `Your agent suggested raising its no-ask line to ${usd(num)} per purchase. It could then spend up to ${usd(num)} on a single purchase without checking with you. Review and Save to apply.`;
    }
    if (b.field === "allowedCategories") {
      const labels = b.value
        .split(",")
        .map((x) => x.trim())
        .filter((c) => data.tier_default_categories.includes(c))
        .map((c) => CATEGORY_LABELS[c] ?? c)
        .join(", ");
      return `Your agent suggested re-enabling autonomous spending on: ${labels}. Review and Save to apply.`;
    }
    return null;
  }, [suggestBanner, data]);

  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setError(null);
    setPending(false);
    setSaved(false);
    try {
      const td = data.tier_default_bands;
      // Per-tx no-ask line is bidirectional: send it whenever it differs from the
      // tier default (a raise up to the plan hard cap, or a tighten below default);
      // null clears to the tier default. The gate clamps it at neverPerTx
      // (clampOverrides), so a raise can never pass the hard deny line. The daily
      // line stays tighten-only, so send it only when below the default.
      // Replace-semantics: omitted bands and the floor (not exposed here) revert
      // to the tier default, which is intended.
      const body = {
        justDoItPerTx: perTx !== td.justDoItPerTx ? perTx : null,
        justDoItPerDay: perDay < td.justDoItPerDay ? perDay : null,
        // Reserve is bidirectional (Slice B #2b): send it whenever it differs from
        // the tier default (lower toward 0 to "spend it all", or raise for a bigger
        // cushion); null clears to the tier default. The gate floors the effective
        // value at 0 (clampOverrides Math.max(0, ..)).
        minWalletBalance: reserve !== td.minWalletBalance ? reserve : null,
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
        setError("Couldn't save. Try again in a moment.");
      }
    } catch {
      setError("Couldn't save. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }, [data, perTx, perDay, reserve, selected, fetchPolicy]);

  const dirty = useMemo(() => {
    if (!data) return false;
    const catsDiff =
      selected.size !== data.allowed_categories.length ||
      data.allowed_categories.some((c) => !selected.has(c));
    return (
      catsDiff ||
      perTx !== data.bands.justDoItPerTx ||
      perDay !== data.bands.justDoItPerDay ||
      reserve !== data.bands.minWalletBalance
    );
  }, [data, selected, perTx, perDay, reserve]);

  if (loading) {
    return (
      <div
        className="glass rounded-2xl p-6 animate-pulse"
        style={{ border: "1px solid var(--border)", height: 320 }}
      />
    );
  }
  // Error-vs-null: a failed /policy load used to silently vanish the whole panel
  // (return null). After loading, !data only happens on a failed fetch (success
  // always hydrates), so show a small inline retry instead of disappearing.
  if (!data) {
    return (
      <div className="glass rounded-2xl p-6" style={{ border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: "var(--accent, #DC6743)" }} />
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Couldn&apos;t load your spending controls.
          </p>
          <button
            onClick={() => fetchPolicy()}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all active:scale-95 cursor-pointer"
            style={{ background: "rgba(0,0,0,0.05)", border: "1px solid var(--border)" }}
          >
            <RotateCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  const a = data.autonomy;
  const td = data.tier_default_bands;
  const aboveTier = data.all_categories.filter((c) => !data.tier_default_categories.includes(c));

  // ── GAP-1 headline content ──
  const bindingMsg: Record<string, string> = {
    earned: "its earned trust, which grows as it makes good decisions",
    daily_limit: "your daily ceiling",
    wallet: "its wallet balance",
  };

  return (
    <div className="glass rounded-2xl p-6 sm:p-7" style={{ border: "1px solid var(--border)" }}>
      {/* ── The contract, in one sentence (§6) — funding + posture, read-only. ── */}
      <div
        className="rounded-xl p-5 mb-5"
        style={{ background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.05)" }}
      >
        <p className="text-[13px] leading-relaxed" style={{ color: "var(--foreground)" }}>
          Your agent spends from a wallet <span className="font-medium">you fund</span> (we cover the
          gas).{" "}
          {data.bands.justDoItPerTx === 0 ? (
            <>It asks before every purchase</>
          ) : (
            <>
              It asks before any single purchase over{" "}
              <span className="font-semibold" style={{ color: ACCENT }}>
                {usd(data.bands.justDoItPerTx)}
              </span>
            </>
          )}
          {a && a.binding !== "spend_disabled" ? (
            <>
              , and stays within a daily allowance it earns (
              <span className="font-semibold">{usd(a.earnedDailyBudgetUsd)}</span>/day so far)
            </>
          ) : (
            <>, and stays within a daily allowance it earns</>
          )}
          .{" "}
          {data.bands.minWalletBalance === 0 ? (
            <>It holds nothing back in reserve.</>
          ) : (
            <>
              It always keeps{" "}
              <span className="font-semibold">{usd(data.bands.minWalletBalance)}</span> in reserve.
            </>
          )}
        </p>
      </div>

      {/* ── Agent suggestion (from a /settings deep link). Pre-filled below, UNSAVED;
          your Save is the consent. Shown only when the page could pre-fill it. ── */}
      {suggestMsg && !saved && (
        <div
          className="rounded-xl p-3 mb-5 flex items-start gap-2"
          style={{ background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)" }}
        >
          <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "rgb(234,179,8)" }} />
          <p className="text-[12px] leading-snug" style={{ color: "var(--foreground)" }}>
            {suggestMsg}
          </p>
        </div>
      )}

      {/* ── Low-balance soft warning (§16.5): fires with runway (< ~1 day of the
          earned budget left), above the hard floor. A nudge, not a block. ── */}
      {a &&
        a.binding !== "spend_disabled" &&
        a.binding !== "balance_unknown" &&
        a.walletBalanceUsd != null &&
        a.walletHeadroomUsd > 0 &&
        a.walletHeadroomUsd < a.earnedDailyBudgetUsd && (
          <div
            className="rounded-xl p-3 mb-5 flex items-start gap-2"
            style={{ background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)" }}
          >
            <AlertTriangle
              className="w-3.5 h-3.5 mt-0.5 shrink-0"
              style={{ color: "rgb(234,179,8)" }}
            />
            <p className="text-[12px] leading-snug" style={{ color: "var(--foreground)" }}>
              Running low — about a day of spending left. Top up the wallet when you get a chance and
              your agent keeps handling things on its own.
            </p>
          </div>
        )}

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
              ? "Couldn't load your agent's current spending power. Refresh in a moment."
              : "Loading…"}
          </p>
        ) : a.binding === "spend_disabled" ? (
          <>
            <p className="text-2xl font-semibold tracking-tight">Off</p>
            <p className="text-xs mt-1 leading-snug" style={{ color: "var(--muted)" }}>
              Autonomous spending is off. Your agent asks before every purchase.
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
                  ? "It's used its autonomous budget for today. Resets on a rolling 24 hours."
                  : "It hasn't earned spending room yet. This grows as it makes good decisions."}
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

      {/* ── GAP-2: no-ask ceilings. Per-tx is bidirectional (raise to the plan cap
          or tighten); daily is tighten-only. The gate binds the real autonomous
          spend to the earned budget regardless. ── */}
      <div className="flex items-center gap-2 mb-1">
        <Hand className="w-4 h-4" style={{ color: "var(--muted)" }} />
        <h3 className="text-sm font-medium">Ask-first ceilings</h3>
      </div>
      <p className="text-[11px] mb-4 leading-snug" style={{ color: "var(--muted)" }}>
        The most your agent spends without asking. It grows toward these as it earns trust, and the gate always
        uses whichever is lower (what it&apos;s earned, or your ceiling). Raise the per-purchase line up to your
        plan&apos;s hard cap, or pull it down to stay cautious. The daily line you can only tighten.
      </p>

      {/* Presets (§6): one tap across the spectrum for the per-tx no-ask line.
          "Ask me first" = 0 (most cautious). "Earned autonomy" = the tier default.
          "Plan max" = the hard cap (neverPerTx). The gate still binds the actual
          autonomous spend to what the agent has earned, so Plan max raises the
          ceiling, not the spend. */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <PresetBtn
          label="Ask me first"
          active={perTx === 0}
          onClick={() => {
            setSaved(false);
            setPerTx(0);
          }}
        />
        <PresetBtn
          label="Earned autonomy"
          active={perTx === td.justDoItPerTx}
          onClick={() => {
            setSaved(false);
            setPerTx(td.justDoItPerTx);
          }}
        />
        <PresetBtn
          label="Plan max"
          active={perTx === data.bands.neverPerTx}
          onClick={() => {
            setSaved(false);
            setPerTx(data.bands.neverPerTx);
          }}
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <BandInput
          label="Any single purchase over"
          value={perTx}
          tierDefault={td.justDoItPerTx}
          max={data.bands.neverPerTx}
          onChange={(v) => {
            setSaved(false);
            setPerTx(clampBand(v, data.bands.neverPerTx));
          }}
        />
        <BandInput
          label="Total daily spend over"
          value={perDay}
          tierDefault={td.justDoItPerDay}
          max={td.justDoItPerDay}
          onChange={(v) => {
            setSaved(false);
            setPerDay(clampBand(v, td.justDoItPerDay));
          }}
        />
      </div>

      {/* ── Reserve (§16): bidirectional (Slice B #2b). The minimum the agent leaves
          in the wallet; lower it toward $0 to let the agent spend the wallet down, or
          raise it for a bigger cushion. The gate floors the effective value at 0. ── */}
      <div className="mb-4">
        <ReserveInput
          value={reserve}
          tierDefault={td.minWalletBalance}
          onChange={(v) => {
            setSaved(false);
            setReserve(Math.max(0, Number.isFinite(v) ? v : 0));
          }}
        />
      </div>

      <p className="text-[11px] mb-6 flex items-start gap-1.5" style={{ color: "var(--muted)" }}>
        <Lock className="w-3 h-3 mt-0.5 shrink-0" />
        <span>
          Hard limits (set by your {data.tier} plan, can&apos;t be exceeded): never over {usd(data.bands.neverPerTx)} per
          purchase or {usd(data.bands.neverPerDay)} per day. Your reserve is yours to set, down to $0.
        </span>
      </p>

      {/* ── Categories (tighten-only allowlist) ── */}
      <div className="flex items-center gap-2 mb-1">
        <Tag className="w-4 h-4" style={{ color: "var(--muted)" }} />
        <h3 className="text-sm font-medium">What it may buy on its own</h3>
      </div>
      <p className="text-[11px] mb-3 leading-snug" style={{ color: "var(--muted)" }}>
        Uncheck anything you&apos;d rather approve case by case. Those still work, your agent just asks first.
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
            {aboveTier.includes("market") ? ". Trading stays approval-only by design." : "."}
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
            Categories are being set up. Check back shortly.
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
  tierDefault,
  max,
  onChange,
}: {
  label: string;
  value: number;
  tierDefault: number;
  max: number;
  onChange: (v: number) => void;
}) {
  // Color relative to the tier default: below = tightened (cautious, green), above
  // = raised toward the plan cap (amber), exactly at = neutral. The daily line is
  // passed tierDefault === max so it can only ever read tightened or neutral.
  const cueColor =
    value < tierDefault
      ? "rgb(34,197,94)"
      : value > tierDefault
        ? "rgb(234,179,8)"
        : "var(--foreground)";
  return (
    <label className="block rounded-xl p-3" style={{ background: "rgba(0,0,0,0.025)", border: "1px solid rgba(0,0,0,0.06)" }}>
      <span className="text-[11px] block mb-1.5" style={{ color: "var(--muted)" }}>
        Ask before {label}
      </span>
      <div className="flex items-center gap-1">
        <span className="text-lg font-semibold" style={{ color: cueColor }}>$</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={max}
          step={tierDefault <= 5 ? 0.25 : 1}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full bg-transparent text-lg font-semibold tracking-tight outline-none"
          style={{ color: cueColor }}
        />
      </div>
      <span className="text-[10px]" style={{ color: "var(--muted)" }}>
        your plan allows up to {`$${max.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
      </span>
    </label>
  );
}

/** A small posture preset pill (sets the per-tx ceiling to one end). */
function PresetBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-full text-xs font-medium transition-all active:scale-95 cursor-pointer"
      style={{
        background: active ? "rgba(34,197,94,0.10)" : "rgba(0,0,0,0.04)",
        border: active ? "1px solid rgba(34,197,94,0.30)" : "1px solid var(--border)",
        color: active ? "rgb(21,128,61)" : "var(--foreground)",
      }}
    >
      {label}
    </button>
  );
}

/**
 * The reserve control: bidirectional (Slice B #2b). The amount the agent leaves in
 * the wallet: lower toward $0 to let it spend the wallet down ("spend it all"), or
 * raise it for a bigger cushion. The gate floors the effective value at 0.
 */
function ReserveInput({ value, tierDefault, onChange }: { value: number; tierDefault: number; onChange: (v: number) => void }) {
  // Inverted vs the ask-first lines: RAISING the reserve is the cautious direction
  // (green); LOWERING it toward $0 leans in (amber); exactly at the default is neutral.
  const cueColor =
    value > tierDefault
      ? "rgb(34,197,94)"
      : value < tierDefault
        ? "rgb(234,179,8)"
        : "var(--foreground)";
  return (
    <label className="block rounded-xl p-3" style={{ background: "rgba(0,0,0,0.025)", border: "1px solid rgba(0,0,0,0.06)" }}>
      <span className="text-[11px] block mb-1.5" style={{ color: "var(--muted)" }}>
        Keep in reserve (your agent won&apos;t spend below this)
      </span>
      <div className="flex items-center gap-1">
        <span className="text-lg font-semibold" style={{ color: cueColor }}>$</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step={tierDefault <= 5 ? 0.25 : 1}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full bg-transparent text-lg font-semibold tracking-tight outline-none"
          style={{ color: cueColor }}
        />
      </div>
      <span className="text-[10px]" style={{ color: "var(--muted)" }}>
        set to $0 to let it spend the wallet down · your plan reserves {`$${tierDefault.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} by default
      </span>
    </label>
  );
}
