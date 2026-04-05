"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Onboarding from "@/components/onboarding/onboarding";

function MaintenanceEmailForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !email.includes("@")) return;
    setStatus("submitting");
    try {
      const res = await fetch("/api/notify-launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setStatus(res.ok ? "done" : "error");
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        padding: "0.75rem 1.25rem",
        borderRadius: "14px",
        background: "rgba(34,197,94,0.06)",
        border: "1px solid rgba(34,197,94,0.12)",
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        <span style={{ fontSize: "0.8rem", color: "#16a34a", fontWeight: 500 }}>
          We&apos;ll notify you when we launch
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{
      display: "flex",
      gap: "0.5rem",
      width: "100%",
    }}>
      <div style={{
        flex: 1,
        borderRadius: "14px",
        background: "rgba(255,255,255,0.45)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.5)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 2px rgba(0,0,0,0.02), 0 1px 3px rgba(0,0,0,0.03)",
        overflow: "hidden",
      }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Your email"
          required
          style={{
            width: "100%",
            padding: "0.75rem 1rem",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "#333334",
            fontSize: "0.85rem",
            letterSpacing: "0.01em",
          }}
        />
      </div>
      <button
        type="submit"
        disabled={status === "submitting"}
        style={{
          padding: "0.75rem 1.25rem",
          borderRadius: "14px",
          fontSize: "0.8rem",
          fontWeight: 600,
          whiteSpace: "nowrap",
          cursor: status === "submitting" ? "wait" : "pointer",
          opacity: status === "submitting" ? 0.7 : 1,
          background: "linear-gradient(170deg, #c97856 0%, #be6843 50%, #b45e3a 100%)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.15)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), 0 4px 16px rgba(200,105,60,0.35), 0 1px 3px rgba(0,0,0,0.15)",
          textShadow: "0 1px 2px rgba(0,0,0,0.2)",
          transition: "all 0.3s cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        {status === "submitting" ? "..." : "Notify me"}
      </button>
    </form>
  );
}

export default function RootPage() {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "not-world" | "onboarding">("loading");
  const resolved = useRef(false);

  useEffect(() => {
    console.log("[InstaClaw] Root page mounted");

    // Hard timeout: force past splash after 5 seconds
    const forceTimer = setTimeout(() => {
      if (!resolved.current) {
        console.log("[InstaClaw] Force timeout — showing onboarding");
        resolved.current = true;
        setState("onboarding");
      }
    }, 5000);

    async function tryAutoLogin() {
      // Step 1: Check existing session first (fastest path)
      try {
        const meRes = await fetch("/api/auth/me");
        if (meRes.ok) {
          const meData = await meRes.json();
          if (meData?.user?.agentReady) {
            console.log("[InstaClaw] Existing session + ready agent → dashboard");
            resolved.current = true;
            router.replace("/home");
            return;
          }
          if (meData?.user?.hasAgent) {
            console.log("[InstaClaw] Existing session + agent (configuring) → home");
            resolved.current = true;
            router.replace("/home");
            return;
          }
          if (meData?.user?.id) {
            // Has session but no agent — check if verified (mid-provisioning) or needs onboarding
            if (meData.user.worldIdVerified) {
              console.log("[InstaClaw] Existing session, verified, no agent → provisioning");
              resolved.current = true;
              router.replace("/home");
              return;
            }
            // Not verified, no agent → show onboarding (don't redirect to /home or it loops)
            console.log("[InstaClaw] Existing session, NOT verified → onboarding");
            resolved.current = true;
            setState("onboarding");
            return;
          }
        }
      } catch {
        console.log("[InstaClaw] /api/auth/me failed, trying wallet auto-login");
      }

      // Step 2: No session — try wallet-based auto-login via MiniKit
      // MiniKit.user may not be populated immediately after install — retry a few times
      let walletAddress: string | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 400));
        walletAddress = MiniKit.user?.walletAddress;
        if (walletAddress && walletAddress.startsWith("0x")) break;
        console.log(`[InstaClaw] Wallet attempt ${attempt + 1}: ${walletAddress || "null"}`);
      }
      console.log("[InstaClaw] Final walletAddress:", walletAddress);

      if (walletAddress && typeof walletAddress === "string" && walletAddress.startsWith("0x")) {
        try {
          const autoRes = await fetch(`/api/auth/auto-login?wallet=${encodeURIComponent(walletAddress)}`);
          if (autoRes.ok) {
            const autoData = await autoRes.json();
            if (autoData?.user?.id) {
              console.log("[InstaClaw] Auto-login success:", autoData.user.id, "hasAgent:", autoData.user.hasAgent);
              resolved.current = true;
              if (autoData.user.hasAgent) {
                router.replace("/home");
              } else if (autoData.user.worldIdVerified) {
                // Verified but no agent — mid-provisioning
                router.replace("/home");
              } else {
                // Not verified — show onboarding
                setState("onboarding");
              }
              return;
            }
          }
        } catch (err) {
          console.error("[InstaClaw] Auto-login failed:", err);
        }
      }

      // Step 3: No session, no wallet match — new user, show onboarding
      if (!resolved.current) {
        console.log("[InstaClaw] No session or wallet match — showing onboarding");
        resolved.current = true;
        setState("onboarding");
      }
    }

    tryAutoLogin();

    return () => clearTimeout(forceTimer);
  }, [router]);

  // Not in World App
  if (state === "not-world") {
    return (
      <div style={{ background: "#f8f7f4", color: "#333334", height: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2rem", padding: "2rem", textAlign: "center" }}>
        <div>
          <h1 style={{ fontSize: "1.75rem", fontFamily: "'Instrument Serif', Georgia, serif", letterSpacing: "-0.5px" }}>InstaClaw</h1>
          <p style={{ marginTop: "0.5rem", color: "#6b6b6b", fontSize: "0.875rem", maxWidth: "280px", lineHeight: "1.6" }}>
            Open this app inside World App to get your free AI agent.
          </p>
        </div>
        <a
          href="https://worldcoin.org/download"
          style={{ background: "linear-gradient(180deg, rgba(218,119,86,0.95), rgba(200,85,52,1))", color: "#fff", padding: "0.875rem 2rem", borderRadius: "0.75rem", fontWeight: "600", textDecoration: "none", boxShadow: "0 2px 8px rgba(218,119,86,0.3)" }}
        >
          Get World App
        </a>
      </div>
    );
  }

  // Loading
  if (state === "loading") {
    return (
      <div style={{ background: "#f8f7f4", color: "#333334", height: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem" }}>
        <div style={{ width: "2.5rem", height: "2.5rem", border: "3px solid rgba(0,0,0,0.08)", borderTopColor: "#da7756", borderRadius: "50%", animation: "spin 1.2s linear infinite" }} />
        <p style={{ fontSize: "0.75rem", color: "#6b6b6b" }}>Loading InstaClaw...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Maintenance gate — block new signups while keeping existing users functional.
  // NEXT_PUBLIC_MAINTENANCE must be set in Vercel env vars for instaclaw-mini project.
  // Renders full onboarding behind a frosted glass overlay so the hero stays visible + alive.
  if (process.env.NEXT_PUBLIC_MAINTENANCE === "true") {
    return (
      <div style={{ position: "relative", height: "100dvh", overflow: "hidden" }}>
        {/* Live onboarding hero behind the overlay — visible but non-interactive */}
        <div style={{ pointerEvents: "none", height: "100dvh" }} aria-hidden="true">
          <Onboarding />
        </div>

        {/* Frosted glass overlay */}
        <div style={{
          position: "absolute",
          inset: 0,
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          backdropFilter: "blur(6px) saturate(1.1)",
          WebkitBackdropFilter: "blur(6px) saturate(1.1)",
          background: "rgba(248,247,244,0.45)",
        }}>
          {/* Glass card */}
          <div className="animate-fade-in-up" style={{
            opacity: 0,
            width: "100%",
            maxWidth: "340px",
            padding: "2.25rem 1.75rem",
            borderRadius: "24px",
            background: "linear-gradient(145deg, rgba(255,255,255,0.55), rgba(255,255,255,0.35))",
            backdropFilter: "blur(24px) saturate(1.4)",
            WebkitBackdropFilter: "blur(24px) saturate(1.4)",
            border: "1px solid rgba(255,255,255,0.5)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.7), inset 0 -1px 0 rgba(0,0,0,0.02)",
            textAlign: "center",
          }}>
            {/* Icon */}
            <div style={{
              width: "56px",
              height: "56px",
              borderRadius: "16px",
              background: "linear-gradient(135deg, rgba(218,119,86,0.10), rgba(218,119,86,0.03))",
              border: "1px solid rgba(218,119,86,0.12)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6), 0 2px 8px rgba(218,119,86,0.08)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 1.25rem",
            }}>
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                style={{ animation: "maintenance-spin 3s linear infinite" }}
              >
                {[0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => (
                  <line
                    key={angle}
                    x1="12"
                    y1="3"
                    x2="12"
                    y2="7"
                    stroke="#da7756"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    transform={`rotate(${angle} 12 12)`}
                    style={{
                      opacity: 0.25 + (i / 8) * 0.75,
                    }}
                  />
                ))}
              </svg>
              <style>{`
                @keyframes maintenance-spin {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
              `}</style>
            </div>

            {/* Title */}
            <h1 style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: "1.75rem",
              letterSpacing: "-0.5px",
              color: "#333334",
              marginBottom: "0.5rem",
              lineHeight: 1.2,
            }}>
              Something big is coming
            </h1>

            {/* Subtitle */}
            <p style={{
              color: "#6b6b6b",
              fontSize: "0.85rem",
              lineHeight: 1.7,
              marginBottom: "1.5rem",
            }}>
              We&apos;re upgrading InstaClaw. Get notified when new signups reopen.
            </p>

            {/* Email form */}
            <MaintenanceEmailForm />

            {/* Status pill */}
            <div style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 1rem",
              borderRadius: "999px",
              background: "rgba(255,255,255,0.35)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              border: "1px solid rgba(255,255,255,0.4)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 1px 3px rgba(0,0,0,0.02)",
              marginTop: "1.25rem",
            }}>
              <div style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "#da7756",
                boxShadow: "0 0 6px rgba(218,119,86,0.4)",
                animation: "pulse-dot 2s ease-in-out infinite",
              }} />
              <span style={{ fontSize: "0.7rem", color: "#888", letterSpacing: "0.02em" }}>
                Launching this week
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <Onboarding />;
}
