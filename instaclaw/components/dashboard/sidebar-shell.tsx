"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { motion, AnimatePresence } from "motion/react";
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
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Session } from "next-auth";
import { AgentbookHatBanner } from "@/components/dashboard/agentbook-hat-banner";
import { ChannelNudgeBanner } from "@/components/dashboard/channel-nudge-banner";
import { SessionsSection } from "@/components/dashboard/sessions-section";
import { useIsDesktop } from "@/components/dashboard/use-is-desktop";

/**
 * SidebarShell — the left-sidebar workspace chrome. Renders on BOTH viewports
 * when the sidebar flag is on (layout gates `navMode === "sidebar"`).
 *
 * The shell owns the viewport split internally via `useIsDesktop`:
 *   - Desktop (lg+): the fixed 240px <aside> rail (<SidebarNav>).
 *   - Mobile (<lg): a slim top bar (logo + hamburger + status-strip slot) + an
 *     off-canvas drawer (<SidebarNav>, scrim z-40 / panel z-[45], below the
 *     z-9998 gate overlay). Rail and drawer share ONE <SidebarNav> source of
 *     truth; only one mounts per viewport (conditional render, not CSS-hide) so
 *     there's a single data-tour copy for the onboarding tour to target.
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

// `tourKey` (optional) puts a data-tour anchor on the section CONTAINER so the
// onboarding tour can spotlight a whole cluster (e.g. nav-manage-section → the
// Account group, replacing the old "More" dropdown step). PRD §4.6.
type NavSection = { key: string; label: string; items: NavItem[]; tourKey?: string };

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
    tourKey: "nav-manage-section", // onboarding tour step 19 spotlights this cluster
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
// Darkened coral for text/icon ON coral-tinted glass — mirrors the .skill-pill
// is-green trick (text rgb(20,120,57) is darker than its radial fill) so the
// label stays legible over the translucent coral-under-glass material.
const CORAL_TEXT = "#A8442A";
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
      className="group relative flex shrink-0 items-center gap-3 px-3 h-9 rounded-lg text-sm transition-snappy transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
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
            // Real glass (the canonical material: −75° white sheen ⊕ light-under-
            // glass radial + 4-layer glow-ring/shadow stack, border:none). The
            // home anchor is keyed faintly coral (the icon is coral) so it reads
            // as the warm, lifted "selected" surface, not a flat white box. Near-
            // white sheen keeps dark label/icon perfectly legible on the recessed
            // cream rail; the glow-ring is the rim (no hard border).
            backgroundImage:
              "linear-gradient(-75deg, rgba(255,255,255,0.55), rgba(255,255,255,0.80), rgba(255,255,255,0.55)), " +
              "radial-gradient(120% 140% at 26% 22%, rgba(220,103,67,0.11) 0%, rgba(220,103,67,0.045) 55%, rgba(255,255,255,0) 100%)",
            backdropFilter: "blur(3px)",
            WebkitBackdropFilter: "blur(3px)",
            boxShadow:
              "rgba(0,0,0,0.05) 0px 1px 1.5px 0px inset, " +
              "rgba(255,255,255,0.70) 0px -1px 1.5px 0px inset, " +
              "rgba(0,0,0,0.10) 0px 2px 5px -1px, " +
              "rgba(255,255,255,0.55) 0px 0px 0.5px 1px inset",
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
    <div className="mt-1" data-tour={section.tourKey}>
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

/* ─── Status strip (§2.3) — at-a-glance agent health + daily usage ──────────
   TWO independent halves so a usage-endpoint hiccup can NEVER degrade the nav:
   - Health dot: from heartbeatHealth (already in the shell, no fetch) — always
     renders, can't fail.
   - Credits: best-effort GET /api/vm/usage with a 4s timeout. Fail-SILENT: on
     slow / error / unexpected shape it renders nothing for the credits half
     (never a hanging spinner, never an error bubbling into the chrome). The
     health dot stands alone. */

