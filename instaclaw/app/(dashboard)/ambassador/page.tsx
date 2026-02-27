"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  AlertCircle,
  Award,
  Copy,
  Check,
  Users,
  DollarSign,
  ExternalLink,
} from "lucide-react";
import { motion } from "motion/react";
import AmbassadorCard from "@/components/AmbassadorCard";

// ── Types ───────────────────────────────────────────

interface Ambassador {
  id: string;
  status: "pending" | "approved" | "rejected" | "revoked";
  ambassador_name: string;
  ambassador_number: number | null;
  wallet_address: string;
  application_text: string;
  social_handles: Record<string, string>;
  referral_code: string | null;
  referral_count: number;
  earnings_total: number;
  applied_at: string;
  approved_at: string | null;
  minted_at: string | null;
  revoked_at: string | null;
}

// ── Page ────────────────────────────────────────────

export default function AmbassadorPage() {
  const [ambassador, setAmbassador] = useState<Ambassador | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Apply form state
  const [walletAddress, setWalletAddress] = useState("");
  const [applicationText, setApplicationText] = useState("");
  const [socialHandles, setSocialHandles] = useState({ twitter: "", instagram: "", tiktok: "", youtube: "" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // Copy referral code
  const [copied, setCopied] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/ambassador/status");
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setAmbassador(data.ambassador);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/ambassador/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, applicationText, socialHandles }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Application failed");
      setAmbassador(data.ambassador);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Application failed");
    } finally {
      setSubmitting(false);
    }
  }

  function copyReferralCode() {
    if (!ambassador?.referral_code) return;
    navigator.clipboard.writeText(`https://instaclaw.io/signup?ref=${ambassador.referral_code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  // ── Loading ──

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <AlertCircle className="w-8 h-8" style={{ color: "var(--error)" }} />
        <p className="text-sm" style={{ color: "var(--muted)" }}>{error}</p>
      </div>
    );
  }

  // ── State: Approved ──

  if (ambassador?.status === "approved") {
    return (
      <>
        <div className="mb-6">
          <h1
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Ambassador
          </h1>
          <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
            Welcome to the program. Share your link, earn rewards.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          {/* Card */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="flex justify-center lg:justify-start"
          >
            <AmbassadorCard
              number={ambassador.ambassador_number ?? 0}
              verified
            />
          </motion.div>

          {/* Info panel */}
          <div className="space-y-4">
            {/* Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="glass rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4" style={{ color: "var(--muted)" }} />
                  <span className="text-xs" style={{ color: "var(--muted)" }}>Referrals</span>
                </div>
                <p
                  className="text-2xl font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  {ambassador.referral_count}
                </p>
              </div>
              <div className="glass rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <DollarSign className="w-4 h-4" style={{ color: "var(--muted)" }} />
                  <span className="text-xs" style={{ color: "var(--muted)" }}>Earnings</span>
                </div>
                <p
                  className="text-2xl font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  ${Number(ambassador.earnings_total).toFixed(2)}
                </p>
              </div>
            </div>

            {/* Referral link */}
            <div className="glass rounded-xl p-4 sm:p-5">
              <h2
                className="text-base font-normal tracking-[-0.3px] mb-3 flex items-center gap-2"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                <ExternalLink className="w-4 h-4" style={{ color: "var(--muted)" }} />
                Your Referral Link
              </h2>
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 px-3 py-2.5 rounded-lg text-sm font-mono truncate"
                  style={{
                    background: "rgba(0,0,0,0.03)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                  }}
                >
                  instaclaw.io/signup?ref={ambassador.referral_code}
                </div>
                <button
                  onClick={copyReferralCode}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
                  style={{
                    background: "linear-gradient(135deg, rgba(255,255,255,0.92), rgba(240,240,240,0.88))",
                    boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.6)",
                    backdropFilter: "blur(8px)",
                    color: "#000",
                  }}
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
                Friends who sign up with your link get 25% off their first month.
                You earn $10 for each paying referral.
              </p>
            </div>

            {/* Approved date */}
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Approved {ambassador.approved_at ? new Date(ambassador.approved_at).toLocaleDateString() : ""}
              {" · "}Ambassador #{String(ambassador.ambassador_number ?? 0).padStart(3, "0")}
            </p>
          </div>
        </div>
      </>
    );
  }

  // ── State: Pending ──

  if (ambassador?.status === "pending") {
    return (
      <>
        <div className="mb-6">
          <h1
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Ambassador
          </h1>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="glass rounded-xl p-5 sm:p-6 max-w-lg"
        >
          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: "rgba(220,103,67,0.1)" }}
            >
              <Award className="w-5 h-5" style={{ color: "#DC6743" }} />
            </div>
            <div>
              <h2
                className="text-lg font-normal tracking-[-0.3px]"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                Application Pending
              </h2>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Submitted {new Date(ambassador.applied_at).toLocaleDateString()}
              </p>
            </div>
          </div>

          <div
            className="rounded-lg p-3 text-sm"
            style={{
              background: "rgba(0,0,0,0.03)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          >
            <p className="text-xs mb-1" style={{ color: "var(--muted)" }}>Your application</p>
            <p style={{ whiteSpace: "pre-wrap" }}>{ambassador.application_text}</p>
          </div>

          <p className="text-xs mt-4" style={{ color: "var(--muted)" }}>
            We review applications within a few days. You&apos;ll see your ambassador card here once approved.
          </p>
        </motion.div>
      </>
    );
  }

  // ── State: Rejected / Revoked ──

  if (ambassador?.status === "rejected" || ambassador?.status === "revoked") {
    return (
      <>
        <div className="mb-6">
          <h1
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Ambassador
          </h1>
        </div>

        <div className="glass rounded-xl p-5 sm:p-6 max-w-lg">
          <div className="flex items-center gap-3 mb-3">
            <AlertCircle className="w-5 h-5" style={{ color: "var(--muted)" }} />
            <h2
              className="text-lg font-normal tracking-[-0.3px]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Application {ambassador.status === "rejected" ? "Not Approved" : "Revoked"}
            </h2>
          </div>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {ambassador.status === "rejected"
              ? "Unfortunately, your application wasn't approved at this time. Reach out to us if you have questions."
              : "Your ambassador status has been revoked. Contact us if you believe this is an error."}
          </p>
        </div>
      </>
    );
  }

  // ── State: No Application — Show Apply Form ──

  return (
    <>
      <div className="mb-6">
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Ambassador Program
        </h1>
        <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
          Earn $10 for every user you refer. Your friends get 25% off their first month.
        </p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="grid gap-6 lg:grid-cols-[auto_1fr]"
      >
        {/* Preview card */}
        <div className="flex justify-center lg:justify-start">
          <AmbassadorCard number={42} verified />
        </div>

        {/* Apply form */}
        <form onSubmit={handleApply} className="glass rounded-xl p-5 sm:p-6 space-y-4">
          <h2
            className="text-xl font-normal tracking-[-0.3px] flex items-center gap-2"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            <Award className="w-5 h-5" style={{ color: "#DC6743" }} />
            Apply
          </h2>

          {/* Wallet */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--muted)" }}>
              Wallet Address (Base)
            </label>
            <input
              type="text"
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
              placeholder="0x..."
              required
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                color: "var(--foreground)",
              }}
            />
          </div>

          {/* Application text */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--muted)" }}>
              Why do you want to be an ambassador?
            </label>
            <textarea
              value={applicationText}
              onChange={(e) => setApplicationText(e.target.value)}
              placeholder="Tell us about yourself and why you'd be a great ambassador..."
              required
              rows={4}
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none resize-none"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                color: "var(--foreground)",
              }}
            />
            <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
              {applicationText.length}/2000
            </p>
          </div>

          {/* Social handles */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--muted)" }}>
              Social Handles (optional)
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(["twitter", "instagram", "tiktok", "youtube"] as const).map((platform) => (
                <input
                  key={platform}
                  type="text"
                  value={socialHandles[platform]}
                  onChange={(e) =>
                    setSocialHandles((prev) => ({ ...prev, [platform]: e.target.value }))
                  }
                  placeholder={platform.charAt(0).toUpperCase() + platform.slice(1)}
                  className="px-3 py-2 rounded-lg text-sm outline-none"
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                  }}
                />
              ))}
            </div>
          </div>

          {submitError && (
            <p className="text-sm" style={{ color: "var(--error)" }}>{submitError}</p>
          )}

          <button
            type="submit"
            disabled={submitting || !walletAddress || applicationText.length < 20}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background:
                "linear-gradient(135deg, rgba(220,103,67,0.85), rgba(200,83,47,0.95))",
              color: "#fff",
              boxShadow:
                "0 0 0 1px rgba(220,103,67,0.3), 0 2px 8px rgba(220,103,67,0.25), inset 0 1px 0 rgba(255,255,255,0.2)",
            }}
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <Award className="w-4 h-4" />
                Submit Application
              </>
            )}
          </button>
        </form>
      </motion.div>
    </>
  );
}
