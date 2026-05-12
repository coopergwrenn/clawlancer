/**
 * /edge-city/plaza — Live Activity Dashboard
 *
 * Public-anonymized funnel dashboard for the agent matching pipeline.
 * Reads matchpool_outcomes + matchpool_funnel_counts RPC. Refreshes
 * every 10s server-side (revalidate). No PII in the rendered HTML —
 * source_user_id and candidate_user_id are hashed to Agent #NNN tags.
 *
 * Sections (top-down narrative):
 *   1. Live status banner — "N agents active today" + freshness pulse
 *   2. The funnel — proposed → responded → met → valuable, with %
 *   3. Layer 3 calibration — score distribution for valuable vs declined
 *      (validates the central pipeline claim: do high-score matches
 *      actually become valuable meetings?)
 *   4. Activity over time — bar chart of intros per hour, last 24h
 *
 * Hidden until matchpool_outcomes has data. Until then it shows the
 * "ready for Edge Esmeralda" message — honest about pre-Edge state.
 *
 * Per the 2026-05-11 production audit: cohort is currently 8 insiders.
 * Edge Esmeralda (May 30) is the first real validation event. The
 * dashboard is the marketing artifact that proves the architecture
 * works as the village fills up.
 */
import { createMetadata } from "@/lib/seo";
import { getSupabase } from "@/lib/supabase";
import { runCalibration } from "@/lib/matchpool/calibration-fetch";
import type { CalibrationResult } from "@/lib/matchpool/calibration";

export const dynamic = "force-dynamic";
export const revalidate = 10;

export const metadata = createMetadata({
  title: "Live · Agent Village Activity",
  description:
    "Live, anonymized funnel of agent-mediated introductions at Edge Esmeralda 2026. Proposed → responded → met → valuable.",
  path: "/edge-city/plaza",
  ogTitle: "Live · Edge Esmeralda Plaza",
});

