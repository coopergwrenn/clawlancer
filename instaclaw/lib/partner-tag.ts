/**
 * Shared partner-tag logic — applies `partner = "edge_city" | "consensus_2026"`
 * to an existing user, syncs the tag to their assigned VMs, and auto-enables
 * the partner's live-event skill.
 *
 * Two consumers:
 *   1. POST /api/partner/tag (the explicit endpoint — called when a user is
 *      already logged in and visits a partner portal page)
 *   2. lib/auth.ts signIn callback (called when a user signs in via Google
 *      with a `instaclaw_partner` cookie set from an earlier partner-portal
 *      visit while logged out)
 *
 * Before extraction (2026-05-12), this logic lived only in the route. The
 * signIn callback only read the partner cookie when CREATING a new user —
 * existing users (Google-linked or wallet-only-then-linking-Google) had their
 * cookie silently ignored. Result: the dual-account bug Timour Kosters reported
 * 2026-04-30 (CLAUDE.md Rule 9): user comes back to /edge while logged out,
 * cookie is set, they sign in with Google, their existing user record stays
 * untagged, and we end up with a half-populated dual-account state.
 *
 * The fix is to call this helper from BOTH consumers so the cookie consistently
 * propagates to user.partner + vms.partner regardless of how the user arrived.
 *
 * Semantics:
 *   - Allow-list validation (VALID_PARTNERS). Invalid value → no-op, error.
 *   - Idempotent user update — skip the write if user.partner already matches.
 *   - Per-VM idempotent sync — skip per-VM write if already matches; one bad
 *     VM doesn't abort the rest.
 *   - Auto-enable live-events skill via upsert with ignoreDuplicates:true so
 *     user OFF preferences are preserved.
 *   - Last-touch wins on partner overwrite: if user.partner=consensus_2026 and
 *     they click claim on /edge (cookie=edge_city), partner is overwritten to
 *     edge_city. Rationale: Consensus was past (May 5-7 2026), Edge is the
 *     active partner the user just chose. Per-VM partner mirrors this.
 *   - Errors don't throw — return { ok: false, error } so callers handle
 *     appropriately (route: return 500; auth callback: log + continue OAuth).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

/**
 * Partners we accept. Adding a new partner (e.g. "eclipse") is a one-line
 * change here + an entry in PARTNER_LIVE_EVENT_SKILLS if they have a paired
 * conference skill.
 */
export const VALID_PARTNERS = new Set<string>(["edge_city", "consensus_2026"]);

/**
 * Live-events skills to auto-enable per partner.
 *
 * Both edge_city and consensus_2026 attendees get the consensus-2026 skill
 * (Edge attendees frequently also attend Consensus). Upsert uses
 * ignoreDuplicates:true so a user who has explicitly disabled the skill keeps
 * it disabled even if their partner is re-tagged.
 */
export const PARTNER_LIVE_EVENT_SKILLS: Record<string, string[]> = {
  edge_city: ["consensus-2026"],
  consensus_2026: ["consensus-2026"],
};

export interface TagPartnerResult {
  /** Whether the operation completed without error. Helper never throws. */
  ok: boolean;
  /** Error string if !ok. Suitable for log lines, not user-facing copy. */
  error?: string;
  /** True if user.partner was actually written (false if already matched). */
  userUpdated: boolean;
  /** Number of VMs whose partner column was actually written. */
  vmsUpdated: number;
  /** Number of vm_skill rows inserted (excludes already-existing rows). */
  skillsEnabled: number;
  /** True if the user has any assigned VMs (used by /api/partner/tag to
   *  decide redirect destination: dashboard vs signup). */
  hasVm: boolean;
}

/**
 * Apply a partner tag to a user. Idempotent. Resilient to partial failure.
 *
 * @param supabase  Service-role Supabase client (from getSupabase())
 * @param userId    instaclaw_users.id of the user being tagged
 * @param partner   Partner slug; rejected if not in VALID_PARTNERS
 * @returns TagPartnerResult — counts + ok/error flag
 */
