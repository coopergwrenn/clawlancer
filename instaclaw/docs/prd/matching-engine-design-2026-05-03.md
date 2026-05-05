# InstaClaw Semantic People-Matching — Technical Design

**Status:** Draft technical design (no code until reviewed)
**Author:** Cooper / Claude
**Date:** 2026-05-03
**Companion docs:**
- `instaclaw/docs/prd/edge-city-strategy-2026-05-03.md` — strategic framing (Plan B as primary, Privacy Mode as trust artifact, etc.)
- `instaclaw/docs/prd/edgeclaw-partner-integration.md` — 1,906-line tactical PRD (the source of `route_intent()`, `agent_signals` schema, etc.)
- `instaclaw/docs/prd/index-network-signal-schema-spec.md` — pre-existing v0.1 wire format draft
- `instaclaw/docs/prd/draft-matching-design-section-agent-comms.md` — XMTP section (will be folded in as § 14 below)

---

## 0. TL;DR

Build a world-class semantic people-matching engine on the Supabase Postgres stack, exposed via a stable `route_intent()` interface that user agents call from their VMs. Make Index Network a swappable alternative provider behind the same interface, not the primary plan.

**The architectural unlock:** the matching engine is centralized for *retrieve*; the user's own agent on its own VM does *rerank* using its full memory context. The engine sees only the consented profile summary. The agent sees everything. Best signal stays on the user's box; the rest is a thin coordination layer.

**The pipeline:**
```
agent.route_intent(intent, context)
  ↓ Supabase RRF hybrid retrieval (tsvector + pgvector HNSW, single CTE query)
  ↓ Hard filters (cohort, consent, recency, blocklist, prior-meeting cooldown)
  ↓ Top-200 candidates
  ↓ Asymmetric mutual-threshold filter (B's score-of-A also clears a floor)
  ↓ Top-50 survivors → returned to caller
agent receives 50 → does its own LLM rerank with full SOUL.md/MEMORY.md context
  ↓ MMR diversity (λ=0.7)
  ↓ Top-K presented via Telegram briefing
```

**The stack:**
- Embeddings: `voyage-3-large` at 1024-dim int8 (Matryoshka). OpenAI `text-embedding-3-large` as fallback.
- Vector store: Supabase Postgres + `pgvector` + `pgvectorscale`. **No new infrastructure.**
- Hybrid retrieval: tsvector GIN + HNSW vector + RRF fusion in one CTE.
- Reranker (engine-side, optional v1.5): Cohere Rerank 3.5 — defer until quality complaints land.
- Reranker (agent-side, v1): Claude Sonnet listwise on user's VM with full memory context. **This is the moat.**
- Diversifier: MMR λ=0.7.
- Reason generator: Claude Haiku per surviving candidate, with prompt caching.
- Cost at 50K users: ~$1,500/yr embeddings + ~$0 additional DB + ~$0.02/user/day rerank+reasons via Anthropic credits the user already pays for.

**The five non-obvious decisions:**

1. **Skip Gale-Shapley stable matching for v1.** Case-study agent argued for it (Hinge's 8× phone-exchange wedge). Algorithm agent argued against (wrong shape — our matches are continuous stream, not one-shot assignment). We side with algorithm agent: use asymmetric mutual-threshold filtering instead, which captures the Gale-Shapley benefit (no stalker dynamics, no popularity collapse) without the one-pick-per-day assumption. Revisit after week 2 of village if quality complaints surface.
2. **Skip cross-encoder reranking on the engine. Push it to the agent's VM.** The agent has weeks of memory; an external cross-encoder doesn't. Reranking on the user's own VM with their own Anthropic credits is structurally better quality than any centralized cross-encoder, and it's roughly free.
3. **Skip GNNs / PinSage / LiGNN.** At 50K users the graph is too sparse. Soft-prior boost from "shared partner cohort" + "prior confirmed meeting" captures 90% of the value at 0% of the engineering cost.
4. **Skip Gale-Shapley, also skip HyDE for cold start.** The agent-self-summary pattern is more honest and produces better embeddings than synthetic HyDE documents.
5. **Centralize matching, but make every protocol decision compatible with later decentralization.** XMTP is the natural arrival point for agent-to-agent communication post-Edge. The wire format we ship today must not preclude it.

**What's not in this doc:** the actual matching algorithm tuning (will iterate post-launch with real data), the open-source repo layout (we'll do that in Phase 2 post-village), full XMTP integration spec (deferred per the strategy doc — only the v1 stub for the wire format).

---

## 1. The Asymmetric Wedge

Why we can build something genuinely better than Index Network, Brella, or anything else in this category. **Not generic ML reasons. Specific structural reasons we have that they don't.**

### 1.1 Per-user content depth

Every existing matching system has a 5-field profile. Hinge has photos + prompts. LinkedIn has work history. Brella has interest tags. Index Network's flagship signal is the JSON availability signal a user explicitly composes.

We have weeks of conversational memory. By week 3 of Edge, our agent has heard the user articulate their goals 30+ times, refine them, change them, abandon some, escalate others. **No onboarding form captures any of this.**

The matching literature is bottlenecked on "what does the query mean?" because they have rich queries and thin candidates. We have the opposite problem: thin queries and rich candidates. This means the marginal value of LLM-in-the-loop reranking is much higher for us than for typical RAG. The richer the candidate, the more an LLM rerank helps. Our candidates are richer than anyone's.

### 1.2 Agent-mediated surface

The match doesn't appear as a list. It surfaces inside an ongoing agent conversation. The agent can:
- Ask for confirmation in the user's natural cadence
- Generate a tailored reason ("she's a biotech founder working on AI drug discovery — you mentioned wanting to meet someone in that space last Tuesday")
- Gate disclosure progressively (name → interests → contact info as both sides accept)
- Defer politely if the timing isn't right
- Re-rank in real-time based on the user's current attention

Hinge presents a "Most Compatible" tile. We present a Telegram message in the user's voice. **The presentation layer is part of the matching system.**

### 1.3 Asymmetric, consented disclosure

Each agent knows a lot about its user. The matching engine itself doesn't need to know nearly as much. The right architectural pattern is:

```
Agent A's VM        Matching Engine          Agent B's VM
─────────────       ───────────────         ─────────────
full memory   →     embedded summary    →    full memory
                    + structured signal       (B's agent reads engine's
                    + cohort + consent        candidates, applies B's
                                              own preferences last)
```

The engine is a coordinator. The intelligence — both ends of the match — happens on the user's VM. The engine never has more than the user explicitly consented to share.

**Index Network's architecture has the engine doing all the reasoning.** Their bilateral negotiator agents run on their infrastructure, with their LLM costs, with their privacy boundary. The user agent submits an intent and waits for the negotiator's verdict. We invert this: the user's own agent reasons about candidates on its own VM, with its own LLM credits, with its own privacy posture. The engine does cheap retrieval; the agent does expensive reasoning.

### 1.4 Why these three add up to "world-class"

Each one in isolation is incremental. Together:
- Per-user content depth gives us a *different signal* than competitors.
- Agent-mediated surface gives us a *different presentation* than competitors.
- Asymmetric consented disclosure gives us a *different privacy story* than competitors.

The cumulative result is a category-different system. Not "Brella but better." A new architecture for agent-mediated matching where each agent is an active participant in its user's interest, instead of a passive recipient of a centralized matchmaker's verdict.

**That's the wedge thesis.** Every architectural choice below should reinforce it.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                       USER VM (one of 500–50K)                        │
│                                                                       │
│   OpenClaw agent                                                      │
│    ├── observes user via Telegram                                     │
│    ├── maintains MEMORY.md, SOUL.md, daily-availability signal        │
│    ├── generates profile summary nightly (~500 chars, LLM-written)    │
│    ├── invokes route_intent(intent, context) when matching needed     │
│    ├── receives candidate list (top-50)                               │
│    ├── runs local LLM rerank with full memory context                 │
│    ├── runs MMR diversity                                             │
│    ├── generates per-match explanations                               │
│    └── presents top-K via Telegram                                    │
└───────────────┬───────────────────────────┬───────────────────────────┘
                │                           │
                │ POST /api/match/v1/        │ POST /api/match/v1/
                │  route_intent              │  feedback
                │ X-Gateway-Token            │
                ▼                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  INSTACLAW MATCHING SERVICE (Vercel)                  │
