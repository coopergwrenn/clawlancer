"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Coins,
  Wallet,
  ShieldCheck,
  TrendingUp,
  Sparkles,
  Lock,
  Copy,
  Check,
  AlertTriangle,
  RotateCw,
  ArrowUpRight,
  Hand,
  Trophy,
} from "lucide-react";
import { EconomyPolicyControls } from "@/components/dashboard/economy-policy-controls";
import { EconomyHero, CARD_STYLE } from "@/components/dashboard/economy-hero";
import { EconomyActivityFeed, type ActivityRow } from "@/components/dashboard/economy-activity-feed";
import { EconomyCounterparties } from "@/components/dashboard/economy-counterparties";

// ── Types ──────────────────────────────────────────────────────────────────

interface SpendSettings {
  spend_enabled: boolean;
  wallet_address: string | null;
  wallet_balance_usd: number | null;
}

interface EconomyState {
  window_24h: { earned_usdc: number; spent_usdc: number; net_usdc: number; transactions: number };
  lifetime: { earned_usdc: number; spent_usdc: number; net_usdc: number; truncated: boolean };
  reputation_score: number | null;
  active_offerings: number;
  recent: ActivityRow[];
  recent_has_more?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtUsd = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EconomyPage() {
  const [settings, setSettings] = useState<SpendSettings | null>(null);
  const [econ, setEcon] = useState<EconomyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [noVm, setNoVm] = useState(false);
  // Distinct from !econ: a transient /state failure must degrade to "couldn't
  // load, retry" — NOT the brand-new first-run hero, which would misrepresent a
  // real user's actual state. (#2 error-state fix, misrepresentation subset.)
  const [loadError, setLoadError] = useState(false);

  // Opt-in toggle interaction state
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingSetup, setPendingSetup] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    let stateFailed = false;
    try {
      const [sRes, eRes] = await Promise.all([
        fetch("/api/agent-economy/spend-settings"),
        fetch("/api/agent-economy/state"),
      ]);
      if (sRes.status === 404 || eRes.status === 404) {
        setNoVm(true);
        return;
      }
      if (sRes.ok) setSettings(await sRes.json());
      // /state drives firstRun; a transient failure here must NOT be read as
      // "brand-new user" (the hero asserts a state we can't actually confirm).
      if (eRes.ok) setEcon(await eRes.json());
      else stateFailed = true;
    } catch {
      // Network throw — we genuinely don't know the user's economy state.
      stateFailed = true;
    } finally {
      setLoadError(stateFailed);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      setSaveError(null);
      setPendingSetup(false);
      try {
        const res = await fetch("/api/agent-economy/spend-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        const j = await res.json();
        if (res.ok && j.ok) {
          setSettings((s) => (s ? { ...s, spend_enabled: enabled } : s));
        } else if (j.reason === "pending_setup") {
          setPendingSetup(true);
        } else {
          setSaveError("Couldn't save that. Try again in a moment.");
        }
      } catch {
        setSaveError("Couldn't save that. Try again in a moment.");
      } finally {
        setSaving(false);
        setConfirmEnable(false);
      }
    },
    [],
  );

  const copyAddr = useCallback(() => {
    if (!settings?.wallet_address) return;
    navigator.clipboard.writeText(settings.wallet_address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [settings?.wallet_address]);

  const enabled = settings?.spend_enabled === true;
  // First-run = the agent has no economic activity yet (every real user today). This
  // is the flagship surface, not an edge case: show the anticipatory economic-actor
  // hero rather than zeroed cards. Rich-data hero is a separate next pass.
  const firstRun = !econ || (econ.lifetime.earned_usdc === 0 && econ.lifetime.spent_usdc === 0);

  // ── Render ──

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <div className="h-10 w-48 rounded-lg animate-pulse" style={{ background: "rgba(0,0,0,0.05)" }} />
        <div className="h-48 rounded-2xl animate-pulse" style={{ background: "rgba(0,0,0,0.04)" }} />
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="h-36 rounded-2xl animate-pulse" style={{ background: "rgba(0,0,0,0.04)" }} />
          <div className="h-36 rounded-2xl animate-pulse" style={{ background: "rgba(0,0,0,0.04)" }} />
        </div>
      </div>
    );
  }

