# Matching Pipeline — Week-1 Production Audit

**Date:** 2026-05-11
**Audit window:** May 5 (Consensus launch) → May 11 (today). ~6 days of production traffic.
**Tables audited:** `matchpool_profiles`, `matchpool_deliberations`, `matchpool_outcomes`, `matchpool_intros`, `matchpool_cached_top3`, `agent_outreach_log`, `research.match_outcomes`.
**Scripts:** `scripts/_matching-pipeline-week1-report.ts`, `_outcome-ingest-investigation.ts`, `_pool-and-pending-investigation.ts`, `_probe-outreach-rows.ts`, `_index-compat-audit.ts`.

---

## TL;DR — three load-bearing findings

1. **The 3-layer pipeline operates blind.** `matchpool_outcomes` was specified in foundation PRD §6.1 but never created in any migration. `research.match_outcomes` was created with a different shape but has zero writes from any production code path. We have predictions (`matchpool_deliberations.match_score`) but no ground truth. **We cannot tune mutual_threshold, cannot measure Hinge-analogue success rate, cannot detect MAST inter-agent misalignment.**

2. **The pool is 8 users, all insiders.** Cooper (x2 accounts), Timour, Seref, Seren, Katherine (Edge City), plus two stragglers (Andrew Flory, Alejandro). Consensus 2026 organic adoption was effectively zero — or the opt-in flow filtered everyone out. **We have not yet exercised the pipeline against real users.** Edge Esmeralda (May 30) will be the first validation event.

3. **V2 negotiation never fired in production.** `matchpool_intros` has 0 rows. The v2 envelope work on `v2-negotiation-phase1-envelopes` branch is clean per canaries but never merged + deployed. The 30 intros that have run all went through v1 INTRO_V1 (single-shot, no negotiation).

**Implication for §5.2 priority order:** Live Activity Dashboard is moved **down** the priority list, not up. With no outcome data, the dashboard shows "30 intros sent" without being able to show whether any were valuable. The outcome ingest path is now P0 and **must ship before the dashboard is useful as a marketing artifact**.

---

## Detailed findings

### Finding 1: `matchpool_outcomes` never created

**Status:** Foundation PRD §6.1 specified the table with columns `outcome_id, request_id, source_user_id, candidate_user_id, match_engine, rrf_score, mutual_score, agent_action, counterpart_response, human_confirmed, meeting_actually_happened, rating_post_meeting, reason_text, created_at`.

**Reality:** No migration creates this table. `grep -rn matchpool_outcomes supabase/migrations/` returns zero matches. The consensus addendum's `20260504_matchpool_intent_matching.sql` migration creates 6 other tables but not this one. The schema is in the PRD; the migration was never written.

**The PostgREST artifact that misled me:** my first script reported `matchpool_outcomes` as "0 rows" after PostgREST cached a query result against the non-existent table. The actual answer is that the table does not exist.

**There IS a sibling table that does:** `research.match_outcomes` (created in `20260429_research_schema.sql`). But:
- Different schema (`research`, not `public`) — not accessible via PostgREST default config without schema override
- Different shape — keyed by `signal_id` (Index Network signal pattern), not `request_id` (our wire format)
- Zero writes — `grep -rn "research.match_outcomes" --include="*.ts" --include="*.py"` returns only the integration test, no production code

**Impact:** The 3-layer pipeline produces predictions (Layer 3 `match_score`) but nothing captures whether those predictions were accurate. The foundation PRD §10.2 promised tracking surface-rate, acceptance-rate, counterpart-acceptance-rate, meeting-rate, meeting-happened-rate, post-meeting valuable. None of these are tracked.

**Fix required:** Migration + write path. Estimated 1 day for migration + ingest endpoint + Telegram-bot "did you meet?" prompt + cron writeback.

### Finding 2: Only 8 users in `matchpool_profiles`, all insiders

**Status:** Foundation PRD §11 projected 500 users at Edge Esmeralda, 100-500 at Consensus, scaling to 50K. Consensus addendum projected ~500 users at Consensus.

**Reality:** 8 users total. Breakdown:

