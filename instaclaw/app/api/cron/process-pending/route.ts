import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { sendVMReadyEmail } from "@/lib/email";

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get pending users ordered by creation date
  const { data: pending } = await supabase
    .from("instaclaw_pending_users")
    .select("*, instaclaw_users!inner(email)")
    .order("created_at", { ascending: true })
    .limit(10);

  if (!pending?.length) {
    return NextResponse.json({ processed: 0 });
  }

  let assigned = 0;

  for (const p of pending) {
    // Try to assign a VM
    const { data: vm } = await supabase.rpc("instaclaw_assign_vm", {
      p_user_id: p.user_id,
    });

    if (!vm) break; // No more VMs available

    // Trigger VM configuration
    try {
      await fetch(`${process.env.NEXTAUTH_URL}/api/vm/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: p.user_id }),
      });

      // Send notification email
      const userEmail = (p as Record<string, unknown>).instaclaw_users as { email: string };
      if (userEmail?.email) {
        await sendVMReadyEmail(
          userEmail.email,
          `${process.env.NEXTAUTH_URL}/dashboard`
        );
      }

      assigned++;
    } catch (err) {
      console.error(`Failed to configure VM for user ${p.user_id}:`, err);
    }
  }

  return NextResponse.json({
    pending: pending.length,
    assigned,
  });
}
