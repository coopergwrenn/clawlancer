"use client";

import Image from "next/image";
import Link from "next/link";
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
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Session } from "next-auth";
import { AgentbookHatBanner } from "@/components/dashboard/agentbook-hat-banner";
import { ChannelNudgeBanner } from "@/components/dashboard/channel-nudge-banner";

/**
 * SidebarShell — the Phase 1 left-sidebar workspace chrome.
 *
 * Renders behind the `useNavMode() === "sidebar"` flag. When the flag is off,
 * this never mounts and the dashboard renders the original top-nav verbatim
 * (see app/(dashboard)/layout.tsx). All four redirect gates, the heartbeat
 * poll, the gate overlay and the OnboardingWizard live in the layout and are
 * shared across both chromes — this component is presentational nav + the
 * content geometry only.
 *
 * PHASE 1 = pure visual reskin, ZERO routing change:
 *   - the brand/logo still points at /dashboard (the gravity shift to
 *     Command Center is Phase 2, deliberately not done here).
 *   - every route is identical to today; only the chrome changes.
 *   - Command Center is the *visual* hero (top of Workspace, coral icon) but
 *     is not yet the logo's destination.
 *
 * Information architecture per the approved PRD §D3, reconciled against the
 * real origin/main nav (which added /economy — homed here next to Earn):
 *   WORKSPACE  · live agent : Command Center · The Floor · Heartbeat · Live View
 *              · work&output: Skills · Earn · Economy · Files · Scheduled · History
 *   ACCOUNT&PLAN          : Overview · Credits · Billing · Settings · API Keys
 *   PINNED                : Edge City (edge_city only) · Invite & earn · account row
 *
 * Every existing data-tour key is carried onto its sidebar item so the tour
 * keeps resolving; `nav-manage-section` is added on the Account header for the
 * sidebar-native tour step (wired in the Phase 1 tour milestone).
 */

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  tourKey: string;
  hero?: boolean; // Command Center — the workspace home anchor
  heartbeat?: boolean; // shows the live health dot
};

const WORKSPACE_LIVE: NavItem[] = [
  { href: "/tasks", label: "Command Center", icon: MessageSquare, tourKey: "nav-command-center", hero: true },
  { href: "/floor", label: "The Floor", icon: Waves, tourKey: "nav-floor" },
  { href: "/heartbeat", label: "Heartbeat", icon: Heart, tourKey: "nav-heartbeat", heartbeat: true },
  { href: "/live", label: "Live View", icon: Monitor, tourKey: "nav-live" },
];

const WORKSPACE_WORK: NavItem[] = [
  { href: "/skills", label: "Skills", icon: Puzzle, tourKey: "nav-skills" },
  { href: "/earn", label: "Earn", icon: TrendingUp, tourKey: "nav-earn" },
  { href: "/economy", label: "Economy", icon: Coins, tourKey: "nav-economy" },
  { href: "/files", label: "Files", icon: FolderOpen, tourKey: "nav-files" },
  { href: "/scheduled", label: "Scheduled", icon: Clock, tourKey: "nav-scheduled" },
  { href: "/history", label: "History", icon: History, tourKey: "nav-history" },
];

const ACCOUNT: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, tourKey: "nav-dashboard" },
  { href: "/dashboard/credits", label: "Credits", icon: Zap, tourKey: "nav-credits" },
  { href: "/billing", label: "Billing", icon: CreditCard, tourKey: "nav-billing" },
  { href: "/settings", label: "Settings", icon: Settings, tourKey: "nav-settings" },
  { href: "/env-vars", label: "API Keys", icon: Key, tourKey: "nav-api-keys" },
];

const CORAL = "#DC6743";
// The rail sits one notch recessed from the cream content (#f8f7f4) so the
// workspace reads with depth, not as a flat plane split by a hairline. #f5f3ee
// is an existing InstaClaw tone (the landing/onboarding warm cream).
const SIDEBAR_BG = "#f5f3ee";

/* ─── A single nav row ──────────────────────────────────────────────────── */

