# Consensus 2026 Launch Kit — 2026-05-05

Everything needed to ship the announcement publicly.

---

## Status snapshot

**Infrastructure:** GREEN. vm-780 (@edgecitybot) launch-readiness audit
passes 15/15 checks. The XMTP intro flow has 12/12 edge cases passing,
3-layer delivery guarantee in place, telegram_chat_id backfilled on
3/5 partner VMs, application-layer fallback covers the other 2.

**Blocker (in flight, not owned by this thread):** vm-780 is returning
"insufficient balance (1008)" from the InstaClaw billing proxy on every
chat completion. ~105 occurrences in the last 2h journal. **gbrain is
investigating.** Real user-facing tests (sending "I'm at consensus" to
@edgecitybot and watching the agent respond) are blocked until that
clears. Everything else (matching pipeline, XMTP intro flow, Telegram
delivery) is independent of the chat-completion path and works.

---

## Tweet thread — final copy (no em-dashes, CT-native, founder energy)

### Main tweet (the hook — pure problem + value + link, no how-to)

```
18,000 people at consensus. you'll meaningfully meet maybe 12.

we built an AI agent that fixes this. live right now in miami.

instaclaw.io/consensus
```

### Reply 2 (event intelligence)

```
your agent knows the entire program.

every talk, every speaker, every side event across all 3 days. ask "what should i hit thursday afternoon?" or "anyone good on restaking today?" and it answers with specific times and stages.

stop reading the schedule. just ask.
```

### Reply 3 (matching, ongoing)

```
then it finds your people.

every 30 min for the next 3 days it scans the attendee pool and surfaces fresh matches based on what you're actually building. not "you both like crypto." real context from how you talk to it.

new matches all weekend, not a one-shot list.
```

### Reply 4 (activation + CTA)

```
turning it on is dead simple.

just tell your agent "i'm at consensus" and it'll ask if you want to switch on the skill. say yes. done.

prefer clicking? dashboard → Skills & Integrations → Live Events → toggle Consensus 2026 on.

instaclaw.io/consensus
```

---

## Screenshots needed

Cooper to capture these for the announcement (in order of priority):

### Tier 1 — must-have for the main thread

1. **`/consensus/my-matches` rendered with real top-3.** Cooper's
   browser, real account. Shows: 3 attendee cards, rationale per match,
   "Talk about" + "Possible window" fields, "I sent you the full read
   in chat at..." stamp at the top. **Why:** primary product proof.

2. **Telegram intro received from another agent.** Cooper's @edgecitybot
   chat, showing the auto-forwarded intro from a matched user's agent.
   Should look like: *"Cooper Wrenn's agent reached out about meeting
   up at Consensus this week..."* + topic + window + "Reach out: @bot
   on Telegram (their agent will relay)."  **Why:** proves the
   agent-to-agent demo. Most viral artifact.

3. **Agent responding to "I'm at consensus" with the activation offer.**
   Telegram chat with @edgecitybot. User types *"I'm at consensus"*,
   agent replies offering to switch on the skill. **Why:** matches the
   activation copy in the tweet thread.

### Tier 2 — nice-to-have for the reply chain or follow-up posts

4. **Skills & Integrations page showing "Live Events" category with
   Consensus 2026 toggle ON.** Highlights the dashboard activation path
   from Reply 4. Mac browser at instaclaw.io.

5. **Agent answering a session-intel question.** Telegram chat showing
   Cooper asking *"what talks should i hit today?"* and the agent
   responding with specific times + stages (per Reply 2 copy).

6. **Pipeline log line on a partner VM** (terminal screenshot). Shows
   `pipeline.outreach status=sent log_id=...` followed by
   `pipeline.intros_poll polled=N new=M`. Engineering audience material.

### Tier 3 — for blog post / extended write-up only

7. The `agent_outreach_log` row in Supabase showing a real intro that
   landed via Telegram with `ack_channel='telegram'`.
8. The pending-intros.jsonl file showing graceful fallback delivery.
9. `consensus_match_pipeline.py --force` output trace showing all
   four steps (layer1 → rerank → deliberate → post → outreach).

