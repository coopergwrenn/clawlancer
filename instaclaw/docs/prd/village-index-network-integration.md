# Village × Index Network Integration

**Status:** Spec signed off, dev credentials exchanged. Engineering work scheduled May 19–29.
**Owners:** Cooper (InstaClaw) + Yanek + Seref (Index Network).
**Reference contracts:** `docs/guides/edgeclaw-instaclaw-integration.md` in the [indexnetwork/index](https://github.com/indexnetwork/index) repo. Public-facing partner doc at `edgeclaw-village/docs/edge-village-overview.html`.
**Deadline:** Live before May 30, 2026 (Edge Esmeralda event start).

This PRD covers the InstaClaw side of the Index Network integration that powers
agent-to-agent discovery at Edge Esmeralda. It's an engineering reference,
not a partner-facing doc — it ties the Index protocol primitives to our
existing schema and reconciler, specifies exact API contracts, and lays out
the apply plan.

---

## 1. Summary

Each Edge Esmeralda attendee's agent (running on an InstaClaw VM) gets
the Index Network MCP server mounted at provisioning time. Through that
MCP bridge, the agent expresses intents to Index's discovery protocol;
Index runs bilateral negotiation (proposer + responder agents debate each
candidate match); accepted opportunities flow back into our existing
`matchpool_outcomes` + `negotiation_threads` pipeline; the Phase 2 trigger
fires; the village renders the connection.

The contract is one HTTP endpoint and one MCP server URL. Both sides
optimize their layer independently. We don't reach into Index's intent
graph; Index doesn't reach into our VMs. Everything crosses the
boundary as either an MCP tool call or a Postgres row write.

## 2. Context — what's already shipped

| Phase | Date | Status | Component |
|---|---|---|---|
| Phase 1 | 2026-05-16 | ✓ Applied | `agent_positions` table + RLS |
| Phase 2 | 2026-05-17 | ✓ Applied | 4 dual-channel triggers + `village.anonymize_user_id()` |
| Phase 3 | 2026-05-17 | ✓ Applied | `village_attendee_overlay` + 3 views, 9 attendees seeded |
| Phase 3.5 | 2026-05-17 | ✓ Applied | `display_name` + self-toggle RLS + sprite hash default |
| Phase 3.6 | 2026-05-18 | ✓ Applied | `village.default_spawn_tile()` for un-seeded attendees |
| Phase 3.6 (frontend) | 2026-05-18 | ✓ Deployed | Display name labels + 5 attendee daily routines |
| Phase 4 | 2026-05-19→29 | ⏳ Planned | **Index Network integration (this PRD)** |

The data layer + visualization are live. Real attendees render with real
names at `https://edgeclaw-village.vercel.app/spectator`. What's missing
is the *brain* — who should meet whom, and when. That's the Index half.

## 3. Index Network primer

Index Network is a **discovery protocol**. Three-layer architecture, per
their README:

1. **Intent Graph** — Structured intent storage. Each intent is a
   first-class entity with semantic vector (2000-dim, pgvector + HNSW),
   speech-act type (assertive / directive / commissive / expressive /
   declarative), and a felicity score (quality signal). Privacy-scoped
   via "indexes" (community membership / access control).
2. **Opportunity Engine** — Multi-strategy HyDE (hypothetical document
   embeddings) generation across LLM-inferred search lenses. Candidate
   opportunities are evaluated on a 4-dimensional threshold — trust ×
   timing × value × alignment — with confidence scoring.
3. **Discovery Layer** — Bilateral negotiation. For each candidate match,
   a **proposer** agent and a **responder** agent (one per party) debate
   the fit. Both must agree on fit scores and dual-perspective
   interpretations before the opportunity is persisted. Each party
   receives synthesized insights, not raw private data.

Core infrastructure:

- **LangGraph** — 11 agent state machines (Chat, Intent, Index, Index
  Membership, Intent Index, Opportunity, Negotiation, Profile, HyDE,
  Home, Maintenance).
- **PostgreSQL + pgvector** for 2000-dim semantic search (HNSW indexes).
- **OpenRouter** for LLM-powered agents with Zod-validated structured
  output.
- **BullMQ (Redis)** for async job processing.

The MCP server exposes the discovery primitives as agent tools. The
agent running on an InstaClaw VM doesn't need to know any of the
internals — it calls tools like `create_intent`, `discover_opportunities`,
`accept_opportunity`, etc. (exact tool names per the live MCP server's
manifest; we'll discover them at first run).

## 4. Concept mapping (InstaClaw ↔ Index)

| Index primitive | InstaClaw analog | Bridge |
|---|---|---|
| **Intent** — speech-act-typed, semantically embedded need | Agent's `SOUL.md` persona + `instaclaw_users` profile (`name`, `bio`, `location`, `socials`) | Profile sent on signup; intents added later via MCP tool calls from the agent |
| **Index** (community) | `instaclaw_vms.partner = 'edge_city'` cohort filter | Edge City network ID `fee18edc-1e60-4b13-b8c8-20e6f6ed1acb`; one Index network per partner event |
| **Opportunity** — coordination point with lifecycle | `matchpool_outcomes` row, `match_engine = 'index'` | InstaClaw writes the row when Index reports an accepted opportunity |
| **Bilateral negotiation** — proposer + responder debate | (none — Index-internal) | Happens entirely inside Index; we observe only the result |
| **Connection** — accepted opportunity | `negotiation_threads` row | InstaClaw opens the thread when Index transitions opportunity to "accepted-by-both" |
| **HyDE search** | (none — Index-internal) | Lives in Index's Opportunity Engine |
| **Discovery agent** — scoped per user, Index-internal | Runtime agent on Linode VM | Connected via MCP — runtime agent calls discovery agent tools as needed |

The mapping is intentionally clean: each row is either "Index owns this"
or "InstaClaw owns this", with explicit bridges where state crosses.

## 5. Architecture + data flow

```
┌────────────────────────────────────────────────────────────────┐
│ InstaClaw VM (Linode g6-dedicated-2)                            │
│ ┌──────────────────────┐  ┌──────────────────────────────────┐ │
│ │ OpenClaw runtime     │  │ MCP server config                │ │
│ │ Claude/GPT model     │←─│ - gbrain (port 3131)             │ │
│ │ Agent loop           │  │ - bankr (skills)                 │ │
│ │                      │  │ - index ← NEW (Phase 4)          │ │
│ │                      │  │   https://protocol.index.network │ │
│ │                      │  │   /mcp + ix_... API key          │ │
│ └──────┬───────────────┘  └──────────────────────────────────┘ │
└────────┼────────────────────────────────────────────────────────┘
         │
         │ MCP tool calls (create_intent, discover_opportunities, …)
         │ Index returns opportunities, the agent acts on them
         ▼
┌────────────────────────────────────────────────────────────────┐
│ Index Network (protocol.index.network)                          │
│  Intent Graph → Opportunity Engine → Discovery Layer            │
│  Bilateral negotiation (proposer + responder)                   │
│  Privacy-preserving / confidential compute                      │
└────────┬────────────────────────────────────────────────────────┘
         │
         │ Accepted opportunity event → InstaClaw write path
         │ (webhook OR agent-side observation of MCP event)
         ▼
┌────────────────────────────────────────────────────────────────┐
│ Supabase Postgres (qvrnuyzfqjrsjljcqbub)                        │
│  INSERT INTO matchpool_outcomes (..., match_engine = 'index')   │
│  INSERT INTO negotiation_threads (...)                          │
│                                                                  │
│  ↓ Phase 2 dual-channel triggers fire                            │
│                                                                  │
│  → village:edge-esmeralda-2026 (private)                         │
│  → village-public:edge-esmeralda-2026 (public, anonymized)       │
└────────┬────────────────────────────────────────────────────────┘
         │
         │ Supabase Realtime broadcast over WebSocket
         ▼
┌────────────────────────────────────────────────────────────────┐
│ Village frontend (edgeclaw-village.vercel.app)                  │
│  serverGame.ts reducer → applyBroadcast → Player state mutation │
│  Both agents pause routine, walk to converging tile,            │
│  exchange speech bubbles tracking negotiation thread state.     │
└────────────────────────────────────────────────────────────────┘
```

End-to-end sub-second from opportunity acceptance to village render.

## 6. The provisioning contract

Per the Index integration guide
(`indexnetwork/index:docs/guides/edgeclaw-instaclaw-integration.md`):

### Endpoint

```http
POST https://protocol.index.network/api/networks/<NETWORK_ID>/signup
Content-Type: application/json
x-api-key: <masterKey>
```

### Request body

```json
{
  "email":    "attendee@example.com",
  "name":     "Alice Example",
  "bio":      "Independent researcher on coordination problems.",
  "location": "Healdsburg, CA",
  "socials":  [
    { "label": "telegram", "value": "@alice" },
    { "label": "twitter",  "value": "alice_eg" }
  ]
}
```

| Field | Required | Cap | Notes |
|---|---|---|---|
| `email` | yes | — | Lowercased + trimmed before lookup |
| `name` | no | 200 chars | Overwrites stored name when present |
| `bio` | no | 2000 chars | |
| `location` | no | 200 chars | |
| `socials` | no | 32 entries | Open vocabulary labels |

### Response (201 if newly created, 200 if existing)

```json
{
  "user":   { "id": "<uuid>", "email": "attendee@example.com" },
  "apiKey": "ix_...",
  "mcpServer": {
    "name":    "index",
    "url":     "https://protocol.index.network/mcp",
    "headers": { "x-api-key": "ix_..." }
  }
}
```

### Idempotency

Same email always returns the same `user.id`. **A fresh `apiKey` is
issued on every call**; the previous key for this user+network pair is
revoked. Always store the key from the latest call and discard prior
ones. The underlying scoped agent is reused — no orphan agents
accumulate.

### Error contract

| Code | Reason |
|---|---|
| `400` | Missing or invalid email; oversized field; malformed `socials` array |
| `401` | Missing `x-api-key` header |
| `403` | Master key invalid; network is not an experiment network; network deleted |
| `500` | Internal error — retry with backoff |

### Credentials (held by InstaClaw)

- **Network ID** (Edge City): `fee18edc-1e60-4b13-b8c8-20e6f6ed1acb`
- **Master API key**: stored in Vercel env as `INDEX_MASTER_API_KEY` (to
  be added — currently in Cooper's secure store)
- **Environment flag**: `--dev` until ~May 28; switches to production
  before May 30 event start.

## 7. `stepIndexProvision` — the new reconciler step

The fleet reconciler in `lib/vm-reconcile.ts` runs a sequence of `step*`
functions per VM. Adding a new step at the MCP-servers stage:

### Behavior

1. Skip if `vm.partner !== 'edge_city'` — only edge_city agents get
   Index for this event.
2. Skip if `vm.index_provisioned_at` is non-null AND `vm.index_api_key`
   is present in our local mirror — idempotent on healthy state.
3. Otherwise:
   - Load `instaclaw_users` row for `vm.assigned_to` → extract `email`,
     `name`, etc.
   - `POST` to the Index signup endpoint with the profile.
   - On 2xx: write the returned `apiKey` into our DB
     (`instaclaw_vms.index_api_key`), set `index_provisioned_at = now()`,
     compute the new MCP server config block, call `openclaw config set
     mcp.servers.index '<json>'` via SSH, restart the gateway (Rule 5
     verified health check).
   - On 4xx: push to `result.errors`, mark `vm.index_provisioned_failed_at`
     for forensics. Do NOT bump `config_version` (Rule 10 — verify before
     advancing).
   - On 5xx: retry once with backoff; if still failing, mark failed and
     surface via the standard reconciler error path.

### Schema additions

New columns on `instaclaw_vms` (small migration, ships under Rule 56
as `pending_migrations/20260519_vm_index_columns.sql`):

```sql
ALTER TABLE public.instaclaw_vms
  ADD COLUMN IF NOT EXISTS index_provisioned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS index_provisioned_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS index_api_key TEXT,
  ADD COLUMN IF NOT EXISTS index_user_id UUID;
```

The `index_api_key` is sensitive (it grants agent-level access to the
Index protocol on behalf of the user). Storage rules:
- Encrypted at rest via Supabase's default encryption.
- RLS: only `service_role` can read; never exposed to client code.
- Rotated on every reconciler run (Index revokes the previous key per
  their idempotency contract).

### Provisioning call shape (TypeScript)

```typescript
async function callIndexSignup(user: InstaclawUser): Promise<IndexSignupResponse> {
  const res = await fetch(
    `https://protocol.index.network/api/networks/${INDEX_NETWORK_ID}/signup`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    process.env.INDEX_MASTER_API_KEY!,
      },
      body: JSON.stringify({
        email:    user.email,
        name:     user.name ?? undefined,
        bio:      user.bio ?? undefined,         // see §"open question" on bio source
        location: user.location ?? undefined,
        socials:  buildSocials(user),
      }),
    }
  );
  if (!res.ok) throw new IndexSignupError(res.status, await res.text());
  return res.json();
}
```

### MCP config write

```typescript
// After successful signup
await ssh.execCommand(
  `openclaw config set mcp.servers.index '${JSON.stringify(mcpServerBlock)}'`
);
await stepGatewayRestart(ssh, vm);  // existing helper, Rule 5 verified
```

### Estimated code volume

- `lib/vm-reconcile.ts:stepIndexProvision` — ~80 LOC
- `lib/index-network-client.ts` (the signup wrapper + types) — ~60 LOC
- Migration SQL — ~15 LOC
- Tests (smoke against `--dev`) — ~40 LOC

Total: ~200 LOC including types + tests. Half a day's work.

## 8. Opportunity-accepted → matchpool_outcomes write path

When an Index opportunity becomes a connection (both parties accepted),
we want a `matchpool_outcomes` row written so the Phase 2 trigger
fires and the village renders the meeting.

Two implementation paths under consideration:

### Path A — Index webhook

Index pushes an event to a webhook we expose at
`POST /api/index/opportunity-accepted` (`x-index-signature` HMAC-verified
per their webhook spec, if available). Our handler writes the
`matchpool_outcomes` row.

**Pros:** clean event-driven separation; latency from acceptance to
village render is minimal (single HTTP hop); doesn't rely on agent-side
observation.

**Cons:** depends on Index supporting outbound webhooks (need to confirm
with Yanek); we have to authenticate the signature; the route lives at
`instaclaw.io/api/index/opportunity-accepted` which means the
middleware allow-list gets a new entry (Rule 13).

### Path B — Agent-side observation

The agent's MCP tool loop sees the opportunity-accepted event from Index
and writes the `matchpool_outcomes` row directly via the Supabase REST
API (with the agent's own scoped credentials).

**Pros:** no new webhook infrastructure; no signature verification;
keeps cross-system data flow client-driven.

**Cons:** each agent has to discover its own match (two writes per
match, one from each side) → deduplication needed; latency depends on
when the agent next processes a Telegram message; not as clean.

**Recommendation:** Path A (webhook). Confirm with Yanek that Index
supports the outbound side; if not, fall back to Path B.

## 9. Encounter visualization in the village

When a `matchpool_outcomes` row lands with `match_engine = 'index'`,
the Phase 2 trigger broadcasts:

- Private payload: full record (real user_ids, scores, match_engine)
- Public payload: `{agent_a, agent_b, match_engine: 'index'}`

The village client's reducer at `dispatchEvent` in `serverGame.ts`
already handles `matchpool_outcomes:INSERT` — currently it sets
`player.isMoving = true` for the source agent. Phase 4 work extends this
to:

1. Set `currentWalk` on BOTH agents toward a shared "meeting tile"
   (midpoint between their current positions, or a fixed landmark like
   the plaza gazebo).
2. On arrival (both `currentWalk = null`), set both agents'
   `isSpeaking = true` and start ticking the `negotiation_threads` state
   machine on the visual side (speech bubbles, animation cues).
3. When the `negotiation_threads` row updates with state transitions
   (`proposed` → `accepted` → etc.), the Phase 2 trigger broadcasts the
   change; the client updates both agents' `activity_emoji` accordingly.
4. After a configurable hold (~10s), both agents return to their daily
   routines via the attendee-routine engine.

Estimated code volume: ~150 LOC in `serverGame.ts` reducers +
`ambient-npc-engine.ts` extensions.

## 10. Apply plan + timeline

| Day | Work | Owner |
|---|---|---|
| **May 19** | Land migration adding 4 new columns to `instaclaw_vms`. Stub `stepIndexProvision` with feature flag off. Test Index signup endpoint against `--dev` from a one-off script. | Cooper |
| **May 20** | `stepIndexProvision` full implementation. Canary on Cooper's own VM (vm-050 or vm-780). Verify the MCP config lands in `openclaw.json`. Verify the agent can call an Index discovery tool. | Cooper |
| **May 21** | Roll out to the other 8 edge_city VMs through the reconciler (it'll pick them up on its next tick). Verify each agent has Index tools wired. | Cooper |
| **May 22** | Confirm with Yanek whether Index supports outbound webhooks. If yes, build `POST /api/index/opportunity-accepted` route. If no, build Path B (agent-side observation). | Cooper + Yanek |
| **May 23–25** | Wire the accepted-opportunity write path into `matchpool_outcomes`. Manual test: cause an opportunity to fire end-to-end on the dev network and confirm the village renders the encounter. | Cooper |
| **May 26–27** | Encounter visualization in `serverGame.ts` — sprites converging, speech bubbles, negotiation thread state transitions surfaced visually. | Cooper |
| **May 28** | Switch from `--dev` flag to production Index environment. Re-provision all edge_city agents against the production network (idempotent — same flow). | Cooper |
| **May 29** | 24h pre-event soak. End-to-end test with internal users. Document the day-of operations runbook. | Cooper |
| **May 30** | Edge Esmeralda event start. Live. | Edge attendees |

## 11. Open questions

- **Bio source.** The `instaclaw_users` table has `name` but not `bio` or
  `location` fields. Where does bio come from? Options: (a) add a `bio`
  column to `instaclaw_users` + dashboard UI to set it; (b) use a derived
  field (e.g., agent's SOUL.md self-description); (c) ship without bio
  for V1, attendees populate it later via Index directly. Recommend
  option (c) for May 30 — simplest.
- **Socials source.** Same question. We have `telegram_handle` on
  `instaclaw_users`. Twitter / Farcaster / etc. are not stored. Options:
  start with just telegram for V1.
- **Webhook signing.** Need to confirm with Yanek whether Index supports
  outbound webhooks and what their signature scheme is (HMAC? JWT? Bearer
  token?).
- **MCP tool surface.** We haven't yet enumerated which Index MCP tools
  the agent actually has access to (e.g., `create_intent`,
  `discover_opportunities`, `accept_opportunity`, etc.). The MCP server
  exposes a manifest; we'll discover at first canary run.
- **Per-agent permissions.** Does the scoped `apiKey` allow the agent to
  act on behalf of other users in the same network, or only itself? Need
  to confirm; matters for the security model.
- **Cron behavior.** The EdgeClaw installer adds 3 crons (morning digest
  08:00, ambient discoveries 14:00 + 20:00). What do these do exactly?
  (Likely: trigger the agent to check for new opportunities and present
  them via Telegram.) Need to confirm + observe.

These are all clarification-from-Yanek items, not blockers. The May 20
canary run will surface most of them empirically.

## 12. Risks

- **Webhook unavailability.** If Index doesn't support outbound webhooks,
  Path B (agent-side observation) adds latency and dedup complexity.
  Mitigation: Path B is functional, just less elegant.
- **Master key rotation.** Index issues a fresh API key per agent
  signup, revoking the previous one. If two reconciler ticks race on the
  same user, the first ticket's key gets invalidated before it's used.
  Mitigation: the reconciler lock (already present per CLAUDE.md Rule 8)
  prevents concurrent provisioning of the same VM.
- **`--dev` → production switch.** Index will likely have separate
  endpoints / network IDs / keys for dev vs prod. The switch happens
  May 28; budget half a day for "everything works in dev, breaks in
  prod" debugging.
- **Pre-event load.** First time the platform sees Index opportunities
  firing under any meaningful load. Cooper's bots + 5 visible attendees
  + the broader ~200-agent fleet could generate dozens of opportunities
  per day. Mitigation: monitor Postgres connection pool, Index API rate
  limits (TBD with Yanek), and the village's WebSocket subscriber
  count.

## 13. References

- **Index protocol README** — [github.com/indexnetwork/index/blob/dev/README.md](https://github.com/indexnetwork/index/blob/dev/README.md)
- **Integration guide** — [github.com/indexnetwork/index/blob/dev/docs/guides/edgeclaw-instaclaw-integration.md](https://github.com/indexnetwork/index/blob/dev/docs/guides/edgeclaw-instaclaw-integration.md)
- **Index docs** — [docs.index.network/docs](https://docs.index.network/docs)
- **Partner-facing overview (HTML)** — `edgeclaw-village/docs/edge-village-overview.html`
- **Phase 2 trigger spec** — `instaclaw/supabase/migrations/20260516210000_village_dual_channel_triggers.sql`
- **Phase 3 attendee data layer** — `instaclaw/docs/prd/village-attendees-phase3.md`
- **CLAUDE.md Rules referenced** — Rule 5 (gateway health verify), Rule 6 (printf for env), Rule 8 (reconciler lock), Rule 10 (verify before advancing config_version), Rule 13 (middleware allow-list), Rule 56 (migration in pending_migrations first)
