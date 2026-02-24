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
  category: "marketplace" | "trading" | "ecommerce" | "freelance";
  description: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  status: "active" | "available" | "setup-required";
  tags: string[];
}

const CHANNELS: EarningChannel[] = [
  {
    id: "clawlancer",
    name: "Clawlancer",
    category: "marketplace",
    description: "Your primary marketplace. Autonomous bounties — poll, claim, deliver, earn.",
    icon: Store,
    status: "active",
    tags: ["bounties", "autonomous", "primary", "marketplace"],
  },
  {
    id: "virtuals",
    name: "Virtuals Protocol (ACP)",
    category: "marketplace",
    description: "Agent Commerce marketplace — earn from AI jobs on the Virtuals network.",
    icon: Globe,
    status: "available",
    tags: ["marketplace", "agent commerce", "virtuals", "acp", "secondary"],
  },
  {
    id: "polymarket",
    name: "Polymarket Trading",
    category: "trading",
    description: "Prediction market intelligence, portfolio monitoring, and autonomous trading.",
    icon: TrendingUp,
    status: "available",
    tags: ["prediction market", "trading", "polymarket", "betting", "odds", "probabilities"],
  },
  {
    id: "ecommerce",
    name: "E-Commerce Operations",
    category: "ecommerce",
    description: "Shopify, Amazon, eBay — inventory sync, order management, competitor pricing.",
    icon: ShoppingBag,
    status: "setup-required",
    tags: ["shopify", "amazon", "ebay", "ecommerce", "inventory", "orders", "shipping"],
  },
  {
    id: "freelance",
    name: "Freelance & Digital Products",
    category: "freelance",
    description: "Create and sell on Contra, Gumroad, Fiverr, Upwork — digital products and services.",
    icon: BarChart3,
    status: "available",
    tags: ["contra", "gumroad", "fiverr", "upwork", "freelance", "digital products", "passive income"],
  },
];

// ── Category labels ─────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  marketplace: "Marketplaces",
  trading: "Trading & Prediction Markets",
  ecommerce: "E-Commerce",
  freelance: "Freelance & Products",
};

