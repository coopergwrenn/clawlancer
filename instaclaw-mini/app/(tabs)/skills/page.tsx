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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 pb-0">
        <h1 className="mb-1 text-xl font-bold tracking-tight">Skills</h1>
        <p className="mb-4 text-xs text-muted">Capabilities your agent has access to</p>

        {/* Tabs */}
        <div className="flex gap-1 mb-3 rounded-xl p-1" style={{ background: "rgba(255,255,255,0.04)" }}>
          {(["skills", "integrations"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex-1 rounded-lg py-2 text-[12px] font-semibold transition-all"
              style={{
                background: tab === t ? "rgba(255,255,255,0.08)" : "transparent",
                color: tab === t ? "#fff" : "#888",
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
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {loading ? (
          <div className="flex flex-col items-center gap-3 py-16">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "rgba(220,103,67,0.3)", borderTopColor: "transparent" }} />
            <p className="text-xs text-muted">Loading skills...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.03]">
              <Sparkles size={24} className="text-muted" />
            </div>
            <p className="max-w-[220px] text-sm leading-relaxed text-muted">
              {skills.length === 0
                ? "No skills configured yet. Your agent will get skills after deployment completes."
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
              const canToggle = !isBuiltIn && !isIntegration && !isComingSoon;

              return (
                <div
                  key={skill.slug}
                  className="animate-fade-in-up glass-card rounded-xl px-4 py-3.5"
                  style={{ opacity: 0, animationDelay: `${i * 0.03}s` }}
                >
                  <div className="flex items-center gap-3">
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

                    {/* Name + description */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{skill.name}</span>
                        {isBuiltIn && (
                          <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(99,102,241,0.1)", color: "#818cf8" }}>
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

                    {/* Toggle / Status */}
                    {canToggle ? (
                      <button
                        onClick={() => handleToggle(skill.slug, skill.enabled)}
                        disabled={toggling === skill.slug}
                        className="shrink-0 relative w-10 h-6 rounded-full transition-all"
                        style={{
                          background: skill.enabled
                            ? "linear-gradient(180deg, rgba(220,103,67,0.8), rgba(200,85,52,0.9))"
                            : "rgba(255,255,255,0.08)",
                          opacity: toggling === skill.slug ? 0.5 : 1,
                        }}
                      >
                        <div
                          className="absolute top-0.5 h-5 w-5 rounded-full transition-all duration-200"
                          style={{
                            left: skill.enabled ? "calc(100% - 22px)" : "2px",
                            background: "#fff",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                          }}
                        />
                      </button>
                    ) : isIntegration ? (
                      <span
                        className="shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold"
                        style={{
                          borderColor: skill.connected ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.1)",
                          color: skill.connected ? "#22c55e" : "#666",
                        }}
                      >
                        {skill.connected ? "Connected" : "Not connected"}
                      </span>
                    ) : null}
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
