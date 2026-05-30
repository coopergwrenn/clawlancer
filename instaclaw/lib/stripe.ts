import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-01-28.clover",
    });
  }
  return _stripe;
}

export type Tier = "starter" | "pro" | "power";
export type ApiMode = "all_inclusive" | "byok";

/* ─── Stripe price IDs ───────────────────────────────────────────────
 *
 * 2026-05-29 PRICING UPDATE
 *
 * NEW_PRICE_IDS below are the ACTIVE price IDs — every new checkout
 * routes through these. They're hardcoded so the codebase is self-
 * documenting about what's live; env vars below still override
 * (useful for staging/test environments that point at separate
 * Stripe accounts).
 *
 *   All-inclusive (default tier):
 *     starter  $49.99/mo  price_1TcZLhCsyFRN0uBDSlTQaw4E
 *     pro      $129.99/mo price_1TcZMzCsyFRN0uBDo45FlQA0
 *     power    $349.99/mo price_1TcZOBCsyFRN0uBDQYUgcITD
 *
 *   BYOK (user brings their own Anthropic/OpenAI key):
 *     starter  $35.99/mo  price_1TcZPVCsyFRN0uBDQgMwtiLS
 *     pro      $49.99/mo  price_1TcZQMCsyFRN0uBDqVnN0xEw
 *     power    $119.99/mo price_1TcZRvCsyFRN0uBDYapg1rAE
 *
 * GRANDFATHERED_PRICE_IDS below are the OLD active-tier price IDs
 * from before the 2026-05-29 update. We KEEP them in the codebase
 * (do NOT delete from Stripe either) so existing subscribers stay
 * on their original price. Stripe handles this automatically — an
 * existing subscription holds its `price_id` reference forever
 * unless we explicitly change it. We just stop routing NEW
 * checkouts to old prices.
 *
 *   Pro (old)   $99/mo   price_1T02UxCsyFRN0uBD9WqwPS4u
 *   Power (old) $299/mo  price_1T02gbCsyFRN0uBDfF4k4WXj
 *
 * (No old Starter ID is recorded — Starter was introduced at
 * pre-2026-05-29 pricing too, but the env var historically resolved
 * to whatever Cooper had configured. If a grandfathered Starter
 * sub exists, its tier was already written to the DB at signup;
 * tierFromPriceId returning null for an unrecognized price just
 * causes a webhook warning, not a billing break.)
 *
 * tierFromPriceId checks BOTH the active map AND the grandfathered
 * map so webhooks/cron continue to resolve old subs' tier correctly. */

const NEW_PRICE_IDS: Record<`${Tier}_${ApiMode}`, string> = {
  starter_all_inclusive: "price_1TcZLhCsyFRN0uBDSlTQaw4E",
  starter_byok: "price_1TcZPVCsyFRN0uBDQgMwtiLS",
  pro_all_inclusive: "price_1TcZMzCsyFRN0uBDo45FlQA0",
  pro_byok: "price_1TcZQMCsyFRN0uBDqVnN0xEw",
  power_all_inclusive: "price_1TcZOBCsyFRN0uBDQYUgcITD",
  power_byok: "price_1TcZRvCsyFRN0uBDYapg1rAE",
};

const GRANDFATHERED_PRICE_IDS: Record<string, Tier> = {
  price_1T02UxCsyFRN0uBD9WqwPS4u: "pro",
  price_1T02gbCsyFRN0uBDfF4k4WXj: "power",
};

const PRICE_IDS: Record<`${Tier}_${ApiMode}`, string> = {
  starter_all_inclusive: process.env.STRIPE_PRICE_STARTER || NEW_PRICE_IDS.starter_all_inclusive,
  starter_byok: process.env.STRIPE_PRICE_STARTER_BYOK || NEW_PRICE_IDS.starter_byok,
  pro_all_inclusive: process.env.STRIPE_PRICE_PRO || NEW_PRICE_IDS.pro_all_inclusive,
  pro_byok: process.env.STRIPE_PRICE_PRO_BYOK || NEW_PRICE_IDS.pro_byok,
  power_all_inclusive: process.env.STRIPE_PRICE_POWER || NEW_PRICE_IDS.power_all_inclusive,
  power_byok: process.env.STRIPE_PRICE_POWER_BYOK || NEW_PRICE_IDS.power_byok,
};

export function getPriceId(tier: Tier, apiMode: ApiMode): string {
  const key = `${tier}_${apiMode}` as const;
  const priceId = PRICE_IDS[key];
  if (!priceId) throw new Error(`No Stripe price ID configured for ${key}`);
  return priceId;
}

export const TIER_DISPLAY: Record<Tier, { name: string; allInclusive: number; byok: number }> = {
  starter: { name: "Starter", allInclusive: 49.99, byok: 35.99 },
  pro: { name: "Pro", allInclusive: 129.99, byok: 49.99 },
  power: { name: "Power", allInclusive: 349.99, byok: 119.99 },
};

/** Reverse-map a Stripe price ID back to a tier. Checks the active
 * NEW_PRICE_IDS first, then GRANDFATHERED_PRICE_IDS so existing
 * subscribers on old prices still resolve to the right tier when
 * the webhook/cron reconciles their subscription. Returns null if
 * unrecognized — caller treats that as "don't update tier" rather
 * than as an error. */
export function tierFromPriceId(priceId: string): Tier | null {
  for (const [key, val] of Object.entries(PRICE_IDS)) {
    if (val && val === priceId) {
      // key is like "pro_all_inclusive" — extract tier portion
      return key.split("_")[0] as Tier;
    }
  }
  return GRANDFATHERED_PRICE_IDS[priceId] ?? null;
}
