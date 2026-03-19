import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { readFileBase64 } from "@/lib/ssh";
import crypto from "crypto";

export const dynamic = "force-dynamic";

const FILE_SHARE_SECRET = process.env.FILE_SHARE_SECRET || "";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown",
  ".json": "application/json", ".html": "text/html",
};

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  // Restore standard base64
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64");
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    if (!FILE_SHARE_SECRET) {
      return new NextResponse("File sharing not configured", { status: 500 });
    }

    const { token } = await params;
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx <= 0) {
      return new NextResponse("Invalid link", { status: 403 });
    }

    const payloadB64 = token.slice(0, dotIdx);
    const signatureB64 = token.slice(dotIdx + 1);

    // Verify HMAC with constant-time comparison
    const expectedSig = base64url(
      crypto.createHmac("sha256", FILE_SHARE_SECRET).update(payloadB64).digest()
    );

    const sigA = Buffer.from(signatureB64);
    const sigB = Buffer.from(expectedSig);
    if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
      return new NextResponse("Invalid link", { status: 403 });
    }

    // Decode payload
    let payload: { vmId: string; filePath: string; userId: string; exp: number };
    try {
      payload = JSON.parse(base64urlDecode(payloadB64).toString("utf-8"));
    } catch {
      return new NextResponse("Invalid link", { status: 403 });
    }

    // Check expiry
    if (!payload.exp || payload.exp < Date.now()) {
      return new NextResponse("This link has expired", { status: 410 });
    }

    const supabase = getSupabase();
    const fileName = payload.filePath.split("/").pop() || "file";
    const ext = fileName.lastIndexOf(".") >= 0
      ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase()
      : "";
    const mime = MIME_MAP[ext] || "application/octet-stream";

    // V2: Try Supabase Storage first (fast CDN, works even if VM is offline)
    const { data: delivery } = await supabase
      .from("delivered_files")
      .select("storage_path")
      .eq("user_id", payload.userId)
      .eq("vm_id", payload.vmId)
      .ilike("filename", fileName)
      .not("storage_path", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (delivery?.storage_path) {
      const { data: storageData, error: storageErr } = await supabase.storage
        .from("delivered-files")
        .download(delivery.storage_path);

      if (!storageErr && storageData) {
        const buf = Buffer.from(await storageData.arrayBuffer());
        return new NextResponse(buf, {
          headers: {
            "Content-Type": mime,
            "Content-Disposition": `inline; filename="${fileName}"`,
            "Content-Length": String(buf.length),
            "Cache-Control": "private, max-age=3600",
          },
        });
      }
    }

    // Fallback: SSH into VM (V1 behavior)
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("id", payload.vmId)
      .single();

    if (!vm) {
      return new NextResponse("File not available", { status: 404 });
    }

    let b64Content: string;
    try {
      b64Content = await readFileBase64(vm, payload.filePath);
    } catch {
      return new NextResponse("File not available", { status: 404 });
    }

    if (!b64Content) {
      return new NextResponse("File not available", { status: 404 });
    }

    const buf = Buffer.from(b64Content, "base64");

    return new NextResponse(buf, {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `inline; filename="${fileName}"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("Signed URL resolver error:", err);
    return new NextResponse("File not available", { status: 404 });
  }
}
