/**
 * travala-trips-view — ALL pure logic for the Trips surface (the travel lane's
 * first user-facing page). One module, three consumers: the session-authed API
 * (row mapping), the TripCard component (countdown + status views), and the
 * decision tests (scripts/_test-trip-card-logic.ts).
 *
 * THE THESIS (trips spec, ruled 2026-06-12): chat is the right interface for
 * ACTIONS; a page is the right interface for ARTIFACTS. The card shows what the
 * SYSTEM RECORDED (instaclaw_travala_bookings — the system of record this lane
 * built), never what the agent said. Read-only by construction: nothing in this
 * module or its consumers can act.
 *
 * CANARY BOUNDARY (firm): refund landing (assumed travala credit, unverified)
 * and the cancellation confirmation reference are exactly what the canary
 * observes — the cancelled view renders an HONEST STUB when those fields are
 * null. Build the provable; stub the observed.
 */

// ── the wire shape (every field traces to an instaclaw_travala_bookings column) ──
export interface TripRow {
  id: string; // instaclaw_travala_bookings.id
  bookingId: string | null; // booking_id (null = ref-parse degraded; raw kept server-side)
  hotelName: string | null; // hotel_name
  checkIn: string | null; // check_in (DATE, YYYY-MM-DD)
  checkOut: string | null; // check_out
  room: string | null; // room
  displayPrice: number | null; // display_price
  currency: string | null; // currency
  amountUsdPaid: number | null; // amount_usd_paid (the on-chain USDC amount)
  txHash: string | null; // tx_hash (basescan-verifiable)
  status: string; // status: confirmed | cancel_requested | cancelled | cancel_failed
  cancellationPolicy: string | null; // cancellation_policy_string
  freeCancellationUntilUtc: string | null; // free_cancellation_until_utc (timestamptz)
  isRefundable: boolean | null; // is_refundable
  refundAmount: number | null; // refund_amount (cancel snapshot; null until cancelled)
  cancellationFee: number | null; // cancellation_fee
  cancelRequestedAt: string | null; // cancel_requested_at
  cancelledAt: string | null; // cancelled_at
  createdAt: string; // created_at (the "booked autonomously" timestamp)
}

/** Map a DB row (snake_case, unknown-typed) to the wire shape. Pure. */
export function toTripRow(r: Record<string, unknown>): TripRow {
  const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const n = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const x = Number(v); // PostgREST returns numeric as string (Rule 21 class)
      return Number.isFinite(x) ? x : null;
    }
    return null;
  };
  return {
    id: String(r.id),
    bookingId: s(r.booking_id),
    hotelName: s(r.hotel_name),
    checkIn: s(r.check_in),
    checkOut: s(r.check_out),
    room: s(r.room),
    displayPrice: n(r.display_price),
    currency: s(r.currency) ?? "USD",
    amountUsdPaid: n(r.amount_usd_paid),
    txHash: s(r.tx_hash),
    status: typeof r.status === "string" ? r.status : "confirmed",
    cancellationPolicy: s(r.cancellation_policy_string),
    freeCancellationUntilUtc: s(r.free_cancellation_until_utc),
    isRefundable: typeof r.is_refundable === "boolean" ? r.is_refundable : null,
    refundAmount: n(r.refund_amount),
    cancellationFee: n(r.cancellation_fee),
    cancelRequestedAt: s(r.cancel_requested_at),
    cancelledAt: s(r.cancelled_at),
    createdAt: typeof r.created_at === "string" ? r.created_at : new Date(0).toISOString(),
  };
}

// ── countdown classification (the ticking clock; tracker #6's pull-form twin) ──
// Calm, staged — a deadline, not a siren: neutral >48h, amber ≤48h, accent ≤12h.
export type CountdownView =
  | { kind: "none"; label: string } // no deadline recorded → policy string or honest absence
  | { kind: "until"; label: string } // >48h out → absolute date, no ticking
  | { kind: "ticking"; label: string; urgent: boolean } // ≤48h → live countdown; urgent ≤12h
  | { kind: "ended"; label: string }; // window passed → quiet past-tense

const H48 = 48 * 60 * 60 * 1000;
const H12 = 12 * 60 * 60 * 1000;

/** "36h 12m" / "5h 03m" from a positive ms delta. Pure, deterministic. */
export function fmtHm(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** lowercase short date ("jun 24") — UTC-pinned for determinism. */
export function fmtShortDateUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .toLowerCase();
}

