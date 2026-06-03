"use client";

/**
 * Dashboard access gate overlay (Phase 3 billing gate).
 *
 * Extracted VERBATIM from the inline JSX in app/(dashboard)/layout.tsx so the
 * new sidebar render path can show the identical overlay for gated WLD-only
 * users. The top-nav (flag-off) path keeps its own inline copy untouched — this
 * component is intentionally a faithful duplicate during Phase 1; Phase 3
 * consolidates the two onto this component once the top-nav is removed.
 *
 * Pixel-for-pixel identical to the original markup (same inline styles, copy,
 * gradients, z-index). Behaviour lives in the layout (the `gated` state + the
 * NEXT_PUBLIC_ENABLE_DASHBOARD_GATE check); this is presentational only.
 */
export function DashboardGateOverlay({
  onUpgrade,
  onManageBilling,
}: {
  onUpgrade: () => void;
  onManageBilling: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: "1.25rem",
          padding: "2.5rem",
          maxWidth: "420px",
          width: "90%",
          textAlign: "center",
          boxShadow: "0 24px 64px rgba(0,0,0,0.2)",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: "1.5rem",
            fontWeight: 400,
            marginBottom: "0.75rem",
          }}
        >
          Upgrade to unlock the dashboard
        </h2>
        <p
          style={{
            color: "var(--muted)",
            fontSize: "0.875rem",
            lineHeight: 1.6,
            marginBottom: "1.5rem",
          }}
        >
          Your agent is running via World App and Telegram. Subscribe to unlock
          the full web dashboard, daily credit refresh, and all features.
        </p>
        <button
          onClick={onUpgrade}
          style={{
            width: "100%",
            padding: "0.875rem",
            borderRadius: "0.75rem",
            fontSize: "0.9rem",
            fontWeight: 600,
            color: "#fff",
            border: "none",
            cursor: "pointer",
            background:
              "linear-gradient(180deg, rgba(220,103,67,0.95), rgba(200,85,52,1))",
            boxShadow: "0 2px 8px rgba(220,103,67,0.3)",
            marginBottom: "0.75rem",
          }}
        >
          View plans — from $49.99/mo
        </button>
        <button
          onClick={onManageBilling}
          style={{
            width: "100%",
            padding: "0.75rem",
            borderRadius: "0.75rem",
            fontSize: "0.8rem",
            fontWeight: 500,
            color: "var(--muted)",
            background: "rgba(0,0,0,0.04)",
            border: "1px solid var(--border)",
            cursor: "pointer",
          }}
        >
          Manage billing
        </button>
      </div>
    </div>
  );
}
