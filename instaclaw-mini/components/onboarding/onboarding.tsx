"use client";

import { MiniKit, tokenToDecimals, Tokens, VerificationLevel } from "@worldcoin/minikit-js";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type Step = "welcome" | "verifying" | "collect-email" | "verify-failed" | "duplicate-found" | "delegate" | "delegating" | "ready";

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
  background: "#ffffff",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  border: "1px solid rgba(0, 0, 0, 0.08)",
  boxShadow:
    "rgba(0, 0, 0, 0.04) 0px 2px 2px 0px inset, rgba(255, 255, 255, 0.8) 0px -1px 1px 0px inset, rgba(0, 0, 0, 0.06) 0px 2px 4px 0px, rgba(255, 255, 255, 0.5) 0px 0px 1px 2px inset",
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

// ── Pixel Avatars (8x8 grids) ──
// h=hair, s=skin, e=eye, m=mouth, b=shirt, space=transparent

const avatars: Record<string, { grid: string[]; colors: Record<string, string>; bg: string }> = {
  SM: { grid: ["  hhhh  "," hhhhhh ","hhsssshh","h sese h","h ssss h","h smms h","   ss   ","  bbbb  "], colors: { h:"#5C3A1E",s:"#F5D0A9",e:"#1A1A1A",m:"#CC6666",b:"#6B8E9B" }, bg:"#E8DDD3" },
  JK: { grid: ["  hhhh  "," hhhhhh "," hssssh ","  sese  ","  ssss  ","  smms  ","   ss   ","  bbbb  "], colors: { h:"#2C1810",s:"#FADDBA",e:"#1A1A1A",m:"#CC6666",b:"#4A6FA5" }, bg:"#D5DDE5" },
  PR: { grid: ["  hhhh  "," hhhhhh ","hhsssshh","h sese h","h ssss h","h smms h","   ss   ","  bbbb  "], colors: { h:"#1A1A2A",s:"#C68642",e:"#1A1A1A",m:"#B85C5C",b:"#B8860B" }, bg:"#E5D8C3" },
  MT: { grid: [" hhhhhh "," hhhhhh "," hssssh ","  sese  ","  ssss  ","  smms  ","   ss   ","  bbbb  "], colors: { h:"#1A1A2A",s:"#8D6E4C",e:"#1A1A1A",m:"#A0522D",b:"#E8734A" }, bg:"#E0D5CA" },
  AL: { grid: ["  hhhh  "," hhhhhh ","hhsssshh","h sese h","  ssss  ","  smms  ","   ss   ","  bbbb  "], colors: { h:"#D4A017",s:"#FFE0BD",e:"#1A1A1A",m:"#E8888A",b:"#7CB68E" }, bg:"#D8E5D5" },
  DW: { grid: ["  hhhh  "," hhhhhh "," hssssh ","  sese  ","  ssss  ","  hmmh  ","   hh   ","  bbbb  "], colors: { h:"#6B4226",s:"#FADDBA",e:"#1A1A1A",m:"#CC6666",b:"#333333" }, bg:"#D5D5D5" },
  RS: { grid: ["  hhhh  "," hhhhhh ","hhsssshh","h sese h","h ssss h","h smms h","   ss   ","  bbbb  "], colors: { h:"#A0522D",s:"#FFE0BD",e:"#1A1A1A",m:"#CC6666",b:"#9B6B8E" }, bg:"#E5D5DE" },
  TH: { grid: ["  hhhh  "," hhhhhh "," hssssh ","  sese  ","  ssss  ","  smms  ","   ss   ","  bbbb  "], colors: { h:"#4A3728",s:"#D4A574",e:"#1A1A1A",m:"#B85C5C",b:"#5B7553" }, bg:"#D5E0D5" },
  NP: { grid: ["  hhhh  "," hhhhhh ","hhsssshh","h sese h","h ssss h","h smms h","   ss   ","  bbbb  "], colors: { h:"#2C1810",s:"#D4A574",e:"#1A1A1A",m:"#B85C5C",b:"#4A4A6A" }, bg:"#D8D5E0" },
  CD: { grid: ["  hhhh  "," hhhhhh "," hssssh ","  sese  ","  ssss  ","  smms  ","   ss   ","  bbbb  "], colors: { h:"#C4A45A",s:"#FADDBA",e:"#1A1A1A",m:"#CC6666",b:"#5A8FA5" }, bg:"#D5E0E5" },
};