  if (noVm) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="glass rounded-2xl p-10 text-center" style={{ border: "1px solid var(--border)" }}>
          <div
            className="w-12 h-12 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))" }}
          >
            <Coins className="w-6 h-6" style={{ color: "var(--muted)" }} />
          </div>
          <h2 className="text-lg font-medium mb-1">No agent yet</h2>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Your agent&apos;s economy appears here once it&apos;s set up.
          </p>
        </div>
      </div>
    );
  }

  // ── Load error (distinct from first-run): /state genuinely failed and we have
  //    no economy data, so we must NOT render the "you're brand new" hero. Show a
  //    neutral retry instead — a hiccup never gets to misrepresent a real user. ──
  if (loadError && !econ) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="glass rounded-2xl p-10 text-center" style={{ border: "1px solid var(--border)" }}>
          <div
            className="w-12 h-12 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: "rgba(220,103,67,0.10)" }}
          >
            <AlertTriangle className="w-6 h-6" style={{ color: "var(--accent, #DC6743)" }} />
          </div>
          <h2 className="text-lg font-medium mb-1">Couldn&apos;t load your economy</h2>
          <p className="text-sm mb-5 max-w-sm mx-auto" style={{ color: "var(--muted)" }}>
            This is usually temporary. Your agent&apos;s wallet, standing, and activity are safe.
          </p>
          <button
            onClick={() => load()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium transition-all active:scale-95 cursor-pointer"
            style={{ background: "rgba(0,0,0,0.05)", border: "1px solid var(--border)" }}
          >
            <RotateCw className="w-3.5 h-3.5" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      {/* ── First-run: the economic-actor hero (the flagship surface every user hits today).
             Rich-data header/hero is the next state-by-state pass. ── */}
      {firstRun ? (
        <EconomyHero
          walletAddress={settings?.wallet_address ?? null}
          standingScore={econ?.reputation_score ?? null}
        />
      ) : (
        <div>
          <h1
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] flex items-center gap-3"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            <Coins className="w-7 h-7 sm:w-8 sm:h-8" style={{ color: "var(--accent, #DC6743)" }} />
            Economy
          </h1>
          <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
            Where your agent earns, spends, and builds a reputation, always under limits you set.
          </p>
        </div>
      )}

      {/* ── CONTROL: Autonomous spending (the real, wired control — secondary to the
             hero, which owns the headline). A calm light card, not a second hero. ── */}
      <section
        className="rounded-2xl p-6 sm:p-7 relative overflow-hidden"
        style={{
          background: enabled
            ? "linear-gradient(135deg, rgba(34,197,94,0.07), rgba(255,255,255,0.92))"
            : "#ffffff",
          border: enabled ? "1px solid rgba(34,197,94,0.30)" : "1px solid rgba(0,0,0,0.08)",
          boxShadow: enabled
            ? "0 4px 18px rgba(34,150,90,0.10), inset 0 1px 0 rgba(255,255,255,0.9)"
            : "0 4px 16px rgba(120,70,50,0.06), inset 0 1px 0 rgba(255,255,255,0.9)",
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2.5 mb-2">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  background: enabled
                    ? "linear-gradient(135deg, rgba(34,197,94,0.22), rgba(34,197,94,0.10))"
                    : "rgba(0,0,0,0.04)",
                }}
              >
                {enabled ? (
                  <Sparkles className="w-5 h-5" style={{ color: "rgb(34,197,94)" }} />
                ) : (
                  <Lock className="w-5 h-5" style={{ color: "var(--muted)" }} />
                )}
              </div>
              <h2 className="text-lg font-medium">Autonomous spending</h2>
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                style={{
                  background: enabled ? "rgba(34,197,94,0.16)" : "rgba(0,0,0,0.05)",
                  color: enabled ? "rgb(22,163,74)" : "var(--muted)",
                }}
              >
                {enabled ? "On" : "Off"}
              </span>
            </div>
            <p className="text-sm max-w-xl" style={{ color: "var(--muted)" }}>
              {enabled
                ? "Your agent can pay for services on its own, within the limits it earns. It still asks you before anything large or unusual, and you can switch this off instantly."
                : "Off by default. Your agent will ask you before paying for anything. Turn this on to let it handle small, routine purchases on its own, within limits it earns over time."}
            </p>
          </div>

          {/* The toggle — canonical InstaClaw switch */}
          <button
            onClick={() => {
              if (saving) return;
              if (enabled) setEnabled(false);
              else setConfirmEnable(true);
            }}
            disabled={saving}
            className="relative w-12 h-7 rounded-full transition-all flex-shrink-0 cursor-pointer disabled:opacity-50"
            style={{
              background: enabled
                ? "linear-gradient(135deg, rgba(34,197,94,0.9), rgba(22,163,74,0.95))"
                : "rgba(0,0,0,0.13)",
              boxShadow: enabled
                ? "0 0 0 1px rgba(34,197,94,0.35), 0 2px 8px rgba(34,197,94,0.25), inset 0 1px 0 rgba(255,255,255,0.25)"
                : "inset 0 1px 2px rgba(0,0,0,0.12)",
            }}
            aria-label={enabled ? "Disable autonomous spending" : "Enable autonomous spending"}
          >
            <span
              className="absolute top-1 w-5 h-5 rounded-full"
              style={{
                left: enabled ? "24px" : "4px",
                background: "linear-gradient(135deg, rgba(255,255,255,0.98), rgba(240,240,240,0.92))",
                boxShadow: "0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.6)",
                transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
              }}
            />
          </button>
        </div>

        {/* Safety rails — always visible, reassuring */}
        <div className="mt-5 grid sm:grid-cols-3 gap-3">
          {[
            { icon: TrendingUp, title: "Earned limits", body: "Spending room grows only as your agent makes good decisions." },
            { icon: Hand, title: "Asks first", body: "Anything large or unfamiliar still comes to you for approval." },
            { icon: ShieldCheck, title: "Always reversible", body: "Switch off here anytime. A global stop protects the whole fleet." },
          ].map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl p-3.5"
              style={{ background: "rgba(0,0,0,0.025)", border: "1px solid rgba(0,0,0,0.06)" }}
            >
              <Icon className="w-4 h-4 mb-1.5" style={{ color: "var(--muted)" }} />
              <p className="text-xs font-medium mb-0.5">{title}</p>
              <p className="text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
                {body}
              </p>
            </div>
          ))}
        </div>

        {/* Inline states */}
        {saving && (
          <div className="mt-4 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
            <RotateCw className="w-3 h-3 animate-spin" />
            Saving…
          </div>
        )}
        {pendingSetup && (
          <div
            className="mt-4 rounded-xl p-3.5 flex items-start gap-2.5"
            style={{ background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.2)" }}
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "rgb(234,179,8)" }} />
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              This control is being switched on for your account. Check back shortly. (Your agent stays in
              ask-first mode until then.)
            </p>
          </div>
        )}
        {saveError && (
          <div className="mt-4 text-xs" style={{ color: "rgb(239,68,68)" }}>
            {saveError}
          </div>
        )}

        {/* Confirm-on-enable */}
        {confirmEnable && (
          <div
            className="mt-4 rounded-2xl p-5"
            style={{
              background: "linear-gradient(135deg, rgba(34,197,94,0.10), rgba(255,255,255,0.9))",
              border: "1px solid rgba(34,197,94,0.28)",
              boxShadow: "0 2px 10px rgba(34,150,90,0.06)",
            }}
          >
            <p className="text-sm font-medium mb-1">Let your agent spend on its own?</p>
            <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
              Your agent will be able to pay for small, routine services without checking in first, capped by the
              limits it earns. It still asks you before anything large, and you can turn this off in one tap.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setEnabled(true)}
                disabled={saving}
                className="px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, rgba(34,197,94,0.9), rgba(22,163,74,0.95))",
                  color: "#fff",
                  boxShadow: "0 2px 8px rgba(34,197,94,0.25)",
                }}
              >
                Enable spending
              </button>
              <button
                onClick={() => setConfirmEnable(false)}
                disabled={saving}
                className="px-4 py-2 rounded-full text-sm font-medium transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                style={{ background: "rgba(0,0,0,0.04)", border: "1px solid var(--border)" }}
              >
                Not yet
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── Recent activity — the live stream of the agent's economic decisions.
             Universal (gated on recent.length, not firstRun): a populated feed
             for any agent that's transacted, a crafted empty state otherwise. ── */}
      <EconomyActivityFeed recent={econ?.recent ?? null} hasMore={econ?.recent_has_more ?? false} />

      {/* ── Wallet + Standing — only in the rich-data state; the first-run hero
             presents these as the agent's economic identity instead. ── */}
      {!firstRun && (
      <>
      <div className="grid sm:grid-cols-2 gap-4">
        {/* Wallet */}
        <div className="rounded-2xl p-6" style={CARD_STYLE}>
          <div className="flex items-center gap-2 mb-4">
            <Wallet className="w-4 h-4" style={{ color: "var(--muted)" }} />
            <h3 className="text-sm font-medium">Wallet</h3>
          </div>
          {settings?.wallet_address ? (
            <>
              <div className="flex items-baseline gap-2 mb-3">
                <span className="text-[1.9rem] leading-none tracking-tight tabular-nums" style={{ fontFamily: "var(--font-serif)" }}>
                  {fmtUsd(settings.wallet_balance_usd)}
                </span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  USDC · Base
                </span>
              </div>
              <button
                onClick={copyAddr}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
                style={{ background: "rgba(0,0,0,0.035)", border: "1px solid rgba(0,0,0,0.08)", color: "var(--muted)" }}
              >
                {copied ? <Check className="w-3 h-3" style={{ color: "rgb(34,197,94)" }} /> : <Copy className="w-3 h-3" />}
                {copied ? "Copied" : shortAddr(settings.wallet_address)}
              </button>
              <p className="text-[11px] mt-4 leading-snug" style={{ color: "var(--muted)" }}>
                Your agent&apos;s on-chain wallet. Funding it from the dashboard is coming soon. For now, send USDC to
                this address on Base.
              </p>
            </>
          ) : (
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              A wallet is being provisioned for your agent. Check back in a few minutes.
            </p>
          )}
        </div>

        {/* Standing */}
        <div className="rounded-2xl p-6" style={CARD_STYLE}>
          <div className="flex items-center gap-2 mb-4">
            <Trophy className="w-4 h-4" style={{ color: "var(--muted)" }} />
            <h3 className="text-sm font-medium">Standing</h3>
          </div>
          {econ && (econ.lifetime.earned_usdc > 0 || econ.lifetime.spent_usdc > 0) && econ.reputation_score != null ? (
            <>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-[1.9rem] leading-none tracking-tight tabular-nums" style={{ fontFamily: "var(--font-serif)" }}>{econ.reputation_score}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  credit standing
                </span>
              </div>
              <p className="text-[11px] mt-3 leading-snug" style={{ color: "var(--muted)" }}>
                Built from your agent&apos;s track record. Higher standing earns it more spending room.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm mb-1">No track record yet</p>
              <p className="text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
                Your agent builds a credit standing as it transacts. Good decisions earn it more autonomy over time.
              </p>
            </>
          )}
        </div>
      </div>

      {/* ── Activity (real, last 24h + lifetime) ── */}
      <div className="rounded-2xl p-6" style={CARD_STYLE}>
        <div className="flex items-center gap-2 mb-5">
          <TrendingUp className="w-4 h-4" style={{ color: "var(--muted)" }} />
          <h3 className="text-sm font-medium">Activity</h3>
        </div>
        {econ && (econ.lifetime.earned_usdc > 0 || econ.lifetime.spent_usdc > 0) ? (
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Earned", value: econ.lifetime.earned_usdc, color: "rgb(34,197,94)" },
              { label: "Spent", value: econ.lifetime.spent_usdc, color: "var(--foreground)" },
              { label: "Net", value: econ.lifetime.net_usdc, color: econ.lifetime.net_usdc >= 0 ? "rgb(34,197,94)" : "rgb(239,68,68)" },
            ].map((s) => (
              <div key={s.label}>
                <p className="text-[11px] uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>
                  {s.label}
                </p>
                <p className="text-2xl leading-none tracking-tight tabular-nums" style={{ fontFamily: "var(--font-serif)", color: s.color }}>
                  {fmtUsd(s.value)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No transactions yet. When your agent earns or spends, you&apos;ll see the running totals here.
          </p>
        )}
      </div>

      {/* ── Who it works with — the ledger pivoted by relationship (suppliers +
             reliability), sitting on the same CARD_STYLE material as Wallet /
             Standing / Activity. Self-fetches; owns its own loading/empty/error. ── */}
      <EconomyCounterparties />
      </>
      )}

      {/* ── Spending controls (real, wired to /api/agent-economy/policy) ── */}
      <EconomyPolicyControls />

      {/* ── What's coming (honest scaffold — no fake data, no dead controls) ── */}
      <div>
        <h2 className="text-sm font-medium mb-3 flex items-center gap-2" style={{ color: "var(--muted)" }}>
          <Sparkles className="w-3.5 h-3.5" />
          The rest of the picture
        </h2>
        <div className="rounded-2xl divide-y" style={{ border: "1px solid var(--border)", borderColor: "var(--border)" }}>
          {[
            { title: "Earning a living", body: "Your agent offers its own services and gets paid by other agents." },
            { title: "Staking", body: "Back your agent with $INSTACLAW to raise its limits and signal trust." },
          ].map((row, i) => (
            <div
              key={row.title}
              className="flex items-start justify-between gap-4 p-4"
              style={{ borderColor: "var(--border)", background: i % 2 ? "transparent" : "rgba(0,0,0,0.018)" }}
            >
              <div>
                <p className="text-sm font-medium mb-0.5">{row.title}</p>
                <p className="text-xs leading-snug" style={{ color: "var(--muted)" }}>
                  {row.body}
                </p>
              </div>
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 mt-0.5"
                style={{ background: "rgba(0,0,0,0.045)", color: "var(--muted)", border: "1px solid rgba(0,0,0,0.08)" }}
              >
                Coming soon
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
