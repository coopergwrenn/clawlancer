# Dashboard Sidebar Restructure — Planning Doc

**Status:** ✅ LIVE — Phases 1–3 shipped; the sidebar is **flipped ON in production** (`NEXT_PUBLIC_SIDEBAR_NAV=true`, 2026-06-05, deploy `instaclaw-48ulg4w56`, verified serving the sidebar on instaclaw.io, both viewports). Only remaining step: old-nav deletion (separate PR, ~1 week after the flip soaks).

**Build status (as of 2026-06-04, verified against live code on `main`):**
- **Phase 1 — sidebar shell behind flag — ✅ SHIPPED, dark.** Shell (`318185db`), desktop-only + collapsible clusters + navMode gating in `layout.tsx` (`705a9673`), navMode-aware tour `buildTourSteps()` (`168b3003`, copy `99ea1682`), glass material (`e83a5099`). The full **D3 IA** is built in the shell (Command Center anchor → `/tasks`, WORKSPACE + ACCOUNT clusters, Overview rename [D2], Credits, Edge City + Invite pinned). Gates/banners/overlay live in `layout.tsx`, applied before the nav branch.
- **Sessions index (sub-PRD) — ✅ SHIPPED, dark.** Stage 1 rail + deep-link (`d1f5770a`), Stage 2 durable server-backed pins (`ab96486c`).
- **Phase 2 — shift center of gravity — ✅ SHIPPED, dark (completionist pass 2026-06-04 → 2026-06-05).** Live View + Files (D4); re-entry CTAs + logo → `/tasks` (D1, `51ea60d7`); Billing↔Credits flywheel (D6, light); **Command Center full-height in the shell** (B1, `fdac2006` — input pins to bottom both viewports); **mobile off-canvas drawer** (D5/B2, `f178d4b9` — the sidebar now renders on mobile, so the flag governs BOTH viewports); **status strip** (§2.3 health-dot + credits in the rail header / mobile top bar — Unit C, `5fa210da`; two independent halves, credits fail-silent). **No remaining Phase 2 items.** Desktop icon-rail collapse: DEFERRED polish (not killed). Bottom-tab hybrid: KILLED.
- **Phase 3 — flip flag default-on + delete old nav — ✅ FLAG FLIPPED + LIVE (2026-06-05); old-nav deletion PENDING (~1wk soak).** `NEXT_PUBLIC_SIDEBAR_NAV=true` set in production (non-sensitive; value `od`-verified exactly `true`), redeployed (`instaclaw-48ulg4w56`, Ready), verified on instaclaw.io serving the sidebar (rail + Account cluster + status strip; no top-nav). The gate is `navMode === "sidebar"` (no `&& isDesktop`) so it governs BOTH viewports. Live gates re-exercised post-flip (2026-06-05): auth unauth → `/signin`; needsOnboarding/Rule-33 no-VM → `/channels`; edge-intent null-intent → `/edge/intents` — all pass. Old top-nav stays behind the flag for the ~1-week soak (instant rollback: `?nav=topnav` per-user, or unset the env var + redeploy), then a separate PR deletes it.

**Date:** 2026-06-03 (plan) · build status updated 2026-06-05 (flag flipped live)
**Author:** CC terminal (onboarding/dashboard)
**Reference inspiration:** ZO Computer (`coop.zo.computer`) — persistent left
sidebar: Home / Chats / Files / Automations / Plugins / Computer / Terminal /
Hosting; workspace selector pinned top; account + settings + dismissable
referral banner pinned bottom. Study the *pattern*, not the items.

---

## 0. The reframe (read this first)

This is a **navigation/layout change, not a feature change.** Nothing is
deleted. Every route, page, nav item, deep-link, and entry point on the Part 1
inventory either survives verbatim or is explicitly re-homed.

Two things move:

1. **The chrome** — top-nav tabbed bar → persistent left sidebar (SaaS workspace
   feel).
2. **The center of gravity** — the *workspace home* (what the logo points to,
   what a returning configured user lands on) shifts from **Dashboard** →
   **Command Center** (`/tasks`), our existing chat/agent surface and the
   ZO-equivalent.

**Critical invariant (Cooper, 2026-06-03):** *first-time / onboarding routing
does NOT change.* A brand-new user still lands on **Dashboard first** — it's the
getting-started/config screen they need. The gravity shift is for the
**day-to-day returning** experience, not the first-run. §2.1 proves these are
independent code paths, so we can do one without touching the other.

Good news this surfaces: the "workspace home" we want to elevate **already
exists** (Command Center). This is a **reorganization, not a net-new build.**
§2.3 confirms it's the right surface and flags the (small) gaps.

---

# PART 1 — Current-state inventory (the contract)

The restructure must preserve every item below. Read from the real files
(`app/(dashboard)/layout.tsx`, `middleware.ts`, route tree, `tour-steps.ts`),
not memory.

## 1.1 Every dashboard route

Source: `app/(dashboard)/` route tree + the `primaryNav`/`overflowNav` arrays in
`layout.tsx` + the partner-conditional `edgeCityNavItem`.

| Route | What it is | In nav today | tourKey | Reached by |
|---|---|---|---|---|
| `/dashboard` | Account/instance home: usage, credits, plan, agent health/status, model switch, World-ID verify, Virtuals toggle, reset bot, pro-tip | **Primary** "Dashboard" | `nav-dashboard` | Logo click; post-onboarding redirect (5× from `onboarding/done`); post-signin (`auth/page`); `/go/[code]`; marketing hero + `site-header` "Go to Dashboard"; `onboarding/web`; `edge/intents` continue |
| `/tasks` | **Command Center** — Tasks / Chat / Library tabs, chat input, quick-action chips, model selector, task cards. The agent-interaction surface. | **Primary** "Command Center" | `nav-command-center` | Nav; OnboardingWizard completion; tour (6 steps); `/tasks` floating CTA → `/floor` |
| `/heartbeat` | Agent pulse / wake schedule + health | **Primary** "Heartbeat" | `nav-heartbeat` | Nav; tour |
| `/floor` | "The Floor" — live/watch launch feature (public `/floor/[handle]` share view planned) | **Primary** "The Floor" | `nav-floor` | Nav; `/tasks` page floating CTA |
| `/earn` | Marketplace earning surface | **Primary** "Earn" | `nav-earn` | Nav |
| `/skills` | Skill/integration management | **Primary** "Skills" | `nav-skills` | Nav; OAuth callback `skills/connect/callback` → `/skills?connected=…` |
| `/edge/dashboard` | Edge City attendee dashboard | **Partner-conditional** (`partner==="edge_city"`) "Edge City" | `nav-edge-city` | Nav (edge only); `edge-city-card` on `/dashboard`. **Lives OUTSIDE `(dashboard)` group** — has its own layout |
| `/history` | Full record of conversations + tasks + results | **Overflow** "History" | `nav-history` | More menu; tour |
| `/files` | File manager (upload/download agent files) | **Overflow** "Files" | `nav-files` | More menu; tour; file-delivery deep-links |
| `/scheduled` | Recurring/scheduled tasks | **Overflow** "Scheduled" | `nav-scheduled` | More menu; tour |
| `/env-vars` | API key management | **Overflow** "API Keys" | `nav-api-keys` | More menu; tour |
| `/ambassador` | Referral/ambassador program | **Overflow** "Ambassador" | `nav-ambassador` | More menu |
| `/dashboard/credits` | Credits detail / buy more | **Overflow** "Credits" | `nav-credits` | More menu; back-link to `/dashboard` |
| `/settings` | Account settings (plan, bot info, Gmail personalization) | **Overflow** "Settings" | `nav-settings` | More menu; tour (3 steps); links from settings→billing, marketing docs, `edge/consent`, `world-id-banner` `#human-verification`; **gate-exempt** |
| `/billing` | Subscription/billing management | **Overflow** "Billing" | `nav-billing` | More menu; tour; 5× CTAs from `/dashboard`; `/upgrade` redirects; settings link; **gate-exempt** |

