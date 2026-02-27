"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Search,
  RefreshCw,
  Store,
  TrendingUp,
  ShoppingBag,
  BarChart3,
  Globe,
  ChevronDown,
  Zap,
  Clock,
  ArrowRight,
  MessageSquare,
  CheckCircle2,
  Wallet,
  AlertCircle,
} from "lucide-react";

// Polymarket icon — official brand symbol (from polymarket.com/brand)
function PolymarketIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
      <path
        d="M375.84 389.422C375.84 403.572 375.84 410.647 371.212 414.154C366.585 417.662 359.773 415.75 346.15 411.927L127.22 350.493C119.012 348.19 114.907 347.038 112.534 343.907C110.161 340.776 110.161 336.513 110.161 327.988V184.012C110.161 175.487 110.161 171.224 112.534 168.093C114.907 164.962 119.012 163.81 127.22 161.507L346.15 100.072C359.773 96.2495 366.585 94.338 371.212 97.8455C375.84 101.353 375.84 108.428 375.84 122.578V389.422ZM164.761 330.463L346.035 381.337V279.595L164.761 330.463ZM139.963 306.862L321.201 256L139.963 205.138V306.862ZM164.759 181.537L346.035 232.406V130.663L164.759 181.537Z"
        fill="currentColor"
      />
    </svg>
  );
}
import { motion, AnimatePresence } from "motion/react";
import PolymarketPanel from "@/components/dashboard/polymarket-panel";

// ── Types ───────────────────────────────────────────

interface VMStatus {
  status: string;
  vm?: {
    gatewayUrl: string;
    controlUiUrl: string;
    healthStatus: string;
    telegramBotUsername: string | null;
    agdpEnabled: boolean;
    channelsEnabled: string[];
  };
}

// ── Earning Channel Definitions ─────────────────────

interface EarningChannel {
  id: string;
  name: string;
  headline: string;
  description: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  status: "active" | "one-click" | "setup-needed";
  effort: "Automatic" | "One-time setup" | "Bring your own accounts";
  tags: string[];
}

const CHANNELS: EarningChannel[] = [
  {
    id: "clawlancer",
    name: "Clawlancer Bounties",
    headline: "Your agent picks up freelance work and gets paid automatically",
    description: "Your agent monitors the Clawlancer marketplace 24/7, claims jobs it can handle, does the work, and earns money — all without you lifting a finger.",
    icon: Store,
    status: "active",
    effort: "Automatic",
    tags: ["bounties", "autonomous", "primary", "marketplace", "freelance", "earn"],
  },
  {
    id: "virtuals",
    name: "Virtuals Protocol",
    headline: "Earn from AI agent jobs on the Virtuals marketplace",
    description: "A second marketplace for your agent. When there are no Clawlancer jobs available, your agent picks up work from Virtuals Protocol instead.",
    icon: Globe,
    status: "one-click",
    effort: "One-time setup",
    tags: ["marketplace", "agent commerce", "virtuals", "acp", "secondary", "ai jobs"],
  },
  {
    id: "polymarket",
    name: "Polymarket",
    headline: "Track odds and place trades on Polymarket — the world's largest prediction market",
    description: "Your agent monitors Polymarket, watches for price changes, and places trades for you with safety limits you control.",
    icon: PolymarketIcon,
    status: "one-click",
    effort: "One-time setup",
    tags: ["prediction market", "trading", "polymarket", "betting", "odds", "probabilities", "invest"],
  },
  {
    id: "ecommerce",
    name: "E-Commerce Manager",
    headline: "Manage your Shopify, Amazon, or eBay store",
    description: "Connect your online store and your agent handles inventory tracking, order processing, returns, competitor price monitoring, and daily sales reports.",
    icon: ShoppingBag,
    status: "setup-needed",
    effort: "Bring your own accounts",
    tags: ["shopify", "amazon", "ebay", "ecommerce", "inventory", "orders", "shipping", "store"],
  },
  {
    id: "freelance",
    name: "Freelance & Digital Products",
    headline: "Sell services and digital products on popular platforms",
    description: "Your agent creates listings, proposals, and digital products on platforms like Gumroad, Fiverr, and Upwork. You approve everything before it goes live.",
    icon: BarChart3,
    status: "one-click",
    effort: "One-time setup",
    tags: ["contra", "gumroad", "fiverr", "upwork", "freelance", "digital products", "passive income", "sell"],
  },
];

const STATUS_CONFIG: Record<string, { bg: string; color: string; border: string; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }> = {
  active: {
    bg: "rgba(34,197,94,0.1)",
    color: "rgb(34,197,94)",
    border: "1px solid rgba(34,197,94,0.2)",
    label: "Running",
    icon: CheckCircle2,
  },
  "one-click": {
    bg: "rgba(59,130,246,0.1)",
    color: "rgb(59,130,246)",
    border: "1px solid rgba(59,130,246,0.2)",
    label: "Ready to enable",
    icon: Zap,
  },
  "setup-needed": {
    bg: "rgba(249,115,22,0.1)",
    color: "rgb(249,115,22)",
    border: "1px solid rgba(249,115,22,0.2)",
    label: "Needs your accounts",
    icon: ArrowRight,
  },
};

