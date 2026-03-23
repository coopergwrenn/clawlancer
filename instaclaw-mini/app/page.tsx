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

    // HARD TIMEOUT: force past splash after 3 seconds no matter what
    const forceTimer = setTimeout(() => {
      if (!resolved.current) {
        console.log("[InstaClaw] Force timeout — showing onboarding");
        resolved.current = true;
        setState("onboarding");
      }
    }, 3000);

    // Try MiniKit detection
    try {
      const installed = MiniKit.isInstalled();
      console.log("[InstaClaw] MiniKit.isInstalled():", installed);

      if (!installed) {
        // Give it a moment — MiniKit.install() from provider may not have run yet
        // Check again after a short delay
        setTimeout(() => {
          const retryInstalled = MiniKit.isInstalled();
          console.log("[InstaClaw] MiniKit retry isInstalled():", retryInstalled);

          if (!retryInstalled) {
            // Not in World App — but DON'T block on this in preview mode
            // World App preview may report false initially
            // Show onboarding anyway; MiniKit commands will work when called
            console.log("[InstaClaw] Not detected as World App — showing onboarding anyway");
            if (!resolved.current) {
              resolved.current = true;
              setState("onboarding");
            }
          }
        }, 500);
      }
    } catch (e) {
      console.error("[InstaClaw] MiniKit detection error:", e);
    }

    // Check for existing session (non-blocking)
    console.log("[InstaClaw] Checking /api/auth/me...");
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 4000);

    fetch("/api/auth/me", { signal: controller.signal })
      .then((r) => {
        clearTimeout(fetchTimeout);
        console.log("[InstaClaw] /api/auth/me status:", r.status);
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        console.log("[InstaClaw] /api/auth/me data:", JSON.stringify(data));
        if (resolved.current) return; // force timeout already fired

        if (data?.user?.hasAgent) {
          console.log("[InstaClaw] User has agent — redirecting to /home");
          resolved.current = true;
          router.replace("/home");
        } else {
          console.log("[InstaClaw] No agent — showing onboarding");
          resolved.current = true;
          setState("onboarding");
        }
      })
      .catch((err) => {
        console.log("[InstaClaw] /api/auth/me error:", err);
        if (!resolved.current) {
          resolved.current = true;
          setState("onboarding");
        }
      });

    return () => {
      clearTimeout(forceTimer);
      clearTimeout(fetchTimeout);
      controller.abort();
    };
  }, [router]);

  console.log("[InstaClaw] Render state:", state);

  // Not in World App (only shown if explicitly detected outside World App
  // AND we're confident — not used in practice since we default to onboarding)
  if (state === "not-world") {
    return (
      <div style={{ background: "#000", color: "#fff", height: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2rem", padding: "2rem", textAlign: "center" }}>
        <div style={{ fontSize: "4rem" }}>🤠</div>
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>InstaClaw</h1>
          <p style={{ marginTop: "0.5rem", color: "#888", fontSize: "0.875rem" }}>
            Open this app inside World App to get your free AI agent.
          </p>
        </div>
        <a
          href="https://worldcoin.org/download"
          style={{ background: "#DC6743", color: "#fff", padding: "0.875rem 2rem", borderRadius: "1rem", fontWeight: "600", textDecoration: "none" }}
        >
          Get World App
        </a>
      </div>
    );
  }

  // Loading — use INLINE styles so it renders even if CSS hasn't loaded
  if (state === "loading") {
    return (
      <div style={{ background: "#000", color: "#fff", height: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem" }}>
        <div style={{ width: "2.5rem", height: "2.5rem", border: "3px solid rgba(255,255,255,0.1)", borderTopColor: "#DC6743", borderRadius: "50%", animation: "spin 1.2s linear infinite" }} />
        <p style={{ fontSize: "0.75rem", color: "#888" }}>Loading InstaClaw...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return <Onboarding />;
}
