"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { motion } from "motion/react";
import {
  MessageSquare,
  Waves,
  Heart,
  Monitor,
  Puzzle,
  TrendingUp,
  Coins,
  FolderOpen,
  Clock,
  History,
  LayoutDashboard,
  Zap,
  CreditCard,
  Settings,
  Key,
  MapPin,
  Award,
  Sparkles,
  Mail,
  LogOut,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import type { Session } from "next-auth";
import { AgentbookHatBanner } from "@/components/dashboard/agentbook-hat-banner";
import { ChannelNudgeBanner } from "@/components/dashboard/channel-nudge-banner";

/**
 * SidebarShell — the Phase 1 left-sidebar workspace chrome. DESKTOP-ONLY.
 *
 * Only ever mounted at lg+ (the layout gates `navMode === "sidebar" &&
 * isDesktop`). Below lg the dashboard renders the existing top-nav verbatim, so
 * this component is a pure desktop rail — no mobile drawer, no hamburger. The
 * deliberate mobile pass comes later; the prior drawer implementation is in git
 * history (commit c27266aa) if we want it back.
 *
 * Flag-off never mounts this (the layout's top-nav return handles every
 * viewport). All four redirect gates + the heartbeat poll + the gate overlay +
 * the OnboardingWizard live in the layout and are shared across both chromes.
 *
 * IA (per PRD §D3, reconciled against the real origin/main nav incl. /economy):
 *   ⌂ Command Center  — permanent home anchor, NOT collapsible (one-tap home
 *                        always available regardless of any collapse state).
 *   ▾ WORKSPACE       — collapsible: The Floor · Heartbeat · Live View ·
 *                        (hairline) · Skills · Earn · Economy · Files ·
 *                        Scheduled · History
 *   ▾ ACCOUNT & PLAN  — collapsible: Overview · Credits · Billing · Settings ·
 *                        API Keys
 *   PINNED            — Edge City (edge_city only) · Invite & earn · account row
 *
 * Collapse: section headers are toggles (chevron spring-rotates), the body
 * springs open/closed with a subtle item stagger, state persists in
 * localStorage, and the section containing the active route is force-open and
 * non-collapsible so the current page can never be hidden.
 */

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  tourKey: string;
  hero?: boolean; // Command Center — the home anchor
  heartbeat?: boolean; // shows the live health dot
  dividerBefore?: boolean; // subtle in-section hairline above this row
};

// Permanent home anchor — sits above the collapsible sections, always visible.
const HOME: NavItem = {
  href: "/tasks",
  label: "Command Center",
  icon: MessageSquare,
  tourKey: "nav-command-center",
  hero: true,
};

type NavSection = { key: string; label: string; items: NavItem[] };

const SECTIONS: NavSection[] = [
  {
    key: "workspace",
    label: "Workspace",
    items: [
      { href: "/floor", label: "The Floor", icon: Waves, tourKey: "nav-floor" },
      { href: "/heartbeat", label: "Heartbeat", icon: Heart, tourKey: "nav-heartbeat", heartbeat: true },
      { href: "/live", label: "Live View", icon: Monitor, tourKey: "nav-live" },
      { href: "/skills", label: "Skills", icon: Puzzle, tourKey: "nav-skills", dividerBefore: true },
      { href: "/earn", label: "Earn", icon: TrendingUp, tourKey: "nav-earn" },
      { href: "/economy", label: "Economy", icon: Coins, tourKey: "nav-economy" },
      { href: "/files", label: "Files", icon: FolderOpen, tourKey: "nav-files" },
      { href: "/scheduled", label: "Scheduled", icon: Clock, tourKey: "nav-scheduled" },
      { href: "/history", label: "History", icon: History, tourKey: "nav-history" },
    ],
  },
  {
    key: "account",
    label: "Account & Plan",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard, tourKey: "nav-dashboard" },
      { href: "/dashboard/credits", label: "Credits", icon: Zap, tourKey: "nav-credits" },
      { href: "/billing", label: "Billing", icon: CreditCard, tourKey: "nav-billing" },
      { href: "/settings", label: "Settings", icon: Settings, tourKey: "nav-settings" },
      { href: "/env-vars", label: "API Keys", icon: Key, tourKey: "nav-api-keys" },
    ],
  },
];

