/**
 * Frontier — the ONE canonical reader for per-VM policy overrides.
 *
 * Both the authorize gate (app/api/agent-economy/authorize) and the dashboard
 * policy endpoint (app/api/agent-economy/policy) read the per-VM override row
 * through THIS function, so the bands + category allowlist the gate enforces can
 * never drift from what the dashboard shows/sets. (Before this existed, the gate
 * passed `overrides: null` and ignored the stored row entirely — a latent lie:
 * the /policy PUT accepted a safety tightening the gate never honored.)
 *
 * Tolerant of the storage not being fully provisioned, so callers keep working
 * across migration boundaries:
 *   - table absent (pre-20260601130000)        → no overrides
 *   - allowed_categories column absent          → no category override (band
 *     overrides still read); select("*") simply doesn't return the column.
 *
 * Returns the RAW stored intent. Tighten-only clamping is applied at the point of
 * use (frontier-policy.ts:clampOverrides for bands, effectiveAllowedCategories for
 * categories), so a stored value can never make an agent less safe than its tier.
 */
import { ALL_CATEGORIES, type PolicyOverrides, type SpendCategory } from "./frontier-policy";

// PostgREST schema-cache miss (PGRST205) / raw Postgres relation-missing (42P01).
const TABLE_MISSING_CODES = new Set(["PGRST205", "42P01"]);

// DB snake_case ↔ TS camelCase for the five bands.
const BAND_FIELD_MAP: ReadonlyArray<[keyof PolicyOverrides, string]> = [
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

export interface StoredPolicyOverride {
  /** Raw band overrides (camelCase), or null if none stored. */
  bandOverrides: PolicyOverrides | null;
  /**
   * Raw category allowlist override, or null when there is no override (no row,
   * NULL column, or column absent pre-migration → fall back to tier default).
   * An explicit empty array [] is distinct from null: the user turned every
   * category off (every categorized spend then bounces to ask_first).
   */
  allowedCategoriesOverride: SpendCategory[] | null;
  /** True iff a row exists (the override table is provisioned and has this VM). */
  persisted: boolean;
}

const EMPTY: StoredPolicyOverride = {
  bandOverrides: null,
  allowedCategoriesOverride: null,
  persisted: false,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function readPolicyOverrides(
  supabase: any,
  vmId: string,
): Promise<StoredPolicyOverride> {
  const { data, error } = await supabase
    .from("frontier_policy_overrides")
    .select("*") // Rule 19 + forward-compatible: tolerates the category column being absent
    .eq("vm_id", vmId)
    .maybeSingle();

  if (error) {
    if (!TABLE_MISSING_CODES.has(error.code)) {
      console.error("[frontier-overrides-db] read failed:", error);
    }
    return EMPTY;
  }
  if (!data) return EMPTY;

  const row = data as Record<string, unknown>;

  const bands: PolicyOverrides = {};
  for (const [camel, snake] of BAND_FIELD_MAP) {
    const v = num(row[snake] as number | string | null);
    if (v !== undefined) bands[camel] = v;
  }

  // Category column may be absent (pre-migration) → undefined → treat as no override.
  let allowedCategoriesOverride: SpendCategory[] | null = null;
  const rawCats = row["allowed_categories"];
  if (Array.isArray(rawCats)) {
    allowedCategoriesOverride = rawCats.filter(
      (c): c is SpendCategory => ALL_CATEGORIES.includes(c as SpendCategory),
    );
  }

  return {
    bandOverrides: Object.keys(bands).length > 0 ? bands : null,
    allowedCategoriesOverride,
    persisted: true,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
