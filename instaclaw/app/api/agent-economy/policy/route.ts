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
  type FrontierTier,
  type PolicyOverrides,
  type SpendCategory,
} from "@/lib/frontier-policy";
import { readPolicyOverrides } from "@/lib/frontier-overrides-db";

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

// Note: reads now go through lib/frontier-overrides-db.readPolicyOverrides (the
// ONE canonical reader shared with the authorize gate). The former local
// readOverrides()/num() were removed to avoid a second, drift-prone reader.

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
  // Canonical reader (lib/frontier-overrides-db) — the SAME read the authorize
  // gate uses, so the dashboard shows exactly what the agent enforces.
  const { bandOverrides, allowedCategoriesOverride, persisted } = await readPolicyOverrides(
    supabase,
    r.vmId,
  );
  const isStaker = false; // staking not live
  const bands = effectiveBands(r.tier, isStaker, bandOverrides);
  const tierDefaultCategories = DEFAULT_ALLOWED_CATEGORIES_BY_TIER[r.tier];

  return NextResponse.json({
    tier: r.tier,
    is_staker: isStaker,
    bands, // EFFECTIVE (post tier × staker × clamped overrides) — what the agent enforces
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
  const row: Record<string, number | string[] | null> = {};
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

  // Validate the category allowlist override (W3). `allowed_categories`:
  //   absent / null         → clear (revert to the tier default)
  //   array of SpendCategory → store (must be a subset of ALL_CATEGORIES; the
  //                            gate further intersects with the tier default —
  //                            tighten-only, so a value above the tier is inert).
  // `allowed_categories: []` is valid and DISTINCT from null: it means "turn every
  // category off" (the agent then asks before any categorized spend).
  let categoryOverride: SpendCategory[] | null = null;
  const rawCats = b["allowed_categories"];
  if (rawCats !== undefined && rawCats !== null) {
    if (!Array.isArray(rawCats)) {
      return NextResponse.json(
        { error: "allowed_categories must be an array of category strings (or null to clear)" },
        { status: 400 },
      );
    }
    const invalid = rawCats.filter((c) => !ALL_CATEGORIES.includes(c as SpendCategory));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `allowed_categories has unknown categories: ${invalid.join(", ")}. Valid: ${ALL_CATEGORIES.join(", ")}` },
        { status: 400 },
      );
    }
    // De-dupe, preserve taxonomy order.
    categoryOverride = ALL_CATEGORIES.filter((c) => rawCats.includes(c));
  }
  row["allowed_categories"] = categoryOverride; // null clears

  const supabase = getSupabase();
  // PGRST204 = "column not found in schema cache" → the allowed_categories
  // column isn't applied yet (pre-migration). Retry the upsert without it so the
  // band overrides still persist; flag categories as not-yet-stored to the UI.
  const CATEGORY_COLUMN_MISSING = "PGRST204";
  let categoryPersisted = true;
  let { error: upErr } = await supabase
    .from("frontier_policy_overrides")
    .upsert({ vm_id: r.vmId, ...row }, { onConflict: "vm_id" });

  if (upErr && upErr.code === CATEGORY_COLUMN_MISSING && "allowed_categories" in row) {
    const { allowed_categories: _drop, ...bandsOnly } = row;
    categoryPersisted = false;
    ({ error: upErr } = await supabase
      .from("frontier_policy_overrides")
      .upsert({ vm_id: r.vmId, ...bandsOnly }, { onConflict: "vm_id" }));
  }

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
