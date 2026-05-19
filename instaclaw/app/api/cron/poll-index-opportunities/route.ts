/**
 * GET /api/cron/poll-index-opportunities — Path C, PRIMARY path for
 * Index→Village (per Yanek 2026-05-19).
 *
 * Architecture: Option B (per-user keys, fan-out to all 9 agents).
 *
 * ── Why per-user fan-out ──
 *
 *   Yanek's auth model: the master key is ONLY for /signup. The
 *   /api/opportunities?status=accepted endpoint requires a PER-USER
 *   x-api-key, which is issued by /signup and stored in our
 *   instaclaw_vms.index_api_key column.
 *
 *   We couldn't empirically determine all-vs-mine scoping (re-probed after
 *   re-provisioning the 9 keys — both keys returned 200 with empty result
 *   sets because no real opportunities exist yet). Three converging signals
 *   pointed at user-scoped:
 *
 *     1. Yanek explicitly said per-user keys are scoped to specific users.
 *     2. The sibling documented endpoint
 *        GET /api/agents/:id/opportunities/accepted is explicitly user-scoped.
 *     3. The master rotation invalidated the previously-issued per-user
 *        keys — confirming master→per-user-key is a real derivation, not
 *        independent identities.
 *
 *   Asymmetric risk: if we built single-key (Option A) and it turned out
 *   user-scoped, we'd silently miss opportunities. If we build fan-out
 *   (Option B) and it turned out all-network, we waste 8 redundant requests
 *   per tick (negligible). → Option B.
 *
 * ── Flow per tick ──
 *
 *   1. Auth: Bearer CRON_SECRET (existing /api/cron/* pattern).
 *   2. Feature flag: default-on; `INDEX_POLLER_ENABLED=false` disables.
 *   3. Pull all 9 (well, however many are present) edge_city VMs with a
 *      non-null index_api_key from instaclaw_vms.
 *   4. Parallel fetch: GET /api/opportunities?status=accepted with each
 *      agent's per-user x-api-key. ~200-500ms each in parallel.
 *   5. In-memory dedup by opportunity.id (a single opportunity between
 *      two cohort agents shows up in BOTH agents' result sets; we should
 *      only attempt one recordIndexMatch call per opportunity per tick).
 *   6. For each unique opportunity: hand to recordIndexMatch.
 *      - Bidirectional matches (both actors in cohort): deduped in-memory,
 *        single INSERT, success.
 *      - Single-side matches (one actor in cohort, one external): only the
 *        cohort actor's poll sees the opportunity, single INSERT attempt,
 *        recorder returns `skipped: 'unknown_index_user'` for the external
 *        side. Correct behavior — we can't visualize a match between
 *        someone in cohort and someone outside it.
 *      - Re-running ticks: matchpool_outcomes_index_opportunity_unique
 *        constraint catches dupes → recordIndexMatch returns
 *        `already_recorded` (200, not an error).
 *
 * ── Cost ──
 *
 *   ~9 GET calls per minute = 12,960 calls/day. Trivial both for us and
 *   for Index. Plus 1 Supabase SELECT and 0-N Supabase INSERTs per tick.
 *
 * ── Failure modes ──
 *
 *   - Single agent's poll 401s: skip that agent's results, continue with
 *     the rest. (Per-user key may have been revoked; operator should
 *     re-provision via scripts/_reprovision-index-keys.ts.)
 *   - Single agent's poll 5xx: skip + log; continue.
 *   - Single recordIndexMatch fails: continue with the rest of the deduped
 *     set; one bad row doesn't block the batch.
 *   - All polls fail uniformly (Index API outage): tick returns ok with
 *     summary showing 0 fetched + N agent-level failures. Cron tries
 *     again next minute. No state corruption.
 */
import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { recordIndexMatch } from "@/lib/index-match-recorder";
import { notifyIndexMatch } from "@/lib/index-match-notifier";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INDEX_API_BASE_DEFAULT = "https://protocol.index.network";

// ── Confirmed response shape (Yanek, 2026-05-19, with real data sample) ──
//
//   {
//     "opportunities": [{
//       "id": "uuid",
//       "status": "accepted",
//       "actors": [
//         { "userId": "uuid", "networkId": "uuid", "role": "patient|agent", "name": "...", "intent": "..." },
//         { "userId": "uuid", "networkId": "uuid", "role": "patient|agent", "name": "...", "intent": "..." }
//       ],
//       "interpretation": { "category": "...", "reasoning": "...", "confidence": 0.95, "signals": [...] },
//       "confidence": "0.95",
//       "createdAt": "iso", "updatedAt": "iso", "expiresAt": null,
//       "context": { "conversationId": "..." },
//       "counterpartName": "..."
//     }]
//   }
//
//   Yanek confirmed actors[].userId is the SAME global user.id from /signup
//   — our instaclaw_vms.index_user_id lookup works as-is.

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

