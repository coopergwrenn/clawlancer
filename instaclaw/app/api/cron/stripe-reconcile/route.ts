import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getStripe, tierFromPriceId } from "@/lib/stripe";
import { sendAdminAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Stripe Reconciliation Cron
 *
 * Compares all active/trialing/past_due subscriptions in Stripe against
 * the instaclaw_subscriptions table and fixes mismatches. This prevents
 * the DB from drifting out of sync with Stripe due to missed webhooks.
 *
 * Runs every 6 hours. Fixes are applied automatically; mismatches are
 * logged and emailed to the admin.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const stripe = getStripe();

  const report = {
    stripe_active: 0,
    stripe_trialing: 0,
    stripe_past_due: 0,
    db_matches: 0,
    status_fixed: 0,
    missing_sub_created: 0,
    missing_user: 0,
    errors: [] as string[],
    fixes: [] as string[],
  };

  try {
    // Step 1: Fetch ALL non-canceled subscriptions from Stripe
    const stripeSubscriptions: Array<{
      id: string;
      customer: string;
      status: string;
      items: { data: Array<{ price: { id: string } }> };
    }> = [];

    for (const status of ["active", "trialing", "past_due"] as const) {
      let hasMore = true;
      let startingAfter: string | undefined;

      while (hasMore) {
        const params: Record<string, unknown> = { status, limit: 100 };
        if (startingAfter) params.starting_after = startingAfter;

        const response = await stripe.subscriptions.list(params as Parameters<typeof stripe.subscriptions.list>[0]);
        stripeSubscriptions.push(...(response.data as typeof stripeSubscriptions));
        hasMore = response.has_more;
        if (response.data.length > 0) {
          startingAfter = response.data[response.data.length - 1].id;
        }
      }
    }

    report.stripe_active = stripeSubscriptions.filter(s => s.status === "active").length;
    report.stripe_trialing = stripeSubscriptions.filter(s => s.status === "trialing").length;
    report.stripe_past_due = stripeSubscriptions.filter(s => s.status === "past_due").length;

    // Step 2: Build a map of Stripe customer_id → subscription info
    const stripeMap = new Map<string, typeof stripeSubscriptions[0]>();
    for (const sub of stripeSubscriptions) {
      // If a customer has multiple subs, keep the "best" one (active > trialing > past_due)
      const existing = stripeMap.get(sub.customer);
      if (!existing || priorityOf(sub.status) > priorityOf(existing.status)) {
        stripeMap.set(sub.customer, sub);
      }
    }

    // Step 3: Get all users with stripe_customer_id
    const { data: users } = await supabase
      .from("instaclaw_users")
      .select("id, email, stripe_customer_id")
      .not("stripe_customer_id", "is", null);

    const userByCustomerId = new Map<string, { id: string; email: string; stripe_customer_id: string }>();
    for (const u of users ?? []) {
      if (u.stripe_customer_id) {
        userByCustomerId.set(u.stripe_customer_id, u);
      }
    }

    // Step 4: Get all subscription records from DB
    const { data: dbSubs } = await supabase
      .from("instaclaw_subscriptions")
      .select("*");

    const dbSubByUserId = new Map<string, (typeof dbSubs extends Array<infer T> ? T : never)>();
    for (const s of dbSubs ?? []) {
      dbSubByUserId.set(s.user_id, s);
    }

    // Step 5: Reconcile each Stripe subscription
    for (const [customerId, stripeSub] of stripeMap) {
      const user = userByCustomerId.get(customerId);

      if (!user) {
        // Stripe customer has no matching user in our DB
        report.missing_user++;
        continue;
      }

      const dbSub = dbSubByUserId.get(user.id);
      const priceId = stripeSub.items?.data?.[0]?.price?.id;
      const tier = priceId ? tierFromPriceId(priceId) : null;

      if (!dbSub) {
        // User exists but has no subscription record — create one
        const { error } = await supabase.from("instaclaw_subscriptions").insert({
          user_id: user.id,
          stripe_customer_id: customerId,
          stripe_subscription_id: stripeSub.id,
          status: stripeSub.status,
          tier: tier ?? "starter",
          payment_status: stripeSub.status === "past_due" ? "past_due" : "current",
          past_due_since: stripeSub.status === "past_due" ? new Date().toISOString() : null,
        });

        if (error) {
          report.errors.push(`Failed to create sub for ${user.email}: ${error.message}`);
        } else {
          report.missing_sub_created++;
          report.fixes.push(`Created subscription for ${user.email} (Stripe: ${stripeSub.status})`);
        }
        continue;
      }

      // Subscription record exists — check if status matches
      if (dbSub.status !== stripeSub.status) {
        const updates: Record<string, unknown> = {
          status: stripeSub.status,
          stripe_subscription_id: stripeSub.id,
          stripe_customer_id: customerId,
        };

        // Clear past_due_since when moving to active/trialing
        if (stripeSub.status === "active" || stripeSub.status === "trialing") {
          updates.past_due_since = null;
          updates.payment_status = "current";
        }

        // Set past_due_since when moving to past_due (if not already set)
        if (stripeSub.status === "past_due" && !dbSub.past_due_since) {
          updates.past_due_since = new Date().toISOString();
          updates.payment_status = "past_due";
        }

        // Update tier if detected
        if (tier && tier !== dbSub.tier) {
          updates.tier = tier;
        }

        const { error } = await supabase
          .from("instaclaw_subscriptions")
          .update(updates)
          .eq("id", dbSub.id);

        if (error) {
          report.errors.push(`Failed to update ${user.email}: ${error.message}`);
        } else {
          report.status_fixed++;
          report.fixes.push(`${user.email}: DB ${dbSub.status} → Stripe ${stripeSub.status}`);
        }
      } else {
        // Ensure stripe_customer_id is up to date (handles customer ID changes)
        if (dbSub.stripe_customer_id !== customerId) {
          await supabase
            .from("instaclaw_subscriptions")
            .update({ stripe_customer_id: customerId, stripe_subscription_id: stripeSub.id })
            .eq("id", dbSub.id);
          report.fixes.push(`${user.email}: updated customer_id ${dbSub.stripe_customer_id} → ${customerId}`);
          report.status_fixed++;
        } else {
          report.db_matches++;
        }
      }
    }

    // Step 6: Check for DB records that say active/trialing but Stripe says otherwise
    for (const dbSub of dbSubs ?? []) {
      if (dbSub.status !== "active" && dbSub.status !== "trialing") continue;

      const custId = dbSub.stripe_customer_id;
      if (!custId) continue;

      const stripeSub = stripeMap.get(custId);
      if (!stripeSub) {
        // DB says active but Stripe has no active sub for this customer
        // This means the subscription was canceled in Stripe but webhook was missed
        const { error } = await supabase
          .from("instaclaw_subscriptions")
          .update({ status: "canceled" })
          .eq("id", dbSub.id);

        if (!error) {
          const user = (users ?? []).find(u => u.id === dbSub.user_id);
          report.status_fixed++;
          report.fixes.push(`${user?.email ?? dbSub.user_id}: DB active → canceled (not in Stripe)`);
        }
      }
    }

    // Step 7: Send admin alert if any fixes were made
    if (report.fixes.length > 0) {
      const subject = `Stripe Reconciliation: ${report.fixes.length} fixes applied`;
      const body = [
        `Stripe subscription reconciliation ran at ${new Date().toISOString()}`,
        "",
        `Stripe counts: ${report.stripe_active} active, ${report.stripe_trialing} trialing, ${report.stripe_past_due} past_due`,
        `DB matches (no fix needed): ${report.db_matches}`,
        `Status fixes applied: ${report.status_fixed}`,
        `Missing subscriptions created: ${report.missing_sub_created}`,
        `Orphaned Stripe customers (no user in DB): ${report.missing_user}`,
        "",
        "Fixes:",
        ...report.fixes.map(f => `  - ${f}`),
        ...(report.errors.length > 0 ? ["", "Errors:", ...report.errors.map(e => `  - ${e}`)] : []),
      ].join("\n");

      await sendAdminAlertEmail(subject, body).catch(() => {});

      logger.info("Stripe reconciliation complete", {
        route: "cron/stripe-reconcile",
        ...report,
      });
    }
  } catch (err) {
    logger.error("Stripe reconciliation failed", {
      route: "cron/stripe-reconcile",
      error: String(err),
    });
    report.errors.push(String(err));
  }

  return NextResponse.json(report);
}

function priorityOf(status: string): number {
  switch (status) {
    case "active": return 3;
    case "trialing": return 2;
    case "past_due": return 1;
    default: return 0;
  }
}
