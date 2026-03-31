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
  const activeIndex = tabs.findIndex((t) => pathname.startsWith(t.href));

  useEffect(() => {
    if (!navRef.current || activeIndex < 0) return;
    const links = navRef.current.querySelectorAll<HTMLAnchorElement>("a[data-tab]");
    const activeLink = links[activeIndex];
    if (activeLink) {
      const navRect = navRef.current.getBoundingClientRect();
      const linkRect = activeLink.getBoundingClientRect();
      setPillStyle({
        left: linkRect.left - navRect.left,
        width: linkRect.width,
      });
    }
  }, [activeIndex]);

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50"
      style={{
        pointerEvents: "none",
      }}
    >
      {/* Blur fade — extends well above nav so content scrolls behind smoothly */}
      <div
        className="absolute inset-0 -top-20"
        style={{
          backdropFilter: "blur(40px) saturate(1.5)",
          WebkitBackdropFilter: "blur(40px) saturate(1.5)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 35%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 35%)",
        }}
      />
      <div
        className="relative px-5"
        style={{
          paddingBottom: "max(env(safe-area-inset-bottom, 8px), 8px)",
          paddingTop: "6px",
          pointerEvents: "none",
        }}
      >
      <nav
        ref={navRef}
        className="relative flex items-center justify-around rounded-full px-1 py-1"
        style={{
          background: "rgba(20, 20, 20, 0.65)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow:
            "0 2px 16px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.03)",
          pointerEvents: "auto",
        }}
      >
        {/* Sliding pill indicator */}
        {pillStyle.width > 0 && (
          <div
            className="absolute rounded-full"
            style={{
              left: pillStyle.left,
              width: pillStyle.width,
              top: "4px",
              bottom: "4px",
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.15)",
              transition:
                "left 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), width 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)",
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
              className="relative z-10 flex flex-col items-center gap-0.5 px-5 py-2"
            >
              <Icon
                size={20}
                strokeWidth={active ? 2.2 : 1.6}
                className="transition-all duration-300"
                style={{
                  color: active ? "#fff" : "rgba(255,255,255,0.3)",
                  transform: active ? "scale(1.08)" : "scale(1)",
                  filter: active
                    ? "drop-shadow(0 0 4px rgba(218,119,86,0.25))"
                    : "none",
                }}
              />
              <span
                className="text-[10px] font-medium tracking-wide transition-all duration-300"
                style={{
                  color: active ? "#fff" : "rgba(255,255,255,0.3)",
                }}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
      </div>
    </div>
  );
}
