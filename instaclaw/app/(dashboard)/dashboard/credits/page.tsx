"use client";

import { useState, useEffect } from "react";
import { Zap, Film, AlertCircle } from "lucide-react";

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

/* ── Glass styles ─────────────────────────────────────────────────────────── */

const glassCard: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  border: "1px solid rgba(255,255,255,0.08)",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.06)",
};

const glassButton: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  border: "1px solid rgba(255,255,255,0.08)",
  boxShadow: "0 1px 2px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.04)",
  transition: "all 0.2s ease",
};

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
        <Skeleton className="h-8 w-14" />
        <Skeleton className="h-5 w-8" />
        <Skeleton className="h-5 w-10" />
      </div>
      <Skeleton className="h-2 w-full" />
      <div className="flex items-center gap-2 mt-2">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-4 w-28" />
      </div>
    </div>
  );
}

function PackSkeleton() {
  return (
    <div className="grid gap-3">
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
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
  const barColor = usagePct >= 90 ? "#ef4444" : usagePct >= 70 ? "#f59e0b" : "var(--success)";

  return (
    <div className="space-y-10" data-tour="page-credits">
      {/* ── Header ── */}
      <div>
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Credits
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Manage your message credits and media credits.
        </p>
      </div>

      {/* ── Two-column grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── Section 1: Daily Message Credits ── */}
        <div className="rounded-xl p-6 space-y-5" style={glassCard}>
          <div className="flex items-center gap-2.5">
            <Zap className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h2
              className="text-lg font-normal"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Daily Message Credits
            </h2>
          </div>

          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Used for all conversations with your agent. Resets every day at midnight UTC.
          </p>

          {/* Usage bar — skeleton / error / loaded */}
          {usageError ? (
            <div className="flex items-center gap-2 py-3">
              <AlertCircle className="w-4 h-4" style={{ color: "var(--muted)" }} />
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                Usage data unavailable right now.
              </span>
            </div>
          ) : !usage ? (
            <UsageSkeleton />
          ) : (
            <div>
              <div className="flex items-baseline gap-1.5 mb-2">
                <span
                  className="text-3xl font-semibold tracking-tight"
                  style={usagePct >= 100 ? { color: "#ef4444" } : undefined}
                >
                  {usage.today}
                </span>
                <span className="text-lg" style={{ color: "var(--muted)" }}>/</span>
                <span className="text-lg" style={{ color: "var(--muted)" }}>{usage.dailyLimit}</span>
                <span className="text-sm ml-1" style={{ color: "var(--muted)" }}>units used</span>
              </div>
              <div
                className="h-2 rounded-full overflow-hidden"
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
              <div className="flex items-center gap-2 mt-3">
                <Zap className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
                <span className="text-sm font-semibold">{usage.creditBalance} credits</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {usage.creditBalance > 0 ? "available after daily limit" : "none remaining"}
                </span>
              </div>
            </div>
          )}

          {/* Message credit packs */}
          {!usage && !usageError ? (
            <PackSkeleton />
          ) : (
            <div className="grid gap-3">
              {MESSAGE_PACKS.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => handleBuy(pack.id)}
                  disabled={buying !== null}
                  className="rounded-lg p-4 text-left cursor-pointer disabled:opacity-50 flex items-center justify-between group"
                  style={glassButton}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                    e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.08)";
                    e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = glassButton.background as string;
                    e.currentTarget.style.boxShadow = glassButton.boxShadow as string;
                    e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
                  }}
                >
                  <div>
                    <span className="text-lg font-bold">{pack.credits}</span>
                    <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>
                      message units
                    </span>
                    {pack.best && (
                      <span
                        className="text-[10px] font-semibold ml-2 px-1.5 py-0.5 rounded-full"
                        style={{ background: "rgba(59,130,246,0.1)", color: "#3b82f6" }}
                      >
                        Best Value
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-semibold shrink-0" style={{ color: "#3b82f6" }}>
                    {buying === pack.id ? "Redirecting..." : pack.price}
                  </span>
                </button>
              ))}
            </div>
          )}

          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Credit packs don&apos;t expire and stack on top of your daily allowance.
          </p>
        </div>

        {/* ── Section 2: Media Credits ── */}
        <div className="rounded-xl p-6 space-y-5" style={glassCard}>
          <div className="flex items-center gap-2.5">
            <Film className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h2
              className="text-lg font-normal"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Media Credits
            </h2>
          </div>

          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Used exclusively for Higgsfield AI video, image, and audio generation.
            Completely separate from your daily message credits. Never expire.
          </p>

          {/* Media balance */}
          {!mediaBalance ? (
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4 rounded-full" />
              <Skeleton className="h-5 w-32" />
            </div>
          ) : mediaBalance.balance !== null ? (
            <div className="flex items-center gap-2">
              <Film className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
              <span className="text-sm font-semibold">
                {mediaBalance.balance.toLocaleString()} credits
              </span>
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {mediaBalance.balance > 0 ? "available for media generation" : "none remaining"}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4" style={{ color: "var(--muted)" }} />
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                Balance unavailable right now.
              </span>
            </div>
          )}

          {/* Media credit packs */}
          {!mediaBalance ? (
            <PackSkeleton />
          ) : (
            <div className="grid gap-3">
              {MEDIA_PACKS.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => handleBuy(pack.id)}
                  disabled={buying !== null}
                  className="rounded-lg p-4 text-left cursor-pointer disabled:opacity-50 group"
                  style={glassButton}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                    e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.08)";
                    e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = glassButton.background as string;
                    e.currentTarget.style.boxShadow = glassButton.boxShadow as string;
                    e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
                  }}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <span className="text-lg font-bold">{pack.credits.toLocaleString()}</span>
                      <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>
                        media credits
                      </span>
                      {pack.best && (
                        <span
                          className="text-[10px] font-semibold ml-2 px-1.5 py-0.5 rounded-full"
                          style={{
                            background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                            color: "#fff",
                          }}
                        >
                          Best Value
                        </span>
                      )}
                    </div>
                    <span className="text-sm font-semibold shrink-0" style={{ color: "var(--accent)" }}>
                      {buying === pack.id ? "Redirecting..." : pack.price}
                    </span>
                  </div>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    {pack.note} &middot; {pack.perCredit}
                  </p>
                </button>
              ))}
            </div>
          )}

          <div
            className="rounded-lg p-3"
            style={{
              background: "rgba(0,0,0,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              <Film className="inline-block w-3.5 h-3.5 mr-1 -mt-0.5" style={{ color: "var(--accent)" }} />
              Completely separate from your daily message credits. Media credits are used
              for Higgsfield video, image, and audio generation only.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
