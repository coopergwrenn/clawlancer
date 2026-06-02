/**
 * POST /api/agent-economy/authorize
 *
 * The pre-spend gate. Before an agent pays for anything — a fleet agent's
 * service (A2A) or an external x402 Bazaar endpoint — its `frontier.authorize`
 * tool calls this. We read its integrity-filtered track record, compute its
 * earned autonomy, run its human's policy, and return a verdict. When the
 * verdict is "go", we atomically reserve the spend as a `pending` hold against
 * today's budget. The agent then pays (signs EIP-3009 via Bankr; the seller's
 * facilitator settles — the buyer needs no proxy) and calls /settle to close it.
 *
 * This is, as far as we know, the first endpoint where an autonomous agent's
 * earned record of good decisions gates a real financial transaction. The
 * decision logic is the pure, tested frontier-authz.decideAuthorization; this
 * route is its I/O shell (auth, read, reserve).
 *
 * THE GATE (see lib/frontier-authz.ts for the full reasoning):
 *   - hard policy deny (privacy / ceilings / drain / banned category) → denied
 *   - human in the loop (human_approved) → authorized (hard denies still bind)
 *   - autonomous: must clear the policy just_do_it band AND the EARNED daily
 *     budget. A spend within policy but beyond what the agent has earned →
 *     ask_first. Unknown capability category → ask_first. Otherwise → autonomous.
 *
 * RESERVE SEMANTICS:
 *   The `pending` hold IS the reserve — future authorize calls count it against
 *   today's budget (lib/frontier-ledger-db.reserveAwareSpentTodayUsd), but only
 *   while fresh (HOLD_TTL_MS). An authorize that's never settled self-frees, so
 *   an authorize-bomb cannot permanently lock a VM out of its own budget.
 *   Idempotent on (vm_id, request_id): a retried authorize returns the original
 *   hold's current state, never a second reserve.
 *
 * Amount is fixed here and IMMUTABLE at settle — kills "authorize $0.01, settle
 * $100". The earned budget is an autonomy governor, not custody: the wallet
 * balance + on-chain settlement is the unforgeable financial backstop, so the
 * rare concurrent-different-request_id over-reserve (a TOCTOU on the soft budget)
 * self-heals on the next tick and never moves money the wallet doesn't hold. The
 * fully-atomic form is a Postgres RPC taking pg_advisory_xact_lock(vm_id) around
 * read-check-insert — the documented hardening path, not built for Phase 1.
 *
 * Auth: Authorization: Bearer <gateway_token> OR x-gateway-token. vm_id is taken
 * from the token, never the body — a VM cannot authorize a spend for another VM.
 *
 * Request body:
 *   {
 *     "request_id":   <string>,                 // required — idempotency key (single-use)
 *     "amount_usd":   <number > 0>,             // required — the proposed spend
 *     // supplier — at least one of:
 *     "counterparty_vm_id":  <uuid>,            // a fleet agent (A2A); auto-verified
 *     "counterparty_address":<string 0x…>,      // an external payee
 *     "endpoint":            <string url>,       // the external resource (Bazaar) URL
 *     // capability:
 *     "category": "data"|"search"|"inference"|"compute"|"market"|"media"|"agent"|"other",
 *     "tags":     <string[]>,                    // mapped to a category if `category` omitted
 *     // context:
 *     "wallet_balance_usd":  <number>,          // IGNORED (P1-3) — balance is read server-side from bankr_evm_address; kept for backward-compat
 *     "rail":     "x402"|"compute"|"card"|"stripe_mcp"|"ap2"|"base_mcp", // default x402
 *     "protocol_fee_usd":    <number >= 0>,     // optional
 *     "require_verified_counterparty": <bool>,  // default: true for A2A, false for public endpoints
 *     "counterparty_verified":         <bool>,  // for AgentBook-verified external agents
 *     "human_approved":                <bool>   // the human approved THIS spend
 *   }
 *
 * Responses:
 *   201 { authorized:true, mode, hold_id, outcome, reason, standing, spent_today_usd, remaining_earned_after_usd }
 *   200 { authorized:false, outcome:"ask_first"|"deny", reason, standing, spent_today_usd, ... }   (a valid business answer)
 *   200 { authorized:true|false, hold_id, idempotent:true, ... }                                    (retry of an existing request_id)
 *   400/401/409 on bad input / auth / no-assigned-user
 *
 * PRD: instaclaw/docs/PRD-frontier-economic-agency.md §2 (C-spend), §4 Phase 1 (W4)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import {
  evaluateSpend,
  mapTagsToCategory,
  ALL_CATEGORIES,
  DEFAULT_ALLOWED_CATEGORIES_BY_TIER,
  type FrontierTier,
  type SpendCategory,
} from "@/lib/frontier-policy";
import { deriveTrackRecord } from "@/lib/frontier-ledger";
import { creditStanding, type CreditStanding } from "@/lib/frontier-standing";
import { toLedgerRow, reserveAwareSpentTodayUsd, HOLD_TTL_MS, SPEND_WINDOW_MS, type FrontierTxnDbRow } from "@/lib/frontier-ledger-db";
import { decideAuthorization } from "@/lib/frontier-authz";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // DB reads + one insert, no LLM (Rule 11 short tier)

const RAILS = ["x402", "compute", "card", "stripe_mcp", "ap2", "base_mcp"] as const;
type Rail = (typeof RAILS)[number];
const TIERS: readonly FrontierTier[] = ["starter", "pro", "power"];

const MAX_REQUEST_ID = 200;
const MAX_ADDRESS = 42;
const MAX_ENDPOINT = 500;
const MAX_AMOUNT = 99_999_999; // numeric(14,6) integer part
const MAX_TAGS = 20;
const MAX_TAG_LEN = 60;
const RECENT_SCAN_LIMIT = 500; // recent rows for standing + reserve (matches /state)

// Base mainnet USDC — for the authoritative server-side wallet-balance read (P1-3).
const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

/**
 * Read the wallet's on-chain USDC balance (USD) on Base, server-side (P1-3).
 * The drain guard must not trust a client-supplied balance — an agent could lie
 * to bypass the wallet floor. null on ANY failure → the gate forces ask_first
 * ("never auto-spend blind"), so a read failure is safe, never permissive.
 */
