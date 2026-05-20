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
import { sendAdminAlertEmail } from "@/lib/email";

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
  /** Classified failure kind (only set when status !== 200). */
  errorClass?: PollErrorClass;
  /** Whether this result is from a retried attempt (only set on retry). */
  retried?: boolean;
}

/**
 * Failure-mode classification — keeps "Yanek is down" distinguishable
 * from "one VM has a dead key" in the alert log + emails.
 *
 *   • connect_timeout — undici UND_ERR_CONNECT_TIMEOUT (Yanek's endpoint
 *     unreachable, e.g. Railway deploy mid-flux)
 *   • tls_error       — TLS handshake / cert validation failure (e.g.
 *     2026-05-19 *.up.railway.app cert on the custom domain)
 *   • dns_failure     — ENOTFOUND / EAI_AGAIN
 *   • http_4xx        — 400-499 (likely per-VM auth: key revoked, etc.)
 *   • http_5xx        — Yanek's server returned 500+
 *   • http_other      — 1xx / 3xx anything else
 *   • transport_other — fetch threw, no specific signature matched
 */
export type PollErrorClass =
  | "connect_timeout"
  | "tls_error"
  | "dns_failure"
  | "http_4xx"
  | "http_5xx"
  | "http_other"
  | "transport_other";

/** Decide which failure classes are worth a retry. */
const RETRYABLE_CLASSES: ReadonlySet<PollErrorClass> = new Set([
  "http_5xx",
  "connect_timeout",
  "transport_other",
]);

const POLL_RETRY_DELAY_MS = 1500;

/**
 * Classify a poll outcome. `status === 0` means fetch threw (no HTTP
 * response); fall back to message-text heuristics over `errorBody`.
 * Exported so the dry-run verification test can exercise this without
 * spinning up the whole route.
 */
export function classifyPollError(status: number, errorBody: string): PollErrorClass {
  if (status >= 400 && status < 500) return "http_4xx";
  if (status >= 500 && status < 600) return "http_5xx";
  if (status === 0) {
    const lc = errorBody.toLowerCase();
    if (
      lc.includes("und_err_connect_timeout") ||
      lc.includes("connect_timeout") ||
      (lc.includes("connect") && lc.includes("timeout"))
    ) {
      return "connect_timeout";
    }
    if (
      lc.includes("cert") ||
      lc.includes("tls") ||
      lc.includes("ssl") ||
      lc.includes("self signed") ||
      lc.includes("subjectaltname") ||
      lc.includes("does not match")
    ) {
      return "tls_error";
    }
    if (
      lc.includes("enotfound") ||
      lc.includes("eai_again") ||
      lc.includes("getaddrinfo") ||
      lc.includes("dns")
    ) {
      return "dns_failure";
    }
    return "transport_other";
  }
  return "http_other";
}

/**
 * From an array of poll results, decide if a fleet-level alert should
 * fire and what its dominant error class is. Pure — no DB / no email.
 * Exported so verification tests can dry-run against synthetic input
 * matching today's actual outage state.
 */
