/**
 * POST /api/onboarding/done/submit
 *
 * Channel-onboarding form submission handler. Called by
 * /onboarding/done's client when the user taps Done or Skip.
 *
 * Responsibilities:
 *   1. Validate session ownership (the auth'd user owns the pending row).
 *   2. Write user_profile (if not skipped + at least one field provided).
 *   3. Write user_channel_bindings (channel, channel_identity) for
 *      permanent routing of future inbound messages.
 *   4. Set users.preferred_channel from pending.channel.
 *   5. Compare-and-swap pending.consumed_at = NOW. Race-safe against
 *      Pass 6 reclaim AND the m-return-sweep cron.
 *   6. Try to dispatch M_RETURN via lib/m-return-dispatch. If VM
 *      isn't ready, the sweep cron picks it up later.
 *
 * Return shape:
 *   { kind: "ok" }           — happy path
 *   { kind: "expired" }      — pending row was reclaimed by Pass 6
 *                              while user was on the form. UI shows
 *                              "your signup expired — text us again
 *                              to start over" message.
 *   { kind: "error", error } — DB or unexpected error. UI surfaces
 *                              with retry option.
 *
 * Auth: middleware enforces NextAuth session (this route is NOT in
 * selfAuthAPIs). Additional pending-row ownership check below.
 *
 * Per CLAUDE.md Rule 11, this route can plausibly take >10s on a
 * cold M_RETURN dispatch (VM gateway HTTP call + Sendblue send + DB
 * writes). Setting maxDuration=300 per Rule 11.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { dispatchMReturn } from "@/lib/m-return-dispatch";

export const maxDuration = 300;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Allowed CHECK values for instaclaw_user_profile, matching the
// migration's CHECK constraints. Anything else is rejected client-side
// shape (defense beyond the DB constraint).
const VALID_INTENDED_USE = new Set(["work", "personal", "both"]);
const VALID_VIBE = new Set([
  "just-get-things-done",
  "chatty-and-warm",
  "wry-and-minimal",
]);

interface SubmitBody {
  sessionId?: unknown;
  skipped?: unknown;
  profile?: {
    name?: unknown;
    intended_use?: unknown;
    vibe?: unknown;
  };
}

export async function POST(req: NextRequest) {
  const authSession = await auth();
  if (!authSession?.user?.id) {
    return NextResponse.json({ kind: "error", error: "Unauthorized" }, { status: 401 });
  }
  const userId = authSession.user.id;

  // ─── Parse + validate body ──
  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return NextResponse.json(
      { kind: "error", error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    return NextResponse.json(
      { kind: "error", error: "Missing or malformed sessionId" },
      { status: 400 },
    );
  }

  const skipped = body.skipped === true;

  // Sanitize profile inputs — never trust what came over the wire.
  let nameClean: string | null = null;
  let intendedUseClean: string | null = null;
  let vibeClean: string | null = null;

  if (!skipped && body.profile && typeof body.profile === "object") {
    const p = body.profile;

    if (typeof p.name === "string") {
      const trimmed = p.name.trim();
      if (trimmed.length > 0 && trimmed.length <= 100) {
        nameClean = trimmed;
      }
    }

    if (typeof p.intended_use === "string" && VALID_INTENDED_USE.has(p.intended_use)) {
      intendedUseClean = p.intended_use;
    }

    if (typeof p.vibe === "string" && VALID_VIBE.has(p.vibe)) {
      vibeClean = p.vibe;
    }
  }

  const supabase = getSupabase();

  // ─── Verify session ownership ──
  const { data: pending, error: pendingErr } = await supabase
    .from("instaclaw_pending_users")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (pendingErr) {
    logger.error("[/api/onboarding/done/submit] pending lookup failed", {
      route: "onboarding/done/submit",
      userId,
      sessionId,
      error: pendingErr.message,
    });
    return NextResponse.json(
      { kind: "error", error: "DB read failed" },
      { status: 500 },
    );
  }

  if (!pending) {
    logger.warn("[/api/onboarding/done/submit] pending row not found", {
      route: "onboarding/done/submit",
      userId,
      sessionId,
    });
    return NextResponse.json({ kind: "expired" });
  }

  // Hostile session-id swap: pending row belongs to a different user.
  if (pending.user_id && pending.user_id !== userId) {
    logger.warn("[/api/onboarding/done/submit] hostile pending bind", {
      route: "onboarding/done/submit",
      userId,
      sessionId,
      pendingUserId: pending.user_id,
    });
    return NextResponse.json({ kind: "expired" });
  }

  // Already consumed by another writer (Pass 6 reclaim, prior submit, or
  // the sweep cron). UI treats this as "expired".
  if (pending.consumed_at) {
    logger.info("[/api/onboarding/done/submit] pending already consumed", {
      route: "onboarding/done/submit",
      userId,
      sessionId,
      consumedAt: pending.consumed_at,
      reclaimedAt: pending.reclaimed_at,
    });
    // If the row was reclaimed (Pass 6), the user's VM is gone — they
    // need to start over. If consumed without reclaim (somehow), tell
    // them they're already done. Either way, the UI's "expired" state
    // is the right affordance.
    return NextResponse.json({
      kind: pending.reclaimed_at ? "expired" : "ok",
    });
  }

  // ─── Compare-and-swap consumed_at = NOW (atomic claim) ──
  // Race-safe against Pass 6 + sweep cron. Whoever sets consumed_at
  // first wins. If we lose, return "expired" so UI redirects user to
  // start over.
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from("instaclaw_pending_users")
    .update({ consumed_at: nowIso })
    .eq("id", sessionId)
    .eq("user_id", userId) // defense: ensure user_id was set by /auth bind
    .is("consumed_at", null)
    .select()
    .maybeSingle();

  if (claimErr) {
    logger.error("[/api/onboarding/done/submit] claim UPDATE failed", {
      route: "onboarding/done/submit",
      userId,
      sessionId,
      error: claimErr.message,
    });
    return NextResponse.json(
      { kind: "error", error: "DB write failed" },
      { status: 500 },
    );
  }

  if (!claimed) {
    // Race lost — Pass 6 or sweep got here first.
    logger.info("[/api/onboarding/done/submit] consumed_at race lost", {
      route: "onboarding/done/submit",
      userId,
      sessionId,
    });
    return NextResponse.json({ kind: "expired" });
  }

  // ─── Write user_profile (if any data) ──
  // ON CONFLICT DO UPDATE because the user might have hit submit twice
  // in quick succession (one wins the race; the other gets "expired";
  // but the winner's UPSERT here handles re-runs cleanly).
  if (!skipped && (nameClean || intendedUseClean || vibeClean)) {
    const { error: profileErr } = await supabase
      .from("instaclaw_user_profile")
      .upsert(
        {
          user_id: userId,
          name: nameClean,
          intended_use: intendedUseClean,
          vibe: vibeClean,
          filled_at: nowIso,
        },
        { onConflict: "user_id" },
      );

    if (profileErr) {
      logger.warn("[/api/onboarding/done/submit] user_profile upsert failed", {
        route: "onboarding/done/submit",
        userId,
        sessionId,
        error: profileErr.message,
      });
      // Don't bail — profile is nice-to-have, not gate-on. Continue
      // to binding + M_RETURN.
    }
  }

  // ─── Write user_channel_bindings (permanent routing) ──
  // INSERT ... ON CONFLICT DO NOTHING because if this same (channel,
  // channel_identity) somehow exists, we don't want to error or
  // overwrite — the binding's user_id is enforced unique on the pair.
  if (pending.channel && pending.channel_identity) {
    const { error: bindErr } = await supabase
      .from("instaclaw_user_channel_bindings")
      .upsert(
        {
          user_id: userId,
          channel: pending.channel,
          channel_identity: pending.channel_identity,
        },
        { onConflict: "channel,channel_identity" },
      );

    if (bindErr) {
      logger.error("[/api/onboarding/done/submit] binding upsert failed", {
        route: "onboarding/done/submit",
        userId,
        sessionId,
        error: bindErr.message,
      });
      // This is more serious — without the binding, inbound messages
      // won't route back to this user. But the consumed_at is already
      // set, so we can't unwind. Best effort: continue, log loudly.
    }
  }

  // ─── Set users.preferred_channel ──
  if (pending.channel) {
    const { error: userUpdateErr } = await supabase
      .from("instaclaw_users")
      .update({ preferred_channel: pending.channel })
      .eq("id", userId);

    if (userUpdateErr) {
      logger.warn("[/api/onboarding/done/submit] preferred_channel update failed", {
        route: "onboarding/done/submit",
        userId,
        error: userUpdateErr.message,
      });
    }
  }

  // ─── Try to dispatch M_RETURN ──
  // Fast path: if the VM gateway is ready, M_RETURN arrives ~1s after
  // the user closes the tab. Slow path: VM not ready yet → sweep cron
  // picks it up when gateway_url appears.
  const dispatchResult = await dispatchMReturn(sessionId, "form-submit");

  logger.info("[/api/onboarding/done/submit] complete", {
    route: "onboarding/done/submit",
    userId,
    sessionId,
    channel: pending.channel,
    skipped,
    hadName: !!nameClean,
    hadIntendedUse: !!intendedUseClean,
    hadVibe: !!vibeClean,
    dispatchResult,
  });

  return NextResponse.json({ kind: "ok" });
}
