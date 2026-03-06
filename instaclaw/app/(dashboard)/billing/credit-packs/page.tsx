"use client";

import { useState } from "react";
import { Zap } from "lucide-react";

const mediaPacks = [
  {
    key: "media_500",
    credits: 500,
    price: 4.99,
    perCredit: "~1\u00A2 each",
    description: "Good for a handful of images or a couple videos",
  },
  {
    key: "media_1200",
    credits: 1200,
    price: 9.99,
    perCredit: "~0.8\u00A2 each",
    description: "Enough for a full creative session",
    popular: true,
  },
  {
    key: "media_3000",
    credits: 3000,
    price: 19.99,
    perCredit: "~0.7\u00A2 each",
    description: "Best value for heavy media workflows",
  },
];

export default function CreditPacksPage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function handlePurchase(packKey: string) {
    setLoading(packKey);
    setError("");
    try {
      const res = await fetch("/api/billing/credit-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack: packKey }),
      });

      if (!res.ok) {
        const err = await res.json();
        setError(err.error || `Checkout failed (${res.status}). Please try again.`);
        setLoading(null);
        return;
      }

      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError("Stripe checkout URL not received. Please try again.");
        setLoading(null);
      }
    } catch {
      setError("Network error. Please check your connection and try again.");
      setLoading(null);
    }
  }

  return (
    <div className="space-y-8" data-tour="page-credit-packs">
      <div>
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Media Credit Packs
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Top up your media credits for AI video, image, and audio generation.
        </p>
      </div>

      <div
        className="glass rounded-xl p-5"
        style={{ borderLeft: "3px solid var(--accent)" }}
      >
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          <Zap className="inline-block w-4 h-4 mr-1.5 -mt-0.5" style={{ color: "var(--accent)" }} />
          Credits are added to your account instantly after purchase and never expire.
          They stack on top of your daily allowance.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {mediaPacks.map((pack) => {
          const isLoading = loading === pack.key;

          const cardContent = (
            <div className="text-left relative rounded-lg p-6" style={{ background: "var(--card)" }}>
              {pack.popular && (
                <div className="flex justify-center mb-4">
                  <span
                    className="inline-block px-3 py-1 rounded-full text-xs font-semibold"
                    style={{
                      background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                      boxShadow: "rgba(255,255,255,0.2) 0px 1px 1px 0px inset, rgba(255,255,255,0.25) 0px -1px 1px 0px inset, rgba(220,103,67,0.3) 0px 2px 8px 0px",
                      color: "#ffffff",
                    }}
                  >
                    Best Value
                  </span>
                </div>
              )}

              <div className="mb-4">
                <h3
                  className="text-xl font-normal mb-1"
                  style={{ fontFamily: "var(--font-serif)", color: "var(--foreground)" }}
                >
                  {pack.credits.toLocaleString()} Credits
                </h3>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  {pack.description}
                </p>
              </div>

              <div className="mb-6">
                <div className="flex items-baseline">
                  <span
                    className="text-4xl font-normal"
                    style={{ fontFamily: "var(--font-serif)", color: "var(--foreground)" }}
                  >
                    ${pack.price}
                  </span>
                  <span className="text-sm ml-2" style={{ color: "var(--muted)" }}>
                    {pack.perCredit}
                  </span>
                </div>
              </div>

              <div className="mb-4 py-2.5 px-3 rounded-md glass">
                <p className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
                  What you get
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: "var(--muted)" }}>
                  ~{Math.floor(pack.credits / 10)} images or ~{Math.floor(pack.credits / 80)} videos
                </p>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handlePurchase(pack.key);
                }}
                disabled={loading !== null}
                className="w-full px-4 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-50"
                style={{
                  background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                  boxShadow: `
                    rgba(255,255,255,0.2) 0px 2px 2px 0px inset,
                    rgba(255,255,255,0.3) 0px -1px 1px 0px inset,
                    rgba(220,103,67,0.35) 0px 4px 16px 0px,
                    rgba(255,255,255,0.08) 0px 0px 1.6px 4px inset
                  `,
                  color: "#ffffff",
                }}
              >
                {isLoading ? (
                  <span className="flex items-center gap-2 justify-center">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Opening checkout...
                  </span>
                ) : (
                  "Buy Now"
                )}
              </button>
            </div>
          );

          return pack.popular ? (
            <div key={pack.key} className="glow-wrap" style={{ borderRadius: "0.5rem" }}>
              <div className="glow-border" style={{ borderRadius: "0.5rem" }}>
                <div className="glow-spinner" />
                <div className="glow-content" style={{ borderRadius: "calc(0.5rem - 1.5px)" }}>
                  {cardContent}
                </div>
              </div>
            </div>
          ) : (
            <div
              key={pack.key}
              className="rounded-lg transition-all"
              style={{
                border: "1px solid var(--border)",
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
              }}
            >
              {cardContent}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="text-sm text-center" style={{ color: "var(--error)" }}>
          {error}
        </p>
      )}

      <div className="text-center">
        <a
          href="/billing"
          className="text-sm underline"
          style={{ color: "var(--muted)" }}
        >
          Back to Billing
        </a>
      </div>
    </div>
  );
}
