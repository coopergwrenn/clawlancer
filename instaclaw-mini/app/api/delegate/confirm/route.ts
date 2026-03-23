import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase, getAgentStatus } from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { reference, transactionId } = await req.json();

    // Verify transaction via Dev Portal API
    const appId = process.env.NEXT_PUBLIC_APP_ID;
    const apiKey = process.env.DEV_PORTAL_API_KEY;

    const verifyRes = await fetch(
      `https://developer.worldcoin.org/api/v2/minikit/transaction/${transactionId}?app_id=${appId}&type=payment`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );

    if (!verifyRes.ok) {
      return NextResponse.json(
        { error: "Could not verify transaction" },
        { status: 400 }
      );
    }

    const txData = await verifyRes.json();
    if (txData.transaction_status !== "mined") {
      return NextResponse.json(
        { error: "Transaction not confirmed" },
        { status: 400 }
      );
    }

    // Update delegation record
    const { data: delegation, error: findErr } = await supabase()
      .from("instaclaw_wld_delegations")
      .select("*")
      .eq("transaction_id", reference)
      .eq("user_id", session.userId)
      .eq("status", "pending")
      .single();

    if (findErr || !delegation) {
      return NextResponse.json(
        { error: "Delegation record not found" },
        { status: 404 }
      );
    }

    await supabase()
      .from("instaclaw_wld_delegations")
      .update({
        status: "confirmed",
        transaction_hash: txData.transactionHash || transactionId,
        confirmed_at: new Date().toISOString(),
      })
      .eq("id", delegation.id);

    // Add credits to agent
    const agent = await getAgentStatus(session.userId);
    if (agent) {
      await supabase().rpc("instaclaw_add_credits", {
        p_vm_id: agent.id,
        p_credits: delegation.credits_granted,
      });
    } else {
      // No agent yet — trigger provisioning, credits will be added after
      proxyToInstaclaw("/api/vm/configure", session.userId, {
        method: "POST",
        body: JSON.stringify({
          userId: session.userId,
          initialCredits: delegation.credits_granted,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      creditsAdded: delegation.credits_granted,
    });
  } catch (err) {
    console.error("Delegate confirm error:", err);
    return NextResponse.json(
      { error: "Failed to confirm delegation" },
      { status: 500 }
    );
  }
}
