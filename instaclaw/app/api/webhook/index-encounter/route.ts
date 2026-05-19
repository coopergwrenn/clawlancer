/**
 * POST /api/webhook/index-encounter
 *
 * Receiver for Index Network's `opportunity.accepted` events. When the second
 * party of an opportunity calls `PATCH /api/opportunities/:id/status` with
 * `status='accepted'` on Index's side, Index POSTs here. We write the
 * corresponding `matchpool_outcomes` row, which fires the dual-channel
 * trigger we already shipped → the village's encounter-engine renders the
 * meeting on /spectator. See `docs/prd/village-index-network-integration.md`
 * §8 (Path A) for the full architecture.
 *
 * ── Auth ──
 *
 *   HMAC-SHA256 of the raw request body, hex-encoded, in the
 *   `X-Index-Signature` header. Shared secret is `INDEX_WEBHOOK_SECRET`
 *   (set via `printf '%s' "$SEC" | npx vercel env add ...` per Rule 6).
 *   Timing-safe comparison.
 *
 *   If Yanek's actual scheme differs (Bearer token, JWT, etc.), this is
 *   the only spot that needs to change.
 *
 *   Per Rule 13 we're in middleware's selfAuthAPIs allow-list — the
 *   middleware lets unauth requests through; this handler does the auth.
 *
 * ── Payload (best-guess shape) ──
 *
 *   The Index API docs don't yet describe outbound webhook payloads.
 *   The parser accepts the shape we'd expect from their internal vocabulary:
 *
 *   {
 *     "event": "opportunity.accepted",  // string, optional, advisory
 *     "occurredAt": "2026-05-30T12:00:00Z",  // ISO, optional
 *     "data": {
 *       "opportunityId": "uuid",       // required
 *       "networkId": "uuid",           // optional (advisory only)
 *       "parties": [                   // array of >=2 parties
 *         { "userId": "uuid", "role": "proposer" },
 *         { "userId": "uuid", "role": "responder" }
 *       ],
 *       "scores": {                    // optional
 *         "rrf": 0.87,
 *         "mutual": 0.92,
 *         "deliberation": 0.78
 *       }
 *     }
 *   }
 *
 *   `parseEvent()` ALSO accepts a few common alternate shapes (top-level
 *   opportunityId, `users[]` instead of `parties[]`, flat
 *   userIdA/userIdB) so the day-one ping has a chance of working even if
 *   Yanek's exact shape differs. Failed parses return 400 with the field
 *   list expected — Yanek's first 400 tells us how to adapt.
 *
 * ── Response ──
 *
 *   200 + JSON `{ result }` on EVERY successful auth+parse, regardless of
 *   whether we actually wrote a row. Index treats 5xx as retry; we don't
 *   want them retrying when we've made a deterministic skip decision (e.g.
 *   unknown_index_user). The body's `status` field tells them what happened.
 *
 *   401 only on auth failure. 400 only on unparseable body. 502 if Supabase
 *   itself fails (Index can retry that).
 *
 * ── maxDuration ──
 *
 *   The route hits Supabase (~50-200ms). Set to 30s to give comfortable
 *   headroom; well under the Pro 60s default but explicit.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { recordIndexMatch, type RecordIndexMatchInput } from "@/lib/index-match-recorder";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SIGNATURE_HEADER = "x-index-signature";

interface NormalizedEvent {
  opportunityId: string;
  userA: string;
  userB: string;
  metadata: RecordIndexMatchInput["metadata"];
}

export async function POST(req: NextRequest) {
  // ── 1. Capture raw body for signature verification ──
  // Cannot use `req.json()` first — we need bytes-as-received to compute
  // HMAC over. PostgreSQL hashing or JSON re-serialization would diverge.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (e) {
    return NextResponse.json(
      { status: "error", reason: "could_not_read_body" },
      { status: 400 },
    );
  }

  // ── 2. Verify HMAC signature ──
  const secret = process.env.INDEX_WEBHOOK_SECRET;
  if (!secret) {
    // Env not configured — reject (Yanek will see 401 + retry; operator
    // sees the log line and sets the env var). Never accept unsigned in
    // prod.
    logger.error("[index-webhook] INDEX_WEBHOOK_SECRET not configured in env");
    return NextResponse.json(
      { status: "error", reason: "server_not_configured" },
      { status: 401 },
    );
  }

  const provided = req.headers.get(SIGNATURE_HEADER) ?? "";
  if (!provided) {
    logger.warn("[index-webhook] missing signature header", {
      ip: req.headers.get("x-forwarded-for") ?? "(unknown)",
      ua: req.headers.get("user-agent")?.slice(0, 80),
    });
    return NextResponse.json(
      { status: "error", reason: "missing_signature" },
      { status: 401 },
    );
  }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // Both strings must be the same length for timingSafeEqual.
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(
      Buffer.from(provided, "utf8"),
      Buffer.from(expected, "utf8"),
    )
  ) {
    logger.warn("[index-webhook] signature mismatch", {
      ip: req.headers.get("x-forwarded-for") ?? "(unknown)",
      providedPrefix: provided.slice(0, 8),
      bodyLen: rawBody.length,
    });
    return NextResponse.json(
      { status: "error", reason: "signature_mismatch" },
      { status: 401 },
    );
  }

  // ── 3. Parse + normalize the payload ──
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { status: "error", reason: "invalid_json" },
      { status: 400 },
    );
  }

  const normalized = parseEvent(parsed);
  if (!normalized) {
    logger.warn("[index-webhook] could not normalize payload — adapter needed", {
      bodyPrefix: rawBody.slice(0, 300),
    });
    return NextResponse.json(
      {
        status: "error",
        reason: "unparseable_payload",
        detail:
          "Expected one of: { data: { opportunityId, parties:[{userId},{userId}] } } | " +
          "{ data: { opportunityId, users: [...] } } | " +
          "{ opportunityId, userIdA, userIdB }",
      },
      { status: 400 },
    );
  }

  // ── 4. Hand to the recorder ──
  const result = await recordIndexMatch({
    indexOpportunityId: normalized.opportunityId,
    indexUserA: normalized.userA,
    indexUserB: normalized.userB,
    metadata: normalized.metadata,
    source: "webhook",
  });

  // 502 only if the Supabase write itself failed — Index should retry on
  // those. Every other status returns 200 with the structured outcome.
  if (result.status === "error") {
    return NextResponse.json({ result }, { status: 502 });
  }
  return NextResponse.json({ result }, { status: 200 });
}

/**
 * Normalize the incoming event into the shape our recorder needs. Accepts
 * several plausible payload shapes — see header comment for details. Returns
 * null when no shape matches.
 *
 * This is the single place that needs to be updated when Yanek confirms
 * the actual outbound payload format.
 */
