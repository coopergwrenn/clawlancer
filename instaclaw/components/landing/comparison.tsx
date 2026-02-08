"use client";

import { motion } from "motion/react";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

const rows = [
  {
    old: "Provision and maintain servers",
    new: "No infrastructure to manage",
  },
  {
    old: "Configure Docker, SSH, and networking",
    new: "Full OpenClaw instance in minutes",
  },
  {
    old: "Handle API keys and rate limits",
    new: "Built-in Claude API or bring your own key",
  },
  {
    old: "Monitor uptime and restarts",
    new: "99.9% uptime, auto-healing",
  },
  {
    old: "Debug deployment issues yourself",
    new: "Shell access, skills, memory — everything",
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
                      className="shrink-0 mt-0.5 text-sm"
                      style={{ color: "rgba(200, 80, 60, 0.5)" }}
                    >
                      ✕
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
                      className="shrink-0 mt-0.5 text-sm"
                      style={{ color: "var(--accent)" }}
                    >
                      ✓
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

        {/* Bottom punchline */}
        <motion.p
          className="text-center mt-10 text-sm sm:text-base font-medium"
          style={{ color: "var(--accent)" }}
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
