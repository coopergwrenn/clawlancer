import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { logger } from "@/lib/logger";

/**
 * SINGLE SOURCE OF TRUTH for "is this VM owned by a paying customer?"
 *
 * Spec: instaclaw/docs/watchdog-v2-and-wake-reconciler-design.md §4
 *
 * Existed because three separate sprint incidents reflected the same root
 * cause — different code paths re-implementing billing checks, each missing
 * a different revenue source:
 *
 *   - Lesson 3: "38 orphan VM" census missed credit_balance (WLD users)
 *   - Lesson 4: vm-036/vm-068 nearly hibernated; api_mode=all_inclusive
 *               legitimately has credit_balance=0
 *   - Lesson 2: suspend-check trusted local DB current_period_end which
 *               had drifted from Stripe
 *
 * Use getBillingStatus() for non-destructive checks (UI, dashboards).
 * Use getBillingStatusVerified() before ANY destructive action (hibernate,
 * restart, freeze) — it queries Stripe API for ground truth (Lesson 2).
 */

export type BillingStatus = {
  isPaying: boolean;
  /**
   * Human-readable list of why we said paying / not paying. Goes into audit
   * meta jsonb so future-you can understand decisions made days ago.
   */
  reasons: string[];
  details: {
    stripeSubStatus: string | null;
    stripePaymentStatus: string | null;
    /** True ONLY if we verified against Stripe API, not just local DB. */
    stripeSubVerified: boolean;
    /** Set when verified=true and Stripe disagrees with local DB. */
    stripeDriftDetected: boolean;
    creditBalance: number;
    partner: string | null;
    apiMode: string | null;
    tier: string | null;
  };
};

/**
 * Cheap path: local DB only. Use for:
 *   - Dashboard / UI rendering
 *   - Pre-filtering before the verified call (avoid hitting Stripe for
 *     obvious non-customers)
 *   - Anywhere the consequence of being wrong is "show wrong UI for ~1
 *     cron cycle until reconciler heals"
 *
 * DO NOT use for destructive actions. Use getBillingStatusVerified instead.
 */
export async function getBillingStatus(
  supabase: SupabaseClient,
  vmId: string,
): Promise<BillingStatus | null> {
  // Lesson 7: select * to avoid RLS / column-grant silent failures.
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("id", vmId)
    .single();

  if (vmErr || !vm) {
    logger.warn("billing-status: vm not found", { vmId, error: vmErr?.message });
    return null;
  }

  // No assigned user → no billing relationship at all.
  if (!vm.assigned_to) {
    return {
      isPaying: false,
      reasons: ["vm_unassigned"],
      details: {
        stripeSubStatus: null,
        stripePaymentStatus: null,
        stripeSubVerified: false,
        stripeDriftDetected: false,
        creditBalance: 0,
        partner: null,
        apiMode: vm.api_mode ?? null,
        tier: vm.tier ?? null,
      },
    };
  }

  // Subscription lookup. Lesson 7: select *.
  const { data: subs } = await supabase
    .from("instaclaw_subscriptions")
    .select("*")
    .eq("user_id", vm.assigned_to);

  // A user can have multiple sub rows (canceled + new). Pick the most-active
  // one: prefer non-canceled, then most-recently-updated.
  const sub = (subs ?? []).sort((a, b) => {
    const aCanceled = a.status === "canceled" ? 1 : 0;
    const bCanceled = b.status === "canceled" ? 1 : 0;
    if (aCanceled !== bCanceled) return aCanceled - bCanceled;
    const aT = new Date(a.updated_at ?? 0).getTime();
    const bT = new Date(b.updated_at ?? 0).getTime();
    return bT - aT;
  })[0] ?? null;

  return classify(vm, sub, /* verified */ false, /* drift */ false);
}

/**
 * Verified path: queries Stripe API. Use BEFORE any destructive action.
 *
 * Latency: ~200-400ms per call (Stripe API round-trip). Don't call in tight
 * loops — getBillingStatus() first to filter, then this for survivors.
 *
 * If Stripe is unreachable (network, rate limit, outage):
 *   - Returns isPaying based on local DB
 *   - stripeSubVerified=false signals to caller "I couldn't verify"
 *   - Caller MUST treat unverified as "do not act destructively" (Lesson 2)
 */
