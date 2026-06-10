/**
 * /api/agent-economy/settings  - the AGENT-facing economy-settings write path.
 *
 *   GET  → the current EFFECTIVE settings (bands, allowlist, master switch) so the
 *          agent can tell its human "you keep $X in reserve, no-ask up to $Y".
 *   POST → apply MONOTONIC-TOWARD-SAFE changes only. Tightenings apply immediately;
 *          LOOSENINGS apply to nothing and are returned in `needs_confirmation`
 *          with a deep link to the session-authed dashboard.
 *
 * SECURITY (see lib/frontier-settings-monotonic.ts): the gateway token authenticates
 * the VM, NOT the user's intent (a hostile prompt in the agent's context can emit any
 * gateway-token call). So this endpoint is structurally INCAPABLE of loosening a money
 * rail: every field is combined monotonic-toward-safe against the CURRENT EFFECTIVE
 * value (read server-side, unforgeable). A loosening has no representation here. The
 * read-side clamp (frontier-policy.clampOverrides / effectiveAllowedCategories) is the
 * independent second wall. Loosenings route to the session - the only channel the
 * VM-resident agent cannot forge (the human's NextAuth dashboard).
 *
 * Auth: Authorization: Bearer <gateway_token> OR x-gateway-token. vm_id is taken from
 * the token, never the body - same discipline as /authorize. Reuses the existing
 * seams (lookupVMByGatewayToken, validatePolicyPutBody, upsertPolicyOverrideRow,
 * readPolicyOverrides, effectiveBands) - one clamp implementation, no parallel.
 *
 * NOTE: turning spending ON is dashboard-only (session-authed /spend-settings); this
 * endpoint can only turn it OFF. Raising a no-ask line, lowering the reserve, and
 * adding a category are loosenings → needs_confirmation.
 *
 * PRD: instaclaw/docs/prd/economy-settings-ownership-2026-06-09.md (step 2)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import {
  effectiveBands,
  effectiveAllowedCategories,
  DEFAULT_BANDS_BY_TIER,
  DEFAULT_ALLOWED_CATEGORIES_BY_TIER,
  type FrontierTier,
  type TierBands,
} from "@/lib/frontier-policy";
import { readPolicyOverrides } from "@/lib/frontier-overrides-db";
import { validatePolicyPutBody, upsertPolicyOverrideRow } from "@/lib/frontier-policy-write";
import { isFrontierSpendEnabled } from "@/lib/frontier-spend-optin";
import {
  monotonicSafeSettings,
  type FieldVerdict,
} from "@/lib/frontier-settings-monotonic";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // DB-only, but a frontier money-path route (Rule 11)

// Local gateway-token extractor - matches the per-route convention in settle /
// transaction / refund (each defines its own; none import cross-route).
function extractGatewayToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const xGate = req.headers.get("x-gateway-token");
  if (xGate?.trim()) return xGate.trim();
  return null;
}

const TIERS: readonly FrontierTier[] = ["starter", "pro", "power"];
function normalizeTier(raw: unknown): FrontierTier {
  const t = (raw ?? "starter").toString().toLowerCase();
  return (TIERS as readonly string[]).includes(t) ? (t as FrontierTier) : "starter";
}

const APP_URL =
  process.env.INSTACLAW_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://instaclaw.io";

/** A deep link that PRE-FILLS the loosening in the session-authed dashboard. The
 *  ?suggest param is a public IDENTIFIER, not a capability - consent is the in-session
 *  Save (the only channel the VM-resident agent cannot forge), never this link. */
