# Edge Esmeralda 2026 — Pre-Registered Research Protocol

**Status:** TEMPLATE. Vendrov + Cooper finalize sections marked `[VENDROV]` before May 22, 2026 lock.
**Pre-registration target date:** 2026-05-22 (per Edge strategy doc §13).
**Public publication target:** 2026-05-23 (pre-village).
**Companion documents:**
- `instaclaw/docs/prd/edgeclaw-partner-integration.md` — Section 4.10 (research instrumentation)
- `instaclaw/docs/prd/edge-city-strategy-2026-05-03.md` — §11 (success criteria)
- `instaclaw/lib/research-export/cohort-assignment.ts` — cohort assignment policy (code-level source of truth)

---

## 0. Summary

This document pre-registers the experimental protocol for the Edge Esmeralda 2026 Agent Village field deployment (May 30 – June 27, 2026, Healdsburg CA). It locks the hypotheses, the cohort assignment policy, the data-collection plan, and the analysis plan **before any data is collected**, so the village functions as a confirmatory study rather than an exploratory one.

The Agent Village deploys per-user AI agents (InstaClaw runtime) tethered to ~500 Edge attendees for 28 days. The agents conduct overnight matching and morning intro briefings. Each agent has weeks of conversation memory with its human and deliberates per-candidate via Anthropic Claude. Treatment-control cohorts isolate the causal contribution of agent-mediated matching vs. baseline.

---

## 1. Hypotheses `[VENDROV]`

Five hypotheses. Each is a pre-registered, independently-tested claim with a treatment cohort and a control cohort drawn via consistent-hash partition from the village population.

### H1 — Matching engine surfaces connections attendees would otherwise miss

> **H1:** Attendees in the `h1-treatment` cohort (matching engine active) report a higher rate of "best connection of the village was agent-facilitated" than `h1-control` (matching engine inactive) at the end-of-village survey.

- Predicted direction: treatment > control
- Target effect size: ≥ 20-percentage-point lift in best-connection-attribution rate
- Pre-registered analysis: two-sample proportion test (Fisher exact), α=0.05, one-sided

### H2 — Norm formation under repeated agent interaction `[VENDROV]`

> *Vendrov to specify. Likely structure: do agents that repeatedly interact with each other develop pro-cooperative norms?*

### H3 — Coasean bargaining at scale `[VENDROV]`

> *Vendrov to specify. From Edge strategy doc: agent-mediated negotiation reduces transaction costs of multi-party coordination.*

### H4 — Agent autonomy levels affect human trust `[VENDROV]`

> *Vendrov to specify. Treatment varies how autonomously the agent acts on the user's behalf; control is "ask first" for every decision.*

### H5 — Deliberation broadens > deepens `[VENDROV]`

> *Vendrov to specify. From Edge strategy doc PRD §4.10: agent-mediated deliberation broadens participation more than it deepens individual engagement.*

---

## 2. Cohort assignment policy

### 2.1 Mechanism

Consistent-hash partition on the user's Bankr wallet address (a stable identifier each attendee receives at signup). For each experiment, the cohort assignment is:

```
cohort_idx = HASH(experiment_id + ":" + lower(bankr_wallet)) mod bucket_count
cohort     = experiment.cohorts[cohort_idx]
```

Where `HASH` is SHA-256 (first 32 bits taken as a uint32). Implementation: `instaclaw/lib/research-export/cohort-assignment.ts:assignCohort()`.

**Why this mechanism:**

- **Deterministic.** Re-running the assignment produces identical results. No central-randomness state to lose.
- **Independent per experiment.** Salting by `experiment_id` decorrelates assignments — a user's `h1` cohort tells you nothing about their `h2` cohort. Critical for the independence assumption of Vendrov's analyses.
- **Approximately uniform.** Over a 500-attendee pool, each cohort gets ~250 ± expected sampling noise.
- **Adversary-resistant** (modulo): an attendee cannot trivially game the assignment by choosing their Bankr wallet because each experiment uses a different salt — they'd have to brute-force pick a wallet that lands in the desired cohort across all 5 experiments simultaneously, which is computationally non-trivial.
- **Manually overridable.** `research.cohort_assignments` has `UNIQUE(bankr_wallet, experiment_id)`. The auto-assigner uses `ON CONFLICT DO NOTHING`, so Vendrov can pre-populate any specific assignment and the script respects it.

### 2.2 Pre-registered experiments

Locked at pre-registration time. Adding experiments after this point requires a separate amendment (which we publicly publish).

| `experiment_id` | Cohorts | Hypothesis |
|---|---|---|
| `ee26-h1-matching` | `h1-treatment` / `h1-control` | H1 — matching surfaces missed connections |
| `ee26-h2-norms` | `h2-treatment` / `h2-control` | H2 — norm formation under repeated interaction |
| `ee26-h3-coasean` | `h3-treatment` / `h3-control` | H3 — Coasean bargaining at scale |
| `ee26-h4-autonomy` | `h4-treatment` / `h4-control` | H4 — agent autonomy ↔ human trust |
| `ee26-h5-deliberation` | `h5-treatment` / `h5-control` | H5 — deliberation broadens > deepens |

Cohort definitions: `instaclaw/lib/research-export/cohort-assignment.ts:EE26_EXPERIMENTS`.

### 2.3 Pre-registration of assignment timing

