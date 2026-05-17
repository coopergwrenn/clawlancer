# Village Phase 3 — Scaling Gap Audit (2026-05-17)

**Context:** Phase 3 (`village_attendee_overlay` table + 3 views) shipped today as commit `1b64d18a`. 9 edge_city attendees seeded; 5 spectator-visible. View queries verified clean.

This audit identifies three gaps that block the village from scaling cleanly from 9 → 50+ attendees without manual intervention before Edge Esmeralda's **May 30 event start (13 days)**.

For each gap: ground-truth diagnosis, severity assessment, and the minimal fix that ships before May 30.

---

## Gap 1 — Default sprite for un-seeded attendees

### Current state

When a new edge_city VM is provisioned and no overlay row exists, the view's COALESCE returns `larry_atlas_index = 0`. Schema lives at `village_attendee_overlay.larry_atlas_index INT NOT NULL DEFAULT 0`; view aliases:

```sql
COALESCE(o.larry_atlas_index, 0) AS larry_atlas_index
```

What index 0 actually renders as: re-read of `data/characters.ts` (lines 67–73):

```ts
export const characters: CharacterEntry[] = Array.from({ length: 50 }, (_, i) => ({
  name: `larry${String(i).padStart(2, '0')}`,
  textureUrl: PLACEHOLDER_LARRY,        // every index uses the same atlas
  spritesheetData: LARRY_SPRITESHEET_DATA,
  speed: 0.1,
}));
```

Until PixelLab Day-5 deliverables land (Cooper's parallel art-asset work), all 50 indices point at the **same** placeholder PNG (`/assets/32x32folk.png`, AI Town's bundled folk atlas, cropped to the top-left 96×128 region). Index 0 is NOT broken; it renders the same character as every other index.

### Severity

**P3 — pre-PixelLab: zero visual issue.** All sprites currently look identical regardless of index. The default-to-0 behavior has no user-visible effect today.

**P2 — post-PixelLab: silent visual collision.** Once Cooper's distinct atlases land, every auto-onboarded attendee without an overlay seed will render with the SAME sprite (whatever Day-5 art assigns to index 0). For a 9-attendee state with manual seed it doesn't matter; for 50+ auto-onboarded attendees it produces a visually homogeneous map.

### Minimal fix (ships in a CREATE OR REPLACE VIEW migration, <10 LOC)

Replace the COALESCE default with a hash-derived expression that distributes deterministically across all 50 sprites:

```sql
-- In both village_attendees and village_attendees_public:
COALESCE(o.larry_atlas_index, ABS(hashtext(u.id::text)) % 50) AS larry_atlas_index
```

Properties:
- Stable per-user (same UUID always picks the same sprite).
- Even-ish distribution across 0..49 (Postgres `hashtext` is well-mixed).
- No coordination with manual seeds: explicitly seeded rows still override; unseeded rows fall back to the hashed default.
- Zero risk pre-PixelLab — output is the same identical placeholder sprite either way.
- Once PixelLab atlases land, all 50 sprites are immediately and automatically distributed across the auto-onboarded cohort.

**Trade-off:** the hash is non-cryptographic and can collide with curated seed picks (Carter's manually-assigned sprite 42 might collide with a future attendee whose hash also lands on 42). Acceptable for cosmetic-only data; if a real conflict shows up, the curated seed wins (it's explicit).

**Alternative considered: round-robin from a reserved "generic" pool (sprites 30–49).** Smaller pool, more visual repetition. Rejected — using all 50 sprites is better variety with no downside.

### Ships before May 30?

Yes — single CREATE OR REPLACE VIEW migration, no schema change. Bundle with the Gap 3 spawn-distribution fix into one Phase 3.5 migration. ~15 minutes total work.

---

## Gap 2 — Nothing writes to `agent_positions`

### Current state — the BIG gap

**Grep evidence (whole codebase, 2026-05-17):** zero callsites write to `public.agent_positions` anywhere in `instaclaw/` or `edgeclaw-village/`. The only references are:

- `instaclaw/scripts/_preflight-village-triggers.ts` — read-only schema probe
- `edgeclaw-village/src/hooks/serverGame.ts` — READS from the table (and from `agent_positions_public` view) for initial position load
- Migration files (`20260516200000_*`, `20260516210000_*`, `20260517000100_*`) — DDL only

The Phase 2 trigger `trg_agent_positions_dual_broadcast` fires AFTER INSERT OR UPDATE on `agent_positions` and emits the public broadcast. **The pipeline has no producer.**

