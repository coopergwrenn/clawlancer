"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { WorldLogo } from "@/components/icons/world-logo";

interface WorldIDStatus {
  verified: boolean;
}

/**
 * World ID verification card. Persistent, two states.
 *
 * Visibility:
 *   - Unverified (status.verified === false): the "power up your agent"
 *     nudge plus a Get verified CTA.
 *   - Verified (status.verified === true): a quiet "World ID verified"
 *     confirmation plus a Manage CTA, instead of disappearing.
 *   - Always visible once status loads. Returns null only when World ID
 *     isn't configured (no app id) or status hasn't loaded yet.
 *   - NO dismiss affordance in either state (per Cooper's call). The
 *     unverified nudge is not a dismissible promo; the verified state is
 *     a permanent status indicator.
 *
 * The /api/auth/world-id/dismiss-banner endpoint and the
 * world_id_banner_dismissed_at column remain unused. No migration needed.
 */
export function WorldIDBanner() {
  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID;
  const [status, setStatus] = useState<WorldIDStatus | null>(null);

  useEffect(() => {
    if (!appId) return;
    fetch("/api/auth/world-id/status")
      .then((r) => r.json())
      .then((data) => setStatus(data))
      .catch(() => {});
  }, [appId]);

  // Render nothing only when World ID isn't configured or status hasn't loaded.
  if (!appId) return null;
  if (!status) return null;

  // Verified state: quiet confirmation + Manage, instead of disappearing.
  if (status.verified) {
    return (
      <div
        className="rounded-xl p-4 flex items-center gap-3"
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
        }}
      >
        <WorldLogo className="w-5 h-5 shrink-0" style={{ color: "#333334" }} />
        <div className="flex-1">
          <p className="text-sm font-semibold flex items-center gap-1.5" style={{ color: "#333334" }}>
            World ID verified
            <Check className="w-3.5 h-3.5 shrink-0" strokeWidth={2.5} style={{ color: "#22c55e" }} />
          </p>
          <p className="text-xs" style={{ color: "#6b6b6b" }}>
            A real human is verified behind your agent. Premium tools are active in its toolkit.
          </p>
        </div>
        <Link
          href="/settings#human-verification"
          className="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 whitespace-nowrap transition-all"
          style={{
            background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.05))",
            boxShadow: `
              rgba(0, 0, 0, 0.05) 0px 1px 1px 0px inset,
              rgba(255, 255, 255, 0.4) 0px -1px 1px 0px inset,
              rgba(0, 0, 0, 0.08) 0px 1px 3px 0px
            `,
            color: "#333334",
          }}
        >
          Manage →
        </Link>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl p-4 flex items-center gap-3"
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
      }}
    >
      <WorldLogo className="w-5 h-5 shrink-0" style={{ color: "#333334" }} />
      <div className="flex-1">
        <p className="text-sm font-semibold" style={{ color: "#333334" }}>
          Verify you&apos;re human to power up your agent.
        </p>
        <p className="text-xs" style={{ color: "#6b6b6b" }}>
          World ID verification wires premium tools into your agent (Exa, Manus, Browserbase, and more), gives it an on-chain identity, and unlocks higher autonomy as it earns standing.
        </p>
      </div>
      <Link
        href="/settings#human-verification"
        className="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 whitespace-nowrap transition-all"
        style={{
          background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.05))",
          boxShadow: `
            rgba(0, 0, 0, 0.05) 0px 1px 1px 0px inset,
            rgba(255, 255, 255, 0.4) 0px -1px 1px 0px inset,
            rgba(0, 0, 0, 0.08) 0px 1px 3px 0px
          `,
          color: "#333334",
        }}
      >
        Get verified →
      </Link>
    </div>
  );
}
