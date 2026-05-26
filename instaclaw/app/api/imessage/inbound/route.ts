/**
 * POST /api/imessage/inbound — Sendblue webhook for inbound iMessage.
 *
 * This is the highest-stakes handler in the onboarding redesign:
 * the FIRST piece of our system a stranger touches. Per spec §6.5,
 * every second after this fires shapes the user's experience.
 *
 * Flow (spec §6.5.4 timeline):
 *
 *   1. Verify Sendblue's HMAC-SHA256 signature.
 *   2. Parse JSON payload (defensively — never crash on weird shape).
 *   3. Classify sender via lib/onboarding-signup.resolveInbound:
 *      - known  → returning user, route to their VM (stub; item 8 owns it)
 *      - in_flight → repeat texter mid-signup, skip welcome burst
 *      - new    → first-time, fire Welcome 1+2+3 with variable gaps
 *      - error  → DB problem, return 500 so Sendblue retries
 *   4. Return 200 fast; let the welcome burst play out via after().
 *
 * Auth model (CLAUDE.md Rule 13):
 *   This route is on the middleware self-auth allow-list. Its own auth
 *   is a shared signing secret that Sendblue posts in the
 *   `sb-signing-secret` header — we compare to SENDBLUE_WEBHOOK_SECRET
 *   via sha256-hashed constant-time compare in lib/sendblue-webhook.
 *   No NextAuth session. Sendblue does NOT use HMAC-of-body like
 *   Stripe — it's a static secret in the header.
 *
 * Idempotency / race-safety:
 *   The DB enforces a partial unique index on
 *   (channel, channel_identity) WHERE consumed_at IS NULL. If two
 *   inbound webhooks for the same phone hit us within milliseconds,
 *   only one INSERT succeeds; the other catches 23505, re-resolves
 *   via SELECT, and treats it as in_flight. resolveInbound handles
 *   the retry loop.
 *
 * Edge cases handled here:
 *   - Malformed JSON              → 200 skipped (don't make Sendblue retry crap)
 *   - Empty content / non-message → 200 skipped
 *   - Outbound echo from Sendblue → 200 skipped
 *   - Invalid E.164 from_number   → 200 skipped (won't be helped by retry)
 *   - Missing signature           → 401
 *   - Bad signature               → 401
 *   - Missing webhook secret env  → 500 (we don't ship without it set)
 *   - DB unreachable              → 500 (Sendblue retries)
 *
 * Per CLAUDE.md Rule 11, maxDuration=300 because the after() block
 * needs to outlive the response while the welcome burst plays out
 * (2.5s wall time + Sendblue API latency × 3 sends).
 */

import { NextRequest, NextResponse, after } from "next/server";
import { logger } from "@/lib/logger";
import { resolveInbound, type SignupChannel } from "@/lib/onboarding-signup";
import { sendImessage, isValidE164 } from "@/lib/sendblue";
import {
  extractInbound,
  verifySigningSecret,
  type SendblueInboundPayload,
} from "@/lib/sendblue-webhook";
import {
  WELCOME_1,
  WELCOME_2,
  welcome3,
  WELCOME_GAP_1_TO_2_MS,
  WELCOME_GAP_2_TO_3_MS,
} from "@/lib/welcome-messages";

export const maxDuration = 300;

const CHANNEL: SignupChannel = "imessage";

/**
 * Fire the three-message welcome burst with the variable gaps from
 * spec §6.5.3. Wrapped in try/catch because a failed send mid-burst
 * shouldn't crash the after() handler (Vercel logs scary errors when
 * background promises reject unhandled).
 *
 * If W1 succeeds but W2 fails, the user has W1 but not W2/3. That's
 * a degraded but not broken state — they may reach out again, and
 * the in-flight check stops them from getting a redundant W1.
 */
