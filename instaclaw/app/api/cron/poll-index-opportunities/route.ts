/**
 * GET /api/cron/poll-index-opportunities — Path C, PRIMARY path for
 * Index→Village (per Yanek 2026-05-19: Index doesn't have outbound webhooks).
 *
 * Polls Yanek's dedicated Edge-City endpoint:
 *
 *     POST {INDEX_API_URL}/api/networks/:networkId/opportunities?status=accepted
 *     Headers: x-api-key: {INDEX_NETWORK_MASTER_KEY}
 *     Body:    {} (empty — filter is in the query string)
 *
 * Yes, POST for a read operation — Yanek confirmed this is the exact shape.
 * He added a separate endpoint that accepts x-api-key auth (vs the documented
 * GET version which requires AuthGuard / session). The path is identical;
 * only the method differs.
 *
 * Every cron tick (1 min via vercel.json), feeds each accepted opportunity
 * to `recordIndexMatch`. Idempotent across runs via the
 * `matchpool_outcomes_index_opportunity_unique` partial-UNIQUE index — so
 * replaying the same opportunity is a no-op, and running this alongside
 * Path A (the webhook receiver, kept in case Yanek adds outbound webhooks
 * later) is safe.
 *
 * Gating:
 *
 *   ENABLED BY DEFAULT (as of Yanek's 2026-05-19 confirmation). Cooper can
 *   still disable via `INDEX_POLLER_ENABLED=false` env var if needed — the
 *   flag check below treats EXACT "false" as off; everything else (unset,
 *   "true", "1", "yes") is on.
 *
 * Failure modes:
 *
 *   - Index API unreachable / 5xx: log, return 502, Vercel cron continues
 *     next tick.
 *   - Auth failure (401/403): log loud at error level, return 401/403.
 *     Operator must check the master key + endpoint auth model.
 *   - Single opportunity record fails: continue with the rest — one bad
 *     row doesn't block the batch.
 *
 * What this route DOES NOT do:
 *   - Cursor persistence (yet). Per-tick fetches "all accepted" within a
 *     small window. Because writes are idempotent via the UNIQUE
 *     constraint, replaying the same opportunity is a no-op. Cooper
 *     decision: cursor persistence is a P2 once we see traffic shape.
 *   - Pagination. First 50 results per tick. If Index emits >50 per
 *     minute we'll add pagination — at Edge Esmeralda's ~200 attendee
 *     scale this is comfortably overhead-free.
 */
