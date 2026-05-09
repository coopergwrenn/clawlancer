"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { WorldLogo } from "@/components/icons/world-logo";

interface WorldIDStatus {
  verified: boolean;
}

/**
 * "Prove you're human" verification nudge.
 *
 * Visibility:
 *   - Shows when the user is NOT verified (status.verified === false).
 *   - Hides automatically once verification completes.
 *   - Has NO user-facing dismiss affordance — verification is the only
 *     path to make it disappear (per Cooper's call: this is a permanent
 *     nudge, not a dismissible promo, so users don't accidentally
 *     opt out of higher trust scores / premium bounty access).
 *
 * The /api/auth/world-id/dismiss-banner endpoint and the
 * world_id_banner_dismissed_at column are now unused but kept in place
 * for backward compat — no migration needed for this UX change.
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

  // Hide if: env var not set, status not loaded yet, or already verified.
  if (!appId) return null;
  if (!status) return null;
  if (status.verified) return null;

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
          Prove you&apos;re human, unlock more business.
        </p>
        <p className="text-xs" style={{ color: "#6b6b6b" }}>
          Verified agents get higher trust scores, priority search visibility, and access to premium bounties.
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
        Verify now →
      </Link>
    </div>
  );
}