async function fireWelcomeBurst(phone: string, shortCode: string): Promise<void> {
  const phoneRedacted = phone.slice(0, 6) + "***";
  try {
    await sendImessage(phone, WELCOME_1);
    await new Promise((r) => setTimeout(r, WELCOME_GAP_1_TO_2_MS));
    await sendImessage(phone, WELCOME_2);
    await new Promise((r) => setTimeout(r, WELCOME_GAP_2_TO_3_MS));
    await sendImessage(phone, welcome3(shortCode));
    logger.info("[/api/imessage/inbound] welcome burst complete", {
      route: "imessage/inbound",
      phone: phoneRedacted,
      shortCode,
    });
  } catch (err) {
    logger.error("[/api/imessage/inbound] welcome burst failed mid-flight", {
      route: "imessage/inbound",
      phone: phoneRedacted,
      shortCode,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function POST(req: NextRequest) {
  // Read raw body. We use the parsed JSON below; raw is also kept so
  // we can log bodyLength on auth-failure paths without re-stringifying.
  const rawBody = await req.text();

  // ─── Signing secret verification (Rule 13: self-auth) ──
  //
  // Sendblue posts a shared secret in `sb-signing-secret`. We compare
  // to SENDBLUE_WEBHOOK_SECRET via constant-time sha256-hashed equal.
  // NOT HMAC-of-body like Stripe — Sendblue uses static shared secret.
  const expectedSecret = process.env.SENDBLUE_WEBHOOK_SECRET;
  if (!expectedSecret) {
    // Refuse to process any inbound without a webhook secret configured.
    // Per CLAUDE.md Rule 13, new routes that don't use session auth must
    // use their own auth mechanism — and shipping without that mechanism
    // configured is a deploy-time error, not a runtime one.
    logger.error("[/api/imessage/inbound] SENDBLUE_WEBHOOK_SECRET not configured", {
      route: "imessage/inbound",
    });
    return NextResponse.json(
      { error: "Webhook not configured on this environment" },
      { status: 500 },
    );
  }

  const providedSecret = req.headers.get("sb-signing-secret");
  if (!providedSecret) {
    logger.warn("[/api/imessage/inbound] missing sb-signing-secret header", {
      route: "imessage/inbound",
    });
    return NextResponse.json({ error: "Missing signing secret" }, { status: 401 });
  }

  if (!verifySigningSecret(providedSecret, expectedSecret)) {
    logger.warn("[/api/imessage/inbound] signing secret mismatch", {
      route: "imessage/inbound",
      providedPrefix: providedSecret.slice(0, 4) + "***",
      bodyLength: rawBody.length,
    });
    return NextResponse.json({ error: "Invalid signing secret" }, { status: 401 });
  }

  // ─── Payload parsing ──
  let payload: SendblueInboundPayload;
  try {
    payload = JSON.parse(rawBody) as SendblueInboundPayload;
  } catch {
    logger.warn("[/api/imessage/inbound] malformed JSON; halting retry", {
      route: "imessage/inbound",
      bodyLength: rawBody.length,
    });
    // Return 200 so Sendblue doesn't keep retrying a payload we can't parse.
    return NextResponse.json({ ok: true, skipped: "malformed-json" });
  }

  const {
    fromNumber,
    content,
    isOutbound,
    status,
    service,
    wasDowngraded,
    messageType,
    mediaUrl,
    groupId,
  } = extractInbound(payload);

  // Skip group chat messages. Sendblue sets group_id to a non-null
  // identifier when someone adds our line to a group conversation.
  // Onboarding is strictly 1-on-1 — we don't want to treat a group
  // message as a new signup. Plan-policy-safe: we never send anything
  // outbound in this branch (just ack 200).
  if (groupId) {
    logger.info("[/api/imessage/inbound] group message; ignoring", {
      route: "imessage/inbound",
      groupId,
    });
    return NextResponse.json({ ok: true, skipped: "group-message" });
  }

  // Sendblue posts BOTH inbound messages and outbound status updates
  // (QUEUED / SENT / DELIVERED / ERROR) to the same webhook URL when
  // an account subscribes to multiple webhook types. Our setup uses
  // `webhooks set-receive` only, so we shouldn't see outbound — but
  // we filter defensively. status="RECEIVED" is the canonical signal
  // for "this is a user message," and the minimal `receive` payload
  // shape from the docs omits the status field entirely, so absence
  // (status === null) is also treated as a user message.
  if (isOutbound || (status !== null && status !== "RECEIVED")) {
    return NextResponse.json({ ok: true, skipped: "non-received", status });
  }

  // Skip non-message events (reactions, typing indicators, etc.).
  // Sendblue's docs use message_type="message" for the user-text case;
  // we treat the absence of the field as "message" (defensive — older
  // payloads may not have it) and only skip when we see something else.
  if (messageType !== null && messageType !== "message") {
    return NextResponse.json({ ok: true, skipped: "non-message-type", messageType });
  }

  // E.164 validation — required for any downstream sendImessage call.
  if (!fromNumber || !isValidE164(fromNumber)) {
    logger.warn("[/api/imessage/inbound] invalid or missing fromNumber", {
      route: "imessage/inbound",
      hasFromNumber: !!fromNumber,
      fromNumberShape:
        typeof fromNumber === "string" ? `${fromNumber.length}-char string` : typeof fromNumber,
    });
    return NextResponse.json({ ok: true, skipped: "invalid-from-number" });
  }

  // User-engagement signal must be non-empty. A user texting nothing
  // would be impossible from a real client, but a user sending
  // media-only (e.g., screenshot of the QR poster, photo) is a real
  // engagement signal — we accept that as "they want to talk" and
  // proceed to welcome burst. content-and-media-both-empty is the
  // skip case.
  const hasContent = content !== null && content.trim().length > 0;
  const hasMedia = mediaUrl !== null;
  if (!hasContent && !hasMedia) {
    return NextResponse.json({ ok: true, skipped: "empty-message" });
  }

  // Analytics: log the service + downgrade flag for funnel reporting.
  // iMessage = blue bubble (Apple users); SMS = green (Android users
  // or Apple users with iMessage off). was_downgraded means the user
  // is on iMessage but our outbound got SMS-downgraded (e.g., they're
  // offline or have a deactivated Apple ID) — this is an outbound
  // signal but Sendblue may surface it on inbound too.
  if ((service !== null && service !== "iMessage") || wasDowngraded) {
    logger.info("[/api/imessage/inbound] non-blue-bubble delivery", {
      route: "imessage/inbound",
      service,
      wasDowngraded,
    });
  }

  // ─── Classify sender via shared resolver ──
  const resolution = await resolveInbound(CHANNEL, fromNumber);
  const phoneRedacted = fromNumber.slice(0, 6) + "***";

  switch (resolution.kind) {
    case "error":
      logger.error("[/api/imessage/inbound] resolveInbound returned error", {
        route: "imessage/inbound",
        phone: phoneRedacted,
        error: resolution.error,
      });
      // 500 → Sendblue retries this delivery, which is what we want
      // for a transient DB problem.
      return NextResponse.json({ error: "Internal error" }, { status: 500 });

    case "known":
      // Returning user texting their agent. Item 8 (M_RETURN dispatcher)
      // will own the actual gateway POST. For now: log + 200 so Sendblue
      // doesn't retry. Once item 8 lands, route here will forward via
      // lib/channel-routing.ts.
      logger.info("[/api/imessage/inbound] known user (gateway routing pending item 8)", {
        route: "imessage/inbound",
        phone: phoneRedacted,
        userId: resolution.userId,
        vmId: resolution.vmId,
        // content may be null when the user sent media-only; coalesce
        // to 0 so the log shape is stable.
        contentLength: content?.length ?? 0,
        hasMedia: mediaUrl !== null,
      });
      return NextResponse.json({ ok: true, kind: "known" });

    case "in_flight":
      // User has an in-flight signup. Don't re-fire welcome burst —
      // they'd see two copies of Welcome 1+2+3, which feels broken.
      // The in-flight row's short_code is still valid; if they need
      // a reminder, future v2 might send a "still here when you're
      // ready" nudge. For v1, silent ack.
      logger.info("[/api/imessage/inbound] in-flight signup; not re-firing welcome", {
        route: "imessage/inbound",
        phone: phoneRedacted,
        pendingId: resolution.pendingId,
        shortCode: resolution.shortCode,
      });
      return NextResponse.json({ ok: true, kind: "in_flight" });

    case "new":
      // First-time stranger. Fire the welcome burst in the background,
      // ack Sendblue immediately. Per spec §6.5.3 the burst uses
      // variable gaps (2s, 500ms), NOT a uniform 900ms default.
      logger.info("[/api/imessage/inbound] new user — scheduling welcome burst", {
        route: "imessage/inbound",
        phone: phoneRedacted,
        pendingId: resolution.pendingId,
        shortCode: resolution.shortCode,
      });
      after(async () => {
        await fireWelcomeBurst(fromNumber, resolution.shortCode);
      });
      return NextResponse.json({ ok: true, kind: "new" });

    default: {
      // Exhaustiveness check — every resolution.kind should be handled.
      const exhaustive: never = resolution;
      logger.error("[/api/imessage/inbound] unreachable resolution kind", {
        route: "imessage/inbound",
        resolution: exhaustive,
      });
      return NextResponse.json({ error: "Unreachable" }, { status: 500 });
    }
  }
}
