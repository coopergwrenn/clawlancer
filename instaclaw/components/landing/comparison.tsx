"use client";

import { motion } from "motion/react";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

const rows = [
  {
    old: "Provision servers, configure DNS, manage SSL certs",
    new: "Click a button. You're live.",
  },
  {
    old: "Set up Docker, SSH tunnels, and reverse proxies",
    new: "Everything works out of the box",
  },
  {
    old: "Manage API keys, rate limits, and token budgets",
    new: "AI is built in and ready to go",
  },
  {
    old: "Monitor uptime, restart crashed processes, rotate logs",
    new: "Always on. Fixes itself if anything breaks.",
  },
  {
    old: "Debug networking, permissions, and dependency conflicts",
    new: "Just tell it what to do",
  },
];

export function Comparison() {
  return (
    <section className="py-16 sm:py-[12vh] px-4">
      <div className="max-w-3xl mx-auto">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          <h2
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            The Old Way vs. InstaClaw
          </h2>
        </motion.div>

        {/* Column headers */}
        <motion.div
          className="flex gap-6 sm:gap-10"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          <div className="flex-1 pb-4">
            <span
              className="text-xs sm:text-sm uppercase tracking-[2px]"
              style={{ color: "var(--muted)" }}
            >
              Self-Hosting
            </span>
          </div>
          <div className="flex-1 pb-4">
            <span
              className="text-xs sm:text-sm uppercase tracking-[2px] font-medium"
              style={{ color: "var(--accent)" }}
            >
              InstaClaw
            </span>
          </div>
        </motion.div>

        {/* Rows */}
        <div className="space-y-0">
          {rows.map((row, i) => (
            <motion.div
              key={i}
              className="relative"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ delay: i * 0.08, duration: 0.6, ease: SNAPPY }}
            >
              {/* Top border */}
              <div
                className="h-px w-full"
                style={{ background: "var(--border)" }}
              />

              <div className="flex gap-6 sm:gap-10">
                {/* Old way */}
                <div className="flex-1 py-6 sm:py-8">
                  <div className="flex items-start gap-3">
                    <span
                      className="shrink-0 mt-0.5 flex items-center justify-center w-5 h-5 rounded-full"
                      style={{
                        background: "radial-gradient(circle at 40% 35%, rgba(160,160,160,0.15), rgba(120,120,120,0.08) 70%)",
                        boxShadow: "inset 0 1px 2px rgba(255,255,255,0.3), inset 0 -1px 2px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)",
                      }}
                    >
                      <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none">
                        <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="rgba(160,130,120,0.5)" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </span>
                    <p
                      className="text-sm sm:text-base leading-relaxed line-through decoration-1"
                      style={{ color: "var(--muted)" }}
                    >
                      {row.old}
                    </p>
                  </div>
                </div>

                {/* New way */}
                <div
                  className="flex-1 py-6 sm:py-8 px-5 sm:px-6 rounded-lg"
                  style={{ background: "rgba(220, 103, 67, 0.04)" }}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="shrink-0 mt-0.5 flex items-center justify-center w-5 h-5 rounded-full"
                      style={{
                        background: "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.25), rgba(220,103,67,0.12) 70%)",
                        boxShadow: "inset 0 1px 2px rgba(255,255,255,0.4), inset 0 -1px 2px rgba(0,0,0,0.1), 0 1px 3px rgba(220,103,67,0.1)",
                      }}
                    >
                      <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none">
                        <path d="M2.5 5.5l2 2 3.5-4" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <p className="text-sm sm:text-base leading-relaxed font-medium">
                      {row.new}
                    </p>
                  </div>
                </div>
              </div>

              {/* Bottom border on last item */}
              {i === rows.length - 1 && (
                <div
                  className="h-px w-full"
                  style={{ background: "var(--border)" }}
                />
              )}
            </motion.div>
          ))}
        </div>

        {/* Bottom punchline with shimmer. font-family is the only thing
            changed here vs the shimmer-text class — the orange→gold→orange
            background-clip + animation in globals.css stays untouched. */}
        <motion.p
          className="text-center mt-10 text-sm sm:text-base font-semibold shimmer-text"
          style={{ fontFamily: "var(--font-serif)" }}
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ delay: 0.4, duration: 0.6, ease: SNAPPY }}
        >
          Skip the setup. Be live in minutes.
        </motion.p>
      </div>
    </section>
  );
}
