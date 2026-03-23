"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMiniKit } from "@/components/minikit-provider";
import Onboarding from "@/components/onboarding/onboarding";

export default function RootPage() {
  const router = useRouter();
  const { ready } = useMiniKit();
  const [state, setState] = useState<"loading" | "not-world" | "onboarding">("loading");

  useEffect(() => {
    if (!ready) return;

    // MiniKit is installed — check if we're in World App
    const installed = MiniKit.isInstalled();

    if (!installed) {
      setState("not-world");
      return;
    }

    // Check if user already has an agent (existing session)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s max

    fetch("/api/auth/me", { signal: controller.signal })
      .then((r) => {
        clearTimeout(timeout);
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (data?.user?.hasAgent) {
          router.replace("/home");
        } else {
          setState("onboarding");
        }
      })
      .catch(() => {
        // Fetch failed or timed out — show onboarding anyway
        setState("onboarding");
      });

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [ready, router]);

  // Not in World App
  if (state === "not-world") {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-8 px-8 text-center">
        <div className="relative">
          <div className="animate-orb absolute -inset-8 rounded-full bg-accent/20 blur-2xl" />
          <div className="relative text-6xl">🤠</div>
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">InstaClaw</h1>
          <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-muted">
            Open this app inside World App to get your free AI agent.
          </p>
        </div>
        <a
          href="https://worldcoin.org/download"
          className="btn-primary rounded-2xl px-8 py-3.5 font-semibold"
        >
          Get World App
        </a>
      </div>
    );
  }

  // Loading state — visible spinner on dark bg
  if (state === "loading") {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-background">
        <div className="relative">
          <div className="absolute -inset-3 animate-pulse rounded-full bg-accent/20 blur-xl" />
          <div className="relative h-10 w-10 animate-[spin_1.2s_linear_infinite] rounded-full border-[3px] border-white/10 border-t-accent" />
        </div>
        <p className="text-xs text-muted">Loading...</p>
      </div>
    );
  }

  return <Onboarding />;
}
