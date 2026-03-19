import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/vm/files/delivered/download?id={delivery_id}
 * Serves a delivered file from Supabase Storage. Auth-gated to file owner.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return new NextResponse("Missing id", { status: 400 });
    }

    const supabase = getSupabase();

    // Look up delivery record — ensure user owns it
    const { data: delivery } = await supabase
      .from("delivered_files")
      .select("id, filename, mime_type, storage_path, user_id")
      .eq("id", id)
      .single();

    if (!delivery || delivery.user_id !== session.user.id) {
      return new NextResponse("Not found", { status: 404 });
    }

    if (!delivery.storage_path) {
      return new NextResponse("File not in storage — try the dashboard file browser", { status: 404 });
    }

    // Download from Supabase Storage
    const { data, error } = await supabase.storage
      .from("delivered-files")
      .download(delivery.storage_path);

    if (error || !data) {
      return new NextResponse("File not available", { status: 404 });
    }

    const buf = Buffer.from(await data.arrayBuffer());

    return new NextResponse(buf, {
      headers: {
        "Content-Type": delivery.mime_type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${delivery.filename}"`,
        "Content-Length": String(buf.length),
      },
    });
  } catch (err) {
    console.error("Delivery download error:", err);
    return new NextResponse("Download failed", { status: 500 });
  }
}
