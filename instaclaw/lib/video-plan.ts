/**
 * Video Creator Plan — discrimination gate + webhook handlers + constants.
 *
 * THE REFERENCE IMPLEMENTATION for subscriptions-with-consumable-allowances
 * on this platform. Future plans (message-credit plan, toolrouter plan)
 * should copy these shapes. Architecture report: 2026-06-12, ruled F1-F4(a).
 *
 * ── WHY THE GATE EXISTS (Finding 1, pre-build audit 2026-06-12) ──
 * Every platform subscription/invoice webhook handler resolves by CUSTOMER
 * ID and assumes the-platform-sub. A second subscription on the same Stripe
 * customer (this plan) would, ungated:
 *   - clobber instaclaw_subscriptions via created's UPSERT ON CONFLICT
 *     user_id (a canceled-platform user buying the video plan becomes
 *     "active" platform-wide);
 *   - mark the PLATFORM sub past_due when the VIDEO card fails → the VM
 *     suspension/dunning machinery fires on a paid platform user;
 *   - wrongly clear REAL platform dunning when a video invoice pays;
 *   - read a video-plan cancel as a PLATFORM cancel → freeze machinery.
 * So: every platform handler early-returns on video-plan events (routing
 * here), and every handler here early-returns on platform events. The plan
 * is UNPURCHASABLE until this gate is live — sequencing is load-bearing.
 *
 * ── PLAN ECONOMICS (locked 2026-06-12) ──
 * $44.99/mo → 546 vc (42 premium clips × 13 vc) = $1.07/clip effective:
 * 24% margin at current COGS, ~5% under an HF+25% shock, ~39% if wholesale
 * lands. Sub floor rule (standing): no subscription below $1.05/clip
 * effective without re-running the shock math.
 *
 * ── DIVERGENCE WHY #1: NO ROLLOVER ──
 * Industry is mixed (ElevenLabs/Lovable cap rollover at ~2x; Runway none).
 * Ours is deliberate: rollover stockpiles convert a 24%-margin plan into a
 * deferred COGS liability; the $1.07/clip effective rate only holds if the
 * allowance expires. Capped-rollover is the v2 lever if churn data demands
 * it. The grant SETs (never increments) — no-rollover falls out of the
 * mechanism itself.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

/** checkout.session metadata.type for plan subscriptions (vs "credit_pack"). */
export const VIDEO_PLAN_CHECKOUT_TYPE = "video_plan";
/** subscription_data.metadata marker — survives price rotation. */
export const VIDEO_PLAN_SUB_METADATA_KEY = "plan_type";
export const VIDEO_PLAN_SUB_METADATA_VALUE = "video_creator_plan";
/** Monthly allowance in video-credits: 42 premium clips × 13 vc. */
export const VIDEO_PLAN_ALLOWANCE_VC = 546;
/** Clips shown to users = allowance / 13 (same divisor as /api/credits/video). */
export const VIDEO_PLAN_CLIPS_PER_MONTH = 42;

/** Minimal shapes (Stripe webhook payloads are loosely typed at the boundary). */
export interface SubLike {
  id?: string;
  metadata?: Record<string, string> | null;
  items?: { data?: Array<{ price?: { id?: string } | null } | null> | null } | null;
}
export interface InvoiceLike {
  id?: string;
  subscription?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscription_details?: { metadata?: Record<string, string> | null } | null;
  lines?: { data?: Array<{ price?: { id?: string } | null } | null> | null } | null;
}

/**
 * THE discriminator — pure + testable (price id injected, no env read).
 * Belt AND suspenders: metadata marker (survives price rotation, set by our
 * checkout) OR price-id match (catches admin-created subs without metadata).
 * Over-match is as dangerous as under-match: a platform sub must NEVER test
 * true (it would silently skip platform dunning) — hence exact-equality
 * checks only, no substring/prefix logic.
 */
export function isVideoPlanSubscription(sub: SubLike | null | undefined, planPriceId: string | undefined): boolean {
  if (!sub) return false;
  if (sub.metadata?.[VIDEO_PLAN_SUB_METADATA_KEY] === VIDEO_PLAN_SUB_METADATA_VALUE) return true;
  if (planPriceId) {
    for (const item of sub.items?.data ?? []) {
      if (item?.price?.id === planPriceId) return true;
    }
  }
  return false;
}

/**
 * Invoice discriminator. Checks (cheapest first): line price ids →
 * subscription_details metadata → fallback retrieve of the subscription
 * (webhook payloads don't always expand lines; the retrieve mirrors the
 * platform updated-handler's own fallback pattern).
 */
