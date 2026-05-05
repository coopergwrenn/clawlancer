import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { fetchMoltbankAccount } from "@/lib/ssh";
import { logger } from "@/lib/logger";

// SSH fetch is ~3-5s; allow headroom.
export const maxDuration = 30;

/**
 * Fetch the user's primary Moltbank account address for display in the
 * funding panel. Returns the cached address from instaclaw_vm_skills.config
 * immediately, and refreshes from the VM in the background.
 *
 * The returned address is a USDC account on the Base network ONLY.
 * Sending funds on any other network will result in loss.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    let userId = session?.user?.id;

    if (!userId) {
      const { validateMiniAppToken } = await import("@/lib/security");
      userId = (await validateMiniAppToken(req)) ?? undefined;
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", userId)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    const { data: skill } = await supabase
      .from("instaclaw_skills")
      .select("id")
      .eq("slug", "moltbank")
      .single();

    if (!skill) {
      return NextResponse.json(
        { error: "Moltbank skill is not registered" },
        { status: 404 }
      );
    }

    const { data: vmSkill } = await supabase
      .from("instaclaw_vm_skills")
      .select("config, connected, enabled")
      .eq("vm_id", vm.id)
      .eq("skill_id", skill.id)
      .single();

    const cached = (vmSkill?.config ?? {}) as {
      paired?: boolean;
      account_address?: string;
      account_name?: string;
    };

    if (!vmSkill?.enabled || !cached.paired) {
      return NextResponse.json(
        { paired: false, network: "base", asset: "USDC" },
        { status: 200 }
      );
    }

    // Serve cached address immediately if we have one
    if (cached.account_address) {
      return NextResponse.json({
        paired: true,
        accountAddress: cached.account_address,
        accountName: cached.account_name ?? null,
        network: "base",
        asset: "USDC",
      });
    }

    // No cached address yet — fetch from the VM and persist
    const fresh = await fetchMoltbankAccount(vm);

    if (fresh.accountAddress) {
      const newConfig: Record<string, unknown> = {
        ...cached,
        paired: true,
        account_address: fresh.accountAddress,
      };
      if (fresh.accountName) newConfig.account_name = fresh.accountName;

      await supabase
        .from("instaclaw_vm_skills")
        .update({ config: newConfig })
        .eq("vm_id", vm.id)
        .eq("skill_id", skill.id);
    }

    return NextResponse.json({
      paired: true,
      accountAddress: fresh.accountAddress ?? null,
      accountName: fresh.accountName ?? null,
      network: "base",
      asset: "USDC",
    });
  } catch (err) {
    logger.error("Moltbank account lookup error", {
      error: String(err),
      route: "api/skills/moltbank/account",
    });
    return NextResponse.json(
      { error: "Failed to fetch Moltbank account" },
      { status: 500 }
    );
  }
}
