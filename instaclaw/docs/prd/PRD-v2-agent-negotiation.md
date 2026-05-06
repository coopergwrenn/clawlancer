# PRD: v2 Agent-to-Agent Negotiation over XMTP

**Status:** Draft, ready for review
**Author:** Cooper + Claude
**Date:** 2026-05-05
**Target ship:** post-Consensus 2026 (week of 2026-05-12)
**Dependencies:** v1 intro flow (live in production)

---

## 0. TL;DR

v1 ships a one-way intro: agent A picks a match, DMs agent B, agent B forwards a Telegram intro to its human, human decides what to do out of band.

v2 turns this into a real negotiation. Agent A proposes a meeting (specific time/place windows). Agent B's user gets the proposal in Telegram with "accept / counter / decline" options. User replies; B's agent fires the appropriate envelope back. If A's user countered, A's user gets the same options. Both humans converge on a confirmed meeting in 1-3 turns, never having to do scheduling back-and-forth themselves.

**Locked decisions for v2.0:**
- Five envelope types: PROPOSE, COUNTER, ACCEPT, DECLINE, CANCEL.
- Hard turn cap: 3 envelopes per thread (last turn must be terminal — no second counter).
- Always PRESENT_TO_USER. The agent never autonomously accepts on the user's behalf in v2.0. The user makes the choice; the agent executes.
- Free-text `instaclaw_users.availability` field. The LLM interprets it against proposed windows. Structured calendar deferred to v2.2+.
- 1-hour USER_CANCEL grace window after ACCEPTED.
- 24-hour thread expiry on inactivity.
- v2.1 adds autonomous accept as a **user-controlled opt-in** (dashboard toggle OR conversational "auto-accept above 0.85" command), never a default.

This PRD specifies the protocol, data model, API surface, code changes, phased rollout, and risk register.

---

## 1. Background

### 1.1 What v1 already does (in production at Consensus 2026)

Single-shot intro flow. Wire format: `[INSTACLAW_AGENT_INTRO_V1]` envelope, JSON header + prose body. Sender's pipeline fires on top-1 change, server-side reserve in `agent_outreach_log`, local mjs sends XMTP DM, receiver's mjs verifies via `/api/match/v1/identify-agent`, forwards to Telegram via `notify_user.sh`, ACKs back. Three-layer at-least-once delivery (XMTP → sender retry → server-poll fallback). Per-sender 20/24h rate limit + per-receiver 3/24h cap.

Verified working end-to-end in production: log_id `458a5938-cd78-47f5-8c02-758b2f804342`, vm-780 → vm-354, 1.77 second wall clock, ack_channel='telegram'.

### 1.2 What's missing for v2

v1 produces an intro. v2 produces a confirmed meeting. The gaps from research:
- No conversation threading — one log_id per intro.
- No state machine — only `pending → sent → ack`.
- No agent decision-making at receive-time — the mjs is a router, not a decider.
- No user calendar / availability primitive.
- No human-override pathway after agent action.
- No loop prevention for multi-turn exchanges.

### 1.3 Hard constraints from existing system (non-negotiable)

These are the rules v2 must respect or break production:

1. **The mjs cannot call Anthropic directly.** No `sk-ant-` key on disk. All LLM calls route through the gateway proxy.
2. **Idempotency is required everywhere.** XMTP V3 store-and-forward delivers duplicates across reconnects.
3. **No silent drops.** Every received envelope either gets handled or stored to disk for later.
4. **Receiver verifies via server.** Sender authenticity is established by the server checking `agent_outreach_log` (or in v2: `negotiation_messages`) ledger row.
5. **OpenClaw isolation respected.** Agents do not directly DM arbitrary humans; the chain stays `agent → XMTP → agent → user's own bot → user`.
6. **No-loop guard.** No auto-reply on gateway error. v2 multi-turn exchanges need explicit termination conditions.
7. **Kill-switch must work.** `CONSENSUS_INTRO_FLOW_ENABLED=false` already gates v1; v2 reuses the same flag (with optional v2-specific extension).

---

## 2. Goals + non-goals

### 2.1 Goals (v2.0)

- Agent A's pipeline fires PROPOSE with N candidate windows, B's user sees a proposal with "accept / counter / decline" options.
- B's user replies via Telegram, agent fires appropriate envelope back.
- If COUNTER: A's user sees the counter with "accept / decline" options.
- After 1-3 turns, both humans get a Telegram confirmation with the agreed window.
- 100% of agent moves require user input. No autonomy in v2.0.
- Backwards compat: v1 INTRO_V1 envelopes still work. Receivers ignore unknown markers; v1 senders → v1 receivers, v2 senders → v2 receivers.

### 2.2 Non-goals (deferred to v2.1+)

- **Autonomous accept** by agent without user input. v2.1 — opt-in only.
- **Structured calendar** with conflict detection. v2.2 — free-text in v2.0.
- **Group meetings** (3+ parties). v2.3 — pairwise only.
- **Real-time co-presence indicators** ("B is typing..."). v2.3.
- **Re-negotiation after EXPIRED**. The user can manually re-fire by triggering a fresh PROPOSE (new thread_id).
- **Cross-event negotiations.** Scope is Consensus 2026 first; generalize after.
- **Counter-counter (more than 1 counter per thread).** Forbidden by the 3-turn cap. If the agents truly can't converge, the LAST turn forces a terminal (DECLINE or accept stale window).
- **Trust scores for repeat negotiators.** v2.4+.

---

## 3. Protocol spec

### 3.1 Envelope wire format

One new marker. Receivers detect it the same way they detect `[INSTACLAW_AGENT_INTRO_V1]` today:

```
[INSTACLAW_AGENT_NEGOTIATION_V2]
{"v":2,"type":"...","thread_id":"...","turn":N,"from_xmtp":"0x...","from_user_id":"...","from_name":"...","payload":{...}}
---
<receiver-facing prose>
```

Same structure as v1: marker line, JSON header on one line, separator `---`, multi-line prose body. Total cap: 8000 bytes (existing mjs listener limit). Telegram caps at 4000.

The `type` field differentiates envelope subtypes. The `thread_id` groups all envelopes in one negotiation. The `turn` field enforces ordering and the 3-turn cap.

### 3.2 Five envelope types

#### 3.2.1 PROPOSE (sender → receiver, turn 1)

Sender's pipeline fires this on a top-1 change with full deliberation (same trigger as v1 INTRO).

```json
{
  "v": 2,
  "type": "propose",
  "thread_id": "<uuid>",
  "turn": 1,
  "from_xmtp": "0x...",
  "from_user_id": "<uuid>",
  "from_name": "Cooper Wrenn",
  "from_telegram_handle": "cooperwrenn",
  "from_telegram_bot_username": "edgecitybot",
  "from_identity_wallet": "0x...",
  "payload": {
    "topic": "Cross-cohort agent rollout",
    "rationale": "First-person agent voice explaining why these two should meet.",
    "proposed_windows": [
      "Wed 3-5pm at Aria espresso bar",
      "Thu 11am-1pm at attendee lounge"
    ],
    "deliberation_score": 0.78
  }
}
---
<receiver-facing prose>
```

Constraints:
- 1-5 proposed windows.
- `deliberation_score` is the L3 deliberation result, 0.0-1.0. Used by v2.1's autonomy gate (always passed through; just unused in v2.0).
- `proposed_windows` are free-text strings; the LLM on the receiver side interprets against the receiver's free-text availability.

#### 3.2.2 COUNTER (receiver → sender, turn 2)

The receiver's user (via their agent) proposes a different window.

```json
{
  "v": 2,
  "type": "counter",
  "thread_id": "<same uuid>",
  "turn": 2,
  "from_xmtp": "0xB",
  ...,
  "payload": {
    "counter_window": "Thu 4-5pm at Aria",
    "counter_topic": null,
    "user_facing_reason": "Wed I'm in a session, but Thursday 4pm at Aria works."
  }
}
---
<sender-facing prose>
```

Constraints:
- Exactly 1 counter window.
- `counter_topic` optional (lets the receiver re-scope the conversation, e.g. "yes but let's talk about X instead").
- `user_facing_reason` is required — the original sender's user sees this so they understand why a different time was suggested.

