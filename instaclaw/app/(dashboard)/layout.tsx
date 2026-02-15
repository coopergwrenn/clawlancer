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
  MessageSquare,
  Clock,
  FolderOpen,
  Key,
  MoreHorizontal,
  ClipboardList,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";

// Primary items always visible on mobile
const primaryNav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tasks", label: "Command Center", icon: ClipboardList },
  { href: "/history", label: "History", icon: MessageSquare },
];

// Overflow items shown in the "more" menu on mobile, visible on lg+
const overflowNav = [
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/scheduled", label: "Scheduled", icon: Clock },
  { href: "/env-vars", label: "API Keys", icon: Key },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/billing", label: "Billing", icon: CreditCard },
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

  const needsOnboarding =
    status !== "loading" && session?.user && !session.user.onboardingComplete;

  useEffect(() => {
    if (needsOnboarding) {
      router.replace("/connect");
    }
  }, [needsOnboarding, router]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!moreOpen) return;
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [moreOpen]);

  // Close dropdown on route change
  useEffect(() => {
    setMoreOpen(false);
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
            {/* Primary items — always visible */}
            {primaryNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm transition-snappy transition-colors"
                style={{
                  color: pathname === item.href ? "var(--foreground)" : "var(--muted)",
                  background: pathname === item.href ? "rgba(0,0,0,0.06)" : "transparent",
                }}
              >
                <item.icon className="w-4 h-4" />
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            ))}

            {/* More button + dropdown for overflow items */}
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setMoreOpen((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm transition-snappy transition-colors"
                style={{
                  color: isOverflowActive || moreOpen ? "var(--foreground)" : "var(--muted)",
                  background: isOverflowActive || moreOpen ? "rgba(0,0,0,0.06)" : "transparent",
                }}
              >
                <MoreHorizontal className="w-4 h-4" />
                <span className="hidden sm:inline">More</span>
              </button>

              {moreOpen && (
                <div
                  className="absolute right-0 top-full mt-2 w-48 rounded-xl py-1 z-50"
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
                  }}
                >
                  {overflowNav.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
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
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-12 sm:py-16">{children}</main>
    </div>
  );
}
