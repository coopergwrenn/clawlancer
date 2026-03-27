"use client";

import { useState, useEffect } from "react";
import {
  Sparkles,
  Globe,
  Search,
  Mail,
  Code,
  Mic,
  Video,
  ShoppingCart,
  TrendingUp,
  Palette,
  FolderOpen,
  Briefcase,
  Film,
  Crosshair,
  AtSign,
  RotateCw,
} from "lucide-react";

// ── Types ──

interface Skill {
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  itemType: string;
  status: string;
  enabled: boolean;
  connected: boolean;
}

type Category = "all" | "creative" | "productivity" | "commerce" | "social" | "developer" | "communication" | "earn";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "all", label: "All" },
  { id: "creative", label: "Creative" },
  { id: "productivity", label: "Productivity" },
  { id: "commerce", label: "Commerce" },
  { id: "social", label: "Social" },
  { id: "developer", label: "Developer" },
  { id: "communication", label: "Communication" },
  { id: "earn", label: "Earn" },
];

const EARN_SLUGS = new Set([
  "clawlancer", "virtuals-agdp", "prediction-markets", "freelance-digital", "solana-defi",
]);

// Map skill slugs/categories to icons
function getSkillIcon(slug: string, category: string) {
  const iconMap: Record<string, typeof Sparkles> = {
    "web-search": Search,
    "web-browsing": Globe,
    "email-outreach": Mail,
    "code-execution": Code,
    "voice-audio-production": Mic,
    "sjinn-video": Video,
    "higgsfield-video": Video,
    "ecommerce-marketplace": ShoppingCart,
    "financial-analysis": TrendingUp,
    "brand-design": Palette,
    "file-management": FolderOpen,
    "freelance-digital": Briefcase,
    "motion-graphics": Film,
    "competitive-intelligence": Crosshair,
    "social-media-content": AtSign,
    "prediction-markets": TrendingUp,
  };
  return iconMap[slug] || Sparkles;
}

function getSkillColor(slug: string, category: string, enabled: boolean): string {
  if (!enabled) return "rgba(255,255,255,0.04)";
  const colorMap: Record<string, string> = {
    creative: "rgba(224,107,158,0.15)",
    productivity: "rgba(43,181,160,0.15)",
    commerce: "rgba(74,144,217,0.15)",
    social: "rgba(224,107,158,0.15)",
    developer: "rgba(76,175,125,0.15)",
    communication: "rgba(99,102,241,0.15)",
  };
  if (EARN_SLUGS.has(slug)) return "rgba(245,158,11,0.15)";
  return colorMap[category] || "rgba(220,103,67,0.12)";
}

