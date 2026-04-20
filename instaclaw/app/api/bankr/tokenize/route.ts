import { NextRequest, NextResponse, after } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { connectSSH } from "@/lib/ssh";
import type { VMRecord } from "@/lib/ssh";

// Token launches are synchronous on Bankr's side. 30s is plenty of headroom.
export const maxDuration = 30;

const BANKR_API_URL = "https://api.bankr.bot";

interface BankrLaunchResponse {
  success?: boolean;
  simulated?: boolean;
  tokenAddress?: string;
  poolId?: string;
  txHash?: string;
  activityId?: string;
  chain?: string;
  feeDistribution?: Record<string, { address: string; bps: number }>;
  error?: string;
}

export async function POST(req: NextRequest) {
  const DIAG_ID = Math.random().toString(36).slice(2, 10);
  try {
  logger.info("tokenize:start", { diagId: DIAG_ID });
  // Accept NextAuth session (web app) OR X-Mini-App-Token (World mini app)
  let userId: string | undefined;
  let authStage = "auth_start";
  try {
    const session = await auth();
    authStage = "auth_returned";
    if (session?.user?.id) {
      userId = session.user.id;
      authStage = "nextauth_ok";
    } else {
      const { validateMiniAppToken } = await import("@/lib/security");
      const miniAppUserId = await validateMiniAppToken(req);
      if (miniAppUserId) {
        userId = miniAppUserId;
        authStage = "miniapp_ok";
      }
    }
  } catch (authErr) {
    logger.error("tokenize:auth_threw", {
      diagId: DIAG_ID,
      authStage,
      error: String(authErr),
      stack: authErr instanceof Error ? authErr.stack?.slice(0, 500) : undefined,
    });
    return NextResponse.json({ error: "Auth check failed", diagId: DIAG_ID }, { status: 500 });
  }
  logger.info("tokenize:auth_done", { diagId: DIAG_ID, authStage, hasUserId: !!userId });
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Hard block: tokenization disabled until prod Bankr org is set up.
  // Set BANKR_TOKENIZE_ENABLED=true on Vercel to enable.
  if (process.env.BANKR_TOKENIZE_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Token launching is coming soon! Stay tuned." },
      { status: 503 }
    );
  }

  const partnerKey = process.env.BANKR_PARTNER_KEY;
  if (!partnerKey) {
    logger.error("BANKR_PARTNER_KEY not configured");
    return NextResponse.json({ error: "Token launches not configured" }, { status: 503 });
  }

  // Parse + validate input (length checks only — Bankr enforces the rest)
  const body = await req.json().catch(() => ({}));
  const tokenName = typeof body.token_name === "string" ? body.token_name.trim() : "";
  const tokenSymbol = typeof body.token_symbol === "string" ? body.token_symbol.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : undefined;
  const image = typeof body.image === "string" ? body.image.trim() : undefined;

  if (!tokenName || tokenName.length < 1 || tokenName.length > 100) {
    return NextResponse.json({ error: "Token name must be 1-100 characters" }, { status: 400 });
  }
  if (!tokenSymbol || tokenSymbol.length < 1 || tokenSymbol.length > 10) {
    return NextResponse.json({ error: "Token symbol must be 1-10 characters" }, { status: 400 });
  }
  if (description && description.length > 500) {
    return NextResponse.json({ error: "Description max 500 characters" }, { status: 400 });
  }

  const supabase = getSupabase();
  logger.info("tokenize:supabase_client_ok", { diagId: DIAG_ID });

  // Clear stale locks: if a previous launch attempt crashed mid-execution,
  // the lock stays as 'bankr_pending' forever. Auto-clear after 5 minutes.
  try {
    await supabase
      .from("instaclaw_vms")
      .update({ tokenization_platform: null, bankr_token_launched_at: null })
      .eq("assigned_to", userId)
      .eq("tokenization_platform", "bankr_pending")
      .is("bankr_token_address", null)
      .lt("bankr_token_launched_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());
  } catch (stErr) {
    logger.error("tokenize:stale_lock_clear_threw", { diagId: DIAG_ID, error: String(stErr) });
  }
  logger.info("tokenize:stale_lock_cleared", { diagId: DIAG_ID });

  // Look up user's VM with Bankr wallet
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("id, bankr_wallet_id, bankr_evm_address, bankr_token_address, tokenization_platform, ip_address, ssh_port, ssh_user")
    .eq("assigned_to", userId)
    .single();

  if (vmErr) {
    logger.error("tokenize:vm_lookup_err", {
      diagId: DIAG_ID,
      code: vmErr.code,
      message: vmErr.message?.slice(0, 300),
      details: vmErr.details?.slice(0, 300),
    });
  }
  logger.info("tokenize:vm_lookup_done", {
    diagId: DIAG_ID,
    hasVm: !!vm,
    vmId: vm?.id,
    hasWallet: !!vm?.bankr_wallet_id,
    hasEvm: !!vm?.bankr_evm_address,
    tokenizationPlatform: vm?.tokenization_platform,
    hasTokenAddr: !!vm?.bankr_token_address,
  });

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }

  if (!vm.bankr_wallet_id || !vm.bankr_evm_address) {
    return NextResponse.json({ error: "No Bankr wallet provisioned" }, { status: 400 });
  }

  // Cross-platform tokenization guard — only one platform allowed
  if (vm.tokenization_platform === "virtuals") {
    return NextResponse.json(
      { error: "Agent already tokenized on Virtuals Protocol. Only one tokenization platform is allowed per agent." },
      { status: 409 }
    );
  }

  if (vm.bankr_token_address || vm.tokenization_platform === "bankr") {
    return NextResponse.json({ error: "Agent already tokenized on Bankr" }, { status: 409 });
  }

  // SIMULATION MODE: Run the launch through Bankr's simulateOnly path.
  // Returns predicted tokenAddress without broadcasting on-chain. No DB state changes.
  // Controlled by env var so we can test in dev without making real tokens.
  const simulateOnly = process.env.BANKR_TOKEN_LAUNCH_SIMULATE === "true";

  // Atomic DB lock: only proceed if no other request has the lock.
  // We claim the lock by setting tokenization_platform = 'bankr_pending' in a single
  // UPDATE...WHERE...RETURNING. Either we get the row (lock acquired) or 0 rows
  // (someone else got it first). NO race condition possible.
  if (!simulateOnly) {
    const { data: locked, error: lockErr } = await supabase
      .from("instaclaw_vms")
      .update({
        tokenization_platform: "bankr_pending",
        bankr_token_launched_at: new Date().toISOString(),
      })
      .eq("id", vm.id)
      .is("tokenization_platform", null)
      .is("bankr_token_address", null)
      .select()
      .single();

    if (lockErr || !locked) {
      return NextResponse.json(
        { error: "Token launch already in progress for this agent" },
        { status: 409 }
      );
    }
  }

  // Call Bankr's token launch API
  // - Auth: X-Partner-Key (org-level deploy, our org wallet pays gas)
  // - feeRecipient: the user's own Bankr wallet (1a — agent owns its creator fees)
  // - Partner share (18.05%) routes automatically to our org's configured fee wallet
  const launchPayload: Record<string, unknown> = {
    tokenName,
    tokenSymbol,
    description: description ?? `AI agent token on InstaClaw. Trading fees fund autonomous compute.`,
    websiteUrl: "https://instaclaw.io",
    ...(image ? { image } : {}),
    feeRecipient: {
      type: "wallet",
      value: vm.bankr_evm_address,
    },
  };
  if (simulateOnly) launchPayload.simulateOnly = true;

  let launchData: BankrLaunchResponse;
  try {
    const launchRes = await fetch(`${BANKR_API_URL}/token-launches/deploy`, {
      method: "POST",
      headers: {
        "X-Partner-Key": partnerKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(launchPayload),
    });

    launchData = (await launchRes.json()) as BankrLaunchResponse;

    if (!launchRes.ok || !launchData.success) {
      logger.error("Bankr token launch failed", {
        status: launchRes.status,
        error: launchData.error ?? "unknown",
        userId: userId,
        vmId: vm.id,
        simulateOnly,
      });

      // Release the lock so the user can retry
      if (!simulateOnly) {
        await supabase
          .from("instaclaw_vms")
          .update({
            tokenization_platform: null,
            bankr_token_launched_at: null,
          })
          .eq("id", vm.id);
      }

      return NextResponse.json(
        { error: launchData.error ?? "Token launch failed", status: launchRes.status },
        { status: 502 }
      );
    }
  } catch (err) {
    logger.error("Bankr token launch network error", {
      error: String(err),
      userId: userId,
      vmId: vm.id,
    });

    // Release the lock
    if (!simulateOnly) {
      await supabase
        .from("instaclaw_vms")
        .update({
          tokenization_platform: null,
          bankr_token_launched_at: null,
        })
        .eq("id", vm.id);
    }

    return NextResponse.json({ error: "Network error contacting Bankr" }, { status: 502 });
  }

  // Simulation: return predicted result without DB state change
  if (simulateOnly) {
    logger.info("Bankr token launch simulated", {
      userId: userId,
      vmId: vm.id,
      predictedAddress: launchData.tokenAddress,
    });
    return NextResponse.json({
      simulated: true,
      tokenAddress: launchData.tokenAddress,
      tokenSymbol,
      feeDistribution: launchData.feeDistribution,
    });
  }

  // Real launch succeeded — finalize state
  const { error: finalizeErr } = await supabase
    .from("instaclaw_vms")
    .update({
      tokenization_platform: "bankr",
      bankr_token_address: launchData.tokenAddress,
      bankr_token_symbol: tokenSymbol,
      bankr_token_launched_at: new Date().toISOString(),
    })
    .eq("id", vm.id);

  if (finalizeErr) {
    // CRITICAL: Bankr launched the token but our DB update failed.
    // The token exists on-chain but our state is inconsistent. Log loudly so we
    // can manually reconcile. The user's tokenize button will look like it's
    // still in pending state, but the token is real.
    logger.error("CRITICAL: Bankr token launched but DB finalize failed", {
      userId: userId,
      vmId: vm.id,
      tokenAddress: launchData.tokenAddress,
      txHash: launchData.txHash,
      finalizeError: finalizeErr.message,
    });
    sendAdminAlertEmail(
      "CRITICAL: Bankr Token Launched But DB Save Failed",
      `Token was deployed on-chain but instaclaw_vms update failed.\n\nUser: ${userId}\nVM: ${vm.id}\nToken Address: ${launchData.tokenAddress}\nTx Hash: ${launchData.txHash}\nDB Error: ${finalizeErr.message}\n\nManual reconciliation needed: UPDATE instaclaw_vms SET bankr_token_address='${launchData.tokenAddress}', bankr_token_symbol='${tokenSymbol}', tokenization_platform='bankr', bankr_token_launched_at=NOW() WHERE id='${vm.id}';`
    ).catch(() => {});
    return NextResponse.json(
      {
        error: "Token launched but state save failed — contact support",
        tokenAddress: launchData.tokenAddress,
        txHash: launchData.txHash,
      },
      { status: 500 }
    );
  }

  logger.info("Bankr token launched successfully", {
    userId: userId,
    vmId: vm.id,
    tokenAddress: launchData.tokenAddress,
    poolId: launchData.poolId,
    txHash: launchData.txHash,
    feeRecipient: vm.bankr_evm_address,
  });

  const launchAlert = `User: ${userId}\nVM: ${vm.id}\nToken: $${tokenSymbol} (${tokenName})\nAddress: ${launchData.tokenAddress}\nTx: ${launchData.txHash}\n\nhttps://basescan.org/token/${launchData.tokenAddress}`;
  const launchSubject = `New Token Launched: $${tokenSymbol}`;
  sendAdminAlertEmail(launchSubject, launchAlert).catch(() => {});
  // Also notify Cooper's personal + instaclaw emails
  import("@/lib/email").then(({ sendCustomEmail }) => {
    const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#000;color:#fff;"><h1 style="font-size:24px;margin-bottom:16px;">${launchSubject}</h1><pre style="margin-top:16px;padding:16px;background:#0a0a0a;border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#ccc;white-space:pre-wrap;font-size:13px;">${launchAlert}</pre></div>`;
    sendCustomEmail("coopergrantwrenn@gmail.com", `[InstaClaw] ${launchSubject}`, html).catch(() => {});
    sendCustomEmail("coop@instaclaw.io", `[InstaClaw] ${launchSubject}`, html).catch(() => {});
  }).catch(() => {});

  // Background: SSH into VM and write token info to WALLET.md + MEMORY.md
  // Runs AFTER the response is sent — zero added latency for the user
  const tokenAddr = launchData.tokenAddress ?? "";
  after(async () => {
    if (!tokenAddr || !vm.ip_address) return;
    try {
      // Re-check VM ownership — if reassigned between response and after(), abort
      const { data: currentVm } = await getSupabase()
        .from("instaclaw_vms")
        .select("assigned_to")
        .eq("id", vm.id)
        .single();
      if (currentVm?.assigned_to !== userId) {
        logger.warn("VM reassigned before token info write — aborting", { vmId: vm.id, userId });
        return;
      }

      const ssh = await connectSSH(vm as unknown as VMRecord, { skipDuplicateIPCheck: true });
      try {
        const today = new Date().toISOString().split("T")[0];
        const walletSection = [
          "",
          "## Your Token",
          "",
          `- **Token:** $${tokenSymbol} (${tokenName})`,
          `- **Contract:** ${tokenAddr} (Base mainnet)`,
          "- **Trading:** Live on Uniswap V4",
          `- **BaseScan:** https://basescan.org/token/${tokenAddr}`,
          `- **Manage:** https://bankr.bot/launches/${tokenAddr}`,
          "",
          "### How Fees Work",
          "- 1.2% fee on every swap of your token",
          "- 57% of that fee (creator share) goes to YOUR Bankr wallet automatically",
          "- These fees can fund your compute credits over time",
          "- Check your earnings at the Bankr launches page above",
          "",
          "### Important",
          "- Your token is already live. Do NOT attempt to launch another token.",
          "- If users ask about your token, you can share the BaseScan or Bankr link.",
          "- Do not shill or spam about your token — only mention it when relevant.",
        ].join("\n");

        const memoryLine = `\n## ${today} — Token Launched\nLaunched $${tokenSymbol} token on Base (contract: ${tokenAddr}). See WALLET.md for details.\n`;

        const walletB64 = Buffer.from(walletSection, "utf-8").toString("base64");
        const memoryB64 = Buffer.from(memoryLine, "utf-8").toString("base64");

        // Append token section to WALLET.md (only if not already present)
        // Append memory entry to MEMORY.md
        await ssh.execCommand([
          `if ! grep -qF "## Your Token" "$HOME/.openclaw/workspace/WALLET.md" 2>/dev/null; then`,
          `  echo '${walletB64}' | base64 -d >> "$HOME/.openclaw/workspace/WALLET.md"`,
          `  echo "TOKEN_WALLET_WRITTEN"`,
          `fi`,
          `if ! grep -qF "Token Launched" "$HOME/.openclaw/workspace/MEMORY.md" 2>/dev/null; then`,
          `  echo '${memoryB64}' | base64 -d >> "$HOME/.openclaw/workspace/MEMORY.md"`,
          `  echo "TOKEN_MEMORY_WRITTEN"`,
          `fi`,
        ].join("\n"));

        logger.info("Token info written to VM workspace", {
          vmId: vm.id,
          tokenSymbol,
          tokenAddress: tokenAddr,
        });
      } finally {
        ssh.dispose();
      }
    } catch (err) {
      // Non-fatal — next reconfigure will include token info via the WALLET.md template
      logger.warn("Failed to write token info to VM (non-fatal)", {
        error: String(err),
        vmId: vm.id,
      });
    }
  });

  return NextResponse.json({
    success: true,
    tokenAddress: launchData.tokenAddress,
    tokenSymbol,
    poolId: launchData.poolId,
    txHash: launchData.txHash,
    chain: launchData.chain,
    feeDistribution: launchData.feeDistribution,
  });
  } catch (outerErr) {
    logger.error("tokenize:OUTER_UNHANDLED", {
      diagId: DIAG_ID,
      error: String(outerErr),
      name: outerErr instanceof Error ? outerErr.name : undefined,
      message: outerErr instanceof Error ? outerErr.message : undefined,
      stack: outerErr instanceof Error ? outerErr.stack?.slice(0, 1500) : undefined,
    });
    return NextResponse.json(
      { error: "Internal error — diagId " + DIAG_ID, diagId: DIAG_ID },
      { status: 500 }
    );
  }
}
