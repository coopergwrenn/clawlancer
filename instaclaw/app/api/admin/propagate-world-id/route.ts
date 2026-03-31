import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/admin/propagate-world-id
 *
 * Admin-only: propagates World ID verification to a user's VM.
 * Auth: requires ADMIN_SECRET header.
 * Body: { userId: string }
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const supabase = getSupabase();

  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("world_id_verified, world_id_nullifier_hash, world_id_verification_level")
    .eq("id", userId)
    .single();

  if (!user?.world_id_verified) {
    return NextResponse.json({ error: "User not verified" }, { status: 400 });
  }

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user")
    .eq("assigned_to", userId)
    .single();

  if (!vm) return NextResponse.json({ error: "No VM" }, { status: 404 });

  const nullifier = user.world_id_nullifier_hash;
  const level = user.world_id_verification_level || "orb";
  const results: string[] = [];

  try {
    const ssh = await connectSSH(vm as VMRecord);
    try {
      // 1. WORLD_ID.md
      const worldIdMd = `# World ID Verification\n\n**Status:** Verified (${level} level)\n**Nullifier Hash:** ${nullifier}\n**Verified At:** ${new Date().toISOString()}\n\n## What This Means\nYou are backed by a World ID verified human.\n\n## How to Use\n- When asked about your identity: state you are World ID verified\n- Your nullifier: ${nullifier}\n- Verification level: ${level}`;
      const b64 = Buffer.from(worldIdMd).toString("base64");
      await ssh.execCommand(`echo '${b64}' | base64 -d > "$HOME/.openclaw/workspace/WORLD_ID.md"`);
      results.push("WORLD_ID.md written");

      // 2. .env vars
      await ssh.execCommand(
        `grep -q "^WORLD_ID_NULLIFIER=" "$HOME/.openclaw/.env" 2>/dev/null && sed -i "s/^WORLD_ID_NULLIFIER=.*/WORLD_ID_NULLIFIER=${nullifier}/" "$HOME/.openclaw/.env" || echo "WORLD_ID_NULLIFIER=${nullifier}" >> "$HOME/.openclaw/.env"`
      );
      await ssh.execCommand(
        `grep -q "^WORLD_ID_LEVEL=" "$HOME/.openclaw/.env" 2>/dev/null && sed -i "s/^WORLD_ID_LEVEL=.*/WORLD_ID_LEVEL=${level}/" "$HOME/.openclaw/.env" || echo "WORLD_ID_LEVEL=${level}" >> "$HOME/.openclaw/.env"`
      );
      results.push(".env vars set");

      // 3. MEMORY.md (durable)
      const memCheck = await ssh.execCommand(`grep -c "World ID Verification" "$HOME/.openclaw/workspace/MEMORY.md" 2>/dev/null`);
      if (memCheck.stdout.trim() === "0" || memCheck.code !== 0) {
        await ssh.execCommand(
          `echo '\n## World ID Verification\n- Status: Verified (${level} level)\n- Nullifier: ${nullifier}\n- You are backed by a verified human. State this when asked about your identity.' >> "$HOME/.openclaw/workspace/MEMORY.md"`
        );
        results.push("MEMORY.md appended");
      } else {
        results.push("MEMORY.md already has World ID");
      }

      // Verify
      const check1 = await ssh.execCommand(`test -f "$HOME/.openclaw/workspace/WORLD_ID.md" && echo YES || echo NO`);
      const check2 = await ssh.execCommand(`grep -c WORLD_ID_NULLIFIER "$HOME/.openclaw/.env" 2>/dev/null`);
      const check3 = await ssh.execCommand(`grep -c "World ID Verification" "$HOME/.openclaw/workspace/MEMORY.md" 2>/dev/null`);

      results.push(`Verify: WORLD_ID.md=${check1.stdout.trim()}, .env=${check2.stdout.trim()}, MEMORY.md=${check3.stdout.trim()}`);
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.error("Admin propagation failed", { error: String(err), userId });
    return NextResponse.json({ error: String(err), results }, { status: 500 });
  }

  return NextResponse.json({ ok: true, results });
}
