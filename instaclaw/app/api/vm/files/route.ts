import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { listFiles, readFile } from "@/lib/ssh";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
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

    const path = req.nextUrl.searchParams.get("path") || "~/workspace";
    const file = req.nextUrl.searchParams.get("file");

    // Block path traversal
    if (path.includes("..") || file?.includes("..")) {
      return NextResponse.json(
        { error: "Path traversal not allowed: '..' is forbidden" },
        { status: 400 }
      );
    }

    if (file) {
      // Read file content
      const content = await readFile(vm, file);
      return NextResponse.json({ content });
    }

    // List directory
    const files = await listFiles(vm, path);
    return NextResponse.json({ path, files });
  } catch (err) {
    logger.error("Files error", { error: String(err), route: "vm/files" });
    return NextResponse.json(
      { error: "Failed to browse files" },
      { status: 500 }
    );
  }
}
