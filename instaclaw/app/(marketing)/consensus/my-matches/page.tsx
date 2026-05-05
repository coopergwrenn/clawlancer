/**
 * /consensus/my-matches — authenticated real-data view.
 *
 * Shows the current logged-in user's top-3 deliberation results from the
 * consensus matching engine. Reads:
 *   - matchpool_cached_top3.top3_user_ids   (refreshed by /api/match/v1/results)
 *   - matchpool_deliberations               (rationale, topic, window per match)
 *   - matchpool_profiles                    (interests, looking_for, summaries)
 *
 * Display rules:
 *   - Empty state if user has no matches yet (cron hasn't run or new signup).
 *   - Per-candidate display gated by candidate's consent_tier:
 *     'interests'  → interests + looking_for, no summaries
 *     'interests_plus_name' / 'full_profile' → summaries + interests + looking_for
 *
 * The deliberation rationale, conversation_topic, and meeting_window are
 * always shown — they're the user's own agent's output about a candidate,
 * not the candidate's data.
 *
 * The static /consensus/matches preview page is unchanged and still serves
 * as the marketing demo. This page is only useful when the user has data.
 *
 * PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §5
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { createMetadata } from "@/lib/seo";
import { projectForConsent, type MatchCandidate } from "@/lib/match-scoring";

export const dynamic = "force-dynamic";

export const metadata = createMetadata({
  title: "Your matches · Consensus 2026 · InstaClaw",
  description:
    "Your agent's deliberation on who to meet at Consensus 2026. " +
    "Per-candidate rationale based on weeks of context, not just embedding similarity.",
  path: "/consensus/my-matches",
});

const glassStyle = {
  background:
    "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow:
    "rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset, rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset, rgba(0, 0, 0, 0.1) 0px 2px 4px 0px, rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset",
} as const;

const glassOrange = {
  background:
    "linear-gradient(-75deg, rgba(220,103,67,0.08), rgba(220,103,67,0.22), rgba(220,103,67,0.08))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow:
    "rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset, rgba(255, 255, 255, 0.4) 0px -2px 2px 0px inset, rgba(220, 103, 67, 0.15) 0px 2px 4px 0px, rgba(255, 255, 255, 0.18) 0px 0px 1.6px 4px inset",
} as const;

// Three kinds of "match" the user can see, distinguished by how the
// rationale was produced. Kept honest in the UI — a preliminary match
// must NOT be styled as if it were the agent's full deliberation.
type MatchKind = "full" | "preliminary" | "fallback";

interface MyMatch {
  candidate_user_id: string;
  match_score: number;
  rationale: string;       // cleaned (prefix stripped)
  kind: MatchKind;
  conversation_topic: string | null;
  meeting_window: string | null;
  skip_reason: string | null;
  display: MatchCandidate;
}

interface MatchesResult {
  matches: MyMatch[];
  computedAt: string | null;
}

// Magic prefixes the orchestrator and rerank/deliberate scripts use to
// signal what kind of result this is. Must mirror
// scripts/consensus_match_pipeline.py:RATIONALE_PREFIX_*.
const PREFIX_L2_ONLY = "<l2-only> ";
const PREFIX_FALLBACK = "<fallback: ";
const PREFIX_DELIB_FAIL = "<deliberation unavailable: ";

// Replace em-dashes (—) and en-dashes (–) with regular hyphens. The LLM
// loves em-dashes, but Cooper has called them out as a tell of "AI text"
// that breaks the agent-voice illusion. Runtime sanitization here covers
// LLM-generated rationale + topic + window without re-deploying scripts.
function stripDashes(s: string): string {
  return s.replace(/[—–]/g, "-");
}

function classifyRationale(raw: string): { kind: MatchKind; cleaned: string } {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith(PREFIX_L2_ONLY)) {
    return { kind: "preliminary", cleaned: stripDashes(trimmed.slice(PREFIX_L2_ONLY.length).trim()) };
  }
  if (trimmed.startsWith(PREFIX_FALLBACK)) {
    const close = trimmed.indexOf(">");
    const after = close > 0 ? trimmed.slice(close + 1).trim() : trimmed;
    return { kind: "fallback", cleaned: stripDashes(after) || "best-effort match (deliberation step degraded)" };
  }
  if (trimmed.startsWith(PREFIX_DELIB_FAIL)) {
    const close = trimmed.indexOf(">");
    const after = close > 0 ? trimmed.slice(close + 1).trim() : trimmed;
    return { kind: "fallback", cleaned: stripDashes(after) || "best-effort match (deliberation step degraded)" };
  }
  return { kind: "full", cleaned: stripDashes(trimmed) };
}

async function loadMatches(userId: string): Promise<MatchesResult> {
  const supabase = getSupabase();

  // 1. Get the cached top3 for this user
  const { data: cached } = await supabase
    .from("matchpool_cached_top3")
    .select("top3_user_ids, top3_scores, computed_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (!cached || !Array.isArray(cached.top3_user_ids) || cached.top3_user_ids.length === 0) {
    return { matches: [], computedAt: null };
  }
  const candidateUserIds = cached.top3_user_ids as string[];
  const computedAt = (cached.computed_at as string | null) ?? null;

  // 2. Fetch deliberations for these candidates (latest only)
  const { data: deliberations } = await supabase
    .from("matchpool_deliberations")
    .select(
      "candidate_user_id, match_score, rationale, conversation_topic, meeting_window, skip_reason, deliberated_at, candidate_profile_version"
    )
    .eq("user_id", userId)
    .in("candidate_user_id", candidateUserIds)
    .order("deliberated_at", { ascending: false });

  if (!deliberations) return { matches: [], computedAt };

  const latest = new Map<string, (typeof deliberations)[number]>();
  for (const d of deliberations) {
    if (!latest.has(d.candidate_user_id as string)) {
      latest.set(d.candidate_user_id as string, d);
    }
  }

  const { data: profiles } = await supabase
    .from("matchpool_profiles")
    .select(
      "user_id, agent_id, profile_version, offering_summary, seeking_summary, " +
        "interests, looking_for, format_preferences, consent_tier"
    )
    .in("user_id", candidateUserIds);

  if (!profiles) return { matches: [], computedAt };
  const profileRows = profiles as unknown as Array<Record<string, unknown>>;
  const profileById = new Map(profileRows.map((p) => [p.user_id as string, p]));

  const out: MyMatch[] = [];
  for (const cid of candidateUserIds) {
    const d = latest.get(cid);
    const p = profileById.get(cid);
    if (!d || !p) continue;
    const rawRationale = (d.rationale as string) || "";
    const { kind, cleaned } = classifyRationale(rawRationale);
    const candidate: MatchCandidate = {
      user_id: p.user_id as string,
      agent_id: p.agent_id as string,
      candidate_profile_version: p.profile_version as number,
      offering_summary: (p.offering_summary as string) ?? "",
      seeking_summary: (p.seeking_summary as string) ?? "",
      interests: (p.interests as string[]) ?? [],
      looking_for: (p.looking_for as string[]) ?? [],
      format_preferences: (p.format_preferences as string[]) ?? [],
      consent_tier: p.consent_tier as string,
      mutual_score: 0,
      forward_score: 0,
      reverse_score: 0,
    };
    const topic = d.conversation_topic as string | null;
    const window = d.meeting_window as string | null;
    const skip = d.skip_reason as string | null;
    out.push({
      candidate_user_id: cid,
      match_score: Number(d.match_score) || 0,
      rationale: cleaned,
      kind,
      conversation_topic: topic ? stripDashes(topic) : null,
      meeting_window: window ? stripDashes(window) : null,
      skip_reason: skip ? stripDashes(skip) : null,
      display: projectForConsent(candidate),
    });
  }
  return { matches: out, computedAt };
}

function relativeFreshness(iso: string | null): string {
  if (!iso) return "";
  const computed = Date.parse(iso);
  if (Number.isNaN(computed)) return "";
  const ms = Date.now() - computed;
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "just now";
  if (min === 1) return "1 minute ago";
  if (min < 60) return `${min} minutes ago`;
  const hrs = Math.round(min / 60);
  if (hrs === 1) return "1 hour ago";
  if (hrs < 24) return `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function shortAgentLabel(agentId: string): string {
  // agent_id is a 64-char SHA-256 hex. Show "agent-XXXX" using the
  // last 4 hex chars, since the prefix is the same for everyone.
  return agentId ? `agent-${agentId.slice(-4)}` : "agent";
}

export default async function ConsensusMyMatchesPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/consensus/my-matches");
  }

  const userId = session.user.id as string;
  const { matches, computedAt } = await loadMatches(userId);
  const freshness = relativeFreshness(computedAt);
  const hasFallback = matches.some((m) => m.kind === "fallback");
  const allPreliminary = matches.length > 0 && matches.every((m) => m.kind === "preliminary");

  return (
    <>
      {/* Hero */}
      <section className="px-4 pt-16 pb-8 sm:pt-20 sm:pb-10">
        <div className="max-w-3xl mx-auto text-center">
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.18em] mb-8"
            style={{ ...glassOrange, color: "#DC6743", fontFamily: "var(--font-serif)" }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#DC6743" }} />
            Your matches · Live
          </div>

          <p className="text-xs uppercase tracking-[0.15em] mb-3" style={{ color: "#DC6743" }}>
            Intent matching
          </p>
          <h1
            className="text-4xl sm:text-5xl font-normal tracking-[-1px] leading-[1.05] mb-5"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Your agent picked these.
          </h1>
          <p
            className="text-base sm:text-lg max-w-xl mx-auto leading-relaxed"
            style={{ color: "#6b6b6b" }}
          >
            Each match below is your own agent&apos;s judgment, based on weeks of
            context with you, about who&apos;s worth a 30-minute meeting at
            Consensus this week.
          </p>
          {freshness ? (
            <p className="mt-4 text-xs uppercase tracking-[0.18em]" style={{ color: "#9a9a9a" }}>
              Computed {freshness}
            </p>
          ) : null}
        </div>
      </section>

      {/* Honest banners — preliminary or degraded state. Better the user
          knows than thinks the agent's depth is what's on the page. */}
      {allPreliminary ? (
        <section className="px-4 pb-2">
          <div className="max-w-3xl mx-auto">
            <div className="rounded-xl px-5 py-3 text-sm" style={{ ...glassOrange, color: "#7a3a26" }}>
              <span style={{ fontFamily: "var(--font-serif)" }}>Preliminary matches.</span>{" "}
              Your agent is still building context with you. These matches are
              based on profile fit, not on weeks of conversation. Talk to your
              agent more and the matches will get sharper.
            </div>
          </div>
        </section>
      ) : hasFallback ? (
        <section className="px-4 pb-2">
          <div className="max-w-3xl mx-auto">
            <div className="rounded-xl px-5 py-3 text-sm" style={{ ...glassOrange, color: "#7a3a26" }}>
              One or more matches below are best-effort. The deliberation
              step degraded. Your agent will produce richer rationale on the
              next pipeline run.
            </div>
          </div>
        </section>
      ) : null}

      {/* Empty state */}
      {matches.length === 0 ? (
        <section className="px-4 pb-24">
          <div className="max-w-3xl mx-auto">
            <div className="rounded-2xl p-8 sm:p-10 text-center" style={glassStyle}>
              <p
                className="text-2xl sm:text-3xl font-normal mb-4"
                style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
              >
                Your matches haven&apos;t arrived yet.
              </p>
              <p className="text-base leading-relaxed mb-6" style={{ color: "#6b6b6b" }}>
                The pipeline runs every 30 minutes on your VM. Once your agent
                has extracted your intent and the platform has reranked the
                candidate pool, you&apos;ll see your top 3 here.
              </p>
              <p className="text-sm leading-relaxed" style={{ color: "#999" }}>
                If you just signed up, give it 30-60 minutes. If it&apos;s been
                longer, mention it to your agent and they can run the pipeline
                manually.
              </p>
              <div className="mt-8">
                <Link
                  href="/consensus/matches"
                  className="text-sm uppercase tracking-[0.15em]"
                  style={{ color: "#DC6743" }}
                >
                  See the preview demo →
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="px-4 pb-24">
          <div className="max-w-3xl mx-auto space-y-6">
            {matches.map((m, i) => {
              const score = Math.round(m.match_score * 100);
              const tier = m.display.consent_tier;
              const showSummaries = tier === "interests_plus_name" || tier === "full_profile";
              return (
                <article key={m.candidate_user_id} className="rounded-2xl p-6 sm:p-8" style={glassStyle}>
                  <div className="flex items-start justify-between gap-6 mb-4">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-12 h-12 rounded-full flex items-center justify-center text-base font-medium"
                        style={{
                          background: "rgba(220, 103, 67, 0.08)",
                          color: "#DC6743",
                          fontFamily: "var(--font-serif)",
                        }}
                      >
                        {String(i + 1)}
                      </div>
                      <div>
                        <p
                          className="text-base sm:text-lg"
                          style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
                        >
                          {shortAgentLabel(m.display.agent_id)}
                        </p>
                        <p className="text-xs uppercase tracking-[0.15em]" style={{ color: "#9a9a9a" }}>
                          {tier === "interests" ? "Interests-only profile" : tier.replace(/_/g, " ")}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-3xl font-medium" style={{ fontFamily: "var(--font-serif)", color: "#DC6743" }}>
                        {score}
                      </p>
                      <p className="text-[10px] uppercase tracking-[0.18em]" style={{ color: "#9a9a9a" }}>
                        match
                      </p>
                    </div>
                  </div>

                  {/* Rationale — the moat. Header changes by kind so a
                      preliminary match isn't styled as full deliberation. */}
                  <div className="mb-4">
                    <p
                      className="text-[10px] uppercase tracking-[0.18em] mb-2"
                      style={{
                        color: m.kind === "full" ? "#9a9a9a" : "#a87555",
                      }}
                    >
                      {m.kind === "full"
                        ? "Your agent's read"
                        : m.kind === "preliminary"
                          ? "Preliminary · profile fit only"
                          : "Best-effort · deliberation degraded"}
                    </p>
                    <p
                      className="text-base leading-relaxed"
                      style={{ color: m.kind === "full" ? "#333334" : "#5a5a5a" }}
                    >
                      {m.rationale}
                    </p>
                  </div>

                  {/* Topic */}
                  {m.conversation_topic ? (
                    <div className="mb-4">
                      <p className="text-[10px] uppercase tracking-[0.18em] mb-2" style={{ color: "#9a9a9a" }}>
                        Talk about
                      </p>
                      <p className="text-sm sm:text-base leading-relaxed" style={{ color: "#5a5a5a" }}>
                        {m.conversation_topic}
                      </p>
                    </div>
                  ) : null}

                  {/* Meeting window */}
                  {m.meeting_window ? (
                    <div className="mb-4">
                      <p className="text-[10px] uppercase tracking-[0.18em] mb-2" style={{ color: "#9a9a9a" }}>
                        When
                      </p>
                      <p className="text-sm sm:text-base" style={{ color: "#5a5a5a" }}>
                        {m.meeting_window}
                      </p>
                    </div>
                  ) : null}

                  {/* Their public details (per consent tier) */}
                  {showSummaries && m.display.offering_summary ? (
                    <div className="mt-5 pt-5 border-t" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
                      <p className="text-[10px] uppercase tracking-[0.18em] mb-2" style={{ color: "#9a9a9a" }}>
                        They bring
                      </p>
                      <p className="text-sm leading-relaxed mb-4" style={{ color: "#5a5a5a" }}>
                        {m.display.offering_summary}
                      </p>
                      <p className="text-[10px] uppercase tracking-[0.18em] mb-2" style={{ color: "#9a9a9a" }}>
                        They&apos;re looking for
                      </p>
                      <p className="text-sm leading-relaxed" style={{ color: "#5a5a5a" }}>
                        {m.display.seeking_summary}
                      </p>
                    </div>
                  ) : null}

                  {(m.display.interests.length > 0 || m.display.looking_for.length > 0) && (
                    <div className="mt-5 pt-5 border-t flex flex-wrap gap-2" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
                      {m.display.interests.map((tag) => (
                        <span
                          key={`i-${tag}`}
                          className="text-[10px] uppercase tracking-[0.15em] px-2 py-1 rounded-full"
                          style={{ background: "rgba(0,0,0,0.04)", color: "#666" }}
                        >
                          {tag}
                        </span>
                      ))}
                      {m.display.looking_for.map((tag) => (
                        <span
                          key={`lf-${tag}`}
                          className="text-[10px] uppercase tracking-[0.15em] px-2 py-1 rounded-full"
                          style={{ background: "rgba(220,103,67,0.08)", color: "#DC6743" }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}

            <div className="text-center pt-4">
              <p className="text-xs" style={{ color: "#9a9a9a" }}>
                Updated as your agent learns more about you. Reach the candidate
                via your agent. XMTP intro flow ships Wednesday.
              </p>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
