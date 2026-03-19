import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import crypto from "crypto";

export const dynamic = "force-dynamic";

const FILE_SHARE_SECRET = process.env.FILE_SHARE_SECRET || "";
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const BLOCKED_FILES = new Set([
  "soul.md", "capabilities.md", "quick-reference.md", "tools.md",
  "bootstrap.md", "user.md", ".env", "auth-profiles.json", "wallet.json",
]);

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function POST(req: NextRequest) {
  try {
    if (!FILE_SHARE_SECRET) {
      return NextResponse.json({ error: "File sharing not configured" }, { status: 500 });
    }

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const filePath = body.filePath as string;
    if (!filePath || typeof filePath !== "string") {
      return NextResponse.json({ error: "filePath required" }, { status: 400 });
    }

    // Path traversal blocking
    if (filePath.includes("..")) {
      return NextResponse.json({ error: "Path traversal not allowed" }, { status: 400 });
    }

    // Must be within workspace
    if (!filePath.startsWith("~/.openclaw/workspace")) {
      return NextResponse.json({ error: "Access restricted to workspace" }, { status: 403 });
    }

    // Block protected files
    const fileName = filePath.split("/").pop()?.toLowerCase() || "";
    if (BLOCKED_FILES.has(fileName) || fileName.startsWith(".env")) {
      return NextResponse.json({ error: "This file is protected" }, { status: 403 });
    }

    // Look up user's VM
    const supabase = getSupabase();
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Build HMAC token
    const payload = {
      vmId: vm.id,
      filePath,
      userId: session.user.id,
      exp: Date.now() + EXPIRY_MS,
    };

    const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
    const signature = base64url(
      crypto.createHmac("sha256", FILE_SHARE_SECRET).update(payloadB64).digest()
    );
    const token = `${payloadB64}.${signature}`;

    const baseUrl = (process.env.NEXTAUTH_URL || "https://instaclaw.io").replace(/\/$/, "");
    const url = `${baseUrl}/api/f/${token}`;

    return NextResponse.json({
      url,
      expiresAt: new Date(payload.exp).toISOString(),
    });
  } catch (err) {
    console.error("Share URL error:", err);
    return NextResponse.json({ error: "Failed to generate share URL" }, { status: 500 });
  }
}
