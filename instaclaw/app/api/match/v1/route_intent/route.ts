/**
 * POST /api/match/v1/route_intent
 *
 * Layer 1 retrieval endpoint. The user's VM calls this with its
 * gateway_token; the server runs `computeTopKMutual` (matchpool_compute_topk_mutual
 * RPC) and returns the top-K candidate profiles.
 *
 * The VM then runs Layer 2 (consensus_match_rerank.py) and Layer 3
 * (consensus_match_deliberate.py) locally with full SOUL.md + MEMORY.md
 * context, and POSTs the deliberation results back to /api/match/v1/results.
 *
 * This shape (server runs Layer 1, VM runs Layer 2+3) matches the PRD §2.5
 * architectural commitment: the user's memory anchor never leaves the VM.
 *
 * Request body (optional fields):
 *   {
 *     "k": 50,                           // top-K (default 50, max 100)
 *     "pool_size": 200,                  // HNSW retrieval pool (default 200)
 *     "min_mutual_score": 0,             // threshold (default 0)
 *     "exclude_user_ids": []             // additional excludes
 *   }
 *
 * Response:
 *   {
 *     "ok": true,
 *     "user_id": "...",
 *     "profile_version": <int>,           // caller's current pv (for cache keying)
 *     "consent_tier": "...",              // caller's tier
 *     "candidates": [<MatchCandidate>...] // up to k results, mutual_score desc
 *   }
 *
 * Returns:
 *   200 with empty candidates → caller has no profile, no embeddings,
 *        or no candidates passed filters
 *   401 → invalid/missing gateway_token
 *   409 → VM has no assigned user
 *   503 → DB error (caller should retry)
 *
 * Auth: same as POST /api/match/v1/profile — Authorization: Bearer <token>
 *       OR X-Gateway-Token: <token>.
 *
 * PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §5
 *      ("USER ASKS AGENT 'find me my people'" flow + cascade flow)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { computeTopKMutual } from "@/lib/match-scoring";
import { getSkillState, CONSENSUS_2026_SKILL_SLUG } from "@/lib/match-skill-status";

export const dynamic = "force-dynamic";
// Layer 1 is fast (~80ms PG query) but we set max so unexpected HNSW
// rebuilds or cold starts don't get clipped.
export const maxDuration = 60;

const MAX_K = 100;
const DEFAULT_K = 50;
const MAX_POOL = 500;
const DEFAULT_POOL = 200;
const MAX_EXCLUDE = 200;

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

interface RouteIntentBody {
  k?: number;
  pool_size?: number;
  min_mutual_score?: number;
  exclude_user_ids?: string[];
}

function validateBody(raw: unknown): RouteIntentBody | { error: string } {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object (or empty)" };
  }
  const b = raw as Record<string, unknown>;
  const out: RouteIntentBody = {};

  if ("k" in b) {
    if (typeof b.k !== "number" || b.k < 1 || b.k > MAX_K) {
      return { error: `k must be 1..${MAX_K}` };
    }
    out.k = Math.floor(b.k);
  }

  if ("pool_size" in b) {
    if (typeof b.pool_size !== "number" || b.pool_size < 1 || b.pool_size > MAX_POOL) {
      return { error: `pool_size must be 1..${MAX_POOL}` };
    }
    out.pool_size = Math.floor(b.pool_size);
  }

  if ("min_mutual_score" in b) {
    if (typeof b.min_mutual_score !== "number" || b.min_mutual_score < 0 || b.min_mutual_score > 1) {
      return { error: "min_mutual_score must be 0..1" };
    }
    out.min_mutual_score = b.min_mutual_score;
  }

  if ("exclude_user_ids" in b) {
    if (!Array.isArray(b.exclude_user_ids)) {
      return { error: "exclude_user_ids must be an array" };
    }
    if (b.exclude_user_ids.length > MAX_EXCLUDE) {
      return { error: `exclude_user_ids exceeds ${MAX_EXCLUDE}` };
    }
    for (const id of b.exclude_user_ids) {
      if (!isUUID(id)) return { error: "exclude_user_ids contains non-UUID" };
    }
    out.exclude_user_ids = b.exclude_user_ids as string[];
  }

  return out;
}

export async function POST(req: NextRequest) {
  // ─ Auth ─
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json(
      { error: "Missing authentication. Provide Authorization: Bearer or x-gateway-token." },
      { status: 401 }
    );
  }

  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const userId = vm.assigned_to as string;
  const vmId = vm.id as string;

  // ─ Skill gate ─
  // Live-events skills (consensus-2026) default OFF. Pipeline calls this
  // endpoint at the start of every cycle; if the skill is disabled we
  // return a normal 200 with empty candidates and a reason flag so the
  // pipeline can log the skip and exit silently. We deliberately do NOT
  // 403 here — pipeline.py's existing "no_candidates" path handles 200
  // + empty list cleanly without a backoff cascade.
  const supabaseForSkill = getSupabase();
  const skillState = await getSkillState(supabaseForSkill, vmId, CONSENSUS_2026_SKILL_SLUG);
  if (!skillState.enabled) {
    return NextResponse.json({
      ok: true,
      user_id: userId,
      profile_version: null,
      consent_tier: null,
      candidates: [],
      reason: "skill_disabled",
      skill_slug: CONSENSUS_2026_SKILL_SLUG,
    });
  }

  // ─ Body validation (body optional — defaults are fine) ─
  let parsedBody: unknown = null;
  try {
    parsedBody = await req.json();
  } catch {
    parsedBody = null; // empty body is OK
  }
  const validated = validateBody(parsedBody);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const k = validated.k ?? DEFAULT_K;
  const poolSize = validated.pool_size ?? DEFAULT_POOL;
  const minMutual = validated.min_mutual_score ?? 0;
  const excludes = validated.exclude_user_ids ?? [];

  // ─ Fetch caller's profile metadata (for cache-key support downstream) ─
  const supabase = getSupabase();
  const { data: callerProfile } = await supabase
    .from("matchpool_profiles")
    .select("profile_version, consent_tier")
    .eq("user_id", userId)
    .maybeSingle();

  // No profile → empty result. Caller should run intent extraction first.
  if (!callerProfile) {
    return NextResponse.json({
      ok: true,
      user_id: userId,
      profile_version: null,
      consent_tier: null,
      candidates: [],
      reason: "caller has no matchpool_profile yet",
    });
  }

  // ─ Layer 1 retrieval ─
  let candidates;
  try {
    candidates = await computeTopKMutual(userId, k, {
      candidatePoolSize: poolSize,
      minMutualScore: minMutual,
      excludeUserIds: excludes,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/match/v1/route_intent] Layer 1 failed:", msg);
    // RPC-not-registered → 503 so the caller knows to retry once the
    // operator has applied the migration. All other errors → 503 too,
    // since they're transient from the caller's POV (they should retry
    // a few minutes later, by which time we've fixed the DB).
    return NextResponse.json(
      { error: "match query failed", detail: msg },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    user_id: userId,
    profile_version: callerProfile.profile_version as number,
    consent_tier: callerProfile.consent_tier as string,
    candidates,
  });
}