// ─────────────────────────────────────────────────────────────────────
// Anonymizer: short stable hash for an agent ID. NOT cryptographic —
// strictly for "Agent #047"-style display. Visible to the world, must
// not reverse to user_id.
// ─────────────────────────────────────────────────────────────────────
function anonAgent(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = ((h << 5) - h + userId.charCodeAt(i)) | 0;
  }
  // Clamp to 3 digits so display is "Agent #042" not "Agent #-1842671023"
  return `Agent #${String(Math.abs(h) % 1000).padStart(3, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────
// Data fetchers — each isolates a single query so partial failure of
// one section doesn't blow up the whole page.
// ─────────────────────────────────────────────────────────────────────

interface FunnelCounts {
  total_outcomes: number;
  proposed_count: number;
  responded_count: number;
  accepted_count: number;
  declined_count: number;
  met_count: number;
  valuable_count: number;
  valuable_rate: number | null;
  avg_deliberation_score_valuable: number | null;
  avg_deliberation_score_declined: number | null;
}

async function fetchFunnel(): Promise<FunnelCounts | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("matchpool_funnel_counts", {
    p_partner: null,
    p_match_engine: null,
    p_since: null,
  });
  if (error || !data?.length) return null;
  return data[0] as FunnelCounts;
}

async function fetchActiveAgentsToday(): Promise<number> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("matchpool_outcomes")
    .select("source_user_id")
    .gte("created_at", since);
  if (error || !data) return 0;
  return new Set(data.map((r) => (r as { source_user_id: string }).source_user_id)).size;
}

interface RecentRow {
  outcome_id: string;
  source_user_id: string;
  candidate_user_id: string;
  match_engine: string;
  proposed_at: string | null;
  responded_at: string | null;
  met_at: string | null;
  rated_at: string | null;
  rating_post_meeting: number | null;
}

async function fetchRecentActivity(): Promise<RecentRow[]> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("matchpool_outcomes")
    .select(
      "outcome_id, source_user_id, candidate_user_id, match_engine, proposed_at, responded_at, met_at, rated_at, rating_post_meeting"
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(12);
  if (error || !data) return [];
  return data as RecentRow[];
}

interface ScoreBucket {
  range: string;
  valuable: number;
  declined: number;
}

async function fetchScoreDistribution(): Promise<ScoreBucket[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("matchpool_outcomes")
    .select("deliberation_score, rating_post_meeting, counterpart_response")
    .not("deliberation_score", "is", null);
  if (error || !data) return [];
  const buckets: ScoreBucket[] = [
    { range: "<0.3", valuable: 0, declined: 0 },
    { range: "0.3-0.45", valuable: 0, declined: 0 },
    { range: "0.45-0.55", valuable: 0, declined: 0 },
    { range: "0.55-0.7", valuable: 0, declined: 0 },
    { range: "0.7-0.85", valuable: 0, declined: 0 },
    { range: ">=0.85", valuable: 0, declined: 0 },
  ];
  for (const row of data) {
    const r = row as { deliberation_score: number; rating_post_meeting: number | null; counterpart_response: string | null };
    const s = r.deliberation_score;
    let idx = 0;
    if (s >= 0.85) idx = 5;
    else if (s >= 0.7) idx = 4;
    else if (s >= 0.55) idx = 3;
    else if (s >= 0.45) idx = 2;
    else if (s >= 0.3) idx = 1;
    if ((r.rating_post_meeting ?? 0) >= 4) buckets[idx].valuable++;
    else if (r.counterpart_response === "declined") buckets[idx].declined++;
  }
  return buckets;
}

async function fetchHourlyActivity(): Promise<{ hour: string; count: number }[]> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("matchpool_outcomes")
    .select("created_at")
    .gte("created_at", since);
  if (error || !data) return [];
  const buckets: { hour: string; count: number }[] = [];
  const now = new Date();
  for (let i = 23; i >= 0; i--) {
    const hourStart = new Date(now.getTime() - i * 3600 * 1000);
    hourStart.setMinutes(0, 0, 0);
    buckets.push({
      hour: hourStart.toISOString(),
      count: 0,
    });
  }
  for (const r of data) {
    const t = Date.parse((r as { created_at: string }).created_at);
    const hourStart = new Date(t);
    hourStart.setMinutes(0, 0, 0);
    const key = hourStart.toISOString();
    const b = buckets.find((x) => x.hour === key);
    if (b) b.count++;
  }
  return buckets;
}

// ─────────────────────────────────────────────────────────────────────
// UI components
// ─────────────────────────────────────────────────────────────────────

function FunnelCard({ data }: { data: FunnelCounts | null }) {
  if (!data || data.total_outcomes === 0) {
    return (
      <div className="rounded-xl border border-neutral-800 p-8 text-center">
        <div className="text-sm text-neutral-500 mb-2">No data yet</div>
        <div className="text-lg text-neutral-300">Edge Esmeralda begins May 30, 2026</div>
        <div className="text-xs text-neutral-600 mt-3">
          When agents start meeting, the funnel will appear here.
        </div>
      </div>
    );
  }

  const proposed = data.proposed_count;
  const responded = data.responded_count;
  const met = data.met_count;
  const valuable = data.valuable_count;

  const pct = (n: number, base: number) => (base > 0 ? Math.round((n / base) * 100) : 0);

  const stages: Array<{ label: string; count: number; basePct: number; tint: string }> = [
    { label: "Proposed", count: proposed, basePct: 100, tint: "bg-neutral-200" },
    { label: "Responded", count: responded, basePct: pct(responded, proposed), tint: "bg-emerald-300" },
    { label: "Met", count: met, basePct: pct(met, proposed), tint: "bg-emerald-400" },
    { label: "Valuable", count: valuable, basePct: pct(valuable, proposed), tint: "bg-emerald-500" },
  ];

  return (
    <div className="rounded-xl border border-neutral-800 p-6 bg-neutral-950/50">
      <div className="flex items-baseline justify-between mb-5">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500">The funnel</h2>
        <div className="text-xs text-neutral-600">last refreshed just now</div>
      </div>
      <div className="space-y-3">
        {stages.map((s) => (
          <div key={s.label}>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-sm text-neutral-300">{s.label}</span>
              <span className="text-sm tabular-nums">
                <span className="text-neutral-200 font-medium">{s.count}</span>
                <span className="text-neutral-600 ml-2 text-xs">{s.basePct}% of proposed</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-neutral-900 overflow-hidden">
              <div
                className={`h-full ${s.tint} transition-all`}
                style={{ width: `${Math.max(s.basePct, 1)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {data.valuable_rate !== null && (
        <div className="mt-6 pt-5 border-t border-neutral-800 flex items-baseline gap-3">
          <span className="text-3xl font-medium tabular-nums">
            {Math.round((data.valuable_rate ?? 0) * 100)}%
          </span>
          <span className="text-xs text-neutral-500">
            of proposed intros led to a valuable meeting
          </span>
        </div>
      )}
    </div>
  );
}

