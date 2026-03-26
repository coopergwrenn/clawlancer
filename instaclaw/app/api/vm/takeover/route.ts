import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/vm/takeover
 *
 * Signal the agent to pause (user taking control) or resume (user releasing control).
 * Body: { action: "start" | "stop" }
 *
 * Creates/removes ~/.openclaw/workspace/.user-takeover on the VM.
 * The agent checks this file before executing dispatch commands.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const action = body.action;

    if (action !== "start" && action !== "stop") {
      return NextResponse.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, name")
      .eq("assigned_to", session.user.id)
      .eq("status", "assigned")
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    const ssh = await connectSSH(vm);
    try {
      const takeoverFile = "$HOME/.openclaw/workspace/.user-takeover";

      if (action === "start") {
        // Create takeover file — agent will pause
        await ssh.execCommand(`echo '{"user":"${session.user.id}","since":"${new Date().toISOString()}"}' > ${takeoverFile}`);
        logger.info("User takeover started", { userId: session.user.id, vmName: vm.name });
      } else {
        // Remove takeover file — agent resumes
        await ssh.execCommand(`rm -f ${takeoverFile}`);
        logger.info("User takeover ended", { userId: session.user.id, vmName: vm.name });
      }

      return NextResponse.json({ success: true, action, vmName: vm.name });
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.error("Takeover error", { error: String(err), route: "vm/takeover" });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
