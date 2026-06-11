/**
 * Travala booking persistence + manage/cancel core — the testable half of the
 * lane's read/cancel side. The /api/travala/[op] route is a thin shell over
 * these functions (so the gate logic + state machine are unit-testable).
 *
 * WHY A SEPARATE MODULE: instaclaw_travala_bookings is the ONLY record a booking
 * ever happened (the Travala MCP has no list-all; nothing else persists a
 * booking). cancel/manage need {bookingId,lastName,email}; gate-2 ownership needs
 * {vm_id}. Both flow through here.
 *
 * ERROR CLASSIFICATION is designed from the REAL 2026-06-11 throwaway-probe
 * catalog, NOT guesses. Every manage/cancel error comes back as an MCP tool
 * result with `isError:true` + content[].text (HTTP 200, NOT a JSON-RPC error) —
 * so we classify on result.isError + the text, never on mcpToolsCall's `ok`.
 * Observed bodies:
 *   - unknown id, step-1:  "Failed to send (verification|cancellation) OTP …"
 *   - unknown id, step-2:  "Booking not found"
 *   - malformed args:      "MCP error -32602: Input validation error …" (Zod)
 *   - step-1 success:      isError:false, "code emailed to <masked>" (canary-confirmed shape)
 *   - step-2 success:      isError:false, cancellation + refund/fee (canary-only)
 *   - bad/expired otp, already-cancelled, past-deadline: canary-only → surfaced verbatim
 *
 * §9 LEDGER SEAM (standing ruling): cancel NEVER calls /authorize, /settle,
 * /refund, or credits any frontier budget. The USDC spend is permanent; the
 * refund posts as Travala Travel Credit off-ledger. refund_* here is an
 * informational snapshot of what cancel_booking RETURNED — never a confirmation,
 * refund_destination is always 'travala_credit'.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { mintTravalaToken, mcpToolsCall, type McpCallResult } from "./travala-mcp";

export const TRAVALA_BOOKINGS_TABLE = "instaclaw_travala_bookings";

// ── the search-option snapshot the agent threads through book → record ──
export interface TravalaBookingSnapshot {
  hotelName?: string;
  checkIn?: string; // YYYY-MM-DD
  checkOut?: string; // YYYY-MM-DD
  room?: string;
  displayPrice?: number;
  currency?: string;
  cancellationPolicy?: string;
  freeCancellationUntilUtc?: string; // ISO timestamptz
  refundable?: boolean;
}

export interface TravalaBookingRow {
  id: string;
  vm_id: string;
  user_id: string;
  booking_id: string | null;
  last_name: string;
  email: string;
  status: string; // confirmed | cancel_requested | cancelled | cancel_failed
  package_id: string | null;
  session_id: string | null;
  [k: string]: unknown;
}

// ── tool-result classification (from the REAL catalog) ──
export type TravalaToolState =
  | "ok" // isError:false — success (OTP sent / details / cancelled)
  | "not_found" // booking unknown to Travala upstream
  | "bad_otp" // wrong/expired OTP on step 2
  | "already_cancelled"
  | "invalid_input" // -32602 Zod validation — our bug (args from a bad stored row)
  | "upstream_error"; // transport down OR an unrecognised isError message (surfaced verbatim)

export interface TravalaClassified {
  state: TravalaToolState;
  isError: boolean;
  text: string; // raw joined tool text — forensics + truthful surfacing
}

/**
 * Classify an mcpToolsCall result for manage/cancel. Order matters:
 * already_cancelled → bad_otp → not_found, then the verbatim default.
 */
export function classifyToolResult(r: McpCallResult): TravalaClassified {
  if (!r.ok || !r.result) {
    return { state: "upstream_error", isError: true, text: r.error || "travala unreachable" };
  }
  const res = r.result as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = Array.isArray(res.content)
    ? res.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join(" ").trim()
    : JSON.stringify(res);
  const isError = res.isError === true;
  if (!isError) return { state: "ok", isError: false, text };
  const t = text.toLowerCase();
  if (/input validation error|invalid arguments for tool|-32602/.test(t)) {
    return { state: "invalid_input", isError, text };
  }
  if (/already cancel/.test(t)) return { state: "already_cancelled", isError, text };
  if (/invalid otp|incorrect (code|otp)|wrong (code|otp)|otp[^a-z]{0,12}(expired|invalid)|verification code[^a-z]{0,12}(expired|invalid)|code (has )?expired/.test(t)) {
    return { state: "bad_otp", isError, text };
  }
  if (/booking not found|failed to send (verification|cancellation) otp|no booking|does not exist|couldn'?t find|unable to find/.test(t)) {
    return { state: "not_found", isError, text };
  }
  return { state: "upstream_error", isError, text }; // surface Travala's real message truthfully
}

