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

  // Yanek's CONFIRMED endpoint shape (2026-05-19 update — previous
  // /api/networks/:id/opportunities variant deprecated):
  //
  //   GET /api/opportunities?status=accepted
  //   Header: x-api-key: <INDEX_NETWORK_MASTER_KEY>
  //
  // Note: this is a SINGLE endpoint scoped by master-key auth, not
  // network-scoped in the URL. Yanek's master key is scoped to the
  // Edge City network on his side; the returned opportunities are
  // implicitly filtered to that network.
  //
  // No pagination params documented yet. At ~200 Edge attendees we
  // expect <50 accepted opportunities per minute. If volume grows
  // past what the endpoint returns per call we'll revisit.
  const url = `${apiBase}/api/opportunities?status=accepted`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": indexEnv.masterKey,
        Accept: "application/json",
      },
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
//
// Response shape — CONFIRMED with Yanek (2026-05-19) with real data:
//
//   {
//     "opportunities": [
//       {
//         "id": "uuid",
//         "status": "accepted",
//         "actors": [
//           { "userId": "user-uuid", "networkId": "...", "role": "patient|agent", "name": "...", "intent": "..." },
//           { "userId": "user-uuid", "networkId": "...", "role": "patient|agent", "name": "...", "intent": "..." }
//         ],
//         "interpretation": { "category": "...", "reasoning": "...", "confidence": 0.95, "signals": [...] },
//         "confidence": "0.95",
//         "createdAt": "iso", "updatedAt": "iso", "expiresAt": null,
//         "context": { "conversationId": "..." },
//         "counterpartName": "..."
//       }
//     ]
//   }
//
// Yanek's CRITICAL confirmation: `actors[].userId` is the SAME global user
// ID returned from /signup — our `instaclaw_vms.index_user_id` lookup
// pipeline works as-is. No translation layer needed.
//
// Earlier defensive parsers (parties / users / userIdA-userIdB) are removed
// since the shape is now known and stable.

interface IndexOpportunityActor {
  userId: string;
  networkId?: string;
  role?: "patient" | "agent";
  name?: string;
  intent?: string;
}

interface IndexOpportunity {
  id: string;
  status: string;
  actors: IndexOpportunityActor[];
  interpretation?: {
    category?: string;
    reasoning?: string;
    confidence?: number;
    signals?: unknown[];
  };
  confidence?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string | null;
  context?: { conversationId?: string };
  counterpartName?: string;
}

interface IndexOpportunitiesResponse {
  opportunities: IndexOpportunity[];
}

function extractOpportunities(raw: unknown): IndexOpportunity[] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<IndexOpportunitiesResponse>;
  if (!Array.isArray(r.opportunities)) return null;
  return r.opportunities;
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

function normalizeOpportunity(opp: IndexOpportunity): NormalizedOpportunity | null {
  if (!opp.id || typeof opp.id !== "string") return null;
  if (!Array.isArray(opp.actors) || opp.actors.length < 2) return null;

  // Role pairing semantics (from Yanek): one actor is "agent" (initiator),
  // one is "patient" (recipient). Map to source/candidate consistently —
  // if roles are present, agent → source, patient → candidate. If they're
  // both the same role or roles are missing, fall back to array order.
  const agent = opp.actors.find((a) => a.role === "agent");
  const patient = opp.actors.find((a) => a.role === "patient");

  let userA: string | null = null;
  let userB: string | null = null;
  if (agent && patient && agent.userId && patient.userId && agent.userId !== patient.userId) {
    userA = agent.userId;
    userB = patient.userId;
  } else {
    userA = opp.actors[0]?.userId ?? null;
    userB = opp.actors[1]?.userId ?? null;
  }
  if (!userA || !userB) return null;

  // Score mapping for the matchpool_outcomes columns:
  //   - rrf_score, mutual_score: not present in Yanek's response; stay NULL
  //   - deliberation_score: nearest semantic match for interpretation.confidence
  //     (or the top-level "confidence" string if interpretation.confidence absent)
  const deliberationScore =
    typeof opp.interpretation?.confidence === "number"
      ? opp.interpretation.confidence
      : opp.confidence
        ? Number.parseFloat(opp.confidence)
        : null;

  return {
    opportunityId: opp.id,
    userA,
    userB,
    metadata: {
      rrfScore: null,
      mutualScore: null,
      deliberationScore:
        deliberationScore !== null && Number.isFinite(deliberationScore)
          ? deliberationScore
          : null,
      reasoning: opp.interpretation?.reasoning ?? null,
    },
  };
}
