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
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { motion } from "motion/react";
import OnboardingWizard from "@/components/onboarding-wizard/OnboardingWizard";

// Primary items always visible on mobile
const primaryNav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, tourKey: "nav-dashboard" },
  { href: "/tasks", label: "Command Center", icon: MessageSquare, tourKey: "nav-command-center" },
  { href: "/history", label: "History", icon: History, tourKey: "nav-history" },
];

// Overflow items shown in the "more" menu on mobile, visible on lg+
const overflowNav = [
  { href: "/files", label: "Files", icon: FolderOpen, tourKey: "nav-files" },
  { href: "/scheduled", label: "Scheduled", icon: Clock, tourKey: "nav-scheduled" },
  { href: "/env-vars", label: "API Keys", icon: Key, tourKey: "nav-api-keys" },
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

  const needsOnboarding =
    status !== "loading" && session?.user && !session.user.onboardingComplete;

  useEffect(() => {
    if (needsOnboarding) {
      router.replace("/connect");
    }
  }, [needsOnboarding, router]);

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

  if (status === "loading" || needsOnboarding) {
    return null;
  }

  // Check if current page is an overflow item (to highlight "more" button)
  const isOverflowActive = overflowNav.some((item) => pathname === item.href);

  return (
    <div className="min-h-screen" data-theme="dashboard">
      {/* Top nav */}
      <nav
        className="border-b transition-colors"
        style={{ borderColor: "var(--border)", background: "var(--background)" }}
      >
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-1 text-xl tracking-[-0.5px] transition-opacity hover:opacity-70 shrink-0" style={{ fontFamily: "var(--font-serif)" }}>
            <Image src="/logo.png" alt="InstaClaw" width={44} height={44} unoptimized style={{ imageRendering: "pixelated" }} />
            <span className="hidden sm:inline">Instaclaw</span>
          </Link>

          <div className="flex items-center gap-1">
            {/* Primary items — always visible, with sliding glass pill */}
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-snappy transition-colors"
                style={{
                  color: isOverflowActive || moreOpen ? "var(--foreground)" : "var(--muted)",
                  background: isOverflowActive || moreOpen ? "rgba(0,0,0,0.07)" : "rgba(0,0,0,0.03)",
                  boxShadow: "0 0 0 1px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
                  backdropFilter: "blur(8px)",
                }}
              >
                <MoreHorizontal className="w-4 h-4" />
                <span className="hidden sm:inline">More</span>
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

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-12 sm:py-16">{children}</main>

      {/* Onboarding wizard (persists across page navigations) */}
      <OnboardingWizard
        setMoreOpen={setMoreOpen}
        tourControllingMore={tourControllingMore}
      />
    </div>
  );
}