function StatusStrip({
  heartbeatHealth,
  className = "",
}: {
  heartbeatHealth: "healthy" | "unhealthy" | "paused" | null;
  className?: string;
}) {
  const [usage, setUsage] = useState<{ today: number; dailyLimit: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000); // never hang the header
    fetch("/api/vm/usage", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (
          !cancelled &&
          d &&
          typeof d.today === "number" &&
          typeof d.dailyLimit === "number"
        ) {
          setUsage({ today: d.today, dailyLimit: d.dailyLimit });
        }
      })
      .catch(() => {
        /* slow / network / abort / bad shape — fail silent, dot stands alone */
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, []);

  const dotColor =
    heartbeatHealth === "healthy"
      ? "#22c55e"
      : heartbeatHealth === "unhealthy"
        ? "#ef4444"
        : heartbeatHealth === "paused"
          ? "#f59e0b"
          : "var(--muted)";

  return (
    <div
      data-status-strip
      data-credits={usage ? `${Math.round(usage.today)}/${usage.dailyLimit}` : ""}
      className={`flex items-center gap-1.5 text-[11px] ${className}`}
      style={{ color: "var(--muted)" }}
    >
      <span
        data-health-dot
        className="w-2 h-2 rounded-full shrink-0"
        style={{ background: dotColor, boxShadow: `0 0 0 2px ${SIDEBAR_BG}` }}
        title={heartbeatHealth ? `Agent ${heartbeatHealth}` : "Agent status"}
        aria-label={heartbeatHealth ? `Agent ${heartbeatHealth}` : "Agent status"}
      />
      {usage && (
        <span className="whitespace-nowrap">
          {Math.round(usage.today)}/{usage.dailyLimit}
        </span>
      )}
    </div>
  );
}

/* ─── Shared nav body — rendered in the desktop rail AND the mobile drawer ───
   ONE source of truth so "every inventory item reachable" holds structurally on
   both viewports (not hand-maintained). Only one of {rail, drawer} mounts per
   viewport (conditional on isDesktop), so there's a single copy of each
   data-tour element for the tour to target. */

