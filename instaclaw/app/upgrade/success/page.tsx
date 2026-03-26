"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function SuccessContent() {
  const searchParams = useSearchParams();
  const canceled = searchParams.get("canceled") === "1";

  if (canceled) {
    return (
      <div style={{ background: "#f8f7f4", color: "#333334", minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem", textAlign: "center" }}>
        <div style={{ maxWidth: 340 }}>
          <h1 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: "1.5rem", fontWeight: 400, marginBottom: "0.75rem" }}>
            No worries
          </h1>
          <p style={{ color: "#6b6b6b", fontSize: "0.875rem", lineHeight: 1.6 }}>
            You can subscribe anytime from the World App or instaclaw.io. Your agent keeps running with WLD credits.
          </p>
          <p style={{ color: "#aaa", fontSize: "0.75rem", marginTop: "1.5rem" }}>
            You can close this tab.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "#f8f7f4", color: "#333334", minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem", textAlign: "center" }}>
      <div style={{ maxWidth: 340 }}>
        <div style={{
          width: 64, height: 64, borderRadius: "50%",
          background: "linear-gradient(135deg, rgba(34,197,94,0.15), rgba(34,197,94,0.25))",
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto 1.5rem",
          animation: "pop 0.4s ease-out",
        }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h1 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: "1.5rem", fontWeight: 400, marginBottom: "0.75rem" }}>
          Subscribed
        </h1>
        <p style={{ color: "#6b6b6b", fontSize: "0.875rem", lineHeight: 1.6, marginBottom: "1.5rem" }}>
          Your plan is active. Daily credits refresh at midnight.
          Return to World App — your agent is ready.
        </p>
        <p style={{ color: "#aaa", fontSize: "0.75rem" }}>
          You can also sign in at instaclaw.io for the full dashboard.
        </p>
        <style>{`@keyframes pop { from { transform: scale(0.5); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
      </div>
    </div>
  );
}

export default function UpgradeSuccessPage() {
  return (
    <Suspense fallback={
      <div style={{ background: "#f8f7f4", minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "#6b6b6b" }}>Loading...</p>
      </div>
    }>
      <SuccessContent />
    </Suspense>
  );
}
