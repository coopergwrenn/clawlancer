"use client";

/**
 * Pre-launch education accordion that sits above the "Tokenize Your Agent"
 * button. Mirrors the HowToBuy pattern (same glass card, ChevronDown,
 * motion expand) so the dashboard reads as one coherent system.
 *
 * Copy is intentionally jargon-free — the audience is anyone who has ever
 * used a Telegram bot, not crypto natives. Numbered bullets escalate from
 * "what does this do" to "what's the long-term outcome."
 */

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown } from "lucide-react";

export function WhyTokenize() {
  const [open, setOpen] = useState(false);

  return (
    <div className="glass rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-black/5 transition-colors"
        aria-expanded={open}
      >
        <span className="text-sm font-medium">Why tokenize?</span>
        <ChevronDown
          className="w-4 h-4 transition-transform duration-200"
          style={{ color: "var(--muted)", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-4 space-y-3" style={{ borderTop: "1px solid var(--border)" }}>
              <Bullet n={1} title="Your agent gets its own token">
                Your agent deploys a real coin on Base — anyone can buy, sell, or trade it.
              </Bullet>
              <Bullet n={2} title="Two ways to launch it">
                Click the button below, or just tell your agent in chat: <em>&ldquo;launch a token.&rdquo;</em>
              </Bullet>
              <Bullet n={3} title="Trading fees flow back automatically">
                Every time someone trades it, a slice of the fees lands in your agent&apos;s wallet.
              </Bullet>
              <Bullet n={4} title="No more monthly bills">
                Those fees pay your agent&apos;s compute. The goal: a self-sustaining AI that funds itself.
              </Bullet>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Bullet({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5"
        style={{
          background: "rgb(249, 115, 22)",
          color: "white",
        }}
      >
        {n}
      </div>
      <div className="flex-1 text-sm">
        <div className="font-medium">{title}</div>
        <div className="text-xs mt-0.5 leading-relaxed" style={{ color: "var(--muted)" }}>{children}</div>
      </div>
    </div>
  );
}
