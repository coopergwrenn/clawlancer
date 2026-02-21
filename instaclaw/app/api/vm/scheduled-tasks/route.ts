import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { manageCrontab } from "@/lib/ssh";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    const entries = await manageCrontab(vm, "list");
    return NextResponse.json({ entries });
  } catch (err) {
    logger.error("Scheduled tasks error", { error: String(err), route: "vm/scheduled-tasks" });
    return NextResponse.json(
      { error: "Failed to fetch scheduled tasks" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { action, schedule, command, description } = await req.json();
    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    if (action === "add") {
      if (!schedule || !command) {
        return NextResponse.json(
          { error: "schedule and command are required" },
          { status: 400 }
        );
      }
      await manageCrontab(vm, "add", { schedule, command, description });
      return NextResponse.json({ added: true });
    }

    if (action === "remove") {
      if (!command) {
        return NextResponse.json(
          { error: "command is required" },
          { status: 400 }
        );
      }
      await manageCrontab(vm, "remove", { schedule: "", command });
      return NextResponse.json({ removed: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    logger.error("Scheduled tasks update error", { error: String(err), route: "vm/scheduled-tasks" });
    return NextResponse.json(
      { error: "Failed to update scheduled tasks" },
      { status: 500 }
    );
  }
}
