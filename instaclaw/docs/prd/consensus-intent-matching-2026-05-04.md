# InstaClaw Intent Matching for Consensus 2026 — Technical Design Addendum

**Status:** Draft technical design (no code until reviewed)
**Author:** Cooper / Claude
**Date:** 2026-05-04 (revision 2 — adds Layer 3 deliberation + XMTP intro layer)
**Target ship:** Tuesday 2026-05-05 morning ET (Phase 1) → Wednesday 2026-05-06 (Phase 2)

**Foundation document (do not duplicate):**
`instaclaw/docs/prd/matching-engine-design-2026-05-03.md` — the 1182-line core
matching engine design. This addendum extends it with the architectural decisions
specific to Consensus and reframes the build plan around a 3-day event timeline.

**Companion / referenced:**
- `instaclaw/docs/prd/draft-matching-design-section-agent-comms.md` — XMTP layer architecture (was deferred to post-Edge; promoted here to a Phase 2 component)
- `instaclaw/docs/prd/cross-session-memory.md` — the MEMORY.md infrastructure that Layer 3 deliberation reads from

---

## 0. TL;DR

The foundation PRD got the architecture skeleton right: **engine retrieves cheaply, agent reranks expensively with full memory.** This addendum takes that to its logical conclusion — and then adds the transport layer that lets agents *actually communicate* once a match is made.

**Six architectural decisions:**

