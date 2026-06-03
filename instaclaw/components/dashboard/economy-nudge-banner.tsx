"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Coins, X } from "lucide-react";

/**
 * Discovery nudge for the Economy page / autonomous-spend opt-in.
 *
 * Visibility:
 *   - Shows only when the agent's autonomous spending is OFF (the default) —
 *     i.e. the user hasn't set it up yet. This is the dashboard-side discovery
 *     surface for a feature whose other contextual touchpoint is the agent's
 *     own "I'd need permission to pay for that" message in chat.
 *   - Hides automatically once spend is enabled.
 *   - Dismissible (localStorage) — unlike the World ID nudge, opting out of
 *     autonomy is a legitimate choice, so we don't nag.
 */
export function EconomyNudgeBanner() {
  const [spendEnabled, setSpendEnabled] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(true); // assume dismissed until checked

  useEffect(() => {
    setDismissed(localStorage.getItem("economy_nudge_dismissed") === "1");
    fetch("/api/agent-economy/spend-settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setSpendEnabled(d?.spend_enabled === true))
      .catch(() => {});
  }, []);

  if (dismissed) return null;
  if (spendEnabled === null) return null; // not loaded
  if (spendEnabled) return null; // already on — nothing to nudge

  return (
    <div
      className="rounded-xl p-4 flex items-center gap-3"
      style={{
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
      }}
    >
      <Coins className="w-5 h-5 shrink-0" style={{ color: "#333334" }} />
      <div className="flex-1">
        <p className="text-sm font-semibold" style={{ color: "#333334" }}>
          Let your agent handle small purchases on its own.
        </p>
        <p className="text-xs" style={{ color: "#6b6b6b" }}>
          Off by default — turn on autonomous spending within limits your agent earns. You stay in control and can
          switch it off anytime.
        </p>
      </div>
      <Link
        href="/economy"
        className="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 whitespace-nowrap transition-all"
        style={{
          background:
            "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.05))",
          boxShadow: `
            rgba(0, 0, 0, 0.05) 0px 1px 1px 0px inset,
            rgba(255, 255, 255, 0.4) 0px -1px 1px 0px inset,
            rgba(0, 0, 0, 0.08) 0px 1px 3px 0px
          `,
          color: "#333334",
        }}
      >
        Set up →
      </Link>
      <button
        onClick={() => {
          localStorage.setItem("economy_nudge_dismissed", "1");
          setDismissed(true);
        }}
        className="shrink-0 p-1 rounded-md transition-colors cursor-pointer"
        style={{ color: "#6b6b6b" }}
        aria-label="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