#### 3.2.3 ACCEPT (terminal, sent by responder)

Confirms a specific window. Either turn 2 (B accepting A's proposal as-is) or turn 3 (A accepting B's counter).

```json
{
  "v": 2,
  "type": "accept",
  "thread_id": "<uuid>",
  "turn": 2 | 3,
  "from_xmtp": "0x...",
  ...,
  "payload": {
    "accepted_window": "Thu 4-5pm at Aria",
    "user_facing_message": "Thursday 4pm at Aria is good. See you there."
  }
}
---
<other party-facing prose>
```

Constraints:
- `accepted_window` MUST exactly match one of the proposed windows from turn 1, OR the counter_window from turn 2. Server validates.
- Terminal state — no further envelopes accepted on this thread except USER_CANCEL within the 1-hour grace.

#### 3.2.4 DECLINE (terminal, sent by responder)

Declines the negotiation entirely.

```json
{
  "v": 2,
  "type": "decline",
  "thread_id": "<uuid>",
  "turn": 2 | 3,
  "from_xmtp": "0x...",
  ...,
  "payload": {
    "decline_category": "scheduling" | "not_interested" | "conflicting_intent" | "other",
    "user_facing_reason": "Calendar's packed this week, sorry."
  }
}
---
<other party-facing prose>
```

Terminal. Notifies the other party with the user-facing reason.

#### 3.2.5 CANCEL (any state, sender or initiator)

Either party retracts. Distinct from DECLINE — CANCEL means "I'm taking back the negotiation," not "I'm rejecting the proposal."

Two sub-flavors, both same envelope type, distinguished by `payload.cancelled_by`:

```json
{
  "v": 2,
  "type": "cancel",
  "thread_id": "<uuid>",
  "turn": 2 | 3 | 4,
  "from_xmtp": "0x...",
  ...,
  "payload": {
    "cancelled_by": "agent" | "user_override",
    "user_facing_reason": "..."
  }
}
```

`cancelled_by: "agent"` — sender's pipeline cancels mid-flight (e.g., user said "stop" before B responded, or the original sender's user explicitly cancelled).

`cancelled_by: "user_override"` — special turn=4 envelope sent within 1h of ACCEPTED state. Only the responder (the one who would have honored the meeting) can send this. Notifies the other party.

### 3.3 State machine

Seven states. Strict alternation between two parties (initiator, responder). Turn cap = 3 envelopes (no fourth, except the user-override cancel).

```
[INIT] -PROPOSE (turn 1, initiator)→ [PROPOSED]

[PROPOSED] -ACCEPT (turn 2, responder)→  [ACCEPTED]      ← terminal
[PROPOSED] -COUNTER (turn 2, responder)→ [COUNTERED]
[PROPOSED] -DECLINE (turn 2, responder)→ [DECLINED]      ← terminal
[PROPOSED] -CANCEL (turn 2, initiator)→  [CANCELLED]     ← terminal

[COUNTERED] -ACCEPT (turn 3, initiator)→  [ACCEPTED]
[COUNTERED] -DECLINE (turn 3, initiator)→ [DECLINED]
[COUNTERED] -CANCEL (turn 3, initiator)→  [CANCELLED]
[COUNTERED] -COUNTER → ❌ REJECTED (server returns 422 "turn cap exceeded")

[ACCEPTED] -USER_CANCEL within 1h (turn 4, responder's user) → [CANCELLED_BY_USER]

[any non-terminal] -no activity 24h (cron) → [EXPIRED]
```

Terminal states: `ACCEPTED`, `DECLINED`, `CANCELLED`, `CANCELLED_BY_USER`, `EXPIRED`.

The state machine is enforced **server-side** (`/api/match/v1/negotiation/respond` validates current state before applying any transition). Clients do not need to be trusted.

### 3.4 Turn invariant

