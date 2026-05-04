# InstaClaw Intent Matching for Consensus 2026 — Technical Design Addendum

**Status:** Draft technical design (no code until reviewed)
**Author:** Cooper / Claude
**Date:** 2026-05-04
**Target ship:** Tuesday 2026-05-05 morning ET

**Foundation document (do not duplicate):**
`instaclaw/docs/prd/matching-engine-design-2026-05-03.md` — the 1182-line core
matching engine design from yesterday. This addendum extends it with the four
architectural decisions specific to Consensus and reframes the build plan
around a 3-day event timeline.

**Companion / referenced:**
- `instaclaw/docs/prd/draft-matching-design-section-agent-comms.md` — XMTP layer (deferred post-Edge, fine here)
- `instaclaw/docs/prd/cross-session-memory.md` — the MEMORY.md infrastructure that this addendum reads from

---

## 0. TL;DR

The foundation PRD got the architecture skeleton right: **engine retrieves cheaply, agent reranks expensively with full memory.** This addendum specifies the four pieces that turn that skeleton into a system that *feels like magic* instead of like a directory.

**The four additions:**

1. **Inferred intent, no form.** The agent reads MEMORY.md (already populated by our cross-session-memory infrastructure shipped this week) and extracts a structured profile — `offering_summary`, `seeking_summary`, plus structured fields. Users with conversational history bypass the form entirely. Cold-start users get one open-ended Telegram question, not a multi-step modal.

2. **Dual-embedding offering/seeking model.** Every user has two vectors, not one. Match score is `geometric_mean(cos(A.seeking, B.offering), cos(B.seeking, A.offering))`. This is what makes "investor finds founder" work correctly instead of "investor finds another investor." The complementarity moat is structural, not a one-line nudge in a rerank prompt.

3. **Reactive cascades, not polling.** Postgres `LISTEN/NOTIFY` trigger on `matchpool_profiles` change → worker recomputes only the affected users' top-K → push Telegram notifications for material changes. New match arrivals feel real-time.

4. **Living feed.** The existing `periodic_summary_hook` cron (deployed today) updates MEMORY.md as the user's context evolves through the conference. Profile changes propagate via the reactive cascade. Day 1 matches naturally differ from Day 3 matches because the user's stated context evolves.

