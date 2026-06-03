"use client";

import { useState, useEffect, useCallback } from "react";
import { Check, RotateCw, ShieldCheck, Tag, Lock } from "lucide-react";

/**
 * Live spend-policy controls for /economy.
 *
 * Reads /api/agent-economy/policy (the SAME effective bands + category allowlist
 * the authorize gate enforces — lib/frontier-overrides-db is the one canonical
 * reader) and lets the user TIGHTEN the category allowlist (turn off categories
 * their agent may buy autonomously). Limits are shown read-only — they're set by
 * the plan tier + earned trust, and the override path (tighten-only band caps) is
 * wired in the gate + API but not yet exposed as sliders here.
 *
 * Tighten-only by construction: the checkboxes only cover the tier's default
 * categories. Categories above the plan (incl. "market"/trading) are shown
 * greyed — they can't be enabled here (the gate intersects with the tier default).
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

interface PolicyResponse {
  tier: string;
  bands: {
    justDoItPerTx: number;
    justDoItPerDay: number;
    neverPerTx: number;
    neverPerDay: number;
    minWalletBalance: number;
  };
  all_categories: string[];
  tier_default_categories: string[];
  allowed_categories: string[];
  allowed_categories_persisted?: boolean;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function EconomyPolicyControls() {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/agent-economy/policy")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PolicyResponse | null) => {
        if (d) {
          setData(d);
          setSelected(new Set(d.allowed_categories));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = useCallback((cat: string) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setError(null);
    setPending(false);
    setSaved(false);
    try {
      // Tighten-only: only ever send categories within the tier default.
      const allowed = data.tier_default_categories.filter((c) => selected.has(c));
      const res = await fetch("/api/agent-economy/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowed_categories: allowed }),
      });
      const j = await res.json();
      if (res.ok && j.ok) {
        if (j.allowed_categories_persisted === false) {
          setPending(true);
        } else {
          setSaved(true);
          setSelected(new Set(j.allowed_categories));
        }
      } else {
        setError("Couldn't save — try again in a moment.");
      }
    } catch {
      setError("Couldn't save — try again in a moment.");
    } finally {
      setSaving(false);
    }
  }, [data, selected]);

  if (loading) {
    return (
      <div className="glass rounded-2xl p-6 animate-pulse" style={{ border: "1px solid var(--border)", height: 220 }} />
    );
  }
  if (!data) return null;

  const dirty =
    selected.size !== data.allowed_categories.length ||
    data.allowed_categories.some((c) => !selected.has(c));
  const aboveTier = data.all_categories.filter((c) => !data.tier_default_categories.includes(c));

  return (
    <div className="glass rounded-2xl p-6" style={{ border: "1px solid var(--border)" }}>
      {/* Limits (read-only, live from the gate) */}
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck className="w-4 h-4" style={{ color: "var(--muted)" }} />
        <h3 className="text-sm font-medium">Spending limits</h3>
        <span
          className="text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide"
          style={{ background: "rgba(255,255,255,0.05)", color: "var(--muted)" }}
        >
          {data.tier}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-2">
        {[
          { label: "No-ask, per purchase", value: data.bands.justDoItPerTx },
          { label: "No-ask, per day", value: data.bands.justDoItPerDay },
          { label: "Hard cap, per purchase", value: data.bands.neverPerTx },
          { label: "Hard cap, per day", value: data.bands.neverPerDay },
          { label: "Always keep in wallet", value: data.bands.minWalletBalance },
        ].map((b) => (
          <div key={b.label} className="rounded-lg p-3" style={{ background: "rgba(255,255,255,0.025)" }}>
            <p className="text-[10px] uppercase tracking-wide mb-0.5" style={{ color: "var(--muted)" }}>
              {b.label}
            </p>
            <p className="text-sm font-semibold tracking-tight">{usd(b.value)}</p>
          </div>
        ))}
      </div>
      <p className="text-[11px] leading-snug mb-6" style={{ color: "var(--muted)" }}>
        Set by your plan and the trust your agent earns — a new agent starts well below these and grows into them.
        Anything above the no-ask line still comes to you for approval.
      </p>

      {/* Categories (editable, tighten-only) */}
      <div className="flex items-center gap-2 mb-1">
        <Tag className="w-4 h-4" style={{ color: "var(--muted)" }} />
        <h3 className="text-sm font-medium">What your agent may buy on its own</h3>
      </div>
      <p className="text-[11px] mb-3" style={{ color: "var(--muted)" }}>
        Uncheck anything you&apos;d rather approve case by case. Unchecked categories still work — your agent just asks first.
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
                background: on ? "rgba(34,197,94,0.08)" : "rgba(255,255,255,0.025)",
                border: on ? "1px solid rgba(34,197,94,0.2)" : "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span
                className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                style={{
                  background: on ? "rgb(34,197,94)" : "transparent",
                  border: on ? "none" : "1px solid var(--border)",
                }}
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
            Not available for autonomous spend:{" "}
            {aboveTier.map((c) => CATEGORY_LABELS[c] ?? c).join(", ")}
            {aboveTier.includes("market") ? " — trading stays approval-only by design." : "."}
          </p>
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-default"
          style={{ background: "rgba(255,255,255,0.08)", border: "1px solid var(--border)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saving && <RotateCw className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--muted)" }} />}
        {saved && (
          <span className="text-xs flex items-center gap-1" style={{ color: "rgb(34,197,94)" }}>
            <Check className="w-3.5 h-3.5" /> Saved
          </span>
        )}
        {pending && (
          <span className="text-xs" style={{ color: "rgb(234,179,8)" }}>
            Being set up — check back shortly.
          </span>
        )}
        {error && <span className="text-xs" style={{ color: "rgb(239,68,68)" }}>{error}</span>}
      </div>
    </div>
  );
}
