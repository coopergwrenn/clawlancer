/**
 * THE CANONICAL PURCHASABLE CATALOG — single source of truth for every
 * pack/plan display surface (the /billing hub, /dashboard/credits, the
 * dashboard pack picker). Audited 2026-06-12 (Cooper's hard requirement:
 * "/billing sells EVERYTHING; a user should never need to know our internal
 * lane structure to find a thing they can pay us for").
 *
 * Pack ids MUST match CREDIT_PACKS in app/api/billing/credit-pack/route.ts
 * (the checkout truth) — that route validates the id and carries the Stripe
 * env mapping. This module is DISPLAY data only; prices here are what the
 * user sees, the route's Stripe price is what they pay. Keep in sync (the
 * audit found 4 files each carrying their own copy of these numbers — that
 * drift class ends here; import, don't redefine).
 *
 * Classes (audit result):
 *   - tier subscriptions (starter/pro/power × all-inclusive/BYOK) →
 *     /api/billing/checkout mode:subscription — NOT in this module (they're
 *     plans, rendered by the billing page's tier UI / onboarding /plan).
 *   - message packs   → credit_balance (daily-allowance overflow units)
 *   - media packs     → credit_balance media pool (muapi/sjinn generation)
 *   - video packs     → video_credit_balance (Higgsfield cinematic clips)
 *   - toolrouter pack → toolrouter_topup_balance (premium searches) —
 *     the audit's orphaned-shelf finding: was sold ONLY on a dashboard
 *     side-card, absent from every money page until the /billing hub.
 *   - WLD path: credit packs are also purchasable inside the World App
 *     (app/api/checkout/verify) — in-app flow, not a dashboard surface.
 *   - video creator plan ($44.99/mo): pending build (forks under ruling);
 *     gets its entry here when it ships. No speculative cards.
 */

export interface CatalogPack {
  /** CREDIT_PACKS id — the exact string POSTed to /api/billing/credit-pack. */
  id: string;
  /** Big numeral / title for cards. */
  title: string;
  /** Price string as displayed. */
  price: string;
  /** Per-unit framing. */
  perUnit: string;
  /** One-line description. */
  note: string;
  /** Highlight as the recommended pick. */
  best?: boolean;
}

export const MESSAGE_PACKS: CatalogPack[] = [
  { id: "50", title: "50 message units", price: "$5", perUnit: "10¢ each", note: "Tops up after your daily limit" },
  { id: "200", title: "200 message units", price: "$15", perUnit: "7.5¢ each", note: "For busier weeks" },
  { id: "500", title: "500 message units", price: "$30", perUnit: "6¢ each", note: "Best message-unit rate", best: true },
];

export const MEDIA_PACKS: CatalogPack[] = [
  { id: "media_500", title: "500 media credits", price: "$4.99", perUnit: "~1¢ each", note: "A handful of images or a couple videos" },
  { id: "media_1200", title: "1,200 media credits", price: "$9.99", perUnit: "~0.8¢ each", note: "Enough for a full creative session", best: true },
  { id: "media_3000", title: "3,000 media credits", price: "$19.99", perUnit: "~0.7¢ each", note: "Best value for heavy media workflows" },
];

// Cinematic video packs (Higgsfield launch §3.1). Sold as CLIPS.
// Standing rule: the 99¢/video rate exists ONLY on the taste pack; nothing
// below $1.25/clip without re-running the HF+25% stress math.
export const VIDEO_PACKS: CatalogPack[] = [
  { id: "video_taste", title: "4 premium videos", price: "$3.99", perUnit: "99¢ a video", note: "A taste of cinematic text-to-video" },
  { id: "video_creator", title: "12 premium videos", price: "$14.99", perUnit: "$1.25 a video", note: "For regular creating", best: true },
  { id: "video_studio", title: "32 premium videos", price: "$39.99", perUnit: "$1.25 a video", note: "The studio shelf" },
];

export const TOOLROUTER_PACKS: CatalogPack[] = [
  { id: "toolrouter_100", title: "100 premium searches", price: "$10", perUnit: "10¢ each", note: "Web search, browser automation, deep research" },
];