export async function tagUserAsPartner(
  supabase: SupabaseClient,
  userId: string,
  partner: string,
): Promise<TagPartnerResult> {
  // 1. Allow-list validation. Caller may pass cookie value; never trust it.
  if (!VALID_PARTNERS.has(partner)) {
    return {
      ok: false,
      error: `invalid partner: ${partner}`,
      userUpdated: false,
      vmsUpdated: 0,
      skillsEnabled: 0,
      hasVm: false,
    };
  }

  // 2. Idempotent user update — read partner first, only write if different.
  // Use .maybeSingle() — if the user row doesn't exist (rare race during user
  // creation), we get null instead of an error, and skip the rest.
  const { data: user, error: userReadErr } = await supabase
    .from("instaclaw_users")
    .select("partner")
    .eq("id", userId)
    .maybeSingle();

  if (userReadErr) {
    return {
      ok: false,
      error: `user lookup failed: ${userReadErr.message}`,
      userUpdated: false,
      vmsUpdated: 0,
      skillsEnabled: 0,
      hasVm: false,
    };
  }
  if (!user) {
    return {
      ok: false,
      error: `user not found: ${userId}`,
      userUpdated: false,
      vmsUpdated: 0,
      skillsEnabled: 0,
      hasVm: false,
    };
  }

  let userUpdated = false;
  if (user.partner !== partner) {
    const { error: updateErr } = await supabase
      .from("instaclaw_users")
      .update({ partner })
      .eq("id", userId);
    if (updateErr) {
      return {
        ok: false,
        error: `user update failed: ${updateErr.message}`,
        userUpdated: false,
        vmsUpdated: 0,
        skillsEnabled: 0,
        hasVm: false,
      };
    }
    userUpdated = true;
  }

  // 3. Sync to assigned VMs. Per-VM error tolerance — one bad VM doesn't
  //    abort the rest. Mirrors the existing /api/partner/tag loop pattern.
  const { data: vms, error: vmReadErr } = await supabase
    .from("instaclaw_vms")
    .select("id, partner")
    .eq("assigned_to", userId);

  // VM read failure is non-fatal — we already updated the user. Log and
  // continue. The user.partner is the source of truth; configureOpenClaw
  // reads it at provision time, so a missed VM sync self-heals on next
  // reconcile.
  if (vmReadErr) {
    logger.warn("partner-tag: VM lookup failed (non-fatal)", {
      userId,
      partner,
      error: String(vmReadErr.message),
    });
  }

  let vmsUpdated = 0;
  for (const vm of vms ?? []) {
    if (vm.partner !== partner) {
      const { error: vmUpdateErr } = await supabase
        .from("instaclaw_vms")
        .update({ partner })
        .eq("id", vm.id);
      if (!vmUpdateErr) {
        vmsUpdated++;
      } else {
        logger.warn("partner-tag: VM update failed (continuing)", {
          userId,
          partner,
          vmId: vm.id,
          error: String(vmUpdateErr.message),
        });
      }
    }
  }

  // 4. Auto-enable live-events skills. Only fires for partners with a
  //    registered mapping. ignoreDuplicates:true means we never overwrite an
  //    existing row, so a user who explicitly disabled the skill keeps it off
  //    even if their partner is re-tagged.
  let skillsEnabled = 0;
  const liveEventSlugs = PARTNER_LIVE_EVENT_SKILLS[partner] ?? [];
  if (liveEventSlugs.length > 0 && (vms?.length ?? 0) > 0) {
    try {
      const { data: skills, error: skillReadErr } = await supabase
        .from("instaclaw_skills")
        .select("id, slug")
        .in("slug", liveEventSlugs);

      if (skillReadErr) {
        logger.warn("partner-tag: skill lookup failed (non-fatal)", {
          userId,
          partner,
          error: String(skillReadErr.message),
        });
      } else if (skills && skills.length > 0) {
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
          const { error: skillUpsertErr, count } = await supabase
            .from("instaclaw_vm_skills")
            .upsert(rows, {
              onConflict: "vm_id,skill_id",
              ignoreDuplicates: true,
              count: "exact",
            });
          if (!skillUpsertErr) {
            skillsEnabled = count ?? 0;
          } else {
            logger.warn("partner-tag: skill upsert failed (non-fatal)", {
              userId,
              partner,
              error: String(skillUpsertErr.message),
            });
          }
        }
      }
    } catch (skillErr) {
      // Defensive catch for any unexpected throw inside the skill block.
      // Partner+VM tag has already landed; we degrade gracefully.
      logger.warn("partner-tag: skill enablement threw (non-fatal)", {
        userId,
        partner,
        error: String(skillErr),
      });
    }
  }

  const hasVm = (vms?.length ?? 0) > 0;

  // 5. Telemetry — log a structured line on every successful tag application
  //    so we can grep production logs to confirm the dual-account fix is
  //    firing. Only log if we actually did something (avoid noise from pure
  //    no-op idempotent calls).
  if (userUpdated || vmsUpdated > 0 || skillsEnabled > 0) {
    logger.info("partner-tag applied", {
      userId,
      partner,
      userUpdated,
      vmsUpdated,
      skillsEnabled,
      hasVm,
    });
  }

  return {
    ok: true,
    userUpdated,
    vmsUpdated,
    skillsEnabled,
    hasVm,
  };
}
