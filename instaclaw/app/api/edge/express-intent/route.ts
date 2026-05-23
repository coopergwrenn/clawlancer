/**
 * POST /api/edge/express-intent
 *
 * Edge City attendee form-submit endpoint — registers a free-text
 * intent in Index Network's discovery graph. The intent ("I'm
 * researching governance protocols", "I'm looking for cofounders
 * for an agentic browser startup", etc.) flows through Yanek's
 * create_intent MCP tool and becomes part of the Index opportunity
 * pool. Yanek's discovery engine then surfaces complementary intents
 * back to the user via the poller → matchpool_outcomes → notifier path.
 *
 * Auth: NextAuth session (mirrors /api/village/overlay). Session-
 * protected at the middleware level — no selfAuthAPIs entry required
 * per Rule 13.
 *
 * Partner gate: instaclaw_users.partner === "edge_city". Non-Edge
 * users get 403. The /edge/dashboard layout enforces the same gate
 * for the form's container page, so this is defense in depth.
 *
 * Rate-limit: 1 intent per user per 5 min, anchored by
 * instaclaw_users.index_last_intent_at (added via migration
 * 20260520000000). Only successful submissions advance the anchor —
 * failed submissions (validation errors, Yanek's write-tool bug)
 * allow immediate retry.
 *
 * Validation: description must be a string, 10-500 chars after trim.
 * The 500 cap is tighter than lib/index-intent-creator.ts's 2000-char
 * safety guard — keeps intents focused and prevents prompt-injection-
 * size submissions. 10-char minimum prevents "hi"/"test" spam.
 *
 * Error mapping: createIndexIntent's `error` status is mapped to a
 * single user-facing "intent registration is coming online soon"
 * message regardless of the underlying error code. This is the
 * expected failure mode until Yanek fixes his create_intent write-
 * tool bug. The operator can dig into Vercel logs for the actual
 * error code; the user just sees a coherent friendly message.
 *
 * Response shape: `{ status, message?, intentId? }` — the `status`
 * field is the stable discriminant (matches the union in
 * mapCreateIntentResultToResponse below); the form component
 * pattern-matches on it.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { createIndexIntent } from "@/lib/index-intent-creator";
import type { CreateIndexIntentResult } from "@/lib/index-intent-creator";
import { ensureIndexCredentials } from "@/lib/index-jit-provision";
import { queueIntentForBackfill } from "@/lib/index-intent-queue";

export const dynamic = "force-dynamic";
// createIndexIntent can take 1-15s (MCP initialize + tools/call +
// the burst-rate-limit retry). Plus DB roundtrips. 60s is generous
// and matches the poller route's budget.
export const maxDuration = 60;

const DESCRIPTION_MIN_CHARS = 10;
const DESCRIPTION_MAX_CHARS = 500;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ── Pure helper: response shaping ───────────────────────────────────
//
// Exported so the test suite can exercise the mapping without spinning
// up the full route (no auth mock, no DB mock, no fetch mock needed).

export type IntentResponseStatus =
  | "created"
  | "rate_limited"
  | "validation_error"
  | "not_eligible"
  | "service_unavailable"
  | "error";

export interface IntentResponseBody {
  status: IntentResponseStatus;
  message?: string;
  intentId?: string;
  retryAfterSec?: number;
}

/**
 * Map a CreateIndexIntentResult to the route's HTTP response shape.
 *
 * All error states from createIndexIntent collapse into the friendly
 * "coming online soon" message at the user-facing layer — the actual
 * error code is logged separately for operator triage. This matches
 * Cooper's spec: "if createIndexIntent returns the Yanek write-tool
 * error... surface a user-friendly 'intent registration is coming
 * online soon' message, not a raw error."
 */