interface AgentPollResult {
  vmName: string;
  status: number;
  count: number;
  opportunities: IndexOpportunity[];
  errorBody?: string;
}

export async function GET(req: NextRequest) {
  // ── 1. Auth ──
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── 2. Feature flag (default-on; only "false" disables) ──
  if (process.env.INDEX_POLLER_ENABLED === "false") {
    return NextResponse.json({ skipped: "INDEX_POLLER_ENABLED=false" });
  }

  const apiBase = (
    process.env.INDEX_NETWORK_API_URL?.trim() || INDEX_API_BASE_DEFAULT
  ).replace(/\/+$/, "");
  const url = `${apiBase}/api/opportunities?status=accepted`;

  // ── 3. Pull all edge_city agents with a non-null index_api_key ──
  const sb = getSupabase();
  const { data: agents, error: agentsErr } = await sb
    .from("instaclaw_vms")
    .select("name, index_api_key")
    .eq("partner", "edge_city")
    .not("index_api_key", "is", null)
    .order("name");
  if (agentsErr) {
    logger.error("[index-poller] agent query failed", { error: agentsErr.message });
    return NextResponse.json(
      { error: "agent_query_failed", detail: agentsErr.message },
      { status: 502 },
    );
  }
  if (!agents || agents.length === 0) {
    return NextResponse.json({ skipped: "no_provisioned_agents" });
  }

  // ── 4. Parallel fetch — one GET per agent's key ──
  const pollResults = await Promise.all(
    agents.map((agent) =>
      pollOne(url, agent.name as string, agent.index_api_key as string),
    ),
  );

  // ── 5. In-memory dedup by opportunity.id ──
  // Bidirectional matches (both actors in our cohort) appear in both
  // agents' polls. Dedup before calling recordIndexMatch so we don't waste
  // a Supabase INSERT round-trip on the UNIQUE-constraint catch path.
  const deduped = new Map<string, IndexOpportunity>();
  for (const pr of pollResults) {
    for (const opp of pr.opportunities) {
      if (!opp?.id || typeof opp.id !== "string") continue;
      if (!deduped.has(opp.id)) deduped.set(opp.id, opp);
    }
  }

  // ── 6. Record each unique opportunity ──
  const recordSummary = {
    fetched_per_agent: pollResults.map((r) => ({ agent: r.vmName, count: r.count, status: r.status })),
    unique_after_dedup: deduped.size,
    recorded: 0,
    already_recorded: 0,
    skipped: 0,
    failed: 0,
    // Per-side notification outcomes. Telegram delivery happens AFTER
    // recordIndexMatch returns 'recorded' (we don't re-notify on
    // already_recorded). Per-side because partial failures retry just
    // the failed side on the next tick (notified_*_at column-backed
    // idempotency — see lib/index-match-notifier.ts).
    notify_source_delivered: 0,
    notify_source_skipped: 0,
    notify_source_failed: 0,
    notify_candidate_delivered: 0,
    notify_candidate_skipped: 0,
    notify_candidate_failed: 0,
  };
  const recordErrors: Array<{ opportunityId: string; reason: string; detail?: string }> = [];
  const notifyErrors: Array<{ opportunityId: string; side: "source" | "candidate"; reason: string; detail?: string }> = [];

  for (const [_id, opp] of deduped) {
    const normalized = normalizeOpportunity(opp);
    if (!normalized) {
      recordSummary.skipped++;
      recordErrors.push({ opportunityId: opp.id, reason: "unparseable_opportunity" });
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
      if (result.status === "recorded") {
        recordSummary.recorded++;
        // Fire-and-await Telegram notifications to both sides.
        // The notifier is internally per-side idempotent — running on
        // a re-recorded match (which shouldn't happen due to UNIQUE
        // constraint but defense in depth) is a no-op.
        try {
          const notifyRes = await notifyIndexMatch({
            outcomeId: result.outcomeId,
            sourceUserId: result.sourceUserId,
            candidateUserId: result.candidateUserId,
            opportunity: opp,
          });
          tallyNotifyResult(notifyRes.source, "source", recordSummary, notifyErrors, normalized.opportunityId);
          tallyNotifyResult(notifyRes.candidate, "candidate", recordSummary, notifyErrors, normalized.opportunityId);
        } catch (err) {
          // Notifier exception — the match is still recorded (good); just
          // the notification failed. Both sides will be retried on the
          // next tick because notified_*_at stays NULL.
          const msg = err instanceof Error ? err.message : String(err);
          notifyErrors.push({ opportunityId: normalized.opportunityId, side: "source", reason: "notifier_exception", detail: msg.slice(0, 200) });
          notifyErrors.push({ opportunityId: normalized.opportunityId, side: "candidate", reason: "notifier_exception", detail: msg.slice(0, 200) });
        }
      } else if (result.status === "already_recorded") {
        recordSummary.already_recorded++;
        // ALSO fire notify here for the case where a prior tick recorded
        // the match but the notification path failed transiently. The
        // notifier reads notified_*_at to skip already-delivered sides;
        // only the actually-pending sides get retried.
        try {
          const sb2 = getSupabase();
          const { data: row } = await sb2
            .from("matchpool_outcomes")
            .select("source_user_id, candidate_user_id, notified_source_at, notified_candidate_at")
            .eq("outcome_id", result.outcomeId)
            .maybeSingle();
          if (row && (!row.notified_source_at || !row.notified_candidate_at)) {
            const notifyRes = await notifyIndexMatch({
              outcomeId: result.outcomeId,
              sourceUserId: row.source_user_id as string,
              candidateUserId: row.candidate_user_id as string,
              opportunity: opp,
            });
            tallyNotifyResult(notifyRes.source, "source", recordSummary, notifyErrors, normalized.opportunityId);
            tallyNotifyResult(notifyRes.candidate, "candidate", recordSummary, notifyErrors, normalized.opportunityId);
          }
        } catch (err) {
          /* swallow — already_recorded means downstream state is fine */
        }
      } else if (result.status === "skipped") {
        recordSummary.skipped++;
        recordErrors.push({
          opportunityId: normalized.opportunityId,
          reason: result.reason,
          detail: result.detail,
        });
      } else {
        recordSummary.failed++;
        recordErrors.push({
          opportunityId: normalized.opportunityId,
          reason: result.reason,
          detail: result.detail,
        });
      }
    } catch (err) {
      recordSummary.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      recordErrors.push({
        opportunityId: normalized.opportunityId,
        reason: "unhandled_exception",
        detail: msg.slice(0, 200),
      });
    }
  }

  // ── Log + return ──
  // Per-agent errors (not recordIndexMatch failures — those are per-opp above)
  const pollErrors = pollResults
    .filter((p) => p.status !== 200)
    .map((p) => ({ agent: p.vmName, status: p.status, body: p.errorBody?.slice(0, 150) }));

  if (recordSummary.recorded > 0 || recordSummary.failed > 0 || pollErrors.length > 0) {
    logger.info("[index-poller] tick complete", {
      agents_polled: agents.length,
      agents_with_errors: pollErrors.length,
      ...recordSummary,
    });
  }

  return NextResponse.json({
    ok: true,
    summary: recordSummary,
    poll_errors: pollErrors,
    record_errors: recordErrors.slice(0, 10),
    notify_errors: notifyErrors.slice(0, 10),
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

async function pollOne(
  url: string,
  vmName: string,
  apiKey: string,
): Promise<AgentPollResult> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { vmName, status: res.status, count: 0, opportunities: [], errorBody: body };
    }
    const parsed = (await res.json()) as Partial<IndexOpportunitiesResponse>;
    const opps = Array.isArray(parsed.opportunities) ? parsed.opportunities : [];
    return { vmName, status: 200, count: opps.length, opportunities: opps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { vmName, status: 0, count: 0, opportunities: [], errorBody: msg.slice(0, 150) };
  }
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

// ── Notify tally helper ─────────────────────────────────────────────
import type { NotifySideResult } from "@/lib/index-match-notifier";

function tallyNotifyResult(
  result: NotifySideResult,
  side: "source" | "candidate",
  summary: {
    notify_source_delivered: number;
    notify_source_skipped: number;
    notify_source_failed: number;
    notify_candidate_delivered: number;
    notify_candidate_skipped: number;
    notify_candidate_failed: number;
  },
  errors: Array<{ opportunityId: string; side: "source" | "candidate"; reason: string; detail?: string }>,
  opportunityId: string,
): void {
  if (result.status === "delivered") {
    if (side === "source") summary.notify_source_delivered++;
    else summary.notify_candidate_delivered++;
  } else if (result.status === "already_notified") {
    // Don't count — neither delivered nor skipped this tick.
  } else if (result.status === "skipped") {
    if (side === "source") summary.notify_source_skipped++;
    else summary.notify_candidate_skipped++;
    errors.push({ opportunityId, side, reason: result.reason });
  } else if (result.status === "failed") {
    if (side === "source") summary.notify_source_failed++;
    else summary.notify_candidate_failed++;
    errors.push({ opportunityId, side, reason: result.reason, detail: result.detail });
  }
}