export function classifyPollBatch(results: AgentPollResult[]): {
  shouldAlert: boolean;
  failureRate: number;
  failureCount: number;
  total: number;
  dominantClass: PollErrorClass | "none";
  dominantCount: number;
  classCounts: Record<string, number>;
} {
  const total = results.length;
  const failures = results.filter((r) => r.status !== 200);
  const failureCount = failures.length;
  const failureRate = total === 0 ? 0 : failureCount / total;
  const classCounts: Record<string, number> = {};
  let dominantClass: PollErrorClass | "none" = "none";
  let dominantCount = 0;
  for (const f of failures) {
    const cls = f.errorClass ?? "transport_other";
    classCounts[cls] = (classCounts[cls] ?? 0) + 1;
    if (classCounts[cls] > dominantCount) {
      dominantCount = classCounts[cls];
      dominantClass = cls as PollErrorClass;
    }
  }
  // Threshold: alert if MORE THAN 50% of agents are failing. Equal
  // 50/50 split is borderline-noisy and we'd rather wait another tick.
  const shouldAlert = total > 0 && failureRate > 0.5;
  return {
    shouldAlert,
    failureRate,
    failureCount,
    total,
    dominantClass,
    dominantCount,
    classCounts,
  };
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
    .map((p) => ({
      agent: p.vmName,
      status: p.status,
      errorClass: p.errorClass,
      retried: p.retried ?? false,
      body: p.errorBody?.slice(0, 150),
    }));

  // ── Threshold-based admin alert (#5, Rule 49 dedup pattern) ──
  //
  // If MORE THAN 50% of agents failed in this tick, fire a 6h-deduped
  // admin alert. Alert key encodes the dominant error class so a shift
  // from connect_timeout → tls_error mid-outage re-fires the alert
  // (new signal).
  //
  // Best-effort: failure of the alert path must NOT corrupt the
  // poller's response or block subsequent ticks. Try/catch outermost.
  let alertOutcome: AlertOutcome = { fired: false, suppressed: false, reason: "below_threshold" };
  try {
    alertOutcome = await maybeFireHighFailureAlert(pollResults);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("[index-poller] alert path threw (swallowed)", {
      error: msg.slice(0, 200),
    });
  }

  if (recordSummary.recorded > 0 || recordSummary.failed > 0 || pollErrors.length > 0 || alertOutcome.fired) {
    logger.info("[index-poller] tick complete", {
      agents_polled: agents.length,
      agents_with_errors: pollErrors.length,
      alert: alertOutcome,
      ...recordSummary,
    });
  }

  return NextResponse.json({
    ok: true,
    summary: recordSummary,
    poll_errors: pollErrors,
    alert: alertOutcome,
    record_errors: recordErrors.slice(0, 10),
    notify_errors: notifyErrors.slice(0, 10),
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Single GET attempt against Yanek's /api/opportunities. Returns the
 * normalized result. Caller decides whether to retry.
 *
 * Node's fetch wraps undici errors in `.cause`; we unwrap so the
 * resulting `errorBody` carries enough signature for classifyPollError
 * to distinguish connect_timeout from TLS issues from DNS issues.
 */
async function singlePoll(
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
    let msg = err instanceof Error ? err.message : String(err);
    // Unwrap the underlying undici / Node cause if present — undici sets
    // err.cause with code = UND_ERR_CONNECT_TIMEOUT, EAI_AGAIN, etc.
    // Without the unwrap, top-level err.message is "fetch failed" which
    // classifies as transport_other (loses signal).
    const cause = (err as { cause?: unknown })?.cause as
      | { message?: string; code?: string }
      | undefined;
    if (cause) {
      const causeParts: string[] = [];
      if (cause.code) causeParts.push(`code=${cause.code}`);
      if (cause.message) causeParts.push(cause.message);
      if (causeParts.length > 0) msg += " | cause: " + causeParts.join(" ");
    }
    return { vmName, status: 0, count: 0, opportunities: [], errorBody: msg.slice(0, 300) };
  }
}

/**
 * Wrap singlePoll with: error classification + retry-once-with-backoff
 * for retryable classes (http_5xx, connect_timeout, transport_other).
 *
 * Non-retryable failures (http_4xx, tls_error, dns_failure, http_other)
 * surface immediately — the operator cares about distinguishing "Yanek's
 * endpoint is flaking" (retryable, often recovers) from "this VM has
 * a dead key" (4xx, permanent until reprovision).
 */
async function pollOne(
  url: string,
  vmName: string,
  apiKey: string,
  attempt: number = 1,
): Promise<AgentPollResult> {
  const r = await singlePoll(url, vmName, apiKey);
  if (r.status === 200) {
    return attempt > 1 ? { ...r, retried: true } : r;
  }
  const errClass = classifyPollError(r.status, r.errorBody ?? "");
  if (attempt === 1 && RETRYABLE_CLASSES.has(errClass)) {
    logger.info("[index-poller] retrying after retryable error", {
      vmName,
      errClass,
      status: r.status,
      delayMs: POLL_RETRY_DELAY_MS,
    });
    await new Promise((res) => setTimeout(res, POLL_RETRY_DELAY_MS));
    return pollOne(url, vmName, apiKey, attempt + 1);
  }
  return { ...r, errorClass: errClass, retried: attempt > 1 };
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

// ── High-failure threshold alert (#5, Rule 49 dedup) ───────────────

interface AlertOutcome {
  fired: boolean;
  suppressed: boolean;
  /**
   * One of:
   *   - "below_threshold"     ≤50% failure
   *   - "no_agents"           empty input
   *   - "sent"                first fire in 6h window — email sent + log row inserted
   *   - "deduped"             same key fired within 6h — log row inserted, email skipped
   *   - "send_failed"         dedup row written but email send threw
   */
  reason:
    | "below_threshold"
    | "no_agents"
    | "sent"
    | "deduped"
    | "send_failed";
  alertKey?: string;
  failureRate?: number;
  failureCount?: number;
  total?: number;
  dominantClass?: PollErrorClass | "none";
  classCounts?: Record<string, number>;
}

/**
 * If the poll batch has >50% failure rate, fire a 6h-deduped admin
 * alert. Pattern mirrors lib/enospc-guard.ts:sendEnospcAlertDeduped
 * and lib/vm-reconcile.ts:sendVMReadyEmail (record-before-send to
 * prevent races; insert a "suppressed" row when deduped so the log
 * still captures every threshold breach for forensics).
 *
 * Alert key encodes the DOMINANT error class so a shift from
 * connect_timeout → tls_error mid-outage produces a NEW alert (it's
 * new information). Per-class dedup is more useful than a single
 * monolithic "poller-down" key.
 */
async function maybeFireHighFailureAlert(
  results: AgentPollResult[],
): Promise<AlertOutcome> {
  const summary = classifyPollBatch(results);
  if (summary.total === 0) {
    return { fired: false, suppressed: false, reason: "no_agents" };
  }
  if (!summary.shouldAlert) {
    return {
      fired: false,
      suppressed: false,
      reason: "below_threshold",
      failureRate: summary.failureRate,
      failureCount: summary.failureCount,
      total: summary.total,
    };
  }

  const alertKey = `index_poller_high_failure_rate:${summary.dominantClass}`;
  const sb = getSupabase();
  const sixHoursAgoIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  // Dedup check — has this exact key fired within last 6h?
  let recentlySent = false;
  try {
    const { data } = await sb
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", alertKey)
      .gte("sent_at", sixHoursAgoIso)
      .limit(1);
    recentlySent = (data?.length ?? 0) > 0;
  } catch (err) {
    // Dedup-table missing or transient — proceed without dedup. Better
    // to over-alert on a first signal than miss it. Matches the
    // enospc-guard and vm-ready paths' failure mode.
    logger.warn("[index-poller] dedup query failed; proceeding to send", {
      alertKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (recentlySent) {
    // Log the suppression for forensics — operator can still see that
    // a threshold breach happened on this tick by scanning details.
    try {
      await sb.from("instaclaw_admin_alert_log").insert({
        alert_key: alertKey,
        vm_count: summary.failureCount,
        details: `suppressed (dedup): ${summary.failureCount}/${summary.total} agents failing, dominant=${summary.dominantClass}, classes=${JSON.stringify(summary.classCounts)}`,
      });
    } catch {
      /* log-insert failed; non-fatal */
    }
    return {
      fired: false,
      suppressed: true,
      reason: "deduped",
      alertKey,
      failureRate: summary.failureRate,
      failureCount: summary.failureCount,
      total: summary.total,
      dominantClass: summary.dominantClass,
      classCounts: summary.classCounts,
    };
  }

  // First fire in 6h — record BEFORE sending email so two near-
  // simultaneous ticks don't both alert. Insert failure is non-fatal:
  // the operator gets the email either way; only the dedup safety net
  // weakens, which we can live with on a poller that runs once/min.
  try {
    await sb.from("instaclaw_admin_alert_log").insert({
      alert_key: alertKey,
      vm_count: summary.failureCount,
      details: `sent: index poller ${summary.failureCount}/${summary.total} agents failing (${Math.round(summary.failureRate * 100)}%), dominant=${summary.dominantClass}, classes=${JSON.stringify(summary.classCounts)}`,
    });
  } catch (err) {
    logger.warn("[index-poller] alert log insert failed; sending anyway", {
      alertKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Build email body. Include per-class breakdown + 3-VM sample +
  // dominant-class-specific triage guidance so the operator can act
  // without re-deriving context.
  const subject = `[Index Poller] ${summary.failureCount}/${summary.total} agents failing (${summary.dominantClass})`;
  const sample = results
    .filter((r) => r.status !== 200)
    .slice(0, 3)
    .map(
      (r) =>
        `  • ${r.vmName.padEnd(20)} status=${r.status} class=${r.errorClass} body=${(r.errorBody ?? "").slice(0, 120)}`,
    )
    .join("\n");
  const triage =
    summary.dominantClass === "connect_timeout"
      ? "→ Yanek's endpoint (protocol.dev.index.network) is likely unreachable. Verify: curl -I https://protocol.dev.index.network/mcp. Ping Yanek if his deploy/Railway is mid-flux."
      : summary.dominantClass === "tls_error"
        ? "→ TLS cert issue on Yanek's side. The custom domain mapping may be misconfigured (seen 2026-05-19: *.up.railway.app cert served on protocol.dev.index.network). Ping Yanek."
        : summary.dominantClass === "dns_failure"
          ? "→ DNS resolution failing. Probably transient. If persistent, check Vercel function region's resolver or Yanek's domain config."
          : summary.dominantClass === "http_4xx"
            ? "→ Per-VM key issue. Likely some keys were invalidated. Run scripts/_probe-mcp-tool-call.ts to identify dead keys, then scripts/_reprovision-index-keys.ts ONLY after confirming Yanek's rotateKey:boolean param is available (calling /signup blind rotates keys)."
            : summary.dominantClass === "http_5xx"
              ? "→ Yanek's server is returning 500s. Probably transient — watch over the next 15-30 min."
              : "→ Mixed/unknown failures. See per-class breakdown above; correlate with the 3-VM sample.";
  const body =
    `Index poller tick at ${new Date().toISOString()} saw ${summary.failureCount}/${summary.total} agents fail (${Math.round(summary.failureRate * 100)}%).\n` +
    `\n` +
    `Dominant error class: ${summary.dominantClass} (${summary.classCounts[summary.dominantClass as string] ?? 0} agents)\n` +
    `\n` +
    `Per-class breakdown:\n` +
    Object.entries(summary.classCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([cls, count]) => `  • ${cls.padEnd(20)} ${count} agents`)
      .join("\n") +
    `\n\n` +
    `Sample failures (first 3):\n${sample}\n` +
    `\n` +
    `Triage:\n${triage}\n` +
    `\n` +
    `Alert key: ${alertKey}\n` +
    `Dedup window: 6h (next alert for THIS class suppressed until ${new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()})\n` +
    `A shift in dominant class within the window WILL re-alert.\n`;

  try {
    await sendAdminAlertEmail(subject, body);
  } catch (err) {
    logger.error("[index-poller] sendAdminAlertEmail failed", {
      alertKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      fired: false,
      suppressed: false,
      reason: "send_failed",
      alertKey,
      failureRate: summary.failureRate,
      failureCount: summary.failureCount,
      total: summary.total,
      dominantClass: summary.dominantClass,
      classCounts: summary.classCounts,
    };
  }

  return {
    fired: true,
    suppressed: false,
    reason: "sent",
    alertKey,
    failureRate: summary.failureRate,
    failureCount: summary.failureCount,
    total: summary.total,
    dominantClass: summary.dominantClass,
    classCounts: summary.classCounts,
  };
}
