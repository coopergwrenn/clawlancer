/**
 * POST /api/match/v1/profile
 *
 * VM-side bridge endpoint for the matching engine.
 *
 * Component 4 (consensus_intent_sync.py) calls this from each user's VM with
 * their structured intent profile. We:
 *
 *   1. Authenticate the request via gateway_token
 *   2. Embed offering_summary + seeking_summary via Component 2 (lib/match-embeddings)
 *   3. Upsert into matchpool_profiles
 *   4. Increment profile_version when offering/seeking text actually changed
 *      (avoids spurious deliberation-cache invalidation)
 *   5. Return profile_version + consent_tier so the VM can update local state
 *
 * Auth: Authorization: Bearer <gateway_token> OR x-gateway-token: <token>
 * (We accept both for compatibility with Component 4's Bearer header AND the
 * existing internal endpoint pattern.)
 *
 * The endpoint NEVER changes consent_tier — that's owned by Component 10
 * (privacy opt-in flow). New profiles default to consent_tier='hidden' per
 * the migration's column default; matching pipeline only surfaces non-hidden
 * profiles.
 *
 * PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §2.1, §4
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { embedDual, vectorToPgString } from "@/lib/match-embeddings";

export const dynamic = "force-dynamic";
// CLAUDE.md Rule 11: every route that calls an external LLM/API must set
// maxDuration explicitly. embedDual hits OpenAI/Voyage; tail latency under
// burst can exceed Vercel's default 60s. 300s is the safe ceiling for Pro.
export const maxDuration = 300;

// ─── Validation helpers ─────────────────────────────────────────────

const MAX_SUMMARY_CHARS = 800;
const MAX_TAGS = 10;
const VALID_FORMATS = new Set(["1on1", "small_group", "session"]);

interface ProfileRequestBody {
  offering_summary: string;
  seeking_summary: string;
  interests: string[];
  looking_for: string[];
  format_preferences: string[];
  confidence: number;
  metadata?: {
    extracted_at?: string;
    extractor_version?: string;
    memory_chars?: number;
    is_cold_start?: boolean;
  };
}

function validateBody(raw: unknown): ProfileRequestBody | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const b = raw as Record<string, unknown>;

  // offering_summary + seeking_summary
  for (const k of ["offering_summary", "seeking_summary"] as const) {
    if (typeof b[k] !== "string" || !(b[k] as string).trim()) {
      return { error: `${k} must be a non-empty string` };
    }
    if ((b[k] as string).length > MAX_SUMMARY_CHARS) {
      return { error: `${k} exceeds ${MAX_SUMMARY_CHARS} chars` };
    }
  }

  // interests, looking_for, format_preferences — arrays of strings
  for (const k of ["interests", "looking_for", "format_preferences"] as const) {
    if (!Array.isArray(b[k])) return { error: `${k} must be an array` };
    if ((b[k] as unknown[]).length > MAX_TAGS) {
      return { error: `${k} exceeds ${MAX_TAGS} entries` };
    }
    for (const item of b[k] as unknown[]) {
      if (typeof item !== "string") {
        return { error: `${k} contains non-string item` };
      }
    }
  }

  // format_preferences whitelist (defensive — VM also filters)
  for (const f of b.format_preferences as string[]) {
    if (!VALID_FORMATS.has(f)) {
      return { error: `format_preferences contains invalid value '${f}'` };
    }
  }

  // confidence
  if (typeof b.confidence !== "number" || !isFinite(b.confidence) ||
      b.confidence < 0 || b.confidence > 1) {
    return { error: "confidence must be a number in [0, 1]" };
  }

  return {
    offering_summary: (b.offering_summary as string).trim(),
    seeking_summary: (b.seeking_summary as string).trim(),
    interests: b.interests as string[],
    looking_for: b.looking_for as string[],
    format_preferences: b.format_preferences as string[],
    confidence: b.confidence,
    metadata: typeof b.metadata === "object" && b.metadata !== null
      ? (b.metadata as ProfileRequestBody["metadata"])
      : undefined,
  };
}

// ─── Auth ───────────────────────────────────────────────────────────

function extractGatewayToken(req: NextRequest): string | null {
  // Authorization: Bearer <token> (component 4's convention)
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  // x-gateway-token (existing internal endpoint convention)
  const xGate = req.headers.get("x-gateway-token");
  if (xGate?.trim()) return xGate.trim();
  return null;
}

// ─── agent_id derivation ────────────────────────────────────────────
// PRD: hash of (user_id || research_salt). For v1 use deterministic
// SHA-256 of user_id (salt application is a future hardening; the
// matchpool_profiles.agent_id column is research-only, not identity).
function deriveAgentId(userId: string): string {
  return createHash("sha256").update(`matchpool:${userId}`).digest("hex");
}

// ─── Handler ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ─ 1. Auth ─
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json(
      { error: "Missing authentication. Provide Authorization: Bearer or x-gateway-token." },
      { status: 401 }
    );
  }

  const vm = await lookupVMByGatewayToken(
    gatewayToken,
    "id, assigned_to, partner"
  );
  if (!vm) {
    return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  }
  if (!vm.assigned_to) {
    return NextResponse.json(
      { error: "VM has no assigned user; cannot create profile" },
      { status: 409 }
    );
  }

  const userId = vm.assigned_to as string;
  const partner = (vm.partner as string | null) ?? null;

  // ─ 2. Body validation ─
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

  // ─ 3. Read current profile (for profile_version increment logic) ─
  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from("matchpool_profiles")
    .select("offering_summary, seeking_summary, profile_version, consent_tier, agent_id")
    .eq("user_id", userId)
    .maybeSingle();

  // Decide whether profile_version should bump.
  // Bump when text content materially changed; metadata-only changes don't bump.
  // Per the deliberation cache key (user × candidate × user_pv × candidate_pv),
  // a bump invalidates all cached deliberations involving this user.
  const offeringChanged = !existing ||
    existing.offering_summary !== body.offering_summary;
  const seekingChanged = !existing ||
    existing.seeking_summary !== body.seeking_summary;
  const textChanged = offeringChanged || seekingChanged;

  // ─ 4. Embed (only if text changed; skip embedding for unchanged content) ─
  let offeringEmbeddingPg: string | null = null;
  let seekingEmbeddingPg: string | null = null;
  let embeddingModel: string | undefined;
  if (textChanged) {
    try {
      const embedded = await embedDual({
        offering: body.offering_summary,
        seeking: body.seeking_summary,
      });
      offeringEmbeddingPg = vectorToPgString(embedded.offering_embedding);
      seekingEmbeddingPg = vectorToPgString(embedded.seeking_embedding);
      embeddingModel = embedded.model;
    } catch (e) {
      console.error("[/api/match/v1/profile] embedding failed:", e);
      return NextResponse.json(
        { error: "embedding failed; please retry" },
        { status: 503 }
      );
    }
  }

  // ─ 5. Upsert ─
  const newVersion = existing
    ? (textChanged ? (existing.profile_version as number) + 1 : (existing.profile_version as number))
    : 1;

  const agentId = (existing?.agent_id as string | undefined) ?? deriveAgentId(userId);

  // We assemble the upsert payload based on whether text changed.
  // For text-unchanged updates: refresh structured fields + metadata only,
  // don't re-embed, don't bump version.
  // The matchpool_profiles trigger only fires on embedding/consent changes,
  // so a no-text-change update won't pg_notify (which is what we want — no
  // wasteful cascade work for metadata-only refreshes).
  const upsertPayload: Record<string, unknown> = {
    user_id: userId,
    agent_id: agentId,
    offering_summary: body.offering_summary,
    seeking_summary: body.seeking_summary,
    interests: body.interests,
    looking_for: body.looking_for,
    format_preferences: body.format_preferences,
    profile_version: newVersion,
    intent_extracted_at: new Date().toISOString(),
    intent_extraction_confidence: body.confidence,
    last_active_at: new Date().toISOString(),
    partner,
  };

  if (textChanged) {
    upsertPayload.offering_embedding = offeringEmbeddingPg;
    upsertPayload.seeking_embedding = seekingEmbeddingPg;
    upsertPayload.embedding_model = embeddingModel;
  }

  const { data: upserted, error: upsertErr } = await supabase
    .from("matchpool_profiles")
    .upsert(upsertPayload, { onConflict: "user_id" })
    .select("profile_version, consent_tier, agent_id, embedding_model")
    .single();

  if (upsertErr || !upserted) {
    console.error("[/api/match/v1/profile] upsert failed:", upsertErr);
    return NextResponse.json(
      { error: "failed to write profile", detail: upsertErr?.message },
      { status: 500 }
    );
  }

  // ─ 6. Response ─
  return NextResponse.json({
    ok: true,
    user_id: userId,
    profile_version: upserted.profile_version as number,
    consent_tier: upserted.consent_tier as string,
    agent_id: upserted.agent_id as string,
    embedding_model: (upserted.embedding_model as string) ?? null,
    text_changed: textChanged,
    is_new_profile: !existing,
  });
}
