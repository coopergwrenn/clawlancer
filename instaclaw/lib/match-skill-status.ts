/**
 * Skill-state lookup for the matching engine.
 *
 * The consensus-2026 skill is gated by a runtime check (not by skill-dir
 * presence) — the matching pipeline only does work when the user has
 * the skill toggled ON via the Skills page, the partner-tag flow, or the
 * agent's organic activation. Default is OFF.
 *
 * This helper centralizes the lookup so route_intent, consent, and the
 * agent-callable skill-toggle endpoint share one source of truth + one
 * default policy. If we ever change how live-events skills resolve
 * (e.g., per-conference dates window), this is the single edit point.
 *
 * Default-when-no-row policy: any consensus-2026 skill with is_default=false
 * (per the migration) means "not enabled unless explicitly turned on." A
 * missing instaclaw_vm_skills row → enabled=false. We never look at the
 * skill's is_default at runtime — that's a provisioning-time concern only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SkillState {
  /** Whether the skill is currently enabled for this VM. */
  enabled: boolean;
  /** The skill's id (UUID) if it exists in the registry. */
  skillId: string | null;
  /** The slug we looked up. */
  slug: string;
}

/**
 * Read the enabled state of a live-events skill for a specific VM.
 *
 * Returns enabled=false on:
 *   - skill slug not registered in instaclaw_skills (returns skillId=null)
 *   - no row in instaclaw_vm_skills for (vm_id, skill_id)
 *   - row exists with enabled=false
 *
 * Returns enabled=true only when the row exists with enabled=true.
 *
 * Errors are NOT thrown — they're treated as "skill disabled" so a DB
 * blip never accidentally surfaces matching work to a non-attendee. Log
 * + return false. The caller can decide whether to retry.
 */
export async function getSkillState(
  supabase: SupabaseClient,
  vmId: string,
  slug: string,
): Promise<SkillState> {
  // 1. Resolve slug → skill_id. The skills table is small (~20 rows) and
  // this query is uncached; if it becomes hot we can memoize per-process.
  const { data: skill, error: skillErr } = await supabase
    .from("instaclaw_skills")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (skillErr || !skill) {
    return { enabled: false, skillId: null, slug };
  }

  const skillId = skill.id as string;

  // 2. Check the per-VM row.
  const { data: vmSkill, error: vmSkillErr } = await supabase
    .from("instaclaw_vm_skills")
    .select("enabled")
    .eq("vm_id", vmId)
    .eq("skill_id", skillId)
    .maybeSingle();

  if (vmSkillErr) {
    return { enabled: false, skillId, slug };
  }

  return {
    enabled: vmSkill?.enabled === true,
    skillId,
    slug,
  };
}

export const CONSENSUS_2026_SKILL_SLUG = "consensus-2026";