1. **Inferred intent, no form.** Agent reads MEMORY.md (already populated by today's cross-session-memory infrastructure) and extracts structured intent on the user's own VM. New users get one open-ended Telegram question, not a multi-step modal.

2. **Dual-embedding offering/seeking model.** Two vectors per user. Match score = `geometric_mean(cos(A.seeking, B.offering), cos(B.seeking, A.offering))`. This is what makes "investor finds founder" work correctly instead of "investor finds another investor."

3. **Reactive cascades, not polling.** Postgres `LISTEN/NOTIFY` trigger → worker recomputes only the affected users' top-K → push Telegram notifications for material changes.

4. **Living feed.** The existing `periodic_summary_hook` cron updates MEMORY.md as the user's context evolves through the conference. Profile changes propagate via the reactive cascade.

5. **Per-candidate agent deliberation with full memory** *(the central moat)*. Every match in the user's feed is judged by their own agent — full SOUL.md + MEMORY.md context — *per candidate*. This catches signals no embedding could express: *"user mentioned frustration with their current auditor in passing 3 days ago"*. Three-layer pipeline: dual-embedding retrieval (Postgres, ~80ms) → listwise rerank (1 LLM call, ~3s) → per-candidate deliberation (4 batched calls, ~5s parallel). Total: ~5 LLM calls/user/cycle, ~$0.035 in user-paid Anthropic credits.

6. **XMTP intro-negotiation layer (Phase 2, Wed 2026-05-06)**. Once a match is confirmed and the user wants to reach out, **the user's agent DMs the candidate's agent over XMTP** — wallet-to-wallet, end-to-end encrypted. The agents negotiate the meeting window, exchange context, and surface a finalized proposal to both humans. This is the literal architectural fulfillment of the "agents talk to each other before you do" line from the launch thread.

**Deferred to Wed+:** serendipity slot / wildcard exploration. Ship exploitation cleanly first.

**The five non-obvious decisions:**

1. **Two embeddings per user, not one.** Single-embedding cosine similarity matches *similar* people, who don't need each other. Dual-embedding mutual scoring matches *complementary* people, who do.

2. **Geometric mean for mutual scoring.** Arithmetic mean accepts asymmetric matches (0.9 × 0.1 = 0.5 average); geometric mean rejects them (sqrt(0.09) = 0.3). The best match is balanced.

3. **Listwise rerank + per-candidate deliberation, not 20 individual deliberations.** 5 LLM calls per cycle instead of 20, same architectural moat, ~70% cost reduction via prompt-caching the user's memory anchor.

4. **Privacy is opt-in via Telegram question, not opt-out.** Default `consent_tier='hidden'`. The agent asks once.

5. **XMTP is the intro-negotiation transport, not the matching transport.** Matching/scoring stays local to the agent (the moat). XMTP enters only after a match is confirmed and the agents need to coordinate a meeting.

**Cost at Consensus scale (~500 users, 3 days):**
- Embeddings: ~$2 total (1000 calls × $0.0002)
- Haiku intent extraction: ~$0.50 total
- Layer 3 deliberation: ~$50 total over 3 days (paid by user tier credits, not platform)
- Cascade compute: ~$0.10/day for HNSW queries
- Telegram delivery: free (existing channel)
- XMTP: free (decentralized, agent uses existing Bankr wallet)
- **Total platform cost: <$5 for the whole conference. The user's agent does the expensive work on their own credits, which is the architecture we want.**

---

## 1. Gap Analysis vs. Foundation PRD

| Requirement | Foundation PRD coverage | This addendum |
|---|---|---|
| Wire format (`route_intent` / `feedback`) | ✅ Complete (§3) | Reuses unchanged. |
| Schema skeleton (`matchpool_profiles`) | ✅ Complete (§6) | Extends with dual-embedding columns + deliberation cache. |
| Asymmetric mutual-threshold filter | ✅ Filter pattern only | **Replaced** by structural dual-embedding model — asymmetry now in the embeddings themselves. |
| Hard filters / soft-priors | ✅ Complete (§4) | Reuses. |
| Agent-side LLM rerank | ✅ Listwise rerank (§4 Step A) | **Extended** to a 3-layer pipeline: retrieve → listwise rerank → per-candidate deliberation. |
| Privacy / consent tiers | ✅ Complete (§9) | Default `hidden`; opt-in flow specified. |
| Eval methodology | ✅ Complete (§10) | Add `match_kind` + `deliberation_outcome` tagging for future serendipity A/B. |
| Embedding model + vector store | ✅ voyage-3-large 1024-int8 + Supabase pgvector | Same. Two embeddings per row instead of one. |
| **Intent capture** | Vague — "agent generates summary nightly" | **Specified (§2.1).** |
| **Complementarity vs similarity** | One-line nudge in rerank prompt | **Specified (§2.2) as structural dual-embedding architecture.** |
| **Update propagation (real-time)** | 15-min polling cron | **Replaced (§2.3) with reactive `LISTEN/NOTIFY` cascade.** |
| **Temporal evolution** | Implicit | **Specified (§2.4).** |
| **Per-candidate full-memory deliberation** | Listwise rerank only | **NEW (§2.5) — the central moat.** |
| **Agent-to-agent intro negotiation** | Foundation PRD §14 (deferred) | **Promoted (§2.6) to Phase 2, scheduled for Wed 2026-05-06.** |
| Serendipity / wildcard exploration | Not covered | Deferred to Wed+; tracking infrastructure ships v1. |

---

## 2. Architectural Additions

### 2.1 Inferred intent — no form

#### The problem with onboarding forms

Every existing matching system makes the user fill out a profile. Hinge has prompts. Brella has tags. Index Network has a JSON signal. The user has to know what they want before they can be matched. **Consensus attendees don't know what they want.** They know what they're working on. The matchmaking should figure out the rest.

We have weeks of MEMORY.md history on every existing VM. We have the agent's continuous attention on every new signup. We don't need a form.

#### Two-tier capture

**Tier 1 — Existing users (Cooper, edge_city VMs, anyone with conversational history):**

The agent already knows them. The cross-session-memory infrastructure deployed today (`periodic_summary_hook`, `MEMORY.md`, USER_FACTS marker section) holds: recent project context, stated goals, people they've asked about, topics they've discussed deeply.

A single Haiku call on the user's own VM extracts a structured profile:

```
SYSTEM: You are extracting structured intent for a conference matchmaking
system. Given the user's MEMORY.md and recent agent conversation, output
strict JSON:

{
  "offering_summary": "1-3 sentences. What they bring to a 30-min meeting:
    capital, advice, deal flow, technical knowledge, intros, partnerships,
    time. Be specific. Use their actual project names.",
  "seeking_summary": "1-3 sentences. What they're hoping to find at this
    conference. Be specific.",
  "interests": ["string", ...],
  "looking_for": ["string", ...],   // role tags ('biotech-founder', 'ai-investor')
  "format_preferences": ["1on1" | "small_group" | "session"],
  "confidence": 0-1                 // self-assessment of inference quality
}

If you can't extract something specific, leave it empty rather than
fabricate. Quality over coverage.
```

Output uploads to platform via existing `X-Gateway-Token` bridge.

**Tier 2 — New users (just-signed-up, no history):**

Agent's first Telegram message:

> *"Hey — quick one before I start finding people for you. What are you working on right now, and what are you hoping to find at Consensus this week?"*

One question. Free-form. Agent runs same extractor on the reply. If `confidence < 0.4`, agent follows up with one more clarifying question. Two questions max — never three.

#### Profile lifecycle

```
1. Agent installs consensus skill → reads MEMORY.md → extracts profile (Tier 1)
                                  → asks Telegram question → extracts (Tier 2)
2. Agent → POST /api/match/v1/profile (X-Gateway-Token auth)
3. Platform embeds offering + seeking → upsert matchpool_profiles
                                       → trigger fires (cascade kicks off)
4. Hourly: periodic_summary_hook updates MEMORY.md
5. Daily-ish: agent re-extracts intent if MEMORY.md changed materially
   (heuristic: profile_summary token-edit-distance > threshold)
6. Re-upload → re-embed → cascade → notification (if material match-set diff)
```

The user never sees a form. Their conversation IS the profile.

---

### 2.2 Dual-embedding offering/seeking model

#### Why single-embedding cosine similarity is structurally wrong

A single user-summary embedding compresses everything into one direction. Two users with similar summaries have similar embeddings. Cosine similarity is high. The system says "match."

But two DePIN founders both saying "I'm building decentralized compute infrastructure" have *redundant* offerings. They don't need each other. The match is wasted attention.

Meanwhile, a DePIN investor saying *"I'm looking for DePIN deals"* has a different embedding direction — but is the *complementary* match the founder needs.

**Single embedding = similarity. Complementarity needs two vectors.**

#### The model

Each user has two embeddings:

- **`offering_embedding`** — what they bring. Embedding of `offering_summary`.
- **`seeking_embedding`** — what they're hoping to find. Embedding of `seeking_summary`.

#### Match scoring

For a candidate pair (A, B):

```
forward_score = cos(A.seeking_embedding, B.offering_embedding)
reverse_score = cos(B.seeking_embedding, A.offering_embedding)
mutual_score = sqrt(forward_score * reverse_score)  // geometric mean
```

#### Why geometric mean

| Pair | forward | reverse | arithmetic | geometric |
|---|---|---|---|---|
| Truly mutual | 0.7 | 0.7 | 0.70 | 0.70 |
| Slightly imbalanced | 0.8 | 0.6 | 0.70 | 0.69 |
| Heavily imbalanced (stalker) | 0.9 | 0.1 | 0.50 | 0.30 |
| Cold mutual | 0.5 | 0.5 | 0.50 | 0.50 |
| One-sided | 1.0 | 0.0 | 0.50 | 0.00 |

Arithmetic mean ranks the stalker pattern equal to cold mutual. Geometric mean correctly buries it. **Best mutual matches are balanced; geometric mean enforces it structurally.**

#### Cost / perf

- 2× embedding cost per profile refresh: voyage-3-large @ $0.0004/user/refresh × 500 users = $0.20 total at Consensus scale.
- Storage: 2× 1024-dim int8 vectors = 2KB/user. Negligible.
- Query latency: ~80ms p95 retrieval (one HNSW scan per direction, mutual computed in code) vs. ~50ms in foundation PRD. Acceptable.

---

### 2.3 Reactive cascades — not polling

#### Why polling is wrong for Consensus

Foundation PRD has a 15-min cron drain. For Edge's 4-week timeline this is fine. For Consensus's 3-day window — most users sign up Mon evening; arrival wave Tue morning — 15 min lag means a Tue 8am arrival doesn't surface to existing users until lunchtime. **Reactive is structurally right when the event window is short.**

#### Postgres LISTEN/NOTIFY

```sql
CREATE OR REPLACE FUNCTION matchpool_profiles_changed() RETURNS trigger AS $$
DECLARE
  embeddings_changed BOOLEAN;
  consent_changed BOOLEAN;
BEGIN
  embeddings_changed :=
    (TG_OP = 'INSERT')
    OR (OLD.offering_embedding IS DISTINCT FROM NEW.offering_embedding)
    OR (OLD.seeking_embedding IS DISTINCT FROM NEW.seeking_embedding);
  consent_changed :=
    (TG_OP = 'INSERT')
    OR (OLD.consent_tier IS DISTINCT FROM NEW.consent_tier);

  IF embeddings_changed OR consent_changed THEN
    PERFORM pg_notify('matchpool_changed', json_build_object(
      'user_id', NEW.user_id,
      'change_kind', TG_OP,
      'embeddings_changed', embeddings_changed,
      'consent_changed', consent_changed
    )::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

Trigger fires only on changes that materially affect the match graph (embeddings or consent). Avoids notification spam from irrelevant DB writes.

#### Worker design

A long-running Node process listens on the channel, processes each notification:

```typescript
async function processMatchpoolChange(userId: string) {
  // 1. Compute X's new top-K via dual-embedding mutual score
  const xMatches = await computeTopKMutual(userId, 50);

  // 2. For each candidate c, check if X is now in c's top-K
  const affected = await Promise.all(xMatches.map(async (c) => {
    const cMatches = await computeTopKMutual(c.user_id, 50);
    const xRankInC = cMatches.findIndex(m => m.user_id === userId);
    return { c, xRankInC, cMatches };
  }));

  // 3. For each c where X newly entered top-3 (material change): queue notification
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

  // 4. X's own update if changed
  // ...
}
```

#### Latency budget

- Trigger → notify: <10ms
- Worker pickup → top-K computed: ~80ms (HNSW)
- Reverse top-K for 50 candidates (parallel): ~150ms
- Notification queue write: <10ms
- Telegram delivery (separate worker): ~1-3s

**End-to-end: ~3-5 seconds from intent capture to phone vibrate.**

#### Material-change gating

```typescript
function materiallyChanged(oldTop3: string[], newTop3: string[]): boolean {
  const oldSet = new Set(oldTop3);
  const added = newTop3.filter(id => !oldSet.has(id));
  // Material = at least 1 new entrant in top-3 OR top-1 changed
  return added.length > 0 || (oldTop3[0] !== newTop3[0]);
}
```

A wave of 50 morning signups results in *at most a handful* of notifications per affected user, not 50.

---

### 2.4 Living feed — temporal evolution

#### Mechanism (mostly free, given existing infrastructure)

Today's cross-session memory infrastructure provides:
- `periodic_summary_hook` runs every 2h on each VM
- Reads recent conversation, updates MEMORY.md / `profile_summary`
- Refreshes USER_FACTS marker section

**The hook:** at the end of each periodic-summary tick, if the profile_summary changed materially, the agent re-runs the intent extractor (§2.1) and POSTs the updated structured intent. Platform re-embeds → trigger fires → cascade.

#### What this looks like to the user

**Day 0 evening (Mon, signup):** User installs consensus skill. Initial profile saved. Nothing dramatic visible yet.

**Day 1 morning (Tue 8am):** Wave of new signups arrives. Telegram message:

> *"Morning. 4 new people joined the consensus pool overnight who match your intent. Top arrival: David Wachsman (Founder, Wachsman) — your offering on agentic infrastructure and his focus on infra/data/oracle session is a strong fit. Want me to draft an intro?"*

**Day 1 afternoon:** User attends "Agentic Commerce" panel, mentions it to agent → MEMORY.md updates → profile re-extracts → seeking_summary now mentions agentic commerce more prominently → cascade fires → 2 new matches surface.

**Day 2 morning:** Yesterday's matches re-rank based on yesterday's evolution.

**Day 3:** End-of-conference digest with follow-up suggestions.

#### Notification cadence (anti-spam)

- Real-time push allowed during waking hours (user's local timezone, 7am-11pm)
- Quiet hours (11pm-7am): material changes accumulate → single morning briefing
- Aggregation window: cluster notifications within 5-min windows during waking hours
- Hard ceiling: max 5 notifications/user/day

The agent on the user's VM owns notification cadence (cron picks up queue every minute, decides timing based on user timezone). Platform queues; agent decides when to send.

---

### 2.5 Per-candidate agent deliberation — *the central moat*

This is the architectural commitment that separates InstaClaw from every other matching system. **The user's own agent — with weeks of MEMORY.md context — judges every candidate before showing the user anything.** Not a generic LLM scoring call. The agent that's been listening to them.

#### What this catches that nothing else does

Three signals worth burning into the architecture, drawn from real MEMORY.md patterns we've observed:

1. *"User's project pivoted from gaming to agentic commerce 9 days ago."*
   - Their seeking_summary may still emphasize gaming.
   - Deliberation overrides with current intent: investor candidates relevant to gaming get downscored; agentic-commerce builders get upscored.
   - **No embedding could capture this. No tag system could capture this.**

2. *"User mentioned in passing they're frustrated with their current smart-contract auditor."*
   - This will never be in any structured field.
   - When an auditor candidate appears, deliberation surfaces: *"you mentioned this last week — Brian Trunzo at Succinct does protocol-level review."*
   - **The deliberation has read every conversation. It remembers the throwaway line.**

3. *"User said in last week's chat that they're NOT raising right now."*
   - Investor candidates suppressed automatically.
   - No checkbox the user filled out. The agent picked it up from natural conversation.

These are the signals nobody else has. The dedicated-VM-with-weeks-of-memory architecture is the only architecture that captures them.

#### The 3-layer pipeline

```
LAYER 1 — RETRIEVAL (engine-side, cheap, fast)
  Dual-embedding mutual score (offering ↔ seeking)
  HNSW + RRF hybrid retrieval, hard filters, soft-prior boosts
  Returns top 50 candidates with public summaries
  ~80ms p95
  ~$0 marginal cost (Postgres + Voyage embedding)

LAYER 2 — LISTWISE RERANK (agent-side, full memory, 1 LLM call)
  Single Sonnet call with full SOUL.md + MEMORY.md anchor
  All 50 candidates' public summaries
  Output: ordered ranking + brief score per candidate
  ~3-5s
  ~$0.04 (Sonnet) / ~$0.01 (Haiku) per cycle

LAYER 3 — PER-CANDIDATE DELIBERATION (agent-side, batched)
  For top 12 (after MMR diversity from Layer 2): batched 3-at-a-time = 4 calls
  Each call: full memory anchor + 3 candidates → structured per-candidate output
  Output per candidate: { match_score, rationale, conversation_topic, meeting_window }
  ~5s parallel via Promise.all
  ~$0.025 (Haiku 4.5 with prompt caching) per cycle

TOTAL: 5 LLM calls per refresh, ~$0.035/user/cycle, ~5s end-to-end
```

#### Cost analysis with prompt caching

Anthropic prompt caching is the unlock. The user's memory anchor (~10K tokens, identical across all calls in a cycle) gets full price once, then 90% off for the next 4 calls.

| Model | First call | 4 cached calls | Total output | Per-cycle / user |
|---|---|---|---|---|
| Sonnet 4.6 | $0.0315 | $0.0126 | $0.06 | **~$0.10** |
| **Haiku 4.5** | **$0.0084** | **$0.0034** | **$0.024** | **~$0.04** |

At Consensus scale (500 users × 1 refresh/day) = ~$20/day with Haiku. Trivial.

**And critically: this cost falls on the user's VM, paid by their tier credits.** Not the platform. Foundation PRD §1.3 architecture inversion exactly: agent does the expensive work on its own dedicated infrastructure with its own paid-for credits.

A Haiku deliberation = ~1 unit of the 600-unit Starter daily allowance. 5 calls/day = 5 units = <1% of allowance. Sustainable indefinitely.

#### Latency analysis

- Layer 1: ~80ms (HNSW)
- Layer 2: ~3-5s (single Sonnet listwise call, ~10K cached input + ~1K output)
- Layer 3: ~5s parallel (4 calls × ~5s each in 4 parallel batches; bound by slowest)
- **Total p95: ~8-10s end-to-end**

For real-time Telegram push notifications, this is fine. For interactive ("find me my people right now"), 10s is acceptable — same order as a Google search with rich features.

#### The deliberation prompt (the load-bearing artifact)

```
SYSTEM: You are this user's personal AI agent. You have weeks of conversation
history with them in your context. Your job: for each candidate below,
deliberate honestly whether a meeting between your user and this person at
Consensus 2026 would be genuinely valuable.

Be honest. If the meeting doesn't make sense, say so with a low score. Don't
pad. Don't suggest meetings just because the embeddings matched.

Reference SPECIFIC things from your user's history (a project they mentioned,
a frustration, a goal, a pivot). The whole reason you exist as their agent —
rather than as a generic matchmaker — is that you have these specific
signals.

