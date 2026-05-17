# Village Attendees — Phase 3 Design (D14/D15 follow-up)

**Status:** Design proposal awaiting Cooper's decision on Option A / B / C.
**Deadline:** Apply before May 30, 2026 (Edge Esmeralda event start, 13 days from 2026-05-17).
**Audience scope at launch:** 300+ Edge Esmeralda attendees, plus public-spectator viewers.
**Pre-conditions:** Phase 1 (`agent_positions` table, applied 2026-05-16) + Phase 2 (4 dual-channel triggers, applied 2026-05-17) live in production.

---

## Summary

Phase 3 lands the `village_attendees` data layer + the two anonymized public views (`village_attendees_public`, `agent_positions_public`) that the village frontend already expects. After Phase 3, the spectator route at `https://edgeclaw-village.vercel.app/spectator` will render real Edge Esmeralda attendees (anonymized) walking around the Healdsburg map, not just the 14 hand-scripted ambient NPCs.

Three architectural options proposed below. **Recommendation: Option B (hybrid — small overlay table + view).** Reasoning is in §"Options" and §"Recommendation."

---

## Design decisions

The six questions Cooper raised, addressed in order. Each section has the question, the analysis, and the locked decision.

### 1. Who are the attendees? Table-vs-view trade-off

**Question:** For Edge Esmeralda specifically, attendees are humans whose agents run on `edge_city` partner VMs. There are 9 in production today (8 healthy, 1 configure_failed). Do we need a dedicated `village_attendees` table, or can attendees be derived as a view over existing data?

**Analysis:**

The data we already have on every edge_city attendee, queryable from base tables today:
- `instaclaw_users.id` (UUID), `instaclaw_users.email`, `instaclaw_users.full_name`
- `instaclaw_vms.assigned_to` (FK to users), `instaclaw_vms.partner`, `instaclaw_vms.health_status`, `instaclaw_vms.telegram_bot_username`

