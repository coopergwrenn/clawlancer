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
    /**
     * True ONLY when a Stripe subscription EXISTED but the live retrieve FAILED
     * (outage) — the non-paying signal is untrustworthy. Distinct from
     * stripeSubVerified=false on a no-sub user (nothing to verify → reliable).
     * Destructive callers MUST treat true as "do not act" (Lesson 2). Default false.
     */
    stripeUnreachable: boolean;
    /**
     * True when the comp/founder billing_exempt read was a CLEAN read (verified).
     * False when that read errored — the exemption status is unknown, so a
     * destructive caller must fail-closed (a blip could be hiding an exempt
     * account). Mirrors fetchBillingExempt's `verified`. Default true (the
     * unassigned path + legacy callers have nothing to verify).
     */
    compExemptVerified: boolean;
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
        stripeUnreachable: false,
        compExemptVerified: true,
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

  // Path 0 input: comp/founder exemption on the owning account.
  const { exempt, exemptReason, verified: exemptVerified } = await fetchBillingExempt(supabase, vm.assigned_to);

  return classify(vm, sub, /* verified */ false, /* drift */ false, exempt, exemptReason, exemptVerified);
}

/**
 * Fetch the owning account's comp/founder exemption (instaclaw_users.billing_exempt).
 * Never throws. Returns THREE signals so both fail directions are correct
 * (this primitive has a DUAL ROLE — read both paragraphs before "fixing" it):
 *
 *   - `exempt`   : true only on a CLEAN read of billing_exempt=true.
 *   - `verified` : true when the read succeeded (row OR no-row). false on a
 *                  read ERROR / exception (unverifiable).
 *   - `exemptReason`: the reason string, or an "unverifiable_*" sentinel on error.
 *
 * On an ERROR/exception, `exempt` stays FALSE and `verified` is FALSE. This is
 * the SAME fail-closed principle expressed in opposite values for the two
 * caller families:
 *
 *   GRANT side — classify() Path 0 (`if (exempt) isPaying=true`), via
 *   getBillingStatus / getBillingStatusVerified. These IGNORE `verified` and
 *   read `exempt`, which stays FALSE on error → a transient DB hiccup can never
 *   accidentally GRANT isPaying to a non-exempt account. Fail-closed on grant.
 *   (Worst case: a real comp account is briefly classified non-exempt by these
 *   read paths — cushioned by the destructive consumers' own fail-closed null
 *   guards + grace windows.) DO NOT make these read `verified`.
 *
 *   DESTROY side — the suspend/hibernate guards (`if (!exempt) { suspend }`).
 *   These MUST read `verified`: destroy only on `(!exempt && verified)` — i.e.
 *   a CONFIRMED not-exempt read — and skip on `(exempt || !verified)`. A
 *   transient DB hiccup (verified=false) can never permit a suspend of a
 *   protected VM. Fail-closed on destroy. (2026-06-11: this is the F1 fix —
 *   the root primitive under the 2026-06-10 vm-1075 downtime, where the old
 *   collapsed `{exempt:false}` on error let a blip suspend a comp founder VM.)
 *
 * Same principle (a DB blip is never allowed to harm a protected account),
 * opposite values (grant wants exempt:false, destroy wants !verified) — which
 * is exactly why the signal is split into `exempt` + `verified` rather than
 * one boolean. The Pass-2 Rule-14 consolidation should FOLD this `verified`
 * pattern in, not replace it.
 */
