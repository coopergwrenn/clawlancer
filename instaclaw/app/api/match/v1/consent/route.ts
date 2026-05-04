/**
 * POST /api/match/v1/consent
 *
 * Privacy opt-in endpoint. The user's agent collects a consent tier via a
 * one-question Telegram exchange and POSTs the answer here.
 *
 * Tiers (matches matchpool_profiles.consent_tier check constraint):
 *   'hidden'              — default; user is invisible to other matches
 *   'name_only'           — only display name surfaces (UI joins instaclaw_users)
 *   'interests'           — interests + looking_for visible, no summaries
 *   'interests_plus_name' — interests + looking_for + name + summaries visible
 *   'full_profile'        — all profile fields visible
 *
 * Only the user's own VM (verified by gateway_token) can change their tier.
 * The endpoint is idempotent — repeating the same tier does nothing.
 *
 * Side effects:
 *   - Sets matchpool_profiles.consent_tier
 *   - Bumps profile_version ONLY when tier transitions hidden→non-hidden
 *     (or any non-hidden→non-hidden), so the deliberation cache (keyed on
 *     user_pv × candidate_pv) gets invalidated and other users see fresh
 *     deliberations referencing the now-visible content.
 *   - Triggers matchpool_profiles_change_notify (only on consent_tier
 *     transition, per the trigger's WHEN clause).
 *
 * GET (with gateway token) returns the user's current tier — the agent can
 * use this to decide whether it still needs to ask.
 *
 * Auth: Authorization: Bearer <gateway_token> OR x-gateway-token.
 *
 * PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §9
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const VALID_TIERS = new Set([
  "hidden",
  "name_only",
  "interests",
  "interests_plus_name",
  "full_profile",
]);

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

async function authedUserIdFromToken(req: NextRequest): Promise<{ userId: string } | NextResponse> {
  const token = extractGatewayToken(req);
  if (!token) return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  const vm = await lookupVMByGatewayToken(token, "id, assigned_to");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  return { userId: vm.assigned_to as string };
}

export async function GET(req: NextRequest) {
  const authed = await authedUserIdFromToken(req);
  if (authed instanceof NextResponse) return authed;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("matchpool_profiles")
    .select("consent_tier, profile_version")
    .eq("user_id", authed.userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "lookup failed", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    user_id: authed.userId,
    consent_tier: (data?.consent_tier as string) ?? null,
    profile_version: (data?.profile_version as number) ?? null,
    has_profile: !!data,
  });
}

export async function POST(req: NextRequest) {
  const authed = await authedUserIdFromToken(req);
  if (authed instanceof NextResponse) return authed;

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }

  if (!bodyJson || typeof bodyJson !== "object" || Array.isArray(bodyJson)) {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const b = bodyJson as Record<string, unknown>;

  const tier = b.consent_tier;
  if (typeof tier !== "string" || !VALID_TIERS.has(tier)) {
    return NextResponse.json(
      {
        error: "consent_tier must be one of: " + Array.from(VALID_TIERS).join(", "),
      },
      { status: 400 }
    );
  }

  const supabase = getSupabase();

  // Read current row to decide whether to bump profile_version
  const { data: existing } = await supabase
    .from("matchpool_profiles")
    .select("consent_tier, profile_version")
    .eq("user_id", authed.userId)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json(
      {
        error:
          "no profile row to update consent on; the agent must extract intent first " +
          "(POST /api/match/v1/profile)",
      },
      { status: 409 }
    );
  }

  const currentTier = existing.consent_tier as string;
  const currentPv = existing.profile_version as number;

  if (currentTier === tier) {
    return NextResponse.json({
      ok: true,
      user_id: authed.userId,
      consent_tier: currentTier,
      profile_version: currentPv,
      changed: false,
    });
  }

  // Bump pv when transitioning into a non-hidden tier OR between non-hidden
  // tiers (since the visible projection changes — caches must invalidate).
  // Bump on hidden→hidden NEVER applies (we returned above on no-change).
  // Bump on non-hidden→hidden is also useful — Layer 1 will stop returning
  // this user, and existing cached deliberations referencing them should be
  // recomputed when other people refresh.
  const newPv = currentPv + 1;

  const { data: updated, error: updErr } = await supabase
    .from("matchpool_profiles")
    .update({
      consent_tier: tier,
      profile_version: newPv,
    })
    .eq("user_id", authed.userId)
    .select("consent_tier, profile_version")
    .single();

  if (updErr || !updated) {
    return NextResponse.json(
      { error: "consent update failed", detail: updErr?.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    user_id: authed.userId,
    consent_tier: updated.consent_tier as string,
    profile_version: updated.profile_version as number,
    changed: true,
    previous_tier: currentTier,
  });
}
