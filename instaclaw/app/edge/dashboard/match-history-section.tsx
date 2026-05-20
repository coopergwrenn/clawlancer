"use client";

/**
 * MatchHistorySection — the dashboard's "your matches" feed.
 *
 * Renders two stacked cards above the existing IntentForm + spectator:
 *
 *   1. Current-intent card — "your agent is looking for: [intent text]"
 *      • Shown when fetchUserCurrentIntent returned a real intent
 *      • Empty-state prompt when the user hasn't submitted yet (with
 *        a soft CTA pointing at the IntentForm below)
 *      • Soft "couldn't load" state if Yanek's read_intents failed
 *        AND the user has Index credentials (distinguishes from
 *        "no intent submitted yet")
 *
 *   2. Match list — counterpart name + reason excerpt + relative time
 *      + optional confidence. Feed-style cards, single column,
 *      mobile-first.
 *      • Empty-state copy when matches.length === 0: forward-leaning,
 *        not "the database is empty" — "your agent is looking."
 *
 * Voice + style decisions:
 *   • Lowercase per InstaClaw convention except proper names
 *   • Counterpart name in stronger weight (the "headline")
 *   • Reason text in body weight, italicized (it's the agent's
 *     interpretation, not editorial)
 *   • Relative time + confidence in the same secondary metadata line
 *   • Subtle sparkles icon as the section heading accent — represents
 *     serendipitous discovery, not "computer output"
 *   • Olive palette via CSS variables (--edge-olive, --edge-ink, etc.)
 *     to match the rest of the Edge dashboard surface
 *
 * NOT a server component because the parent (EdgeDashboardClient) is
 * a "use client" boundary. Data is pre-fetched server-side in
 * page.tsx and passed via props — this component owns only render.
 */
import { Sparkles, Compass } from "lucide-react";
import type { CounterpartMatch, CurrentIntent } from "@/lib/edge-dashboard-data";
import { formatRelativeTime } from "@/lib/edge-dashboard-data";

interface MatchHistorySectionProps {
  matches: CounterpartMatch[];
  currentIntent: CurrentIntent | null;
  /** True if the user has Index credentials (index_api_key set on their VM). */
  userHasIndexKey: boolean;
  /** True if read_intents call succeeded (vs failed). Used to distinguish
   *  "no intent submitted yet" from "couldn't load intent right now". */
  intentFetchSucceeded: boolean;
}

export function MatchHistorySection({
  matches,
  currentIntent,
  userHasIndexKey,
  intentFetchSucceeded,
}: MatchHistorySectionProps) {
  return (
    <section style={{ marginBottom: "40px" }}>
      {/* Section heading */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "16px",
        }}
      >
        <Sparkles size={16} style={{ color: "var(--edge-olive)" }} />
        <h2
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--edge-ink-soft)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            margin: 0,
          }}
        >
          Your matchmaking
        </h2>
      </div>

      {/* Current-intent card */}
      <CurrentIntentCard
        intent={currentIntent}
        userHasIndexKey={userHasIndexKey}
        intentFetchSucceeded={intentFetchSucceeded}
      />

      {/* Match list */}
      {matches.length === 0 ? (
        <EmptyMatchesState hasIntent={!!currentIntent} />
      ) : (
        <MatchList matches={matches} />
      )}
    </section>
  );
}

// ── Current-intent card ─────────────────────────────────────────────

