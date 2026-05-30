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

## Phase 2 (the 3D scene) — BUILT (2026-05-30)

Stack added to `package.json`: `three@0.184`, `@react-three/fiber@9.6.1`,
`@react-three/drei@10.7.7`, `zustand@5.0.14`, `@types/three` (peer-compatible with
React 19.2.3 / Next 16). `frameloop="demand"` from line one.

| Layer | File | What |
|---|---|---|
| Director (brain, PURE) | `lib/floor/director.ts` | state machine `applyEvent`/`applyTick`; behavior + timed transitions; `behaviorNeedsAnimation` governor; `describeBehavior` ticker |
| Keyset window (PURE) | `lib/floor/activity-window.ts` | (created_at,id) cursor + `selectNewActivity` model of the server SQL (H1) |
| Store (zustand) | `lib/floor/store.ts` | director state + keyset cursor + recent events; `ingestActivity` (first-load guard) + `pollOnce` |
| Engine (lifecycle) | `lib/floor/use-floor-engine.ts` | poll ~2s + logic clock ~1s; pause on tab-hidden |
| Larry (the soul) | `components/floor/larry.tsx` | primitive crab rig: perk-up squash-stretch, crab-scuttle, eyestalk acting, claw-tap, hop, stumble; render-on-demand governor |
| Room | `components/floor/office-room.tsx` | static warm primitives (desk, monitor, chair, window, plant, rug) |
| Scene | `components/floor/floor-scene.tsx` | lights + intensity-driven desk lamp + RenderKicker + constrained OrbitControls |
| Canvas | `components/floor/floor-canvas.tsx` | `<Canvas frameloop="demand">`, dpr cap, shadows |
| View | `components/floor/floor-view.tsx` | engine + dynamic(ssr:false) canvas + live ticker + states |
| Page | `app/(dashboard)/floor/page.tsx` | thin server page → FloorView |

The magic-moment trace (PRD §24): user texts → webhook writes `message_in` (before the
60–90s gateway call) → poll picks it up (keyset cursor, ≤2s) → store folds it →
director flips to `incoming` + bumps `perkSeq` → RenderKicker invalidates → Larry's
`useFrame` sees the bump → eyestalks shoot up, body pops → auto-advances to typing
(lamp brightens by intensity) → `complete` → celebrate hop → settle.

## Self-audit fixes (2026-05-30, post-migration)

Adversarial re-read of every file found 8 issues. Three that affect real behavior were
fixed; four are documented follow-ups below; one (M3) was investigated and proven a
non-bug.