function CalibrationCard({ buckets }: { buckets: ScoreBucket[] }) {
  if (!buckets.length || buckets.every((b) => b.valuable + b.declined === 0)) {
    return (
      <div className="rounded-xl border border-neutral-800 p-6 bg-neutral-950/50">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Layer 3 calibration</h2>
        <div className="text-sm text-neutral-500">Calibration data builds up as meetings complete.</div>
      </div>
    );
  }
  const maxV = Math.max(1, ...buckets.map((b) => b.valuable));
  const maxD = Math.max(1, ...buckets.map((b) => b.declined));
  const overall = Math.max(maxV, maxD);

  return (
    <div className="rounded-xl border border-neutral-800 p-6 bg-neutral-950/50">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500">Layer 3 calibration</h2>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-neutral-400">Valuable</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-rose-500" />
            <span className="text-neutral-400">Declined</span>
          </span>
        </div>
      </div>
      <p className="text-xs text-neutral-600 mb-4">
        Did the agent&apos;s deliberation predict outcomes? Higher scores should map to valuable meetings.
      </p>
      <div className="flex items-end gap-2 h-32">
        {buckets.map((b) => (
          <div key={b.range} className="flex-1 flex flex-col items-center justify-end gap-1">
            <div className="w-full flex items-end justify-center gap-0.5 h-24">
              <div
                className="w-1/2 bg-emerald-400 rounded-t-sm"
                style={{ height: `${(b.valuable / overall) * 100}%` }}
                title={`${b.valuable} valuable in score range ${b.range}`}
              />
              <div
                className="w-1/2 bg-rose-500 rounded-t-sm"
                style={{ height: `${(b.declined / overall) * 100}%` }}
                title={`${b.declined} declined in score range ${b.range}`}
              />
            </div>
            <div className="text-[10px] text-neutral-500 tabular-nums">{b.range}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityCard({ buckets }: { buckets: { hour: string; count: number }[] }) {
  if (!buckets.length) return null;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="rounded-xl border border-neutral-800 p-6 bg-neutral-950/50">
      <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-1">Activity</h2>
      <p className="text-xs text-neutral-600 mb-4">Last 24 hours, by hour.</p>
      <div className="flex items-end gap-1 h-24">
        {buckets.map((b, i) => (
          <div
            key={i}
            className="flex-1 bg-neutral-800 rounded-t-sm relative group"
            style={{ height: `${Math.max((b.count / max) * 100, 2)}%` }}
            title={`${b.count} at ${b.hour.slice(11, 16)}`}
          >
            {b.count > 0 && (
              <div className="absolute inset-x-0 bottom-0 bg-neutral-400 rounded-t-sm" style={{ height: "100%" }} />
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-2 text-[10px] text-neutral-600 tabular-nums">
        <span>24h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Threshold tuning card — surfaces calibration recommendations as data
// arrives. Pre-Edge state: "deferred until data arrives". Mid-Edge state:
// "47 ratings, recommended threshold X with 95% CI". Post-Edge: a record
// of how the pipeline self-tuned across the village.
//
// Reads from lib/matchpool/calibration-fetch. Same library the
// scripts/_calibrate-thresholds.ts CLI uses. One Source of Truth.
// ─────────────────────────────────────────────────────────────────────
function TuningCard({ results }: { results: CalibrationResult[] }) {
  if (!results.length) return null;
  return (
    <div className="rounded-xl border border-neutral-800 p-6 bg-neutral-950/50">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500">Threshold tuning</h2>
        <span className="text-xs text-neutral-600">
          F<sub>0.5</sub> precision-weighted · 95% Wilson CI
        </span>
      </div>
      <p className="text-xs text-neutral-600 mb-5 max-w-2xl">
        The pipeline measures itself. When enough meetings are rated, it recommends
        threshold shifts that improve precision. Below: per-predictor calibration over
        all matchpool_outcomes labelled so far.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {results.map((r) => {
          const recommended = r.recommended_threshold;
          const change = recommended !== null
            ? recommended > r.current_threshold
              ? "raise"
              : recommended < r.current_threshold
                ? "lower"
                : "hold"
            : null;
          const dataReady = r.n_total >= r.min_samples_for_recommendation;
          const showRec = r.ready_to_recommend_change && recommended !== null;
          return (
            <div key={r.predictor} className="border border-neutral-900 rounded-lg p-4">
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-sm text-neutral-300 font-mono">
                  {r.predictor === "mutual_score" ? "mutual_score" : "deliberation_score"}
                </span>
                <span className="text-[10px] text-neutral-600 uppercase tracking-wider">
                  {r.predictor === "mutual_score" ? "Layer 1" : "Layer 3"}
                </span>
              </div>
              <div className="flex items-baseline gap-4 mb-3">
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Current</div>
                  <div className="text-2xl font-medium tabular-nums">{r.current_threshold.toFixed(2)}</div>
                </div>
                <span className="text-neutral-700 text-lg">→</span>
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-wider">
                    {showRec ? `Recommended` : `Pending`}
                  </div>
                  <div className="text-2xl font-medium tabular-nums">
                    {showRec ? recommended!.toFixed(2) : "—"}
                    {showRec && change === "raise" && (
                      <span className="text-emerald-400 text-base ml-2">▲</span>
                    )}
                    {showRec && change === "lower" && (
                      <span className="text-amber-400 text-base ml-2">▼</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-xs text-neutral-500 mb-2 leading-relaxed">
                {r.status_message}
              </div>
              {dataReady && r.recommended_metrics && r.recommended_precision_ci && (
                <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-neutral-900 text-xs">
                  <div>
                    <div className="text-[10px] text-neutral-600 uppercase">Precision</div>
                    <div className="text-neutral-300 tabular-nums">
                      {(r.recommended_metrics.precision * 100).toFixed(0)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-neutral-600 uppercase">Recall</div>
                    <div className="text-neutral-300 tabular-nums">
                      {(r.recommended_metrics.recall * 100).toFixed(0)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-neutral-600 uppercase">95% CI</div>
                    <div className="text-neutral-300 tabular-nums">
                      {(r.recommended_precision_ci.lower * 100).toFixed(0)}–
                      {(r.recommended_precision_ci.upper * 100).toFixed(0)}%
                    </div>
                  </div>
                </div>
              )}
              <div className="flex items-baseline justify-between mt-3 text-[10px] text-neutral-600">
                <span>
                  Samples: {r.n_total} rated ({r.n_positive} valuable, {r.n_negative} declined)
                </span>
                <span>min {r.min_samples_for_recommendation}</span>
              </div>
              {/* Tiny sparkline: F-beta across threshold sweep */}
              {dataReady && (
                <div className="flex items-end gap-px h-6 mt-2">
                  {r.sweep.map((m) => {
                    const h = Number.isNaN(m.f_beta) ? 0 : m.f_beta;
                    const isRec = r.recommended_metrics && m.threshold === r.recommended_metrics.threshold;
                    const isCur = Math.abs(m.threshold - r.current_threshold) < 0.025;
                    return (
                      <div
                        key={m.threshold}
                        className={`flex-1 rounded-t-sm ${
                          isRec ? "bg-emerald-400" : isCur ? "bg-neutral-400" : "bg-neutral-800"
                        }`}
                        style={{ height: `${Math.max(h * 100, 2)}%` }}
                        title={`t=${m.threshold.toFixed(2)} F${0.5}=${Number.isNaN(m.f_beta) ? "—" : m.f_beta.toFixed(2)}`}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentFeed({ rows }: { rows: RecentRow[] }) {
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-neutral-800 p-6 bg-neutral-950/50">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Recent agent moves</h2>
        <div className="text-sm text-neutral-500">Quiet on the wire right now.</div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-neutral-800 p-6 bg-neutral-950/50">
      <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-4">Recent agent moves</h2>
      <ul className="space-y-3">
        {rows.map((r) => {
          let action = "proposed an intro";
          let actionColor = "text-neutral-400";
          if ((r.rating_post_meeting ?? 0) >= 4) {
            action = "had a valuable meeting";
            actionColor = "text-emerald-300";
          } else if (r.met_at) {
            action = "met in person";
            actionColor = "text-emerald-400";
          } else if (r.responded_at) {
            action = "got a response";
            actionColor = "text-neutral-300";
          }
          const a = anonAgent(r.source_user_id);
          const b = anonAgent(r.candidate_user_id);
          const t = r.proposed_at ?? r.responded_at ?? r.met_at;
          const age = t ? Math.max(1, Math.round((Date.now() - Date.parse(t)) / 1000 / 60)) : 0;
          return (
            <li
              key={r.outcome_id}
              className="flex items-baseline justify-between text-sm font-mono"
            >
              <span>
                <span className="text-neutral-300">{a}</span>
                <span className={`mx-2 ${actionColor}`}>{action}</span>
                <span className="text-neutral-500">with</span>{" "}
                <span className="text-neutral-300">{b}</span>
              </span>
              <span className="text-xs text-neutral-600 tabular-nums">{age}m ago</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────

async function fetchTuningResults(): Promise<CalibrationResult[]> {
  try {
    const { results } = await runCalibration(getSupabase());
    return results;
  } catch {
    // Calibration is non-essential — page should still render if this
    // fails for any reason (DB hiccup, missing column on a fresh deploy).
    return [];
  }
}

export default async function PlazaPage() {
  // Fetch in parallel — partial failures don't block the page.
  const [funnel, activeToday, recent, distribution, hourly, tuning] = await Promise.all([
    fetchFunnel(),
    fetchActiveAgentsToday(),
    fetchRecentActivity(),
    fetchScoreDistribution(),
    fetchHourlyActivity(),
    fetchTuningResults(),
  ]);

  return (
    <main className="min-h-screen bg-black text-neutral-200">
      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* HERO */}
        <header className="mb-12">
          <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-neutral-500 mb-3">
            <span className="inline-flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Live · Edge Esmeralda 2026 · Agent Village</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-3">
            <span className="tabular-nums font-medium">{activeToday}</span>
            <span className="text-neutral-400"> agents at work</span>
          </h1>
          <p className="text-sm text-neutral-500 max-w-2xl">
            Personal AI agents talking to each other on behalf of their humans. Each agent ran on a
            dedicated VM with weeks of conversation memory, deliberated per-candidate, then DM&apos;d the
            counterpart agent. Numbers below are real, anonymized, refreshed every 10 seconds.
          </p>
        </header>

        {/* FUNNEL — full width */}
        <section className="mb-6">
          <FunnelCard data={funnel} />
        </section>

        {/* THRESHOLD TUNING — full width, important data deserves real estate */}
        <section className="mb-6">
          <TuningCard results={tuning} />
        </section>

        {/* CALIBRATION + ACTIVITY — two columns */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <CalibrationCard buckets={distribution} />
          <ActivityCard buckets={hourly} />
        </section>

        {/* RECENT FEED — full width */}
        <section className="mb-12">
          <RecentFeed rows={recent} />
        </section>

        {/* Footer */}
        <footer className="border-t border-neutral-900 pt-6 text-xs text-neutral-600 flex justify-between">
          <span>Anonymized: agent IDs are non-reversible 3-digit hashes. No PII rendered.</span>
          <span className="tabular-nums">Edge Esmeralda · 2026-05-30 → 2026-06-27</span>
        </footer>
      </div>
    </main>
  );
}
