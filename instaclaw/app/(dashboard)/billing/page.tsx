"use client";

import { useState } from "react";
import { CreditCard } from "lucide-react";

export default function BillingPage() {
  const [loading, setLoading] = useState(false);

  async function openPortal() {
    setLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      // Handle error
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-10" data-tour="page-billing">
      <div>
        <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>
          Billing
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Manage your subscription and payment details.
        </p>
      </div>

      <div data-tour="page-billing-card" className="glass rounded-xl p-6 space-y-4">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Manage your subscription, update payment methods, and view invoices
          through the Stripe customer portal.
        </p>
        <button
          onClick={openPortal}
          disabled={loading}
          className="px-6 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-50 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]"
          style={{ background: "#ffffff", color: "#000000" }}
        >
          <CreditCard className="inline-block w-4 h-4 mr-2 -mt-0.5" />
          {loading ? "Opening..." : "Manage Subscription"}
        </button>
      </div>
    </div>
  );
}
