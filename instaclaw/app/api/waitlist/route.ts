import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + "instaclaw-salt");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.email ?? "").trim().toLowerCase();
    const source = body.source ?? "landing";

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json(
        { success: false, message: "Invalid email address." },
        { status: 400 }
      );
    }

    // Hash IP for privacy-safe rate limiting
    const forwarded = req.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim() ?? "unknown";
    const ipHash = await hashIP(ip);

    // Rate limit: 5 requests per IP per minute
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const supabase = getSupabase();

    const { count } = await supabase
      .from("instaclaw_waitlist")
      .select("*", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", oneMinuteAgo);

    if (count !== null && count >= 5) {
      return NextResponse.json(
        { success: false, message: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    // Check for duplicate email
    const { data: existing } = await supabase
      .from("instaclaw_waitlist")
      .select("position")
      .ilike("email", email)
      .single();

    if (existing) {
      return NextResponse.json({
        success: true,
        message: "You're already on the list!",
        position: existing.position,
      });
    }

    // Insert new entry (position auto-assigned by trigger)
    const { data: inserted, error } = await supabase
      .from("instaclaw_waitlist")
      .insert({
        email,
        source,
        referrer: req.headers.get("referer") ?? null,
        ip_hash: ipHash,
      })
      .select("position")
      .single();

    if (error) {
      // Unique constraint violation = duplicate (race condition)
      if (error.code === "23505") {
        const { data: dup } = await supabase
          .from("instaclaw_waitlist")
          .select("position")
          .ilike("email", email)
          .single();

        return NextResponse.json({
          success: true,
          message: "You're already on the list!",
          position: dup?.position,
        });
      }
      throw error;
    }

    return NextResponse.json({
      success: true,
      message: "Welcome to the waitlist!",
      position: inserted.position,
    });
  } catch (err) {
    console.error("Waitlist error:", err);
    return NextResponse.json(
      { success: false, message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
