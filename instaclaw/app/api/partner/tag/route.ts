/**
 * POST /api/partner/tag
 *
 * Tags a user's account as belonging to a partner program (Edge City, Eclipse, etc.).
 *
 * Two paths:
 *   1. Logged-in user → update `instaclaw_users.partner` on their existing
 *      record + sync `instaclaw_vms.partner` for any VMs assigned to them.
 *      (Idempotent — only writes if value differs from current.)
 *   2. Not logged in → set the `instaclaw_partner` cookie so the next
 *      Google OAuth signup picks it up via lib/auth.ts:79 and tags the
 *      newly-created user record.
 *
 * Either way, the cookie is set as a defensive fallback. The endpoint is
 * generic and works for any partner string in VALID_PARTNERS — adding
 * a new partner (e.g. "eclipse") is a one-line change to the allow-list.
 *
 * Origin of bug: prior to this endpoint, /edge-city only set the cookie
 * (read at user creation in lib/auth.ts). Existing users who later visited
 * the partner portal got the cookie but their existing user record never
 * got tagged — leading to dual-account states where the partner-tagged
 * record had no VM and the working VM had an untagged user.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

const VALID_PARTNERS = new Set(["edge_city", "consensus_2026"]);
const PARTNER_COOKIE = "instaclaw_partner";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days — survives OAuth round-trip

function withPartnerCookie(res: NextResponse, partner: string): NextResponse {
  res.cookies.set(PARTNER_COOKIE, partner, {
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
  });
  return res;
}

export async function POST(req: NextRequest) {
  let partner: string;
  try {
    const body = await req.json();
    partner = body?.partner;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof partner !== "string" || !VALID_PARTNERS.has(partner)) {
    return NextResponse.json(
      { error: "Invalid partner", validPartners: [...VALID_PARTNERS] },
      { status: 400 }
    );
  }

  const session = await auth();

  if (!session?.user?.id) {
    // Not logged in — set the cookie so the next Google OAuth signup
    // picks it up in lib/auth.ts:79 and tags the new user record.
    return withPartnerCookie(
      NextResponse.json({
        tagged: false,
        reason: "not_authenticated",
        redirect_to: "/signup",
      }),
      partner
    );
  }

  const supabase = getSupabase();
  const userId = session.user.id;

  // Idempotent user update — skip the write if already tagged.
  const { data: user, error: userReadErr } = await supabase
    .from("instaclaw_users")
    .select("partner")
    .eq("id", userId)
    .single();

  if (userReadErr) {
    return NextResponse.json({ error: "User lookup failed" }, { status: 500 });
  }

  let userUpdated = false;
  if (user?.partner !== partner) {
    const { error } = await supabase
      .from("instaclaw_users")
      .update({ partner })
      .eq("id", userId);
    if (error) {
      return NextResponse.json({ error: "User update failed" }, { status: 500 });
    }
    userUpdated = true;
  }

  // Sync to any assigned VMs (idempotent).
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, partner")
    .eq("assigned_to", userId);

  let vmsUpdated = 0;
  for (const vm of vms ?? []) {
    if (vm.partner !== partner) {
      const { error } = await supabase
        .from("instaclaw_vms")
        .update({ partner })
        .eq("id", vm.id);
      if (!error) vmsUpdated++;
    }
  }

  // If the user already has a VM, send them to dashboard so they can see the
  // tag took effect. If not, send to signup/onboarding so they complete setup.
  const hasVm = (vms?.length ?? 0) > 0;

  // Defensive cookie set — covers re-auth edge cases where the user's
  // session ends and they sign in again on the same device.
  return withPartnerCookie(
    NextResponse.json({
      tagged: true,
      userUpdated,
      vmsUpdated,
      hasVm,
      redirect_to: hasVm ? "/dashboard" : "/signup",
    }),
    partner
  );
}
