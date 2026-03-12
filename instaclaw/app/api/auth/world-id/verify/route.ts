import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// In-memory rate limiting: max 5 attempts per user per hour
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: Request) {
  try {
    const RP_ID = process.env.RP_ID?.trim();
    if (!RP_ID) {
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

    // Accept the full IDKit result payload from the frontend
    const body = await req.json();

    // v4 format: { protocol_version, nonce, action, environment, responses: [...] }
    // v3 fallback: { merkle_root, nullifier_hash, proof, verification_level }
    const isV4 = body.protocol_version === "4.0";

    // Extract nullifier for uniqueness check
    let nullifier_hash: string | null = null;
    let verification_level: string = "orb";

    if (isV4) {
      const firstResponse = body.responses?.[0];
      if (!firstResponse?.nullifier || !firstResponse?.proof) {
        return NextResponse.json(
          { error: "Missing required proof fields" },
          { status: 400 }
        );
      }
      nullifier_hash = firstResponse.nullifier;
      verification_level = firstResponse.identifier ?? "orb";
    } else {
      // Legacy v3 format
      if (!body.merkle_root || !body.nullifier_hash || !body.proof) {
        return NextResponse.json(
          { error: "Missing required proof fields" },
          { status: 400 }
        );
      }
      nullifier_hash = body.nullifier_hash;
      verification_level = body.verification_level ?? "orb";
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

    // Check if nullifier is already linked to another user
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

    // Verify proof with World ID v4 API
    let verifySuccess = false;
    let verifyDetail: string | null = null;
    try {
      const verifyRes = await fetch(
        `https://developer.world.org/api/v4/verify/${RP_ID}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const verifyResult = await verifyRes.json();

      if (verifyRes.ok && verifyResult.success) {
        verifySuccess = true;
        // Use the nullifier from the verified response if available
        if (verifyResult.nullifier) {
          nullifier_hash = verifyResult.nullifier;
        }
      } else {
        verifyDetail = verifyResult.detail ?? "Verification failed";
        logger.warn("World ID v4 verification failed", {
          code: verifyResult.code,
          detail: verifyDetail,
          status: verifyRes.status,
          userId,
          route: "world-id/verify",
        });
      }
    } catch (err) {
      logger.warn("World ID v4 verify call failed", {
        error: String(err),
        userId,
        route: "world-id/verify",
      });
      return NextResponse.json(
        { error: "Verification service temporarily unavailable" },
        { status: 503 }
      );
    }

    if (!verifySuccess) {
      return NextResponse.json(
        { error: verifyDetail ?? "Verification failed" },
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

    // Fetch AgentBook pre-requisites for the response (Phase 2)
    let agentbook: { walletAddress: string | null; nonce: string | null; alreadyRegistered: boolean } | null = null;
    try {
      const { data: vmData } = await supabase
        .from("instaclaw_vms")
        .select("wallet_address, agentbook_registered")
        .eq("assigned_to", userId)
        .single();

      if (vmData?.wallet_address) {
        const { getNextNonce, isAgentRegistered } = await import("@/lib/agentbook");
        const alreadyRegistered = vmData.agentbook_registered || await isAgentRegistered(vmData.wallet_address);
        let nonce: string | null = null;
        if (!alreadyRegistered) {
          const n = await getNextNonce(vmData.wallet_address);
          nonce = n.toString();
        }
        agentbook = {
          walletAddress: vmData.wallet_address,
          nonce,
          alreadyRegistered,
        };
      }
    } catch {
      // Non-fatal — AgentBook data is optional
    }

    return NextResponse.json({
      verified: true,
      verification_level,
      ...(agentbook ? { agentbook } : {}),
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