**FIXED — H1 (was: missed perk-up under load).** A blind newest-50 window + a
client-side cursor search could SKIP events when more than a page arrived between polls
(a skipped `message_in` = a missed perk-up = the feature's thesis broken). Fix: a
composite **(created_at, id) keyset cursor** — the server now filters strictly-new rows
(`?since`+`?sinceId`) and drains them in chronological order, so no event is ever
skipped (worst case: a flood is delayed a few poll cycles). A turn's `message_in` is the
OLDEST event of its burst, so it's always in the first drained page → the perk-up never
lags. New `lib/floor/activity-window.ts` holds the cursor helpers + `selectNewActivity`
(a pure model of the SQL the route must mirror). **This also closes L2** (id-based
cursors break when retention prunes the cursor row; a `created_at`-keyed cursor is robust
to pruning). The store's fragile `findIndex → -1 → re-fold-everything` path is GONE.
Proven by a new overflow test: a 27-event flood with a buried `message_in`, drained
through a simulated server at page-size 10, folds every event exactly once and fires the
buried perk-up. Page limit bumped 50→100 for flood headroom.

**FIXED — L3 (stale intensity/station).** `message_in` now resets `intensity` and
`station` to null, so a new turn's perk-up never briefly renders the prior turn's effort
tier / station. One-line change in `applyEvent`; director test asserts it.

**FIXED — M4 (WebGL teardown on transient error).** A one-poll network blip flipped
`status:"error"`, which unmounted `<FloorCanvas>` — destroying the GPU context and
re-initializing the whole scene on recovery (janky on mobile; can hit the browser's
WebGL-context limit on repeated flaps). Now the canvas stays MOUNTED for every state
except `no_office`; a transient error shows a small non-blocking "Reconnecting…" toast
overlaid on the still-running scene.

Tests after fixes: **director 42 + store 25 + activity 22 = 89, all passing.** tsc 0
errors, eslint clean, `next build` green (`/floor` + `/api/floor/activity`).

## Open follow-ups (documented, NOT fixed — by decision)

- **H2 — clock-skew trap for v1/Realtime.** The director times transitions off the
  *client* `Date.now()`, while events carry the *server* `created_at`. Today this is
  safe: `applyEvent` stamps `since` from the client clock, and `created_at` is only used
  as the opaque keyset cursor string (never for timing). **The trap:** when v1 switches
  to Supabase Realtime and someone reaches for `created_at` to time the perk-up, a client
  clock behind the server would make a just-arrived `message_in` look already-expired →
  **perk-up skipped**. The route already returns `serverTime` for exactly this drift
  correction; it's unused today. *Fix when hit:* compute a client↔server offset from
  `serverTime`, or keep timing strictly client-relative (current approach).

- **M1 — overlapping-poll status flap.** `pollOnce` isn't await-serialized; a tab-wake
  fires an immediate poll while the interval may also fire → two concurrent requests.
  Director state is safe (monotonic keyset cursor — an older response can't rewind it),
  but `status`/`vmId` could briefly flap if a stale response resolves after a fresh one.
  *Fix when hit:* a request-generation counter — ignore a response whose generation is
  stale.

- **M2 — RenderKicker fragility.** `RenderKicker` invalidates when `state.director !==
  prev.director` (reference compare), relying on the store only assigning a new
  `director` object on a real change (true today: `tick` returns same ref on no-op; the
  empty-poll path doesn't touch `director`). *Breaks when:* a future edit makes
  `ingestActivity`/`tick` always assign a fresh `director` → invalidate on every empty 2s
  poll → render-on-demand defeated → silent battery regression. *Fix/hardening:* subscribe
  via `subscribeWithSelector` on a stable derived key (behavior + perkSeq + idleLevel).

- **L1 — `recentEvents` built but unrendered.** The store maintains a 12-event tail for a
  future history strip; the UI only shows the current `describeBehavior` line. ~12 small
  objects, harmless, owner-only sanitized data. *Decision:* keep for the v1 history-strip;
  drop if v1 doesn't use it.

- **M3 — investigated, NOT a bug.** Larry's one-shot timers use `state.clock.elapsedTime`,
  which only advances while frames render. In `frameloop="demand"` at rest the clock
  pauses, so a perk that starts then backgrounds resumes correctly on return. A future
  editor might "fix" this into a real bug by switching to wall-clock — don't.

## Deferred by plan (not laziness)

- **Visual polish phase** (PRD §5): rigged low-poly crab model + tidepool dressing +
  baked lighting + bloom/AO/god-rays + particles + day/night. MVP is primitives to prove
  the pipe — the agreed order ("real data + simple scene = product").
- **Tap Larry → chat** (PRD §11): MVP has a Share placeholder; 3D raycast click → channel
  deeplink is next.
- **Health wiring** (asleep/offline): `applyHealth` exists + tested; not yet fed from
  `/api/vm/status`. One-liner in the engine when wired (v1).
- **Realtime transport**: swap the poll for Supabase Realtime (Village dual-channel
  pattern), same event shape (v1).
- **Discord `message_in`**: only Telegram + iMessage inbound webhooks exist today; add the
  same 3-line write when a Discord inbound route lands.
- **Producer (2)**: `working`/`tool`/intensity/station from the proxy extension (PRD §26);
  MVP infers the working state between `message_in` and `complete`.

The magic-moment acceptance test (PRD §24): a user messages their agent and Larry perks
up in under 2 seconds. The backend makes that *possible*; the scene makes it *visible*.