For the 14 ambient NPCs this is fine: they run via a client-side engine (`src/lib/ambient-npc-engine.ts`) that emits synthetic `WalkEvent`s through React's reducer — *no DB involvement*. Each spectator browser independently animates them using wall-clock PDT time (deterministic so all viewers see the same thing).

For the 5 spectator-visible real attendees: they have rows in `village_attendees_public` (verified) but no rows in `agent_positions_public` (verified — 0 rows). On `serverGame.ts:loadInitialPositions()` returning empty, the player-init loop falls back to `attendee.home_tile_x/y`. They spawn at the seed positions **and never move**.

### What this looks like at Edge Esmeralda

Spectator viewers see:
- 14 ambient NPCs walking around to their schedule (Chef Larry between SingleThread and Big John's, Vintner Larry in vineyards, etc.) — animated, alive
- 5 anonymized real-attendee sprites standing motionless at plaza tiles (28–32, 35–39) for the entire event

Public viewers will reasonably wonder why some sprites move and others don't. The village reads as "diorama + walking dolls" rather than "live agent map."

### Severity

**P0 for the experience claim.** Phase 3 fundamentally was about "real attendees rendering on the map" — but rendering statically is the lesser half of that promise. The user-facing message we want to make is "300+ humans, their AI agents are alive in this village."

**Not P0 for the technical render** — the spectator route loads without errors, no toast spam, the data layer is correct. A static rendering is fine for "the village data layer is alive." But the experiential gap is meaningful.

### Three implementation options for May 30

Listed in order of fidelity vs. cost.

#### Option 2A — Replicate the ambient pattern for real attendees (RECOMMENDED for May 30)

Hand-script daily schedules for the 5 spectator-visible attendees in a new file `data/attendee-routines.ts` (mirror of `data/ambient-routines.ts`). Extend the ambient engine to consume both sets. Walks are CLIENT-SIDE synthetic emissions through the same reducer — same wall-clock-driven determinism as ambient NPCs, so all viewers see the same thing.

**Pros:**
- Reuses proven pattern with zero new infrastructure
- No backend writes; no new cron; no Postgres trigger involvement
- Visually indistinguishable from "real" walk-driven motion
- Schedules can be themed per attendee (Timour visits Edge HQ, Carter visits the library, etc.)
- ~50 LOC per attendee schedule × 5 attendees = ~250 LOC total

**Cons:**
- Schedules are static — same routine every day. Edge attendees actually doing things at the event won't drive in-village motion.
- The engine bypasses the Phase 2 broadcast pipeline entirely. The trigger architecture stays dormant for real attendees.
- New attendees added during the event would also need hand-scripted routines OR sit static until edited.

**Recommended for May 30** because:
- Cooper can hand-script 5 thoughtful routines in 2-3 hours.
- Pattern is debuggable, contained, has no new failure modes.
- Real-walk integration (Option 2C) becomes Phase 4 with the trigger pipeline already proven via this client-side path.

#### Option 2B — Cron-driven random walks

Vercel cron at `/api/cron/village-walk-tick` running every 30s. Query edge_city attendees whose `last_proxy_call_at` is within the last hour (active users). For each, advance their `agent_positions` by one tile toward a random walkable destination. UPSERT fires the Phase 2 trigger → broadcast → spectator clients see the walk.

**Pros:**
- Real backend-driven walks; exercises the full Phase 2 pipeline end-to-end (catches the realtime delivery bug we couldn't probe last week)
- Auto-extends to new attendees as they're provisioned
- Ties motion to user activity (active users move; idle users don't)

**Cons:**
- More infrastructure (new cron route, walkable-tile map, pathing logic)
- ~200-300 LOC
- Random destinations look meaningless ("why is Carter walking in circles?")
- Vercel cron min interval is 1 min on free tier; might need to chunk per-call

**Rejected for May 30** — higher build cost, lower visual quality than 2A.

#### Option 2C — Real agent activity → village walks

When an edge_city agent receives a Telegram message (or any user interaction), the agent's response handler emits a walk event toward a destination informed by the interaction. E.g., user asks bot about food → bot walks toward SingleThread. Plus periodic idle walks.

**Pros:**
- Highest fidelity — village genuinely reflects what agents are doing
- Best Edge Esmeralda story: "Timour just messaged his agent; you can see Timour's avatar walking to the cafe to look up the menu"

**Cons:**
- Requires VM-side code (a skill or middleware on every edge_city VM)
- 13-day timeline doesn't fit safely
- Skill rollout needs fleet reconciler integration
- Untested code paths under live event load

**Rejected for May 30** — Phase 4 candidate.

### Recommendation

**Ship Option 2A.** Authoring the 5 attendee routines becomes a half-day of Cooper's curation work + ~2 hours of engine plumbing on my side. The result is visually equivalent to "agents are alive" for the public reveal. Phase 4 adds 2B or 2C for genuine activity-driven motion.

### Implementation sketch (Option 2A)

1. **New file `edgeclaw-village/data/attendee-routines.ts`** mirroring `data/ambient-routines.ts` structure. Keyed by `agent_id` (the anonymized spectator-mode label, which is what the spectator client uses for player lookup) AND by `user_id` (for authenticated mode). Or — keyed by `user_id` UUID, with a client-side `anonymize_user_id` helper to map at lookup time.

2. **Extend `src/lib/ambient-npc-engine.ts`** to also drive attendee routines. The engine already accepts a `getPlayers: () => Map<GameId, Player>` callback — it can iterate any subset of players, not just ambient ones. Add an `ATTENDEE_ROUTINES` consumer that uses the same `currentEntry(...)` schedule-lookup logic.

3. **Schedule content (Cooper-curated):** 5 attendees × ~6 schedule entries (morning at hotel → mid-morning at plaza → lunch at restaurant → afternoon at library → evening at theater → home). Routines diverge by attendee so each has a distinct personality. Wall-clock PDT-driven, same as ambient.

4. **Key handling for spectator mode:** the engine needs to know which Player is which when looking up routines. The Player Map is keyed by `GameId<'players'>`. We hash either `user_id` (auth mode) or `agent_id` (spectator mode) to seed the GameId. Routine lookup needs to start from `user_id` and convert. Helper: client-side mirror of `village.anonymize_user_id()`. ~10 LOC.

5. **Wall-clock-PDT for spectator viewers** — they're not in their own timezone necessarily. The village always uses PDT (already established via `village-clock.ts`). Routines should also be PDT-driven so they match ambient NPCs.

### Ships before May 30?

**Yes — Option 2A.** Estimated ~6 hours of work distributed:
- ~2 hours engine plumbing
- ~3 hours Cooper-curated routine content for 5 attendees
- ~1 hour testing + screenshot

Could ship by 2026-05-20 with buffer.

---

## Gap 3 — Spawn pile-up at the default tile

### Current state

`village_attendee_overlay` defaults `home_tile_x = 30, home_tile_y = 37` (plaza gazebo). All 9 currently-seeded attendees have distinct home_tile values within a 5×5 grid around the plaza — manual placement.

**At 50+ attendees** without manual seeding, the COALESCE returns the default for all unseeded rows. Worst case: 41 sprites stacked at (30, 37) on frame 1 of the spectator render. Visually unreadable. Even with z-order they overlap.

### Severity

**P1 for May 30.** With current 9 attendees and manual seeds, no issue. But if edge_city grows during the 13-day window (likely — more attendees signing up daily) and auto-onboarded attendees don't get manual seeds, they pile at the plaza. Operationally: someone has to manually seed every new VM, OR we fix the default.

Mitigated by the same manual-seeding workflow Cooper used today for the 9. But that's operational toil — defeats the auto-VIEW design.

### Minimal fix (ships in the same Phase 3.5 migration as Gap 1)

Define a SQL function `village.default_spawn_tile(user_id uuid, axis text) → int` that hashes the user_id to one of N curated walkable tiles. Replace the COALESCE defaults:

```sql
-- In both village_attendees and village_attendees_public:
COALESCE(o.home_tile_x, village.default_spawn_tile(u.id, 'x')) AS home_tile_x,
COALESCE(o.home_tile_y, village.default_spawn_tile(u.id, 'y')) AS home_tile_y,
```

**Function design:**

```sql
CREATE OR REPLACE FUNCTION village.default_spawn_tile(uid UUID, axis TEXT)
  RETURNS INT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  WITH tiles(x, y) AS (
    VALUES
      -- Plaza tiles (8 spots around the gazebo)
      (28, 35), (30, 35), (32, 35),
      (28, 37),           (32, 37),
      (28, 39), (30, 39), (32, 39),
      -- Hotel Trio area (north)        — 8x5 building, picks 3 spawn tiles outside it
      (24, 12), (28, 12), (32, 12),
      -- West-side hotels (h2hotel, Healdsburg, Harmon Guest House)
      (22, 35), (23, 35),
      (22, 39), (23, 39),
      (22, 43), (23, 43),
      -- SingleThread approach
      (35, 33), (37, 33),
      -- Library / Carnegie
      (29, 44), (31, 44),
      -- Cafe / Flying Goat plaza approach
      (35, 41),
      -- Memorial Bridge end
      (28, 56), (30, 56),
      -- East vineyards (sparse)
      (55, 35), (58, 35),
      -- West vineyards
      (5, 30), (8, 30)
  ),
  indexed AS (
    SELECT x, y, ROW_NUMBER() OVER () - 1 AS idx
    FROM tiles
  )
  SELECT CASE axis WHEN 'x' THEN x ELSE y END
  FROM indexed
  WHERE idx = (ABS(hashtext(uid::text)) % (SELECT COUNT(*) FROM indexed));
$$;
```

Properties:
- ~27 curated walkable tiles spanning all major landmarks (hotels, plaza, library, cafe, bridge, vineyards)
- Hash-determined: each attendee gets a stable spawn — same UUID always maps to the same tile
- Distribution is even-ish (`hashtext` is well-mixed)
- Walkability is curated by hand (every tile in the VALUES list is known walkable)
- New attendees auto-distributed; no manual seed needed for sane spawns

**Risk:** the hand-curated tile list might include tiles that LOOK walkable but the map's tile data marks otherwise. Mitigation: verify each tile against `bgTiles` in `data/healdsburg.ts` post-implementation. Since the map generator uses deterministic tile placement, this is a one-time check.

**Alternative considered: random walkable tile via map data scan.** Would require materializing the walkable-tile set into Postgres, more setup, no real benefit over a curated 27-tile list.

### Ships before May 30?

**Yes.** Bundle with Gap 1 into one Phase 3.5 migration. Total: ~50 LOC SQL, plus a 30-min pass-1 verification (does each curated tile actually render at a walkable map cell). Could ship in <2 hours total.

---

## Phase 3.5 — Bundled Recommendation

All three fixes ship in a **single Phase 3.5 migration**: `village_attendee_view_defaults.sql`. Contents:

1. `CREATE OR REPLACE FUNCTION village.default_spawn_tile(uuid, text) → int` (Gap 3)
2. `CREATE OR REPLACE VIEW village_attendees AS ...` with updated COALESCEs for both sprite-hash (Gap 1) and spawn-hash (Gap 3)
3. `CREATE OR REPLACE VIEW village_attendees_public AS ...` mirror update

No table mutations. No DROP/recreate. Pure view definitions. Bundled apply in <10 seconds. Safe.

**The harder fix is Gap 2 (motion).** That's a separate Phase 3.6 (`attendee-routines.ts` + engine extension + Cooper's curation pass). Ships in 6 hours of focused work.

### Migration apply order

1. **Phase 3.5 (view defaults)** — pure SQL, ships first, low risk. Both Gap 1 and Gap 3 closed.
2. **Phase 3.6 (motion engine)** — village frontend change. Ships second. Gap 2 closed for the 5 visible attendees. Phase 4 picks up activity-driven motion later.

### Severity-stack for May 30

| Gap | Pre-fix state | Severity for May 30 | Ships before May 30? |
|---|---|---|---|
| Gap 1 (sprite) | All sprites visually identical (placeholder) — invisible problem until PixelLab lands | P3 today, P2 post-PixelLab | Yes, in Phase 3.5 |
| Gap 2 (motion) | 5 attendees static at seed positions; ambient NPCs walking around them | P0 for "alive village" experience claim; P2 for technical render | Yes via Option 2A (client-side routines) in Phase 3.6 |
| Gap 3 (spawn) | New attendees stack at plaza | P1 (manifests only if cohort grows mid-event) | Yes, in Phase 3.5 |

---

## What I'm NOT recommending for May 30

- **Backend cron walks (Option 2B)** — wrong fidelity for the cost.
- **Real activity-driven walks (Option 2C)** — too much VM-side work for 13 days.
- **PixelLab atlas integration** — Cooper's parallel art work; Phase 3.5 prepares for it via hash-default but doesn't depend on it.
- **Schema changes** — no new tables. All three fixes are functions/views.

## Asks

Cooper greenlights → I ship Phase 3.5 (Gap 1 + Gap 3) as one migration to `pending_migrations/`. After he applies + I `git mv`, we move to Phase 3.6 (Gap 2 routines). Cooper provides routine content / personalities for the 5 visible attendees:

- Timour Kosters (sprite 32 at plaza NW)
- Seref Yarar (sprite 34 at plaza N)
- Seren Sandikci (sprite 36 at plaza NE)
- Katherine Jones (sprite 40 at plaza E)
- Carter Cleveland (sprite 42 at plaza S)

OR Cooper delegates routine authoring to me with a brief like "give each one a 6-stop daily routine that fits Edge Esmeralda's vibe."

Either way: Phase 3.5 ships first (no content dependency); Phase 3.6 ships after a routine pass.
