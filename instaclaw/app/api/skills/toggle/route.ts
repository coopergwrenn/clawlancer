import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { toggleSkillDir, toggleMcpServer, installAgdpSkill, uninstallAgdpSkill, installSolanaDefiSkill, uninstallSolanaDefiSkill, installHiggsfieldSkill, uninstallHiggsfieldSkill } from "@/lib/ssh";
import { logger } from "@/lib/logger";

// SSH + gateway restart + pip install can take up to 45s
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    // Dual auth: NextAuth session OR X-Mini-App-Token (from World mini app proxy)
    const session = await auth();
    let userId = session?.user?.id;

    if (!userId) {
      const { validateMiniAppToken } = await import("@/lib/security");
      userId = await validateMiniAppToken(req) ?? undefined;
    }

    if (!userId) {
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
      .eq("assigned_to", userId)
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

    // ── Special case: Virtuals aGDP uses its own install/uninstall flow ──
    if (skill.slug === "virtuals-agdp") {
      try {
        if (enabled) {
          const agdpResult = await installAgdpSkill(vm);

          // Update instaclaw_vms.agdp_enabled (+ authRequestId if present)
          const dbUpdate: Record<string, unknown> = { agdp_enabled: true };
          if (agdpResult.authRequestId) {
            dbUpdate.acp_auth_request_id = agdpResult.authRequestId;
          }
          await supabase.from("instaclaw_vms").update(dbUpdate).eq("id", vm.id);

          // Upsert vm_skills state (row may not exist for new VMs)
          await supabase
            .from("instaclaw_vm_skills")
            .upsert({ vm_id: vm.id, skill_id: skill.id, enabled: true }, { onConflict: "vm_id,skill_id" });

          logger.info("Skill toggled (aGDP install)", {
            slug: skill.slug,
            enabled,
            authUrl: !!agdpResult.authUrl,
            serving: agdpResult.serving,
            vmId: vm.id,
            userId: userId,
            route: "api/skills/toggle",
          });

          return NextResponse.json({
            success: true,
            restarted: false,
            authUrl: agdpResult.authUrl,
            serving: agdpResult.serving,
          });
        } else {
          await uninstallAgdpSkill(vm);

          await supabase.from("instaclaw_vms").update({ agdp_enabled: false }).eq("id", vm.id);
          await supabase
            .from("instaclaw_vm_skills")
            .upsert({ vm_id: vm.id, skill_id: skill.id, enabled: false }, { onConflict: "vm_id,skill_id" });

          logger.info("Skill toggled (aGDP uninstall)", {
            slug: skill.slug,
            enabled,
            vmId: vm.id,
            userId: userId,
            route: "api/skills/toggle",
          });

          return NextResponse.json({ success: true, restarted: false });
        }
      } catch (agdpErr) {
        logger.error("aGDP toggle failed", {
          vmId: vm.id,
          enabled,
          error: String(agdpErr),
          route: "api/skills/toggle",
        });
        return NextResponse.json(
          { error: `Virtuals toggle failed: ${String(agdpErr).slice(0, 200)}` },
          { status: 500 }
        );
      }
    }

    // ── Special case: Solana DeFi uses install/uninstall (wallet generation on enable) ──
    if (skill.slug === "solana-defi") {
      try {
        if (enabled) {
          const solResult = await installSolanaDefiSkill(vm);

          // Save wallet address + enabled flag to instaclaw_vms
          const dbUpdate: Record<string, unknown> = { solana_defi_enabled: true };
          if (solResult.walletAddress) {
            dbUpdate.solana_wallet_address = solResult.walletAddress;
          }
          await supabase.from("instaclaw_vms").update(dbUpdate).eq("id", vm.id);

          // Upsert vm_skills state (row may not exist for new VMs)
          await supabase
            .from("instaclaw_vm_skills")
            .upsert({ vm_id: vm.id, skill_id: skill.id, enabled: true }, { onConflict: "vm_id,skill_id" });

          logger.info("Skill toggled (Solana DeFi install)", {
            slug: skill.slug,
            enabled,
            walletAddress: solResult.walletAddress,
            vmId: vm.id,
            userId: userId,
            route: "api/skills/toggle",
          });

          return NextResponse.json({
            success: true,
            restarted: true,
            walletAddress: solResult.walletAddress,
          });
        } else {
          await uninstallSolanaDefiSkill(vm);

          await supabase.from("instaclaw_vms").update({ solana_defi_enabled: false }).eq("id", vm.id);
          await supabase
            .from("instaclaw_vm_skills")
            .upsert({ vm_id: vm.id, skill_id: skill.id, enabled: false, connected: false }, { onConflict: "vm_id,skill_id" });

          logger.info("Skill toggled (Solana DeFi uninstall)", {
            slug: skill.slug,
            enabled,
            vmId: vm.id,
            userId: userId,
            route: "api/skills/toggle",
          });

          return NextResponse.json({ success: true, restarted: true });
        }
      } catch (solErr) {
        logger.error("Solana DeFi toggle failed", {
          vmId: vm.id,
          enabled,
          error: String(solErr),
          route: "api/skills/toggle",
        });
        return NextResponse.json(
          { error: `Solana DeFi toggle failed: ${String(solErr).slice(0, 200)}` },
          { status: 500 }
        );
      }
    }

    // ── Special case: Higgsfield AI Video uses install/uninstall (platform-provided) ──
    if (skill.slug === "higgsfield-video") {
      try {
        if (enabled) {
          await installHiggsfieldSkill(vm);

          await supabase.from("instaclaw_vms").update({ higgsfield_enabled: true }).eq("id", vm.id);
          await supabase
            .from("instaclaw_vm_skills")
            .upsert({ vm_id: vm.id, skill_id: skill.id, enabled: true }, { onConflict: "vm_id,skill_id" });

          logger.info("Skill toggled (Higgsfield install)", {
            slug: skill.slug,
            enabled,
            vmId: vm.id,
            userId: userId,
            route: "api/skills/toggle",
          });

          return NextResponse.json({ success: true, restarted: true });
        } else {
          await uninstallHiggsfieldSkill(vm);

          await supabase.from("instaclaw_vms").update({ higgsfield_enabled: false }).eq("id", vm.id);
          await supabase
            .from("instaclaw_vm_skills")
            .upsert({ vm_id: vm.id, skill_id: skill.id, enabled: false }, { onConflict: "vm_id,skill_id" });

          logger.info("Skill toggled (Higgsfield uninstall)", {
            slug: skill.slug,
            enabled,
            vmId: vm.id,
            userId: userId,
            route: "api/skills/toggle",
          });

          return NextResponse.json({ success: true, restarted: true });
        }
      } catch (hfErr) {
        logger.error("Higgsfield toggle failed", {
          vmId: vm.id,
          enabled,
          error: String(hfErr),
          route: "api/skills/toggle",
        });
        return NextResponse.json(
          { error: `Higgsfield toggle failed: ${String(hfErr).slice(0, 200)}` },
          { status: 500 }
        );
      }
    }

    // ── Generic toggle: skill dirs and MCP servers ──
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

    // Upsert DB state (row may not exist for new VMs with non-default skills)
    await supabase
      .from("instaclaw_vm_skills")
      .upsert({ vm_id: vm.id, skill_id: skill.id, enabled }, { onConflict: "vm_id,skill_id" });

    logger.info("Skill toggled", {
      slug: skill.slug,
      enabled,
      restarted: result.restarted,
      vmId: vm.id,
      userId: userId,
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
