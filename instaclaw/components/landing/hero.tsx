"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { signIn, useSession } from "next-auth/react";
import { WaitlistForm } from "./waitlist-form";

export function Hero() {
  const { data: session } = useSession();

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-4 overflow-hidden">
      {/* Top-right Sign In / Dashboard */}
      <motion.div
        className="absolute top-6 right-6 z-20"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.5 }}
      >
        {session ? (
          <Link
            href="/dashboard"
            className="px-4 py-2 rounded-lg text-sm font-medium transition-all hover:shadow-[0_0_20px_rgba(255,255,255,0.15)]"
            style={{
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#ffffff",
            }}
          >
            Dashboard
          </Link>
        ) : (
          <button
            onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all hover:shadow-[0_0_20px_rgba(255,255,255,0.15)]"
            style={{
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#ffffff",
            }}
          >
            Sign In
          </button>
        )}
      </motion.div>

      {/* Animated gradient orb — white/gray */}
      <div
        className="animate-orb absolute w-[500px] h-[500px] rounded-full blur-[120px] pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0.05) 50%, transparent 70%)",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
        }}
      />

      <motion.div
        className="relative z-10 max-w-3xl w-full text-center space-y-8"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      >
        {/* Coming Soon badge */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
        >
          <span
            className="inline-block px-4 py-1.5 rounded-full text-xs font-medium tracking-wide uppercase"
            style={{
              border: "1px solid rgba(255, 255, 255, 0.4)",
              color: "#ffffff",
            }}
          >
            Coming Soon
          </span>
        </motion.div>

        {/* Headline */}
        <motion.h1
          className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-tight"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.7 }}
        >
          Your Own OpenClaw.
          <br />
          <span className="text-white">Live in Minutes.</span>
        </motion.h1>

        {/* Subtext */}
        <motion.p
          className="text-lg sm:text-xl max-w-xl mx-auto leading-relaxed"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.7 }}
        >
          The easiest way to deploy your own OpenClaw instance — shell access,
          browser automation, skills, memory, everything. No DevOps required.
        </motion.p>

        {/* Waitlist CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7, duration: 0.7 }}
        >
          <WaitlistForm />
        </motion.div>

        {/* Already have an invite? */}
        <motion.p
          className="text-sm"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1, duration: 0.7 }}
        >
          Already have an invite code?{" "}
          <Link
            href="/signup"
            className="underline text-white hover:opacity-80 transition-opacity"
          >
            Sign up here
          </Link>
        </motion.p>

        {/* Trust line */}
        <motion.p
          className="text-xs tracking-wide"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2, duration: 0.7 }}
        >
          Powered by Anthropic
        </motion.p>
      </motion.div>
    </section>
  );
}
