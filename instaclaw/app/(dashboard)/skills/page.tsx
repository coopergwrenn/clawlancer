"use client";

import { useState, useEffect, useCallback } from "react";
import { RotateCw, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useSearchParams } from "next/navigation";

// ── Types ────────────────────────────────────────────

interface Skill {
  slug: string;
  name: string;
  description: string;
  longDescription: string | null;
  icon: string;
  category: string;
  itemType: string;
  authType: string | null;
  requiresRestart: boolean;
  requiresApiKey: boolean;
  tierMinimum: string;
  sortOrder: number;
  status: string;
  enabled: boolean;
  connected: boolean;
  connectedAccount: string | null;
}

type Tab = "skills" | "integrations" | "marketplace";

const TABS: { id: Tab; label: string }[] = [
  { id: "skills", label: "My Skills" },
  { id: "integrations", label: "Integrations" },
  { id: "marketplace", label: "Marketplace" },
];

const CATEGORIES = [
  "all",
  "creative",
  "productivity",
  "commerce",
  "social",
  "developer",
  "communication",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  all: "All",
  creative: "Creative",
  productivity: "Productivity",
  commerce: "Commerce",
  social: "Social",
  developer: "Developer",
  communication: "Communication",
};

// ── Main Page ────────────────────────────────────────

