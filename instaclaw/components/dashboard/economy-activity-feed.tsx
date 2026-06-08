"use client";

import Link from "next/link";
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Activity, ChevronDown, ArrowRight, ExternalLink } from "lucide-react";
import {
  ACCENT,
  SUCCESS,
  SERIF,
  EASE,
  FAIL,
  ICON_DISC_SPEND,
  ICON_DISC_EARN,
  fmtRelTime,
  shortAddr,
  serviceLabel,
  catMeta,
  statusMeta,
} from "./economy-format";

/**
 * EconomyActivityFeed — the live stream of an agent's economic decisions.
 *
 * Not a transaction list. The feed is built as a TIMELINE: a warm connective
 * spine runs down the left, each decision sits on it as a node, and quiet
 * relative-day waypoints ("Today", "Yesterday") chunk the stream — so ten
 * near-identical decisions read as beats in one continuous economic life, not
 * duplicate rows in a table. Color is pulled to a single place: the earned
 * autonomy budget (terracotta) climbing UP the thread row-over-row; success is
 * calm, and the one red is reserved for the rare decision that didn't go
 * through. Expanding a row reveals the agent's economic state at the instant it
 * decided — credit standing + earned budget — as a miniature of the hero (a
 * warm terracotta-washed panel with white identity tiles, serif numbers), plus
 * the on-chain receipt, hanging off the timeline to the right.
 *
 * The form (decision-journal rows, timeline spine, hanging record panel) is
 * stolen from the best-in-class chronological feeds — Linear's activity spine,
 * Stripe's payment-lifecycle, Mercury's day-grouped list, Things' timeline —
 * but expressed entirely in the dashboard's own material: the `.glass` card,
 * the hero's warm-wash + identity-card recipe, Instrument Serif for the hero
 * numbers, terracotta as the single earned-signal accent, the signature
 * 0.23/1/0.32/1 easing. Gated on recent.length, not firstRun.
 */

export interface ActivityRow {
  id: string;
  rail?: string | null;
  direction: "earn" | "spend";
  amount_usdc: number;
  protocol_fee_usdc?: number | null;
  status: string; // settled | failed | pending | disputed | refunded
  counterparty_address?: string | null;
  counterparty_vm_id?: string | null;
  response_summary?: string | null;
  tx_hash?: string | null;
  created_at: string;
  settled_at?: string | null;
  category?: string | null;
  mode?: string | null; // autonomous | human_approved
  result_used?: boolean | null;
  standing_at_decision?: number | null;
  earned_budget_at_decision?: number | null;
  latency_ms?: number | null;
  endpoint?: string | null;
  pay_error?: string | null;
}

// the connective thread the decision-nodes sit on — one continuous life
// carrying the eye down the stream. Graded by recency: most present at the live
// top, trailing off into history at the bottom (our editorial read of a
// timeline, not a flat uniform rule). Node discs are opaque and mask it at each
// event so every row is a node ON the thread.
const SPINE =
  "linear-gradient(to bottom, rgba(161,105,77,0.36) 0%, rgba(150,103,77,0.23) 40%, rgba(150,103,77,0.11) 100%)";

// the expanded record is a miniature hero panel: warm terracotta wash …
const RECORD_PANEL: CSSProperties = {
  background:
    "linear-gradient(158deg, rgba(220,103,67,0.06) 0%, rgba(255,251,249,0.6) 48%, rgba(255,255,255,0.42) 100%)",
  border: "1px solid rgba(220,103,67,0.13)",
  boxShadow: "0 2px 14px rgba(150,75,50,0.06), inset 0 1px 0 rgba(255,255,255,0.7)",
};
// … with the hero's white identity tiles sitting on it.
const STAT_TILE: CSSProperties = {
  background: "rgba(255,255,255,0.72)",
  border: "1px solid rgba(0,0,0,0.06)",
  boxShadow: "0 2px 10px rgba(120,70,50,0.05), inset 0 1px 0 rgba(255,255,255,0.8)",
};

