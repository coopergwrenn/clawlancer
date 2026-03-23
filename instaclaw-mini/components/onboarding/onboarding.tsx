"use client";

import { MiniKit, tokenToDecimals, Tokens, VerificationLevel } from "@worldcoin/minikit-js";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Step = "welcome" | "verifying" | "verify-failed" | "duplicate-found" | "delegate" | "delegating" | "ready";

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

  // ── Render ──
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center px-6">
      {/* ── Welcome ── */}
      {step === "welcome" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-8 text-center" style={{ opacity: 0 }}>
          {/* Decorative orb */}
          <div className="relative">
            <div className="animate-orb absolute -inset-6 rounded-full bg-accent/20 blur-2xl" />
            <div className="relative text-6xl">🤠</div>
          </div>

          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Get your free
              <br />
              <span className="shimmer-text">AI agent</span>
            </h1>
            <p className="mt-3 max-w-[280px] text-sm leading-relaxed text-muted">
              Verify as a real human and your personal AI agent is ready in
              seconds. Powered by your WLD grant.
            </p>
          </div>

          {error && (
            <div className="glass-card rounded-xl px-4 py-2.5">
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          <button
            onClick={handleGetAgent}
            className="btn-primary w-full max-w-[300px] rounded-2xl py-4 text-lg font-bold"
          >
            Get your free AI agent
          </button>
        </div>
      )}

      {/* ── Verifying ── */}
      {step === "verifying" && (
        <div className="animate-fade-in flex flex-col items-center gap-5 text-center" style={{ opacity: 0 }}>
          <div className="relative">
            <div className="absolute -inset-3 animate-pulse rounded-full bg-accent/20 blur-xl" />
            <div className="relative h-12 w-12 animate-[spin_1.2s_linear_infinite] rounded-full border-[3px] border-white/10 border-t-accent" />
          </div>
          <p className="text-lg font-medium">Verifying your identity...</p>
          <p className="text-sm text-muted">Confirm in World App</p>
        </div>
      )}

      {/* ── Verify Failed ── */}
      {step === "verify-failed" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-6 text-center" style={{ opacity: 0 }}>
          <div className="relative">
            <div className="animate-orb absolute -inset-4 rounded-full bg-white/5 blur-xl" />
            <div className="relative text-5xl">🔒</div>
          </div>

          <div>
            <h2 className="text-2xl font-bold">Verification needed</h2>
            <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-muted">
              Get Orb verified to unlock your free AI agent, or subscribe to get
              started right away.
            </p>
          </div>

          <div className="flex w-full max-w-[300px] flex-col gap-3">
            <button
              onClick={handleGetVerified}
              className="btn-primary rounded-2xl py-4 font-bold"
            >
              Get Orb Verified
            </button>
            <button
              onClick={handleBuyCredits}
              className="glass-button rounded-2xl py-3.5 font-semibold text-foreground"
            >
              Buy credits with USDC
            </button>
            <button
              onClick={handleSubscribeInstead}
              className="py-2 text-sm text-muted underline underline-offset-2 transition-colors hover:text-foreground"
            >
              Subscribe on instaclaw.io instead
            </button>
          </div>
        </div>
      )}

      {/* ── Duplicate Found ── */}
      {step === "duplicate-found" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-6 text-center" style={{ opacity: 0 }}>
          <div className="relative">
            <div className="animate-orb absolute -inset-4 rounded-full bg-accent/20 blur-xl" />
            <div className="relative text-5xl">🔗</div>
          </div>

          <div>
            <h2 className="text-2xl font-bold">Already have an agent?</h2>
            <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-muted">
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
              className="w-full rounded-xl border border-border bg-white/[0.04] px-4 py-3 text-center font-mono text-lg tracking-[0.3em] placeholder:text-muted/50 focus:border-accent focus:outline-none"
            />
            <p className="mt-2 text-xs text-muted">
              Get your code from instaclaw.io → Settings → Connect World Wallet
            </p>
          </div>

          {error && (
            <div className="glass-card rounded-xl px-4 py-2.5">
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          <div className="flex w-full max-w-[300px] flex-col gap-3">
            <button
              onClick={handleRedeemCode}
              disabled={linkCode.length < 8}
              className="btn-primary rounded-2xl py-4 font-bold disabled:opacity-40"
            >
              Connect existing agent
            </button>
            <button
              onClick={handleSkipDuplicate}
              className="py-2 text-sm text-muted underline underline-offset-2 transition-colors hover:text-foreground"
            >
              No, create a new agent
            </button>
          </div>
        </div>
      )}

      {/* ── Delegate ── */}
      {step === "delegate" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-6 text-center" style={{ opacity: 0 }}>
          <div className="relative">
            <div className="animate-orb absolute -inset-4 rounded-full bg-wld/20 blur-xl" />
            <div className="relative text-5xl">⚡</div>
          </div>

          <div>
            <h2 className="text-2xl font-bold">Activate with 5 WLD</h2>
            <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-muted">
              Stake 5 WLD from your grant to power your agent for ~3 days.
              That&apos;s about $1.50 — from tokens you got for free.
            </p>
          </div>

          <div className="glass-card w-full max-w-[300px] rounded-2xl px-5 py-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted">Credits</span>
              <span className="font-semibold">25 credits</span>
            </div>
            <div className="mt-2 flex justify-between text-sm">
              <span className="text-muted">Duration</span>
              <span className="font-semibold">~3 days</span>
            </div>
            <div className="mt-2 flex justify-between text-sm">
              <span className="text-muted">Cost</span>
              <span className="font-semibold text-wld">5 WLD</span>
            </div>
          </div>

          {error && (
            <div className="glass-card rounded-xl px-4 py-2.5">
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          <button
            onClick={handleDelegate}
            className="btn-wld w-full max-w-[300px] rounded-2xl py-4 text-lg font-bold"
          >
            Activate with 5 WLD
          </button>
        </div>
      )}

      {/* ── Delegating ── */}
      {step === "delegating" && (
        <div className="animate-fade-in flex flex-col items-center gap-5 text-center" style={{ opacity: 0 }}>
          <div className="relative">
            <div className="absolute -inset-3 animate-pulse rounded-full bg-wld/20 blur-xl" />
            <div className="relative h-12 w-12 animate-[spin_1.2s_linear_infinite] rounded-full border-[3px] border-white/10 border-t-wld" />
          </div>
          <p className="text-lg font-medium">Your agent is powering up...</p>
          <p className="text-sm text-muted">Deploying your personal AI</p>
        </div>
      )}

      {/* ── Ready ── */}
      {step === "ready" && (
        <div className="animate-fade-in-up flex flex-col items-center gap-8 text-center" style={{ opacity: 0 }}>
          <div className="relative">
            <div className="animate-pulse-glow absolute -inset-6 rounded-full" />
            <div className="relative text-6xl">🎉</div>
          </div>

          <div>
            <h2 className="text-2xl font-bold">Your agent is ready!</h2>
            <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-muted">
              Start chatting now. Your agent is standing by in World Chat.
            </p>
          </div>

          <button
            onClick={handleStartChat}
            className="btn-primary animate-pulse-glow w-full max-w-[300px] rounded-2xl py-4 text-lg font-bold"
          >
            Start chatting
          </button>
        </div>
      )}
    </div>
  );
}
