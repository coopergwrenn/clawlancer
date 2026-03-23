"use client";

import { MiniKit, tokenToDecimals, Tokens, VerificationLevel } from "@worldcoin/minikit-js";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Step = "welcome" | "verifying" | "verify-failed" | "delegate" | "delegating" | "ready";

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [error, setError] = useState<string | null>(null);

  // ---- TAP 1: Verify + Sign In ----
  async function handleGetAgent() {
    setStep("verifying");
    setError(null);
    try {
      // Step 1: Get nonce for SIWE
      const nonceRes = await fetch("/api/nonce");
      const { nonce } = await nonceRes.json();

      // Step 2: Wallet auth (SIWE)
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

      // Step 3: Verify SIWE on server + create session
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

      // Step 4: World ID verification
      const verifyResult = await MiniKit.commandsAsync.verify({
        action: "instaclaw-verify-human",
        verification_level: VerificationLevel.Orb,
      });

      if (verifyResult.finalPayload.status !== "success") {
        setStep("verify-failed");
        return;
      }

      // Step 5: Send proof to backend
      const verifyRes = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(verifyResult.finalPayload),
      });

      if (!verifyRes.ok) {
        setStep("verify-failed");
        return;
      }

      // Verification succeeded — move to delegation
      setStep("delegate");
    } catch (err) {
      console.error("Onboarding error:", err);
      setError("Something went wrong. Please try again.");
      setStep("welcome");
    }
  }

  // ---- TAP 2: Delegate WLD ----
  async function handleDelegate() {
    setStep("delegating");
    setError(null);
    try {
      // Initiate delegation on server
      const initRes = await fetch("/api/delegate/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "try_it" }),
      });
      const { reference, tokenAmount } = await initRes.json();

      // Execute WLD payment
      const payResult = await MiniKit.commandsAsync.pay({
        reference,
        to: process.env.NEXT_PUBLIC_RECIPIENT_ADDRESS!,
        tokens: [
          {
            symbol: Tokens.WLD,
            token_amount: tokenAmount,
          },
        ],
        description: "Activate your free InstaClaw agent",
      });

      if (payResult.finalPayload.status !== "success") {
        setError("Payment was cancelled. Try again.");
        setStep("delegate");
        return;
      }

      // Confirm delegation on server
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

      setStep("ready");
    } catch (err) {
      console.error("Delegation error:", err);
      setError("Something went wrong. Please try again.");
      setStep("delegate");
    }
  }

  // ---- TAP 3: Start Chatting ----
  async function handleStartChat() {
    try {
      // Get agent's XMTP address
      const res = await fetch("/api/auth/me");
      const data = await res.json();
      const xmtpAddress = data?.user?.xmtpAddress;

      if (xmtpAddress) {
        await MiniKit.commandsAsync.chat({
          message: "Hey! What's happening today?",
          to: [xmtpAddress],
        });
      }
      // Regardless, navigate to dashboard
      router.replace("/home");
    } catch {
      router.replace("/home");
    }
  }

  // ---- Fallback for non-Orb users ----
  function handleGetVerified() {
    // Deep-link into World's Orb verification flow
    // TODO: Register as Grow referral source (question for Mateo)
    window.open("https://worldcoin.org/download", "_blank");
  }

  function handleSubscribeInstead() {
    // Open instaclaw.io Stripe checkout
    window.open("https://instaclaw.io/billing", "_blank");
  }

  async function handleBuyCredits() {
    // Skip to credit pack purchase flow via USDC
    const initRes = await fetch("/api/pay/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pack: "50" }),
    });
    const { reference } = await initRes.json();

    const payResult = await MiniKit.commandsAsync.pay({
      reference,
      to: process.env.NEXT_PUBLIC_RECIPIENT_ADDRESS!,
      tokens: [
        {
          symbol: Tokens.USDC,
          token_amount: String(tokenToDecimals(5, Tokens.USDC)),
        },
      ],
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

  // ---- Render ----
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center px-6">
      {step === "welcome" && (
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="text-6xl">🤠</div>
          <h1 className="text-3xl font-bold tracking-tight">
            Get your free
            <br />
            AI agent
          </h1>
          <p className="max-w-[280px] text-sm text-muted">
            Verify as a real human and your personal AI agent is ready in
            seconds. Powered by your WLD grant.
          </p>
          {error && (
            <p className="text-sm text-error">{error}</p>
          )}
          <button
            onClick={handleGetAgent}
            className="w-full max-w-[300px] rounded-2xl bg-accent py-4 text-lg font-bold text-black active:scale-[0.98] transition-transform"
          >
            Get your free AI agent
          </button>
        </div>
      )}

      {step === "verifying" && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="h-10 w-10 animate-spin rounded-full border-3 border-accent border-t-transparent" />
          <p className="text-lg font-medium">Verifying your identity...</p>
          <p className="text-sm text-muted">Confirm in World App</p>
        </div>
      )}

      {step === "verify-failed" && (
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="text-5xl">🔒</div>
          <h2 className="text-2xl font-bold">Verification needed</h2>
          <p className="max-w-[280px] text-sm text-muted">
            Get Orb verified to unlock your free AI agent, or subscribe to get
            started right away.
          </p>
          <div className="flex w-full max-w-[300px] flex-col gap-3">
            <button
              onClick={handleGetVerified}
              className="rounded-2xl bg-accent py-4 font-bold text-black active:scale-[0.98] transition-transform"
            >
              Get Orb Verified
            </button>
            <button
              onClick={handleBuyCredits}
              className="rounded-2xl border border-border py-3.5 font-semibold text-foreground active:scale-[0.98] transition-transform"
            >
              Buy credits with USDC
            </button>
            <button
              onClick={handleSubscribeInstead}
              className="py-2 text-sm text-muted underline"
            >
              Subscribe on instaclaw.io instead
            </button>
          </div>
        </div>
      )}

      {step === "delegate" && (
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="text-5xl">⚡</div>
          <h2 className="text-2xl font-bold">Activate with 5 WLD</h2>
          <p className="max-w-[280px] text-sm text-muted">
            Stake 5 WLD from your grant to power your agent for ~3 days. That&apos;s
            about $1.50 — from tokens you got for free.
          </p>
          <div className="rounded-xl border border-border bg-card px-5 py-3 text-left text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Credits</span>
              <span className="font-medium">25 credits</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-muted">Duration</span>
              <span className="font-medium">~3 days</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-muted">Cost</span>
              <span className="font-medium text-wld">5 WLD</span>
            </div>
          </div>
          {error && (
            <p className="text-sm text-error">{error}</p>
          )}
          <button
            onClick={handleDelegate}
            className="w-full max-w-[300px] rounded-2xl bg-wld py-4 text-lg font-bold text-black active:scale-[0.98] transition-transform"
          >
            Activate with 5 WLD
          </button>
        </div>
      )}

      {step === "delegating" && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="h-10 w-10 animate-spin rounded-full border-3 border-wld border-t-transparent" />
          <p className="text-lg font-medium">Your agent is powering up...</p>
          <p className="text-sm text-muted">Deploying your personal AI</p>
        </div>
      )}

      {step === "ready" && (
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="text-6xl">🎉</div>
          <h2 className="text-2xl font-bold">Your agent is ready!</h2>
          <p className="max-w-[280px] text-sm text-muted">
            Start chatting now. Your agent is standing by in World Chat.
          </p>
          <button
            onClick={handleStartChat}
            className="w-full max-w-[300px] rounded-2xl bg-accent py-4 text-lg font-bold text-black active:scale-[0.98] transition-transform"
          >
            Start chatting
          </button>
        </div>
      )}
    </div>
  );
}
