# Edge Esmeralda attendee journey — end-to-end audit

**Date:** 2026-05-19
**Author:** Cooper Wrenn + Claude
**Status:** AUDIT ONLY — no building until Cooper greenlights individual findings
**Scope:** The 8-step flow a real Edge Esmeralda attendee walks from "told to go to instaclaw.io/edge" through "first message from their agent in Telegram." 11 days to May 30 launch.

---

## TL;DR — what an attendee actually experiences today

A new attendee (sophisticated, AI/crypto researcher) following the friend's recommendation hits `instaclaw.io/edge` and sees:

1. **Stunning cinematic Healdsburg map** with a single CTA: "Set up your agent."
2. **Clicks the CTA → page scrolls down.** No new flow starts. They wonder if it's broken.
3. **Eventually reaches the Claim card at the bottom**, sees "We'll set up your **OpenClaw** a week before the village opens" (date confusion + internal product name) and a research-consent line with a `href="#"` placeholder link.
4. **Clicks "Claim your agent"** → POST `/api/partner/tag` → /signup with a partner-aware banner: "**CLAIMING YOUR EDGE ESMERALDA AGENT. FREE FOR VERIFIED TICKET HOLDERS.**" (Good!)
5. **Clicks "Continue with Google"** → OAuth → `/connect` (still Edge-themed with olive palette + persistent banner).
6. **Pastes Telegram bot token from @BotFather** (no deeplink — they have to know to open Telegram and search).
7. **`/plan` (Stripe checkout) → Edge banner DISAPPEARS.** Brand-seam break. Looks like they're now just a generic InstaClaw user.
8. **`/deploying` → 5-step progress with "Configuring OpenClaw"** (internal product name surfaced again) and "Payment confirmed" (doesn't match "free for ticket holders" framing). Edge banner still gone.
9. **After ~3-5 min provisioning completes.** Bot username surfaces. User has to DM the bot first — no auto-poke from us.
10. **First message from agent reads BOOTSTRAP.md** (generic awakening prompt — no Edge-specific framing) and routes to INSTACLAW_OVERLAY.md (✅ Edge interview now correctly says "EdgeOS canonical, Sola deprecated" after the P0-1 fix earlier today).

**Top 3 ship-blockers for May 30:**
- 🚨 Hero CTA is anchor-scroll, not flow-start (looks broken)
- 🚨 Consent is opt-out with placeholder `href="#"` link (worst possible signal for AI-researcher audience)
- 🚨 BYO-agent flow doesn't exist at all (meeting wanted minimal version)

**Net assessment:** The infrastructure is largely there and well-engineered. The Edge-aware partner banner, the state machine (Rule 33), the bot-token flow, the configureOpenClaw chain, the post-fix INSTACLAW_OVERLAY.md — all solid. **The user-facing seams are what need work.** Three high-frustration items, six medium, several low. Total ~25 findings. None of them require new architecture — they're all copy / surface / state-aware-routing tweaks.

---

## Methodology

For each of 8 steps:
- Read every file in the redirect chain end-to-end before puppeteering
- Puppeteer the page transitions in a fresh browser context (no cookies → simulates first-time visitor)
- Trace each redirect with `file:line` citations
- Enumerate failure modes
- Rank findings by "attendee walks away frustrated" impact: 🚨 HIGH, 🟡 MED, 🟢 LOW, 🟢 works

Puppeteer screenshots referenced inline as `puppeteer:<name>` — saved during the audit session, available on request.

---

## Findings ranked by attendee frustration

### 🚨 HIGH frustration (3 items — fix before May 30)

#### H1. Hero CTA is anchor-scroll, not flow-start

**Where:** `app/edge/components/nav.tsx` + `app/edge/components/map-hero-overlay.tsx` (both render `<a href="#claim">` for logged_out users)

**What happens:** A logged-out attendee clicks the prominent "Set up your agent" CTA in the hero. The page **scrolls down** to the Claim card. No new page, no spinner, no transition. A sophisticated user thinks the button is broken or they missed something. They have to click "Claim your agent" at the bottom for the real flow to start. **Two-click flow disguised as one.**

**Fix shape:** Either (a) hero CTA performs the same POST `/api/partner/tag` directly and routes to /signup, OR (b) keep anchor scroll but make the Claim card the FIRST section after hero so the scroll is short + obvious.

**Code refs:**
- `app/edge/page.tsx:121-141` — `deriveHeaderCta` returns `{ href: "#claim", ... }` for logged_out
- `app/edge/edge-city-client.tsx:116-134` — `handleClaim` (the actual POST handler) lives inside the Claim card, not the hero

#### H2. Research consent is opt-out with placeholder `href="#"` link

**Where:** `app/edge/components/claim.tsx` (Claim card copy)

**What happens:** Below the "Claim your agent" CTA, fine print reads: *"By setting up your agent you agree to participate in the EE26 research program. [Read the consent brief]."* The link is `href="#"` (literal placeholder). An AI/governance researcher in the audience clicks the link expecting to see what they're agreeing to, gets nothing, and the trust signal is destroyed.

This is the worst possible UX for the most-sophisticated subset of the audience (researchers in cooperative AI, governance, mechanism design).

**Fix shape:** Either (a) host a real consent brief at `instaclaw.io/edge/consent` and link there, OR (b) drop the consent line entirely until the brief is real. Sophisticated users would rather see no consent text than a broken consent link.

**Code refs:**
- `app/edge/components/claim.tsx` — search for `"Read the consent brief"`

#### H3. BYO-agent flow has ZERO surfaces

**Where:** N/A — doesn't exist

**What happens:** Sophisticated attendees with Hermes, Claude Code, or a custom Anthropic-API setup arrive at /edge and see no path for them. They either:
- Confused-click "Set up your agent" (provisions a hosted InstaClaw VM they didn't want)
- Look for a public skills repo / API key flow on the page (doesn't exist)
- Bounce

Meeting explicitly wanted this even in minimal form ("I bring my own agent" secondary CTA + a skills-repo handoff page). PRD §A3 + §F1 cover the spec.

**Fix shape:** Minimum-viable: add a secondary "I have my own agent" link under the hero CTA → routes to a new `/edge/byo` page that surfaces: (a) the EdgeOS event token mint flow (already-built `lib/edgeos-auth.ts` chain), (b) link to the public skills repo (when it's split), (c) a test-connection curl example. PRD §F1.

---

### 🟡 MED frustration (10 items)

#### M1. EdgePartnerBanner DISAPPEARS on `/plan` and `/deploying`

**Where:** `app/(onboarding)/plan/page.tsx`, `app/(onboarding)/deploying/page.tsx`

**What happens:** /signup and /connect both render the persistent dark-olive Edge banner (verified via puppeteer). /plan and /deploying drop it. The brand seam between "Edge attendee" and "InstaClaw user being provisioned" reopens at exactly the moment the user is most invested (paying / waiting for VM). User reads: "did I leave the Edge flow?"

**Fix shape:** Import `EdgePartnerBanner` from `components/marketing/edge-partner-banner.tsx` and add to /plan and /deploying. ~3 lines per file.

#### M2. "OpenClaw" surfaced in user-facing copy

**Where:** `app/edge/components/claim.tsx` (Claim card), `app/(onboarding)/deploying/page.tsx:160` (progress step label)

**What happens:** Both the landing page Claim card ("We'll set up your **OpenClaw** a week before the village opens") and the /deploying progress UI ("Configuring OpenClaw") use the internal upstream product name. Sophisticated users may recognize the open-source upstream; less-technical users see a brand they've never heard of and wonder what they're signing up for.

**Fix shape:** Replace "OpenClaw" with "your agent" in both surfaces. The internal name is an implementation detail attendees don't need.

#### M3. Copy says "a week before the village opens" but provisioning is immediate

**Where:** `app/edge/components/claim.tsx`

**What happens:** "We'll set up your OpenClaw **a week before the village opens**" — but today is May 19; village opens May 30 (11 days). Provisioning happens immediately on signup. User expectation: "I'm just registering interest now." Reality: provisioning starts in ~2 min after Google OAuth. The mismatch is jarring — user gets the "Your AI is being born…" page when they thought they were just claiming a spot.

**Fix shape:** Either (a) update copy to "We'll set up your agent immediately — you can start chatting today" OR (b) defer actual provisioning (more architecture). (a) is the right call given the existing flow.

#### M4. Hero CTA UX for "live" users

**Where:** `app/edge/page.tsx` (the live user still sees the full marketing landing)

**What happens:** A returning Edge attendee with a working VM hits /edge. The state machine correctly routes nav header CTA to "Open agent" → `https://t.me/<bot>`. But the user STILL sees the full marketing landing (cinematic + Plaza + Research + FAQ + Footer). Reads as "this product doesn't recognize me." PRD §A3 calls for auto-redirect to /dashboard for `kind:"live"` users.

**Fix shape:** Add a server-side redirect in `app/edge/page.tsx` (before the JSX return): `if (userState.kind === "live") redirect("/dashboard")`. One line. Live users land on their dashboard with the existing "you're an Edge attendee, here's your bot" framing.

#### M5. No deeplink to @BotFather in /connect

**Where:** `app/(onboarding)/connect/page.tsx:85` (BotFather mentioned in FAQ accordion)

**What happens:** User on /connect sees "Paste your Telegram bot token to connect your agent." If they don't already have a bot, they expand "How to get your bot token" and read instructions. They have to know to OPEN Telegram, SEARCH @BotFather, START him, and run `/newbot`. Non-technical attendees fail this step silently.

**Fix shape:** Add a button "Open @BotFather in Telegram" → `https://t.me/BotFather` (deeplink). And/or embed a 30-second video.

#### M6. No auto-poke after Telegram bot setup

**Where:** configureOpenClaw flow (no outbound first-message in our code)

**What happens:** After /deploying completes, the user sees the bot username and a "Open in Telegram" link. They click, open the chat, see... nothing. They have to type `/start` or any message before the agent's BOOTSTRAP.md awakening prompt fires. Sophisticated users figure this out; some attendees may not.

**Fix shape:** Send a first-message via the bot API after configureOpenClaw succeeds. Use a minimal "👋 awake. Send me anything to get started." This is a `sendMessage` call on the bot token we already have. Could even be wired into stepDeployEdgeOverlay as a one-shot trigger.

#### M7. Post-OAuth has no "welcome" beat

**Where:** Direct redirect from Google OAuth → /connect (no intermediate)

**What happens:** User completes Google OAuth → lands on /connect with no acknowledgment of "you're signed in as X@gmail.com" or "you're now an Edge attendee — your account is linked." Most users won't care; researchers may want to confirm before continuing.

**Fix shape:** Add a one-line confirmation on /connect: "Signed in as `{email}` · Edge attendee" near the persistent banner. Pulls from `session.user.email` + `session.user.partner`.

#### M8. /deploying time estimate underestimates real-world

**Where:** `app/(onboarding)/deploying/page.tsx` — copy says "about a minute"

**What happens:** configureOpenClaw runs 3-5 min in practice (per CLAUDE.md memory + the OpenClaw Upgrade Playbook context). User reads "about a minute," waits 90s, gets impatient, closes the tab. State machine recovery brings them back, but the trust signal degrades.

**Fix shape:** Update copy to "Usually 2-3 minutes — please leave this screen open." Or show a progressive estimate that updates as steps complete ("Configuring OpenClaw · ~2 min remaining").

#### M9. "Payment confirmed" step in /deploying doesn't match Edge "free" framing

**Where:** `app/(onboarding)/deploying/page.tsx` (progress step labels)

**What happens:** First step in the deploy progress reads "Payment confirmed." Edge attendees are getting it free (banner says "FREE FOR VERIFIED TICKET HOLDERS"). The "Payment confirmed" line implies they paid for something, contradicting the free framing.

**Fix shape:** For partner=edge_city users, swap "Payment confirmed" → "Plan selected" or "Trial started." Two lines of conditional in the page.

#### M10. /signup banner is single-line minimal — doesn't explain InstaClaw

**Where:** `components/marketing/edge-partner-banner.tsx` copy

**What happens:** /signup banner says "CLAIMING YOUR EDGE ESMERALDA AGENT. FREE FOR VERIFIED TICKET HOLDERS." That's the entire context for what InstaClaw is. Meeting wanted MORE explanation ("what InstaClaw is, why pricing, Edge partnership/free month, OpenAI subscription option").

**Fix shape:** Extend the /signup page (not necessarily the banner — the banner is good as a sticky strip). Add a short explainer below the headline: 2-3 lines on InstaClaw + what happens next (OAuth → bot setup → 3-min provisioning → first message).

---

### 🟢 LOW frustration (8 items)

#### L1. Privacy posture section removed from /edge
PRD §I2. The 4 principles (per-VM isolation, Maximum Privacy Mode, anonymized research, granular opt-in) were positioning, not decoration. Researchers expect them. **Fix:** restore as a sage-card-grid section between `<Features />` and `<PlazaSection />`. ~60 lines TSX.

#### L2. Footer all-`href="#"` placeholders
`app/edge/components/footer.tsx` — Privacy Policy / Terms / Contact / "Edge City" all dead links. Doesn't block flow; signals "beta." **Fix:** point at real pages (or remove the links if pages don't exist yet).

#### L3. "Powered by InstaClaw" attribution dropped
Per partnership agreement (CLAUDE.md memory + partner PRD §5.1: "pre-signup pure Edge brand, Powered by InstaClaw in footer only"). Seref's redesign removed it. **Fix:** add one line in the footer.

#### L4. Existing paying user → edge_city tag doesn't get retroactive promo
A pre-existing paying InstaClaw user who hits /edge and tags as edge_city continues paying their normal rate. The Edge promo (free month) only applies to NEW Stripe checkouts. Possible billing edge case for the "free for ticket holders" framing. **Question for Cooper:** intentional or oversight?

#### L5. /connect renders without auth at layout level
The (onboarding) layout doesn't gate. API endpoints gate. Not a security issue; minor confusion if someone deeplinks /connect without a session.

#### L6. /signup `<title>` is generic
"InstaClaw.io — Your Personal AI Agent, Live in Minutes" — could be Edge-aware ("Claim your Edge Esmeralda agent · InstaClaw").

#### L7. No abandoned-funnel email
If user closes during /deploying and never returns, agent sits idle. No email sent. **Fix later:** a cron-driven "your agent is ready, come back" email after, say, 24h of inactivity.

#### L8. "Apply to Edge Esmeralda" link appears twice
Hero + Claim card — slight redundancy. Not blocking.

---

## Code-traced redirect chain (canonical reference)

```
[1] instaclaw.io/edge
    app/edge/page.tsx:121 → getEdgeUserState()
                       → app/edge/edge-user-state.ts:28-92
                       → returns { kind: "logged_out" | "in_progress" | "live" }
    For logged_out: hero CTA href="#claim" → anchor-scrolls down

[2] Click "Claim your agent" (bottom of page)
    app/edge/edge-city-client.tsx:116 → handleClaim()
                       → POST /api/partner/tag { partner: "edge_city" }
                       → app/api/partner/tag/route.ts:34
                       → sets cookie instaclaw_partner=edge_city (7d max-age)
                       → returns { redirect_to: "/signup" }
                       → router.push("/signup")
    middleware.ts:97 allow-lists /api/partner/tag

[3] /signup
    app/(auth)/signup/page.tsx:13 → usePartnerCookie() → "edge_city"
                       → renders <EdgePartnerBanner /> (sticky olive bar)
                       → click "Continue with Google"
                       → signIn("google", { callbackUrl: "/connect" })

[4] Google OAuth → returns to NextAuth callback
    lib/auth.ts:12 → signIn callback fires
                       → reads instaclaw_partner cookie
                       → 3 branches (existing Google user / wallet user linking / brand new)
                       → all apply partner via tagUserAsPartner (lib/partner-tag.ts)
                       → Rule 9 dual-account-bug closed
    session.user.partner = "edge_city" (lib/auth.ts:249)

[5] /connect (callbackUrl)
    app/(onboarding)/connect/page.tsx → palette-swap to olive
                       → user pastes Telegram bot token
                       → TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/ validates
                       → POST /api/onboarding/save persists to instaclaw_pending_users

[6] Click "Continue to Plan Selection"
    → /plan
    app/(onboarding)/plan/page.tsx → Stripe checkout
                       → app/api/billing/checkout/route.ts:126
                       → user.partner === "edge_city" + EDGE_CITY_COUPON_ID → applies Edge promo

[7] Stripe success → /deploying
    app/(onboarding)/deploying/page.tsx → polls /api/vm/status
                       → calls configureOpenClaw (lib/ssh.ts) via /api/vm/configure
                       → 5 steps: Payment confirmed → Assigning server → Configuring OpenClaw → Connecting Telegram bot → Health check
                       → configureOpenClaw deploys BOOTSTRAP.md + SOUL.md (with v80 Edge stub) + INSTACLAW_OVERLAY.md (just fixed in v108) + skills (edge-esmeralda + agentbook + ...)

[8] First Telegram interaction
    user DMs the bot → bot has BOOTSTRAP.md unconsumed → agent reads BOOTSTRAP.md
                       → generic awakening prompt (asks for name/identity)
                       → creates .bootstrap_consumed marker
                       → from then on: SOUL.md routes to INSTACLAW_OVERLAY.md (Edge interview, one-at-a-time)
                       → agent stores answers in MEMORY.md for matching
```

---

## Cross-references

- This audit: `instaclaw/docs/edge-attendee-journey-audit-2026-05-19.md`
- Master PRD: `instaclaw/docs/prd/edge-esmeralda-master-prd-2026-05-19.md`
- Rule 9 (partner tagging): CLAUDE.md
- Rule 33 (onboarding state machine): CLAUDE.md
- Today's P0 fixes:
  - v108 Social Layer copy fix (commit `3cfd7a52`)
  - Village `<title>` fix (commit `0052e41` in edgeclaw-village)
  - Cron dedup (commit `78ef5037`) — fleet went from 164 → 9 redundant entries
  - Force-deploy script (commit `b427daa8`) — used to push v108 to all 9 edge VMs immediately

---

## Recommended fix order (for Cooper to greenlist)

If 11 days budget were perfectly allocated:

**Week 1 (May 19 → 26) — 3 HIGH + top 4 MED:**
- H1 (hero CTA flow-start) — 1 day
- H2 (consent placeholder link) — 1 day (either real brief or remove)
- H3 (BYO minimal page) — 2 days
- M1 (banner on /plan + /deploying) — 1 hour
- M2 (drop OpenClaw branding) — 1 hour
- M3 (fix "a week before" copy) — 30 min
- M4 (live-user redirect to dashboard) — 30 min

**Week 2 (May 27 → 30) — remaining MED + buffer:**
- M5-M10 — copy/UX polish

**Post-launch (week 1 of village):**
- L1-L8 — non-blocking polish

The 3 HIGH items are launch-blockers — they will be the first thing 500 sophisticated people notice. None require new architecture; all are surface fixes.