export async function getBillingStatusVerified(
  supabase: SupabaseClient,
  stripe: Stripe,
  vmId: string,
): Promise<BillingStatus | null> {
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("id", vmId)
    .single();

  if (vmErr || !vm) return null;
  if (!vm.assigned_to) return getBillingStatus(supabase, vmId);

  const { data: subs } = await supabase
    .from("instaclaw_subscriptions")
    .select("*")
    .eq("user_id", vm.assigned_to);

  const localSub = (subs ?? []).sort((a, b) => {
    const aCanceled = a.status === "canceled" ? 1 : 0;
    const bCanceled = b.status === "canceled" ? 1 : 0;
    if (aCanceled !== bCanceled) return aCanceled - bCanceled;
    const aT = new Date(a.updated_at ?? 0).getTime();
    const bT = new Date(b.updated_at ?? 0).getTime();
    return bT - aT;
  })[0] ?? null;

  // No local sub → just classify on credits/partner. Stripe verification
  // doesn't apply (no sub_id to retrieve).
  if (!localSub?.stripe_subscription_id) {
    return classify(vm, localSub, /* verified */ false, /* drift */ false);
  }

  // Hit Stripe for ground truth.
  let stripeSub: Stripe.Subscription | null = null;
  let stripeError: string | null = null;
  try {
    stripeSub = await stripe.subscriptions.retrieve(localSub.stripe_subscription_id, {
      expand: ["latest_invoice"],
    });
  } catch (err) {
    stripeError = err instanceof Error ? err.message : String(err);
    logger.warn("billing-status: Stripe verification failed — caller MUST treat as unverified", {
      vmId,
      userId: vm.assigned_to,
      stripeSubId: localSub.stripe_subscription_id,
      error: stripeError,
    });
  }

  if (!stripeSub) {
    // Verification failed. Classify on local DB but flag unverified.
    return classify(vm, localSub, /* verified */ false, /* drift */ false);
  }

  // Detect DB drift: when Stripe says one thing and our DB says another.
  const stripeStatus = stripeSub.status;
  const dbStatus = localSub.status;
  const drift = stripeStatus !== dbStatus;
  if (drift) {
    logger.warn("billing-status: DB drift from Stripe — local DB lying about sub status", {
      vmId,
      userId: vm.assigned_to,
      stripeSubId: localSub.stripe_subscription_id,
      stripeStatus,
      dbStatus,
    });
  }

  // Classify based on Stripe truth, not DB. Construct a synthetic sub-like
  // object that overrides DB values with Stripe's.
  const inv = (stripeSub.latest_invoice as Stripe.Invoice | null) ?? null;
  const invoicePaid = inv?.status === "paid";
  const synth = {
    ...localSub,
    status: stripeStatus,
    payment_status: invoicePaid ? "current" : (localSub.payment_status ?? null),
    canceled_at: stripeSub.canceled_at ? new Date(stripeSub.canceled_at * 1000).toISOString() : null,
  };

  return classify(vm, synth, /* verified */ true, drift);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classify(vm: any, sub: any, verified: boolean, drift: boolean): BillingStatus {
  const reasons: string[] = [];
  let isPaying = false;

  const subStatus = sub?.status ?? null;
  const paymentStatus = sub?.payment_status ?? null;
  const canceledAt = sub?.canceled_at ?? null;
  const creditBalance = vm.credit_balance ?? 0;
  const partner = vm.partner ?? null;
  const apiMode = vm.api_mode ?? null;
  const tier = vm.tier ?? null;

  // Path 1: active or trialing Stripe sub, payment current
  if (subStatus && ["active", "trialing"].includes(subStatus) && !canceledAt && paymentStatus !== "past_due") {
    isPaying = true;
    reasons.push(`stripe_${subStatus}`);
  }

  // Path 2: past_due IS still paying — they're in the 7-day grace window
  // (suspend-check Pass 1 is what eventually hibernates after grace expires)
  if (subStatus && ["active", "trialing"].includes(subStatus) && !canceledAt && paymentStatus === "past_due") {
    isPaying = true;
    reasons.push("stripe_past_due_in_grace");
  }

  // Path 3: positive credit balance (WLD users, leftover Stripe credits)
  if (creditBalance > 0) {
    isPaying = true;
    reasons.push(`credits_${creditBalance}`);
  }

  // Path 4: partner-tagged (edge_city etc.) — the partnership covers their
  // VM cost; we keep these alive even with no sub or credits.
  if (partner) {
    isPaying = true;
    reasons.push(`partner_${partner}`);
  }

  // Path 5: all-inclusive tier with active sub. Lesson 4: credit_balance=0
  // is NORMAL for these (usage is metered against tier limit, not credits).
  // Without this path, Path 1 already catches them — but we add an explicit
  // reason string so audit logs make this clear.
  if (apiMode === "all_inclusive" && tier && ["starter", "pro", "power"].includes(tier) && isPaying) {
    reasons.push(`all_inclusive_${tier}`);
  }

  if (!isPaying) {
    reasons.push("no_payment_signal");
    if (subStatus === "canceled") reasons.push("stripe_canceled");
    if (creditBalance === 0) reasons.push("credits_zero");
    if (!partner) reasons.push("no_partner");
  }

  return {
    isPaying,
    reasons,
    details: {
      stripeSubStatus: subStatus,
      stripePaymentStatus: paymentStatus,
      stripeSubVerified: verified,
      stripeDriftDetected: drift,
      creditBalance,
      partner,
      apiMode,
      tier,
    },
  };
}