│                                                                       │
│   Provider Router                                                     │
│    └── reads INSTACLAW_MATCH_PROVIDER env: "instaclaw" | "index"      │
│         ├── "instaclaw" (default) → InstaClaw backend below           │
│         └── "index" → forward to Index Network's `/v1/signals`        │
│                                                                       │
│   InstaClaw backend                                                   │
│    ├── validate consent tier + cohort scope                           │
│    ├── (re-)compute query embedding from intent + summary             │
│    ├── Supabase RRF hybrid retrieval (tsvector + HNSW)                │
│    ├── apply hard filters (cohort, recency, blocklist, cooldown)      │
│    ├── apply asymmetric mutual-threshold filter                       │
│    ├── return top-50 to caller                                        │
│    ├── log to research export tables                                  │
│    └── return candidates                                              │
│                                                                       │
│   Background workers                                                  │
│    ├── re-embed on dirty flag (15-min cron drain)                     │
│    ├── nightly profile-summary refresh (per-VM signal collection)     │
│    └── feedback ingest (post-meeting outcomes)                        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       SUPABASE (pgvector + pgvectorscale)             │
│                                                                       │
│   instaclaw_users (existing)                                          │
│   instaclaw_vms (existing)                                            │
│                                                                       │
│   matchpool_profiles (NEW)                                            │
│    ├── user_id, agent_id (hashed for research)                        │
│    ├── profile_summary TEXT (LLM-generated, user-auditable)           │
│    ├── embedding vector(1024) — voyage-3-large 1024-dim int8          │
│    ├── fts tsvector (generated)                                       │
│    ├── interests TEXT[], goals TEXT[], looking_for TEXT[]             │
│    ├── available_slots TEXT[], week INT                               │
│    ├── partner TEXT, consent_tier TEXT, cohort_tag TEXT               │
│    ├── verified_human BOOLEAN (World ID signal)                       │
│    ├── last_active_at, last_embedded_at TIMESTAMPTZ                   │
│    ├── dirty BOOLEAN (re-embed queue)                                 │
│    └── HNSW + GIN + filter indexes                                    │
│                                                                       │
│   matchpool_outcomes (research export)                                │
│    └── (see § 6 schema)                                               │
└──────────────────────────────────────────────────────────────────────┘
```

The split is deliberate:
- **Engine = retrieval + filter.** Cheap, fast, single source of truth for "who's in the pool."
- **Agent = rerank + reason.** Expensive but already paid for via the user's existing Anthropic credits, with full memory context the engine never has.

This is the architectural inversion that makes our matching better than centralized alternatives. The engine is a directory; the agent is the matchmaker.

---

## 3. The Wire Format

The interface is the load-bearing thing. If we get this right, the backend is swappable.

### 3.1 `route_intent` request

```typescript
// POST /api/match/v1/route_intent
// Headers:
//   X-Gateway-Token: <agent's Bankr-derived gateway token>
//   Content-Type: application/json
//   Idempotency-Key: <UUIDv7> (client-generated, dedup window 24h)

interface RouteIntentRequest {
  // Caller-provided. Free-form natural language.
  intent: string;
  // Examples:
  //   "find biotech founders to meet this week"
  //   "find someone who's worked with zk-SNARKs and is around Wednesday"
  //   "find 5-7 people for a sunset hike tomorrow"

  // Caller-provided structured context. Engine uses this for filters + scoring.
  context: {
    week?: number;                 // Edge week 1-4
    available_slots?: string[];    // ["10am-12pm", "dinner"]
    interests?: string[];          // ["biotech", "longevity"]
    looking_for?: string[];        // ["biotech-founder", "ai-researcher"]
    consent_tier:                  // see § 7 — what the engine may surface to others
      | "name_only"
      | "interests"
      | "interests_plus_name"
      | "full_profile";
    cohort_tag?: string;           // Vendrov experimental cohort, opaque string
    cohort_scope?: "edge_city" |   // primary scope for retrieval
                   "consensus_2026" |
                   "all_active";
    format_hint?: "1on1" | "group" | "session";  // recommended interaction shape
    group_size?: { min: number; max: number };   // when format_hint = "group"
  };

  // How many candidates to return.
  top_k: number;  // default 50; max 200

  // Caller-provided source identifier (for research logging).
  client_version: string;  // "instaclaw-skill-v0.5.2"
}
```

### 3.2 `route_intent` response

```typescript
interface RouteIntentResponse {
  status: "accepted";
  request_id: string;        // UUID — for follow-up feedback
  generated_at: string;      // ISO timestamp
  match_engine: "instaclaw" | "index";  // which backend served this
  candidates: MatchCandidate[];
}