function parseEvent(raw: unknown): NormalizedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // Try `data: { ... }` envelope first (most idiomatic).
  const candidates = [o.data, o] as Array<Record<string, unknown> | undefined>;

  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;

    // opportunityId — accept both opportunityId and opportunity_id and id
    const opportunityId =
      asStr(c.opportunityId) ?? asStr(c.opportunity_id) ?? asStr(c.id);
    if (!opportunityId) continue;

    // Two parties — try { parties: [{userId},{userId}] } | { users: [...] } | flat
    let userA: string | null = null;
    let userB: string | null = null;

    const partyList = Array.isArray(c.parties)
      ? (c.parties as Array<Record<string, unknown>>)
      : Array.isArray(c.users)
        ? (c.users as Array<Record<string, unknown>>)
        : null;

    if (partyList && partyList.length >= 2) {
      // Prefer role=proposer/responder when present; else first two.
      const proposer = partyList.find(
        (p) => asStr(p.role) === "proposer" || asStr(p.role) === "accepter",
      );
      const responder = partyList.find(
        (p) =>
          asStr(p.role) === "responder" ||
          asStr(p.role) === "counterparty" ||
          asStr(p.role) === "candidate",
      );
      if (proposer && responder) {
        userA = asStr(proposer.userId) ?? asStr(proposer.user_id) ?? asStr(proposer.id);
        userB = asStr(responder.userId) ?? asStr(responder.user_id) ?? asStr(responder.id);
      } else {
        // No role info — take the first two parties.
        const p0 = partyList[0];
        const p1 = partyList[1];
        userA = asStr(p0.userId) ?? asStr(p0.user_id) ?? asStr(p0.id);
        userB = asStr(p1.userId) ?? asStr(p1.user_id) ?? asStr(p1.id);
      }
    } else {
      // Flat shape: userIdA/userIdB OR sourceUserId/candidateUserId
      userA =
        asStr(c.userIdA) ??
        asStr(c.user_id_a) ??
        asStr(c.sourceUserId) ??
        asStr(c.source_user_id);
      userB =
        asStr(c.userIdB) ??
        asStr(c.user_id_b) ??
        asStr(c.candidateUserId) ??
        asStr(c.candidate_user_id);
    }

    if (!userA || !userB) continue;

    // Pull optional metadata (scores + reasoning). All optional; null-safe.
    const scoresRaw = (c.scores ?? c.score) as
      | { rrf?: number; mutual?: number; deliberation?: number }
      | undefined;
    const reasoning = asStr(c.reasoning);

    return {
      opportunityId,
      userA,
      userB,
      metadata: {
        rrfScore: scoresRaw?.rrf ?? null,
        mutualScore: scoresRaw?.mutual ?? null,
        deliberationScore: scoresRaw?.deliberation ?? null,
        reasoning: reasoning ?? null,
      },
    };
  }

  return null;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
