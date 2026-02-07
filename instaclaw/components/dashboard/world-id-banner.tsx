"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Shield, X } from "lucide-react";

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
        background: "rgba(234,179,8,0.1)",
        border: "1px solid rgba(234,179,8,0.3)",
      }}
    >
      <Shield className="w-5 h-5 shrink-0" style={{ color: "#eab308" }} />
      <div className="flex-1">
        <p className="text-sm font-semibold" style={{ color: "#eab308" }}>
          Prove you&apos;re human, unlock more business.
        </p>
        <p className="text-xs" style={{ color: "rgba(234,179,8,0.7)" }}>
          Verified agents get higher trust scores, priority search visibility, and access to premium bounties.
        </p>
      </div>
      <Link
        href="/settings#world-id"
        className="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 whitespace-nowrap"
        style={{ background: "rgba(234,179,8,0.15)", color: "#eab308" }}
      >
        Verify now →
      </Link>
      <button
        onClick={handleDismiss}
        className="shrink-0 p-1 rounded cursor-pointer transition-colors"
        style={{ color: "rgba(234,179,8,0.6)" }}
        aria-label="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