const EFFORT_STYLES: Record<string, { color: string }> = {
  "Automatic": { color: "rgb(34,197,94)" },
  "One-time setup": { color: "rgb(59,130,246)" },
  "Bring your own accounts": { color: "rgb(249,115,22)" },
};

// ── Main Page ───────────────────────────────────────

export default function EarnPage() {
  const [vmStatus, setVmStatus] = useState<VMStatus | null>(null);
  const [search, setSearch] = useState("");
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [togglingAgdp, setTogglingAgdp] = useState(false);
  const [agdpConfirm, setAgdpConfirm] = useState<"enable" | "disable" | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/vm/status");
      const data = await res.json();
      setVmStatus(data);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  async function handleToggleAgdp(enabled: boolean) {
    if (!vmStatus?.vm || togglingAgdp) return;
    setAgdpConfirm(null);
    setTogglingAgdp(true);
    try {
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle_agdp", enabled }),
      });
      if (res.ok) {
        setTimeout(fetchStatus, 2000);
        setToast({ message: enabled ? "Virtuals Protocol enabled" : "Virtuals Protocol disabled", type: "success" });
      } else {
        const data = await res.json().catch(() => ({}));
        setToast({ message: data.error || "Failed to update", type: "error" });
      }
    } catch {
      setToast({ message: "Network error", type: "error" });
    } finally {
      setTogglingAgdp(false);
      setTimeout(() => setToast(null), 3000);
    }
  }

  // Update channel statuses based on VM state
  const channels = useMemo(() => {
    return CHANNELS.map((ch) => {
      if (ch.id === "virtuals" && vmStatus?.vm?.agdpEnabled) {
        return { ...ch, status: "active" as const };
      }
      return ch;
    });
  }, [vmStatus]);

  // Filter channels by search
  const filteredChannels = useMemo(() => {
    if (!search.trim()) return channels;
    const q = search.toLowerCase();
    return channels.filter(
      (ch) =>
        ch.name.toLowerCase().includes(q) ||
        ch.headline.toLowerCase().includes(q) ||
        ch.description.toLowerCase().includes(q) ||
        ch.tags.some((t) => t.includes(q))
    );
  }, [channels, search]);

  const vm = vmStatus?.vm;

  if (vmStatus && vmStatus.status !== "assigned") {
    return (
      <div className="space-y-10">
        <div>
          <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>
            Earn
          </h1>
          <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
            Set up the ways your agent makes money for you.
          </p>
        </div>
        <div className="glass rounded-xl p-8 text-center" style={{ border: "1px solid var(--border)" }}>
          <p className="text-lg font-medium">No Instance Active</p>
          <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
            Complete onboarding to deploy your agent and start earning.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
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
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div>
        <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>
          Earn
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Your agent can earn money through multiple channels. Turn them on below.
        </p>
      </div>

      {/* Search — only show if useful */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "var(--muted)" }} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search (e.g. Shopify, Polymarket, freelance...)"
          className="w-full pl-10 pr-4 py-3 rounded-xl text-sm outline-none"
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
          }}
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-xs cursor-pointer"
            style={{ color: "var(--muted)" }}
          >
            Clear
          </button>
        )}
      </div>

      {/* No results */}
      {filteredChannels.length === 0 && (
        <div className="text-center py-8">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No earning channels match &ldquo;{search}&rdquo;
          </p>
        </div>
      )}

      {/* Channel list — flat, ordered by ease */}
      <div className="space-y-3">
        {filteredChannels.map((ch) => (
          <ChannelCard
            key={ch.id}
            channel={ch}
            vm={vm}
            expanded={expandedChannel === ch.id}
            onToggle={() => setExpandedChannel(expandedChannel === ch.id ? null : ch.id)}
            togglingAgdp={togglingAgdp}
            agdpConfirm={agdpConfirm}
            setAgdpConfirm={setAgdpConfirm}
            handleToggleAgdp={handleToggleAgdp}
          />
        ))}
      </div>
    </div>
  );
}

// ── Channel Card Component ──────────────────────────

