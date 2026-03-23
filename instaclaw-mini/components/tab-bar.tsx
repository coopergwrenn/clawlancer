"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Sparkles, MessageCircle, Settings } from "lucide-react";

const tabs = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export default function TabBar() {
  const pathname = usePathname();

  return (
    <nav
      className="glass flex items-center justify-around px-2 pt-2"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 8px)" }}
    >
      {tabs.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className="relative flex flex-col items-center gap-0.5 px-4 py-1.5 transition-snappy"
          >
            {active && (
              <span className="absolute inset-0 rounded-xl bg-white/[0.06]" />
            )}
            <Icon
              size={22}
              strokeWidth={active ? 2.2 : 1.5}
              className={`relative transition-colors duration-200 ${
                active ? "text-accent" : "text-muted"
              }`}
            />
            <span
              className={`relative text-[10px] font-medium tracking-wide transition-colors duration-200 ${
                active ? "text-accent" : "text-muted"
              }`}
            >
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