function NavRow({
  item,
  active,
  heartbeatHealth,
  pillId,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  heartbeatHealth: "healthy" | "unhealthy" | "paused" | null;
  pillId: string;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const showDot =
    item.heartbeat && heartbeatHealth && heartbeatHealth !== "healthy";

  return (
    <Link
      href={item.href}
      data-tour={item.tourKey}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className="group relative flex items-center gap-3 px-3 h-9 rounded-lg text-sm transition-snappy transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
      style={{
        color: active ? "var(--foreground)" : "var(--muted)",
        fontWeight: active || item.hero ? 500 : 400,
      }}
    >
      {/* Active sliding pill — shared layoutId so it glides between items.
          Mirrors the top-nav's nav-pill (rgba glass + ring + blur, snappy
          spring) so the two chromes speak the same material language. */}
      {active && (
        <motion.div
          layoutId={pillId}
          className="absolute inset-0 rounded-lg"
          style={{
            // Selected = an elevated near-white card lifted off the recessed
            // rail (Things/macOS sidebar language). Unmistakable, premium, and
            // neutral — coral stays reserved for the home anchor, not "active".
            background: "#ffffff",
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.05), 0 2px 6px rgba(0,0,0,0.05), inset 0 0 0 1px rgba(0,0,0,0.035), inset 0 1px 0 rgba(255,255,255,0.8)",
          }}
          transition={{ type: "spring", stiffness: 420, damping: 36 }}
        />
      )}
      {/* Hover = a gentle lift toward white (consistent tactility with the
          selected card) for inactive rows. */}
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
          // Command Center anchors as the home: its glyph carries the brand
          // coral always, so the eye lands on it first even when inactive.
          style={{ color: item.hero ? CORAL : undefined }}
        />
        {showDot && (
          <span
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
            style={{
              background: heartbeatHealth === "unhealthy" ? "#ef4444" : "#9ca3af",
              boxShadow: "0 0 0 2px var(--background)",
            }}
          />
        )}
      </span>
      <span className="relative z-10 truncate">{item.label}</span>
    </Link>
  );
}

/* ─── Section label ─────────────────────────────────────────────────────── */

function SectionLabel({
  children,
  tourKey,
}: {
  children: React.ReactNode;
  tourKey?: string;
}) {
  return (
    <p
      data-tour={tourKey}
      className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] select-none"
      style={{ color: "var(--muted)", opacity: 0.7 }}
    >
      {children}
    </p>
  );
}

/* ─── The nav body (shared by desktop rail + mobile drawer) ─────────────── */