async function readUsdcBalanceUsd(address: string | null | undefined): Promise<number | null> {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  try {
    const data = "0x70a08231" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const res = await fetch(BASE_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE_ADDRESS, data }, "latest"] }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (!j?.result || j.result === "0x") return null;
    return Math.round((Number(BigInt(j.result)) / 1e6) * 1e6) / 1e6;
  } catch {
    return null;
  }
}

export function extractGatewayToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const xGate = req.headers.get("x-gateway-token");
  if (xGate?.trim()) return xGate.trim();
  return null;
}

function isUUID(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Map an existing hold's status to the idempotent-reply kind for a retried
 * authorize (request_id is single-use). Pure — tested in P2-1.
 *   live     — still pending: return the same hold, authorized:true.
 *   settled  — already paid: return it, don't let the agent re-pay.
 *   consumed — failed/refunded/disputed: request_id spent → use a fresh one.
 */
export function classifyExistingHold(status: string): "live" | "settled" | "consumed" {
  if (status === "pending") return "live";
  if (status === "settled") return "settled";
  return "consumed";
}

function standingSummary(s: CreditStanding) {
  return {
    score: s.score,
    level: s.level,
    earned_daily_budget_usd: s.earnedDailyBudgetUsd,
    world_id_verified: s.worldIdVerified,
    factors: s.factors,
  };
}

interface CleanAuthz {
  request_id: string;
  amount_usd: number;
  counterparty_vm_id: string | null;
  counterparty_address: string | null;
  endpoint: string | null;
  category: SpendCategory | null;
  tags: string[];
  wallet_balance_usd: number | null;
  rail: Rail;
  protocol_fee_usd: number;
  require_verified_counterparty: boolean;
  counterparty_verified: boolean;
  human_approved: boolean;
}

export function validate(raw: unknown): CleanAuthz | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be a JSON object" };
  const b = raw as Record<string, unknown>;

  if (typeof b.request_id !== "string" || !b.request_id.trim()) {
    return { error: "request_id must be a non-empty string" };
  }
  const request_id = b.request_id.trim().slice(0, MAX_REQUEST_ID);

  if (typeof b.amount_usd !== "number" || !Number.isFinite(b.amount_usd) || b.amount_usd <= 0) {
    return { error: "amount_usd must be a positive finite number" };
  }
  if (b.amount_usd > MAX_AMOUNT) return { error: `amount_usd exceeds ${MAX_AMOUNT}` };
  const amount_usd = round6(b.amount_usd);

  // Supplier identity — at least one. supplierIdOf (in the ledger) prefers vm > url > addr.
  let counterparty_vm_id: string | null = null;
  if (b.counterparty_vm_id !== undefined && b.counterparty_vm_id !== null) {
    if (!isUUID(b.counterparty_vm_id)) return { error: "counterparty_vm_id must be a UUID" };
    counterparty_vm_id = b.counterparty_vm_id;
  }
  let counterparty_address: string | null = null;
  if (b.counterparty_address !== undefined && b.counterparty_address !== null) {
    if (typeof b.counterparty_address !== "string") return { error: "counterparty_address must be a string" };
    const a = b.counterparty_address.trim().slice(0, MAX_ADDRESS);
    counterparty_address = a === "" ? null : a;
  }
  let endpoint: string | null = null;
  if (b.endpoint !== undefined && b.endpoint !== null) {
    if (typeof b.endpoint !== "string") return { error: "endpoint must be a string" };
    const e = b.endpoint.trim().slice(0, MAX_ENDPOINT);
    endpoint = e === "" ? null : e;
  }
  if (!counterparty_vm_id && !counterparty_address && !endpoint) {
    return { error: "a supplier is required: counterparty_vm_id, counterparty_address, or endpoint" };
  }

  // Category — explicit if valid, else derive from tags, else unknown (null).
  let tags: string[] = [];
  if (b.tags !== undefined && b.tags !== null) {
    if (!Array.isArray(b.tags)) return { error: "tags must be an array of strings" };
    tags = b.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().slice(0, MAX_TAG_LEN))
      .filter((t) => t !== "")
      .slice(0, MAX_TAGS);
  }
  let category: SpendCategory | null = null;
  if (b.category !== undefined && b.category !== null) {
    if (!ALL_CATEGORIES.includes(b.category as SpendCategory)) {
      return { error: `category must be one of ${ALL_CATEGORIES.join(", ")}` };
    }
    category = b.category as SpendCategory;
  } else {
    category = mapTagsToCategory(tags); // may be null (unknown → ask_first downstream)
  }

  let wallet_balance_usd: number | null = null;
  if (b.wallet_balance_usd !== undefined && b.wallet_balance_usd !== null) {
    if (typeof b.wallet_balance_usd !== "number" || !Number.isFinite(b.wallet_balance_usd) || b.wallet_balance_usd < 0) {
      return { error: "wallet_balance_usd must be a non-negative finite number" };
    }
    wallet_balance_usd = round6(b.wallet_balance_usd);
  }

  let rail: Rail = "x402";
  if (b.rail !== undefined && b.rail !== null) {
    if (!RAILS.includes(b.rail as Rail)) return { error: `rail must be one of ${RAILS.join(", ")}` };
    rail = b.rail as Rail;
  }

  let protocol_fee_usd = 0;
  if (b.protocol_fee_usd !== undefined && b.protocol_fee_usd !== null) {
    if (typeof b.protocol_fee_usd !== "number" || !Number.isFinite(b.protocol_fee_usd) || b.protocol_fee_usd < 0) {
      return { error: "protocol_fee_usd must be a non-negative finite number" };
    }
    if (b.protocol_fee_usd > amount_usd) return { error: "protocol_fee_usd cannot exceed amount_usd" };
    protocol_fee_usd = round6(b.protocol_fee_usd);
  }

  const boolOr = (v: unknown, dflt: boolean): boolean | { error: string } => {
    if (v === undefined || v === null) return dflt;
    if (typeof v !== "boolean") return { error: "expected a boolean" };
    return v;
  };
  const isFleet = !!counterparty_vm_id;
  const reqVer = boolOr(b.require_verified_counterparty, isFleet); // A2A strict; public endpoints lenient
  if (typeof reqVer === "object") return { error: "require_verified_counterparty must be a boolean" };
  const cpVer = boolOr(b.counterparty_verified, isFleet); // fleet agents are World-ID-rooted → verified
  if (typeof cpVer === "object") return { error: "counterparty_verified must be a boolean" };
  const human = boolOr(b.human_approved, false);
  if (typeof human === "object") return { error: "human_approved must be a boolean" };

  return {
    request_id,
    amount_usd,
    counterparty_vm_id,
    counterparty_address,
    endpoint,
    category,
    tags,
    wallet_balance_usd,
    rail,
    protocol_fee_usd,
    require_verified_counterparty: reqVer,
    counterparty_verified: cpVer,
    human_approved: human,
  };
}

