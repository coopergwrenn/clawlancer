/**
 * Frontier human_approved hardening -- pure helpers (Surface 1 + 3).
 *
 * Two concerns, both pure (no I/O, fully testable -- Rule 31):
 *
 *   1. Session-approval row logic: does an `instaclaw_frontier_spend_approvals`
 *      row authorize THIS spend? An approved row only counts if it is fresh (not
 *      past its TTL), not already consumed, and binds to the exact spend identity
 *      (amount + category + counterparty) the agent is now re-authorizing. The
 *      identity binding is the anti-amount-swap guard: get $1 approved, you cannot
 *      spend $100 on the same request_id.
 *
 *   2. The one-tap revoke token: an HMAC over (vm_id, issued_at) signed with
 *      NEXTAUTH_SECRET (mirrors lib/openai-signup-token.ts). The Telegram "was that
 *      you? Revoke" button carries this token. Revoke only ever DISABLES spend (the
 *      fail-safe direction), so a signed GET one-tap is correct: the worst an
 *      attacker with the link can do is turn a customer's spend off. The agent never
 *      holds NEXTAUTH_SECRET, so it cannot forge the link for its own VM.
 *
 * The matching SQL table ships in
 * supabase/pending_migrations/20260610210000_frontier_spend_approvals.sql.
 */

import crypto from "crypto";

/** A session-approval is valid for 15 minutes after it is minted. A stale URL past
 *  this window cannot be approved (confirm endpoint) or honored (authorize route). */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** The revoke link is valid for 24h after it is issued (a notification a user opens
 *  the next morning still works; an ancient leaked link does not). */
export const REVOKE_TOKEN_TTL_S = 24 * 60 * 60;

export type ApprovalStatus =
  | "pending_approval"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

/** The subset of an approval row the pure logic needs. */
export interface ApprovalRow {
  status: ApprovalStatus;
  amount_usd: number | string; // numeric comes back from PostgREST as a string
  category: string | null;
  counterparty: string | null;
  expires_at: string; // ISO
}

/** The spend the agent is (re-)authorizing right now. */
export interface SpendIdentity {
  amountUsd: number;
  category: string | null;
  counterparty: string | null;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** True iff the approval's captured identity matches the spend now being authorized.
 *  Amount compared at 6dp (the ledger's precision); category/counterparty exact
 *  (null === null is a match -- both "unspecified"). */
export function approvalMatchesSpend(row: ApprovalRow, spend: SpendIdentity): boolean {
  const rowAmt = round6(typeof row.amount_usd === "string" ? parseFloat(row.amount_usd) : row.amount_usd);
  if (!Number.isFinite(rowAmt)) return false;
  if (rowAmt !== round6(spend.amountUsd)) return false;
  if ((row.category ?? null) !== (spend.category ?? null)) return false;
  if ((row.counterparty ?? null) !== (spend.counterparty ?? null)) return false;
  return true;
}

/** Has this approval passed its TTL as of nowMs? (Independent of stored status --
 *  the read path lazily treats a past-TTL row as expired even if not yet marked.) */
export function isApprovalExpired(row: ApprovalRow, nowMs: number): boolean {
  const exp = Date.parse(row.expires_at);
  if (!Number.isFinite(exp)) return true; // unparseable expiry -> treat as expired (fail-safe)
  return nowMs > exp;
}

/**
 * The single authoritative "does this row authorize this spend right now?" check
 * for the authorize route. Returns a discriminated verdict so the route can branch:
 *   - "approved"           -> honor it (consume + reserve with human_approved=true)
 *   - "identity_mismatch"  -> a fresh approved row exists but for a DIFFERENT spend
 *                             identity (anti-amount-swap) -> surface, do NOT honor
 *   - "pending"            -> still awaiting the human (re-relay the approval URL)
 *   - "none"               -> no usable approval (absent / denied / expired / consumed
 *                             / stale) -> fall through to the normal autonomy gate
 */
export function evaluateApproval(
  row: ApprovalRow | null | undefined,
  spend: SpendIdentity,
  nowMs: number,
): "approved" | "identity_mismatch" | "pending" | "none" {
  if (!row) return "none";
  if (row.status === "denied" || row.status === "consumed" || row.status === "expired") return "none";
  if (isApprovalExpired(row, nowMs)) return "none";
  if (row.status === "pending_approval") return "pending";
  // status === "approved" and fresh:
  return approvalMatchesSpend(row, spend) ? "approved" : "identity_mismatch";
}

// ── One-tap revoke token (HMAC, mirrors lib/openai-signup-token.ts) ──

const REVOKE_TOKEN_AUD = "frontier-revoke";

interface RevokePayload {
  vm: string; // instaclaw_vms.id to disable
  jti: string; // 16-byte hex random
  aud: string; // REVOKE_TOKEN_AUD (cross-purpose-reuse defense)
}

export type RevokeSignResult = { ok: true; token: string } | { ok: false; error: string };
export type RevokeVerifyResult =
  | { ok: true; vmId: string }
  | { ok: false; reason: "malformed" | "missing_secret" | "expired" | "bad_sig" | "bad_aud" };

function getSecret(): string | null {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s || s.length < 16) return null;
  return s;
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf-8") : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf-8");
}

function constantTimeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Mint a one-tap revoke token for a VM. ok:false only if NEXTAUTH_SECRET is
 *  misconfigured -- callers degrade gracefully (skip the revoke button, the
 *  notification still informs; the user can revoke from the dashboard). */
export function signRevokeToken(vmId: string, nowMs: number): RevokeSignResult {
  const secret = getSecret();
  if (!secret) return { ok: false, error: "NEXTAUTH_SECRET unset or too short" };
  if (!vmId || typeof vmId !== "string") return { ok: false, error: "vmId required" };

  const payload: RevokePayload = {
    vm: vmId,
    jti: crypto.randomBytes(16).toString("hex"),
    aud: REVOKE_TOKEN_AUD,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const exp = Math.floor(nowMs / 1000) + REVOKE_TOKEN_TTL_S;
  const hmac = crypto.createHmac("sha256", secret).update(`${payloadB64}.${exp}`).digest("hex");
  return { ok: true, token: `${payloadB64}.${exp}.${hmac}` };
}

/** Verify a revoke token. Constant-time HMAC compare. Returns the vmId on success;
 *  the caller still confirms the VM exists + flips frontier_spend_enabled (defense
 *  in depth -- a leaked-secret attacker would still need a real vm.id, and the worst
 *  outcome is a spend turned OFF). */
export function verifyRevokeToken(value: string | undefined | null, nowMs: number): RevokeVerifyResult {
  if (!value) return { ok: false, reason: "malformed" };
  const secret = getSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };

  const parts = value.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [payloadB64, expStr, hmacHex] = parts;
  if (!payloadB64 || !expStr || !hmacHex) return { ok: false, reason: "malformed" };

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };
  if (Math.floor(nowMs / 1000) > exp) return { ok: false, reason: "expired" };

  const expected = crypto.createHmac("sha256", secret).update(`${payloadB64}.${expStr}`).digest("hex");
  if (!constantTimeEqHex(hmacHex, expected)) return { ok: false, reason: "bad_sig" };

  let payload: RevokePayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64)) as RevokePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object" || payload.aud !== REVOKE_TOKEN_AUD || typeof payload.vm !== "string") {
    return { ok: false, reason: "bad_aud" };
  }
  return { ok: true, vmId: payload.vm };
}

/**
 * Should mintPendingApproval RE-ARM (reset to a fresh pending_approval) an
 * existing row instead of reusing it as-is?
 *
 * THE DEADLOCK THIS KILLS (2026-06-12 pre-canary audit): request_id is
 * single-use by design (the deterministic pay nonce derives from it), and the
 * approvals table is unique on (vm_id, request_id) — so each booking attempt
 * has exactly ONE approval row, forever. Before this, mintPendingApproval
 * reused ANY existing row, including a dead one: a user who tapped after the
 * 15-min TTL (or denied, then changed their mind) got the SAME dead row's URL
 * on every re-authorize, the approve POST correctly 409'd it, and the booking
 * was permanently unbookable under its request_id — while the script's
 * narration promised "I'll send a fresh one if it expires." Re-arming the row
 * (fresh TTL + the CURRENT spend identity) makes that promise true.
 *
 * Re-arm is SAFE because money never moves on a re-armed row without a fresh
 * human tap: pending_approval authorizes nothing; the approve POST requires
 * the owner's live browser session; identity binding (approvalMatchesSpend)
 * re-checks amount/category/counterparty at authorize time.
 *
 * NEVER re-arm "consumed": consumed means this request_id already authorized a
 * reserve — the hold exists, so authorize answers idempotently long before any
 * mint. Resurrecting a consumed row could only ever be a bug amplifier.
 *
 *   live pending (fresh)        -> false (reuse as-is; the 5s in-turn poll must
 *                                  NOT keep resetting the TTL)
 *   approved (fresh)            -> false (it will authorize on this very call)
 *   consumed                    -> false (terminal, see above)
 *   expired / denied            -> true  (the dead-end states)
 *   pending/approved PAST TTL   -> true  (lazily-expired — same dead end)
 *
 * Pure. Tested in scripts/_test-frontier-session-decouple.ts (block E).
 */
export function shouldRearmApproval(row: ApprovalRow, nowMs: number): boolean {
  if (row.status === "consumed") return false;
  if (row.status === "expired" || row.status === "denied") return true;
  // pending_approval / approved: dead only if past TTL (incl. unparseable expiry).
  return isApprovalExpired(row, nowMs);
}
