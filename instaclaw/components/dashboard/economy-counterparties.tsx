"use client";

import { useState, useEffect, useCallback } from "react";
import { motion } from "motion/react";
import { Users, ChevronDown, RotateCw, AlertTriangle } from "lucide-react";
import { CARD_STYLE } from "./economy-hero";
import {
  serviceLabel,
  shortAddr,
  fmtRelTime,
  catMeta,
  CAT_SHORT,
  ICON_DISC_SPEND,
  ACCENT,
  FAIL,
  EASE,
} from "./economy-format";

/**
 * EconomyCounterparties — "who your agent works with, and does it go well."
 *
 * The activity feed is the agent's economic life by TIME; this is the same
 * ledger pivoted by RELATIONSHIP: the distinct suppliers it has paid, each with
 * how many times and — the part worth looking at — how many DELIVERED vs the rare
 * one that DIDN'T GO THROUGH (the single reserved red, same as the feed).
 *
 * Self-fetches /api/agent-economy/counterparties (like the policy panel), so it
 * owns its OWN three states, distinct from each other:
 *   - loading  → a quiet skeleton
 *   - empty    → "No one yet" (a real-but-no-supplier agent; NOT a read failure)
 *   - error    → "Couldn't load relationships" + retry (NOT the empty copy)
 * Gated by the page into the rich-data (!firstRun) block, so a brand-new agent
 * never mounts this card at all — a third, distinct state owned upstream.
 *
 * Reuses the feed's label + category vocabulary (economy-format) so the two
 * surfaces can never disagree about what the same counterparty is called.
 */

interface Counterparty {
  id: string;
  endpoint: string | null;
  counterparty_vm_id: string | null;
  counterparty_address: string | null;
  category: string;
  times: number;
  delivered: number;
  didnt_go_through: number;
  total_spent_usd: number;
  last_seen: string;
  internal: boolean;
}

const CAP = 5;

// The same label rule the feed uses, with the feed's expanded-record fallbacks
// for a counterparty with no endpoint (a fleet agent → "another agent";
// an external on-chain party → its short address).
function nameOf(c: Counterparty): string {
  return (
    serviceLabel(c.endpoint) ??
    (c.internal ? "another agent" : c.counterparty_address ? shortAddr(c.counterparty_address) : "an external service")
  );
}

export function EconomyCounterparties() {
  const [data, setData] = useState<Counterparty[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    let failed = false;
    try {
      const res = await fetch("/api/agent-economy/counterparties");
      if (res.ok) {
        const j = await res.json();
        setData((j.counterparties as Counterparty[]) ?? []);
      } else {
        failed = true;
      }
    } catch {
      failed = true;
    } finally {
      setLoadError(failed);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const Header = (
    <div className="flex items-center gap-2 mb-1">
      <Users className="w-4 h-4" style={{ color: "var(--muted)" }} />
      <h3 className="text-sm font-medium">Who your agent works with</h3>
    </div>
  );
  const Sub = (
    <p className="text-[11px] mb-4 leading-snug" style={{ color: "var(--muted)" }}>
      The agents and services it pays, and how reliably each one delivered.
    </p>
  );

  // ── loading ──
  if (loading) {
    return (
      <div className="rounded-2xl p-6" style={CARD_STYLE}>
        {Header}
        {Sub}
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full animate-pulse shrink-0" style={{ background: "rgba(0,0,0,0.05)" }} />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-1/3 rounded animate-pulse" style={{ background: "rgba(0,0,0,0.05)" }} />
                <div className="h-2.5 w-1/2 rounded animate-pulse" style={{ background: "rgba(0,0,0,0.04)" }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── error (distinct from empty) ──
  if (loadError && !data) {
    return (
      <div className="rounded-2xl p-6" style={CARD_STYLE}>
        {Header}
        <div className="flex items-center gap-2.5 mt-3">
          <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: ACCENT }} />
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Couldn&apos;t load relationships.
          </p>
          <button
            onClick={() => load()}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all active:scale-95 cursor-pointer"
            style={{ background: "rgba(0,0,0,0.05)", border: "1px solid var(--border)" }}
          >
            <RotateCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  const rows = data ?? [];

  // ── empty (a real agent with no qualifying supplier yet — NOT a read failure) ──
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl p-6" style={CARD_STYLE}>
        {Header}
        {Sub}
        <p className="text-sm mb-1">No one yet</p>
        <p className="text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
          When your agent hires another agent or buys from a service, the ones it works with show up here, with how
          reliably each delivered.
        </p>
      </div>
    );
  }

  // ── populated ──
  const capActive = rows.length > CAP && !expanded;
  const visible = capActive ? rows.slice(0, CAP) : rows;
  const hiddenCount = rows.length - CAP;

  return (
    <div className="rounded-2xl p-6" style={CARD_STYLE}>
      {Header}
      {Sub}

      <div className="-mx-1">
        {visible.map((c, i) => {
          const cm = catMeta(c.category);
          const Icon = cm.icon;
          const failed = c.didnt_go_through > 0;
          return (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 8) * 0.04, duration: 0.4, ease: EASE }}
              className="flex items-center gap-3 px-1 py-2.5"
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={ICON_DISC_SPEND}>
                <Icon className="w-[14px] h-[14px]" style={{ color: "rgb(150,120,104)" }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <p className="text-[14px] font-medium leading-tight truncate flex-1 min-w-0" style={{ color: "var(--foreground)" }}>
                    {nameOf(c)}
                  </p>
                  <span className="text-[11px] shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
                    {fmtRelTime(c.last_seen)}
                  </span>
                </div>
                <p className="text-[12px] leading-snug mt-[3px]" style={{ color: "var(--muted)" }}>
                  {CAT_SHORT[c.category] ?? "Services"} · {c.times}
                  {"×"} ·{" "}
                  {failed ? (
                    <span style={{ color: FAIL }}>
                      {c.didnt_go_through} didn&rsquo;t go through
                    </span>
                  ) : (
                    <span>all delivered</span>
                  )}
                </p>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* in-place show-more — same pattern as the feed; no second archive page. */}
      {rows.length > CAP && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center justify-center gap-1.5 mt-1.5 py-2 text-[12px] font-medium rounded-lg transition-colors cursor-pointer"
          style={{ color: "var(--muted)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = ACCENT;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--muted)";
          }}
        >
          {expanded ? "Show less" : `Show ${hiddenCount} more`}
          <ChevronDown
            className="w-3.5 h-3.5 transition-transform duration-300"
            style={{ transform: expanded ? "rotate(180deg)" : "none" }}
          />
        </button>
      )}
    </div>
  );
}
