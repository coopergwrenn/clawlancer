import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { removeIntegrationCredentials } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const maxDuration = 30;

// Env var keys to remove from the VM's .env per integration
const INTEGRATION_ENV_KEYS: Record<string, string[]> = {
  "google-workspace": ["GOOGLE_ACCESS_TOKEN", "GOOGLE_REFRESH_TOKEN"],
  shopify: ["SHOPIFY_ACCESS_TOKEN", "SHOPIFY_SHOP_DOMAIN"],
  notion: ["NOTION_ACCESS_TOKEN"],
  github: ["GITHUB_ACCESS_TOKEN"],
};

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { integrationSlug } = body as { integrationSlug: unknown };

    if (typeof integrationSlug !== "string" || !integrationSlug) {
      return NextResponse.json(
        { error: "integrationSlug is required" },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    // Look up integration
    const { data: skill } = await supabase
      .from("instaclaw_skills")
      .select("id, slug, name, item_type, auth_type")
      .eq("slug", integrationSlug)
      .eq("item_type", "integration")
      .single();

    if (!skill) {
      return NextResponse.json(
        { error: `Integration not found: ${integrationSlug}` },
        { status: 404 }
      );
    }

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Remove credentials from VM
    const envKeys = INTEGRATION_ENV_KEYS[integrationSlug] ?? [];
    if (envKeys.length > 0) {
      const removed = await removeIntegrationCredentials(
        vm,
        integrationSlug,
        envKeys
      );

      if (!removed) {
        logger.warn("Failed to remove credentials from VM", {
          slug: integrationSlug,
          vmId: vm.id,
          route: "api/skills/disconnect",
        });
        // Non-fatal: continue to update DB state even if VM cleanup had issues
      }
    }

    // Update DB: clear connected state and credentials
    await supabase
      .from("instaclaw_vm_skills")
      .update({
        enabled: false,
        connected: false,
        connected_account: null,
        credentials: null,
      })
      .eq("vm_id", vm.id)
      .eq("skill_id", skill.id);

    logger.info("Integration disconnected", {
      slug: integrationSlug,
      vmId: vm.id,
      userId: session.user.id,
      route: "api/skills/disconnect",
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("Integration disconnect error", {
      error: String(err),
      route: "api/skills/disconnect",
    });
    return NextResponse.json(
      { error: "Failed to disconnect integration" },
      { status: 500 }
    );
  }
}
