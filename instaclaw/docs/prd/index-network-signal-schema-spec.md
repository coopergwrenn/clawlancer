# Index Network ↔ InstaClaw Signal Schema Spec

**Status:** Draft v0.1 — pre-sync proposal for Apr 30, 2026 partnership call
**Owners:** Cooper Wrenn (InstaClaw) ↔ Index Network technical lead
**Source-of-truth PRD:** `instaclaw/docs/prd/edgeclaw-partner-integration.md` § 4.9
**Resolves:** PRD open questions Q17 (API contract), Q18 (throughput), Q19 (hosting/retention), Q20 (↔ XMTP boundary)
**Companion artifacts:** `lib/research-export/` (anonymization pipeline, shipped) — `research.agent_signals` columns are coupled to the request shape below.

---

## 1. Purpose

This document is what InstaClaw walks into the Apr 30 sync with. It exists to turn the meeting from "let's brainstorm" into "we propose this — what changes do you need?"

The output of the meeting should be a v0.2 of this document with every section either ✅ accepted, ◯ accepted-with-changes, or ⚠ deferred — and a hard freeze of the request/response payloads by **May 5** so XMTP integration (Phase 3a) can be written against a stable surface.

Cooper's recommended posture in the meeting: **defaults below are starting positions, not ultimatums**. The throughput and privacy boundaries are non-negotiable; everything else is moveable.

---

## 2. Architectural boundary (Q20)

**Proposal:** Index Network ranks. XMTP brokers. Personal agent decides.

```
Agent A ──submit_signal()──▶ Index Network
Agent A ──get_matches()────▶ Index Network ──ranked candidates──▶ Agent A
Agent A ──XMTP DM──▶ Agent B          (intro proposal — no Index Network involvement)
Agent B ──XMTP DM──▶ Agent A          (response — no Index Network involvement)
```

**Index Network's responsibilities:**
- Ingest availability signals (one per agent per night)
- Maintain semantic embeddings over the active signal pool
- On query, return top-N ranked candidates for a given signal with reason summaries
- Optionally: cluster query for group formation (§ 6)
- Optionally: light scoring feedback ingest from agents (§ 8) for online quality improvement

