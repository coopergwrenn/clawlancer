"use client";

import { motion } from "motion/react";
import { X, Check } from "lucide-react";

const painPoints = [
  "Provision and maintain servers",
  "Configure Docker, SSH, and networking",
  "Handle API keys and rate limits",
  "Monitor uptime and restarts",
  "Debug deployment issues yourself",
];

const benefits = [
  "No infrastructure to manage",
  "Full OpenClaw instance in minutes",
  "Built-in Claude API or bring your own key",
  "99.9% uptime, auto-healing",
  "Shell access, skills, memory — everything",
];

export function Comparison() {
  return (
    <section className="py-24 px-4">
      <div className="max-w-5xl mx-auto">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            The Old Way vs. InstaClaw
          </h2>
          <p style={{ color: "var(--muted)" }}>
            Stop fighting infrastructure. Start using OpenClaw.
          </p>
        </motion.div>

        <div className="grid gap-6 sm:grid-cols-2">
          {/* Traditional */}
          <motion.div
            className="glass rounded-xl p-8"
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
          >
            <h3
              className="text-lg font-semibold mb-6"
              style={{ color: "var(--muted)" }}
            >
              Self-Hosting OpenClaw
            </h3>
            <ul className="space-y-4">
              {painPoints.map((point) => (
                <li
                  key={point}
                  className="flex items-start gap-3 text-sm line-through"
                  style={{ color: "var(--muted)" }}
                >
                  <X className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
                  {point}
                </li>
              ))}
            </ul>
          </motion.div>

          {/* InstaClaw */}
          <motion.div
            className="glass rounded-xl p-8"
            style={{
              border: "1px solid rgba(255, 255, 255, 0.3)",
              boxShadow: "0 0 40px rgba(255, 255, 255, 0.05)",
            }}
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6, delay: 0.15 }}
          >
            <h3 className="text-lg font-semibold mb-6">With InstaClaw</h3>
            <ul className="space-y-4">
              {benefits.map((benefit) => (
                <li
                  key={benefit}
                  className="flex items-start gap-3 text-sm"
                >
                  <Check
                    className="w-4 h-4 mt-0.5 shrink-0 text-white"
                  />
                  {benefit}
                </li>
              ))}
            </ul>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