export function mapCreateIntentResultToResponse(
  result: CreateIndexIntentResult,
): { status: number; body: IntentResponseBody } {
  if (result.status === "created") {
    return {
      status: 200,
      body: {
        status: "created",
        message: "your intent is registered. it's live in the directory.",
        intentId: result.intentId,
      },
    };
  }
  if (result.status === "skipped") {
    if (result.reason === "missing_description") {
      // Validation error from the lib's own check (covers length-cap
      // and empty-description cases that slip past our route's guard).
      return {
        status: 400,
        body: {
          status: "validation_error",
          message: result.detail ?? "your intent description is missing or too short.",
        },
      };
    }
    // user_not_found or no_index_credentials — the user isn't fully
    // provisioned on the Edge cohort side. Could happen mid-onboarding
    // (VM is still spinning up) or for a non-edge_city user who
    // somehow reached this route (shouldn't, given the partner gate).
    return {
      status: 403,
      body: {
        status: "not_eligible",
        message:
          "your edge city setup isn't fully online yet. give it a minute and try again.",
      },
    };
  }
  // result.status === "error" — Yanek's write-tool bug, transient
  // MCP issue, or anything else that didn't fit cleanly. ALL
  // collapse to the friendly message at the user layer.
  return {
    status: 503,
    body: {
      status: "service_unavailable",
      message:
        "intent registration is coming online soon — we're working with the index team to bring this live. try again in a few minutes.",
    },
  };
}

// ── Helper: partner gate (mirrors village/overlay pattern) ──────────

