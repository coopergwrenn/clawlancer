/**
 * POST /api/match/v1/results
 *
 * VM-side ingestion endpoint for Layer 3 deliberation output. The VM's
 * consensus_match_pipeline.py calls /route_intent → runs Layer 2 + 3 →
 * POSTs the per-candidate deliberation results here.
 *
 * Side effects:
 *   1. Upsert matchpool_deliberations (one row per candidate). Conflict
 *      key: (user_id, candidate_user_id, user_profile_version,
 *      candidate_profile_version) — re-running the pipeline with the
 *      same profile versions just refreshes the rationale, doesn't
 *      duplicate rows.
 *   2. Refresh matchpool_cached_top3 with the top 3 by match_score.
 *      This is what the /consensus/matches page reads from.
 *
 * The endpoint is dumb on purpose — the deliberation ranking is the
 * VM's responsibility (its agent did the thinking). Server just stores
 * what it's told. RLS on matchpool_deliberations + the gateway_token
 * check prevents one VM from writing for a different user.
 *
 * Request body:
 *   {
 *     "user_profile_version": <int>,        // caller's profile_version at compute time
 *     "deliberations": [
 *       {
 *         "candidate_user_id": "<uuid>",
 *         "candidate_profile_version": <int>,
 *         "match_score": 0.0-1.0,
 *         "rationale": "<string>",
 *         "conversation_topic": "<string>" | null,
 *         "meeting_window": "<string>" | null,
 *         "skip_reason": "<string>" | null
 *       },
 *       ...
 *     ],
 *     "match_kind": "intent" | "serendipity"  // optional, default "intent"
 *   }
 *
 * Auth: Authorization: Bearer <gateway_token> OR x-gateway-token.
 *
 * PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §5
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_DELIBERATIONS = 60;
const MAX_RATIONALE_CHARS = 1000;
const MAX_TOPIC_CHARS = 400;
const MAX_WINDOW_CHARS = 200;
const MAX_SKIP_REASON_CHARS = 400;

function extractGatewayToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const xGate = req.headers.get("x-gateway-token");
  if (xGate?.trim()) return xGate.trim();
  return null;
}

function isUUID(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

interface DeliberationEntry {
  candidate_user_id: string;
  candidate_profile_version: number;
  match_score: number;
  rationale: string;
  conversation_topic: string | null;
  meeting_window: string | null;
  skip_reason: string | null;
}

interface ResultsBody {
  user_profile_version: number;
  deliberations: DeliberationEntry[];
  match_kind: "intent" | "serendipity";
}

function validateBody(raw: unknown): ResultsBody | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.user_profile_version !== "number" || !Number.isInteger(b.user_profile_version) || b.user_profile_version < 1) {
    return { error: "user_profile_version must be a positive integer" };
  }

  if (!Array.isArray(b.deliberations)) {
    return { error: "deliberations must be an array" };
  }
  if (b.deliberations.length > MAX_DELIBERATIONS) {
    return { error: `deliberations exceeds ${MAX_DELIBERATIONS}` };
  }

  const cleaned: DeliberationEntry[] = [];
  for (const raw of b.deliberations as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: "deliberation entries must be objects" };
    }
    const d = raw as Record<string, unknown>;
    if (!isUUID(d.candidate_user_id)) return { error: "candidate_user_id missing or not a UUID" };
    if (typeof d.candidate_profile_version !== "number" || !Number.isInteger(d.candidate_profile_version) || d.candidate_profile_version < 1) {
      return { error: "candidate_profile_version must be a positive integer" };
    }
    if (typeof d.match_score !== "number" || !isFinite(d.match_score) || d.match_score < 0 || d.match_score > 1) {
      return { error: "match_score must be a number in [0,1]" };
    }
    if (typeof d.rationale !== "string" || !d.rationale.trim()) {
      return { error: "rationale must be a non-empty string" };
    }
    cleaned.push({
      candidate_user_id: d.candidate_user_id,
      candidate_profile_version: d.candidate_profile_version,
      match_score: d.match_score,
      rationale: d.rationale.slice(0, MAX_RATIONALE_CHARS),
      conversation_topic: typeof d.conversation_topic === "string"
        ? d.conversation_topic.slice(0, MAX_TOPIC_CHARS) || null
        : null,
      meeting_window: typeof d.meeting_window === "string"
        ? d.meeting_window.slice(0, MAX_WINDOW_CHARS) || null
        : null,
      skip_reason: typeof d.skip_reason === "string"
        ? d.skip_reason.slice(0, MAX_SKIP_REASON_CHARS) || null
        : null,
    });
  }

  let match_kind: "intent" | "serendipity" = "intent";
  if ("match_kind" in b) {
    if (b.match_kind !== "intent" && b.match_kind !== "serendipity") {
      return { error: "match_kind must be 'intent' or 'serendipity'" };
    }
    match_kind = b.match_kind;
  }

  return { user_profile_version: b.user_profile_version, deliberations: cleaned, match_kind };
}

export async function POST(req: NextRequest) {
  // ─ Auth ─
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }

  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const userId = vm.assigned_to as string;

  // ─ Body validation ─
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  const validated = validateBody(bodyJson);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const body = validated;

  if (body.deliberations.length === 0) {
    // Vacuous case — clear cached_top3 and return ok
    const supabase = getSupabase();
    await supabase.from("matchpool_cached_top3").upsert({
      user_id: userId,
      top3_user_ids: [],
      top3_scores: [],
      computed_at: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true, written: 0, top3: [] });
  }

  const supabase = getSupabase();

  // ─ Upsert deliberations ─
  const now = new Date().toISOString();
  const rows = body.deliberations.map((d) => ({
    user_id: userId,
    candidate_user_id: d.candidate_user_id,
    user_profile_version: body.user_profile_version,
    candidate_profile_version: d.candidate_profile_version,
    match_score: d.match_score,
    rationale: d.rationale,
    conversation_topic: d.conversation_topic,
    meeting_window: d.meeting_window,
    skip_reason: d.skip_reason,
    match_kind: body.match_kind,
    deliberated_at: now,
  }));

  const { error: insertErr } = await supabase
    .from("matchpool_deliberations")
    .upsert(rows, {
      onConflict: "user_id,candidate_user_id,user_profile_version,candidate_profile_version",
    });

  if (insertErr) {
    console.error("[/api/match/v1/results] deliberation upsert failed:", insertErr);
    return NextResponse.json(
      { error: "failed to write deliberations", detail: insertErr.message },
      { status: 500 }
    );
  }

  // ─ Refresh cached_top3 ─
  // Take top 3 by match_score from this submission. Skip any with skip_reason
  // set (those are the agent's "do not surface" signals — caller side already
  // suppressed them via low score, but we double-check here).
  const surfaceable = body.deliberations
    .filter((d) => d.skip_reason === null || d.match_score >= 0.5)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 3);

  const top3UserIds = surfaceable.map((d) => d.candidate_user_id);
  const top3Scores = surfaceable.map((d) => d.match_score);

  const { error: cacheErr } = await supabase
    .from("matchpool_cached_top3")
    .upsert({
      user_id: userId,
      top3_user_ids: top3UserIds,
      top3_scores: top3Scores,
      computed_at: now,
    });

  if (cacheErr) {
    // Log but don't fail — the deliberations are already saved; cached_top3
    // can be backfilled by a periodic worker.
    console.error("[/api/match/v1/results] cached_top3 upsert failed:", cacheErr);
  }

  return NextResponse.json({
    ok: true,
    written: rows.length,
    top3: top3UserIds,
  });
}
