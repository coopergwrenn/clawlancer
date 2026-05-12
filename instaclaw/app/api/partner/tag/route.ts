/**
 * POST /api/partner/tag
 *
 * Tags a user's account as belonging to a partner program (Edge City, Eclipse, etc.).
 *
 * Two paths:
 *   1. Logged-in user → applies partner via the shared tagUserAsPartner helper
 *      (updates instaclaw_users.partner, syncs instaclaw_vms.partner for any
 *      VMs assigned to them, auto-enables paired live-event skill). Idempotent.
 *   2. Not logged in → set the `instaclaw_partner` cookie so the next Google
 *      OAuth signin picks it up via lib/auth.ts signIn callback and applies the
 *      tag (whether the user is brand-new or already existed).
 *
 * Either way, the cookie is set as a defensive fallback. The endpoint is
 * generic and works for any partner string in VALID_PARTNERS — adding a new
 * partner (e.g. "eclipse") is a one-line change to lib/partner-tag.ts.
 *
 * History: the inline partner-tag logic used to live in this file. Extracted
 * to lib/partner-tag.ts on 2026-05-12 so lib/auth.ts signIn callback can apply
 * the same logic to existing users (Google-linked or wallet-only) signing in
 * with a partner cookie set — the missing path that allowed Timour Kosters's
 * 2026-04-30 dual-account state to occur.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { tagUserAsPartner, VALID_PARTNERS } from "@/lib/partner-tag";

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
    // Not logged in — set the cookie so the next Google OAuth signin picks
    // it up in lib/auth.ts and tags the user record. The signIn callback
    // applies the cookie whether the user is brand-new OR already exists
    // (the dual-account-bug fix landing 2026-05-12).
    return withPartnerCookie(
      NextResponse.json({
        tagged: false,
        reason: "not_authenticated",
        redirect_to: "/signup",
      }),
      partner
    );
  }

  // Logged-in path — call the shared helper. Same logic as lib/auth.ts signIn
  // callback uses for existing users with a partner cookie.
  const supabase = getSupabase();
  const result = await tagUserAsPartner(supabase, session.user.id, partner);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "tag failed" },
      { status: 500 }
    );
  }

  // If the user already has a VM, send them to dashboard so they can see the
  // tag took effect. If not, send to signup/onboarding so they complete setup.
  return withPartnerCookie(
    NextResponse.json({
      tagged: true,
      userUpdated: result.userUpdated,
      vmsUpdated: result.vmsUpdated,
      skillsEnabled: result.skillsEnabled,
      hasVm: result.hasVm,
      redirect_to: result.hasVm ? "/dashboard" : "/signup",
    }),
    partner
  );
}
