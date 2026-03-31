import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/auth/world-id/propagate
 *
 * After a mini app user verifies World ID, this endpoint propagates the
 * verification to the VM (system prompt, WORLD_ID.md, .env, gateway restart)
 * and to the Clawlancer marketplace (public badge).
 *
 * Accepts mini app proxy token OR NextAuth session.
 * Optionally stores the proof JSON if provided in the request body.
 *
 * Body (optional): { proofJson: object }
 */
export async function POST(req: NextRequest) {
  try {
    // Dual auth: NextAuth or mini app proxy token
    const session = await auth();
    let userId = session?.user?.id;
    if (!userId) {
      const { validateMiniAppToken } = await import("@/lib/security");
      userId = await validateMiniAppToken(req) ?? undefined;
    }
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Verify the user is actually World ID verified
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("world_id_verified, world_id_nullifier_hash, world_id_verification_level, wallet_address")
      .eq("id", userId)
      .single();

    if (!user?.world_id_verified) {
      return NextResponse.json({ error: "Not World ID verified" }, { status: 400 });
    }

    // Optionally store proof JSON if provided
    let body: { proofJson?: unknown } = {};
    try { body = await req.json(); } catch { /* no body */ }

    if (body.proofJson) {
      await supabase
        .from("instaclaw_users")
        .update({ world_id_proof_json: body.proofJson })
        .eq("id", userId);
    }

    const results = {
      vmPropagation: false,
      clawlancerSync: false,
      agentBookPrompt: false,
    };

    // ── 1. Propagate to VM ──
    try {
      await propagateVerificationToVM(userId, supabase);
      results.vmPropagation = true;
    } catch (err) {
      logger.error("VM propagation failed", { error: String(err), userId, route: "world-id/propagate" });
    }

    // ── 2. Propagate to Clawlancer marketplace ──
    try {
      await propagateVerificationToAgent(userId, supabase);
      results.clawlancerSync = true;
    } catch (err) {
      logger.error("Clawlancer sync failed", { error: String(err), userId, route: "world-id/propagate" });
    }

    // ── 3. Trigger AgentBook registration prompt ──
    try {
      await triggerAgentBookRegistration(userId, supabase);
      results.agentBookPrompt = true;
    } catch (err) {
      logger.error("AgentBook prompt failed", { error: String(err), userId, route: "world-id/propagate" });
    }

    logger.info("World ID propagation complete", { userId, results, route: "world-id/propagate" });

    return NextResponse.json({ propagated: true, ...results });
  } catch (err) {
    logger.error("World ID propagation error", { error: String(err), route: "world-id/propagate" });
    return NextResponse.json({ error: "Propagation failed" }, { status: 500 });
  }
}

// ── Propagation functions (copied from verify/route.ts to avoid circular deps) ──