const STATUS_STYLES: Record<string, { bg: string; color: string; border: string; label: string }> = {
  active: {
    bg: "rgba(34,197,94,0.1)",
    color: "rgb(34,197,94)",
    border: "1px solid rgba(34,197,94,0.2)",
    label: "Active",
  },
  available: {
    bg: "rgba(59,130,246,0.1)",
    color: "rgb(59,130,246)",
    border: "1px solid rgba(59,130,246,0.2)",
    label: "Available",
  },
  "setup-required": {
    bg: "rgba(249,115,22,0.1)",
    color: "rgb(249,115,22)",
    border: "1px solid rgba(249,115,22,0.2)",
    label: "Setup Required",
  },
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
        ch.description.toLowerCase().includes(q) ||
        ch.tags.some((t) => t.includes(q)) ||
        ch.category.includes(q)
    );
  }, [channels, search]);

  // Group by category
  const grouped = useMemo(() => {
    const groups: Record<string, typeof filteredChannels> = {};
    for (const ch of filteredChannels) {
      if (!groups[ch.category]) groups[ch.category] = [];
      groups[ch.category].push(ch);
    }
    return groups;
  }, [filteredChannels]);

  const vm = vmStatus?.vm;

  if (vmStatus && vmStatus.status !== "assigned") {
    return (
      <div className="space-y-10">
        <div>
          <h1
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Earn
          </h1>
          <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
            Configure how your agent earns money.
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
    <div className="space-y-10">
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
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Earn
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Configure how your agent earns money for you.
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
          style={{ color: "var(--muted)" }}
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search channels... (Shopify, Polymarket, Virtuals, freelance...)"
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

      {/* Channel groups */}
      {Object.entries(grouped).map(([category, chs]) => (
        <div key={category}>
          <h2
            className="text-2xl font-normal tracking-[-0.5px] mb-5"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            {CATEGORY_LABELS[category] ?? category}
          </h2>
          <div className="space-y-3">
            {chs.map((ch) => (
              <ChannelCard
                key={ch.id}
                channel={ch}
                vm={vm}
                expanded={expandedChannel === ch.id}
                onToggle={() =>
                  setExpandedChannel(expandedChannel === ch.id ? null : ch.id)
                }
                togglingAgdp={togglingAgdp}
                agdpConfirm={agdpConfirm}
                setAgdpConfirm={setAgdpConfirm}
                handleToggleAgdp={handleToggleAgdp}
              />
            ))}
          </div>
        </div>
      ))}
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
  const style = STATUS_STYLES[channel.status];

  return (
    <div
      className="glass rounded-xl overflow-hidden"
      style={{ border: "1px solid var(--border)" }}
    >
      {/* Header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-5 cursor-pointer text-left"
      >
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background: channel.status === "active"
                ? "rgba(34,197,94,0.08)"
                : "rgba(0,0,0,0.04)",
              border: channel.status === "active"
                ? "1px solid rgba(34,197,94,0.15)"
                : "1px solid var(--border)",
            }}
          >
            <Icon
              className="w-5 h-5"
              style={{
                color: channel.status === "active" ? "rgb(34,197,94)" : "var(--muted)",
              }}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="text-sm font-semibold">{channel.name}</h3>
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0"
                style={{
                  background: style.bg,
                  color: style.color,
                  border: style.border,
                }}
              >
                {style.label}
              </span>
            </div>
            <p className="text-xs truncate" style={{ color: "var(--muted)" }}>
              {channel.description}
            </p>
          </div>
        </div>
        <ChevronDown
          className="w-4 h-4 shrink-0 ml-3 transition-transform"
          style={{
            color: "var(--muted)",
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
          }}
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
                {channel.id === "ecommerce" && <EcommerceSection />}
                {channel.id === "freelance" && <FreelanceSection />}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Clawlancer Section ──────────────────────────────

function ClawlancerSection() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full" style={{ background: "var(--success)" }} />
        <span className="text-sm font-medium">Always Active</span>
      </div>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Clawlancer is your primary marketplace. Your agent automatically polls for bounties,
        claims work it can handle, delivers results, and gets paid. No configuration needed.
      </p>
      <div className="grid gap-2 text-xs" style={{ color: "var(--muted)" }}>
        <div className="flex justify-between">
          <span>Priority</span>
          <span className="font-semibold" style={{ color: "var(--foreground)" }}>Primary (always first)</span>
        </div>
        <div className="flex justify-between">
          <span>Mode</span>
          <span>Fully autonomous</span>
        </div>
        <div className="flex justify-between">
          <span>Setup</span>
          <span>None required</span>
        </div>
      </div>
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
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">
            {enabled ? "Virtuals Protocol is enabled" : "Enable Virtuals Protocol"}
          </p>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            {enabled
              ? "Your bot accepts jobs from the Virtuals marketplace as a secondary income source."
              : "Connect to earn from AI jobs on the Virtuals Protocol marketplace."}
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
          {enabled ? "Disabling" : "Enabling"} Virtuals Protocol...
        </div>
      )}

      {/* Confirmation dialog */}
      {agdpConfirm && (
        <div
          className="rounded-2xl p-5"
          style={{
            background: "linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
            border: agdpConfirm === "enable"
              ? "1px solid rgba(249,115,22,0.2)"
              : "1px solid rgba(239,68,68,0.2)",
          }}
        >
          <p className="text-sm font-medium mb-1">
            {agdpConfirm === "enable" ? "Enable Virtuals Protocol?" : "Disable Virtuals Protocol?"}
          </p>
          <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
            {agdpConfirm === "enable"
              ? "This will install the Virtuals Protocol Agent Commerce skill on your VM. After enabling, message your bot to complete authentication."
              : "This will remove the Agent Commerce skill. Your agent will no longer accept Virtuals jobs."}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setAgdpConfirm(null)}
              className="px-4 py-2 rounded-full text-xs font-medium transition-all active:scale-95 cursor-pointer"
              style={{
                background: "rgba(0,0,0,0.06)",
                color: "var(--foreground)",
              }}
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
              {agdpConfirm === "enable" ? "Enable" : "Disable"}
            </button>
          </div>
        </div>
      )}

      {enabled && !togglingAgdp && !agdpConfirm && (
        <>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Clawlancer bounties are prioritized first. Virtuals jobs are only picked up when no Clawlancer work is available.
          </p>
          {vm?.telegramBotUsername && (
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              If you haven&apos;t completed Virtuals authentication yet, message your bot:
              <strong style={{ color: "var(--foreground)" }}> &quot;Set up Virtuals marketplace&quot;</strong>
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── E-Commerce Section ──────────────────────────────

function EcommerceSection() {
  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Connect your Shopify, Amazon, or eBay stores. Your agent will manage inventory sync,
        process orders, handle returns, monitor competitor pricing, and generate daily sales reports.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { name: "Shopify", desc: "Store management, orders, inventory" },
          { name: "Amazon", desc: "Seller Central, FBA, listing optimization" },
          { name: "eBay", desc: "Listings, orders, messaging" },
        ].map((platform) => (
          <div
            key={platform.name}
            className="rounded-lg p-4"
            style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
          >
            <p className="text-sm font-semibold mb-1">{platform.name}</p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>{platform.desc}</p>
            <span
              className="inline-block mt-2 text-[10px] px-2 py-0.5 rounded-full"
              style={{
                background: "rgba(249,115,22,0.1)",
                color: "#ea580c",
                border: "1px solid rgba(249,115,22,0.2)",
              }}
            >
              BYOK — Provide your credentials
            </span>
          </div>
        ))}
      </div>

      <div
        className="rounded-lg p-4"
        style={{
          background: "rgba(59,130,246,0.05)",
          border: "1px solid rgba(59,130,246,0.15)",
        }}
      >
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          <strong style={{ color: "var(--foreground)" }}>To get started:</strong> Message your
          agent with your platform credentials. For example:
        </p>
        <p className="text-xs mt-1 font-mono" style={{ color: "var(--muted)" }}>
          &quot;Set up my Shopify store. My store URL is mystore.myshopify.com and my API key is...&quot;
        </p>
      </div>
    </div>
  );
}

// ── Freelance & Digital Products Section ─────────────

function FreelanceSection() {
  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Your agent can create digital products, service listings, and proposals on freelance
        platforms. You review and approve — the agent does the work.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {[
          { name: "Contra", desc: "Freelance services & project proposals", mode: "Semi-autonomous" },
          { name: "Gumroad", desc: "Digital products, templates, guides", mode: "Semi-autonomous" },
          { name: "Fiverr", desc: "Service gigs and deliverables", mode: "Semi-autonomous" },
          { name: "Upwork", desc: "Freelance proposals and project bids", mode: "Semi-autonomous" },
        ].map((platform) => (
          <div
            key={platform.name}
            className="rounded-lg p-4"
            style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
          >
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-semibold">{platform.name}</p>
              <span className="text-[10px]" style={{ color: "var(--muted)" }}>{platform.mode}</span>
            </div>
            <p className="text-xs" style={{ color: "var(--muted)" }}>{platform.desc}</p>
          </div>
        ))}
      </div>

      <div
        className="rounded-lg p-4"
        style={{
          background: "rgba(59,130,246,0.05)",
          border: "1px solid rgba(59,130,246,0.15)",
        }}
      >
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          <strong style={{ color: "var(--foreground)" }}>How it works:</strong> Tell your agent
          what products or services you want to offer. It creates the listings using browser automation.
          You approve before anything goes live.
        </p>
      </div>
    </div>
  );
}
