"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import {
  LayoutDashboard,
  Settings,
  CreditCard,
  LogOut,
  History,
  Clock,
  FolderOpen,
  Key,
  MoreHorizontal,
  MessageSquare,
  Sparkles,
  Heart,
  TrendingUp,
  Puzzle,
  Award,
  Zap,
  Mail,
  MapPin,
  Waves,
  Coins,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { motion } from "motion/react";
import OnboardingWizard from "@/components/onboarding-wizard/OnboardingWizard";
import { AgentbookHatBanner } from "@/components/dashboard/agentbook-hat-banner";
import { ChannelNudgeBanner } from "@/components/dashboard/channel-nudge-banner";
import { useNavMode } from "@/components/dashboard/use-nav-mode";
import { SidebarShell } from "@/components/dashboard/sidebar-shell";
import { DashboardGateOverlay } from "@/components/dashboard/dashboard-gate-overlay";

// Primary items — the daily-use operational core, always visible. Kept to FIVE
// so the eye lands on what users actually reach for every session, not a wall
// of tabs. Order: home → interact → monitor → configure → engage. Skills sits
// ahead of Earn (it's the target of the ToolRouter-announcement traffic). The
// Floor + Edge City moved into the "···" overflow — features users explore, not
// daily workflow. Routes are UNCHANGED, so all deep links keep working.
const primaryNav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, tourKey: "nav-dashboard" },
  { href: "/tasks", label: "Command Center", icon: MessageSquare, tourKey: "nav-command-center" },
  { href: "/heartbeat", label: "Heartbeat", icon: Heart, tourKey: "nav-heartbeat" },
  { href: "/skills", label: "Skills", icon: Puzzle, tourKey: "nav-skills" },
  { href: "/earn", label: "Earn", icon: TrendingUp, tourKey: "nav-earn" },
];

// Feature items — surfaced at the TOP of the "···" menu (cool-but-not-daily:
// watch/share/delight). The Floor is universal. Edge City is appended only for
// edge_city attendees (partner-niche + time-boxed); session.user.partner is
// populated by the NextAuth session callback from instaclaw_users.partner, so
// it renders without a fetch (no flash).
const featuresNav = [
  // Waves nods to Larry's tidepool + the "sea floor" double meaning of the name.
  { href: "/floor", label: "The Floor", icon: Waves, tourKey: "nav-floor" },
];
const edgeCityNavItem = {
  href: "/edge/dashboard",
  label: "Edge City",
  icon: MapPin,
  tourKey: "nav-edge-city",
};

// Utility / account items — the lower section of the "···" menu.
const overflowNav = [
  { href: "/history", label: "History", icon: History, tourKey: "nav-history" },
  { href: "/files", label: "Files", icon: FolderOpen, tourKey: "nav-files" },
  { href: "/scheduled", label: "Scheduled", icon: Clock, tourKey: "nav-scheduled" },
  { href: "/env-vars", label: "API Keys", icon: Key, tourKey: "nav-api-keys" },
  { href: "/ambassador", label: "Ambassador", icon: Award, tourKey: "nav-ambassador" },
  { href: "/economy", label: "Economy", icon: Coins, tourKey: "nav-economy" },
  { href: "/dashboard/credits", label: "Credits", icon: Zap, tourKey: "nav-credits" },
  { href: "/settings", label: "Settings", icon: Settings, tourKey: "nav-settings" },
  { href: "/billing", label: "Billing", icon: CreditCard, tourKey: "nav-billing" },
];


