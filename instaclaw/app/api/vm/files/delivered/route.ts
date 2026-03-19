import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { readFileBase64 } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown",
  ".json": "application/json", ".html": "text/html",
};

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/**
 * POST /api/vm/files/delivered — Log a file delivery + upload to Supabase Storage.
 *
 * Called by deliver_file.sh on the VM after successful Telegram delivery.
 * Auth: gateway token (same as heartbeat/health endpoints).
 */
export async function POST(req: NextRequest) {
  try {
    // Auth via gateway token (Bearer)
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Look up VM by gateway token
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, assigned_to")
      .eq("gateway_token", token)
      .single();

    if (!vm || !vm.assigned_to) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const body = await req.json();
    const {
      filename,
      file_path,
      size,
      mime,
      telegram_file_id,
      telegram_method,
      caption,
      dashboard_url,
    } = body as {
      filename: string;
      file_path: string;
      size: number;
      mime: string;
      telegram_file_id?: string;
      telegram_method?: string;
      caption?: string;
      dashboard_url?: string;
    };

    if (!filename || !file_path) {
      return NextResponse.json({ error: "filename and file_path required" }, { status: 400 });
    }

    // Build storage path
    const timestamp = Date.now();
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${vm.assigned_to}/${vm.id}/${timestamp}_${safeFilename}`;

    // Read file from VM and upload to Supabase Storage
    let storageUploaded = false;
    try {
      const b64Content = await readFileBase64(vm, file_path, 50_000_000); // 50MB max
      if (b64Content) {
        const buf = Buffer.from(b64Content, "base64");
        const ext = getExt(filename);
        const contentType = mime || MIME_MAP[ext] || "application/octet-stream";

        const { error: uploadError } = await supabase.storage
          .from("delivered-files")
          .upload(storagePath, buf, {
            contentType,
            upsert: false,
          });

        if (uploadError) {
          logger.warn("Storage upload failed, delivery still logged", {
            error: String(uploadError),
            storagePath,
            vmId: vm.id,
          });
        } else {
          storageUploaded = true;
        }
      }
    } catch (sshErr) {
      logger.warn("Could not read file from VM for storage upload", {
        error: String(sshErr),
        vmId: vm.id,
        file_path,
      });
    }

    // Insert delivery record
    const { data: record, error: insertError } = await supabase
      .from("delivered_files")
      .insert({
        user_id: vm.assigned_to,
        vm_id: vm.id,
        filename,
        file_path_vm: file_path,
        storage_path: storageUploaded ? storagePath : null,
        file_size_bytes: size || 0,
        mime_type: mime || "application/octet-stream",
        telegram_file_id: telegram_file_id || null,
        telegram_method: telegram_method || null,
        caption: caption || null,
        dashboard_url: dashboard_url || null,
      })
      .select("id")
      .single();

    if (insertError) {
      logger.error("Failed to insert delivery record", {
        error: String(insertError),
        vmId: vm.id,
      });
      return NextResponse.json({ error: "Failed to log delivery" }, { status: 500 });
    }

    return NextResponse.json({
      logged: true,
      id: record?.id,
      storage_uploaded: storageUploaded,
      storage_path: storageUploaded ? storagePath : null,
    });
  } catch (err) {
    logger.error("Delivery log error", { error: String(err), route: "vm/files/delivered" });
    return NextResponse.json({ error: "Failed to log delivery" }, { status: 500 });
  }
}

/**
 * GET /api/vm/files/delivered — Return delivery history for the authenticated user.
 *
 * Auth: session (dashboard) — imports auth lazily to avoid circular deps.
 */
export async function GET(req: NextRequest) {
  try {
    const { auth } = await import("@/lib/auth");
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();
    const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "50"), 100);
    const offset = parseInt(req.nextUrl.searchParams.get("offset") || "0");

    const { data: deliveries, error } = await supabase
      .from("delivered_files")
      .select("id, filename, file_size_bytes, mime_type, telegram_method, telegram_file_id, caption, dashboard_url, storage_path, created_at")
      .eq("user_id", session.user.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error("Delivery history query failed", { error: String(error) });
      return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
    }

    // Generate download URLs for files in storage
    const enriched = (deliveries || []).map((d) => ({
      ...d,
      download_url: d.storage_path
        ? `/api/vm/files/delivered/download?id=${d.id}`
        : null,
    }));

    return NextResponse.json({ deliveries: enriched });
  } catch (err) {
    logger.error("Delivery history error", { error: String(err), route: "vm/files/delivered" });
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }
}
