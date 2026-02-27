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
  Copy,
  Check,
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

// ── Step Indicator ──────────────────────────────────

function StepIndicator({ step, completed, active }: { step: number; completed: boolean; active: boolean }) {
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
      style={{
        background: completed
          ? "rgba(34,197,94,0.1)"
          : active
            ? "rgba(249,115,22,0.1)"
            : "rgba(0,0,0,0.04)",
        color: completed
          ? "rgb(34,197,94)"
          : active
            ? "rgb(249,115,22)"
            : "var(--muted)",
        border: completed
          ? "1px solid rgba(34,197,94,0.2)"
          : active
            ? "1px solid rgba(249,115,22,0.2)"
            : "1px solid var(--border)",
      }}
    >
      {completed ? <Check className="w-4 h-4" /> : step}
    </div>
  );
}

// ── Risk Limit Inputs ───────────────────────────────

const RISK_FIELDS: { key: keyof Omit<RiskConfig, "enabled">; label: string; help: string }[] = [
  {
    key: "dailySpendCapUSDC",
    label: "Max daily spending",
    help: "Your agent won't spend more than this per day",
  },
  {
    key: "confirmationThresholdUSDC",
    label: "Ask me before spending over",
    help: "Bets above this amount need your OK first",
  },
  {
    key: "dailyLossLimitUSDC",
    label: "Stop if I lose more than",
    help: "Trading pauses for the day if losses hit this",
  },
  {
    key: "maxPositionSizeUSDC",
    label: "Biggest single trade",
    help: "The most your agent can put on one outcome",
  },
];

