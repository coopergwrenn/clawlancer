import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

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
    const refCode = (body.ref_code ?? "").trim().toLowerCase() || null;

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
        ...(refCode ? { ref_code: refCode } : {}),
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

    // If ref_code provided, create a referral tracking record for the ambassador
    if (refCode) {
      try {
        const { data: ambassador } = await supabase
          .from("instaclaw_ambassadors")
          .select("id")
          .eq("referral_code", refCode)
          .eq("status", "approved")
          .single();

        if (ambassador) {
          await supabase.from("instaclaw_ambassador_referrals").insert({
            ambassador_id: ambassador.id,
            ref_code: refCode,
            waitlisted_at: new Date().toISOString(),
          });
        }
      } catch (refErr) {
        // Non-critical — don't fail the waitlist signup
        logger.error("Failed to create referral record", { error: String(refErr), route: "waitlist" });
      }
    }

    return NextResponse.json({
      success: true,
      message: "Welcome to the waitlist!",
      position: inserted.position,
    });
  } catch (err) {
    logger.error("Waitlist error", { error: String(err), route: "waitlist" });
    return NextResponse.json(
      { success: false, message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
