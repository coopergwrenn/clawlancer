/**
 * GET /api/agent-economy/counterparties
 *
 * "Who your agent works with" — the distinct counterparties the logged-in user's
 * agent has bought from, each rolled up with how many times, how many DELIVERED
 * (settled) vs DIDN'T GO THROUGH (failed), what it mostly bought there, and how
 * recently. Read-only; session-authed. Powers components/dashboard/
 * economy-counterparties.
 *
 * Self-dealing is excluded the SAME way the authorize gate / standing do (§7.3.1
 * #1): a counterparty bonded to the agent's own World-ID human (the user's other
 * VM) can't pad the relationships. Resolution mirrors lib/frontier-standing-db.
 *
 * `category` is read from metadata.category — the SAME field the activity feed
 * renders — so the card and the feed never disagree about what a purchase was.
 *
 * PRD: instaclaw/docs/PRD-frontier-economic-agency.md §2 C3 (rolodex), §9.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { deriveCounterpartyRollup, type CounterpartyTxn } from "@/lib/frontier-ledger";
import type { SpendCategory } from "@/lib/frontier-policy";

export const dynamic = "force-dynamic";

// Same bounded scan as /state — far above Phase-1A per-VM volume.
const SCAN_LIMIT = 500;
// Cap the response; the card shows the top 5 with an in-place "show more".
const TOP_N = 24;

const CATEGORIES: readonly SpendCategory[] = [
  "data",
  "search",
  "inference",
  "compute",
  "market",
  "media",
  "agent",
  "other",
];

interface TxnRow {
  direction: "earn" | "spend";
  status: string;
  amount_usdc: number | string; // PostgREST returns numeric as string
  created_at: string;
  counterparty_vm_id: string | null;
  counterparty_address: string | null;
  metadata: Record<string, unknown> | null;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  return Number.isFinite(n as number) ? (n as number) : 0;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }
  const vmId = vm.id as string;

  const { data: txns, error: txnErr } = await supabase
    .from("frontier_transactions")
    .select("direction, status, amount_usdc, created_at, counterparty_vm_id, counterparty_address, metadata")
    .eq("vm_id", vmId)
    .order("created_at", { ascending: false })
    .limit(SCAN_LIMIT);

  if (txnErr) {
    console.error("[/api/agent-economy/counterparties] transaction fetch failed:", txnErr);
    return NextResponse.json({ error: "failed to load counterparties" }, { status: 500 });
  }

  const rows = (txns ?? []) as TxnRow[];

  // same-human resolution — which counterparty VMs share this user's account
  // (self-dealing). Identical pattern to lib/frontier-standing-db.loadVmStanding.
  const counterpartyVmIds = Array.from(
    new Set(rows.map((r) => r.counterparty_vm_id).filter((id): id is string => !!id)),
  );
  const sameHumanVms = new Set<string>();
  if (counterpartyVmIds.length > 0) {
    const { data: cpVms } = await supabase
      .from("instaclaw_vms")
      .select("id, assigned_to")
      .in("id", counterpartyVmIds);
    for (const cp of cpVms ?? []) {
      if (cp.assigned_to && cp.assigned_to === session.user.id) sameHumanVms.add(cp.id as string);
    }
  }
  const isSameHuman = (id: string) => sameHumanVms.has(id);

  // map DB rows → the pure rollup's input. `category` from metadata.category (the
  // feed's source); `endpoint` from metadata.endpoint (the label's source).
  const txnInput: CounterpartyTxn[] = rows.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const rawCat = typeof m.category === "string" ? (m.category as string) : null;
    const category = rawCat && (CATEGORIES as readonly string[]).includes(rawCat)
      ? (rawCat as SpendCategory)
      : null;
    const endpoint = typeof m.endpoint === "string" && m.endpoint.trim() !== "" ? (m.endpoint as string) : null;
    return {
      direction: r.direction === "earn" ? "earn" : "spend",
      status: (["pending", "settled", "failed", "disputed", "refunded"] as const).includes(
        r.status as never,
      )
        ? (r.status as CounterpartyTxn["status"])
        : "failed",
      amountUsd: num(r.amount_usdc),
      createdAtMs: Date.parse(r.created_at),
      counterpartyVmId: r.counterparty_vm_id,
      counterpartyAddress: r.counterparty_address,
      endpoint,
      category,
    };
  });

  const rolled = deriveCounterpartyRollup(txnInput, { isSameHuman });

  const counterparties = rolled.slice(0, TOP_N).map((c) => ({
    id: c.supplierId,
    endpoint: c.endpoint,
    counterparty_vm_id: c.counterpartyVmId,
    counterparty_address: c.counterpartyAddress,
    category: c.category,
    times: c.timesTransacted,
    delivered: c.delivered,
    didnt_go_through: c.didntGoThrough,
    total_spent_usd: c.totalSpentUsd,
    last_seen: new Date(c.lastSeenMs).toISOString(),
    internal: c.internal,
  }));

  return NextResponse.json({ counterparties, total: rolled.length });
}