export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const tourControllingMore = useRef(false);
  const [heartbeatHealth, setHeartbeatHealth] = useState<"healthy" | "unhealthy" | "paused" | null>(null);
  const [gateChecked, setGateChecked] = useState(false);
  const [gated, setGated] = useState(false);
  // Phase 1 sidebar restructure — flag-gated. `navMode` resolves to "topnav"
  // for every un-opted-in user (env unset, no localStorage, no ?nav= param),
  // so the flag-off render below is byte-identical to origin/main. `drawerOpen`
  // drives the mobile off-canvas drawer (sidebar mode only).
  const navMode = useNavMode();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Only redirect to onboarding if we have a confirmed session (user.id is set
  // by the session callback) AND onboardingComplete is explicitly false.
  // Using strict equality prevents redirecting when the session callback's
  // Supabase query fails and onboardingComplete is undefined.
  const needsOnboarding =
    status !== "loading" && session?.user?.id && session.user.onboardingComplete === false;

  // 2026-05-12: redirect target must be data-driven, not just based on
  // onboarding_complete. `/api/vm/configure` can hit its critical-failure gate
  // AFTER the atomic VM write but BEFORE the supplemental update that flips
  // onboarding_complete=true. The user ends up with a healthy, usable VM and
  // a stale onboarding_complete=false. Naively redirecting them to /connect
  // creates an infinite loop: dashboard → connect → plan → deploying (sees
  // healthy VM, redirects back) → dashboard. Eight users hit this between
  // 2026-05-10 and 2026-05-12 — see Rule 33.
  //
  // 2026-05-28 Move 6: no-VM fallback retargeted /connect → /channels.
  // /connect is the legacy BYOB Telegram bot creation page; /channels is the
  // modern channel picker (iMessage / Telegram shared / Discord+Slack
  // waitlist / "skip to your command center" web-only path). A user who
  // signs in via /signin (not via /channels) and lands on /dashboard with no
  // VM was being shoved into the BYOB-only path, never seeing the new flow.
  // /channels covers all those options PLUS the web skip (which routes back
  // through /onboarding/web for the silent-provision path).
  //
  // Disambiguate by VM state:
  //   - has usable VM (healthy + gateway_url) → stay on dashboard, let them in
  //   - VM exists but configure_failed → /deploying (where they see retry UI)
  //   - VM exists but still configuring (no gateway_url yet) → /deploying
  //   - no VM at all → /channels (modern new-user entrypoint, post-Move 6)
  //
  // Network-error failsafes (lines 111 + 139) still send to /connect — they
  // run when /api/vm/status is unreachable, which is "I don't know what
  // state the user is in" rather than "I know they have no VM". /connect
  // works as a known-good landing in that degraded case (it renders its
  // own client UI regardless of API availability).
  useEffect(() => {
    if (!needsOnboarding) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/vm/status");
        if (cancelled) return;
        if (!res.ok) {
          // 401/5xx — conservatively send to /connect (failsafe; /channels
          // would also work here but we preserve the pre-Move-6 failsafe to
          // bound the blast radius of this change).
          router.replace("/connect");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        const vm = data?.vm;
        const hasUsableVm =
          data?.status === "assigned" &&
          !!vm?.gatewayUrl &&
          vm?.healthStatus !== "configure_failed";
        if (hasUsableVm) {
          // Working VM exists. Let them stay on the dashboard. The supplemental
          // state (onboarding_complete, telegram_bot_username, partner) will be
          // healed by the next successful configure or by manual remediation.
          return;
        }
        if (data?.status === "assigned" && vm?.healthStatus === "configure_failed") {
          router.replace("/deploying");
          return;
        }
        if (data?.status === "assigned" && !vm?.gatewayUrl) {
          // VM assigned, configure in progress
          router.replace("/deploying");
          return;
        }
        // No VM (pending/no_user) → modern channel picker (Move 6).
        // From /channels users can pick iMessage / Telegram shared-bot /
        // "skip to your command center" web path. The legacy BYOB Telegram
        // route is still reachable via /channels' "use the legacy setup"
        // footnote (which now points to /signin?callbackUrl=/connect — see
        // Move 4 in the same auth-consolidation commit).
        router.replace("/channels");
      } catch {
        if (!cancelled) router.replace("/connect");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsOnboarding, router]);

  // ── Edge attendee intent gate (FUP-3a) ──────────────────────────────────
  //
  // Edge Esmeralda's matching engine needs at least one expressed intent
  // per attendee — without it, the user is invisible to the village
  // network. Enforce universally: any Edge attendee landing on /dashboard
  // (or any sub-route) with index_last_intent_at === null is bounced to
  // /edge/intents BEFORE the dashboard renders. /deploying's post-provision
  // redirect ALSO routes Edge users here as a primary path; this layout
  // gate is the defense-in-depth catch for direct nav, refresh, Telegram
  // deep-links, and any other path.
  //
  // The gate is independent of the `needsOnboarding` useEffect above —
  // fresh-deploy Edge users have onboarding_complete=true (the supplemental
  // update at the end of /api/vm/configure flips it), so needsOnboarding
  // is false and that effect skips. This effect runs regardless.
  //
  // Escape hatch: `edge_intent_skipped_at` in localStorage (30-min TTL),
  // set by /edge/intents's service-degraded fallback when Yanek's MCP is
  // down. Honors the flag so users aren't locked out by a partner outage;
  // re-prompts after 30 min so the network still gets seeded post-recovery.
  // 2026-05-23 redirect-loop fix: the prior implementation read
  // `session.user.indexLastIntentAt` directly. NextAuth's SessionProvider
  // caches session state across SPA navigations — when a user submits an
  // intent on /edge/intents and clicks Continue (router.push("/dashboard")),
  // the SPA navigation does NOT trigger a session refetch. The dashboard
  // layout mounts with the stale snapshot (intentAt still null from
  // /edge/intents's initial server render), fires
  // router.replace("/edge/intents"), and the /edge/intents server component
  // reads LIVE DB (intent IS set), fires `redirect("/dashboard")` → loop.
  //
  // The fix: when session reports intentAt is null AND user is edge_city,
  // verify against live DB via /api/vm/status before redirecting. Mirrors
  // the data-driven pattern the needsOnboarding gate already uses
  // (which is loop-free precisely because it lives-fetches via /api/vm/
  // status before deciding where to redirect).
  //
  // True positives (intent really is null): live DB also returns null →
  //   redirect. Correct.
  // False positives (intent set in DB but null in session — the loop
  //   trigger): live DB returns set → skip redirect. Loop broken.
  // Session already says set: short-circuit, no fetch needed.
  useEffect(() => {
    if (status === "loading") return;
    if (!session?.user?.id) return;
    if (session.user.partner !== "edge_city") return;
    if (session.user.indexLastIntentAt) return; // session knows for sure

    let cancelled = false;
    (async () => {
      // Live-DB verify before redirecting. The stale-session loop happens
      // here — without this fetch, we'd bounce to /edge/intents which
      // would server-redirect right back.
      try {
        const res = await fetch("/api/vm/status");
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          if (data?.user?.indexLastIntentAt) return; // set in DB, skip redirect
        }
      } catch {
        // Network failure — fall through to localStorage check + redirect.
        // This preserves the previous fail-safe behavior of "if we can't
        // verify, assume the user needs to submit intent." Worst case is
        // a redirect that resolves on the next page load.
      }
      if (cancelled) return;

      // Check localStorage escape flag — Yanek-MCP-down service degradation.
      try {
        const skipTs = parseInt(
          localStorage.getItem("edge_intent_skipped_at") ?? "0",
          10,
        );
        if (
          Number.isFinite(skipTs) &&
          skipTs > 0 &&
          Date.now() - skipTs < 30 * 60 * 1000
        ) {
          // Within the 30-min grace window — let them through.
          return;
        }
      } catch {
        // localStorage unavailable (SSR, private mode) — proceed with gate.
      }
      router.replace("/edge/intents");
    })();
    return () => {
      cancelled = true;
    };
  }, [
    status,
    session?.user?.id,
    session?.user?.partner,
    session?.user?.indexLastIntentAt,
    router,
  ]);

  // Close dropdown when clicking outside (suppressed when tour controls it)
  useEffect(() => {
    if (!moreOpen) return;
    function handleClick(e: MouseEvent) {
      if (tourControllingMore.current) return;
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [moreOpen]);

  // Close dropdown on route change (suppressed when tour controls it)
  useEffect(() => {
    if (!tourControllingMore.current) {
      setMoreOpen(false);
    }
  }, [pathname]);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/signin");
    }
  }, [status, router]);

  // ── Dashboard access gate (Phase 3) ──
  // When NEXT_PUBLIC_ENABLE_DASHBOARD_GATE=true, check subscription status.
  // WLD-only users (no active subscription) see a dimmed preview + upgrade prompt.
  // Exempt routes: /billing, /settings — always accessible for account management.
  useEffect(() => {
    if (status !== "authenticated") return;
    if (process.env.NEXT_PUBLIC_ENABLE_DASHBOARD_GATE !== "true") {
      setGateChecked(true);
      return;
    }

    // Exempt routes — always accessible
    const exemptPaths = ["/billing", "/settings", "/upgrade"];
    if (exemptPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      setGateChecked(true);
      setGated(false);
      return;
    }

    fetch("/api/billing/status")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        const sub = data?.subscription;
        const isActive = sub?.status === "active" || sub?.status === "trialing";
        const isPastDueGrace = sub?.status === "past_due";
        if (!isActive && !isPastDueGrace) {
          setGated(true);
        }
        setGateChecked(true);
      })
      .catch(() => {
        // Can't check — don't gate (fail open)
        setGateChecked(true);
      });
  }, [status, pathname]);

  // Auto-detect browser timezone and sync to backend if it differs.
  // This catches pre-feature users (before Feb 21) who defaulted to America/New_York,
  // and keeps timezone current if a user travels or changes system settings.
  useEffect(() => {
    if (status !== "authenticated") return;
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browserTz) return;
    fetch("/api/settings/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sync_timezone", timezone: browserTz }),
    }).catch(() => {}); // Silent — never block UI
  }, [status]);

  // Poll heartbeat health for nav dot
  useEffect(() => {
    if (status !== "authenticated") return;
    const poll = () =>
      fetch("/api/heartbeat/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d?.healthStatus) setHeartbeatHealth(d.healthStatus); })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 60_000);
    return () => clearInterval(t);
  }, [status]);

  if (status === "loading" || status === "unauthenticated" || needsOnboarding) {
    return null;
  }

  // Gate not yet checked — don't flash content
  if (process.env.NEXT_PUBLIC_ENABLE_DASHBOARD_GATE === "true" && !gateChecked) {
    return null;
  }

  // ── Sidebar render path (Phase 1, flag-gated) ───────────────────────────
  // When navMode === "sidebar", render the new left-sidebar workspace chrome.
  // This is an ADDITIVE early-return: every hook, redirect gate, and the
  // auth/null-render guards above run identically in both modes (they precede
  // this branch). The top-nav `return` below is left BYTE-IDENTICAL to
  // origin/main, so flipping the flag off (env unset / ?nav=topnav / clear
  // localStorage) is a provable, instant rollback. The wizard is invoked
  // exactly as the top-nav path for now; the navMode-aware tour lands in the
  // Phase 1 tour milestone.
  if (navMode === "sidebar") {
    return (
      <div className="min-h-screen" data-theme="dashboard">
        <SidebarShell
          pathname={pathname}
          session={session}
          heartbeatHealth={heartbeatHealth}
          drawerOpen={drawerOpen}
          setDrawerOpen={setDrawerOpen}
        >
          {children}
        </SidebarShell>

        {gated && (
          <DashboardGateOverlay
            onUpgrade={() => router.push("/upgrade")}
            onManageBilling={() => router.push("/billing")}
          />
        )}

        <OnboardingWizard
          setMoreOpen={setMoreOpen}
          tourControllingMore={tourControllingMore}
        />
      </div>
    );
  }

  // Effective feature items — The Floor for everyone, + Edge City for edge
  // attendees. These render at the top of the "···" menu.
  const features =
    session?.user?.partner === "edge_city"
      ? [...featuresNav, edgeCityNavItem]
      : featuresNav;

  // Highlight the "···" button when the current page lives in the overflow menu
  // (features OR utility), so the active state follows demoted routes.
  const isOverflowActive = [...features, ...overflowNav].some(
    (item) => pathname === item.href,
  );

  // Command Center (/tasks) is the one dashboard route that must be
  // viewport-locked: its chat input pins to the bottom of the screen and the
  // task/message area scrolls above it, like a native chat app. Every other
  // route is a normal document-scroll page (min-h-screen). We give /tasks a
  // full-height flex column so the page can fill exactly the space left after
  // the nav + any conditional banners (AgentbookHatBanner / ChannelNudgeBanner)
  // — the browser computes that remaining height via flexbox, so the input
  // never falls below the fold no matter what renders above. The page used to
  // hard-code `h-[calc(100dvh-4rem)]` + negative margins to guess that offset;
  // adding the banners later silently pushed the input off-screen (the offset
  // was never updated). See the page-root comment in tasks/page.tsx.
  const isCommandCenter = pathname === "/tasks";

  return (
    <div
      className={isCommandCenter ? "h-dvh overflow-hidden flex flex-col" : "min-h-screen"}
      data-theme="dashboard"
    >
      {/* Top nav */}
      <nav
        className="border-b transition-colors shrink-0"
        style={{ borderColor: "var(--border)", background: "var(--background)" }}
      >
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-1 text-xl tracking-[-0.5px] transition-opacity hover:opacity-70 shrink-0" style={{ fontFamily: "var(--font-serif)" }}>
            <Image src="/logo.png" alt="InstaClaw" width={44} height={44} unoptimized style={{ imageRendering: "pixelated" }} />
            <span className="hidden sm:inline">Instaclaw</span>
          </Link>

          <div className="flex items-center gap-1">
            {/* Primary items — always visible, with sliding glass pill.
                These five reflect what a user reaches for every session.
                Lower-frequency surfaces (The Floor, Edge City for edge
                attendees, utility, account) live in the "···" overflow
                menu below. */}
            {primaryNav.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-tour={item.tourKey}
                  className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm transition-colors"
                  style={{
                    color: isActive ? "var(--foreground)" : "var(--muted)",
                  }}
                >
                  {isActive && (
                    <motion.div
                      layoutId="nav-pill"
                      className="absolute inset-0 rounded-lg"
                      style={{
                        background: "rgba(0,0,0,0.06)",
                        boxShadow: "0 0 0 1px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
                        backdropFilter: "blur(8px)",
                      }}
                      transition={{
                        type: "spring",
                        stiffness: 400,
                        damping: 30,
                      }}
                    />
                  )}
                  <item.icon className="w-4 h-4 relative z-10" />
                  <span className="hidden sm:inline relative z-10">{item.label}</span>
                </Link>
              );
            })}

            {/* More button + dropdown for overflow items */}
            <div className="relative" ref={moreRef}>
              <button
                data-tour="nav-more"
                onClick={() => setMoreOpen((v) => !v)}
                aria-label="More options"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                title="More"
                className="flex items-center justify-center w-9 h-9 rounded-full text-sm transition-snappy transition-colors"
                style={{
                  color: isOverflowActive || moreOpen ? "var(--foreground)" : "var(--muted)",
                  background: isOverflowActive || moreOpen ? "rgba(0,0,0,0.07)" : "rgba(0,0,0,0.03)",
                  boxShadow: "0 0 0 1px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
                  backdropFilter: "blur(8px)",
                }}
              >
                <span className="relative">
                  <MoreHorizontal className="w-4 h-4" />
                  {heartbeatHealth && heartbeatHealth !== "healthy" && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
                      style={{
                        background:
                          heartbeatHealth === "unhealthy"
                            ? "#ef4444"
                            : "#9ca3af",
                      }}
                    />
                  )}
                </span>
              </button>

              {moreOpen && (
                <div
                  data-tour-dropdown="more"
                  className="absolute right-0 top-full mt-2 w-48 rounded-xl py-1"
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
                    zIndex: tourControllingMore.current ? 9999 : 50,
                  }}
                >
                  {/* Features — lower-frequency product surfaces. Edge City
                      only appears for edge_city attendees. Routes unchanged;
                      these items simply moved out of the always-visible row. */}
                  {features.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      data-tour={item.tourKey}
                      className="flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors"
                      style={{
                        color: pathname === item.href ? "var(--foreground)" : "var(--muted)",
                        background: pathname === item.href ? "rgba(0,0,0,0.04)" : "transparent",
                      }}
                    >
                      <item.icon className="w-4 h-4" />
                      {item.label}
                    </Link>
                  ))}
                  <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                  {/* Utility + account */}
                  {overflowNav.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      data-tour={item.tourKey}
                      className="flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors"
                      style={{
                        color: pathname === item.href ? "var(--foreground)" : "var(--muted)",
                        background: pathname === item.href ? "rgba(0,0,0,0.04)" : "transparent",
                      }}
                    >
                      <item.icon className="w-4 h-4" />
                      {item.label}
                    </Link>
                  ))}
                  <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                  <a
                    href="mailto:help@instaclaw.io"
                    className="flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors"
                    style={{ color: "var(--muted)" }}
                  >
                    <Mail className="w-4 h-4" />
                    Support
                  </a>
                  <button
                    onClick={() => signOut({ callbackUrl: "/" })}
                    className="flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors w-full cursor-pointer"
                    style={{ color: "var(--muted)" }}
                  >
                    <LogOut className="w-4 h-4" />
                    Sign Out
                  </button>
                </div>
              )}
            </div>

            {/* Restart wizard button */}
            <button
              onClick={async () => {
                await fetch("/api/onboarding/restart-wizard", { method: "PATCH" });
                window.dispatchEvent(new Event("instaclaw:restart-wizard"));
              }}
              className="w-8 h-8 flex items-center justify-center rounded-lg cursor-pointer transition-all hover:bg-black/[0.06] active:scale-95"
              style={{ color: "var(--muted)" }}
              title="Take the tour again"
            >
              <Sparkles className="w-4 h-4" />
            </button>
          </div>
        </div>
      </nav>

      {/* Site-wide banners — sit between nav and main so they appear above the
          page heading on every dashboard route. Wrapped in a shrink-0 box so
          that under the Command Center's flex-column layout they keep their
          natural height (never compressed) and `<main>` fills exactly the
          space below them. In the normal min-h-screen layout the wrapper is
          inert. Each banner returns null when not eligible, so the wrapper
          adds no whitespace when nothing is shown.
            - AgentbookHatBanner: hat-claim strip (registered/dismissed/first-visit gated)
            - ChannelNudgeBanner: web-only-user nudge (14-day dismiss gated) */}
      <div className="shrink-0">
        <AgentbookHatBanner />
        <ChannelNudgeBanner />
      </div>

      {/* Content. Command Center fills the remaining viewport height as a flex
          child (so its chat input pins to the bottom); every other route is a
          normal padded, document-scrolling container. */}
      <main
        className={
          isCommandCenter
            ? "flex-1 min-h-0 w-full max-w-6xl mx-auto px-4"
            : "max-w-6xl mx-auto px-4 py-12 sm:py-16"
        }
      >
        {children}
      </main>

      {/* ── Dashboard Gate Overlay (Phase 3) ── */}
      {gated && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9998,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
          }}
        >
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "1.25rem",
              padding: "2.5rem",
              maxWidth: "420px",
              width: "90%",
              textAlign: "center",
              boxShadow: "0 24px 64px rgba(0,0,0,0.2)",
            }}
          >
            <h2
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: "1.5rem",
                fontWeight: 400,
                marginBottom: "0.75rem",
              }}
            >
              Upgrade to unlock the dashboard
            </h2>
            <p
              style={{
                color: "var(--muted)",
                fontSize: "0.875rem",
                lineHeight: 1.6,
                marginBottom: "1.5rem",
              }}
            >
              Your agent is running via World App and Telegram.
              Subscribe to unlock the full web dashboard, daily credit refresh,
              and all features.
            </p>
            <button
              onClick={() => router.push("/upgrade")}
              style={{
                width: "100%",
                padding: "0.875rem",
                borderRadius: "0.75rem",
                fontSize: "0.9rem",
                fontWeight: 600,
                color: "#fff",
                border: "none",
                cursor: "pointer",
                background: "linear-gradient(180deg, rgba(220,103,67,0.95), rgba(200,85,52,1))",
                boxShadow: "0 2px 8px rgba(220,103,67,0.3)",
                marginBottom: "0.75rem",
              }}
            >
              View plans — from $49.99/mo
            </button>
            <button
              onClick={() => router.push("/billing")}
              style={{
                width: "100%",
                padding: "0.75rem",
                borderRadius: "0.75rem",
                fontSize: "0.8rem",
                fontWeight: 500,
                color: "var(--muted)",
                background: "rgba(0,0,0,0.04)",
                border: "1px solid var(--border)",
                cursor: "pointer",
              }}
            >
              Manage billing
            </button>
          </div>
        </div>
      )}

      {/* Onboarding wizard (persists across page navigations) */}
      <OnboardingWizard
        setMoreOpen={setMoreOpen}
        tourControllingMore={tourControllingMore}
      />
    </div>
  );
}