- Assignments locked at: **end of day 2026-05-22**, before any matching engine activity that would influence outcomes.
- Mechanism: run `npx tsx scripts/_assign-cohorts.ts --apply` after Vendrov's final hypothesis lock. Output written to `research.cohort_assignments`.
- Late arrivals (attendees who sign up after May 22): assigned automatically by the script on next run. Their cohort is determined by the same hash, so it's the cohort they would have had if assigned on May 22.

---

## 3. Data collection plan

### 3.1 Tables collected

Per `instaclaw/docs/prd/edgeclaw-partner-integration.md` Section 4.10.3, five anonymized tables in the `research.*` schema:

| Table | Source | Description |
|---|---|---|
| `research.agent_signals` | Index Network (when integrated) | Nightly availability signals |
| `research.match_outcomes` | `public.matchpool_outcomes` (bridge writer) | Per-match outcome funnel |
| `research.briefing_outcomes` | TBD | Morning briefing composition + human response |
| `research.governance_events` | Per-proposal | Governance participation |
| `research.cohort_assignments` | `_assign-cohorts.ts` | This document's assignments |

### 3.2 Anonymization

All wallet addresses replaced with `HMAC-SHA-256(wallet, EDGE_CITY_RESEARCH_SALT)` truncated to 16 hex chars before any data leaves Supabase. Free-text fields (rationale, conversation_topic, reason_text) PII-swept against:

- Common-name lookups
- Email addresses (regex)
- Phone numbers (regex)
- Wallet addresses (regex)
- Telegram/Twitter/Farcaster handles (regex)

Implementation: `instaclaw/lib/research-export/anonymize.ts`. Redaction events logged to `redactions.jsonl` for 1% manual spot-check.

### 3.3 Salt rotation

`EDGE_CITY_RESEARCH_SALT` rotated 7 days post-village close. After rotation, the existing anonymized exports become structurally non-reidentifiable. Vendrov retains the data; InstaClaw retains no linkage.

---

## 4. Analysis plan `[VENDROV]`

For each hypothesis, specify:
- Primary outcome metric (one)
- Secondary outcome metrics (any number, registered here)
- Statistical test (specific)
- Significance threshold (α, typically 0.05)
- Multiple comparison correction (if running multiple tests)
- Pre-specified subgroup analyses (if any)

*Vendrov to fill in. Anything not pre-specified here is exploratory and labelled as such in the final paper.*

---

## 5. Exclusion criteria

Attendees excluded from per-hypothesis analysis:
- Those who never installed an InstaClaw agent (no `matchpool_profiles` row)
- Those who set `consent_tier = 'hidden'` (opted out of pool)
- Those who registered after the village mid-point (June 13) — insufficient observation window
- Those flagged for moderation issues during the village (small N expected; full list published in addendum)

Attendees included in attendance/dropout analyses (intent-to-treat): everyone with a `research.cohort_assignments` row.

---

## 6. Stopping rules

No interim analyses planned. Data analysis begins post-village (after June 27) on the locked anonymized export.

If a critical bug in the matching engine is discovered mid-village (e.g., a privacy leak), the matching engine may be paused. In that case, all data from the pause window is flagged in the export and analyses note the discontinuity.

---

## 7. Publication commitments

- **Pre-registration:** This document published publicly at `[URL]` on `2026-05-23`.
- **Anonymized dataset:** Published 30 days post-village close (≈2026-07-27) under [LICENSE TBD] at `[URL]`.
- **Primary findings paper:** Submitted by Vendrov to a peer-reviewed venue with InstaClaw as data-provider co-author. No pre-publication NDA.
- **Null results:** Will be published with the same prominence as positive results. We do not suppress non-significant findings.

---

## 8. Conflicts of interest

- **InstaClaw** (Cooper Wrenn) operates the matching engine being studied. Has commercial interest in positive results.
- **Edge City** (Timour Kosters, Stephanie He) hosts the village. Has community-building interest in any signal (positive or negative) about agent-mediated coordination.
- **Vendrov** (Ivan Vendrov) is the research lead. Independent academic stake.

The analysis plan above is pre-registered specifically to prevent COI from influencing the analytic choices. Vendrov has unilateral authority to publish findings without InstaClaw or Edge City approval.

---

## 9. Operational artifacts

| Artifact | Location | Owner |
|---|---|---|
| Cohort assignment script | `instaclaw/scripts/_assign-cohorts.ts` | Cooper / engineering |
| Cohort definitions | `instaclaw/lib/research-export/cohort-assignment.ts:EE26_EXPERIMENTS` | locked at preregistration |
| Anonymization library | `instaclaw/lib/research-export/anonymize.ts` | Cooper / engineering |
| Export pipeline | `instaclaw/scripts/_export-research-data.ts` | Cooper / engineering |
| Live activity dashboard | `instaclaw.io/edge-city/plaza` | Cooper / engineering |
| Threshold calibration tool | `instaclaw/scripts/_calibrate-thresholds.ts` | Cooper / engineering |
| This pre-registration | `instaclaw/docs/edge-vendrov-prereg-template-2026-05-30.md` → `[URL]` | Vendrov + Cooper |

---

## 10. Sign-off

- Vendrov: `[NAME, DATE, SIGNATURE]`
- Cooper: `[NAME, DATE, SIGNATURE]`
- Edge City reviewer: `[NAME, DATE, SIGNATURE]`
- (Optional) Independent methodological reviewer: `[NAME, DATE, SIGNATURE]`

---

*End of template. Sections marked `[VENDROV]` to be filled in by 2026-05-22. Document then published publicly and the cohort-assignment script runs against the locked policy.*
