import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { walletAddress, applicationText, socialHandles } = body;

  // Validation
  if (!walletAddress || typeof walletAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return NextResponse.json({ error: "Valid wallet address required (0x...)" }, { status: 400 });
  }
  if (!applicationText || typeof applicationText !== "string" || applicationText.trim().length < 20) {
    return NextResponse.json({ error: "Application text must be at least 20 characters" }, { status: 400 });
  }
  if (applicationText.length > 2000) {
    return NextResponse.json({ error: "Application text must be under 2000 characters" }, { status: 400 });
  }

  // Sanitize social handles
  const handles: Record<string, string> = {};
  for (const key of ["twitter", "instagram", "tiktok", "youtube"]) {
    const val = socialHandles?.[key];
    if (val && typeof val === "string" && val.trim()) {
      handles[key] = val.trim().slice(0, 100);
    }
  }

  const supabase = getSupabase();

  // Check if user already applied
  const { data: existing } = await supabase
    .from("instaclaw_ambassadors")
    .select("id, status")
    .eq("user_id", session.user.id)
    .single();

  if (existing) {
    return NextResponse.json(
      { error: `You already have an application (status: ${existing.status})` },
      { status: 409 }
    );
  }

  const { data, error } = await supabase
    .from("instaclaw_ambassadors")
    .insert({
      user_id: session.user.id,
      wallet_address: walletAddress,
      ambassador_name: session.user.name || session.user.email?.split("@")[0] || "Ambassador",
      application_text: applicationText.trim(),
      social_handles: handles,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Application already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ambassador: data });
}
