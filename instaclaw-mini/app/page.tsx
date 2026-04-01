"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Onboarding from "@/components/onboarding/onboarding";

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

  return <Onboarding />;
}
