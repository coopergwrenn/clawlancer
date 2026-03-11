import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { verifyCloudProof, type IVerifyResponse } from "@worldcoin/idkit-core/backend";

// In-memory rate limiting: max 5 attempts per user per hour
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: Request) {
  try {
    const WORLD_APP_ID = process.env.WORLD_APP_ID;
    if (!WORLD_APP_ID) {
      return NextResponse.json(
        { error: "World ID verification not yet configured" },
        { status: 503 }
      );
    }

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    // Rate limiting
    const now = Date.now();
    const rl = rateLimitMap.get(userId);
    if (rl && now < rl.resetAt) {
      if (rl.count >= RATE_LIMIT_MAX) {
        return NextResponse.json(
          { error: "Too many verification attempts. Try again later." },
          { status: 429 }
        );
      }
      rl.count++;
    } else {
      rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    }

    const body = await req.json();
    const { merkle_root, nullifier_hash, proof, verification_level } = body;

    if (!merkle_root || !nullifier_hash || !proof) {
      return NextResponse.json(
        { error: "Missing required proof fields" },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    // Check if user is already verified
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("world_id_verified")
      .eq("id", userId)
      .single();

    if (user?.world_id_verified) {
      return NextResponse.json(
        { error: "Already verified" },
        { status: 409 }
      );
    }

    // Check if nullifier_hash is already linked to another user
    const { data: existing } = await supabase
      .from("instaclaw_users")
      .select("id")
      .eq("world_id_nullifier_hash", nullifier_hash)
      .single();

    if (existing && existing.id !== userId) {
      return NextResponse.json(
        { error: "This World ID is already linked to another account" },
        { status: 409 }
      );
    }

    // Verify proof with World ID cloud API via official SDK helper
    let verifyResult: IVerifyResponse;
    try {
      verifyResult = await verifyCloudProof(
        { merkle_root, nullifier_hash, proof, verification_level: verification_level ?? "orb" },
        WORLD_APP_ID as `app_${string}`,
        "verify-instaclaw-agent",
        userId
      );
    } catch (err) {
      logger.warn("World ID cloud verify call failed", {
        error: String(err),
        userId,
        route: "world-id/verify",
      });
      return NextResponse.json(
        { error: "Verification service temporarily unavailable" },
        { status: 503 }
      );
    }

    if (!verifyResult.success) {
      logger.warn("World ID verification failed", {
        code: verifyResult.code,
        detail: verifyResult.detail,
        userId,
        route: "world-id/verify",
      });
      return NextResponse.json(
        { error: verifyResult.detail ?? "Verification failed" },
        { status: 400 }
      );
    }

    // Update user record
    const { error: updateError } = await supabase
      .from("instaclaw_users")
      .update({
        world_id_verified: true,
        world_id_nullifier_hash: nullifier_hash,
        world_id_verified_at: new Date().toISOString(),
        world_id_verification_level: verification_level ?? "orb",
      })
      .eq("id", userId);

    if (updateError) {
      logger.error("Failed to update World ID verification", {
        error: String(updateError),
        userId,
        route: "world-id/verify",
      });
      return NextResponse.json(
        { error: "Failed to save verification" },
        { status: 500 }
      );
    }

    logger.info("World ID verification successful", {
      userId,
      verification_level: verification_level ?? "orb",
      route: "world-id/verify",
    });

    // Propagate verification to the agent's VM system prompt (fire and forget)
    propagateVerificationToVM(userId, supabase).catch((err) =>
      logger.warn("Failed to propagate World ID to VM (non-fatal)", {
        error: String(err),
        userId,
        route: "world-id/verify",
      })
    );

    // Propagate to Clawlancer agents table (fire and forget)
    propagateVerificationToAgent(userId, supabase).catch((err) =>
      logger.warn("Failed to propagate World ID to agent (non-fatal)", {
        error: String(err),
        userId,
        route: "world-id/verify",
      })
    );

    // Auto-trigger AgentBook registration if VM hasn't registered yet (fire and forget)
    triggerAgentBookRegistration(userId, supabase).catch((err) =>
      logger.warn("Failed to trigger AgentBook registration (non-fatal)", {
        error: String(err),
        userId,
        route: "world-id/verify",
      })
    );

    return NextResponse.json({
      verified: true,
      verification_level: verification_level ?? "orb",
    });
  } catch (err) {
    logger.error("World ID verify error", {
      error: String(err),
      route: "world-id/verify",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * After successful verification, append a World ID identity block
 * to the agent's system prompt on the VM so other agents and platforms
 * can see this agent is backed by a verified human.
 */
async function propagateVerificationToVM(
  userId: string,
  supabase: ReturnType<typeof getSupabase>
) {
  // Get user's VM
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, system_prompt")
    .eq("assigned_to", userId)
    .single();

  if (!vm) return; // No VM deployed yet — nothing to push

  const { updateSystemPrompt } = await import("@/lib/ssh");

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

  // Don't append if already present
  if (currentPrompt.includes("## World ID Verified")) return;

  const newPrompt = currentPrompt + verifiedBlock;

  await updateSystemPrompt(vm, newPrompt);

  // Update DB to match
  await supabase
    .from("instaclaw_vms")
    .update({ system_prompt: newPrompt })
    .eq("id", vm.id);
}

/**
 * Mark the user's Clawlancer agent(s) as World ID verified
 * so the badge shows on public agent profiles.
 * Rule #3: propagation via runtime API call, never direct DB write.
 */
async function propagateVerificationToAgent(
  userId: string,
  supabase: ReturnType<typeof getSupabase>
) {
  const adminKey = process.env.CLAWLANCER_ADMIN_KEY;
  if (!adminKey) return; // No admin key — skip propagation

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

const AGENTBOOK_PROMPT_MESSAGE = `🌐 New feature: Your agent can now register in the World AgentBook — an on-chain registry that proves a real human operates this agent.

This gives your agent a verified trust signal that other agents and services can check. Registration is free (no gas fees).

Type "register agentbook" to get started.`;

/**
 * After World ID verification, auto-trigger AgentBook registration prompt
 * on the user's VM if it hasn't registered yet. This eliminates the need
 * for users to manually type "register agentbook".
 */
async function triggerAgentBookRegistration(
  userId: string,
  supabase: ReturnType<typeof getSupabase>
) {
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, name, telegram_bot_token, telegram_chat_id, agentbook_registered, agentbook_prompt_sent")
    .eq("assigned_to", userId)
    .single();

  if (!vm) return; // No VM assigned
  if (vm.agentbook_registered) return; // Already registered
  if (vm.agentbook_prompt_sent) return; // Already prompted
  if (!vm.telegram_bot_token || !vm.telegram_chat_id) return; // No Telegram

  // Send Telegram prompt
  const res = await fetch(
    `https://api.telegram.org/bot${vm.telegram_bot_token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: vm.telegram_chat_id,
        text: AGENTBOOK_PROMPT_MESSAGE,
        disable_web_page_preview: true,
      }),
    }
  );

  const result = await res.json();
  if (!result.ok) {
    logger.warn("AgentBook Telegram prompt failed", {
      vmName: vm.name,
      error: JSON.stringify(result.description ?? result),
      route: "world-id/verify",
    });
    return;
  }

  // Mark as prompted
  await supabase
    .from("instaclaw_vms")
    .update({ agentbook_prompt_sent: true })
    .eq("id", vm.id);

  logger.info("AgentBook registration auto-triggered after World ID verify", {
    vmName: vm.name,
    userId,
    route: "world-id/verify",
  });
}