function SidebarNav({
  pathname,
  activeChatId,
  activeTaskId,
  heartbeatHealth,
  pillId,
  collapsed,
  toggle,
  isEdge,
  email,
  variant = "rail",
}: {
  pathname: string;
  activeChatId: string | null;
  activeTaskId: string | null;
  heartbeatHealth: "healthy" | "unhealthy" | "paused" | null;
  pillId: string;
  collapsed: CollapseMap;
  toggle: (key: string) => void;
  isEdge: boolean;
  email: string;
  // "rail" = desktop aside (shows the status strip under the logo, §2.3).
  // "drawer" = mobile off-canvas (the mobile top bar owns the strip instead, so
  // we don't double-render it). Only one SidebarNav renders per viewport, so the
  // strip fetches /api/vm/usage at most once.
  variant?: "rail" | "drawer";
}) {
  return (
    <>
      {/* Brand — PHASE 2 gravity shift: logo → Command Center (home), per D1. */}
      <Link
        href="/tasks"
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

      {/* Status strip (§2.3) — at-a-glance agent health + daily usage, under the
          logo. Rail only; the mobile top bar renders its own copy in the
          reserved slot so it's always visible without opening the drawer. */}
      {variant !== "drawer" && (
        <div className="shrink-0 px-3 pb-1.5">
          <StatusStrip heartbeatHealth={heartbeatHealth} />
        </div>
      )}

      {/* Command Center — permanent home anchor. Pinned ABOVE the scroll
          region (shrink-0) so it holds its full natural height in every
          collapse + viewport-height combination and never scrolls away. */}
      <div className="shrink-0 px-2 pt-1">
        <NavRow
          item={HOME}
          active={pathname === "/tasks" && !activeChatId && !activeTaskId}
          heartbeatHealth={heartbeatHealth}
          pillId={pillId}
        />
        <div className="mx-3 my-2 h-px" style={{ background: "var(--border)" }} />
      </div>

      {/* Scrollable section list — takes the remaining height and scrolls when
          the expanded sections overflow. `min-h-0` is load-bearing. */}
      <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {/* Sessions — live index of Command Center chats + tasks. */}
        <SessionsSection
          collapsed={collapsed["sessions"] ?? false}
          onToggle={() => toggle("sessions")}
          activeChatId={activeChatId}
          activeTaskId={activeTaskId}
        />
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
            color: pathname === "/ambassador" ? "var(--foreground)" : CORAL_TEXT,
            // Real coral-tinted glass — coral light UNDER the −75° white sheen
            // (mirrors .skill-pill.is-green/is-blue: white sheen ⊕ brand radial
            // + 4-layer shadow stack), not a flat coral rect. The coral identity
            // now reads as our glass material; CORAL_TEXT keeps the label legible.
            backgroundImage:
              "linear-gradient(-75deg, rgba(255,255,255,0.10), rgba(255,255,255,0.34), rgba(255,255,255,0.10)), " +
              "radial-gradient(125% 150% at 26% 26%, rgba(220,103,67,0.34) 0%, rgba(220,103,67,0.20) 55%, rgba(220,103,67,0.12) 100%)",
            backdropFilter: "blur(3px)",
            WebkitBackdropFilter: "blur(3px)",
            boxShadow:
              "rgba(0,0,0,0.05) 0px 0.5px 1px 0px inset, " +
              "rgba(255,255,255,0.42) 0px -0.5px 1.5px 0px inset, " +
              "rgba(0,0,0,0.09) 0px 1px 2px -1px, " +
              "rgba(255,255,255,0.30) 0px 0px 0.5px 1px inset",
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
          style={{
            // Clean neutral glass — the canonical material (−75° white sheen ⊕
            // faint white light-under-glass + 4-layer glow-ring/shadow stack)
            // tuned subtle for utility chrome.
            backgroundImage:
              "linear-gradient(-75deg, rgba(255,255,255,0.22), rgba(255,255,255,0.46), rgba(255,255,255,0.22)), " +
              "radial-gradient(120% 160% at 28% 20%, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0.10) 55%, rgba(255,255,255,0) 100%)",
            backdropFilter: "blur(3px)",
            WebkitBackdropFilter: "blur(3px)",
            boxShadow:
              "rgba(0,0,0,0.04) 0px 1px 1.5px 0px inset, " +
              "rgba(255,255,255,0.50) 0px -1px 1.5px 0px inset, " +
              "rgba(0,0,0,0.07) 0px 1px 3px -1px, " +
              "rgba(255,255,255,0.35) 0px 0px 0.5px 1px inset",
          }}
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
    </>
  );
}

/* ─── The shell (desktop rail + mobile off-canvas drawer) ────────────────── */

type SidebarShellProps = {
  children: React.ReactNode;
  pathname: string;
  session: Session | null;
  heartbeatHealth: "healthy" | "unhealthy" | "paused" | null;
  /** Off-canvas drawer open state — lifted to the dashboard layout so the
   *  onboarding tour can open it on mobile nav-item steps (mirrors setMoreOpen).
   *  Optional so the dev preview harness can mount the shell without it. */
  drawerOpen?: boolean;
  setDrawerOpen?: (open: boolean) => void;
};

/**
 * Suspense boundary is required because SidebarShellInner reads useSearchParams
 * (for the active-session highlight + the Command Center pill predicate). Kept
 * INSIDE this component so the dashboard layout stays untouched.
 */
export function SidebarShell(props: SidebarShellProps) {
  return (
    <Suspense fallback={null}>
      <SidebarShellInner {...props} />
    </Suspense>
  );
}

