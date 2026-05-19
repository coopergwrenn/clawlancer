# Edge Esmeralda 2026 — Master PRD

**Date:** 2026-05-19
**Author:** Cooper Wrenn + Claude
**Status:** Source of truth — supersedes scattered Edge / Path-1 docs going forward
**Launch:** Edge Esmeralda 2026 begins **2026-05-30** (11 days from authorship). ~500 attendees over 4 weeks, ~150 on-site at any time.

---

## How to read this doc

This PRD consolidates the decisions from the 2026-05-19 Edge City call (Cooper × Timour × Seref × Edge team) AND the audit of what already exists in `instaclaw/`, `instaclaw-mini/`, and `edgeclaw-village/`. Every section follows the same shape:

- **What was decided in the meeting** — the strategic call
- **What already exists** — with file:line citations from the audit
- **Gap** — what's missing or needs change
- **Priority** — P0 (must ship for May 30), P1 (should ship), P2 (post-launch)
- **Owner** — InstaClaw (Cooper) / Edge team / Index / Geo / EdgeOS / shared
- **Dependencies** — including cross-terminal work in flight

Cross-terminal work happening in parallel (don't duplicate):
- **ChatGPT OAuth terminal**: `lib/openai-oauth*.ts`, 6 PRD docs (`docs/prd/chatgpt-oauth-*.md`). Phase 0 spike confirmed working from Linode 2026-05-18. Phase 1 implementation plan ready.
- **Consensus / Index terminal**: `app/api/cron/poll-index-opportunities/route.ts`, Option B per-user-key fan-out. Latest commit `2c90b041` BLOCKED on Yanek's auth model.
- **Gbrain terminal**: `docs/prd/gbrain-fleet-rollout-canary-2026-05-19.md` — 17-VM canary plan, 3-phase timeline to Esmeralda.
- **Snapshot bake terminal**: `lib/bake/`, `_autonomous-bake.ts` (commit `2a2d80d6`) — autonomous snapshot bake.

---

## TL;DR — what changes vs today

| Topic | Today | Meeting decision |
|---|---|---|
| Landing page | `/edge` (Seref redesign, live at instaclaw.io/edge) drops users into hero CTA → /signup | Two-layer: Edge canonical explainer + InstaClaw tactical interstitial that explains pricing, options, and routes to hosted or BYO |
| Existing-agent edge case | `/edge` doesn't detect prior agent users → can route them through onboarding again | Add "already have your own agent" branch + cookie/session detection so existing users land in dashboard |
| Onboarding form | None (intake happens conversationally in Telegram via INSTACLAW_OVERLAY.md) | Add a structured form on web for baseline interests/goals; inject as agent context; Telegram follows up softly |
| Architecture | Skills are in-tree under `instaclaw/skills/`; partner-specific overlays per-skill | Skills-oriented, primarily; split into a separate skills repo so hosted + BYO share the same set; Geo + Index are skills |
| Geo / knowledge graph | No automatic flow | Skill-triggered only, never automatic; explicit user-initiated action |
| Crons on edge VMs | 5+ duplicate `git pull` crons (vm-050 audit); per-VM auto-pull every 30min | Reduce defaults; ask user preference; default to 1 morning brief at 9 AM PT |
| Model defaults | Sonnet | OpenAI subscription import is strategically important (also brings prior ChatGPT context) — model-quality concern from Edge team |
| EdgeOS calendar integration | `lib/edgeos-auth.ts` chain built + smoke-tested but NOT wired into configureOpenClaw | Wire event reads via per-user `eos_live_*`; event creation deferred to week 2 |
| BYO-agent flow | Not really implemented | Email + OTP auth; same skills repo as hosted; user generates own API keys; no Index API key handling required for user |
| Village viz | Live at edgeclaw-village.vercel.app/spectator; rendering with named characters | Production-ready for May 30 pending branding fix + sunset-sync wiring |

---

## A. Landing + Interstitial Flow

### A1. Two-layer landing structure

**Decision:** The Edge team owns a **public canonical explainer page** (Agent Village concept, why it exists, how it works) on the Edge site. **InstaClaw owns a tactical interstitial** at `instaclaw.io/edge` that explains InstaClaw, pricing, the Edge partnership / free-month, options between hosted vs BYO, and routes users into either.

**What exists today:**
- `instaclaw.io/edge` is Seref's redesign (ported in `instaclaw/app/edge/` from `edge-landing-collab`). Cinematic Healdsburg OSD map + sections for HowItWorks / Features / Plaza / Research / TechPartners / Faq / Claim. Hero CTA "Set up your agent" anchors to `#claim`, which posts to `/api/partner/tag`.
  - `app/edge/page.tsx` — composer (89 lines).
  - `app/edge/components/nav.tsx`, `app/edge/components/healdsburg-map.tsx`, `app/edge/components/plaza-section.tsx`, etc.
  - `app/edge/edge-city-client.tsx` — claim handler at `handleClaim()` (`POST /api/partner/tag` body `{partner:"edge_city"}` → redirect to `/signup`).
- **`/edge` already covers the InstaClaw tactical surface** at v0.2 quality. What's missing is: (a) the route-to-BYO branch, (b) the pricing/free-month explainer, (c) the existing-agent detection.
- **No Edge-side canonical explainer page yet** — that's Edge team's deliverable.

**Gap:**
1. **No "already have your own agent" branch** on `/edge` page.
2. **No pricing / Edge partnership / free-month framing** visible to logged-out visitor. Edge promo IS wired in `app/api/billing/checkout/route.ts:126` (`user.partner === "edge_city" && process.env.EDGE_CITY_COUPON_ID`) but the user has to commit to signup before they ever see it.
3. **No existing-agent detection.** A logged-in user with a working VM hitting `/edge` should redirect to `/dashboard`; today `getEdgeUserState()` in `app/edge/edge-user-state.ts` resolves three states (logged_out / in_progress / live) and routes correctly for "live" via the nav CTA → `https://t.me/<botUsername>`, but the page still renders the full landing instead of fast-redirecting.

**Priority:** P0 for items 1 + 2; P1 for item 3 (live users still get the right Telegram link).

**Owner:** InstaClaw (Cooper) for /edge changes. Edge team owns the canonical explainer.

**Dependency:** None blocking.

### A2. Interstitial that routes hosted vs BYO

**Decision:** Add a step between the landing CTA and the existing `/signup` Google OAuth flow that:
1. Explains pricing + free-month
2. Asks: "are you new to agents (hosted)" OR "I bring my own (BYO)"
3. Hosted → continues to `/signup` (existing)
4. BYO → routes to a new BYO setup page (does not exist yet)

**What exists today:**
- `app/edge/components/claim.tsx` — current claim card. Single CTA.
- `app/edge/components/map-hero-overlay.tsx` — hero CTA (Single primary action).
- No interstitial page exists. The current flow is: `/edge` → `/api/partner/tag` → `/signup` (Google OAuth) → existing onboarding state machine (Rule 33).

**Gap:** Build the interstitial page (new route, e.g. `/edge/setup` or inline modal on `/edge`). Build the BYO flow it routes into (see section F).

**Priority:** P0. Without this the meeting's "explain pricing first" mandate is unmet.

**Owner:** InstaClaw (Cooper). Edge team contributing copy.

**Dependency:** BYO flow design (section F).

### A3. "Already have your own agent" CTA + existing-agent edge case

**Decision:** A small secondary CTA under the primary "Set up your agent" that branches to a BYO path. Plus: cookie/session detection so users with an existing agent land on `/dashboard` rather than re-walking onboarding.

**What exists today:**
- `getEdgeUserState()` already detects three states (logged_out, in_progress, live) using session + Supabase VM lookup. Lives at `app/edge/edge-user-state.ts`. Per Rule 33 it deliberately avoids leaning on `session.user.onboardingComplete` alone.
- The nav header CTA in `app/edge/components/nav.tsx` already routes correctly for `kind: "live"` (deeplink to Telegram) vs `kind: "in_progress"` (resume path) vs `kind: "logged_out"` (anchor to #claim).
- What the landing **doesn't do**: hard-redirect a "live" user away from `/edge` to `/dashboard` to prevent them from re-reading the marketing copy and being confused. They see the full marketing page with an "Open agent" header pill.

**Gap:** Two small adds:
1. **Secondary "I have my own agent" link** under the hero CTA. Routes to BYO entry.
2. **Auto-redirect for `kind: "live"` users** from `/edge` → `/dashboard`. Or surface a clear "Welcome back — your agent is at /dashboard" banner.

**Priority:** P0 for #1 (meeting explicit). P1 for #2 (live users have a working pill, just suboptimal UX).

**Owner:** InstaClaw (Cooper).

**Dependency:** BYO flow (section F).

---

## B. Onboarding Form + Telegram Handoff

### B1. Pre-signup interests/profile form

**Decision (the meeting reversed twice on this):** Final state — **use a form** to capture baseline interests/profile up front, **inject as agent context**, then let Telegram follow up softly with "you've already told me a lot about yourself…" The form lives in/around the interstitial flow.

**What exists today:**
- **No pre-signup form.** There's a `components/onboarding-wizard/OnboardingWizard.tsx` (314 lines) but it's a **post-signup tour**, not an intake form. Phases: `loading → welcome → bot-verify → tour → complete → done`. It walks users through bot verification and a spotlight tour of the dashboard.
- `app/api/onboarding/*` routes (`check-bot-status`, `complete-wizard`, `gmail-insights`, `restart-wizard`, `save`, `suggested-tasks`, `update-wizard-step`, `wizard-status`) — all support the post-signup wizard. None is the new form.
- `app/api/match/v1/profile/route.ts` exists — a profile endpoint used by the match pipeline. Could be repurposed as the form's destination, or paired with a new endpoint for the intake.
- **Existing Telegram intake** happens via `INSTACLAW_OVERLAY.md` (verified on edge VMs in audit; `lib/partner-content.ts` lines 73-102):
  - 4 questions, "one at a time":
    1. What are you most excited about? What are your goals for EE26?
    2. What are you working on right now? What's your background?
    3. Who do you want to meet? What kind of connections are you looking for?
    4. Which weeks are you attending?
  - Answers stored in `MEMORY.md` for matching + proactivity downstream.

**Gap:** Substantial. We need:
1. A web form (interstitial-adjacent) that asks the same/similar questions
2. A `POST /api/edge/profile-intake` endpoint that stores answers in `instaclaw_users.edge_profile` (or similar JSONB)
3. **Inject form answers into the agent's INITIAL context** — two options:
    - (a) Write to `~/.openclaw/workspace/USER.md` during configureOpenClaw using the form answers (preferred — fits existing surface)
    - (b) Write to a new `~/.openclaw/workspace/EDGE_INTAKE.md` and reference from INSTACLAW_OVERLAY.md
4. **Update `EDGE_INSTACLAW_OVERLAY_MD`** in `lib/partner-content.ts` so the agent doesn't re-ask the 4 questions verbatim if form data is present. New phrasing per meeting:
    - *"You've already told me a lot about yourself. Anything else you want to add? Or anything you'd like to refine?"*
5. **Pricing/Edge-partnership context** visible on the form page (the meeting explicitly tied this to the interstitial).

**Priority:** P0. This is the meeting's biggest reversal-then-decision.

**Owner:** InstaClaw (Cooper) — form, endpoint, configureOpenClaw plumbing, overlay copy update.

**Dependency:**
- Field set TBD (open question — see end of doc)
- Conditional overlay logic depends on form data being available to configureOpenClaw at provisioning time

### B2. Form fields (open question — Cooper to decide)

The meeting referenced "what the user is interested in" + "core information" but did NOT specify the exact fields. Proposed v0 set, mirroring the Telegram intake:

```
1. What are you most excited about for Edge Esmeralda? (open text, 0-280 chars)
2. What are you working on right now? (open text, 0-280 chars)
3. Who do you want to meet? What kinds of connections? (open text, 0-280 chars)
4. Which weeks are you attending? (multi-select: May 30-Jun 6, Jun 6-13, Jun 13-20, Jun 20-27)
5. (Optional) Telegram handle if you want first-message warmth (text)
```

Notification cadence (deferred to a later UI step, per section E):
- One morning brief at 9 AM PT (default)
- "Send me more / less" controls

**Owner:** Cooper to confirm fields. Then InstaClaw builds.

### B3. Telegram handoff after form

**Decision:** Agent opens Telegram with something like *"You've already told me a lot about yourself — is there anything else you want to add?"* Existing Telegram intent inference flow (`lib/index-intent-creator.ts`) continues to run on follow-up messages.

**What exists today:**
- Existing BOOTSTRAP.md generators (`lib/ssh.ts:4454` for `WORKSPACE_BOOTSTRAP_SHORT`, `lib/ssh.ts:4514` for the Gmail-connected variant) — both are the **first-awakening prompt** with no Edge-specific content. The "agent comes online for the first time, asks for a name" framing.
- The Edge-specific 4-question interview is in `INSTACLAW_OVERLAY.md` (deployed to edge VMs, sha `11adcb6f…` verified on vm-050 + vm-354 in audit).
- `lib/index-intent-creator.ts` — Telegram intent inference (turns user messages into Index intents per the existing per-user-key fan-out).

**Gap:**
1. **Rewrite the Edge first-message logic** in INSTACLAW_OVERLAY.md to conditionally:
    - If `USER.md` has form intake data → "You've told me X, Y, Z — anything else? Anything to refine?"
    - If no form data (BYO users? form skipped?) → existing 4-question interview, one at a time
2. **Carry the existing "first-awakening" warmth** from BOOTSTRAP.md but layer Edge personality on top (the meeting was clear Edge users shouldn't feel like they're configuring a product — they're meeting a new agent).

**Priority:** P0. Coupled to B1.

**Owner:** InstaClaw (Cooper) — content update to `EDGE_INSTACLAW_OVERLAY_MD` in `lib/partner-content.ts`. Manifest version bump → reconciler redeploys to all 9 edge VMs in ~3min (stepDeployEdgeOverlay handles via SHA-verify).

**Dependency:** Form data available in USER.md.

### B4. Bug already identified in EDGE_INSTACLAW_OVERLAY_MD

**Issue:** `lib/partner-content.ts:101` mentions *"query the live APIs via the edge-esmeralda skill (Social Layer for events, EdgeOS for attendees)"* — but **Sola/Social Layer is deprecated for EE2026 per Tule**. EdgeOS is canonical for both events and attendees now.

**Fix:** Replace "Social Layer for events, EdgeOS for attendees" with "EdgeOS for events AND attendees" (or just "edge-esmeralda skill" without backend mixing).

**Priority:** P0. Real copy bug live on 9 VMs today.

**Owner:** InstaClaw (Cooper). 1-line fix + manifest version bump.

---

## C. Architecture: Skills-based with Hybrid Elements

### C1. Final architecture decision

**Decision:** **Skills-oriented, primarily.** The Edge agent calls modular skills for Index / Geo / etc. SOME things stay pre-baked (cron defaults, base prompt structure, BOOTSTRAP.md). Both hosted AND BYO paths share the same skills set.

### C2. Two-repo structure

**Decision:** Split into:
- **Repo 1 (instaclaw/edgeclaw)**: install scripts, workspace setup, bootstrap/onboarding files, tools routing, Edge-specific product behavior
- **Repo 2 (skills repo)**: shared skills (Index, Geo, future). Published independently. Auto-updates for "official" skills.

Both hosted and BYO point to the same skills.

**What exists today:**
- **All skills live in `instaclaw/skills/`** as a single tree (20+ skills: agentbook, brand-design, dgclaw, edgeos-events, prediction-markets, etc.).
- `instaclaw/skills/manifest.json` — current skills manifest (v1, last updated 2026-03-08). Schema includes `name`, `pip_deps`, `scripts`, `auto_update`, `source`, optional `note`.
- **`edge-esmeralda` skill is NOT in this tree** — it's git-cloned at runtime from `https://github.com/aromeoes/edge-agent-skill.git` onto each edge_city VM, with a 30-min auto-pull cron (verified on vm-050, vm-354 in audit). Last commit `79e457b Update reference content [automated]`. So it's already operating as an external skill repo, just one-off.

**Gap:**
1. **Define the split.** Which skills graduate to the new external "skills" repo, and which stay in-tree? Open question.
2. **Build the indexing/version mechanism.** Skills repo needs an analog of `manifest.json` that supports per-skill versioning and `auto_update`.
3. **Update configureOpenClaw to clone or pull skills from the new repo** vs `instaclaw/skills/` content. The pattern works (edge-esmeralda already uses it); just needs generalization.
4. **Ownership rotation** — meeting said "a participant volunteered to take on the burden of rearranging the repo that way." Identify them and ground the work in this PRD.

**Priority:** P1. Splitting the repo doesn't unblock launch but does enable BYO. Hosted users get skills via `configureOpenClaw` either way.

**Owner:** Shared (Cooper + Edge volunteer).

**Dependency:** None hard. Can ship after launch if needed; the form/onboarding work above is more pressing.

### C3. Pre-baking vs skills tradeoff — what stays pre-baked

The meeting acknowledged real reasons to keep some things bundled:
- Avoid plugin warning friction (the OpenClaw fork already controls this — we can configure approval defaults)
- Tight cron-job control
- Edge-flavored "turnkey" defaults

**What stays pre-baked at v0 (in instaclaw/edgeclaw repo):**
- BOOTSTRAP.md / WORKSPACE_BOOTSTRAP_SHORT — generated by configureOpenClaw
- SOUL.md base (with v80 partner stubs) — generated by configureOpenClaw
- AGENTS.md — generated by configureOpenClaw
- exec-approvals.json (security=full for hosted users)
- Cron defaults (see section E)

**What's a skill (called via the new repo):**
- Index Network — intent / opportunity inference, agent-to-agent matching
- Geo — knowledge graph reads / writes (writes only on explicit user trigger)
- EdgeOS events — calendar reads + RSVP (event creation gated, see D3)
- AgentBook — World Chain registration (already a skill at `skills/agentbook/`)
- ChatGPT history import — new skill (see D4)

**Priority:** P1 architecture decision; doesn't block launch.

**Owner:** Cooper to ratify.

### C4. BOOTSTRAP.md / onboarding files as the editable control surface

**Decision:** Bootstrap is the first thing the agent reads on install. Product decisions about onboarding behavior live in `instaclaw/lib/ssh.ts` (the generators) and partner-specific overlays in `instaclaw/lib/partner-content.ts`.

**What exists today:**
- `WORKSPACE_BOOTSTRAP_SHORT` at `lib/ssh.ts:4454` — for users who skipped Gmail
- Full BOOTSTRAP.md generator at `lib/ssh.ts:4514+` — for Gmail-connected users (personality-first with dynamic Gmail paragraph)
- `BOOTSTRAP_MAX_CHARS = 40000` constant at `lib/vm-manifest.ts:468`
- The agent reads BOOTSTRAP.md ONCE, then creates `.bootstrap_consumed` marker. After that, behavior is governed by SOUL.md (which routes to INSTACLAW_OVERLAY.md for partner=edge_city).
- Manifest version bumps trigger `stepDeployEdgeOverlay` → SHA-verified push to all edge VMs in ~3min.

**Gap:** Mostly documentation — make sure the Edge team knows where to find these files and how a change cycles to live VMs. Add a "BOOTSTRAP edit cycle" doc + reference from this PRD.

**Priority:** P2 (doc); the system works.

**Owner:** InstaClaw (Cooper) — write a 1-page "where to edit Edge agent behavior" guide.

---

## D. Integrations

### D1. Index Network — intent detection, skill-based invocation

**Decision:** Index is a skill. The agent recognizes meaningful intent signals from user messages and calls the Index MCP / tool. Irrelevant facts (e.g., "my favorite color is green") should NOT trigger Index. Tested by Edge team ~100-200 times; high confidence in intent detection.

For hosted Edge users, **users don't see Index API keys** — system handles auth via per-user x-api-key issued at /signup.

**What exists today:**
- `app/api/cron/poll-index-opportunities/route.ts` — Path C poller (per Yanek 2026-05-19 confirmation). Option B per-user-key fan-out across 9 edge_city VMs.
- `app/api/webhook/index-encounter/route.ts` — webhook from Index when matches happen
- `app/api/match/v1/outcome/route.ts` — outcome ingest
- `app/api/match/v1/negotiation/respond/route.ts`, `app/api/match/v1/negotiation/reserve/route.ts` — negotiation endpoints
- `app/api/match/v1/outreach/route.ts` — outreach
- `lib/index-intent-creator.ts` — Telegram intent inference creator (turns Telegram messages into Index intents)
- `supabase/migrations/20260511_matchpool_outcomes_ingest.sql` — `matchpool_outcomes` table schema
- `supabase/migrations/20260516210000_village_dual_channel_triggers.sql` — broadcast triggers for the village viz
- Latest commit `2c90b041 feat(index): intent-expression infrastructure — BLOCKED on Yanek auth model` — **integration is blocked on Yanek's final auth contract.**

**Gap:**
1. **Unblock the Yanek auth model.** The Consensus terminal flagged the blocker; cross-terminal coordination needed.
2. **Guardrail on irrelevant intents.** The meeting said Edge team tested heavily and is confident. The tool description in the skill should reinforce the guardrail.
3. **Hide Index API keys from hosted users** — per-user x-api-key generation on /signup. Storage at `instaclaw_vms.index_api_key` (verified existing in poll route).
4. **Re-verify after Yanek-auth lands** that the existing `lib/index-intent-creator.ts` still works against the new contract.

**Priority:** P0 (blocks launch — the village viz and the Telegram intent flow both depend on Index).

**Owner:** Cross-terminal (Consensus/Index terminal owns the auth unblock; InstaClaw owns the intent-creator integration).

**Dependency:** Yanek's auth model (external).

### D2. Geo — skill-based, NEVER auto-ingest private data

**Decision (strong consensus):** Geo is a skill that the agent calls **only when the user explicitly wants something published to the knowledge graph**. NO automatic background syncing of user data into Geo's backend.

**What exists today:**
- No Geo skill in `instaclaw/skills/` today (verified by listing).
- Nick (Geo) was reportedly asking for production / calendar access in the meeting — there are open access requests outstanding.

**Gap:**
1. **Build the Geo skill** in the new shared skills repo.
2. **Define the explicit-user-trigger contract.** The agent should be required to confirm with the user before calling any Geo write tool. Examples in tool description.
3. **Audit any code paths that could leak user data to Geo** — none today, but a sweep before launch.

**Priority:** P1. Most Edge attendees will not interact with Geo on day one; the skill can ship in week 1.

**Owner:** Geo team builds the skill content; InstaClaw integrates per the shared-skills-repo pattern.

**Dependency:** Skills-repo split (C2) is helpful but not required (can stub Geo skill in `instaclaw/skills/geo/` initially).

### D3. EdgeOS calendar — event reads (week 1), event creation (week 2)

**Decision:** Week 1 — agents can READ events. Week 2 — agents can CREATE events. The week-2 delay is deliberate to prevent agents getting "too excited" with calendar actions early.

**What exists today:**
- **EdgeOS auth chain built** by this terminal (`lib/edgeos-auth.ts`, `lib/edgeos-api-keys.ts`, `lib/edgeos-mint.ts`, `scripts/_test-edgeos-auth-chain.ts`). Smoke-tested 9/9 phases against `api.dev.edgeos.world` on 2026-05-19. Includes the categorization-bug fix for `authenticateOTP` 404 → `no_account`.
- **NOT yet wired into configureOpenClaw.** Per-user `eos_live_*` mint is built (`mintOrReuseApiKey`) but not invoked at provisioning time.
- `EDGEOS_BEARER_TOKEN` is in `.env` on all 9 edge VMs (verified in audit). That's the legacy shared bearer for the attendee-directory API at `api-citizen-portal.simplefi.tech` — NOT the per-user EdgeOS events token.
- `edge-esmeralda` skill on each VM clones from `https://github.com/aromeoes/edge-agent-skill.git` and has Tule's reference content.
- `instaclaw/skills/edgeos-events/SKILL.md` exists in-tree (placeholder).

**Gap:**
1. **Wire `mintOrReuseApiKey` into configureOpenClaw** so each new edge_city user gets a per-user `eos_live_*` minted automatically and written to `~/.openclaw/.env` as `EDGEOS_EVENTS_TOKEN`. INTERACTIVE blocker: requires a real OTP from the user's email. Two options:
    - (a) Defer: have user paste eos_live_* manually (matches Path 2 BYO pattern)
    - (b) Ship the OTP flow on the InstaClaw side — user enters email on /edge, EdgeOS sends OTP, user pastes back. Real but requires UX.
2. **Update `edge-esmeralda` skill content** (Tule's repo) to teach the agent to read events via the per-user token. Currently the skill references the legacy Sola/Social Layer URL (per the B4 copy bug).
3. **Gate event creation in week 2** — agent skill should include a "DO NOT call event-create tools before 2026-06-06" guardrail until week 2.

**Priority:** P0 for event reads (week 1 mandate). P1 for event creation (week 2).

**Owner:** InstaClaw (Cooper) for configureOpenClaw plumbing. Tule for skill content updates.

**Dependency:** EdgeOS sandbox test from Cooper (signing up at demo.dev.edgeos.world + Tule approving popup application) to verify the chain end-to-end before production wiring. See `instaclaw/docs/edgeos-sandbox-test-setup.md`.

### D4. ChatGPT history import + OpenAI subscription model

**Decision:** Strategically important. Users bring in their prior ChatGPT context. Personalization out of the box. Sonnet alone is insufficient model-quality for credible UX per the Edge team's concern.

**What exists today (CROSS-TERMINAL — don't duplicate):**
- `lib/openai-oauth.ts` (22KB) — full device-code OAuth client. Verified end-to-end in Phase 0 spike 2026-05-18 from a Linode us-east cloud IP.
- `lib/openai-oauth-encryption.ts` — token encryption
- `lib/chatgpt-oauth-feature-flag.ts` — feature flag
- 6 PRDs in `docs/prd/chatgpt-oauth-*.md` covering Phase 0 spike, Phase 0.5 (OpenClaw natively supports it), Phase 1 design, Phase 1 implementation plan, history-import design, history-import decisions.
- DB table `instaclaw_oauth_device_flows` (referenced in code; verify via schema search if needed).
- `instaclaw_users.openai_token_version` column (referenced in code).

**Gap (InstaClaw side):**
1. **UI integration** — surface "Bring your ChatGPT" CTA in onboarding (probably in the interstitial flow).
2. **Skill wrapper** — agent on VM needs a tool to "ask my ChatGPT history about X". This may already be partly in scope of the ChatGPT OAuth terminal.
3. **Model-default plumbing** — let users with OpenAI subscription connected use a better model than Sonnet. Today `agents.defaults.model.primary` is the per-VM default; we'd need a runtime switch when the user has OAuth'd OpenAI.

**Priority:** P0 (Edge team explicit). Strategic for launch reception.

**Owner:** ChatGPT OAuth terminal (Phase 1). InstaClaw (Cooper) integrates the UI surfaces.

**Dependency:** Phase 1 ship from the cross-terminal.

---

## E. Cron Jobs + Default Behavior

### E1. Reduce defaults; ask user preference

**Decision:** Don't pre-bake every possible cron. Defaults should not feel spammy. Default to **one morning brief at 9 AM PT**. Let the form (or a follow-up Telegram question) capture cadence preference.

**What exists today:**
- Edge VM crontab audit on vm-050 showed **5+ identical** copies of:
  ```
  */30 * * * * cd $HOME/.openclaw/skills/edge-esmeralda && git pull --ff-only -q 2>/dev/null
  ```
  ff-only is idempotent so they're harmless but wasteful. **Real bug — duplicate cron entries.**
- Other crons running on edge VMs (need a per-VM scan — partial probe only checked git-pull lines):
  - heartbeat, strip-thinking, vm-watchdog, silence-watchdog, push-heartbeat, openclaw memory index — these are infrastructure crons, not user-facing
  - No "morning brief" cron exists for edge users today.

**Gap:**
1. **De-dup the edge-esmeralda git-pull cron** on all 9 VMs. Single-entry post-cleanup.
2. **Build morning-brief cron** for edge_city users. Default 9 AM PT, single Telegram message. Content: today's confirmed intros + relevant sessions + governance items.
3. **User preference store** for cadence (no / 1/day / 2/day). Lives on `instaclaw_users` or `instaclaw_vms`.
4. **Audit pre-existing cron jobs** the meeting was worried about — the meeting flagged "multiple cron jobs in mind" being spammy. Map out exactly what runs on a fresh edge_city VM and label each as infra (heartbeat) vs user-facing (brief). Make sure ONLY user-facing crons respect the preference.

**Priority:** P0. Spammy defaults = bad first impression.

**Owner:** InstaClaw (Cooper).

**Dependency:** Form data for preference (B1) is helpful but defaultable.

### E2. Concrete morning-brief content (week 1)

Default morning brief at 9 AM PT for an edge_city user, drawing from:
- EdgeOS events for today (via per-user `eos_live_*`)
- Their stated interests (from form intake)
- Confirmed intros from the day before (via Index)
- Open governance items (none yet — defer until governance ships)

**Priority:** P0.

**Owner:** InstaClaw (Cooper) — `lib/edge-morning-brief.ts` + cron route in `app/api/cron/edge-morning-brief/route.ts`. Use existing edge-skill APIs.

---

## F. BYO-Agent Flow

### F1. What "bring your own agent" actually means

**Decision:** Users with their own agent (Hermes / Claude Code / custom Anthropic API setup / etc.) can connect to Edge's shared skills + Index without going through the hosted InstaClaw stack. Auth = email + OTP. They generate own API keys. Same skills as hosted.

**What exists today:**
- **Essentially zero infrastructure for this.**
- `/edge` Path 2 was discussed in earlier meeting notes ("I know what I'm doing") but doesn't have a working route today.
- The skills are still in-tree at `instaclaw/skills/`, not published in a way external users can pull.

**Gap:**
1. **Public skills repo** (per C2) — same urgency as the architecture decision.
2. **BYO landing page** — `/edge/byo` or similar. Shows the EdgeOS API token, link to skills repo, test connection command.
3. **API key generation flow** — user enters email → OTP → generates eos_live_* via the chain we built (`lib/edgeos-auth.ts` / `lib/edgeos-api-keys.ts` / `lib/edgeos-mint.ts`). All built. Just needs a UI.
4. **Test-connection endpoint** that confirms their agent can call our skills.

**Priority:** P1. The Edge team thought a small % of attendees will go BYO. Hosted path is the focus for launch.

**Owner:** InstaClaw (Cooper).

**Dependency:** Skills repo split (C2).

---

## G. Agent Configuration + MD Files

### G1. The chain: BOOTSTRAP → SOUL → AGENTS → skill files

**What exists today:**
- `BOOTSTRAP.md` written to `~/.openclaw/workspace/` on each VM — generic "first-awakening" prompt (`lib/ssh.ts:4454` / `lib/ssh.ts:4514`)
- `SOUL.md` — base identity + partner stubs via `SOUL_STUB_EDGE` (`lib/partner-content.ts:40`)
- `AGENTS.md` — tools/skills routing layer
- Partner-specific overlay: `~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md` — the Edge-specific operational layer (`EDGE_INSTACLAW_OVERLAY_MD` in `lib/partner-content.ts:73-102`)
- Tule's upstream SKILL.md — separate, controlled by Tule, auto-pulled every 30 min

**What changes when meeting decisions change:**
- Bootstrap copy → `lib/ssh.ts:4454+` (generators) + manifest bump
- SOUL.md partner stubs → `lib/partner-content.ts:40` + manifest bump
- Edge operational overlay → `lib/partner-content.ts:73-102` + manifest bump
- Each manifest bump triggers `stepDeployEdgeOverlay` + `stepRewriteSoulPartnerSections` → SHA-verified push to all edge VMs within ~3min via the reconciler

### G2. Concrete content changes from this meeting

| File | Current | Change |
|---|---|---|
| `EDGE_INSTACLAW_OVERLAY_MD` | "Social Layer for events, EdgeOS for attendees" (line ~101) | "EdgeOS for events AND attendees" |
| `EDGE_INSTACLAW_OVERLAY_MD` | 4 questions one-at-a-time | If form data in USER.md → "You've already told me a lot, anything to add?"; else fall back to 4-question flow |
| `WORKSPACE_BOOTSTRAP_SHORT` | Generic awakening — no Edge framing | Possibly add a 1-sentence Edge context line for partner=edge_city — TBD |

**Priority:** P0 (B4 copy bug). P0 (B3 conditional intake).

**Owner:** InstaClaw (Cooper).

---

## H. Visualization + Village (edgeclaw-village)

### H1. Current state

**What exists today (audit):**
- `edgeclaw-village` repo (sibling of instaclaw): fork of a16z `ai-town`, migrated to Supabase backend, deployed at `https://edgeclaw-village.vercel.app/spectator`.
- Live render confirmed via puppeteer: pixel-art map, named characters (Timour Kosters, Katherine Jones, Florist Larry, Barista Larry, Carter Librarian Larry…), top bar reads "spectator · Edge Esmeralda 2026 · anonymized".
- Stack: Vite + React 18 + PixiJS + TypeScript + Supabase
- Recent commits (2026-05-18ish): encounter-engine integrated with Index Network bilateral matches, dual-channel triggers, audit-fixed 4 P0 + 3 P1 bugs, mobile-optimized rendering (`df8d15a D20: cap PIXI resolution + antialias off + autoDensity`)
- Design vision: 8 magic moments documented in `docs/village-direction-2026-05-15.md` — sunset sync 2026-06-17 at 8:32 PM PDT as the load-bearing moment.

**Issues found:**
1. **`<title>` is still "AI Town"** on live deploy — branding regression.
2. **Map looks sparse** with ~6-8 characters in frame. For 500 attendees the density should feel more alive. Will partially self-correct as more attendees come online + ambient NPCs run.
3. **No live encounter visible during the puppeteer probe** — expected (nothing matched at probe time, AND Index integration blocked on Yanek auth model per D1).

**Gap:**
1. **Fix the `<title>` tag** — edge-village's `index.html`. P0 polish.
2. **Wire encounters once D1 is unblocked.** When Yanek's auth ships and the poller can fan out, encounters should start firing into the village automatically (the encounter-engine.ts is already ready).
3. **Verify sunset-sync is implemented** — design doc says it's the load-bearing magic moment for 2026-06-17. Audit `village-clock.ts` + `day-night-cycle.ts` to confirm the wall-clock-driven schedule is in place.
4. **Density at scale** — once 100+ attendees are configured, the map's character count should organically grow. Confirm the dual-channel triggers don't bottleneck.

**Priority:** P0 for title fix. P1 for sunset sync audit (have until 2026-06-17). P0 for encounter wiring (gated on Yanek).

**Owner:** edgeclaw-village owner (Cooper for the title fix; the encounter wiring is cross-terminal).

**Dependency:** D1 unblock for encounters.

---

## I. Privacy + Security

### I1. No automatic data to Geo / knowledge graph

**Decision (strong):** Users' private info NEVER flows automatically to Geo. Only explicit user-triggered actions (e.g., "publish my notes to the graph").

**What exists today:**
- No Geo integration exists yet on edge VMs (no Geo skill in `instaclaw/skills/`). So there's no auto-flow problem to fix today.
- General principle is already encoded in CLAUDE.md operating principles (Rule 28 — strong "do not refuse" directives for sanctioned features; the inverse "do not auto-send" must be equally explicit in the Geo skill content when it ships).

**Gap:**
1. **When Geo skill is built (D2), explicitly write in its SKILL.md the contract that the agent MUST confirm with the user before any write call.**
2. **Audit all existing skills** for any analogous auto-send patterns (none found in skim).

**Priority:** P1.

**Owner:** Geo team (skill content) + InstaClaw (integration review).

### I2. Existing privacy posture

CLAUDE.md memory + the v1 /edge backup landing page documented:
- Per-VM filesystem isolation
- "Maximum Privacy Mode" — user-toggleable, auto-reverts after 24h
- Researchers never see raw data (anonymized pipeline)
- Granular opt-in for inter-agent sharing

**The new (Seref) /edge landing page DROPPED the privacy section** — flagged in the prior PR review. Need to either restore it or get explicit sign-off to drop. Not a feature regression, but a positioning loss.

**Priority:** P1.

**Owner:** InstaClaw (Cooper) + Edge team.

---

## J. Cross-terminal coordination

| Terminal | Owns | Current status | InstaClaw dependency |
|---|---|---|---|
| **ChatGPT OAuth** | `lib/openai-oauth*.ts`, 6 PRDs in `docs/prd/chatgpt-oauth-*.md` | Phase 0 spike confirmed, Phase 1 implementation plan ready | D4 onboarding UI integration |
| **Consensus / Index** | `app/api/cron/poll-index-opportunities/route.ts`, intent-expression infra | **BLOCKED on Yanek auth model** (commit 2c90b041) | D1 (Index) + H (encounter visualization) |
| **Gbrain** | `docs/prd/gbrain-fleet-rollout-canary-2026-05-19.md` | 17-VM canary plan, phase 1 active | Agent memory quality; affects how the agent uses form-intake data over time |
| **Snapshot bake** | `lib/bake/`, `_autonomous-bake.ts`, `docs/prd/autonomous-bake-system-design-2026-05-19.md` | P0 code shipped 2026-05-19 | New edge VMs will provision from the next snapshot — make sure overlay copy bug (B4) lands BEFORE the next bake |

---

## K. Open questions for Cooper

1. **Exact form fields** (B2) — confirm 5-field v0 set or adjust.
2. **Cron-job baseline audit** — which existing crons on a fresh edge VM are infra vs user-facing? Need a pre-launch sweep to be sure we don't ship the "spammy by default" UX the meeting was worried about.
3. **Reverse proxy / domain routing** — meeting mentioned proxying an `/agent-village` path to the Edge site via Webflow. Who's checking? Status?
4. **Skills repo name + ownership** — meeting said someone volunteered to lead the split. Confirm who.
5. **Geo / Nick production access** — meeting flagged outstanding access requests. Status?
6. **ChatGPT history import scope on day-one** — Phase 1 plan exists but the user-facing UX surface (button placement, copy, error handling) needs UI design.
7. **Visualization parallel work** — meeting referenced parallel viz work. Is that the edgeclaw-village (above) or something else?
8. **Model default policy** — when a user has OpenAI OAuth connected, do we switch to GPT-4o automatically? Or expose as a setting?
9. **Privacy section on /edge** — restore it in Seref's redesign, or get explicit sign-off to drop?

---

## L. Priority-ranked work plan (next 11 days)

### P0 — ship-blockers (today + tomorrow)

1. **B4** — fix the "Social Layer" copy bug in `EDGE_INSTACLAW_OVERLAY_MD`. 1-line edit, manifest bump, reconciler redeploys in ~3min. (InstaClaw — Cooper)
2. **B1** — pre-signup form (web). Build form page, `POST /api/edge/profile-intake`, `instaclaw_users.edge_profile` JSONB column, write to USER.md during configureOpenClaw. (InstaClaw — Cooper)
3. **B3** — update `EDGE_INSTACLAW_OVERLAY_MD` to be form-aware. Manifest bump. (InstaClaw — Cooper)
4. **A1+A2** — interstitial that explains pricing + Edge partnership + free-month + routes to hosted vs BYO. (InstaClaw — Cooper, with Edge team copy support)
5. **A3** — "already have your own agent" CTA + existing-agent redirect. (InstaClaw — Cooper)
6. **E1** — de-dup the edge-esmeralda git-pull cron on all 9 VMs (one-shot script). (InstaClaw — Cooper)
7. **E2** — morning-brief cron at 9 AM PT. (InstaClaw — Cooper)
8. **D1** — Index integration unblock (cross-terminal); follow the Consensus terminal's progress.
9. **D3** — wire `mintOrReuseApiKey` into configureOpenClaw OR define the user-paste fallback. (InstaClaw — Cooper)
10. **D4** — ChatGPT history import UI surface (cross-terminal); follow the OAuth terminal's Phase 1.
11. **H1** — fix the `<title>` in edgeclaw-village to "Edge Esmeralda — Agent Village" or similar. (edgeclaw-village owner)

### P1 — should ship (within first week of village)

12. **C2** — split skills into shared repo
13. **F1** — BYO-agent flow public page + email-OTP entry
14. **D2** — Geo skill (with explicit user-trigger contract)
15. **H2** — verify sunset-sync schedule for 2026-06-17
16. **I2** — restore privacy posture section on /edge or document explicit drop
17. **A3.2** — auto-redirect `kind:"live"` users from `/edge` to `/dashboard`

### P2 — post-launch

18. **C4** — write "BOOTSTRAP edit cycle" doc
19. **D3.2** — gate event-creation behind week-2 date check in skill
20. **I1** — Geo SKILL.md "confirm before write" contract codification

---

## M. The launch-day rehearsal

The meeting wanted to walk the user flow "like fighter pilots." Here's the rehearsal script for launch day:

1. Attendee lands on **Edge canonical page** (Edge team owns; explains Agent Village)
2. Clicks "Set up your agent" → bounces to `instaclaw.io/edge`
3. Sees the InstaClaw landing — Healdsburg map cinematic, sections, hero CTA "Set up your agent" + secondary "I have my own agent"
4. Click main CTA → **interstitial** (NEW): explains InstaClaw, pricing, free-month, options
5. Hosted path: continues to form (NEW): 4-5 questions about interests/goals/connections/weeks
6. Form submit → `POST /api/edge/profile-intake` → stores in `instaclaw_users.edge_profile` → continues to `/signup` (Google OAuth)
7. After OAuth: existing `/connect` (Telegram bot setup) → `/plan` (Stripe with Edge promo applied automatically via `app/api/billing/checkout/route.ts:126`) → `/deploying` → `configureOpenClaw` runs (3-5 min)
8. configureOpenClaw deploys BOOTSTRAP.md + SOUL.md (with v80 Edge stub) + INSTACLAW_OVERLAY.md (updated form-aware copy) + EDGEOS_EVENTS_TOKEN (or fallback) + USER.md (with form intake data) + skills (edge-esmeralda + agentbook + others)
9. Telegram bot receives first message from agent: "You've already told me a lot about yourself — anything else you want to add?"
10. User responds → agent reads INSTACLAW_OVERLAY.md → conversational follow-up → maybe creates an Index intent
11. Index intent matched (cross-terminal, post-Yanek-unblock) → encounter visualized in the village viz → user gets a Telegram intro
12. 9 AM PT next day → morning brief (NEW): today's events + new attendees matching interests + intros from yesterday

If any of those 12 steps is broken on launch day, the experience falls apart. This PRD treats each as a tracked item.

---

## N. References

- This PRD: `instaclaw/docs/prd/edge-esmeralda-master-prd-2026-05-19.md`
- Edge audit doc (older): `instaclaw/docs/prd/edge-city-strategy-2026-05-03.md`
- Partner integration: `instaclaw/docs/prd/edgeclaw-partner-integration.md`
- EdgeOS sandbox runbook: `instaclaw/docs/edgeos-sandbox-test-setup.md`
- EdgeOS auth audit: `instaclaw/docs/edgeos-auth-audit-2026-05-14.md`
- Cross-terminal PRDs:
  - `instaclaw/docs/prd/chatgpt-oauth-phase-1-design.md`
  - `instaclaw/docs/prd/chatgpt-oauth-phase-1-implementation-plan.md`
  - `instaclaw/docs/prd/chatgpt-oauth-history-import.md`
  - `instaclaw/docs/prd/gbrain-fleet-rollout-canary-2026-05-19.md`
  - `instaclaw/docs/prd/autonomous-bake-system-design-2026-05-19.md`
  - `instaclaw/docs/prd/village-index-network-integration.md`
- Source code citations: see inline file:line refs throughout
- Village viz: `edgeclaw-village/docs/village-direction-2026-05-15.md` (8 magic moments)