function CurrentIntentCard({
  intent,
  userHasIndexKey,
  intentFetchSucceeded,
}: {
  intent: CurrentIntent | null;
  userHasIndexKey: boolean;
  intentFetchSucceeded: boolean;
}) {
  // State machine for what to render:
  //   (a) intent is set → show it
  //   (b) !userHasIndexKey → "setup not complete" (rare; should be
  //       caught by the page-level partner gate but defense in depth)
  //   (c) intentFetchSucceeded && !intent → "no intent yet" prompt
  //   (d) !intentFetchSucceeded → "couldn't load intent" soft message

  if (intent) {
    return (
      <div style={cardStyle}>
        <div style={labelStyle}>Your agent is looking for</div>
        <p
          style={{
            margin: "8px 0 0",
            fontSize: "15px",
            lineHeight: 1.55,
            color: "var(--edge-ink)",
            fontStyle: "italic",
          }}
        >
          “{intent.description}”
        </p>
        {intent.createdAt && (
          <div
            style={{
              marginTop: "10px",
              fontSize: "12px",
              color: "var(--edge-ink-soft)",
            }}
          >
            updated {formatRelativeTime(intent.createdAt)}
          </div>
        )}
      </div>
    );
  }

  if (!userHasIndexKey) {
    return (
      <div style={cardStyle}>
        <div style={labelStyle}>Your agent is looking for</div>
        <p style={emptyTextStyle}>
          your edge city setup isn&apos;t fully online yet. give it a minute
          and refresh this page.
        </p>
      </div>
    );
  }

  if (!intentFetchSucceeded) {
    return (
      <div style={cardStyle}>
        <div style={labelStyle}>Your agent is looking for</div>
        <p style={emptyTextStyle}>
          we couldn&apos;t load your current intent right now. it&apos;s saved —
          just not displayable at this moment. try refreshing in a bit.
        </p>
      </div>
    );
  }

  // intentFetchSucceeded && !intent: no intent submitted yet
  return (
    <div style={cardStyle}>
      <div style={labelStyle}>Your agent is looking for</div>
      <p style={emptyTextStyle}>
        you haven&apos;t told your agent what to look for yet. submit your
        first intent below to start matching.
      </p>
    </div>
  );
}

// ── Match list ──────────────────────────────────────────────────────

function MatchList({ matches }: { matches: CounterpartMatch[] }) {
  return (
    <div style={cardStyle}>
      <div style={labelStyle}>Your matches</div>
      <div style={{ marginTop: "16px" }}>
        {matches.map((m, i) => (
          <MatchCard key={m.outcomeId} match={m} isLast={i === matches.length - 1} />
        ))}
      </div>
    </div>
  );
}

function MatchCard({ match, isLast }: { match: CounterpartMatch; isLast: boolean }) {
  const confidencePct =
    match.scoreConfidence !== null ? Math.round(match.scoreConfidence * 100) : null;
  return (
    <div
      style={{
        padding: "14px 0",
        borderBottom: isLast ? "none" : "1px solid var(--edge-line)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            fontSize: "16px",
            fontWeight: 600,
            color: "var(--edge-ink)",
            letterSpacing: "-0.005em",
          }}
        >
          {match.counterpartName}
        </div>
        <div
          style={{
            fontSize: "12px",
            color: "var(--edge-ink-soft)",
            flexShrink: 0,
          }}
        >
          {formatRelativeTime(match.createdAt)}
          {confidencePct !== null && (
            <>
              <span style={{ margin: "0 6px" }}>·</span>
              {confidencePct}% confidence
            </>
          )}
        </div>
      </div>
      {match.reasonText && (
        <p
          style={{
            margin: "6px 0 0",
            fontSize: "14px",
            lineHeight: 1.55,
            color: "var(--edge-ink-soft)",
            fontStyle: "italic",
          }}
        >
          {match.reasonText}
        </p>
      )}
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────

function EmptyMatchesState({ hasIntent }: { hasIntent: boolean }) {
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
        <Compass size={16} style={{ color: "var(--edge-olive)" }} />
        <div style={labelStyle}>Your matches</div>
      </div>
      <p style={emptyTextStyle}>
        {hasIntent
          ? "no matches yet — your agent is looking. agents take a bit to find the right overlaps. check back later, or update your intent above."
          : "no matches yet. submit an intent below and your agent will start looking."}
      </p>
    </div>
  );
}

// ── Shared inline-style constants ───────────────────────────────────

const cardStyle: React.CSSProperties = {
  padding: "20px 24px",
  border: "1px solid var(--edge-line)",
  borderRadius: "10px",
  background: "rgba(255,255,255,0.5)",
  marginBottom: "16px",
};

const labelStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--edge-ink-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.1em",
};

const emptyTextStyle: React.CSSProperties = {
  margin: "8px 0 0",
  fontSize: "14px",
  lineHeight: 1.55,
  color: "var(--edge-ink-soft)",
};
