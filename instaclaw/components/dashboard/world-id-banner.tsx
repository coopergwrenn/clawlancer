"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { WorldLogo } from "@/components/icons/world-logo";

interface WorldIDStatus {
  verified: boolean;
  banner_dismissed: boolean;
}

export function WorldIDBanner() {
  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID;
  const [status, setStatus] = useState<WorldIDStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!appId) return;
    fetch("/api/auth/world-id/status")
      .then((r) => r.json())
      .then((data) => setStatus(data))
      .catch(() => {});
  }, [appId]);

  // Hide if: env var not set, verified, banner dismissed, or locally dismissed
  if (!appId) return null;
  if (!status) return null;
  if (status.verified) return null;
  if (status.banner_dismissed) return null;
  if (dismissed) return null;

  async function handleDismiss() {
    setDismissed(true);
    try {
      await fetch("/api/auth/world-id/dismiss-banner", { method: "POST" });
    } catch {
      // Silently handle — already hidden locally
    }
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
      <button
        onClick={handleDismiss}
        className="shrink-0 p-1 rounded cursor-pointer transition-colors"
        style={{ color: "#6b6b6b" }}
        aria-label="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
