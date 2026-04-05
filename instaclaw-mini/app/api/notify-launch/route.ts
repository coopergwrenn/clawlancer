import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    // Upsert into waitlist — ignore if already exists
    await supabase()
      .from("instaclaw_waitlist")
      .upsert(
        { email: email.toLowerCase().trim(), source: "maintenance_gate" },
        { onConflict: "email" }
      );

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