export async function POST(req: NextRequest) {
  // ── Auth: gateway token → vm_id (never a body-supplied vm_id) ──
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  const vm = await lookupVMByGatewayToken(gatewayToken, "*"); // Rule 19: safety-critical read
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  const vmId = vm.id as string;
  const ownerId = vm.assigned_to as string;

  // ── Body ──
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  const v = validate(bodyJson);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });

  // No self-dealing — a VM transacting with itself is wash activity, not commerce.
  if (v.counterparty_vm_id === vmId) {
    return NextResponse.json({ error: "counterparty_vm_id cannot be the reporting VM" }, { status: 400 });
  }

  const supabase = getSupabase();
  const nowMs = Date.now();

  // ── Read this VM's recent ledger (standing + reserve) ──
  const { data: rawRows, error: rowsErr } = await supabase
    .from("frontier_transactions")
    .select("direction, status, amount_usdc, created_at, counterparty_vm_id, counterparty_address, verified_on_chain_at, metadata")
    .eq("vm_id", vmId)
    .order("created_at", { ascending: false })
    .limit(RECENT_SCAN_LIMIT);
  if (rowsErr) {
    console.error("[/api/agent-economy/authorize] ledger read failed:", rowsErr);
    return NextResponse.json({ error: "failed to read ledger" }, { status: 500 });
  }
  const dbRows = (rawRows ?? []) as FrontierTxnDbRow[];

  // ── Same-human resolution (§7.3.1 #1): which counterparty VMs share our owner ──
  const counterpartyVmIds = Array.from(
    new Set(dbRows.map((r) => r.counterparty_vm_id).filter((id): id is string => !!id)),
  );
  const sameHumanVms = new Set<string>();
  if (counterpartyVmIds.length > 0) {
    const { data: cpVms } = await supabase
      .from("instaclaw_vms")
      .select("id, assigned_to")
      .in("id", counterpartyVmIds);
    for (const cp of cpVms ?? []) {
      if (cp.assigned_to && cp.assigned_to === ownerId) sameHumanVms.add(cp.id as string);
    }
  }
  const isSameHuman = (id: string) => sameHumanVms.has(id);

  // ── P1-2: real World-ID gate — read the owner's verification, never hardcode.
  // Unverified owners are capped at audit/500 by the standing engine (the sybil
  // root of trust). Missing user row → false (correctly unverified).
  const { data: ownerRow } = await supabase
    .from("instaclaw_users")
    .select("world_id_verified")
    .eq("id", ownerId)
    .maybeSingle();
  const ownerWorldIdVerified = ownerRow?.world_id_verified === true;

  // ── P1-3: authoritative server-side wallet balance (never trust a client value).
  // A read failure → null → the policy forces ask_first (never auto-spend blind).
  const walletBalanceUsd = await readUsdcBalanceUsd(vm.bankr_evm_address as string | null);

  // ── Pure pipeline: rows → track record → standing → policy → decision ──
  const ledgerRows = dbRows.map(toLedgerRow);
  const trackRecord = {
    ...deriveTrackRecord(ledgerRows, { nowMs, isSameHuman }),
    worldIdVerified: ownerWorldIdVerified,
  };
  const tier: FrontierTier = TIERS.includes(vm.tier as FrontierTier) ? (vm.tier as FrontierTier) : "starter";
  const standing = creditStanding(trackRecord, tier, { nowMs, isStaker: false });
  const reserveAwareSpent = reserveAwareSpentTodayUsd(dbRows, { nowMs });

  const privacyModeOn = !!(vm.privacy_mode_until && Date.parse(vm.privacy_mode_until as string) > nowMs);
  const allowedCategories = DEFAULT_ALLOWED_CATEGORIES_BY_TIER[tier];

  const evaluation = evaluateSpend(tier, {
    amountUsd: v.amount_usd,
    spentTodayUsd: reserveAwareSpent,
    walletBalanceUsd, // P1-3: server-read on-chain balance; null → ask_first (never auto-spend blind)
    privacyModeOn,
    counterpartyVerified: v.counterparty_verified,
    isStaker: false,
    requireVerifiedCounterparty: v.require_verified_counterparty,
    overrides: null,
    category: v.category ?? undefined, // known-banned → policy deny; unknown → handled by categoryKnown below
    allowedCategories,
  });

  const decision = decideAuthorization({
    evaluation,
    standing,
    reserveAwareSpentTodayUsd: reserveAwareSpent,
    amountUsd: v.amount_usd,
    humanApproved: v.human_approved,
    categoryKnown: v.category !== null,
  });

  const commonBody = {
    outcome: decision.outcome,
    reason: decision.reason,
    standing: standingSummary(standing),
    spent_today_usd: reserveAwareSpent,
    earned_daily_budget_usd: decision.earnedDailyBudgetUsd,
    remaining_earned_after_usd: decision.remainingEarnedAfterUsd,
    policy_bands: evaluation.effectiveBands,
  };

  // ── Not authorized: a valid business answer (ask the human / hard no). No hold. ──
  if (!decision.authorized) {
    return NextResponse.json({ authorized: false, mode: null, ...commonBody }, { status: 200 });
  }

  // ── Authorized: atomically reserve the spend as a pending hold (P1-4). ──
  const holdMeta = {
    hold: true,
    mode: decision.mode,
    endpoint: v.endpoint,
    category: v.category,
    tags: v.tags,
    score_at_authorize: standing.score,
    earned_budget_at_authorize: standing.earnedDailyBudgetUsd,
  };

  const authorizedResponse = (holdId: string, idempotent: boolean) =>
    NextResponse.json(
      { authorized: true, mode: decision.mode, hold_id: holdId, idempotent, ...commonBody },
      { status: idempotent ? 200 : 201 },
    );

  // Idempotent retry — a request_id is single-use. Return the EXISTING hold's
  // true state (via classifyExistingHold) so the agent never reserves/pays twice.
  const idempotentReplyForExisting = async () => {
    const { data: existing } = await supabase
      .from("frontier_transactions")
      .select("id, status")
      .eq("vm_id", vmId)
      .eq("request_id", v.request_id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: "conflict re-read failed, retry" }, { status: 503 });
    const kind = classifyExistingHold(existing.status as string);
    if (kind === "live") return authorizedResponse(existing.id, true);
    if (kind === "settled") {
      return NextResponse.json(
        { authorized: true, hold_id: existing.id, idempotent: true, already_settled: true, ...commonBody },
        { status: 200 },
      );
    }
    return NextResponse.json(
      { authorized: false, hold_id: existing.id, idempotent: true, outcome: "deny", reason: "request_id_consumed", consumed_status: existing.status, standing: standingSummary(standing) },
      { status: 200 },
    );
  };

  // ── Primary: the atomic-reserve RPC (advisory-locked re-check + insert). ──
  const { data: rpcData, error: rpcErr } = await supabase.rpc("frontier_reserve_spend", {
    p_vm_id: vmId,
    p_request_id: v.request_id,
    p_rail: v.rail,
    p_counterparty_address: v.counterparty_address,
    p_counterparty_vm_id: v.counterparty_vm_id,
    p_amount: v.amount_usd,
    p_protocol_fee: v.protocol_fee_usd,
    p_metadata: holdMeta,
    p_cap_daily: evaluation.effectiveBands.neverPerDay,
    p_cap_earned: decision.earnedDailyBudgetUsd,
    p_human_approved: v.human_approved,
    p_window_start: new Date(nowMs - SPEND_WINDOW_MS).toISOString(),
    p_fresh_pending_cutoff: new Date(nowMs - HOLD_TTL_MS).toISOString(),
  });

  const rpcMissing =
    !!rpcErr &&
    (rpcErr.code === "PGRST202" ||
      rpcErr.code === "42883" ||
      /could not find the function|does not exist|schema cache/i.test(rpcErr.message || ""));

  if (!rpcErr && rpcData) {
    const r = rpcData as { reserved?: boolean; id?: string; conflict?: boolean; reason?: string };
    if (r.reserved && r.id) return authorizedResponse(r.id, false);
    if (r.conflict) return idempotentReplyForExisting();
    if (r.reason === "invalid_counterparty") {
      return NextResponse.json({ error: "counterparty_vm_id does not exist" }, { status: 400 });
    }
    // Lost the locked budget re-check — a concurrent reserve consumed the headroom
    // the non-locked decision saw. Bounce to the human rather than over-reserve.
    return NextResponse.json(
      { authorized: false, mode: null, ...commonBody, outcome: "ask_first", reason: r.reason ?? "budget_race_lost" },
      { status: 200 },
    );
  }
  if (rpcErr && !rpcMissing) {
    console.error("[/api/agent-economy/authorize] reserve RPC failed:", rpcErr);
    return NextResponse.json({ error: "failed to reserve spend" }, { status: 500 });
  }

  // ── Fallback: RPC not yet applied (migration pending). Plain insert — the prior
  // non-atomic-but-wallet-bounded behavior. Logged so the gap is visible; remove
  // once frontier_reserve_spend is applied fleet-wide. ──
  console.warn("[/api/agent-economy/authorize] frontier_reserve_spend RPC absent — non-atomic insert fallback (apply the pending migration to activate the per-VM lock)");
  const holdRow = {
    request_id: v.request_id, rail: v.rail, direction: "spend" as const, vm_id: vmId,
    counterparty_address: v.counterparty_address, counterparty_vm_id: v.counterparty_vm_id,
    amount_usdc: v.amount_usd, protocol_fee_usdc: v.protocol_fee_usd, status: "pending" as const,
    facilitator: "coinbase", metadata: holdMeta,
  };
  const { data: inserted, error: insertErr } = await supabase
    .from("frontier_transactions").insert(holdRow).select("id").single();
  if (!insertErr && inserted) return authorizedResponse(inserted.id, false);
  if (insertErr?.code === "23505") return idempotentReplyForExisting();
  if (insertErr?.code === "23503") return NextResponse.json({ error: "counterparty_vm_id does not exist" }, { status: 400 });
  if (insertErr?.code === "23514") return NextResponse.json({ error: "value failed a database constraint" }, { status: 400 });
  console.error("[/api/agent-economy/authorize] hold insert failed:", insertErr);
  return NextResponse.json({ error: "failed to reserve spend" }, { status: 500 });
}