const CORAL = "#DC6743";
// The rail sits one notch recessed from the cream content (#f8f7f4) so the
// workspace reads with depth, not a flat plane split by a hairline. #f5f3ee is
// an existing InstaClaw tone (the landing/onboarding warm cream).
const SIDEBAR_BG = "#f5f3ee";

/* ─── Collapse state (localStorage-persisted, mirrors useNavMode) ─────────── */

const COLLAPSE_STORAGE_KEY = "instaclaw_sidebar_collapsed";
type CollapseMap = Record<string, boolean>; // sectionKey → collapsed?

function useCollapseState(): {
  collapsed: CollapseMap;
  toggle: (key: string) => void;
} {
  // Default everything EXPANDED on first load (collapsed = {}) so a new user
  // sees the whole map, then collapses to taste. localStorage hydrates in the
  // effect; SSR/first-paint render expanded.
  const [collapsed, setCollapsed] = useState<CollapseMap>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
      if (raw) setCollapsed(JSON.parse(raw) as CollapseMap);
    } catch {
      // localStorage unavailable / malformed — stay expanded.
    }
  }, []);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* best-effort */
      }
      return next;
    });
  }, []);

  return { collapsed, toggle };
}

/* ─── Motion: the iOS-feel section spring ─────────────────────────────────── */
// Lively, slight overshoot, settles fast, no wobble — the satisfying give of an
// iOS Settings section. These are the knobs to tune by feel on the live rail.
const LIST_VARIANTS = {
  open: {
    height: "auto" as const,
    opacity: 1,
    transition: {
      height: { type: "spring" as const, stiffness: 520, damping: 32 },
      opacity: { duration: 0.18 },
      staggerChildren: 0.025,
      delayChildren: 0.04,
    },
  },
  closed: {
    height: 0,
    opacity: 0,
    transition: {
      height: { type: "spring" as const, stiffness: 560, damping: 40 },
      opacity: { duration: 0.12 },
      staggerChildren: 0.015,
      staggerDirection: -1 as const,
    },
  },
};
const ROW_VARIANTS = {
  open: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 600, damping: 30 } },
  closed: { opacity: 0, y: -4, transition: { duration: 0.1 } },
};
const CHEVRON_SPRING = { type: "spring" as const, stiffness: 600, damping: 30 };

/* ─── A single nav row ──────────────────────────────────────────────────── */

function NavRow({
  item,
  active,
  heartbeatHealth,
  pillId,
}: {
  item: NavItem;
  active: boolean;
  heartbeatHealth: "healthy" | "unhealthy" | "paused" | null;
  pillId: string;
}) {
  const Icon = item.icon;
  const showDot =
    item.heartbeat && heartbeatHealth && heartbeatHealth !== "healthy";

  return (
    <Link
      href={item.href}
      data-tour={item.tourKey}
      aria-current={active ? "page" : undefined}
      className="group relative flex items-center gap-3 px-3 h-9 rounded-lg text-sm transition-snappy transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
      style={{
        color: active ? "var(--foreground)" : "var(--muted)",
        fontWeight: active || item.hero ? 500 : 400,
      }}
    >
      {/* Selected = an elevated near-white card lifted off the recessed rail
          (Things/macOS sidebar language). Unmistakable, premium, neutral —
          coral stays reserved for the home anchor, not "active". */}
      {active && (
        <motion.div
          layoutId={pillId}
          className="absolute inset-0 rounded-lg"
          style={{
            background: "#ffffff",
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.05), 0 2px 6px rgba(0,0,0,0.05), inset 0 0 0 1px rgba(0,0,0,0.035), inset 0 1px 0 rgba(255,255,255,0.8)",
          }}
          transition={{ type: "spring", stiffness: 420, damping: 36 }}
        />
      )}
      {!active && (
        <span
          className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150"
          style={{ background: "rgba(255,255,255,0.6)" }}
        />
      )}

      <span className="relative z-10 flex items-center justify-center shrink-0">
        <Icon
          className="w-[18px] h-[18px]"
          strokeWidth={active ? 2.25 : 2}
          style={{ color: item.hero ? CORAL : undefined }}
        />
        {showDot && (
          <span
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
            style={{
              background: heartbeatHealth === "unhealthy" ? "#ef4444" : "#9ca3af",
              boxShadow: "0 0 0 2px " + SIDEBAR_BG,
            }}
          />
        )}
      </span>
      <span className="relative z-10 truncate">{item.label}</span>
    </Link>
  );
}

