import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const MAX_FILE_SIZE = 1_048_576; // 1MB

export async function POST(req: NextRequest) {
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

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const destination = formData.get("destination") as string | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` },
        { status: 400 }
      );
    }

    // Default destination is ~/workspace/
    const dest = destination || "~/workspace/" + file.name;

    // Block path traversal
    if (dest.includes("..")) {
      return NextResponse.json(
        { error: "Path traversal not allowed: '..' is forbidden" },
        { status: 400 }
      );
    }

    // Only allow paths under home directory (relative or ~/*)
    if (dest.startsWith("/") && !dest.startsWith("/home/")) {
      return NextResponse.json(
        { error: "Absolute paths must be under /home/" },
        { status: 400 }
      );
    }

    // Validate destination characters (no shell metacharacters)
    if (!/^[A-Za-z0-9_:.\-\/~]+$/.test(dest)) {
      return NextResponse.json(
        { error: "Invalid characters in destination path" },
        { status: 400 }
      );
    }

    // Read file content and base64 encode
    const arrayBuffer = await file.arrayBuffer();
    const b64 = Buffer.from(arrayBuffer).toString("base64");

    // Upload via SSH using base64 decode to write file
    const { connectSSH } = await import("@/lib/ssh");
    const ssh = await connectSSH(vm);

    try {
      // Ensure parent directory exists — dest is already validated against
      // a strict character allowlist (alphanumeric, _, :, ., -, /, ~) so
      // it is safe to interpolate after base64 encoding for extra safety.
      const destB64 = Buffer.from(dest, "utf-8").toString("base64");
      const parentDir = dest.substring(0, dest.lastIndexOf("/"));
      if (parentDir) {
        const parentB64 = Buffer.from(parentDir, "utf-8").toString("base64");
        await ssh.execCommand(`mkdir -p "$(echo '${parentB64}' | base64 -d)"`);
      }

      // Write file via base64 decode (handles binary safely)
      const result = await ssh.execCommand(
        `echo '${b64}' | base64 -d > "$(echo '${destB64}' | base64 -d)"`
      );

      if (result.code !== 0) {
        return NextResponse.json(
          { error: `Upload failed: ${result.stderr}` },
          { status: 500 }
        );
      }

      return NextResponse.json({
        uploaded: true,
        path: dest,
        size: file.size,
        name: file.name,
      });
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.error("File upload error", {
      error: String(err),
      route: "bot/files/upload",
    });
    return NextResponse.json(
      { error: "Failed to upload file" },
      { status: 500 }
    );
  }
}
