"use client";

import { motion } from "motion/react";
import {
  Zap,
  Terminal,
  Shield,
  Brain,
  CreditCard,
  Globe,
  Fingerprint,
} from "lucide-react";

const features = [
  {
    icon: Zap,
    title: "Instant Deployment",
    description:
      "Go from zero to a live OpenClaw instance in minutes. No DevOps required.",
  },
  {
    icon: Terminal,
    title: "Full Shell Access",
    description:
      "Your own dedicated VM with shell access, file system, and browser automation.",
  },
  {
    icon: Shield,
    title: "Always On",
    description:
      "99.9% uptime with auto-healing. Your instance never sleeps, even when you do.",
  },
  {
    icon: Brain,
    title: "Skills & Memory",
    description:
      "Full OpenClaw feature set — skills, persistent memory, and custom configurations.",
  },
  {
    icon: CreditCard,
    title: "Simple Pricing",
    description:
      "Flat monthly fee, everything included. Or bring your own API key and save.",
  },
  {
    icon: Globe,
    title: "BYOK Option",
    description:
      "Bring your own Anthropic API key for maximum flexibility and lower costs.",
  },
  {
    icon: Fingerprint,
    title: "Human Verification",
    description:
      "Prove there's a real person behind your agent. Verified agents earn a public trust badge — powered by World ID's privacy-preserving proof of personhood.",
  },
];

export function Features() {
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
            Everything You Need
          </h2>
          <p style={{ color: "var(--muted)" }}>
            A full OpenClaw instance, zero complexity.
          </p>
        </motion.div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              className="glass rounded-xl p-6"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ delay: i * 0.1, duration: 0.6 }}
            >
              <feature.icon
                className="w-8 h-8 mb-4 text-white"
              />
              <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
              <p
                className="text-sm leading-relaxed"
                style={{ color: "var(--muted)" }}
              >
                {feature.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
