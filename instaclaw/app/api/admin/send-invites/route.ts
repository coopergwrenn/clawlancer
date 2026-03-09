import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { getSupabase } from "@/lib/supabase";
import { sendInviteEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

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

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { count = 5 } = await req.json();
  const supabase = getSupabase();

  // Get next waitlist entries that haven't been invited
  const { data: entries } = await supabase
    .from("instaclaw_waitlist")
    .select("id, email, position, ref_code")
    .is("invite_sent_at", null)
    .order("position", { ascending: true })
    .limit(Math.min(count, 100));

  if (!entries?.length) {
    return NextResponse.json({ sent: 0, message: "No un-invited entries." });
  }

  let sent = 0;
  for (const entry of entries) {
    const code = generateCode();
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    // Create invite code
    await supabase.from("instaclaw_invites").insert({
      code,
      email: entry.email,
      max_uses: 1,
      expires_at: expiresAt,
      created_by: "admin-batch",
    });

    // Send email
    try {
      await sendInviteEmail(entry.email, code, entry.ref_code ?? undefined);

      // Update waitlist entry
      await supabase
        .from("instaclaw_waitlist")
        .update({
          invite_sent_at: new Date().toISOString(),
          invite_code: code,
        })
        .eq("id", entry.id);

      sent++;
    } catch (err) {
      logger.error("Failed to send invite", { error: String(err), route: "admin/send-invites", email: entry.email });
    }
  }

  return NextResponse.json({ sent, total: entries.length });
}
