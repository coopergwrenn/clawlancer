"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "motion/react";
import { signIn, useSession } from "next-auth/react";
import { WaitlistForm } from "./waitlist-form";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

export function Hero() {
  const { data: session } = useSession();

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-4 pb-24 sm:pb-16 overflow-hidden">
      {/* Top-left logo */}
      <motion.div
        className="absolute top-6 left-6 z-20"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.5, ease: SNAPPY }}
      >
        <Link href="/" className="flex items-center gap-1">
          <Image src="/logo.png" alt="Instaclaw" width={44} height={44} unoptimized style={{ imageRendering: "pixelated" }} />
          <span className="text-xl tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>
            Instaclaw
          </span>
        </Link>
      </motion.div>

      {/* Top-right Sign In / Dashboard */}
      <motion.div
        className="absolute top-6 right-6 z-20"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.5, ease: SNAPPY }}
      >
        {session ? (
          <Link
            href="/dashboard"
            className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
            style={{
              background: "var(--accent)",
              color: "#ffffff",
            }}
          >
            Dashboard
          </Link>
        ) : (
          <button
            onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all"
            style={{
              border: "1px solid var(--foreground)",
              color: "var(--foreground)",
              background: "transparent",
            }}
          >
            Sign In
          </button>
        )}
      </motion.div>

      <motion.div
        className="relative z-10 max-w-3xl w-full text-center space-y-8"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: SNAPPY }}
      >
        {/* Coming Soon badge */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.5, ease: SNAPPY }}
        >
          <span
            className="inline-block px-4 py-1.5 rounded-full text-xs font-medium tracking-wide uppercase"
            style={{
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          >
            Coming Soon
          </span>
        </motion.div>

        {/* Headline */}
        <motion.h1
          className="text-5xl sm:text-6xl lg:text-[80px] font-normal tracking-[-1.5px] leading-[1.05]"
          style={{ fontFamily: "var(--font-serif)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.7, ease: SNAPPY }}
        >
          Your Own OpenClaw.
          <br />
          Live in Minutes.
        </motion.h1>

        {/* Subtext */}
        <motion.p
          className="text-lg sm:text-xl max-w-xl mx-auto leading-relaxed"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.7, ease: SNAPPY }}
        >
          The easiest way to deploy your own OpenClaw instance — shell access,
          browser automation, skills, memory, everything. No DevOps required.
        </motion.p>

        {/* Waitlist CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7, duration: 0.7, ease: SNAPPY }}
        >
          <WaitlistForm />
        </motion.div>

        {/* Already have an invite? */}
        <motion.p
          className="text-sm"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1, duration: 0.7, ease: SNAPPY }}
        >
          Already have an invite code?{" "}
          <Link
            href="/signup"
            className="underline hover:opacity-80 transition-opacity"
            style={{ color: "var(--foreground)" }}
          >
            Sign up here
          </Link>
        </motion.p>


      </motion.div>
    </section>
  );
}
