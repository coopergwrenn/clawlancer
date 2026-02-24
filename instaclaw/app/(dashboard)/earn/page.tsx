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
} from "lucide-react";
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
    name: "Prediction Markets",
    headline: "Track event odds and trade on real-world outcomes",
    description: "Your agent can monitor prediction markets (like Polymarket), watch for price changes, and even place trades for you with safety limits you control.",
    icon: TrendingUp,
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
          placeholder="Search (e.g. Shopify, prediction markets, freelance...)"
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

function ClawlancerSection() {
  return (
    <div
      className="rounded-lg p-4"
      style={{ background: "rgba(34,197,94,0.04)", border: "1px solid rgba(34,197,94,0.12)" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <CheckCircle2 className="w-4 h-4" style={{ color: "rgb(34,197,94)" }} />
        <span className="text-sm font-semibold" style={{ color: "rgb(34,197,94)" }}>Already running</span>
      </div>
      <p className="text-xs" style={{ color: "var(--muted)", lineHeight: "1.6" }}>
        This is always on. Your agent checks the Clawlancer job board automatically,
        picks up work it&apos;s qualified for, completes it, and gets paid.
        No action needed from you.
      </p>
    </div>
  );
}

// ── Virtuals Protocol Section ───────────────────────

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
              ? "This adds a new skill to your agent. After turning it on, you'll need to message your bot once to finish setup."
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

      {/* Post-enable next step */}
      {enabled && !togglingAgdp && !agdpConfirm && vm?.telegramBotUsername && (
        <BotMessage
          message="Set up Virtuals marketplace"
          botUsername={vm.telegramBotUsername}
        />
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
