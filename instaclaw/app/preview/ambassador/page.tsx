"use client";

import AmbassadorCard from "@/components/AmbassadorCard";

export default function AmbassadorPreviewPage() {
  return (
    <div
      data-theme="dashboard"
      style={{
        minHeight: "100vh",
        background: "linear-gradient(145deg, #f0efe9, #f8f7f4, #eeedea)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "24px",
        padding: "48px 24px",
      }}
    >
      <p style={{ fontSize: "12px", letterSpacing: "0.15em", color: "#9ca3af", fontWeight: 500 }}>
        INTERACTIVE (WEBSITE)
      </p>
      <AmbassadorCard number={1} verified />

      <div style={{ height: "24px" }} />

      <p style={{ fontSize: "12px", letterSpacing: "0.15em", color: "#9ca3af", fontWeight: 500 }}>
        STATIC (NFT EXPORT)
      </p>
      <AmbassadorCard number={1} verified static />
    </div>
  );
}
