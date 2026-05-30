# The Floor — Build Notes & Architecture Map

> Living engineering companion to `docs/prd/the-floor.md`. The PRD is the *what/why*;
> this is the *how/where*, updated as we build. Decision of record (2026-05-30,
> Cooper): **build our own 3D renderer on three.js / R3F / drei / zustand.** Not a
> Claw3D fork — we own every line, no fork drift, no dependency on withheld source.
> Claw3D's `ARCHITECTURE.md` is a blueprint; the MIT substrate is the foundation.

## Why not the Claw3D fork (resolved)

Claw3D's source IS real, MIT, and forkable (308 source files, verified). But it's
architected as a **local-first, single-user, self-hosted Studio** with its own Node
WS-proxy server and filesystem settings store — not a multi-tenant SaaS module.
Embedding one user's office into our multi-tenant Next.js app would mean stripping
its server/Studio layer anyway. Since we replace everything visual (avatar→Larry,
room→tidepool, lighting we add ourselves) and the data layer (our Supabase activity,
not its gateway WebSocket), the fork's residual value was scene scaffolding we'd want
to own regardless. Building clean on the same substrate is the better long-term call.

What we still take from Claw3D (as reference, not code): its scene-graph structure
(`RetroOffice3D.tsx`), the agent animation state model (`walking/sitting/working/away`
in `core/types.ts`), the `useFrame` interpolation loop pattern, and the architectural
boundary discipline in its `ARCHITECTURE.md` ("derive UI from events; don't duplicate
state"). Honest caveat confirmed in-source: Claw3D ships plain Lambert materials, no
bloom/AO/god-rays, `frameloop` always-on — so the premium lighting + `frameloop=demand`
were always going to be *our* additions. Nothing lost by building fresh.

## The architecture (three layers)

```
                         PRODUCERS (write real activity)
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 1. inbound webhooks  → message_in   (perk-up; ALL users incl. BYOK)    │  ← DONE
  │      app/api/telegram/shared-bot/inbound/route.ts  (known branch)      │
  │      app/api/imessage/inbound/route.ts             (known branch)      │
  │ 2. gateway proxy     → working/tool + intensity + station  [v1]        │  ← deferred
  │      app/api/gateway/proxy/route.ts  (whitelisted tool-name extension) │
  │ 3. outbound relay    → complete / error  (ALL users)                   │  ← DONE
  │      lib/floor-activity.ts:recordForwardOutcome, called in the webhook │
  │      after() block once forwardInboundToVm resolves                    │
  └──────────────────────────────────────────────────────────────────────┘
                                   │  all writes via
                                   ▼
              lib/floor-activity.ts:recordFloorActivity()            ← DONE
              (the ONLY sanctioned writer; sanitized by construction)
                                   │  fire-and-forget insert
                                   ▼
              public.instaclaw_agent_activity  (Supabase)            ← MIGRATION WRITTEN
              RLS default-private; owner-read only; service-role write
                                   │
                    ┌──────────────┴───────────────┐
                    ▼  MVP transport (poll ~2s)     ▼  v1 transport (push)
        GET /api/floor/activity  (owner)     Supabase Realtime dual-channel
                    │  DONE                         (reuse Village pattern)
                    ▼
        THE FLOOR FRONTEND  (Next.js + three.js/R3F)                 ← NEXT
        zustand activity store → work-activity director (PRD §10.4)
        → Larry's 3D behavior (perk-up / type / celebrate / idle)
```

### The two-signal model (PRD §35 — why this works)

We do **not** need a continuous stream of "still working" events. Each interaction is
*bracketed*: `message_in` (arrival, ~instant) and `complete`/`error` (resolution,
60–90s later). The director fills the gap with the honest "working" animation — the
agent genuinely IS working that whole time, so a continuous typing loop is the truthful
render, and its duration literally equals real generation time. This is the honesty
thesis made literal (PRD §9), and it's why the MVP needs only producers (1) + (3).

## What's built (2026-05-30) — verified

| Piece | File | Status |
|---|---|---|
| Activity table + RLS | `supabase/pending_migrations/20260530180000_floor_agent_activity.sql` | written, **not yet applied** |
| Activity producer + sanitization | `lib/floor-activity.ts` | done · tsc clean |
| `message_in` (Telegram) | `app/api/telegram/shared-bot/inbound/route.ts` | done |
| `message_in` (iMessage) | `app/api/imessage/inbound/route.ts` | done |
| `complete`/`error` (relay) | `recordForwardOutcome` in both webhooks' `after()` | done |
| Owner polling feed | `app/api/floor/activity/route.ts` | done · tsc clean |
| Contract test (no DB) | `scripts/_test-floor-activity.ts` | **27/27 pass** |

`npx tsc --noEmit` → 0 errors. `npx tsx scripts/_test-floor-activity.ts` → 27 passed, 0 failed.

### Safe-to-merge-before-apply

The migration lives in `pending_migrations/` per **Rule 56** (a `CREATE TABLE` in
`migrations/` would hard-fail the Vercel build via `verify-migrations.ts` until prod
catches up). Until Cooper applies it via Supabase Studio, `recordFloorActivity`
inserts no-op with a swallowed warn — the webhooks keep working unchanged. **Apply
order:** paste the SQL into Studio → verify (11 columns, `floor_activity_owner_select`
policy) → `git mv` the file into `migrations/` in the promoting commit.

## Deliberate scope decisions

- **Discord not wired.** The repo has only Telegram + iMessage inbound webhooks today
  (no `app/api/discord/.../inbound`). When a Discord inbound route lands, add the same
  3-line `recordFloorActivity({kind:"message_in", channel:"discord"})` + outcome pair.
- **Owner feed, not `[handle]`.** PRD §10.5's public `/floor/[handle]/activity` reads a
  separate anonymized view and is **v1** (ships with the public Floor). The MVP endpoint
  is owner-authenticated (`auth()` → own VM only), so v1-private cannot leak by
  construction. `floor_handle` / `floor_public` columns are deferred to that work.
- **Polling, not Realtime, for MVP** (PRD §10.1). Same event shape; the frontend swaps
  to Supabase Realtime (reusing the Village's dual-channel pattern) in v1 with no
  behavior change.
- **Producer (2) deferred.** `working`/`tool`/intensity/station come from the proxy
  extension (PRD §26). MVP runs on `message_in` + `complete`/`error`; the director
  infers the working state between them. Station-specific walks are v1.

## Next: the 3D scene (item 5)

Stack: `three` + `@react-three/fiber` + `@react-three/drei` + `zustand` (to add to
`package.json`; none present yet). Plan, in order (prove the pipe, then dress it up):

1. **zustand activity store** — subscribes to `GET /api/floor/activity` (poll ~2s),
   normalizes rows into a director-friendly event queue.
2. **Work-activity director** (PRD §10.4) — pure state machine modeled on the Village's
   encounter-engine *structure* (one owner of motion, explicit states), fed work
   signals: `IDLE → INCOMING(perk-up) → WORKING_DESK(type) → CELEBRATING/STUMBLING →
   IDLE`. Unit-testable with no renderer.
3. **R3F scene, primitives first** — `frameloop="demand"` from line one; a box room, a
   sphere/low-poly Larry, a desk. Wire director → Larry's transform/animation. Prove
   "message → Larry perks up" end-to-end with ugly geometry.
4. **`app/(dashboard)/floor/page.tsx`** — owner view; tap-Larry → existing chat deeplink;
   one-line activity ticker.
5. **THEN dress it up** — crab Larry model, tidepool room, baked lighting + bloom + AO +
   god-rays, day/night from the agent's timezone, particles. The screenshot bar (PRD §5).

The magic-moment acceptance test (PRD §24): a user messages their agent and Larry perks
up in under 2 seconds. The backend now makes that *possible*; the scene makes it *visible*.
