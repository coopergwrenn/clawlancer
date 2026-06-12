"use client";

/**
 * TripCard — the durable artifact for a Travala booking. One component, FOUR
 * lifecycle states (the REAL booking-row state machine): confirmed (countdown) →
 * cancel_requested (otp pending) → cancelled (refund snapshot / honest stub) →
 * cancel_failed (honest failure). Trips spec, ruled 2026-06-12.
 *
 * THE THREE LOAD-BEARING IDEAS:
 *  1. the check-in desk moment — the booking ref is the typographic hero,
 *     monospace, one-tap copy, four seconds without a conversation.
 *  2. the ticking clock — free_cancellation_until_utc renders as a calm staged
 *     pill (neutral >48h, amber ≤48h, accent ≤12h). Pull-form twin of lane
 *     tracker #6's deadline reminders.
 *  3. verify-don't-trust — the proof block shows what the SYSTEM RECORDED:
 *     amount in USDC on Base + the tx hash linking to basescan (the same
 *     explorer idiom as bankr-wallet-card). Never the agent's word.
 *
 * READ-ONLY, always. The one button deep-links into chat with the composer
 * SEEDED (never auto-sent — the user pressing send themselves is the consent;
 * spec D3). The agent stays the actor; this card is a window.
 *
 * House style: glass card tokens (rounded-2xl border-white/10 bg-[#161617]),
 * Travala teal #13B5C9 (the skill card's orb color), lowercase ui strings,
 * middle dots, no em-dashes in user-facing text.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Globe, Copy, Check, ExternalLink, Clock, AlertTriangle } from "lucide-react";
import {
  type TripRow,
  countdownFor,
  statusView,
  nightsBetween,
  fmtDateRange,
  shortTx,
  fmtShortDateUtc,
  fmtUsd,
  refundView,
} from "@/lib/travala-trips-view";

const TRAVALA_TEAL = "#13B5C9";

const TONE_PILL: Record<string, string> = {
  ok: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  pending: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  done: "border-white/15 bg-white/5 text-white/60",
  warn: "border-[#DC6743]/30 bg-[#DC6743]/10 text-[#DC6743]",
};

function CopyRef({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="copy booking ref"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          },
          () => {},
        );
      }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[#13B5C9]/40 outline-none"
    >
      {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
      {copied ? "copied" : "copy"}
    </button>
  );
}

/**
 * ghost: the empty-state's example receipt (north-star ruling 2026-06-12) — it
 * sells by SHOWING the real thing, the way the would_drain narration does.
 * Non-interactive (no copy, no button, no live link), clearly labeled "example",
 * never mistakable for a real booking.
 */
