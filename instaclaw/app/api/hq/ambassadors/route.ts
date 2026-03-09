import { NextRequest, NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";
import { sendAmbassadorApprovedEmail, sendAmbassadorRejectedEmail } from "@/lib/email";
import { mintAmbassadorNFT } from "@/lib/ambassador-nft";

export const dynamic = "force-dynamic";
// Mint waits for on-chain confirmation (~2-4s on Base) + email send
export const maxDuration = 30;

// ── GET: List all ambassador applications ──
export async function GET() {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  const { data: ambassadors, error } = await supabase
    .from("instaclaw_ambassadors")
    .select("*, instaclaw_users(email, name)")
    .order("applied_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Fetch all referral records with referred user info
  const { data: allReferrals } = await supabase
    .from("instaclaw_ambassador_referrals")
    .select("*, instaclaw_users(email, name)")
    .order("created_at", { ascending: false });

  // Group referrals by ambassador_id
  const referralsByAmbassador: Record<string, typeof allReferrals> = {};
  for (const ref of allReferrals ?? []) {
    if (!referralsByAmbassador[ref.ambassador_id]) {
      referralsByAmbassador[ref.ambassador_id] = [];
    }
    referralsByAmbassador[ref.ambassador_id]!.push(ref);
  }

  // Compute per-ambassador referral stats
  const ambassadorsWithReferrals = (ambassadors ?? []).map((a) => {
    const refs = referralsByAmbassador[a.id] ?? [];
    return {
      ...a,
      referrals: refs,
      referral_stats: {
        waitlist_count: refs.filter((r) => r.waitlisted_at).length,
        signup_count: refs.filter((r) => r.signed_up_at).length,
        paid_count: refs.filter((r) => r.paid_at).length,
        pending_earnings: refs
          .filter((r) => r.commission_status === "pending")
          .reduce((sum, r) => sum + Number(r.commission_amount ?? 0), 0),
      },
    };
  });

  // Compute stats
  const total = ambassadors?.length ?? 0;
  const approved = ambassadors?.filter((a) => a.status === "approved").length ?? 0;
  const pending = ambassadors?.filter((a) => a.status === "pending").length ?? 0;
  const totalReferrals = ambassadors?.reduce((sum, a) => sum + (a.referral_count ?? 0), 0) ?? 0;
  const totalEarnings = ambassadors?.reduce((sum, a) => sum + Number(a.earnings_total ?? 0), 0) ?? 0;
  const totalPendingPayouts = (allReferrals ?? [])
    .filter((r) => r.commission_status === "pending")
    .reduce((sum, r) => sum + Number(r.commission_amount ?? 0), 0);

  return NextResponse.json({
    ambassadors: ambassadorsWithReferrals,
    stats: { total, approved, pending, totalReferrals, totalEarnings, totalPendingPayouts },
  });
}

// ── POST: Approve, Reject, or Revoke ──
export async function POST(req: NextRequest) {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { action, ambassadorId, referralId } = body;

  const supabase = getSupabase();

  // ── PAY COMMISSION (operates on referral row, not ambassador) ──
  if (action === "pay_commission" && referralId) {
    const { data: ref, error: refErr } = await supabase
      .from("instaclaw_ambassador_referrals")
      .select("id, commission_status, commission_amount")
      .eq("id", referralId)
      .single();

    if (refErr || !ref) {
      return NextResponse.json({ error: "Referral not found" }, { status: 404 });
    }
    if (ref.commission_status !== "pending") {
      return NextResponse.json({ error: `Cannot pay: status is ${ref.commission_status}` }, { status: 400 });
    }

    await supabase
      .from("instaclaw_ambassador_referrals")
      .update({
        commission_status: "paid",
        paid_out_at: new Date().toISOString(),
      })
      .eq("id", referralId);

    return NextResponse.json({ success: true });
  }

  if (!ambassadorId || !action) {
    return NextResponse.json({ error: "ambassadorId and action required" }, { status: 400 });
  }

  // Fetch the ambassador record
  const { data: ambassador, error: fetchErr } = await supabase
    .from("instaclaw_ambassadors")
    .select("*")
    .eq("id", ambassadorId)
    .single();

  if (fetchErr || !ambassador) {
    return NextResponse.json({ error: "Ambassador not found" }, { status: 404 });
  }

  // ── APPROVE ──
  if (action === "approve") {
    if (ambassador.status !== "pending") {
      return NextResponse.json({ error: `Cannot approve: status is ${ambassador.status}` }, { status: 400 });
    }

    // Get next sequential number
    const { data: maxRow } = await supabase
      .from("instaclaw_ambassadors")
      .select("ambassador_number")
      .not("ambassador_number", "is", null)
      .order("ambassador_number", { ascending: false })
      .limit(1)
      .single();

    const nextNumber = (maxRow?.ambassador_number ?? 0) + 1;

    // Generate referral code from name
    const namePart = (ambassador.ambassador_name || "ambassador")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12);
    const referralCode = `${namePart}-${nextNumber}`;

    const { error: updateErr } = await supabase
      .from("instaclaw_ambassadors")
      .update({
        status: "approved",
        ambassador_number: nextNumber,
        referral_code: referralCode,
        approved_at: new Date().toISOString(),
      })
      .eq("id", ambassadorId);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Mint soulbound NFT to ambassador's wallet
    let tokenId: number | null = null;
    let txHash: string | null = null;
    try {
      if (ambassador.wallet_address?.startsWith("0x")) {
        const mintResult = await mintAmbassadorNFT(
          ambassador.wallet_address,
          ambassador.ambassador_name || "Ambassador",
          nextNumber,
        );
        tokenId = mintResult.tokenId;
        txHash = mintResult.txHash;

        // Save token_id and minted_at to DB
        await supabase
          .from("instaclaw_ambassadors")
          .update({ token_id: tokenId, minted_at: new Date().toISOString() })
          .eq("id", ambassadorId);
      }
    } catch (mintErr) {
      // Don't fail the approval if mint fails — log and continue
      console.error("Failed to mint ambassador NFT:", mintErr);
    }

    // Send approval email with referral link
    try {
      const { data: user } = await supabase
        .from("instaclaw_users")
        .select("email")
        .eq("id", ambassador.user_id)
        .single();
      if (user?.email) {
        await sendAmbassadorApprovedEmail(
          user.email,
          ambassador.ambassador_name,
          referralCode,
          nextNumber,
        );
      }
    } catch (emailErr) {
      // Don't fail the approval if email fails — log and continue
      console.error("Failed to send ambassador approval email:", emailErr);
    }

    return NextResponse.json({ success: true, ambassadorNumber: nextNumber, referralCode, tokenId, txHash });
  }

  // ── REJECT ──
  if (action === "reject") {
    if (ambassador.status !== "pending") {
      return NextResponse.json({ error: `Cannot reject: status is ${ambassador.status}` }, { status: 400 });
    }

    const { error: updateErr } = await supabase
      .from("instaclaw_ambassadors")
      .update({ status: "rejected" })
      .eq("id", ambassadorId);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Send rejection email
    try {
      const { data: user } = await supabase
        .from("instaclaw_users")
        .select("email")
        .eq("id", ambassador.user_id)
        .single();
      if (user?.email) {
        await sendAmbassadorRejectedEmail(user.email, ambassador.ambassador_name);
      }
    } catch (emailErr) {
      console.error("Failed to send ambassador rejection email:", emailErr);
    }

    return NextResponse.json({ success: true });
  }

  // ── REVOKE ──
  if (action === "revoke") {
    if (ambassador.status !== "approved") {
      return NextResponse.json({ error: `Cannot revoke: status is ${ambassador.status}` }, { status: 400 });
    }

    const { error: updateErr } = await supabase
      .from("instaclaw_ambassadors")
      .update({
        status: "revoked",
        revoked_at: new Date().toISOString(),
      })
      .eq("id", ambassadorId);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