export async function fetchBillingExempt(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ exempt: boolean; exemptReason: string | null; verified: boolean }> {
  try {
    const { data, error } = await supabase
      .from("instaclaw_users")
      .select("billing_exempt, billing_exempt_reason")
      .eq("id", userId)
      .maybeSingle();
    // Read ERROR — unverifiable. Destroy side fails closed via verified=false;
    // grant side stays exempt=false (no false grant). Split from the no-row
    // case below (maybeSingle cleanly distinguishes error from zero rows).
    if (error) {
      return { exempt: false, exemptReason: "unverifiable_read_error", verified: false };
    }
    // Clean read, NO row — genuinely not exempt. Correct to proceed.
    if (!data) {
      return { exempt: false, exemptReason: null, verified: true };
    }
    // Clean read with a row.
    return {
      exempt: (data as { billing_exempt?: boolean }).billing_exempt === true,
      exemptReason: (data as { billing_exempt_reason?: string | null }).billing_exempt_reason ?? null,
      verified: true,
    };
  } catch {
    // Exception (network/timeout/client throw) — unverifiable.
    return { exempt: false, exemptReason: "unverifiable_exception", verified: false };
  }
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

  // Path 0 input: comp/founder exemption on the owning account. Fetched once,
  // threaded into every classify() branch below.
  const { exempt, exemptReason, verified: exemptVerified } = await fetchBillingExempt(supabase, vm.assigned_to);

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

  // No local sub → just classify on credits/partner/exemption. Stripe
  // verification doesn't apply (no sub_id to retrieve).
  if (!localSub?.stripe_subscription_id) {
    return classify(vm, localSub, /* verified */ false, /* drift */ false, exempt, exemptReason, exemptVerified);
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
    // Verification failed AND a stripe_subscription_id existed → the non-paying
    // signal is untrustworthy. Flag stripeUnreachable=true (7th→8th arg) so
    // destructive callers fail-closed (Lesson 2).
    return classify(vm, localSub, /* verified */ false, /* drift */ false, exempt, exemptReason, exemptVerified, /* unreachable */ true);
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

  return classify(vm, synth, /* verified */ true, drift, exempt, exemptReason, exemptVerified);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classify(
  vm: any,
  sub: any,
  verified: boolean,
  drift: boolean,
  // billing_exempt lives on instaclaw_users (the owning account), NOT the vm
  // row — the callers fetch it and thread it in. Defaults false so callers
  // that haven't been updated (or the unassigned path) behave as before.
  billingExempt = false,
  billingExemptReason: string | null = null,
  // True when the billing_exempt read was a clean read (mirrors
  // fetchBillingExempt's `verified`). Default true: the unassigned path + any
  // legacy caller has nothing to verify.
  compExemptVerified = true,
  // True ONLY in the stripe-retrieve-failed branch (sub existed, Stripe down).
  stripeUnreachable = false,
): BillingStatus {
  const reasons: string[] = [];
  let isPaying = false;

  const subStatus = sub?.status ?? null;
  const paymentStatus = sub?.payment_status ?? null;
  const canceledAt = sub?.canceled_at ?? null;
  const creditBalance = vm.credit_balance ?? 0;
  const partner = vm.partner ?? null;
  const apiMode = vm.api_mode ?? null;
  const tier = vm.tier ?? null;

  // Path 0: comp/founder exemption (instaclaw_users.billing_exempt). Replaces
  // the hardcoded PROTECTED_USER_IDS set in vm-lifecycle. Checked FIRST so a
  // comp account is paying regardless of sub/credit state — and so every
  // billing-gated path (guard, freeze, reaper, suspend-check) honors it
  // through this single source of truth. See migration
  // 20260610210000_user_billing_exempt.sql.
  if (billingExempt) {
    isPaying = true;
    reasons.push(billingExemptReason ? `comp_exempt_${billingExemptReason}` : "comp_exempt");
  }

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
      stripeUnreachable,
      compExemptVerified,
      stripeDriftDetected: drift,
      creditBalance,
      partner,
      apiMode,
      tier,
    },
  };
}

/**
 * Freeze-safety verdict, built on the SoT (Rule 14 + Rule 82). The canonical
 * billing gate for EVERY destructive freeze/delete path — never re-implement
 * billing classification at the call site (that anti-pattern is exactly what
 * Rule 14 exists to kill; it was found live in the freeze gate on 2026-06-11).
 *
 * Composes ONE coherent predicate over getBillingStatusVerified, which already
 * folds the comp/founder exemption (Path 0) AND every revenue source into
 * isPaying and verifies against Stripe. Three mutually-exclusive states:
 *   - "paying":      isPaying by ANY source — active/trialing sub, past_due-in-
 *                    grace, credits, partner, all-inclusive tier, OR a verified
 *                    comp-exemption. NEVER act — caller skips THIS vm.
 *   - "unverifiable":the VM row was unreadable, OR a Stripe sub existed but its
 *                    live retrieve failed (stripeUnreachable), OR the comp-exempt
 *                    read errored (compExemptVerified=false). The non-paying
 *                    signal is untrustworthy → caller MUST skip ALL candidates
 *                    THIS TICK. Fail-closed on BOTH the Stripe AND the exempt
 *                    read — an outage on either must never cause a destructive
 *                    spree on possibly-paying / possibly-comp customers (Lesson 2).
 *   - "freezable":   reliably non-paying AND both reads were trustworthy. Safe.
 *
 * Requires a Stripe client (verified path). Call AFTER the cheap local gates
 * (status/health/activity) so Stripe is only hit for genuine survivors.
 */
export type FreezeBillingVerdict = "paying" | "freezable" | "unverifiable";

export async function classifyFreezeBilling(
  supabase: SupabaseClient,
  stripe: Stripe,
  vmId: string,
): Promise<FreezeBillingVerdict> {
  const bs = await getBillingStatusVerified(supabase, stripe, vmId);
  if (bs === null) return "unverifiable"; // couldn't read the VM row
  if (bs.isPaying) return "paying"; // any revenue source incl verified comp-exemption
  // !isPaying — trust it ONLY if BOTH reads were trustworthy.
  if (bs.details.stripeUnreachable) return "unverifiable"; // sub existed, Stripe down
  if (!bs.details.compExemptVerified) return "unverifiable"; // comp-exempt read errored
  return "freezable";
}

