import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * POST /api/google/pair
 *
 * Generates a 6-char pairing code for Google OAuth.
 * User opens instaclaw.io/g/<code> in their phone browser to complete OAuth.
 * Mini app polls /api/google/status until connected.
 */
export async function POST() {
  try {
    const session = await requireSession();
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // Delete any existing codes for this user first
    await supabase()
      .from("instaclaw_google_pairings")
      .delete()
      .eq("user_id", session.userId);

    // Insert new pairing code
    const { error } = await supabase()
      .from("instaclaw_google_pairings")
      .insert({
        code,
        user_id: session.userId,
        expires_at: expiresAt,
        used: false,
      });

    if (error) {
      console.error("[Google/Pair] Insert error:", error);
      return NextResponse.json({ error: "Failed to create pairing code" }, { status: 500 });
    }

    const baseUrl = process.env.INSTACLAW_API_URL || "https://instaclaw.io";

    return NextResponse.json({
      code,
      url: `${baseUrl}/g/${code}`,
      expiresIn: 600, // seconds
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to generate pairing code" }, { status: 500 });
  }
}