For each candidate, output strict JSON:

{
  "candidate_id": "...",
  "match_score": 0-1,           // your honest assessment of mutual value
  "rationale": "...",            // 1-2 sentences. Reference specific user history.
  "conversation_topic": "...",   // 1 sentence. The specific thing they should discuss.
  "meeting_window": "...",       // 1 phrase. Realistic time during the conference.
  "skip_reason": null | "..."    // if score < 0.5, what's missing
}

USER CONTEXT (full MEMORY.md + SOUL.md):
{{ANCHOR}}

CANDIDATES TO DELIBERATE:
{{CANDIDATES_JSON}}

OUTPUT: JSON array of deliberation results, one per candidate, in same order.
```

The `{{ANCHOR}}` is the prompt-cached portion (paid once per cycle). `{{CANDIDATES_JSON}}` is the per-call variable.

#### Failure modes

| Mode | Plan |
|---|---|
| **Cold start (anchor < 5K tokens)** | Skip Layer 3, fall through to Layer 2 only. User still gets matches; quality recovers as MEMORY.md grows. *This is the flywheel — the system gets better the longer they use it.* |
| **VM down / credits exhausted** | Engine returns top-K from Layer 1 (dual embedding) with template-generated rationales (foundation PRD §4 Step 7 fallback). Quality degrades but matches still surface. |
| **Asymmetric deliberation** (A's agent says GREAT, B's agent says MEH) | Each user sees their *own* agent's judgment. Different ranks for the same pair on each side is fine; if A reaches out and B's agent has reservations, B's agent gates the introduction. No false signals propagate. |
| **Latency spikes (Anthropic API slow)** | Engine returns Layer 1+2 results immediately; Layer 3 streams in async via push notification ("new deliberation arrived: David Wachsman, here's why he matters now"). |
| **Privacy** | Deliberation runs on A's VM. Reads only B's *consented* public summary (per consent_tier). B's full memory never crosses the wire. Clean. |

#### Why Sonnet for v1, not Haiku

Sonnet quality is meaningfully better for nuanced reasoning. Haiku 4.5 will sometimes miss the throwaway-line catch ("user mentioned frustration with auditor"). Sonnet won't.

Cost difference at Consensus scale: ~$50 vs ~$20 over 3 days (paid by user tier credits). The extra $30 buys the moat. Worth it.

**Recommendation:** ship Sonnet for Layer 3 in v1. Track quality against Haiku in v1.5 if cost becomes a concern.

---

### 2.6 XMTP intro-negotiation layer (Phase 2 — Wed 2026-05-06)

This is the architectural fulfillment of *"agents talk to each other before you do"* from the launch thread. Once a match is confirmed and the user wants to reach out, **the user's agent doesn't email the candidate or DM them on Telegram. It DMs the candidate's agent over XMTP** — wallet-to-wallet, end-to-end encrypted, no centralized intermediary.

The agents negotiate the meeting, exchange context, and surface a finalized proposal to both humans.

This is what makes the marketing claim *literally architecturally true*.

#### Why XMTP belongs here, not earlier

The matching/scoring step is local to the agent (Layers 1-3 above). XMTP doesn't help the *deciding* — it helps what happens *after* the deciding. The agents need to:

1. Coordinate a meeting time given each user's calendar / availability
2. Exchange context the engine never carried (private notes, prior introductions)
3. Negotiate counter-proposals if the first time slot doesn't work
4. Communicate cancellations / reschedules without going through the user

**Bilateral writes (Phase 1, Tue) handle the simple case:** A's agent says "I'd like to introduce my user to your user — Tuesday 3pm Brickell coffee?" via email or Telegram link to B. B accepts/declines. Engine reconciles.

**XMTP handles the realistic case (Phase 2, Wed):** counter-proposals, multi-round negotiation, async coordination, cross-event continuity. Bilateral writes degenerate at this — XMTP scales.

#### Why now, not deferred to post-Edge

Foundation PRD §14 (the XMTP draft) deferred this to post-Edge. **Two reasons to promote it to Phase 2 of Consensus:**

1. **Every InstaClaw agent already has a Bankr wallet.** The identity layer is shipped. There's no new infrastructure to build — just a `xmtp-client.service` per VM and a content-type schema. ~2 hours of work.
2. **It validates the architectural claim from the launch thread.** Wednesday's day-of follow-up content can show a real screenshot of *"my agent just negotiated this meeting with David's agent — here's the finalized 3pm slot, neither of us touched a calendar."* That's a category-different demonstration.

#### Phase 2 wire format (the minimum to ship Wed)

Define one content type schema family:

```typescript
// xmtp content type: instaclaw.intro/v1