/* ─── A collapsible section ─────────────────────────────────────────────── */

function CollapsibleSection({
  section,
  pathname,
  heartbeatHealth,
  pillId,
  collapsed,
  onToggle,
}: {
  section: NavSection;
  pathname: string;
  heartbeatHealth: "healthy" | "unhealthy" | "paused" | null;
  pillId: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const hasActive = section.items.some((i) => i.href === pathname);
  // Active-route protection: the section containing the current page is
  // force-open AND non-collapsible, so the current page can never be hidden.
  const open = hasActive ? true : !collapsed;
  const locked = hasActive;

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={locked ? undefined : onToggle}
        aria-expanded={open}
        aria-disabled={locked || undefined}
        title={locked ? "Current section" : open ? "Collapse" : "Expand"}
        className={`group flex items-center gap-1.5 w-full px-3 pt-1 pb-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40 ${
          locked ? "cursor-default" : "cursor-pointer"
        }`}
      >
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.08em] select-none transition-colors"
          style={{
            color: "var(--muted)",
            opacity: locked ? 0.7 : open ? 0.7 : 0.55,
          }}
        >
          {section.label}
        </span>
        {/* chevron: down when open, rotated -90 (points right) when closed;
            spring-rotates in sync. Dimmed + static for the locked section. */}
        <motion.span
          className="ml-auto flex items-center"
          animate={{ rotate: open ? 0 : -90 }}
          transition={CHEVRON_SPRING}
          style={{ opacity: locked ? 0.25 : 0.5 }}
        >
          <ChevronDown
            className="w-3.5 h-3.5 transition-opacity group-hover:opacity-100"
            style={{ color: "var(--muted)" }}
          />
        </motion.span>
      </button>

      <motion.div
        initial={false}
        animate={open ? "open" : "closed"}
        variants={LIST_VARIANTS}
        style={{ overflow: "hidden" }}
        className="flex flex-col gap-0.5"
      >
        {section.items.map((item) => (
          <motion.div key={item.href} variants={ROW_VARIANTS}>
            {item.dividerBefore && (
              <div className="mx-3 my-1.5 h-px" style={{ background: "var(--border)" }} />
            )}
            <NavRow
              item={item}
              active={pathname === item.href}
              heartbeatHealth={heartbeatHealth}
              pillId={pillId}
            />
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}

/* ─── The shell (pure desktop rail) ─────────────────────────────────────── */

export function SidebarShell({
  children,
  pathname,
  session,
  heartbeatHealth,
}: {
  children: React.ReactNode;
  pathname: string;
  session: Session | null;
  heartbeatHealth: "healthy" | "unhealthy" | "paused" | null;
}) {
  const { collapsed, toggle } = useCollapseState();
  const isEdge = session?.user?.partner === "edge_city";
  const email = session?.user?.email ?? "";
  const pillId = "sidebar-active-pill";

  return (
    <div className="min-h-screen flex" style={{ background: "var(--background)" }}>
      <aside
        className="flex w-60 shrink-0 sticky top-0 h-screen flex-col"
        style={{ background: SIDEBAR_BG, borderRight: "1px solid var(--border)" }}
      >
        {/* Brand — PHASE 1: still points at /dashboard (no gravity shift yet) */}
        <Link
          href="/dashboard"
          className="flex items-center gap-1 h-14 px-3 shrink-0 text-xl tracking-[-0.5px] transition-opacity hover:opacity-70"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          <Image
            src="/logo.png"
            alt="InstaClaw"
            width={40}
            height={40}
            unoptimized
            style={{ imageRendering: "pixelated" }}
          />
          <span>Instaclaw</span>
        </Link>

        {/* Scrollable nav */}
        <nav className="flex-1 overflow-y-auto px-2 pt-1 pb-2 flex flex-col">
          {/* Command Center — permanent home anchor (always visible) */}
          <NavRow
            item={HOME}
            active={pathname === HOME.href}
            heartbeatHealth={heartbeatHealth}
            pillId={pillId}
          />
          <div className="mx-3 my-2 h-px" style={{ background: "var(--border)" }} />

          {/* Collapsible sections */}
          {SECTIONS.map((section) => (
            <CollapsibleSection
              key={section.key}
              section={section}
              pathname={pathname}
              heartbeatHealth={heartbeatHealth}
              pillId={pillId}
              collapsed={collapsed[section.key] ?? false}
              onToggle={() => toggle(section.key)}
            />
          ))}
        </nav>

        {/* Pinned bottom — never inside a collapsible section */}
        <div
          className="shrink-0 px-2 pt-2 pb-2 flex flex-col gap-2"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          {isEdge && (
            <NavRow
              item={{ href: "/edge/dashboard", label: "Edge City", icon: MapPin, tourKey: "nav-edge-city" }}
              active={pathname === "/edge/dashboard"}
              heartbeatHealth={heartbeatHealth}
              pillId={pillId}
            />
          )}

          {/* Invite & earn — referral banner (ZO "Share … earn" equivalent) */}
          <Link
            href="/ambassador"
            data-tour="nav-ambassador"
            className="group relative flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm transition-snappy outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40 overflow-hidden"
            style={{
              color: pathname === "/ambassador" ? "var(--foreground)" : CORAL,
              background:
                "linear-gradient(90deg, rgba(220,103,67,0.10), rgba(220,103,67,0.04))",
              boxShadow: "inset 0 0 0 1px rgba(220,103,67,0.16)",
              fontWeight: 500,
            }}
          >
            <span
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ background: "rgba(220,103,67,0.06)" }}
            />
            <Award className="w-[18px] h-[18px] relative z-10 shrink-0" strokeWidth={2} />
            <span className="relative z-10 truncate">Invite &amp; earn</span>
          </Link>

          {/* Account — two lines so identity + actions both breathe at 240px. */}
          <div
            className="rounded-lg px-2.5 py-2"
            style={{ background: "rgba(0,0,0,0.022)", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.03)" }}
          >
            <div className="flex items-center gap-2">
              <span
                className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[11px] font-semibold uppercase"
                style={{
                  background:
                    "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.85), rgba(200,85,52,0.95))",
                  color: "#fff",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)",
                }}
              >
                {email ? email[0] : "?"}
              </span>
              <span
                className="flex-1 min-w-0 truncate text-xs"
                style={{ color: "var(--foreground)", fontWeight: 500 }}
                title={email}
              >
                {email || "Signed in"}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-2">
              <button
                type="button"
                title="Take the tour again"
                aria-label="Take the tour again"
                onClick={async () => {
                  await fetch("/api/onboarding/restart-wizard", { method: "PATCH" });
                  window.dispatchEvent(new Event("instaclaw:restart-wizard"));
                }}
                className="w-7 h-7 flex items-center justify-center rounded-md cursor-pointer transition-all hover:bg-black/[0.06] active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
                style={{ color: "var(--muted)" }}
              >
                <Sparkles className="w-3.5 h-3.5" />
              </button>
              <a
                href="mailto:help@instaclaw.io"
                title="Support"
                aria-label="Support"
                className="w-7 h-7 flex items-center justify-center rounded-md cursor-pointer transition-all hover:bg-black/[0.06] active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
                style={{ color: "var(--muted)" }}
              >
                <Mail className="w-3.5 h-3.5" />
              </a>
              <div className="flex-1" />
              <button
                type="button"
                title="Sign out"
                aria-label="Sign out"
                onClick={() => signOut({ callbackUrl: "/" })}
                className="flex items-center gap-1.5 h-7 px-2 rounded-md cursor-pointer transition-all hover:bg-black/[0.06] active:scale-95 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
                style={{ color: "var(--muted)" }}
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Content column */}
      <div className="flex-1 min-w-0 flex flex-col">
        <AgentbookHatBanner />
        <ChannelNudgeBanner />
        <main className="max-w-6xl mx-auto w-full px-4 py-12 sm:py-16">
          {children}
        </main>
      </div>
    </div>
  );
}
