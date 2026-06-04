/**
 * /api/agent-economy/policy
 *
 *   GET — the EFFECTIVE autonomy spend bands for the logged-in user's agent
 *         (tier defaults → staker 2x → tighten-only overrides), read from the
 *         same lib/frontier-policy.ts the VM-side gate uses, so the dashboard
 *         shows exactly what the agent will enforce.
 *   PUT — set per-VM overrides. Replace-semantics: the body is the complete
 *         desired override set; a band omitted (or null) reverts to the tier
 *         default. Overrides are TIGHTEN-ONLY (clampOverrides) — a user can make
 *         their agent more conservative, never more aggressive than what they've
 *         paid for. Loosening stays gated behind tier/staking.
 *
 * Staking isn't live yet (no $INSTACLAW staking contract), so is_staker is
 * always false until it lands. The PUT stores RAW requested values; the clamp
 * applies at read time, so a later tier/staking change re-derives correctly and
 * the response always reflects what's actually enforced.
 *
 * Storage: frontier_policy_overrides (pending migration). GET tolerates the
 * table being absent (treats as no overrides) so it works pre-apply; PUT returns
 * 503 until the migration lands.
 *
 * Auth: NextAuth session.
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §6.6, §8.4, §10.1
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import {
  effectiveBands,
  effectiveAllowedCategories,
  ALL_CATEGORIES,
  DEFAULT_ALLOWED_CATEGORIES_BY_TIER,
  DEFAULT_BANDS_BY_TIER,
  type FrontierTier,
} from "@/lib/frontier-policy";
import { readPolicyOverrides } from "@/lib/frontier-overrides-db";
import { validatePolicyPutBody, upsertPolicyOverrideRow } from "@/lib/frontier-policy-write";
import { loadVmStanding } from "@/lib/frontier-standing-db";
import { autonomousHeadroom } from "@/lib/frontier-headroom";
import { readUsdcBalanceUsd } from "@/lib/usdc-balance";
import { isFrontierSpendEnabled } from "@/lib/frontier-spend-optin";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // GET does an on-chain wallet-balance read (Rule 11)

const TIERS: readonly FrontierTier[] = ["starter", "pro", "power"];

function normalizeTier(raw: unknown): FrontierTier {
  const t = (raw ?? "").toString().toLowerCase();
  return (TIERS as readonly string[]).includes(t) ? (t as FrontierTier) : "starter";
}

// Note: reads go through lib/frontier-overrides-db.readPolicyOverrides (the ONE
// canonical reader shared with the authorize gate); the PUT body validation +
// upsert (incl. the PGRST204 retry) live in lib/frontier-policy-write. The former
// local readers/validators were removed to avoid second, drift-prone copies.

/** session → assigned VM. The session user IS the owner (assigned_to). Returns
 *  the fields GET needs for the live autonomy snapshot; PUT uses only vmId/tier. */
async function resolveUserVm(): Promise<
  | {
      vmId: string;
      tier: FrontierTier;
      ownerId: string;
      bankrAddress: string | null;
      spendEnabled: boolean;
    }
  | { error: string; status: number }
> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Unauthorized", status: 401 };
  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("*") // Rule 19 — safety-adjacent read; pull the fields the snapshot needs
    .eq("assigned_to", session.user.id)
    .single();
  if (!vm) return { error: "No VM assigned", status: 404 };
  return {
    vmId: vm.id as string,
    tier: normalizeTier(vm.tier),
    ownerId: session.user.id,
    bankrAddress: (vm.bankr_evm_address as string | null) ?? null,
    spendEnabled: isFrontierSpendEnabled(vm),
  };
}

