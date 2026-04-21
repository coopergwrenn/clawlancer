"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, Copy, Check, ExternalLink } from "lucide-react";

interface HowToBuyProps {
  tokenAddress: string;
  tokenSymbol: string | null;
}

export function HowToBuy({ tokenAddress, tokenSymbol }: HowToBuyProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"address" | "command" | null>(null);
  const shortAddr = `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`;
  const symbol = (tokenSymbol ?? "TOKEN").toUpperCase();
  const buyCommand = `buy $20 of $${symbol}`;

  async function copy(text: string, kind: "address" | "command") {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="glass rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-black/5 transition-colors"
        aria-expanded={open}
      >
        <span className="text-sm font-medium">How to buy</span>
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
              <Step n={1} text="Open the Bankr Terminal">
                <a
                  href="https://bankr.bot/terminal"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] px-2.5 py-1 rounded-md flex items-center gap-1 font-medium hover:scale-[1.02] active:scale-[0.98] transition-transform"
                  style={{
                    background: "linear-gradient(180deg, #f5a623 0%, #d4911d 100%)",
                    color: "white",
                    textShadow: "0 1px 1px rgba(0,0,0,0.12)",
                  }}
                >
                  Open <ExternalLink className="w-3 h-3" />
                </a>
              </Step>

              <Step n={2} text="Copy this token's address">
                <button
                  type="button"
                  onClick={() => copy(tokenAddress, "address")}
                  className="text-[11px] px-2.5 py-1 rounded-md flex items-center gap-1.5 font-mono hover:bg-black/10 transition-colors"
                  style={{ background: "rgba(0,0,0,0.04)", border: "1px solid var(--border)" }}
                  aria-label="Copy token contract address"
                >
                  {copied === "address" ? (
                    <>
                      <Check className="w-3 h-3 text-green-600" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <span>{shortAddr}</span>
                      <Copy className="w-3 h-3" />
                    </>
                  )}
                </button>
              </Step>

              <Step n={3} text="Tell Bankr what to buy">
                <button
                  type="button"
                  onClick={() => copy(buyCommand, "command")}
                  className="text-[11px] px-2.5 py-1 rounded-md flex items-center gap-1.5 font-mono hover:bg-black/10 transition-colors"
                  style={{ background: "rgba(0,0,0,0.04)", border: "1px solid var(--border)" }}
                  aria-label="Copy buy command"
                >
                  {copied === "command" ? (
                    <>
                      <Check className="w-3 h-3 text-green-600" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <span>{buyCommand}</span>
                      <Copy className="w-3 h-3" />
                    </>
                  )}
                </button>
              </Step>

              <Step n={4} text="Trading fees flow back to this agent automatically" />

              <p className="text-[11px] leading-relaxed pt-1" style={{ color: "var(--muted)" }}>
                Bankr-launched tokens live in Uniswap V4 / Doppler pools — trade them on{" "}
                <a
                  href="https://bankr.bot/terminal"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:opacity-70"
                >
                  Bankr
                </a>{" "}
                or{" "}
                <a
                  href={`https://dexscreener.com/base/${tokenAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:opacity-70"
                >
                  DexScreener
                </a>
                , not the standard Uniswap frontend.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Step({ n, text, children }: { n: number; text: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0"
        style={{
          background: "linear-gradient(135deg, #f5a623, #d4911d)",
          color: "white",
          textShadow: "0 1px 1px rgba(0,0,0,0.15)",
        }}
      >
        {n}
      </div>
      <div className="flex-1 text-sm">{text}</div>
      {children}
    </div>
  );
}