export default function SkillsPage() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>("skills");
  const [activeCategory, setActiveCategory] = useState("all");
  const [skills, setSkills] = useState<Record<string, Skill[]>>({});
  const [loading, setLoading] = useState(true);
  const [togglingSlug, setTogglingSlug] = useState<string | null>(null);
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
  const [disconnectingSlug, setDisconnectingSlug] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  // Shopify connect modal
  const [shopifyModal, setShopifyModal] = useState(false);
  const [shopifyDomain, setShopifyDomain] = useState("");
  const [shopifyToken, setShopifyToken] = useState("");

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 3000);
    },
    []
  );

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch("/api/skills");
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills || {});
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  // Handle OAuth callback redirect params
  useEffect(() => {
    const connected = searchParams.get("connected");
    const connectError = searchParams.get("connect_error");
    if (connected) {
      showToast(`${connected} connected successfully`, "success");
      setActiveTab("integrations");
      fetchSkills();
      // Clean URL
      window.history.replaceState({}, "", "/skills");
    } else if (connectError) {
      const messages: Record<string, string> = {
        csrf: "Security check failed — please try again",
        denied: "Authorization was denied",
        token_exchange: "Failed to exchange authorization code",
        no_token: "No access token received",
        deploy_failed: "Failed to deploy credentials to your agent",
        no_vm: "No agent VM found",
        callback_failed: "Connection failed — please try again",
        invalid_state: "Invalid callback state — please try again",
        unsupported: "This integration is not supported yet",
      };
      showToast(messages[connectError] || "Connection failed", "error");
      setActiveTab("integrations");
      window.history.replaceState({}, "", "/skills");
    }
  }, [searchParams, showToast, fetchSkills]);

  // ── Handlers ──

  async function handleToggle(skill: Skill) {
    if (togglingSlug) return;
    setTogglingSlug(skill.slug);
    try {
      const res = await fetch("/api/skills/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillSlug: skill.slug,
          enabled: !skill.enabled,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const verb = !skill.enabled ? "enabled" : "disabled";
        const suffix = data.restarted ? " — agent restarting" : "";
        showToast(`${skill.name} ${verb}${suffix}`, "success");
        fetchSkills();
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Failed to toggle skill", "error");
      }
    } catch {
      showToast("Network error", "error");
    } finally {
      setTogglingSlug(null);
    }
  }

  async function handleConnect(skill: Skill) {
    if (connectingSlug) return;

    // Shopify uses API key flow — show modal
    if (skill.slug === "shopify") {
      setShopifyModal(true);
      return;
    }

    setConnectingSlug(skill.slug);
    try {
      const res = await fetch("/api/skills/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationSlug: skill.slug }),
      });
      const data = await res.json();

      if (data.authUrl) {
        // OAuth flow — open in same window (redirect-based)
        window.location.href = data.authUrl;
        return;
      }
      if (data.comingSoon) {
        showToast(data.error || "Coming soon", "error");
      } else if (data.error) {
        showToast(data.error, "error");
      }
    } catch {
      showToast("Network error", "error");
    } finally {
      setConnectingSlug(null);
    }
  }

  async function handleShopifyConnect() {
    if (!shopifyDomain.trim() || !shopifyToken.trim()) return;
    setConnectingSlug("shopify");
    try {
      const res = await fetch("/api/skills/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationSlug: "shopify",
          apiKey: shopifyToken.trim(),
          shopDomain: shopifyDomain.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("Shopify connected", "success");
        setShopifyModal(false);
        setShopifyDomain("");
        setShopifyToken("");
        fetchSkills();
      } else {
        showToast(data.error || "Failed to connect Shopify", "error");
      }
    } catch {
      showToast("Network error", "error");
    } finally {
      setConnectingSlug(null);
    }
  }

  async function handleDisconnect(skill: Skill) {
    if (disconnectingSlug) return;
    setDisconnectingSlug(skill.slug);
    try {
      const res = await fetch("/api/skills/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationSlug: skill.slug }),
      });
      if (res.ok) {
        showToast(`${skill.name} disconnected`, "success");
        fetchSkills();
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Failed to disconnect", "error");
      }
    } catch {
      showToast("Network error", "error");
    } finally {
      setDisconnectingSlug(null);
    }
  }

  // ── Filtered skills ──

  const allSkills = Object.values(skills).flat();
  const skillItems = allSkills.filter(
    (s) => s.itemType !== "integration"
  );
  const integrationItems = allSkills.filter(
    (s) => s.itemType === "integration"
  );

  function filterByCategory(items: Skill[]) {
    if (activeCategory === "all") return items;
    return items.filter((s) => s.category === activeCategory);
  }

  const filteredSkills = filterByCategory(skillItems);
  const filteredIntegrations = filterByCategory(integrationItems);

  // ── Render ──

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      {/* Page header */}
      <div>
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Skills & Integrations
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Manage your agent&apos;s capabilities and connected services.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ background: "rgba(0,0,0,0.04)" }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="relative flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer"
            style={{
              color:
                activeTab === tab.id ? "var(--foreground)" : "var(--muted)",
            }}
          >
            {activeTab === tab.id && (
              <motion.div
                layoutId="skills-tab-pill"
                className="absolute inset-0 rounded-lg"
                style={{
                  background: "var(--card)",
                  boxShadow:
                    "0 0 0 1px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
                }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative z-10">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Category filter pills */}
      {activeTab !== "marketplace" && (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
          {CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className="px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all cursor-pointer shrink-0"
                style={
                  isActive
                    ? {
                        background:
                          "linear-gradient(135deg, rgba(22,22,22,0.85), rgba(40,40,40,0.9))",
                        color: "#fff",
                        boxShadow:
                          "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15)",
                      }
                    : {
                        background: "rgba(0,0,0,0.04)",
                        color: "var(--muted)",
                        boxShadow: "0 0 0 1px rgba(0,0,0,0.06)",
                      }
                }
              >
                {CATEGORY_LABELS[cat]}
              </button>
            );
          })}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="glass rounded-xl p-12 text-center">
          <Loader2
            className="w-5 h-5 animate-spin mx-auto mb-2"
            style={{ color: "var(--muted)" }}
          />
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Loading skills...
          </p>
        </div>
      )}

      {/* ── My Skills tab ── */}
      {!loading && activeTab === "skills" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AnimatePresence mode="popLayout">
            {filteredSkills.map((skill, i) => (
              <motion.div
                key={skill.slug}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ delay: i * 0.04, duration: 0.25 }}
              >
                <SkillCard
                  skill={skill}
                  toggling={togglingSlug === skill.slug}
                  onToggle={() => handleToggle(skill)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {filteredSkills.length === 0 && (
            <div
              className="col-span-full glass rounded-xl p-8 text-center"
              style={{ border: "1px solid var(--border)" }}
            >
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No skills in this category.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Integrations tab ── */}
      {!loading && activeTab === "integrations" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AnimatePresence mode="popLayout">
            {filteredIntegrations.map((skill, i) => (
              <motion.div
                key={skill.slug}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ delay: i * 0.04, duration: 0.25 }}
              >
                <IntegrationCard
                  skill={skill}
                  connecting={connectingSlug === skill.slug}
                  disconnecting={disconnectingSlug === skill.slug}
                  onConnect={() => handleConnect(skill)}
                  onDisconnect={() => handleDisconnect(skill)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {filteredIntegrations.length === 0 && (
            <div
              className="col-span-full glass rounded-xl p-8 text-center"
              style={{ border: "1px solid var(--border)" }}
            >
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No integrations in this category.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Marketplace tab (Coming Soon shell) ── */}
      {!loading && activeTab === "marketplace" && (
        <div className="space-y-6">
          <div
            className="glass rounded-xl p-12 text-center"
            style={{ border: "1px solid var(--border)" }}
          >
            <p
              className="text-2xl font-normal tracking-[-0.5px] mb-2"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Skill Marketplace
            </p>
            <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
              A marketplace where InstaClaw users can discover, share, and
              install community-created skills.
            </p>
            <span
              className="inline-block px-4 py-1.5 rounded-full text-xs font-semibold"
              style={{
                background:
                  "linear-gradient(135deg, rgba(59,130,246,0.15), rgba(37,99,235,0.1))",
                color: "rgb(59,130,246)",
                boxShadow:
                  "0 0 0 1px rgba(59,130,246,0.2), inset 0 1px 0 rgba(255,255,255,0.1)",
              }}
            >
              Coming Soon
            </span>
          </div>
        </div>
      )}

      {/* ── Shopify API key modal ── */}
      <AnimatePresence>
        {shopifyModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setShopifyModal(false);
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              className="glass rounded-2xl p-6 w-full max-w-md space-y-4"
              style={{
                border: "1px solid var(--border)",
                background: "var(--card)",
                boxShadow: "0 16px 64px rgba(0,0,0,0.2)",
              }}
            >
              <div>
                <h3
                  className="text-lg font-normal tracking-[-0.3px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  Connect Shopify
                </h3>
                <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                  Enter your Shopify store domain and Admin API access token.
                </p>
              </div>
              <div className="space-y-3">
                <div>
                  <label
                    className="text-xs font-medium block mb-1"
                    style={{ color: "var(--muted)" }}
                  >
                    Shop domain
                  </label>
                  <input
                    type="text"
                    value={shopifyDomain}
                    onChange={(e) => setShopifyDomain(e.target.value)}
                    placeholder="yourstore.myshopify.com"
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                    style={{
                      background: "rgba(0,0,0,0.04)",
                      border: "1px solid var(--border)",
                      color: "var(--foreground)",
                    }}
                  />
                </div>
                <div>
                  <label
                    className="text-xs font-medium block mb-1"
                    style={{ color: "var(--muted)" }}
                  >
                    Admin API access token
                  </label>
                  <input
                    type="password"
                    value={shopifyToken}
                    onChange={(e) => setShopifyToken(e.target.value)}
                    placeholder="shpat_..."
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                    style={{
                      background: "rgba(0,0,0,0.04)",
                      border: "1px solid var(--border)",
                      color: "var(--foreground)",
                    }}
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setShopifyModal(false)}
                  className="px-4 py-2 rounded-full text-xs font-medium transition-all active:scale-95 cursor-pointer"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(255,255,255,0.92), rgba(240,240,240,0.88))",
                    color: "#000",
                    boxShadow:
                      "0 0 0 1px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.6)",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleShopifyConnect}
                  disabled={
                    !shopifyDomain.trim() ||
                    !shopifyToken.trim() ||
                    connectingSlug === "shopify"
                  }
                  className="px-4 py-2 rounded-full text-xs font-semibold transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(22,22,22,0.85), rgba(40,40,40,0.95))",
                    color: "#fff",
                    boxShadow:
                      "0 0 0 1px rgba(255,255,255,0.1), 0 2px 8px rgba(0,0,0,0.2)",
                  }}
                >
                  {connectingSlug === "shopify" ? (
                    <span className="flex items-center gap-1.5">
                      <RotateCw className="w-3 h-3 animate-spin" />
                      Connecting...
                    </span>
                  ) : (
                    "Connect"
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Toast notification ── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl text-sm font-medium"
            style={{
              background:
                toast.type === "success"
                  ? "linear-gradient(135deg, rgba(22,22,22,0.92), rgba(40,40,40,0.95))"
                  : "linear-gradient(135deg, rgba(239,68,68,0.9), rgba(220,38,38,0.95))",
              color: "#fff",
              boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
              backdropFilter: "blur(12px)",
            }}
          >
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── SkillCard ────────────────────────────────────────

function SkillCard({
  skill,
  toggling,
  onToggle,
}: {
  skill: Skill;
  toggling: boolean;
  onToggle: () => void;
}) {
  const isBuiltIn = skill.itemType === "built_in";

  return (
    <div
      className="glass rounded-xl p-5"
      style={{ border: "1px solid var(--border)" }}
    >
      <div className="flex items-start gap-3.5">
        {/* Icon */}
        <span className="text-2xl shrink-0 mt-0.5">{skill.icon}</span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-sm font-medium truncate">{skill.name}</h3>
            {isBuiltIn && (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(34,197,94,0.25), rgba(22,163,74,0.18))",
                  color: "rgb(34,197,94)",
                  boxShadow:
                    "0 0 0 1px rgba(34,197,94,0.25), inset 0 1px 0 rgba(255,255,255,0.15)",
                }}
              >
                Always On
              </span>
            )}
            {skill.itemType === "mcp_server" && (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0"
                style={{
                  background: "rgba(59,130,246,0.1)",
                  color: "rgb(59,130,246)",
                  boxShadow: "0 0 0 1px rgba(59,130,246,0.2)",
                }}
              >
                MCP
              </span>
            )}
          </div>
          <p
            className="text-xs leading-relaxed"
            style={{ color: "var(--muted)" }}
          >
            {skill.description}
          </p>
          {skill.requiresRestart && !isBuiltIn && (
            <p
              className="text-[10px] mt-1.5"
              style={{ color: "var(--muted)", opacity: 0.7 }}
            >
              Requires restart
            </p>
          )}
        </div>

        {/* Toggle */}
        {isBuiltIn ? (
          <div
            className="relative w-12 h-7 rounded-full shrink-0"
            style={{
              background:
                "linear-gradient(135deg, rgba(22,22,22,0.7), rgba(40,40,40,0.8))",
              boxShadow:
                "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.05)",
              opacity: 0.6,
            }}
          >
            <span
              className="absolute top-1 w-5 h-5 rounded-full"
              style={{
                left: "24px",
                background:
                  "linear-gradient(135deg, rgba(255,255,255,0.95), rgba(240,240,240,0.9))",
                boxShadow:
                  "0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.5)",
              }}
            />
          </div>
        ) : (
          <button
            onClick={onToggle}
            disabled={toggling}
            className="relative w-12 h-7 rounded-full transition-all shrink-0 cursor-pointer disabled:opacity-50"
            style={{
              background: skill.enabled
                ? "linear-gradient(135deg, rgba(22,22,22,0.7), rgba(40,40,40,0.8))"
                : "rgba(0,0,0,0.08)",
              boxShadow: skill.enabled
                ? "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.05)"
                : "0 0 0 1px rgba(0,0,0,0.08), inset 0 1px 2px rgba(0,0,0,0.06)",
            }}
            aria-label={
              skill.enabled
                ? `Disable ${skill.name}`
                : `Enable ${skill.name}`
            }
          >
            {toggling ? (
              <RotateCw
                className="w-3 h-3 animate-spin absolute top-2 left-1/2 -translate-x-1/2"
                style={{ color: skill.enabled ? "#fff" : "var(--muted)" }}
              />
            ) : (
              <span
                className="absolute top-1 w-5 h-5 rounded-full transition-all"
                style={{
                  left: skill.enabled ? "24px" : "4px",
                  background: skill.enabled
                    ? "linear-gradient(135deg, rgba(255,255,255,0.95), rgba(240,240,240,0.9))"
                    : "linear-gradient(135deg, rgba(255,255,255,0.85), rgba(230,230,230,0.8))",
                  boxShadow:
                    "0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.5)",
                  transition: "left 0.25s cubic-bezier(0.23, 1, 0.32, 1)",
                }}
              />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// ── IntegrationCard ──────────────────────────────────

function IntegrationCard({
  skill,
  connecting,
  disconnecting,
  onConnect,
  onDisconnect,
}: {
  skill: Skill;
  connecting: boolean;
  disconnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const isComingSoon = skill.status === "coming_soon";
  const isConnected = skill.connected;
  const isBusy = connecting || disconnecting;

  return (
    <div
      className="glass rounded-xl p-5"
      style={{
        border: "1px solid var(--border)",
        opacity: isComingSoon ? 0.65 : 1,
      }}
    >
      <div className="flex items-start gap-3.5">
        {/* Icon */}
        <span className="text-2xl shrink-0 mt-0.5">{skill.icon}</span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-sm font-medium truncate">{skill.name}</h3>
            {isConnected && (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(34,197,94,0.25), rgba(22,163,74,0.18))",
                  color: "rgb(34,197,94)",
                  boxShadow:
                    "0 0 0 1px rgba(34,197,94,0.25), inset 0 1px 0 rgba(255,255,255,0.15)",
                }}
              >
                Connected
              </span>
            )}
            {isComingSoon && (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(59,130,246,0.15), rgba(37,99,235,0.1))",
                  color: "rgb(59,130,246)",
                  boxShadow:
                    "0 0 0 1px rgba(59,130,246,0.2), inset 0 1px 0 rgba(255,255,255,0.1)",
                }}
              >
                Coming Soon
              </span>
            )}
          </div>
          <p
            className="text-xs leading-relaxed"
            style={{ color: "var(--muted)" }}
          >
            {skill.description}
          </p>
          {isConnected && skill.connectedAccount && (
            <p
              className="text-[10px] mt-1.5 truncate"
              style={{ color: "var(--muted)", opacity: 0.7 }}
            >
              {skill.connectedAccount}
            </p>
          )}
        </div>

        {/* Action button */}
        <div className="shrink-0">
          {isComingSoon ? (
            <div className="w-[88px]" /> /* spacer */
          ) : isConnected ? (
            <button
              onClick={onDisconnect}
              disabled={isBusy}
              className="px-3.5 py-1.5 rounded-full text-[11px] font-medium transition-all active:scale-95 cursor-pointer disabled:opacity-50"
              style={{
                background: "rgba(0,0,0,0.04)",
                color: "var(--muted)",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.08)",
              }}
            >
              {disconnecting ? (
                <span className="flex items-center gap-1">
                  <RotateCw className="w-3 h-3 animate-spin" />
                  ...
                </span>
              ) : (
                "Disconnect"
              )}
            </button>
          ) : (
            <button
              onClick={onConnect}
              disabled={isBusy}
              className="px-3.5 py-1.5 rounded-full text-[11px] font-semibold transition-all active:scale-95 cursor-pointer disabled:opacity-50"
              style={{
                background:
                  "linear-gradient(135deg, rgba(22,22,22,0.85), rgba(40,40,40,0.95))",
                color: "#fff",
                boxShadow:
                  "0 0 0 1px rgba(255,255,255,0.1), 0 2px 6px rgba(0,0,0,0.15)",
              }}
            >
              {connecting ? (
                <span className="flex items-center gap-1">
                  <RotateCw className="w-3 h-3 animate-spin" />
                  ...
                </span>
              ) : (
                "Connect"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
