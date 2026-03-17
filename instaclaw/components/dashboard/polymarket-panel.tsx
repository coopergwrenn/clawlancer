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
  ExternalLink,
  ChevronRight,
  Lock,
  Zap,
  HelpCircle,
  Key,
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

interface Balances {
  usdcE: number;
  usdcNative: number;
  pol: number;
  total: number;
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
  dailySpendCapUSDC: 50,
  confirmationThresholdUSDC: 25,
  dailyLossLimitUSDC: 100,
  maxPositionSizeUSDC: 100,
};

async function fetchBalances(address: string): Promise<Balances> {
  const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const balanceOfData =
    "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");

  const RPC_URLS = [
    "https://polygon.gateway.tenderly.co",
    "https://api.zan.top/polygon-mainnet",
  ];
  const rpcCall = async (method: string, params: unknown[]) => {
    for (const rpc of RPC_URLS) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        });
        const data = await res.json();
        if (data.result !== undefined) return data;
      } catch {
        continue;
      }
    }
    return { result: "0x0" };
  };

  const [usdcRes, usdcERes, polRes] = await Promise.all([
    rpcCall("eth_call", [{ to: USDC, data: balanceOfData }, "latest"]),
    rpcCall("eth_call", [{ to: USDC_E, data: balanceOfData }, "latest"]),
    rpcCall("eth_getBalance", [address, "latest"]),
  ]);

  const parse6 = (hex: string | undefined) =>
    hex && hex !== "0x" ? parseInt(hex, 16) / 1e6 : 0;
  const parse18 = (hex: string | undefined) =>
    hex && hex !== "0x" ? parseInt(hex, 16) / 1e18 : 0;

  const usdcE = parse6(usdcERes.result);
  const usdcNative = parse6(usdcRes.result);
  const pol = parse18(polRes.result);

  return { usdcE, usdcNative, pol, total: usdcE + usdcNative };
}

// ── Copyable Bot Message ────────────────────────────

