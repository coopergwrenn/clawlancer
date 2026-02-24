"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ChevronDown,
  Wallet,
  Eye,
  BarChart3,
  Shield,
  ScrollText,
  RefreshCw,
  AlertTriangle,
  MessageSquare,
  CheckCircle2,
  Info,
} from "lucide-react";

// ── Types ───────────────────────────────────────────

interface WalletInfo {
  address: string;
  chain_id: number;
  created_at: string;
}

interface WatchlistMarket {
  id: string;
  question: string;
  alertThreshold: number;
  lastPrice: number;
  lastChecked: string;
  notes: string;
  alerts: { type: string; value: number; triggered: boolean }[];
  positionRef: string | null;
}

interface Watchlist {
  version: number;
  markets: WatchlistMarket[];
}

interface Position {
  marketId: string;
  question: string;
  outcome: string;
  shares: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: string;
}

interface RiskConfig {
  enabled: boolean;
  dailySpendCapUSDC: number;
  confirmationThresholdUSDC: number;
  dailyLossLimitUSDC: number;
  maxPositionSizeUSDC: number;
}

interface Trade {
  id: string;
  timestamp: string;
  question: string;
  outcome: string;
  side: string;
  price: number;
  shares: number;
  totalUSDC: number;
  reasoning: string;
}

// ── Helpers ─────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function truncateAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ── Copyable Bot Message (same pattern as earn page) ──

