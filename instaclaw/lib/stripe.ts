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

const PRICE_IDS: Record<`${Tier}_${ApiMode}`, string> = {
  starter_all_inclusive: process.env.STRIPE_PRICE_STARTER ?? "",
  starter_byok: process.env.STRIPE_PRICE_STARTER_BYOK ?? "",
  pro_all_inclusive: process.env.STRIPE_PRICE_PRO ?? "",
  pro_byok: process.env.STRIPE_PRICE_PRO_BYOK ?? "",
  power_all_inclusive: process.env.STRIPE_PRICE_POWER ?? "",
  power_byok: process.env.STRIPE_PRICE_POWER_BYOK ?? "",
};

export function getPriceId(tier: Tier, apiMode: ApiMode): string {
  const key = `${tier}_${apiMode}` as const;
  const priceId = PRICE_IDS[key];
  if (!priceId) throw new Error(`No Stripe price ID configured for ${key}`);
  return priceId;
}

export const TIER_DISPLAY: Record<Tier, { name: string; allInclusive: number; byok: number }> = {
  starter: { name: "Starter", allInclusive: 19, byok: 9 },
  pro: { name: "Pro", allInclusive: 39, byok: 19 },
  power: { name: "Power", allInclusive: 79, byok: 39 },
};
