import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { pollMoltbankAuth } from "@/lib/ssh";
import { logger } from "@/lib/logger";

// SSH poll can take ~3-8s; allow a bit of headroom.
export const maxDuration = 30;

/**
 * Poll the Moltbank device-code flow for this user's VM.
 *
 * Returns:
 *  - { paired: false }             — still waiting for the user
 *  - { paired: false, expired }    — session expired; UI should reset and toggle off
 *  - { paired: true, accountAddress, accountName } — success
 *
 * Persists pairing state into instaclaw_vm_skills.config so the Skills page
 * can re-render the funding panel on navigation.
 */
export async function POST(req: NextRequest) {
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

    const poll = await pollMoltbankAuth(vm);

    if (poll.paired) {
      const newConfig: Record<string, unknown> = {
        paired: true,
        paired_at: Date.now(),
      };
      if (poll.accountAddress) newConfig.account_address = poll.accountAddress;
      if (poll.accountName) newConfig.account_name = poll.accountName;

      await supabase
        .from("instaclaw_vm_skills")
        .upsert(
          {
            vm_id: vm.id,
            skill_id: skill.id,
            enabled: true,
            connected: true,
            config: newConfig,
          },
          { onConflict: "vm_id,skill_id" }
        );

      logger.info("Moltbank pairing complete", {
        vmId: vm.id,
        userId,
        hasAddress: !!poll.accountAddress,
        route: "api/skills/moltbank/status",
      });

      return NextResponse.json({
        paired: true,
        accountAddress: poll.accountAddress,
        accountName: poll.accountName,
      });
    }

    if (poll.expired) {
      await supabase
        .from("instaclaw_vm_skills")
        .upsert(
          {
            vm_id: vm.id,
            skill_id: skill.id,
            enabled: true,
            connected: false,
            config: { paired: false, expired: true },
          },
          { onConflict: "vm_id,skill_id" }
        );

      return NextResponse.json({ paired: false, expired: true });
    }

    return NextResponse.json({ paired: false });
  } catch (err) {
    logger.error("Moltbank status poll error", {
      error: String(err),
      route: "api/skills/moltbank/status",
    });
    return NextResponse.json(
      { error: "Failed to check Moltbank status" },
      { status: 500 }
    );
  }
}