// ── bookingId extraction — book_status is authoritative, regex is fallback ──
// Tightened from travala-book.mjs's bare regex: refs look like MN5V9DWQ /
// ABCD1234 (>=7 uppercase-alnum, >=2 leading letters), which excludes short
// tokens (USDC, BASE) and lowercase tx hashes.
const BOOKING_REF_RE = /\b([A-Z]{2}[A-Z0-9]{5,12})\b/;

export function extractBookingRef(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const m = text.match(BOOKING_REF_RE);
  return m ? m[1] : null;
}

/**
 * Validate the bookingId via travala_book_status (Cooper's directive: never
 * trust the bare pay-response regex). Returns the ref parsed from the
 * authoritative status body + the interpretation field, plus the raw text.
 * Best-effort: a propagation delay can leave status 'in_progress' with no ref
 * yet — the caller falls back to the pay-response regex.
 */
export async function extractBookingIdViaStatus(
  packageId: string,
  sessionId: string,
): Promise<{ bookingId: string | null; statusText: string; interpretation: string | null }> {
  const tok = await mintTravalaToken("mcp:read mcp:book");
  if (!tok.ok || !tok.access_token) return { bookingId: null, statusText: "", interpretation: null };
  const r = await mcpToolsCall(tok.access_token, "travala_book_status", { packageId, sessionId });
  const cls = classifyToolResult(r);
  let interpretation: string | null = null;
  const sc = (r.result as { structuredContent?: { interpretation?: unknown } } | undefined)?.structuredContent;
  if (sc && typeof sc.interpretation === "string") interpretation = sc.interpretation;
  return { bookingId: extractBookingRef(cls.text), statusText: cls.text, interpretation };
}

// ── cancel outcome parse (step-2 success; canary refines the shape) ──
export function parseCancelOutcome(text: string): { refundAmount: number | null; cancellationFee: number | null } {
  const num = (re: RegExp): number | null => {
    const m = text.match(re);
    if (!m) return null;
    const v = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(v) ? v : null;
  };
  return {
    refundAmount: num(/refund(?:\s*amount)?[^0-9$]{0,12}\$?\s*([0-9][0-9,]*\.?[0-9]*)/i),
    cancellationFee: num(/(?:cancellation\s*)?fee[^0-9$]{0,12}\$?\s*([0-9][0-9,]*\.?[0-9]*)/i),
  };
}

// ── gate-2 ownership: bookingId in our table AND vm_id matches. Fires BEFORE
// any MCP call so VM-A never triggers an OTP email to VM-B's user. ──
export async function lookupOwnedBooking(
  supabase: SupabaseClient,
  vmId: string,
  bookingId: string,
): Promise<TravalaBookingRow | null> {
  if (!bookingId) return null;
  // Rule 19: select("*") for a safety-critical read.
  const { data } = await supabase
    .from(TRAVALA_BOOKINGS_TABLE)
    .select("*")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!data) return null;
  if ((data as TravalaBookingRow).vm_id !== vmId) return null; // ownership gate
  return data as TravalaBookingRow;
}

// ── persistence: record a confirmed booking (persist-on-confirmed-pay) ──
export interface RecordBookingParams {
  vmId: string;
  userId: string;
  customer: { firstName?: string; lastName: string; email: string; phone?: string };
  packageId: string;
  sessionId: string;
  amountUsd?: number | null;
  txHash?: string | null;
  holdId?: string | null;
  requestId?: string | null;
  payResponseRaw?: string | null; // the x402 pay-response body (booking_ref fallback + forensics)
  snapshot?: TravalaBookingSnapshot | null;
}

export interface RecordBookingResult {
  recorded: boolean;
  bookingId: string | null;
  rowId: string | null;
  refSource: "book_status" | "pay_response_regex" | "none";
  reason?: string;
}

