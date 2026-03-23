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
    <nav className="flex items-center justify-around border-t border-border bg-background px-2 pb-[env(safe-area-inset-bottom)] pt-2">
      {tabs.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex flex-col items-center gap-0.5 px-3 py-1.5 text-xs transition-colors ${
              active ? "text-accent" : "text-muted"
            }`}
          >
            <Icon size={22} strokeWidth={active ? 2.2 : 1.5} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