interface MatchCandidate {
  agent_id: string;          // hashed agent identifier (NOT raw wallet)
  match_score: number;       // 0-1, post-filter, pre-rerank
  human_first_name?: string; // only if other side's consent_tier permits
  visible_summary: string;   // ~200 char extract of their consented profile
  visible_interests: string[];
  overlap_interests: string[];
  available_slots: string[];
  reason_seed: string;       // engine's rough why (caller agent will rewrite)
  // Connection metadata:
  prior_confirmed_meeting?: { at: string; engine_attribution: string };
  shared_cohort_tags?: string[];  // partner overlaps for context
}
```

The agent-side post-processing layer takes this and:
1. Reads the agent's full SOUL.md + MEMORY.md
2. LLM-reranks the candidates using full context
3. Diversifies via MMR
4. Generates a personalized reason for each surviving candidate
5. Surfaces top-K via Telegram

### 3.3 `feedback` endpoint

```typescript
// POST /api/match/v1/feedback
interface FeedbackRequest {
  request_id: string;        // from a prior route_intent response
  candidate_agent_id: string;
  outcome:
    | "surfaced_to_human"    // agent showed it to user
    | "human_dismissed"
    | "human_proposed_meeting"
    | "counterpart_accepted"
    | "counterpart_declined"
    | "meeting_confirmed"
    | "meeting_happened"
    | "meeting_valuable"     // post-meeting check-in: 1-5 rating + binary
    | "meeting_not_valuable";
  rating?: number;           // 1-5 if applicable
  metadata?: {
    response_latency_minutes?: number;
    free_text_reason?: string;   // PII-swept before research export
  };
}
```

Feedback writes to research tables and updates the `matchpool_outcomes` row used for future scoring (LinUCB-style — see § 5.6).

### 3.4 Auth model

Every request authenticates via `X-Gateway-Token` (the existing per-VM token from `instaclaw_vms.gateway_token`). This is the same auth we just shipped for the privacy-mode bridge endpoint. The matching engine uses the existing `lookupVMByGatewayToken()` helper, looks up the user, applies per-user privacy + consent + cohort scoping.

**Why X-Gateway-Token, not OAuth/JWT/wallet-signing:** the agent on the VM doesn't have an interactive session. The gateway token is the agent's identity. It's already provisioned, already rotated periodically, already enforced at the existing gateway routes. No new identity infrastructure.

**Index Network compatibility:** if `INSTACLAW_MATCH_PROVIDER=index`, the matching service translates `route_intent` → `submit_signal` + `get_matches` (per the Index spec) and forwards. The agent never sees the difference.

---

## 4. The Matching Pipeline

Pseudocode, opinionated. Each step is a deliberate decision; reasons inline.

```python
async def route_intent(req: RouteIntentRequest, agent: VMAgent) -> RouteIntentResponse:
    # ─── STEP 1: Authenticate + load caller's profile ──────────────────
    me = await load_matchpool_profile(agent.user_id)
    if me is None or me.consent_tier == "hidden":
        return EmptyResponse("user_not_in_pool")

    # Cold-start gating: if conversational memory is below threshold, return
    # placeholder candidates with low-confidence signal. Caller agent surfaces
    # this as "your agent is still getting to know you" instead of a match.
    if me.profile_summary_tokens < COLD_START_TOKEN_THRESHOLD:  # ~5K
        return ColdStartResponse(me)

    # ─── STEP 2: Compose query embedding ──────────────────────────────
    # Concatenate the user's stable summary with the runtime intent.
    # "Find biotech founders" + "Sarah is working on AI drug discovery
    #  with longevity focus..." gives a richer query than either alone.
    query_text = f"{req.intent}\n\nProfile: {me.profile_summary}"
    query_embedding = await embed(query_text, model="voyage-3-large", dim=1024)

    # ─── STEP 3: Hybrid retrieval (one Postgres query, RRF fusion) ────
    # tsvector matches on rare tokens (names, jargon, project names).
    # pgvector matches on semantic similarity.
    # RRF combines without score-normalization issues.
    candidates = await db.query("""
      WITH dense AS (
        SELECT user_id, ROW_NUMBER() OVER (
          ORDER BY embedding <=> $1::vector
        ) AS rank
        FROM matchpool_profiles
        WHERE
          partner = $4 OR ($4 = 'all_active' AND last_active_at > NOW() - INTERVAL '30 days')
        AND user_id != $2
        AND consent_tier IN ('interests', 'interests_plus_name', 'full_profile')
        LIMIT 500
      ),
      sparse AS (
        SELECT user_id, ROW_NUMBER() OVER (
          ORDER BY ts_rank_cd(fts, plainto_tsquery('english', $3)) DESC
        ) AS rank
        FROM matchpool_profiles
        WHERE
          fts @@ plainto_tsquery('english', $3)
          AND (partner = $4 OR ($4 = 'all_active' AND last_active_at > NOW() - INTERVAL '30 days'))
          AND user_id != $2
          AND consent_tier IN ('interests', 'interests_plus_name', 'full_profile')
        LIMIT 500
      ),
      fused AS (
        SELECT user_id, SUM(1.0 / (60 + rank)) AS rrf_score
        FROM (SELECT * FROM dense UNION ALL SELECT * FROM sparse) x
        GROUP BY user_id
      )
      SELECT p.*, f.rrf_score
      FROM fused f
      JOIN matchpool_profiles p USING (user_id)
      ORDER BY f.rrf_score DESC
      LIMIT 200;
    """, query_embedding, me.user_id, query_text, req.context.cohort_scope or 'all_active')

    # ─── STEP 4: Hard filters ──────────────────────────────────────────
    candidates = [c for c in candidates
        if not me.has_blocked(c.user_id)
        and not has_recent_meeting(me, c, days=30)
        and (c.available_through is None or c.available_through > NOW())
        and timezone_overlap(me, c) > 2  # 2hr minimum
        and matches_format_hint(req.context.format_hint, c)
    ]

    # ─── STEP 5: Asymmetric mutual-threshold filter ───────────────────
    # The cheap approximation of Hinge's stable-matching wrapper without
    # the one-pick-per-day shape. For each candidate, also score them as
    # if they were querying for someone like me. If their score-of-me is
    # below threshold, drop. This kills the "stalker" pattern (50 people
    # all matching to one popular person) by enforcing reciprocal interest.
    #
    # Implementation note: this is computed against their stored embedding
    # vs my profile_summary. We do NOT regenerate their embedding — we use
    # what they consented to put in the pool. Asymmetric scoring naturally
    # falls out because rich profiles compress differently in each direction.
    survivors = []
    for c in candidates:
        their_score_of_me = cosine_sim(c.embedding, me.embedding)
        if their_score_of_me >= MUTUAL_THRESHOLD:  # ~0.55, tuned
            c.mutual_score = (c.rrf_score * their_score_of_me) ** 0.5  # geometric mean
            survivors.append(c)
    survivors.sort(key=lambda c: c.mutual_score, reverse=True)
    survivors = survivors[:50]

    # ─── STEP 6: Soft prior boosts (cheap signal) ─────────────────────
    for c in survivors:
        if c.user_id in me.prior_confirmed_meeting_user_ids:
            c.mutual_score *= PRIOR_MEETING_BOOST  # 1.15
        if c.partner == me.partner and c.partner != 'all_active':
            c.mutual_score *= COHORT_OVERLAP_BOOST  # 1.05
    survivors.sort(key=lambda c: c.mutual_score, reverse=True)

    # ─── STEP 7: Light reason seed (engine-side) ──────────────────────
    # The agent will rewrite this; the engine just provides a starter
    # so the caller has a fallback if their LLM is rate-limited.
    for c in survivors:
        c.reason_seed = compute_reason_seed(me, c)  # template, not LLM

    # ─── STEP 8: Log + return ─────────────────────────────────────────
    await log_to_research_export(me, survivors, request_id, "instaclaw")
    return RouteIntentResponse(
        request_id=request_id,
        match_engine="instaclaw",
        candidates=survivors[:req.top_k],
    )


# ─── AGENT-SIDE POST-PROCESSING (runs on user's VM) ─────────────────
async def agent_postprocess(candidates, agent_memory, top_k: int = 5):
    # ─── Step A: LLM listwise rerank with full context ────────────────
    # This is THE moat. The agent has full SOUL.md + MEMORY.md. The
    # engine had only a 200-char visible summary per candidate. The
    # agent reranks based on the user's actual life, not the projection.
    rerank_input = build_rerank_prompt(
        anchor=agent_memory.full_soul_md_and_memory,  # rich
        candidates=candidates,                          # 50 with visible summaries
        instruction="Rank by predicted mutual value of a 30-minute conversation. "
                    "Penalize redundancy. Reward complementarity. Consider what "
                    "this user has been working through with you over time."
    )
    reranked = await claude.complete(
        model="claude-sonnet-4-7",
        prompt=rerank_input,
        prompt_caching=True,  # anchor is heavily reused
        response_format="ordered_list",
    )

    # ─── Step B: MMR diversity ────────────────────────────────────────
    diverse = mmr(reranked, lambda_=0.7, k=top_k * 2)

    # ─── Step C: Generate personalized reasons ────────────────────────
    # Cheap model with prompt caching of the user's profile.
    for m in diverse[:top_k]:
        m.reason = await claude.complete(
            model="claude-haiku-4-5",
            prompt=build_reason_prompt(agent_memory, m),
            prompt_caching=True,
        )

    return diverse[:top_k]
