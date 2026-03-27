"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Sparkles, MessageCircle, Settings } from "lucide-react";
import { useRef, useEffect, useState } from "react";

const tabs = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export default function TabBar() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const [pillStyle, setPillStyle] = useState({ left: 0, width: 0 });

  // Calculate active tab position for sliding pill
  const activeIndex = tabs.findIndex((t) => pathname.startsWith(t.href));

  useEffect(() => {
    if (!navRef.current || activeIndex < 0) return;
    const navEl = navRef.current;
    const links = navEl.querySelectorAll<HTMLAnchorElement>("a[data-tab]");
    const activeLink = links[activeIndex];
    if (activeLink) {
      const navRect = navEl.getBoundingClientRect();
      const linkRect = activeLink.getBoundingClientRect();
      setPillStyle({
        left: linkRect.left - navRect.left,
        width: linkRect.width,
      });
    }
  }, [activeIndex]);

  return (
    <nav
      ref={navRef}
      className="relative flex items-center justify-around px-2 pt-2"
      style={{
        paddingBottom: "max(env(safe-area-inset-bottom), 8px)",
        background: "rgba(10, 10, 10, 0.7)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderTop: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      {/* Sliding glass pill */}
      {pillStyle.width > 0 && (
        <div
          className="absolute rounded-xl"
          style={{
            left: pillStyle.left,
            width: pillStyle.width,
            top: "6px",
            bottom: "max(env(safe-area-inset-bottom, 6px), 6px)",
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.06)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 1px 4px rgba(0,0,0,0.1)",
            backdropFilter: "blur(8px)",
            transition: "left 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), width 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)",
            pointerEvents: "none",
          }}
        />
      )}

      {tabs.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            data-tab
            className="relative z-10 flex flex-col items-center gap-0.5 px-4 py-1.5"
          >
            <Icon
              size={22}
              strokeWidth={active ? 2.2 : 1.5}
              className="transition-all duration-300"
              style={{
                color: active ? "#DC6743" : "rgba(255,255,255,0.35)",
                transform: active ? "scale(1.05)" : "scale(1)",
                filter: active ? "drop-shadow(0 0 6px rgba(220,103,67,0.3))" : "none",
              }}
            />
            <span
              className="text-[10px] font-medium tracking-wide transition-all duration-300"
              style={{
                color: active ? "#DC6743" : "rgba(255,255,255,0.35)",
              }}
            >
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
