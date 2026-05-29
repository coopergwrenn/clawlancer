"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Legacy redirect: Gmail connect moved to dashboard popup. Redirects
 * to the modern onboarding flow's entry point (2026-05-29: was
 * /connect; updated to /plan to match Cooper's onboarding redesign —
 * /connect is now an opt-in power-user path, not part of the standard
 * flow).
 */
export default function GmailConnectRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/plan");
  }, [router]);

  return null;
}