The data we don't have anywhere yet (village-specific):
- `larry_atlas_index` (which sprite to render — 0..49)
- `home_tile_x`, `home_tile_y` (spawn position)
- `spectator_visible` (opt-out toggle)
- `description` (the attendee's bio line for tap-to-inspect; can fall back to `full_name` or null)

That four-column metadata gap is the fundamental driver of the table-vs-view choice. The data has to live *somewhere*. Three places it could live:

1. **Add columns to `instaclaw_users` or `instaclaw_vms`** (Option A). Most direct, but pollutes the most heavily-used base tables in the codebase with village-specific data. `instaclaw_users` has every user across every product surface; tacking `larry_atlas_index` onto it is poor abstraction. Every future read of `instaclaw_users` would carry these unused columns.

2. **Small dedicated overlay table** (Option B). A narrow table keyed by `user_id` that holds *only* the four village-specific columns. Other tables untouched. The `village_attendees` view joins `instaclaw_vms` (filter `partner='edge_city'`) + `instaclaw_users` (for `full_name`) + the overlay (for sprite/spawn/opt-out). LEFT JOIN means attendees appear even before their overlay row exists (defaults kick in).

3. **Fully dedicated `village_attendees` table** (Option C). Holds user_id, full_name copy, all the columns. Decoupled from VM. Most flexible but most coordination cost (sync from instaclaw_vms; risk of drift).

**Decision: Option B (hybrid).** Reasons:

- The "attendees are VM owners with partner='edge_city'" relationship is already accurate and queryable; duplicating it into a separate table (Option C) creates a sync problem we don't have today.
- Option A polutes base tables with concerns that aren't theirs. The cost of "every future query against instaclaw_users carries 4 unused columns" compounds.
- Option B keeps the village-specific metadata in one narrow place, leaves base tables alone, and ships in the same migration window as Options A and C (one CREATE TABLE + 3 CREATE VIEW statements).
- For partner expansion (Eclipse, Devcon, etc.), the overlay scales naturally: `village_attendee_overlay.partner` column (or just rely on the joined `instaclaw_vms.partner` filter in each per-partner view).

### 2. What does `serverGame.ts` actually need?

**Question:** The frontend code is what defines the contract. What columns does it query?

**Re-read of `src/hooks/serverGame.ts` (2026-05-17):**

`loadAttendees(client, mode)` at lines 499–532:
- `mode === 'authenticated'`: `SELECT * FROM village_attendees`
- `mode === 'spectator'`: `SELECT * FROM village_attendees_public`
- Returns `attendees: VillageAttendee[]` where the type is:
  ```ts
  type VillageAttendee = {
    user_id?: string;       // auth mode
    agent_id?: string;      // spectator mode
    full_name?: string;     // auth mode (PII)
    description: string | null;
    larry_atlas_index: number;
    home_tile_x: number;
    home_tile_y: number;
    spectator_visible: boolean;
  };
  ```
- Maps attendee → `PlayerDescription` via `attendeeKey(att) = att.agent_id ?? att.user_id`. Hashes the key to a `GameId<'players'>`. Renders character as `'larry' + larry_atlas_index padded to 2 digits` (e.g., `larry07`).

`loadInitialPositions(client, mode)` at lines 534–568:
- `mode === 'authenticated'`: `SELECT * FROM agent_positions`
- `mode === 'spectator'`: `SELECT * FROM agent_positions_public`
- Returns `Map<string, AgentPosition>` keyed by `positionKey(pos) = pos.agent_id ?? pos.user_id`.

Player-init loop at lines 244–283:
- For each attendee: lookup initial position by `attendeeKey(att)`. If missing, fall back to `{tile_x: attendee.home_tile_x, tile_y: attendee.home_tile_y, facing_dx: 0, facing_dy: 1, is_moving: false, ...}`.

**Schema contract (locked):**

`village_attendees` (auth-mode view) — must expose every column with these exact names:

| column | type | nullable | notes |
|---|---|---|---|
| `user_id` | uuid | no | the canonical identifier in auth mode |
| `full_name` | text | yes | from instaclaw_users; null if missing |
| `description` | text | yes | bio line; null OK |
| `larry_atlas_index` | int | no | 0..49 |
| `home_tile_x` | int | no | tile coord (typically 0..63 on current map) |
| `home_tile_y` | int | no | tile coord |
| `spectator_visible` | bool | no | gates the public view |

`village_attendees_public` (spectator-mode view) — must expose:

| column | type | nullable | notes |
|---|---|---|---|
| `agent_id` | text | no | `village.anonymize_user_id(user_id)` — `"agent_NNNN"` |
| `description` | text | yes | non-PII bio line OK |
| `larry_atlas_index` | int | no | sprite — public-safe |
| `home_tile_x` | int | no | spatial — public-safe |
| `home_tile_y` | int | no | spatial — public-safe |
| `spectator_visible` | bool | no | always `true` here (view filters on it) |

Note: `full_name` and `user_id` are **excluded** from the public view. That's the privacy guarantee at the schema level. Even if a future client bug tries to read `full_name` in spectator mode, PostgREST returns nothing — the column doesn't exist on the view.

`agent_positions_public` (spectator-mode view) — must expose:

| column | type | nullable | notes |
|---|---|---|---|
| `agent_id` | text | no | `village.anonymize_user_id(user_id)` |
| `tile_x`, `tile_y` | int | no | current position |
| `facing_dx`, `facing_dy` | int | no | facing vector |
| `is_moving`, `is_thinking`, `is_speaking` | bool | no | activity flags |
| `activity_emoji` | text | yes | emoji-only (soft-enforced, see §"Activity emoji hardening" below) |
| `activity_until` | timestamptz | yes | expiry timestamp |

`user_id` excluded. Filtered via INNER JOIN with `village_attendees_public` on `agent_id` (or equivalent) so opted-out attendees disappear from position broadcasts too.

**This contract is identical across all three options.** Only the implementation differs.

### 3. Character assignment (larry_atlas_index)

**Question:** Where does the sprite index come from? Hash-derived? Manual? User-chosen?

**Analysis:**

- **Hash-derived (`larry_atlas_index = hash(user_id) % 50`)**: stable, automatic, no UI needed. Risk: random-looking matches (the most reserved Edge attendee might get the menacing sprite). For 9 attendees on a 50-sprite range, collision odds are ~75% across the cohort (birthday problem) so 2-3 collisions are likely.
- **Manual assignment**: hand-pick a sprite per attendee. Best aesthetic match. ~5–10 min of Cooper's time for 9 attendees.
- **User-chosen at signup**: best agency. Doesn't fit the 13-day timeline (requires onboarding UI + retroactive prompt for existing attendees).

**Decision:** Manual assignment for the 9 known edge_city attendees, with a hash-derived computed default for any future attendee added post-migration. The overlay table stores `larry_atlas_index` as `NOT NULL DEFAULT 0` (a neutral "everyman" fallback); a one-time seed script populates the 9 with curated picks. Future attendees fall back to the default until manually assigned or until we add a signup UI.

Curation note for Cooper to confirm: spread the 9 across the 0..49 range avoiding ambient NPC indices already in use. The ambient routine file uses sprite indices 7 (Chef), 23 (Vintner), and others — see `data/ambient-routines.ts`. Safe-to-use range: 30..49 gives 20 sprites untouched by ambient NPCs.

**Soft consideration:** if any attendee is a known persona Cooper wants to character-match (e.g., Carter Cleveland of Edge City lead → assign a "lead" sprite), the seed block in the migration is the place to do it. Trivial to edit before applying.

### 4. Spawn positions (home_tile_x, home_tile_y)

**Question:** Where on the map do attendees spawn? Hand-assigned? Algorithmic?

**Map landmarks** (from `data/ambient-routines.ts` header comments — these are walkable, on the current 64×64 grid):

| Landmark | Tile | Size |
|---|---|---|
| Plaza center (gazebo) | (30, 37) | center |
| Plaza walkways | varied around 8×8 plaza | walkable |
| Hotel Trio | (24, 6) | 8×5 north |
| h2hotel | (22, 38) | 3×3 west |
| Hotel Healdsburg | (22, 42) | 3×3 west |
| Harmon Guest House | (22, 34) | 3×3 west |
| SingleThread Restaurant + Inn | (35, 31) | 3×3 |
| Carnegie Library | (30, 43) | 4×2 |
| Flying Goat Plaza Cafe | (35, 40) | 2×2 |

**Options:**

- **Hotel-distributed**: Edge attendees actually stay at one of the 4 hotels during the event. Spawning at their (eventual) IRL hotel is thematic. Requires Cooper knowing the room assignments — not all 9 might be in hotels (some may be local).
- **Plaza-clustered**: spawn all 9 around the plaza (e.g., tiles (28, 35), (29, 35), …, (32, 39)). They visibly cluster on first load; subsequent walks fan them out. Communicates "people gathering" — a good cold-start visual.
- **Random walkable**: pick any walkable tile per user. Looks scattered, less curated.

**Decision:** Plaza-clustered as the default seed (cold-start visual is best for the spectator reveal), with home_tile noted as "easily overridden per-attendee" so Cooper can swap in hotel-specific tiles for known attendees later.

Specific seed positions for 9 attendees (tiles around the 8×8 plaza centered on the gazebo at (30, 37)):

| Slot | Tile | Position relative to plaza |
|---|---|---|
| 1 | (28, 35) | NW corner |
| 2 | (30, 35) | N edge |
| 3 | (32, 35) | NE corner |
| 4 | (28, 37) | W edge |
| 5 | (32, 37) | E edge |
| 6 | (28, 39) | SW corner |
| 7 | (30, 39) | S edge |
| 8 | (32, 39) | SE corner |
| 9 | (30, 37) | center gazebo |

(9 slots for 9 attendees, slot 9 = gazebo for whoever Cooper wants to anchor visually.)

**Important:** these are *spawn* positions, not *destination* positions. Once the village engine reads the attendee's actual `agent_positions` row (driven by real walk events from the agent's VM), the spawn is overridden. For Edge Esmeralda Day 0 before any real walks have happened, the spawn is what viewers see.

