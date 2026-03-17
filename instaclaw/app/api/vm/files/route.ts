import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { listFiles, readFile, readFileBase64 } from "@/lib/ssh";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
  ".mp4", ".webm", ".mov", ".avi", ".mkv",
  ".mp3", ".wav", ".ogg", ".flac",
  ".pdf", ".zip", ".tar", ".gz", ".7z",
]);

const MIME_MAP: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".pdf": "application/pdf", ".zip": "application/zip",
};

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

async function getVM(userId: string) {
  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user")
    .eq("assigned_to", userId)
    .single();
  return vm;
}

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const vm = await getVM(session.user.id);
    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    const BROWSE_ROOT = "~/.openclaw/workspace";
    const path = req.nextUrl.searchParams.get("path") || BROWSE_ROOT;
    const file = req.nextUrl.searchParams.get("file");
    const download = req.nextUrl.searchParams.get("download") === "1";

    // Block path traversal
    if (path.includes("..") || file?.includes("..")) {
      return NextResponse.json(
        { error: "Path traversal not allowed" },
        { status: 400 }
      );
    }

    // Directory browsing: only allow within ~/.openclaw/workspace
    if (!path.startsWith(BROWSE_ROOT)) {
      return NextResponse.json(
        { error: "Access restricted to workspace" },
        { status: 403 }
      );
    }

    // File viewing/downloading: block protected system files
    if (file) {
      // Dashboard panels (e.g. PolymarketPanel) need to read specific files
      // outside of workspace. Allow exact paths that are safe to expose.
      const DASHBOARD_ALLOWLIST = [
        "~/.openclaw/polymarket/wallet.json",
        "~/.openclaw/polymarket/positions.json",
        "~/.openclaw/polymarket/risk-config.json",
        "~/.openclaw/polymarket/trade-log.json",
        "~/.openclaw/polymarket/polymarket-risk.json",
        "~/.openclaw/polymarket/daily-spend.json",
        "~/.openclaw/kalshi/credentials.json",
        "~/memory/polymarket-watchlist.json",
      ];
      const isDashboardFile = DASHBOARD_ALLOWLIST.includes(file);

      if (!isDashboardFile && !file.startsWith(BROWSE_ROOT)) {
        return NextResponse.json(
          { error: "Access restricted to workspace" },
          { status: 403 }
        );
      }
      if (!isDashboardFile) {
        const fileName = file.split("/").pop()?.toLowerCase() || "";
        const BLOCKED_FILES = [
          "soul.md", "capabilities.md", "quick-reference.md", "tools.md",
          "bootstrap.md", "user.md",
          ".env", "auth-profiles.json",
        ];
        const BLOCKED_DIRS = ["/skills/", "/.openclaw/"];
        const isBlocked =
          BLOCKED_FILES.includes(fileName) ||
          BLOCKED_DIRS.some((d) => file.includes(d)) ||
          fileName.startsWith(".env");
        if (isBlocked) {
          return NextResponse.json(
            { error: "This file is protected" },
            { status: 403 }
          );
        }
      }
    }

    if (file) {
      const ext = getExt(file);
      const isBinary = BINARY_EXTENSIONS.has(ext);

      if (download || isBinary) {
        // Return base64-encoded binary content
        const b64 = await readFileBase64(vm, file);
        const mime = MIME_MAP[ext] || "application/octet-stream";
        const fileName = file.split("/").pop() || "file";

        if (download) {
          // Direct download — return raw bytes
          const buf = Buffer.from(b64, "base64");
          return new NextResponse(buf, {
            headers: {
              "Content-Type": mime,
              "Content-Disposition": `attachment; filename="${fileName}"`,
              "Content-Length": String(buf.length),
            },
          });
        }

        // Return base64 for inline preview (images/video)
        return NextResponse.json({ content: b64, mime, binary: true });
      }

      // Text file
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
