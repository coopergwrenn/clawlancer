import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { toggleSkillDir, toggleMcpServer } from "@/lib/ssh";
import { logger } from "@/lib/logger";

// SSH + gateway restart can take up to 15s
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { skillSlug, enabled } = body as {
      skillSlug: unknown;
      enabled: unknown;
    };

    // Validate input
    if (typeof skillSlug !== "string" || !skillSlug) {
      return NextResponse.json(
        { error: "skillSlug is required" },
        { status: 400 }
      );
    }
    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Look up the skill in the registry
    const { data: skill } = await supabase
      .from("instaclaw_skills")
      .select("id, slug, name, item_type, requires_restart, status")
      .eq("slug", skillSlug)
      .single();

    if (!skill) {
      return NextResponse.json(
        { error: `Skill not found: ${skillSlug}` },
        { status: 404 }
      );
    }

    // Built-in skills cannot be toggled
    if (skill.item_type === "built_in") {
      return NextResponse.json(
        { error: "Built-in skills cannot be toggled" },
        { status: 400 }
      );
    }

    // Integrations use the connect/disconnect flow, not toggle
    if (skill.item_type === "integration") {
      return NextResponse.json(
        { error: "Use /api/skills/connect or /api/skills/disconnect for integrations" },
        { status: 400 }
      );
    }

    // SSH into VM and toggle based on item_type
    let result: { success: boolean; restarted: boolean };

    if (skill.item_type === "mcp_server") {
      result = await toggleMcpServer(vm, skill.slug, enabled);
    } else {
      // item_type === "skill"
      result = await toggleSkillDir(vm, skill.slug, enabled);
    }

    if (!result.success) {
      return NextResponse.json(
        { error: "Failed to toggle skill on VM" },
        { status: 500 }
      );
    }

    // Update DB state
    await supabase
      .from("instaclaw_vm_skills")
      .update({ enabled })
      .eq("vm_id", vm.id)
      .eq("skill_id", skill.id);

    logger.info("Skill toggled", {
      slug: skill.slug,
      enabled,
      restarted: result.restarted,
      vmId: vm.id,
      userId: session.user.id,
      route: "api/skills/toggle",
    });

    return NextResponse.json({
      success: true,
      restarted: result.restarted,
    });
  } catch (err) {
    logger.error("Skill toggle error", {
      error: String(err),
      route: "api/skills/toggle",
    });
    return NextResponse.json(
      { error: "Failed to toggle skill" },
      { status: 500 }
    );
  }
}