**Deferred to Wednesday (per Cooper's call):** serendipity slot / wildcard exploration. Ship exploitation cleanly first.

**The five non-obvious decisions:**

1. **Two embeddings per user, not one.** Single-embedding cosine similarity matches *similar* people, who don't need each other. Dual-embedding mutual scoring matches *complementary* people, who do. This is non-negotiable for the moat thesis.

2. **Geometric mean, not arithmetic mean, for mutual scoring.** Arithmetic mean accepts asymmetric matches (0.9 × 0.1 = 0.5 average). Geometric mean rejects them (sqrt(0.09) = 0.3). The best match is balanced, not lopsided.

3. **Reactive cascade triggered on the embedding columns specifically.** Not every column change fires the cascade. Only `offering_embedding`, `seeking_embedding`, or `consent_tier` changes trigger. Avoids notification spam from irrelevant DB writes.

4. **Privacy is opt-in via Telegram question, not opt-out.** Default `consent_tier='hidden'`. The agent asks once: *"Want to be visible to other Consensus attendees through intent matching?"* Anyone can be a matcher; only opt-in users can be matched.

5. **Notification anti-spam by diff, not by rate.** The cascade may fire 50 times for one user as a wave of new signups arrives. Notifications gate on *material change* (new entrant in top-3, OR existing top-3 dropped), not on a global rate limit. Latency stays sharp; spam stays low.

**Cost at Consensus scale (~500 users, 3 days):**
- Embeddings: ~$2 total (1000 calls × $0.0002)
- Haiku intent extraction: ~$0.50 total
- Cascade compute: ~$0.10/day for HNSW queries
- Telegram delivery: free (existing channel)
- **Total: <$5 for the whole conference. Architecture costs nothing.**

---

## 1. Gap Analysis vs. Foundation PRD

| Requirement | Foundation PRD coverage | This addendum |
|---|---|---|
| Wire format (`route_intent` / `feedback`) | ✅ Complete (§3) | Reuses unchanged. |
| Schema skeleton (`matchpool_profiles`) | ✅ Complete (§6) | Extends with dual-embedding columns. |
| Asymmetric mutual-threshold filter | ✅ Complete (§4) | Replaced by structural dual-embedding model — the asymmetry is now in the embeddings themselves, not just a filter. |
| Hard filters (cohort, recency, blocklist) | ✅ Complete (§4) | Reuses. |
| Soft-prior boosts (cohort overlap, prior meetings) | ✅ Complete (§4) | Reuses. |
| Agent-side LLM rerank with full memory | ✅ Complete (§4) | Reuses — this is the moat we don't reinvent. |
| Privacy / consent tiers | ✅ Complete (§9) | Default tier set to `hidden`; opt-in flow added. |
| Eval methodology | ✅ Complete (§10) | Add `match_kind` tagging for `core` vs (future) `wildcard`. |
| Embedding model + vector store | ✅ voyage-3-large 1024-int8 + Supabase pgvector | Same. Two embeddings per row instead of one. |
| **Intent capture (how does intent enter the system)** | Vague — "agent generates summary nightly" | **Specified here (§2.1).** |
| **Complementarity vs similarity** | One-line nudge in rerank prompt | **Specified here (§2.2) — dual-embedding architecture.** |
| **Update propagation (real-time)** | Polling cron 15min | **Replaced here (§2.3) with reactive `LISTEN/NOTIFY` cascade.** |
| **Temporal evolution** | Implicit | **Specified here (§2.4) — hooks into periodic_summary.** |
| Serendipity / exploration | Not covered | **Deferred to Wednesday.** Tracking infrastructure (`match_kind` column) ships v1. |

**The addendum is small in scope but architecturally load-bearing.** Without these four pieces, Consensus matching is a directory. With them, it's a system that learns and adapts.

---

## 2. Architectural Additions

### 2.1 Inferred intent — no form

#### The problem with onboarding forms

Every existing matching system makes the user fill out a profile. Hinge has prompts. Brella has tags. Index Network has a JSON signal. The user has to know what they want before they can be matched. **Consensus attendees don't know what they want.** They know what they're working on. The matchmaking should figure out the rest.

We have weeks of MEMORY.md history on every existing VM. We have the agent's continuous attention on every new signup. We don't need a form.

#### Two-tier capture

**Tier 1 — Existing users (Cooper, edge_city VMs, anyone with conversational history):**

The agent already knows them. The cross-session-memory infrastructure deployed today (`periodic_summary_hook`, `MEMORY.md`, USER_FACTS marker section) holds:
- Recent project context
- Stated goals and priorities
- People they've asked about
- Topics they've discussed deeply

A single Haiku call on the user's own VM extracts a structured profile from this:

```
SYSTEM: You are extracting structured intent for a conference matchmaking
system. Given the user's MEMORY.md and recent agent conversation, output
strict JSON:

{
  "offering_summary": "1-3 sentences describing what they bring to a
    30-min meeting (capital, advice, deal flow, technical knowledge,
    intros, partnerships, time, etc.). Be specific. Use their actual
    project names.",
  "seeking_summary": "1-3 sentences describing what they're hoping to
    find at this conference (capital, advice, customers, partners,
    knowledge, friends, hires, deals, etc.). Be specific.",
  "interests": ["string", ...],     // 3-7 short tags
  "looking_for": ["string", ...],   // 1-5 short tags ("biotech-founder",
                                    //  "ai-investor", "rust-engineer")
  "format_preferences": ["1on1" | "small_group" | "session"],
  "confidence": 0-1                 // self-assessment of inference quality
}

If you can't extract something specific, leave it empty rather than
fabricate. Quality over coverage.
```

The Haiku call runs on the user's VM (paid for by their existing Anthropic credits). Output uploads to the platform via the existing `X-Gateway-Token` bridge.

**Tier 2 — New users (just-signed-up at /consensus, no history):**

The agent's first Telegram message:

> *"Hey — quick one before I start finding people for you. What are you working on right now, and what are you hoping to find at Consensus this week?"*

One question. Free-form. The agent runs the same Haiku extractor against the user's reply. If the reply is too vague (`confidence < 0.4`), the agent follows up with one more clarifying question and extracts again. Two questions max — never three.

#### Profile lifecycle

```
1. Agent installs consensus skill → reads MEMORY.md → extracts profile (Tier 1)
                                  → asks Telegram question → extracts (Tier 2)
2. Agent → POST /api/match/v1/profile with structured intent
3. Platform embeds offering + seeking via voyage-3-large
4. Platform writes matchpool_profiles row → trigger fires → cascade kicks off
5. Hourly: periodic_summary_hook updates MEMORY.md
6. Daily-ish: agent re-extracts intent if MEMORY.md changed materially
   (heuristic: profile_summary token-edit-distance > threshold)
7. Re-upload → re-embed → cascade → notification (if material match-set diff)
```

The user never sees a form. Their conversation IS the profile.

---

### 2.2 Dual-embedding offering/seeking model

#### Why single-embedding cosine similarity is structurally wrong

A single user-summary embedding compresses everything into one direction in vector space. Two users with similar summaries have similar embeddings. Cosine similarity is high. The system says "match."

But two DePIN founders both saying "I'm building decentralized compute infrastructure" have *redundant* offerings. They don't need each other. The match is wasted attention.

Meanwhile, a DePIN investor saying *"I'm looking for DePIN deals"* has a different embedding direction — but is the *complementary* match the founder needs.

**Single embedding = similarity. Complementarity needs two vectors.**

#### The model

Each user has two embeddings:

- **`offering_embedding`** — what they bring to a meeting. Embedding of `offering_summary`.
- **`seeking_embedding`** — what they're hoping to find. Embedding of `seeking_summary`.

#### Match scoring

For a candidate pair (A, B):

```
forward_score = cos(A.seeking_embedding, B.offering_embedding)
                  // how well B's offering matches A's needs

reverse_score = cos(B.seeking_embedding, A.offering_embedding)
                  // how well A's offering matches B's needs

mutual_score = sqrt(forward_score * reverse_score)
                  // geometric mean — balanced matches win,
                  // lopsided matches penalized
```

#### Why geometric mean, not arithmetic mean

| Pair | forward | reverse | arithmetic | geometric |
|---|---|---|---|---|
| Truly mutual | 0.7 | 0.7 | 0.70 | 0.70 |
| Slightly imbalanced | 0.8 | 0.6 | 0.70 | 0.69 |
| Heavily imbalanced (stalker) | 0.9 | 0.1 | 0.50 | 0.30 |
| Cold mutual | 0.5 | 0.5 | 0.50 | 0.50 |
| One-sided | 1.0 | 0.0 | 0.50 | 0.00 |

Arithmetic mean ranks "stalker pattern" (high forward, low reverse) equal to "cold mutual." Geometric mean correctly buries it. **Best mutual matches are balanced; geometric mean enforces that structurally.**

#### The pipeline replacement

Foundation PRD §4 has Step 5 ("Asymmetric mutual-threshold filter") which uses single-embedding cosine. **Replace with dual-embedding mutual score:**

```python
# ─── STEP 5: Dual-embedding mutual scoring (replaces foundation PRD §4 Step 5) ───
candidates_with_score = []
for c in candidates:
    fwd = cosine_sim(me.seeking_embedding, c.offering_embedding)
    rev = cosine_sim(c.seeking_embedding, me.offering_embedding)
    mutual = (fwd * rev) ** 0.5
    if mutual >= MUTUAL_THRESHOLD:  # ~0.45 with dual; tune
        c.mutual_score = mutual
        c.forward_score = fwd
        c.reverse_score = rev
        candidates_with_score.append(c)
candidates_with_score.sort(key=lambda c: c.mutual_score, reverse=True)
survivors = candidates_with_score[:50]
```

The hard filters, soft-prior boosts (foundation §4 Step 6), reason seed (Step 7), and agent-side rerank (Steps A-C) are unchanged. The agent's full-memory rerank can use both embeddings as input.

#### Cost / perf

- Each user: 2 embeddings instead of 1 → 2× embedding cost. Voyage-3-large @ $0.20/M tokens × ~200 tokens/summary = $0.0004/user/refresh. At Consensus scale: $0.20 total.
- Storage: 2× 1024-dim int8 vectors per row = 2KB/user. Negligible.
- Query latency: 2 cosine sims per pair instead of 1. Postgres handles it in the same query (one HNSW scan per direction, then mutual computed in Python). ~80ms p95 retrieval, vs ~50ms in foundation PRD. Acceptable.

#### What the agent-side rerank gets

The agent's rerank prompt now sees both summaries per candidate:

```
CANDIDATE 1: Alex Chen, Aave (CEO)
  offering: "Building DeFi-native credit primitives. Can offer institutional
    intros to Galaxy and Coinbase, and 5 years of liquidation-engine design
    experience."
  seeking: "Looking for protocol researchers thinking about agent-mediated
    market-making, especially folks who've worked on intent-based DEXes."

CANDIDATE 2: ...

YOU (the user): Cooper Wrenn, InstaClaw (Founder)
  offering: "Personal AI agent platform — own VMs, own wallets, agentic
    commerce. Active partnerships with Bankr, Edge City."
  seeking: "Investors who back agentic infrastructure at the seed stage,
    plus AI-research collaborators on long-context agent memory."

Rank by predicted mutual value of a 30-minute conversation.
```

The rerank is dramatically more decision-useful with structured offering/seeking than with conflated summaries.

---

### 2.3 Reactive cascades — not polling

#### Why polling is wrong for Consensus

Foundation PRD has a 15-min cron that drains a `dirty` flag. That's polling. For Edge's 4-week timeline this is fine — most context drift is slow.

For Consensus's 3-day timeline:
- Most users sign up Day 0 evening (Mon)
- A wave of arrivals on Day 1 morning (Tue 8-10am)
- Late arrivals through Day 1 afternoon
- Latency from "user signs up" to "potential matches notified" matters
- 15 min lag means a Day 1 morning arrival doesn't surface to existing users until lunchtime
- That's a meaningful UX miss in a 72-hour event

**Reactive is structurally right** when the event window is short and the value of immediacy is high.

#### Postgres LISTEN/NOTIFY architecture

```sql
CREATE OR REPLACE FUNCTION matchpool_profiles_changed() RETURNS trigger AS $$
DECLARE
  embeddings_changed BOOLEAN;
  consent_changed BOOLEAN;
BEGIN
  -- Only fire on changes that materially affect the match graph
  embeddings_changed :=
    (TG_OP = 'INSERT')
    OR (OLD.offering_embedding IS DISTINCT FROM NEW.offering_embedding)
    OR (OLD.seeking_embedding IS DISTINCT FROM NEW.seeking_embedding);
  consent_changed :=
    (TG_OP = 'INSERT')
    OR (OLD.consent_tier IS DISTINCT FROM NEW.consent_tier);

  IF embeddings_changed OR consent_changed THEN
    PERFORM pg_notify('matchpool_changed', json_build_object(
      'user_id',          NEW.user_id,
      'change_kind',      TG_OP,
      'embeddings_changed', embeddings_changed,
      'consent_changed',    consent_changed
    )::text);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER matchpool_profiles_change_notify
AFTER INSERT OR UPDATE
ON matchpool_profiles
FOR EACH ROW EXECUTE FUNCTION matchpool_profiles_changed();
```

#### Worker design

A long-running Node process (or persistent serverless worker) listens on the `matchpool_changed` channel:

```typescript
// One worker process. Idempotent. Restarts cleanly.
import { Pool } from "pg";
const sub = new Pool({ connectionString: process.env.SUPABASE_POSTGRES_URL });
const conn = await sub.connect();
await conn.query("LISTEN matchpool_changed");

conn.on("notification", async (msg) => {
  const { user_id, embeddings_changed, consent_changed } = JSON.parse(msg.payload!);
  await processMatchpoolChange(user_id, { embeddings_changed, consent_changed });
});

async function processMatchpoolChange(
  userId: string,
  flags: { embeddings_changed: boolean; consent_changed: boolean }
) {
  // 1. Compute X's new top-K via dual-embedding mutual score
  const xMatches = await computeTopKMutual(userId, /* k = */ 50);

  // 2. For each candidate c in X's top-K, check if X is now in c's top-K.
  //    This is the "cascade" — only re-evaluate users who plausibly care.
  const affected = await Promise.all(
    xMatches.map(async (c) => {
      const cMatches = await computeTopKMutual(c.user_id, 50);
      const xRankInC = cMatches.findIndex(m => m.user_id === userId);
      return { c, xRankInC, cMatches };
    })
  );

  // 3. For each c where X newly entered c's top-K (or X jumped meaningfully),
  //    enqueue a notification IF the diff is material.
  for (const { c, xRankInC, cMatches } of affected) {
    if (xRankInC === -1) continue;
    const oldTop3 = await getCachedTop3(c.user_id);
    const newTop3 = cMatches.slice(0, 3).map(m => m.user_id);
    if (materiallyChanged(oldTop3, newTop3)) {
      await queueNotification({
        user_id: c.user_id,
        new_match_user_id: userId,
        rank: xRankInC,
        reason: "new_arrival",
      });
      await setCachedTop3(c.user_id, newTop3);
    }
  }

  // 4. X gets their own update
  const xOldTop3 = await getCachedTop3(userId);
  const xNewTop3 = xMatches.slice(0, 3).map(m => m.user_id);
  if (materiallyChanged(xOldTop3, xNewTop3)) {
    await queueNotification({
      user_id: userId,
      reason: "your_matches_updated",
      top3: xNewTop3,
    });
    await setCachedTop3(userId, xNewTop3);
  }
}
```

#### Latency budget

- Trigger → notify: <10ms
- Worker pickup → top-K computed: ~50ms (HNSW)
- Reverse top-K for 50 candidates (parallel): ~150ms
- Notification queue write: <10ms
- Telegram delivery (separate worker): ~1-3s

**End-to-end: ~3-5 seconds from "user X updates intent" to "user Y's phone vibrates."** Real-time enough to feel like magic.

#### Material change detection

A diff threshold prevents notification spam:

```typescript
function materiallyChanged(oldTop3: string[], newTop3: string[]): boolean {
  const oldSet = new Set(oldTop3);
  const newSet = new Set(newTop3);
  const added = newTop3.filter(id => !oldSet.has(id));
  const removed = oldTop3.filter(id => !newSet.has(id));
  // Material = at least 1 new entrant in top-3 OR top-1 changed
  return added.length > 0 || (oldTop3[0] !== newTop3[0]);
}
```

This means a wave of 50 new signups during the morning rush results in *at most a handful* of notifications per affected user — not 50.

#### Why not Supabase Realtime?

Supabase Realtime is great for client-side UIs. Our consumers are server-side workers and Telegram delivery. `LISTEN/NOTIFY` is closer to the metal, simpler, and works through the same Postgres connection we already have. No new infrastructure.

#### Worker hosting

Single Node process on a small Railway / Fly / Render box with a restart-on-crash supervisor. Or a Vercel cron that fires every 30s and drains a queue if `LISTEN` proves flaky on serverless. The architecture supports either.

---

### 2.4 Living feed — temporal evolution

#### Mechanism (mostly free, given existing infrastructure)

The cross-session memory infrastructure deployed today gives us:
- `periodic_summary_hook` runs every 2h on each VM
- Reads recent conversation, updates MEMORY.md / `profile_summary`
- Refreshes USER_FACTS marker section

**The hook:** at the end of each periodic-summary tick, if the profile_summary changed materially, the agent re-runs the intent extractor (§2.1) and POSTs the updated structured intent to the platform. Platform re-embeds → trigger fires → cascade.

#### What this looks like to the user

**Day 0 evening (Mon, signup):** User installs the consensus skill. Agent extracts intent from initial signup or asks one question. Initial profile saved. Nothing dramatic visible yet.

**Day 1 morning (Tue 8am):** Wave of new signups arrives. User wakes up to a Telegram message:

> "Morning. 4 new people joined the consensus pool overnight who match your intent. Top arrival: David Wachsman (Founder, Wachsman) — your offering on AI-infra DevTools and his focus on infra/data/oracle session is a strong fit. Want me to draft an intro?"

**Day 1 afternoon:** User attends "Agentic Commerce" panel. Agent picks this up via Telegram conversation (user mentions it) → MEMORY.md updates → profile re-extracts → seeking_summary now mentions agentic commerce more prominently → cascade fires → 2 new matches surface.

**Day 2 morning:** Yesterday's matches re-rank based on yesterday's evolution. Maybe Wachsman is gone (already met). Maybe May Zabaneh from PayPal (agentic commerce panel) is now top.

**Day 3:** End-of-conference digest. Agent summarizes connections made, suggests follow-ups for people not yet met.

#### Notification cadence (anti-spam)

The reactive cascade can fire often. Notification policy:

- **Real-time push** allowed during waking hours (user's local timezone, 7am-11pm)
- **Quiet hours** (11pm-7am): material changes accumulate → single morning briefing message
- **Aggregation window:** within waking hours, cluster notifications within 5-min windows (avoid back-to-back pings)
- **Hard ceiling:** max 5 notifications/user/day, regardless of cascade activity. Beyond that, queue for the next morning briefing.

The agent on the user's VM owns the notification cadence (pulls from notification queue every minute via cron, decides whether to send based on policy + timezone). Platform queues; agent decides timing.

#### Cohort / event awareness

A future enhancement (not required for v1): the cascade can be parameterized by event phase.
- Day 0 (Mon): emphasize *who's arriving*
- Day 1-2: emphasize *who's still unmatched in your top-K* (avoid telling someone about a person they could've met yesterday)
- Day 3: emphasize *who you should follow up with after the conference*

Ship the cascade infrastructure now; phase-aware logic in v1.5.

---

## 3. Consensus-Specific Operating Context

| Dimension | Edge City (foundation PRD) | Consensus (this addendum) |
|---|---|---|
| Event length | 4 weeks | 3 days |
| Pool size | ~500 users | ~100-500 (highly dependent on launch traction) |
| Cold-start window | First weekend (~48h to seed pool) | First 12 hours (Mon evening → Tue morning) |
| Match cadence | Daily morning briefing | Real-time + morning briefing |
| Refresh frequency | Daily | Every 2h (matches the periodic_summary cadence) |
| Privacy posture | Default opt-in (community context) | Default opt-out, opt-in via Telegram (broader audience, lower trust) |
| Failure mode tolerance | High (4 weeks to recover from a bad week) | **Low — every hour matters** |
| Surfacing channel | Telegram + future XMTP | Telegram only (XMTP deferred per foundation PRD) |

The 3-day timeline is the dominant constraint. Every architectural choice — reactive cascades, real-time notifications, aggressive cold-start handling — reinforces "make every hour count."

---

## 4. Schema Additions (extends foundation PRD §6)

```sql
-- Extends matchpool_profiles from foundation PRD §6.

ALTER TABLE matchpool_profiles
  -- Dual embedding model (replaces single embedding from foundation PRD)
  ADD COLUMN offering_summary TEXT,
  ADD COLUMN seeking_summary TEXT,
  ADD COLUMN offering_embedding vector(1024),
  ADD COLUMN seeking_embedding vector(1024),
  ADD COLUMN profile_version INT NOT NULL DEFAULT 1,
  -- Living feed bookkeeping
  ADD COLUMN intent_extracted_at TIMESTAMPTZ,
  ADD COLUMN intent_extraction_confidence NUMERIC(3,2),
  -- Future-proofing: serendipity / wildcard slot tagging (Wed feature)
  ADD COLUMN match_kind_default TEXT NOT NULL DEFAULT 'core';

-- Keep the foundation PRD's `embedding` column as the legacy /
-- general embedding for hybrid retrieval. The dual-embedding mutual
-- score is the new ranker; the legacy embedding stays for tsvector
-- candidate retrieval.

-- HNSW indexes on both new embeddings.
CREATE INDEX matchpool_offering_hnsw
  ON matchpool_profiles USING hnsw (offering_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE offering_embedding IS NOT NULL;

CREATE INDEX matchpool_seeking_hnsw
  ON matchpool_profiles USING hnsw (seeking_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE seeking_embedding IS NOT NULL;

-- Cached top-3 per user, for diff-based notifications.
CREATE TABLE matchpool_cached_top3 (
  user_id            UUID PRIMARY KEY REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  top3_user_ids      UUID[] NOT NULL,
  top3_scores        NUMERIC[] NOT NULL,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notification queue (drained by per-VM agent cron).
CREATE TABLE matchpool_notifications (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  reason             TEXT NOT NULL,         -- 'new_arrival' | 'your_matches_updated' | 'morning_brief'
  payload            JSONB NOT NULL,
  delivered_at       TIMESTAMPTZ,           -- set when agent picks up + sends
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX matchpool_notifications_undelivered
  ON matchpool_notifications (user_id, created_at)
  WHERE delivered_at IS NULL;
```

**Migration strategy:** non-destructive ALTER TABLE. Existing rows stay. New columns nullable initially. Backfill is automatic as users re-extract intent (Tier 1 + Tier 2).

---

## 5. Pipeline (full request flow with all four additions)

```
USER SIGNS UP via /consensus or /signup
  → configureOpenClaw provisions VM + installs consensus-2026 skill
  → agent runs intent-extraction script on VM:
      Tier 1 (existing user): reads MEMORY.md → Haiku extract → structured intent
      Tier 2 (new user): Telegram one-question → Haiku extract → structured intent
  → agent POSTs to /api/match/v1/profile (X-Gateway-Token auth)
  → platform: voyage-embed offering + seeking → upsert matchpool_profiles
                                                → trigger fires
                                                → pg_notify('matchpool_changed', ...)
                                                              ↓
WORKER PROCESS (LISTEN matchpool_changed):
  → recompute top-K mutual for X (dual-embedding HNSW + geometric mean)
  → for each c in top-K of X: reverse top-K of c, check if X enters
      → if X newly enters c's top-3 (material change): queue notification
  → if X's own top-3 changed materially: queue X's own update notification
                                                              ↓
PER-VM AGENT (cron every minute, deployed in v1):
  → poll /api/match/v1/notifications/pending
  → for each undelivered: send Telegram message in agent's voice
      ("4 new matches surfaced overnight. Top arrival: David Wachsman...")
  → mark delivered

USER ASKS AGENT "find me my people" (existing route_intent flow from foundation PRD):
  → agent calls route_intent (foundation PRD §3 wire format)
  → engine returns top-50 candidates (cached, fast)
  → agent does FULL-MEMORY rerank using SOUL.md + MEMORY.md (foundation PRD §4 step A)
  → agent generates per-match reason via Haiku (foundation PRD §4 step C)
  → agent surfaces top-K via Telegram

USER ATTENDS A SESSION / has a conversation:
  → agent updates MEMORY.md (existing periodic_summary_hook)
  → next periodic-summary tick: re-extract intent if material drift
  → re-POST profile → trigger → cascade
  → potential new matches surface in real-time
```

The agent-side rerank, MMR diversity, and reason generation are unchanged from the foundation PRD §4. The cascade adds the "matches arrive without being asked" surface.

---

## 6. Build Plan — incremental ship through Mon evening + Tue morning

Ten components. Each ships independently. Tuesday morning announcement gates on components 1-7. Components 8-10 finish Tuesday afternoon.

| # | Component | Time | Risk | Ship | Tue announcement gates on |
|---|---|---|---|---|---|
| 1 | Migration: dual-embedding columns + indexes + triggers + queue tables | 0.75h | low | Mon 11pm | YES |
| 2 | Voyage embedding helper + dual-embed function | 0.75h | low | Mon 11:45pm | YES |
| 3 | Intent extraction lib (Haiku call, JSON validation) | 1.0h | medium | Tue 12:45am | YES |
| 4 | VM-side intent script (reads MEMORY.md, calls Haiku, POSTs platform) | 1.0h | low | Tue 1:45am | YES |
| 5 | Platform endpoint POST `/api/match/v1/profile` | 0.75h | low | Tue 2:30am | YES |
| 6 | Match scoring lib (dual-embedding mutual top-K) | 1.5h | medium | Tue 4:00am | YES |
| 7 | `/consensus/matches` real-data wiring (replace static demo with computed matches) | 1.0h | low | Tue 5:00am | YES |
| 8 | Reactive cascade worker (LISTEN/NOTIFY, queue fanout, top-3 cache) | 1.5h | medium | Tue 11am | NO (nice-to-have for announcement) |
| 9 | Telegram notification delivery (per-VM cron, anti-spam, opt-in gate) | 1.0h | low | Tue 1pm | NO |
| 10 | Privacy opt-in flow (Telegram one-question + consent_tier setting) | 0.5h | low | Tue 9am | YES (must ship before announcement) |

**Critical-path total:** ~7.25h. Achievable Mon evening through ~5am Tue.

**Tue 8am ET announcement criteria:**
- ✅ Components 1-7 + 10 shipped
- ✅ Cooper's matches visible at /consensus/matches with real data
- ✅ At least 5 manually-tested users in the pool with offering/seeking + computed matches
- ✅ /consensus/matches loads cleanly under 1s

**Tue afternoon delivery criteria:**
- ✅ Reactive cascade producing notifications
- ✅ Telegram messages reaching users
- ✅ Anti-spam working (no user gets >5 notifications/day)

**Wed morning expansion:**
- Serendipity slot (deferred per Cooper)
- Multi-objective scoring instrumentation (foundation PRD §5.2)
- Agent-side rerank with full memory (foundation PRD §4 Step A) — currently the page does engine-only ranking; adding agent rerank here is the quality lift for Wed

#### Per-component rollback

Each component ships behind a feature flag (env var `INTENT_MATCHING_PHASE = 0|1|2|3`). If anything breaks:

- Phase 0: matching off, /consensus/matches shows the static preview from earlier today (already in the codebase)
- Phase 1: intent capture only, no matching display
- Phase 2: matching display, no notifications
- Phase 3: full system

Set `INTENT_MATCHING_PHASE` via Vercel env. No code revert needed.

---

## 7. Telegram Delivery — the user-visible surface

### Notification voice

The agent's voice. Always second-person. Always specific. Never marketing-flavored.

**Good:**
> "Morning. David Wachsman just joined the pool — Founder/CEO at Wachsman, working on infra+data+oracle session Wednesday. Your offering (AI-agent platform) and his focus on institutional crypto infra are complementary. He has a Wednesday 11:30 panel slot. Want me to suggest a coffee around 12:30?"

**Bad:**
> "🎯 NEW MATCH! 94% compatibility! David Wachsman wants to connect!"

### Anti-spam policy (recap)

- Max 5 notifications/user/day
- Quiet hours: 11pm-7am local (notifications queue → morning brief)
- Cluster within 5-min window during waking hours
- Material-change gating (top-3 must shift)

### Opt-in flow (component 10 — must ship pre-announcement)

On consensus skill install OR first user message after install:

```
AGENT (Telegram):
"Quick housekeeping. I can help you find people at Consensus this week —
investors, builders, operators working on stuff that overlaps with what
you're building. To match you with them and let them find you, I need
your okay to show your name + a 1-paragraph summary of what you're
working on (drawn from our chats). You can revoke or edit this anytime
just by telling me.

Say YES to opt in, or NO MATCHING if you'd rather stay private."
```

Response handling:
- "yes" / "go" / "sure" / "ok" → set `consent_tier = 'interests_plus_name'`
- "no" / "no matching" / "skip" / "private" → set `consent_tier = 'hidden'`
- Anything else: agent asks once more for clarity, defaults to `hidden` if unclear

Default until user responds: `hidden`. Opt-in must be affirmative.

### Privacy controls (in-conversation)

The agent recognizes these phrases and updates `consent_tier` accordingly:

| Phrase pattern | Action |
|---|---|
| "show me to investors only" / "i'm raising" | filter visibility by counterpart's `looking_for` containing investor signals |
| "stop matching me" / "go private" | set `consent_tier = 'hidden'`, stop showing in others' results |
| "show me again" / "matching back on" | reset to `interests_plus_name` |
| "what do people see about me" | display the `offering_summary` + `interests` in chat |
| "edit what people see" | offer to regenerate the summary with new emphasis |

These are agent-side conversational primitives, no UI. Existing OpenClaw skill pattern.

---

## 8. Deferred — Wednesday and beyond

### Wed: Serendipity slot

Per Cooper's call. Architecture support (the `match_kind` column) ships v1 so we can A/B once enabled.

Wed implementation:
- After top-K computed, sample 1 candidate from rank 50-200 with diversity vs top-K
- LLM-generate a "compelling why this seemingly random match" rationale
- If rationale-quality score > threshold, surface as the +1 wildcard slot
- Tag `match_kind = 'wildcard'`
- Track outcomes per `match_kind` for future learning

### Beyond v1 (foundation PRD § 5.2 already covers most)

- Multi-objective scoring (P(surfaced), P(accepted), P(meeting), P(valuable))
- LinUCB bandit on feedback signal
- Cohere Rerank 3.5 engine-side cross-encoder (only when quality complaints land)
- HyDE for cold start (foundation PRD §5.2; only if cold-start quality is bad)
- XMTP / agent-to-agent comms (foundation PRD §14; deferred to post-Edge)

---

## 9. Open Questions — handed off, with deadlines

| # | Question | Owner | Decide by |
|---|---|---|---|
| 1 | Is `voyage-3-large` available on the Vercel deployment, or do we route through the agent's VM (which has Anthropic credits but not Voyage)? Implication: if Voyage isn't reachable, fall back to OpenAI text-embedding-3-large. | Cooper | Mon 9pm (before component 2) |
| 2 | Should the reactive worker live on Vercel (cron-style polling-of-LISTEN — fragile) or on a small Railway/Fly box (cleaner — long-running)? | Cooper | Mon 11pm (before component 8) |
| 3 | What's the target time of day for the Tue announcement? 8am ET or 9am ET? Affects the deadline for component 6 finishing. | Cooper | Mon 9pm |
| 4 | Do we want the agent to ASK before pushing each notification ("Hey, a new match arrived. Want me to share?"), or just push? Pushing is the magic version; asking is more polite. | Cooper | Tue morning before component 9 |

---

## 10. The Recommendation

Ship this. The foundation PRD did the hard architectural work yesterday. This addendum's contribution is:

1. **Dual embeddings as the structural complementarity moat** — the one decision that separates us from a generic conference matching app
2. **Reactive cascades as the latency moat** — turns a directory into a system that arrives at the user
3. **Inferred intent as the friction moat** — the first matching system where the user never fills out a form
4. **Living feed as the temporal moat** — matches that evolve with the user's understanding, not stuck on whatever they typed Monday night

Build plan is conservative. 7.25h critical path with 3-4h slack before the Tue morning announcement. Each component ships behind a feature flag with clean rollback.

The Tuesday announcement, when this lands:

> *"matching is live. tell your agent what you're working on once. it cross-references everyone in the consensus pool — speakers, attendees, side-event hosts — and surfaces the people most relevant to what you're trying to accomplish, not what your bio says. matches update in real-time as new attendees arrive and your context evolves through the conference. no forms. just conversation."*

That's a category-different system. Worth shipping right.

---

*End of addendum. Total: ~480 lines. Reviewable in 15 min. Build starts on Cooper's go.*
