/**
 * GET /api/agent-economy/policy
 *
 * Returns the EFFECTIVE autonomy spend bands for the logged-in user's agent —
 * the just-do-it / ask-first / never thresholds the spend gate enforces. Read
 * straight from lib/frontier-policy.ts (the same module the VM-side gate uses),
 * so the dashboard always shows exactly what the agent will enforce.
 *
 * GET only by design. Per-VM OVERRIDES and $INSTACLAW-staker 2x ceilings are not
 * yet persistable: there's no frontier_policy storage column (deliberately
 * deferred in the migration audit to keep instaclaw_vms blast radius small), and
 * the staking contract doesn't exist yet (PRD §8.4 — contingent on tokenomics
 * Phase 0). So this returns the tier DEFAULTS with is_staker=false. A PUT lands
 * with its storage migration; surfacing a PUT now would be a fake.
 *
 * Auth: NextAuth session.
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §6.6, §8.4, §10.1
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { effectiveBands, type FrontierTier } from "@/lib/frontier-policy";

export const dynamic = "force-dynamic";

const TIERS: readonly FrontierTier[] = ["starter", "pro", "power"];

function normalizeTier(raw: unknown): FrontierTier {
  const t = (raw ?? "").toString().toLowerCase();
  return (TIERS as readonly string[]).includes(t) ? (t as FrontierTier) : "starter";
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, tier")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }

  // Staking isn't live yet — always false until the $INSTACLAW staking contract
  // exists. When it does, this becomes a real lookup and is_staker flips on.
  const isStaker = false;
  const tier = normalizeTier(vm.tier);
  const bands = effectiveBands(tier, isStaker);

  return NextResponse.json({
    tier,
    is_staker: isStaker,
    bands,
    // Signals to the dashboard that what it shows is the tier default, not a
    // saved override — so it can render "defaults" vs "customized" correctly.
    overrides_persisted: false,
  });
}
