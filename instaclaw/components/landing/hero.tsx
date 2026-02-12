"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "motion/react";
import { useSession } from "next-auth/react";
import { WaitlistForm } from "./waitlist-form";
import { SpotsCounter } from "./spots-counter";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

export function Hero() {
  const { data: session } = useSession();

  return (
    <section className="relative min-h-[80vh] sm:min-h-screen flex flex-col items-center justify-center px-4 pt-28 sm:pt-0 pb-12 sm:pb-16 overflow-hidden">
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
              background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
              backdropFilter: "blur(2px)",
              WebkitBackdropFilter: "blur(2px)",
              boxShadow: `
                rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
                rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
                rgba(0, 0, 0, 0.1) 0px 2px 4px 0px,
                rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
              `,
              color: "var(--foreground)",
            }}
          >
            Dashboard
          </Link>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              href="/signin"
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
              style={{
                color: "var(--foreground)",
                opacity: 0.7,
              }}
            >
              Sign In
            </Link>
            <button
              onClick={() => {
                const el = document.getElementById("waitlist-email");
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                  setTimeout(() => el.focus(), 400);
                }
              }}
              className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all"
              style={{
                background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
                backdropFilter: "blur(2px)",
                WebkitBackdropFilter: "blur(2px)",
                boxShadow: `
                  rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
                  rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
                  rgba(0, 0, 0, 0.1) 0px 2px 4px 0px,
                  rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
                `,
                color: "var(--foreground)",
              }}
            >
              Sign Up
            </button>
          </div>
        )}
      </motion.div>

      <motion.div
        className="relative z-10 max-w-3xl w-full text-center space-y-8"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: SNAPPY }}
      >
        {/* Live spots counter */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.5, ease: SNAPPY }}
        >
          <SpotsCounter />
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
          className="text-base sm:text-xl max-w-md sm:max-w-xl mx-auto leading-[2] sm:leading-relaxed sm:text-balance"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.7, ease: SNAPPY }}
        >
          A personal AI that works for you{" "}
          <span className="relative inline-block">
            around the clock
            <motion.span
              className="absolute pointer-events-none left-0 bottom-0"
              style={{
                height: "6px",
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='6' viewBox='0 0 20 6'%3E%3Cpath d='M0,3 Q5,0.5 10,3 Q15,5.5 20,3' fill='none' stroke='%23DC6743' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E")`,
                backgroundRepeat: "repeat-x",
                backgroundSize: "20px 6px",
                transformOrigin: "left center",
              }}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "100%", opacity: 0.85 }}
              transition={{ delay: 1.4, duration: 0.6, ease: "easeOut" }}
            />
          </span>
          . It handles your tasks,{" "}
          <span className="relative inline-block">
            <motion.svg
              className="absolute pointer-events-none"
              style={{
                left: "-12px",
                top: "-6px",
                width: "calc(100% + 24px)",
                height: "calc(100% + 12px)",
              }}
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 200 100"
              preserveAspectRatio="none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.7 }}
              transition={{ delay: 1.8, duration: 0.1 }}
            >
              <motion.path
                d="M8,50 Q10,16 55,13 Q120,10 170,20 Q192,35 190,55 Q188,78 150,86 Q100,92 40,84 Q6,74 8,50"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ delay: 1.8, duration: 0.7, ease: "easeOut" }}
              />
            </motion.svg>
            <span className="relative">remembers everything</span>
          </span>
          , and gets smarter every day. Set it up in
          minutes. No technical experience required.
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
