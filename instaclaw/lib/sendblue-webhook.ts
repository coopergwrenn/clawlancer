/**
 * Sendblue inbound webhook utilities.
 *
 * Pure-logic helpers used by `/api/imessage/inbound/route.ts`. Lives
 * in its own module so the validation, secret verification, and
 * payload-extraction layers can be tested without spinning up the
 * Next.js route or providing Sendblue credentials.
 *
 * The route file owns orchestration (read raw body → verify → parse →
 * classify → respond). This module owns the building blocks.
 *
 * ─── Webhook signing model ───
 *
 * Sendblue uses a STATIC SHARED SECRET in the `sb-signing-secret`
 * header — NOT HMAC-of-body like Stripe. The header value IS the
 * secret. We compare it to SENDBLUE_WEBHOOK_SECRET in env, in
 * constant time, with sha256-pre-hashing so the comparison itself
 * doesn't leak length via timing.
 *
 * This is simpler than HMAC but slightly weaker (an attacker who
 * captures one webhook request can replay it). We can't choose the
 * protocol — Sendblue dictates it. The shared-secret-in-header model
 * is what most webhook providers use; Stripe is the exception.
 *
 * ─── Inbound payload shape (from Sendblue docs) ───
 *
 *   accountEmail     string (camelCase!)
 *   content          string  — message body
 *   is_outbound      boolean — false for inbound
 *   status           string  — "RECEIVED" for inbound messages
 *   error_code       null|string  — set on outbound error events
 *   error_message    null|string
 *   message_handle   string
 *   date_sent        ISO 8601
 *   date_updated     ISO 8601
 *   from_number      string  — sender's E.164 (the user)
 *   number           string
 *   to_number        string  — our Sendblue line
 *   was_downgraded   boolean — true if iMessage fell back to SMS
 *   media_url        null|string
 *   message_type     string  — "message", possibly "reaction" etc.
 *   sendblue_number  string  — our Sendblue line (redundant with to_number)
 *   service          string  — "iMessage" or "SMS"
 *
 * The handler only needs a subset; we surface the analytics-relevant
 * fields (service, was_downgraded) so callers can log them.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export interface SendblueInboundPayload {
  accountEmail?: string;
  content?: string;
  is_outbound?: boolean;
  status?: string;
  error_code?: string | null;
  error_message?: string | null;
  message_handle?: string;
  date_sent?: string;
  date_updated?: string;
  from_number?: string;
  number?: string;
  to_number?: string;
  was_downgraded?: boolean;
  media_url?: string | null;
  message_type?: string;
  sendblue_number?: string;
  service?: string;
  group_id?: string | null;
}

export interface ExtractedInbound {
  fromNumber: string | null;
  content: string | null;
  isOutbound: boolean;
  status: string | null;
  service: string | null;
  wasDowngraded: boolean;
  messageType: string | null;
  messageHandle: string | null;
  mediaUrl: string | null;
  /**
   * Sendblue sets group_id to a non-null identifier when the message came
   * from a group chat (someone added our line to a group). For onboarding
   * we ignore group messages — the flow is strictly 1-on-1.
   */
  groupId: string | null;
}

/**
 * Pull the relevant fields out of a Sendblue inbound payload.
 *
 * Sendblue's docs use consistent snake_case throughout (no camelCase
 * aliases observed in production payloads), so we read the documented
 * names directly. Non-string fields normalize to null rather than
 * crashing — defensive against API drift.
 *
 * The handler uses these to:
 *   - fromNumber + content: identify the sender + message
 *   - isOutbound: skip echoes of our own sends
 *   - status: require "RECEIVED" before treating as user message
 *   - service: log "iMessage" vs "SMS" for analytics
 *   - wasDowngraded: log SMS-fallback events for analytics
 *   - messageType: skip non-"message" events (reactions, etc.)
 *   - messageHandle: optional for forensics
 */
export function extractInbound(payload: SendblueInboundPayload): ExtractedInbound {
  const stringOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  return {
    fromNumber: stringOrNull(payload.from_number),
    content: stringOrNull(payload.content),
    isOutbound: payload.is_outbound === true,
    status: stringOrNull(payload.status),
    service: stringOrNull(payload.service),
    wasDowngraded: payload.was_downgraded === true,
    messageType: stringOrNull(payload.message_type),
    messageHandle: stringOrNull(payload.message_handle),
    mediaUrl: stringOrNull(payload.media_url),
    groupId: stringOrNull((payload as { group_id?: string | null }).group_id),
  };
}

/**
 * Verify the shared signing secret Sendblue posts in the
 * `sb-signing-secret` header against our SENDBLUE_WEBHOOK_SECRET env.
 *
 * Pattern: sha256-hash both sides, then constant-time compare. This
 * avoids the length-leak in naive string compare (an attacker could
 * otherwise probe whether their guess has the right length via
 * timing — small but real for ~30-char secrets).
 *
 * Returns false on:
 *   - Either input is non-string or empty
 *   - Crypto operation throws (shouldn't happen, but defensive)
 *   - Hash mismatch
 *
 * Returns true ONLY on a constant-time byte-equal of the two hashes.
 */
export function verifySigningSecret(
  provided: string,
  expected: string,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  if (provided.length === 0 || expected.length === 0) {
    return false;
  }
  try {
    const providedHash = createHash("sha256").update(provided, "utf8").digest();
    const expectedHash = createHash("sha256").update(expected, "utf8").digest();
    return timingSafeEqual(providedHash, expectedHash);
  } catch {
    return false;
  }
}