- Turn 1 must be PROPOSE, sent by the initiator.
- Turn 2 must be sent by the responder (the receiver of turn 1).
- Turn 3 must be sent by the initiator (the receiver of turn 2's COUNTER).
- Turn 3 must be terminal (ACCEPT, DECLINE, or CANCEL — never COUNTER).
- Turn 4 is allowed only for USER_CANCEL within the 1-hour grace window from ACCEPTED.

Server enforces all of these via `UNIQUE(thread_id, turn)` constraint + state-transition validator. Client cannot bypass.

### 3.5 Expiry

When a thread sits in PROPOSED or COUNTERED for > 24 hours, it auto-expires. State → `EXPIRED`. Cron `/api/cron/negotiation-expire` runs every 30 min, sweeps expired threads, notifies both parties via XMTP CANCEL envelope (or stores notification for next pipeline cycle if XMTP unavailable).

`expires_at` is reset to `NOW + 24h` on each turn. So an active back-and-forth doesn't expire.

### 3.6 Idempotency anchors

Two layers:

1. **Thread reservation idempotency:** `UNIQUE(initiator_user_id, receiver_user_id, anchor_v2)` on `negotiation_threads`, where `anchor_v2 = "<initiator_pv>:<receiver_user_id>:<topic_hash>"`. Prevents duplicate threads for the same match from the same pipeline cycle.
2. **Per-message idempotency:** `UNIQUE(thread_id, turn)` on `negotiation_messages`. Replays of the same envelope produce 23505 (Postgres unique violation) which the server treats as no-op-success.

Combined, the system is replay-safe end-to-end. Sender retry, XMTP store-and-forward double-delivery, server-poll re-surface — all idempotent.

---

## 4. Data model

Two new tables. `agent_outreach_log` (v1) is unchanged and continues to handle v1 INTRO traffic.

### 4.1 `negotiation_threads`

```sql
CREATE TABLE negotiation_threads (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_user_id       UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  receiver_user_id        UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,

  -- Identity / origination
  initiator_xmtp_address  TEXT NOT NULL,
  receiver_xmtp_address   TEXT NOT NULL,
  initiator_vm_id         UUID REFERENCES instaclaw_vms(id) ON DELETE SET NULL,

  -- Idempotency anchor — prevents duplicate threads for same match
  anchor_v2               TEXT NOT NULL,

  -- Negotiation content (denormalized from PROPOSE for fast reads)
  topic                   TEXT,
  rationale               TEXT,
  proposed_windows        JSONB,  -- ["Wed 3-5pm...", "Thu 11am..."]
  deliberation_score      NUMERIC(4,3),

  -- State machine
  state                   TEXT NOT NULL DEFAULT 'proposed'
                          CHECK (state IN (
                            'proposed','countered','accepted','declined',
                            'cancelled','cancelled_by_user','expired'
                          )),
  current_turn            INT NOT NULL DEFAULT 1
                          CHECK (current_turn BETWEEN 1 AND 4),

  -- Outcome (set on ACCEPT)
  agreed_window           TEXT,

  -- Lifecycle timestamps
  started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  terminated_at           TIMESTAMPTZ,

  CONSTRAINT chk_terminal_has_termination_ts
    CHECK (
      (state IN ('proposed','countered') AND terminated_at IS NULL)
      OR (state IN ('accepted','declined','cancelled','cancelled_by_user','expired')
          AND terminated_at IS NOT NULL)
    ),

  UNIQUE (initiator_user_id, receiver_user_id, anchor_v2)
);

CREATE INDEX idx_threads_active
  ON negotiation_threads (initiator_user_id, state, started_at DESC)
  WHERE state IN ('proposed','countered');

CREATE INDEX idx_threads_active_receiver
  ON negotiation_threads (receiver_user_id, state, started_at DESC)
  WHERE state IN ('proposed','countered');

CREATE INDEX idx_threads_expiry_sweep
  ON negotiation_threads (expires_at)
  WHERE state IN ('proposed','countered');

ALTER TABLE negotiation_threads ENABLE ROW LEVEL SECURITY;
```

Notes:
- `current_turn` lives on the thread for fast "where are we" reads. `negotiation_messages` is the source of truth.
- `anchor_v2` is `<initiator_pv>:<receiver_user_id>:<topic_hash>`. Topic hash is sha256 of normalized topic text, first 8 chars. Prevents re-PROPOSE on top-1 churn.
- The CHECK constraint on `terminated_at` ensures we never have a `state='accepted'` row with NULL `terminated_at` — invariant for the 1-hour grace window calculation.
- Three partial indexes for the hot paths (active threads as initiator, active threads as receiver, expiry sweep).

### 4.2 `negotiation_messages`

```sql
CREATE TABLE negotiation_messages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id               UUID NOT NULL REFERENCES negotiation_threads(id) ON DELETE CASCADE,
  turn                    INT NOT NULL CHECK (turn BETWEEN 1 AND 4),
  envelope_type           TEXT NOT NULL
                          CHECK (envelope_type IN (
                            'propose','counter','accept','decline','cancel'
                          )),

  sender_user_id          UUID NOT NULL REFERENCES instaclaw_users(id),
  sender_xmtp_address     TEXT NOT NULL,

  -- Type-specific payload — see envelope schemas in section 3.2
  payload                 JSONB NOT NULL,

  -- Free-form prose body (what gets sent over XMTP after the JSON header)
  prose                   TEXT,

  -- Delivery state (mirrors v1 outreach pattern)
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sent','failed')),
  retry_count             INT NOT NULL DEFAULT 0,
  last_retry_at           TIMESTAMPTZ,
  ack_received_at         TIMESTAMPTZ,
  ack_channel             TEXT,
  error_message           TEXT,

  sent_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (thread_id, turn)
);

CREATE INDEX idx_msgs_thread_turn ON negotiation_messages (thread_id, turn);
CREATE INDEX idx_msgs_unacked_outbound
  ON negotiation_messages (sender_user_id, sent_at ASC)
  WHERE status = 'sent' AND ack_received_at IS NULL;
CREATE INDEX idx_msgs_unacked_target ON negotiation_messages (thread_id)
  WHERE status = 'sent' AND ack_received_at IS NULL;

ALTER TABLE negotiation_messages ENABLE ROW LEVEL SECURITY;
```

Notes:
- The `UNIQUE(thread_id, turn)` is THE replay-safety primitive. Any duplicate envelope from XMTP store-and-forward, sender retry, or server-poll fallback INSERT-fails with 23505 → server treats as success-no-op.
- Mirrors v1's `agent_outreach_log` retry/ack pattern. Same partial indexes, same hot paths.
- `payload JSONB` keeps the schema flexible per envelope type (covered in section 3.2).

### 4.3 `instaclaw_users` additions

```sql
ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS availability TEXT,
  ADD COLUMN IF NOT EXISTS autonomy_preferences JSONB DEFAULT '{}'::JSONB;

COMMENT ON COLUMN instaclaw_users.availability IS
  'Free-text availability statement. e.g. "free Wed pm, busy Thu 2-4 keynote, prefer espresso bars". The LLM interprets this against proposed windows during /negotiation/decide. Defaults to NULL (= "no stated availability"); the LLM treats this as "always present to user, no autonomy guesses".';

COMMENT ON COLUMN instaclaw_users.autonomy_preferences IS
  'v2.1+ user-controlled autonomy settings. v2.0 defaults to {} (= no autonomy). Schema: {auto_accept_threshold: 0.0-1.0, auto_decline_threshold: 0.0-1.0, scopes: ["consensus_2026", ...]}';
```

Both nullable / default empty. v2.0 doesn't read `autonomy_preferences` at all (always PRESENT_TO_USER).

### 4.4 Migration

`supabase/migrations/20260506a_negotiation_v2.sql` contains all three (the two new tables + the instaclaw_users alter). Idempotent (`IF NOT EXISTS` everywhere).

---

## 5. Architecture

### 5.1 Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│ Sender's VM                              Receiver's VM               │
│                                                                      │
│  consensus_match_pipeline.py                                         │
│  └─ on top-1 change:                                                 │
│     consensus_agent_negotiation.py (NEW)                             │
│       ├─ POST /negotiation/reserve  ─────────┐                       │
│       └─ POST 127.0.0.1:18790/send-intro     │                       │
│            (existing local listener)         │                       │
│                          │                   │                       │
│                          v                   │                       │
│                       XMTP DM                │                       │
│                       v                                              │
│                                       xmtp-agent.mjs                 │
│                                       └─ NEGOTIATION_V2 envelope     │
│                                          ├─ POST /negotiation/decide │
│                                          │   (server orchestrates    │
│                                          │    gateway-proxied LLM,   │
│                                          │    returns PRESENT_TO_USER)│
│                                          ├─ notifyUserOfProposal()   │
│                                          │   (Telegram with options) │
│                                          └─ ACK envelope ←────────── │
│                                                                      │
│                          ↓ user replies in Telegram                  │
│                                                                      │
│                                       OpenClaw gateway               │
│                                       └─ Claude session              │
│                                          ├─ parses intent            │
│                                          └─ calls tool:              │
│                                             instaclaw_negotiation_   │
│                                             user_response            │
│                                             └─ POST /negotiation/    │
│                                                respond               │
│                                                                      │
│                                       ↓ server returns envelope      │
│                                                                      │
│                                       xmtp-agent.mjs                 │
│                                       └─ sends ACCEPT/COUNTER/       │
│                                          DECLINE envelope back       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 Where decisions live

| Decision | Where it happens | Why |
|---|---|---|
| Initial PROPOSE | sender's pipeline cron (existing v1 logic — top-1 change, full deliberation, no cold-start) | Same trigger as v1; no behavior change |
| Should B accept / counter / decline | server-orchestrated LLM via `/api/match/v1/negotiation/decide` | mjs cannot call Anthropic directly (Constraint 1). Server has gateway-proxy access |
| Final user choice | OpenClaw gateway agent (Claude) parses Telegram reply, calls tool | User's reply IS the ultimate authority in v2.0 |
| Server-side state transition | `/api/match/v1/negotiation/respond` validates current state + turn invariant | Trust boundary. Clients cannot bypass turn cap. |
| Thread expiry | Vercel cron `/api/cron/negotiation-expire` every 30 min | Independent of any specific agent |

### 5.3 Why the mjs stays a router

In v2.0, the mjs does NOT make decisions. It:
1. Receives an envelope.
2. Calls `/negotiation/decide` (server returns instruction).
3. If instruction is `present_to_user`: forwards proposal to user via Telegram.
4. ACKs the envelope.
5. Waits for the user's reply (which arrives via the OpenClaw gateway → Claude → tool → server, NOT via the mjs).

This keeps the mjs simple, keeps the LLM call gated behind a server endpoint we can monitor / rate-limit / disable, and matches Constraint 1.

In v2.1, when autonomous accept is enabled, the server's `/decide` endpoint returns `accept` directly (with the chosen window). The mjs then calls `/respond` to commit the transition and sends the ACCEPT envelope. Still no direct Anthropic call from mjs.

### 5.4 API endpoints

All under `/api/match/v1/negotiation/`. All auth via gateway_token Bearer.

#### `POST /reserve`

Sender starts a negotiation. Equivalent to v1's `/outreach phase=reserve`.

Body:
```json
{
  "target_user_id": "<uuid>",
  "anchor_v2": "<pv>:<target_uid>:<topic_hash>",
  "topic": "...",
  "rationale": "...",
  "proposed_windows": ["...", "..."],
  "deliberation_score": 0.78
}
```

Server:
1. Authenticates caller via gateway_token → identifies initiator user/VM.
2. Checks rate-limit (20/24h sender) and per-receiver pending cap (3/24h).
3. Idempotency check on `(initiator, receiver, anchor_v2)` unique constraint.
4. Verifies target has a healthy VM with xmtp_address.
5. INSERTs `negotiation_threads` (state=proposed) + `negotiation_messages` (turn=1, type=propose, status=pending).
6. Returns `{ok, allowed, thread_id, message_id, target_xmtp_address}`.

Response:
```json
{ "ok": true, "allowed": true, "thread_id": "<uuid>", "message_id": "<uuid>", "target_xmtp_address": "0x..." }
```

Or rejected:
```json
{ "ok": true, "allowed": false, "reason": "rate_limited" | "duplicate" | "target_inbox_full" | "feature_disabled" | "no_xmtp_address" }
```

#### `POST /finalize`

Sender's local mjs finished the XMTP send (or failed). Update `negotiation_messages.status`. Mirror of v1 finalize.

Body: `{ message_id, status: "sent" | "failed", error_message? }`

#### `POST /decide`

Receiver's mjs got an envelope, asks the server what to do.

Body:
```json
{
  "thread_id": "<uuid>",
  "envelope_turn": 1 | 2,
  "sender_xmtp_address": "0x..."
}
```

Server:
1. Verifies sender (existing identify-agent logic — `instaclaw_vms.xmtp_address` known + `negotiation_messages` row matches).
2. Loads thread + most recent message.
3. Checks current state allows a response of the given turn.
4. Loads receiver's context: `instaclaw_users.availability` (free text), MEMORY.md head 1KB, recent matches with sender.
5. Checks receiver's `autonomy_preferences`. **In v2.0 always `{}` so we skip autonomous decision and return PRESENT_TO_USER directly.** v2.1 will check thresholds here.
6. Returns instruction:

```json
{
  "ok": true,
  "action": "present_to_user",
  "thread_id": "<uuid>",
  "thread_state": "proposed" | "countered",
  "sender_display": { "name": "Cooper Wrenn", "telegram_handle": "cooperwrenn", ... },
  "proposal_summary": {
    "topic": "...",
    "rationale": "...",
    "proposed_windows": ["..."],  // for PROPOSE-state threads
    "counter_window": "..."        // for COUNTERED-state threads
  },
  "available_actions": ["accept", "counter", "decline"],
  // v2.0: action is ALWAYS present_to_user. autonomous fields below are
  // not populated in v2.0 but the schema is defined for v2.1.
  "autonomous_recommendation": null
}
```

In v2.1, action could be `accept` / `counter` / `decline` directly with `autonomous_recommendation` containing the agent's chosen window + rationale, IF the user has opted in via `autonomy_preferences`.

#### `POST /respond`

A turn is being committed. Either by the agent autonomously (v2.1) or by the user via gateway-side tool (v2.0 default).

Body:
```json
{
  "thread_id": "<uuid>",
  "envelope_type": "accept" | "counter" | "decline" | "cancel",
  "payload": { /* type-specific, see section 3.2 */ },
  "triggered_by": "user" | "agent_autonomous" | "agent_expiry"
}
```

Server:
1. Auth: caller must be either initiator or receiver of the thread.
2. State validation: current state allows this transition? Turn invariant satisfied?
3. Turn cap: if attempting turn=4 with type≠cancel-by-user, 422.
4. INSERT `negotiation_messages` (idempotent on `(thread_id, turn)`). UPDATE `negotiation_threads.state` and `current_turn`. If terminal, set `terminated_at`.
5. Returns the envelope payload to send over XMTP, plus the new state.

Response:
```json
{
  "ok": true,
  "applied": true,
  "new_state": "accepted" | "declined" | "countered" | "cancelled",
  "terminal": true | false,
  "envelope_to_send": { /* full JSON header for XMTP envelope */ },
  "envelope_prose": "..."  // user-facing prose for the other party
}
```

Caller (user's mjs OR sender's pipeline depending on context) takes `envelope_to_send` + `envelope_prose`, builds the wire format, fires XMTP DM via local listener.

#### `POST /user-override`

User-driven actions outside the autonomous path. Used for:
- USER_CANCEL within 1h of ACCEPTED.
- User responding to PRESENT_TO_USER ("accept the wednesday one").
- User explicitly cancelling a still-PROPOSED thread before responder acts.

Body:
```json
{
  "thread_id": "<uuid>",
  "user_action": "accept" | "counter" | "decline" | "cancel",
  "chosen_window": "Thu 4-5pm at Aria",  // for accept
  "counter_window": "...",                // for counter
  "user_facing_reason": "...",
  "originated_from": "telegram_reply" | "dashboard"
}
```

Server: same validation as `/respond` but additionally enforces the 1-hour grace window for post-ACCEPTED cancels. If grace expired, returns `{ok: false, reason: "grace_window_expired", advice: "Direct message {handle} on Telegram instead."}`.

#### `GET /my-threads`

Returns active + recently-terminal threads where caller is initiator OR receiver. Used by:
- Sender's pipeline to find own threads to retry.
- Receiver's pipeline to find unacked inbound proposals (server-poll fallback path).
- `/consensus/my-matches` UI to render the user's negotiation history.

Query params: `?state=proposed,countered&limit=50`.

### 5.5 The `negotiation/decide` LLM prompt (v2.0)

Server constructs:

```
You are {receiver_name}'s personal AI agent. Another agent just proposed a meeting:

  Sender: {sender_name}
  Topic: {topic}
  Rationale: {rationale}
  Proposed windows: {windows[]}
  Deliberation score (sender's confidence): {score}

{receiver_name}'s context:
  Stated availability: {availability_text or "(none stated)"}
  Recent context (last conversation summary): {memory_md_head_1kb}
  Past matches with this sender: {past_matches_list or "none"}

In v2.0, you ALWAYS return action="present_to_user" — autonomy is a v2.1
opt-in feature. Your only job here is to summarize the proposal in a
way that helps {receiver_name} decide.

Return JSON:
{
  "action": "present_to_user",
  "summary_for_user": "<2-3 sentences explaining the proposal in plain
                       language, written as if you (the agent) are speaking
                       to {receiver_name}>",
  "windows_recommendation": "<which of the proposed windows seems to
                             best fit their stated availability, or 'none'
                             if all conflict, or 'unknown' if availability
                             not stated>",
  "potential_concerns": "<flag if you see a conflict with stated
                         availability, or null>"
}
```

The LLM is NOT making the decision in v2.0. It's just helping pre-process the proposal into something the user can act on quickly. The user's reply via Telegram is the actual decision.

### 5.6 The Telegram message sent to the receiver's user (PRESENT_TO_USER)

```
{Sender Name}'s agent wants to meet - they suggest {primary_window}.

Here's why: {rationale_first_sentence}

Want me to:
- Accept {primary_window}
- Counter with a different time
- Decline

Just reply and I'll handle it.
```

Variants:

**Multiple windows proposed** (use the LLM's `windows_recommendation` to pick the primary):
```
Cooper Wrenn's agent wants to meet - they suggest Thursday 4-5pm at Aria.

(Or Wednesday 3-5pm at the espresso bar if Thursday doesn't work.)

Here's why: you're both running agent infrastructure at Consensus,
overlap in matching systems.

Want me to:
- Accept Thursday 4-5pm at Aria
- Counter with a different time
- Decline

Just reply and I'll handle it.
```

**Concern flagged** (LLM saw a conflict):
```
Cooper Wrenn's agent wants to meet - they suggest Wednesday 3-5pm at Aria.

Here's why: ...

Heads up: you mentioned you're booked Wed 4-6pm for the keynote.
Want me to counter with a different time?

Want me to:
- Accept anyway (Wed 3-5pm)
- Counter (e.g., "thu 11am works")
- Decline

Just reply and I'll handle it.
```

**Receiver-side counter** (when A's user gets B's COUNTER):
```
Timour Kosters countered your proposal - they suggest Thursday 4-5pm at Aria instead.

Their note: "Wed I'm in a session, but Thu 4pm at Aria works."

Want me to:
- Accept Thursday 4-5pm
- Decline (no meeting)

Just reply and I'll handle it.

(Note: this is the last round. We can't counter again.)
```

**Terminal accept (notification to both parties):**
```
Confirmed: you're meeting Timour Kosters Thursday 4-5pm at Aria.

You can DM them directly: @timourxyz on Telegram.

Need to cancel? Just say "cancel my meeting with Timour" within
the next hour.
```

**Terminal decline:**
```
Timour passed on the meeting. Their note: "Calendar's packed this week, sorry."

Your matches page has others: instaclaw.io/consensus/my-matches
```

**Cancel-by-user (other party):**
```
Timour cancelled the meeting we set up. They had a conflict.

Want to reach out directly? @timourxyz on Telegram.
```

All variants composed in the receiver's xmtp-agent.mjs from the `/decide` response payload + the relevant LLM-generated `summary_for_user`. No em-dashes (regular dashes), CT-native voice, conversational.

### 5.7 The user-reply parsing path

When the receiver's user types in Telegram: "accept the thursday one" / "counter with friday morning" / "decline":

1. Telegram → bot → OpenClaw gateway → Claude session.
2. Claude has a new tool registered: `instaclaw_negotiation_user_response`. Schema:
   ```json
   {
     "thread_id": "<uuid>",
     "action": "accept" | "counter" | "decline" | "cancel",
     "chosen_window": "<one of the proposed>",
     "counter_window": "<user's alternative>",
     "user_facing_reason": "<why, in user's words>"
   }
   ```
3. Claude looks at `~/.openclaw/xmtp/pending-intros.jsonl` (the agent's view of recent proposals) to resolve which thread the user means.
4. Claude calls the tool. Tool implementation: HTTP POST to `/api/match/v1/negotiation/user-override`.
5. Server validates + applies the transition. Returns the envelope payload.
6. mjs sends the envelope over XMTP.
7. Both users get terminal-state notifications via Telegram.

### 5.8 Tool registration

The new `instaclaw_negotiation_user_response` tool needs to be available in every receiver's gateway. Two options:

1. **OpenClaw native tool**: bake into the OpenClaw gateway tool registry. Requires OpenClaw upstream change. Heavier lift.
2. **MCP server**: ship a tiny MCP server on every VM that exposes the tool. Lighter lift; reuses existing MCP infra.

Recommended for v2.0: **MCP server**. Existing MCP infrastructure on VMs (mcporter), pattern matches dgclaw / bankr skills, no upstream OpenClaw dependency. Spec for the MCP file:

`~/.openclaw/skills/consensus-2026/mcp/negotiation-tool.json` declares the tool. `~/.openclaw/scripts/consensus_negotiation_tool.py` implements the handler — POSTs to `/api/match/v1/negotiation/user-override` with the gateway_token.

The agent's SKILL.md gets a §4: "When the user is replying to a meeting proposal you presented, call instaclaw_negotiation_user_response with their decision."

---

## 6. Walking through the three scenarios

### 6.1 Scenario A: Happy path (PROPOSE → COUNTER → ACCEPT)

T+0s. Cooper's pipeline (vm-780) runs L3 deliberation, picks Timour (vm-354) as top-1. Score 0.78.

T+0s. Pipeline → `consensus_agent_negotiation.py`:
- POST `/negotiation/reserve` with topic, rationale, two proposed windows.
- Server checks rate-limit + cap, INSERTs `negotiation_threads` (state=proposed) + `negotiation_messages` (turn=1).
- Returns `thread_id`, `target_xmtp_address`.

T+1s. Local mjs `/send-intro` → XMTP DM with PROPOSE envelope.

T+2s. Timour's mjs receives. Detects `[INSTACLAW_AGENT_NEGOTIATION_V2]` marker. Calls `/negotiation/decide`.

T+5s. Server orchestrates LLM call. Returns `{action: "present_to_user", summary_for_user: "...", windows_recommendation: "Thu 11am-1pm best fit"}`.

T+5s. Timour's mjs sends Telegram message:
```
Cooper Wrenn's agent wants to meet - they suggest Thursday 11am-1pm at the attendee lounge.

(Or Wednesday 3-5pm at Aria if Thursday doesn't work.)

Here's why: you're both running agent infrastructure at Consensus, overlap in matching systems.

Want me to:
- Accept Thursday 11am-1pm
- Counter with a different time
- Decline

Just reply and I'll handle it.
```

T+5s. Timour's mjs sends ACK envelope back to Cooper. Cooper's user gets a "Sent intro to Timour, waiting on his response" Telegram (sender-side notification, optional).

T+(seconds-to-hours). Timour replies in his Telegram chat: "counter with thursday 4pm at aria — i have a session 11-1."

T+later. Telegram → bot → OpenClaw gateway → Claude session. Claude reads recent pending-intros.jsonl, identifies the Cooper thread, calls `instaclaw_negotiation_user_response` tool with `{thread_id, action: "counter", counter_window: "Thu 4-5pm at Aria", user_facing_reason: "I have a session 11-1."}`.

T+later. Tool POSTs `/negotiation/user-override`. Server validates (state=proposed, transition counter is valid), INSERTs `negotiation_messages` turn=2 type=counter, UPDATEs thread state to countered, current_turn=2.

T+later. Server returns envelope payload. Tool returns success. Claude tells Timour: "OK — countered with Thursday 4-5pm at Aria. Cooper will see it."

T+later+1s. Timour's mjs sends COUNTER envelope to Cooper.

T+later+3s. Cooper's mjs receives COUNTER. Calls `/negotiation/decide`. Server returns `{action: "present_to_user", summary_for_user: "..."}`. Cooper gets Telegram:
```
Timour Kosters countered your proposal - they suggest Thursday 4-5pm at Aria instead.

Their note: "I have a session 11-1."

Want me to:
- Accept Thursday 4-5pm
- Decline (no meeting)

Just reply and I'll handle it.

(Note: this is the last round. We can't counter again.)
```

T+later+more. Cooper replies "yes accept thursday 4." Tool fires `accept` user-override. Server validates (state=countered, turn=3, type=accept allowed), INSERTs turn=3 message, UPDATEs thread state to ACCEPTED, sets agreed_window="Thu 4-5pm at Aria", terminated_at=NOW.

T+later+more+1s. Cooper's mjs sends ACCEPT envelope to Timour. Both users get terminal-state Telegrams:
```
Confirmed: you're meeting Timour Kosters Thursday 4-5pm at Aria.

You can DM them directly: @timourxyz on Telegram.

Need to cancel? Just say "cancel my meeting with Timour" within
the next hour.
```

End state: thread ACCEPTED. Both users have a confirmed plan in Telegram. Agents step out of the way.

Wall clock when both sides actively engaged: 30-60 seconds.

### 6.2 Scenario B: Async receiver offline

Same as Scenario A turn 1: Cooper proposes. Timour's xmtp-agent service is down (VM crashed, network flake, whatever).

XMTP V3 queues the PROPOSE envelope (30-day store-and-forward). `negotiation_threads.state = proposed`. Cooper's user gets a "Sent intro to Timour" Telegram with ETA caveat.

Cooper's pipeline polls `/negotiation/my-threads` each 30-min cycle. Sees thread state still PROPOSED, no ack received. Decides:
- < 15 min old: skip (XMTP is probably still trying).
- 15 min - 24 h: re-fire same envelope (retry path). Same thread_id, same turn=1. Receiver dedups on UNIQUE constraint when it eventually arrives.
- > 24 h: cron expiry kicks in (`/api/cron/negotiation-expire`). Thread → EXPIRED. Both users get a "your proposal to Timour expired without response" Telegram.

If Timour comes back online within 24h:
- mjs reconnects, XMTP delivers queued PROPOSE.
- Standard `/decide` flow runs.
- Standard happy-path scenario from there.

Edge case: **Cooper cancelled while Timour was offline.** Cooper typed "cancel that intro to Timour" hours ago. State → CANCELLED. Timour's mjs comes online, sees PROPOSE in inbox, calls `/decide`. Server checks thread state: CANCELLED (terminal). Server returns `{action: "noop", reason: "cancelled_by_initiator"}`. Timour's mjs notifies Timour: "Cooper sent you an intro yesterday but cancelled it - no action needed."

Worst-case latency: bounded by 24h expiry. After that, Cooper needs to manually re-fire (new thread).

### 6.3 Scenario C: User override mid-negotiation

(With v2.0's PRESENT_TO_USER default, this scenario simplifies — there's never an autonomous accept to "override.")

**Sub-case C.1: User overrides during PROPOSED.** Timour got the PRESENT_TO_USER Telegram, hasn't replied yet. Cooper changes his mind, types "cancel that intro to Timour" in his Telegram bot.

Cooper's gateway → Claude → calls `/user-override` with `action: cancel`. Server validates state=PROPOSED, applies CANCEL transition, INSERTs turn=2 type=cancel, UPDATEs state to CANCELLED.

Cooper's mjs sends CANCEL envelope to Timour. Timour's mjs receives, recognizes CANCEL on a PROPOSED thread, sends Timour a follow-up Telegram: "Cooper took back the proposal he sent earlier. No action needed." Pending PRESENT_TO_USER message in Timour's chat is now stale; agent could optionally edit/delete it (Telegram allows for 48h).

**Sub-case C.2: User cancels post-ACCEPTED within 1-hour grace.** Thread reached ACCEPTED via Scenario A. Confirmation Telegrams sent. 30 minutes later, Timour realizes he double-booked: types "cancel my meeting with Cooper" in his bot.

Tool calls `/user-override` with `action: cancel`. Server checks: `terminated_at` is 30 min ago, < 1h grace window. Allows the transition. INSERTs turn=4 message (the special turn-4 USER_CANCEL slot). UPDATEs state to CANCELLED_BY_USER.

Timour's mjs sends CANCEL envelope (with `cancelled_by: "user_override"`) to Cooper. Cooper gets Telegram: "Timour cancelled the meeting we set up. They had a conflict. Want to reach out directly? @timourxyz on Telegram."

**Sub-case C.3: User tries to cancel post-ACCEPTED outside the grace window.** Same as C.2 but 1h+15min after `terminated_at`. Server returns `{ok: false, reason: "grace_window_expired", advice: "Direct message Cooper on Telegram instead."}`. Timour's agent tells Timour: "It's past the cancel window. Just message Cooper directly: @cooperwrenn."

Server still records the override attempt for forensics (in a small `negotiation_user_overrides` log table — not strictly required for v2.0, but useful for understanding behavior).

---

## 7. Edge cases (not in the three scenarios)

### 7.1 Both agents PROPOSE simultaneously (mutual top-1)

Two threads created (A→B and B→A), each with separate thread_id. Independent state machines. Both could end ACCEPTED, both users get two "confirmed meeting" Telegrams (same person, possibly different times).

**Mitigation:** the PROPOSE reservation gate adds a "soft dedup" check: if the caller already has an active thread (state in proposed/countered) where the other user is the initiator, the new reserve returns `{allowed: false, reason: "mutual_thread_active", existing_thread_id: <uuid>}`. Sender's pipeline logs and skips.

This is best-effort — race conditions can still produce two threads. But the dedup catches the common case.

### 7.2 Agent over-commits (double booking)

Cooper accepts Thursday 4-5pm with Timour (thread #1). Twenty minutes later, Cooper accepts Thursday 4:30pm with Katherine (thread #2, different proposer). Cooper is double-booked.

v2.0 doesn't solve this. The user is the decider — if they accept two overlapping meetings, that's a user choice. The accept-confirmation Telegram could optionally flag "you're already meeting someone Thursday 4-5pm" if the agent detects overlap, but v2.0 ships without that feature.

v2.2+ structured calendar makes this trivially detectable. v2.0 trusts the user to check before accepting.

### 7.3 LLM call timeout

Receiver's mjs calls `/decide`, server's LLM call takes > 60s (function maxDuration). Server returns 504. mjs falls back to a simple PRESENT_TO_USER without the LLM-generated summary — the proposal still gets surfaced, just with default copy ("Cooper's agent wants to meet — they suggest the following windows. Want me to accept, counter, or decline?").

Server also queues a retry for the `/decide` call (cron-based). Next cycle re-runs the LLM call to enrich the data. This is best-effort polish — the user is never blocked on the LLM.

### 7.4 Race: user override during agent-side processing

Sub-case: server is mid-LLM-call for Timour's `/decide` request when Cooper sends CANCEL. By the time Timour's mjs gets the response, the thread is already CANCELLED. mjs does the standard "thread terminal, no action needed" handling.

If the server already returned `{action: "present_to_user"}` and Timour's mjs sent the Telegram before Cooper's CANCEL landed: Timour gets a now-stale "Cooper wants to meet" Telegram followed seconds later by "Cooper took it back." Both come through. Slightly weird UX but not broken.

### 7.5 Mass thread creation by malicious user

Existing rate limit (20/24h sender) + per-receiver pending cap (3/24h) handle this. Same protections as v1 INTRO. Kill-switch (`CONSENSUS_INTRO_FLOW_ENABLED=false`) gates v2 reserves too.

Additional v2-specific abuse vector: an attacker repeatedly counter-proposes nonsense times to waste the original sender's LLM call budget. Mitigation: server rejects COUNTER if the counter_window text fails a basic sanity check (length, contains a time/date pattern, not a URL or javascript). Easy to bypass in adversarial conditions but raises the bar.

### 7.6 Stale thread accumulation

Threads stuck in COUNTERED forever because user A never replies after B's counter. Cron expiry at 24h handles. Both parties get "your negotiation expired" Telegram.

### 7.7 Counter-storm via state-machine bug

Receiver's mjs somehow sends a turn=3 COUNTER (invariant violation). Server's `/respond` rejects with 422 + state-machine reason. mjs falls back to PRESENT_TO_USER with "I'm forwarding this to you to handle directly — the back-and-forth got too long." Fail-safe.

---

## 8. Implementation plan

### 8.1 New files

| File | Purpose | Approx. LOC |
|---|---|---|
| `supabase/migrations/20260506a_negotiation_v2.sql` | Schema | ~80 |
| `lib/negotiation-state-machine.ts` | Transition validator, turn invariant, state predicates | ~200 |
| `lib/negotiation-decision-prompt.ts` | LLM prompt builder for `/decide` | ~150 |
| `lib/negotiation-types.ts` | TypeScript types for envelopes, payloads, states | ~100 |
| `app/api/match/v1/negotiation/reserve/route.ts` | Sender starts a thread | ~150 |
| `app/api/match/v1/negotiation/finalize/route.ts` | Sender's mjs reports send result | ~80 |
| `app/api/match/v1/negotiation/decide/route.ts` | Receiver asks server what to do | ~200 |
| `app/api/match/v1/negotiation/respond/route.ts` | Apply state transition | ~250 |
| `app/api/match/v1/negotiation/user-override/route.ts` | User-driven actions (accept/decline/cancel) | ~200 |
| `app/api/match/v1/negotiation/my-threads/route.ts` | Active threads where caller is initiator or receiver | ~120 |
| `app/api/cron/negotiation-expire/route.ts` | Sweeps expired threads every 30 min | ~120 |
| `scripts/consensus_agent_negotiation.py` | VM-side composer (replaces consensus_agent_outreach for v2 traffic) | ~300 |
| `~/.openclaw/skills/consensus-2026/mcp/negotiation-tool.json` | MCP tool declaration | ~30 |
| `scripts/consensus_negotiation_tool.py` | MCP tool implementation | ~100 |

Total: ~2080 new LOC across 14 files.

### 8.2 Modified files

| File | Change | Risk |
|---|---|---|
| `skills/xmtp-agent/scripts/xmtp-agent.mjs` | New `parseNegotiationEnvelope()`, `handleInboundNegotiation()`, dispatch on type. Keep INTRO_V1 handlers unchanged. | Medium — adds branches to the text handler. New sentinels required (Rule 23). |
| `scripts/consensus_match_pipeline.py` | When `CONSENSUS_NEGOTIATION_V2_ENABLED=true`, fire v2 PROPOSE via consensus_agent_negotiation.py instead of v1 INTRO. | Low — single flag-gated branch. |
| `app/api/match/v1/contact-info/route.ts` | Surface `autonomy_preferences` (always `{}` for v2.0) on the response. | Low — additive only. |
| `consensus-2026/SKILL.md` | New §6: "When user replies to a meeting proposal in their bot, call instaclaw_negotiation_user_response with their parsed intent." | Low — agent-side instruction. |
| `vercel.json` | Add `/api/cron/negotiation-expire` entry, `*/30 * * * *`. | Low. |
| `lib/outreach-feature-flag.ts` | Add `isNegotiationV2Enabled()` reading `CONSENSUS_NEGOTIATION_V2_ENABLED`. Defaults FALSE for v2.0 phased rollout. | Low. |
| `scripts/_deploy-xmtp-intro-flow-partner-vms.ts` | Sentinel updates: `[INSTACLAW_AGENT_NEGOTIATION_V2]`, `parseNegotiationEnvelope`, `handleInboundNegotiation` in mjs. | Low. |

### 8.3 Schema migration

`20260506a_negotiation_v2.sql` (idempotent):
1. CREATE TABLE `negotiation_threads` (with all CHECKs, FKs, indexes, RLS).
2. CREATE TABLE `negotiation_messages` (FK + UNIQUE + indexes + RLS).
3. ALTER TABLE `instaclaw_users` ADD COLUMN `availability TEXT`, `autonomy_preferences JSONB DEFAULT '{}'`.

Cooper applies via Supabase Studio SQL editor. Verify-migrations script will pass once column appears in PostgREST schema cache.

### 8.4 Sentinel discipline (Rule 23)

For each touched file, the deploy script's sentinel array gets new markers that prove the v2 code is loaded. Examples:

- xmtp-agent.mjs: `[INSTACLAW_AGENT_NEGOTIATION_V2]`, `parseNegotiationEnvelope`, `handleInboundNegotiation`, `notifyUserOfProposal`.
- consensus_match_pipeline.py: `consensus_agent_negotiation`, `CONSENSUS_NEGOTIATION_V2_ENABLED`.
- consensus_agent_negotiation.py: `/negotiation/reserve`, `propose_envelope`, `thread_id`.

If the deploy ever writes a stale (pre-v2) version of any of these files, the sentinel grep fails and the deploy refuses to commit the file (per existing Rule 23 guard).

---

## 9. Phased rollout

### 9.1 Phase 0 — code shipped, flag off (pre-launch)

- Apply migration `20260506a_negotiation_v2.sql` in Supabase Studio.
- Push v2 code to main. Vercel deploys. Endpoints live but no traffic (the `CONSENSUS_NEGOTIATION_V2_ENABLED` env var defaults to false).
- Deploy v2 mjs + python scripts to all 5 partner VMs via existing out-of-band deploy script. Sentinel-verified. `instaclaw-xmtp` service restarted.
- v1 INTRO_V1 traffic continues unchanged.

### 9.2 Phase 1 — vm-780 canary (1-2 days)

- Set `CONSENSUS_NEGOTIATION_V2_ENABLED=true` for vm-780 only (per-VM env override on the VM's `~/.openclaw/.env` — NOT a global Vercel env).
- vm-780's pipeline now fires NEGOTIATION_V2 PROPOSE envelopes instead of v1 INTRO_V1.
- Other VMs receive PROPOSE, recognize the v2 marker, run `/decide` flow, surface to user via Telegram. Other VMs' pipelines still fire v1 INTRO when their own pipelines run.
- Run synthetic e2e test suite (parallel to v1's 12-test suite — e.g., happy path, async receiver, user override, expiry, mutual-thread dedup).
- Manual check: Cooper sends a real proposal from vm-780 to a partner VM, walks through the user-reply flow.

### 9.3 Phase 2 — 5 partner VMs (3-5 days)

- Flip the env on all 5 partner VMs.
- Mutual negotiations within partner cohort possible.
- Watch `agent_outreach_log` (v1 traffic should drop) and `negotiation_threads` (v2 traffic should appear).
- Health alert (existing `/api/cron/consensus-intro-health`) extended to query v2 tables and report state distribution.

### 9.4 Phase 3 — opt-in fleet (1 week)

- Toggle in dashboard `/skills` page: "Negotiation Mode" (default OFF).
- Users explicitly opt in.
- v1 INTRO_V1 still default for opted-out users.

### 9.5 Phase 4 — default on (after 1-2 weeks of stable opt-in)

- Default flips. v1 INTRO_V1 deprecated for new traffic.
- v1 receivers still handle their inbox until terminal.
- 30-day later: remove v1 INTRO_V1 sender code. Receivers retain v1 envelope handlers indefinitely for archival robustness.

### 9.6 Kill-switch behavior

- `CONSENSUS_INTRO_FLOW_ENABLED=false` gates v2 `/reserve` AND v1 `/outreach` (single shared flag).
- Future: separate flag `CONSENSUS_NEGOTIATION_V2_ENABLED=false` lets us flip back to v1-only without disabling all outreach.

---

## 10. Risk register

| Risk | Likelihood | Impact | Detection | Recovery |
|---|---|---|---|---|
| LLM `/decide` call exceeds 60s timeout | Medium | Low | Vercel maxDuration error logs | Fall back to default PRESENT_TO_USER copy without LLM summary |
| Mutual proposal storm (A→B + B→A simultaneous) | Low | Low | Server log query for active-thread pairs | Soft dedup at reserve time (existing-active-thread check) |
| Tool registration fails on a receiver VM | Medium | Medium | User reply doesn't trigger response — thread stuck in PROPOSED until 24h expiry | Cron alert on threads stuck > 6h with no message; manual intervention via `/user-override` admin endpoint |
| Race: user override during server LLM call | Low | Low | Server log: state was PROPOSED at LLM-call-start, CANCELLED by transition-time | Server detects state change, returns `noop` to mjs, mjs notifies user "no action needed" |
| Counter-counter via client bug | Very Low | Low | Server-side state-machine validator | 422 returned, mjs falls back to PRESENT_TO_USER |
| Spam: 100 fake threads from a malicious account | Medium | Low | Existing rate limit + per-receiver cap | Kill-switch flips, ban offender |
| Schema cache lag after migration | Low | Medium | Vercel `verify-migrations` script blocks build | Re-trigger build after PostgREST schema refresh (~5 min) |
| Sender retries old PROPOSE for already-CANCELLED thread | Medium | Low | Server returns existing-row info | mjs treats as no-op, no user-facing impact |
| User accepts two overlapping meetings | Medium | Low | (No detection in v2.0) | Defer to v2.2 calendar feature; user resolves out-of-band |
| Tool call from gateway fails (network) | Low | Medium | Tool returns error to Claude | Claude tells user "I tried to record your decision but couldn't reach the server — try again" |

---

## 11. Roadmap

### v2.0 (THIS PRD — target ship week of 2026-05-12)

Everything specified above. PRESENT_TO_USER always. Free-text availability. 5 envelope types. 3-turn cap. 1-hour USER_CANCEL grace.

### v2.1 — User-controlled autonomous accept (planned follow-up)

**Two opt-in activation paths:**

1. **Dashboard toggle**: a section on `/consensus/my-matches` (or `/account/preferences`) lets the user enable autonomy with a slider for the threshold (0.5-1.0). Default OFF. Setting persists to `instaclaw_users.autonomy_preferences.auto_accept_threshold`.

2. **Conversational command**: user tells their agent "auto-accept matches above 0.85 / pause autonomous accepts / disable autonomy." Agent parses intent via gateway, calls a new tool `instaclaw_negotiation_set_autonomy_preferences`. Updates the same DB column. Acknowledges to user.

**Critical: never a default, ever.** A user must take an explicit action — clicking a toggle or saying a sentence — to enable autonomy. The default forever remains PRESENT_TO_USER. Adding a default would erode trust irreversibly.

**Server-side enforcement:**
- `/decide` reads caller's `autonomy_preferences`. If `{}` (default), always returns `present_to_user`.
- If `auto_accept_threshold` is set AND the proposal's `deliberation_score` exceeds it AND the LLM says the proposal cleanly fits availability: returns `accept` with the chosen window.
- All other cases: still `present_to_user`.

**Revocation:**
- User says "stop auto-accepting" / toggle off in dashboard.
- Agent immediately updates `autonomy_preferences = {}`.
- All future `/decide` calls return PRESENT_TO_USER.

**UX safety nets:**
- When an autonomous accept fires, the user gets a Telegram immediately: "I accepted Cooper's proposal autonomously per your settings: Thursday 4-5pm at Aria. You can cancel within 1 hour by saying 'cancel that meeting'." Same 1-hour grace window applies.
- Settings UI shows "Autonomous accepts last 30 days: N" so user sees how often it fires.

### v2.2 — Structured calendar primitive

Replace free-text `availability` with a structured representation: list of `{start_iso, end_iso, status: free|busy, label}`. Rich UI in `/consensus/my-matches` for entering windows. LLM `/decide` reads structured calendar, can mathematically detect conflicts. Enables overlap warnings on accepts.

### v2.3 — Group meetings (3+ parties)

A→[B,C,D] PROPOSE. Each receiver responds independently. Convergence logic at the agent layer. Significant scope — a separate PRD.

### v2.4 — Reputation / trust scoring

User-level signal: "people who accepted intros from this user reported the meeting as useful." Aggregated, anonymized, surfaced as a "trust score" in `/decide`. Uses signed claims pattern from the agent-comms design draft. v2.4 because we need data first.

---

## 12. Open questions — LOCKED

All resolved as of 2026-05-05. Recording for the implementation phase.

1. **Should mutual-PROPOSE dedup at reserve time auto-merge the two threads, or just refuse the second?** ✅ **Locked: refuse + return existing.** Merging is too complex. The second sender's pipeline logs the skip, the existing thread continues normally.

2. **Server cron `/negotiation-expire` cadence: 30 min or hourly?** ✅ **Locked: 30 min.** Matches existing pipeline cadence; tight expiry SLA wins over marginal server-load saving.

3. **MCP tool vs OpenClaw upstream tool?** ✅ **Locked: MCP.** Existing infra, ships in days. v2.2+ may consider upstreaming once protocol stabilizes.

4. **Sender-side notification on PROPOSE sent?** ✅ **Locked: yes.** When the sender's pipeline fires a PROPOSE, the sender's user gets a brief Telegram: *"I sent an intro to {receiver_name}'s agent — waiting on their response."* Closes the loop on the sender side. The user knows their agent did something on their behalf, doesn't have to wait silently for the terminal-state Telegram. Concise (no rationale repeat); the Telegram only fires once per thread (on PROPOSE, not on retries).

5. **`negotiation_user_overrides` audit log table — needed for v2.0 or v2.1?** ✅ **Locked: v2.1.** v2.0 ships without the explicit audit table. The state-machine messages in `negotiation_messages` are sufficient forensic record for v2.0 (all USER_CANCEL transitions land as `cancel` envelopes with `cancelled_by="user_override"` in payload). v2.1 adds the dedicated table when we want richer audit + analytics on user-override patterns.

6. **Gating behavior when target's user has both v1 (INTRO) and v2 (NEGOTIATION) inbox traffic active. Combined or separate cap?** ✅ **Locked: combined v1 + v2.** A target with 2 unacked v1 INTRO rows + 1 active v2 NEGOTIATION thread = 3 total. Cap hit. Cleaner from a user perspective: "you have N intros pending" is one count regardless of protocol version. Implementation: `getPendingIntroCount(target_user_id)` in `lib/outreach-feature-flag.ts` queries both `agent_outreach_log` (where `status='sent' AND ack_received_at IS NULL`) AND `negotiation_threads` (where `state IN ('proposed','countered')`), sums, returns the total. Reserve gate refuses if `total >= cap`.

---

## 13. Success criteria

v2.0 ship-quality bar:

- [ ] All 5 envelope types ship with proper state-machine enforcement.
- [ ] Hard 3-turn cap enforced server-side; verified by edge-case test ("attempt counter on turn 3 → 422").
- [ ] PRESENT_TO_USER fires for every PROPOSE and every COUNTER (zero autonomous moves in v2.0).
- [ ] User reply via Telegram successfully transitions thread (verified: 3 of 3 paths — accept, counter, decline — round-trip through Claude tool).
- [ ] 1-hour USER_CANCEL grace window enforced; post-grace returns explicit "grace_window_expired" with handle fallback.
- [ ] 24-hour expiry cron transitions stale threads, notifies both parties.
- [ ] Mutual-thread dedup at reserve time prevents double-proposal storms.
- [ ] Kill-switch (`CONSENSUS_INTRO_FLOW_ENABLED=false`) gates both v1 and v2 reserves.
- [ ] Phase-1 canary on vm-780 runs the parallel edge-case suite, all green.
- [ ] Phase-2 5-partner-VM rollout deployed with sentinel verification, no v1 regression observed.
- [ ] All 7 hard constraints from research compliance-checked at code review.

v2.0 success bar in production (post-launch):

- [ ] Median PROPOSE → ACCEPT latency under 60s (when both users actively engaged).
- [ ] Zero confirmed cases of unintended autonomous accepts (impossible by design in v2.0 — but watch for bugs).
- [ ] User-override path fires successfully on > 95% of attempts (vs. server returning errors).
- [ ] Thread-state distribution looks healthy: < 20% expired, > 50% reach terminal (accepted/declined).

---

## 14. Appendix: Design decisions and tradeoffs

### A. Why NOT autonomous accept in v2.0

The risk of an autonomous accept gone wrong:
- Cooper signs up at Consensus, agent autonomously accepts a meeting Cooper didn't actually want.
- Cooper sees the confirmation, didn't ask for this, feels his agent is acting against his interests.
- Trust collapse: every future autonomous action is suspect. User disables the agent entirely.

The cost of v2.0 always asking:
- Slightly slower negotiations (depends on how fast users reply).
- The full auto-magical experience deferred to v2.1.

The math: trust takes weeks to build, days to lose. Conservative default is the right call. v2.1 makes it opt-in once we have data on which proposals look auto-acceptable.

### B. Why free-text availability instead of structured calendar

For v2.0:
- Free-text matches user's mental model ("I'm free Wed afternoon, busy Thu morning for keynote").
- LLM does the interpretation work; no UI to build.
- Ship-speed: we can launch v2.0 in 5-7 days with this approach.
- Failure mode is graceful: if availability is empty or ambiguous, agent defaults to PRESENT_TO_USER which is the v2.0 default anyway.

For v2.2:
- Structured calendar is more reliable for autonomous moves.
- Requires UI investment (calendar picker, conflict warnings).
- Worth it once we know users want autonomy.

### C. Why turn cap of 3, not 5 or "no cap"

3 caps the cost of agent-mediated negotiation:
- 1 LLM call per PROPOSE (sender's L3, already exists in v1).
- 1 LLM call per `/decide` (receiver's, server-orchestrated).
- 1 LLM call per second `/decide` if COUNTER fires (sender's response evaluation).

Max 3 LLM calls per thread. At 100 active threads / hour, that's 300 LLM calls / hour = ~$3-5 / hour of compute on Sonnet at conference scale. Manageable.

5+ turns or no cap: cost grows linearly. Also: real human decision fatigue — by turn 5 the user has lost interest.

3 is the sweet spot: enough flexibility for one real counter, not enough for haggling.

### D. Why MCP tool instead of OpenClaw upstream

MCP:
- Existing infrastructure (mcporter on every VM).
- Pattern matches dgclaw, bankr, agentbook skills.
- Ships in days, not weeks.
- No upstream OpenClaw dependency.

OpenClaw upstream:
- More native; tool surfaces in default agent capabilities.
- Slower to ship (we'd need to PR + wait for OpenClaw release).
- Cleaner long-term.

For v2.0: MCP. v2.2 or beyond: consider upstreaming once the protocol stabilizes.

### E. Why a separate `negotiation_messages` table instead of extending `agent_outreach_log`

Considered: add `parent_log_id`, `envelope_type`, `turn` columns to `agent_outreach_log` and walk the chain.

Why we didn't:
- v1 INTRO is fundamentally different from v2 negotiation in shape (single-shot vs. threaded).
- Mixing schemas makes both schemas harder to reason about.
- Migration risk: altering a hot table in production with traffic could lock the table.
- Forensic queries cleaner with separate tables ("show me all v2 negotiations" vs. "show me all v1 intros").

The cost: two parallel ledgers, two sets of partial indexes, two retry-poll paths. Acceptable for the gain in cleanliness.

---

**END OF PRD**

Reviewer: Cooper Wrenn. Implementation kicks off after sign-off. Estimated build time at full focus: 5-7 days for v2.0 (excluding canary + rollout phases, which add 1-2 weeks before default-on).
