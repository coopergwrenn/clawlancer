import { NextRequest, NextResponse } from "next/server";
import { requireSession, signProxyToken } from "@/lib/auth";
import { supabase, getAgentStatus } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { reference, transactionId } = await req.json();

    // Verify via Dev Portal API
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

    // Find and update payment record
    const { data: payment, error: findErr } = await supabase()
      .from("instaclaw_world_payments")
      .select("*")
      .eq("reference", reference)
      .eq("user_id", session.userId)
      .eq("status", "pending")
      .single();

    if (findErr || !payment) {
      return NextResponse.json(
        { error: "Payment record not found" },
        { status: 404 }
      );
    }

    await supabase()
      .from("instaclaw_world_payments")
      .update({
        status: "confirmed",
        transaction_id: transactionId,
        transaction_hash: txData.transactionHash || transactionId,
        confirmed_at: new Date().toISOString(),
      })
      .eq("id", payment.id);

    // Add credits
    const agent = await getAgentStatus(session.userId);
    if (agent) {
      await supabase().rpc("instaclaw_add_credits", {
        p_vm_id: agent.id,
        p_credits: payment.credits,
      });

      // Fix C: wake the VM if it was hibernating after a credit reload.
      // instaclaw_add_credits only touches credit_balance — it has no idea
      // about gateway state. Without this, WLD users who topped up after
      // credit depletion stayed asleep indefinitely.
      // RCA: instaclaw/docs/wake-from-hibernation-bug-2026-05-02.md
      //
      // Best-effort: never fail the response if the wake fails. Credits
      // are already added; the defensive reconciler cron (Fix D) heals
      // any stranded VM within 15 min.
      try {
        const apiUrl = process.env.INSTACLAW_API_URL || "https://instaclaw.io";
        const proxyToken = await signProxyToken(session.userId);
        await fetch(`${apiUrl}/api/internal/wake-vm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Mini-App-Token": proxyToken,
          },
        }).catch(() => {});
      } catch (wakeErr) {
        console.error("pay/confirm: wake-vm call failed", wakeErr);
      }
    }

    const newBalance = agent
      ? (agent.credit_balance || 0) + payment.credits
      : payment.credits;

    return NextResponse.json({
      success: true,
      creditsAdded: payment.credits,
      newBalance,
    });
  } catch (err) {
    console.error("Pay confirm error:", err);
    return NextResponse.json(
      { error: "Failed to confirm payment" },
      { status: 500 }
    );
  }
}