export async function GET() {
  const r = await resolveUserVm();
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });

  const supabase = getSupabase();
  // Canonical reader (lib/frontier-overrides-db) — the SAME read the authorize
  // gate uses, so the dashboard shows exactly what the agent enforces.
  const { bandOverrides, allowedCategoriesOverride, persisted } = await readPolicyOverrides(
    supabase,
    r.vmId,
  );
  const isStaker = false; // staking not live
  const bands = effectiveBands(r.tier, isStaker, bandOverrides);
  const tierDefaultBands = DEFAULT_BANDS_BY_TIER[r.tier];
  const tierDefaultCategories = DEFAULT_ALLOWED_CATEGORIES_BY_TIER[r.tier];

  // ── Live autonomy snapshot (GAP-1): the HONEST "what can this agent spend on
  // its own right now?" — the binding minimum of earned-budget / daily-band /
  // wallet, gated by opt-in + known-balance. Computed from the SAME standing
  // pipeline + the SAME effective bands the gate enforces (loadVmStanding mirrors
  // authorize; autonomousHeadroom is gate-consistency-tested). One on-chain
  // balance read + the standing read; tolerant of failures (null balance ⇒ the
  // honest "can't auto-spend blind" state, exactly like the gate).
  const nowMs = Date.now();
  let autonomy: ReturnType<typeof autonomousHeadroom> | null = null;
  let autonomyError = false;
  try {
    // Independent reads — overlap the standing pipeline with the on-chain balance.
    const [{ standing, spentTodayUsd }, walletBalanceUsd] = await Promise.all([
      loadVmStanding(supabase, { vmId: r.vmId, ownerId: r.ownerId, tier: r.tier, nowMs }),
      readUsdcBalanceUsd(r.bankrAddress),
    ]);
    autonomy = autonomousHeadroom({
      spendEnabled: r.spendEnabled,
      standing,
      bands,
      spentTodayUsd,
      walletBalanceUsd,
    });
  } catch (e) {
    // Never fail the whole policy read because the snapshot couldn't compute —
    // the bands/categories controls must still render. Surface a flag instead.
    console.error("[/api/agent-economy/policy] autonomy snapshot failed:", e);
    autonomyError = true;
  }

  return NextResponse.json({
    tier: r.tier,
    is_staker: isStaker,
    bands, // EFFECTIVE (post tier × staker × clamped overrides) — what the agent enforces
    tier_default_bands: tierDefaultBands, // the tier ceiling — the tighten-only slider MAX
    overrides: bandOverrides ?? null, // raw stored band intent (may differ from bands after clamp)
    overrides_persisted: persisted,
    // Category allowlist (W3). all_categories = the full taxonomy for the UI to
    // render checkboxes; tier_default = what's allowed with no override;
    // allowed_categories = EFFECTIVE (tighten-only intersection) — what the gate
    // enforces; allowed_categories_override = the raw stored intent (null = none).
    all_categories: ALL_CATEGORIES,
    tier_default_categories: tierDefaultCategories,
    allowed_categories: effectiveAllowedCategories(r.tier, allowedCategoriesOverride),
    allowed_categories_override: allowedCategoriesOverride ?? null,
    // Live autonomy snapshot (GAP-1). null + autonomy_error if it couldn't compute.
    autonomy,
    autonomy_error: autonomyError,
  });
}

export async function PUT(req: NextRequest) {
  const r = await resolveUserVm();
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  // Validate the body (bands range + category shape) — pure, in frontier-policy-write.
  const parsed = validatePolicyPutBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const { row, rawOverrides, categoryOverride } = parsed;

  const supabase = getSupabase();
  // Upsert with the PGRST204 (category-column-absent) retry — in frontier-policy-write.
  const up = await upsertPolicyOverrideRow(supabase, r.vmId, row);
  if (!up.ok) {
    if (up.kind === "table_missing") {
      return NextResponse.json(
        { error: "policy override storage not yet provisioned" },
        { status: 503 },
      );
    }
    console.error("[/api/agent-economy/policy PUT] upsert failed:", up.error);
    return NextResponse.json({ error: "failed to save policy" }, { status: 500 });
  }
  const categoryPersisted = up.categoryPersisted;

  // Return the EFFECTIVE bands + categories so the dashboard shows what'll
  // actually be enforced (raw intent clamped/intersected to tighten-only).
  const isStaker = false;
  const effective = effectiveBands(r.tier, isStaker, rawOverrides);
  return NextResponse.json({
    ok: true,
    tier: r.tier,
    is_staker: isStaker,
    bands: effective,
    overrides: Object.keys(rawOverrides).length > 0 ? rawOverrides : null,
    overrides_persisted: true,
    all_categories: ALL_CATEGORIES,
    tier_default_categories: DEFAULT_ALLOWED_CATEGORIES_BY_TIER[r.tier],
    allowed_categories: effectiveAllowedCategories(r.tier, categoryOverride),
    allowed_categories_override: categoryOverride,
    allowed_categories_persisted: categoryPersisted,
  });
}
