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
 * ── Payload — aligned to Yanek's confirmed Path C shape ──
 *
 *   Yanek confirmed (2026-05-19) that Index does NOT have outbound webhooks
 *   today. Path C (the cron poller) is the primary path. This route stays
 *   in place as dead code in case he adds outbound webhooks later.
 *
 *   If/when he does add outbound webhooks, we expect (and parse) the same
 *   per-opportunity shape Path C polls — wrapped in a single-opportunity
 *   envelope rather than an array:
 *
 *   {
 *     "event": "opportunity.accepted",            // advisory, ignored by parser
 *     "occurredAt": "2026-05-30T12:00:00Z",       // advisory
 *     "data": {                                   // single opportunity object
 *       "id": "uuid",
 *       "status": "accepted",
 *       "actors": [
 *         { "userId": "uuid", "role": "patient|agent", ... },
 *         { "userId": "uuid", "role": "patient|agent", ... }
 *       ],
 *       "interpretation": { "category", "reasoning", "confidence", "signals" },
 *       "confidence": "0.95",
 *       "createdAt": "iso", "updatedAt": "iso"
 *     }
 *   }
 *
 *   `parseEvent()` accepts the opportunity either wrapped in `data` or
 *   at the top level. No other shape variants — the parser mirrors the
 *   poller's `normalizeOpportunity` exactly.
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
          "Expected: { data?: { id, status, actors: [{userId,role}, ...] } } " +
          "or the opportunity at the top level. Roles 'agent' / 'patient' " +
          "are recognized for ordering but not required.",
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
 * Normalize the incoming event into the shape our recorder needs.
 *
 * Mirrors Path C's `normalizeOpportunity` exactly — same confirmed Yanek
 * shape, just unwrapped from either `{data: ...}` or top-level. If Index
 * ever adds outbound webhooks, this will Just Work as long as they emit
 * the same per-opportunity payload as the poller endpoint returns.
 */
interface IndexOpportunityActor {
  userId?: string;
  role?: string;
}

interface IndexOpportunity {
  id?: string;
  actors?: IndexOpportunityActor[];
  interpretation?: { reasoning?: string; confidence?: number };
  confidence?: string;
}

function parseEvent(raw: unknown): NormalizedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // Accept either { data: opportunity } or { opportunity at top level }.
  const candidates: IndexOpportunity[] = [];
  if (o.data && typeof o.data === "object") candidates.push(o.data as IndexOpportunity);
  candidates.push(o as IndexOpportunity);

  for (const opp of candidates) {
    if (!opp.id || typeof opp.id !== "string") continue;
    if (!Array.isArray(opp.actors) || opp.actors.length < 2) continue;

    // Role pairing: agent → source, patient → candidate.
    const agent = opp.actors.find((a) => a.role === "agent");
    const patient = opp.actors.find((a) => a.role === "patient");

    let userA: string | null = null;
    let userB: string | null = null;
    if (agent?.userId && patient?.userId && agent.userId !== patient.userId) {
      userA = agent.userId;
      userB = patient.userId;
    } else {
      userA = opp.actors[0]?.userId ?? null;
      userB = opp.actors[1]?.userId ?? null;
    }
    if (!userA || !userB) continue;

    // Score mapping: same as Path C.
    const deliberation =
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
          deliberation !== null && Number.isFinite(deliberation) ? deliberation : null,
        reasoning: opp.interpretation?.reasoning ?? null,
      },
    };
  }

  return null;
}