async function propagateVerificationToVM(
  userId: string,
  supabase: ReturnType<typeof getSupabase>
) {
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, system_prompt")
    .eq("assigned_to", userId)
    .single();

  if (!vm) return;

  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("world_id_nullifier_hash, world_id_verification_level")
    .eq("id", userId)
    .single();

  const nullifier = user?.world_id_nullifier_hash ?? "unknown";
  const level = user?.world_id_verification_level ?? "orb";

  const { updateSystemPrompt, connectSSH } = await import("@/lib/ssh");

  // 1. Append World ID block to system prompt
  const verifiedBlock = [
    "",
    "---",
    "## World ID Verified",
    "This agent is operated by a World ID verified human (Orb level).",
    "Verification is privacy-preserving — no personal data is stored or shared.",
    "World ID verified agents are backed by a unique, real person.",
    "---",
  ].join("\n");

  const currentPrompt = vm.system_prompt ?? "";

  if (!currentPrompt.includes("## World ID Verified")) {
    const newPrompt = currentPrompt + verifiedBlock;
    await updateSystemPrompt(vm, newPrompt);
    await supabase
      .from("instaclaw_vms")
      .update({ system_prompt: newPrompt })
      .eq("id", vm.id);
  }

  // 2. Deploy WORLD_ID.md + nullifier to .env
  try {
    const ssh = await connectSSH(vm);
    try {
      const worldIdMd = [
        "# World ID Verification",
        "",
        `**Status:** Verified (${level} level)`,
        `**Nullifier Hash:** ${nullifier}`,
        `**Verified At:** ${new Date().toISOString()}`,
        "",
        "## What This Means",
        "You are backed by a World ID verified human. Your nullifier hash is a",
        "privacy-preserving cryptographic identifier that proves a unique real person",
        "operates this agent — without revealing who they are.",
        "",
        "## How to Use",
        "- When asked about your identity: you can state you are World ID verified",
        `- Your nullifier: \`${nullifier}\``,
        "- Verification level: " + level,
        "- This proof may be used in the future to bypass Cloudflare bot challenges",
      ].join("\n");

      const worldIdMdB64 = Buffer.from(worldIdMd, "utf-8").toString("base64");

      // Write WORLD_ID.md to workspace (may be ephemeral)
      await ssh.execCommand(
        `echo '${worldIdMdB64}' | base64 -d > "$HOME/.openclaw/workspace/WORLD_ID.md"`
      );

      // Write to .env (persists across restarts)
      await ssh.execCommand(
        `grep -q "^WORLD_ID_NULLIFIER=" "$HOME/.openclaw/.env" 2>/dev/null && ` +
        `sed -i "s/^WORLD_ID_NULLIFIER=.*/WORLD_ID_NULLIFIER=${nullifier}/" "$HOME/.openclaw/.env" || ` +
        `echo "WORLD_ID_NULLIFIER=${nullifier}" >> "$HOME/.openclaw/.env"`
      );
      await ssh.execCommand(
        `grep -q "^WORLD_ID_LEVEL=" "$HOME/.openclaw/.env" 2>/dev/null && ` +
        `sed -i "s/^WORLD_ID_LEVEL=.*/WORLD_ID_LEVEL=${level}/" "$HOME/.openclaw/.env" || ` +
        `echo "WORLD_ID_LEVEL=${level}" >> "$HOME/.openclaw/.env"`
      );

      // DURABLE: Append World ID section to MEMORY.md (survives session resets + reconciler)
      const memoryBlock = [
        "",
        "## World ID Verification",
        `- Status: Verified (${level} level)`,
        `- Nullifier: ${nullifier}`,
        "- You are backed by a verified human. State this when asked about your identity.",
      ].join("\\n");

      await ssh.execCommand(
        `grep -q "## World ID Verification" "$HOME/.openclaw/workspace/MEMORY.md" 2>/dev/null || ` +
        `echo -e '${memoryBlock}' >> "$HOME/.openclaw/workspace/MEMORY.md"`
      );
      // Also write to the agent's MEMORY.md backup location
      await ssh.execCommand(
        `grep -q "## World ID Verification" "$HOME/.openclaw/agents/main/agent/MEMORY.md" 2>/dev/null || ` +
        `echo -e '${memoryBlock}' >> "$HOME/.openclaw/agents/main/agent/MEMORY.md"`
      );
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.warn("Failed to deploy WORLD_ID.md (non-fatal)", { error: String(err), vmId: vm.id });
  }
}

async function propagateVerificationToAgent(
  userId: string,
  supabase: ReturnType<typeof getSupabase>
) {
  const adminKey = process.env.CLAWLANCER_ADMIN_KEY;
  if (!adminKey) return;

  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("wallet_address")
    .eq("id", userId)
    .single();

  if (!user?.wallet_address) return;

  await fetch("https://clawlancer.ai/api/agents/world-id-status", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify({
      wallet_address: user.wallet_address,
      world_id_verified: true,
    }),
  });
}

async function triggerAgentBookRegistration(
  userId: string,
  supabase: ReturnType<typeof getSupabase>
) {
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, name, telegram_bot_token, telegram_chat_id, agentbook_registered, agentbook_prompt_sent")
    .eq("assigned_to", userId)
    .single();

  if (!vm) return;
  if (vm.agentbook_registered) return;
  if (vm.agentbook_prompt_sent) return;
  if (!vm.telegram_bot_token || !vm.telegram_chat_id) return;

  const promptMessage = `🌐 New feature: Your agent can now register in the World AgentBook — an on-chain registry that proves a real human operates this agent.\n\nThis gives your agent a verified trust signal that other agents and services can check. Registration is free (no gas fees).\n\nType "register agentbook" to get started.`;

  const res = await fetch(
    `https://api.telegram.org/bot${vm.telegram_bot_token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: vm.telegram_chat_id,
        text: promptMessage,
        disable_web_page_preview: true,
      }),
    }
  );

  const result = await res.json();
  if (result.ok) {
    await supabase
      .from("instaclaw_vms")
      .update({ agentbook_prompt_sent: true })
      .eq("id", vm.id);
  }
}