| user_id | partner | identity | profile_version |
|---|---|---|---|
| 0a102415 | consensus_2026 | coopergrantwrenn@gmail.com (Cooper) | 17 |
| cc1d7227 | edge_city | timour.kosters@gmail.com (Timour) | 17 |
| 1d1df916 | edge_city | katherine@edgecity.live (Katherine) | 10 |
| 3a2c2392 | edge_city | seren@index.network (Seren) | 8 |
| 4e0213b3 | edge_city | coopgwrenn@gmail.com (Cooper alt) | 10 |
| a8344b7a | edge_city | seref@index.network (Seref) | 10 |
| 34e86135 | (none) | andrewflory1989@gmail.com (Andrew) | 7 |
| b3f0b13f | (none) | alejandroclarianamartinez@gmail.com (Alejandro) | 4 |

6 of 8 are insiders (Cooper, Timour, Katherine, Seref, Seren). 2 are unpartnered stragglers.

**Coverage of partner-tagged users:** 11 users have a partner tag in `instaclaw_users` (9 edge_city + 2 consensus_2026). 8 of them have a `matchpool_profile` = 72.7% coverage of the eligible pool.

**Consent_tier breakdown:** 3 `hidden`, 5 `interests`. None at `interests_plus_name` or `full_profile`. The opt-in flow defaults to `hidden` (per consensus addendum §2.4 anti-spam policy). Of the 5 who opted in, all chose `interests` (the next-lowest tier).

**Implication:** Whatever we measure in week-1 production is the team testing among themselves. The 30 intros, the 519 deliberations — these are *Cooper, Timour, Seref, Seren testing the pipeline among themselves.* This is not bad data. It's not real-user data either.

**Honest framing for the competitive-research PRD §5.4:** my projection that "we have ~6 days of production data" was wrong. We have ~6 days of *test data from 8 known users including the project team*. Edge Esmeralda will be the first real signal.

### Finding 3: V2 negotiation never fired in production

**Status:** Consensus addendum §2.6 promised XMTP intro negotiation shipping Wed 2026-05-06. V2 negotiation PRD specified 5 envelope types + 7-state machine. Per existing task list, canaries on vm-050 and vm-780 are clean.

**Reality:** `matchpool_intros` table has 0 rows. No v2 envelope has ever been sent in production. The branch `v2-negotiation-phase1-envelopes` is not merged to main.

**The 30 intros that DID run** all went through the v1 INTRO_V1 single-shot flow. No counter-proposals. No state machine. No multi-turn negotiation.

**Impact:** The consensus addendum's claim "agents talk to each other before you do" is only architecturally true for the single-shot intro. Multi-round negotiation — the unique architectural differentiator vs centralized matchmaking — is not yet exercised.

