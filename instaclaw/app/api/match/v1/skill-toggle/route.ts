/**
 * POST /api/match/v1/skill-toggle
 *
 * VM-side / agent-callable skill toggle. Mirrors /api/skills/toggle's data
 * write but uses gateway_token auth (instead of session/mini-app-token) so
 * the agent on the VM can flip the skill state programmatically — used by
 * the consensus-2026 skill's §Organic Activation flow when a user mentions
 * strong Consensus intent in chat and consents to enabling.
 *
 * Security: restricted to skills in the 'live-events' category. A VM's
 * gateway token should NOT be able to enable arbitrary skills (e.g.,
 * commerce, developer) on its own VM — those have their own UI install
 * flows with auth/payment/etc. Live-events skills are gated by user
 * consent (the agent asked, the user said yes), so toggling them on
 * from the VM side is a legitimate flow.
 *
 * Same data write as /api/skills/toggle's live-events branch — keeps a
 * single source of truth for the per-VM skill state.
 *
 * PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md (org. activation)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ALLOWED_CATEGORIES = new Set(["live-events"]);

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

export async function POST(req: NextRequest) {
  // ─ Auth ─
  const token = extractGatewayToken(req);
  if (!token) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }
  const vm = await lookupVMByGatewayToken(token, "id, assigned_to");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const vmId = vm.id as string;

  // ─ Body validation ─
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (typeof b.slug !== "string" || !b.slug.trim()) {
    return NextResponse.json({ error: "slug must be a non-empty string" }, { status: 400 });
  }
  if (typeof b.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  const slug = b.slug.trim();
  const enabled = b.enabled;

  // ─ Skill lookup + category gate ─
  const supabase = getSupabase();
  const { data: skill } = await supabase
    .from("instaclaw_skills")
    .select("id, slug, category, status")
    .eq("slug", slug)
    .maybeSingle();

  if (!skill) {
    return NextResponse.json({ error: `Skill not found: ${slug}` }, { status: 404 });
  }
  if (!ALLOWED_CATEGORIES.has(skill.category as string)) {
    // Don't leak whether the skill exists — same 404 shape regardless. The
    // agent shouldn't be probing other categories anyway.
    logger.warn("skill-toggle: rejected non-live-events slug from VM", {
      vmId,
      slug,
      category: skill.category,
      route: "api/match/v1/skill-toggle",
    });
    return NextResponse.json(
      { error: `Skill not toggleable from agent: ${slug}` },
      { status: 403 },
    );
  }
  if (skill.status !== "active") {
    return NextResponse.json({ error: `Skill is not active: ${slug}` }, { status: 400 });
  }
  const skillId = skill.id as string;

  // ─ Read previous state for the response ─
  const { data: prev } = await supabase
    .from("instaclaw_vm_skills")
    .select("enabled")
    .eq("vm_id", vmId)
    .eq("skill_id", skillId)
    .maybeSingle();
  const previousEnabled = prev?.enabled === true;

  // ─ Upsert ─
  const { error: upErr } = await supabase
    .from("instaclaw_vm_skills")
    .upsert(
      { vm_id: vmId, skill_id: skillId, enabled },
      { onConflict: "vm_id,skill_id" },
    );

  if (upErr) {
    logger.error("skill-toggle: upsert failed", {
      vmId,
      slug,
      enabled,
      error: upErr.message,
      route: "api/match/v1/skill-toggle",
    });
    return NextResponse.json(
      { error: "Failed to update skill state", detail: upErr.message },
      { status: 500 },
    );
  }

  logger.info("skill-toggle: agent flipped live-events skill", {
    vmId,
    slug,
    enabled,
    previousEnabled,
    changed: previousEnabled !== enabled,
    route: "api/match/v1/skill-toggle",
  });

  return NextResponse.json({
    ok: true,
    slug,
    enabled,
    previous_enabled: previousEnabled,
    changed: previousEnabled !== enabled,
  });
}
