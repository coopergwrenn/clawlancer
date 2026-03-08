"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Zap, Film, AlertCircle, ArrowLeft } from "lucide-react";

/* ── Pack definitions ─────────────────────────────────────────────────────── */

const MESSAGE_PACKS = [
  { id: "50", credits: 50, price: "$5", perCredit: "10¢ each" },
  { id: "200", credits: 200, price: "$15", perCredit: "7.5¢ each" },
  { id: "500", credits: 500, price: "$30", perCredit: "6¢ each", best: true },
];

const MEDIA_PACKS = [
  { id: "media_500", credits: 500, price: "$4.99", perCredit: "~1¢ each", note: "A handful of images or a couple videos" },
  { id: "media_1200", credits: 1200, price: "$9.99", perCredit: "~0.8¢ each", note: "Enough for a full creative session", best: true },
  { id: "media_3000", credits: 3000, price: "$19.99", perCredit: "~0.7¢ each", note: "Best value for heavy media workflows" },
];

/* ── Types ────────────────────────────────────────────────────────────────── */

interface UsageData {
  today: number;
  week: number;
  month: number;
  dailyLimit: number;
  creditBalance: number;
}

interface MediaBalance {
  balance: number | null;
  error?: string;
}

/* ── Skeleton ─────────────────────────────────────────────────────────────── */

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={`rounded-md animate-pulse ${className ?? ""}`}
      style={{ background: "rgba(0,0,0,0.06)" }}
    />
  );
}

function UsageSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <Skeleton className="h-9 w-16" />
        <Skeleton className="h-5 w-8" />
        <Skeleton className="h-5 w-12" />
      </div>
      <Skeleton className="h-2.5 w-full rounded-full" />
      <div className="flex items-center gap-2 mt-2">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  );
}

function PackSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-3">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-[72px] w-full rounded-xl" />
      ))}
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function CreditsPage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [mediaBalance, setMediaBalance] = useState<MediaBalance | null>(null);
  const [buying, setBuying] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/vm/usage")
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => setUsageError(true));

    fetch("/api/credits/media")
      .then((r) => r.json())
      .then(setMediaBalance)
      .catch(() => setMediaBalance({ balance: null, error: "Unable to fetch balance" }));
  }, []);

  async function handleBuy(packId: string) {
    setBuying(packId);
    try {
      const res = await fetch("/api/billing/credit-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack: packId }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } finally {
      setBuying(null);
    }
  }

  const usagePct = usage ? Math.min(100, (usage.today / usage.dailyLimit) * 100) : 0;
  const barColor =
    usagePct >= 90 ? "#ef4444" : usagePct >= 70 ? "#f59e0b" : "#22c55e";

  return (
    <div className="space-y-8" data-tour="page-credits">
      {/* ── Header ── */}
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm mb-4 transition-colors"
          style={{ color: "var(--muted)" }}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Dashboard
        </Link>
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Credits
        </h1>
        <p className="text-sm mt-1.5" style={{ color: "var(--muted)" }}>
          Manage your message credits and media credits.
        </p>
      </div>

      {/* ── Two-column grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ━━━━ Section 1: Daily Message Credits ━━━━ */}
        <div
          className="glass rounded-xl p-6"
          style={{ border: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "rgba(59,130,246,0.08)" }}
            >
              <Zap className="w-4 h-4" style={{ color: "#3b82f6" }} />
            </div>
            <h2
              className="text-lg font-normal"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Daily Message Credits
            </h2>
          </div>

          <p className="text-xs mb-5 ml-[42px]" style={{ color: "var(--muted)" }}>
            Used for conversations with your agent. Resets daily at midnight UTC.
          </p>

          {/* Usage bar — skeleton / error / loaded */}
          {usageError ? (
            <div
              className="flex items-center gap-2 rounded-lg p-4 mb-5"
              style={{ background: "rgba(0,0,0,0.02)", border: "1px solid var(--border)" }}
            >
              <AlertCircle className="w-4 h-4 shrink-0" style={{ color: "var(--muted)" }} />
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                Usage data unavailable right now.
              </span>
            </div>
          ) : !usage ? (
            <div className="mb-5"><UsageSkeleton /></div>
          ) : (
            <div
              className="rounded-xl p-4 mb-5"
              style={{ background: "rgba(0,0,0,0.02)", border: "1px solid var(--border)" }}
            >
              <div className="flex items-baseline gap-1.5 mb-3">
                <span
                  className="text-3xl font-semibold tracking-tight"
                  style={usagePct >= 100 ? { color: "#ef4444" } : undefined}
                >
                  {Math.round(usage.today)}
                </span>
                <span className="text-lg" style={{ color: "var(--muted)" }}>/</span>
                <span className="text-lg" style={{ color: "var(--muted)" }}>
                  {usage.dailyLimit}
                </span>
                <span className="text-sm ml-1" style={{ color: "var(--muted)" }}>
                  used today
                </span>
              </div>

              {/* Progress bar */}
              <div
                className="h-2.5 rounded-full overflow-hidden mb-3"
                style={{ background: "rgba(0,0,0,0.06)" }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${usagePct}%`,
                    background: barColor,
                    transition: "width 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
                  }}
                />
              </div>

              {/* Credit balance row */}
              <div
                className="flex items-center justify-between pt-3"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5" style={{ color: "#3b82f6" }} />
                  <span className="text-sm font-semibold">{usage.creditBalance} bonus credits</span>
                </div>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {usage.creditBalance > 0
                    ? "kick in after daily limit"
                    : "none remaining"}
                </span>
              </div>
            </div>
          )}

          {/* Message credit packs */}
          <p className="text-xs font-medium mb-3" style={{ color: "var(--muted)" }}>
            Top up message credits
          </p>
          {!usage && !usageError ? (
            <PackSkeleton />
          ) : (
            <div className="grid gap-2.5">
              {MESSAGE_PACKS.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => handleBuy(pack.id)}
                  disabled={buying !== null}
                  className="glass rounded-xl p-4 text-left cursor-pointer transition-all disabled:opacity-50 flex items-center justify-between"
                  style={{
                    border: pack.best
                      ? "1.5px solid rgba(59,130,246,0.3)"
                      : "1px solid var(--border)",
                    background: pack.best ? "rgba(59,130,246,0.03)" : undefined,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow =
                      "0 2px 12px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.08)";
                    e.currentTarget.style.transform = "translateY(-1px)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = "";
                    e.currentTarget.style.transform = "";
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold"
                      style={{
                        background: pack.best
                          ? "rgba(59,130,246,0.1)"
                          : "rgba(0,0,0,0.04)",
                        color: pack.best ? "#3b82f6" : "var(--foreground)",
                      }}
                    >
                      {pack.credits}
                    </div>
                    <div>
                      <span className="text-sm font-semibold">
                        {pack.credits} message units
                      </span>
                      <span className="text-xs block" style={{ color: "var(--muted)" }}>
                        {pack.perCredit}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {pack.best && (
                      <span
                        className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                        style={{
                          background: "rgba(59,130,246,0.1)",
                          color: "#3b82f6",
                        }}
                      >
                        Best Value
                      </span>
                    )}
                    <span
                      className="text-sm font-bold px-3 py-1.5 rounded-lg"
                      style={{
                        background: pack.best
                          ? "linear-gradient(135deg, #3b82f6, #2563eb)"
                          : "rgba(0,0,0,0.05)",
                        color: pack.best ? "#fff" : "#3b82f6",
                        boxShadow: pack.best
                          ? "0 1px 3px rgba(59,130,246,0.3)"
                          : undefined,
                      }}
                    >
                      {buying === pack.id ? "..." : pack.price}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}

          <p className="text-xs mt-4" style={{ color: "var(--muted)" }}>
            Credit packs don&apos;t expire and stack on top of your daily allowance.
          </p>
        </div>

        {/* ━━━━ Section 2: Media Credits ━━━━ */}
        <div
          className="glass rounded-xl p-6"
          style={{ border: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{
                background: "linear-gradient(135deg, rgba(199,90,52,0.1), rgba(220,103,67,0.1))",
              }}
            >
              <Film className="w-4 h-4" style={{ color: "var(--accent)" }} />
            </div>
            <h2
              className="text-lg font-normal"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Media Credits
            </h2>
          </div>

          <p className="text-xs mb-5 ml-[42px]" style={{ color: "var(--muted)" }}>
            For Higgsfield AI video, image, and audio generation. Never expire.
          </p>

          {/* Media balance */}
          <div
            className="rounded-xl p-4 mb-5"
            style={{ background: "rgba(0,0,0,0.02)", border: "1px solid var(--border)" }}
          >
            {!mediaBalance ? (
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-4 rounded-full" />
                <Skeleton className="h-6 w-36" />
              </div>
            ) : mediaBalance.balance !== null ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Film className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
                  <span className="text-2xl font-semibold tracking-tight">
                    {mediaBalance.balance.toLocaleString()}
                  </span>
                  <span className="text-sm" style={{ color: "var(--muted)" }}>
                    credits
                  </span>
                </div>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {mediaBalance.balance > 0
                    ? "available for generation"
                    : "purchase below to get started"}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" style={{ color: "var(--muted)" }} />
                <span className="text-sm" style={{ color: "var(--muted)" }}>
                  Balance unavailable right now.
                </span>
              </div>
            )}
          </div>

          {/* Media credit packs */}
          <p className="text-xs font-medium mb-3" style={{ color: "var(--muted)" }}>
            Top up media credits
          </p>
          {!mediaBalance ? (
            <PackSkeleton />
          ) : (
            <div className="grid gap-2.5">
              {MEDIA_PACKS.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => handleBuy(pack.id)}
                  disabled={buying !== null}
                  className="glass rounded-xl p-4 text-left cursor-pointer transition-all disabled:opacity-50"
                  style={{
                    border: pack.best
                      ? "1.5px solid rgba(220,103,67,0.3)"
                      : "1px solid var(--border)",
                    background: pack.best ? "rgba(220,103,67,0.03)" : undefined,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow =
                      "0 2px 12px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.08)";
                    e.currentTarget.style.transform = "translateY(-1px)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = "";
                    e.currentTarget.style.transform = "";
                  }}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold"
                        style={{
                          background: pack.best
                            ? "linear-gradient(135deg, rgba(199,90,52,0.12), rgba(220,103,67,0.12))"
                            : "rgba(0,0,0,0.04)",
                          color: pack.best ? "var(--accent)" : "var(--foreground)",
                        }}
                      >
                        {pack.credits >= 1000
                          ? `${(pack.credits / 1000).toFixed(pack.credits % 1000 ? 1 : 0)}k`
                          : pack.credits}
                      </div>
                      <div>
                        <span className="text-sm font-semibold">
                          {pack.credits.toLocaleString()} media credits
                        </span>
                        <span className="text-xs block" style={{ color: "var(--muted)" }}>
                          {pack.note}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {pack.best && (
                        <span
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                          style={{
                            background:
                              "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                            color: "#fff",
                          }}
                        >
                          Best Value
                        </span>
                      )}
                      <span
                        className="text-sm font-bold px-3 py-1.5 rounded-lg"
                        style={{
                          background: pack.best
                            ? "linear-gradient(135deg, #c75a34, #DC6743)"
                            : "rgba(0,0,0,0.05)",
                          color: pack.best ? "#fff" : "var(--accent)",
                          boxShadow: pack.best
                            ? "0 1px 3px rgba(199,90,52,0.3)"
                            : undefined,
                        }}
                      >
                        {buying === pack.id ? "..." : pack.price}
                      </span>
                    </div>
                  </div>
                  <div className="ml-[52px]">
                    <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                      {pack.perCredit}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div
            className="rounded-lg p-3 mt-4 flex items-start gap-2"
            style={{
              background: "rgba(0,0,0,0.02)",
              border: "1px solid var(--border)",
            }}
          >
            <Film
              className="w-3.5 h-3.5 mt-0.5 shrink-0"
              style={{ color: "var(--accent)" }}
            />
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Media credits are completely separate from message credits and are used
              for Higgsfield video, image, and audio generation only.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