import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { recordIndexMatch } from "@/lib/index-match-recorder";
import { getIndexEnv } from "@/lib/index-network-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // ── Auth: CRON_SECRET Bearer (existing /api/cron/* pattern) ──
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── Feature flag: default-on per Yanek's 2026-05-19 confirmation that
  // Path C is the primary path. Only the explicit string "false" disables. ──
  if (process.env.INDEX_POLLER_ENABLED === "false") {
    return NextResponse.json({ skipped: "INDEX_POLLER_ENABLED=false" });
  }

  const indexEnv = getIndexEnv();
  if (!indexEnv) {
    return NextResponse.json({ skipped: "no_index_credentials" });
  }

  // ── Resolve API base URL — same source as the signup client ──
  // We have INDEX_NETWORK_API_URL pointing at dev or prod (matching where
  // signups were issued). Master key is scoped to whichever network the
  // signups used, so the polled opportunities will be the right ones.
  const apiBase = (
    process.env.INDEX_NETWORK_API_URL?.trim() ||
    "https://protocol.index.network"
  ).replace(/\/+$/, "");

  // Yanek's confirmed endpoint shape:
  //   POST /api/networks/:networkId/opportunities?status=accepted
  //   Header: x-api-key: <master>
  //   Body:   {} — empty; filter is in the query string
  //
  // Limit isn't documented as a query param for THIS endpoint (it's documented
  // on the GET variant which we're not using); omit it. If volume grows past
  // what the endpoint returns per call we'll revisit.
  const url = `${apiBase}/api/networks/${indexEnv.networkId}/opportunities?status=accepted`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": indexEnv.masterKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("[index-poller] fetch threw", { url, error: msg.slice(0, 200) });
    return NextResponse.json(
      { error: "fetch_failed", detail: msg.slice(0, 200) },
      { status: 502 },
    );
  }

  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    logger.error("[index-poller] auth failure — master-key may not work on this endpoint", {
      status: res.status,
      bodyPrefix: body.slice(0, 200),
    });
    return NextResponse.json(
      { error: "auth_failed", status: res.status, body_prefix: body.slice(0, 200) },
      { status: res.status },
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error("[index-poller] non-2xx", { status: res.status, bodyPrefix: body.slice(0, 200) });
    return NextResponse.json(
      { error: "non_2xx", status: res.status, body_prefix: body.slice(0, 200) },
      { status: 502 },
    );
  }

  // ── Parse opportunities list. Try several shapes (same defensive parser
  //    posture as Path A) — Index API docs leave this slightly ambiguous. ──
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return NextResponse.json({ error: "non_json_response" }, { status: 502 });
  }

  const opportunities = extractOpportunities(parsed);
  if (opportunities === null) {
    logger.warn("[index-poller] could not extract opportunities array", {
      bodyShape: typeof parsed,
      keys:
        parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 5) : null,
    });
    return NextResponse.json({ error: "unexpected_response_shape" }, { status: 502 });
  }

  // ── For each opportunity, attempt to record ──
  const summary = { fetched: opportunities.length, recorded: 0, already: 0, skipped: 0, failed: 0 };
  const errors: Array<{ opportunityId?: string; reason: string }> = [];

  for (const opp of opportunities) {
    const normalized = normalizeOpportunity(opp);
    if (!normalized) {
      summary.skipped++;
      errors.push({ reason: "unparseable_opportunity_row" });
      continue;
    }

    try {
      const result = await recordIndexMatch({
        indexOpportunityId: normalized.opportunityId,
        indexUserA: normalized.userA,
        indexUserB: normalized.userB,
        metadata: normalized.metadata,
        source: "poller",
      });
      if (result.status === "recorded") summary.recorded++;
      else if (result.status === "already_recorded") summary.already++;
      else if (result.status === "skipped") {
        summary.skipped++;
        errors.push({ opportunityId: normalized.opportunityId, reason: result.reason });
      } else {
        summary.failed++;
        errors.push({ opportunityId: normalized.opportunityId, reason: result.reason });
      }
    } catch (err) {
      summary.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ opportunityId: normalized.opportunityId, reason: msg.slice(0, 150) });
    }
  }

  if (summary.recorded > 0 || summary.failed > 0) {
    logger.info("[index-poller] tick complete", { summary });
  }

  return NextResponse.json({ ok: true, summary, errors: errors.slice(0, 10) });
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractOpportunities(raw: unknown): Array<Record<string, unknown>> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.opportunities)) return r.opportunities as Array<Record<string, unknown>>;
  if (Array.isArray(r.data)) return r.data as Array<Record<string, unknown>>;
  if (Array.isArray(r.items)) return r.items as Array<Record<string, unknown>>;
  return null;
}

interface NormalizedOpportunity {
  opportunityId: string;
  userA: string;
  userB: string;
  metadata: {
    rrfScore: number | null;
    mutualScore: number | null;
    deliberationScore: number | null;
    reasoning: string | null;
  };
}

function normalizeOpportunity(opp: Record<string, unknown>): NormalizedOpportunity | null {
  const opportunityId = asStr(opp.id) ?? asStr(opp.opportunityId) ?? asStr(opp.opportunity_id);
  if (!opportunityId) return null;

  // Parties — same flexible parser as Path A's payload normalizer.
  const partyList = Array.isArray(opp.parties)
    ? (opp.parties as Array<Record<string, unknown>>)
    : Array.isArray(opp.users)
      ? (opp.users as Array<Record<string, unknown>>)
      : null;
  if (!partyList || partyList.length < 2) return null;

  const proposer = partyList.find(
    (p) => asStr(p.role) === "proposer" || asStr(p.role) === "accepter",
  );
  const responder = partyList.find(
    (p) =>
      asStr(p.role) === "responder" ||
      asStr(p.role) === "counterparty" ||
      asStr(p.role) === "candidate",
  );
  const userA = proposer
    ? asStr(proposer.userId) ?? asStr(proposer.user_id) ?? asStr(proposer.id)
    : asStr(partyList[0].userId) ?? asStr(partyList[0].user_id) ?? asStr(partyList[0].id);
  const userB = responder
    ? asStr(responder.userId) ?? asStr(responder.user_id) ?? asStr(responder.id)
    : asStr(partyList[1].userId) ?? asStr(partyList[1].user_id) ?? asStr(partyList[1].id);
  if (!userA || !userB) return null;

  const scores = opp.scores as
    | { rrf?: number; mutual?: number; deliberation?: number }
    | undefined;

  return {
    opportunityId,
    userA,
    userB,
    metadata: {
      rrfScore: scores?.rrf ?? null,
      mutualScore: scores?.mutual ?? null,
      deliberationScore: scores?.deliberation ?? null,
      reasoning: asStr(opp.reasoning) ?? null,
    },
  };
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
