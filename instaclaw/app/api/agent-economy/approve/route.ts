/**
 * /api/agent-economy/approve  --  the session-rooted spend-approval surface
 * (Frontier human_approved hardening, Surface 2).
 *
 *   GET  ?id=<approval_id>            -> the exact proposed spend, for the confirm page
 *   POST { id, decision:"approve"|"deny" }  -> flips a pending approval
 *
 * Auth is by USER SESSION (auth() -> session.user.id), mirroring /spend-settings,
 * NEVER by gateway token. This is the load-bearing security property of the whole
 * build: the VM-resident agent authenticates the VM (its gateway token is readable
 * by the agent), but it provably cannot present the human's NextAuth browser session.
 * Consent is a channel property, not a payload. Every read/write is scoped to
 * owner_id = session.user.id, so one user can never see or approve another's spend.
 *
 * The authorize route (gateway-token-authed) MINTS the pending_approval row capturing
 * the exact spend; this endpoint only flips its status; the authorize route then
 * honors + consumes it. Single-use + 15-min TTL live in the row + the pure helpers.
 *
 * Session route -> NOT in middleware selfAuthAPIs (Rule 13: the session check is the
 * first line; this owner-scope is defense in depth).
 *
 * Migration dependency: instaclaw_frontier_spend_approvals ships in
 * supabase/pending_migrations/20260610210000_frontier_spend_approvals.sql. Until
 * applied, GET/POST return a friendly pending_setup state, never a 500 (Rule 56).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { isApprovalExpired, type ApprovalRow } from "@/lib/frontier-approvals";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TABLE = "instaclaw_frontier_spend_approvals";

function isMissingRelationError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703" || err.code === "PGRST204" || err.code === "PGRST205") return true;
  return /(does not exist|schema cache|could not find)/i.test(err.message ?? "") &&
    /instaclaw_frontier_spend_approvals/.test(err.message ?? "");
}

interface ApprovalRowFull extends ApprovalRow {
  id: string;
  vm_id: string;
  owner_id: string;
  request_id: string;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from(TABLE)
    .select("id, vm_id, owner_id, request_id, status, amount_usd, category, counterparty, expires_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error)) {
      return NextResponse.json({ ok: false, reason: "pending_setup" }, { status: 200 });
    }
    logger.warn("approve GET read failed", { route: "agent-economy/approve", code: error.code });
    return NextResponse.json({ error: "read failed" }, { status: 500 });
  }
  // Not found OR not owned by this session -> 404 (never reveal another user's spend).
  const r = row as ApprovalRowFull | null;
  if (!r || r.owner_id !== session.user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Lazily reflect TTL expiry on read.
  let status = r.status;
  if ((status === "pending_approval" || status === "approved") && isApprovalExpired(r, Date.now())) {
    status = "expired";
    try {
      await supabase.from(TABLE).update({ status: "expired" }).eq("id", r.id).in("status", ["pending_approval", "approved"]);
    } catch {
      /* best-effort */
    }
  }

  // Agent display name (best-effort; not security-relevant).
  let agentName: string | null = null;
  try {
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("telegram_bot_username, name")
      .eq("id", r.vm_id)
      .maybeSingle();
    agentName = (vm?.telegram_bot_username as string | null) ?? (vm?.name as string | null) ?? null;
  } catch {
    /* best-effort */
  }

  return NextResponse.json({
    ok: true,
    id: r.id,
    amount_usd: typeof r.amount_usd === "string" ? parseFloat(r.amount_usd) : r.amount_usd,
    category: r.category,
    counterparty: r.counterparty,
    status,
    expires_at: r.expires_at,
    agent_name: agentName,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : null;
  const decision = b.decision === "approve" || b.decision === "deny" ? b.decision : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!decision) return NextResponse.json({ error: 'decision must be "approve" or "deny"' }, { status: 400 });

  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from(TABLE)
    .select("id, owner_id, status, amount_usd, category, counterparty, expires_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error)) {
      return NextResponse.json({ ok: false, reason: "pending_setup" }, { status: 200 });
    }
    logger.warn("approve POST read failed", { route: "agent-economy/approve", code: error.code });
    return NextResponse.json({ error: "read failed" }, { status: 500 });
  }
  const r = row as (ApprovalRow & { id: string; owner_id: string }) | null;
  if (!r || r.owner_id !== session.user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Idempotent-safe: approving an already-approved row is a no-op success.
  if (r.status === "approved" && decision === "approve") {
    return NextResponse.json({ ok: true, status: "approved", idempotent: true });
  }
  // Terminal states cannot be changed.
  if (r.status === "consumed" || r.status === "denied" || r.status === "expired") {
    return NextResponse.json({ ok: false, status: r.status, reason: "terminal_state" }, { status: 409 });
  }
  // Past TTL -> mark expired, refuse.
  if (isApprovalExpired(r, Date.now())) {
    try {
      await supabase.from(TABLE).update({ status: "expired" }).eq("id", r.id).in("status", ["pending_approval", "approved"]);
    } catch {
      /* best-effort */
    }
    return NextResponse.json({ ok: false, status: "expired", reason: "expired" }, { status: 409 });
  }

  // Only a pending_approval row can be flipped here. Guard the UPDATE on the prior
  // status too (compare-and-set) so two concurrent taps can't race.
  const newStatus = decision === "approve" ? "approved" : "denied";
  const patch =
    decision === "approve" ? { status: newStatus, approved_at: new Date().toISOString() } : { status: newStatus };
  const { data: updated, error: updErr } = await supabase
    .from(TABLE)
    .update(patch)
    .eq("id", r.id)
    .eq("owner_id", session.user.id)
    .eq("status", "pending_approval")
    .select("id, status")
    .maybeSingle();

  if (updErr) {
    logger.warn("approve POST update failed", { route: "agent-economy/approve", code: updErr.code });
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
  if (!updated) {
    // Lost the compare-and-set (concurrent flip) — re-report current state.
    return NextResponse.json({ ok: false, reason: "state_changed" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, status: newStatus });
}