function ChannelCard({
  channel,
  vm,
  expanded,
  onToggle,
  togglingAgdp,
  agdpConfirm,
  setAgdpConfirm,
  handleToggleAgdp,
}: {
  channel: EarningChannel;
  vm?: VMStatus["vm"];
  expanded: boolean;
  onToggle: () => void;
  togglingAgdp: boolean;
  agdpConfirm: "enable" | "disable" | null;
  setAgdpConfirm: (v: "enable" | "disable" | null) => void;
  handleToggleAgdp: (enabled: boolean) => void;
}) {
  const Icon = channel.icon;
  const status = STATUS_CONFIG[channel.status];
  const StatusIcon = status.icon;
  const effort = EFFORT_STYLES[channel.effort];

  return (
    <div className="glass rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
      {/* Header row */}
      <button onClick={onToggle} className="w-full flex items-center gap-4 p-5 cursor-pointer text-left">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: channel.status === "active" ? "rgba(34,197,94,0.08)" : "rgba(0,0,0,0.04)",
            border: channel.status === "active" ? "1px solid rgba(34,197,94,0.15)" : "1px solid var(--border)",
          }}
        >
          <Icon className="w-5 h-5" style={{ color: channel.status === "active" ? "rgb(34,197,94)" : "var(--muted)" }} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold">{channel.name}</h3>
            <span
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0"
              style={{ background: status.bg, color: status.color, border: status.border }}
            >
              <StatusIcon className="w-3 h-3" />
              {status.label}
            </span>
          </div>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            {channel.headline}
          </p>
          <div className="flex items-center gap-1.5 mt-1.5">
            <Clock className="w-3 h-3" style={{ color: effort.color }} />
            <span className="text-[11px] font-medium" style={{ color: effort.color }}>
              {channel.effort}
            </span>
          </div>
        </div>

        <ChevronDown
          className="w-4 h-4 shrink-0 ml-1 transition-transform"
          style={{ color: "var(--muted)", transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>

      {/* Expanded content */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5" style={{ borderTop: "1px solid var(--border)" }}>
              <div className="pt-4">
                {/* Description visible for all channels */}
                <p className="text-sm mb-4" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                  {channel.description}
                </p>

                {channel.id === "clawlancer" && <ClawlancerSection />}
                {channel.id === "virtuals" && (
                  <VirtualsSection
                    vm={vm}
                    togglingAgdp={togglingAgdp}
                    agdpConfirm={agdpConfirm}
                    setAgdpConfirm={setAgdpConfirm}
                    handleToggleAgdp={handleToggleAgdp}
                  />
                )}
                {channel.id === "polymarket" && <PolymarketPanel />}
                {channel.id === "ecommerce" && <EcommerceSection botUsername={vm?.telegramBotUsername} />}
                {channel.id === "freelance" && <FreelanceSection botUsername={vm?.telegramBotUsername} />}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Helper: copy-able bot message ───────────────────

function BotMessage({ message, botUsername }: { message: string; botUsername?: string | null }) {
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
            Message your bot{botUsername ? ` @${botUsername}` : ""}:
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

// ── Clawlancer Section ──────────────────────────────

interface ClawlancerStatus {
  registered: boolean;
  vmId?: string;
  agentName?: string;
  agentId?: string;
  walletAddress?: string | null;
  reputationTier?: string;
  transactionCount?: number;
  totalEarnedUsdc?: string;
  monthlyEarnedUsdc?: string;
  balanceUsdc?: string;
  recentTransactions?: {
    id: string;
    state: string;
    description: string;
    amount: string;
    createdAt: string;
    deliveredAt?: string;
    completedAt?: string;
    buyer?: string | null;
    seller?: string | null;
  }[];
  botUsername?: string | null;
  preferences?: {
    autoClaim: boolean;
    approvalThreshold: number;
  };
  error?: string;
}

const TX_STATE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  FUNDED: { label: "Claimed", color: "rgb(59,130,246)", bg: "rgba(59,130,246,0.08)" },
  DELIVERED: { label: "Delivered", color: "rgb(168,85,247)", bg: "rgba(168,85,247,0.08)" },
  RELEASED: { label: "Paid", color: "rgb(34,197,94)", bg: "rgba(34,197,94,0.08)" },
  DISPUTED: { label: "Disputed", color: "rgb(239,68,68)", bg: "rgba(239,68,68,0.08)" },
  REFUNDED: { label: "Refunded", color: "rgb(249,115,22)", bg: "rgba(249,115,22,0.08)" },
};

// Skeleton loader for the earnings display
function EarningsSkeleton() {
  return (
    <div className="space-y-5 animate-pulse">
      {/* Big number skeleton */}
      <div className="text-center py-4">
        <div className="h-3 w-20 rounded bg-current opacity-[0.06] mx-auto mb-3" />
        <div className="h-10 w-36 rounded bg-current opacity-[0.08] mx-auto mb-2" />
        <div className="h-3 w-32 rounded bg-current opacity-[0.05] mx-auto" />
      </div>
      {/* Stats row skeleton */}
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg p-3" style={{ border: "1px solid var(--border)" }}>
            <div className="h-2.5 w-12 rounded bg-current opacity-[0.06] mb-2" />
            <div className="h-5 w-16 rounded bg-current opacity-[0.08]" />
          </div>
        ))}
      </div>
      {/* Activity skeleton */}
      <div className="space-y-2">
        <div className="h-3 w-24 rounded bg-current opacity-[0.06] mb-3" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg px-4 py-3 flex justify-between" style={{ border: "1px solid var(--border)" }}>
            <div>
              <div className="h-3 w-32 rounded bg-current opacity-[0.07] mb-1.5" />
              <div className="h-2.5 w-20 rounded bg-current opacity-[0.05]" />
            </div>
            <div className="h-4 w-12 rounded bg-current opacity-[0.07]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ClawlancerSection() {
  const [status, setStatus] = useState<ClawlancerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoClaim, setAutoClaim] = useState(true);
  const [threshold, setThreshold] = useState("50");
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);

  useEffect(() => {
    fetch("/api/clawlancer/status")
      .then((r) => r.json())
      .then((data) => {
        setStatus(data);
        if (data.error && !data.registered && !data.vmId) setError(data.error);
        if (data.preferences) {
          setAutoClaim(data.preferences.autoClaim);
          setThreshold(String(data.preferences.approvalThreshold));
        }
      })
      .catch(() => setError("Failed to load Clawlancer data"))
      .finally(() => setLoading(false));
  }, []);

  async function savePreferences(newAutoClaim: boolean, newThreshold?: string) {
    setSavingPrefs(true);
    setPrefsSaved(false);
    try {
      const body: Record<string, unknown> = { autoClaim: newAutoClaim };
      if (newThreshold !== undefined) {
        body.approvalThreshold = Number(newThreshold);
      }
      const res = await fetch("/api/clawlancer/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) setPrefsSaved(true);
    } catch {
      // silent
    } finally {
      setSavingPrefs(false);
      setTimeout(() => setPrefsSaved(false), 2000);
    }
  }

  // Loading state — skeleton
  if (loading) return <EarningsSkeleton />;

  // Hard error — no VM, network failure
  if (error && !status) {
    return (
      <div
        className="rounded-lg p-5"
        style={{ background: "rgba(239,68,68,0.04)", border: "1px solid rgba(239,68,68,0.12)" }}
      >
        <div className="flex items-center gap-2 mb-2">
          <AlertCircle className="w-4 h-4" style={{ color: "rgb(239,68,68)" }} />
          <span className="text-sm font-semibold" style={{ color: "rgb(239,68,68)" }}>
            Connection issue
          </span>
        </div>
        <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
          {error}
        </p>
      </div>
    );
  }

  // Not registered — setup wizard
  if (!status?.registered) {
    return (
      <div className="space-y-5">
        {/* Step indicator */}
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
            style={{
              background: status?.walletAddress
                ? "rgba(34,197,94,0.1)"
                : "rgba(249,115,22,0.1)",
              color: status?.walletAddress
                ? "rgb(34,197,94)"
                : "rgb(249,115,22)",
              border: status?.walletAddress
                ? "1px solid rgba(34,197,94,0.2)"
                : "1px solid rgba(249,115,22,0.2)",
            }}
          >
            1
          </div>
          <div>
            <p className="text-sm font-semibold">Register on Clawlancer</p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Your agent needs a marketplace account to claim bounties and earn USDC
            </p>
          </div>
        </div>

        {/* What happens */}
        <div
          className="rounded-lg p-4"
          style={{ background: "rgba(59,130,246,0.04)", border: "1px solid rgba(59,130,246,0.12)" }}
        >
          <p className="text-xs font-semibold mb-2" style={{ color: "rgb(59,130,246)" }}>
            What happens when you register:
          </p>
          <ul className="space-y-1.5 text-xs" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" style={{ color: "rgb(59,130,246)" }} />
              Your agent creates a Base wallet for receiving USDC payments
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" style={{ color: "rgb(59,130,246)" }} />
              Registers on the Clawlancer marketplace with its skills
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" style={{ color: "rgb(59,130,246)" }} />
              Starts checking for bounties every 3 hours automatically
            </li>
          </ul>
        </div>

        {/* CTA */}
        <BotMessage
          message="Register on Clawlancer. Before you register, ask me what I want your marketplace name to be."
          botUsername={status?.botUsername}
        />

        {status?.error && (
          <p className="text-[11px]" style={{ color: "var(--muted)" }}>
            {status.error}
          </p>
        )}
      </div>
    );
  }

  // ── Registered — Full Earnings Dashboard ──
  const totalEarned = Number(status.totalEarnedUsdc ?? "0");
  const monthlyEarned = Number(status.monthlyEarnedUsdc ?? "0");
  const balance = Number(status.balanceUsdc ?? "0");
  const txCount = status.transactionCount ?? 0;
  const tier = status.reputationTier ?? "NEW";
  const txs = status.recentTransactions ?? [];

  return (
    <div className="space-y-5">
      {/* ── Hero: Total Earned (Robinhood-style) ── */}
      <div className="text-center py-2">
        <p className="text-[11px] font-medium tracking-wide uppercase" style={{ color: "var(--muted)" }}>
          Total Earned
        </p>
        <p
          className="text-4xl sm:text-5xl font-bold tracking-tight mt-1"
          style={{ color: "rgb(34,197,94)", fontVariantNumeric: "tabular-nums" }}
        >
          ${totalEarned.toFixed(2)}
        </p>
        <p className="text-xs mt-1.5" style={{ color: "var(--muted)" }}>
          ${monthlyEarned.toFixed(2)} this month
        </p>
      </div>

      {/* ── Stats Grid ── */}
      <div className="grid grid-cols-3 gap-3">
        <div
          className="rounded-lg p-3 text-center"
          style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
        >
          <Wallet className="w-3.5 h-3.5 mx-auto mb-1" style={{ color: "rgb(59,130,246)" }} />
          <p className="text-lg font-bold" style={{ fontVariantNumeric: "tabular-nums" }}>
            ${balance.toFixed(2)}
          </p>
          <p className="text-[10px]" style={{ color: "var(--muted)" }}>USDC Balance</p>
        </div>
        <div
          className="rounded-lg p-3 text-center"
          style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
        >
          <CheckCircle2 className="w-3.5 h-3.5 mx-auto mb-1" style={{ color: "rgb(168,85,247)" }} />
          <p className="text-lg font-bold">{txCount}</p>
          <p className="text-[10px]" style={{ color: "var(--muted)" }}>Bounties</p>
        </div>
        <div
          className="rounded-lg p-3 text-center"
          style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
        >
          <TrendingUp className="w-3.5 h-3.5 mx-auto mb-1" style={{ color: "rgb(249,115,22)" }} />
          <p className="text-lg font-bold">{tier}</p>
          <p className="text-[10px]" style={{ color: "var(--muted)" }}>Reputation</p>
        </div>
      </div>

      {/* ── Agent & Wallet Info ── */}
      <div
        className="flex items-center justify-between rounded-lg px-4 py-3"
        style={{ background: "rgba(34,197,94,0.04)", border: "1px solid rgba(34,197,94,0.12)" }}
      >
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "rgb(34,197,94)" }} />
          <span className="text-xs font-medium" style={{ color: "rgb(34,197,94)" }}>
            {status.agentName}
          </span>
        </div>
        {status.walletAddress && (
          <span className="text-[10px] font-mono" style={{ color: "var(--muted)" }}>
            {status.walletAddress.slice(0, 6)}...{status.walletAddress.slice(-4)}
          </span>
        )}
      </div>

      {/* ── Activity Feed ── */}
      <div>
        <p className="text-xs font-semibold mb-3">Activity</p>
        {txs.length > 0 ? (
          <div className="space-y-2">
            {txs.map((tx) => {
              const stateInfo = TX_STATE_LABELS[tx.state] ?? {
                label: tx.state,
                color: "var(--muted)",
                bg: "rgba(0,0,0,0.04)",
              };
              const date = tx.completedAt || tx.deliveredAt || tx.createdAt;
              return (
                <div
                  key={tx.id}
                  className="flex items-center justify-between rounded-lg px-4 py-3"
                  style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
                >
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="text-xs font-medium truncate">{tx.description}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: stateInfo.bg, color: stateInfo.color }}
                      >
                        {stateInfo.label}
                      </span>
                      <span className="text-[10px]" style={{ color: "var(--muted)" }}>
                        {new Date(date).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                      {tx.buyer && (
                        <span className="text-[10px]" style={{ color: "var(--muted)" }}>
                          from {tx.buyer}
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className="text-sm font-bold shrink-0 tabular-nums"
                    style={{ color: tx.state === "RELEASED" ? "rgb(34,197,94)" : "var(--foreground)" }}
                  >
                    ${tx.amount}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="rounded-lg p-5 text-center"
            style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
          >
            <Store className="w-5 h-5 mx-auto mb-2" style={{ color: "var(--muted)" }} />
            <p className="text-xs font-medium mb-1">No bounties yet</p>
            <p className="text-[11px]" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
              Your agent checks the bounty board every 3 hours. Bounties will appear here as your agent claims and completes work.
            </p>
          </div>
        )}
      </div>

      {/* ── Safety Controls ── */}
      <div>
        <p className="text-xs font-semibold mb-3">Safety Controls</p>
        <div className="space-y-3">
          {/* Auto-claim toggle */}
          <div
            className="flex items-center justify-between rounded-lg px-4 py-3"
            style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
          >
            <div className="mr-3">
              <p className="text-xs font-semibold">Auto-claim bounties</p>
              <p className="text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
                {autoClaim
                  ? "Agent claims matching bounties automatically"
                  : "Agent asks you before claiming any bounty"}
              </p>
            </div>
            <button
              type="button"
              disabled={savingPrefs}
              onClick={() => {
                const next = !autoClaim;
                setAutoClaim(next);
                savePreferences(next, threshold);
              }}
              className="relative w-11 h-6 rounded-full transition-all cursor-pointer shrink-0 disabled:opacity-50"
              style={{
                background: autoClaim
                  ? "linear-gradient(135deg, rgba(22,22,22,0.7), rgba(40,40,40,0.8))"
                  : "rgba(0,0,0,0.08)",
                boxShadow: autoClaim
                  ? "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15)"
                  : "0 0 0 1px rgba(0,0,0,0.08)",
              }}
            >
              <span
                className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
                style={{
                  left: autoClaim ? "22px" : "2px",
                  background: "white",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                  transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
                }}
              />
            </button>
          </div>

          {/* Approval threshold */}
          {autoClaim && (
            <div
              className="rounded-lg px-4 py-3"
              style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
            >
              <p className="text-xs font-semibold mb-0.5">Approval threshold</p>
              <p className="text-[11px] mb-3" style={{ color: "var(--muted)" }}>
                Bounties over this amount require your approval before claiming
              </p>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium" style={{ color: "var(--muted)" }}>$</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  onBlur={() => savePreferences(autoClaim, threshold)}
                  className="w-24 px-3 py-1.5 rounded-lg text-sm font-medium outline-none"
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                  }}
                />
                <span className="text-[11px]" style={{ color: "var(--muted)" }}>USDC</span>
                {savingPrefs && (
                  <RefreshCw className="w-3 h-3 animate-spin" style={{ color: "var(--muted)" }} />
                )}
                {prefsSaved && (
                  <CheckCircle2 className="w-3 h-3" style={{ color: "rgb(34,197,94)" }} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Virtuals Protocol Section ───────────────────────

interface VirtualsStatus {
  enabled: boolean;
  vmId?: string;
  authenticated?: boolean;
  serving?: boolean;
  walletAddress?: string | null;
  agentName?: string | null;
  offeringCount?: number;
  authUrl?: string | null;
  virtualsUsageToday?: number;
  virtualsLimit?: number;
  error?: string;
}

function VirtualsSection({
  vm,
  togglingAgdp,
  agdpConfirm,
  setAgdpConfirm,
  handleToggleAgdp,
}: {
  vm?: VMStatus["vm"];
  togglingAgdp: boolean;
  agdpConfirm: "enable" | "disable" | null;
  setAgdpConfirm: (v: "enable" | "disable" | null) => void;
  handleToggleAgdp: (enabled: boolean) => void;
}) {
  const enabled = vm?.agdpEnabled ?? false;
  const [status, setStatus] = useState<VirtualsStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateResult, setActivateResult] = useState<string | null>(null);

  // Fetch Virtuals status when enabled
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    setLoadingStatus(true);
    fetch("/api/virtuals/status")
      .then((r) => r.json())
      .then((data) => setStatus(data))
      .catch(() => setStatus({ enabled: true, error: "Failed to check status" }))
      .finally(() => setLoadingStatus(false));
  }, [enabled]);

  async function handleActivate() {
    setActivating(true);
    setActivateResult(null);
    try {
      const res = await fetch("/api/virtuals/activate", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setActivateResult("success");
        // Refresh status
        const statusRes = await fetch("/api/virtuals/status");
        const statusData = await statusRes.json();
        setStatus(statusData);
      } else {
        setActivateResult(data.error || "Activation failed");
      }
    } catch {
      setActivateResult("Network error");
    } finally {
      setActivating(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Main toggle */}
      <div
        className="flex items-center justify-between rounded-lg p-4"
        style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
      >
        <div className="mr-4">
          <p className="text-sm font-semibold">
            {enabled ? "Virtuals Protocol is on" : "Turn on Virtuals Protocol"}
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
            {enabled
              ? "Your agent picks up Virtuals jobs when Clawlancer work isn't available."
              : "One click to enable. Your Clawlancer jobs always come first."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (togglingAgdp) return;
            setAgdpConfirm(enabled ? "disable" : "enable");
          }}
          disabled={togglingAgdp}
          className="relative w-12 h-7 rounded-full transition-all cursor-pointer shrink-0 disabled:opacity-50"
          style={{
            background: enabled
              ? "linear-gradient(135deg, rgba(22,22,22,0.7), rgba(40,40,40,0.8))"
              : "rgba(0,0,0,0.08)",
            boxShadow: enabled
              ? "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15)"
              : "0 0 0 1px rgba(0,0,0,0.08)",
          }}
        >
          <span
            className="absolute top-1 w-5 h-5 rounded-full transition-all"
            style={{
              left: enabled ? "24px" : "4px",
              background: "white",
              boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
              transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
            }}
          />
        </button>
      </div>

      {togglingAgdp && (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
          <RefreshCw className="w-3 h-3 animate-spin" />
          {enabled ? "Turning off" : "Turning on"} Virtuals Protocol...
        </div>
      )}

      {/* Confirmation dialog */}
      {agdpConfirm && (
        <div
          className="rounded-xl p-5"
          style={{
            border: agdpConfirm === "enable" ? "1px solid rgba(249,115,22,0.2)" : "1px solid rgba(239,68,68,0.2)",
            background: agdpConfirm === "enable" ? "rgba(249,115,22,0.04)" : "rgba(239,68,68,0.04)",
          }}
        >
          <p className="text-sm font-semibold mb-1">
            {agdpConfirm === "enable" ? "Turn on Virtuals Protocol?" : "Turn off Virtuals Protocol?"}
          </p>
          <p className="text-xs mb-4" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
            {agdpConfirm === "enable"
              ? "This installs the Virtuals Protocol skill on your agent and sets up a marketplace listing."
              : "Your agent will stop accepting Virtuals jobs. You can turn it back on anytime."}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setAgdpConfirm(null)}
              className="px-4 py-2 rounded-full text-xs font-medium transition-all active:scale-95 cursor-pointer"
              style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)" }}
            >
              Cancel
            </button>
            <button
              onClick={() => handleToggleAgdp(agdpConfirm === "enable")}
              className="px-4 py-2 rounded-full text-xs font-semibold transition-all active:scale-95 cursor-pointer"
              style={agdpConfirm === "enable" ? {
                background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                color: "#fff",
              } : {
                background: "linear-gradient(135deg, rgba(239,68,68,0.85), rgba(220,38,38,0.95))",
                color: "#fff",
              }}
            >
              {agdpConfirm === "enable" ? "Turn On" : "Turn Off"}
            </button>
          </div>
        </div>
      )}

      {/* ── Enabled: Status Dashboard ── */}
      {enabled && !togglingAgdp && !agdpConfirm && (
        <>
          {/* Loading state */}
          {loadingStatus && (
            <div className="flex items-center gap-2 text-xs py-4" style={{ color: "var(--muted)" }}>
              <RefreshCw className="w-3 h-3 animate-spin" />
              Checking Virtuals Protocol status...
            </div>
          )}

          {/* Error state */}
          {status?.error && !loadingStatus && (
            <div
              className="rounded-lg p-4"
              style={{ background: "rgba(239,68,68,0.04)", border: "1px solid rgba(239,68,68,0.12)" }}
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4" style={{ color: "rgb(239,68,68)" }} />
                <span className="text-xs" style={{ color: "rgb(239,68,68)" }}>{status.error}</span>
              </div>
            </div>
          )}

          {/* Not authenticated — show auth URL */}
          {status && !status.authenticated && !status.error && !loadingStatus && (
            <div className="space-y-4">
              {/* Step 1: Authenticate */}
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{
                    background: "rgba(249,115,22,0.1)",
                    color: "rgb(249,115,22)",
                    border: "1px solid rgba(249,115,22,0.2)",
                  }}
                >
                  1
                </div>
                <div>
                  <p className="text-sm font-semibold">Authenticate with Virtuals Protocol</p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    Open the link below to connect your agent to the Virtuals marketplace
                  </p>
                </div>
              </div>

              {status.authUrl ? (
                <a
                  href={status.authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl text-sm font-semibold transition-all active:scale-[0.98] cursor-pointer"
                  style={{
                    background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                    color: "#fff",
                  }}
                >
                  <Globe className="w-4 h-4" />
                  Open Virtuals Authentication
                  <ArrowRight className="w-4 h-4" />
                </a>
              ) : (
                <BotMessage
                  message="Set up Virtuals Protocol authentication"
                  botUsername={vm?.telegramBotUsername}
                />
              )}

              {/* Step 2: Verify & Start */}
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{
                    background: "rgba(0,0,0,0.04)",
                    color: "var(--muted)",
                    border: "1px solid var(--border)",
                  }}
                >
                  2
                </div>
                <div>
                  <p className="text-sm font-semibold">Verify & Start Earning</p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    After authenticating, click below to start accepting jobs
                  </p>
                </div>
              </div>

              <button
                onClick={handleActivate}
                disabled={activating}
                className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl text-sm font-semibold transition-all active:scale-[0.98] cursor-pointer disabled:opacity-50"
                style={{
                  background: "rgba(0,0,0,0.06)",
                  color: "var(--foreground)",
                  border: "1px solid var(--border)",
                }}
              >
                {activating ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    Verify Authentication & Start
                  </>
                )}
              </button>

              {activateResult && activateResult !== "success" && (
                <p className="text-xs" style={{ color: "rgb(239,68,68)" }}>{activateResult}</p>
              )}
            </div>
          )}

          {/* Authenticated & serving — active dashboard */}
          {status?.authenticated && !loadingStatus && (
            <div className="space-y-4">
              {/* Status indicator */}
              <div
                className="flex items-center justify-between rounded-lg px-4 py-3"
                style={{
                  background: status.serving ? "rgba(34,197,94,0.04)" : "rgba(249,115,22,0.04)",
                  border: status.serving ? "1px solid rgba(34,197,94,0.12)" : "1px solid rgba(249,115,22,0.12)",
                }}
              >
                <div className="flex items-center gap-2">
                  {status.serving ? (
                    <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "rgb(34,197,94)" }} />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5" style={{ color: "rgb(249,115,22)" }} />
                  )}
                  <span
                    className="text-xs font-medium"
                    style={{ color: status.serving ? "rgb(34,197,94)" : "rgb(249,115,22)" }}
                  >
                    {status.serving ? "Accepting jobs" : "Authenticated but not serving"}
                  </span>
                </div>
                {status.walletAddress && (
                  <span className="text-[10px] font-mono" style={{ color: "var(--muted)" }}>
                    {status.walletAddress.slice(0, 6)}...{status.walletAddress.slice(-4)}
                  </span>
                )}
              </div>

              {/* Start serving button if not running */}
              {!status.serving && (
                <button
                  onClick={handleActivate}
                  disabled={activating}
                  className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl text-sm font-semibold transition-all active:scale-[0.98] cursor-pointer disabled:opacity-50"
                  style={{
                    background: "linear-gradient(135deg, rgba(249,115,22,0.85), rgba(234,88,12,0.95))",
                    color: "#fff",
                  }}
                >
                  {activating ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4" />
                      Start Accepting Jobs
                    </>
                  )}
                </button>
              )}

              {/* Virtuals credit usage */}
              {(status.virtualsLimit ?? 0) > 0 && (
                <div
                  className="rounded-lg px-4 py-3"
                  style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold">Virtuals Credits Today</p>
                    <span className="text-xs font-medium tabular-nums" style={{ color: "var(--muted)" }}>
                      {Math.round(status.virtualsUsageToday ?? 0)}/{status.virtualsLimit}
                    </span>
                  </div>
                  <div
                    className="w-full h-2 rounded-full overflow-hidden"
                    style={{ background: "rgba(0,0,0,0.06)" }}
                  >
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, ((status.virtualsUsageToday ?? 0) / (status.virtualsLimit ?? 1)) * 100)}%`,
                        background:
                          ((status.virtualsUsageToday ?? 0) / (status.virtualsLimit ?? 1)) >= 0.9
                            ? "rgb(239,68,68)"
                            : ((status.virtualsUsageToday ?? 0) / (status.virtualsLimit ?? 1)) >= 0.7
                              ? "rgb(249,115,22)"
                              : "rgb(34,197,94)",
                      }}
                    />
                  </div>
                  <p className="text-[10px] mt-1.5" style={{ color: "var(--muted)" }}>
                    Separate from your chat credits. Resets daily.
                  </p>
                </div>
              )}

              {/* Stats */}
              <div className="grid grid-cols-2 gap-3">
                <div
                  className="rounded-lg p-3 text-center"
                  style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
                >
                  <CheckCircle2 className="w-3.5 h-3.5 mx-auto mb-1" style={{ color: "rgb(168,85,247)" }} />
                  <p className="text-lg font-bold">{status.offeringCount ?? 0}</p>
                  <p className="text-[10px]" style={{ color: "var(--muted)" }}>Offerings</p>
                </div>
                <div
                  className="rounded-lg p-3 text-center"
                  style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
                >
                  <Globe className="w-3.5 h-3.5 mx-auto mb-1" style={{ color: "rgb(249,115,22)" }} />
                  <p className="text-lg font-bold">ACP</p>
                  <p className="text-[10px]" style={{ color: "var(--muted)" }}>Marketplace</p>
                </div>
              </div>

              {/* How it works */}
              <div
                className="rounded-lg p-5 text-center"
                style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
              >
                <Store className="w-5 h-5 mx-auto mb-2" style={{ color: "var(--muted)" }} />
                <p className="text-xs font-medium mb-1">
                  {status.serving ? "Listening for jobs" : "Ready to accept jobs"}
                </p>
                <p className="text-[11px]" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
                  Your agent is listed on the Virtuals Protocol ACP marketplace. When other agents or users send task requests, your agent completes them automatically and earns fees.
                </p>
              </div>

              {activateResult === "success" && (
                <div className="flex items-center gap-2 text-xs" style={{ color: "rgb(34,197,94)" }}>
                  <CheckCircle2 className="w-3 h-3" />
                  ACP serve started successfully
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── E-Commerce Section ──────────────────────────────

function EcommerceSection({ botUsername }: { botUsername?: string | null }) {
  return (
    <div className="space-y-4">
      {/* Platform cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { name: "Shopify", desc: "Manage your store, orders, and inventory", example: "Connect my Shopify store at mystore.myshopify.com" },
          { name: "Amazon", desc: "Seller Central, FBA, listing optimization", example: "Set up my Amazon seller account" },
          { name: "eBay", desc: "Listings, orders, and buyer messaging", example: "Connect my eBay store" },
        ].map((platform) => (
          <div
            key={platform.name}
            className="rounded-lg p-4"
            style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
          >
            <p className="text-sm font-semibold mb-1">{platform.name}</p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>{platform.desc}</p>
          </div>
        ))}
      </div>

      <div
        className="rounded-lg p-4"
        style={{ background: "rgba(249,115,22,0.04)", border: "1px solid rgba(249,115,22,0.12)" }}
      >
        <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
          <strong style={{ color: "var(--foreground)" }}>You&apos;ll need:</strong> Your own account on the platform you want to connect.
          Your agent will ask you for your store URL and API credentials when you set it up.
        </p>
      </div>

      <BotMessage
        message="Set up my Shopify store"
        botUsername={botUsername}
      />
    </div>
  );
}

// ── Freelance & Digital Products Section ─────────────

function FreelanceSection({ botUsername }: { botUsername?: string | null }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          { name: "Gumroad", desc: "Sell digital products, templates, and guides" },
          { name: "Fiverr", desc: "List services and complete gig orders" },
          { name: "Contra", desc: "Take on freelance projects and proposals" },
          { name: "Upwork", desc: "Bid on freelance jobs and deliver work" },
        ].map((platform) => (
          <div
            key={platform.name}
            className="rounded-lg p-4"
            style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
          >
            <p className="text-sm font-semibold mb-0.5">{platform.name}</p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>{platform.desc}</p>
          </div>
        ))}
      </div>

      <div
        className="rounded-lg p-4"
        style={{ background: "rgba(59,130,246,0.04)", border: "1px solid rgba(59,130,246,0.12)" }}
      >
        <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
          <strong style={{ color: "var(--foreground)" }}>How it works:</strong> Tell your agent what products or services you want to offer.
          It drafts listings and proposals for you. Nothing goes live until you approve it.
        </p>
      </div>

      <BotMessage
        message="Create a Gumroad product — a PDF guide about productivity tips"
        botUsername={botUsername}
      />
    </div>
  );
}
