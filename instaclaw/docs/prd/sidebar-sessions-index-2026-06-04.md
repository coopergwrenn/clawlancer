# PRD — Sidebar Sessions Index

**Date:** 2026-06-04
**Branch:** `feat/sidebar-restructure-phase1` (sidebar worktree)
**Status:** Proposed — awaiting green-light before any code
**Author:** sidebar terminal (Claude)

> A live, persistent index of the user's Command Center **sessions** (Chat threads + Tasks) in the
> left rail — a Pinned group on top, a unified recency list below — so a user can jump straight back
> into a past session and pin the ones they care about, without leaving for a separate page. It surfaces
> what's buried inside the `/tasks` workspace up into the always-visible rail.

---

## 0. Locked decisions (plan is built against these)

1. **Scope = web Command Center sessions only** — `instaclaw_conversations` (Chat) + `instaclaw_tasks` (Tasks).
   **NOT** the VM/Telegram agent sessions that `/history` shows (`/api/vm/conversations`, sourced from
   `instaclaw_vms`). Different data; out of scope.
2. **Unified-by-recency list with type glyphs** — chats and tasks interleaved in one list, sorted by last-touched,
   distinguished by a small glyph (not two separate sub-lists).
3. **Staged pinning** — Stage 1 ships `localStorage` pins; Stage 2 swaps to a server table behind one interface.
4. **Deep-link open is IN Stage 1** — clicking a row resumes that exact session.

Non-negotiable build discipline (carried from the sidebar work so far): **flag-off + mobile byte-identical**
(the section only renders inside `SidebarShell`, which is already gated `navMode === "sidebar" && isDesktop`);
**real glass material** (the `.glass` / `.skill-pill` recipe, reused from the surfaces just shipped); **iOS-spring**
collapse (unchanged); **preview-first, LOOK at it** before any push.

---

## 1. Investigation findings (deepened — ground truth)

All citations are real, read against the live code.

### 1.1 The two data sources

| Entity | Table | List endpoint | Single-item endpoint | Sort / limit |
|---|---|---|---|---|
| **Chat** | `instaclaw_conversations` (`migrations/20260219_multi_chat.sql`) | `GET /api/chat/conversations` | `GET /api/chat/conversations/[id]` (+ `/messages`) | `updated_at DESC`, limit **100**, `is_archived=false` |
| **Tasks** | `instaclaw_tasks` (`migrations/20260215_tasks.sql`) | `GET /api/tasks/list` | `GET /api/tasks/[id]` | `created_at DESC`, limit ≤200 (default 50) |

**Conversation fields:** `id, user_id, title, created_at, updated_at, is_archived, last_message_preview, message_count`.
**Task fields:** `id, user_id, title, description, status (queued|in_progress|completed|failed|active|paused),
is_recurring, frequency, streak, last_run_at, next_run_at, result, error_message, tools_used[], created_at, updated_at`.

Both tables have an `updated_at` auto-update trigger (per their migrations) → `updated_at` is the universal
"last touched" key for the unified recency sort.

They are **separate entities, separate id spaces, separate routes**. There is no unified endpoint — the merge is
client-side. Both list endpoints are session-authed (user-scoped) and already exist; **Stage 1 needs no new backend.**

### 1.2 Pinning — server-side does not exist for sessions

`is_pinned` exists **only** on `instaclaw_library` (`migrations/20260216_library.sql`). Toggle precedent:
`PATCH /api/library/[id] { is_pinned }`; list sorts `is_pinned DESC` then sort field; filter `?pinned=true`.
Neither `instaclaw_tasks` nor `instaclaw_conversations` has a pin column. Established interim store convention:
`localStorage` with `instaclaw_*` keys (e.g. `instaclaw_welcome_collapsed`, `instaclaw_sidebar_collapsed`).

### 1.3 `/history` is a different source — no redundancy

`/history` (`app/(dashboard)/history/page.tsx`) calls `GET /api/vm/conversations` (reads `instaclaw_vms` → the VM's
on-disk agent/Telegram session log). That is the **bot-side** conversation archive, NOT the web Chat tab. The new
Sessions index indexes the **web** Command Center. They never share data; `/history` stays as-is. (Possible *later*
label disambiguation — out of scope.)

### 1.4 The Command Center mount/hydration trace — and the THREE races deep-link must kill