export async function recordConfirmedBooking(
  supabase: SupabaseClient,
  p: RecordBookingParams,
): Promise<RecordBookingResult> {
  // 1. validate via book_status (authoritative), fall back to the pay-response regex.
  const viaStatus = await extractBookingIdViaStatus(p.packageId, p.sessionId);
  let bookingId = viaStatus.bookingId;
  let refSource: RecordBookingResult["refSource"] = bookingId ? "book_status" : "none";
  if (!bookingId) {
    bookingId = extractBookingRef(p.payResponseRaw);
    if (bookingId) refSource = "pay_response_regex";
  }

  const baseRow: Record<string, unknown> = {
    vm_id: p.vmId,
    user_id: p.userId,
    booking_id: bookingId,
    last_name: p.customer.lastName,
    email: p.customer.email,
    hotel_name: p.snapshot?.hotelName ?? null,
    check_in: p.snapshot?.checkIn ?? null,
    check_out: p.snapshot?.checkOut ?? null,
    room: p.snapshot?.room ?? null,
    display_price: p.snapshot?.displayPrice ?? null,
    currency: p.snapshot?.currency ?? "USD",
    cancellation_policy_string: p.snapshot?.cancellationPolicy ?? null,
    free_cancellation_until_utc: p.snapshot?.freeCancellationUntilUtc ?? null,
    is_refundable: typeof p.snapshot?.refundable === "boolean" ? p.snapshot.refundable : null,
    amount_usd_paid: p.amountUsd ?? null,
    tx_hash: p.txHash ?? null,
    hold_id: p.holdId ?? null,
    request_id: p.requestId ?? null,
    package_id: p.packageId,
    session_id: p.sessionId,
    booking_ref_raw: (p.payResponseRaw ?? "").slice(0, 4000),
    status: "confirmed",
    meta: {
      book_status_text: (viaStatus.statusText || "").slice(0, 2000),
      interpretation: viaStatus.interpretation,
      ref_source: refSource,
    },
  };

  // Idempotent on (vm_id, package_id, session_id): retries update, never duplicate.
  const { data: existing } = await supabase
    .from(TRAVALA_BOOKINGS_TABLE)
    .select("id")
    .eq("vm_id", p.vmId)
    .eq("package_id", p.packageId)
    .eq("session_id", p.sessionId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from(TRAVALA_BOOKINGS_TABLE)
      .update({ ...baseRow, updated_at: new Date().toISOString() })
      .eq("id", (existing as { id: string }).id);
    if (error) return { recorded: false, bookingId, rowId: null, refSource, reason: error.message };
    return { recorded: true, bookingId, rowId: (existing as { id: string }).id, refSource };
  }

  let ins = await supabase.from(TRAVALA_BOOKINGS_TABLE).insert(baseRow).select("id").single();
  // If a parse collision trips the unique booking_id index, degrade to a
  // ref-less row (booking present + raw kept) rather than losing the record.
  if (ins.error && /duplicate|unique|23505/i.test(ins.error.message)) {
    refSource = "none";
    const degraded = { ...baseRow, booking_id: null, meta: { ...(baseRow.meta as object), ref_source: "none", ref_collision: bookingId } };
    bookingId = null;
    ins = await supabase.from(TRAVALA_BOOKINGS_TABLE).insert(degraded).select("id").single();
  }
  if (ins.error) return { recorded: false, bookingId, rowId: null, refSource, reason: ins.error.message };
  return { recorded: true, bookingId, rowId: (ins.data as { id: string }).id, refSource };
}

// ── row state transitions for the cancel flow (status wiring) ──
export async function markCancelRequested(supabase: SupabaseClient, rowId: string): Promise<void> {
  await supabase
    .from(TRAVALA_BOOKINGS_TABLE)
    .update({ status: "cancel_requested", cancel_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", rowId);
}

export async function markCancelled(
  supabase: SupabaseClient,
  rowId: string,
  outcome: { refundAmount: number | null; cancellationFee: number | null; raw: unknown },
): Promise<void> {
  await supabase
    .from(TRAVALA_BOOKINGS_TABLE)
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      refund_amount: outcome.refundAmount,
      cancellation_fee: outcome.cancellationFee,
      refund_destination: "travala_credit", // §9: never 'wallet'
      cancel_raw: outcome.raw ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);
}

export async function markCancelFailed(supabase: SupabaseClient, rowId: string, reason: string): Promise<void> {
  // bad_otp does NOT land here — that leaves status at cancel_requested so the
  // user can retry with a fresh code. Only hard failures (not_found / upstream).
  await supabase
    .from(TRAVALA_BOOKINGS_TABLE)
    .update({ status: "cancel_failed", cancel_raw: { error: reason.slice(0, 2000) }, updated_at: new Date().toISOString() })
    .eq("id", rowId);
}
