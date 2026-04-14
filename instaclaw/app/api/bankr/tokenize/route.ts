import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

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
  // Accept NextAuth session (web app) OR X-Mini-App-Token (World mini app)
  let userId: string | undefined;
  const session = await auth();
  if (session?.user?.id) {
    userId = session.user.id;
  } else {
    const { validateMiniAppToken } = await import("@/lib/security");
    const miniAppUserId = await validateMiniAppToken(req);
    if (miniAppUserId) {
      userId = miniAppUserId;
    }
  }
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  // Look up user's VM with Bankr wallet
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, bankr_wallet_id, bankr_evm_address, bankr_token_address, tokenization_platform")
    .eq("assigned_to", userId)
    .single();

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
    feeRecipient: {
      type: "wallet",
      value: vm.bankr_evm_address,
    },
  };
  if (description) launchPayload.description = description;
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

  return NextResponse.json({
    success: true,
    tokenAddress: launchData.tokenAddress,
    tokenSymbol,
    poolId: launchData.poolId,
    txHash: launchData.txHash,
    chain: launchData.chain,
    feeDistribution: launchData.feeDistribution,
  });
}