function PixelAvatar({ id }: { id: string }) {
  const d = avatars[id];
  if (!d) return null;
  return (
    <svg width="24" height="24" viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
      <rect width="8" height="8" fill={d.bg} />
      {d.grid.map((row, y) =>
        [...row].map((c, x) => {
          if (c === " ") return null;
          const color = d.colors[c];
          return color ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} /> : null;
        })
      )}
    </svg>
  );
}

// ── Testimonials ──

type Testimonial = { quote: string; name: string; role: string; avatarId: string; bg: string };

const TESTIMONIALS_ROW_1: Testimonial[] = [
  { quote: "I asked it to plan my entire vacation, book restaurants, and draft packing lists. It did all of it.", name: "Sarah M.", role: "Freelancer", avatarId: "SM", bg: "#E8DDD3" },
  { quote: "I told it what I needed and it figured out the rest. A week later it was doing things I didn't even ask for yet.", name: "James K.", role: "Small Business Owner", avatarId: "JK", bg: "#D5DDE5" },
  { quote: "It remembered every detail about 200+ clients and followed up with each one personally.", name: "Priya R.", role: "Real Estate Agent", avatarId: "PR", bg: "#E5D8C3" },
  { quote: "I gave it one task as a test. An hour later it had done that plus five other things I didn't think to ask for.", name: "Marcus T.", role: "Content Creator", avatarId: "MT", bg: "#E0D5CA" },
  { quote: "It wrote my cover letters, prepped me for interviews, and tracked every application. I got the job because of this.", name: "Ava L.", role: "College Student", avatarId: "AL", bg: "#D8E5D5" },
];

const TESTIMONIALS_ROW_2: Testimonial[] = [
  { quote: "I went to sleep. Woke up to 30 emails answered, my calendar organized, and a summary waiting for me.", name: "Danny W.", role: "Startup Founder", avatarId: "DW", bg: "#D5D5D5" },
  { quote: "It gets smarter every week. I taught it how I like my reports and now it just does them perfectly.", name: "Rachel S.", role: "Marketing Manager", avatarId: "RS", bg: "#E5D5DE" },
  { quote: "The dashboard makes everything so simple. I'm not technical at all and I manage it myself.", name: "Tom H.", role: "Teacher", avatarId: "TH", bg: "#D5E0D5" },
  { quote: "There is nothing I've thrown at it that it couldn't do. Emails, research, scheduling, writing. Anything.", name: "Nina P.", role: "Consultant", avatarId: "NP", bg: "#D8D5E0" },
  { quote: "My 68-year-old mom set it up by herself and now she won't stop telling her friends about it.", name: "Chris D.", role: "Product Designer", avatarId: "CD", bg: "#D5E0E5" },
];

const testimonialCardStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid rgba(0,0,0,0.08)",
  boxShadow: "rgba(0,0,0,0.04) 0px 2px 2px 0px inset, rgba(255,255,255,0.8) 0px -1px 1px 0px inset, rgba(0,0,0,0.06) 0px 2px 4px 0px",
};

