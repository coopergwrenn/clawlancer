"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ConsensusClient() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");

  async function handleClaim() {
    setClaiming(true);
    setError("");
    try {
      const res = await fetch("/api/partner/tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partner: "consensus_2026" }),
      });
      const data = await res.json().catch(() => ({}));
      // Endpoint always sets the partner cookie server-side. For logged-in
      // users it also updates their existing user + VM records so the tag
      // is reflected on the actual account they're using.
      router.push(data.redirect_to ?? "/signup");
    } catch {
      // Fallback to the legacy cookie-only path if the API roundtrip fails.
      document.cookie =
        "instaclaw_partner=consensus_2026; path=/; max-age=604800; SameSite=Lax";
      router.push("/signup");
    } finally {
      setClaiming(false);
    }
  }

  async function handleNotify(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source: "consensus_2026" }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong");
        return;
      }

      setSubmitted(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div
        className="max-w-md mx-auto px-5 py-4 rounded-full text-sm"
        style={{
          background: "rgba(220,103,67,0.08)",
          color: "#DC6743",
          fontFamily: "var(--font-serif)",
        }}
      >
        You&apos;re on the list. We&apos;ll email you the moment claim opens.
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <button
        onClick={handleClaim}
        disabled={claiming}
        className="w-full px-6 py-3.5 rounded-full text-sm font-medium transition-all hover:opacity-90 disabled:opacity-60"
        style={{
          background: "#DC6743",
          color: "#ffffff",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 3px rgba(220,103,67,0.3)",
        }}
      >
        {claiming ? "Claiming…" : "Claim your agent →"}
      </button>

      <div className="flex items-center gap-3 my-4">
        <div
          className="flex-1 h-px"
          style={{ background: "rgba(0,0,0,0.08)" }}
        />
        <span className="text-xs" style={{ color: "#9a9a9a" }}>
          or
        </span>
        <div
          className="flex-1 h-px"
          style={{ background: "rgba(0,0,0,0.08)" }}
        />
      </div>

      <form onSubmit={handleNotify} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          disabled={loading}
          className="flex-1 px-4 py-3 rounded-full text-sm outline-none transition-all"
          style={{
            background: "#ffffff",
            border: "1px solid rgba(0,0,0,0.12)",
            color: "#333334",
          }}
        />
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-3 rounded-full text-sm font-medium transition-all hover:opacity-90 disabled:opacity-60"
          style={{
            background: "#333334",
            color: "#ffffff",
          }}
        >
          {loading ? "..." : "Notify me"}
        </button>
      </form>

      {error && (
        <p className="text-xs mt-3" style={{ color: "#c44" }}>
          {error}
        </p>
      )}
    </div>
  );
}
