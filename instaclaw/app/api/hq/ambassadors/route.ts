import { NextRequest, NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

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

  // Compute stats
  const total = ambassadors?.length ?? 0;
  const approved = ambassadors?.filter((a) => a.status === "approved").length ?? 0;
  const pending = ambassadors?.filter((a) => a.status === "pending").length ?? 0;
  const totalReferrals = ambassadors?.reduce((sum, a) => sum + (a.referral_count ?? 0), 0) ?? 0;
  const totalEarnings = ambassadors?.reduce((sum, a) => sum + Number(a.earnings_total ?? 0), 0) ?? 0;

  return NextResponse.json({
    ambassadors: ambassadors ?? [],
    stats: { total, approved, pending, totalReferrals, totalEarnings },
  });
}

// ── POST: Approve, Reject, or Revoke ──
export async function POST(req: NextRequest) {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { action, ambassadorId } = body;

  if (!ambassadorId || !action) {
    return NextResponse.json({ error: "ambassadorId and action required" }, { status: 400 });
  }

  const supabase = getSupabase();

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

    return NextResponse.json({ success: true, ambassadorNumber: nextNumber, referralCode });
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
