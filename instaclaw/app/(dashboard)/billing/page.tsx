"use client";

import { useState } from "react";

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
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Manage your subscription and payment details.
        </p>
      </div>

      <div className="glass rounded-xl p-6 space-y-4">
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
          {loading ? "Opening..." : "Manage Subscription"}
        </button>
      </div>
    </div>
  );
}
