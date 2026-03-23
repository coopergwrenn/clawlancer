"use client";

import { MiniKit, tokenToDecimals, Tokens, VerificationLevel } from "@worldcoin/minikit-js";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Step = "welcome" | "verifying" | "verify-failed" | "duplicate-found" | "delegate" | "delegating" | "ready";

const MARQUEE_ROW_1 = [
  "Personal Assistant", "Email Manager", "Scheduling Bot", "Content Creator",
  "Social Media Manager", "Customer Support", "Writing Coach", "Research Assistant",
  "CEO", "Your New Best Friend",
];

const MARQUEE_ROW_2 = [
  "Community Manager", "Sales Outreach", "Lead Generation", "Travel Planner",
  "Language Tutor", "Health Coach", "Meeting Notes", "Your New Employee",
  "The Intern That Never Sleeps", "Data Entry & Reports",
];

const pillStyle: React.CSSProperties = {
  background: "linear-gradient(-75deg, rgba(0,0,0,0.02), rgba(0,0,0,0.06), rgba(0,0,0,0.02))",
  border: "1px solid rgba(0,0,0,0.08)",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  color: "#333334",
};

function MarqueeRow({ items, direction }: { items: string[]; direction: "left" | "right" }) {
  const animClass = direction === "left" ? "animate-marquee-left" : "animate-marquee-right";
  const repeated = [...items, ...items, ...items, ...items];

  return (
    <div className="overflow-hidden w-full py-1">
      <div className={`flex gap-2 w-max ${animClass}`}>
        {repeated.map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="whitespace-nowrap px-4 py-1.5 rounded-full text-xs shrink-0"
            style={pillStyle}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [error, setError] = useState<string | null>(null);

  // ── TAP 1: Verify + Sign In ──
  async function handleGetAgent() {
    setStep("verifying");
    setError(null);
    try {
      const nonceRes = await fetch("/api/nonce");
      const { nonce } = await nonceRes.json();

      const authResult = await MiniKit.commandsAsync.walletAuth({
        nonce,
        statement: "Sign in to InstaClaw",
        expirationTime: new Date(Date.now() + 1000 * 60 * 60),
      });

      if (authResult.finalPayload.status !== "success") {
        setError("Sign-in was cancelled. Try again.");
        setStep("welcome");
        return;
      }

      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(authResult.finalPayload),
      });
      if (!loginRes.ok) {
        setError("Sign-in failed. Please try again.");
        setStep("welcome");
        return;
      }

      const verifyResult = await MiniKit.commandsAsync.verify({
        action: "instaclaw-verify-human",
        verification_level: VerificationLevel.Orb,
      });

      if (verifyResult.finalPayload.status !== "success") {
        setStep("verify-failed");
        return;
      }

      const verifyRes = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(verifyResult.finalPayload),
      });

      if (!verifyRes.ok) {
        setStep("verify-failed");
        return;
      }

      // Check if server detected a potential duplicate agent
      const verifyData = await verifyRes.json();
      if (verifyData.potentialDuplicate) {
        setStep("duplicate-found");
        return;
      }

      setStep("delegate");
    } catch (err) {
      console.error("Onboarding error:", err);
      setError("Something went wrong. Please try again.");
      setStep("welcome");
    }
  }

  // ── TAP 2: Delegate WLD ──
  async function handleDelegate() {
    setStep("delegating");
    setError(null);
    try {
      const initRes = await fetch("/api/delegate/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "try_it" }),
      });
      const { reference, tokenAmount } = await initRes.json();

      const payResult = await MiniKit.commandsAsync.pay({
        reference,
        to: process.env.NEXT_PUBLIC_RECIPIENT_ADDRESS!,
        tokens: [{ symbol: Tokens.WLD, token_amount: tokenAmount }],
        description: "Activate your free InstaClaw agent",
      });

      if (payResult.finalPayload.status !== "success") {
        setError("Payment was cancelled. Try again.");
        setStep("delegate");
        return;
      }

      const confirmRes = await fetch("/api/delegate/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference,
          transactionId: (payResult.finalPayload as Record<string, unknown>).transaction_id,
        }),
      });

      if (!confirmRes.ok) {
        setError("Could not confirm payment. Please contact support.");
        setStep("delegate");
        return;
      }

      MiniKit.commands.sendHapticFeedback({ hapticsType: "notification", style: "success" });

      // Request push notification permission
      try {
        await MiniKit.commandsAsync.requestPermission({ permission: "notifications" as never });
      } catch { /* user declined — that's fine */ }

      setStep("ready");
    } catch (err) {
      console.error("Delegation error:", err);
      setError("Something went wrong. Please try again.");
      setStep("delegate");
    }
  }

  // ── TAP 3: Start Chatting ──
  async function handleStartChat() {
    MiniKit.commands.sendHapticFeedback({ hapticsType: "impact", style: "medium" });
    try {
      const res = await fetch("/api/auth/me");
      const data = await res.json();
      const xmtpAddress = data?.user?.xmtpAddress;

      if (xmtpAddress) {
        await MiniKit.commandsAsync.chat({
          message: "Hey! What's happening today?",
          to: [xmtpAddress],
        });
      }
      router.replace("/home");
    } catch {
      router.replace("/home");
    }
  }

  // ── Linking code ──
  const [linkCode, setLinkCode] = useState("");

  async function handleRedeemCode() {
    if (!linkCode.trim()) return;
    setError(null);
    try {
      const res = await fetch("/api/link/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: linkCode.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        // Successfully linked — go to dashboard (they already have an agent)
        router.replace("/home");
      } else {
        setError(data.error || "Invalid or expired code");
      }
    } catch {
      setError("Failed to redeem code. Try again.");
    }
  }

  function handleSkipDuplicate() {
    // User says "no, this is a new account" — proceed to delegation
    setStep("delegate");
  }

  // ── Fallbacks ──
  function handleGetVerified() {
    window.open("https://worldcoin.org/download", "_blank");
  }

  function handleSubscribeInstead() {
    window.open("https://instaclaw.io/billing", "_blank");
  }

  async function handleBuyCredits() {
    const initRes = await fetch("/api/pay/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pack: "50" }),
    });
    const { reference } = await initRes.json();

    const payResult = await MiniKit.commandsAsync.pay({
      reference,
      to: process.env.NEXT_PUBLIC_RECIPIENT_ADDRESS!,
      tokens: [{
        symbol: Tokens.USDC,
        token_amount: String(tokenToDecimals(5, Tokens.USDC)),
      }],
      description: "InstaClaw Starter credit pack (50 credits)",
    });

    if (payResult.finalPayload.status === "success") {
      await fetch("/api/pay/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference,
          transactionId: (payResult.finalPayload as Record<string, unknown>).transaction_id,
        }),
      });
      setStep("ready");
    }
  }

  // ── Shared styles ──
  const serif = { fontFamily: "'Instrument Serif', Georgia, serif" };
  const pageStyle = "flex h-[100dvh] flex-col items-center justify-center px-6 onboarding-light";

  // ── Render ──
  return (
    <div className={pageStyle}>
      {/* ── Welcome ── */}
      {step === "welcome" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-8 text-center" style={{ opacity: 0 }}>
          <div>
            <h1 className="text-4xl tracking-[-0.5px] leading-[1.1]" style={serif}>
              Claim your free
              <br />
              <span className="shimmer-text text-5xl" style={serif}>AI agent</span>
            </h1>
            <p className="mt-4 max-w-[280px] text-sm leading-relaxed" style={{ color: "#6b6b6b" }}>
              Verify as a real human and your personal AI agent is ready in
              seconds. Powered by your WLD grant.
            </p>
          </div>

          {/* ── Marquee use cases ── */}
          <div className="w-screen overflow-hidden relative">
            <div className="absolute left-0 top-0 bottom-0 w-12 z-10 pointer-events-none" style={{ background: "linear-gradient(to right, #f8f7f4, transparent)" }} />
            <div className="absolute right-0 top-0 bottom-0 w-12 z-10 pointer-events-none" style={{ background: "linear-gradient(to left, #f8f7f4, transparent)" }} />
            <div className="space-y-2">
              <MarqueeRow items={MARQUEE_ROW_1} direction="left" />
              <MarqueeRow items={MARQUEE_ROW_2} direction="right" />
            </div>
          </div>

          {error && (
            <div className="rounded-xl px-4 py-2.5" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
              <p className="text-sm" style={{ color: "#ef4444" }}>{error}</p>
            </div>
          )}

          <button
            onClick={handleGetAgent}
            className="btn-primary w-full max-w-[300px] rounded-xl py-4 text-base font-semibold"
          >
            Claim your free AI agent
          </button>
        </div>
      )}

      {/* ── Verifying ── */}
      {step === "verifying" && (
        <div className="animate-fade-in flex flex-col items-center gap-5 text-center" style={{ opacity: 0 }}>
          <div className="relative">
            <div className="absolute -inset-3 animate-pulse rounded-full blur-xl" style={{ background: "rgba(220,103,67,0.15)" }} />
            <div className="relative h-12 w-12 animate-[spin_1.2s_linear_infinite] rounded-full" style={{ border: "3px solid rgba(0,0,0,0.08)", borderTopColor: "#DC6743" }} />
          </div>
          <p className="text-lg" style={{ ...serif, color: "#333334" }}>Verifying your identity...</p>
          <p className="text-sm" style={{ color: "#6b6b6b" }}>Confirm in World App</p>
        </div>
      )}

      {/* ── Verify Failed ── */}
      {step === "verify-failed" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-6 text-center" style={{ opacity: 0 }}>
          <div className="flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.12), rgba(220,103,67,0.04) 70%)" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#DC6743" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>

          <div>
            <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>Verification needed</h2>
            <p className="mt-2 max-w-[280px] text-sm leading-relaxed" style={{ color: "#6b6b6b" }}>
              Get Orb verified to unlock your free AI agent, or subscribe to get
              started right away.
            </p>
          </div>

          <div className="flex w-full max-w-[300px] flex-col gap-3">
            <button onClick={handleGetVerified} className="btn-primary rounded-xl py-4 font-semibold">
              Get Orb Verified
            </button>
            <button
              onClick={handleBuyCredits}
              className="rounded-xl py-3.5 font-semibold transition-all"
              style={{ background: "rgba(0,0,0,0.04)", color: "#333334", border: "1px solid rgba(0,0,0,0.08)" }}
            >
              Buy credits with USDC
            </button>
            <button onClick={handleSubscribeInstead} className="py-2 text-sm underline underline-offset-2" style={{ color: "#6b6b6b" }}>
              Subscribe on instaclaw.io instead
            </button>
          </div>
        </div>
      )}

      {/* ── Duplicate Found ── */}
      {step === "duplicate-found" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-6 text-center" style={{ opacity: 0 }}>
          <div className="flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.12), rgba(220,103,67,0.04) 70%)" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#DC6743" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </div>

          <div>
            <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>Already have an agent?</h2>
            <p className="mt-2 max-w-[280px] text-sm leading-relaxed" style={{ color: "#6b6b6b" }}>
              It looks like you might already have an InstaClaw agent from
              instaclaw.io. Enter your linking code to connect to your existing
              agent.
            </p>
          </div>

          <div className="w-full max-w-[300px]">
            <input
              type="text"
              value={linkCode}
              onChange={(e) => setLinkCode(e.target.value.toUpperCase())}
              placeholder="Enter 8-digit code"
              maxLength={8}
              className="w-full rounded-xl px-4 py-3 text-center font-mono text-lg tracking-[0.3em] focus:outline-none"
              style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.1)", color: "#333334" }}
            />
            <p className="mt-2 text-xs" style={{ color: "#6b6b6b" }}>
              Get your code from instaclaw.io &rarr; Settings &rarr; Connect World Wallet
            </p>
          </div>

          {error && (
            <div className="rounded-xl px-4 py-2.5" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
              <p className="text-sm" style={{ color: "#ef4444" }}>{error}</p>
            </div>
          )}

          <div className="flex w-full max-w-[300px] flex-col gap-3">
            <button onClick={handleRedeemCode} disabled={linkCode.length < 8} className="btn-primary rounded-xl py-4 font-semibold disabled:opacity-40">
              Connect existing agent
            </button>
            <button onClick={handleSkipDuplicate} className="py-2 text-sm underline underline-offset-2" style={{ color: "#6b6b6b" }}>
              No, create a new agent
            </button>
          </div>
        </div>
      )}

      {/* ── Delegate ── */}
      {step === "delegate" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-6 text-center" style={{ opacity: 0 }}>
          <div>
            <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>Activate with 5 WLD</h2>
            <p className="mt-2 max-w-[280px] text-sm leading-relaxed" style={{ color: "#6b6b6b" }}>
              Stake 5 WLD from your grant to power your agent for ~3 days.
              That&apos;s about $1.50 — from tokens you got for free.
            </p>
          </div>

          <div className="w-full max-w-[300px] rounded-xl px-5 py-4" style={{ background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.08)" }}>
            <div className="flex justify-between text-sm" style={{ color: "#333334" }}>
              <span style={{ color: "#6b6b6b" }}>Credits</span>
              <span className="font-semibold">25 credits</span>
            </div>
            <div className="mt-2 flex justify-between text-sm" style={{ color: "#333334" }}>
              <span style={{ color: "#6b6b6b" }}>Duration</span>
              <span className="font-semibold">~3 days</span>
            </div>
            <div className="mt-2 flex justify-between text-sm" style={{ color: "#333334" }}>
              <span style={{ color: "#6b6b6b" }}>Cost</span>
              <span className="font-semibold" style={{ color: "#1dc1a0" }}>5 WLD</span>
            </div>
          </div>

          {error && (
            <div className="rounded-xl px-4 py-2.5" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
              <p className="text-sm" style={{ color: "#ef4444" }}>{error}</p>
            </div>
          )}

          <button onClick={handleDelegate} className="btn-wld w-full max-w-[300px] rounded-xl py-4 text-base font-semibold">
            Activate with 5 WLD
          </button>
        </div>
      )}

      {/* ── Delegating ── */}
      {step === "delegating" && (
        <div className="animate-fade-in flex flex-col items-center gap-5 text-center" style={{ opacity: 0 }}>
          <div className="relative">
            <div className="absolute -inset-3 animate-pulse rounded-full blur-xl" style={{ background: "rgba(29,193,160,0.15)" }} />
            <div className="relative h-12 w-12 animate-[spin_1.2s_linear_infinite] rounded-full" style={{ border: "3px solid rgba(0,0,0,0.08)", borderTopColor: "#1dc1a0" }} />
          </div>
          <p className="text-lg" style={{ ...serif, color: "#333334" }}>Your agent is powering up...</p>
          <p className="text-sm" style={{ color: "#6b6b6b" }}>Deploying your personal AI</p>
        </div>
      )}

      {/* ── Ready ── */}
      {step === "ready" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-8 text-center" style={{ opacity: 0 }}>
          <div className="flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, rgba(34,197,94,0.15), rgba(34,197,94,0.04) 70%)" }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          </div>

          <div>
            <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>Your agent is ready!</h2>
            <p className="mt-2 max-w-[280px] text-sm leading-relaxed" style={{ color: "#6b6b6b" }}>
              Start chatting now. Your agent is standing by in World Chat.
            </p>
          </div>

          <button
            onClick={handleStartChat}
            className="btn-primary animate-pulse-glow w-full max-w-[300px] rounded-xl py-4 text-base font-semibold"
          >
            Start chatting
          </button>
        </div>
      )}
    </div>
  );
}