/**
 * Cheap user-level billing check for "should we ASSIGN a VM to this user?"
 *
 * Unlike getBillingStatus / getBillingStatusVerified (which key off a
 * specific vm_id and consult VM-row fields like credit_balance + api_mode),
 * this helper takes only userId because at assignment time the user has
 * no VM yet. credit_balance is a per-VM concept that only materializes
 * AFTER assignment, so we can't check it here.
 *
 * Returns billable=true if ANY of:
 *   - User has an `instaclaw_subscriptions` row with status active/trialing
 *   - User has a non-null `partner` (edge_city, consensus_2026, etc) —
 *     sponsored cohorts skip /plan entirely and never get a Stripe sub
 *
 * Used by process-pending Pass 1, Pass 3, Pass 3b to gate VM assignment +
 * retry. The original sub-only check broke channel-first Edge attendees:
 * they go from /auth → /onboarding/done with no Stripe round-trip, so they
 * never have a subscription row, and every retry pass skipped them.
 *
 * Never throws. Returns { billable, reason, verified }:
 *   - On a CLEAN read (incl. a genuine "not billable" result like
 *     no_payment_signal / stripe_canceled), `verified` is TRUE.
 *   - On a read ERROR / exception, `billable` stays FALSE and `verified` is
 *     FALSE (unverifiable).
 *
 * `verified` exists because callers have OPPOSITE polarity and must fail
 * closed in their own direction (2026-06-11, sibling of the F1 fix):
 *   - CONSTRUCTIVE callers — `if (!billable) skip` to gate provision/configure
 *     (process-pending Pass 1/3/3b, health-check stuck-deploy). These IGNORE
 *     `verified`: billable=false on error → skip the constructive action =
 *     already fail-closed (don't provision/configure on a blip). UNCHANGED.
 *   - DESTRUCTIVE-direction caller — vm-lifecycle's hibernating→suspended
 *     transition (`if (billable) skip-transition`). This MUST read `verified`:
 *     skip the transition on `(billable || !verified)` so a blip can't advance
 *     a protected VM toward reclaim. Fail-closed on destroy.
 * DO NOT make the constructive callers read `verified` — that would flip them
 * to provision/configure on a blip (the polarity bug). Check the gate
 * direction at every new call site before relying on `verified`.
 */
export async function isUserBillableForVmAssignment(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ billable: boolean; reason: string; verified: boolean }> {
  // 0/1. Comp-exempt + partner gate (cheap, hits instaclaw_users only).
  //    billing_exempt users (founder / family / partner-comp) are billable
  //    regardless of Stripe state — Path 0, same as getBillingStatus.classify.
  //    Partner-tagged users are sponsored; billable regardless of Stripe state.
  //    Without the billing_exempt check here, vm-lifecycle's hibernating→suspended
  //    transition (the only caller) would still suspend an exempt user whose
  //    sub is canceled and who has no partner (the 2026-06-10 vm-1075 class).
  try {
    const { data: user, error: userErr } = await supabase
      .from("instaclaw_users")
      .select("partner, billing_exempt, billing_exempt_reason")
      .eq("id", userId)
      .maybeSingle();
    if (userErr) {
      logger.warn("isUserBillableForVmAssignment: user lookup failed", {
        userId,
        error: userErr.message,
      });
      return { billable: false, reason: "user_lookup_error", verified: false };
    }
    const u = user as {
      partner?: string | null;
      billing_exempt?: boolean;
      billing_exempt_reason?: string | null;
    } | null;
    if (u?.billing_exempt === true) {
      return { billable: true, reason: `comp_exempt_${u.billing_exempt_reason ?? "unknown"}`, verified: true };
    }
    const partner = u?.partner ?? null;
    if (partner) {
      return { billable: true, reason: `partner_${partner}`, verified: true };
    }
  } catch (err) {
    logger.warn("isUserBillableForVmAssignment: user lookup threw", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { billable: false, reason: "user_lookup_exception", verified: false };
  }

  // 2. Subscription gate. Active or trialing → billable.
  try {
    const { data: sub, error: subErr } = await supabase
      .from("instaclaw_subscriptions")
      .select("status")
      .eq("user_id", userId)
      .maybeSingle();
    if (subErr) {
      logger.warn("isUserBillableForVmAssignment: sub lookup failed", {
        userId,
        error: subErr.message,
      });
      return { billable: false, reason: "sub_lookup_error", verified: false };
    }
    const status = (sub as { status?: string | null } | null)?.status ?? null;
    if (status && ["active", "trialing"].includes(status)) {
      return { billable: true, reason: `stripe_${status}`, verified: true };
    }
    // Clean read, genuinely not billable (no sub / canceled / past_due / etc.)
    // → verified TRUE so the destructive-direction caller proceeds as today.
    return {
      billable: false,
      reason: status ? `stripe_${status}` : "no_payment_signal",
      verified: true,
    };
  } catch (err) {
    logger.warn("isUserBillableForVmAssignment: sub lookup threw", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { billable: false, reason: "sub_lookup_exception", verified: false };
  }
}