export function TripCard({ trip, agentName, ghost = false }: { trip: TripRow; agentName: string | null; ghost?: boolean }) {
  const sv = statusView(trip.status, trip.bookingId);

  // the ticking clock — re-evaluate every 60s while a countdown is live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const cd = useMemo(
    () => countdownFor(trip.freeCancellationUntilUtc, nowMs, trip.cancellationPolicy),
    [trip.freeCancellationUntilUtc, trip.cancellationPolicy, nowMs],
  );
  useEffect(() => {
    if (cd.kind !== "ticking") return;
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [cd.kind]);

  const nights = nightsBetween(trip.checkIn, trip.checkOut);
  const range = fmtDateRange(trip.checkIn, trip.checkOut);
  const refund = refundView(trip);
  const bookedDate = fmtShortDateUtc(trip.createdAt);

  const countdownPill =
    trip.status === "confirmed" && cd.kind !== "none" ? (
      <div
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
          cd.kind === "ticking"
            ? cd.urgent
              ? "border-[#DC6743]/35 bg-[#DC6743]/10 text-[#DC6743]"
              : "border-amber-400/25 bg-amber-400/10 text-amber-300"
            : cd.kind === "ended"
              ? "border-white/10 bg-white/[0.03] text-white/40"
              : "border-white/15 bg-white/5 text-white/60"
        }`}
      >
        <Clock size={12} />
        {cd.label}
      </div>
    ) : null;

  return (
    <div className={`relative w-full rounded-2xl border bg-[#161617] p-5 shadow-xl ${ghost ? "border-dashed border-white/15 opacity-80" : "border-white/10"}`}>
      {ghost && (
        <span className="absolute right-4 top-4 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-white/45">
          example
        </span>
      )}
      {/* header: orb · hotel · dates · status pill (ghost: pad right so the
          absolute EXAMPLE pill never overlaps the title at narrow widths) */}
      <div className={`flex items-start gap-3 ${ghost ? "pr-16" : ""}`}>
        <div
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{ background: `${TRAVALA_TEAL}1f`, border: `1px solid ${TRAVALA_TEAL}40` }}
        >
          <Globe size={17} color={TRAVALA_TEAL} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-white">
            {trip.hotelName ?? "hotel booking"}
          </div>
          <div className="mt-0.5 text-xs text-white/50">
            {range ?? "dates not recorded"}
            {nights != null && ` · ${nights} night${nights === 1 ? "" : "s"}`}
            {trip.room && ` · ${trip.room.toLowerCase()}`}
          </div>
        </div>
        {!ghost && (
          <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] ${TONE_PILL[sv.tone]}`}>
            {sv.badge}
          </span>
        )}
      </div>

      {/* the check-in desk moment: ref as the typographic hero */}
      <div className="mt-4 flex items-end justify-between gap-3 rounded-xl border border-white/[0.07] bg-black/20 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">booking ref</div>
          <div className="mt-0.5 truncate font-mono text-2xl font-semibold tracking-wide text-white">
            {trip.bookingId ?? "· · ·"}
          </div>
          {!trip.bookingId && (
            <div className="mt-1 text-[11px] text-white/40">
              ref not captured · ask your agent to retry recording this booking
            </div>
          )}
        </div>
        {trip.bookingId && !ghost && <CopyRef value={trip.bookingId} />}
      </div>

      {/* state strip: countdown (confirmed) / note (pending + failed) / refund (cancelled) */}
      <div className="mt-3 space-y-2">
        {countdownPill}
        {trip.status === "confirmed" && cd.kind !== "none" && trip.cancellationPolicy && (
          <div className="text-[11px] leading-relaxed text-white/40">{trip.cancellationPolicy}</div>
        )}
        {trip.status === "confirmed" && cd.kind === "none" && (
          <div className="text-[11px] leading-relaxed text-white/40">{cd.label}</div>
        )}
        {sv.note && (
          <div className="flex items-start gap-1.5 text-xs leading-relaxed text-white/55">
            {sv.tone === "warn" && <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[#DC6743]" />}
            <span>{sv.note}</span>
          </div>
        )}
        {trip.status === "cancelled" && (
          <div className="text-xs leading-relaxed text-white/55">
            {trip.cancelledAt && (
              <span className="text-white/40">cancelled {fmtShortDateUtc(trip.cancelledAt)} · </span>
            )}
            {/* CANARY BOUNDARY: refund.stub renders the honest placeholder — we do
                not guess where the refund lands or what the confirmation ref looks
                like. TODO(canary): refine per the runbook seams ledger + tracker #9. */}
            {refund.line}
          </div>
        )}
      </div>

      {/* verify-don't-trust: what the system recorded, on-chain verifiable */}
      <div className="mt-4 border-t border-white/[0.07] pt-3">
        <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">payment record</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/65">
          {trip.amountUsdPaid != null ? (
            <span className="font-medium text-white/85">{fmtUsd(trip.amountUsdPaid)} usdc on base</span>
          ) : (
            <span>amount not recorded</span>
          )}
          {trip.txHash && (
            <>
              <span className="text-white/25">·</span>
              {ghost ? (
                <span className="inline-flex items-center gap-1 font-mono text-[#13B5C9]/70">
                  {shortTx(trip.txHash)}
                  <ExternalLink size={11} />
                </span>
              ) : (
                <a
                  href={`https://basescan.org/tx/${trip.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-[#13B5C9]/90 transition-colors hover:text-[#13B5C9]"
                >
                  {shortTx(trip.txHash)}
                  <ExternalLink size={11} />
                </a>
              )}
            </>
          )}
        </div>
        <div className="mt-1 text-[11px] text-white/40">
          booked autonomously{agentName ? ` by ${agentName.toLowerCase()}` : " by your agent"}
          {bookedDate && ` · ${bookedDate}`}
        </div>
      </div>

      {/* the one button — deep-links into chat, composer SEEDED, user presses send */}
      {sv.action && !ghost && (
        <div className="mt-4">
          <Link
            href={`/tasks?prefill=${encodeURIComponent(sv.action.prefill)}`}
            className={`inline-flex h-9 items-center justify-center rounded-lg border px-4 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40 ${
              sv.tone === "warn"
                ? "border-[#DC6743]/35 bg-[#DC6743]/10 text-[#DC6743] hover:bg-[#DC6743]/20"
                : "border-white/15 bg-white/5 text-white/75 hover:bg-white/10 hover:text-white"
            }`}
          >
            {sv.action.label}
          </Link>
        </div>
      )}
    </div>
  );
}