// ── Component ──

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<Category>("all");
  const [toggling, setToggling] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState<"skills" | "integrations">("skills");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/proxy/skills");
        if (res.ok) {
          const data = await res.json();
          // The API returns { skills: { category1: [...], category2: [...] } }
          const flat: Skill[] = [];
          const grouped = data?.skills || data;
          if (grouped && typeof grouped === "object") {
            for (const cat of Object.values(grouped)) {
              if (Array.isArray(cat)) flat.push(...(cat as Skill[]));
            }
          }
          setSkills(flat);
        }
      } catch (err) {
        console.error("[Skills] Fetch error:", err);
      }
      setLoading(false);
    }
    load();
  }, []);

  async function handleToggle(slug: string, currentEnabled: boolean) {
    setToggling(slug);
    try {
      const res = await fetch("/api/proxy/skills/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillSlug: slug, enabled: !currentEnabled }),
      });
      if (res.ok) {
        setSkills((prev) =>
          prev.map((s) => (s.slug === slug ? { ...s, enabled: !currentEnabled } : s))
        );
      }
    } catch {}
    setToggling(null);
  }

  // Filter by tab and category
  const tabFiltered = skills.filter((s) =>
    tab === "integrations" ? s.itemType === "integration" : s.itemType !== "integration"
  );

  const filtered = tabFiltered.filter((s) => {
    if (activeCategory === "all") return true;
    if (activeCategory === "earn") return EARN_SLUGS.has(s.slug);
    return s.category === activeCategory;
  });

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="p-4 pb-0">
        <h1 className="mb-1 text-xl font-bold tracking-tight">Skills</h1>
        <p className="mb-4 text-xs text-muted">Capabilities your agent has access to</p>

        {/* Tabs — glass pill with sliding indicator */}
        <div
          className="relative flex mb-3 rounded-2xl p-1"
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            boxShadow: "inset 0 1px 3px rgba(0,0,0,0.15), 0 1px 0 rgba(255,255,255,0.02)",
          }}
        >
          {/* Sliding glass pill */}
          <div
            className="absolute top-1 bottom-1 rounded-xl"
            style={{
              width: "calc(50% - 4px)",
              left: tab === "skills" ? "4px" : "calc(50% + 0px)",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.1)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.06)",
              backdropFilter: "blur(12px)",
              transition: "left 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          />
          {(["skills", "integrations"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="relative z-10 flex-1 rounded-xl py-2.5 text-[12px] font-semibold"
              style={{
                color: tab === t ? "#fff" : "#666",
                transition: "color 0.3s ease",
              }}
            >
              {t === "skills" ? "My Skills" : "Integrations"}
            </button>
          ))}
        </div>

        {/* Category pills */}
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-3">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium transition-all"
              style={{
                background: activeCategory === cat.id ? "rgba(220,103,67,0.15)" : "rgba(255,255,255,0.04)",
                border: activeCategory === cat.id ? "1px solid rgba(220,103,67,0.3)" : "1px solid rgba(255,255,255,0.06)",
                color: activeCategory === cat.id ? "#DC6743" : "#888",
              }}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Skills list */}
      <div className="flex-1 flex flex-col overflow-y-auto px-4 pb-6" style={{ minHeight: 0 }}>
        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3" style={{ minHeight: "50vh" }}>
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "rgba(220,103,67,0.3)", borderTopColor: "transparent" }} />
            <p className="text-xs text-muted">Loading skills...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center" style={{ minHeight: "50vh" }}>
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.03]">
              <Sparkles size={24} className="text-muted" />
            </div>
            <p className="max-w-[220px] text-sm leading-relaxed text-muted">
              {skills.length === 0
                ? "No skills configured yet. Your agent will get skills after deployment completes."
                : tab === "integrations"
                  ? "No integrations in this category."
                  : "No skills in this category."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((skill, i) => {
              const Icon = getSkillIcon(skill.slug, skill.category);
              const isBuiltIn = skill.itemType === "built_in";
              const isIntegration = skill.itemType === "integration";
              const isComingSoon = skill.status === "coming_soon";
              // All integrations that aren't connected are "coming soon" for launch
              const isIntegrationComingSoon = isIntegration && !skill.connected;
              const isDimmed = isComingSoon || isIntegrationComingSoon;
              const canToggle = !isBuiltIn && !isIntegration && !isComingSoon;
              const isExpanded = expanded === skill.slug;
              const isToggling = toggling === skill.slug;

              return (
                <div
                  key={skill.slug}
                  className="animate-fade-in-up glass-card rounded-xl overflow-hidden"
                  style={{ opacity: 0, animationDelay: `${i * 0.03}s` }}
                >
                  {/* Main row — tappable to expand (disabled for coming soon) */}
                  <div
                    className="flex items-center gap-3 px-4 py-3.5 transition-colors"
                    style={isDimmed ? { opacity: 0.4, cursor: "default" } : { cursor: "pointer" }}
                    onClick={isDimmed ? undefined : () => setExpanded(isExpanded ? null : skill.slug)}
                  >
                    {/* Icon */}
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: getSkillColor(skill.slug, skill.category, skill.enabled),
                        boxShadow: skill.enabled
                          ? "inset 0 1px 2px rgba(255,255,255,0.1)"
                          : "none",
                      }}
                    >
                      <Icon size={16} style={{ color: skill.enabled ? "#ddd" : "#666" }} />
                    </div>

                    {/* Name + truncated description */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{skill.name}</span>
                        {isBuiltIn && (
                          <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold" style={{ background: "linear-gradient(135deg, rgba(34,197,94,0.2), rgba(22,163,74,0.15))", color: "#22c55e", boxShadow: "0 0 0 1px rgba(34,197,94,0.2)" }}>
                            Always On
                          </span>
                        )}
                        {isComingSoon && (
                          <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(255,255,255,0.04)", color: "#666" }}>
                            Soon
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted truncate">{skill.description}</p>
                    </div>

                    {/* Toggle */}
                    {canToggle ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggle(skill.slug, skill.enabled); }}
                        disabled={isToggling}
                        className="shrink-0 relative w-12 h-7 rounded-full cursor-pointer disabled:cursor-wait"
                        style={{
                          background: skill.enabled
                            ? "linear-gradient(135deg, #22c55e, #16a34a)"
                            : "rgba(255,255,255,0.06)",
                          boxShadow: skill.enabled
                            ? "0 0 0 1px rgba(34,197,94,0.2), 0 2px 8px rgba(22,163,74,0.3), inset 0 1px 1px rgba(255,255,255,0.2)"
                            : "0 0 0 1px rgba(255,255,255,0.06), inset 0 2px 4px rgba(0,0,0,0.15)",
                          backdropFilter: "blur(8px)",
                          transition: "background 0.3s, box-shadow 0.3s",
                        }}
                      >
                        {isToggling ? (
                          <RotateCw
                            size={12}
                            className="animate-spin absolute top-2 left-1/2 -translate-x-1/2"
                            style={{ color: skill.enabled ? "#fff" : "#888" }}
                          />
                        ) : (
                          <span
                            className="absolute top-1 w-5 h-5 rounded-full"
                            style={{
                              left: skill.enabled ? "24px" : "4px",
                              background: skill.enabled
                                ? "linear-gradient(145deg, rgba(255,255,255,0.98), rgba(245,245,245,0.9))"
                                : "linear-gradient(145deg, rgba(255,255,255,0.85), rgba(220,220,220,0.8))",
                              boxShadow: skill.enabled
                                ? "0 2px 6px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(255,255,255,0.6), inset 0 1px 0 rgba(255,255,255,0.8)"
                                : "0 1px 3px rgba(0,0,0,0.1), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.5)",
                              transition: "left 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)",
                            }}
                          />
                        )}
                      </button>
                    ) : isIntegration ? (
                      <span
                        className="shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold"
                        style={{
                          borderColor: skill.connected ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.08)",
                          color: skill.connected ? "#22c55e" : "#555",
                        }}
                      >
                        {skill.connected ? "Connected" : "Coming Soon"}
                      </span>
                    ) : isBuiltIn ? (
                      <div
                        className="shrink-0 relative w-12 h-7 rounded-full"
                        style={{
                          background: "linear-gradient(135deg, rgba(34,197,94,0.3), rgba(22,163,74,0.2))",
                          boxShadow: "0 0 0 1px rgba(34,197,94,0.15), inset 0 1px 0 rgba(255,255,255,0.05)",
                          opacity: 0.6,
                        }}
                      >
                        <span
                          className="absolute top-1 w-5 h-5 rounded-full"
                          style={{
                            left: "24px",
                            background: "linear-gradient(145deg, rgba(255,255,255,0.9), rgba(240,240,240,0.85))",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.5)",
                          }}
                        />
                      </div>
                    ) : null}
                  </div>

                  {/* Expanded description */}
                  <div
                    style={{
                      maxHeight: isExpanded ? "200px" : "0",
                      opacity: isExpanded ? 1 : 0,
                      overflow: "hidden",
                      transition: "max-height 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease",
                    }}
                  >
                    <div className="px-4 pb-4 pt-0" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                      <p className="text-[12px] leading-relaxed pt-3" style={{ color: "#999" }}>
                        {skill.description}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
