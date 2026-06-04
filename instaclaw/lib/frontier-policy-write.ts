/**
 * Frontier — the WRITE side of per-VM policy overrides (the dashboard PUT).
 *
 * Sibling to lib/frontier-overrides-db.ts (the canonical READ). The two pure,
 * I/O-light pieces of the /api/agent-economy/policy PUT handler live here so they
 * are unit-testable the same way authorize's `validate()` is — without dragging
 * the route's NextAuth/session module graph into a test:
 *
 *   - validatePolicyPutBody  : the body → {row, rawOverrides, categoryOverride}
 *                              transform + every 400 (band range, category shape).
 *   - upsertPolicyOverrideRow : the upsert + the PGRST204 (category-column-absent)
 *                               retry that persists bands-only and flags categories
 *                               as not-stored.
 *
 * Behavior is IDENTICAL to the former inline route logic — this is a
 * move-not-change extraction; the route now calls these and maps their results to
 * NextResponse. The override values are stored RAW; tighten-only clamping happens
 * at the point of use (frontier-policy.clampOverrides / effectiveAllowedCategories),
 * so a stored value can never make an agent less safe than its tier.
 */
import {
  ALL_CATEGORIES,
  type PolicyOverrides,
  type SpendCategory,
} from "./frontier-policy";

// Sane absolute cap on a stored band value; the real ceiling is the tier clamp.
export const MAX_OVERRIDE = 10_000_000;

// PostgREST schema-cache miss (PGRST205) / raw Postgres relation-missing (42P01).
const TABLE_MISSING_CODES = new Set(["PGRST205", "42P01"]);

// PostgREST "column not found in schema cache" — the allowed_categories column
// isn't applied yet (pre-migration / schema-cache lag / rollback).
const CATEGORY_COLUMN_MISSING = "PGRST204";

// DB snake_case ↔ TS camelCase for the five bands.
const FIELD_MAP: ReadonlyArray<[keyof PolicyOverrides, string]> = [
  ["justDoItPerTx", "just_do_it_per_tx"],
  ["justDoItPerDay", "just_do_it_per_day"],
  ["neverPerTx", "never_per_tx"],
  ["neverPerDay", "never_per_day"],
  ["minWalletBalance", "min_wallet_balance"],
];

/** A validated override row ready to upsert. `row` is the snake_case DB shape
 *  (band omitted/null ⇒ cleared); `rawOverrides` is the camelCase intent used to
 *  re-derive the effective response; `categoryOverride` is the stored allowlist
 *  (null clears; [] means "every category off"). */
export interface ValidatedPolicyPut {
  ok: true;
  row: Record<string, number | string[] | null>;
  rawOverrides: PolicyOverrides;
  categoryOverride: SpendCategory[] | null;
}
export interface PolicyPutError {
  ok: false;
  error: string;
  status: number;
}

/**
 * Validate the /policy PUT body. Replace-semantics: the body is the complete
 * desired override set; a band omitted (or null) reverts to the tier default.
 * Pure — no I/O. Identical to the former inline validation.
 */
export function validatePolicyPutBody(body: unknown): ValidatedPolicyPut | PolicyPutError {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object", status: 400 };
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
      return {
        ok: false,
        error: `${camel} must be a number in [0, ${MAX_OVERRIDE}] (or null to clear)`,
        status: 400,
      };
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
      return {
        ok: false,
        error: "allowed_categories must be an array of category strings (or null to clear)",
        status: 400,
      };
    }
    const invalid = rawCats.filter((c) => !ALL_CATEGORIES.includes(c as SpendCategory));
    if (invalid.length > 0) {
      return {
        ok: false,
        error: `allowed_categories has unknown categories: ${invalid.join(", ")}. Valid: ${ALL_CATEGORIES.join(", ")}`,
        status: 400,
      };
    }
    // De-dupe, preserve taxonomy order.
    categoryOverride = ALL_CATEGORIES.filter((c) => rawCats.includes(c));
  }
  row["allowed_categories"] = categoryOverride; // null clears

  return { ok: true, row, rawOverrides, categoryOverride };
}

/** Result of the override upsert. `categoryPersisted` is false when the
 *  allowed_categories column was absent and we retried bands-only. */
export type UpsertOverrideResult =
  | { ok: true; categoryPersisted: boolean }
  | { ok: false; kind: "table_missing" | "failed"; error: unknown };

/**
 * Upsert the override row, with the PGRST204 (category-column-absent) retry:
 * if the first upsert fails because allowed_categories isn't in the schema cache
 * (pre-migration / cache lag / rollback), retry WITHOUT it so the band overrides
 * still persist, and flag categories as not-stored. Identical to the former
 * inline route logic. The route maps the result to 503 (table_missing) / 500
 * (failed) / 200.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function upsertPolicyOverrideRow(
  supabase: any,
  vmId: string,
  row: Record<string, number | string[] | null>,
): Promise<UpsertOverrideResult> {
  let categoryPersisted = true;
  let { error: upErr } = await supabase
    .from("frontier_policy_overrides")
    .upsert({ vm_id: vmId, ...row }, { onConflict: "vm_id" });

  if (upErr && upErr.code === CATEGORY_COLUMN_MISSING && "allowed_categories" in row) {
    const { allowed_categories: _drop, ...bandsOnly } = row;
    categoryPersisted = false;
    ({ error: upErr } = await supabase
      .from("frontier_policy_overrides")
      .upsert({ vm_id: vmId, ...bandsOnly }, { onConflict: "vm_id" }));
  }

  if (upErr) {
    if (TABLE_MISSING_CODES.has(upErr.code)) return { ok: false, kind: "table_missing", error: upErr };
    return { ok: false, kind: "failed", error: upErr };
  }
  return { ok: true, categoryPersisted };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