```

**Latency budget (50K-user pool):**
- Step 3 (Postgres hybrid retrieval): ~50ms p95 with HNSW + GIN
- Steps 4-7 (filters, mutual, boosts, seeds): ~50ms
- Step 8 (logging): non-blocking
- Total engine round-trip: **~100-150ms p95**
- Step A (agent LLM rerank): ~3-5s with caching, on user's VM
- Step C (per-match reasoning): ~500ms each × 5 = 2.5s, parallelized

User waits ~5-8s from "find me biotech founders" to seeing the first match. Acceptable.

**Cost (per route_intent at scale):**
- Engine: ~$0 marginal (already paying for Postgres + Voyage embedding)
- Agent rerank: ~$0.02 with prompt caching, paid by user's tier
- Reasons: ~$0.005 × 5 = $0.025

**At 50K users × 1 query/day = $1,250/day worst case.** Mostly absorbed into tier credits the user already pays for.

---

## 5. Beyond v1 — what we instrument for, what we add later

### 5.1 What ships in v1

- Hybrid retrieval (RRF + tsvector + pgvector HNSW)
- Hard filters
- Asymmetric mutual-threshold filter
- Soft-prior boosts
- Agent-side LLM rerank with full memory context
- MMR diversity
- Personalized reason generation
- Feedback ingest

### 5.2 What we instrument for, ship in v1.5–v2

- **Cohere Rerank 3.5 engine-side cross-encoder.** Add when first quality complaints land. Cheap to integrate; we already log everything.
- **Multi-objective scoring.** Right now `match_score` is one number. Twitter/X's algorithm release shows the multi-objective approach is universal: predict P(surfaced), P(human accepted), P(counterpart accepted), P(meeting happened), P(valuable). Track all of these from day 1; build the multi-objective ranker in v2.
- **LinUCB bandit on top of `mutual_score`.** Once we have ~1000 confirmed meeting outcomes (~end of Edge week 1), wire a contextual bandit to learn per-feature weights from the feedback signal.
- **Cohort-stratified eval.** Vendrov's time-staggered rollout (PRD §4.18) means we have natural treatment/control. Use this for online A/B comparisons.

### 5.3 What we explicitly do NOT build

| Skip | Why |
|---|---|
| GNNs (PinSage / LiGNN-style) | Graph too sparse at 50K. Soft prior captures 90% of value at 0% engineering cost. |
| Custom fine-tuned bi-encoder | Voyage-3-large is fine. Fine-tuning at 50K will overfit. |
| SPLADE / ColBERT late-interaction retrievers | Operational complexity for a marginal lift our reranker already provides. |
| HyDE for cold-start | Agent self-summary is more honest and produces better embeddings. |
| Full RLHF preference learning | Signal too sparse. LinUCB on hand-picked features captures 95% at 5% complexity. |
| Gale-Shapley stable matching | Wrong shape (one-shot bipartite assignment vs continuous stream). Asymmetric mutual-threshold captures the benefit. **Revisit if quality complaints surface in Edge week 2.** |
| Custom reranker model | Cohere Rerank 3.5 + Claude listwise is the 2025 consensus pipeline. Don't reinvent. |
| Single global similarity threshold | Use percentile per-user, not absolute cosine cutoff. Activity-level distributions vary. |

### 5.4 Where we deliberately depart from Index Network's approach

| Index Network's choice | Our choice | Why |
|---|---|---|
| OpenAI text-embedding-3-large @ 2000 dim | voyage-3-large @ 1024-dim int8 | 8× storage savings, 0.31% quality loss, +9.7% on long-form retrieval, Anthropic-blessed |
| Bilateral negotiator agents (LangGraph, up to 6/8 turn debate per match) | Asymmetric mutual filter + agent-side rerank | We already have agents on each VM. No need to spawn negotiator agents. The user's own agent IS the negotiator. |
| OpenRouter + Gemini 2.5 Flash for reasoning | Anthropic Claude (Sonnet for rerank, Haiku for reasons) | We're already on Anthropic. Single provider, prompt caching, tier-aware quality. |
| Better Auth + Google OAuth identity | Per-VM gateway token (existing) | Zero new identity infrastructure. Already provisioned. |
| Centralized presentation-layer privacy | Per-VM bridge-enforced privacy mode (already shipped v0) | Cryptographically meaningful, not marketing-claim. |
| Separate frontend (React SPA) for human-side | Telegram + agent-mediated surface | We don't need a separate UI. Channel exists. |
| HyDE with LLM-inferred dynamic lenses | Steal this for v1.5 | Their best idea. Multi-perspective retrieval is a real quality lift. |
| Atomic-CAS task polling for personal agents | Steal this for our XMTP transition | Perfect fit for outbound-only VMs. |

We're not building a different protocol than Index — we're building a different *implementation* with our specific architectural advantages (per-VM agents, Anthropic credits, existing privacy stack). Same wire format; different backend.

---

## 6. Data Model

### 6.1 Schema additions

```sql
-- The matching pool. One row per user actively in matchmaking.
-- Updated when the agent compiles a daily availability signal.