**Fix required:** Merge the v2-negotiation-phase1-envelopes branch (clean canaries — task #100, #101 marked complete) and roll out to all consensus_2026 + edge_city VMs. Estimated 1 day.

### Finding 4: All 30 intros delivered, but `ack_channel` is misleading

**Status:** My first audit reported `ack_channel='pending'` for 33% of intros and flagged this as a 33% silent-drop rate.

**Reality:** **All 30 intros have `ack=yes` (ack_received_at is non-null).** Delivery infrastructure is working at 100%. The `ack_channel` field is a metadata bug: when the outreach row is created at `reserve` phase, `ack_channel` defaults to `'pending'`. When the ACK is later received, `ack_received_at` is set but `ack_channel` is never updated from its default.

**True ack_channel breakdown** (if the writeback bug were fixed):
- `telegram` (43%, 13 rows): Telegram notification delivered + receiver agent ACK'd via PATCH /outreach
- `polled` (23%, 7 rows): Receiver's `/my-intros` poll fallback fired, found the intro, ACK'd
- `pending` (33%, 10 rows): **Unknown** — either also telegram-delivered (and writeback skipped) or also polled (and writeback skipped). Can't tell.

**Implication:** Delivery is working. But we can't see *how* it's working for a third of intros. The `polled` rate of 23% is also notable — it means roughly a quarter of intros are NOT reaching realtime XMTP delivery and only get surfaced when the receiver-side poll fires. That's worth understanding (XMTP latency? agent process not running? subscriber not yet open?). But we don't have the resolution to attribute it precisely until the writeback bug is fixed.

**Fix required:** The `/api/match/v1/outreach` route's ACK phase update should always set `ack_channel`. ~0.5 day to fix and backfill. Trivial.

### Finding 5: 519 Layer 3 deliberations is healthy volume, but the proxy latency is meaningless

**Status:** Consensus addendum §2.5 projected ~5 LLM calls/user/cycle, ~$0.035/cycle (Sonnet) at ~5s end-to-end latency.

**Reality (518 deliberations on 8 users over ~6 days):**
- 12 deliberations per user-day median (p95: 17, max: 22)
- ~$3.63 total cost (at $0.007/deliberation, Sonnet prompt-cached)
- Cost-per-user-per-day: ~$0.075 (in the projected range — paid by user tier credits)

**The latency proxy I computed (p95 = 19.5 hours) is meaningless.** It measures `intent_extracted_at → deliberated_at` which includes:
- The 2-hour `periodic_summary_hook` cron cadence
- The user's overnight gap (no activity)
- Re-deliberation cycles where the candidate pool changed but the user's profile_version didn't

To answer "what's the actual Layer 3 LLM-call latency" we need a per-call timestamp we don't capture today. **Add `deliberation_started_at` and `deliberation_completed_at` columns to `matchpool_deliberations` so we can measure the actual latency.** ~0.5 day.

### Finding 6: Index-integration schema gaps

**Per Cooper's directive to keep Index integration compatible:** the schema audit reveals two real gaps.

| Table | Has `match_engine` col? | Risk if Index ships |
|---|---|---|
| `matchpool_profiles` | ✗ | None — profiles are engine-agnostic |
| `matchpool_deliberations` | ✗ | **HIGH** — cannot attribute Layer 3 inputs to Index vs InstaClaw retrieval |
| `matchpool_outcomes` | n/a (table doesn't exist) | The PRD-spec'd schema *did* include `match_engine` |
| `agent_outreach_log` | ✗ | **HIGH** — cannot attribute outcome (ack/decline) back to engine |
| `matchpool_intros` | ✗ | **MEDIUM** — v2 negotiations not engine-attributed |
| `matchpool_cached_top3` | ✗ | Low — cache is implicitly engine-specific |

**Gap fix:** add `match_engine TEXT NOT NULL DEFAULT 'instaclaw' CHECK (match_engine IN ('instaclaw', 'index'))` to: `matchpool_deliberations`, `agent_outreach_log`, `matchpool_intros`. Same migration as the `matchpool_outcomes` creation (Finding 1). ~0.5 day for migration + propagation through the producer code paths.

**Why this matters:** without `match_engine`, when we A/B Index vs InstaClaw in Edge week 2 we cannot answer "did Index produce better matches?" because we can't trace any specific outcome back to a specific engine.

### Finding 7: 6 of 8 profiles have profile_version > 4, evidence of intent re-extraction working

**The good news.** Profile versions range from pv=4 to pv=17. This means the consensus addendum §2.4 living-feed mechanism is actually firing — the agent is re-extracting intent as MEMORY.md evolves. Cooper's profile is at pv=17, Timour's at pv=17 — both have been actively talking to their agents over the week.

**Implication:** the periodic_summary_hook + re-extraction cron is the one part of the pipeline that's working end-to-end on real users (the team). When real Edge attendees arrive May 30, this loop will run for them too.

---

## Reordered §5.2 priorities

Original order from the competitive research PRD §5.2:

1. ~~Live Activity Dashboard~~
2. Mutual-threshold calibration
3. Index Network adapter decision
4. V2 negotiation merge to main
5. Memory backup cron
6. Cohort + research export

**New order, with rationale:**

| # | Item | Why this order | Effort |
|---|---|---|---|
| **1** | **Outcome ingest migration + write path** (Findings 1 + 6) | Foundational — without this, no number we measure for the rest of Edge has ground truth. Includes the `match_engine` column gap fix. | 1.5 days |
| **2** | **V2 negotiation merge to main + fleet rollout** (Finding 3) | Canaries are clean. Need this firing before Edge so the architectural claim "agents talk to each other" is demonstrable. | 1 day |
| **3** | **Fix `ack_channel` writeback bug** (Finding 4) + add `deliberation_started_at/completed_at` (Finding 5) | Two small data-quality fixes that enable real measurement of Q2 (latency) and Q4 (delivery channel attribution). | 0.5 day combined |
| **4** | **Live Activity Dashboard** | Moved from #1 to #4. Without outcome ingest (#1) it shows counters without value. With outcome ingest, it shows the full funnel: 30 intros sent → 25 ack'd → 18 user-accepted → 12 met → 8 reported valuable. THAT is the screenshot. | 2 days |
| **5** | **Mutual-threshold calibration** | Now possible (requires outcome data from #1). Will likely happen during Edge week 1 against real-user signal, not against the team's test data. | 0.5 day once data flows |
| **6** | **Cohort assignment + research export pipeline** | Vendrov dependency, May 22 deadline. | 3 days |
| **7** | **Memory backup cron** | Trust narrative artifact. Defer to week 4 if other items slip. | 2 days |
| **8** | **Index Network adapter** | Deferred per Cooper's May 11 decision (Privy/wallet divergence in PRD §2.1). | 0 days now; 2 days when Index resolves identity |

**Total critical-path effort:** ~10–11 days. 19 days available. Buffer ~45%.

---

## Index-integration insurance — preserved from Cooper's directive

The provider router in foundation PRD §8 stays intact. Everything I'm proposing above is Index-compatible. Concretely:

- `matchpool_outcomes` migration includes `match_engine TEXT NOT NULL` per PRD §6.1 spec — Index outcomes will flow into the same table.
- `match_engine` column added to `matchpool_deliberations`, `agent_outreach_log`, `matchpool_intros` — all three become Index-attributable when the adapter ships.
- The `INSTACLAW_MATCH_PROVIDER` env-var router pattern is untouched. Default stays `instaclaw`.
- The `route_intent` wire format is unchanged. The adapter (§8.2 of foundation PRD) translates between our shape and Index's `/v1/signals` shape — no schema change required when we eventually ship it.
- The dashboard (#4) reads from outcomes by `match_engine` so the same dashboard will work post-Index-flip without modification.

**One Index-specific risk I'm flagging now:** if Index Network's `respond_to_negotiation` MCP tool ever fires for a user's agent, where does that outcome land in our schema? The cleanest answer: write the negotiation result back to `matchpool_intros` (with `match_engine = 'index'`) on the agent's next pipeline cycle. This requires (a) the agent's pipeline calling Index's `get_negotiation` MCP method, (b) writing the result back to our DB. Not blocking today; document the requirement for when the adapter ships.

---

## What I'm NOT recommending

- **Don't build a separate `index_outcomes` table.** The provider router lives at the engine layer, not the schema layer. One outcomes table with `match_engine` discriminator is the right shape.
- **Don't add an "Index Network bridge" cron right now.** Until Seref's team resolves the Privy/wallet divergence, adding any code that reads from their endpoints is wasted work that may need rewriting.
- **Don't redesign the wire format to be A2A-compatible right now.** The competitive research PRD's V3 roadmap targets July for that. Pre-Edge it would distract.
- **Don't try to fix the 8-user pool size by building outreach to recruit non-team users to Consensus.** Consensus is over. The cohort that matters is Edge Esmeralda's 500-1000 attendees, and that's a marketing/sales question, not an engineering one.

---

## Open questions for Cooper

| # | Question | Recommendation |
|---|---|---|
| A | Should `matchpool_outcomes` follow the PRD §6.1 schema verbatim, or should we adopt research.match_outcomes' shape (signal-id based)? | **PRD §6.1 verbatim.** Foundation PRD's shape is request-based, aligns with our existing wire format, and is what every other table joins against. The research-export view can join across both. |
| B | The 19 days of Edge runway are the FIRST real validation event. Should we treat it as such — instrument extensively, expect to tune mid-event — or treat it as a production launch? | **First real validation event.** Wire outcome ingest + dashboard + per-day Vendrov data exports. Accept that the 0.55 threshold may be wrong; tune in week 2 with real data. Don't pretend we have answers from 8 insiders. |
| C | Cooper directly asked: should I now start the Live Activity Dashboard? | **Defer dashboard 1-1.5 days until outcome ingest ships.** Then build dashboard against real columns. Otherwise I build a dashboard with mock counters that gets refactored when outcomes land. |

---

## Recommended next concrete action

Ship the outcome-ingest migration (Finding 1 + 6 combined). One migration file, four columns added across three tables, one new table created with the PRD §6.1 shape including `match_engine`. ~1.5 days.

After that: V2 merge (Finding 3, 1 day) + ack_channel + deliberation-latency fixes (Findings 4+5, 0.5 day combined) = 1.5 days.

Total before dashboard: 3 days. Then 2 days for the dashboard built against real outcome data, which is a much better marketing artifact than counters.

**Final framing:** the production audit didn't break the architecture. It revealed a piece that was specified but never implemented. The 3-layer pipeline is still novel; we just can't *prove* it's novel until the feedback loop is closed. That feedback loop is now the highest-leverage thing we ship in the next 19 days.

---

*Audit complete. 5 scripts in `instaclaw/scripts/_*` for reproducibility. Ready to commit.*