function TestimonialMarquee({ items, direction }: { items: Testimonial[]; direction: "left" | "right" }) {
  const cls = direction === "left" ? "animate-testimonial-left" : "animate-testimonial-right";
  const repeated = [...items, ...items, ...items, ...items];

  return (
    <div className="overflow-hidden w-full py-1">
      <div className={`flex gap-3 w-max ${cls}`}>
        {repeated.map((t, i) => (
          <div
            key={`${t.name}-${i}`}
            className="w-[220px] shrink-0 rounded-2xl p-3.5"
            style={testimonialCardStyle}
          >
            <div className="mb-2 flex items-center gap-2.5">
              <div
                className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full"
                style={{
                  background: `radial-gradient(circle at 35% 35%, ${t.bg}dd, ${t.bg}88 40%, rgba(0,0,0,0.2) 100%)`,
                  boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.2), inset 0 2px 3px rgba(255,255,255,0.4), 0 1px 3px rgba(0,0,0,0.12)",
                }}
              >
                <span className="pointer-events-none absolute left-[4px] top-[2px] h-[4px] w-[12px] rounded-full" style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 100%)" }} />
                <div className="relative z-[1] h-6 w-6 overflow-hidden rounded-full">
                  <PixelAvatar id={t.avatarId} />
                </div>
              </div>
              <div>
                <p className="text-[11px] font-semibold" style={{ color: "#333334" }}>{t.name}</p>
                <p className="text-[10px]" style={{ color: "#6b6b6b" }}>{t.role}</p>
              </div>
            </div>
            <p className="text-[11px] leading-[1.5]" style={{ color: "#333334" }}>
              &ldquo;{t.quote}&rdquo;
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SpotsOpenPill() {
  const [spots, setSpots] = useState<number>(62); // hardcoded default, updated by API

  useEffect(() => {
    fetch("/api/spots")
      .then((r) => r.json())
      .then((d) => { if (typeof d.available === "number") setSpots(d.available); })
      .catch(() => {}); // keep hardcoded default
  }, []);

  const orbBg = spots >= 10
    ? "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.7), rgba(220,103,67,0.4) 50%, rgba(180,70,40,0.75) 100%)"
    : spots >= 3
      ? "radial-gradient(circle at 35% 30%, rgba(245,158,11,0.7), rgba(245,158,11,0.4) 50%, rgba(200,120,10,0.75) 100%)"
      : "radial-gradient(circle at 35% 30%, rgba(239,68,68,0.7), rgba(239,68,68,0.4) 50%, rgba(200,50,50,0.75) 100%)";

  const glowBg = spots >= 10
    ? "radial-gradient(circle, rgba(220,103,67,0.4) 0%, transparent 70%)"
    : spots >= 3
      ? "radial-gradient(circle, rgba(245,158,11,0.4) 0%, transparent 70%)"
      : "radial-gradient(circle, rgba(239,68,68,0.4) 0%, transparent 70%)";

  const text = spots >= 1
    ? `${spots} Spots Open`
    : "Servers restocking";

  return (
    <span
      className="mb-6 inline-flex items-center gap-2.5 rounded-full px-5 py-2 text-xs font-medium animate-fade-in"
      style={{
        background: "#ffffff",
        border: "1px solid rgba(0,0,0,0.08)",
        boxShadow:
          "rgba(0,0,0,0.04) 0px 2px 2px 0px inset, rgba(255,255,255,0.8) 0px -1px 1px 0px inset, rgba(0,0,0,0.06) 0px 2px 4px 0px, rgba(255,255,255,0.5) 0px 0px 1px 2px inset",
        color: "#333334",
        opacity: 0,
      }}
    >
      {/* Glass orb */}
      <span
        className="relative flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full"
        style={{
          background: orbBg,
          boxShadow:
            "inset 0 -2px 4px rgba(0,0,0,0.3), inset 0 2px 4px rgba(255,255,255,0.5), inset 0 0 3px rgba(0,0,0,0.15), 0 1px 4px rgba(0,0,0,0.15)",
        }}
      >
        {/* Shimmer sweep */}
        <span
          className="absolute inset-0 rounded-full"
          style={{
            background: "linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0.4) 55%, transparent 80%)",
            backgroundSize: "300% 100%",
            animation: "globe-shimmer 4s linear infinite",
          }}
        />
        {/* Glass highlight */}
        <span
          className="pointer-events-none absolute left-[3px] top-[2px] h-[5px] w-[8px] rounded-full"
          style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)" }}
        />
        {/* Breathing glow */}
        <span
          className="absolute -inset-0.5 rounded-full"
          style={{ background: glowBg, animation: "globe-glow 4s ease-in-out infinite" }}
        />
      </span>
      {text}
    </span>
  );
}

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [walletPayload, setWalletPayload] = useState<Record<string, unknown> | null>(null);

  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  // ── TAP 1a: Wallet Auth → collect email ──
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

      // Store wallet payload and collect email before creating account
      setWalletPayload(authResult.finalPayload as unknown as Record<string, unknown>);
      setStep("collect-email");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
      console.error("[Onboarding] Wallet auth error:", errMsg);
      setError(`Error: ${errMsg}`);
      setStep("welcome");
    }
  }

  // ── TAP 1b: Email collected → login + verify ──
  async function handleEmailContinue() {
    if (!walletPayload || !isValidEmail) return;
    setStep("verifying");
    setError(null);
    try {
      // Create account with email
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...walletPayload, email: email.trim().toLowerCase() }),
      });
      if (!loginRes.ok) {
        const loginErrText = await loginRes.text().catch(() => "no body");
        console.error("[Onboarding] Login failed:", loginRes.status, loginErrText);
        setError(`Login ${loginRes.status}: ${loginErrText}`);
        setStep("collect-email");
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
      const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
      console.error("[Onboarding] Caught error:", errMsg, err);
      setError(`Error: ${errMsg}`);
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

  // ── Render ──
  return (
    <div className="h-[100dvh] flex flex-col onboarding-light">
      {/* ── Welcome ── */}
      {step === "welcome" && (
        <>
          <div className="flex-1 flex flex-col animate-fade-in-up" style={{ opacity: 0 }}>
            {/* Top: title group — pushed down a bit from top */}
            <div className="flex flex-col items-center px-6 pt-[6vh]">
              <SpotsOpenPill />
              <h1 className="text-center text-[42px] tracking-[-0.5px] leading-[1.05]" style={serif}>
                Claim your free
                <br />
                <span className="shimmer-text text-[64px]" style={serif}>AI agent</span>
              </h1>
              <p className="mt-3 max-w-[340px] text-center text-[14px] leading-relaxed" style={{ color: "#6b6b6b" }}>
                Verify as a real human and your personal AI agent is ready in seconds. Powered by your WLD grant.
              </p>
            </div>

            {/* Middle: marquees — flex-grow centers them in remaining space */}
            <div className="flex-1 flex flex-col justify-center">
              {/* Use-case pills */}
              <div className="w-screen overflow-hidden relative">
                <div className="absolute left-0 top-0 bottom-0 w-16 z-10 pointer-events-none" style={{ background: "linear-gradient(to right, #f8f7f4, transparent)" }} />
                <div className="absolute right-0 top-0 bottom-0 w-16 z-10 pointer-events-none" style={{ background: "linear-gradient(to left, #f8f7f4, transparent)" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <MarqueeRow items={MARQUEE_ROW_1} direction="left" />
                  <MarqueeRow items={MARQUEE_ROW_2} direction="right" />
                </div>
              </div>

              {/* Testimonial cards */}
              <div className="mt-4 w-screen overflow-hidden relative">
                <div className="absolute left-0 top-0 bottom-0 w-16 z-10 pointer-events-none" style={{ background: "linear-gradient(to right, #f8f7f4, transparent)" }} />
                <div className="absolute right-0 top-0 bottom-0 w-16 z-10 pointer-events-none" style={{ background: "linear-gradient(to left, #f8f7f4, transparent)" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <TestimonialMarquee items={TESTIMONIALS_ROW_1} direction="left" />
                  <TestimonialMarquee items={TESTIMONIALS_ROW_2} direction="right" />
                </div>
              </div>
            </div>

            {error && (
              <div className="mx-6 mb-2 rounded-xl px-4 py-2.5" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                <p className="text-sm text-center" style={{ color: "#ef4444" }}>{error}</p>
              </div>
            )}
          </div>

          {/* CTA — pinned to bottom */}
          <div
            className="px-7 pt-4"
            style={{ paddingBottom: "calc(max(env(safe-area-inset-bottom, 20px), 20px) + 16px)" }}
          >
            <button
              onClick={handleGetAgent}
              className="btn-primary w-full rounded-[28px] text-base font-semibold"
              style={{ height: "56px" }}
            >
              Claim my agent
            </button>
          </div>
        </>
      )}

      {/* ── Collect Email ── */}
      {step === "collect-email" && (
        <>
          <div className="flex-1 flex flex-col items-center justify-center px-6 animate-fade-in-up" style={{ opacity: 0 }}>
            <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>One more thing</h2>
            <p className="mt-2 max-w-[280px] text-center text-[14px] leading-relaxed" style={{ color: "#6b6b6b" }}>
              Enter your email so your agent can reach you with updates and notifications.
            </p>
            <input
              type="email"
              inputMode="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-6 w-full max-w-[300px] rounded-xl px-4 py-3.5 text-center text-[15px] focus:outline-none"
              style={{ background: "rgba(0,0,0,0.03)", border: `1px solid ${isValidEmail ? "rgba(220,103,67,0.4)" : "rgba(0,0,0,0.1)"}`, color: "#333334", transition: "border-color 0.2s" }}
            />
            {error && (
              <div className="mt-3 rounded-xl px-4 py-2.5" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                <p className="text-xs" style={{ color: "#ef4444" }}>{error}</p>
              </div>
            )}
          </div>
          <div className="px-7 pt-4" style={{ paddingBottom: "calc(max(env(safe-area-inset-bottom, 20px), 20px) + 16px)" }}>
            <button
              onClick={handleEmailContinue}
              disabled={!isValidEmail}
              className="btn-primary w-full rounded-[28px] text-base font-semibold disabled:opacity-40"
              style={{ height: "56px" }}
            >
              Continue
            </button>
          </div>
        </>
      )}

      {/* ── Verifying ── */}
      {step === "verifying" && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 animate-fade-in" style={{ opacity: 0 }}>
          <div className="relative mb-5">
            <div className="absolute -inset-3 animate-pulse rounded-full blur-xl" style={{ background: "rgba(220,103,67,0.15)" }} />
            <div className="relative h-12 w-12 animate-[spin_1.2s_linear_infinite] rounded-full" style={{ border: "3px solid rgba(0,0,0,0.08)", borderTopColor: "#DC6743" }} />
          </div>
          <p className="text-lg" style={{ ...serif, color: "#333334" }}>Verifying your identity...</p>
          <p className="mt-1 text-sm" style={{ color: "#6b6b6b" }}>Confirm in World App</p>
        </div>
      )}

      {/* ── Verify Failed ── */}
      {step === "verify-failed" && (
        <>
          <div className="flex-1 flex flex-col items-center justify-center px-6 animate-fade-in-up" style={{ opacity: 0 }}>
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.12), rgba(220,103,67,0.04) 70%)" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#DC6743" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </div>
            <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>Verification needed</h2>
            <p className="mt-2 max-w-[260px] text-center text-[13px] leading-relaxed" style={{ color: "#6b6b6b" }}>
              Get Orb verified to unlock your free AI agent, or subscribe to get started right away.
            </p>
          </div>
          <div className="px-7 flex flex-col gap-2.5" style={{ paddingBottom: "calc(max(env(safe-area-inset-bottom, 20px), 20px) + 16px)" }}>
            <button onClick={handleGetVerified} className="btn-primary w-full rounded-[28px] font-semibold" style={{ height: "56px" }}>Get Orb Verified</button>
            <button onClick={handleBuyCredits} className="w-full rounded-[28px] font-semibold" style={{ height: "52px", background: "rgba(0,0,0,0.04)", color: "#333334", border: "1px solid rgba(0,0,0,0.08)" }}>Buy credits with USDC</button>
            <button onClick={handleSubscribeInstead} className="py-2 text-sm underline underline-offset-2" style={{ color: "#6b6b6b" }}>Subscribe on instaclaw.io instead</button>
          </div>
        </>
      )}

      {/* ── Duplicate Found ── */}
      {step === "duplicate-found" && (
        <>
          <div className="flex-1 flex flex-col items-center justify-center px-6 animate-fade-in-up" style={{ opacity: 0 }}>
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.12), rgba(220,103,67,0.04) 70%)" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#DC6743" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </div>
            <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>Already have an agent?</h2>
            <p className="mt-2 max-w-[260px] text-center text-[13px] leading-relaxed" style={{ color: "#6b6b6b" }}>
              Enter your linking code from instaclaw.io to connect to your existing agent.
            </p>
            <input
              type="text"
              value={linkCode}
              onChange={(e) => setLinkCode(e.target.value.toUpperCase())}
              placeholder="XXXX XXXX"
              maxLength={8}
              className="mt-6 w-full max-w-[260px] rounded-xl px-4 py-3.5 text-center font-mono text-xl tracking-[0.3em] focus:outline-none"
              style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.1)", color: "#333334" }}
            />
            {error && <p className="mt-2 text-xs" style={{ color: "#ef4444" }}>{error}</p>}
          </div>
          <div className="px-7 flex flex-col gap-2.5" style={{ paddingBottom: "calc(max(env(safe-area-inset-bottom, 20px), 20px) + 16px)" }}>
            <button onClick={handleRedeemCode} disabled={linkCode.length < 8} className="btn-primary w-full rounded-xl font-semibold disabled:opacity-40" style={{ height: "56px" }}>Connect existing agent</button>
            <button onClick={handleSkipDuplicate} className="py-2 text-sm underline underline-offset-2" style={{ color: "#6b6b6b" }}>No, create a new agent</button>
          </div>
        </>
      )}

      {/* ── Delegate ── */}
      {step === "delegate" && (
        <>
          <div className="flex-1 flex flex-col items-center justify-center px-6 animate-fade-in-up" style={{ opacity: 0 }}>
            <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>Activate with 5 WLD</h2>
            <p className="mt-2 max-w-[260px] text-center text-[13px] leading-relaxed" style={{ color: "#6b6b6b" }}>
              Stake 5 WLD from your grant to power your agent for ~3 days. That&apos;s about $1.50 — tokens you got for free.
            </p>
            <div className="mt-6 w-full max-w-[280px] rounded-xl px-5 py-4" style={{ background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.08)" }}>
              <div className="flex justify-between text-sm" style={{ color: "#333334" }}>
                <span style={{ color: "#6b6b6b" }}>Credits</span>
                <span className="font-semibold">25 credits</span>
              </div>
              <div className="mt-2.5 flex justify-between text-sm" style={{ color: "#333334" }}>
                <span style={{ color: "#6b6b6b" }}>Duration</span>
                <span className="font-semibold">~3 days</span>
              </div>
              <div className="mt-2.5 flex justify-between text-sm" style={{ color: "#333334" }}>
                <span style={{ color: "#6b6b6b" }}>Cost</span>
                <span className="font-semibold" style={{ color: "#1dc1a0" }}>5 WLD</span>
              </div>
            </div>
            {error && (
              <div className="mt-4 rounded-xl px-4 py-2.5" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                <p className="text-sm" style={{ color: "#ef4444" }}>{error}</p>
              </div>
            )}
          </div>
          <div className="px-7" style={{ paddingBottom: "calc(max(env(safe-area-inset-bottom, 20px), 20px) + 16px)" }}>
            <button onClick={handleDelegate} className="btn-wld w-full rounded-[28px] text-base font-semibold" style={{ height: "56px" }}>
              Activate with 5 WLD
            </button>
          </div>
        </>
      )}

      {/* ── Delegating ── */}
      {step === "delegating" && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 animate-fade-in" style={{ opacity: 0 }}>
          <div className="relative mb-5">
            <div className="absolute -inset-3 animate-pulse rounded-full blur-xl" style={{ background: "rgba(29,193,160,0.15)" }} />
            <div className="relative h-12 w-12 animate-[spin_1.2s_linear_infinite] rounded-full" style={{ border: "3px solid rgba(0,0,0,0.08)", borderTopColor: "#1dc1a0" }} />
          </div>
          <p className="text-lg" style={{ ...serif, color: "#333334" }}>Your agent is powering up...</p>
          <p className="mt-1 text-sm" style={{ color: "#6b6b6b" }}>Deploying your personal AI</p>
        </div>
      )}

      {/* ── Ready ── */}
      {step === "ready" && (
        <>
          <div className="flex-1 flex flex-col items-center justify-center px-6 animate-fade-in-up" style={{ opacity: 0 }}>
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, rgba(34,197,94,0.15), rgba(34,197,94,0.04) 70%)" }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            </div>
            <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>Your agent is ready!</h2>
            <p className="mt-2 max-w-[260px] text-center text-[13px] leading-relaxed" style={{ color: "#6b6b6b" }}>
              Start chatting now. Your agent is standing by in World Chat.
            </p>
          </div>
          <div className="px-7" style={{ paddingBottom: "calc(max(env(safe-area-inset-bottom, 20px), 20px) + 16px)" }}>
            <button onClick={handleStartChat} className="btn-primary w-full rounded-xl text-base font-semibold" style={{ height: "56px" }}>
              Start chatting
            </button>
          </div>
        </>
      )}
    </div>
  );
}
