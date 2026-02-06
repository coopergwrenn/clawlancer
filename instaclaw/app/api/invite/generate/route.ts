import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { getSupabase } from "@/lib/supabase";

// Characters that avoid 0/O, 1/I confusion
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const parts: string[] = [];
  for (let p = 0; p < 3; p++) {
    let segment = "";
    for (let i = 0; i < 4; i++) {
      segment += CHARS[Math.floor(Math.random() * CHARS.length)];
    }
    parts.push(segment);
  }
  return parts.join("-");
}

export async function GET() {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data: invites } = await supabase
    .from("instaclaw_invites")
    .select("*")
    .order("created_at", { ascending: false });

  return NextResponse.json({ invites: invites ?? [] });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { email, count = 1 } = await req.json();
  const supabase = getSupabase();
  const codes: string[] = [];

  const numToGenerate = Math.min(Math.max(1, count), 50);

  for (let i = 0; i < numToGenerate; i++) {
    const code = generateCode();
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    await supabase.from("instaclaw_invites").insert({
      code,
      email: i === 0 ? email ?? null : null,
      max_uses: 1,
      expires_at: expiresAt,
      created_by: session?.user?.email,
    });

    codes.push(code);
  }

  return NextResponse.json({ codes });
}