function confirmUrl(v: FieldVerdict): string {
  let val: string;
  if (Array.isArray(v.requested)) val = v.requested.join(",");
  else if (typeof v.requested === "boolean") val = v.requested ? "on" : "off";
  else val = String(v.requested);
  return `${APP_URL}/economy?suggest=${encodeURIComponent(v.field)}:${encodeURIComponent(val)}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function resolveVm(
  req: NextRequest,
): Promise<{ vm: any; tier: FrontierTier } | { error: string; status: number }> {
  const token = extractGatewayToken(req);
  if (!token) return { error: "Missing authentication", status: 401 };
  const vm = await lookupVMByGatewayToken(token, "*"); // Rule 19: safety-critical read
  if (!vm) return { error: "Invalid gateway token", status: 401 };
  if (!vm.assigned_to) return { error: "VM has no assigned user", status: 409 };
  return { vm, tier: normalizeTier(vm.tier) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function GET(req: NextRequest) {
  const r = await resolveVm(req);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const supabase = getSupabase();
  const { bandOverrides, allowedCategoriesOverride } = await readPolicyOverrides(supabase, r.vm.id);
  return NextResponse.json({
    tier: r.tier,
    bands: effectiveBands(r.tier, false, bandOverrides),
    tier_default_bands: DEFAULT_BANDS_BY_TIER[r.tier],
    allowed_categories: effectiveAllowedCategories(r.tier, allowedCategoriesOverride),
    tier_default_categories: DEFAULT_ALLOWED_CATEGORIES_BY_TIER[r.tier],
    spend_enabled: isFrontierSpendEnabled(r.vm),
  });
}

export async function POST(req: NextRequest) {
  const r = await resolveVm(req);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const { vm, tier } = r;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }

  // Range-validate the mentioned bands + categories via the SAME validator the
  // dashboard PUT uses ([0, MAX], negatives rejected, categories ⊆ taxonomy).
  const parsed = validatePolicyPutBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  // spendEnabled is not a band - validate it here (only present-and-boolean is honored).
  const b = body as Record<string, unknown>;
  let spendEnabledReq: boolean | undefined;
  if ("spend_enabled" in b && b.spend_enabled !== undefined && b.spend_enabled !== null) {
    if (typeof b.spend_enabled !== "boolean") {
      return NextResponse.json({ error: "spend_enabled must be a boolean" }, { status: 400 });
    }
    spendEnabledReq = b.spend_enabled;
  }

  const supabase = getSupabase();
  const { bandOverrides, allowedCategoriesOverride } = await readPolicyOverrides(supabase, vm.id);
  const currentEffectiveBands = effectiveBands(tier, false, bandOverrides);
  const currentEffectiveCategories = effectiveAllowedCategories(tier, allowedCategoriesOverride);
  const currentSpendEnabled = isFrontierSpendEnabled(vm);

  const requestedBands =
    Object.keys(parsed.rawOverrides).length > 0 ? parsed.rawOverrides : undefined;
  // categoryOverride: null = absent (not mentioned); [] = mentioned (turn all off).
  const requestedCategories = parsed.categoryOverride === null ? undefined : parsed.categoryOverride;

  const result = monotonicSafeSettings(
    {
      bands: currentEffectiveBands,
      categories: currentEffectiveCategories,
      spendEnabled: currentSpendEnabled,
    },
    { bands: requestedBands, categories: requestedCategories, spendEnabled: spendEnabledReq },
  );

  // ── Apply the tightenings (bands + category removals), merged onto current raw. ──
  const bandChanged = Object.keys(result.bandsToApply).length > 0;
  const categoryChanged = result.categoriesToApply !== null;
  if (bandChanged || categoryChanged) {
    const cur = bandOverrides ?? {};
    const a = result.bandsToApply;
    const pick = (k: keyof TierBands): number | null =>
      a[k] !== undefined ? (a[k] as number) : cur[k] !== undefined ? (cur[k] as number) : null;
    const mergedRow: Record<string, number | string[] | null> = {
      just_do_it_per_tx: pick("justDoItPerTx"),
      just_do_it_per_day: pick("justDoItPerDay"),
      never_per_tx: pick("neverPerTx"),
      never_per_day: pick("neverPerDay"),
      min_wallet_balance: pick("minWalletBalance"),
      allowed_categories: result.categoriesToApply ?? allowedCategoriesOverride ?? null,
    };
    const up = await upsertPolicyOverrideRow(supabase, vm.id, mergedRow);
    if (!up.ok) {
      if (up.kind === "table_missing") {
        return NextResponse.json({ error: "settings storage not provisioned" }, { status: 503 });
      }
      console.error("[/api/agent-economy/settings] upsert failed:", up.error);
      return NextResponse.json({ error: "failed to save settings" }, { status: 500 });
    }
  }

  // ── Master switch: OFF only (never ON via the agent path). ──
  if (result.turnOff) {
    const { error: offErr } = await supabase
      .from("instaclaw_vms")
      .update({ frontier_spend_enabled: false })
      .eq("id", vm.id);
    if (offErr) {
      console.error("[/api/agent-economy/settings] turn-off failed:", offErr);
      return NextResponse.json({ error: "failed to pause spending" }, { status: 500 });
    }
  }

  // ── Re-derive the new EFFECTIVE state (truthful read) to return. ──
  const { bandOverrides: newBandOverrides, allowedCategoriesOverride: newCats } =
    await readPolicyOverrides(supabase, vm.id);

  return NextResponse.json({
    ok: true,
    applied: result.applied,
    needs_confirmation: result.needsConfirmation.map((v) => ({ ...v, confirm_url: confirmUrl(v) })),
    noop: result.noop,
    effective: {
      bands: effectiveBands(tier, false, newBandOverrides),
      allowed_categories: effectiveAllowedCategories(tier, newCats),
      spend_enabled: result.turnOff ? false : currentSpendEnabled,
    },
  });
}
