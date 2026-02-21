import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/security";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

// Simple in-memory rate limiter for reveal endpoint
const revealCounts = new Map<string, { count: number; resetAt: number }>();

function checkRevealRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = revealCounts.get(userId);

  if (!entry || now > entry.resetAt) {
    revealCounts.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (entry.count >= 10) {
    return false;
  }

  entry.count++;
  return true;
}

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const name = req.nextUrl.searchParams.get("name");
    if (!name) {
      return NextResponse.json({ error: "name parameter required" }, { status: 400 });
    }

    // Rate limit
    if (!checkRevealRateLimit(session.user.id)) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Max 10 reveals per minute." },
        { status: 429 }
      );
    }

    const supabase = getSupabase();

    const { data: envVar } = await supabase
      .from("instaclaw_env_vars")
      .select("encrypted_value")
      .eq("user_id", session.user.id)
      .eq("var_name", name)
      .single();

    if (!envVar) {
      return NextResponse.json({ error: "Variable not found" }, { status: 404 });
    }

    // Decrypt
    const value = await decryptApiKey(envVar.encrypted_value);

    // Audit log
    await supabase.from("instaclaw_env_var_audit").insert({
      user_id: session.user.id,
      var_name: name,
      action: "reveal",
    });

    return NextResponse.json({ name, value });
  } catch (err) {
    logger.error("Env var reveal error", { error: String(err), route: "bot/env-vars/reveal" });
    return NextResponse.json(
      { error: "Failed to reveal variable" },
      { status: 500 }
    );
  }
}