`CommandCenterPage` is the lone default export (`app/(dashboard)/tasks/page.tsx:2098`), a single `"use client"`
component, **no `useSearchParams`, no `Suspense`** today. Relevant state + lifecycle:

- **`activeTab` initializes to `"tasks"`** (`:2099`). → **RACE 1 (wrong-tab flash):** a deep-link to a chat would
  paint the Tasks tab on first frame, then snap to Chat.
- **Tasks** load via `fetchTasks` (`limit=100`, `:2197`) in the initial effect (`:2223–2226`), keyed on `filter`
  (inits `"all"`).
- **Conversations** load via `loadConversations` (`:2616`): `GET /api/chat/conversations` → `setConversations` →
  **auto-select** (`:2624–2629`):
  ```js
  if (convs.length > 0) {
    setActiveConversationId((prev) => {
      if (prev && convs.some((c) => c.id === prev)) return prev;  // keep only if in the fetched 100
      return convs[0].id;                                         // else snap to most-recent
    });
  }
  ```
  → **RACE 2 (auto-select override):** if we set `activeConversationId` from a deep-link to a conversation **outside
  the first 100**, `convs.some(...)` is false → it gets silently **overwritten to `convs[0]`** (the newest chat).
  The user clicked session X and lands on session Y.
- **Messages** load via `loadConversationMessages` (`:2638`): fetches **by id** with a `loadingConvRef` latest-wins
  guard (`:2644`, `:2651`). → **RACE 3 is already mitigated for messages:** message loading works even when the id
  isn't in the list, and rapid switching can't show stale messages. But the conversation **row/title** still won't
  render (it's not in `conversations`), so we still need a fetch-by-id *hydration* for the header/list.
- **Create** (`createNewConversation`, `:2712`): sets `activeConversationId = null`; the row's id is created on first
  send (`POST /api/chat/conversations` → `setActiveConversationId`, `:2768/2776`). → a brand-new empty chat has **no
  id** until first message; it can't be deep-linked/pinned until then.
- **Rename** (`:2720`) and **archive** (`:2740`) are optimistic-local + PATCH; archive clears `activeConversationId`
  if it was active.
- **Task expand**: `setExpandedTaskId(toggle)` (`:3339`). No dedicated task route — "open a task" = Tasks tab +
  expanded card.
- **Precedent for the event bus:** the page already does
  `window.addEventListener("instaclaw:prefill-input", …)` (`:2256–2266`) — the exact pattern the freshness bus reuses.

### 1.5 Sidebar primitives available to reuse

`components/dashboard/sidebar-shell.tsx`: `useCollapseState()` (localStorage `instaclaw_sidebar_collapsed`),
`CollapsibleSection` (header/chevron, `hasActive`→force-open + `locked`→`<button disabled>`), `LIST_VARIANTS` /
`ROW_VARIANTS` / `CHEVRON_SPRING` (the iOS springs), `NavRow` (glass active pill via shared `layoutId
"sidebar-active-pill"`). The real-glass recipe lives in `globals.css` (`.glass` dashboard `:148–159`,
`.skill-pill.is-green` `:2776–2795`). `SidebarShell` is desktop-only and already a client component.

---

## 2. Architecture

### 2.1 Placement & structure

A new **dynamic** `SessionsSection`, inserted **between the Command Center hero anchor and the Workspace cluster**,
**default expanded**. It's a *variant* of `CollapsibleSection` — same header/chevron/iOS-spring/glass — but its body
is a live list with loading/empty states instead of a static array.

```
⌂ Command Center                  ← hero anchor (home / start new) — active only on BARE /tasks
─────────
▾ SESSIONS                        ← NEW dynamic collapsible section
    Pinned                        ← subgroup header, shown only when ≥1 pin resolves
      💬 RFT5 launch plan
      ⚡ Weekly investor update
    ◌ Research AI agents     2h   ← unified recent list (chats ⊕ tasks, type glyph + relative time)
    💬 Draft Q3 email        1d
    …  (cap ~6)
    See all in Command Center →   ← footer → /tasks
─────────
▾ WORKSPACE  …
▾ ACCOUNT & PLAN  …
```

**No `layout.tsx` change.** `SessionsSection` lives inside `SidebarShell` (already rendered by the layout's sidebar
return). This keeps the feature entirely off the cross-terminal `layout.tsx` collision surface. Files touched in
Stage 1: `sidebar-shell.tsx`, new `sessions-section.tsx`, new `use-sessions.ts`, new `use-pins.ts`,
`tasks/page.tsx` (deep-link wiring). **Nothing in `layout.tsx`.**

### 2.2 Data layer — `useSessions()` (merge / sort / identity)

A hook consumed by `SessionsSection`. Normalizes both entities into one row type:

```ts
type SessionType = "chat" | "task";

interface SessionRow {
  uid: string;          // `${type}:${id}` — namespaced, collision-proof, stable React key
  type: SessionType;
  id: string;           // raw entity id (for the single-item GET + deep-link param)
  title: string;        // conversation.title || "New chat"  |  task.title
  updatedAt: string;    // ISO; recency key
  recency: number;      // Date.parse(updatedAt) || Date.parse(createdAt) || 0
  statusHint?: TaskStatus; // tasks only — drives a faint status dot/glyph variant
  preview?: string;     // conversation.last_message_preview | task.description (optional, may be unused at 240px)
}

interface UseSessions {
  sessions: SessionRow[];   // merged, deduped, recency-desc
  loading: boolean;         // first load only (subsequent refetches don't blank the list)
  error: boolean;
  refetch: () => void;      // the single freshness entrypoint (see §2.3)
}
```

**Merge / sort / identity rules:**
- **Identity:** `uid = ${type}:${id}`. The two id spaces are namespaced so a chat and a task can never collide; `uid`
  is the React key (no key warnings, ever).
- **Sort:** stable recency-desc by `recency`; tie-break by `uid` (deterministic, so equal timestamps never reorder
  between renders).
- **Dedup:** ids are unique per table (PK) → no intra-list dupes. Across groups: **Recent = merged − pinnedKeys**,
  then top N. **Pinned** is resolved separately (§2.5). A session is never shown in both groups.
- **Fetch budget:** `GET /api/tasks/list?limit=20` + `GET /api/chat/conversations` (already capped 100). Merge,
  sort, slice. Two small queries.

### 2.3 The single freshness model (ONE model, not three)

All triggers funnel into **one** `refetch()` with an **in-flight guard** (coalesce — never two concurrent fetches;
a trailing call after an in-flight one re-runs once). `refetch` never blanks the list (only the first load shows
skeletons); on error it keeps the last-good list.

Triggers:
1. **Mount** → one `refetch()`.
2. **Event bus** → `window.addEventListener("instaclaw:sessions-changed", refetch)`. The `/tasks` page
   `window.dispatchEvent(new Event("instaclaw:sessions-changed"))` after **every** session mutation:
   new conversation (first send), rename, archive, new task created, task status change. This is what makes the rail
   update *instantly* on a page action (no waiting for the poll). Mirrors the existing `instaclaw:prefill-input`
   precedent (`tasks/page.tsx:2256`).
3. **Visibility/focus** → on `window "focus"` and `document "visibilitychange"→visible`, `refetch()` (debounced ~1s
   so focus+visibility firing together coalesce to one).
4. **Poll** → `setInterval(refetch, 30_000)`, **gated twice**: only while `document.visibilityState === "visible"`
   AND only while the Sessions section is **expanded** (collapsed = no poll; it refetches on expand). Frugal: a
   collapsed or backgrounded rail makes zero network noise.

**Why this composes cleanly (the coherence argument):** the sidebar and the `/tasks` page each hold their own list
copy. They converge because (a) the page refetches its own lists on its own actions, and (b) the event bus forces
the sidebar to refetch on those same actions — so within one `refetch` both surfaces agree. List-coherence =
event + poll + focus (one `refetch`). **Active-coherence is a separate, orthogonal mechanism: the URL** (§2.4) — so
"which list" and "which is active" never fight each other.

### 2.4 The deep-link mount/hydration sequence (kills all three races)

**Source of truth for "which session is active" = the URL.** Scheme:
`/tasks?v=chat&c=<conversationId>` and `/tasks?v=tasks&t=<taskId>` (`v` = tasks|chat|library).
Both the page (state) and the sidebar (highlight) **read** it; in-page selection **writes** it; there is exactly one
source, so the two clients cannot disagree.

**Suspense:** wrap the page body — `export default function CommandCenterPage(){ return <Suspense fallback={null}>
<CommandCenterInner/></Suspense> }` — because `useSearchParams()` requires a Suspense boundary in the App Router.
The sidebar's read is wrapped **inside `sidebar-shell.tsx`** (Suspense around `SessionsSection`), so **no
`layout.tsx` change**.

**Mount sequence (first paint already correct):**

1. **Kill RACE 1 (wrong-tab flash):** lazy-init the tab from the URL so the very first render is right:
   ```js
   const sp = useSearchParams();
   const [activeTab, setActiveTab] = useState<Tab>(() => {
     const v = sp.get("v");
     if (v === "chat" || v === "tasks" || v === "library") return v;
     if (sp.get("c")) return "chat";   // infer from a chat deep-link with no explicit v
     if (sp.get("t")) return "tasks";
     return "tasks";                    // unchanged default
   });
   ```
2. **Kill RACE 2 (auto-select override):** lazy-init the active conversation from the URL **and** make a non-null
   active id authoritative so `loadConversations` can't snap it to `convs[0]`:
   ```js
   const [activeConversationId, setActiveConversationId] = useState<string|null>(() => sp.get("c"));
   // in loadConversations auto-select — replace the `convs.some(...)` guard:
   setActiveConversationId((prev) => prev ?? (convs[0]?.id ?? null));
   ```
   Dropping the `convs.some` check is safe because the *only* reason it existed was to fall back when the active
   conversation was archived/deleted — and archive/delete **already** set `activeConversationId = null` locally
   (`:2744`). So a non-null active id is, by construction, a deliberate selection (deep-link or in-page click) and
   must be honored even when it's outside the fetched 100.
3. **Kill RACE 3 (deep-linked id outside the loaded list):** messages already load by id (`loadConversationMessages`,
   verified). For the **row/title** to render, add a hydration step after `loadConversations` resolves:
   - If `activeConversationId` is set and **not** in `convs`, `GET /api/chat/conversations/[id]`.
     - `200` → merge/prepend into `conversations` (title + header render correctly).
     - `404` or `is_archived` → stale link → clear active, strip `c` from the URL (`router.replace`, `scroll:false`),
       fall back to `convs[0]` (or empty/new chat). **Self-heal.**
   - For a `t` deep-link: force `filter="all"` (so the task isn't filtered out), `setExpandedTaskId(t)`; if `t` not
     in the loaded tasks, `GET /api/tasks/[id]` → merge; `404` → strip `t`. Then scroll the expanded card into view.

**Post-mount sync (sidebar → page while already on `/tasks`):** clicking a sidebar Link to `/tasks?...` when already
on `/tasks` does **not** remount the page; it updates `useSearchParams`. An effect keeps state synced, **guarded** to
prevent loops (only `setState` when the URL value actually differs from current state):
```js
useEffect(() => { syncStateFromUrl(sp); }, [sp]);  // guarded setters inside
```
**In-page selection writes the URL** so the sidebar highlight follows: every `setActiveConversationId(id)` /
`setExpandedTaskId(id)` / tab switch also `router.replace('/tasks?v=…&c|t=…', { scroll:false })`. No loop: the
selection handler sets state *and* writes the URL; the sync effect sees state already matches → no-op.

**Result:** zero wrong-tab flash (lazy init), zero wrong-session (authoritative id), zero "session not found" on a
valid id (fetch-by-id hydration), and graceful self-heal on a truly stale link.

### 2.5 The pin abstraction (Stage 1 → Stage 2 is a drop-in swap)

One interface; the consuming component never changes when the backend swaps.

```ts
type PinKey = `${SessionType}:${string}`;   // opaque, namespaced — same shape both backends

interface PinStore {
  pins: PinKey[];
  isPinned: (key: PinKey) => boolean;
  togglePin: (key: PinKey) => void;          // optimistic; instant UI
  ready: boolean;                            // hydrated yet (gates a flash of "unpinned")
}
function usePins(): PinStore;
```

- **Stage 1 (localStorage):** key `instaclaw_pinned_sessions` = `JSON<PinKey[]>`. Read on mount → `ready=true`;
  write on toggle; broadcast a `instaclaw:pins-changed` event + listen for cross-tab `storage` events so multiple
  mounts/tabs stay in sync. Optimistic, per-device, zero backend.
- **Stage 2 (server table):** **same interface.** `GET /api/sessions/pins` on mount → `PinKey[]`; `POST {key}` /
  `DELETE {key}` on toggle (optimistic local + revalidate); `localStorage` becomes a read-through offline cache.
- **The drop-in property:** `SessionsSection` depends only on `{ pins, isPinned, togglePin, ready }`. Stage 2 changes
  **only** `use-pins.ts` internals + adds the route + the migration. Nothing above the interface changes — no UI
  rewrite.

`PinKey` is intentionally opaque + namespaced: localStorage stores the joined string; the server stores
`(session_type, session_id)` rows; both map to the identical `PinKey[]`.

### 2.6 Active-session highlight + active-section interaction

- The Sessions section participates in the existing collapse map (new key `"sessions"`) and the
  **active-section-protection**: when a session row is active, the section **force-opens + locks** (same `hasActive`/
  `locked` pattern — you can't collapse the section that's hiding your current session).
- **Active predicate** for a session row: `pathname === "/tasks" && sp.get("c"|"t") === this.id`.
- **layoutId pill — the conflict, and the fix:** the active pill is a shared `layoutId "sidebar-active-pill"`.
  Today Command Center's `NavRow` is active when `pathname === "/tasks"`. With deep-link params present, **both**
  Command Center *and* the active session row would claim the pill → two elements, one `layoutId` = broken animation.
  **Fix (required Stage-1 change):** make Command Center active **only on bare `/tasks`** —
  `pathname === "/tasks" && !sp.get("c") && !sp.get("t")`. Session rows reuse the same `layoutId`. The predicates are
  now mutually exclusive → exactly one element owns the pill → the single glass pill **travels smoothly from Command
  Center to the active session row** (and back). Elegant, and no new pill.

---

## 3. UX specification

- **Row:** type glyph + title (single-line truncate) + faint relative time (e.g. `2h`, `1d`). Chat glyph = message
  bubble; task glyph = a status-tinted dot/zap (in-progress = pulsing blue, failed = red, else neutral — reuse the
  existing `StatusDot` palette). On hover: a Pin affordance (the `Pin` lucide icon, already in the app) toggles pin.
- **Counts:** Pinned shows all resolved pins, capped at ~12 with "+N more → /tasks" if extreme; Recent caps at ~6,
  then "See all in Command Center →". The rail scrolls (the squish fix already makes the nav scroll), but the section
  self-limits so it never crowds Workspace/Account off-screen.
- **Pinned subgroup header** is shown **only** when ≥1 pin resolves (no empty "Pinned" label).
- **Empty (new user / no sessions):** one subtle inline line — "No sessions yet — start one in Command Center →"
  (a link, not a big card; it's a rail section).
- **Loading (first load only):** 3 skeleton rows matching the existing `ConversationListSkeleton` style. Subsequent
  refetches do **not** blank the list.
- **Long titles:** CSS `truncate` (single line, ellipsis); the 240px rail width is the constraint; full title in a
  `title=` tooltip.
- **Active row:** the glass active pill (shared layoutId, §2.6); section force-open + locked while active.
- **Default state:** expanded.

---

## 4. Edge cases (every one, with its resolution)

| # | Case | Resolution |
|---|---|---|
| 1 | Empty (no sessions) | Subtle inline prompt → `/tasks`. Pinned header hidden. |
| 2 | Loading | 3 skeleton rows, first load only; refetch never blanks. |
| 3 | Long titles | Single-line `truncate` + `title=` tooltip. |
| 4 | **Deleted-but-pinned** | Resolve pin against merged list; if absent, `GET …/[id]`: `200` → render; `404` → **self-heal unpin**. Distinguishes "outside window" (resolves) from "deleted" (404). |
| 5 | **Archived-but-pinned** | List endpoint already filters `is_archived=false`; pin resolution treats `is_archived=true` as drop + self-heal unpin. *(Assumption A3 — verify the single-conversation GET returns archived rows.)* |
| 6 | Many pins | Show all (user-curated), cap display ~12 + "+N more → /tasks"; nav scrolls so layout never breaks. |
| 7 | Rapid switching | Messages: `loadingConvRef` latest-wins (verified). URL write latest-wins. Highlight = current URL → never stale. `refetch` in-flight guard. |
| 8 | New unsaved chat (no id) | Can't pin/deep-link until first send creates the row; on send the page dispatches `sessions-changed` → rail shows it. |
| 9 | Pinned task changes status | Pin key is the stable task id; survives status change; glyph updates on next refetch. |
| 10 | Rename elsewhere | Page dispatches `sessions-changed` → rail refetch → new title. |
| 11 | Tab hidden during poll | Poll skipped (visibility gate); refetch on return-to-visible. |
| 12 | Offline / fetch error | Keep last-good list; no blank; retry next trigger. |
| 13 | Active-section + dynamic body | When a session is active → force-open + lock; otherwise normal collapsible. Loading/empty don't force-open. |
| 14 | Stale deep-link (deleted conv) | Fetch-by-id `404` → clear active, strip `c`/`t` from URL, fall back to `convs[0]`/new chat. |

---

## 5. Scope split & staging

### Stage 1 — the whole usable feature (NO new backend)

Pure UI on existing endpoints + the deep-link wiring:
- `SessionsSection` (dynamic collapsible, real glass, iOS spring) above Workspace, inside `SidebarShell`.
- `use-sessions.ts` — merge `GET /api/tasks/list?limit=20` + `GET /api/chat/conversations`, normalize, sort, dedup.
- Single freshness model (event bus + 30s visible-and-expanded poll + focus, one `refetch`, in-flight guard).
- Deep-link into `/tasks`: Suspense wrapper; lazy-init tab/conversation from URL; drop the `convs.some` auto-select
  guard; fetch-by-id hydration + self-heal; post-mount sync effect; selection-writes-URL; page dispatches
  `sessions-changed` on all mutations.
- Sidebar rows = `<Link>`s to the deep-link URLs; active highlight from URL; **Command Center active-predicate
  refinement** (bare `/tasks` only) so the shared pill never double-claims.
- `use-pins.ts` (**localStorage** impl) behind the `PinStore` interface; hover Pin affordance; Pinned/Recent grouping;
  deleted/archived self-heal.
- Empty / loading states; "See all".

**Backend touched in Stage 1: none.** Uses `tasks/list`, `chat/conversations`, and the existing single-item GETs.

### Stage 2 — server pin sync (the ONLY new backend)

- **Migration** `instaclaw_session_pins (user_id uuid, session_type text, session_id uuid, created_at timestamptz,
  unique(user_id, session_type, session_id))` — RLS enabled **in the file** (Rule 60); `pending_migrations/` →
  apply → `git mv` to `migrations/` (Rule 56).
- **Route** `/api/sessions/pins` GET/POST/DELETE (session-authed → no middleware allow-list entry needed; confirm
  per Rule 13).
- **`use-pins.ts` impl swap** (localStorage → server, localStorage as offline cache). **Interface unchanged →
  `SessionsSection` untouched.**

---

## 6. Assumptions (flagged) & where real backend work is needed

- **A1 (locked):** scope = web Command Center sessions only.
- **A2:** `updated_at` is a reliable "last touched" for both tables (auto-update triggers exist). If a task's
  `updated_at` doesn't bump on every run, recency may lag slightly — acceptable for v1; revisit if it feels stale.
- **A3 (verify at build):** `GET /api/chat/conversations/[id]` returns archived rows with `200` (so the archived-but-
  pinned self-heal path is correct). If it `404`s archived rows, the self-heal still works (treats it as deleted) —
  either way handled, but confirm which.
- **A4:** "open a task" = Tasks tab + expanded card + scroll (there is no dedicated task detail route). Confirm this
  is the intended "resume."
- **A5 (verify at build):** wrapping the page body and the `SessionsSection` in `Suspense` for `useSearchParams` adds
  two small Suspense boundaries; the dashboard pages are already client/dynamic, so impact is minimal — confirm clean
  `next build` (no CSR-bailout error).
- **Backend needed:** **Stage 1 = none.** **Stage 2 = one table + one route** (the pins). That is the only real
  backend work in the entire feature.

---

## 7. Seams identified — and solved in this plan

| Seam | Where it would bite | Solved by |
|---|---|---|
| Wrong-tab flash | chat deep-link paints Tasks first | lazy-init `activeTab` from URL (§2.4 step 1) |
| Auto-select override | deep-linked conv outside first 100 → snaps to `convs[0]` | drop `convs.some` guard; non-null active is authoritative (§2.4 step 2) |
| Row missing for valid id | deep-linked conv not in list → no title/header | fetch-by-id hydration + merge (§2.4 step 3) |
| Stale deep-link | deleted/archived id in URL | fetch-by-id `404`/archived → self-heal, strip param, fall back |
| Two-client list divergence | sidebar vs page show different lists | one freshness model: event + poll + focus, single `refetch` (§2.3) |
| Two-client active divergence | sidebar highlight ≠ page selection | URL is the single source; selection writes it, both read it (§2.4) |
| layoutId pill double-claim | Command Center + active session both on `/tasks` | mutually-exclusive active predicates; single pill travels (§2.6) |
| localStorage → server rewrite | Stage 2 forces a UI rewrite | `PinStore` interface; only `use-pins.ts` internals swap (§2.5) |
| id-space collision / key warnings | chat id == task id by luck | namespaced `uid = type:id` (§2.2) |
| Pinned-but-gone | deleted/archived pin lingers | resolve + `404`/`is_archived` self-heal unpin (edge 4/5) |
| Poll cost | constant network noise | poll gated on visible **and** expanded (§2.3) |
| **Cross-terminal `layout.tsx`** | the command-center promote + sidebar both edit `layout.tsx` | **this feature touches `layout.tsx` zero times** — `SessionsSection` lives in `sidebar-shell.tsx`; deep-link lives in `tasks/page.tsx` (§2.1) |

---

## 8. File-by-file change list (Stage 1)

| File | Change |
|---|---|
| `components/dashboard/use-sessions.ts` (new) | merge/normalize/sort hook + the single freshness model |
| `components/dashboard/use-pins.ts` (new) | `PinStore` interface + localStorage impl |
| `components/dashboard/sessions-section.tsx` (new) | the dynamic collapsible section (glass + iOS spring), Pinned/Recent, rows, empty/loading, Suspense for its `useSearchParams` read |
| `components/dashboard/sidebar-shell.tsx` | mount `<SessionsSection>` between the Command Center anchor and Workspace; refine Command Center active predicate (bare `/tasks` only) |
| `app/(dashboard)/tasks/page.tsx` | `Suspense` wrapper; lazy-init tab/conv from URL; drop `convs.some` auto-select guard; fetch-by-id hydration + self-heal; post-mount URL→state sync effect; selection writes URL; dispatch `instaclaw:sessions-changed` on create/rename/archive/new-task/status-change |
| **`app/(dashboard)/layout.tsx`** | **untouched** |

---

## 9. Verification plan (failure-mode tests, per Rule 31)

Before any push, with the flag on (desktop), LOOK at it; with the flag off, prove byte-identical.

- **Happy:** open a chat from the rail → correct tab, correct conversation, highlighted; open a task → expanded +
  scrolled.
- **RACE 1:** hard-load `/tasks?v=chat&c=<id>` → Tasks tab never flashes (first paint is Chat).
- **RACE 2:** deep-link a conversation that is **not** in the first 100 → it stays selected (not snapped to newest).
- **RACE 3:** same as RACE 2 → the row/title renders (fetch-by-id hydration), messages load.
- **Stale link:** `/tasks?c=<deleted>` → self-heals (clears param, falls back), no "stuck empty."
- **Coherence:** rename/archive/new chat on the page → rail updates within the event tick (no manual refresh).
- **Freshness frugality:** background the tab / collapse the section → no polling network calls.
- **Pin lifecycle:** pin → persists across reload (localStorage); unpin; pin then delete the session → self-heal
  unpin; many pins → cap + "+N more".
- **Flag-off / mobile:** `SessionsSection` never mounts; `git diff` shows the top-nav path byte-identical.
- **Build:** `tsc --noEmit` + `npm run build` clean (incl. the Suspense boundaries).

---

## 10. Rollback / invariants

- The entire feature renders only inside `SidebarShell` (gated `navMode === "sidebar" && isDesktop`). Flag off →
  nothing mounts → top-nav + mobile byte-identical.
- The `/tasks` deep-link wiring is additive and **backward-compatible**: with no URL params, the page behaves exactly
  as today (tab defaults to `tasks`, `loadConversations` auto-selects the newest — the only change there is "don't
  override a deliberately-set id," which a bare load never has).
- Stage 2 is isolated to `use-pins.ts` + one route + one migration; reverting it falls back to localStorage pins.

---

**Awaiting green-light.** On approval: build **Stage 1** with the usual discipline — flag-off byte-identical, real
glass, iOS spring, preview-first on `:3017`, screenshot + self-critique before any push. Stage 2 (server pins) is a
clean follow-up swap behind the `PinStore` interface.
