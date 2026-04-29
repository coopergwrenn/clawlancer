import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

const ALLOWED_SOURCES = new Set(["banner", "edge_city"]);

export async function POST(req: NextRequest) {
  try {
    const { email, source } = await req.json();

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    const safeSource =
      typeof source === "string" && ALLOWED_SOURCES.has(source)
        ? source
        : "banner";

    const supabase = getSupabase();

    // Upsert — if email already exists, just succeed silently
    const { error } = await supabase
      .from("instaclaw_notification_signups")
      .upsert(
        { email: email.toLowerCase().trim(), source: safeSource },
        { onConflict: "email" }
      );

    if (error) {
      console.error("notify signup error:", error);
      return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

    const supabase = getSupabase();
    await supabase
      .from("instaclaw_notification_signups")
      .update({ discord_clicked: true })
      .eq("email", email.toLowerCase().trim());

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
