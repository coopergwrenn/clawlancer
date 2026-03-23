"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Onboarding from "@/components/onboarding/onboarding";

export default function RootPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [inWorldApp, setInWorldApp] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setInWorldApp(MiniKit.isInstalled());

      fetch("/api/auth/me")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.user?.hasAgent) {
            router.replace("/home");
          } else {
            setChecking(false);
          }
        })
        .catch(() => setChecking(false));
    }, 100);
    return () => clearTimeout(timer);
  }, [router]);

  if (!inWorldApp) {
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

  if (checking) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4">
        <div className="relative">
          <div className="absolute -inset-3 animate-pulse rounded-full bg-accent/20 blur-xl" />
          <div className="relative h-10 w-10 animate-[spin_1.2s_linear_infinite] rounded-full border-[3px] border-white/10 border-t-accent" />
        </div>
      </div>
    );
  }

  return <Onboarding />;
}
