import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const { code } = await req.json();

    if (!code || typeof code !== "string") {
      return NextResponse.json(
        { valid: false, message: "Invite code is required." },
        { status: 400 }
      );
    }

    const normalized = code.trim().toUpperCase();

    // Format: XXXX-XXXX-XXXX
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalized)) {
      return NextResponse.json(
        { valid: false, message: "Invalid invite code format." },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    const { data: invite, error } = await supabase
      .from("instaclaw_invites")
      .select("id, code, max_uses, times_used, expires_at, is_active")
      .eq("code", normalized)
      .single();

    if (error || !invite) {
      return NextResponse.json(
        { valid: false, message: "Invite code not found." },
        { status: 404 }
      );
    }

    if (!invite.is_active) {
      return NextResponse.json(
        { valid: false, message: "This invite code has been deactivated." },
        { status: 410 }
      );
    }

    if (invite.times_used >= invite.max_uses) {
      return NextResponse.json(
        { valid: false, message: "This invite code has been fully used." },
        { status: 410 }
      );
    }

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return NextResponse.json(
        { valid: false, message: "This invite code has expired." },
        { status: 410 }
      );
    }

    return NextResponse.json({ valid: true, code: invite.code });
  } catch (err) {
    console.error("Invite validation error:", err);
    return NextResponse.json(
      { valid: false, message: "Something went wrong." },
      { status: 500 }
    );
  }
}
