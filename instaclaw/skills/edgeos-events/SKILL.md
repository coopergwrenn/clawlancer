---
name: edgeos-events
description: |-
  Query and modify the EdgeOS calendar for Edge Esmeralda 2026 (and future
  Edge popups). Read the schedule, register the user for events, surface
  matches between scheduled events and the user's stated interests, and —
  with explicit user confirmation — create new events on the user's behalf.
license: MIT
metadata:
  version: '0.2.0-skeleton-ids-resolved'
  status: skeleton-pending-tule-oauth-setup
  api_base_prod: https://api.edgeos.world
  api_base_demo: https://api.dev.edgeos.world
  spec: https://api.edgeos.world/openapi.json
  auth: per-user eos_live_* API key (NOT the shared EDGEOS_BEARER_TOKEN)
  token_path: ~/.openclaw/.env value EDGEOS_EVENTS_TOKEN (placement may move to
    ~/.openclaw/workspace/secrets/edgeos.token in v1 per privacy posture review)
  tenant_header_required: true
  tenant_edgecity_prod: 6018917b-3bce-4333-9870-c29aae915038
  tenant_demo_sandbox: ea1aaa1d-d06f-4c43-b690-79c22c441093
  popup_edge_esmeralda_2026:
    id: 43746fd0-bce2-472b-93e4-a438177b2dff
    slug: edge-esmeralda-2026
    name: Edge Esmeralda 2026
    start: 2026-05-30T00:00:00
    end: 2026-06-27T00:00:00
    tenant: 6018917b-3bce-4333-9870-c29aae915038
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

**Two headers required on every authenticated call:**

- `Authorization: Bearer $EDGEOS_EVENTS_TOKEN` — the per-user eos_live_*
- `X-Tenant-Id: <tenant_uuid>` — which tenant (EdgeCity prod or demo sandbox)
  to scope the query against. The frontend reads this from `localStorage`
  at key `portal_tenant_id`; we substitute it from env or hard-code by
  partner. For `partner=edge_city` users, always send the EdgeCity prod
  tenant UUID: `6018917b-3bce-4333-9870-c29aae915038`.

The Esmeralda popup_id is fixed: `43746fd0-bce2-472b-93e4-a438177b2dff`.
Hard-code it; do not re-discover at call time.

### READ — list events

```bash
curl -sS \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  -H "X-Tenant-Id: 6018917b-3bce-4333-9870-c29aae915038" \
  "https://api.edgeos.world/api/v1/events/portal/events?popup_id=43746fd0-bce2-472b-93e4-a438177b2dff&limit=20&start_after=2026-05-30T00:00:00Z&start_before=2026-06-27T23:59:59Z"
```

Parameters (all optional except popup_id):
- `popup_id` (query, fixed: `43746fd0-bce2-472b-93e4-a438177b2dff` for Edge Esmeralda 2026)
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
  -H "X-Tenant-Id: 6018917b-3bce-4333-9870-c29aae915038" \
  "https://api.edgeos.world/api/v1/events/portal/events/{event_id}"
```

### WRITE — RSVP to an event (with user confirmation)

**Always confirm in Telegram before calling.** Example:
> *"I'll RSVP you to 'Morning Yoga' on June 1 at 9am, hosted by Jess at The Hub. Reply 'yes' to confirm."*

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  -H "X-Tenant-Id: 6018917b-3bce-4333-9870-c29aae915038" \
  "https://api.edgeos.world/api/v1/event-participants/portal/register/{event_id}"
```

### WRITE — cancel RSVP

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  -H "X-Tenant-Id: 6018917b-3bce-4333-9870-c29aae915038" \
  "https://api.edgeos.world/api/v1/event-participants/portal/cancel-registration/{event_id}"
```

### WRITE — create an event (with user confirmation)

**Always confirm in Telegram before calling.** Show the user the proposed
title, time, venue, and a final "yes/no" prompt. After creation, post the
EdgeOS event link so they can edit/cancel via the portal.

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $EDGEOS_EVENTS_TOKEN" \
  -H "X-Tenant-Id: 6018917b-3bce-4333-9870-c29aae915038" \
  -H "Content-Type: application/json" \
  -d '{
    "popup_id": "43746fd0-bce2-472b-93e4-a438177b2dff",
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
  -H "X-Tenant-Id: 6018917b-3bce-4333-9870-c29aae915038" \
  "https://api.edgeos.world/api/v1/event-venues/portal/venues?popup_id=43746fd0-bce2-472b-93e4-a438177b2dff"
```

## Error handling

- **HTTP 401 `{"detail":"Invalid token"}`** — the token in
  `EDGEOS_EVENTS_TOKEN` is either expired, revoked, or wrong-system (e.g.
  someone wrote `EDGEOS_BEARER_TOKEN`'s value here). Action: DM the user to
  re-mint via `https://edgecity.edgeos.world/portal/api-keys`.

- **HTTP 401 `{"detail":"Not authenticated"}`** — no token sent. The agent's
  curl is missing the Authorization header. Bug in this skill.

- **HTTP 422 with `{"detail":[{"loc":["header","X-Tenant-Id"],"msg":"Field required"}]}`**
  — X-Tenant-Id header missing. The agent's curl forgot to include the
  tenant header. Bug in this skill — add the header.

- **HTTP 500 with no detail body** — invalid X-Tenant-Id (wrong UUID, or a
  slug instead of UUID). EdgeOS coerces this to a 500. Make sure the
  header value is exactly the 36-char UUID, not a slug like "edgecity".

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

## Sandbox testing (demo.dev.edgeos.world)

Per Tule 2026-05-14: "all the calendar stuff is working pretty well. if you
need test users go into demo.dev.edgeos.world and submit an application that
i can approve."

Sandbox tenant UUID: `ea1aaa1d-d06f-4c43-b690-79c22c441093` (slug: `demo`).

Sandbox has 3 demo popups for testing — read-only with eos_live_*:

| slug | popup_id | name | dates |
|---|---|---|---|
| amanita-festival | `0ab01677-0827-4160-a020-a32f65e43fc6` | Amanita Festival | 2026-11-17 → 2026-11-24 |
| tech-summit-2025 | `66acbe85-f897-46fb-b911-b21dcae0a85f` | Tech Summit 2025 | 2026-06-15 → 2026-06-20 |
| community-meetup | `fd7114a3-ae46-42fa-9286-165ade5a2a23` | Community Meetup | 2026-04-10 → 2026-05-31 |

Sandbox flow (operator must do this manually before the first end-to-end test):

1. Open `https://demo.dev.edgeos.world` in a browser.
2. Submit an application for one of the popups above (any will do).
3. Ping Tule to approve the application.
4. Once approved, the test email can run the OTP flow at api.dev.edgeos.world.
5. With the resulting eos_live_*, queries against the demo popups should return real events.

Once that's confirmed end-to-end against sandbox, point production users at the
prod tenant + Esmeralda popup_id with no code changes (the modules already
default to sandbox via `EDGEOS_API_BASE` env var).