### Orphan / hidden routes — NOT in any nav array (must be accounted for)

| Route | What it is | ONLY reached by | Restructure note |
|---|---|---|---|
| `/live` | **Live agent desktop view** (watch the agent's screen in real time) | `desktop-thumbnail.tsx:51` card on `/dashboard` — no nav link | **Hidden gem.** Maps to ZO's "Computer." Recommend *promoting* to visible sidebar (§2.2). Already auth-protected in middleware. |
| `/dashboard/privacy` | Privacy/policy page | `edge/consent` link during Edge onboarding; direct URL; self back-link | Keep reachable; not nav-promoted. Edge-flow + Settings sub-link must survive. |
| `/billing/credit-packs` | Credit-pack purchase detail | back-link on the page itself; direct URL | Sub-route of `/billing`; keep reachable via Billing. Not nav-promoted. |

### Non-route items living in the nav chrome (must be re-homed, not lost)

| Item | Today | Action |
|---|---|---|
| Logo | top-left → `/dashboard` | Sidebar brand → **`/tasks`** (gravity shift, §2.1) |
| "More" overflow dropdown | houses 8 overflow routes + Support + Sign Out | **Dissolves** — every item gets a visible sidebar slot. Nothing lost. |
| Support (`mailto:help@instaclaw.io`) | in More menu | → bottom account area |
| Sign Out (`signOut({callbackUrl:"/"})`) | in More menu | → bottom account area |
| Restart-wizard button (Sparkles) | top-right; `PATCH /api/onboarding/restart-wizard` + `instaclaw:restart-wizard` event | → bottom account area ("Take the tour again") |
| Heartbeat health dot | red/grey dot on the "More" button (`/api/heartbeat/status` poll, 60s) | → dot on the **Heartbeat** sidebar item |
| `AgentbookHatBanner` | strip below nav, all routes | Preserve — render in shell below top bar / above content |
| `ChannelNudgeBanner` | strip below nav (web-only users) | Preserve — same |
| Dashboard gate overlay (`gated`) | full-screen overlay when WLD-only + gate flag on | Preserve verbatim — lives in shell |
| `OnboardingWizard` | persists across nav; driven by `data-tour` selectors + `setMoreOpen`/`tourControllingMore` | **High-risk coupling — see §1.4** |

## 1.2 The nav arrays (verbatim contract)

```
primaryNav = [ /dashboard, /tasks, /heartbeat, /floor, /earn, /skills ]
edgeCityNavItem = /edge/dashboard   (appended iff session.user.partner === "edge_city")
overflowNav = [ /history, /files, /scheduled, /env-vars, /ambassador,
                /dashboard/credits, /settings, /billing ]
menu-only (non-route) = Support(mailto), Sign Out, (restart-wizard btn separate)
```

## 1.3 Load-bearing / fragile systems (the danger list)

Everything a layout change can silently break. The shell must preserve each
verbatim.

1. **Auth gate** — `useEffect status==="unauthenticated" → router.replace("/signin")`
   + `if (status==="loading"||"unauthenticated"||needsOnboarding) return null`.
   The shell must keep these guards (no flash of content).
2. **`needsOnboarding` data-driven redirect** (layout.tsx:91–173) — the
   8-user infinite-loop fix (Rule 33). Fetches `/api/vm/status`, routes
   has-usable-VM→stay, configure_failed→`/deploying`, configuring→`/deploying`,
   no-VM→`/channels`, network-fail→`/connect`. **Must move verbatim into the
   shell.** Do not "tidy" it.
3. **Edge intent gate** (layout.tsx:216–270) — edge_city users with
   `indexLastIntentAt===null` bounced to `/edge/intents`, with the live-DB
   verify that fixes the 2026-05-23 redirect loop + the `edge_intent_skipped_at`
   localStorage escape hatch. **Move verbatim.**
4. **Dashboard access gate** (layout.tsx:298–332) — `NEXT_PUBLIC_ENABLE_DASHBOARD_GATE`;
   exempt paths `["/billing","/settings","/upgrade"]`; WLD-only → overlay.
   Note: neither `/dashboard` nor `/tasks` is exempt, so the gate fires equally
   on both → **no regression** when home moves to `/tasks`.
5. **Middleware (Rule 13)** — `middleware.ts`:
   - `protectedPages = [/dashboard, /settings, /billing, /admin, /tasks,
     /history, /files, /scheduled, /env-vars, /ambassador, /live, /floor]`
     (+ matcher with `:path*`). Every current route is already protected.
   - The reorg promotes no *new* route, so **no middleware change is required**
     for the nav move itself. **If we ever add a brand-new route, it MUST be
     added to `protectedPages` + `matcher` (Rule 13) — flag in PR.**
6. **Tour keys + OnboardingWizard coupling** — THE single most fragile piece.
   See §1.4.
7. **Heartbeat health poll** — `/api/heartbeat/status` every 60s, sets the dot.
   Re-home the dot, keep the poll.
8. **Timezone auto-sync** — `useEffect` POSTs `sync_timezone` on auth. Keep.
9. **Banners** (`AgentbookHatBanner`, `ChannelNudgeBanner`) — conditional
   render, no whitespace when hidden. Keep render position relative to content.
10. **Restart-wizard** — button + `PATCH /api/onboarding/restart-wizard` +
    `window.dispatchEvent(new Event("instaclaw:restart-wizard"))`. Re-home, keep
    wiring.

## 1.4 ⚠️ The tour coupling (highest-risk dependency)

`tour-steps.ts` drives the OnboardingWizard via **`data-tour` selectors** that
must exist in the DOM at tour time. New users see this tour — breaking it
breaks the first-run experience, the exact thing we're protecting.

Selectors the tour targets on the nav chrome:
`nav-dashboard`, `nav-command-center`, `nav-heartbeat`, `nav-history`,
`nav-more`, plus page-content selectors (`dash-*`, `tab-tasks/chat/library`,
`input-bar`, `quick-chips`, `page-heartbeat`, `page-files`, `page-scheduled`,
`page-api-keys`, `settings-*`, `page-billing-card`).

The booby-trap: step `nav-more` uses **`preAction: "open-more"` +
`keepMoreOpen: true`**, and the layout passes `setMoreOpen` + `tourControllingMore`
into `<OnboardingWizard>` so the tour can *open the More dropdown*. **In a
sidebar there is no More dropdown.** That step + its preAction + those two props
become dead/broken.

**Contract for the build:**
- Every surviving nav item carries its **exact same `data-tour={tourKey}`** on
  the new sidebar slot (so all page-targeted steps still resolve).
- The `nav-more` step + `open-more` preAction must be **removed or repointed**
  in a sidebar-aware tour variant — and `setMoreOpen`/`tourControllingMore`
  retired only when the sidebar is active.
- Tour changes ship **in lockstep** with the nav change (same phase), never
  lagging.

## 1.5 🔒 THE ONBOARDING-FIRST INVARIANT (do not touch)

These code paths determine where a **brand-new user first lands**. They MUST
remain pointing at `/dashboard`. The restructure does not edit any of them:

- `onboarding/done` → `/dashboard` (×5 exit points)
- `onboarding/web` → `/dashboard`
- `auth/page` (post-signin) → `/dashboard`
- `/deploying` non-Edge happy path → `/dashboard` (Edge → `/edge/intents` first)
- `/go/[code]` → `/dashboard`
- `edge/intents` continue → `/dashboard`

This is the load-bearing first-run flow. **Flagged as untouchable.** §2.1
proves the gravity shift lives in *different* code (logo + sidebar Home), so
these stay frozen.

---

# PART 2 — The restructure proposal

## 2.0 Three independent "where do I go" surfaces

The key insight that makes the routing nuance safe: "where the user goes" is
**three separate mechanisms**, individually controllable.

| Surface | Mechanism | Today | Proposed | Touches onboarding? |
|---|---|---|---|---|
| **A. First-land** (end of onboarding) | one-time `router.replace` at funnel end (§1.5) | `/dashboard` | **`/dashboard` (UNCHANGED)** | — (frozen) |
| **B. Workspace home** (logo + sidebar "Home" item) | `<Link href>` in the shell | `/dashboard` | **`/tasks`** | No |
| **C. Re-entry** (marketing "Go to Dashboard", `/go/[code]`) | external CTAs / redirects | `/dashboard` | **✅ RESOLVED (D1, `51ea60d7`): authed re-entry CTAs → `/tasks`; `/go/[code]` deep-link unchanged** | No |

Because A is a distinct one-time redirect, moving B to Command Center **cannot**
change where a new user first lands. A new user is *sent* to `/dashboard` by the
funnel; only *after* that does the logo/sidebar (B) point them to Command Center
as their ongoing home.

## 2.1 Every routing branch (explicit, so we don't break new users)

| User / action | Path taken | Lands on | Changed? |
|---|---|---|---|
| Brand-new user finishes onboarding (non-Edge) | `onboarding/done` → `replace("/dashboard")` | **Dashboard** | No (frozen) |
| Brand-new Edge user finishes deploy | `/deploying` → `/edge/intents` → continue → `/dashboard` | Intents, then **Dashboard** | No (frozen) |
| Brand-new user, *then* clicks logo / "Home" | shell `<Link href="/tasks">` | Command Center | New (B) |
| Returning configured user clicks logo | shell `<Link href="/tasks">` | Command Center | New (B) |
| Returning user opens any sidebar item | `<Link>` to that route | that route | Same set, new chrome |
| **Unconfigured** user somehow hits `/tasks` directly | `/tasks` is in `(dashboard)` group → `needsOnboarding` gate fires → `/channels`÷`/deploying`÷`/connect` | redirected to correct funnel step | **Safety net intact** — they can't "first-land" on `/tasks` |
| Edge user hits any `(dashboard)` route w/o intent | Edge intent gate → `/edge/intents` | intents | Unchanged |
| WLD-only user (gate on) hits `/tasks` or `/dashboard` | neither exempt → gate overlay | overlay on either | No regression |
| Authed user from marketing "Open InstaClaw" CTA | external CTA → `/tasks` (D1, `51ea60d7`) | Command Center | ✅ shipped (D1) |

**Why this is safe:** the only way a brand-new user reaches the app is via path
A (frozen → Dashboard). The `needsOnboarding` gate is the backstop: even if some
link sent an unconfigured user to `/tasks`, the gate redirects them out before
Command Center renders. So Command Center-as-home is purely a *returning,
configured-user* experience.

## 2.2 Proposed sidebar IA

> **Superseded by D3 (Decisions section).** The sketch below is the first-pass
> thinking; the **final, decided grouping is D3** — it moves Scheduled/History
> into Workspace and API Keys into Account, splits Workspace into two
> hairline-separated clusters, renames Dashboard→Overview, and pins
> Ambassador/Edge/account at the bottom. Read D3 as authoritative.

Form a strong opinion, then let Cooper tune. Principle: a flat primary cluster
(the agent you *use* daily) + a lower "Manage" cluster (your *instance/account*)
+ a pinned bottom (identity/referral/exits). ZO is flat-ish with ~8 items;
Linear groups lightly; Vercel separates project-scope from account-scope. We
have more surfaces than ZO, so light grouping earns its keep.

```
┌─────────────────────────────┐
│  ◈ InstaClaw      [+ new]    │  brand → /tasks ;  "+" = new chat/task (ZO-style, optional)
├─────────────────────────────┤
│  ▸ WORKSPACE                 │  (the agent — daily use; no header or subtle)
│   ⌂  Command Center   ⭐home │  /tasks
│   ≈  The Floor               │  /floor
│   ♥  Heartbeat        ● dot  │  /heartbeat   (health dot re-homed here)
│   ▢  Live View               │  /live        ← PROMOTED from hidden (ZO "Computer")
│   🧩 Skills                  │  /skills
│   🗀  Files                  │  /files       ← PROMOTED from overflow
│   ↗  Earn                    │  /earn
├─────────────────────────────┤
│  ▸ MANAGE                    │  (your instance + account)
│   ▦  Dashboard               │  /dashboard   ← demoted from home → "your instance" overview
│   ◷  Scheduled               │  /scheduled
│   ⌗  History                 │  /history
│   🔑 API Keys                │  /env-vars
│   ⚡ Credits                 │  /dashboard/credits
│   ▭  Billing                 │  /billing
│   ⚙  Settings                │  /settings
├─────────────────────────────┤  (pinned bottom)
│   ⚐  Edge City               │  /edge/dashboard   (iff partner === edge_city)
│   ◆  Invite & earn  ✕        │  /ambassador       (ZO-style referral banner; dismissable)
│   ───────────────            │
│   ● coop@…   ⚙  ↻tour  ⎋     │  account row: email · Settings · restart-tour · Sign out · Support
└─────────────────────────────┘
```

**What changed and why:**
- **Command Center = top of WORKSPACE, the home.** It's the thing you open to
  *do work* — exactly ZO's chat-first home. Logo points here.
- **Dashboard demoted to MANAGE** as "your instance overview" (usage / health /
  plan / model / verify). Still one click, still fully present, just no longer
  the gravity center. (Label: keep "Dashboard" or rename "Overview"/"Instance"
  — Open Q2.)
- **Promote `/live` → "Live View"** (ZO "Computer"). Today it's only reachable
  via a thumbnail card on Dashboard — a hidden gem. Surfacing it is a pure
  *additive* win; nothing lost.
- **Promote `/files`** into WORKSPACE — file manager is a "live-in-it" surface
  (ZO top-levels "Files").
- **The "More" dropdown dissolves** — all 8 overflow items get visible slots.
  Nothing deleted; the menu's contents are now first-class. Support / Sign Out /
  restart-tour move to the pinned account row.
- **Ambassador → bottom referral banner** (ZO's "Share Zo, earn $10"). It's
  growth chrome, not a workspace surface; the bottom slot fits it better and
  matches the reference.
- **Heartbeat health dot** re-homes onto the Heartbeat item (was on the "More"
  button, which no longer exists).
- **Edge City stays partner-conditional + pinned** — note it links *out* of the
  `(dashboard)` group into the edge layout (existing behavior; it loses the
  sidebar by design when you enter Edge).

Everything on the Part 1 inventory has a home. Cross-check: `/dashboard/privacy`
and `/billing/credit-packs` remain reachable via their parents (Settings/Edge
flow, and Billing) — not nav-promoted, as today.

## 2.3 Is Command Center hero-ready? (the "does elevating it expose gaps" check)

**Yes — it's the right surface.** From the code (`app/(dashboard)/tasks/page.tsx`):
it's a full agent surface — **Tasks / Chat / Library** tabs, a chat input bar,
quick-action chips, a model selector, rich task cards. It is *literally* our ZO
"What can I do for you?" equivalent. Elevating it is a reorg, not a build.

Small gaps elevating it exposes (none are blockers; all are post-reorg polish):

1. **No at-a-glance health/usage on Command Center.** A returning user landing
   here doesn't immediately see "am I healthy / credits left" — that lives on
   Dashboard. *Mitigation (optional, later):* a slim status strip in the shell
   header (health dot + credits remaining) visible on every route. Not required
   for v1.
2. **Heartbeat dot needs a new home** — handled (§2.2, moves to Heartbeat item).
3. **WLD-only gated users** — the gate overlay fires on `/tasks` exactly as it
   would on `/dashboard` (neither is exempt), so no regression; gated users
   still see the upgrade overlay either way.
4. **`needsOnboarding`/Edge gates already protect `/tasks`** (it's in the
   `(dashboard)` group), so an unconfigured user can never see a broken
   Command Center — they're redirected first.

Verdict: elevate Command Center. *(Update 2026-06-05 — the optional status strip is now SHIPPED: Unit C, `5fa210da`. Health dot + credits in the desktop rail header AND mobile top bar, two independent halves — the dot can't fail; credits is best-effort `GET /api/vm/usage` with a 4s abort, fail-silent so a usage-endpoint hiccup never degrades the nav.)*

## 2.4 SaaS sidebar principles applied (not vibes)

- **ZO Computer:** chat-home first; flat verb-noun items; account + referral
  pinned bottom; a persistent workspace selector top. → We mirror: chat-home
  (Command Center) first, referral + account bottom.
- **Linear:** light section grouping (Workspace vs personal), keyboard-first,
  collapsible. → We adopt light grouping (Workspace / Manage) and keep it
  collapsible-ready.
- **Vercel:** separates *project scope* from *account scope* in the nav. → Our
  WORKSPACE (the agent) vs MANAGE (the account/instance) split is the same
  instinct.
- **General:** primary nav = the 5–7 things users do *most*; everything else is
  one level down but still visible. The old "More" dropdown buried 8 real
  surfaces behind a click — the sidebar's vertical space lets us surface them
  without burying.

## 2.5 Responsive / mobile

A left sidebar must degrade. **Recommended: off-canvas drawer.**

- **Desktop (≥ lg):** persistent sidebar (≈240px), collapsible to an icon rail
  (≈64px) via a toggle (matches the ZO panel-collapse button top-left).
- **Mobile (< lg):** slim top bar (logo + hamburger + optional "+ new"); tapping
  the hamburger slides in the **full sidebar as an off-canvas drawer** with a
  scrim. The drawer contains **every** item — so mobile users get *more* than
  today's primary-icons + More-menu split, and nothing is lost.
- **Alternative (Open Q5):** hybrid — a bottom tab bar for the 4 most-used
  (Command Center, The Floor, Heartbeat, Dashboard) + hamburger drawer for the
  rest. More thumb-friendly, more work. Recommend starting with the pure drawer;
  add bottom-tabs later if usage warrants.

Either way: **every inventory item is reachable on mobile.** That's the
non-negotiable.

## 2.6 Blast radius (every file the change touches)

| File | Change | Risk |
|---|---|---|
| `app/(dashboard)/layout.tsx` | Extract chrome into a `SidebarShell`; preserve all 4 gates + banners + overlay verbatim; conditionally render sidebar vs current top-nav behind a flag | HIGH (gates must move exactly) |
| `components/dashboard/sidebar-shell.tsx` (NEW) | The sidebar nav component | MED |
| `components/onboarding-wizard/tour-steps.ts` | Sidebar-aware variant: drop `nav-more` step + `open-more` preAction; keep all page-target steps | HIGH (first-run tour) |
| `components/onboarding-wizard/OnboardingWizard.tsx` | Retire `setMoreOpen`/`tourControllingMore` when sidebar active | MED |
| `components/dashboard/desktop-thumbnail.tsx` | `/live` still linked here too (keep — sidebar is additive) | LOW |
| `middleware.ts` | **No change** for the reorg (no new routes). Only if a new route is added (Rule 13) | LOW |
| Marketing `hero.tsx` / `site-header.tsx` / `app/go/[code]/route.ts` | Only if Open Q1 = repoint re-entry → `/tasks` | LOW |
| `app/(dashboard)/dashboard/page.tsx` | Only if Open Q2 = relabel "Dashboard" → "Overview" (+ any internal "home" copy) | LOW |

Not touched: onboarding-completion redirects (§1.5), `/api/*`, the gate logic
(moved, not edited), all page bodies.

## 2.7 Safe rollout (lowest-risk path)

**Build the sidebar as a NEW shell alongside the old top-nav, behind a flag, and
flip only when proven.**

- **Phase 0 — this doc.** Plan + approval. (no code) — ✅ DONE.
- **Phase 1 — sidebar shell behind a flag, zero routing change. — ✅ SHIPPED, dark.**
  `layout.tsx` conditionally renders `<SidebarShell>` vs the current top-nav on
  a flag (`NEXT_PUBLIC_SIDEBAR_NAV`, or a session/cookie/`?nav=sidebar` preview
  toggle). All 4 gates + banners + overlay move into the shell **verbatim**.
  Logo still → `/dashboard`, every item present, **all `data-tour` keys carried
  over**, ship the sidebar-aware tour variant in the same phase. Cooper eyeballs
  at a preview URL / with the flag on; production users see the old nav.
  *Net effect: pure visual reskin, no behavior change.*
  *Shipped `318185db` (shell) + `705a9673` (desktop-only + gating) + `168b3003` (tour) + Sessions `d1f5770a`/`ab96486c`. The shell was built with the full D3 IA, so D4's Live View + Files promotion landed here too.*
- **Phase 2 — shift the center of gravity. — ✅ SHIPPED, dark.** Logo + sidebar "Home" → `/tasks`;
  promote `/live` + `/files` to visible slots; status strip.
  Onboarding redirects (§1.5) **untouched.** §2.1 branch table re-verified (both partners, fresh accounts).
  *Status: Live View + Files (D4) ✅; Command Center anchor + logo → `/tasks` ✅ (D1, `51ea60d7` — `sidebar-shell.tsx` logo verified → `/tasks` at both rail + mobile-top-bar); 3 re-entry CTAs → `/tasks` ✅ (D1); status strip ✅ (Unit C, `5fa210da`). All Phase 2 items shipped, dark.*
- **Phase 3 — flip the flag default-on. — ✅ DONE + LIVE (2026-06-05).** `NEXT_PUBLIC_SIDEBAR_NAV=true`
  set in production (non-sensitive; `od`-verified exactly `true`) + redeployed (`instaclaw-48ulg4w56`, Ready);
  verified serving the sidebar on instaclaw.io. Old top-nav stays behind the flag for ~1 week as instant
  rollback, then a separate PR deletes it (**only remaining step**).
  *The gate is `navMode === "sidebar"` (no `&& isDesktop`), so the flip governs BOTH viewports. Rollback:
  `?nav=topnav` per-user, or unset the env var + redeploy.*

This gives Cooper an eyeball gate before any user sees a change, and an
env-var/flag rollback at every step.

---

# PART 3 — Honest risk read

**Hardest / most fragile**
- **The tour (OnboardingWizard) coupling — §1.4.** New users see the tour, and
  it targets `data-tour` selectors + opens the now-gone "More" dropdown. If the
  sidebar ships without the tour variant in lockstep, the first-run tour breaks
  for exactly the users we're trying to protect. Mitigation: carry every
  `data-tour` key onto the sidebar; remove the `nav-more`/`open-more` step in the
  same phase; test the full tour on a fresh account before flag-flip.
- **Moving the 4 gates verbatim.** `needsOnboarding` (Rule 33 loop fix), the
  Edge intent gate (2026-05-23 loop fix), the dashboard gate, and the auth/
  null-render guards are battle-scarred. Extracting them into a shell is
  mechanical but must be **exact** — a dropped guard re-opens a known incident.
  Mitigation: move as a block, diff against original, don't refactor.

**Medium**
- **Logo → `/tasks` and the new-user invariant.** Safe *because* onboarding
  redirects are frozen and the `needsOnboarding` gate backstops direct `/tasks`
  hits — but this must be explicitly re-verified after Phase 2 (walk the §2.1
  table on a real fresh account, both Edge and non-Edge).
- **Mobile drawer is a net-new interaction.** Must guarantee every item is
  reachable; test the full inventory on a phone before flip.

**Low**
- Middleware needs no change (no new routes). Edge City still leaves the
  dashboard layout by design. Gate overlay behavior is unchanged between
  `/tasks` and `/dashboard`.

**What I was unsure about — now resolved.** All 7 prior open questions are
decided below (D1–D7), each researched and committed. The wizard migration is
fully specified in PART 4; the platform re-audit + completeness proof is PART 5.

---

# PART 4 — Wizard / Tour Migration (detailed)

The tour is the highest-risk coupling (§1.4) and the one new users actually
experience. This section solves it precisely — not "flag it," but a build spec
where every step lands on a real element and the sidebar makes the tour *better*.

## 4.1 How the tour engine actually works (verified from source)

- **`OnboardingWizard.tsx`** — state machine `loading→welcome→bot-verify→tour→
  complete→done`. The `tour` phase renders `<SpotlightTour>` with `startStep`,
  `onStepChange` (persists via `/api/onboarding/update-wizard-step`), `onComplete`
  (`/complete-wizard`), `onClose`, **`setMoreOpen`**, `navigateTo`. Resumes from
  the saved `currentStep` (`wizard-status`). Re-runs on the `instaclaw:restart-
  wizard` event (the sparkle button).
- **`tour-steps.ts`** — 27 ordered steps. Each: `selector` (a `data-tour` key),
  `title`, `description`, optional `navigateTo`, `preAction:"open-more"`,
  `keepMoreOpen`, `position`, `large`.
- **`SpotlightTour.tsx`** — on each step: navigates (400ms settle), calls
  `setMoreOpen(true)` iff `preAction==="open-more" || keepMoreOpen` else
  `setMoreOpen(false)`, then **polls the selector up to 15×200ms = 3s; if still
  missing it AUTO-SKIPS** to the next step (lines 189–207). `keepMoreOpen`
  positions the tooltip below the **hardcoded `[data-tour-dropdown="more"]`**
  (line 68). `setMoreOpen` + `tourControllingMore` (from the layout) are the
  More-menu coupling.

## 4.2 What actually touches the nav (coupling inventory)

Of 27 steps, **23 target page bodies** (`dash-*`, `tab-*`, `input-bar`,
`quick-chips`, `page-heartbeat`, `page-files`, `page-scheduled`, `page-api-keys`,
`settings-*`, `page-billing-card`) — confirmed by grep to live on **page
components, not the nav**, so they are **untouched** by the restructure.

Only **4 steps** reference nav chrome:

| Step | Selector | Today | Under sidebar |
|---|---|---|---|
| 1 | `nav-dashboard` | primaryNav item | Survives as the **Overview** sidebar item; copy reframe |
| 11 | `nav-command-center` | primaryNav item | Survives as the **Command Center** item; copy reframe (→ explicit "home") |
| 18 | `nav-history` | overflow item, **dropdown-only** | **LATENT BUG — auto-skipped today** (menu closed when the step runs; selector not in DOM → 3s retry → skip). Sidebar makes History a visible item → **step resurrected** |
| 19 | `nav-more` (+`open-more`+`keepMoreOpen`) | the More button/dropdown | **Does not exist in sidebar** — replaced |

Plus `SpotlightTour.tsx:68` hardcodes `[data-tour-dropdown="more"]`, and
`OnboardingWizard`/`layout` thread `setMoreOpen` + `tourControllingMore`. All of
this is the "More menu" machinery and **all of it retires in sidebar mode.**

## 4.3 Flag-period strategy (the cleanest, least-fragile approach)

During Phase 1–2 **both navs can render** (flag-gated), so the tour must work in
both. Options weighed:

- **(A) navMode-aware single builder — CHOSEN.** `tour-steps.ts` exports
  `buildTourSteps(navMode: "topnav" | "sidebar")`. Shared page steps defined
  once; the 4 nav-chrome steps differ by mode. `navMode` threaded
  layout → OnboardingWizard → SpotlightTour.
- (B) Do nothing, rely on auto-skip — **REJECTED.** The `nav-more` step would
  sit on a dimmed screen for 3s then skip in sidebar mode. Not "flawless."
- (C) Two duplicated arrays — **REJECTED.** Drift risk between near-identical
  copies.

Why (A) wins: single source of truth; **no dead-waits** (every sidebar step
resolves); `navMode="topnav"` returns **today's exact array → zero regression**
during the flag period; after Phase 3 we delete the topnav branch and it
collapses to just the sidebar steps.

**Resume-index safety:** keep both mode arrays the **same length and
index-aligned** — *replace* step 19 (`nav-more`) with a sidebar-native step at
the same index (`nav-manage-section`), don't remove it. A user mid-tour when the
flag flips then resumes on a sensible step. (Removing a step would shift every
later index by 1 → a resuming user lands one step off.)

## 4.4 The sidebar tour, step by step (the "make it better" design)

New users still **land on `/dashboard`** (onboarding-first invariant), so the
tour starts where they are, reframes Dashboard as instance control, then walks
them to their true home (Command Center), and ends back on Command Center.

| # | Selector | navigateTo | Change vs today |
|---|---|---|---|
| 1 | `nav-dashboard` (now "Overview" item) | — | **Copy reframe:** "You're on your Overview — your agent's control panel: health, usage, plan. But your home base is the Command Center; we'll head there next." |
| 2–10 | `dash-usage … dash-pro-tip` | /dashboard | **Unchanged** (page body) |
| 11 | `nav-command-center` | — | **Copy reframe:** "This is your Command Center — your agent's home. Where you'll spend your time: tasks, chat, and everything it makes." |
| 12–16 | `tab-tasks/chat/library`, `input-bar`, `quick-chips` | /tasks | **Unchanged** |
| 17 | `page-heartbeat` | /heartbeat | **Unchanged** |
| 18 | `nav-history` (visible sidebar item) | — | **Resurrected** (was auto-skipped). Highlights the real History item. |
| 19 | **`nav-manage-section`** (NEW key on the Account group) | — | **Replaces `nav-more`.** "Your account lives here — plan, credits, billing, settings, API keys. All one click away (no more digging through a menu)." Drops `open-more`/`keepMoreOpen`. |
| 20 | `page-files` | /files | **Unchanged** |
| 21 | `page-scheduled` | /scheduled | **Unchanged** |
| 22 | `page-api-keys` | /env-vars | **Unchanged** |
| 23–25 | `settings-*` | /settings | **Unchanged** |
| 26 | `page-billing-card` | /billing | **Unchanged** |
| 27 | `input-bar` (recurring-tasks finale) | /tasks | **Unchanged** — ends on Command Center = home ✓ |

Net: **23 untouched, 2 copy reframes (1, 11), 1 resurrected (18), 1 replaced
(19).** One new `data-tour` key: `nav-manage-section`.

## 4.5 Mobile: the `open-drawer` coupling (a new, cleaner mirror of `open-more`)

On mobile the sidebar collapses to an off-canvas drawer (D5), so the 4 **nav-item
steps (1, 11, 18, 19)** target elements that are hidden until the drawer opens —
exactly the problem `open-more` solved for the old dropdown. So we reintroduce a
cleaner equivalent:

- Add a `preAction: "open-drawer"` (mobile-only) to the 4 nav-item steps. The
  shell exposes `setDrawerOpen` (mirroring the old `setMoreOpen`); the wizard
  calls it for those steps on mobile, and **closes** the drawer for page-content
  steps so it doesn't cover the page. On desktop (persistent sidebar) it's a
  no-op. This is the sidebar-era replacement for the entire `setMoreOpen` /
  `tourControllingMore` / `keepMoreOpen` mechanic — narrower (4 steps, mobile
  only) and not coupled to a hardcoded dropdown selector.

## 4.6 Precise file-by-file edits (build spec)

1. **`components/dashboard/sidebar-shell.tsx` (NEW)** — every nav item carries
   `data-tour={tourKey}` with the **exact existing keys**: `nav-dashboard`
   (on the Overview item), `nav-command-center`, `nav-heartbeat`, `nav-floor`,
   `nav-earn`, `nav-skills`, `nav-edge-city`, `nav-history`, `nav-files`,
   `nav-scheduled`, `nav-api-keys`, `nav-ambassador`, `nav-credits`,
   `nav-settings`, `nav-billing`. Add **`data-tour="nav-manage-section"`** on the
   Account-group container. Heartbeat item carries the **health dot** (moved off
   the old More button). **No** `nav-more`, **no** `data-tour-dropdown="more"`.
   Expose `setDrawerOpen` for the mobile tour.
2. **`tour-steps.ts`** — convert the default export to `buildTourSteps(navMode)`.
   `topnav` = today's 27 verbatim. `sidebar` = the §4.4 array (+ `open-drawer`
   preAction on steps 1/11/18/19). (Grep confirms **only `SpotlightTour` imports
   it**, so the signature change is contained.)
3. **`SpotlightTour.tsx`** — accept a `navMode` prop; `const tourSteps =
   buildTourSteps(navMode)`. Add `open-drawer` handling alongside `open-more`
   (mobile). Guard the `keepMoreOpen`/`[data-tour-dropdown="more"]` block to
   topnav mode (in sidebar there are no `keepMoreOpen` steps, so it's naturally
   inert — guard for clarity).
4. **`OnboardingWizard.tsx`** — accept `navMode`; pass it + `setDrawerOpen` down.
   In sidebar mode `setMoreOpen`/`tourControllingMore` are no-ops (still accepted
   so topnav is unchanged).
5. **`app/(dashboard)/layout.tsx` → shell** — pass `navMode` to the wizard; in
   sidebar mode pass `setMoreOpen={()=>{}}` + a throwaway `tourControllingMore`
   ref and the real `setDrawerOpen`. Topnav path unchanged.
6. **Page bodies — ZERO changes.** All 23 page-content `data-tour` selectors stay
   exactly where they are.

## 4.7 Pre-flip verification checklist

- Fresh-account tour in **sidebar mode**: all 27 steps land on a real element;
  **no dimmed dead-waits**; the History step highlights a real item; the
  `nav-manage-section` step highlights the Account group; the finale lands on
  Command Center.
- **Mobile**: nav-item steps open the drawer (`open-drawer`); page steps close it.
- **Resume across a flag flip** lands on a sensible step (same-length arrays).
- **topnav mode (flag off)** is byte-identical to today (regression guard).
- **Restart-wizard** (sparkle, relocated to the account row) still fires
  `instaclaw:restart-wizard` and re-runs the tour.

**Bar met:** a new user's post-restructure tour is flawless — every step points
at something real, History (dead today) finally works, and the Account-group
step is more honest than "your stuff is hidden in this menu."

---

# PART 5 — Full re-audit & completeness confirmation

## 5.1 Method

Re-walked the **entire** app route tree (every group + top-level), grepped every
`data-tour`, every dashboard chrome-component link, the `/upgrade` entry points,
and the marketing re-entry CTAs. Cross-checked against §1.1.

## 5.2 Full route tree, classified

- **`(dashboard)` group — 18 pages — IN SCOPE.** All 18 appear in §1.1.
  **Complete — zero missed dashboard routes.** ✓
- **`/edge/dashboard`** — partner nav item (own layout); pinned in the new IA,
  links out of the group (existing behavior).
- **Adjacent surfaces reachable FROM dashboard chrome/pages (exits — preserved,
  not nav items, all on page bodies/banners that don't move):** `/upgrade` +
  `/upgrade/success` (gate overlay btn `layout:589` + dashboard CTAs), `/channels`
  (channel-nudge banner + `needsOnboarding`), `/connect` + `/deploying`
  (`needsOnboarding`), `mailto:help@instaclaw.io`, `/settings#human-verification`
  (world-id banner), `/edge/dashboard` (edge-city-card), `/live`
  (desktop-thumbnail — **the only entry to Live today**).
- **NOT dashboard surfaces (separate layouts, unreachable from the dashboard nav;
  out of scope, untouched):** `(admin)/*`, `(hq)/*`, `(auth)/*`
  (signin/signup/auth/auth-error/privacy/terms), `(marketing)/*` (landing, ~25
  blog posts, consensus, docs, token, pricing, faq, use-cases, browser-relay,
  notify), `(onboarding)/*` funnel (connect, deploying, gmail-connect,
  onboarding/done|provider|web, plan), `edge/*` (byob, claim, consent, intents,
  plaza, setup, sponsors, root), `edge-city/*`, `edge-v1-backup/*` (backup),
  `dev/*` (dev-only previews), `launches/[addr]`, `preview/*`, `app/page.tsx`
  (landing).
- **Confirmed:** no dashboard nav/chrome links to `admin`/`hq`/`consensus`/
  `launches`/`token` (grep empty).

## 5.3 Completeness — every item has a home (nothing deleted/orphaned)

| Inventory item | New destination | Status |
|---|---|---|
| `/dashboard` | Overview (Account & Plan group) | re-homed (demoted) |
| `/tasks` | Command Center ⭐ (Workspace, top) | re-homed (elevated to home) |
| `/heartbeat` | Heartbeat (Workspace, +health dot) | survives |
| `/floor` | The Floor (Workspace) | survives |
| `/earn` | Earn (Workspace) | survives |
| `/skills` | Skills (Workspace) | survives |
| `/history` | History (Workspace) | survives + **tour step fixed** |
| `/files` | Files (Workspace) | **promoted** from overflow |
| `/scheduled` | Scheduled (Workspace) | survives (moved Manage→Workspace) |
| `/env-vars` | API Keys (Account & Plan) | survives |
| `/ambassador` | Invite & earn (pinned bottom) | survives |
| `/dashboard/credits` | Credits (Account & Plan) | survives + Billing flywheel (D6) |
| `/settings` | Settings (Account & Plan + account row) | survives |
| `/billing` | Billing (Account & Plan) | survives + Credits flywheel (D6) |
| `/live` | **Live View (Workspace)** | **promoted** from hidden + thumbnail kept |
| `/dashboard/privacy` | reachable via edge/consent + Settings | preserved (no nav slot, as today) |
| `/billing/credit-packs` | reachable via Billing | preserved (no nav slot, as today) |
| `/edge/dashboard` | Edge City (pinned, edge_city only) | survives |
| Logo | → `/tasks` | re-homed |
| "More" dropdown | dissolved; items distributed to visible slots | accounted |
| Support (mailto) | account row | re-homed |
| Sign Out | account row | re-homed |
| Restart-wizard (sparkle) | account row ("Take the tour again") | re-homed |
| Heartbeat health dot | Heartbeat item | re-homed |
| AgentbookHatBanner / ChannelNudgeBanner / gate overlay | preserved in shell | survives verbatim |

**Every single item is either preserved verbatim or re-homed to a stated
destination. Nothing is deleted, orphaned, or excluded.**

## 5.4 Was the first inventory complete? (brutal honesty)

- **Route inventory: COMPLETE.** The full-tree scan confirms all 18 `(dashboard)`
  pages were already captured in §1.1, including the 3 hidden routes. **No route
  was missed.**
- **What this pass ADDED (depth, not missed routes):** (a) the tour engine
  internals (auto-skip, hardcoded dropdown selector, the navMode design); (b) the
  **latent History-step auto-skip bug** — found only by reading `SpotlightTour` —
  which the restructure *fixes*; (c) the exact marketing re-entry CTA targets
  (3); (d) `/upgrade` + `/upgrade/success` as exit surfaces; (e) chrome banner CTA
  targets; (f) the **mobile `open-drawer` tour requirement** (a new build item).
- **One correction to my own §2.2 first pass:** it scattered Files/History/
  Scheduled and parked Dashboard in "Manage." D3 fixes the taxonomy
  (Scheduled + History are agent-*work* → Workspace; API Keys → Account; Dashboard
  → "Overview" in Account). I'm calling that out rather than quietly overwriting.
- **Verdict:** the inventory is complete; no surface is deleted, orphaned, or
  excluded. The only behavior-changing discovery is *positive* (the dead History
  tour step gets fixed).

---

## Decisions (resolved)

The 7 prior open questions, each researched and committed. Reasoning visible.

### D1 — Re-entry CTAs: **repoint to `/tasks` + relabel "Open InstaClaw."** — ✅ SHIPPED `51ea60d7` (2026-06-04, LIGHT/user-visible — public pages). `site-header.tsx` authed → `/tasks` "Open InstaClaw"; `hero.tsx:274` → `/tasks` "open instaclaw"; `hero.tsx:377` authed → `/tasks`; sidebar logo → `/tasks`. `/go/[code]` + onboarding-completion redirects left frozen → `/dashboard`. Live-verified §2.1 both partners (configured stays on /tasks; unconfigured Edge+non-Edge caught → /channels).
Three authed re-entry points target `/dashboard` today: `site-header.tsx:61`
(label "Dashboard"), `hero.tsx:274`, `hero.tsx:377`. The whole thesis is Command
Center = home; landing returning users on the instance-management screen instead
of their workspace is inconsistent and slightly worse (they came to *work*, not
manage billing). Best-in-class "open app" CTAs (ZO, Linear, Vercel) land you in
your workspace home. **Decision:** repoint all three → `/tasks` and relabel
"Dashboard" → **"Open InstaClaw"** (the label must change or it lies). Safe
because `/tasks` is in the `(dashboard)` group → the `needsOnboarding` gate
catches any unconfigured user. Ship in **Phase 2** (with the logo repoint);
independent of the nav flag (these are public pages; `/tasks` already works in
both navs). `/go/[code]` stays `/dashboard` (it's a deep-link-redemption path
where landing on the instance screen is fine, and it's lower-traffic). Low risk.

### D2 — Dashboard label: **rename to "Overview" (route stays `/dashboard`).** — ✅ SHIPPED (in shell: `sidebar-shell.tsx` ACCOUNT cluster, label "Overview" → `/dashboard`).
The page is agent health + usage + plan + model switch + World-ID verify +
Virtuals toggle + reset. Labeling it "Dashboard" while Command Center is actually
home creates a "why isn't the Dashboard my home?" mismatch. "Overview" is the
standard SaaS term for the at-a-glance status screen that isn't the main
workspace (cf. Vercel project Overview); "Instance" is too technical, "My Agent"
risks confusion with Command Center. **Decision:** sidebar label = **"Overview."**
**Do NOT rename the route** — `/dashboard` stays (protects the 20+ deep-links, the
onboarding-first invariant, and middleware). Only the nav label + the tour
step-1 copy change to match.

### D3 — Sidebar grouping: **two zones, Workspace (two clusters) + Account & Plan, pinned bottom.** (Authoritative; supersedes §2.2.) — ✅ SHIPPED (the full IA below is built in `sidebar-shell.tsx`; Sessions index added above WORKSPACE per the sub-PRD).
Grouped by user intent (interact-with-agent vs produce-work vs account), home at
top, hidden routes surfaced, money paired.

```
WORKSPACE  (top, no header)
  ── live agent ──
   Command Center ⭐ (home)   /tasks
   The Floor                  /floor
   Heartbeat        ● dot     /heartbeat
   Live View                  /live      (promoted, D4)
  ── work & output ──  (hairline divider, no header)
   Skills                     /skills
   Earn                       /earn
   Files                      /files     (promoted, D4)
   Scheduled                  /scheduled
   History                    /history
ACCOUNT & PLAN  (header)
   Overview                   /dashboard (renamed, D2)
   Credits                    /dashboard/credits   ↕ flywheel (D6)
   Billing                    /billing             ↕ flywheel (D6)
   Settings                   /settings
   API Keys                   /env-vars
PINNED BOTTOM
   Edge City                  /edge/dashboard   (iff partner === edge_city)
   Invite & earn  ✕           /ambassador       (referral banner, dismissable)
   ───────────────
   ● coop@…   ⚙ Settings · ↻ tour · ✉ Support · ⎋ Sign out
```
Rationale: Scheduled + History are about the *agent's work*, not your account, so
they belong in Workspace (corrects §2.2). API Keys is integration *config* →
Account. The two-cluster Workspace (live-agent vs work-&-output) gives visual
rhythm without heavy headers (ZO/Linear pattern). Order within each cluster is
by frequency/prominence (The Floor stays high — it's the launch feature). Tunable
later, but this is the committed v1.

### D4 — Promote `/live` + `/files`: **yes, both.** — ✅ SHIPPED (in shell: "Live View" → `/live` in the live-agent cluster, "Files" → `/files` in work-&-output). Note: landed inside the Phase 1 shell even though the PRD slots it under Phase 2.
`/live` (watch the agent's screen — ZO's "Computer") is reachable **only** via the
desktop-thumbnail on `/dashboard` today — a buried, differentiating delight
feature. `/files` (file manager — ZO top-levels it) is stuck in the overflow
dropdown. Both already exist, are auth-protected, and work. Surfacing them is
**purely additive** (more entry points, nothing removed; the thumbnail stays).
**Decision:** `/live` → "**Live View**" (live-agent cluster), `/files` → "Files"
(work-&-output cluster). "Live View" over "Computer" (self-explanatory; "Computer"
risks "whose computer?").

### D5 — Mobile: **off-canvas drawer. Bottom-tab hybrid KILLED (Cooper, 2026-06-04).** — ✅ SHIPPED (Unit B2). Mobile (<lg) renders a slim top bar (logo + hamburger + status-strip slot) + an off-canvas drawer: the full nav via the shared `<SidebarNav>`, scrim `z-40` / panel `z-[45]` (below the `z-9998` gate overlay), closes on scrim-tap / swipe-left / Escape / item-tap, body-scroll lock. The shell owns the rail-vs-drawer split via its own `useIsDesktop` — **conditional render** (not CSS-hide) so there's one `data-tour` copy per viewport. Gating dropped `&& isDesktop` so the flag now governs BOTH viewports. Tour `open-drawer` is driven off the existing `sidebarNav` step marker (mobile nav-item steps open the drawer; page steps close it), `setDrawerOpen` lifted to the layout (mirrors `setMoreOpen`). Verified @390px: seam-6 input pinned (`802/844`), gate z-order (injected `z-9998` covers the hamburger → drawer not openable under the gate), all 16 nav items reachable in the drawer, tap-item closes+navigates, flag-off byte-identical (TOPNAV, no hamburger/drawer, input pinned). **Bottom-tab hybrid: KILLED** (native bottom tabs compete with mobile-browser chrome; the drawer is the web-native pattern). **Desktop icon-rail collapse: DEFERRED polish** (not killed) — tour-target interaction + persisted state; deliberately skipped for the completionist pass.
Sidebar-first workspace tools (Linear, Notion, Height, Vercel) overwhelmingly
degrade to an off-canvas hamburger drawer; it preserves **all** items in one
place and is the lowest-risk path for a "don't break anything" launch. Bottom
tabs are a consumer/native pattern and add scope (choose-the-4, two nav patterns
to maintain). **Decision (v1):** slim top bar (logo · hamburger · optional "+")
→ hamburger opens the **full sidebar as an off-canvas drawer** with a scrim; the
tour's `open-drawer` preAction (§4.5) handles nav-item steps. Desktop sidebar is
collapsible to a ~64px icon rail (persisted in localStorage) — *optional polish*.
**Killed for v1 (spec retained):** bottom-tabs are KILLED for v1 (see the D5
header — the off-canvas drawer is the web-native pattern). The spec is kept on
record only if mobile usage ever warrants revisiting: a bottom-tab bar holding
Command Center · The Floor · Heartbeat · a "Menu" button (opens the drawer).
Reviving it would be a deliberate new decision, not a planned fast-follow.

### D6 — Credits vs Billing: **keep Credits as its own dedicated item; build a bidirectional flywheel.** *(Cooper-directed.)* — ✅ SHIPPED. Credits sidebar item in shell (adjacent to Billing). Flywheel cross-links built (2026-06-04, LIGHT — page content, not flag-gated, per Cooper's call): Billing → `/dashboard/credits` ("Credits & balances →", both active + inactive states); Credits → `/billing` ("Manage subscription & payment →"). Route stays `/dashboard/credits` (deep-link safety).
Per Cooper: there are multiple distinct credit types (video credits, premium-tool
credits, unit credits, and more) — Credits is genuinely its own surface, not a
Billing sub-section. **Decision:** Credits = dedicated sidebar item, placed
directly adjacent to Billing in Account & Plan. Build the flywheel (small,
additive — two links): **Billing** gets a "Credits & balances →" link →
`/dashboard/credits`; **Credits** gets a "Manage subscription & payment →" link →
`/billing`. So users move naturally between "my plan/payment" and "my credit
balances." Route stays `/dashboard/credits` (deep-link safety); only the nav item
+ the two cross-links are added. *Note (out of scope for this restructure):* the
multiple credit types may warrant the Credits **page** itself getting richer —
that's a page-content enhancement to track separately.

### D7 — Tour timing: **ship the navMode-aware tour in Phase 1, same PR as the sidebar shell.** — ✅ SHIPPED (`168b3003`: `buildTourSteps(navMode)` in `tour-steps.ts`, `adaptStepForSidebar`, `SpotlightTour`/`OnboardingWizard` thread `navMode`; copy polish `99ea1682`).
During the flag period both navs can render, so the tour must be navMode-aware to
work in both (§4.3). Globally disabling the `nav-more` step would degrade the
*old* top-nav tour while the flag is still off for most users. **Decision:** ship
`buildTourSteps(navMode)` in Phase 1 alongside the shell — `topnav` returns
today's exact array (zero regression), `sidebar` returns the §4.4 array. Keep both
arrays the same length (replace, don't remove, step 19) for resume-index safety.
No temporary disabling.

---

*Planning only. On approval we scope Phase 1 (sidebar shell behind a flag, zero
routing change) as the first build unit.*
