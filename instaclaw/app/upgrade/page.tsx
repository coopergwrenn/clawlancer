"use client";

import { useSession, signIn } from "next-auth/react";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState, Suspense } from "react";

const PLANS = [
  { tier: "starter", name: "Starter", price: 29, daily: 600 },
  { tier: "pro", name: "Pro", price: 99, daily: 1000 },
  { tier: "power", name: "Power", price: 299, daily: 2500 },
];

function UpgradeContent() {
  const { data: session, status } = useSession();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [selectedTier, setSelectedTier] = useState(searchParams.get("tier") || "starter");
  const [loading, setLoading] = useState(false);
  const fromMiniApp = searchParams.get("from") === "mini-app";
  const emailHint = searchParams.get("email") || "";

  // If already authenticated and has active subscription, go to billing
  useEffect(() => {
    if (status === "authenticated" && session?.user?.id) {
      // Check if they already have an active subscription
      fetch("/api/billing/status")
        .then((r) => r.json())
        .then((data) => {
          if (data?.subscription?.status === "active") {
            router.replace("/billing");
          }
        })
        .catch(() => {});
    }
  }, [status, session, router]);

  async function handleSubscribe() {
    if (status !== "authenticated") {
      // Sign in with Google first, then come back here
      signIn("google", {
        callbackUrl: `/upgrade?tier=${selectedTier}&from=${fromMiniApp ? "mini-app" : "web"}`,
        ...(emailHint ? { login_hint: emailHint } : {}),
      });
      return;
    }

    // Already signed in — go to Stripe checkout
    setLoading(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: selectedTier,
          apiMode: "all_inclusive",
          trial: false,
          cancelUrl: fromMiniApp ? "/upgrade/success?canceled=1" : "/billing",
        }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.deploying) {
        // Already subscribed — redirect to success
        router.replace(fromMiniApp ? "/upgrade/success" : "/billing");
      }
    } catch {
      setLoading(false);
    }
  }

  return (
    <div style={{ background: "#f8f7f4", color: "#333334", minHeight: "100dvh" }}>
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "3rem 1.5rem" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: "2.5rem" }}>
          <h1 style={{
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontSize: "2rem",
            fontWeight: 400,
            letterSpacing: "-0.5px",
            marginBottom: "0.75rem",
          }}>
            Unlock the full experience
          </h1>
          <p style={{ color: "#6b6b6b", fontSize: "0.9rem", lineHeight: 1.6 }}>
            Daily credit refresh, full web dashboard, and all features.
            {fromMiniApp && " Your agent, credits, and data carry over."}
          </p>
        </div>

        {/* Plan cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "2rem" }}>
          {PLANS.map((plan) => (
            <button
              key={plan.tier}
              onClick={() => setSelectedTier(plan.tier)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "1.25rem 1.5rem",
                borderRadius: "1rem",
                border: selectedTier === plan.tier
                  ? "2px solid rgba(220,103,67,0.5)"
                  : "2px solid rgba(0,0,0,0.06)",
                background: selectedTier === plan.tier
                  ? "rgba(220,103,67,0.04)"
                  : "#fff",
                cursor: "pointer",
                transition: "all 0.2s",
                textAlign: "left",
                width: "100%",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: "1rem" }}>{plan.name}</div>
                <div style={{ color: "#6b6b6b", fontSize: "0.8rem", marginTop: "0.25rem" }}>
                  {plan.daily} credits/day, resets at midnight
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontWeight: 700, fontSize: "1.25rem" }}>${plan.price}</div>
                <div style={{ color: "#6b6b6b", fontSize: "0.75rem" }}>/month</div>
              </div>
            </button>
          ))}
        </div>

        {/* Features */}
        <div style={{
          background: "rgba(0,0,0,0.02)",
          border: "1px solid rgba(0,0,0,0.06)",
          borderRadius: "1rem",
          padding: "1.25rem 1.5rem",
          marginBottom: "2rem",
        }}>
          <p style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: "0.75rem", color: "#333" }}>
            All plans include:
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "0.8rem", color: "#6b6b6b", lineHeight: 2 }}>
            <li>Daily credit refresh (resets every midnight)</li>
            <li>Full instaclaw.io web dashboard</li>
            <li>Task scheduling, file management, history</li>
            <li>Priority model access (Sonnet, Opus)</li>
            <li>World Mini App + Telegram access</li>
          </ul>
        </div>

        {/* CTA */}
        <button
          onClick={handleSubscribe}
          disabled={loading}
          style={{
            width: "100%",
            padding: "1rem",
            borderRadius: "0.875rem",
            fontSize: "1rem",
            fontWeight: 600,
            color: "#fff",
            border: "none",
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.6 : 1,
            background: "linear-gradient(180deg, rgba(220,103,67,0.95), rgba(200,85,52,1))",
            boxShadow: "0 2px 8px rgba(220,103,67,0.3)",
            transition: "all 0.2s",
          }}
        >
          {status === "authenticated"
            ? loading ? "Redirecting to checkout..." : `Subscribe — $${PLANS.find(p => p.tier === selectedTier)?.price}/mo`
            : "Sign in with Google to subscribe"
          }
        </button>

        {status !== "authenticated" && (
          <p style={{ textAlign: "center", color: "#999", fontSize: "0.75rem", marginTop: "1rem", lineHeight: 1.5 }}>
            Google sign-in links your account for full dashboard access.
            {emailHint && ` We'll pre-fill ${emailHint}.`}
          </p>
        )}

        {/* Back link for mini app users */}
        {fromMiniApp && (
          <p style={{ textAlign: "center", color: "#999", fontSize: "0.75rem", marginTop: "1.5rem" }}>
            Or continue using World App with pay-as-you-go WLD credits.
          </p>
        )}
      </div>
    </div>
  );
}

export default function UpgradePage() {
  return (
    <Suspense fallback={
      <div style={{ background: "#f8f7f4", minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "#6b6b6b" }}>Loading...</p>
      </div>
    }>
      <UpgradeContent />
    </Suspense>
  );
}
