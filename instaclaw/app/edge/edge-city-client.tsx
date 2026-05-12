"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function EdgeCityClient() {
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
        body: JSON.stringify({ partner: "edge_city" }),
      });
      const data = await res.json().catch(() => ({}));
      router.push(data.redirect_to ?? "/signup");
    } catch {
      document.cookie =
        "instaclaw_partner=edge_city; path=/; max-age=604800; SameSite=Lax";
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
        body: JSON.stringify({ email: email.trim(), source: "edge_city" }),
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
        className="max-w-md px-5 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] inline-flex items-center gap-2"
        style={{ background: "var(--edge-sage)", color: "var(--edge-olive)" }}
      >
        <span aria-hidden>✓</span>
        You&apos;re on the list — we&apos;ll email when claim opens
      </div>
    );
  }

  return (
    <div className="w-full">
      <button
        onClick={handleClaim}
        disabled={claiming}
        className="w-full px-6 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] disabled:opacity-60 inline-flex items-center justify-center gap-2"
        style={{ background: "var(--edge-olive)", color: "#FFFFFF", letterSpacing: "0.12em" }}
      >
        {claiming ? "Claiming…" : <>Claim your agent <span aria-hidden>→</span></>}
      </button>

      <div className="flex items-center gap-3 my-5">
        <div className="flex-1 h-px" style={{ background: "var(--edge-line)" }} />
        <span className="text-[11px] uppercase tracking-[0.16em]" style={{ color: "var(--edge-ink-soft)" }}>
          or
        </span>
        <div className="flex-1 h-px" style={{ background: "var(--edge-line)" }} />
      </div>

      <form onSubmit={handleNotify} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          disabled={loading}
          aria-label="email"
          className="flex-1 px-5 py-3.5 rounded-full text-[14px] outline-none transition-colors focus:border-[var(--edge-olive)]"
          style={{
            background: "#FFFFFF",
            border: "1px solid var(--edge-line)",
            color: "var(--edge-ink)",
          }}
        />
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-3.5 rounded-full text-[13px] uppercase tracking-[0.12em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] disabled:opacity-60"
          style={{ background: "var(--edge-olive)", color: "#FFFFFF" }}
        >
          {loading ? "…" : "Notify me"}
        </button>
      </form>

      {error && (
        <p className="text-[12px] mt-3" style={{ color: "#B83D01" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
