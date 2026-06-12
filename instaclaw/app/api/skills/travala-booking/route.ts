/**
 * /api/skills/travala-booking — the session-authed read/write path for the
 * "Travel Agent" card toggle (item J). Maps ONE switch to the per-VM
 * `instaclaw_vms.travala_booking_enabled` (item F) — no parallel enable path.
 *
 * Session-authed (auth()): the user toggles booking for THEIR OWN VM. Not in the
 * middleware selfAuthAPIs allow-list (Rule 13) — the session gate is the auth.
 *
 * GET  → { enabled, prereqs: { tier, spendEnabled, walletProvisioned, walletFundedUsd }, prereqsMet }
 * POST { enabled: boolean } → sets the flag.
 *   - enable=true is GATED server-side: pro/power tier AND frontier_spend_enabled
 *     AND a provisioned Bankr wallet. Never trust the client's prereq view.
 *   - enable=false is ALWAYS allowed (fail-safe direction — turning booking off
 *     never needs a prerequisite).
 *
 * Funding (USDC balance) is shown in the UI as advisory; it is NOT a hard
 * server gate — an unfunded booking simply fails at the frontier pay leg, which
 * is the correct place for that error. Gating enable on a live balance read would
 * add fragility (RPC flakiness) for no safety gain.
 *
 * PRD: instaclaw/docs/prd/travala-x402-booking-2026-06-10.md §14-J / §14-F.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { isTravalaBookingEnabled } from "@/lib/travala-kill-switch";
import { isFrontierSpendEnabled } from "@/lib/frontier-spend-optin";

export const maxDuration = 30; // DB read + best-effort on-chain balance (Rule 11)

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

async function readUsdcUsd(address: string | null | undefined): Promise<number | null> {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  try {
    const data = "0x70a08231" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const res = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (!j?.result || j.result === "0x") return null;
    return Math.round((Number(BigInt(j.result)) / 1e6) * 1e6) / 1e6;
  } catch {
    return null;
  }
}

async function resolveVm() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: "Unauthorized" as const, status: 401 };
  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("*") // Rule 19 — safety-critical read
    .eq("assigned_to", userId)
    .single();
  if (!vm) return { error: "No VM assigned" as const, status: 404 };
  return { vm, supabase };
}

function prereqView(vm: Record<string, unknown>, walletFundedUsd: number | null) {
  const tier = typeof vm.tier === "string" ? vm.tier : "starter";
  // tierOk: ALWAYS true (Q1 reversed 2026-06-12 — booking is open to every tier,
  // Starter included; no tier gate anywhere in the travel lane). Field kept so
  // older card clients reading prereqs don't break.
  const tierOk = true;
  const spendEnabled = isFrontierSpendEnabled(vm as { frontier_spend_enabled?: boolean | null });
  const walletProvisioned = !!vm.bankr_evm_address;
  return {
    tier,
    tierOk,
    spendEnabled,
    walletProvisioned,
    walletFundedUsd, // null = unknown (RPC flaky) — advisory only
    // hard server gate (funding is advisory, not gated)
    prereqsMet: tierOk && spendEnabled && walletProvisioned,
  };
}

export async function GET() {
  const r = await resolveVm();
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const fundedUsd = await readUsdcUsd(r.vm.bankr_evm_address as string | null);
  const prereqs = prereqView(r.vm, fundedUsd);
  return NextResponse.json({
    enabled: isTravalaBookingEnabled(r.vm as { travala_booking_enabled?: boolean | null }),
    prereqs,
    prereqsMet: prereqs.prereqsMet,
  });
}

export async function POST(req: NextRequest) {
  const r = await resolveVm();
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });

  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  const wantEnabled = body.enabled;

  // enable=true is gated; enable=false is always allowed (fail-safe direction).
  if (wantEnabled) {
    const prereqs = prereqView(r.vm, null);
    if (!prereqs.prereqsMet) {
      return NextResponse.json(
        {
          error: "prereqs_not_met",
          prereqs,
          message:
            "Booking needs a Pro or Power plan, autonomous spend enabled, and a provisioned wallet first.",
        },
        { status: 409 },
      );
    }
  }

  const { error: upErr } = await r.supabase
    .from("instaclaw_vms")
    .update({ travala_booking_enabled: wantEnabled })
    .eq("id", r.vm.id);
  if (upErr) {
    return NextResponse.json({ error: "update_failed", detail: upErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, enabled: wantEnabled });
}
