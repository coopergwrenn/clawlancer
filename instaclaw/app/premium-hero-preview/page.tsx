/**
 * /premium-hero-preview — SCREENSHOT-ONLY canvas for the recovered
 * Premium Tools / World ToolRouter hero card.
 *
 * Top-level route (OUTSIDE the (dashboard) group) so it has no auth
 * redirect and no dashboard chrome — just the card on the dashboard
 * background, sized for a clean launch-announcement screenshot.
 *
 * Edit the look in components/dashboard/premium-hero-card.tsx.
 * The live /skills page, its compact Premium Tools tile, and the modal
 * are untouched — this route does not import or affect them.
 */

import { PremiumHeroCard } from "@/components/dashboard/premium-hero-card";

export const dynamic = "force-static";

export default function PremiumHeroPreviewPage() {
  return (
    <div
      data-theme="dashboard"
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--foreground)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "1040px" }}>
        <PremiumHeroCard />
      </div>
    </div>
  );
}
