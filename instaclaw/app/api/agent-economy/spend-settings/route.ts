/**
 * /api/agent-economy/spend-settings
 *
 * The dashboard read/write surface for the user-owned autonomous-spend opt-in
 * (Frontier C27). This is the ONE real, wired economic control today.
 *
 *   GET  → { spend_enabled, wallet_address, wallet_balance_usd }
 *   PUT  → { enabled: boolean }  flips instaclaw_vms.frontier_spend_enabled
 *
 * Auth is by user session (this is called by the logged-in human from the
 * dashboard), NOT by gateway token (that's the agent-side authorize route).
 *
 * Default-OFF / fail-closed semantics live in lib/frontier-spend-optin.ts.
 * The authorize gate denies AUTONOMOUS-capable spend when this is false (deny:
 * spend_not_enabled), so a user who never visits this page is protected by
 * construction. SESSION-REQUIRED categories (travel) are exempt since the
 * 2026-06-12 decouple — their only money path is the per-spend browser tap,
 * which is stronger consent than this standing switch (spendMandateSatisfied).
 *
 * Migration dependency: the frontier_spend_enabled column ships in
 * supabase/pending_migrations/20260603190000_vm_frontier_spend_enabled.sql.
 * Until Cooper applies it (Rule 56), GET reads false (column absent → undefined
 * → fail-closed) and PUT returns { ok:false, reason:"pending_setup" } instead
 * of a 500, so the UI can show a friendly "being set up" state.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { isFrontierSpendEnabled } from "@/lib/frontier-spend-optin";
import { readUsdcBalanceUsd } from "@/lib/usdc-balance";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// PostgREST / Postgres codes for "column does not exist" — the not-yet-applied
// migration case. Surface as pending_setup, never a hard error.
function isMissingColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  return /frontier_spend_enabled/.test(err.message ?? "") &&
    /(column|does not exist|schema cache)/i.test(err.message ?? "");
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  // Rule 19 — select("*") for a safety-critical read; tolerate the column
  // being absent pre-migration (it just won't be a key on the row).
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }

  const walletAddress =
    (vm.bankr_evm_address as string | null) ?? null;
  const balance = await readUsdcBalanceUsd(walletAddress);

  return NextResponse.json({
    spend_enabled: isFrontierSpendEnabled(vm),
    wallet_address: walletAddress,
    wallet_balance_usd: balance,
  });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }
  const enabled = body.enabled;

  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }

  const { error } = await supabase
    .from("instaclaw_vms")
    .update({ frontier_spend_enabled: enabled })
    .eq("id", vm.id);

  if (error) {
    if (isMissingColumnError(error)) {
      // Migration not applied yet — honest, non-fatal signal for the UI.
      logger.warn("spend-settings PUT before migration applied", {
        route: "agent-economy/spend-settings",
        vm_id: vm.id,
      });
      return NextResponse.json(
        { ok: false, reason: "pending_setup" },
        { status: 200 },
      );
    }
    logger.error("spend-settings PUT failed", {
      route: "agent-economy/spend-settings",
      vm_id: vm.id,
      error: error.message,
    });
    return NextResponse.json({ error: "failed to update" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, spend_enabled: enabled });
}
