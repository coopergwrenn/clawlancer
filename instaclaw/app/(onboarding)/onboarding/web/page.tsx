/**
 * /onboarding/web — web-only onboarding entry, no messaging channel.
 *
 * The destination of /channels' "skip to your command center" link.
 * Mirrors the structure of app/(auth)/auth/page.tsx exactly — server
 * component, auth-gated, idempotent on refresh, fires VM provision in
 * after(), redirects to /plan or /onboarding/done for Edge partners.
 *
 * Key differences from /auth:
 *   - No session= query param. We synthesize a fresh pending_users row
 *     for this user with channel='web'.
 *   - channel_identity is the user's UUID (sentinel — can't collide
 *     with E.164 phone or Telegram chat-id which are different shapes).
 *   - We update instaclaw_users.preferred_channel='web' so SOUL.md
 *     generation + dashboard banner (Phase 2) can branch on it.
 *   - VM ends up with channels_enabled=[] (empty array — the
 *     buildOpenClawConfig path at lib/ssh.ts:5260 already gates on
 *     channels.includes("telegram") so no telegram block is written
 *     when the array is empty). The 7 production VMs that already run
 *     in this shape (vm-036, vm-040, vm-108, vm-511, vm-527, vm-603,
 *     vm-linode-10) prove this works.
 *
 * Idempotency contract:
 *   - Refresh = reuse existing in-flight pending row, never create a
 *     parallel one.
 *   - If user has a 'telegram' or 'imessage' in-flight row from a prior
 *     attempt, DON'T clobber it — let that flow complete if they later
 *     change their mind. We just bail out to /dashboard.
 *
 * Self-auth: the (onboarding) route group has no middleware-level auth
 * guard (matcher in middleware.ts:130 doesn't include /onboarding/*).
 * Page-level auth() check is the source of truth — same pattern as
 * /auth and /onboarding/done.
 *
 * Multiple-in-flight handling: a user could theoretically have multiple
 * in-flight pending rows (one 'web' + one 'imessage' from a competing
 * tab). PostgREST .maybeSingle() throws on >1 row. We ORDER BY
 * created_at DESC LIMIT 1 to deterministically pick the most-recent
 * row — if most recent is 'web' we reuse, if it's a channel attempt we
 * bail.
 */

import { redirect } from "next/navigation";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { assignOrProvisionUserVm } from "@/lib/createUserVM";
import { logger } from "@/lib/logger";

export default async function OnboardingWebPage() {
  const authSession = await auth();

  // Unauthenticated → /signin with callbackUrl preserved. Mirror of
  // middleware's bounce for protected routes.
  if (!authSession?.user?.id) {
    redirect("/signin?callbackUrl=/onboarding/web");
  }
  const userId = authSession.user.id;
  const supabase = getSupabase();

  // ─── Idempotency: SELECT before INSERT ──
  // Any in-flight pending row for this user is the source of truth.
  //   - 'web' row from a prior visit: reuse (refresh case).
  //   - 'imessage' / 'telegram' row from a partial channel attempt:
  //     don't clobber. Bail to /dashboard; the layout's data-driven
  //     redirect handles them from there.
  // ORDER+LIMIT ensures determinism if the user has more than one
  // in-flight row (rare but possible — see the spec doc §7.2).
  const { data: existing, error: selectErr } = await supabase
    .from("instaclaw_pending_users")
    .select("id, channel")
    .eq("user_id", userId)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectErr) {
    logger.error("[/onboarding/web] pending select failed", {
      route: "onboarding/web",
      userId,
      error: selectErr.message,
    });
    // Best-effort: send to /dashboard. They're authed; the layout will
    // route based on VM state. Better than crashing the page.
    redirect("/dashboard");
  }

  let pendingId: string;
  if (existing) {
    if (existing.channel === "web") {
      // Refresh case — reuse the in-flight row.
      pendingId = existing.id;
    } else {
      // In-flight channel attempt. Don't override. They probably landed
      // here from a back-button or competing tab. Bail to /dashboard;
      // the layout routes them by VM state.
      logger.info("[/onboarding/web] user has in-flight channel pending; bailing", {
        route: "onboarding/web",
        userId,
        existingChannel: existing.channel,
      });
      redirect("/dashboard");
    }
  } else {
    // No in-flight row — create the 'web' pending. channel_identity =
    // userId (UUID) is the sentinel for web. UUIDs can't collide with
    // E.164 phone numbers (+...) or Telegram chat-ids (numeric string)
    // so the partial unique index (channel, channel_identity)
    // WHERE consumed_at IS NULL is safe.
    const { data: inserted, error: insertErr } = await supabase
      .from("instaclaw_pending_users")
      .insert({
        user_id: userId,
        channel: "web",
        channel_identity: userId,
        // tier + api_mode default per column defaults
        // (api_mode='all_inclusive'). /plan sets the real tier later.
      })
      .select("id")
      .single();

    if (insertErr || !inserted) {
      logger.error("[/onboarding/web] pending insert failed", {
        route: "onboarding/web",
        userId,
        error: insertErr?.message,
      });
      redirect("/dashboard");
    }

    pendingId = inserted.id;

    // Surface the choice on instaclaw_users. Drives downstream
    // surfaces — SOUL.md/AGENTS.md generation (Phase 2), dashboard
    // nudge banner (Phase 2), settings page channels-list copy.
    // Best-effort: a failure here doesn't break onboarding. Worst case
    // the user gets a slightly weaker first-load experience (no
    // web-only agent guidance, no banner). They can still chat.
    await supabase
      .from("instaclaw_users")
      .update({ preferred_channel: "web" })
      .eq("id", userId);

    logger.info("[/onboarding/web] created web pending row + flagged user", {
      route: "onboarding/web",
      userId,
      pendingId,
    });
  }

  // ─── Fire VM provision in after() ──
  // Mirrors /auth's §6.5.2 architectural shift: provision while the
  // user enters their card on /plan. By the time they land on
  // /onboarding/done, gateway_url is populated.
  //
  // configureOpenClaw is already null-safe for channel-less users —
  // lib/ssh.ts:5260 (buildOpenClawConfig) gates Telegram writes on
  // channels.includes("telegram") && config.telegramBotToken. With
  // channels:[] and bot tokens null, the channels block stays empty
  // ({}) and the gateway boots channel-less. Empirically validated:
  // 7 production VMs run in this state today.
  const userIdForProvision = userId;
  after(async () => {
    try {
      await assignOrProvisionUserVm(userIdForProvision, { supabase });
      logger.info("[/onboarding/web] VM provision fired via after()", {
        route: "onboarding/web",
        userId: userIdForProvision,
        pendingId,
      });
    } catch (err) {
      // Logged; process-pending Pass 0 will recover any paid user
      // without a VM, and Pass 6 will reclaim the pending row if VM
      // never arrives.
      logger.error("[/onboarding/web] assignOrProvisionUserVm threw in after()", {
        route: "onboarding/web",
        userId: userIdForProvision,
        pendingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ─── Decide next route ──
  // Edge / partner users skip /plan (sponsored trial, no card).
  // Standard paid flow → /plan?web=1&session=<id> so /plan can detect
  // the channel-less branch when computing the Stripe success_url.
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("partner")
    .eq("id", userId)
    .maybeSingle();

  if (user?.partner === "edge_city") {
    redirect(`/onboarding/done?session=${pendingId}&web=1`);
  }

  redirect(`/plan?web=1&session=${pendingId}`);
}
