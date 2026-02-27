import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  long_description: string | null;
  icon: string;
  category: string;
  item_type: string;
  auth_type: string | null;
  requires_restart: boolean;
  requires_api_key: boolean;
  tier_minimum: string;
  is_default: boolean;
  sort_order: number;
  status: string;
}

interface VmSkillRow {
  skill_id: string;
  enabled: boolean;
  connected: boolean;
  connected_account: string | null;
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Fetch all skills and this VM's skill states in parallel
    const [skillsResult, vmSkillsResult] = await Promise.all([
      supabase
        .from("instaclaw_skills")
        .select(
          "id, slug, name, description, long_description, icon, category, item_type, auth_type, requires_restart, requires_api_key, tier_minimum, is_default, sort_order, status"
        )
        .order("category")
        .order("sort_order"),
      supabase
        .from("instaclaw_vm_skills")
        .select("skill_id, enabled, connected, connected_account")
        .eq("vm_id", vm.id),
    ]);

    const skills = (skillsResult.data ?? []) as SkillRow[];
    const vmSkills = (vmSkillsResult.data ?? []) as VmSkillRow[];

    // Build lookup map: skill_id → vm_skill state
    const vmSkillMap = new Map(
      vmSkills.map((vs) => [vs.skill_id, vs])
    );

    // Merge and group by category
    const grouped: Record<
      string,
      Array<{
        slug: string;
        name: string;
        description: string;
        longDescription: string | null;
        icon: string;
        category: string;
        itemType: string;
        authType: string | null;
        requiresRestart: boolean;
        requiresApiKey: boolean;
        tierMinimum: string;
        sortOrder: number;
        status: string;
        enabled: boolean;
        connected: boolean;
        connectedAccount: string | null;
      }>
    > = {};

    for (const skill of skills) {
      const vmSkill = vmSkillMap.get(skill.id);

      const entry = {
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        longDescription: skill.long_description,
        icon: skill.icon,
        category: skill.category,
        itemType: skill.item_type,
        authType: skill.auth_type,
        requiresRestart: skill.requires_restart,
        requiresApiKey: skill.requires_api_key,
        tierMinimum: skill.tier_minimum,
        sortOrder: skill.sort_order,
        status: skill.status,
        enabled: vmSkill?.enabled ?? (skill.item_type !== "integration"),
        connected: vmSkill?.connected ?? false,
        connectedAccount: vmSkill?.connected_account ?? null,
      };

      if (!grouped[skill.category]) {
        grouped[skill.category] = [];
      }
      grouped[skill.category].push(entry);
    }

    return NextResponse.json({ skills: grouped });
  } catch (err) {
    logger.error("Skills list error", {
      error: String(err),
      route: "api/skills",
    });
    return NextResponse.json(
      { error: "Failed to fetch skills" },
      { status: 500 }
    );
  }
}
