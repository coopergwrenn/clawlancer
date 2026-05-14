---
name: edgeos-events
description: |-
  Query and modify the EdgeOS calendar for Edge Esmeralda 2026 (and future
  Edge popups). Read the schedule, register the user for events, surface
  matches between scheduled events and the user's stated interests, and —
  with explicit user confirmation — create new events on the user's behalf.
license: MIT
metadata:
  version: '0.1.0-skeleton'
  status: skeleton-pending-tule-oauth-setup
  api_base_prod: https://api.edgeos.world
  api_base_demo: https://api.dev.edgeos.world
  spec: https://api.edgeos.world/openapi.json
  auth: per-user eos_live_* API key (NOT the shared EDGEOS_BEARER_TOKEN)
  token_path: ~/.openclaw/.env value EDGEOS_EVENTS_TOKEN (placement may move to
    ~/.openclaw/workspace/secrets/edgeos.token in v1 per privacy posture review)
---

# EdgeOS Events — Calendar integration for Edge Esmeralda 2026

> **STATUS: SKELETON.** This file documents the integration shape so the agent
> can reason about it during onboarding conversations. Production curl examples
> are NOT yet active — we are waiting on Tule (EdgeOS team) to either (a)
> register InstaClaw as an OAuth client so we can mint user tokens in-flow,
> or (b) clarify whether the user must visit /portal/api-keys themselves to
> mint and paste back.

## When to activate this skill

Use this skill (and not the legacy `edge-esmeralda` skill's Sola examples)
whenever the user is on `partner=edge_city` AND asks about:

- "what's on today / tomorrow / Friday" → events list (read)
- "any AI talks this week?" → events search (read)
- "RSVP me to the morning yoga" → register (write)
- "cancel my RSVP for X" → cancel-registration (write)
- "create a meetup at the hub at 3pm" → event create (write, with confirmation)

The `edge-esmeralda` skill still references `api.sola.day` for events. **Ignore
those examples — Sola is deprecated for Esmeralda 2026.** Use the endpoints
below.

## Authentication model

EdgeOS uses a per-user API key (`eos_live_*` prefix), NOT a service-wide token.

- The shared `EDGEOS_BEARER_TOKEN` env var on this VM authenticates ONLY the
  legacy attendee-directory API at `api-citizen-portal.simplefi.tech` — it
  does NOT work against `api.edgeos.world` event endpoints.
- The per-user `EDGEOS_EVENTS_TOKEN` (when present in `~/.openclaw/.env`) is
  what authenticates requests to `api.edgeos.world/api/v1/*`.

If `EDGEOS_EVENTS_TOKEN` is empty or missing, this skill cannot complete
event queries. Tell the user: *"I need your EdgeOS events token to query the
calendar — I'll DM you a link to set this up."* Do NOT fall back to Sola.

## Production endpoints (from OpenAPI spec)

Base URL: `https://api.edgeos.world` (prod) or `https://api.dev.edgeos.world`
(sandbox — for testing only, do not write user data here).

Auth header: `Authorization: Bearer $EDGEOS_EVENTS_TOKEN`

### READ — list events

```bash
curl -sS \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  "https://api.edgeos.world/api/v1/events/portal/events?popup_id=ESMERALDA_POPUP_ID&limit=20&start_after=2026-05-30T00:00:00Z&start_before=2026-06-27T23:59:59Z"
```

Parameters (all optional except popup_id):
- `popup_id` (path/query, the Esmeralda popup UUID — placeholder until Tule provides)
- `kind` — event type filter
- `venue_id` — filter to one venue
- `tags` — tag filter
- `start_after`, `start_before` — ISO 8601 UTC, inclusive
- `search` — title substring
- `limit` — max 100

Response shape: `{ results: [Event...], paging: {...} }`. Event fields include
`id`, `title`, `start_time`, `end_time`, `timezone`, `venue`, `tags`, `owner`,
`participants_count`, `max_participant`, `formatted_address`.

### READ — single event with caller's RSVP status

```bash
curl -sS \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  "https://api.edgeos.world/api/v1/events/portal/events/{event_id}"
```

### WRITE — RSVP to an event (with user confirmation)

**Always confirm in Telegram before calling.** Example:
> *"I'll RSVP you to 'Morning Yoga' on June 1 at 9am, hosted by Jess at The Hub. Reply 'yes' to confirm."*

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  "https://api.edgeos.world/api/v1/event-participants/portal/register/{event_id}"
```

### WRITE — cancel RSVP

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  "https://api.edgeos.world/api/v1/event-participants/portal/cancel-registration/{event_id}"
```

### WRITE — create an event (with user confirmation)

**Always confirm in Telegram before calling.** Show the user the proposed
title, time, venue, and a final "yes/no" prompt. After creation, post the
EdgeOS event link so they can edit/cancel via the portal.

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "popup_id": "ESMERALDA_POPUP_ID",
    "title": "AI Discussion",
    "start_time": "2026-06-05T15:00:00-07:00",
    "end_time":   "2026-06-05T16:00:00-07:00",
    "venue_id":   "VENUE_UUID_OR_NULL"
  }' \
  "https://api.edgeos.world/api/v1/events/portal/events"
```

### READ — list venues

```bash
curl -sS \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  "https://api.edgeos.world/api/v1/event-venues/portal/venues?popup_id=ESMERALDA_POPUP_ID"
```

## Error handling

- **HTTP 401 `{"detail":"Invalid token"}`** — the token in
  `EDGEOS_EVENTS_TOKEN` is either expired, revoked, or wrong-system (e.g.
  someone wrote `EDGEOS_BEARER_TOKEN`'s value here). Action: DM the user to
  re-mint via `https://edgecity.edgeos.world/portal/api-keys`.

- **HTTP 401 `{"detail":"Not authenticated"}`** — no token sent. The agent's
  curl is missing the Authorization header. Bug in this skill.

- **HTTP 422 with `HTTPValidationError`** — request body / params failed
  schema validation. Inspect the response detail; common causes are wrong
  timezone format, missing required field, or `name` too long (> 100 chars).

- **HTTP 409 / 403 on create/RSVP** — likely event is full (`max_participant`
  reached) or requires approval. Surface to user: don't auto-retry.

## Rate limits

Tule has not implemented rate limits yet (as of 2026-05-14). When they do, we
expect 429 + `Retry-After` header. Until then, agents should self-throttle to:

- Reads: max 60/min per agent
- Writes: max 5 event-creates/day, 20 RSVPs/day per user

## Confirmation discipline for write operations

Every WRITE operation (event create, RSVP, cancel, venue create) requires
EXPLICIT user confirmation in Telegram before the curl. Never write
preemptively. If the user says "RSVP me for everything related to AI,"
present the candidate list and ask them to confirm one at a time, NOT all
at once.

This is non-negotiable. Bad RSVPs broadcast the user's plans publicly and
damage trust in the agent.