// ── formatting ──────────────────────────────────────────────────────────────

function fmtAmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 0.01 || a === 0) return a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return a.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function fmtBudget(n: number): string {
  return n >= 0.01 || n === 0
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── row ──────────────────────────────────────────────────────────────────────

/**
 * The agent's decision as a readable statement, not a ledger amount. This
 * product's star is the JUDGMENT + the earned autonomy, not a $0.001 micro-
 * amount — so the row reads like a sentence the agent could say, with the
 * earned budget (terracotta) given the weight, and the outcome woven in.
 */
function EconomicStatement({ r }: { r: ActivityRow }) {
  const amt = `$${fmtAmt(r.amount_usdc)}`;
  const budget = typeof r.earned_budget_at_decision === "number" ? r.earned_budget_at_decision : null;
  const strong = (t: string) => (
    <span style={{ color: "var(--foreground)", fontWeight: 500 }}>{t}</span>
  );
  const drewOn =
    budget != null ? (
      <>
        {" "}
        of the{" "}
        <span style={{ color: ACCENT, fontWeight: 500 }}>${fmtBudget(budget)}/day</span> it earned
      </>
    ) : null;

  if (r.direction === "earn") {
    return (
      <>
        Earned {strong(amt)} for {catMeta(r.category).noun}
        {r.status !== "settled" && <> · {statusMeta(r.status).label}</>}
      </>
    );
  }
  if (r.status === "failed")
    return (
      <>
        Tried to spend {strong(amt)}
        {drewOn} · <span style={{ color: FAIL }}>didn&rsquo;t go through</span>
      </>
    );
  if (r.status === "pending")
    return (
      <>
        Spending {strong(amt)}
        {drewOn} · <span style={{ color: "rgb(176,128,22)" }}>pending</span>
      </>
    );
  // success is calm — the node already carries "it went through", so the text
  // doesn't need green. Color is reserved for the one terracotta thread (budget)
  // and the rare red (failure). Texture comes from the spine, not from tinting
  // every row.
  // §8 value-legibility: lead with the VALUE the spend delivered (was the result
  // used?), the cost follows as the tail. Spend-led only as the fallback when we
  // don't know (result_used null). The title already carries WHAT it bought.
  if (r.result_used === true)
    return (
      <>
        Used what it bought · {strong(amt)}
        {drewOn}
      </>
    );
  if (r.result_used === false)
    return (
      <>
        Explored it, didn&rsquo;t use it · {strong(amt)}
        {drewOn}
      </>
    );
  return (
    <>
      Spent {strong(amt)}
      {drewOn}
    </>
  );
}

// relative-day waypoint for the timeline. Chunks the stream the way a
// best-in-class banking list does, so a run of similar decisions never reads as
// a flat wall of identical rows.
function dayBucket(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Earlier";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(new Date(t))) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  return new Date(t).toLocaleDateString("en-US", { month: "long" });
}

function GroupHeader({ label, first }: { label: string; first: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-3 pb-1.5 ${first ? "pt-0" : "pt-5"}`}>
      {/* gutter spacer — the spine runs continuously behind it */}
      <div className="w-8 shrink-0" aria-hidden />
      <span
        className="text-[10px] font-semibold uppercase tracking-[0.18em]"
        style={{ color: "var(--muted)" }}
      >
        {label}
      </span>
    </div>
  );
}

function Row({ r }: { r: ActivityRow }) {
  const [open, setOpen] = useState(false);
  const earn = r.direction === "earn";
  const failed = r.status === "failed";
  const cm = catMeta(r.category);
  const Icon = cm.icon;
  const svc = serviceLabel(r.endpoint);

  // The node carries state so the text can stay calm: warm cream for a spend,
  // green for an earn, a restrained red ring for the rare failure.
  const nodeStyle: CSSProperties = failed
    ? {
        background: "linear-gradient(155deg, rgba(255,251,250,0.96), rgba(248,233,230,0.95))",
        border: `1px solid rgba(192,74,60,0.42)`,
        boxShadow: "0 1px 2px rgba(150,60,50,0.07), inset 0 1px 0 rgba(255,255,255,0.85)",
      }
    : earn
      ? ICON_DISC_EARN
      : ICON_DISC_SPEND;
  const glyphColor = earn ? SUCCESS : failed ? "rgba(168,84,72,0.92)" : "rgb(150,120,104)";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-start gap-3 px-3 py-3.5 text-left rounded-xl transition-colors duration-200"
        style={{ background: open ? "rgba(220,103,67,0.045)" : "transparent" }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = "rgba(220,103,67,0.028)";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "transparent";
        }}
      >
        {/* node on the spine — opaque, so it masks the thread at this event */}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 relative z-[1] mt-[1px]"
          style={nodeStyle}
        >
          <Icon className="w-[14px] h-[14px]" style={{ color: glyphColor }} />
        </div>

        <div className="flex-1 min-w-0 pt-[2px]">
          <div className="flex items-baseline gap-2">
            <p
              className="text-[14px] font-medium leading-tight truncate flex-1 min-w-0"
              style={{ color: "var(--foreground)" }}
            >
              {earn ? cm.earn : cm.spend}
              {svc && <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {svc}</span>}
            </p>
            <span className="text-[11px] shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
              {fmtRelTime(r.created_at)}
            </span>
          </div>
          <p className="text-[12px] leading-snug mt-[5px]" style={{ color: "var(--muted)" }}>
            <EconomicStatement r={r} />
          </p>
        </div>

        <ChevronDown
          className="w-4 h-4 shrink-0 mt-1 transition-transform duration-300"
          style={{ color: "var(--muted)", opacity: open ? 0.55 : 0.26, transform: open ? "rotate(180deg)" : "none" }}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            style={{ overflow: "hidden" }}
          >
            {/* the record hangs off the timeline to the right; gutter spacer keeps
                the spine running down its left, past this open event */}
            <div className="flex gap-3 px-3 pb-3.5 pt-1">
              <div className="w-8 shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <DecisionRecord r={r} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DecisionRecord({ r }: { r: ActivityRow }) {
  const cm = catMeta(r.category);
  const svc = serviceLabel(r.endpoint);
  const mode = r.mode === "autonomous" ? "on its own" : r.mode === "human_approved" ? "you approved" : null;
  const note = r.response_summary?.trim() || null;
  const counterparty = r.counterparty_vm_id
    ? "another agent"
    : r.counterparty_address
      ? shortAddr(r.counterparty_address)
      : null;

  const meta: Array<[string, ReactNode]> = [];
  meta.push(["Needed", <span>{cm.noun}{mode && <span style={{ color: "var(--muted)" }}> · {mode}</span>}</span>]);
  if (svc) meta.push(["Service", <span>{svc}</span>]);
  if (note) meta.push(["Its note", <span style={{ color: "var(--muted)" }}>&ldquo;{note}&rdquo;</span>]);
  if (counterparty) meta.push(["Paid", <span className="font-mono text-[11px]">{counterparty}</span>]);
  const outcome: string[] = [];
  if (r.status === "settled" && typeof r.result_used === "boolean") outcome.push(r.result_used ? "result used" : "result not used");
  if (r.latency_ms != null) outcome.push(`${(r.latency_ms / 1000).toFixed(r.latency_ms >= 1000 ? 1 : 2)}s to deliver`);
  if (typeof r.protocol_fee_usdc === "number" && r.protocol_fee_usdc > 0) outcome.push(`$${fmtAmt(r.protocol_fee_usdc)} fee`);
  if (outcome.length) meta.push(["Outcome", outcome.join(" · ")]);
  if (r.pay_error) meta.push(["Couldn’t settle", <span style={{ color: FAIL }}>{r.pay_error}</span>]);
  meta.push(["When", fmtWhen(r.settled_at || r.created_at)]);

  const hasStanding = r.standing_at_decision != null;
  const hasBudget = r.earned_budget_at_decision != null;

  return (
    <div className="rounded-2xl p-5 relative overflow-hidden" style={RECORD_PANEL}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] mb-3.5" style={{ color: ACCENT }}>
        Its state at the moment it decided
      </p>

      {(hasStanding || hasBudget) && (
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="rounded-xl p-4" style={STAT_TILE}>
              <p className="text-[10px] font-medium uppercase tracking-[0.1em] mb-2" style={{ color: "var(--muted)" }}>
                Credit standing
              </p>
              <p className="text-[30px] leading-none tabular-nums" style={{ fontFamily: SERIF, color: "var(--foreground)" }}>
                {hasStanding ? r.standing_at_decision : "—"}
              </p>
            </div>
            <div className="rounded-xl p-4" style={STAT_TILE}>
              <p className="text-[10px] font-medium uppercase tracking-[0.1em] mb-2" style={{ color: "var(--muted)" }}>
                Earned autonomy
              </p>
              <p className="text-[30px] leading-none" style={{ fontFamily: SERIF, color: ACCENT }}>
                {hasBudget ? `$${fmtBudget(r.earned_budget_at_decision as number)}` : "—"}
                {hasBudget && <span className="text-[15px]" style={{ color: "var(--muted)" }}> /day</span>}
              </p>
            </div>
          </div>
        )}

        <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2 text-[12px]">
          {meta.map(([k, v], i) => (
            <div key={i} className="contents">
              <dt className="whitespace-nowrap" style={{ color: "var(--muted)" }}>
                {k}
              </dt>
              <dd style={{ color: "var(--foreground)" }}>{v}</dd>
            </div>
          ))}
        </dl>

        {r.tx_hash && (
          <a
            href={`https://basescan.org/tx/${r.tx_hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-4 text-[12px] font-medium hover:underline"
            style={{ color: ACCENT }}
          >
            On-chain receipt <span className="font-mono">{r.tx_hash.slice(0, 10)}…</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
    </div>
  );
}

// ── feed ─────────────────────────────────────────────────────────────────────

export function EconomyActivityFeed({
  recent,
  hasMore = false,
  full = false,
  historyHref = "/economy/history",
}: {
  recent?: ActivityRow[] | null;
  /** true when the archive holds more decisions than the dashboard's recent
   *  set (state.recent_has_more) — gates the "See full history" footer. */
  hasMore?: boolean;
  /** the dedicated full-history surface: render every row, with no cap /
   *  show-more / footer, and let the page own the heading. */
  full?: boolean;
  historyHref?: string;
}) {
  // Dashboard caps the SOURCE at 10 (state returns ≤10 anyway); the full-history
  // page passes the complete set and renders all of it.
  const rows = full ? recent ?? [] : (recent ?? []).slice(0, 10);

  // Compact-at-every-state: default to a short glance, reveal the rest IN PLACE.
  // The trap with a single whole-card toggle is that "expanded" just restores
  // the sprawl; capping to CAP + show-more keeps the card small in BOTH states.
  const CAP = 5;
  const [expanded, setExpanded] = useState(false);
  const capActive = !full && rows.length > CAP && !expanded;
  const visible = capActive ? rows.slice(0, CAP) : rows;
  const hiddenCount = rows.length - CAP;

  const live = !full && rows.length > 0 && Date.now() - Date.parse(rows[0].created_at) < 2 * 60 * 1000;
  const showFooter = !full && rows.length > 0 && hasMore;

  return (
    <div className="glass rounded-2xl p-6 sm:p-7">
      {!full && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4" style={{ color: "var(--muted)" }} />
              <h3 className="text-sm font-medium">Recent activity</h3>
            </div>
            {live && (
              <span
                className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em]"
                style={{ color: ACCENT }}
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping" style={{ background: ACCENT }} />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: ACCENT }} />
                </span>
                Live
              </span>
            )}
          </div>
          <p className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>
            Your agent&apos;s economic decisions, as they happen.
          </p>
        </>
      )}

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className={full ? "relative" : "relative mt-4"}>
            {/* the timeline spine — one continuous warm thread the decision-nodes
                sit on; faded at both ends so it reads as the agent's economic life
                emerging and trailing off, not a hard rule. left:28px = the node
                centers (px-3 inset + half of the w-8 disc). */}
            <div
              aria-hidden
              className="pointer-events-none absolute top-0 bottom-0 w-[1.5px]"
              style={{
                left: "28px",
                transform: "translateX(-50%)",
                background: SPINE,
                maskImage: "linear-gradient(to bottom, transparent 0, #000 26px, #000 calc(100% - 22px), transparent 100%)",
                WebkitMaskImage:
                  "linear-gradient(to bottom, transparent 0, #000 26px, #000 calc(100% - 22px), transparent 100%)",
              }}
            />

            {(() => {
              let lastBucket: string | null = null;
              return visible.map((r, i) => {
                const bucket = dayBucket(r.created_at);
                const showHeader = bucket !== lastBucket;
                lastBucket = bucket;
                return (
                  <Fragment key={r.id}>
                    {showHeader && <GroupHeader label={bucket} first={i === 0} />}
                    <motion.div
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i, 8) * 0.04, duration: 0.45, ease: EASE }}
                    >
                      <Row r={r} />
                    </motion.div>
                  </Fragment>
                );
              });
            })()}
          </div>

          {/* Show more / less — expands the list in place, keeping the card
              compact by default. Only when there's more than the cap to show. */}
          {!full && rows.length > CAP && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="w-full flex items-center justify-center gap-1.5 mt-1.5 py-2 text-[12px] font-medium rounded-lg transition-colors cursor-pointer"
              style={{ color: "var(--muted)" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = ACCENT; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--muted)"; }}
            >
              {expanded ? "Show less" : `Show ${hiddenCount} more`}
              <ChevronDown
                className="w-3.5 h-3.5 transition-transform duration-300"
                style={{ transform: expanded ? "rotate(180deg)" : "none" }}
              />
            </button>
          )}

          {/* "See every decision" — a quiet card footer to the dedicated archive
              (/economy/history), shown only when the archive holds more than the
              dashboard does (recent_has_more). */}
          {showFooter && (
            <div className="mt-2 pt-2.5" style={{ borderTop: "1px solid rgba(0,0,0,0.06)" }}>
              <Link
                href={historyHref}
                className="group flex items-center justify-between px-1 py-1.5 text-[12.5px] rounded-lg transition-colors"
                style={{ color: "var(--muted)" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = ACCENT; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--muted)"; }}
              >
                <span>See every decision</span>
                <ArrowRight className="w-3.5 h-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="relative overflow-hidden mt-3 py-14 px-6 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 -top-10 w-60 h-60 rounded-full animate-orb"
        style={{ background: "radial-gradient(circle, rgba(220,103,67,0.13), transparent 70%)", filter: "blur(32px)" }}
      />
      <div className="relative">
        <div
          className="w-12 h-12 rounded-2xl mx-auto mb-4 flex items-center justify-center"
          style={{
            background: "linear-gradient(135deg, rgba(220,103,67,0.16), rgba(220,103,67,0.05))",
            border: "1px solid rgba(220,103,67,0.16)",
          }}
        >
          <Activity className="w-5 h-5" style={{ color: ACCENT }} />
        </div>
        <h4 className="text-lg leading-snug mb-2" style={{ fontFamily: SERIF, fontWeight: 400, color: "var(--foreground)" }}>
          Its economic life will show up here
        </h4>
        <p className="text-[12.5px] leading-relaxed max-w-sm mx-auto" style={{ color: "var(--muted)" }}>
          The first time your agent earns or spends on its own, every decision lands here: what it needed, what it
          chose, the budget it earned, and the on-chain receipt.
        </p>
      </div>
    </div>
  );
}
