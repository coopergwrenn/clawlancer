"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function ProvisioningStatus() {
  const router = useRouter();
  const [dots, setDots] = useState(".");

  // Animate dots
  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "." : d + "."));
    }, 600);
    return () => clearInterval(interval);
  }, []);

  // Poll for agent readiness every 5 seconds
  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (data?.user?.hasAgent) {
          clearInterval(poll);
          router.refresh();
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(poll);
  }, [router]);

  const serif = { fontFamily: "'Instrument Serif', Georgia, serif" };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 onboarding-light">
      <div className="relative mb-5">
        <div className="absolute -inset-3 animate-pulse rounded-full blur-xl" style={{ background: "rgba(220,103,67,0.15)" }} />
        <div className="relative h-12 w-12 animate-[spin_1.2s_linear_infinite] rounded-full" style={{ border: "3px solid rgba(0,0,0,0.08)", borderTopColor: "#DC6743" }} />
      </div>
      <h2 className="text-xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>
        Setting up your agent{dots}
      </h2>
      <p className="mt-2 max-w-[260px] text-center text-[13px] leading-relaxed" style={{ color: "#6b6b6b" }}>
        Your agent is being provisioned. This usually takes 1-2 minutes. This page will update automatically.
      </p>
    </div>
  );
}
