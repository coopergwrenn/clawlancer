"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Coins } from "lucide-react";
import { EconomyActivityFeed, type ActivityRow } from "@/components/dashboard/economy-activity-feed";

/**
 * /economy/history — the COMPLETE economic record.
 *
 * The dashboard feed surfaces only the 10 most-recent decisions; this is the
 * full archive. It reuses the SAME timeline component (EconomyActivityFeed in
 * `full` mode), so the archive is consistent with the dashboard, not a second
 * design. Data comes from /api/agent-economy/history.
 */
export default function EconomyHistoryPage() {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [noVm, setNoVm] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-economy/history");
      if (res.status === 404) {
        setNoVm(true);
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setRows((data.rows as ActivityRow[]) ?? []);
      }
    } catch {
      /* leave null — render the neutral empty surface */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const BackLink = (
    <Link
      href="/economy"
      className="inline-flex items-center gap-1.5 text-[13px] mb-5 transition-colors"
      style={{ color: "var(--muted)" }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--foreground)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--muted)"; }}
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      Economy
    </Link>
  );

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="h-5 w-24 rounded-md animate-pulse mb-6" style={{ background: "rgba(0,0,0,0.05)" }} />
        <div className="h-9 w-56 rounded-lg animate-pulse mb-6" style={{ background: "rgba(0,0,0,0.05)" }} />
        <div className="h-96 rounded-2xl animate-pulse" style={{ background: "rgba(0,0,0,0.04)" }} />
      </div>
    );
  }

  if (noVm) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        {BackLink}
        <div className="glass rounded-2xl p-10 text-center" style={{ border: "1px solid var(--border)" }}>
          <div
            className="w-12 h-12 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))" }}
          >
            <Coins className="w-6 h-6" style={{ color: "var(--muted)" }} />
          </div>
          <h2 className="text-lg font-medium mb-1">No agent yet</h2>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Your agent&apos;s history appears here once it&apos;s set up.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {BackLink}
      <h1
        className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] flex items-center gap-3"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        <Coins className="w-7 h-7 sm:w-8 sm:h-8" style={{ color: "var(--accent, #DC6743)" }} />
        Full history
      </h1>
      <p className="text-base mt-2 mb-6" style={{ color: "var(--muted)" }}>
        Every decision your agent has made with its own money, most recent first.
      </p>

      <EconomyActivityFeed recent={rows} full />
    </div>
  );
}
