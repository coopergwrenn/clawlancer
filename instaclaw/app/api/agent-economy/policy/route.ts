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
import { effectiveBands, type FrontierTier, type PolicyOverrides } from "@/lib/frontier-policy";

export const dynamic = "force-dynamic";

const TIERS: readonly FrontierTier[] = ["starter", "pro", "power"];
const MAX_OVERRIDE = 10_000_000; // sane absolute cap; the real ceiling is the tier clamp

// "Table missing": PostgREST surfaces a schema-cache miss as PGRST205; raw
// Postgres relation-missing is 42P01. Treat both as "overrides not provisioned"
// so /policy works before the migration is applied.
const TABLE_MISSING_CODES = new Set(["PGRST205", "42P01"]);

function normalizeTier(raw: unknown): FrontierTier {
  const t = (raw ?? "").toString().toLowerCase();
  return (TIERS as readonly string[]).includes(t) ? (t as FrontierTier) : "starter";
}

// DB snake_case ↔ TS camelCase for the five bands.
const FIELD_MAP: ReadonlyArray<[keyof PolicyOverrides, string]> = [
  ["justDoItPerTx", "just_do_it_per_tx"],
  ["justDoItPerDay", "just_do_it_per_day"],
  ["neverPerTx", "never_per_tx"],
  ["neverPerDay", "never_per_day"],
  ["minWalletBalance", "min_wallet_balance"],
];

function num(v: number | string | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? (n as number) : undefined;
}

/** Read the stored overrides row → camelCase PolicyOverrides (or null). Returns
 *  null if the table doesn't exist yet (pre-migration) so GET keeps working. */
async function readOverrides(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  vmId: string,
): Promise<{ overrides: PolicyOverrides | null; persisted: boolean }> {
  const { data, error } = await supabase
    .from("frontier_policy_overrides")
    .select("just_do_it_per_tx, just_do_it_per_day, never_per_tx, never_per_day, min_wallet_balance")
    .eq("vm_id", vmId)
    .maybeSingle();
  if (error) {
    // Table missing (migration not applied) → behave as no overrides, quietly.
    if (!TABLE_MISSING_CODES.has(error.code)) {
      console.error("[/api/agent-economy/policy] overrides read failed:", error);
    }
    return { overrides: null, persisted: false };
  }
  if (!data) return { overrides: null, persisted: false };
  const ov: PolicyOverrides = {};
  for (const [camel, snake] of FIELD_MAP) {
    const v = num((data as Record<string, unknown>)[snake] as number | string | null);
    if (v !== undefined) ov[camel] = v;
  }
  return { overrides: Object.keys(ov).length > 0 ? ov : null, persisted: true };
}

/** session → assigned VM (id, tier). */
async function resolveUserVm(): Promise<
  { vmId: string; tier: FrontierTier } | { error: string; status: number }
> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Unauthorized", status: 401 };
  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, tier")
    .eq("assigned_to", session.user.id)
    .single();
  if (!vm) return { error: "No VM assigned", status: 404 };
  return { vmId: vm.id as string, tier: normalizeTier(vm.tier) };
}

export async function GET() {
  const r = await resolveUserVm();
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });

  const supabase = getSupabase();
  const { overrides, persisted } = await readOverrides(supabase, r.vmId);
  const isStaker = false; // staking not live
  const bands = effectiveBands(r.tier, isStaker, overrides);

  return NextResponse.json({
    tier: r.tier,
    is_staker: isStaker,
    bands, // EFFECTIVE (post tier × staker × clamped overrides) — what the agent enforces
    overrides: overrides ?? null, // the raw stored intent (may differ from bands after clamp)
    overrides_persisted: persisted,
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // Validate each band: present → finite, >= 0, <= MAX_OVERRIDE; absent/null →
  // cleared (revert to tier default). Replace-semantics: {} resets everything.
  const rawOverrides: PolicyOverrides = {};
  const row: Record<string, number | null> = {};
  for (const [camel, snake] of FIELD_MAP) {
    const raw = b[camel];
    if (raw === undefined || raw === null) {
      row[snake] = null; // cleared
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_OVERRIDE) {
      return NextResponse.json(
        { error: `${camel} must be a number in [0, ${MAX_OVERRIDE}] (or null to clear)` },
        { status: 400 },
      );
    }
    row[snake] = raw;
    rawOverrides[camel] = raw;
  }

  const supabase = getSupabase();
  const { error: upErr } = await supabase
    .from("frontier_policy_overrides")
    .upsert({ vm_id: r.vmId, ...row }, { onConflict: "vm_id" });

  if (upErr) {
    if (TABLE_MISSING_CODES.has(upErr.code)) {
      return NextResponse.json(
        { error: "policy override storage not yet provisioned" },
        { status: 503 },
      );
    }
    console.error("[/api/agent-economy/policy PUT] upsert failed:", upErr);
    return NextResponse.json({ error: "failed to save policy" }, { status: 500 });
  }

  // Return the EFFECTIVE bands so the dashboard shows what'll actually be
  // enforced (raw intent clamped to tighten-only).
  const isStaker = false;
  const effective = effectiveBands(r.tier, isStaker, rawOverrides);
  return NextResponse.json({
    ok: true,
    tier: r.tier,
    is_staker: isStaker,
    bands: effective,
    overrides: Object.keys(rawOverrides).length > 0 ? rawOverrides : null,
    overrides_persisted: true,
  });
}