---

## Pre-announcement checklist

Cooper to confirm each item before the main tweet goes out:

- [ ] gbrain has resolved the 1008 billing error on vm-780.
- [ ] Cooper has tested "I'm at consensus" → @edgecitybot end-to-end.
- [ ] At least one real intro has fired from vm-780 to a partner VM
      and landed in the receiver's Telegram (verifiable via
      `agent_outreach_log` ack_channel='telegram').
- [ ] /consensus/my-matches loads cleanly for Cooper's account.
- [ ] Tier-1 screenshots captured.
- [ ] All 5 partner VMs healthy (run
      `npx tsx scripts/_check-vm780-launch-readiness.ts` and similar
      ad-hoc on the 4 edge_city VMs).

---

## What's live right now (technical receipts)

For anyone asking "is this real or vapor?":

- **/consensus** marketing page: live at instaclaw.io/consensus
- **/consensus/my-matches** UI: live, renders real data from
  `matchpool_cached_top3` + `matchpool_deliberations`.
- **Three-layer matching pipeline**: Postgres pgvector RRF retrieval
  (Layer 1) → on-VM listwise rerank with full SOUL.md anchor (Layer 2)
  → on-VM per-candidate deliberation (Layer 3). Runs every 30 min.
  PRD: `docs/prd/consensus-intent-matching-2026-05-04.md`.
- **Agent-to-agent intro flow over XMTP** (V3 MLS): when the matching
  pipeline's top-1 changes, the sender's agent DMs the receiver's
  agent with a structured envelope. The receiver verifies the sender
  via the API ledger, then forwards a Telegram intro to its human.
  Three independent delivery channels (Telegram, XMTP-user channel,
  pending-intros.jsonl recovery file). Worst-case latency 30 min.
- **5 partner VMs already running this**: 4 Edge City users +
  vm-780 (Cooper / consensus_2026). Manifest unchanged for the
  fleet — out-of-band deploy keeps blast radius tight for week 1.

---

## Talking points (for replies / threads / DMs)

- **"How is this different from Lu.ma matching?"** Lu.ma matches on
  registration form fields. Our agent has actually been talking with
  the user for weeks/months — it knows what they're stuck on, who
  they've already met, what they're actually building. The match is
  conversation-grounded, not form-grounded.

- **"Is the agent reading my chats?"** Three-tier consent. Tier 1
  (interests) is opt-in default. Tiers 2 (engagement) and 3 (full
  context) require explicit user toggle. PRD enforces no leakage —
  Layer 3 deliberation runs on the user's own VM, never on the server.

- **"How do agents actually talk to each other?"** XMTP V3 (the same
  MLS protocol World Chat uses). Each VM has its own EVM keypair.
  Cross-agent DMs use a structured envelope the receiver verifies
  against the server ledger before surfacing.

- **"What if the demo breaks at the conference?"** Three-layer fallback
  — XMTP delivery, sender retry, server-poll. Even if XMTP transport
  fails entirely, the next pipeline cycle (within 30 min) will surface
  the intro on the receiver's VM via the polling endpoint. We have
  receipts: 12/12 edge cases pass on real infrastructure.

---

## Post-announcement watch list

In the first 24h after the main tweet drops:

1. **Watch `agent_outreach_log` for ack_received_at populated rows.**
   Each one is a successful intro → user surface. Quote-tweet-worthy
   if a real attendee replies "this just happened to me, mind blown."

2. **Monitor 1008 errors fleet-wide.** If gbrain's fix is partial,
   it could re-surface on other VMs.

3. **`instaclaw.io/consensus` traffic.** If the main tweet hits, watch
   for signup conversion via `/api/partner/tag` POSTs.

4. **Agent activation rate.** Users typing "I'm at consensus" → toggle
   accepted. If the activation copy isn't landing, iterate the prompt
   in the consensus-2026 SKILL.md (no manifest bump needed — skills
   pull from the repo every 30 min).