/** lowercase date+time ("jun 24, 3:00 pm utc") — UTC-pinned, says so honestly. */
export function fmtDateTimeUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${date}, ${time} utc`.toLowerCase();
}

export function countdownFor(
  freeCancellationUntilUtc: string | null,
  nowMs: number,
  policy: string | null,
): CountdownView {
  if (!freeCancellationUntilUtc) {
    return { kind: "none", label: policy ? `cancellation policy: ${policy}` : "cancellation policy not recorded" };
  }
  const t = Date.parse(freeCancellationUntilUtc);
  if (!Number.isFinite(t)) {
    return { kind: "none", label: policy ? `cancellation policy: ${policy}` : "cancellation policy not recorded" };
  }
  const delta = t - nowMs;
  if (delta <= 0) return { kind: "ended", label: `free cancellation window ended ${fmtShortDateUtc(freeCancellationUntilUtc)}` };
  if (delta > H48) return { kind: "until", label: `free cancellation until ${fmtDateTimeUtc(freeCancellationUntilUtc)}` };
  return { kind: "ticking", label: `free cancellation ends in ${fmtHm(delta)}`, urgent: delta <= H12 };
}

// ── status → view (plain language, never enum-speak; four REAL states) ──
export type StatusTone = "ok" | "pending" | "done" | "warn";
export interface StatusView {
  badge: string; // the pill text (lowercase)
  tone: StatusTone;
  /** the one button: label + the chat prefill it deep-links with (seed, never send) */
  action: { label: string; prefill: string } | null;
  /** the sentence under the badge for non-confirmed states */
  note: string | null;
}

export function statusView(status: string, bookingId: string | null): StatusView {
  const ref = bookingId ?? "my recent hotel booking";
  switch (status) {
    case "confirmed":
      return {
        badge: "confirmed",
        tone: "ok",
        action: { label: "cancel this trip", prefill: `cancel my hotel booking ${ref}` },
        note: null,
      };
    case "cancel_requested":
      return {
        badge: "cancellation pending",
        tone: "pending",
        action: { label: "finish cancelling", prefill: `i have the cancellation code for booking ${ref}: ` },
        note: "travala emailed a code to your booking email · read it to your agent to finish",
      };
    case "cancelled":
      return { badge: "cancelled", tone: "done", action: null, note: null };
    case "cancel_failed":
      return {
        badge: "cancellation didn't complete",
        tone: "warn",
        action: { label: "check this booking", prefill: `check the status of my hotel booking ${ref}` },
        note: "the last attempt didn't complete · your booking may still be active",
      };
    default:
      // unreachable-by-schema (CHECK constraint) — render honestly anyway.
      return { badge: status.replace(/_/g, " "), tone: "pending", action: null, note: null };
  }
}

// ── small display helpers ──
export function nightsBetween(checkIn: string | null, checkOut: string | null): number | null {
  if (!checkIn || !checkOut) return null;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 86_400_000);
}

export function fmtDateRange(checkIn: string | null, checkOut: string | null): string | null {
  if (!checkIn || !checkOut) return null;
  return `${fmtShortDateUtc(`${checkIn}T00:00:00Z`)} → ${fmtShortDateUtc(`${checkOut}T00:00:00Z`)}`;
}

/** "$84.50" — money always two decimals (a receipt, not a float). */
export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function shortTx(tx: string | null): string | null {
  if (!tx || tx.length < 12) return tx;
  return `${tx.slice(0, 6)}…${tx.slice(-4)}`;
}

/**
 * The refund block for the cancelled state. CANARY BOUNDARY: when the snapshot
 * fields are null we render the honest stub — we do NOT guess the shape.
 * TODO(canary): refine once the canary observes (a) where the refund actually
 * lands (assumed travala credit, unverified) and (b) the cancellation
 * confirmation reference shape (lane tracker #9 / runbook seams ledger).
 */
export function refundView(r: TripRow): { line: string; stub: boolean } {
  if (r.status !== "cancelled") return { line: "", stub: false };
  if (r.refundAmount != null) {
    const fee = r.cancellationFee != null && r.cancellationFee > 0 ? `, after a ${fmtUsd(r.cancellationFee)} fee` : "";
    return {
      line: `refund ${fmtUsd(r.refundAmount)}${fee} · expected as travala travel credit, ~7 business days · not to your wallet`,
      stub: false,
    };
  }
  return { line: "refund details are recorded once travala confirms them · check your travala account", stub: true };
}