function BotMessage({ message }: { message: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="glass rounded-lg p-4 mt-3">
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
          className="glass px-2.5 py-1 rounded-md text-[11px] font-medium cursor-pointer transition-all shrink-0"
          style={{ color: copied ? "rgb(34,197,94)" : "rgb(59,130,246)" }}
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
    <div className="glass rounded-xl overflow-hidden">
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
                  className="px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0"
                  style={{
                    background: "rgba(249,115,22,0.08)",
                    color: "#ea580c",
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
            <div className="px-4 pb-4" style={{ borderTop: "1px solid var(--border)" }}>
              <div className="pt-4">{children}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Funding Guide (collapsible) ─────────────────────

function FundingGuide() {
  const [openOption, setOpenOption] = useState<string | null>(null);

  const options = [
    {
      id: "have-polygon",
      title: "Already have USDC on Polygon?",
      content: (
        <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
          Send it directly to the wallet address above. It will appear in your balance within a few minutes.
        </p>
      ),
    },
    {
      id: "exchange",
      title: "Buying from an exchange (Coinbase, Binance, etc.)?",
      content: (
        <div className="text-xs space-y-2" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
          <p>
            <strong>1.</strong> Buy USDC on your exchange.<br />
            <strong>2.</strong> Go to &ldquo;Withdraw&rdquo; and paste the wallet address above.<br />
            <strong>3.</strong> Select <strong>Polygon</strong> as the network (NOT Ethereum, NOT Base).<br />
            <strong>4.</strong> Also send ~$0.50 worth of POL for gas fees (or use the exchange&apos;s Polygon withdrawal).
          </p>
        </div>
      ),
    },
    {
      id: "other-chain",
      title: "Have crypto on another chain?",
      content: (
        <div className="text-xs space-y-2.5" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
          <p>
            Bridge it to Polygon using Jumper Exchange &mdash; paste your wallet address above as the destination and select Polygon as the target network.
          </p>
          <a
            href="https://jumper.exchange"
            target="_blank"
            rel="noopener noreferrer"
            className="glass inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={{ color: "rgb(59,130,246)" }}
          >
            Open Jumper Exchange
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      ),
    },
  ];

  return (
    <div className="glass rounded-xl overflow-hidden">
      <p className="px-4 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        Need help funding?
      </p>
      {options.map((opt, i) => {
        const isOpen = openOption === opt.id;
        return (
          <div
            key={opt.id}
            style={{ borderTop: i > 0 ? "1px solid var(--border)" : undefined }}
          >
            <button
              onClick={() => setOpenOption(isOpen ? null : opt.id)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left cursor-pointer"
            >
              <span className="text-xs font-medium">{opt.title}</span>
              <ChevronRight
                className="w-3.5 h-3.5 shrink-0 transition-transform"
                style={{
                  color: "var(--muted)",
                  transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                }}
              />
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 pb-3">{opt.content}</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

// ── Progress Bar ────────────────────────────────────

const STEP_LABELS = ["Create Wallet", "Fund Wallet", "Activate", "Risk Disclosure", "Set Limits"];

function ProgressBar({ currentStep, completedSteps }: { currentStep: number; completedSteps: Set<number> }) {
  return (
    <div className="glass rounded-xl px-4 py-3 mb-4">
      <div className="flex items-center gap-1">
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
                        : "transparent",
                    color: done
                      ? "rgb(34,197,94)"
                      : active
                        ? "rgb(249,115,22)"
                        : "var(--muted)",
                    border: done
                      ? "1.5px solid rgba(34,197,94,0.25)"
                      : active
                        ? "1.5px solid rgba(249,115,22,0.25)"
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
              {i < STEP_LABELS.length - 1 && (
                <div
                  className="flex-1 h-px mx-1"
                  style={{
                    background: done
                      ? "rgba(34,197,94,0.25)"
                      : "var(--border)",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
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
              className="glass w-full pl-7 pr-3 py-2 rounded-lg text-sm outline-none"
              style={{ color: "var(--foreground)" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Copyable Address ────────────────────────────────

function CopyableAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="glass rounded-xl flex items-center gap-2 px-4 py-3">
      <Wallet className="w-4 h-4 shrink-0" style={{ color: "var(--muted)" }} />
      <span className="text-xs sm:text-sm font-mono flex-1 truncate">{address}</span>
      <button
        onClick={() => {
          navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all shrink-0"
        style={{
          background: copied ? "rgba(34,197,94,0.08)" : "rgba(59,130,246,0.08)",
          color: copied ? "rgb(34,197,94)" : "rgb(59,130,246)",
        }}
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? "Copied!" : "Copy Address"}
      </button>
    </div>
  );
}

// ── FAQ Section ─────────────────────────────────────

const FAQ_ITEMS = [
  {
    q: "I sent USDC but it's not showing up",
    a: "Make sure you sent on the Polygon network (not Ethereum, Base, or Arbitrum). Polygon transfers usually arrive in 1-2 minutes. If you sent on the wrong network, you'll need to bridge the funds to Polygon.",
  },
  {
    q: "What's USDC.e vs USDC?",
    a: "Both are worth exactly $1. USDC.e (bridged USDC) is what Polymarket uses for trading. Regular USDC works on Polygon too. Your agent handles both automatically.",
  },
  {
    q: "How much POL do I need?",
    a: "About $0.50 worth of POL is enough for hundreds of transactions. POL is the gas token on Polygon — every transaction costs a fraction of a cent.",
  },
  {
    q: "Can I withdraw my funds?",
    a: 'Yes! Tell your agent "send my USDC.e to [your wallet address]" and it will transfer your funds. You always have full control.',
  },
  {
    q: "What if Polymarket freezes my account?",
    a: "Withdraw regularly to your own wallet. For a fully regulated alternative, connect Kalshi in the Kalshi tab — it's US-regulated and uses normal USD.",
  },
];

function FAQSection() {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
        <HelpCircle className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          Frequently Asked Questions
        </p>
      </div>
      {FAQ_ITEMS.map((item, i) => {
        const isOpen = openIdx === i;
        return (
          <div key={i} style={{ borderTop: "1px solid var(--border)" }}>
            <button
              onClick={() => setOpenIdx(isOpen ? null : i)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left cursor-pointer"
            >
              <span className="text-xs font-medium">{item.q}</span>
              <ChevronRight
                className="w-3.5 h-3.5 shrink-0 transition-transform"
                style={{
                  color: "var(--muted)",
                  transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                }}
              />
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  <p className="px-4 pb-3 text-xs" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                    {item.a}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

// ── Quick Start Guide ───────────────────────────────

function QuickStartGuide() {
  return (
    <Section icon={MessageSquare} title="Quick Start" subtitle="Example messages to get your agent trading">
      <div className="space-y-1">
        <BotMessage message="What are the hottest prediction markets right now?" />
        <BotMessage message="Buy $5 of YES on 'Will Bitcoin hit $100k by June?'" />
        <BotMessage message="Show me my Polymarket positions" />
        <BotMessage message="Set an alert if the Trump election odds go above 60%" />
      </div>
    </Section>
  );
}

// ── Status Overview (always visible in dashboard) ───

function StatusOverview({
  wallet,
  balances,
  credsReady,
  riskAcknowledged,
}: {
  wallet: WalletInfo;
  balances: Balances | null;
  credsReady: boolean;
  riskAcknowledged: boolean;
}) {
  const [addrCopied, setAddrCopied] = useState(false);

  const rows: { label: string; ok: boolean; value: string; copyable?: string }[] = [
    {
      label: "Wallet",
      ok: true,
      value: truncateAddr(wallet.address),
      copyable: wallet.address,
    },
    {
      label: "USDC.e",
      ok: (balances?.usdcE ?? 0) > 0,
      value: balances ? `$${balances.usdcE.toFixed(2)}` : "$0.00",
    },
    {
      label: "POL (gas)",
      ok: (balances?.pol ?? 0) > 0.001,
      value: balances ? `$${(balances.pol * 0.45).toFixed(2)}` : "$0.00",
    },
    {
      label: "Approvals",
      ok: credsReady,
      value: credsReady ? "Ready" : "Need setup",
    },
    {
      label: "CLOB Creds",
      ok: credsReady,
      value: credsReady ? "Derived" : "Need setup",
    },
    {
      label: "Risk Ack",
      ok: riskAcknowledged,
      value: riskAcknowledged ? "Accepted" : "Required",
    },
  ];

  return (
    <div className="glass rounded-xl p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide mb-3" style={{ color: "var(--muted)" }}>
        System Status
      </p>
      <div className="grid gap-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between text-xs">
            <span style={{ color: "var(--muted)" }}>{row.label}</span>
            <div className="flex items-center gap-2">
              <span className={row.ok ? "" : ""} style={{ color: row.ok ? "rgb(34,197,94)" : "rgb(239,68,68)" }}>
                {row.ok ? "\u2705" : "\u274C"} {row.value}
              </span>
              {row.copyable && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(row.copyable!);
                    setAddrCopied(true);
                    setTimeout(() => setAddrCopied(false), 2000);
                  }}
                  className="cursor-pointer"
                  style={{ color: addrCopied ? "rgb(34,197,94)" : "var(--muted)" }}
                >
                  {addrCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Kalshi Section ──────────────────────────────────

function KalshiSection({
  kalshiConnected,
  showToast,
  onConnected,
}: {
  kalshiConnected: boolean;
  showToast: (msg: string, type: "success" | "error") => void;
  onConnected: () => void;
}) {
  const [apiKeyId, setApiKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [connecting, setConnecting] = useState(false);

  async function handleConnect() {
    if (!apiKeyId.trim() || !privateKey.trim()) {
      showToast("Both API Key ID and Private Key are required", "error");
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "connect_kalshi",
          apiKeyId: apiKeyId.trim(),
          privateKey: privateKey.trim(),
        }),
      });
      if (res.ok) {
        showToast("Kalshi connected!", "success");
        onConnected();
        setApiKeyId("");
        setPrivateKey("");
      } else {
        const data = await res.json();
        showToast(data.error || "Failed to connect Kalshi", "error");
      }
    } catch {
      showToast("Network error", "error");
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="glass rounded-xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <BarChart3 className="w-4 h-4" style={{ color: "rgb(59,130,246)" }} />
          <h3 className="text-sm font-semibold">What is Kalshi?</h3>
        </div>
        <p className="text-xs mb-3" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
          Kalshi is a <strong>US-regulated</strong> prediction market (CFTC-regulated exchange).
          Unlike Polymarket, it uses normal USD — no crypto needed. Your agent can trade on both
          platforms simultaneously for better odds.
        </p>
        <div
          className="rounded-lg p-3 flex items-start gap-2"
          style={{ background: "rgba(59,130,246,0.04)", border: "1px solid rgba(59,130,246,0.08)" }}
        >
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "rgb(59,130,246)" }} />
          <p className="text-[11px]" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
            You&apos;ll need a Kalshi account with API access enabled.
            Go to <a href="https://kalshi.com" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "rgb(59,130,246)" }}>kalshi.com</a> to
            sign up, then generate API keys from your account settings.
          </p>
        </div>
      </div>

      {kalshiConnected ? (
        <div className="glass rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
              style={{ background: "rgba(34,197,94,0.1)" }}
            >
              <Check className="w-4 h-4" style={{ color: "rgb(34,197,94)" }} />
            </div>
            <div>
              <p className="text-sm font-semibold" style={{ color: "rgb(34,197,94)" }}>
                Kalshi Connected
              </p>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Your agent can now trade on Kalshi
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="glass rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Key className="w-4 h-4" style={{ color: "rgb(249,115,22)" }} />
            <p className="text-sm font-semibold">Connect Your Kalshi API</p>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold block mb-1">API Key ID</label>
              <input
                type="text"
                value={apiKeyId}
                onChange={(e) => setApiKeyId(e.target.value)}
                placeholder="e.g. abc123-def456-..."
                className="glass w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ color: "var(--foreground)" }}
              />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1">Private Key</label>
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="Paste your RSA private key here..."
                rows={4}
                className="glass w-full px-3 py-2 rounded-lg text-sm outline-none resize-none font-mono"
                style={{ color: "var(--foreground)" }}
              />
            </div>
            <button
              onClick={handleConnect}
              disabled={connecting || !apiKeyId.trim() || !privateKey.trim()}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, rgba(59,130,246,0.85), rgba(37,99,235,0.95))",
                color: "#fff",
                boxShadow: "0 2px 12px rgba(59,130,246,0.3)",
              }}
            >
              {connecting ? (
                <span className="flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Connecting...
                </span>
              ) : (
                "Connect Kalshi"
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab Bar ─────────────────────────────────────────

function TabBar({ activeTab, onTabChange }: { activeTab: "polymarket" | "kalshi"; onTabChange: (tab: "polymarket" | "kalshi") => void }) {
  return (
    <div className="glass rounded-xl p-1 flex gap-1 mb-4">
      {(["polymarket", "kalshi"] as const).map((tab) => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-all"
          style={{
            background: activeTab === tab ? "rgba(249,115,22,0.08)" : "transparent",
            color: activeTab === tab ? "rgb(249,115,22)" : "var(--muted)",
          }}
        >
          {tab === "polymarket" ? "Polymarket" : "Kalshi"}
        </button>
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
  const [balances, setBalances] = useState<Balances | null>(null);
  const [checkingBalance, setCheckingBalance] = useState(false);
  const [credsReady, setCredsReady] = useState(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [kalshiConnected, setKalshiConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<"polymarket" | "kalshi">("polymarket");
  const [activatingCreds, setActivatingCreds] = useState(false);
  const [acknowledgingRisk, setAcknowledgingRisk] = useState(false);
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
    const [w, wl, pos, rc, tl, riskAck, kalshiCreds] = await Promise.all([
      fetchFile("~/.openclaw/polymarket/wallet.json"),
      fetchFile("~/memory/polymarket-watchlist.json"),
      fetchFile("~/.openclaw/polymarket/positions.json"),
      fetchFile("~/.openclaw/polymarket/risk-config.json"),
      fetchFile("~/.openclaw/polymarket/trade-log.json"),
      fetchFile("~/.openclaw/polymarket/polymarket-risk.json"),
      fetchFile("~/.openclaw/kalshi/credentials.json"),
    ]);
    setWallet(w);
    setWatchlist(wl);
    setPositions(pos?.positions ?? []);
    setRiskConfig(rc);
    setRiskDraft(rc ?? DEFAULT_RISK);
    setTrades(tl?.trades ?? []);
    setRiskAcknowledged(riskAck != null);
    setKalshiConnected(kalshiCreds != null);
    // Creds are ready if risk-config exists (setup-creds was run as part of activation)
    setCredsReady(rc != null && riskAck != null);
    setLoading(false);
  }, [fetchFile]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const checkBalance = useCallback(async (address: string) => {
    setCheckingBalance(true);
    try {
      const bal = await fetchBalances(address);
      setBalances(bal);
    } catch {
      // keep existing
    } finally {
      setCheckingBalance(false);
    }
  }, []);

  useEffect(() => {
    if (!wallet) return;
    checkBalance(wallet.address);
  }, [wallet, checkBalance]);

  useEffect(() => {
    if (!wallet || (balances !== null && balances.total > 0)) {
      if (balancePollRef.current) clearInterval(balancePollRef.current);
      return;
    }
    balancePollRef.current = setInterval(() => {
      if (wallet) checkBalance(wallet.address);
    }, 15000);
    return () => {
      if (balancePollRef.current) clearInterval(balancePollRef.current);
    };
  }, [wallet, balances, checkBalance]);

  const setupComplete = wallet != null && riskConfig?.enabled === true;

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
        if (data.address) {
          const newWallet: WalletInfo = {
            address: data.address,
            chain_id: 137,
            created_at: new Date().toISOString(),
          };
          setWallet(newWallet);
          setRiskConfig(DEFAULT_RISK);
          setRiskDraft({ ...DEFAULT_RISK });
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

  async function handleActivateCreds() {
    setActivatingCreds(true);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setup_polymarket_creds" }),
      });
      if (res.ok) {
        setCredsReady(true);
        showToast("Trading activated! Approvals and credentials are set up.", "success");
      } else {
        const data = await res.json();
        showToast(data.error || "Activation failed — try again", "error");
      }
    } catch {
      showToast("Network error — check your connection", "error");
    } finally {
      setActivatingCreds(false);
    }
  }

  async function handleAcknowledgeRisk() {
    setAcknowledgingRisk(true);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge_polymarket_risk" }),
      });
      if (res.ok) {
        setRiskAcknowledged(true);
        showToast("Risk disclosure acknowledged", "success");
      } else {
        const data = await res.json();
        showToast(data.error || "Failed — try again", "error");
      }
    } catch {
      showToast("Network error — check your connection", "error");
    } finally {
      setAcknowledgingRisk(false);
    }
  }

  async function handleSaveRiskAndEnable() {
    if (!riskDraft) return;
    const updated = { ...riskDraft, enabled: true };
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
        setRiskDraft(updated);
        showToast("Trading is live! Your agent is now monitoring Polymarket.", "success");
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

  if (loading) {
    return (
      <div className="glass rounded-xl p-8 text-center">
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

      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === "kalshi" ? (
        <KalshiSection
          kalshiConnected={kalshiConnected}
          showToast={showToast}
          onConnected={() => setKalshiConnected(true)}
        />
      ) : setupComplete ? (
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
          balances={balances}
          checkingBalance={checkingBalance}
          onCheckBalance={() => wallet && checkBalance(wallet.address)}
          fetchAll={fetchAll}
          showToast={showToast}
          credsReady={credsReady}
          riskAcknowledged={riskAcknowledged}
        />
      ) : (
        <SetupFlow
          wallet={wallet}
          riskDraft={riskDraft}
          setRiskDraft={setRiskDraft}
          settingUpWallet={settingUpWallet}
          savingRisk={savingRisk}
          handleSetupWallet={handleSetupWallet}
          handleActivateCreds={handleActivateCreds}
          handleAcknowledgeRisk={handleAcknowledgeRisk}
          handleSaveRiskAndEnable={handleSaveRiskAndEnable}
          balances={balances}
          checkingBalance={checkingBalance}
          onCheckBalance={() => wallet && checkBalance(wallet.address)}
          credsReady={credsReady}
          riskAcknowledged={riskAcknowledged}
          activatingCreds={activatingCreds}
          acknowledgingRisk={acknowledgingRisk}
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
  handleActivateCreds,
  handleAcknowledgeRisk,
  handleSaveRiskAndEnable,
  balances,
  checkingBalance,
  onCheckBalance,
  credsReady,
  riskAcknowledged,
  activatingCreds,
  acknowledgingRisk,
}: {
  wallet: WalletInfo | null;
  riskDraft: RiskConfig | null;
  setRiskDraft: (rc: RiskConfig | null) => void;
  settingUpWallet: boolean;
  savingRisk: boolean;
  handleSetupWallet: () => void;
  handleActivateCreds: () => void;
  handleAcknowledgeRisk: () => void;
  handleSaveRiskAndEnable: () => void;
  balances: Balances | null;
  checkingBalance: boolean;
  onCheckBalance: () => void;
  credsReady: boolean;
  riskAcknowledged: boolean;
  activatingCreds: boolean;
  acknowledgingRisk: boolean;
}) {
  const hasWallet = wallet != null;
  const isFunded = (balances?.total ?? 0) > 0;
  const [fundingSkipped, setFundingSkipped] = useState(false);

  const step2Unlocked = hasWallet;
  const step3Unlocked = hasWallet && (isFunded || fundingSkipped);
  const step4Unlocked = step3Unlocked && credsReady;
  const step5Unlocked = step4Unlocked && riskAcknowledged;

  const completedSteps = new Set<number>();
  if (hasWallet) completedSteps.add(1);
  if (isFunded) completedSteps.add(2);
  if (credsReady) completedSteps.add(3);
  if (riskAcknowledged) completedSteps.add(4);

  let currentStep = 1;
  if (hasWallet) currentStep = 2;
  if (step3Unlocked) currentStep = 3;
  if (step4Unlocked) currentStep = 4;
  if (step5Unlocked) currentStep = 5;

  return (
    <div>
      <ProgressBar currentStep={currentStep} completedSteps={completedSteps} />

      <div className="space-y-3">
        {/* ── Step 1: Create Wallet ── */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="glass rounded-xl p-5"
        >
          {hasWallet ? (
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "rgba(34,197,94,0.1)" }}
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
                Your agent needs a trading wallet on Polygon (a fast, cheap blockchain).
                This creates a secure wallet that only your agent controls &mdash; you can withdraw funds anytime.
              </p>
              <div
                className="rounded-lg p-3 flex items-start gap-2 mb-4"
                style={{ background: "rgba(0,0,0,0.02)" }}
              >
                <Shield className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--muted)" }} />
                <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
                  No money is spent until you fund it and enable trading.
                </p>
              </div>
              <button
                onClick={handleSetupWallet}
                disabled={settingUpWallet}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                  color: "#fff",
                  boxShadow: "0 2px 12px rgba(249,115,22,0.3)",
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
                        background: "rgba(255,255,255,0.2)",
                        backdropFilter: "blur(8px)",
                        color: "#fff",
                        border: "1px solid rgba(255,255,255,0.25)",
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
              className="glass rounded-xl p-5"
            >
              {isFunded ? (
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: "rgba(34,197,94,0.1)" }}
                  >
                    <Check className="w-4 h-4" style={{ color: "rgb(34,197,94)" }} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "rgb(34,197,94)" }}>
                      Wallet funded
                    </p>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      USDC.e: ${balances?.usdcE.toFixed(2)} &middot; USDC: ${balances?.usdcNative.toFixed(2)} &middot; POL: {balances?.pol.toFixed(4)}
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <DollarSign className="w-4 h-4" style={{ color: "rgb(249,115,22)" }} />
                      <p className="text-sm font-semibold">Fund Your Wallet</p>
                    </div>
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

                  {/* Balance breakdown */}
                  <div className="grid grid-cols-3 gap-2 mb-4 mt-3">
                    <div className="glass rounded-lg p-2.5 text-center">
                      <p className="text-xs font-bold tabular-nums">${balances?.usdcE.toFixed(2) ?? "0.00"}</p>
                      <p className="text-[10px] mt-0.5" style={{ color: "var(--muted)" }}>USDC.e</p>
                      <p className="text-[9px]" style={{ color: "var(--muted)", opacity: 0.6 }}>Trading money</p>
                    </div>
                    <div className="glass rounded-lg p-2.5 text-center">
                      <p className="text-xs font-bold tabular-nums">${balances?.usdcNative.toFixed(2) ?? "0.00"}</p>
                      <p className="text-[10px] mt-0.5" style={{ color: "var(--muted)" }}>USDC</p>
                      <p className="text-[9px]" style={{ color: "var(--muted)", opacity: 0.6 }}>Also $1 each</p>
                    </div>
                    <div className="glass rounded-lg p-2.5 text-center">
                      <p className="text-xs font-bold tabular-nums">{balances?.pol.toFixed(4) ?? "0.0000"}</p>
                      <p className="text-[10px] mt-0.5" style={{ color: "var(--muted)" }}>POL</p>
                      <p className="text-[9px]" style={{ color: "var(--muted)", opacity: 0.6 }}>Gas fees</p>
                    </div>
                  </div>

                  {/* Plain language explanation */}
                  <div
                    className="rounded-lg p-3 mb-3"
                    style={{ background: "rgba(59,130,246,0.04)", border: "1px solid rgba(59,130,246,0.08)" }}
                  >
                    <p className="text-[11px]" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                      <strong>USDC.e</strong> is your trading money &mdash; this is what Polymarket uses.
                      <strong> POL</strong> pays for transaction fees (like postage for the blockchain). ~$0.50 of POL is plenty for hundreds of trades.
                    </p>
                  </div>

                  {/* Chain warning */}
                  <div
                    className="rounded-xl p-3 flex items-start gap-2 mb-4"
                    style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.12)" }}
                  >
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "rgb(239,68,68)" }} />
                    <p className="text-[11px] font-semibold" style={{ color: "rgb(239,68,68)", lineHeight: "1.5" }}>
                      Always send on the Polygon network. Funds sent on Ethereum, Base, or Arbitrum will NOT arrive here.
                    </p>
                  </div>

                  {/* Address + copy */}
                  <CopyableAddress address={wallet.address} />

                  {/* Trust card */}
                  <div
                    className="rounded-xl p-4 mt-3 mb-3"
                    style={{ background: "rgba(34,197,94,0.03)", border: "1px solid rgba(34,197,94,0.08)" }}
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <Lock className="w-3.5 h-3.5" style={{ color: "rgb(34,197,94)" }} />
                      <p className="text-xs font-semibold" style={{ color: "rgb(34,197,94)" }}>Your Wallet, Your Keys</p>
                    </div>
                    <ul className="space-y-1.5 text-[11px]" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                      <li className="flex items-start gap-2">
                        <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" style={{ color: "rgba(34,197,94,0.5)" }} />
                        The private key is stored securely on your dedicated VM &mdash; only your agent has access.
                      </li>
                      <li className="flex items-start gap-2">
                        <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" style={{ color: "rgba(34,197,94,0.5)" }} />
                        Withdraw anytime &mdash; just message your agent &ldquo;send my funds to [your wallet]&rdquo;
                      </li>
                    </ul>
                  </div>

                  {/* Funding guide */}
                  <FundingGuide />

                  <p className="text-xs mt-4 mb-3" style={{ color: "var(--muted)" }}>
                    Start with as little as $1 USDC to test, or $10&ndash;50 to get started.
                  </p>

                  <button
                    onClick={() => setFundingSkipped(true)}
                    className="text-[11px] font-medium cursor-pointer transition-all"
                    style={{ color: "var(--muted)", opacity: 0.5 }}
                  >
                    Skip &mdash; I&apos;ll fund later
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Step 3: Activate Trading ── */}
        <AnimatePresence>
          {step3Unlocked && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08 }}
              className="glass rounded-xl p-5"
            >
              {credsReady ? (
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: "rgba(34,197,94,0.1)" }}
                  >
                    <Check className="w-4 h-4" style={{ color: "rgb(34,197,94)" }} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "rgb(34,197,94)" }}>
                      Trading activated
                    </p>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      Approvals and CLOB credentials are set up
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Zap className="w-4 h-4" style={{ color: "rgb(249,115,22)" }} />
                    <p className="text-sm font-semibold">Activate Trading</p>
                  </div>
                  <p className="text-xs mb-3" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                    This sets up the approvals and credentials your agent needs to place trades on Polymarket.
                    It connects your wallet to Polymarket&apos;s order book so your agent can buy and sell positions.
                  </p>
                  <div
                    className="rounded-lg p-3 flex items-start gap-2 mb-4"
                    style={{ background: "rgba(0,0,0,0.02)" }}
                  >
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--muted)" }} />
                    <p className="text-[11px]" style={{ color: "var(--muted)", lineHeight: "1.5" }}>
                      This is a one-time setup. No funds are spent &mdash; it just authorizes your agent to trade when you&apos;re ready.
                    </p>
                  </div>
                  <button
                    onClick={handleActivateCreds}
                    disabled={activatingCreds}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
                    style={{
                      background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                      color: "#fff",
                      boxShadow: "0 2px 12px rgba(249,115,22,0.3)",
                    }}
                  >
                    {activatingCreds ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Activating...
                      </>
                    ) : (
                      "Activate"
                    )}
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Step 4: Risk Disclosure ── */}
        <AnimatePresence>
          {step4Unlocked && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08 }}
              className="glass rounded-xl p-5"
            >
              {riskAcknowledged ? (
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: "rgba(34,197,94,0.1)" }}
                  >
                    <Check className="w-4 h-4" style={{ color: "rgb(34,197,94)" }} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "rgb(34,197,94)" }}>
                      Risk disclosure accepted
                    </p>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      You understand the risks of prediction market trading
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="w-4 h-4" style={{ color: "rgb(249,115,22)" }} />
                    <p className="text-sm font-semibold">Risk Disclosure</p>
                  </div>

                  <div
                    className="rounded-xl p-4 mb-3 space-y-3"
                    style={{ background: "rgba(239,68,68,0.04)", border: "1px solid rgba(239,68,68,0.08)" }}
                  >
                    <p className="text-xs font-medium" style={{ color: "rgb(239,68,68)", lineHeight: "1.6" }}>
                      Please read carefully before proceeding:
                    </p>
                    <ul className="space-y-2 text-[11px]" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                      <li className="flex items-start gap-2">
                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" style={{ color: "rgb(239,68,68)" }} />
                        <span>
                          <strong>Prediction markets carry real financial risk.</strong> You can lose some or all of your deposited funds.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" style={{ color: "rgb(239,68,68)" }} />
                        <span>
                          <strong>Polymarket may restrict accounts</strong> that access the platform through proxies or from restricted jurisdictions. Withdraw profits regularly.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <Info className="w-3 h-3 mt-0.5 shrink-0" style={{ color: "rgb(59,130,246)" }} />
                        <span>
                          <strong>For a regulated alternative</strong>, consider Kalshi (available in the Kalshi tab). It&apos;s CFTC-regulated, uses USD, and doesn&apos;t require crypto.
                        </span>
                      </li>
                    </ul>
                  </div>

                  <button
                    onClick={handleAcknowledgeRisk}
                    disabled={acknowledgingRisk}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
                    style={{
                      background: "linear-gradient(135deg, rgba(22,22,22,0.8), rgba(40,40,40,0.9))",
                      color: "#fff",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                    }}
                  >
                    {acknowledgingRisk ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      "I Understand the Risks"
                    )}
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Step 5: Set Risk Limits & Start Trading ── */}
        <AnimatePresence>
          {step5Unlocked && riskDraft && wallet && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08 }}
              className="glass rounded-xl p-5"
            >
              <div className="flex items-center gap-2 mb-1">
                <Shield className="w-4 h-4" style={{ color: "rgb(249,115,22)" }} />
                <p className="text-sm font-semibold">Set Your Safety Limits</p>
              </div>
              <p className="text-xs mb-4" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                These limits control how much your agent can spend. You can change them anytime after setup.
              </p>

              <RiskLimitInputs riskDraft={riskDraft} setRiskDraft={setRiskDraft} />

              <button
                onClick={handleSaveRiskAndEnable}
                disabled={savingRisk}
                className="w-full mt-4 px-5 py-3 rounded-xl text-sm font-semibold cursor-pointer transition-all disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                  color: "#fff",
                  boxShadow: "0 2px 12px rgba(249,115,22,0.3)",
                }}
              >
                {savingRisk ? (
                  <span className="flex items-center justify-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Starting...
                  </span>
                ) : (
                  "Save & Start Trading"
                )}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* FAQ at bottom of setup */}
      <div className="mt-4">
        <FAQSection />
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
  balances,
  checkingBalance,
  onCheckBalance,
  fetchAll,
  showToast,
  credsReady,
  riskAcknowledged,
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
  balances: Balances | null;
  checkingBalance: boolean;
  onCheckBalance: () => void;
  fetchAll: () => void;
  showToast: (msg: string, type: "success" | "error") => void;
  credsReady: boolean;
  riskAcknowledged: boolean;
}) {
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
          className="glass flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all"
          style={{ color: "var(--muted)" }}
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      {/* ── Status Overview ── */}
      <StatusOverview
        wallet={wallet}
        balances={balances}
        credsReady={credsReady}
        riskAcknowledged={riskAcknowledged}
      />

      {/* ── Status Card ── */}
      <div className="glass rounded-xl p-5">
        {/* Top row */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{
                background: riskConfig.enabled ? "rgb(34,197,94)" : "rgb(249,115,22)",
                boxShadow: riskConfig.enabled
                  ? "0 0 8px rgba(34,197,94,0.4)"
                  : "0 0 8px rgba(249,115,22,0.4)",
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
                : "rgba(0,0,0,0.06)",
              boxShadow: riskConfig.enabled
                ? "0 0 0 1px rgba(34,197,94,0.2), inset 0 1px 2px rgba(0,0,0,0.1)"
                : "inset 0 1px 2px rgba(0,0,0,0.06)",
            }}
          >
            <span
              className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
              style={{
                left: riskConfig.enabled ? "22px" : "2px",
                background: "white",
                boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
              }}
            />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="text-center rounded-xl py-3" style={{ background: "rgba(0,0,0,0.02)" }}>
            <p
              className="text-lg font-bold tabular-nums"
              style={{ color: balances && balances.total > 0 ? "var(--foreground)" : "var(--muted)" }}
            >
              ${balances ? balances.total.toFixed(2) : "\u2014"}
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
          <div className="text-center rounded-xl py-3" style={{ background: "rgba(0,0,0,0.02)" }}>
            <p
              className="text-lg font-bold tabular-nums"
              style={{ color: totalPnl > 0 ? "rgb(34,197,94)" : totalPnl < 0 ? "#ef4444" : "var(--foreground)" }}
            >
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </p>
            <p className="text-[10px]" style={{ color: "var(--muted)" }}>P&L</p>
          </div>
          <div className="text-center rounded-xl py-3" style={{ background: "rgba(0,0,0,0.02)" }}>
            <p className="text-lg font-bold">{positions.length}</p>
            <p className="text-[10px]" style={{ color: "var(--muted)" }}>Positions</p>
          </div>
        </div>

        {/* Balance breakdown */}
        <div className="grid grid-cols-3 gap-2 text-[10px] mb-3" style={{ color: "var(--muted)" }}>
          <div className="text-center">USDC.e: ${balances?.usdcE.toFixed(2) ?? "0.00"}</div>
          <div className="text-center">USDC: ${balances?.usdcNative.toFixed(2) ?? "0.00"}</div>
          <div className="text-center">POL: {balances?.pol.toFixed(4) ?? "0.0000"}</div>
        </div>

        {/* Wallet */}
        <div className="flex items-center justify-between text-xs" style={{ color: "var(--muted)" }}>
          <CopyableAddress address={wallet.address} />
          {!riskConfig.enabled && (
            <div className="flex items-center gap-1 ml-2" style={{ color: "rgb(249,115,22)" }}>
              <Pause className="w-3 h-3" />
              <span className="text-[10px] font-medium">Paused</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Markets ── */}
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
                    <td className="py-2 pr-3 max-w-[200px] truncate">{m.question}</td>
                    <td className="py-2 text-right font-mono font-semibold">
                      {(m.lastPrice * 100).toFixed(0)}%
                    </td>
                    <td className="py-2 text-right" style={{ color: "var(--muted)" }}>
                      {m.alertThreshold ? `${(m.alertThreshold * 100).toFixed(0)}% change` : "\u2014"}
                    </td>
                    <td className="py-2 text-right" style={{ color: "var(--muted)" }}>
                      {m.lastChecked ? timeAgo(m.lastChecked) : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              You&apos;re not watching any markets yet. Ask your bot to find interesting predictions to track.
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
                    background: t.side === "BUY" ? "rgba(22,163,74,0.08)" : "rgba(239,68,68,0.08)",
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
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No trades yet. Once trading is on, every trade your agent places will show up here with the reasoning behind it.
          </p>
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
            className="px-4 py-2 rounded-xl text-sm font-medium cursor-pointer transition-all disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg, rgba(22,22,22,0.8), rgba(40,40,40,0.9))",
              color: "#fff",
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            }}
          >
            {savingRisk ? "Saving..." : "Save Limits"}
          </button>
        </div>
      </Section>

      {/* ── Quick Start ── */}
      <QuickStartGuide />

      {/* ── FAQ ── */}
      <FAQSection />
    </div>
  );
}