### 5. Privacy: `spectator_visible` default

**Question:** TRUE (opted-in) or FALSE (must explicitly enable)?

**Analysis:**

Edge_city attendees signed up to Edge Esmeralda knowing the partner integration includes village rendering — opt-in by joining the event. Defaulting them to opted-in matches their consent.

However: the bar for "what shows up on a public anon channel" should err toward least-surprise. If an attendee later reads "I'm on the public village map" and didn't expect it, that's a complaint we don't want.

**Decision:** `spectator_visible BOOL NOT NULL DEFAULT true` for edge_city attendees, with two protections:

1. **Per-row explicit opt-out**: a future dashboard toggle (Phase 4) flips `spectator_visible = false` on the attendee's overlay row. Effect is instant (next page-load of `/spectator` excludes them; existing subscriber's WebSocket session would still see them until reconnect — acceptable for an opt-out that's not legally-required real-time).
2. **System-wide kill switch**: a separate Postgres GUC or env var that disables the entire public broadcast path (returns empty from the views, optionally drops the triggers). Not in this migration; flagged as a P0 lever for if anything goes wrong post-launch.

Test accounts in the cohort (`@charlie_test_2_bot`, `@edgeclaw_charlie_test_bot`, possibly `@edgeclaw1bot` and `@edgecitybot` which are Cooper's) probably want `spectator_visible = false` in the seed — Cooper can flip per-row in the seed block. Default everyone TRUE in the seed comment; Cooper edits the comment-out as needed.

### 6. RLS on the raw overlay table

**Question:** What RLS does the underlying overlay table need? Public views are the anon-safe interface; what about the table itself?

**Decision:**

The overlay table is the system-of-record for village-specific attendee metadata. Writes should be **service-role-only** (attendees are provisioned by the system, not self-registered for the village specifically). Reads should be available to authenticated roles (so the auth'd village view at `mode='authenticated'` works).

Policies:

```sql
ALTER TABLE public.village_attendee_overlay ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read (used by the authenticated village view)
CREATE POLICY overlay_select ON public.village_attendee_overlay
  FOR SELECT USING (
    auth.role() IN ('authenticated', 'service_role')
  );

-- Only service role can insert/update/delete (no self-registration via this table)
CREATE POLICY overlay_write ON public.village_attendee_overlay
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
```

**Anon role gets nothing on the raw table** — they only see the anonymized public view. This is the same defense-in-depth pattern as Phase 1's `agent_positions` RLS.

Future option: allow attendees to UPDATE their own overlay row (e.g., change their `larry_atlas_index` via a dashboard control). Add a `auth.uid() = user_id` policy when that UI ships. Not in this migration.

### 7. Activity emoji hardening (carried over from Phase 2 follow-ups)

**Question:** `agent_positions.activity_emoji` is bare `TEXT` with no length/character constraint. The trigger forwards it to the public payload. If app code ever writes a non-emoji string (e.g., a username), it leaks.

**Decision:** Add `CHECK (activity_emoji IS NULL OR length(activity_emoji) <= 8)` to `agent_positions` in this migration. 8 chars is enough for any emoji + a couple of variation selectors. Stops free-form text at the schema boundary.

This is the third Phase 2 follow-up landing in Phase 3 — included for free in all three migration options below.

---

## Three migration options

Each option produces the same client-facing schema contract (the three views with the columns serverGame.ts expects). They differ only in where the village-specific metadata lives.

### Option A — Columns on base tables

`ALTER TABLE instaclaw_users ADD COLUMN larry_atlas_index INT NOT NULL DEFAULT 0; ALTER TABLE instaclaw_users ADD COLUMN home_tile_x INT NOT NULL DEFAULT 30; ALTER TABLE instaclaw_users ADD COLUMN home_tile_y INT NOT NULL DEFAULT 37; ALTER TABLE instaclaw_users ADD COLUMN spectator_visible BOOL NOT NULL DEFAULT true; ALTER TABLE instaclaw_users ADD COLUMN village_description TEXT;` then CREATE VIEW village_attendees ...

**Trade-off:** Simplest to implement (no new table, no overlay JOIN). But it pollutes `instaclaw_users` with 5 columns that are only meaningful for the 9 edge_city attendees out of hundreds of users. Every future query against `instaclaw_users` carries unused columns. Phase 4 partner expansion (Eclipse, Devcon, …) would either reuse these columns across all partners (forcing a "one home tile across all events" model) or accumulate more partner-specific columns. The abstraction is wrong; this is a debt we'd pay forever.

### Option B — Hybrid overlay table + view (RECOMMENDED)

New table `village_attendee_overlay` with `user_id PK, larry_atlas_index, home_tile_x, home_tile_y, spectator_visible, description`. The `village_attendees` view is `instaclaw_vms WHERE partner='edge_city'` JOIN `instaclaw_users` LEFT JOIN `village_attendee_overlay`. LEFT JOIN with COALESCE means attendees appear with default metadata even before their overlay row exists (helpful for future attendees provisioned post-launch — they render at the default plaza spawn until manually placed).

**Trade-off:** Cleanest separation of concerns. Base tables untouched; village data is in one narrow place. Slight cognitive cost: "where does the data come from?" requires understanding the JOIN. For 9 attendees this is trivially manageable; for 9000 it scales fine (the overlay is keyed by user_id with a fast index). Phase 4 partner expansion is just "filter the view on a different partner" — same overlay table works because the partner filter lives in the view, not the metadata. Migration risk: one CREATE TABLE + 3 CREATE VIEW + 1 ALTER TABLE on agent_positions (for activity_emoji CHECK). Bounded, reversible.

### Option C — Fully dedicated `village_attendees` table

Drop the view; make `village_attendees` a real table with all the columns including a copy of `full_name`. Sync from `instaclaw_users` + `instaclaw_vms` via a trigger or periodic job.

**Trade-off:** Maximum flexibility. The table is self-contained and could outlive VM changes (e.g., if an attendee swaps VMs, the village attendee row persists). But there's nothing in Edge Esmeralda's MVP that requires this flexibility, and the cost is a sync problem we don't have today: VM gets reassigned → village_attendees needs to update; user changes name → village_attendees needs to update; partner field on VM changes → village_attendees needs to know. Each sync is a trigger or cron we'd have to write, test, and monitor. For 13 days before a live event, this is the wrong direction. Reserve Option C for when we genuinely need attendee identity decoupled from VM ownership — there's no use case for that today.

---

## Recommendation

**Option B (hybrid overlay table + view).**

Reasoning (recapped):

- Cleanest abstraction: village-specific data in one narrow place, base tables untouched.
- Lowest sync risk: the view derives attendee identity from `instaclaw_vms` ground truth; the overlay is metadata-only. Nothing to keep in sync.
- Fastest to ship: one new small table + three views + one ALTER. Single transaction.
- Scales naturally: future partners filter the view on a different partner; same overlay works.
- Most testable: the view's correctness can be verified against `instaclaw_vms` post-apply with a single SELECT.

---

## Seed data (post-apply, applies under Option B; Cooper-edits before running)

After Option B's migration is applied, seed the 9 edge_city attendees:

```sql
INSERT INTO public.village_attendee_overlay
  (user_id, larry_atlas_index, home_tile_x, home_tile_y, spectator_visible, description)
VALUES
  -- vm-050  @timmytimmytimbot  (Cooper's test bot — recommend spectator_visible=false)
  ('4e0213b3-c9e8-4812-9385-827786900b66', 30, 30, 37, false,  'cooper test agent'),
  -- vm-354  @edgeclaw1bot  (default-looking bot — possibly test; Cooper confirm)
  ('cc1d7227-345d-48a5-8a87-7c1ae451956e', 32, 28, 35, false,  'edge default'),
  -- vm-771  @manyakbotbot
  ('a8344b7a-d0a0-45df-8e00-675ae2d0d71a', 34, 30, 35, true,   null),
  -- vm-777  @SerenDippyBot
  ('3a2c2392-83cd-4635-b70c-51a67fac7b53', 36, 32, 35, true,   null),
  -- vm-780  @edgecitybot  (Cooper's edge bot — recommend spectator_visible=false)
  ('0a102415-75e4-4fff-b792-773609c63ff0', 38, 28, 37, false,  'cooper edge bot'),
  -- vm-859  @erinthegreat_bot
  ('1d1df916-2679-4ac5-9cee-1de542859f22', 40, 32, 37, true,   null),
  -- vm-917  @EdgeFriendBot  (Carter Cleveland per project memory)
  ('ef612ac6-f9a7-4e2c-ac22-aa3cc42a4180', 42, 28, 39, true,   'carter cleveland'),
  -- vm-922  @edgeclaw_charlie_test_bot  (test account; configure_failed currently)
  ('520e8d15-6f48-4150-a6d3-91022da09203', 44, 30, 39, false,  'charlie test'),
  -- vm-923  @charlie_test_2_bot  (test account)
  ('6f8882be-8713-4948-93e3-f6b043e67b86', 46, 32, 39, false,  'charlie test 2');
```

Cooper should review each row for:
- `larry_atlas_index`: visual variety, no clash with ambient NPCs (range 30-46 avoids ambient's 7 and 23)
- `spectator_visible`: I've defaulted Cooper's own bots + test accounts to `false`; flip per his judgement
- `description`: a one-line bio line. Public view exposes this; should NOT contain identifying info. Null is fine.
- `home_tile_x/y`: spawn position. Plaza-clustered defaults; swap for hotel-specific tiles if known.

The two test accounts (`@charlie_test_2_bot`, `@edgeclaw_charlie_test_bot`) and Cooper's own bots are flagged `spectator_visible=false` so they don't appear in the public render but stay reachable from the authenticated village view (useful for testing).

---

## Apply plan

Per CLAUDE.md Rule 56 and `village-dual-channel-migration-apply.md`:

1. Cooper picks Option A / B / C from this doc.
2. I `git rm` the two non-chosen migration drafts from `pending_migrations/`.
3. Cooper pastes the chosen migration into Supabase Studio against production. Reviews the post-apply verification block at the bottom of the migration file.
4. I `git mv pending_migrations/<chosen>.sql migrations/<chosen>.sql` and commit with apply evidence.
5. Cooper pastes the seed block (after editing `spectator_visible` flags for test accounts).
6. Smoke test: visit `https://edgeclaw-village.vercel.app/spectator`, confirm real attendees render at the seed positions alongside the 14 ambient NPCs.
7. End-to-end realtime check: agent's VM emits a walk event → broadcast lands on `village-public:edge-esmeralda-2026` → attendee moves on the spectator map.

Step 7 requires real walk traffic from at least one edge_city VM. The Edge bots emit walks on their own schedule; if no walk happens within 30 min of seed, manually trigger one by sending the bot a Telegram message that causes movement.

---

## Phase 4 follow-ups (carried forward, not in this migration)

- **Dashboard UI for `spectator_visible` toggle** — attendee-controlled opt-out without DB access.
- **System-wide kill switch** — GUC or env var to disable the entire public broadcast path in <60s.
- **Signup-time sprite picker** — replace the manually-seeded `larry_atlas_index` with user-chosen.
- **Per-attendee home_tile UI** — pick your "lives at" spot when joining the village.
- **Eclipse / Devcon partner expansion** — same overlay table, different view filter.
- **Realtime broadcast end-to-end probe** — design a synthetic-but-non-transactional probe that doesn't hit the `INSERT+DELETE`-in-same-transaction issue we saw in Phase 2.

---

## What I'm asking for

Cooper picks A, B, or C. (My recommendation: **B**.)

After the pick:
1. I delete the two non-chosen files from `pending_migrations/`.
2. Cooper edits the seed block's `spectator_visible` flags + `description` strings to taste.
3. Cooper pastes the chosen migration + the seed block into Supabase Studio.
4. I `git mv` and commit.
5. We're live for Edge Esmeralda's spectator render by May 30.
