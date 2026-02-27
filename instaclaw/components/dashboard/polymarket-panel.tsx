"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  DollarSign,
  TrendingUp,
  Pause,
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

const DEFAULT_RISK: RiskConfig = {
  enabled: false,
  dailySpendCapUSDC: 25,
  confirmationThresholdUSDC: 10,
  dailyLossLimitUSDC: 15,
  maxPositionSizeUSDC: 5,
};

// Check USDC balance on Polygon via public RPC
async function fetchUsdcBalance(address: string): Promise<number> {
  const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const callData = (token: string) =>
    "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const rpcCall = (token: string) =>
    fetch("https://polygon-rpc.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: token, data: callData(token) }, "latest"],
        id: 1,
      }),
    }).then((r) => r.json());

  const [a, b] = await Promise.all([rpcCall(USDC), rpcCall(USDC_E)]);
  const parse = (hex: string | undefined) =>
    hex && hex !== "0x" ? parseInt(hex, 16) / 1e6 : 0;
  return parse(a.result) + parse(b.result);
}

// ── Copyable Bot Message ────────────────────────────

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

// ── Progress Bar ────────────────────────────────────

const STEP_LABELS = ["Create Wallet", "Fund Wallet", "Set Limits", "Start Trading"];

function ProgressBar({ currentStep, completedSteps }: { currentStep: number; completedSteps: Set<number> }) {
  return (
    <div className="flex items-center gap-1 mb-5">
      {STEP_LABELS.map((label, i) => {
        const num = i + 1;
        const done = completedSteps.has(num);
        const active = num === currentStep;
        return (
          <div key={num} className="flex items-center gap-1 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                style={{
                  background: done
                    ? "rgba(34,197,94,0.12)"
                    : active
                      ? "rgba(249,115,22,0.12)"
                      : "rgba(0,0,0,0.04)",
                  color: done
                    ? "rgb(34,197,94)"
                    : active
                      ? "rgb(249,115,22)"
                      : "var(--muted)",
                  border: done
                    ? "1.5px solid rgba(34,197,94,0.3)"
                    : active
                      ? "1.5px solid rgba(249,115,22,0.3)"
                      : "1.5px solid var(--border)",
                }}
              >
                {done ? <Check className="w-3 h-3" /> : num}
              </div>
              <span
                className="text-[10px] font-medium truncate hidden sm:block"
                style={{
                  color: done ? "rgb(34,197,94)" : active ? "rgb(249,115,22)" : "var(--muted)",
                }}
              >
                {label}
              </span>
            </div>
            {i < 3 && (
              <div
                className="flex-1 h-px mx-1"
                style={{
                  background: done ? "rgba(34,197,94,0.3)" : "var(--border)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Risk Limit Inputs ───────────────────────────────

const RISK_FIELDS: { key: keyof Omit<RiskConfig, "enabled">; label: string; help: string }[] = [
  {
    key: "maxPositionSizeUSDC",
    label: "Maximum per trade",
    help: "The most your agent can spend on a single trade",
  },
  {
    key: "dailySpendCapUSDC",
    label: "Maximum per day",
    help: "Total your agent can spend across all trades in one day",
  },
  {
    key: "confirmationThresholdUSDC",
    label: "Ask me before spending over",
    help: "Trades above this amount need your approval first",
  },
  {
    key: "dailyLossLimitUSDC",
    label: "Stop-loss for the day",
    help: "Trading pauses automatically if daily losses hit this",
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
          <label className="text-xs font-semibold block mb-0.5">{label}</label>
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
  const [balance, setBalance] = useState<number | null>(null);
  const [checkingBalance, setCheckingBalance] = useState(false);
  const [limitsSaved, setLimitsSaved] = useState(false);
  const [fundingSkipped, setFundingSkipped] = useState(false);
  const balancePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    setRiskDraft(rc ?? DEFAULT_RISK);
    setTrades(tl?.trades ?? []);
    setLoading(false);
  }, [fetchFile]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Check balance when wallet exists
  const checkBalance = useCallback(async (address: string) => {
    setCheckingBalance(true);
    try {
      const bal = await fetchUsdcBalance(address);
      setBalance(bal);
    } catch {
      // keep existing balance on error
    } finally {
      setCheckingBalance(false);
    }
  }, []);

  // Auto-check balance on wallet load + poll every 15s until funded
  useEffect(() => {
    if (!wallet) return;
    checkBalance(wallet.address);
  }, [wallet, checkBalance]);

  useEffect(() => {
    if (!wallet || (balance !== null && balance > 0)) {
      if (balancePollRef.current) clearInterval(balancePollRef.current);
      return;
    }
    balancePollRef.current = setInterval(() => {
      if (wallet) checkBalance(wallet.address);
    }, 15000);
    return () => {
      if (balancePollRef.current) clearInterval(balancePollRef.current);
    };
  }, [wallet, balance, checkBalance]);

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

  // BUG FIX: Set wallet state directly from API response instead of relying on fetchAll
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
        // Set wallet state directly — no fetchAll race condition
        if (data.address) {
          const newWallet: WalletInfo = {
            address: data.address,
            chain_id: 137,
            created_at: new Date().toISOString(),
          };
          setWallet(newWallet);
          setRiskConfig(DEFAULT_RISK);
          setRiskDraft({ ...DEFAULT_RISK });
          // Trigger initial balance check
          checkBalance(data.address);
        }
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
        setLimitsSaved(true);
        showToast(riskDraft.enabled ? "Trading enabled!" : "Safety limits saved!", "success");
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

  async function handleEnableTrading() {
    if (!riskDraft) return;
    const updated = { ...riskDraft, enabled: true };
    setRiskDraft(updated);
    setSavingRisk(true);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_polymarket_risk",
          riskConfig: updated,
        }),
      });
      if (res.ok) {
        setRiskConfig(updated);
        showToast("Trading is live! Your agent is now monitoring Polymarket.", "success");
      } else {
        const data = await res.json();
        showToast(data.error || "Failed to enable", "error");
        setRiskDraft({ ...updated, enabled: false });
      }
    } catch {
      showToast("Network error — check your connection", "error");
      setRiskDraft({ ...updated, enabled: false });
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

  const isFunded = balance !== null && balance > 0;

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

      {setupComplete ? (
        <DashboardView
          wallet={wallet!}
          watchlist={watchlist}
          positions={positions}
          riskConfig={riskConfig!}
          riskDraft={riskDraft!}
          setRiskConfig={setRiskConfig}
          setRiskDraft={setRiskDraft}
          trades={trades}
          savingRisk={savingRisk}
          handleSaveRisk={handleSaveRisk}
          balance={balance}
          checkingBalance={checkingBalance}
          onCheckBalance={() => wallet && checkBalance(wallet.address)}
          fetchAll={fetchAll}
          showToast={showToast}
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
          handleEnableTrading={handleEnableTrading}
          balance={balance}
          checkingBalance={checkingBalance}
          onCheckBalance={() => wallet && checkBalance(wallet.address)}
          isFunded={isFunded}
          limitsSaved={limitsSaved}
          fundingSkipped={fundingSkipped}
          onSkipFunding={() => setFundingSkipped(true)}
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
  handleEnableTrading,
  balance,
  checkingBalance,
  onCheckBalance,
  isFunded,
  limitsSaved,
  fundingSkipped,
  onSkipFunding,
}: {
  wallet: WalletInfo | null;
  riskDraft: RiskConfig | null;
  setRiskDraft: (rc: RiskConfig | null) => void;
  settingUpWallet: boolean;
  savingRisk: boolean;
  handleSetupWallet: () => void;
  handleSaveRisk: () => void;
  handleEnableTrading: () => void;
  balance: number | null;
  checkingBalance: boolean;
  onCheckBalance: () => void;
  isFunded: boolean;
  limitsSaved: boolean;
  fundingSkipped: boolean;
  onSkipFunding: () => void;
}) {
  const hasWallet = wallet != null;
  const [addrCopied, setAddrCopied] = useState(false);
  const step2Unlocked = hasWallet;
  const step3Unlocked = hasWallet && (isFunded || fundingSkipped);
  const step4Unlocked = step3Unlocked && limitsSaved;

  // Derive current step + completed steps
  const completedSteps = new Set<number>();
  if (hasWallet) completedSteps.add(1);
  if (isFunded) completedSteps.add(2);
  if (limitsSaved) completedSteps.add(3);

  let currentStep = 1;
  if (hasWallet) currentStep = 2;
  if (step3Unlocked) currentStep = 3;
  if (step4Unlocked) currentStep = 4;

  return (
    <div>
      {/* Progress indicator */}
      <ProgressBar currentStep={currentStep} completedSteps={completedSteps} />

      <div className="space-y-3">
        {/* ── Step 1: Create Wallet ── */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="rounded-xl p-5"
          style={{
            border: hasWallet ? "1px solid rgba(34,197,94,0.2)" : "1px solid var(--border)",
            background: hasWallet ? "rgba(34,197,94,0.02)" : "var(--card)",
          }}
        >
          {hasWallet ? (
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "rgba(34,197,94,0.1)", border: "1.5px solid rgba(34,197,94,0.3)" }}
              >
                <Check className="w-4 h-4" style={{ color: "rgb(34,197,94)" }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold" style={{ color: "rgb(34,197,94)" }}>
                  Wallet created
                </p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  {truncateAddr(wallet.address)} &middot; Created {new Date(wallet.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>
          ) : (
            <div>
              <h3 className="text-lg font-semibold mb-1">Get Started with Polymarket</h3>
              <p className="text-sm mb-4" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                Your agent needs a trading wallet to place trades on Polymarket.
                This creates a secure Polygon wallet that only your agent controls.
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
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                  color: "#fff",
                  boxShadow: "0 0 0 1px rgba(249,115,22,0.3), 0 2px 8px rgba(249,115,22,0.25)",
                }}
              >
                {settingUpWallet ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Creating your secure wallet...
                  </>
                ) : (
                  <>
                    Create Wallet
                    <span
                      className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide"
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
        </motion.div>

        {/* ── Step 2: Fund Wallet ── */}
        <AnimatePresence>
          {step2Unlocked && wallet && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08 }}
              className="rounded-xl p-5"
              style={{
                border: isFunded
                  ? "1px solid rgba(34,197,94,0.2)"
                  : currentStep === 2
                    ? "1px solid rgba(249,115,22,0.2)"
                    : "1px solid var(--border)",
                background: isFunded
                  ? "rgba(34,197,94,0.02)"
                  : "var(--card)",
              }}
            >
              {isFunded ? (
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: "rgba(34,197,94,0.1)", border: "1.5px solid rgba(34,197,94,0.3)" }}
                  >
                    <Check className="w-4 h-4" style={{ color: "rgb(34,197,94)" }} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "rgb(34,197,94)" }}>
                      Wallet funded
                    </p>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      Balance: ${balance?.toFixed(2)} USDC
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <DollarSign className="w-4 h-4" style={{ color: "rgb(249,115,22)" }} />
                      <p className="text-sm font-semibold">Fund Your Wallet</p>
                    </div>
                    {/* Balance display */}
                    <div className="flex items-center gap-2">
                      <span
                        className="text-sm font-bold tabular-nums"
                        style={{ color: balance !== null && balance > 0 ? "rgb(34,197,94)" : "var(--muted)" }}
                      >
                        ${balance !== null ? balance.toFixed(2) : "0.00"} USDC
                      </span>
                      <button
                        onClick={onCheckBalance}
                        disabled={checkingBalance}
                        className="p-1 rounded-md cursor-pointer transition-all disabled:opacity-50"
                        style={{ color: "var(--muted)" }}
                        title="Check balance"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${checkingBalance ? "animate-spin" : ""}`} />
                      </button>
                    </div>
                  </div>

                  <p className="text-xs mb-3" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                    Send USDC on Polygon to this address to fund your agent&apos;s trading wallet.
                  </p>

                  {/* Big address + copy */}
                  <div
                    className="flex items-center gap-2 rounded-lg px-4 py-3 mb-3"
                    style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
                  >
                    <Wallet className="w-4 h-4 shrink-0" style={{ color: "var(--muted)" }} />
                    <span className="text-xs sm:text-sm font-mono flex-1 truncate">{wallet.address}</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(wallet.address);
                        setAddrCopied(true);
                        setTimeout(() => setAddrCopied(false), 2000);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all shrink-0"
                      style={{
                        background: addrCopied ? "rgba(34,197,94,0.1)" : "rgba(59,130,246,0.1)",
                        color: addrCopied ? "rgb(34,197,94)" : "rgb(59,130,246)",
                        border: addrCopied ? "1px solid rgba(34,197,94,0.2)" : "1px solid rgba(59,130,246,0.2)",
                      }}
                    >
                      {addrCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {addrCopied ? "Copied!" : "Copy Address"}
                    </button>
                  </div>

                  {/* Helper text */}
                  <div
                    className="rounded-lg p-3 flex items-start gap-2 mb-3"
                    style={{ background: "rgba(59,130,246,0.04)", border: "1px solid rgba(59,130,246,0.1)" }}
                  >
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "rgb(59,130,246)" }} />
                    <div className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                      <p>
                        You can buy USDC on Coinbase, Binance, or any major exchange, then withdraw to Polygon.
                      </p>
                      <p className="mt-1 font-medium">
                        We recommend starting with $10&ndash;50 USDC.
                      </p>
                    </div>
                  </div>

                  {/* Skip option */}
                  <button
                    onClick={onSkipFunding}
                    className="text-[11px] font-medium cursor-pointer transition-all"
                    style={{ color: "var(--muted)", opacity: 0.7 }}
                  >
                    Skip &mdash; I&apos;ll fund later
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Step 3: Set Safety Limits ── */}
        <AnimatePresence>
          {step3Unlocked && riskDraft && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08 }}
              className="rounded-xl p-5"
              style={{
                border: limitsSaved
                  ? "1px solid rgba(34,197,94,0.2)"
                  : currentStep === 3
                    ? "1px solid rgba(249,115,22,0.2)"
                    : "1px solid var(--border)",
                background: limitsSaved
                  ? "rgba(34,197,94,0.02)"
                  : "var(--card)",
              }}
            >
              {limitsSaved ? (
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: "rgba(34,197,94,0.1)", border: "1.5px solid rgba(34,197,94,0.3)" }}
                  >
                    <Check className="w-4 h-4" style={{ color: "rgb(34,197,94)" }} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "rgb(34,197,94)" }}>
                      Safety limits saved
                    </p>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      ${riskDraft.maxPositionSizeUSDC}/trade &middot; ${riskDraft.dailySpendCapUSDC}/day limit
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Shield className="w-4 h-4" style={{ color: "rgb(249,115,22)" }} />
                    <p className="text-sm font-semibold">Set Your Safety Limits</p>
                  </div>
                  <p className="text-xs mb-4" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                    These limits control how much your agent can spend. You can change them anytime.
                    We&apos;ve pre-filled conservative defaults to get you started.
                  </p>

                  <RiskLimitInputs riskDraft={riskDraft} setRiskDraft={setRiskDraft} />

                  <button
                    onClick={handleSaveRisk}
                    disabled={savingRisk}
                    className="mt-4 px-5 py-2.5 rounded-lg text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
                    style={{
                      background: "linear-gradient(135deg, rgba(22,22,22,0.85), rgba(40,40,40,0.95))",
                      color: "#fff",
                      boxShadow: "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15)",
                    }}
                  >
                    {savingRisk ? "Saving..." : "Save Limits"}
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Step 4: Enable Trading ── */}
        <AnimatePresence>
          {step4Unlocked && riskDraft && wallet && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08 }}
              className="rounded-xl p-5"
              style={{
                border: "1px solid rgba(249,115,22,0.2)",
                background: "rgba(249,115,22,0.02)",
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="w-4 h-4" style={{ color: "rgb(249,115,22)" }} />
                <p className="text-sm font-semibold">Ready to Start Trading</p>
              </div>

              <p className="text-xs mb-4" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                Your agent will monitor Polymarket and place trades within your safety limits.
                You&apos;ll need to approve any trade above ${riskDraft.confirmationThresholdUSDC}.
              </p>

              {/* Summary */}
              <div
                className="rounded-lg p-4 mb-4 space-y-2"
                style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
              >
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--muted)" }}>Wallet</span>
                  <span className="font-mono">{truncateAddr(wallet.address)}</span>
                </div>
                {balance !== null && (
                  <div className="flex justify-between text-xs">
                    <span style={{ color: "var(--muted)" }}>Balance</span>
                    <span className="font-semibold">${balance.toFixed(2)} USDC</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--muted)" }}>Max per trade</span>
                  <span>${riskDraft.maxPositionSizeUSDC}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--muted)" }}>Daily spending limit</span>
                  <span>${riskDraft.dailySpendCapUSDC}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--muted)" }}>Needs approval above</span>
                  <span>${riskDraft.confirmationThresholdUSDC}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--muted)" }}>Daily stop-loss</span>
                  <span>${riskDraft.dailyLossLimitUSDC}</span>
                </div>
              </div>

              <button
                onClick={handleEnableTrading}
                disabled={savingRisk}
                className="w-full px-5 py-3 rounded-lg text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                  color: "#fff",
                  boxShadow: "0 0 0 1px rgba(249,115,22,0.3), 0 2px 8px rgba(249,115,22,0.25)",
                }}
              >
                {savingRisk ? (
                  <span className="flex items-center justify-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Enabling...
                  </span>
                ) : (
                  "Start Trading"
                )}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
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
  setRiskConfig,
  setRiskDraft,
  trades,
  savingRisk,
  handleSaveRisk,
  balance,
  checkingBalance,
  onCheckBalance,
  fetchAll,
  showToast,
}: {
  wallet: WalletInfo;
  watchlist: Watchlist | null;
  positions: Position[];
  riskConfig: RiskConfig;
  riskDraft: RiskConfig;
  setRiskConfig: (rc: RiskConfig) => void;
  setRiskDraft: (rc: RiskConfig | null) => void;
  trades: Trade[];
  savingRisk: boolean;
  handleSaveRisk: () => void;
  balance: number | null;
  checkingBalance: boolean;
  onCheckBalance: () => void;
  fetchAll: () => void;
  showToast: (msg: string, type: "success" | "error") => void;
}) {
  const [addrCopied, setAddrCopied] = useState(false);
  const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  async function handleToggleTrading() {
    const toggled = { ...riskDraft, enabled: !riskDraft.enabled };
    setRiskDraft(toggled);
    setRiskConfig(toggled);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_polymarket_risk", riskConfig: toggled }),
      });
      if (res.ok) {
        showToast(toggled.enabled ? "Trading resumed" : "Trading paused", "success");
      }
    } catch {
      // revert on error
      setRiskDraft({ ...toggled, enabled: !toggled.enabled });
      setRiskConfig({ ...toggled, enabled: !toggled.enabled });
    }
  }

  return (
    <div className="space-y-3">
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

      {/* ── Status Card ── */}
      <div
        className="rounded-xl p-4"
        style={{
          border: riskConfig.enabled
            ? "1px solid rgba(34,197,94,0.2)"
            : "1px solid rgba(249,115,22,0.2)",
          background: riskConfig.enabled
            ? "rgba(34,197,94,0.03)"
            : "rgba(249,115,22,0.03)",
        }}
      >
        {/* Top row: status + toggle */}
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
            onClick={handleToggleTrading}
            className="relative w-11 h-6 rounded-full transition-all cursor-pointer shrink-0"
            style={{
              background: riskConfig.enabled
                ? "linear-gradient(135deg, rgba(34,197,94,0.7), rgba(22,163,74,0.85))"
                : "rgba(0,0,0,0.08)",
              boxShadow: riskConfig.enabled
                ? "0 0 0 1px rgba(34,197,94,0.3)"
                : "0 0 0 1px rgba(0,0,0,0.08)",
            }}
          >
            <span
              className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
              style={{
                left: riskConfig.enabled ? "22px" : "2px",
                background: "white",
                boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
              }}
            />
          </button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="text-center">
            <p
              className="text-lg font-bold tabular-nums"
              style={{ color: balance !== null && balance > 0 ? "var(--foreground)" : "var(--muted)" }}
            >
              ${balance !== null ? balance.toFixed(2) : "—"}
            </p>
            <div className="flex items-center justify-center gap-1">
              <p className="text-[10px]" style={{ color: "var(--muted)" }}>Balance</p>
              <button
                onClick={onCheckBalance}
                disabled={checkingBalance}
                className="cursor-pointer disabled:opacity-50"
                style={{ color: "var(--muted)" }}
              >
                <RefreshCw className={`w-2.5 h-2.5 ${checkingBalance ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>
          <div className="text-center">
            <p
              className="text-lg font-bold tabular-nums"
              style={{ color: totalPnl > 0 ? "rgb(34,197,94)" : totalPnl < 0 ? "#ef4444" : "var(--foreground)" }}
            >
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </p>
            <p className="text-[10px]" style={{ color: "var(--muted)" }}>P&L</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold">{positions.length}</p>
            <p className="text-[10px]" style={{ color: "var(--muted)" }}>Positions</p>
          </div>
        </div>

        {/* Wallet address */}
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
          {!riskConfig.enabled && (
            <div className="flex items-center gap-1" style={{ color: "rgb(249,115,22)" }}>
              <Pause className="w-3 h-3" />
              <span className="text-[10px] font-medium">Paused</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Markets You're Watching ── */}
      <Section
        icon={Eye}
        title="Markets Your Agent Is Watching"
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

      {/* ── Recent Trades ── */}
      <Section
        icon={ScrollText}
        title="Recent Trades"
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
