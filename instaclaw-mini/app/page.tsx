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
    // Wait a tick for MiniKit to install
    const timer = setTimeout(() => {
      setInWorldApp(MiniKit.isInstalled());

      // Check if user already has a session
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
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-6 px-8 text-center">
        <div className="text-5xl">🤠</div>
        <h1 className="text-2xl font-bold">InstaClaw</h1>
        <p className="text-muted">
          Open this app in World App to get started with your free AI agent.
        </p>
        <a
          href="https://worldcoin.org/download"
          className="rounded-xl bg-accent px-6 py-3 font-semibold text-black"
        >
          Get World App
        </a>
      </div>
    );
  }

  if (checking) {
    return (
      <div className="flex h-[100dvh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return <Onboarding />;
}
