import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase, getAgentStatus } from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";

async function pollTransactionStatus(
  transactionId: string,
  appId: string,
  apiKey: string,
  maxAttempts = 5,
  delayMs = 2000
): Promise<{ status: string; hash?: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(
        `https://developer.worldcoin.org/api/v2/minikit/transaction/${transactionId}?app_id=${appId}&type=payment`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );

      if (res.ok) {
        const data = await res.json();
        console.log(`[Confirm] Poll attempt ${i + 1}: status=${data.transaction_status}`);
        if (data.transaction_status === "mined") {
          return { status: "mined", hash: data.transactionHash };
        }
        if (data.transaction_status === "failed") {
          return { status: "failed" };
        }
      } else {
        console.log(`[Confirm] Poll attempt ${i + 1}: HTTP ${res.status}`);
      }
    } catch (err) {
      console.log(`[Confirm] Poll attempt ${i + 1}: error`, err);
    }

    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { status: "pending" };
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { reference, transactionId, skipVerification } = await req.json();

    console.log("[Confirm] reference:", reference, "txId:", transactionId, "skip:", skipVerification);

    // Find the delegation record
    const { data: delegation, error: findErr } = await supabase()
      .from("instaclaw_wld_delegations")
      .select("*")
      .eq("transaction_id", reference)
      .eq("user_id", session.userId)
      .eq("status", "pending")
      .single();

    if (findErr || !delegation) {
      console.error("[Confirm] Delegation not found:", findErr);
      return NextResponse.json(
        { error: "Delegation record not found", detail: findErr?.message },
        { status: 404 }
      );
    }

    let txHash = transactionId;
    let onChainConfirmed = false;

    if (!skipVerification && transactionId) {
      // Poll for on-chain confirmation with retries
      const appId = process.env.NEXT_PUBLIC_APP_ID || "";
      const apiKey = process.env.DEV_PORTAL_API_KEY || "";

      const result = await pollTransactionStatus(transactionId, appId, apiKey);

      if (result.status === "mined") {
        onChainConfirmed = true;
        txHash = result.hash || transactionId;
      } else if (result.status === "failed") {
        return NextResponse.json(
          { error: "Transaction failed on-chain" },
          { status: 400 }
        );
      }
      // If still "pending" after retries, proceed anyway — MiniKit.pay() returned success
      // so World App accepted it. We'll verify asynchronously.
    }

    // Update delegation record
    await supabase()
      .from("instaclaw_wld_delegations")
      .update({
        status: onChainConfirmed ? "confirmed" : "pending_confirmation",
        transaction_hash: txHash,
        confirmed_at: new Date().toISOString(),
      })
      .eq("id", delegation.id);

    // Grant credits immediately — don't block on chain confirmation
    let agent = null;
    try {
      agent = await getAgentStatus(session.userId);
    } catch (err) {
      console.error("[Confirm] Agent lookup failed:", err);
    }

    if (agent) {
      // Direct update instead of RPC — more reliable
      try {
        const { error: creditErr } = await supabase()
          .from("instaclaw_vms")
          .update({ credit_balance: (agent.credit_balance || 0) + delegation.credits_granted })
          .eq("id", agent.id);
        if (creditErr) {
          console.error("[Confirm] Credit update failed:", creditErr);
        } else {
          console.log("[Confirm] Credits added:", delegation.credits_granted, "to vm:", agent.id, "new balance:", (agent.credit_balance || 0) + delegation.credits_granted);
        }

        // Also update delegation with vm_id
        await supabase()
          .from("instaclaw_wld_delegations")
          .update({ vm_id: agent.id })
          .eq("id", delegation.id);
      } catch (err) {
        console.error("[Confirm] Credit grant error:", err);
      }
    } else {
      // No agent yet — assign a VM from the pool, then configure it
      console.log("[Confirm] No agent found — assigning VM for user:", session.userId);
      try {
        // Step 1: Assign a VM
        const assignRes = await proxyToInstaclaw("/api/vm/assign", session.userId, {
          method: "POST",
          body: JSON.stringify({
            userId: session.userId,
            initialCredits: delegation.credits_granted,
          }),
        });
        const assignData = await assignRes.json().catch(() => ({}));
        console.log("[Confirm] VM assign result:", JSON.stringify(assignData));

        if (!assignData.assigned || !assignData.vm?.id) {
          console.error("[Confirm] VM assignment failed — no VMs available");
          return NextResponse.json(
            { error: "No agents available right now. Please try again later.", noVms: true },
            { status: 503 }
          );
        }

        // Step 2: Configure the assigned VM (await, don't fire-and-forget)
        try {
          const configRes = await proxyToInstaclaw("/api/vm/configure", session.userId, {
            method: "POST",
            body: JSON.stringify({ userId: session.userId }),
          });
          const configStatus = configRes.status;
          console.log("[Confirm] Configure returned:", configStatus);

          if (!configRes.ok) {
            console.error("[Confirm] Configure failed, but VM is assigned. Will retry on next health check.");
          }
        } catch (configErr) {
          console.error("[Confirm] Configure proxy error:", configErr);
          // VM is assigned but not configured — health check will retry
        }

        // Update delegation with vm_id
        await supabase()
          .from("instaclaw_wld_delegations")
          .update({ vm_id: assignData.vm.id })
          .eq("id", delegation.id);
      } catch (err) {
        console.error("[Confirm] VM assignment failed:", err);
        return NextResponse.json(
          { error: "VM assignment failed. Your WLD payment was received — contact support if your agent doesn't appear within 5 minutes." },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      creditsAdded: delegation.credits_granted,
      onChainConfirmed,
    });
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : JSON.stringify(err);
    console.error("[Confirm] Error:", msg);
    return NextResponse.json(
      { error: "Failed to confirm delegation", detail: msg },
      { status: 500 }
    );
  }
}