function RiskLimitInputs({
  riskDraft,
  setRiskDraft,
}: {
  riskDraft: RiskConfig;
  setRiskDraft: (rc: RiskConfig) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {RISK_FIELDS.map(({ key, label, help }) => (
        <div key={key}>
          <label className="text-xs font-medium block mb-0.5">{label}</label>
          <p className="text-[11px] mb-1.5" style={{ color: "var(--muted)" }}>{help}</p>
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
  );
}

// ── Main Panel ──────────────────────────────────────

export default function PolymarketPanel({
  onStatusChange,
}: {
  onStatusChange?: (status: string) => void;
}) {
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

  // Derive setup state
  const setupComplete = wallet != null && riskConfig?.enabled === true;

  // Report status to parent
  useEffect(() => {
    if (loading || !onStatusChange) return;
    if (!wallet) {
      onStatusChange("not_set_up");
    } else if (wallet && riskConfig?.enabled) {
      onStatusChange("active");
    } else if (wallet && riskConfig && !riskConfig.enabled) {
      onStatusChange("paused");
    } else {
      onStatusChange("setting_up");
    }
  }, [loading, wallet, riskConfig, onStatusChange]);

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

      {setupComplete ? (
        <DashboardView
          wallet={wallet!}
          watchlist={watchlist}
          positions={positions}
          riskConfig={riskConfig!}
          riskDraft={riskDraft!}
          setRiskDraft={setRiskDraft}
          trades={trades}
          savingRisk={savingRisk}
          handleSaveRisk={handleSaveRisk}
        />
      ) : (
        <SetupFlow
          wallet={wallet}
          riskDraft={riskDraft}
          setRiskDraft={setRiskDraft}
          settingUpWallet={settingUpWallet}
          savingRisk={savingRisk}
          handleSetupWallet={handleSetupWallet}
          handleSaveRisk={handleSaveRisk}
        />
      )}
    </div>
  );
}

// ── Setup Flow ──────────────────────────────────────

function SetupFlow({
  wallet,
  riskDraft,
  setRiskDraft,
  settingUpWallet,
  savingRisk,
  handleSetupWallet,
  handleSaveRisk,
}: {
  wallet: WalletInfo | null;
  riskDraft: RiskConfig | null;
  setRiskDraft: (rc: RiskConfig | null) => void;
  settingUpWallet: boolean;
  savingRisk: boolean;
  handleSetupWallet: () => void;
  handleSaveRisk: () => void;
}) {
  const hasWallet = wallet != null;
  const [addrCopied, setAddrCopied] = useState(false);

  // Initialize risk draft with defaults if wallet exists but no config yet
  useEffect(() => {
    if (hasWallet && !riskDraft) {
      setRiskDraft({
        enabled: false,
        dailySpendCapUSDC: 25,
        confirmationThresholdUSDC: 10,
        dailyLossLimitUSDC: 15,
        maxPositionSizeUSDC: 10,
      });
    }
  }, [hasWallet, riskDraft, setRiskDraft]);

  return (
    <div className="space-y-4">
      {/* ── Step 1: Create Wallet ── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="glass rounded-xl p-5"
        style={{ border: hasWallet ? "1px solid rgba(34,197,94,0.2)" : "1px solid var(--border)" }}
      >
        <div className="flex items-start gap-3">
          <StepIndicator step={1} completed={hasWallet} active={!hasWallet} />
          <div className="flex-1 min-w-0">
            {hasWallet ? (
              <div>
                <p className="text-sm font-semibold" style={{ color: "rgb(34,197,94)" }}>
                  Trading account created
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                  Created {new Date(wallet.created_at).toLocaleDateString()}
                </p>
              </div>
            ) : (
              <div>
                <h3 className="text-lg font-semibold mb-1">Get Started with Polymarket</h3>
                <p className="text-sm mb-4" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                  Your agent needs a trading account to track and trade on Polymarket.
                  This creates a secure wallet that only your agent can access.
                </p>
                <div
                  className="rounded-lg p-3 flex items-start gap-2 mb-4"
                  style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
                >
                  <Shield className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--muted)" }} />
                  <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
                    No money is spent until you fund it and enable trading.
                  </p>
                </div>
                <button
                  onClick={handleSetupWallet}
                  disabled={settingUpWallet}
                  className="px-5 py-2.5 rounded-lg text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
                  style={{
                    background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                    color: "#fff",
                    boxShadow: "0 0 0 1px rgba(249,115,22,0.3), 0 2px 8px rgba(249,115,22,0.25)",
                  }}
                >
                  {settingUpWallet ? "Creating account..." : (
                    <>
                      Create Wallet
                      <span
                        className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide"
                        style={{
                          background: "rgba(255,255,255,0.25)",
                          backdropFilter: "blur(8px)",
                          color: "#fff",
                          border: "1px solid rgba(255,255,255,0.3)",
                        }}
                      >
                        Free
                      </span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </motion.div>

      {/* ── Step 2: Fund Wallet ── */}
      <AnimatePresence>
        {hasWallet && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.05 }}
            className="glass rounded-xl p-5"
            style={{ border: "1px solid var(--border)" }}
          >
            <div className="flex items-start gap-3">
              <StepIndicator step={2} completed={false} active={true} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold mb-1">Fund Your Wallet</p>
                <p className="text-xs mb-3" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
                  Send USDC (Polygon) to your trading wallet. Your agent can&apos;t trade until the wallet has funds.
                </p>

                {/* Address display + copy */}
                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-2.5"
                  style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
                >
                  <Wallet className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
                  <span className="text-xs font-mono flex-1 truncate">{wallet.address}</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(wallet.address);
                      setAddrCopied(true);
                      setTimeout(() => setAddrCopied(false), 2000);
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer transition-all shrink-0"
                    style={{
                      background: addrCopied ? "rgba(34,197,94,0.1)" : "rgba(59,130,246,0.1)",
                      color: addrCopied ? "rgb(34,197,94)" : "rgb(59,130,246)",
                      border: addrCopied ? "1px solid rgba(34,197,94,0.2)" : "1px solid rgba(59,130,246,0.2)",
                    }}
                  >
                    {addrCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {addrCopied ? "Copied!" : "Copy"}
                  </button>
                </div>

                <div
                  className="rounded-lg p-3 flex items-start gap-2 mt-3"
                  style={{ background: "rgba(59,130,246,0.04)", border: "1px solid rgba(59,130,246,0.1)" }}
                >
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "rgb(59,130,246)" }} />
                  <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
                    You can also ask your bot how to deposit funds.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Step 3: Set Safety Limits ── */}
      <AnimatePresence>
        {hasWallet && riskDraft && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
            className="glass rounded-xl p-5"
            style={{ border: "1px solid var(--border)" }}
          >
            <div className="flex items-start gap-3">
              <StepIndicator step={3} completed={false} active={true} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold mb-1">Set Safety Limits</p>
                <p className="text-xs mb-4" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
                  Control how much your agent can spend. You can change these anytime.
                </p>
                <RiskLimitInputs riskDraft={riskDraft} setRiskDraft={setRiskDraft} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Step 4: Enable Trading ── */}
      <AnimatePresence>
        {hasWallet && riskDraft && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.15 }}
            className="glass rounded-xl p-5"
            style={{ border: "1px solid var(--border)" }}
          >
            <div className="flex items-start gap-3">
              <StepIndicator step={4} completed={false} active={true} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold mb-1">Enable Trading</p>
                <p className="text-xs mb-4" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
                  Flip the switch and save to let your agent trade within the limits you set above.
                </p>

                {/* Trading toggle */}
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-medium">
                    {riskDraft.enabled ? "Trading is on" : "Let my agent place trades"}
                  </p>
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
                  <div
                    className="flex items-start gap-2 p-3 rounded-lg mb-4"
                    style={{
                      background: "rgba(249,115,22,0.06)",
                      border: "1px solid rgba(249,115,22,0.15)",
                    }}
                  >
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#ea580c" }} />
                    <p className="text-xs" style={{ color: "#ea580c" }}>
                      Trading will be on. Your agent will respect the limits above. Any trade
                      larger than your confirmation amount will need your approval first.
                    </p>
                  </div>
                )}

                <button
                  onClick={handleSaveRisk}
                  disabled={savingRisk}
                  className="px-5 py-2.5 rounded-lg text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
                  style={{
                    background: riskDraft.enabled
                      ? "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))"
                      : "linear-gradient(135deg, rgba(22,22,22,0.85), rgba(40,40,40,0.95))",
                    color: "#fff",
                    boxShadow: riskDraft.enabled
                      ? "0 0 0 1px rgba(249,115,22,0.3), 0 2px 8px rgba(249,115,22,0.25)"
                      : "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15)",
                  }}
                >
                  {savingRisk ? "Saving..." : riskDraft.enabled ? "Save & Enable Trading" : "Save Limits"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Dashboard View ──────────────────────────────────

function DashboardView({
  wallet,
  watchlist,
  positions,
  riskConfig,
  riskDraft,
  setRiskDraft,
  trades,
  savingRisk,
  handleSaveRisk,
}: {
  wallet: WalletInfo;
  watchlist: Watchlist | null;
  positions: Position[];
  riskConfig: RiskConfig;
  riskDraft: RiskConfig;
  setRiskDraft: (rc: RiskConfig | null) => void;
  trades: Trade[];
  savingRisk: boolean;
  handleSaveRisk: () => void;
}) {
  const [addrCopied, setAddrCopied] = useState(false);

  return (
    <div className="space-y-3">
      {/* ── Status Card ── */}
      <div
        className="glass rounded-xl p-4"
        style={{
          border: riskConfig.enabled
            ? "1px solid rgba(34,197,94,0.2)"
            : "1px solid rgba(249,115,22,0.2)",
          background: riskConfig.enabled
            ? "rgba(34,197,94,0.03)"
            : "rgba(249,115,22,0.03)",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                background: riskConfig.enabled ? "rgb(34,197,94)" : "rgb(249,115,22)",
              }}
            />
            <span className="text-sm font-semibold">
              {riskConfig.enabled ? "Trading Active" : "Trading Paused"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              const toggled = { ...riskDraft, enabled: !riskDraft.enabled };
              setRiskDraft(toggled);
              // Auto-save the toggle
              fetch("/api/settings/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "update_polymarket_risk", riskConfig: toggled }),
              });
            }}
            className="relative w-11 h-6 rounded-full transition-all cursor-pointer shrink-0"
            style={{
              background: riskDraft.enabled
                ? "linear-gradient(135deg, rgba(34,197,94,0.7), rgba(22,163,74,0.85))"
                : "rgba(0,0,0,0.08)",
              boxShadow: riskDraft.enabled
                ? "0 0 0 1px rgba(34,197,94,0.3)"
                : "0 0 0 1px rgba(0,0,0,0.08)",
            }}
          >
            <span
              className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
              style={{
                left: riskDraft.enabled ? "22px" : "2px",
                background: "white",
                boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
              }}
            />
          </button>
        </div>

        <div className="flex items-center justify-between text-xs" style={{ color: "var(--muted)" }}>
          <div className="flex items-center gap-2">
            <Wallet className="w-3 h-3" />
            <span className="font-mono">{truncateAddr(wallet.address)}</span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(wallet.address);
                setAddrCopied(true);
                setTimeout(() => setAddrCopied(false), 2000);
              }}
              className="cursor-pointer"
              style={{ color: addrCopied ? "rgb(34,197,94)" : "var(--muted)" }}
            >
              {addrCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
          {positions.length > 0 && (
            <span>
              <BarChart3 className="w-3 h-3 inline mr-1" />
              {positions.length} active position{positions.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* ── Markets You're Watching ── */}
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

      {/* ── Trade History ── */}
      <Section
        icon={ScrollText}
        title="Trade History"
        subtitle="Every trade your agent has placed, with its reasoning"
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
              No trades yet. Once trading is on, every trade your agent places will show up
              here with the reasoning behind it.
            </p>
          </div>
        )}
      </Section>

      {/* ── Safety Limits ── */}
      <Section
        icon={Shield}
        title="Safety Limits"
        subtitle="Control how much your agent can spend"
      >
        <div className="space-y-4">
          <RiskLimitInputs riskDraft={riskDraft} setRiskDraft={(rc) => setRiskDraft(rc)} />
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
      </Section>
    </div>
  );
}
