"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Edge City partner portal — minimal version.
 * Sets the instaclaw_partner cookie and redirects to signup.
 * The cookie is read in lib/auth.ts during Google OAuth to tag the user
 * with partner="edge_city", which gates the Edge City skill installation.
 */
export default function EdgeCityPage() {
  const router = useRouter();

  useEffect(() => {
    // Set partner cookie (7-day expiry, survives OAuth redirect)
    document.cookie = "instaclaw_partner=edge_city; path=/; max-age=604800; SameSite=Lax";
    router.replace("/signup");
  }, [router]);

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
      <p style={{ color: "#a0a0a0" }}>Redirecting to signup...</p>
    </div>
  );
}