function BotMessage({ message }: { message: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="rounded-lg p-4 mt-3"
      style={{ background: "rgba(59,130,246,0.05)", border: "1px solid rgba(59,130,246,0.12)" }}
    >
      <div className="flex items-start gap-2.5">
        <MessageSquare className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "rgb(59,130,246)" }} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium mb-1.5" style={{ color: "rgb(59,130,246)" }}>
            Try messaging your bot:
          </p>
          <p className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
            &ldquo;{message}&rdquo;
          </p>
        </div>
        <button
          onClick={() => {
            navigator.clipboard.writeText(message);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="px-2.5 py-1 rounded-md text-[11px] font-medium cursor-pointer transition-all shrink-0"
          style={{
            background: copied ? "rgba(34,197,94,0.1)" : "rgba(59,130,246,0.1)",
            color: copied ? "rgb(34,197,94)" : "rgb(59,130,246)",
            border: copied ? "1px solid rgba(34,197,94,0.2)" : "1px solid rgba(59,130,246,0.2)",
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}

// ── Section Wrapper ─────────────────────────────────

function Section({
  icon: Icon,
  title,
  subtitle,
  defaultOpen = false,
  badge,
  children,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className="glass rounded-xl overflow-hidden"
      style={{ border: "1px solid var(--border)" }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 cursor-pointer text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Icon className="w-4 h-4 shrink-0" style={{ color: "var(--muted)" }} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{title}</span>
              {badge && (
                <span
                  className="px-2 py-0.5 rounded-full text-xs shrink-0"
                  style={{
                    background: "rgba(249,115,22,0.1)",
                    color: "#ea580c",
                    border: "1px solid rgba(249,115,22,0.2)",
                  }}
                >
                  {badge}
                </span>
              )}
            </div>
            {subtitle && (
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{subtitle}</p>
            )}
          </div>
        </div>
        <ChevronDown
          className="w-4 h-4 shrink-0 ml-2 transition-transform"
          style={{
            color: "var(--muted)",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main Panel ──────────────────────────────────────

export default function PolymarketPanel() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [watchlist, setWatchlist] = useState<Watchlist | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [riskConfig, setRiskConfig] = useState<RiskConfig | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [settingUpWallet, setSettingUpWallet] = useState(false);
  const [savingRisk, setSavingRisk] = useState(false);
  const [riskDraft, setRiskDraft] = useState<RiskConfig | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const showToast = useCallback((msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const fetchFile = useCallback(async (filePath: string) => {
    try {
      const res = await fetch(`/api/vm/files?file=${encodeURIComponent(filePath)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.content ? JSON.parse(data.content) : null;
    } catch {
      return null;
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [w, wl, pos, rc, tl] = await Promise.all([
      fetchFile("~/.openclaw/polymarket/wallet.json"),
      fetchFile("~/memory/polymarket-watchlist.json"),
      fetchFile("~/.openclaw/polymarket/positions.json"),
      fetchFile("~/.openclaw/polymarket/risk-config.json"),
      fetchFile("~/.openclaw/polymarket/trade-log.json"),
    ]);
    setWallet(w);
    setWatchlist(wl);
    setPositions(pos?.positions ?? []);
    setRiskConfig(rc);
    setRiskDraft(rc);
    setTrades(tl?.trades ?? []);
    setLoading(false);
  }, [fetchFile]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  async function handleSetupWallet() {
    setSettingUpWallet(true);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setup_polymarket_wallet" }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast("Trading account created!", "success");
        fetchAll();
      } else {
        showToast(data.error || "Setup failed — try again", "error");
      }
    } catch {
      showToast("Network error — check your connection", "error");
    } finally {
      setSettingUpWallet(false);
    }
  }

  async function handleSaveRisk() {
    if (!riskDraft) return;
    setSavingRisk(true);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_polymarket_risk",
          riskConfig: riskDraft,
        }),
      });
      if (res.ok) {
        setRiskConfig(riskDraft);
        showToast("Safety limits saved!", "success");
      } else {
        const data = await res.json();
        showToast(data.error || "Failed to save", "error");
      }
    } catch {
      showToast("Network error — check your connection", "error");
    } finally {
      setSavingRisk(false);
    }
  }

  if (loading) {
    return (
      <div
        className="glass rounded-xl p-8 text-center"
        style={{ border: "1px solid var(--border)" }}
      >
        <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" style={{ color: "var(--muted)" }} />
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading prediction market data...</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-6 right-6 z-50 px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg"
            style={{
              background: toast.type === "success" ? "#16a34a" : "#ef4444",
              color: "#fff",
            }}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Refresh */}
      <div className="flex justify-end">
        <button
          onClick={fetchAll}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all"
          style={{
            background: "rgba(0,0,0,0.04)",
            color: "var(--muted)",
            border: "1px solid var(--border)",
          }}
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      {/* ── 1. Trading Account ── */}
      <Section
        icon={Wallet}
        title="Trading Account"
        subtitle="Required before your agent can place any bets"
        defaultOpen
        badge={wallet ? truncateAddr(wallet.address) : undefined}
      >
        {wallet ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" style={{ color: "var(--success)" }} />
              <span className="text-sm font-medium" style={{ color: "var(--success)" }}>Account ready</span>
            </div>
            <div className="grid gap-2 text-xs" style={{ color: "var(--muted)" }}>
              <div className="flex justify-between">
                <span>Wallet address</span>
                <span className="font-mono">{wallet.address}</span>
              </div>
              <div className="flex justify-between">
                <span>Created</span>
                <span>{new Date(wallet.created_at).toLocaleDateString()}</span>
              </div>
            </div>
            <div
              className="rounded-lg p-3 flex items-start gap-2"
              style={{ background: "rgba(59,130,246,0.04)", border: "1px solid rgba(59,130,246,0.1)" }}
            >
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "rgb(59,130,246)" }} />
              <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
                To start trading, you&apos;ll need to add funds. Ask your bot how to deposit.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
              Your agent needs a trading account to place bets on prediction markets.
              This creates a secure wallet that only your agent can access.
            </p>
            <div
              className="rounded-lg p-3 flex items-start gap-2"
              style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
            >
              <Shield className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--muted)" }} />
              <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
                No money is spent until you fund the account and turn on trading below.
              </p>
            </div>
            <button
              onClick={handleSetupWallet}
              disabled={settingUpWallet}
              className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                color: "#fff",
                boxShadow: "0 0 0 1px rgba(249,115,22,0.3), 0 2px 8px rgba(249,115,22,0.25)",
              }}
            >
              {settingUpWallet ? "Creating account..." : "Create Trading Account"}
            </button>
          </div>
        )}
      </Section>

      {/* ── 2. Markets You're Watching ── */}
      <Section
        icon={Eye}
        title="Markets You're Watching"
        subtitle="Your agent tracks these and alerts you when odds change"
        badge={watchlist?.markets.length ? `${watchlist.markets.length}` : undefined}
      >
        {watchlist?.markets.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: "var(--muted)" }}>
                  <th className="text-left pb-2 font-medium">Question</th>
                  <th className="text-right pb-2 font-medium">Odds</th>
                  <th className="text-right pb-2 font-medium">Alert at</th>
                  <th className="text-right pb-2 font-medium">Last checked</th>
                </tr>
              </thead>
              <tbody>
                {watchlist.markets.map((m) => (
                  <tr
                    key={m.id}
                    className="border-t"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <td className="py-2 pr-3 max-w-[200px] truncate">
                      {m.question}
                    </td>
                    <td className="py-2 text-right font-mono font-semibold">
                      {(m.lastPrice * 100).toFixed(0)}%
                    </td>
                    <td className="py-2 text-right" style={{ color: "var(--muted)" }}>
                      {m.alertThreshold ? `${(m.alertThreshold * 100).toFixed(0)}% change` : "—"}
                    </td>
                    <td className="py-2 text-right" style={{ color: "var(--muted)" }}>
                      {m.lastChecked ? timeAgo(m.lastChecked) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              You&apos;re not watching any markets yet. Ask your bot to find interesting
              predictions to track.
            </p>
            <BotMessage message="What are the hottest prediction markets right now?" />
          </div>
        )}
      </Section>

      {/* ── 3. Your Active Bets ── */}
      {(positions.length > 0 || riskConfig?.enabled) && (
        <Section
          icon={BarChart3}
          title="Your Active Bets"
          subtitle="Positions your agent is currently holding"
          badge={positions.length ? `${positions.length}` : undefined}
        >
          {positions.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: "var(--muted)" }}>
                    <th className="text-left pb-2 font-medium">Market</th>
                    <th className="text-right pb-2 font-medium">Bet on</th>
                    <th className="text-right pb-2 font-medium">Shares</th>
                    <th className="text-right pb-2 font-medium">Bought at</th>
                    <th className="text-right pb-2 font-medium">Now</th>
                    <th className="text-right pb-2 font-medium">Profit/Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => (
                    <tr
                      key={`${p.marketId}-${i}`}
                      className="border-t"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <td className="py-2 pr-3 max-w-[180px] truncate">
                        {p.question}
                      </td>
                      <td className="py-2 text-right">{p.outcome}</td>
                      <td className="py-2 text-right font-mono">
                        {p.shares.toFixed(1)}
                      </td>
                      <td className="py-2 text-right font-mono">
                        ${p.avgEntryPrice.toFixed(2)}
                      </td>
                      <td className="py-2 text-right font-mono">
                        ${p.currentPrice.toFixed(2)}
                      </td>
                      <td
                        className="py-2 text-right font-mono font-semibold"
                        style={{
                          color: p.unrealizedPnl >= 0 ? "var(--success)" : "#ef4444",
                        }}
                      >
                        {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No active bets. Once you turn on trading and fund your account, your agent
                can start placing bets for you.
              </p>
              <BotMessage message="What predictions do you think are good bets right now?" />
            </div>
          )}
        </Section>
      )}

      {/* ── 4. Safety Limits ── */}
      <Section
        icon={Shield}
        title="Safety Limits"
        subtitle="Control how much your agent can spend"
      >
        {riskDraft ? (
          <div className="space-y-4">
            {/* Trading toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">
                  {riskDraft.enabled ? "Trading is turned on" : "Let my agent place bets"}
                </p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  {riskDraft.enabled
                    ? "Your agent can bet within the limits you set below."
                    : "Flip this on to allow your agent to trade. You control all the limits."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRiskDraft({ ...riskDraft, enabled: !riskDraft.enabled })}
                className="relative w-12 h-7 rounded-full transition-all cursor-pointer shrink-0"
                style={{
                  background: riskDraft.enabled
                    ? "linear-gradient(135deg, rgba(249,115,22,0.8), rgba(234,88,12,0.9))"
                    : "rgba(0,0,0,0.08)",
                  boxShadow: riskDraft.enabled
                    ? "0 0 0 1px rgba(249,115,22,0.3), 0 2px 6px rgba(249,115,22,0.2)"
                    : "0 0 0 1px rgba(0,0,0,0.08)",
                }}
              >
                <span
                  className="absolute top-1 w-5 h-5 rounded-full transition-all"
                  style={{
                    left: riskDraft.enabled ? "24px" : "4px",
                    background: "white",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                    transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
                  }}
                />
              </button>
            </div>

            {riskDraft.enabled && (
              <>
                <div
                  className="flex items-start gap-2 p-3 rounded-lg"
                  style={{
                    background: "rgba(249,115,22,0.06)",
                    border: "1px solid rgba(249,115,22,0.15)",
                  }}
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#ea580c" }} />
                  <p className="text-xs" style={{ color: "#ea580c" }}>
                    Trading is on. Your agent will respect the limits below. Any bet larger
                    than your confirmation amount will need your approval first.
                  </p>
                </div>

                {/* Settings with plain English labels */}
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    {
                      key: "dailySpendCapUSDC" as const,
                      label: "Max daily spending",
                      help: "Your agent won't spend more than this per day",
                    },
                    {
                      key: "confirmationThresholdUSDC" as const,
                      label: "Ask me before spending over",
                      help: "Bets above this amount need your OK first",
                    },
                    {
                      key: "dailyLossLimitUSDC" as const,
                      label: "Stop if I lose more than",
                      help: "Trading pauses for the day if losses hit this",
                    },
                    {
                      key: "maxPositionSizeUSDC" as const,
                      label: "Biggest single bet",
                      help: "The most your agent can put on one outcome",
                    },
                  ].map(({ key, label, help }) => (
                    <div key={key}>
                      <label className="text-xs font-medium block mb-0.5">
                        {label}
                      </label>
                      <p className="text-[11px] mb-1.5" style={{ color: "var(--muted)" }}>
                        {help}
                      </p>
                      <div className="relative">
                        <span
                          className="absolute left-3 top-1/2 -translate-y-1/2 text-sm"
                          style={{ color: "var(--muted)" }}
                        >
                          $
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={riskDraft[key]}
                          onChange={(e) =>
                            setRiskDraft({
                              ...riskDraft,
                              [key]: Math.min(500, Math.max(1, Number(e.target.value) || 1)),
                            })
                          }
                          className="w-full pl-7 pr-3 py-2 rounded-lg text-sm outline-none"
                          style={{
                            background: "var(--card)",
                            border: "1px solid var(--border)",
                            color: "var(--foreground)",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Save button */}
            <button
              onClick={handleSaveRisk}
              disabled={savingRisk}
              className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, rgba(22,22,22,0.85), rgba(40,40,40,0.95))",
                color: "#fff",
                boxShadow: "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15)",
              }}
            >
              {savingRisk ? "Saving..." : "Save Limits"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Create a trading account first, then you can set spending limits here.
            </p>
          </div>
        )}
      </Section>

      {/* ── 5. Trade History ── */}
      <Section
        icon={ScrollText}
        title="Trade History"
        subtitle="Every bet your agent has placed, with its reasoning"
        badge={trades.length ? `${trades.length}` : undefined}
      >
        {trades.length ? (
          <div className="space-y-2">
            {[...trades].reverse().slice(0, 20).map((t) => (
              <div
                key={t.id}
                className="flex items-start gap-3 py-2 border-t"
                style={{ borderColor: "var(--border)" }}
              >
                <div
                  className="px-1.5 py-0.5 rounded text-xs font-mono font-semibold shrink-0 mt-0.5"
                  style={{
                    background: t.side === "BUY" ? "rgba(22,163,74,0.1)" : "rgba(239,68,68,0.1)",
                    color: t.side === "BUY" ? "#16a34a" : "#ef4444",
                  }}
                >
                  {t.side === "BUY" ? "BET" : "SOLD"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{t.question}</p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    {t.outcome} &middot; {t.shares.toFixed(1)} shares @ ${t.price.toFixed(2)} &middot; ${t.totalUSDC.toFixed(2)} total
                  </p>
                  {t.reasoning && (
                    <p className="text-xs mt-1 truncate" style={{ color: "var(--muted)", opacity: 0.7 }}>
                      Why: {t.reasoning}
                    </p>
                  )}
                </div>
                <span className="text-xs shrink-0" style={{ color: "var(--muted)" }}>
                  {timeAgo(t.timestamp)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              No trades yet. Once trading is on, every bet your agent places will show up
              here with the reasoning behind it.
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}