interface IntroductionProposal {
  type: "intro_proposal";
  request_id: string;            // links back to a route_intent response
  initiator_agent_id: string;    // sender's hashed agent ID
  human_first_name: string;       // initiator's name (per consent tier)
  rationale: string;             // why this meeting (~2 sentences, from Layer 3)
  conversation_topic: string;    // suggested topic
  proposed_windows: TimeWindow[]; // 2-3 candidate time slots
  meeting_format: "1on1" | "small_group" | "session";
  context_excerpt?: string;      // optional 1-paragraph context
}

interface IntroductionResponse {
  type: "intro_response";
  responding_to: string;         // proposal's request_id
  decision: "accepted" | "counter_proposed" | "declined";
  selected_window?: TimeWindow;  // if accepted
  counter_windows?: TimeWindow[]; // if counter
  decline_reason?: string;       // optional
  responder_human_first_name?: string;  // per consent tier
}

interface TimeWindow {
  start_iso: string;
  end_iso: string;
  location_hint?: string;        // "Brickell coffee" / "near the Convention Center"
}
```

Three messages max (proposal → counter → confirm). After three rounds, fall back to surfacing both humans in Telegram for direct coordination.

#### Privacy semantics

XMTP is end-to-end encrypted via MLS (Signal's group cryptographic protocol). The platform NEVER sees the negotiation content. Only the agents do.

This is a structurally different privacy story than centralized matchmaking. The launch thread positioned us as a privacy-respecting agent platform. XMTP intro negotiation is what makes that claim cryptographically meaningful, not just policy-meaningful.

#### Discovery (how does Agent A know Agent B's XMTP address)

Foundation PRD's `route_intent` response already returns `agent_id` per candidate (hashed, non-wallet). We extend the response to include `xmtp_inbox_id` for candidates whose `consent_tier` includes XMTP communications:

```typescript
interface MatchCandidate {
  // ... existing fields ...
  xmtp_inbox_id?: string;  // present iff candidate opted-in to xmtp
                           // and consent_tier permits direct agent comms
}
```

The user-facing opt-in:

> *"Want me to message [name]'s agent directly to set up the meeting? It's encrypted between our agents — neither of us touches a calendar."*

If yes → A's agent sends an `intro_proposal` over XMTP. If no → fall back to email-link or Telegram-link in Phase 1 mode.

#### Cost / latency

- XMTP node access: free for our use (community nodes; we're well under throughput limits at 500 users)
- Bandwidth: minimal — text-only intro messages, ~1KB per round
- Latency: 2-5 seconds for message delivery via decentralized node network
- Storage: each VM keeps its own XMTP inbox, decrypts locally

Zero platform cost. Zero new infrastructure. Each VM gets `@xmtp/node-sdk` (existing npm package) and a `xmtp-client.service` systemd unit.

#### Build plan integration

Phase 2 is a 2h component, scheduled for Wed 2026-05-06 morning:

- `xmtp-client.service` per VM (1.5h to template + deploy)
- Content type schema + send/receive helpers (0.5h)
- Telegram opt-in prompt for "let agents negotiate directly" (0.25h, polish)

Wednesday morning ship → Wednesday afternoon: real deliberated → XMTP-negotiated meetings happening on the conference floor. **That's the day-of follow-up content for Wednesday.**

#### What stays deferred (foundation PRD §14)

The full XMTP vision — group formation, governance, reputation networks, cross-event continuity — stays scoped for post-Edge per the foundation PRD. Phase 2 here ships only intro negotiation. Everything else is a layer on top, building on the same XMTP substrate.

---

## 3. Consensus-Specific Operating Context

| Dimension | Edge City (foundation PRD) | Consensus (this addendum) |
|---|---|---|
| Event length | 4 weeks | 3 days |
| Pool size | ~500 users | ~100-500 |
| Cold-start window | First weekend (~48h) | First 12 hours (Mon eve → Tue morning) |
| Match cadence | Daily morning briefing | Real-time + morning briefing |
| Refresh frequency | Daily | Every 2h (matches periodic_summary cadence) |
| Privacy posture | Default opt-in (community context) | Default opt-out, opt-in via Telegram |
| Failure mode tolerance | High (4 weeks to recover) | **Low — every hour matters** |
| Surfacing channel (Phase 1) | Telegram | Telegram |
| Intro negotiation (Phase 2) | XMTP from Wed onward | XMTP from Wed onward |
| Recoverable from a bad call | Yes, gradual | Less so — only ~72h |

The 3-day window dominates every design choice — reactive cascades, real-time notifications, aggressive cold-start handling.

---

## 4. Schema Additions (extends foundation PRD §6)

```sql
ALTER TABLE matchpool_profiles
  -- Dual embedding model
  ADD COLUMN offering_summary TEXT,
  ADD COLUMN seeking_summary TEXT,
  ADD COLUMN offering_embedding vector(1024),
  ADD COLUMN seeking_embedding vector(1024),
  ADD COLUMN profile_version INT NOT NULL DEFAULT 1,
  -- Living feed bookkeeping
  ADD COLUMN intent_extracted_at TIMESTAMPTZ,
  ADD COLUMN intent_extraction_confidence NUMERIC(3,2),
  -- Layer 3 deliberation cache (avoid recomputing if profile + candidates unchanged)
  ADD COLUMN last_deliberation_at TIMESTAMPTZ,
  ADD COLUMN last_deliberation_anchor_hash TEXT,
  -- XMTP discovery (Phase 2)
  ADD COLUMN xmtp_inbox_id TEXT,
  ADD COLUMN xmtp_consent_at TIMESTAMPTZ,
  -- Future: serendipity slot tagging (Wed feature)
  ADD COLUMN match_kind_default TEXT NOT NULL DEFAULT 'core';

