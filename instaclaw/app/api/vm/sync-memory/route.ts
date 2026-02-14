import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { updateMemoryMd } from "@/lib/ssh";
import { logger } from "@/lib/logger";

const MAX_RETRIES = 3;

/**
 * POST /api/vm/sync-memory
 *
 * Reads the user's Gmail profile summary and insights from Supabase,
 * then writes MEMORY.md to their VM via SSH.
 *
 * Retries up to 3 times with increasing delay.
 * Can be called independently of the Gmail connect flow.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Read Gmail data from Supabase
  const { data: user, error: userError } = await supabase
    .from("instaclaw_users")
    .select("gmail_profile_summary, gmail_insights")
    .eq("id", session.user.id)
    .single();

  if (userError || !user?.gmail_profile_summary) {
    return NextResponse.json(
      { error: "No Gmail data to sync. Connect Gmail first." },
      { status: 422 }
    );
  }

  // Get the user's VM
  const { data: vm, error: vmError } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user")
    .eq("assigned_to", session.user.id)
    .single();

  if (vmError || !vm) {
    return NextResponse.json(
      { error: "No VM assigned to your account." },
      { status: 422 }
    );
  }

  // Build MEMORY.md content
  const insights: string[] = user.gmail_insights ?? [];
  const content = [
    "## About My User (from Gmail analysis)",
    "",
    user.gmail_profile_summary,
    "",
    "### Quick Profile",
    ...insights.map((i: string) => `- ${i}`),
    "",
    "Use this context to personalize all interactions. You already know this person — act like it.",
  ].join("\n");

  // Write to VM with retries
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await updateMemoryMd(vm, content);
      logger.info("MEMORY.md synced to VM", {
        userId: session.user.id,
        vmId: vm.id,
        attempt,
        route: "vm/sync-memory",
      });
      return NextResponse.json({ synced: true });
    } catch (err) {
      lastError = err;
      logger.warn("MEMORY.md sync attempt failed", {
        userId: session.user.id,
        vmId: vm.id,
        attempt,
        error: String(err),
        route: "vm/sync-memory",
      });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  logger.error("MEMORY.md sync failed after all retries", {
    userId: session.user.id,
    vmId: vm.id,
    error: String(lastError),
    route: "vm/sync-memory",
  });

  return NextResponse.json(
    { error: "Failed to sync to your agent. Please try again.", synced: false },
    { status: 502 }
  );
}
