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

  // 2. Partner gate + read the rate-limit anchor
  const gate = await getEdgeCityUserOrError(session.user.id);
  if (!gate.ok) return gate.error;

  // 3. Rate-limit check — 1 per user per 5 min, only on prior SUCCESS
  if (gate.lastIntentAt) {
    const elapsed = Date.now() - new Date(gate.lastIntentAt).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < RATE_LIMIT_WINDOW_MS) {
      const retryAfterSec = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1000);
      return NextResponse.json<IntentResponseBody>(
        {
          status: "rate_limited",
          message:
            "you can update your intent once every 5 minutes. give it a moment and try again.",
          retryAfterSec,
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSec) },
        },
      );
    }
  }

  // 4. Body parsing + validation
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

  // 5. Call createIndexIntent — does MCP create_intent via the
  //    canonical IndexMcpClient with the burst-retry wrapper.
  const result = await createIndexIntent({
    userId: session.user.id,
    description,
  });

  // 6. On SUCCESS, advance the rate-limit anchor. Failures don't
  //    update the column so users can immediately retry.
  if (result.status === "created") {
    const supabase = getSupabase();
    const { error: updateErr } = await supabase
      .from("instaclaw_users")
      .update({ index_last_intent_at: new Date().toISOString() })
      .eq("id", session.user.id);
    if (updateErr) {
      // The intent was registered upstream; only the rate-limit
      // anchor failed to advance. User would be able to submit again
      // immediately — minor abuse vector, not a correctness issue.
      // Log for operator visibility but don't block the success.
      logger.warn("[express-intent] failed to advance rate-limit anchor", {
        userIdPrefix: session.user.id.slice(0, 8),
        intentIdPrefix: result.intentId.slice(0, 8),
        error: updateErr.message,
      });
    }
  } else if (result.status === "error") {
    // Log for operator forensics — the user sees the friendly
    // "coming online soon" message via mapCreateIntentResultToResponse.
    logger.warn("[express-intent] createIndexIntent error", {
      userIdPrefix: session.user.id.slice(0, 8),
      reason: result.reason,
      detail: result.detail?.slice(0, 200),
    });
  }

  const mapped = mapCreateIntentResultToResponse(result);
  return NextResponse.json(mapped.body, { status: mapped.status });
}
