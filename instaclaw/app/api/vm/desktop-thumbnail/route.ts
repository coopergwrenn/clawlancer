import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/vm/desktop-thumbnail
 *
 * Returns the agent's desktop thumbnail image (400x240 JPEG, ~10-20KB).
 * The thumbnail is pre-generated on the VM every 30 seconds by a cron job.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return new NextResponse(null, { status: 401 });
    }

    const supabase = getSupabase();
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .eq("status", "assigned")
      .single();

    if (!vm) {
      return new NextResponse(null, { status: 404 });
    }

    let ssh;
    try {
      ssh = await connectSSH(vm);

      // Read the pre-generated thumbnail
      const result = await ssh.execCommand(
        "base64 -w0 ~/.openclaw/workspace/desktop-thumbnail.jpg 2>/dev/null || echo NONE"
      );

      if (!result.stdout || result.stdout === "NONE") {
        return new NextResponse(null, { status: 204 }); // No thumbnail yet
      }

      const imageBuffer = Buffer.from(result.stdout.trim(), "base64");

      return new NextResponse(imageBuffer, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=10",
          "Content-Length": String(imageBuffer.length),
        },
      });
    } catch (err) {
      logger.warn("Desktop thumbnail fetch failed", {
        error: String(err),
        vmId: vm.id,
      });
      return new NextResponse(null, { status: 502 });
    } finally {
      ssh?.dispose();
    }
  } catch (err) {
    return new NextResponse(null, { status: 500 });
  }
}