async function getEdgeCityUserOrError(
  userId: string,
): Promise<{ ok: true; lastIntentAt: string | null } | { ok: false; error: NextResponse }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_users")
    .select("id, partner, index_last_intent_at")
    .eq("id", userId)
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: NextResponse.json({ status: "error", message: "user lookup failed" }, { status: 500 }),
    };
  }
  if (data.partner !== "edge_city") {
    return {
      ok: false,
      error: NextResponse.json(
        {
          status: "not_eligible",
          message: "express-intent is available for edge city attendees only.",
        },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    lastIntentAt: (data.index_last_intent_at as string | null) ?? null,
  };
}

// ── POST handler ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // 1. Auth — session required
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { status: "error", message: "you need to sign in first." },
      { status: 401 },
    );
  }

  // 2. Partner gate + read the rate-limit anchor (saved for revert)
  const gate = await getEdgeCityUserOrError(session.user.id);
  if (!gate.ok) return gate.error;
  const originalLastIntentAt = gate.lastIntentAt;

  // 3. Body parsing + validation (cheap; do BEFORE the atomic claim
  //    so malformed bodies don't burn rate-limit budget).
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { status: "validation_error", message: "request body must be valid JSON." },
      { status: 400 },
    );
  }

  const rawDescription = body.description;
  if (typeof rawDescription !== "string") {
    return NextResponse.json(
      { status: "validation_error", message: "description must be a string." },
      { status: 400 },
    );
  }
  const description = rawDescription.trim();
  if (description.length < DESCRIPTION_MIN_CHARS) {
    return NextResponse.json(
      {
        status: "validation_error",
        message: `your intent needs at least ${DESCRIPTION_MIN_CHARS} characters.`,
      },
      { status: 400 },
    );
  }
  if (description.length > DESCRIPTION_MAX_CHARS) {
    return NextResponse.json(
      {
        status: "validation_error",
        message: `your intent must be ${DESCRIPTION_MAX_CHARS} characters or fewer (got ${description.length}).`,
      },
      { status: 400 },
    );
  }

  // 4. Atomic rate-limit claim (#A from 2026-05-20 audit).
  //
  // Pre-audit (pushed at f8ca33a2): read-then-check-then-update was
  // non-atomic — two simultaneous requests both passed the gate,
  // both called createIndexIntent, both UPDATEd the column → two
  // intents landed on Yanek's side per user-click-burst.
  //
  // Implementation uses a TWO-STEP claim instead of a single
  // UPDATE-with-OR-filter, because PostgREST's UPDATE + .or() filter
  // surfaces an "undefined_column" error in supabase-js (verified by
  // _probe-or-js-v2.ts: same .or() works on SELECT, fails on UPDATE
  // for ALL columns — client-library bug). Workaround:
  //
  //   Step 4a: Read-side rate-limit check on originalLastIntentAt
  //            we already have from the partner gate. Returns 429
  //            if within the 5-min window.
  //
  //   Step 4b: CAS atomic claim — UPDATE WHERE id = userId AND
  //            index_last_intent_at = [previous-observed-value].
  //            Uses .is(null) for NULL or .eq(timestamp) for non-NULL.
  //            Postgres serializes UPDATE on the row; only ONE
  //            concurrent request matches the previous value. Other
  //            requests see notified_*_at has CHANGED → 0 rows → 429.
  //
  // This is correctness-equivalent to the single-UPDATE-with-OR
  // pattern. Same race protection (#13's proven primitive on a
  // different table). The two-step is purely a client-library
  // workaround.
  const supabase = getSupabase();
  // Step 4a: window check (read-side; cheap; weeds out the obvious case)
  if (originalLastIntentAt) {
    const elapsed = Date.now() - new Date(originalLastIntentAt).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < RATE_LIMIT_WINDOW_MS) {
      const retryAfterSec = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1000);
      return NextResponse.json<IntentResponseBody>(
        {
          status: "rate_limited",
          message:
            "you can update your intent once every 5 minutes. give it a moment and try again.",
          retryAfterSec,
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }
  }
  // Step 4b: CAS claim against the observed prior value
  const claimedAt = new Date().toISOString();
  let claimQuery = supabase
    .from("instaclaw_users")
    .update({ index_last_intent_at: claimedAt })
    .eq("id", session.user.id);
  claimQuery =
    originalLastIntentAt === null
      ? claimQuery.is("index_last_intent_at", null)
      : claimQuery.eq("index_last_intent_at", originalLastIntentAt);
  const { data: claim, error: claimErr } = await claimQuery.select("id");
  if (claimErr) {
    logger.error("[express-intent] claim UPDATE failed", {
      userIdPrefix: session.user.id.slice(0, 8),
      error: claimErr.message,
    });
    return NextResponse.json(
      { status: "error", message: "something went wrong. try again." },
      { status: 500 },
    );
  }
  if (!claim || claim.length === 0) {
    // CAS failed — another request claimed first. The column's
    // current value differs from originalLastIntentAt. Concurrent
    // requests both read the same prior value, both attempt CAS,
    // only one wins; the loser gets here.
    return NextResponse.json<IntentResponseBody>(
      {
        status: "rate_limited",
        message:
          "you can update your intent once every 5 minutes. give it a moment and try again.",
        retryAfterSec: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      },
      { status: 429, headers: { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) } },
    );
  }

  // 4.5. JIT-provision Index Network credentials if missing.
  //
  // Closes the post-onboarding race against the reconciler. A fresh
  // Edge attendee completing /deploying + landing on /edge/intents in
  // <90 s reliably arrives BEFORE the reconciler's stepIndexProvision
  // (every ~3 min) fires to mint their index_api_key. Pre-fix, they
  // saw "your edge city setup isn't fully online yet" and had to wait
  // + retry manually — terrible UX after 7 screens of onboarding.
  //
  // ensureIndexCredentials is idempotent: it's a no-op DB lookup when
  // the key is already populated (typical for repeat submissions or
  // when the reconciler beat us), and a one-shot Index /signup +
  // DB write (~2-5 s) when missing. On failure, we still fall through
  // to createIndexIntent which surfaces the existing "coming online
  // soon" fallback — so the only behavior change is eliminating the
  // false-positive "setup not online" copy for the race-condition
  // case. True Index outages still get the right message.
  //
  // We do this AFTER the rate-limit claim (step 4) so a JIT-provision
  // attempt also consumes the user's intent budget — prevents an
  // attacker from racing /signup with multiple intent submissions.
  const jitResult = await ensureIndexCredentials(session.user.id);
  if (!jitResult.ok) {
    // Log the JIT failure reason but don't return yet — let
    // createIndexIntent run + give its own friendly fallback. The user
    // sees one coherent error rather than two different ones depending
    // on which layer failed.
    logger.warn("[express-intent] JIT provision failed; falling through", {
      userIdPrefix: session.user.id.slice(0, 8),
      reason: jitResult.reason,
      detail: jitResult.detail,
    });
  } else if (jitResult.minted) {
    logger.info("[express-intent] JIT provisioned Index creds inline", {
      userIdPrefix: session.user.id.slice(0, 8),
      indexUserIdPrefix: jitResult.indexUserId?.slice(0, 8),
    });
  }

  // 5. We own the claim. Call createIndexIntent — does MCP create_intent
  //    via the canonical IndexMcpClient with the burst-retry wrapper.
  //    Re-reads the (now-populated) credentials from DB.
  const result = await createIndexIntent({
    userId: session.user.id,
    description,
  });

  // 6. SUCCESS → claim stays in place (already set by step 4). No
  //    further UPDATE needed.
  // 6a. VALIDATION FAILURE → CAS revert so user can retry without
  //    burning their 5-min rate-limit budget. ONLY applies to the
  //    validation case (user typed something the lib's
  //    defensive guard rejected — should be rare since we validate
  //    description length upstream at line 213-231).
  // 6b. INDEX NETWORK FAILURE → optimistic-accept (Cooper directive
  //    2026-05-23). Yanek's MCP `create_intent` tool is broken on his
  //    side ("Forbidden" / write-tool bug); his /signup is fixed but
  //    intent creation isn't. Instead of surfacing the error to the
  //    user (who just walked through 7 onboarding screens), we:
  //      - Keep the rate-limit claim in place (the gate IS satisfied)
  //      - Log the intent text for back-fill via index-intent-queue
  //      - Return 200 with status="created" so the UI shows success
  //    A back-fill replay script runs once Yanek's create_intent is
  //    restored — grep "[index-intent-queued]" in Vercel logs +
  //    replay each through createIndexIntent.
  const isValidationFailure =
    result.status === "skipped" && result.reason === "missing_description";

  if (isValidationFailure) {
    // Revert the claim — user should retry without rate-limit cost.
    const { error: revertErr } = await supabase
      .from("instaclaw_users")
      .update({ index_last_intent_at: originalLastIntentAt })
      .eq("id", session.user.id)
      .eq("index_last_intent_at", claimedAt);
    if (revertErr) {
      logger.error(
        "[express-intent] claim revert failed; user rate-limited until window expires",
        {
          userIdPrefix: session.user.id.slice(0, 8),
          claimedAt,
          resultStatus: result.status,
          revertError: revertErr.message,
        },
      );
    }
    const mapped = mapCreateIntentResultToResponse(result);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  // ── Optimistic-accept branch ──
  // Any non-success, non-validation result lands here. Queue + return
  // success.
  if (result.status === "error" || result.status === "skipped") {
    const reasonForQueue =
      result.status === "error"
        ? "mcp_create_intent_error"
        : "mcp_create_intent_skipped";
    const detail =
      result.status === "error"
        ? result.detail?.slice(0, 200)
        : `skipped reason: ${result.reason}`;

    logger.warn(
      "[express-intent] createIndexIntent failed — optimistic-accept fallback",
      {
        userIdPrefix: session.user.id.slice(0, 8),
        resultStatus: result.status,
        reason: result.status === "error" ? result.reason : result.reason,
        detail,
      },
    );

    // Queue the intent text + ensure the gate write is in place.
    // The rate-limit claim from step 4 already set index_last_intent_at;
    // queueIntentForBackfill re-asserts it (no-op DB-wise, but ensures
    // the helper is the single source of truth for the gate write).
    await queueIntentForBackfill({
      userId: session.user.id,
      description,
      reason: reasonForQueue,
      detail,
      supabase,
    });

    return NextResponse.json<IntentResponseBody>(
      {
        status: "created",
        message: "your intent is registered. it's live in the directory.",
      },
      { status: 200 },
    );
  }

  // True success path (createIndexIntent returned "created").
  const mapped = mapCreateIntentResultToResponse(result);
  return NextResponse.json(mapped.body, { status: mapped.status });
}