function SidebarShellInner({
  children,
  pathname,
  session,
  heartbeatHealth,
  drawerOpen: drawerOpenProp,
  setDrawerOpen: setDrawerOpenProp,
}: SidebarShellProps) {
  const { collapsed, toggle } = useCollapseState();
  const isDesktop = useIsDesktop();
  const isEdge = session?.user?.partner === "edge_city";
  const email = session?.user?.email ?? "";
  const pillId = "sidebar-active-pill";

  // Mobile off-canvas drawer open state. Controlled by the dashboard layout
  // (lifted, so the onboarding tour can open it on mobile nav-item steps —
  // mirrors setMoreOpen) when the props are provided; falls back to internal
  // state for the dev preview harness, which mounts the shell directly.
  const [internalDrawerOpen, setInternalDrawerOpen] = useState(false);
  const drawerOpen = drawerOpenProp ?? internalDrawerOpen;
  const setDrawerOpen = setDrawerOpenProp ?? setInternalDrawerOpen;
  const touchStartX = useRef<number | null>(null);

  // Active session from the deep-link URL params (?c=<conversation> / ?t=<task>).
  // Drives the Sessions row highlight AND the Command Center predicate below, so
  // exactly one row owns the shared layoutId pill at a time.
  const searchParams = useSearchParams();
  const activeChatId = searchParams.get("c");
  const activeTaskId = searchParams.get("t");

  // Command Center (/tasks) is viewport-locked: its chat input pins to the
  // bottom and the task/message list scrolls above it (native chat-app feel).
  // Mirror the top-nav path's treatment (layout.tsx `isCommandCenter`) so the
  // shell gives /tasks the same full-height flex column instead of the padded,
  // document-scrolling wrapper every other route uses. Without this the input
  // floated mid-page inside the padded <main>. B2's mobile top bar slots into
  // this flex column as another shrink-0 child, so available height stays
  // computed (flexbox), never guessed — the seam-6 requirement.
  const isCommandCenter = pathname === "/tasks";

  // If the viewport grows to desktop while the drawer is open, close it — the
  // rail takes over and a left-open drawer must not linger off-screen.
  useEffect(() => {
    if (isDesktop && drawerOpen) setDrawerOpen(false);
  }, [isDesktop, drawerOpen, setDrawerOpen]);

  // Lock body scroll + close-on-Escape while the mobile drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen, setDrawerOpen]);

  return (
    <div
      className={isCommandCenter ? "h-dvh overflow-hidden flex" : "min-h-screen flex"}
      style={{ background: "var(--background)" }}
    >
      {/* Desktop rail (lg+). Conditionally RENDERED (not CSS-hidden) so that at
          <lg the mobile drawer's copy is the only <SidebarNav> in the DOM — one
          set of data-tour elements for the tour to target, no display:none
          duplicate stealing querySelector. */}
      {isDesktop && (
        <aside
          className="flex w-60 shrink-0 sticky top-0 h-screen flex-col"
          style={{ background: SIDEBAR_BG, borderRight: "1px solid var(--border)" }}
        >
          <SidebarNav
            pathname={pathname}
            activeChatId={activeChatId}
            activeTaskId={activeTaskId}
            heartbeatHealth={heartbeatHealth}
            pillId={pillId}
            collapsed={collapsed}
            toggle={toggle}
            isEdge={isEdge}
            email={email}
          />
        </aside>
      )}

      {/* Content column — a flex column so Command Center fills the remaining
          height (chat input pinned to the bottom) while every other route is a
          normal padded, document-scrolling container. Banners sit in a shrink-0
          wrapper so they keep their natural height and <main> fills exactly the
          space below them. Mirrors the top-nav path (layout.tsx). */}
      <div className={`flex-1 min-w-0 flex flex-col${isCommandCenter ? " min-h-0" : ""}`}>
        {/* Mobile slim top bar (<lg) — the rail is hidden on mobile, so this is
            the nav entry point. It's the FIRST shrink-0 child of the flex
            column, so /tasks' <main> fills exactly the height left below it
            (seam 6 — the chat input stays reachable, height computed not
            guessed). Right side reserves a slot for the Unit C status strip. */}
        {!isDesktop && (
          <header
            className="shrink-0 flex items-center gap-1 h-14 px-3 border-b"
            style={{ background: SIDEBAR_BG, borderColor: "var(--border)" }}
          >
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setDrawerOpen(true)}
              className="w-9 h-9 -ml-1 flex items-center justify-center rounded-lg cursor-pointer transition-all hover:bg-black/[0.06] active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
              style={{ color: "var(--foreground)" }}
            >
              <Menu className="w-5 h-5" />
            </button>
            <Link
              href="/tasks"
              className="flex items-center gap-1 text-lg tracking-[-0.5px] transition-opacity hover:opacity-70"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              <Image src="/logo.png" alt="InstaClaw" width={32} height={32} unoptimized style={{ imageRendering: "pixelated" }} />
              <span>Instaclaw</span>
            </Link>
            {/* Unit C status strip — right-aligned, always visible on mobile
                without opening the drawer. Health dot can't fail; credits is
                best-effort (fail-silent). */}
            <div className="ml-auto flex items-center" data-status-strip-slot>
              <StatusStrip heartbeatHealth={heartbeatHealth} />
            </div>
          </header>
        )}
        <div className="shrink-0">
          <AgentbookHatBanner />
          <ChannelNudgeBanner />
        </div>
        <main
          className={
            isCommandCenter
              ? "flex-1 min-h-0 w-full max-w-6xl mx-auto px-4"
              : "max-w-6xl mx-auto w-full px-4 py-12 sm:py-16"
          }
        >
          {children}
        </main>
      </div>

      {/* Mobile off-canvas drawer (<lg). Scrim z-40 + panel z-[45] — both well
          below the dashboard gate overlay (z-9998), so a gated user always gets
          the gate, never a drawer openable underneath it. Renders only when
          !isDesktop, so the desktop rail's <SidebarNav> is the only data-tour
          copy in the DOM on desktop, and the drawer's is the only one on mobile. */}
      {!isDesktop && (
        <AnimatePresence>
          {drawerOpen && (
            <>
              <motion.div
                key="drawer-scrim"
                className="fixed inset-0 z-40 lg:hidden"
                style={{ background: "rgba(0,0,0,0.45)" }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                onClick={() => setDrawerOpen(false)}
                aria-hidden="true"
              />
              <motion.aside
                key="drawer-panel"
                className="fixed left-0 top-0 bottom-0 z-[45] w-[82%] max-w-[300px] flex flex-col lg:hidden"
                style={{ background: SIDEBAR_BG, borderRight: "1px solid var(--border)" }}
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{ type: "spring", stiffness: 520, damping: 44 }}
                onTouchStart={(e) => {
                  touchStartX.current = e.touches[0]?.clientX ?? null;
                }}
                onTouchEnd={(e) => {
                  const start = touchStartX.current;
                  touchStartX.current = null;
                  const end = e.changedTouches[0]?.clientX ?? start ?? 0;
                  if (start !== null && end - start < -50) setDrawerOpen(false);
                }}
                onClick={(e) => {
                  // Close when a navigation link is tapped (delegation). Pin /
                  // collapse / account controls are <button>s that stopPropagation
                  // (or aren't links), so they don't close the drawer; only a
                  // navigation <a href> bubbles to here → close.
                  if ((e.target as HTMLElement).closest("a[href]")) setDrawerOpen(false);
                }}
              >
                <button
                  type="button"
                  aria-label="Close navigation"
                  onClick={() => setDrawerOpen(false)}
                  className="absolute right-2 top-3 z-10 w-8 h-8 flex items-center justify-center rounded-lg cursor-pointer transition-all hover:bg-black/[0.06] active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
                  style={{ color: "var(--muted)" }}
                >
                  <X className="w-4 h-4" />
                </button>
                <SidebarNav
                  pathname={pathname}
                  activeChatId={activeChatId}
                  activeTaskId={activeTaskId}
                  heartbeatHealth={heartbeatHealth}
                  pillId={pillId}
                  collapsed={collapsed}
                  toggle={toggle}
                  isEdge={isEdge}
                  email={email}
                  variant="drawer"
                />
              </motion.aside>
            </>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}