-- HNSW indexes on both new embeddings
CREATE INDEX matchpool_offering_hnsw
  ON matchpool_profiles USING hnsw (offering_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE offering_embedding IS NOT NULL;

CREATE INDEX matchpool_seeking_hnsw
  ON matchpool_profiles USING hnsw (seeking_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE seeking_embedding IS NOT NULL;

-- Cached top-3 per user (for diff-based notifications)
CREATE TABLE matchpool_cached_top3 (
  user_id            UUID PRIMARY KEY REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  top3_user_ids      UUID[] NOT NULL,
  top3_scores        NUMERIC[] NOT NULL,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Layer 3 deliberation results (cached per user × candidate × profile_version)
CREATE TABLE matchpool_deliberations (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  candidate_user_id  UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  user_profile_version INT NOT NULL,
  candidate_profile_version INT NOT NULL,
  match_score        NUMERIC NOT NULL,
  rationale          TEXT NOT NULL,
  conversation_topic TEXT NOT NULL,
  meeting_window     TEXT,
  skip_reason        TEXT,
  match_kind         TEXT NOT NULL DEFAULT 'core',
  deliberated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, candidate_user_id, user_profile_version, candidate_profile_version)
);
CREATE INDEX matchpool_deliberations_lookup
  ON matchpool_deliberations (user_id, deliberated_at DESC);

-- Notification queue (drained by per-VM agent cron)
CREATE TABLE matchpool_notifications (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  reason             TEXT NOT NULL,
  payload            JSONB NOT NULL,
  delivered_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX matchpool_notifications_undelivered
  ON matchpool_notifications (user_id, created_at)
  WHERE delivered_at IS NULL;

-- XMTP intro negotiation state (Phase 2)
CREATE TABLE matchpool_intros (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_user_id  UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  responder_user_id  UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  status             TEXT NOT NULL,  -- 'proposed' | 'counter_proposed' | 'accepted' | 'declined' | 'expired'
  xmtp_thread_id     TEXT,           -- XMTP conversation ID
  proposal_json      JSONB NOT NULL,
  response_json      JSONB,
  rounds             INT NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX matchpool_intros_active
  ON matchpool_intros (initiator_user_id, status)
  WHERE status IN ('proposed', 'counter_proposed');
```

**Migration strategy:** non-destructive ALTER TABLE. Existing rows stay. New columns nullable. Backfill happens organically as users re-extract intent.

---

## 5. Three-Layer Pipeline (the full flow)

```
USER SIGNS UP via /consensus or /signup
  → configureOpenClaw provisions VM + installs consensus-2026 skill
  → agent runs intent-extraction script:
      Tier 1 (existing user): reads MEMORY.md → Haiku extract → structured intent
      Tier 2 (new user): Telegram one-question → Haiku extract → structured intent
  → agent POSTs to /api/match/v1/profile (X-Gateway-Token auth)
  → platform: voyage-embed offering + seeking → upsert matchpool_profiles
                                              → trigger fires
                                              → pg_notify('matchpool_changed', ...)
                                                              ↓
WORKER PROCESS (LISTEN matchpool_changed):
  → Layer 1: dual-embedding mutual top-K (engine, ~80ms)
  → for each c in top-K of X: check if X enters c's top-K (HNSW reverse, parallel)
  → for c's where top-3 materially shifted: enqueue notification (rate-limited)
  → if X's own top-3 changed: enqueue X's update
                                                              ↓
PER-VM AGENT (cron every minute):
  → poll /api/match/v1/notifications/pending
  → FOR EACH undelivered:
      → fetch detailed candidate profiles
      → run Layer 2 (listwise rerank, full memory anchor) — 1 LLM call
      → run Layer 3 (per-candidate deliberation, batched) — 4 LLM calls
      → write deliberation results to matchpool_deliberations
      → format Telegram message in agent's voice with deliberation rationale
      → respect quiet hours / clustering / ceiling
      → send Telegram message
      → mark delivered

USER ASKS AGENT "find me my people" (route_intent flow):
  → agent calls /api/match/v1/route_intent
  → engine returns top-50 candidates (Layer 1)
  → agent runs Layer 2 + Layer 3 on user's VM
  → agent surfaces top-K with rich rationale via Telegram

USER SAYS "yes, set up the meeting with David" (Phase 2, Wed onward):
  → agent constructs IntroductionProposal (using Layer 3 rationale + topic + window)
  → agent sends via XMTP to candidate's xmtp_inbox_id (encrypted)
  → candidate's agent receives, evaluates against its own user's MEMORY.md
  → response: accept | counter | decline
  → both agents notify their humans with finalized proposal

USER ATTENDS A SESSION / has a conversation:
  → agent updates MEMORY.md (existing periodic_summary_hook)
  → next periodic-summary tick: re-extract intent if material drift
  → re-POST profile → trigger → cascade
  → potential new matches surface in real-time
```

---

## 6. Build Plan — phased ship through Mon-Wed

### Phase 1 — Tuesday morning announcement (Layers 1-3, Telegram-only intros)

| # | Component | Time | Risk | Ship |
|---|---|---|---|---|
| 1 | Migration: dual-embedding columns + indexes + triggers + queue tables | 0.75h | low | Mon 11pm |
| 2 | Voyage embedding helper + dual-embed function | 0.75h | low | Mon 11:45pm |
| 3 | Intent extraction lib (Haiku call, JSON validation) | 1.0h | medium | Tue 12:45am |
| 4 | VM-side intent script (reads MEMORY.md, calls Haiku, POSTs platform) | 1.0h | low | Tue 1:45am |
| 5 | Platform endpoint POST `/api/match/v1/profile` | 0.75h | low | Tue 2:30am |
| 6 | Match scoring lib (Layer 1: dual-embedding mutual top-K) | 1.5h | medium | Tue 4:00am |
| 7 | Layer 2 lib (listwise rerank, prompt-cached anchor, on user VM) | 1.0h | medium | Tue 5:00am |
| 8 | Layer 3 lib (per-candidate batched deliberation, on user VM) | 1.5h | medium | Tue 6:30am |
| 9 | `/consensus/matches` real-data wiring (replace static demo) | 1.0h | low | Tue 7:30am |
| 10 | Privacy opt-in flow (Telegram one-question + consent_tier setting) | 0.5h | low | Tue 8:00am |

**Phase 1 critical path: ~9.75h. Ships by Tue 8am ET.**

**Tue announcement criteria:**
- ✅ Components 1-10 shipped
- ✅ Cooper's matches visible at /consensus/matches with Layer 1+2+3 results
- ✅ At least 5 manually-tested users in pool
- ✅ Privacy opt-in working
- ✅ Page loads in <2s

### Phase 1.5 — Tuesday afternoon (reactive cascade + push notifications)

| # | Component | Time | Risk | Ship |
|---|---|---|---|---|
| 11 | Reactive cascade worker (LISTEN/NOTIFY, queue fanout, top-3 cache) | 1.5h | medium | Tue 11am |
| 12 | Telegram notification delivery (per-VM cron, anti-spam) | 1.0h | low | Tue 1pm |

**By Tue 1pm:** real-time push notifications working. New arrivals trigger cascades; matches arrive without being asked.

### Phase 2 — Wednesday morning (XMTP intro negotiation)

| # | Component | Time | Risk | Ship |
|---|---|---|---|---|
| 13 | XMTP client service per VM (systemd unit + @xmtp/node-sdk install) | 1.5h | medium | Wed 9am |
| 14 | Content type schema + send/receive helpers | 0.5h | low | Wed 10am |
| 15 | Telegram opt-in for "let agents negotiate directly" | 0.25h | low | Wed 10:15am |
| 16 | Intro negotiation handler (proposal → counter → accept) | 1.0h | medium | Wed 11:15am |

**Wed afternoon content:** screenshot of an actual XMTP-negotiated intro between two agents on the conference floor.

### Phase 3 — Wednesday afternoon / Thursday (serendipity + quality polish)

- Wildcard slot generator (the deferred serendipity feature, foundation PRD §5.1)
- Multi-objective scoring instrumentation (foundation PRD §5.2)
- Quality measurement + Sonnet-vs-Haiku A/B for Layer 3

### Per-component rollback

Each component ships behind an `INTENT_MATCHING_PHASE = 0|1|2|3` env var:

| Phase | What's on |
|---|---|
| 0 | Static preview only (current state) |
| 1 | Layer 1+2+3 deliberation, no real-time push |
| 2 | + reactive cascade + push notifications |
| 3 | + XMTP intro negotiation |

Flip via Vercel env. No code revert needed.

---

## 7. Telegram Delivery — the user-visible surface

### Notification voice

Always second-person. Always specific. Always cite specific MEMORY.md signal in the rationale (Layer 3 output). Never marketing-flavored.

**Example (Layer 3 output → Telegram message):**

> *"Morning. David Wachsman just joined the pool — Founder/CEO at Wachsman, on the Wednesday DeFi Infra panel. Your offering on agentic AI infrastructure and his focus on institutional crypto infra are a strong complementarity match. **You mentioned wanting to find institutional infra perspectives last Tuesday** — he's exactly that. He has a Wed 11:30 panel slot; coffee right after at the Frontier lobby is a clean window. Want me to draft an intro?"*

The bolded line is the Layer 3 deliberation citing a specific MEMORY.md signal. Without Layer 3, this would just be a tag-overlap match. With Layer 3, it's a personal recommendation from someone who knows the user.

### Anti-spam policy (recap from §2.4)

- Max 5 notifications/user/day
- Quiet hours: 11pm-7am local (queue → morning brief)
- Cluster within 5-min window
- Material-change gating

### Opt-in flow (component 10)

```
AGENT (Telegram, on consensus skill install or first message after install):

"Quick housekeeping. I can help you find people at Consensus this week —
investors, builders, operators working on stuff that overlaps with what
you're building. To match you with them and let them find you, I need
your okay to show your name + a 1-paragraph summary of what you're
working on (drawn from our chats). You can revoke or edit this anytime.

Say YES to opt in, or NO MATCHING if you'd rather stay private."
```

Defaults:
- Affirmative ("yes" / "go" / "sure" / "ok"): `consent_tier = 'interests_plus_name'`
- Negative ("no" / "no matching" / "private" / "skip"): `consent_tier = 'hidden'`
- Unclear: agent asks once for clarification, defaults to `hidden` if still unclear

### Privacy controls (in-conversation)

Agent recognizes phrases and updates state:

| Phrase pattern | Action |
|---|---|
| "show me to investors only" / "i'm raising" | filter visibility to candidates whose `looking_for` includes investor signals |
| "stop matching me" / "go private" | `consent_tier = 'hidden'` |
| "show me again" | reset to `interests_plus_name` |
| "what do people see about me" | display `offering_summary` + `interests` in chat |
| "edit what people see" | offer to regenerate the summary with new emphasis |
| "let agents negotiate directly" *(Phase 2)* | `xmtp_consent_at = NOW()`; agent will use XMTP for intros |

---

## 8. Deferred — Wednesday and beyond

| Feature | When | Notes |
|---|---|---|
| Serendipity slot / wildcard | Wed afternoon | Architecture support (`match_kind` column) ships v1 |
| Multi-objective scoring | Wed-Thu | Foundation PRD §5.2 |
| LinUCB bandit on feedback | Post-Edge | Foundation PRD §5.2 |
| Cohere Rerank 3.5 cross-encoder | Only if quality complaints land | Foundation PRD §5.2 |
| HyDE for cold-start | Only if cold-start quality is bad | Foundation PRD §5.2 |
| **XMTP group formation** *(plaza, governance)* | Post-Edge | Foundation PRD §14 |
| **Reputation networks via signed claims** | Post-Edge | Foundation PRD §14 |
| **Cross-event continuity** | Pre-Token2049 (Sept-Oct) | Foundation PRD §14 |

---

## 9. Open Questions — handed off, with deadlines

| # | Question | Owner | Decide by | Recommendation |
|---|---|---|---|---|
| 1 | Voyage-3-large reachable from Vercel, or fall back to OpenAI text-embedding-3-large? | Cooper | Mon 9pm | Try Voyage first, fallback to OpenAI if reachability issues |
| 2 | Reactive worker hosting: Vercel cron-style (fragile) vs Railway/Fly long-running box | Cooper | Mon 11pm | Railway/Fly long-running — cleaner |
| 3 | Tue announcement target time: 8am ET or 9am ET? | Cooper | Mon 9pm | 9am — gives 1hr slack on critical path |
| 4 | Layer 3 model: Sonnet (better quality, $50 over 3 days) or Haiku 4.5 ($20)? | Cooper | Mon 11pm | **Sonnet for v1.** Quality matters; user pays from credits anyway |
| 5 | Notification UX: push proactively, or "ask first"? | Cooper | Tue morning before Phase 1.5 | **Push.** "Ask first" = 1 extra round-trip, kills the magic |
| 6 | XMTP node provider: community nodes (free, no SLA) or paid tier (~$50/mo)? | Cooper | Wed 8am before Phase 2 | Community nodes for v1; switch if reliability issues |
| 7 | XMTP opt-in default: opt-in by user request, or opt-in automatic on first match acceptance? | Cooper | Wed 8am | Auto opt-in on first match acceptance — friction-free |

---

## 10. The Recommendation

Ship this. The architecture is structurally different from anything that's shipped before for conferences:

1. **Inferred intent** removes the form. *(§ 2.1)*
2. **Dual embeddings** capture complementarity, not similarity. *(§ 2.2)*
3. **Reactive cascades** make the system feel real-time. *(§ 2.3)*
4. **Living feed** matches the user's evolution through the conference. *(§ 2.4)*
5. **Per-candidate agent deliberation** is the central moat — every match judged by an agent that's been listening for weeks, with prompt caching keeping cost negligible. *(§ 2.5)*
6. **XMTP intro negotiation** makes "agents talk to each other before you do" architecturally true, not just marketing. *(§ 2.6)*

**Phase 1 (Tue 8am):** Layers 1-3 + email-link intros. ~9.75h critical path.
**Phase 1.5 (Tue 1pm):** Reactive cascade + push notifications. +2.5h.
**Phase 2 (Wed 11am):** XMTP intro negotiation. +3.25h.

The Tuesday announcement, with this in:

> *"matching is live. tell your agent what you're working on once. it cross-references everyone in the consensus pool — speakers, attendees, side-event hosts — and your own agent, with weeks of memory of you, deliberates on each candidate before showing you anything. matches arrive with a specific reason ('you mentioned wanting an auditor last week — here's one') and a suggested conversation topic. no other matching system has the architecture to do this."*

The Wednesday day-of follow-up:

> *"day 2. my agent just negotiated this meeting with David's agent over xmtp — encrypted between our wallets, neither of us touched a calendar."* [screenshot of Telegram message showing the finalized proposal]

That's a category-different system, not a marketing claim. Worth shipping right.

---

*End of addendum. Total: ~1000 lines. Reviewable in 20 min. Build starts on Cooper's go.*