export async function isVideoPlanInvoice(
  invoice: InvoiceLike | null | undefined,
  planPriceId: string | undefined,
  retrieveSub: (id: string) => Promise<SubLike | null>,
): Promise<boolean> {
  if (!invoice) return false;
  if (planPriceId) {
    for (const line of invoice.lines?.data ?? []) {
      if (line?.price?.id === planPriceId) return true;
    }
  }
  if (invoice.subscription_details?.metadata?.[VIDEO_PLAN_SUB_METADATA_KEY] === VIDEO_PLAN_SUB_METADATA_VALUE) {
    return true;
  }
  // No line match + no metadata: if there's a subscription id, resolve it.
  // (A pack purchase's invoice-less charge or a platform invoice with
  // expanded lines never reaches the retrieve — this is the rare path.)
  if (invoice.subscription) {
    try {
      const sub = await retrieveSub(invoice.subscription);
      return isVideoPlanSubscription(sub, planPriceId);
    } catch (err) {
      // Fail CLOSED-for-the-platform: treating an UNKNOWN invoice as
      // platform keeps platform dunning intact (the dangerous direction is
      // a real platform invoice classified as video). A video invoice
      // misclassified as platform is then caught by the platform handlers'
      // own sub-row lookups (no instaclaw_subscriptions row matches a
      // video-only customer state change). Logged for forensics.
      logger.error("video-plan invoice discrimination: retrieve failed — treating as platform", {
        route: "lib/video-plan",
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  return false;
}

/** Map a Stripe subscription status onto the plan's three-state column.
 *  ── DIVERGENCE WHY #2: FREEZE-not-grace on past_due ──
 *  The PLATFORM sub gives a 7-day grace window (it protects the user's core
 *  agent). The video allowance freezes immediately on past_due: it is a
 *  high-COGS luxury add-on where grace is real dollars per render, and
 *  PACKS REMAIN USABLE so the user is never bricked — they lose the
 *  discounted lane, not the capability. The freeze is read-side (the
 *  reserve RPC requires status='active'), so recovery is instant when the
 *  invoice pays and the grant handler flips status back. */
export function mapPlanStatus(stripeStatus: string | undefined): "active" | "past_due" | "canceled" {
  switch (stripeStatus) {
    case "active":
    case "trialing": // no trials configured on this plan; mapped defensively
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      // canceled / incomplete / incomplete_expired / paused — no allowance use.
      return "canceled";
  }
}

/** Resolve a Stripe customer id → the user's CURRENTLY-ASSIGNED VM id.
 *  Deliberately user→VM (not sub_id→vm-row): if the user migrated VMs, the
 *  next grant lands on the CURRENT VM — migration self-heals at the cycle
 *  boundary. The in-period remainder is lost on migration: the same accepted
 *  wart as every per-VM balance (documented in the architecture report). */
export async function resolveVmForCustomer(
  supabase: SupabaseClient,
  customerId: string,
): Promise<{ vmId: string; userId: string } | null> {
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();
  if (!user) return null;
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", user.id)
    .single();
  if (!vm) return null;
  return { vmId: vm.id, userId: user.id };
}

/**
 * Status/identity sync for subscription.created/updated/deleted — writes the
 * sub id + mapped status + period end onto the user's current VM. NEVER
 * touches the allowance (grants are invoice.paid's job, exclusively — the
 * one-mechanism rule that makes double-grant structurally impossible here).
 */
export async function syncVideoPlanStatus(
  supabase: SupabaseClient,
  customerId: string,
  sub: { id?: string; status?: string; current_period_end?: number },
  opts?: { zeroAllowance?: boolean },
): Promise<void> {
  const target = await resolveVmForCustomer(supabase, customerId);
  if (!target) {
    logger.warn("video-plan status sync: no VM resolved for customer", {
      route: "lib/video-plan", customerId, subId: sub.id,
    });
    return;
  }
  const update: Record<string, unknown> = {
    video_plan_stripe_sub_id: sub.id ?? null,
    video_plan_status: mapPlanStatus(sub.status),
  };
  if (sub.current_period_end) {
    update.video_plan_period_end = new Date(sub.current_period_end * 1000).toISOString();
  }
  if (opts?.zeroAllowance) update.video_plan_allowance_remaining = 0;
  const { error } = await supabase.from("instaclaw_vms").update(update).eq("id", target.vmId);
  if (error) {
    logger.error("video-plan status sync failed", {
      route: "lib/video-plan", vmId: target.vmId, error: error.message,
    });
    throw new Error(`video_plan_status_sync_failed: ${error.message}`); // Stripe retries
  }
  logger.info("video-plan status synced", {
    route: "lib/video-plan", vmId: target.vmId, status: update.video_plan_status, subId: sub.id,
  });
}

/**
 * THE GRANT — invoice.paid only. Calls instaclaw_video_plan_grant, which
 * takes the SAME per-VM advisory lock as the reserve RPC (grant-vs-render
 * races structurally impossible) and applies the idempotency pair:
 *   invoice_id ≠ last  AND  period_end ≥ stored   (Finding 3: ≥, not > —
 * a late-paying dunning invoice whose period subscription.updated already
 * advanced MUST still grant; a stale prior-period retry must not).
 * SET-not-increment: a same-invoice retry that somehow passed the guard
 * would still be value-idempotent (no-rollover falls out of the SET).
 */
export async function grantVideoPlanAllowance(
  supabase: SupabaseClient,
  customerId: string,
  invoice: { id?: string; subscription?: string | null; period_end?: number; lines?: InvoiceLike["lines"] },
  subStatus: string | undefined,
  periodEndUnix: number | undefined,
): Promise<void> {
  const target = await resolveVmForCustomer(supabase, customerId);
  if (!target) {
    logger.error("video-plan grant: no VM resolved — allowance NOT granted", {
      route: "lib/video-plan", customerId, invoiceId: invoice.id,
    });
    return; // no VM to grant onto; the reconcile backstop heals when assigned
  }
  const { data, error } = await supabase.rpc("instaclaw_video_plan_grant", {
    p_vm_id: target.vmId,
    p_invoice_id: invoice.id ?? "",
    p_sub_id: invoice.subscription ?? null,
    p_status: mapPlanStatus(subStatus ?? "active"),
    p_period_end: periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : new Date().toISOString(),
    p_allowance: VIDEO_PLAN_ALLOWANCE_VC,
  });
  if (error) {
    logger.error("video-plan grant RPC failed — throwing for Stripe retry", {
      route: "lib/video-plan", vmId: target.vmId, invoiceId: invoice.id, error: error.message,
    });
    throw new Error(`video_plan_grant_failed: ${error.message}`);
  }
  logger.info("video-plan allowance granted", {
    route: "lib/video-plan", vmId: target.vmId, invoiceId: invoice.id, result: data,
  });
}