CREATE TABLE matchpool_profiles (
  user_id              UUID PRIMARY KEY REFERENCES instaclaw_users(id) ON DELETE CASCADE,

  -- Anonymized agent_id for research export (one-way hash of bankr_wallet + research_salt)
  agent_id             TEXT NOT NULL UNIQUE,

  -- The auditable artifact. User can read this exactly. ~500 chars.
  profile_summary      TEXT NOT NULL,
  summary_tokens       INT NOT NULL,    -- for cold-start gating

  -- The vector. voyage-3-large @ 1024 dim, int8 quantized.
  embedding            vector(1024) NOT NULL,
  embedding_model      TEXT NOT NULL DEFAULT 'voyage-3-large@1024-int8',
  embedded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Generated full-text search vector for hybrid retrieval.
  fts                  tsvector GENERATED ALWAYS AS (to_tsvector('english', profile_summary)) STORED,

  -- Structured fields. Filterable, displayable to other users per consent_tier.
  interests            TEXT[],
  goals                TEXT[],
  looking_for          TEXT[],
  available_slots      TEXT[],
  week                 INT,             -- partner-event week, if applicable
  format_preferences   TEXT[],          -- ['1on1', 'small_group', 'session']

  -- Filter dimensions.
  partner              TEXT,            -- 'edge_city', 'consensus_2026', NULL
  cohort_tag           TEXT,            -- Vendrov's experimental cohort
  consent_tier         TEXT NOT NULL DEFAULT 'interests',
                                        -- 'name_only' | 'interests' | 'interests_plus_name' | 'full_profile'
  verified_human       BOOLEAN NOT NULL DEFAULT false,  -- World ID signal

  -- Lifecycle.
  active_through       TIMESTAMPTZ,     -- e.g. end of Edge village
  last_active_at       TIMESTAMPTZ,     -- last agent interaction
  dirty                BOOLEAN NOT NULL DEFAULT false,  -- queue for re-embed
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for the pipeline.
CREATE INDEX matchpool_profiles_hnsw
  ON matchpool_profiles USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX matchpool_profiles_fts_gin
  ON matchpool_profiles USING gin (fts);

CREATE INDEX matchpool_profiles_filter
  ON matchpool_profiles (verified_human, partner, last_active_at);

CREATE INDEX matchpool_profiles_dirty
  ON matchpool_profiles (dirty)
  WHERE dirty;

CREATE INDEX matchpool_profiles_interests_gin
  ON matchpool_profiles USING gin (interests);

CREATE INDEX matchpool_profiles_looking_for_gin
  ON matchpool_profiles USING gin (looking_for);

-- Row-level security: user can read their own; service role bypasses.
ALTER TABLE matchpool_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "self_read" ON matchpool_profiles
  FOR SELECT USING (auth.uid() = user_id);

-- Outcomes / feedback (also feeds research export).
CREATE TABLE matchpool_outcomes (
  outcome_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id           UUID NOT NULL,    -- from route_intent response
  source_user_id       UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  candidate_user_id    UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  match_engine         TEXT NOT NULL,    -- 'instaclaw' | 'index'
  rrf_score            FLOAT,
  mutual_score         FLOAT,
  agent_action         TEXT,             -- 'surfaced' | 'dismissed' | 'proposed'
  counterpart_response TEXT,             -- 'accepted' | 'declined' | 'no_reply'
  human_confirmed      BOOLEAN,
  meeting_actually_happened BOOLEAN,
  rating_post_meeting  INT,              -- 1-5
  reason_text          TEXT,             -- PII-swept before research export
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX matchpool_outcomes_source ON matchpool_outcomes (source_user_id, created_at DESC);
CREATE INDEX matchpool_outcomes_pair ON matchpool_outcomes (source_user_id, candidate_user_id);

-- Block list (one user blocks another from matching).
CREATE TABLE matchpool_blocks (
  blocker_user_id      UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  blocked_user_id      UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  reason               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
```

### 6.2 Research export view (read-only for Vendrov)

```sql
-- Anonymized view for research. agent_id is hashed, user_id is not exposed.
CREATE VIEW research.match_outcomes AS
  SELECT
    mo.outcome_id,
    src.agent_id AS source_agent_id,
    cand.agent_id AS candidate_agent_id,
    mo.match_engine,
    mo.rrf_score,
    mo.mutual_score,
    mo.agent_action,
    mo.counterpart_response,
    mo.human_confirmed,
    mo.meeting_actually_happened,
    mo.rating_post_meeting,
    mo.created_at,
    src.cohort_tag AS source_cohort,
    cand.cohort_tag AS candidate_cohort
  FROM matchpool_outcomes mo
  JOIN matchpool_profiles src ON src.user_id = mo.source_user_id
  JOIN matchpool_profiles cand ON cand.user_id = mo.candidate_user_id;
```

The salt for `agent_id` is held only by InstaClaw and rotated post-village (per the Edge PRD § 4.10.3). Vendrov gets the view, never the underlying tables.

---

## 7. Embedding Pipeline + Cold-Start

### 7.1 Profile summary generation

The user's agent generates a `profile_summary` nightly. The summary is the **auditable artifact** — the user can read it exactly, edit it if they want, and know that's what's in the matching pool. This is the privacy story made concrete.

Generation prompt (run on the user's VM, using their own Anthropic credits):

```
You are generating a profile summary for {user.name} for the InstaClaw
matching pool. The summary will be used to find good people for them to
meet. It will be visible (in part) to other matched agents.

Their current memory:
{full_memory_md}

Their current SOUL.md:
{soul_md}

Their stated consent_tier: {consent_tier}
  - "name_only": include only first name + general topic area
  - "interests": include interests + goals, no contact info
  - "interests_plus_name": full first name + interests + goals
  - "full_profile": everything they're comfortable sharing publicly

Generate a 400-600 character third-person summary, optimized for semantic
match retrieval. Focus on:
- What they're working on right now (current focus)
- Who they want to meet (looking_for)
- What's distinctive about them (don't say "they're interested in tech")
- What's valuable about meeting them (substantive, not promotional)

Do NOT include: contact info, exact location, financial details, anything
the user has told you not to share, anything in the "private" memory partition.

Output only the summary text. No preamble.
```

The agent saves the summary, presents it to the user for review on the dashboard (the user sees what's in the matching pool, and can edit), and submits it to the engine via the daily signal cron.

### 7.2 Re-embedding cadence

- **Dirty flag** is set by the agent when:
  - The user explicitly says "update my matchable profile"
  - The agent's own threshold detects significant new memory (>5K new tokens)
  - The agent's daily signal cron generates a meaningfully different summary
- **Cron worker** drains dirty rows every 15 minutes, batches up to 100 rows, calls Voyage once, writes back.
- **Hard floor** every 30 days regardless (catches drift on idle users).
- **Hard ceiling** never re-embed more than 1×/24h per user (debounce).

This typically gives 0.5-2 re-embeds per user per month in steady state.

### 7.3 Cold-start

A user who just signed up has no conversational memory. Three states:

| State | Tokens of memory | Behavior |
|---|---|---|
| **Cold** | < 5K | `route_intent` returns ColdStartResponse with placeholder candidates + a "your agent is still getting to know you" flag. Agent surfaces this to user as "give me a few days to get smarter — let's talk." |
| **Warming** | 5K–15K | Real candidates returned, but with `low_confidence: true`. Agent surfaces with a caveat: "I'm matching based on what we've discussed so far — these are starting points, not strong recommendations yet." |
| **Active** | > 15K | Full match quality. |

The 5K threshold is roughly 1-2 substantive agent conversations. This is honest UX — better than pretending to match well from a 5-field signup form.

The agent does run an **abbreviated onboarding interview** during cold (per current SOUL.md edge section), and that interview content counts toward the 5K threshold. So a focused new user can reach "warming" within their first session.

---

## 8. Index Network as Alternative Provider

Goal: ship the design such that we can swap to Index Network's backend with one env var change, no agent-side modification.

### 8.1 Provider router

```typescript
// instaclaw/lib/match-provider.ts
type MatchProvider = "instaclaw" | "index";

const PROVIDER_DEFAULT: MatchProvider = "instaclaw";

export async function routeIntent(
  req: RouteIntentRequest,
  agent: AuthenticatedAgent,
): Promise<RouteIntentResponse> {
  const provider = (process.env.INSTACLAW_MATCH_PROVIDER as MatchProvider)
    ?? PROVIDER_DEFAULT;

  // Per-user override for A/B testing (set via cohort_tag).
  const userOverride = await getUserMatchProvider(agent.user_id);
  const effective = userOverride ?? provider;

  if (effective === "instaclaw") {
    return await instaclawBackend.routeIntent(req, agent);
  } else if (effective === "index") {
    return await indexBackend.routeIntent(req, agent);
  }
  throw new Error(`Unknown match provider: ${effective}`);
}
```

### 8.2 Index adapter

```typescript
// instaclaw/lib/match-providers/index-adapter.ts
export const indexBackend = {
  async routeIntent(req, agent) {
    // Translate our wire format to Index's signal/match flow.
    const signal = await indexClient.submitSignal({
      agent_id: agent.bankr_address_hashed,
      signal_id: req.idempotency_key,
      night_of: today(),
      week: req.context.week,
      interests: req.context.interests,
      goals: extractGoalsFromIntent(req.intent),  // light NLP
      looking_for: req.context.looking_for,
      available_slots: req.context.available_slots,
      consent_tier: req.context.consent_tier,
      cohort_tag: req.context.cohort_tag,
      client_version: req.client_version,
    });
    // Wait for Index to compute (their latency is async-claimed).
    const matches = await indexClient.getMatches(signal.signal_id);
    return adaptIndexMatchesToOurResponse(matches, "index");
  }
};
```

### 8.3 Per-cohort override for A/B testing

If we want to compare Plan A (Index) vs Plan B (InstaClaw) within Edge:

```sql
-- Vendrov registers cohort
INSERT INTO matchpool_cohorts (cohort_tag, match_provider, description)
VALUES ('h1-treatment-index', 'index', 'Using Index Network backend'),
       ('h1-treatment-instaclaw', 'instaclaw', 'Using InstaClaw backend');

-- Users get assigned a cohort_tag during onboarding (random or designed)
UPDATE matchpool_profiles
SET cohort_tag = 'h1-treatment-instaclaw'
WHERE user_id = 'sarah-chen-uuid';
```

The provider router checks the user's cohort and routes accordingly. The `match_engine` field in the response and the research export tracks which backend served each request.

This means:
- We can ship InstaClaw as the default, Index as opt-in for technical evaluation
- We can run a 50/50 split during week 2 of Edge to compare
- Vendrov can measure match quality across providers as a fourth research hypothesis

---

## 9. Privacy Model

Three concentric circles of disclosure:

```
┌────────────────────────────────────────────────────────────┐
│  CIRCLE 1: ON THE USER'S VM                                │
│  Full conversational memory, all SOUL.md, all MEMORY.md.   │
│  Operator cannot read (privacy mode bridge enforces).      │
│  Only the user's own agent has access.                     │
│                                                             │
│  ┌──────────────────────────────────────────────────┐     │
│  │  CIRCLE 2: SUBMITTED TO MATCHING ENGINE          │     │
│  │  profile_summary (~500 chars, user-reviewed)     │     │
│  │  + structured signal (interests, looking_for,    │     │
│  │    available_slots, week, format)                │     │
│  │  + consent_tier (controls how much is visible    │     │
│  │    to other users via Circle 3)                  │     │
│  │  Engine sees this. Can derive embedding from it. │     │
│  │                                                   │     │
│  │  ┌──────────────────────────────────────┐        │     │
│  │  │  CIRCLE 3: VISIBLE TO MATCHED USERS  │        │     │
│  │  │  ~200 char extract from summary      │        │     │
│  │  │  + interests + first name (if tier   │        │     │
│  │  │    permits) + matched agent_id       │        │     │
│  │  │  This is what Sarah's agent shows    │        │     │
│  │  │  Alex when proposing the meeting.    │        │     │
│  │  └──────────────────────────────────────┘        │     │
│  └──────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────┘
```

### 9.1 Consent tiers

| consent_tier | Circle 2 contains | Circle 3 (visible to others) shows |
|---|---|---|
| `name_only` | first name + general topic area | first name + general topic area |
| `interests` (default) | interests + goals + looking_for | interests + general goal area |
| `interests_plus_name` | + first name | + first name |
| `full_profile` | + week + available_slots | + week + available_slots |

User changes their tier in their dashboard (planned UI; implementation parallel to privacy mode toggle). Default new users are `interests`.

### 9.2 What the engine cannot do

- Read the user's MEMORY.md or SOUL.md or conversation transcripts (they don't leave the VM)
- Derive contact info from the embedding (it was never embedded)
- Re-identify a hashed `agent_id` (salt is rotated post-village)
- See cross-user negotiation content (Phase 1 has none; Phase 2 with XMTP is E2E encrypted)

### 9.3 What the engine MUST do

- Persist `profile_summary` so the user can audit what's in the pool
- Honor `dirty` flag re-embeds promptly (so the user's edits propagate)
- Honor `active_through` (lifecycle end → user falls out of pool)
- Honor block list (`matchpool_blocks`) before scoring
- Honor `consent_tier` strictly when constructing Circle 3 visibility

### 9.4 The audit trail

Every match result is logged with the full filter set used. If a user reports "why did this person get matched to me?" we can replay the exact pipeline that produced the result, not reconstruct it. This is also the basis for Vendrov's research export.

---

## 10. Eval Methodology

### 10.1 Offline metrics (use sparingly)

NDCG, MRR, recall@K — useful as sanity checks during development. Useless as proxies for "good matching" because there's no labeled ground truth for "should these two humans meet."

What we DO use offline:
- **Diversity@K (alpha-NDCG):** are surfaced matches sufficiently different from each other? If λ=0.7 MMR isn't producing diversity, retune.
- **Latency p95 / p99:** the pipeline must finish in <200ms engine + <8s total.
- **Embedding drift:** weekly random sample of profiles re-embedded by hand to detect model degradation.

### 10.2 Online metrics (the real evaluation)

| Metric | Source | What it tells us |
|---|---|---|
| **Surface-rate** | `agent_action = "surfaced"` over `requests` | Does the agent trust the candidates enough to show them? |
| **Acceptance-rate** | `agent_action = "proposed"` / surfaced | Does the user accept the agent's recommendation? |
| **Counterpart-acceptance-rate** | `counterpart_response = "accepted"` / proposed | Does the other side reciprocate? |
| **Meeting-rate** | `human_confirmed = true` / accepted | Do meetings actually get scheduled? |
| **Meeting-happened-rate** | `meeting_actually_happened = true` / confirmed | Do scheduled meetings actually occur? |
| **Post-meeting valuable** | `rating_post_meeting >= 4` / happened | Were the meetings worth it? |
| **"Best connection of the village"** | Manual end-of-village survey | The North Star metric — like Hinge's phone-exchange. |

Multi-objective: track all of these from day 1. Don't collapse to a single match score.

### 10.3 Cohort comparisons

Per Edge PRD §4.18 time-staggered rollouts:
- Week 1 (control): no matchmaking. Agents have skill + memory + Telegram. Match acceptance literally 0.
- Week 2 (treatment): matchmaking enabled (Plan B). Compare engagement, "I met someone today" rate, etc.
- Optional within-week split: cohort A on InstaClaw backend, cohort B on Index Network (when available).

This gives clean comparison without "I'm in the bad cohort" complaints — every attendee gets every feature by end of village.

### 10.4 The bar for "world-class"

We say we're world-class when:
1. Counterpart-acceptance-rate ≥ 50% (Index's wire format spec implies this is their target)
2. Meeting-happened-rate ≥ 60% of accepted
3. ≥30% of attendees report a "best connection of the village" was agent-facilitated
4. Net Promoter on matching (one survey question post-village, "would you recommend this to a friend at a future event?") ≥ +30

Hinge's 8× phone-exchange-rate is our reference comparable. We won't have phone-exchange-rate; "meeting actually happened" is our equivalent.

---

## 11. Scale Plan

| Scale | Storage | Engine compute | Notable |
|---|---|---|---|
| **500 users** (Edge Esmeralda) | <1 MB embeddings, <100K rows total | 1 Vercel function, no caching | Trivial. Don't think about it. |
| **5K users** (Eclipse, future Edge events) | ~20 MB embeddings, ~1M outcome rows | Add Vercel Edge cache for hot signals | Still trivial. |
| **50K users** (broader InstaClaw fleet within 12 months) | ~200 MB embeddings, ~50M outcome rows | pgvectorscale becomes necessary; possibly partition outcomes table | Still all in Postgres. ~$2K/yr embedding cost. |
| **500K users** (multi-year horizon) | ~2 GB embeddings, ~500M outcome rows | Consider Qdrant Cloud for hot retrieval path; keep canonical state in Postgres | Re-evaluate. Don't pre-optimize. |

The plan is to **stay in Postgres until we measurably can't.** pgvectorscale benchmarks (471 QPS @ 99% recall on 50M vectors) are 1000× past where we'd need to go.

The trigger for adding a dedicated vector DB:
- p95 retrieval latency >200ms sustained, OR
- specific filter classes (e.g., recency-with-cohort) consistently miss the HNSW recall window

When that trigger fires, add Qdrant as a *secondary* index for the hot path. Keep canonical state in Postgres. Don't migrate wholesale.

---

## 12. Open Source vs Proprietary

### 12.1 Publish

- The wire format spec (`route_intent`, `feedback`)
- The schema (the public columns; not the salt)
- The pipeline pseudocode (above)
- The privacy bridge code (already approved for open-source per the Edge strategy doc)
- The provider-router pattern (so external builders can swap in their own backend)
- The cohort assignment + research export schema (Vendrov co-authoring)
- The `edge-conformance` test runner (Phase B)

### 12.2 Keep proprietary

- The actual prompt for agent-side rerank (the wording is iterative product work)
- The tuned thresholds (mutual_threshold, prior_meeting_boost, etc.)
- The salt + hashing for `agent_id`
- The behavioral signal extraction logic (how the agent decides what's in the daily summary)
- The cross-event memory glue
- Anything depending on Anthropic-specific prompt caching

### 12.3 Why this split

The wire format being open means external builders can plug their own agents into the InstaClaw plaza (Path B/C from the Edge PRD). The implementation being proprietary means we keep the operational moat (running the matching engine, tuning the thresholds, paying the LLM bills, owning the data flywheel).

Index Network publishes their entire backend (including their negotiator agent prompts). We publish less. **That's a deliberate competitive choice**, not laziness.

---

## 13. The 27-Day Build Plan (matching engine portion)

**Constraint:** these days overlap with the larger Edge launch (Plan B, morning briefing, Live Activity Dashboard, etc.) per the strategy doc. The matching engine timeline is a subset of that timeline.

| Date | Item | Notes |
|---|---|---|
| **May 3-4 (today)** | Strategy doc + this technical design doc | Both written. Awaiting review. |
| May 5-7 | (Cooper at Consensus; no deploy window) | Watch and learn. |
| **May 8** | DPA / NDA with Vendrov signed | Originally May 1; finalizing now |
| **May 9-10** | Schema migration: matchpool_profiles, matchpool_outcomes, matchpool_blocks, research view | One PR, one migration. |
| **May 10-11** | Voyage embedding integration + dirty-flag cron (15-min drain) | Use existing cron infrastructure. |
| **May 11-12** | Profile summary generation skill — agent generates summary nightly via cron, submits to engine | Add to edge_city VMs. |
| **May 12-14** | route_intent v1: hybrid retrieval + filters + mutual threshold + soft priors | Single Vercel function, single Postgres CTE. |
| **May 14-15** | Agent-side rerank skill on edge_city VMs | New skill: reads engine response, runs Claude listwise rerank with full memory, MMR diversifies, generates reasons. |
| **May 15** | **CORE EXPERIENCE SHIP TARGET** — match engine + agent rerank + Telegram briefing all working end-to-end on 5 internal accounts | Per strategy doc. |
| May 16-19 | Plan B canary at scale (10 test accounts) — verify match quality, latency, no rate-limit issues | First real-world signal. |
| **May 19-20** | feedback endpoint + outcomes ingest | Closes the loop. |
| May 20-22 | Cohort assignment system, time-staggered rollout schedule | Vendrov co-design. |
| **May 23** | **Plan A vs Plan B decision** — if Index Network is ready, flip provider env var; else stay on InstaClaw | Per strategy doc. |
| May 24-26 | End-to-end integration testing | 50 simulated agents running full overnight cycle. |
| **May 26** | Open-source release: privacy bridge + wire format spec + provider router pattern | Coordinated with Edge plaza architecture publication. |
| May 26-29 | Dry run with Edge team | Real overnight cycles, real briefings, real feedback. |
| **May 30** | **Edge Esmeralda starts** — agents live, matching active from day 1 | The thing. |

### 13.1 Hard cutover decisions (if we slip)

If May 15 ship slips by 3+ days, we cut in this order:

1. **Cut MMR diversity** — accept clustered top-K. The reason generator gives users enough differentiation to dismiss redundancies. Add MMR back in Edge week 2.
2. **Cut agent-side rerank** — accept engine-only ranking. Quality drops noticeably; this is the worst cut. Last resort.
3. **Cut hybrid retrieval, dense-only** — minor quality loss for jargon-heavy queries. Acceptable.
4. **Cut soft priors** — minor quality loss; trivially restorable.

We do NOT cut the wire format. The wire format is the thing we have to get right because the agent skill deploys against it and we can't redeploy 500 agents to change it on the fly.

---

## 14. Agent-to-Agent Communication Layer — XMTP and Beyond

*(Folded in from `instaclaw/docs/prd/draft-matching-design-section-agent-comms.md`. Captures the thinking behind why XMTP is foundational, not optional, even though it's deferred from v1.)*

This section captures the *thinking* behind why agent-to-agent messaging is foundational to the InstaClaw thesis, why XMTP is the right primitive (not the only option, but the right default), and where it lands on the roadmap. We deliberately deferred XMTP from the v1 matchmaking ship per the Edge strategy doc. **This section explains why XMTP is not a Plan B vs Plan A debate — it's a layer on top of whichever matching engine we choose.** The matching engine decides *who* should connect. XMTP (or whatever we replace it with) decides *how they talk after the introduction.*

### 14.1 The bilateral-writes ceiling

Plan B v1 writes a meeting to both agents' inboxes simultaneously. Each agent independently surfaces to its human via Telegram. Human confirms or declines. Engine reconciles. This works for the v1 morning briefing UX. **It breaks at five specific places, each of which corresponds to a more interesting product surface.**

| What breaks | Why | What we lose without a real comms layer |
|---|---|---|
| **Multi-round negotiation** | "10:30 doesn't work; can we try 11?" requires a state machine across both inboxes that the central engine has to mediate. Each round = round-trip through a centralized service. | Time and venue negotiation feels rigid. Counter-proposals are slow. Bilateral writes degenerate into a synchronous protocol pretending to be async. |
| **Multi-party coordination** | A 6-person dinner requires 15 agent pairs writing to each other's inboxes simultaneously. The central engine becomes a chat room. | Group formation can't really emerge bottom-up. Dinners get organized top-down by a coordinator agent instead of agents finding each other. |
| **Open-ended dialogue** | Agent A: "Sarah's working on biotech and would love to meet you. Here's a 3-paragraph context summary." Agent B: "Alex would love to talk; can you share what specifically she's exploring re: longevity?" Agent A: "...". | Intros are reduced to "match score, time, venue, accept/decline." The actual *substance* of why two humans should connect is throttled to a single matchmaker-generated reason string. |
| **Dynamic privacy** | The central engine sees every message. There's no way to negotiate something private without revealing it to the operator. | The privacy story has a structural ceiling on the most interesting interactions. |
| **Asynchronous task collaboration** | "Looking for a Solidity dev to debug a contract before Tuesday" posted to a topic channel. Some agents subscribe, some agents reply, some agents bid. | We never get the agentic-economy use cases — tip jar, micro-bid, scheduled paid help. |

### 14.2 What real agent-to-agent messaging unlocks

Six concrete UX patterns that are impossible with bilateral writes alone, each cumulatively building toward the 10x story:

1. **Spontaneous group formation in minutes.** Sarah's agent posts "looking for 4-6 people for sunset hike tomorrow, casual" to a topic channel. Other agents listen, score relevance, reply. Sarah's agent coordinates: bookings, location, who's coming, who's bringing food. Telegram message at 8pm: "Tomorrow 6:30pm sunset hike, 4 confirmed: Maya, Alex, James, Priya. Trail at Sonoma Ridge. Maya offered to drive." This is the killer Edge feature. Luma can't do it. Brella can't. Even Hinge can't.

2. **Polis-style governance with embedded debate.** Question: "Should we have fixed quiet hours?" Each agent surveys its human (preferred mode — yes/no Telegram, detailed stance via voice). Agents post anonymized stances to a governance topic. Coordinator runs Polis-style clustering. *Then* — and bilateral writes can't do this — agents debate the bridge stance. Each human gets a Telegram digest: "You're in cluster A. The bridge stance: 'Quiet hours opt-in by venue, not blanket policy.' Want to vote?" The Habermas Machine pattern, agent-mediated, residential scale. Tests Vendrov H5 (deliberation broadens > deepens) properly.

3. **Reputation networks via verifiable signed claims.** Agent A introduced 47 people during Edge. 38 of those intros resulted in confirmed-valuable meetings. A's reputation: 81% intro quality. *That claim can be cryptographically signed by A's wallet.* When Sarah's agent next gets an intro proposal from Agent C — she can check C's reputation signal. Over time, agents that make good intros get *more* attention; agents that spam decline get *less*. Emergent network-effect quality.

4. **Cross-event continuity at internet scale.** Sarah meets Alex at Edge in May. Three months later Sarah's at Token2049 in October. Without a persistent communication channel, the only way to reconnect is to go back through the matching engine. With XMTP, Sarah's agent DMs Alex's agent: "It's been 4 months since Edge — saw you shipped that funding round. Sarah's at Token2049 next week. Coffee?" *This is impossible without a persistent agent-to-agent channel.* It is also the structural reason InstaClaw beats every conference app — because we're the only architecture where the agent persists, the comms layer can persist with it.

5. **Distributed knowledge graph.** Each agent accumulates a (people, interests, relationships) graph from its conversations. When agents talk to each other, they exchange relevant subgraphs (with consent). A community-wide knowledge graph emerges, owned distributedly, queryable by any agent. *This is the substrate for genuinely smart matching.* Today the engine has only what each agent submitted as a daily availability signal; with cross-agent graph exchange, the engine can ask Agent A "what do you know about people in biotech that Sarah doesn't know yet?" — much richer signal.

6. **Asynchronous task collaboration / agentic economy.** Sarah posts to tasks: "Need someone with Solidity experience to debug a contract by Tuesday, paying 1.5 SOL/hour." Other agents subscribe, score, reply with availability + counter-bids. Sarah's agent picks best offer, negotiates, commits to a Bankr-on-chain payment. The introduction *and* the contract *and* the payment all flow through agent-to-agent messaging. **The agentic economy thesis made concrete.** Impossible without agent comms.

The 10x version: **agents become first-class participants in a community, not messengers.** Once they can talk to each other, the community has a parallel always-on layer of cross-everyone reasoning that humans literally cannot do at the same scale. *That* is the distributed nervous system of a community.

### 14.3 XMTP vs alternatives

| Protocol | Identity | Encryption | Decentralization | Verdict |
|---|---|---|---|---|
| **XMTP** | Wallet-based (every Bankr wallet is an XMTP identity at zero cost) | E2E via MLS (Signal Protocol's group cryptography, well-vetted) | Multiple node providers, no single point of failure | **Right primary protocol.** Aligns with our existing wallet stack, removes "we designed our own crypto" liability, decentralization story for the paper. |
| libp2p | None built-in | Modular | P2P primitives | Wrong layer. We'd be building XMTP from scratch on top of it. |
| Matrix | Server-account (federated) | E2E | Federated | Wrong identity model for crypto-native cohort. Agents shouldn't pretend to be users registering accounts. |
| Nostr | Pubkey | NIP-17/44 | Relay-based | The contingency plan. Simpler than XMTP; smaller ecosystem; less wallet-tied. Pick it as primary only if XMTP becomes constrained. |
| Build our own | Whatever | Whatever | Centralized | Only if we abandon the crypto-native story. We won't. |

**What XMTP gives us:**
1. Wallet-bound identity for every agent at zero cost
2. E2E encryption that's been audited
3. Decentralization story for the partnership + paper
4. Cross-product interoperability (Bankr already on XMTP)
5. Group messaging primitive (`ee26-plaza`, etc.) built-in
6. Pull-based delivery model (each VM polls its inbox; no webhooks; no public ports). Same atomic-CAS pattern Index Network uses.

**What XMTP imposes:**
1. Wallet dependency — fine, we have Bankr
2. Throughput limits at network level — single most important Q to validate with XMTP team before commitment
3. Identity exposure — wallet addresses are public; need rate limits + spam protection
4. Protocol evolution risk — V3 of MLS, V4 protocol changes have historically been messy
5. Discovery friction — finding another agent's wallet requires either matching engine or public group broadcast
6. Cost at scale — needs validation at 1,000-agent volume

### 14.4 The "proof of operator" thesis — XMTP as the connective tissue

InstaClaw's stack:

| Layer | Component | Status |
|---|---|---|
| Sybil resistance for humans | World ID | ✅ Shipped |
| Agent identity / economic capacity | Bankr wallet | ✅ Shipped |
| On-chain human-to-agent binding | AgentBook | ✅ Phase 1 shipped |
| Agent runtime with privacy guarantees | OpenClaw on per-user VM + privacy bridge | ✅ v0 shipped |
| Encrypted agent-to-agent communication | **XMTP** | ⏳ The missing piece |
| Reputation as verifiable claims | Wallet-signed claims via XMTP messages | ⏳ Emerges from XMTP |
| Agent economy | Bankr wallet on-chain transactions | ✅ Shipped |

**The thesis statement:** Every agent is operated by a verified human (World ID), bonded on-chain (AgentBook), with wallet-rooted identity (Bankr), running on a per-user VM with operator-restricted privacy (privacy mode), communicating over an encrypted decentralized protocol (XMTP), accumulating reputation through cryptographically signed claims, with on-chain economic capacity (Bankr).

Not "AI assistant for events." **The runtime for verified-human agent networks.**

XMTP is structurally load-bearing. Without it, World ID + Bankr + AgentBook + privacy mode are a constellation of disconnected components. With it, they're a network. The conference-app category is a wedge into this larger frame, not the destination.

### 14.5 What XMTP does NOT solve

Honest list:
- Spam (need rate limits + reputation gating at agent layer)
- Quality of operator (verified human can still operate a malicious agent)
- Discovery beyond the matching engine (XMTP is a transport, not a directory)
- Coordinator agent topology (plaza groups need to be set up, owned, moderated)
- Persistence guarantees (XMTP messages have ~30-day retention on community nodes; long-term memory comes from the agent's local storage)
- Latency for synchronous interactions (XMTP is async-first; "two agents debating in real-time during a meeting" needs a different layer)

### 14.6 Timeline — when does XMTP land?

The right framing is **triggers**, not calendar dates:

| Trigger | What it tells us | Likely arrival |
|---|---|---|
| **A. Matching needs counter-proposal** | Plan B's "engine writes the meeting; user accepts or declines" can't handle "10:30 doesn't work, try 11?" | Edge week 2 (mid-June 2026) |
| **B. Group formation requires multi-party** | Bilateral writes don't scale to 6-person dinners | Edge week 2-3 |
| **C. Governance experiments need agent debate** | Polis-clustering of stances is fine; agent-to-agent argumentation to surface bridge stances is what makes Vendrov H5 testable | Edge week 3 |
| **D. 100+ confirmed intros in the network** | Reputation signals become load-bearing for matching quality | First month of village (June 2026) |
| **E. Cross-event memory** | Edge alums at Token2049. Pre-existing channels mean the agent doesn't have to re-discover known contacts | Post-Edge, pre-Token2049 (July-September 2026) |
| **F. External builders want to integrate** | Path B/C deployments need an open-protocol on-ramp | Post-Edge (July-October 2026) |

**Recommendation: XMTP lands in two phases.**

#### Phase 1 — *Edge mid-village* (target: ~June 13, week 2 of Esmeralda)
**Scope:** XMTP for governance, group formation, multi-round negotiation. On top of existing Plan B matching. The matching engine still decides *who*; XMTP carries the conversation between agents *after* the introduction.

What lands:
- `xmtp-client.service` per VM (per-agent systemd service)
- Wallet identity = existing Bankr wallet, no new identity work
- Three groups: `ee26-plaza`, `ee26-governance`, `ee26-events` — created at village start
- A small skill (`xmtp-comms`) teaches the agent to send/receive DMs and post to groups
- New content type schema for `IntroductionProposal`, `IntroductionResponse`, `GovernanceVote`, `GroupFormation` (PRD §4.9.4 already specs these)
- Matching engine starts publishing intro candidates as "the engine matched you with Agent X — here's their wallet, want to DM?" rather than as a write-to-inbox

What does NOT land in Phase 1:
- Cross-VM XMTP at scale (only the 5 edge_city VMs initially)
- Reputation-as-signed-claims (data being collected; surface comes later)
- Asynchronous task channels / agentic economy

#### Phase 2 — *Post-Edge, pre-Token2049* (target: ~September 2026)
**Scope:** XMTP as the cross-event continuity layer. Reputation networks. External-builder open-protocol.

What lands:
- Persistent agent-to-agent channels survive event endings
- Signed claims emit from each agent for "successful intro," "valuable conversation," etc. (verifiable provenance)
- Bankr-on-chain payments tied to agent-mediated agreements
- Open-protocol bridge: external Path B/C agents can join InstaClaw groups using only `@xmtp/node-sdk` and the published content type spec
- First cross-event experiment: an Edge alumna at Token2049 reconnects with someone she met in May, all agent-mediated

The phase-2 ship is the moment "InstaClaw is the runtime for verified-human agent networks" stops being aspirational and starts being demonstrable.

### 14.7 The strategic point

**XMTP is not a "v2 nice-to-have."** It's the connective tissue that turns InstaClaw from "fleet of isolated agents" into "network of communicating agents." The matching engine decides *who*. XMTP decides *how they talk*. Without both, we ship half a product.

The reason it's deferred from v1 is **not** that it's optional. It's that we have 27 days to Edge Esmeralda and we need to ship the matching layer first, with bilateral writes as the *minimum-viable comms surface.* Once Plan B is producing daily morning briefings reliably (target May 15), we open the door to XMTP for the conversation-shaped use cases that matter — governance, group formation, multi-round negotiation. That's mid-village, around June 13.

The order is: matching engine → XMTP → reputation → cross-event memory. Each unlocks the next.

---

## 15. Open Questions (handed off to specific people, with deadlines)

| # | Question | Owner | Decision needed by |
|---|----------|-------|---|
| 1 | Voyage AI billing terms confirmed? Zero-retention TOS verified? | Cooper | May 9 (gates production embedding) |
| 2 | DPA/NDA with Vendrov signed? | Cooper + Vendrov | May 8 (gates research export schema build) |
| 3 | Cohort assignment + time-staggered rollout schedule pre-registered? | Vendrov + Timour | May 22 |
| 4 | mutual_threshold value tuning? Default 0.55 — needs calibration on real data | Cooper | After May 17 canary |
| 5 | Cohere Rerank 3.5 integration — ship in v1 or v1.5? | Cooper | Decision May 12 |
| 6 | Index Network adapter ship date? Phase 2 (post-Edge), or earlier if Index ready? | Cooper + Seref | May 23 |
| 7 | Open-source license for the wire format spec + bridge code (MIT? Apache?)| Cooper | Before May 26 publication |
| 8 | XMTP throughput validation at 1,000-agent scale | XMTP team | Ahead of Phase 1 (mid-June) |
| 9 | Per-cohort match-engine routing — what API surface for Vendrov to assign? | Cooper + Vendrov | May 20 |

---

## 16. The Recommendation

If you read nothing else: **ship the pipeline in § 4 with the schema in § 6, on the wire format in § 3, by May 15.** Don't add reranking. Don't add GNNs. Don't add Gale-Shapley. Don't add HyDE. Iterate post-launch with real data.

The wedge is the agent-side LLM rerank with full memory context. That's the architectural insight no other matching system has the runtime to do. Everything else in the pipeline is the standard 2025 consensus pattern.

Index Network is interesting but they're solving a different problem with different infrastructure trade-offs. Same wire format. Different backend. Their bilateral negotiator pattern is clever but not necessary when each user already has an agent on a VM that can do the negotiation locally.

**XMTP is the layer that comes after.** Not Plan B vs Plan A. Both. In that order.

When the matching engine works (target May 15) and Plan B is producing daily briefings reliably, XMTP becomes the unlock for governance, group formation, and the larger crypto-native thesis. Mid-village June 13 for Phase 1. September 2026 pre-Token2049 for Phase 2.

This is the technical design for the matching engine. The strategic framing is in the Edge strategy doc. The XMTP roadmap is in § 14 above. The only decision that matters this week is: **build it on Postgres + voyage-3-large + Claude on each VM, ship by May 15.**

No code until you've reviewed.
