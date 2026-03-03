"use client";

import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";

const navLinks = [
  { href: "/pricing", label: "Pricing" },
  { href: "/how-it-works", label: "How It Works" },
  { href: "/use-cases", label: "Use Cases" },
  { href: "/faq", label: "FAQ" },
  { href: "/blog", label: "Blog" },
  { href: "/docs", label: "Docs" },
];

export function SiteHeader() {
  const { data: session } = useSession();

  return (
    <header
      className="sticky top-0 z-50 py-4 px-4 sm:px-6"
      style={{
        background: "rgba(248, 247, 244, 0.85)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
      }}
    >
      <div className="max-w-5xl mx-auto flex items-center justify-between">
        <Link href="/" className="flex items-center gap-1">
          <Image
            src="/logo.png"
            alt="InstaClaw"
            width={36}
            height={36}
            unoptimized
            style={{ imageRendering: "pixelated" }}
          />
          <span
            className="text-lg tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            Instaclaw
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-6">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm transition-colors hover:opacity-70"
              style={{ color: "#6b6b6b" }}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <Link
          href={session ? "/dashboard" : "/signup"}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
          style={{
            background:
              "linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            boxShadow: `
              rgba(0,0,0,0.05) 0px 2px 2px 0px inset,
              rgba(255,255,255,0.5) 0px -2px 2px 0px inset,
              rgba(0,0,0,0.1) 0px 2px 4px 0px,
              rgba(255,255,255,0.2) 0px 0px 1.6px 4px inset
            `,
            color: "#333334",
          }}
        >
          {session ? "Dashboard" : "Sign Up"}
        </Link>
      </div>
    </header>
  );
}