function NavBody({
  pathname,
  session,
  heartbeatHealth,
  pillId,
  onNavigate,
}: {
  pathname: string;
  session: Session | null;
  heartbeatHealth: "healthy" | "unhealthy" | "paused" | null;
  pillId: string;
  onNavigate?: () => void;
}) {
  const isEdge = session?.user?.partner === "edge_city";
  const email = session?.user?.email ?? "";

  const row = (item: NavItem) => (
    <NavRow
      key={item.href}
      item={item}
      active={pathname === item.href}
      heartbeatHealth={heartbeatHealth}
      pillId={pillId}
      onNavigate={onNavigate}
    />
  );

  return (
    <div className="flex flex-col h-full">
      {/* Brand — PHASE 1: still points at /dashboard (no gravity shift yet) */}
      <Link
        href="/dashboard"
        onClick={onNavigate}
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
      <nav className="flex-1 overflow-y-auto px-2 pt-1 pb-2 flex flex-col gap-0.5">
        {/* WORKSPACE · live agent */}
        {WORKSPACE_LIVE.map(row)}

        {/* hairline between the two Workspace clusters */}
        <div
          className="mx-3 my-2 h-px"
          style={{ background: "var(--border)" }}
        />

        {/* WORKSPACE · work & output */}
        {WORKSPACE_WORK.map(row)}

        {/* ACCOUNT & PLAN */}
        <SectionLabel tourKey="nav-manage-section">Account &amp; Plan</SectionLabel>
        {ACCOUNT.map(row)}
      </nav>

      {/* Pinned bottom */}
      <div className="shrink-0 px-2 pt-2 pb-2 flex flex-col gap-2" style={{ borderTop: "1px solid var(--border)" }}>
        {isEdge &&
          row({
            href: "/edge/dashboard",
            label: "Edge City",
            icon: MapPin,
            tourKey: "nav-edge-city",
          })}

        {/* Invite & earn — referral banner (ZO "Share … earn" equivalent) */}
        <Link
          href="/ambassador"
          data-tour="nav-ambassador"
          onClick={onNavigate}
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

        {/* Account — two lines so identity + actions both breathe at 240px:
            line 1 = avatar + email; line 2 = tour · support (left) + sign out
            (right). Settings already lives in the Account nav group above, so
            it isn't duplicated here. */}
        <div
          className="rounded-lg px-2.5 py-2"
          style={{ background: "rgba(0,0,0,0.022)", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.03)" }}
        >
          <div className="flex items-center gap-2">
            <span
              className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[11px] font-semibold uppercase"
              style={{
                background: "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.85), rgba(200,85,52,0.95))",
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
                onNavigate?.();
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
    </div>
  );
}

/* ─── The shell ─────────────────────────────────────────────────────────── */

export function SidebarShell({
  children,
  pathname,
  session,
  heartbeatHealth,
  drawerOpen,
  setDrawerOpen,
}: {
  children: React.ReactNode;
  pathname: string;
  session: Session | null;
  heartbeatHealth: "healthy" | "unhealthy" | "paused" | null;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
}) {
  return (
    <div className="min-h-screen flex" style={{ background: "var(--background)" }}>
      {/* Desktop rail — persistent, sticky, full-height */}
      <aside
        className="hidden lg:flex w-60 shrink-0 sticky top-0 h-screen flex-col"
        style={{
          background: SIDEBAR_BG,
          borderRight: "1px solid var(--border)",
        }}
      >
        <NavBody
          pathname={pathname}
          session={session}
          heartbeatHealth={heartbeatHealth}
          pillId="sidebar-pill-desktop"
        />
      </aside>

      {/* Mobile drawer + scrim */}
      <AnimatePresence>
        {drawerOpen && (
          <motion.div
              key="scrim"
              className="lg:hidden fixed inset-0 z-[60]"
              style={{ background: "rgba(0,0,0,0.4)" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setDrawerOpen(false)}
            />
        )}
        {drawerOpen && (
          <motion.aside
              key="drawer"
              className="lg:hidden fixed top-0 left-0 bottom-0 z-[61] w-[78%] max-w-[300px] flex flex-col"
              style={{
                background: SIDEBAR_BG,
                borderRight: "1px solid var(--border)",
                boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
              }}
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 380, damping: 38 }}
            >
              {/* close affordance */}
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setDrawerOpen(false)}
                className="absolute top-4 right-3 z-20 w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:bg-black/[0.06]"
                style={{ color: "var(--muted)" }}
              >
                <X className="w-4 h-4" />
              </button>
              <NavBody
                pathname={pathname}
                session={session}
                heartbeatHealth={heartbeatHealth}
                pillId="sidebar-pill-mobile"
                onNavigate={() => setDrawerOpen(false)}
              />
            </motion.aside>
        )}
      </AnimatePresence>

      {/* Content column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top bar — logo + hamburger (desktop hides it) */}
        <div
          className="lg:hidden sticky top-0 z-40 h-14 flex items-center justify-between px-3 border-b transition-colors"
          style={{ borderColor: "var(--border)", background: "var(--background)" }}
        >
          <Link
            href="/dashboard"
            className="flex items-center gap-1 text-xl tracking-[-0.5px] transition-opacity hover:opacity-70"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            <Image
              src="/logo.png"
              alt="InstaClaw"
              width={36}
              height={36}
              unoptimized
              style={{ imageRendering: "pixelated" }}
            />
            <span>Instaclaw</span>
          </Link>
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="w-9 h-9 flex items-center justify-center rounded-lg transition-snappy transition-colors hover:bg-black/[0.06] relative"
            style={{ color: "var(--foreground)" }}
          >
            <Menu className="w-5 h-5" />
            {heartbeatHealth && heartbeatHealth !== "healthy" && (
              <span
                className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full"
                style={{
                  background: heartbeatHealth === "unhealthy" ? "#ef4444" : "#9ca3af",
                }}
              />
            )}
          </button>
        </div>

        <AgentbookHatBanner />
        <ChannelNudgeBanner />

        {/* Page content — same max-width + padding as the top-nav layout so
            every page body renders at exactly its current dimensions, just
            offset by the rail. */}
        <main className="max-w-6xl mx-auto w-full px-4 py-12 sm:py-16">
          {children}
        </main>
      </div>
    </div>
  );
}
