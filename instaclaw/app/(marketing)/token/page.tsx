"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Flame,
  Repeat,
  CreditCard,
  Code,
  ArrowRight,
  Copy,
  Check,
  ExternalLink,

} from "lucide-react";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

const CONTRACT_ADDRESS = "0xa9e23871156718c1d55e90dad1c4ea8a33480dfd";
const BASESCAN_URL = `https://basescan.org/token/${CONTRACT_ADDRESS}`;
const COINGECKO_URL = "https://www.coingecko.com/en/coins/instaclaw";
const VIRTUALS_URL = "https://app.virtuals.io/virtuals/43920";
const MEXC_URL = "https://www.mexc.com/exchange/INSTACLAW_USDT";

const glassStyle = {
  background:
    "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow: `
    rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
    rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
    rgba(0, 0, 0, 0.1) 0px 2px 4px 0px,
    rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
  `,
} as React.CSSProperties;

const orbStyle = (size = 44) =>
  ({
    width: size,
    height: size,
    borderRadius: "9999px",
    background:
      "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.18), rgba(220,103,67,0.06) 70%)",
    boxShadow:
      "inset 0 1.5px 3px rgba(255,255,255,0.4), inset 0 -1.5px 3px rgba(0,0,0,0.08), 0 1px 3px rgba(220,103,67,0.08)",
  }) as React.CSSProperties;

/* ─── Hero ───────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative min-h-[70vh] sm:min-h-[80vh] flex flex-col items-center justify-center px-4 pt-20 sm:pt-0 pb-12 overflow-hidden">
      {/* Animated background orb */}
      <div
        className="absolute animate-orb pointer-events-none"
        style={{
          width: 400,
          height: 400,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(220,103,67,0.06) 0%, transparent 70%)",
          top: "20%",
          left: "50%",
          transform: "translateX(-50%)",
        }}
      />

      <motion.div
        className="relative z-10 max-w-3xl w-full text-center space-y-8"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: SNAPPY }}
      >
        {/* Badge */}
        <motion.div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs tracking-wide"
          style={{
            ...glassStyle,
            color: "var(--muted)",
          }}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.5, ease: SNAPPY }}
        >
          <span
            className="shrink-0 flex items-center justify-center flame-orb"
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.22), rgba(220,103,67,0.08) 70%)",
            }}
          >
            <Flame
              size={12}
              strokeWidth={2}
              className="flame-icon"
              style={{ color: "var(--accent)" }}
            />
          </span>
          <span>Deflationary by design</span>
          <span
            style={{ width: 1, height: 12, background: "var(--border)", display: "inline-block" }}
          />
          <span style={{ color: "var(--accent)" }}>Virtuals Protocol</span>
          <span style={{ opacity: 0.4 }}>&middot;</span>
          <span style={{ color: "var(--accent)" }}>Base L2</span>
        </motion.div>

        {/* Headline */}
        <motion.h1
          className="text-5xl sm:text-6xl lg:text-[80px] font-normal tracking-[-1.5px] leading-[1.05]"
          style={{ fontFamily: "var(--font-serif)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.7, ease: SNAPPY }}
        >
          Every Action Burns
          <br />
          <span style={{ color: "var(--accent)" }}>$INSTACLAW</span>
        </motion.h1>

        {/* Subtext */}
        <motion.p
          className="text-base sm:text-xl max-w-xl mx-auto leading-[2] sm:leading-relaxed"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.7, ease: SNAPPY }}
        >
          Every dollar that flows through InstaClaw (subscriptions, credit
          purchases, agent token launches, trading fees) automatically buys and
          burns $INSTACLAW.
        </motion.p>

        {/* CTAs */}
        <motion.div
          className="flex flex-col sm:flex-row items-center justify-center gap-3"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7, duration: 0.7, ease: SNAPPY }}
        >
          <a
            href={VIRTUALS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="glow-wrap"
            style={{ width: "auto" }}
          >
            <div className="glow-border" style={{ width: "auto" }}>
              <div className="glow-spinner" />
              <div
                className="glow-content"
                style={{ background: "transparent" }}
              >
                <span
                  className="flex items-center gap-2 px-8 py-3.5 rounded-lg text-base font-semibold"
                  style={{
                    background:
                      "linear-gradient(180deg, rgba(220,103,67,0.95) 0%, rgba(200,85,52,1) 100%)",
                    color: "#ffffff",
                    boxShadow: `
                      rgba(255, 255, 255, 0.25) 0px 1px 1px 0px inset,
                      rgba(220, 103, 67, 0.15) 0px -2px 4px 0px inset
                    `,
                  }}
                >
                  Buy $INSTACLAW
                  <ArrowRight size={16} strokeWidth={2} />
                </span>
              </div>
            </div>
          </a>
          <a
            href={BASESCAN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-6 py-3.5 rounded-lg text-sm font-medium transition-all"
            style={{
              ...glassStyle,
              color: "var(--foreground)",
            }}
          >
            View Contract
            <ExternalLink size={14} strokeWidth={1.5} />
          </a>
        </motion.div>

        {/* Supply stats */}
        <motion.div
          className="flex items-center justify-center gap-8 sm:gap-12 pt-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1, duration: 0.6, ease: SNAPPY }}
        >
          <div className="text-center">
            <p
              className="text-2xl sm:text-3xl font-normal tracking-[-0.5px]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              1B
            </p>
            <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
              Total supply (fixed)
            </p>
          </div>
          <div
            style={{
              width: 1,
              height: 36,
              background: "var(--border)",
            }}
          />
          <div className="text-center">
            <p
              className="text-2xl sm:text-3xl font-normal tracking-[-0.5px]"
              style={{
                fontFamily: "var(--font-serif)",
                color: "var(--accent)",
              }}
            >
              28.2%
            </p>
            <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
              In circulation (~282M)
            </p>
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}

/* ─── Flywheel ───────────────────────────────────── */

const flywheelSteps = [
  { label: "Users pay for AI agents", sub: "Fiat, WLD, or trading fees" },
  { label: "Real revenue generated", sub: "Subscriptions, credits, skill fees" },
  { label: "10% routes on-chain", sub: "Automated, no human intervention" },
  { label: "Open-market buy $INSTACLAW", sub: "Daily buy-and-burn via smart contract" },
  { label: "Tokens burned forever", sub: "Permanently removed from supply" },
  { label: "Less supply, same demand", sub: "Deflationary pressure compounds" },
];

function Flywheel() {
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
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            The Flywheel
          </h2>
          <p
            className="text-sm sm:text-base max-w-md mx-auto"
            style={{ color: "var(--muted)" }}
          >
            Every cycle removes $INSTACLAW from existence. Every new user adds a
            permanent loop. The flywheel never stops.
          </p>
        </motion.div>

        {/* Flywheel ring — desktop */}
        <div className="hidden sm:block">
          <div className="relative mx-auto" style={{ width: 520, height: 520 }}>
            {/* SVG ring with animated gradient */}
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox="0 0 520 520"
            >
              <defs>
                <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="rgba(220,103,67,0.15)" />
                  <stop offset="50%" stopColor="rgba(220,103,67,0.06)" />
                  <stop offset="100%" stopColor="rgba(220,103,67,0.15)" />
                </linearGradient>
              </defs>
              <circle
                cx="260"
                cy="260"
                r="200"
                fill="none"
                stroke="url(#ring-grad)"
                strokeWidth="1.5"
                strokeDasharray="6 6"
              />
            </svg>

            {/* Orbiting glow dot */}
            <motion.div
              className="absolute"
              animate={{
                offsetDistance: ["0%", "100%"],
              }}
              transition={{
                duration: 12,
                ease: "linear",
                repeat: Infinity,
              }}
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: "#DC6743",
                boxShadow: "0 0 16px 4px rgba(220,103,67,0.4)",
                position: "absolute",
                top: "50%",
                left: "50%",
                offsetPath: "circle(200px at 0px 0px)",
              }}
            />

            {/* Nodes positioned around the circle */}
            {flywheelSteps.map((step, i) => {
              const angle = (i / flywheelSteps.length) * 2 * Math.PI - Math.PI / 2;
              const radius = 200;
              const cx = 260 + radius * Math.cos(angle);
              const cy = 260 + radius * Math.sin(angle);

              return (
                <motion.div
                  key={i}
                  className="absolute"
                  style={{
                    left: cx,
                    top: cy,
                    transform: "translate(-50%, -50%)",
                    width: 160,
                    textAlign: "center",
                  }}
                  initial={{ opacity: 0, scale: 0.8 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true, margin: "-50px" }}
                  transition={{
                    delay: 0.3 + i * 0.1,
                    duration: 0.5,
                    ease: SNAPPY,
                  }}
                >
                  {/* Node dot */}
                  <div
                    className="mx-auto mb-2"
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: "var(--accent)",
                      boxShadow: "0 0 8px rgba(220,103,67,0.3)",
                    }}
                  />
                  <p
                    className="text-xs sm:text-sm font-medium leading-tight"
                    style={{ color: "var(--foreground)" }}
                  >
                    {step.label}
                  </p>
                  <p
                    className="text-[10px] mt-0.5 leading-tight"
                    style={{ color: "var(--muted)" }}
                  >
                    {step.sub}
                  </p>
                </motion.div>
              );
            })}

            {/* Center label */}
            <div
              className="absolute flex flex-col items-center justify-center"
              style={{
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
              }}
            >
              <Repeat
                size={28}
                strokeWidth={1.2}
                style={{ color: "var(--accent)", opacity: 0.5 }}
              />
              <p
                className="text-sm mt-2 font-medium"
                style={{ color: "var(--accent)", opacity: 0.7 }}
              >
                Forever
              </p>
            </div>
          </div>
        </div>

        {/* Flywheel — mobile (vertical flow) */}
        <div className="sm:hidden space-y-0">
          {flywheelSteps.map((step, i) => (
            <motion.div
              key={i}
              className="relative"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ delay: i * 0.08, duration: 0.5, ease: SNAPPY }}
            >
              <div className="flex items-start gap-4 py-5">
                {/* Vertical line + dot */}
                <div className="flex flex-col items-center shrink-0">
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: "var(--accent)",
                      boxShadow: "0 0 8px rgba(220,103,67,0.3)",
                    }}
                  />
                  {i < flywheelSteps.length - 1 && (
                    <div
                      style={{
                        width: 1,
                        flex: 1,
                        minHeight: 32,
                        background:
                          "linear-gradient(to bottom, rgba(220,103,67,0.3), rgba(220,103,67,0.06))",
                      }}
                    />
                  )}
                </div>
                <div className="flex-1 -mt-1">
                  <p className="text-sm font-medium">{step.label}</p>
                  <p
                    className="text-xs mt-0.5"
                    style={{ color: "var(--muted)" }}
                  >
                    {step.sub}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
          {/* Loop indicator */}
          <div className="flex items-center gap-2 pl-[3px] pt-2">
            <Repeat
              size={14}
              strokeWidth={1.5}
              style={{ color: "var(--accent)", opacity: 0.5 }}
            />
            <p
              className="text-xs font-medium"
              style={{ color: "var(--accent)", opacity: 0.6 }}
            >
              Repeats forever
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── Three Burn Sources ─────────────────────────── */

const burnSources = [
  {
    icon: Flame,
    title: "The Agent Economy Loop",
    timeline: "Q2 2026",
    tagline: "Agents that pay for themselves.",
    short:
      "Every agent tokenization (via Virtuals Protocol or Bankr) triggers a burn. Every trade on an agent's token splits fees three ways: burn $INSTACLAW, fund the agent's compute, and protocol fees. Agents even burn in their sleep through 24/7 heartbeats.",
    detail:
      "InstaClaw agents can tokenize through Virtuals Protocol or Bankr. Two independent launchpads, same burn mechanic. When a user tokenizes their agent, the launch fee triggers an open-market buy-and-burn. Every subsequent trade on the agent's token generates ongoing burns. The agent literally funds its own inference from trading fees, and a portion of that spend burns $INSTACLAW. Self-funding agents create a virtuous cycle where market interest in an agent's token directly reduces $INSTACLAW supply.",
  },
  {
    icon: CreditCard,
    title: "The Silent Engine",
    timeline: "Q2\u2013Q3 2026",
    tagline: "Your subscription is burning tokens right now.",
    short:
      "10% of every subscription payment and every WLD credit purchase automatically buys and burns $INSTACLAW. Users never touch crypto. They never see a wallet. The burn is invisible.",
    detail:
      "Users pay $29\u2013$299/month via Stripe or buy credits with WLD in World App. Under the hood, 10% of revenue routes to a smart contract that executes a daily buy-and-burn. A tractor company, a record label, an insurance agency. They\u2019re just paying for their AI agent. Every new subscriber adds permanent, recurring burn pressure that compounds month over month.",
  },
  {
    icon: Code,
    title: "The Ecosystem Tax",
    timeline: "Coming Soon",
    tagline: "Developers pay for access. Burns follow.",
    short:
      "Third-party skill developers pay per API call to reach InstaClaw's agent network. InstaClaw takes a 15\u201320% platform fee. A portion of every fee buys and burns $INSTACLAW.",
    detail:
      "InstaClaw agents are the distribution layer. When developers build skills (video generation, trading, data analysis), they pay usage-based fees. InstaClaw takes a platform cut matching app store economics. More skills make agents more useful, attracting more users, attracting more developers. Classic marketplace flywheel with token burns baked into every transaction.",
  },
];

function BurnSources() {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <section className="py-16 sm:py-[12vh] px-4">
      <div className="max-w-5xl mx-auto">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          <h2
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Three Independent Burn Sources
          </h2>
          <p
            className="text-sm sm:text-base max-w-lg mx-auto"
            style={{ color: "var(--muted)" }}
          >
            No single point of failure. Three independent engines feeding
            the same burn. If one source slows, the others keep burning.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {burnSources.map((source, i) => (
            <motion.div
              key={source.title}
              className="rounded-xl p-6 sm:p-8 relative"
              style={glassStyle}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ delay: i * 0.1, duration: 0.6, ease: SNAPPY }}
            >
              {/* Timeline badge */}
              <div
                className="absolute -top-3 left-6 px-3 py-1 rounded-full text-[10px] font-medium tracking-wide uppercase"
                style={{
                  ...glassStyle,
                  color: "var(--accent)",
                  fontSize: 10,
                }}
              >
                {source.timeline}
              </div>

              {/* Icon */}
              <div
                className="flex items-center justify-center mb-5"
                style={orbStyle(44)}
              >
                <source.icon
                  className="w-5 h-5"
                  style={{ color: "var(--accent)" }}
                  strokeWidth={1.5}
                />
              </div>

              {/* Title */}
              <h3
                className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-2"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                {source.title}
              </h3>

              {/* Tagline */}
              <p
                className="text-sm font-medium mb-3"
                style={{ color: "var(--accent)" }}
              >
                {source.tagline}
              </p>

              {/* Short description */}
              <p
                className="text-sm leading-relaxed mb-3"
                style={{ color: "var(--muted)" }}
              >
                {source.short}
              </p>

              {/* Expandable detail */}
              <button
                onClick={() => setExpanded(expanded === i ? null : i)}
                className="inline-flex items-center gap-1.5 text-xs cursor-pointer transition-colors"
                style={{ color: "var(--accent)" }}
              >
                <span
                  className="transition-transform duration-200"
                  style={{
                    display: "inline-block",
                    transform:
                      expanded === i ? "rotate(90deg)" : "rotate(0deg)",
                  }}
                >
                  &#9656;
                </span>
                How it works
              </button>
              <AnimatePresence initial={false}>
                {expanded === i && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{
                      height: { duration: 0.25, ease: SNAPPY },
                      opacity: { duration: 0.2 },
                    }}
                    className="overflow-hidden"
                  >
                    <p
                      className="pt-3 text-xs leading-relaxed"
                      style={{ color: "#999" }}
                    >
                      {source.detail}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── The Math ───────────────────────────────────── */

function EstimatedProjections() {
  const [open, setOpen] = useState(false);

  return (
    <motion.div
      className="rounded-xl mb-8 overflow-hidden"
      style={glassStyle}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ delay: 0.15, duration: 0.6, ease: SNAPPY }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-6 sm:px-8 py-5 flex items-center justify-between cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <span
            className="transition-transform duration-200"
            style={{
              display: "inline-block",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              color: "var(--accent)",
              fontSize: 12,
            }}
          >
            &#9656;
          </span>
          <p
            className="text-sm font-medium"
            style={{ color: "var(--foreground)" }}
          >
            Estimated burn projections
          </p>
        </div>
        <p
          className="text-sm font-semibold"
          style={{ color: "var(--accent)" }}
        >
          $1,240,000/yr
        </p>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.3, ease: SNAPPY },
              opacity: { duration: 0.2 },
            }}
            className="overflow-hidden"
          >
            <div
              className="px-6 sm:px-8 pb-2"
            >
              <p
                className="text-[10px] uppercase tracking-[1px] px-2 py-1 rounded-full inline-block mb-4"
                style={{
                  background: "rgba(0,0,0,0.05)",
                  color: "var(--muted)",
                }}
              >
                Estimates only. Not guarantees of future performance.
              </p>
            </div>

            <div className="px-6 sm:px-8">
              {/* Header */}
              <div
                className="grid grid-cols-3 gap-4 pb-3"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <p className="text-[10px] uppercase tracking-[1px]" style={{ color: "var(--muted)" }}>Scale</p>
                <p className="text-[10px] uppercase tracking-[1px] text-right" style={{ color: "var(--muted)" }}>Monthly</p>
                <p className="text-[10px] uppercase tracking-[1px] text-right" style={{ color: "var(--muted)" }}>Annual</p>
              </div>

              <div
                className="grid grid-cols-3 gap-4 py-4"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <p className="text-sm">10,000 users</p>
                <p className="text-sm text-right" style={{ color: "var(--muted)" }}>~$103,000</p>
                <p className="text-sm text-right font-semibold" style={{ color: "var(--accent)" }}>~$1,240,000</p>
              </div>

              <div className="grid grid-cols-3 gap-4 py-4">
                <p className="text-sm">100,000 users</p>
                <p className="text-sm text-right" style={{ color: "var(--muted)" }}>~$1,030,000</p>
                <p className="text-sm text-right font-semibold" style={{ color: "var(--accent)" }}>~$12,360,000</p>
              </div>
            </div>

            <div className="px-6 sm:px-8 py-4">
              <p className="text-[10px] leading-relaxed" style={{ color: "var(--muted)", opacity: 0.7 }}>
                These figures are hypothetical estimates based on the 10% buy-and-burn
                mechanism applied to projected revenue at various user scales. Actual
                results will depend on product adoption, revenue mix, and market conditions.
                This is not financial advice and should not be relied upon for investment decisions.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function TheMath() {
  return (
    <section
      className="py-16 sm:py-[12vh] px-4"
      style={{ background: "#e5e3db" }}
    >
      <div className="max-w-3xl mx-auto">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          <h2
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            The Math
          </h2>
          <p
            className="text-sm sm:text-base max-w-md mx-auto"
            style={{ color: "var(--muted)" }}
          >
            Real revenue from real product usage creating buy pressure that
            compounds with every new user.
          </p>
        </motion.div>

        {/* Hero stat */}
        <motion.div
          className="text-center mb-12 rounded-xl p-8 sm:p-10"
          style={glassStyle}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          <p
            className="text-xs uppercase tracking-[2px] mb-3"
            style={{ color: "var(--muted)" }}
          >
            Burns per user per year
          </p>
          <p
            className="text-5xl sm:text-6xl lg:text-7xl font-normal tracking-[-1px]"
            style={{
              fontFamily: "var(--font-serif)",
              color: "var(--accent)",
            }}
          >
            ~$120
          </p>
          <p className="text-sm mt-3" style={{ color: "var(--muted)" }}>
            Every active user generates ~$120/year in automatic buy-and-burn
            pressure across all sources. With only 28.2% of supply in
            circulation, every burn hits ~3.5x harder.
          </p>
        </motion.div>

        {/* Live burn tracker */}
        <motion.div
          className="rounded-xl overflow-hidden mb-8"
          style={glassStyle}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ delay: 0.1, duration: 0.6, ease: SNAPPY }}
        >
          <div className="p-6 sm:p-8 text-center">
            <h3
              className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Live Burn Tracker
            </h3>

            <p
              className="text-xs uppercase tracking-[2px] mb-3"
              style={{ color: "var(--muted)" }}
            >
              Total $INSTACLAW burned
            </p>
            <p
              className="text-4xl sm:text-5xl font-normal tracking-[-1px] mb-2"
              style={{
                fontFamily: "var(--font-serif)",
                color: "var(--foreground)",
              }}
            >
              0
            </p>
            <p
              className="text-xs mb-6"
              style={{ color: "var(--muted)" }}
            >
              First burn: May 2026
            </p>

            {/* Placeholder stats row */}
            <div
              className="grid grid-cols-3 gap-4 pt-5"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              <div>
                <p
                  className="text-lg font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  0
                </p>
                <p className="text-[10px] uppercase tracking-[1px] mt-1" style={{ color: "var(--muted)" }}>
                  Burned today
                </p>
              </div>
              <div>
                <p
                  className="text-lg font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  0
                </p>
                <p className="text-[10px] uppercase tracking-[1px] mt-1" style={{ color: "var(--muted)" }}>
                  Burned this month
                </p>
              </div>
              <div>
                <p
                  className="text-lg font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  0
                </p>
                <p className="text-[10px] uppercase tracking-[1px] mt-1" style={{ color: "var(--muted)" }}>
                  Burn transactions
                </p>
              </div>
            </div>
          </div>

          {/* Verifiable bar */}
          <div
            className="px-6 sm:px-8 py-4"
            style={{
              background: "rgba(220,103,67,0.04)",
              borderTop: "1px solid var(--border)",
            }}
          >
            <p className="text-xs sm:text-sm text-center" style={{ color: "var(--muted)" }}>
              Every burn transaction is verifiable on{" "}
              <a
                href={BASESCAN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                style={{ color: "var(--accent)" }}
              >
                BaseScan
              </a>
            </p>
          </div>
        </motion.div>

        {/* Estimated projections (collapsible) */}
        <EstimatedProjections />

        {/* Burns by source */}
        <motion.div
          className="rounded-xl p-6 sm:p-8"
          style={glassStyle}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ delay: 0.2, duration: 0.6, ease: SNAPPY }}
        >
          <h3
            className="text-lg font-normal tracking-[-0.5px] mb-5"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Burns by Source
            <span
              className="text-xs ml-2 font-normal"
              style={{ color: "var(--muted)", fontFamily: "inherit" }}
            >
              at 10K users
            </span>
          </h3>

          <div className="space-y-4">
            {[
              {
                label: "Subscriptions + WLD",
                amount: "$68,000/mo",
                pct: 66,
              },
              { label: "Agent tokens + trading", amount: "$20,000/mo", pct: 19 },
              { label: "Skill marketplace", amount: "$15,000/mo", pct: 15 },
            ].map((row) => (
              <div key={row.label}>
                <div className="flex justify-between items-baseline mb-1.5">
                  <p className="text-sm">{row.label}</p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    {row.amount} ({row.pct}%)
                  </p>
                </div>
                <div
                  className="h-1.5 rounded-full overflow-hidden"
                  style={{ background: "rgba(0,0,0,0.06)" }}
                >
                  <motion.div
                    className="h-full rounded-full"
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(220,103,67,0.7), rgba(220,103,67,1))",
                    }}
                    initial={{ width: 0 }}
                    whileInView={{ width: `${row.pct}%` }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.3, duration: 0.8, ease: SNAPPY }}
                  />
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ─── Why Different ──────────────────────────────── */

const comparisonRows = [
  {
    label: "Revenue linkage",
    typical: "None",
    instaclaw: "Every dollar of product revenue triggers a burn",
  },
  {
    label: "Burn mechanism",
    typical: "None or manual team burns",
    instaclaw: "Automated buy-and-burn from 3 independent sources",
  },
  {
    label: "User experience",
    typical: "Wallet connections, staking UIs",
    instaclaw: "Zero crypto. Users never touch a wallet.",
  },
  {
    label: "Value driver",
    typical: "Speculation, narrative, listings",
    instaclaw: "Product adoption. More users = more burns.",
  },
  {
    label: "Verifiability",
    typical: "Trust the team",
    instaclaw: "Every burn tx on BaseScan. No trust required.",
  },
];

function WhyDifferent() {
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
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Not Another AI Token
          </h2>
          <p
            className="text-sm sm:text-base max-w-lg mx-auto"
            style={{ color: "var(--muted)" }}
          >
            Most AI tokens have no connection to product revenue. They stake.
            They govern. They vote. None of it creates real buy pressure.
          </p>
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
              Typical AI Token
            </span>
          </div>
          <div className="flex-1 pb-4">
            <span
              className="text-xs sm:text-sm uppercase tracking-[2px] font-medium"
              style={{ color: "var(--accent)" }}
            >
              $INSTACLAW
            </span>
          </div>
        </motion.div>

        {/* Rows */}
        <div className="space-y-0">
          {comparisonRows.map((row, i) => (
            <motion.div
              key={row.label}
              className="relative"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ delay: i * 0.08, duration: 0.6, ease: SNAPPY }}
            >
              <div
                className="h-px w-full"
                style={{ background: "var(--border)" }}
              />
              <div className="py-5">
                <p
                  className="text-[10px] uppercase tracking-[1.5px] mb-2.5"
                  style={{ color: "var(--muted)" }}
                >
                  {row.label}
                </p>
                <div className="flex gap-6 sm:gap-10">
                  <p
                    className="flex-1 text-sm leading-relaxed"
                    style={{ color: "var(--muted)", opacity: 0.7 }}
                  >
                    {row.typical}
                  </p>
                  <p className="flex-1 text-sm leading-relaxed font-medium">
                    {row.instaclaw}
                  </p>
                </div>
              </div>
              {i === comparisonRows.length - 1 && (
                <div
                  className="h-px w-full"
                  style={{ background: "var(--border)" }}
                />
              )}
            </motion.div>
          ))}
        </div>

        {/* BNB comparison callout */}
        <motion.div
          className="mt-8 rounded-xl p-6 text-center"
          style={glassStyle}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ delay: 0.3, duration: 0.6, ease: SNAPPY }}
        >
          <p className="text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
            $INSTACLAW uses the same proven buy-and-burn model as{" "}
            <span style={{ color: "var(--foreground)", fontWeight: 500 }}>
              BNB
            </span>{" "}
            , but applied to AI agent revenue instead of exchange trading
            fees. Every burn transaction is verifiable on BaseScan.
          </p>
        </motion.div>
      </div>
    </section>
  );
}

/* ─── Token Details ──────────────────────────────── */

function TokenDetails() {
  const [copied, setCopied] = useState(false);

  function copyAddress() {
    navigator.clipboard.writeText(CONTRACT_ADDRESS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const details = [
    { label: "Token", value: "$INSTACLAW" },
    { label: "Chain", value: "Base (Coinbase L2)" },
    { label: "Launched Via", value: "Virtuals Protocol" },
    { label: "Total Supply", value: "1,000,000,000" },
    { label: "Circulating Supply", value: "~282,000,000 (28.2%)" },
    { label: "Max Supply", value: "1,000,000,000 (fixed, no minting)" },
    { label: "Mechanism", value: "Deflationary. Automated buy-and-burn." },
    { label: "Burn Frequency", value: "Daily" },
  ];

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
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Token Details
          </h2>
        </motion.div>

        <motion.div
          className="rounded-xl overflow-hidden"
          style={glassStyle}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          {/* Contract address — highlighted */}
          <div
            className="px-6 sm:px-8 py-5"
            style={{
              background: "rgba(220,103,67,0.04)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <p
              className="text-xs uppercase tracking-[1.5px] mb-2"
              style={{ color: "var(--muted)" }}
            >
              Contract Address
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <a
                href={BASESCAN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono break-all hover:underline"
                style={{ color: "var(--accent)" }}
              >
                {CONTRACT_ADDRESS}
              </a>
              <button
                onClick={copyAddress}
                className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md cursor-pointer transition-all"
                style={{
                  background: "rgba(0,0,0,0.04)",
                  color: "var(--muted)",
                }}
                title="Copy address"
              >
                {copied ? (
                  <Check size={14} strokeWidth={1.5} style={{ color: "#16a34a" }} />
                ) : (
                  <Copy size={14} strokeWidth={1.5} />
                )}
              </button>
            </div>
          </div>

          {/* Details rows */}
          <div className="px-6 sm:px-8">
            {details.map((d, i) => (
              <div
                key={d.label}
                className="flex items-baseline justify-between py-4"
                style={
                  i < details.length - 1
                    ? { borderBottom: "1px solid var(--border)" }
                    : {}
                }
              >
                <p className="text-xs uppercase tracking-[1.5px]" style={{ color: "var(--muted)" }}>
                  {d.label}
                </p>
                <p className="text-sm font-medium text-right">{d.value}</p>
              </div>
            ))}
          </div>

          {/* Links bar */}
          <div
            className="px-6 sm:px-8 py-4 flex flex-wrap gap-4"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            {[
              { label: "BaseScan", href: BASESCAN_URL },
              { label: "CoinGecko", href: COINGECKO_URL },
              { label: "Virtuals Protocol", href: VIRTUALS_URL },
              { label: "MEXC", href: MEXC_URL },
            ].map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs transition-opacity hover:opacity-70"
                style={{ color: "var(--accent)" }}
              >
                {link.label}
                <ExternalLink size={10} strokeWidth={1.5} />
              </a>
            ))}
          </div>
        </motion.div>

        {/* Where to trade */}
        <motion.div
          className="mt-8 rounded-xl p-6 sm:p-8"
          style={glassStyle}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ delay: 0.1, duration: 0.6, ease: SNAPPY }}
        >
          <h3
            className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-5"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Where to Trade
          </h3>

          <div className="space-y-0">
            {[
              {
                name: "Virtuals Protocol",
                type: "DEX",
                pair: "INSTACLAW / VIRTUAL",
                note: "Primary liquidity pool",
                href: VIRTUALS_URL,
              },
              {
                name: "MEXC",
                type: "CEX",
                pair: "INSTACLAW / USDT",
                note: "Centralized exchange",
                href: MEXC_URL,
              },
              {
                name: "LBank",
                type: "CEX",
                pair: "INSTACLAW / USDT",
                note: "Centralized exchange",
                href: "https://www.lbank.com/trade/instaclaw_usdt",
              },
              {
                name: "Uniswap V2",
                type: "DEX",
                pair: "INSTACLAW / VIRTUAL (Base)",
                note: "On-chain swap",
                href: BASESCAN_URL,
              },
            ].map((venue, i, arr) => (
              <a
                key={venue.name}
                href={venue.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between py-4 transition-opacity hover:opacity-70 group"
                style={
                  i < arr.length - 1
                    ? { borderBottom: "1px solid var(--border)" }
                    : {}
                }
              >
                <div className="flex items-center gap-3">
                  <span
                    className="text-[10px] uppercase tracking-[1px] px-2 py-0.5 rounded-full font-medium"
                    style={{
                      background:
                        venue.type === "CEX"
                          ? "rgba(220,103,67,0.1)"
                          : "rgba(0,0,0,0.05)",
                      color:
                        venue.type === "CEX"
                          ? "var(--accent)"
                          : "var(--muted)",
                    }}
                  >
                    {venue.type}
                  </span>
                  <div>
                    <p className="text-sm font-medium">{venue.name}</p>
                    <p
                      className="text-xs"
                      style={{ color: "var(--muted)" }}
                    >
                      {venue.pair}
                    </p>
                  </div>
                </div>
                <ExternalLink
                  size={14}
                  strokeWidth={1.5}
                  style={{ color: "var(--muted)", opacity: 0.5 }}
                />
              </a>
            ))}
          </div>

          {/* + more */}
          <div
            className="pt-4 mt-4 text-center"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              + more exchanges, actively expanding to new platforms
            </p>
          </div>
        </motion.div>

        {/* Liquidity expansion */}
        <motion.div
          className="mt-8 rounded-xl overflow-hidden"
          style={glassStyle}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ delay: 0.2, duration: 0.6, ease: SNAPPY }}
        >
          <div
            className="px-6 sm:px-8 py-5"
            style={{
              background: "rgba(220,103,67,0.04)",
              borderBottom: "1px solid rgba(220,103,67,0.1)",
            }}
          >
            <p
              className="text-xs uppercase tracking-[2px] font-medium mb-1"
              style={{ color: "var(--accent)" }}
            >
              Coming Soon
            </p>
            <h3
              className="text-lg sm:text-xl font-normal tracking-[-0.5px]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Expanding Liquidity
            </h3>
          </div>
          <div className="px-6 sm:px-8 py-5">
            <p
              className="text-sm leading-relaxed mb-4"
              style={{ color: "var(--muted)" }}
            >
              We&apos;re actively investing in new liquidity pools and exchange
              listings to make $INSTACLAW tradable for as many people as
              possible. More pools means deeper liquidity, tighter spreads, and
              more efficient burns.
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                "Additional CEX listings",
                "Cross-chain liquidity pools",
                "Deeper Base DEX liquidity",
                "Tier 1 exchange applications",
              ].map((item) => (
                <span
                  key={item}
                  className="text-xs px-3 py-1.5 rounded-full"
                  style={{
                    background: "rgba(0,0,0,0.04)",
                    color: "var(--foreground)",
                  }}
                >
                  {item}
                </span>
              ))}
            </div>
            <p
              className="text-xs mt-4 leading-relaxed"
              style={{ color: "var(--muted)", opacity: 0.7 }}
            >
              Every new exchange and liquidity pool makes it easier to buy
              $INSTACLAW, and every new buyer adds to the demand side
              while the burn steadily reduces supply.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ─── Timeline ───────────────────────────────────── */

const milestones = [
  {
    date: "May 2026",
    title: "First On-Chain Burn",
    description: "Smart contract infrastructure deployed. First $INSTACLAW permanently removed from supply.",
    active: true,
  },
  {
    date: "Q2 2026",
    title: "Agent Economy Loop",
    description: "Agent tokenization and trading fee burns go live via Virtuals Protocol and Bankr partnerships.",
    active: false,
  },
  {
    date: "Q2\u2013Q3 2026",
    title: "Silent Engine",
    description: "Subscription and WLD credit purchases begin automatically burning.",
    active: false,
  },
  {
    date: "Q2 2026",
    title: "Burn Dashboard",
    description: "Real-time public dashboard tracking every burn transaction on BaseScan.",
    active: false,
  },
  {
    date: "TBD",
    title: "Ecosystem Tax",
    description: "Skill marketplace launches. Third-party developer fees feed the burn.",
    active: false,
  },
];

function Timeline() {
  return (
    <section
      className="py-16 sm:py-[12vh] px-4"
      style={{ background: "#e5e3db" }}
    >
      <div className="max-w-3xl mx-auto">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          <h2
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Roadmap
          </h2>
        </motion.div>

        <div className="space-y-0">
          {milestones.map((m, i) => (
            <motion.div
              key={m.title}
              className="relative"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ delay: i * 0.08, duration: 0.6, ease: SNAPPY }}
            >
              <div
                className="h-px w-full"
                style={{ background: "rgba(0,0,0,0.1)" }}
              />
              <div className="flex items-start gap-5 py-6 sm:py-8">
                {/* Timeline dot + line */}
                <div className="flex flex-col items-center shrink-0 pt-1.5">
                  <div
                    style={{
                      width: m.active ? 12 : 8,
                      height: m.active ? 12 : 8,
                      borderRadius: "50%",
                      background: m.active ? "var(--accent)" : "rgba(0,0,0,0.15)",
                      boxShadow: m.active
                        ? "0 0 10px rgba(220,103,67,0.4)"
                        : "none",
                    }}
                  />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-3 mb-1">
                    <h3
                      className="text-lg sm:text-xl font-normal tracking-[-0.5px]"
                      style={{ fontFamily: "var(--font-serif)" }}
                    >
                      {m.title}
                    </h3>
                    <span
                      className="text-xs shrink-0"
                      style={{ color: m.active ? "var(--accent)" : "var(--muted)" }}
                    >
                      {m.date}
                    </span>
                  </div>
                  <p
                    className="text-sm leading-relaxed"
                    style={{ color: "var(--muted)" }}
                  >
                    {m.description}
                  </p>
                </div>
              </div>
              {i === milestones.length - 1 && (
                <div
                  className="h-px w-full"
                  style={{ background: "rgba(0,0,0,0.1)" }}
                />
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── Closing ────────────────────────────────────── */

function Closing() {
  return (
    <section className="py-16 sm:py-[12vh] px-4">
      <div className="max-w-3xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          <div
            className="rounded-xl p-8 sm:p-12 mb-8"
            style={glassStyle}
          >
            <p
              className="text-lg sm:text-xl lg:text-2xl font-normal leading-relaxed tracking-[-0.5px]"
              style={{
                fontFamily: "var(--font-serif)",
                color: "var(--foreground)",
              }}
            >
              &ldquo;If a billion people use InstaClaw agents every day,
              paying subscriptions, buying credits, tokenizing agents, calling
              skills, every single one of those actions automatically buys
              and burns $INSTACLAW.&rdquo;
            </p>
          </div>

          <p
            className="text-sm sm:text-base mb-8"
            style={{ color: "var(--muted)" }}
          >
            Real usage. Real revenue. Real burns. Permanently removed from
            supply.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href={VIRTUALS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="glow-wrap"
              style={{ width: "auto" }}
            >
              <div className="glow-border" style={{ width: "auto" }}>
                <div className="glow-spinner" />
                <div
                  className="glow-content"
                  style={{ background: "transparent" }}
                >
                  <span
                    className="flex items-center gap-2 px-8 py-3.5 rounded-lg text-base font-semibold"
                    style={{
                      background:
                        "linear-gradient(180deg, rgba(220,103,67,0.95) 0%, rgba(200,85,52,1) 100%)",
                      color: "#ffffff",
                      boxShadow: `
                        rgba(255, 255, 255, 0.25) 0px 1px 1px 0px inset,
                        rgba(220, 103, 67, 0.15) 0px -2px 4px 0px inset
                      `,
                    }}
                  >
                    Buy $INSTACLAW
                    <ArrowRight size={16} strokeWidth={2} />
                  </span>
                </div>
              </div>
            </a>
            <a
              href={BASESCAN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3.5 rounded-lg text-sm font-medium transition-all"
              style={{
                ...glassStyle,
                color: "var(--foreground)",
              }}
            >
              View on BaseScan
              <ExternalLink size={14} strokeWidth={1.5} />
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ─── Page ────────────────────────────────────────── */

export default function TokenPage() {
  return (
    <>
      <Hero />
      <hr className="section-divider" />
      <Flywheel />
      <hr className="section-divider" />
      <BurnSources />
      <TheMath />
      <WhyDifferent />
      <hr className="section-divider" />
      <TokenDetails />
      <Timeline />
      <Closing />
    </>
  );
}
