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

/**
 * Live-events skills to auto-enable per partner.
 *
 * Both edge_city and consensus_2026 partners attend Consensus 2026 — they
 * get the matching skill turned on at tag time so the user doesn't have to
 * find the Skills page to discover it.
 *
 * For future conferences (Bitcoin 2026, Token2049, etc.) add a new partner
 * to VALID_PARTNERS and a new entry here.
 *
 * Auto-enable uses ignoreDuplicates: true on the upsert so it won't override
 * a user's explicit OFF choice. If they later disable the skill in the UI
 * and the partner is re-tagged (rare but possible), their preference wins.
 */
const PARTNER_LIVE_EVENT_SKILLS: Record<string, string[]> = {
  edge_city: ["consensus-2026"],
  consensus_2026: ["consensus-2026"],
};

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

  // ── Auto-enable live-events skills for this partner ──
  // Only fires for partners with a registered mapping. ignoreDuplicates:true
  // means we never overwrite an existing row, so a user who has explicitly
  // disabled the skill keeps it disabled even if their partner is re-tagged.
  // First-time partner tag → row doesn't exist → we insert enabled=true.
  let skillsEnabled = 0;
  const liveEventSlugs = PARTNER_LIVE_EVENT_SKILLS[partner] ?? [];
  if (liveEventSlugs.length > 0 && (vms?.length ?? 0) > 0) {
    // Resolve slugs → skill_ids. Single round trip.
    const { data: skills } = await supabase
      .from("instaclaw_skills")
      .select("id, slug")
      .in("slug", liveEventSlugs);
    if (skills && skills.length > 0) {
      const rows: Array<{ vm_id: string; skill_id: string; enabled: boolean }> = [];
      for (const vm of vms ?? []) {
        for (const skill of skills) {
          rows.push({
            vm_id: vm.id as string,
            skill_id: skill.id as string,
            enabled: true,
          });
        }
      }
      if (rows.length > 0) {
        const { error: skillErr, count } = await supabase
          .from("instaclaw_vm_skills")
          .upsert(rows, {
            onConflict: "vm_id,skill_id",
            ignoreDuplicates: true,
            count: "exact",
          });
        if (!skillErr) {
          skillsEnabled = count ?? 0;
        }
      }
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
      skillsEnabled,
      hasVm,
      redirect_to: hasVm ? "/dashboard" : "/signup",
    }),
    partner
  );
}
