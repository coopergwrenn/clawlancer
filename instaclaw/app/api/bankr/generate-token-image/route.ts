import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { generateTokenImage, uploadTokenImage, readAgentPersonality } from "@/lib/token-image";
import { logger } from "@/lib/logger";

// First call: SSH (~5-8s) + generation + upload = up to 15s
// Regen (personality_hash passed): generation + upload = ~3s
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  // Accept NextAuth session (web app) OR X-Mini-App-Token (World mini app)
  let userId: string | undefined;
  const session = await auth();
  if (session?.user?.id) {
    userId = session.user.id;
  } else {
    const { validateMiniAppToken } = await import("@/lib/security");
    const miniAppUserId = await validateMiniAppToken(req);
    if (miniAppUserId) userId = miniAppUserId;
  }
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.BANKR_TOKENIZE_ENABLED !== "true") {
    return NextResponse.json({ error: "Token launching is coming soon!" }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const tokenName = typeof body.token_name === "string" ? body.token_name.trim() : "";
  const variation = typeof body.variation === "number" ? body.variation : 0;
  // Cached personality hash sent back from the client after the first generate
  const cachedPersonalityHash =
    typeof body.personality_hash === "string" ? body.personality_hash : null;

  if (!tokenName) {
    return NextResponse.json({ error: "token_name is required" }, { status: 400 });
  }

  try {
    let personalityContext: string | null = null;
    let skippedSSH = false;
    let vmStatus = "not_checked";
    let sshDurationMs = 0;

    if (cachedPersonalityHash) {
      skippedSSH = true;
      vmStatus = "cached_hash_passed";
    } else {
      const supabase = getSupabase();
      const { data: vm, error: vmError } = await supabase
        .from("instaclaw_vms")
        .select("id, ip_address, ssh_port, ssh_user, status, assigned_to")
        .eq("assigned_to", userId)
        .single();

      if (vmError) {
        vmStatus = `db_error:${vmError.code ?? "unknown"}`;
        logger.warn("Token PFP: VM lookup failed", {
          userId,
          vmErrorCode: vmError.code,
          vmErrorMessage: vmError.message?.slice(0, 200),
        });
      } else if (!vm) {
        vmStatus = "no_vm_assigned";
        logger.warn("Token PFP: no VM assigned to user", { userId });
      } else if (!vm.ip_address) {
        vmStatus = `vm_no_ip:${vm.status ?? "unknown"}`;
        logger.warn("Token PFP: VM has no ip_address", {
          userId,
          vmId: vm.id,
          vmStatus: vm.status,
        });
      } else {
        const sshStart = Date.now();
        personalityContext = await readAgentPersonality(vm);
        sshDurationMs = Date.now() - sshStart;
        if (personalityContext) {
          vmStatus = `vm_ssh_ok:got_${personalityContext.length}chars`;
          logger.info("Token PFP: SSH read succeeded", {
            userId,
            vmId: vm.id,
            sshDurationMs,
            personalityLength: personalityContext.length,
          });
        } else {
          vmStatus = "vm_ssh_returned_null";
          logger.warn("Token PFP: SSH returned null personality (see prior warn log for cause)", {
            userId,
            vmId: vm.id,
            sshDurationMs,
          });
        }
      }
    }

    const { buffer: imageBuffer, personalityHashHex } = await generateTokenImage(tokenName, {
      personalityContext,
      personalityHashHex: cachedPersonalityHash,
      variation,
    });

    const imageUrl = await uploadTokenImage(imageBuffer, userId);

    logger.info("Token PFP generated", {
      userId,
      tokenName,
      variation,
      skippedSSH,
      vmStatus,
      sshDurationMs,
      hasPersonality: !!personalityContext,
      imageUrl,
    });

    return NextResponse.json({
      imageUrl,
      personalityHash: personalityHashHex,
      hasPersonality: !!personalityContext,
    });
  } catch (err) {
    logger.error("Token PFP generation failed", {
      error: String(err),
      userId,
      tokenName,
    });
    return NextResponse.json(
      { error: "Image generation failed — you can skip and add one later on Bankr" },
      { status: 500 }
    );
  }
}