**Index Network does NOT:**
- Carry intro request / response messages between agents (that's XMTP)
- Hold conversational content (Telegram conversations stay on the agent's VM)
- Have access to the human's real name, email, wallet address, or contact info — only the agent-supplied signal payload (§ 4)
- Persist signal data beyond the village + 30-day window (§ 9)

**Why this split:** Index Network is purpose-built for semantic discovery at population scale; XMTP is purpose-built for encrypted agent-to-agent messaging. Asking Index Network to also broker introductions would either compromise privacy (Index Network sees the negotiation) or duplicate XMTP's role. Pairwise comparing 999 signals on each VM doesn't scale. Each system does the thing it's good at.

---

## 3. Endpoints (proposed)

```
POST  /v1/signals                 submit a nightly availability signal
GET   /v1/signals/{id}/matches    fetch ranked matches for a previously submitted signal
POST  /v1/clusters                cluster query for group formation        (optional, § 6)
POST  /v1/feedback                report human-confirmed match outcomes    (optional, § 8)
GET   /v1/health                  liveness/readiness probe                 (operational)
```

Auth model: bearer token per agent, signed by the agent's Bankr wallet (proof-of-key) and exchanged for a session token at first call. Token rotation per village week. **Open: does Index Network want a single InstaClaw-wide service token instead, with per-agent signing only on payload?**

---

## 4. `submit_signal` — request shape

```json
{
  "agent_id": "0x9d4ad3...e8a1",
  "signal_id": "client-generated UUIDv7",
  "night_of": "2026-06-12",
  "week": 3,
  "interests": ["longevity", "ai-governance", "biotech"],
  "goals": ["meet a biotech founder", "join a deep-tech roundtable"],
  "looking_for": ["biotech-founder", "ai-researcher", "governance-expert"],
  "available_slots": ["10:00-12:00", "14:00-16:00", "dinner"],
  "available_slot_count": 3,
  "human_first_name": "Alex",
  "consent_tier": "interests_plus_name",
  "cohort_tag": "h1-treatment",
  "client_version": "edgeclaw-skill-v0.3.2"
}
```

Field-by-field rationale:

| Field | Required | Rationale |
|-------|----------|-----------|
| `agent_id` | ✅ | Stable for the village, keyed off Bankr wallet, **but not the raw wallet** (see § 5). Lets Index Network maintain user-level ranking memory across nights. |
| `signal_id` | ✅ | Client-generated so the agent owns the dedup key. UUIDv7 so it sorts by submission time. |
| `night_of` | ✅ | Date the signal *plans for* — i.e., the morning briefing the next day. Index Network can age out signals after this date. |
| `week` | ✅ | 1–4. Some attendees only attend partial weeks; matching shouldn't surface counterparts who've already left. |
| `interests` | ✅ | Free-form tags the agent extracted from onboarding + memory. Bounded to ~10. |
| `goals` | ✅ | Tomorrow-specific intent strings. ~3-5 typical. Free-form. |
| `looking_for` | ✅ | Counterparty profile tags — who would the human want to meet? ~3-5. |
| `available_slots` | ✅ | When the human is free. Time strings (no date — date is `night_of` + 1). |
| `available_slot_count` | ✅ | Convenience scalar (also stored in research export, slot times themselves are not). |
| `human_first_name` | ◯ optional | Only if `consent_tier ≥ "interests_plus_name"`. Reduces matching cold-starts because LLM ranking improves with even a thin identity signal. |
| `consent_tier` | ✅ | One of `name_only`, `interests`, `interests_plus_name`, `full_profile`. Tells Index Network what's safe to surface in match reasons. |
| `cohort_tag` | ◯ optional | Vendrov's experimental cohort identifier (e.g., `h1-treatment`, `h1-control`). Only included if Vendrov has registered the cohort and the human consented. Lets Index Network *branch* on cohort if a hypothesis demands it (§ 7). Index Network does NOT see the meaning of the tag — just an opaque string. |
| `client_version` | ✅ | InstaClaw skill version. For Index Network's debug logs in case a bad signal payload leaks past the agent's validation. |

**Response (success):**

```json
{
  "status": "accepted",
  "signal_id": "...",
  "received_at": "2026-06-11T23:04:11Z",
  "match_eta": "2026-06-12T03:30:00Z"
}
```

`match_eta` lets the agent set its `get_matches` cron tick precisely. Soft commitment from Index Network, not a hard SLA.

**Response (validation error):**

```json
{
  "status": "rejected",
  "reasons": [
    { "field": "interests", "code": "too_long", "message": "max 10 tags" }
  ]
}
```

**Errors are non-fatal — agent retries once with truncated input, then falls back to broadcasting the signal to the XMTP plaza only.** The agent never blocks the morning briefing on Index Network availability (see § 11 fallback).

---

## 5. `agent_id` — what it is, what it isn't

The single most important detail in this spec.

**`agent_id` is NOT the raw Bankr wallet address.** Submitting raw wallets to Index Network would bring them into the privacy boundary as a sub-processor of identifying data. Instead:

```
agent_id = HMAC-SHA-256(bankr_wallet, edge_city_index_network_pepper) [first 16 hex chars]
```

The pepper is held only by InstaClaw and rotated post-village. It's a different value from the `edge_city_research_salt` used for the Vendrov export — so even if both data sets were somehow joined, the agent IDs wouldn't collide.

**Properties:**
- Stable for the duration of the village (so Index Network can maintain ranking memory)
- One-way (Index Network can't reverse-derive the wallet)
- Salt rotation post-village destroys the linkage entirely (deletion-by-key-rotation pattern)
- Cross-table-consistent: same wallet → same `agent_id` across all four weeks of signals

**What this means for Index Network:**
- Logs and embeddings can keep `agent_id` indefinitely *in operational systems*, but the link to a real human evaporates the moment the pepper is rotated.
- Index Network never sees the raw wallet. Period.

---

## 6. `get_matches` — request and response

```
GET /v1/signals/{signal_id}/matches?top_n=20&cohort_filter=any&include_reason=true
```

**Response:**

```json
{
  "signal_id": "...",
  "computed_at": "2026-06-12T04:02:11Z",
  "candidates": [
    {
      "agent_id": "0x...",
      "match_score": 0.87,
      "reason": "Counterpart's stated goal is 'find collaborators for AI-driven drug discovery'; overlaps with your goal 'meet a biotech founder' and your interest tag 'biotech'.",
      "shared_interests": ["biotech"],
      "complementary_goals": [
        { "yours": "meet a biotech founder", "theirs": "find collaborators for AI-driven drug discovery" }
      ],
      "human_first_name": "Sarah",
      "consent_tier": "interests_plus_name",
      "candidate_week": 3
    }
  ]
}
```

**Cluster query for group formation:**

```
POST /v1/clusters
{
  "seed_signal_id": "...",
  "target_size_min": 4,
  "target_size_max": 8,
  "theme_hint": "outdoor + deep conversations",
  "cohesion_threshold": 0.65
}
```

**Response:**

```json
{
  "clusters": [
    {
      "members": ["0x...", "0x...", "0x...", "0x..."],
      "cohesion_score": 0.78,
      "suggested_theme": "Sunset hike — longevity + AI ethics conversation"
    }
  ]
}
```

The seed agent then opens an XMTP DM to each member proposing the activity (Index Network is not in the loop for the invitation).

---

## 7. Cohort handling (research integration)

Vendrov's pre-registered hypotheses include experimental conditions where Index Network's matching behavior should branch — e.g., one cohort gets the full ranked list, the control gets a randomized subset. Two options:

**Option A — Cohort-blind Index Network.** Index Network always returns the full ranked list. The personal agent applies the cohort branch (e.g., shuffle for control). *Pro:* Index Network has zero awareness of experimental design. *Con:* per-agent client logic; harder to enforce consistently.

**Option B — Cohort-aware Index Network.** `cohort_tag` is included in the signal; Index Network has a small cohort-rule table provided by Vendrov pre-village. *Pro:* central enforcement. *Con:* Index Network becomes part of the experimental apparatus.

**Recommendation: A.** Keeps Index Network's privacy boundary clean and treats it as a pure ranking service. Vendrov's experimental design lives in the InstaClaw skill, where it can be audited, version-controlled, and pre-registered.

---

## 8. Optional feedback channel (post-village quality)

Once a match results in a confirmed meeting (or doesn't), the personal agent could optionally report back:

```json
POST /v1/feedback
{
  "signal_id": "...",
  "candidate_agent_id": "...",
  "agent_action": "dm_sent",
  "counterpart_response": "accepted",
  "human_confirmed": true,
  "meeting_happened": true,
  "agent_quality_rating": 4
}
```

**Recommendation: ship without this in v1, add post-village if Index Network's ranking quality is the bottleneck.** Same data is captured in `research.match_outcomes` — the question is whether Index Network gets a real-time copy or pulls from the research drop later.

---

## 9. Privacy & data retention (Q19)

| Concern | Index Network commitment (proposed) |
|---------|-------------------------------------|
| Raw Bankr wallets | Never submitted. `agent_id` is HMAC-hashed (§ 5). |
| Real names | Only first name, only with `consent_tier ≥ "interests_plus_name"`. Last names, emails, contact info: never submitted. |
| Conversation content | Out of scope. XMTP DMs and Telegram conversations never reach Index Network. |
| Signal retention | Active signals: until `night_of + 1 day`. Anonymized embeddings: until village close + 30 days. Then deleted. |
| Match logs | Same retention as signals. Vendrov gets these via the InstaClaw research export, not direct from Index Network. |
| DPA scope | Index Network is a sub-processor under the InstaClaw ↔ Edge City DPA. Same incident-notification, sub-processor-transparency, and deletion guarantees apply. |
| Pepper rotation | InstaClaw rotates the `agent_id` HMAC pepper within 7 days of village close. After rotation, Index Network's stored `agent_id` values are structurally non-reidentifiable. |

**Asks of Index Network:**
1. Confirm the retention window (village + 30 days, then deletion).
2. Confirm willingness to sign as a sub-processor under InstaClaw's DPA.
3. Specify any operational logs that fall *outside* this scope (e.g., aggregate API metrics, error logs that don't include payloads).

---

## 10. Throughput & latency requirements (Q18)

| Metric | Requirement |
|--------|-------------|
| Concurrent agents | ~1,000 at peak (week 3-4) |
| Signal submission window | 22:00 – 23:00 PT, 1,000 signals submitted within ~60 min |
| Per-agent submission rate | ≤ 1 / minute steady; 1 burst on cron tick |
| Match retrieval | Each agent fetches matches once at 03:00–04:00 PT; 1,000 GETs within 60 min |
| End-to-end latency (signal → match available) | ≤ 5 min P95 |
| Cluster query latency | ≤ 30 s P95 |
| Availability target | 99.5% during nightly window (22:00 PT – 06:00 PT). Off-window degraded mode is acceptable. |

**Load-test commitment:** InstaClaw will provide a synthetic load harness (1,000 mock agents) for joint load testing **between May 19–23**. Hard go/no-go for May 30 launch.

**Asks:**
1. Can Index Network meet the ≤ 5 min E2E latency at 1,000 concurrent? Honest answer is preferred over optimistic.
2. What rate limits should the agent's submit/get cron respect?
3. Is the 22:00–04:00 PT high-window an issue for Index Network's infrastructure (cost, scaling)?

---

## 11. Failure modes & fallback

The morning briefing is the user-visible promise. It must ship every day, even if Index Network is down. The agent's behavior under failure:

| Failure | Agent fallback |
|---------|----------------|
| `submit_signal` 5xx or timeout | Retry once with backoff; if still failing, post the same signal to the XMTP `ee26-plaza` group only. Briefing flags "matches limited tonight." |
| `get_matches` 5xx, timeout, or empty | Pairwise rank against XMTP plaza signals on the agent's own VM (LLM-driven, slower but bounded by the plaza's broadcast list). Briefing flags "matches generated locally." |
| Cluster query failure | Fall back to the agent broadcasting a group-formation invitation directly on `ee26-events` with no pre-clustering. |
| Feedback endpoint 5xx | Drop on the floor; this data is also captured in `research.match_outcomes` so nothing is lost. |
| Index Network entirely offline for the night | Briefing still ships; entire flow degrades to plaza-broadcast-only. Telemetry alert to Cooper. |

**InstaClaw's commitment to Index Network:** under no circumstance does the agent block the morning briefing on Index Network availability. The agent treats Index Network as a quality enhancement layer, not a critical path.

---

## 12. Open questions to resolve at the Apr 30 sync

| # | Question | Index Network owner | InstaClaw owner |
|---|----------|---------------------|-----------------|
| A | Hosting model — Index Network managed (recommended) vs. self-hosted instance? | IN team | Cooper |
| B | Signal/match retention specifics — confirm village + 30 day, then deletion | IN team | Cooper |
| C | Sub-processor DPA — willing to sign under InstaClaw's DPA? | IN legal | Cooper |
| D | Cohort handling — Option A (cohort-blind, recommended) | IN team | Cooper / Vendrov |
| E | Throughput SLA — 1,000 concurrent, ≤ 5 min E2E latency, achievable? | IN team | Cooper |
| F | Load test — joint May 19–23 with 1,000 mock agents | IN team | Cooper |
| G | Auth model — service-token vs. per-agent-token | IN team | Cooper |
| H | Feedback channel (§ 8) — ship in v1, or defer? | IN team | Cooper |
| I | Cluster query (§ 6) — ship in v1, or defer to v1.1? | IN team | Cooper |
| J | API base URL + sandbox env for InstaClaw integration testing | IN team | — |
| K | Failure-mode notification channel (alerts when IN is degraded) | IN team | Cooper |

---

## 13. Hard freeze targets

| Date | Deliverable |
|------|-------------|
| **Apr 30** | This doc accepted in principle. § 4 (request), § 6 (response), § 9 (privacy) locked. |
| **May 5** | Sandbox endpoint live; InstaClaw integration test passes against mock signal volume. |
| **May 9** | Production endpoint live; integrated end-to-end on canary. Portal-live milestone unblocked from this side. |
| **May 19–23** | Joint load test at 1,000-agent scale. Pass = green light for May 30. |
| **May 23** | Signal schema + match schema FROZEN. No breaking changes after this date. |
| **May 30** | EE26 starts. Operational runbook, on-call schedule, alert routing locked. |

---

## 14. What Cooper needs from Index Network team in the meeting

Practical asks, ordered by leverage:

1. **A point-of-contact for daily integration questions** (Slack channel or shared on-call rotation between Apr 30 and May 30).
2. **A sandbox URL by May 5** so the Edge skill can be wired against a real (even if rate-limited) endpoint.
3. **A signed "yes, this is workable" on § 4, § 6, § 9, § 10** — even if specific fields move, the overall shape needs a green light tomorrow.
4. **Hosting model decision (Q19)** so the privacy boundary isn't ambiguous in the DPA draft.
5. **Throughput honest answer (§ 10)** so InstaClaw knows whether to budget for fallback paths.

Everything else — feedback channel, cluster query, cohort handling — can settle in the week after.

---

## Appendix A — Sequence diagram

```
┌─────────┐  22:30  ┌─────────┐  03:30  ┌─────────────┐  04:00  ┌─────────┐  04:30
│ Agent A │ ──────▶ │   IN    │ ──────▶ │  rank pool  │ ──────▶ │ Agent A │ ───────▶
└─────────┘ submit  └─────────┘ ingest  │             │ matches └─────────┘ pull
                                                                     │
                                                                     │ XMTP DM
                                                                     ▼
                                                              ┌─────────┐
                                                              │ Agent B │
                                                              └─────────┘
                                                                     │
                                                                     │ XMTP response
                                                                     ▼
                                                              ┌─────────┐  06:30
                                                              │ Agent A │ ───────▶
                                                              └─────────┘ briefing
                                                                          via Telegram
```

## Appendix B — Cross-references

- PRD § 4.9 — XMTP architecture
- PRD § 4.9.5 — XMTP / Index Network privacy model (this doc supersedes the open items there)
- PRD § 4.10.3 — Research export schema (`research.agent_signals` columns are coupled to § 4 above)
- PRD § 6.1 — Maximum Privacy Mode (does not gate Index Network signal submission; same anonymization applies)
- `lib/research-export/extractors.ts` — already shipped, reads from `research.agent_signals`
- `lib/research-export/anonymize.ts` — HMAC-SHA-256 implementation; same primitive used for the Index Network `agent_id` derivation
