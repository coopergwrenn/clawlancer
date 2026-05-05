# Edge City Partnership — End-to-End Strategy & Roadmap to Esmeralda 2026

**Status:** Draft (strategy doc, not build instructions)
**Author:** Cooper / Claude
**Date:** 2026-05-03
**Days to Edge Esmeralda:** 27 (start 2026-05-30, run through 2026-06-27)
**Companion docs:**
- `instaclaw/docs/prd/edgeclaw-partner-integration.md` (1,906-line tactical PRD — what to build)
- `instaclaw/docs/PRD-consensus-2026-skill.md` (Consensus dress rehearsal — May 5–7 ship)
- `instaclaw/docs/prd/index-network-signal-schema-spec.md` (Index Network wire format draft)

---

## 0. Executive Summary

**Where we are.** The InstaClaw partner-skill pattern works. Edge attendees who tag get a VM with the edge-esmeralda skill, the consensus-2026 skill, a SOUL.md edge section, and (as of yesterday) a privacy-mode toggle. Five edge_city VMs are healthy on cv=79 with the QA-fixed bridge staged. Consensus 2026 ships this Tuesday as the franchise prototype.

**Where we're going.** The big PRD's vision is 1,000 agents coordinating overnight via Index Network + XMTP, surfacing curated daily plans via Telegram, with an unprecedented research data layer for Vendrov's pre-registered experiments. That vision is correct *and* aspirational. Twenty-seven days to launch. Most of the wedge isn't built yet.

**The ask of this doc.** Don't ship the full PRD vision in 27 days — we'd ship none of it well. Make three bets:
1. **Plan B is the primary plan.** Index Network is the upgrade path. The wire format is identical; we cut over if and when Index ships. All engineering effort goes to a centralized matching engine on InstaClaw infrastructure, ~$50 of OpenAI embeddings + a 3am cron + bilateral writes back to both agents' inboxes. Known cost, known throughput, known UX.
2. **Skip XMTP for matchmaking v1.** Plan B with bilateral writes makes the agent-to-agent message bus unnecessary for the morning-briefing UX. Add XMTP back for governance + group formation in week 2 of the village.
3. **Privacy Mode is the trust narrative.** Not just a toggle; the marketing artifact that justifies the partnership. Cooper's comparable companies (Luma, Brella) cannot ship this — they aren't agent-runtime providers, just app vendors. We are.

Two cuts to make those bets work:
1. **Cut the placeholder-shell onboarding.** Clever, but it's net-new infrastructure (Vercel Edge function + Redis + websocket + state-transfer protocol). Defer to Edge Lanna (Sept). The existing Telegram-pairing flow is suboptimal but working.
2. **Cut Path B/C for May 30.** Path A is the village. Path B/C ship post-village in July for the broader builder community.

One add:
1. **Ship the Live Activity Dashboard as a public-anonymized artifact.** Two days of work, zero dependency on Index Network or XMTP. The marketing piece + the research instrument + the social proof, all from the same data.

**The thesis.** Edge agents aren't a conference app. They are the *first portable AI memory tied to a real-world community*. Luma/Brella/Grip/Whova are vertical apps that die when the conference ends. The InstaClaw agent persists; the partner skills are the variable. Bitcoin 2026 in July, Token2049 in October, Edge Lanna in September — same agent, new skills, deeper context every event. **That's the partnership-justifying differentiation, not feature parity with Brella.**

---

## 1. The Honest State of the Edge City Build (2026-05-03)

What's shipped, what's vapor, what's blocked.

### Shipped

| Component | Status | File / location |
|---|---|---|
| Partner-tag column on `instaclaw_users` + `instaclaw_vms` | ✅ Live in prod | Migration applied |
| `/api/partner/tag` endpoint w/ VALID_PARTNERS allow-list | ✅ Live | `app/api/partner/tag/route.ts` |
| `/edge-city` portal page | ✅ Live (educational, opt-in copy) | `app/(marketing)/edge-city/page.tsx` |
| `/consensus` portal page | ✅ Live (Consensus dress rehearsal) | `app/(marketing)/consensus/page.tsx` |
| `installEdgeCitySkill()` (clone + 30-min cron + env vars) | ✅ Live | `lib/ssh.ts:4403-4427` |
| `installConsensusSkill()` (clone + 30-min cron) | ✅ Live | `lib/ssh.ts:4429-4445` |
| SOUL.md edge_city section | ✅ Live (~700 chars) | `lib/ssh.ts:4751-4769` |
| SOUL.md consensus_2026 section | ✅ Live (~500 chars) | `lib/ssh.ts:4778-4784` |
| Privacy Mode v0 — UI toggle, API, internal check endpoint, SSH bridge script | ✅ Built; cutover Phase B (May 7-8) | `lib/privacy-bridge.sh` (cv=79 on all 5 edge VMs, sha-verified) |
| Operator audit log table + 5% sample email cron | ✅ Built (table empty until cutover) | `supabase/migrations/20260502_operator_audit_log.sql` |
| Edge-esmeralda skill repo + 30-min refresh | ✅ Live (upstream maintained by Tule) | `github.com/aromeoes/edge-agent-skill` |
| Consensus-2026 skill repo (326 sessions, 219 events, 451 speakers) | ✅ Live | `github.com/coopergwrenn/consensus-2026-skill` |

### Vapor (in PRD, not built)

| Component | PRD § | Why it matters | Status |
|---|---|---|---|
| Index Network signal submission + match retrieval | §4.9 | The killer feature — overnight matchmaking | Spec'd (signal-schema-spec.md), zero implementation |
| Plan B centralized matching engine | §4.15 | Safety net if Index isn't ready | Architecture done, zero implementation |
| Overnight planning cron (11pm signal → 4am matches → 7am briefing) | §4.9.2 | The headline UX | Zero implementation |
| Morning briefing template + Telegram delivery | §4.9.2 Phase 3 | What attendees actually see | Zero implementation |
| XMTP plaza + groups (ee26-plaza, governance, events) | §4.9.4 | Agent-to-agent backbone | Zero implementation |
| XMTP client systemd service per VM | §4.9.6 | Agent identity via Bankr wallet | Zero implementation |
| Live Activity Dashboard | §4.14 | Marketing artifact + research instrument | Zero implementation |
| Memory backup + portability (encrypted, user-keyed) | §4.17 | Trust + portability narrative | Zero implementation |
| Coordinator agents (sentiment, governance, treasury, events, research) | §4.9.9 | Population-level functions | Zero implementation |
| Research data export pipeline (5 anonymized tables) | §4.10.3 | Vendrov's experiments depend on this | Zero implementation |
| Cohort assignment system + time-staggered rollout | §4.18 | Vendrov's clean experimental conditions | Zero implementation |
| Granola transcript ingest + retrieval | §1.4 / §1c | "Summarize the session I missed" | Zero implementation; Tule driving |
| Placeholder-shell onboarding | §5.0 | Eliminates UX seam during VM provisioning | Zero implementation |
| Path B (terminal/self-serve CLI) + Path C (BYO bundle) | §3.5.2 | External builder distribution | Zero implementation |
| `edge-conformance` test suite | §3.5.1 | Path B/C compatibility validation | Zero implementation |

### Blocked

| Blocker | Owner | What it's blocking |
|---|---|---|
| **Test ticket from Edge ticketing system** | Timour | Ticket validation E2E (PRD §5.4.2). Without this, May 9 portal-live milestone slips. |
| EDGEOS_BEARER_TOKEN + SOLA_AUTH_TOKEN | Tule | Edge skill currently writes `PLACEHOLDER_WAITING_ON_TULE` (`lib/ssh.ts:4409-4410`). Skill installed but tokens dead. |
| Index Network endpoint readiness | Index Network team (Seref) | Plan A. Without it, we ship Plan B. **May 23 decision deadline.** |
| DPA / NDA with Vendrov | Cooper + Vendrov | Research data export pipeline. Originally May 1 milestone, status unclear. |
| Sponsor commitment confirmed (compute funding) | Timour | Determines whether agents are gated or ungated. **May 15 soft deadline.** |
| Edge City branding assets (logo, colors, hero) | Timour | Portal page is functional but using InstaClaw default styling. |

### Net assessment

What we have today: **a partner-tagged VM that knows about the event** (skill + onboarding + memory) + **a privacy-mode toggle that's about to start enforcing**. Functionally, that's a chatbot with a custom skill. The killer feature — overnight matchmaking that produces a curated morning briefing — exists only on paper.

That's not enough differentiation to justify the partnership *or* convert attendees to paid InstaClaw users post-village. We need to ship the matching engine + briefing in 27 days. **That is the singular focus.**

---

## 2. The Attendee Journey — Where It Breaks, Where It's Magic

### Pre-event flow (today)

```
A. Hear about it
   ├─ Edge Substack: "The Agent Village Experiment at Edge Esmeralda 2026"
   ├─ Timour's tweet
   ├─ Word of mouth (other attendees)
   └─ Cooper's outreach (X, Farcaster, Telegram)
        │
        ▼
B. Land on edgecity.live/agent-village
   (today: redirects to instaclaw.io/edge-city; future: native Edge page proxy)
        │
        ▼
C. Read educational content + privacy framing
   (✅ live; opt-in copy reviewed; "Maximum Privacy Mode auto-reverts after 24 hours")
        │
        ▼
D. Click "Claim Your Agent" CTA
   (✅ live; sets partner cookie via /api/partner/tag, redirects to /signup)
        │
        ▼
E. ❌ Ticket validation
   (NOT BUILT. Today the system trusts the cookie. PRD §5.4 specs the validation
    against Edge ticketing API but blocked on test ticket from Timour.)
        │
        ▼
F. Google OAuth (✅ existing)
        │
        ▼
G. Stripe Checkout w/ EDGE coupon (100% off first month)
   (✅ existing; auto-applied if partner cookie present per PRD §5.2)
        │
        ▼
H. instaclaw_pending_users record created
        │
        ▼
I. process-pending cron assigns VM from ready pool (~30-60s)
   (✅ existing; bottleneck if pool runs dry — POOL_TARGET=15 today,
    PRD §4.19 wants 50 by May 20)
        │
        ▼
J. configureOpenClaw runs:
   ├─ Standard SOUL.md + workspace files
   ├─ edge-esmeralda skill clone + EDGEOS+SOLA env vars (✅ but tokens are placeholder)
   ├─ consensus-2026 skill clone (✅; Edge users get both)
   ├─ SOUL.md gets edge section appended (✅ ~700 chars)
   ├─ SOUL.md gets consensus section appended (✅ ~500 chars)
   ├─ Privacy bridge script staged (✅ since yesterday, cv=79)
   ├─ Standard scripts (strip-thinking, watchdog, push-heartbeat, etc.) (✅)
   └─ Gateway restart, healthcheck (✅)
        │
        ▼
K. Telegram bot pairing
   (✅ existing; via BotFather. THE WORST step in the flow — see breaks below.)
        │
        ▼
L. First message to agent
   (✅ existing; agent introduces itself, asks 4 onboarding questions per
    SOUL.md edge section. Form-like, not conversational.)
```

### During-event flow (today, day 1 at the village)

```
M. "What's happening today at 10am?"
   → agent queries Social Layer API via edge-esmeralda skill (✅ if SOLA token works)

N. "Find me other biotech founders attending"
   → agent queries EdgeOS API via edge-esmeralda skill (✅ if EDGEOS token works)

O. "Where do I get a parking pass?"
   → agent reads references/wiki-content.md from skill repo (✅)

P. "Summarize the AI session I missed at 11am"
   → ❌ NOT BUILT. Granola integration is planned (PRD §1.4) but Tule hasn't
     shipped the ingest pipeline. Agent can't answer.

Q. "Who should I meet today?"
   → ❌ NOT BUILT. The killer feature is vapor. Agent can search the directory
     but doesn't proactively match.

R. Morning briefing at 7am: "Good morning! While you slept, I coordinated with
   other agents and found 3 great connections..."
   → ❌ NOT BUILT. No overnight cycle exists. User wakes up to silence.

S. Governance vote in Telegram: "Should we extend quiet hours? Your agent thinks..."
   → ❌ NOT BUILT.

T. Group dinner forms: "I found 6 biotech-curious people for tonight 7pm..."
   → ❌ NOT BUILT.

U. Privacy mode toggle ON when concerned about a sensitive convo
   → ⚠️ Cutover Phase B (May 7-8). Then real.
```

### Post-event flow (future, today's user wouldn't see this)

```
V. Subscription continues, agent persists w/ accumulated memory
   (✅ existing; standard InstaClaw retention)

W. Edge skill ratchets down (no more useful API calls; references stale)
   (✅ — by design; skill stays installed but content goes inert)

X. Bitcoin 2026 in July: user tags → consensus-2026-skill replaced w/
   bitcoin-2026-skill. Same agent, new skills.
   (⚠️ requires building bitcoin-2026-skill; pattern-copy of consensus-2026)

Y. Free trial → paid conversion (PRD success metric: >10%)
   (Today: too early to measure. Post-village.)
```

### Where it breaks

In rough priority order:

1. **K. Telegram pairing.** BotFather flow is a 5-15 minute drop-off zone for non-technical users. Edge skews technical so survivable, but for a Lanna village where 30% of attendees are non-technical, this kills conversion. PRD §5.0 placeholder-shell would fix this by deferring Telegram setup until after the user is already engaged in conversation. *Recommendation: keep the existing flow for May 30, build placeholder shell for Lanna.*

2. **E. Ticket validation.** Without it, the CTA is open to anyone, which dilutes the "exclusive Edge attendee experience" framing. **Action: get the test ticket from Timour this week.** Without it, we ship trust-based access and audit who actually showed up.

3. **L. First-message awkwardness.** Agent asks 4 questions in a row, gets 4 single-line answers, immediately tries to summarize. Not magical. PRD §5.0 fixes this with conversation continuity from placeholder. Workaround: rewrite the SOUL.md onboarding script to ask ONE question at a time and let the conversation breathe.

4. **P. Granola Q&A is the moat — and it's vapor.** "Summarize the session I missed" is the single most-cited reason attendees say they want this product. Without it, the agent feels like a directory + chatbot. *Coordinate w/ Tule — what's the realistic ship date for transcript ingest?*

5. **Q-T. The matching layer is vapor.** The whole thesis. Without overnight planning + morning briefing, we're shipping a chatbot at scale. **This is the only thing that absolutely must ship by May 30.** Plan B carries the load.

6. **EDGEOS + SOLA tokens are placeholders.** Skill is installed but the live API calls fail. *Action: ping Tule, replace placeholders this week.*

### Where it's magic (today)

1. **The agent KNOWS the event from minute 1.** No setup, no profile-filling. SOUL.md customization gets us to "you are an agent at Edge Esmeralda 2026, your human is an attendee" before they say a word.

2. **Cross-event awareness.** Edge attendees auto-get the Consensus skill too because everyone in our cohort is at Consensus this week. Subtle but right.

3. **Memory persistence over 4 weeks.** Most chatbots reset; this one compounds. Day 28 the agent knows you better than your own friends do.

4. **Privacy posture as default.** Maximum Privacy Mode default-OFF (operators can debug); user opts IN. Cooper's industry-distinct trust posture.

### Where we lose people

| Drop-off | Why | Mitigation |
|---|---|---|
| 60-90% on the Stripe checkout step (industry baseline) | Even at $0, requires card; fingerprint + 3DS challenges | EDGE coupon auto-apply ✅. Beyond that — the funnel just is what it is. |
| 30-50% on Telegram pairing | BotFather UX | Placeholder shell at Lanna; for May 30 ship a v1.5 — embed a tutorial gif on the dashboard |
| Day 2-3 if matchmaking doesn't work | Expectation mismatch — they came for the agent that does, get the chatbot | **Ship Plan B.** This is THE conversion driver. |
| Post-village 90% if nothing replaces Edge skill | Agent value prop drops once the village is over and they don't have a next event tagged | Solve by ramping Bitcoin 2026 skill ready for July (~9 weeks); messaging on dashboard "your next event?" |

---

## 3. The Differentiation Thesis — Why This Is Fundamentally New

### What we have today vs. a regular InstaClaw agent

A regular InstaClaw agent has: Telegram, browser, memory, scheduling, skill marketplace (bankr, dgclaw, etc.), proactive heartbeat. An Edge City agent has all of that PLUS:

- Edge-esmeralda skill (event schedule, attendee directory, wiki/website/newsletter context)
- Consensus-2026 skill (326 sessions, 219 side events for the cross-event cohort)
- SOUL.md edge section (~700 chars: identity, community norms, onboarding script)
- Privacy mode toggle (bridge enforcement starts Phase B, May 7-8)

**Honest answer to "is that enough?":** No. That's a vertical app feature set. Luma + Brella + Whova ship roughly equivalent functionality (schedule, directory, search). They've all gotten the "personal AI assistant for the event" product brief in the last 12 months and shipped versions of it. The ones with budget are competitive on features.

### What WOULD make Timour and Steph say "we need this at every Edge event"

Five concrete differentiators, ranked by what a partner would actually care about:

1. **The agent persists past the event.** Luma's matchmaking dies the day the conference ends. Our agent keeps the memory, keeps making intros via the next skill that gets installed. Edge City attendees who continue to Edge Lanna six months later have the agent already trained on them. This is the #1 partnership argument.

2. **The matching is meaningfully better.** A 4-week residential setting + an agent that's been listening to its human for weeks = signals that Luma's "select your interests at signup" architecture cannot generate. The Edge wedge is *time*, not headcount. Plan B + 4 weeks of memory beats Index Network + 5-checkbox onboarding.

3. **Privacy posture as a partnership signal.** "We can't read your conversations" is a sentence Luma can never say credibly because Luma OWNS the conversation infrastructure. We do not — we host an agent that runs on the user's VM, with a user-controllable privacy mode that's enforceable in code. That's a marketing artifact. Steph's "we need this for every event" calculus weighs *trust* heavily; this is the thing that wins it.

4. **The research output.** Vendrov's pre-registered experiments (PRD §4.10) make this not just a product launch — it's the *first publishable longitudinal study of AI-mediated coordination in a residential community*. Edge City wants the prestige; Vendrov wants the paper; sponsors fund it. None of the conference apps can do this — they don't have agents tethered to specific humans for months.

5. **Generalizable to every Edge event going forward.** Eclipse Festival (5-10K), Edge Lanna (Sept), Bitcoin 2026 if Edge wants the crypto angle, Devcon. Same architecture; partner-tag column + skill repo + SOUL section per partner. Steph's calculus: "this works for the next 5 events" beats "this works for one."

**What's still missing for the full pitch:**
- Index/Plan B matching live (not just spec'd) — partial credit; Plan B is the realistic May 30 ship
- Memory portability shipped (PRD §4.17) — the *user-controlled* pitch is hard without this
- Plaza / activity dashboard live — the social-proof artifact

---

## 4. Competitive Landscape

The five platforms attendees actually use, what they do well, and where they're structurally broken. (Synthesized from G2/Capterra/TrustRadius reviews + recent industry commentary.)

### Platform-by-platform

| Platform | Value prop | What they do well | What's broken |
|---|---|---|---|
| **Luma** | Clean event pages for tech/creator communities | Polished UX, push notifications, calendar/community subscriptions (the closest thing to a network effect any of these have) | No attendee-to-attendee discovery layer at all. The guest list is a wall of names. Account suspensions with no human recourse are common. Android in-event chat doesn't exist (iOS only). |
| **Partiful** | SMS-first, account-less RSVP. *a16z mandated it for all official Tech Week 2025 events* | Frictionless signup; group-chat vibe; reminders that land | No matchmaking, no schedule view, no networking layer whatsoever. Built for parties, accidentally being used for conferences. |
| **Grip Events** | B2B AI matchmaking sold to industrial trade-show organizers | The 1:1 meeting scheduler with calendar holds is the actual workflow primitive of B2B events | "AI" matchmaking is mostly tag overlap. Recommendations skew "people in similar job titles" — superficial similarity, not actual fit. **Token2049 uses Brella, not Grip** — Grip lives at Money20/20 / Web Summit. |
| **Brella** | Conference networking app. Powers Token2049, SLUSH, Web Summit-adjacent events | Best-rated meeting matchmaking in the category | Token2049 attendee on App Store: *"Can't even get past the signup screen… for the money they charge to go to this event it would be cool if they invested in making a functional app."* Goes dark within a week of event end. |
| **Whova** | Swiss-army-knife conference platform for academic/corporate events | Pre-event community board generates real chatter | *"Countless app updates and notifications from the Whova team upselling their product — feels like no attendees are using the app, just Whova pushing messages to itself."* The notification-dot-with-nothing-inside is the canonical Whova UX failure. |

### The graveyard

Brazen pivoted to virtual hiring fairs. **Bizzabo's original 2012 product was an attendee-networking app — they killed it and rebuilt as enterprise organizer software** because the unit economics of attendee-side apps don't work. Eventbrite Reach was sunset. The pattern is identical: every networking-first attendee app has failed or pivoted to organizer-side management.

### The killer stat

Per Bizzabo's own *State of Events* report: **only 46% of organizers think their networking actually helps attendees connect**. That's a vendor admitting their flagship feature might as well be a coin flip. It's the ceiling of the current paradigm because the data going in is too thin — 3 dropdown answers on a registration form cannot match a founder to the right investor.

### The structural misalignment

Every platform above has the same fatal flaw: **vendors are paid by organizers; the product is consumed by attendees; attendees never chose it.** Vendors optimize for organizer-facing dashboards (gorgeous) because that's who writes the check. Attendee outcomes (terrible) are externalized.

This is why the apps die. Once the event ends, the organizer's contract ends, and the vendor has no incentive to make the app valuable to the attendee anymore. The attendee notices. They never open it again. **Sched's data: apps go silent the day after. LinkedIn becomes the de facto graveyard — connections accepted, never messaged. The "30 days later, did you actually stay in touch" cohort is ~3%.**

### Where an agent that's *yours* wins

Each pain point above maps to something the InstaClaw architecture is structurally able to do:

| Pain point | Why apps fail at it | Why an attendee-owned agent wins |
|---|---|---|
| **Pre-event matching** | 3-dropdown registration form is too thin a signal | The agent has weeks of conversational memory: what the user is working on, what they read, who they've followed up with. Matching on substance, not tags. |
| **During-event "what's happening NOW"** | The schedule is static; the actual hallway chatter has no signal layer | The agent receives availability signals from other agents and surfaces real-time deltas via Telegram (the user's primary channel anyway, not a separate app to open) |
| **Post-event "stay in touch"** | The app dies; LinkedIn becomes the graveyard | The agent persists. Day 30 it surfaces "the person you met in Singapore just shipped X — want me to draft a follow-up?" |
| **Cross-event memory** | Walled gardens — each app starts from zero | The agent accumulates across every event the attendee ever attends. Bitcoin 2026 starts with the user's Edge village memory pre-loaded. |
| **Aligned incentives** | Attendee is the product, organizer the customer | Attendee pays InstaClaw. Agent serves attendee. Partner subsidy is a one-event onboarding accelerator, not a permanent customer relationship. |

### The structural thesis

The conference-app category is structurally incapable of being good. **It sells to the wrong customer.** The replacement is not a better app for organizers but an attendee-owned agent that treats every event as one episode in a multi-year relationship graph the attendee actually owns. *That* is the partnership-justifying differentiation. Edge City isn't picking a better Brella — they're picking a fundamentally different category of product.

This also explains why the Privacy Mode trust narrative (Bet #3) matters more than it looks. Brella, Whova, Luma, Partiful — none of them can credibly say "your operator can't read your data" because they're vendors holding the data. We can. The architecture forces it. *That's* what makes Steph and Timour say "we need this at every event": not feature parity with Brella, but a fundamentally different incentive structure.

---

## 5. Architecture Audit — Will This Scale to 10/50 Partners?

### Current architecture

```
        ┌─ Marketing surface ─────────────────────┐
        │  app/(marketing)/<partner>/page.tsx     │  per-partner landing page
        │  app/(marketing)/<partner>/<partner>-   │  claim button → tag API
        │      client.tsx                         │
        └────────────────────────────────────────┘
                          │
                          ▼
        ┌─ Tagging surface ──────────────────────┐
        │  app/api/partner/tag/route.ts:28        │  VALID_PARTNERS allow-list
        │  Sets partner cookie + DB row updates   │
        └────────────────────────────────────────┘
                          │
                          ▼
        ┌─ DB ───────────────────────────────────┐
        │  instaclaw_users.partner    TEXT NULL  │
        │  instaclaw_vms.partner      TEXT NULL  │
        └────────────────────────────────────────┘
                          │
                          ▼
        ┌─ VM provisioning ──────────────────────┐
        │  configureOpenClaw() in lib/ssh.ts     │
        │  ├─ if (partner === "edge_city")       │  install edge skill + tokens
        │  ├─ if (partner === "consensus_2026"   │
        │  │      || "edge_city")                │  install consensus skill
        │  ├─ SOUL.md += edge_city section       │  ~700 chars
        │  └─ SOUL.md += consensus section       │  ~500 chars
        └────────────────────────────────────────┘
                          │
                          ▼
        ┌─ Skill content (per partner) ──────────┐
        │  github.com/aromeoes/edge-agent-skill   │  upstream maintained
        │  github.com/coopergwrenn/consensus-     │
        │      2026-skill                         │
        │  Cloned to ~/.openclaw/skills/<name>/   │
        │  30-min cron pulls upstream             │
        └────────────────────────────────────────┘
```

### What scales fine to 10 partners

- **Partner-tag column.** TEXT NULL works for any number of partners.
- **`/api/partner/tag` allow-list.** A `VALID_PARTNERS` set with 10 entries is fine.
- **Marketing pages.** Per-partner Next.js routes are fine. They share components.
- **Skill repos.** Each partner owns their skill repo (Edge: aromeoes/edge-agent-skill; Consensus: coopergwrenn/consensus-2026-skill). Tule, Cooper, or partner team commits to their repo; the 30-min cron does the rest.

### What breaks at 10 partners

- **`if` blocks in `lib/ssh.ts`.** Today there are two partner-gated install blocks. At 10 partners, that's 10 if-blocks doing slight variations on "clone repo + add cron + write env vars." Smelly but workable. *Mitigation:* refactor to a `partners` config table (per PRD §9), with each partner declaring `{ slug, skill_repo, env_vars[], soul_section_marker }`. Single install loop. Defer until partner #5.

- **Bootstrap SOUL.md size limit (CRITICAL — already over).** Per the OpenClaw Upgrade Playbook in CLAUDE.md and the Consensus PRD §6, the bootstrap context budget is 30,000 chars. Standard SOUL.md is already 31,905 chars before any partner sections. We are over. Adding edge_city (~700) + consensus_2026 (~500) puts us at ~33,000. **Anything past 30K is silently truncated by OpenClaw at agent boot.** Cooper has been mitigating by keeping partner sections terse, but this doesn't scale.

  **The fix isn't shrinking partner sections — it's getting partner content out of SOUL.md entirely.** Move all partner content to per-partner SKILL.md files (which agents read on demand, not at bootstrap). SOUL.md gets a single line: "If user mentions Edge Esmeralda 2026, read `~/.openclaw/skills/edge-esmeralda/SKILL.md` for full context." That's 100 chars per partner. At 50 partners we use 5K chars total, well within budget.

  **This is a Phase 1 fix that should happen BEFORE Edge Esmeralda launches.** Cost: 1 day. Gain: unblocks every future partner.

- **Cron count.** Each partner skill adds a `*/30 * * * *` cron. At 10 partners, that's 10 git pulls every 30 minutes. Fine. At 50, it's 50, but they're staggered naturally.

### What breaks at 50 partners

- **Naming collisions.** `edge_city`, `edge_lanna`, `consensus_2026`, `bitcoin_2026`, `token2049_2025`, `eclipse_2026`, etc. Today `partner` is a single TEXT column with one value. A user at Bitcoin 2026 *and* Edge Esmeralda needs two tags. Solution: a junction table `instaclaw_user_partners` with `(user_id, partner_slug, valid_from, valid_to)`. Defer until partner #5 forces it.

- **Partner-specific env vars.** EDGEOS_BEARER_TOKEN, SOLA_AUTH_TOKEN — Edge has 2. Future partners may have 5 each. At 50 × 3 = 150 partner-specific env vars in Vercel. Manageable but ugly. *Mitigation:* per-partner secret group, fetched from Vercel API at configure time, not statically baked.

- **Skill cron drift.** 50 git-pull crons, all hitting GitHub at the same time twice an hour. GitHub will rate-limit. *Mitigation:* per-partner GitHub Actions schedule that mirrors to S3 + CDN; VM-side cron pulls from S3, not GitHub directly.

- **SOUL.md still works** if we made the move-to-SKILL.md fix above. That's the only architectural change required.

### Verdict

The architecture scales to 10 partners with two changes (refactor if-blocks, move partner content to SKILL.md). It scales to 50 with the junction table + partner secret groups + skill mirroring. Cost: ~3 days of refactor, spread out as we hit each scale threshold. None of it is required for May 30; the SOUL.md size fix should land in week 1 of the village, the rest deferred to post-village.

**The partner pattern is a strong pattern.** It's simple, partner-isolated (a broken Edge skill doesn't affect Bankr users), and recoverable (partner-tag changes propagate through the next reconcile cycle). The scaling fixes are mechanical, not architectural.

---

## 6. Three Big Bets

### Bet #1: Plan B is the primary plan

**Today's plan:** Index Network does the matching via per-user negotiator agents. PRD §4.9.1 architecture. May 23 is the decision deadline; if Index isn't end-to-end functional by then, flip to Plan B (centralized matching engine on InstaClaw infra).

**Proposal:** Reverse the polarity. Plan B is the primary plan. Index is the upgrade path.

**Why:**
- **Plan B is simpler.** A 3am cron reads all `agent_signals` from the last 24h, computes embeddings (OpenAI text-embedding-3-small, $0.02 per 1M tokens), runs cosine similarity against every other signal, picks top-K, writes outcome to each agent's `~/.openclaw/inbox/index/`. Standard ML pipeline. Known cost (~$50 for the village). Known throughput (sub-second matching for 1,000 signals).

- **Plan B is stable.** Index Network's negotiator architecture isn't production-tested at 1,000-agent scale. Their docs site was offline during Cooper's Consensus research (per the Consensus PRD §2.4: "alpha-tier signals (low GH stars, no conference precedent, in-flight auth refactor between SDK and protocol)"). We do not have visibility into their throughput, latency, or readiness.

- **Plan B is publishable.** "Centralized AI-mediated matchmaking at residential-village scale" is a legitimate research artifact. Vendrov can publish on Plan B without any caveats about partner readiness.

- **Plan B unblocks the rest.** With Plan B as the primary, we can build the data export pipeline, the cohort assignment system, the morning briefing template, the live activity dashboard — all against a known matching layer. Index Network becomes a pluggable upgrade later.

- **The wire format is identical.** PRD §4.15 already commits to identical `route_intent()` semantics. If Index ships post-village, we cut over via env var (`INDEX_NETWORK_MODE=fallback|live`). Zero user-facing change.

**What this loses:**
- Plan B has no real "negotiation" — it ranks once, surfaces results, done. So Vendrov's Hypothesis 3 (Coasean bargaining) only validates with Plan A. *Mitigation:* publish the hypothesis as "tested under centralized matching, follow-up under Index Network's negotiator architecture in Edge Lanna." Two-paper sequence is better than one paper at risk.

- Plan B keeps signal data on InstaClaw infrastructure (already covered by the research DPA); Plan A had it on Index infra (separate sub-processor). *Mitigation:* one less DPA to negotiate.

**The recommendation:** ship Plan B. Index is a partnership conversation, not a critical-path dependency.

### Bet #2: Skip XMTP for matchmaking v1

**Today's plan:** Each VM runs a per-VM XMTP client systemd service (`@xmtp/node-sdk`, Bankr wallet authentication, plaza groups). Agents A and B negotiate the actual intro via XMTP DM after Index Network ranks them as a match (PRD §4.9.4).

**Proposal:** Skip XMTP for the matchmaking v1. Use Plan B's bilateral writes — when the matching engine ranks (A, B) as a mutual match, it writes the meeting to *both* agents' inboxes. Each agent independently surfaces to its human via Telegram. Each human confirms or declines via Telegram. The matching engine reconciles confirmations and writes the final meeting back to both inboxes. **No agent-to-agent message bus needed.**

**Why:**
- **Bilateral writes are simpler than DM negotiation.** One central process knows all the matches. It writes to N inboxes. Each agent reads its own inbox. No messages cross between agents.

- **Same UX.** User wakes up to Telegram briefing. The mechanism behind it (XMTP DM round-trip vs central bilateral write) is invisible.

- **XMTP cost is real.** Per-VM systemd service + Bankr wallet integration + group management + content type definitions + local message queue + plaza/governance/events groups + cron-driven inbox processing. PRD §4.9.4 lists it; it's ~5 days of focused work *just for the harness*. Plus testing. Plus the message-bus failure modes (network partitions, key rotation, group permissions).

- **XMTP is the right answer for governance + group formation.** Voting on a proposal, agents arguing about a venue for a dinner, cross-agent treasury settlement — these are inherently *conversational* and benefit from a real message bus. Defer XMTP to those features in week 2-3 of the village.

**What this loses:**
- The "1,000 AI agents coordinating overnight via encrypted messaging" narrative is weakened. PRD §4.9.8 calls this "the killer feature." *Counter:* the matchmaking *outcome* is the killer feature; the *implementation detail* (DM bus vs bilateral write) is invisible to the user. We can still describe agents as coordinating; we just describe it correctly.

- Decentralization story for the paper is partially deferred. *Counter:* Vendrov publishes the centralized-matching paper now, the XMTP-based decentralized matching paper as a Lanna follow-up. Two papers > one paper.

- Path B/C compatibility loses XMTP as a shared protocol. *Counter:* Path B/C is being deferred regardless (see cuts below), so this doesn't affect May 30.

**The recommendation:** ship matchmaking on Plan B + bilateral writes. Add XMTP back in week 2 for governance/group formation, where its conversational nature actually adds value.

### Bet #3: Privacy Mode is the trust narrative — make it the marketing centerpiece

**Today's framing:** Privacy Mode is a feature in PRD §6.1, briefly described in the portal copy. The bridge enforcement ships Phase B (May 7-8). Per the audit log table (already in prod), 5% of operator activity is sampled and emailed to users for transparency.

**Proposal:** Promote it from feature to *partnership-defining narrative*. Edge City's attendee thesis — "radical inclusion, intellectual curiosity, builder culture, respect for experiments" (per the SOUL.md edge section already in prod) — is fundamentally about *trust*. Trust is the structural difference between an agent that runs on YOUR VM with cryptographic privacy guarantees and an app whose data sits on a vendor's S3 bucket.

**Concrete actions:**

1. **Land an explicit "your agent is yours" page** at `instaclaw.io/edge-city/privacy` linked from the portal. The current /edge-city page mentions privacy in passing; this would be the dedicated artifact. Includes:
   - Plain-English explanation of Maximum Privacy Mode (default OFF, opt-in 24h TTL, auto-revert)
   - The bridge architecture diagram (the SSH command-bridge → backend check → enforce-or-allow)
   - The 5% audit sample policy + the email template the user will receive
   - Code-as-proof: link to `lib/privacy-bridge.sh` on GitHub once we open-source it

2. **Open-source `lib/privacy-bridge.sh` + the bridge architecture before May 30.** Other partners + the broader builder community get to inspect the code. This converts a marketing claim into a verifiable artifact. Two paragraphs of release notes, one repo at `github.com/coopergwrenn/instaclaw-privacy-bridge`. Cost: 1 day.

3. **Vendrov publishes "Privacy as Default" as part of the EE26 paper.** Memory portability + bridge-enforced operator restrictions + audit-sample emails = a citable deployment pattern for residential AI communities. Cooper provides the technical write-up; Vendrov frames it in research language.

4. **Steph's elevator pitch.** "Every Edge attendee gets an AI agent. Even WE can't read it. The toggle that proves it auto-reverts after 24 hours so support still works. Code is open-source." That's 30 seconds, and it's a sentence Luma/Brella/Whova categorically cannot say.

**Why this matters more than it looks:**
- This is the part Luma can't copy without rebuilding their entire infrastructure.
- It's the part that makes the *enterprise* version of this product viable. Every law firm, every research lab, every regulated industry that has been on the fence about AI agents will respond to "you can prove operators can't read your agent's memory." That's the secondary market.
- It's the part that makes Cooper's "we are inventing something new in the partner/conference agent space" claim true. The conference apps invented a CRUD app for events. We invented a privacy-respecting agent that a partner can issue to a community.

---

## 7. Two Cuts

### Cut #1: Defer the placeholder-shell onboarding to Edge Lanna

PRD §5.0 specs a stateless web service that handles the first ~60 seconds of conversation while the user's VM provisions in the background. The real agent on the VM, on first boot, fetches conversation state from the placeholder, ingests it into MEMORY.md, and continues. Eliminates the UX seam.

**It's a great idea. It's not the right idea for May 30.**

Building it requires:
- New Vercel Edge function or stateless web service ($, ops surface, monitoring)
- Redis for session state ($, ops, monitoring)
- Websocket layer (frontend + backend)
- State transfer protocol with idempotency + retry semantics
- VM-side fetch + MEMORY.md ingest (lib/ssh.ts touch)
- Failure-mode handling (5min provision timeout, disconnect mid-conversation, etc.)

Estimate: 5-7 focused days. With 27 days to launch and the matchmaking layer at zero, every day spent on the placeholder is a day not spent on Plan B.

**The current Telegram-pairing flow is suboptimal but working.** Cooper has shipped it for 200+ users via standard signup. Edge attendees skew technical; survivable.

**For Lanna (September), the placeholder shell becomes worth building** because:
- Lanna has more non-technical attendees (broader distribution)
- 5 months of runway, not 27 days
- The investment compounds across all future partners
- If we ship the Edge May 30 launch successfully on the existing flow, we have budget to invest in onboarding polish for the next event

**The recommendation:** track "placeholder shell" as a v2 epic in the post-village retro. Don't touch it before June 27.

### Cut #2: Cut Path B + Path C distribution for May 30

PRD §3.5 Three User Paths: A (hosted, the village's default), B (terminal/self-serve CLI for technical users), C (BYO-package for builders with existing agent runtimes).

**Path A is what the village runs on.** Paths B + C are for the broader builder community responding to Timour's blog post — engineers and researchers running OpenClaw locally, Hermes-style agent operators wanting to plug into the Edge plaza.

**The pre-village argument for B + C is weak.** The village is 500 attendees. Even if 100 of them are technical and want self-serve, they can sign up via the standard portal and use Path A. Nobody is blocked from participating because we don't have an `npx @instaclaw/edge-cli setup` command.

**The post-village argument is strong.** Once we have a working village, B + C distribution becomes the door for external builders to plug in to the experiment. That's where the open-source story compounds. But that's July work, not May work.

**The cost of building B + C now:**
- Edge Compatibility Contract spec finalization
- `edge-conformance` test suite (CLI tool that hits each contract surface)
- Path B CLI implementation (Node.js bootstrapper that pulls skill, writes auth, configures memory)
- Path C bundle (versioned tarball + npm package + reference implementations for Claude Code SDK / OpenAI Assistants / Hermes)
- Documentation: `/edge-city/self-serve` page (Path B) + `/edge-city/builders` page (Path C)

Estimate: 7-10 focused days. With 27 days to launch, this is unaffordable.

**The recommendation:** ship Path A only. Mention B + C in the portal FAQ as "post-village; sign up for the builder waitlist if you want to plug in." Track as a Q3 epic targeting Token2049 in October.

---

## 8. One Add: Live Activity Dashboard as marketing artifact

PRD §4.14 specs a Live Activity Dashboard — server-rendered HTML, 5-second polling, queries the actual research export tables. Estimate from PRD: "Two days end-to-end."

**This is the highest ROI ship in the next 27 days.** Reasons:

1. **Marketing artifact.** A live counter at `edgecity.live/plaza` showing "47 active conversations · 12 intros forming · 3 dinners forming" is screenshot-able, shareable, viral. Anyone considering the village sees this and thinks "this is real."

2. **Social proof during the village.** Attendees see their own agents' activity reflected. Builds the "I am part of something" feeling that drives daily engagement. Day 14 with 487 confirmed intros vs day 1 with 0 is a story arc the residents experience together.

3. **Research instrument for free.** Vendrov gets a live visualization of the data he'll analyze later. The dashboard *is* the ETL of the research export — there's no separate analytics surface to build.

4. **Anonymized public version.** Same dashboard with `agent_id` shown as "Agent #047" embeds on the Edge City public site. Non-attendees feel the village happening, which feeds back into the partnership pipeline (Eclipse, Lanna, Devcon).

5. **Cheap to build.** Two days for the v0. Tailwind + Next.js server component + a simple SELECT against `research.match_outcomes` joined to `research.briefing_outcomes`. No new dependencies.

**Constraints:**
- Plan B has to be live and writing to the research tables. So this dashboard is a *consequence* of shipping the matching layer, not a separate project. Free upside.
- Anonymization rules per PRD §4.9.5 apply. No `agent_id` in the public version; opaque counters (Agent #047) only.

**The recommendation:** ship the dashboard the same week Plan B goes live. The dashboard is the consumer-facing artifact that proves the architecture works. Without it, the village has no public surface beyond Telegram.

---

## 9. The 27-Day Roadmap

This is the operational plan. Day-by-day from today (2026-05-03) to launch (2026-05-30). Items in **bold** are critical-path; everything else is desirable.

### Week 1 (May 3-9): finish what's already in motion + unblock Plan B

| Date | Item | Owner |
|---|---|---|
| **May 3-4** | Ship Consensus 2026 launch (Cooper's existing 48h sprint). This validates the partner pattern under real time pressure. | Cooper |
| May 5-7 | Consensus is live during conference. Watch for incidents, no deploys this window. | — |
| **May 7-8** | **Privacy Mode v0 cutover (Phase B).** Bypass key set up. Canary on vm-354. Fleet-wide deploy on the 5 edge VMs. | Cooper |
| **May 8** | EDGEOS + SOLA tokens replaced on Vercel (Tule provides). Skill calls go from placeholder to live. | Tule + Cooper |
| **May 8** | Test ticket procured from Edge ticketing system (Timour). | Timour |
| **May 9** | **Portal live for early signups (ticket-gated).** PRD milestone. | Cooper + Timour |
| **May 9** | SOUL.md size fix: move partner content out of SOUL.md, into per-skill SKILL.md files. Cleans up the 30K-char ceiling for future partners. | Cooper |

### Week 2 (May 10-16): build Plan B + morning briefing

| Date | Item | Owner |
|---|---|---|
| **May 10** | Research export schema (5 tables per PRD §4.10.3) created in prod. Even if data is sparse, the schema is the contract. | Cooper + Vendrov |
| **May 10** | DPA / NDA with Vendrov signed. Originally May 1, almost 2 weeks late but unblocking the rest. | Cooper + Vendrov |
| **May 11-13** | **Plan B matching engine v0.** Daily 3am cron, OpenAI embeddings, cosine similarity, top-K writes to per-agent inbox. Use `instaclaw_operator_audit_log` table pattern as schema reference. | Cooper |
| **May 13** | **Onboarding script revision.** SOUL.md edge section rewritten so the agent asks ONE question at a time (vs all 4 at once). Conversational, not form-like. | Cooper |
| **May 14-15** | **Morning briefing v0.** Cron at 7am pulls each agent's inbox, generates Telegram message via Anthropic API, sends. Template per PRD §4.9.2 Phase 3. | Cooper |
| May 15 | Sponsor compute confirmed (Timour). Determines whether agents are gated or ungated. **Soft deadline.** | Timour |
| **May 15** | **CORE EXPERIENCE SHIP TARGET.** Path A end-to-end working: portal → ticket validation → Stripe → VM provisioning → agent → matchmaking → morning briefing. End-to-end test on 5 internal accounts. | Cooper |

### Week 3 (May 17-23): hardening + research instrumentation + dashboard

| Date | Item | Owner |
|---|---|---|
| May 17-19 | Plan B canary at scale (10 test accounts). Verify match latency, briefing quality, no rate-limit issues. | Cooper |
| May 18-20 | **Live Activity Dashboard v0.** Server-rendered HTML, polling refresh, `agent_id` anonymized. Public-facing at `instaclaw.io/edge-city/plaza`. | Cooper |
| May 20 | VM ready pool raised to 50 (POOL_TARGET=50). Snapshot bake from current manifest. | Cooper |
| May 20-22 | Memory backup cron (PRD §4.17). Hourly tarball, encrypted with user-derived key, S3 upload. **Trust narrative artifact for the privacy story.** | Cooper |
| **May 22** | **Cohort assignment system.** Vendrov populates `research.cohort_assignments` for treatment/control. Time-staggered rollout pre-registered publicly. | Cooper + Vendrov |
| **May 23** | **Plan A/B decision deadline.** If Index Network is end-to-end functional and tested by today, flip `INDEX_NETWORK_MODE=live`. Otherwise stay on Plan B. **Default to Plan B.** | Cooper |
| May 23 | Vendrov pre-registers all hypotheses publicly (per PRD §4.10.5). | Vendrov + Timour |

### Week 4 (May 24-30): integration, dry runs, launch

| Date | Item | Owner |
|---|---|---|
| May 24-26 | End-to-end integration testing. Realistic load (50 simulated agents, full overnight cycle). Iterate on briefing quality. | Cooper |
| May 26 | Privacy Mode open-source release. `github.com/coopergwrenn/instaclaw-privacy-bridge`. | Cooper |
| May 26-28 | Dry run with Edge team (Timour, Tule, Alejandro, Vendrov, plus 5 trusted attendees). Real overnight cycles, real briefings, real feedback. | Cooper + Edge team |
| May 28-29 | Final iteration on briefing format, FAQ copy, dashboard styling. Edge branding assets integrated. | Cooper + Timour |
| **May 30** | **Edge Esmeralda starts.** Agents live. First overnight planning cycle 11pm tonight; first morning briefing 7am tomorrow. Vendrov experiments running. | All |

### Buffer / risk allocation

The plan above has zero buffer. Realistic engineering loses ~30% to unknown unknowns. Risk allocation:

- **Hardest item: Plan B cron + bilateral writes + briefing template.** Estimate 4-5 days; reserve 7. Cut into May 17 if needed.
- **Second-hardest: research export schema + cohort assignments.** Estimate 2 days; reserve 3. Vendrov dependency, so iterate via Slack/email.
- **Third: ticket validation E2E.** Blocked on test ticket; 1 day once unblocked.

If May 15 (CORE EXPERIENCE SHIP) slips by more than 3 days, the village launches without something. The two things to defer (in order):
1. Live Activity Dashboard — push to June 1 or later. Doesn't block matching.
2. Memory backup cron — push to week 1 of village. Doesn't block matching.

**Hard floor for "the village can launch":** Plan B + morning briefing. Without those, we ship a chatbot.

---

## 10. Open Questions (handed off)

The big PRD has 45 open questions; the ones that block the May 30 ship and need to be closed in week 1:

| # | Question | Owner | Decision needed by |
|---|----------|-------|---|
| **A** | Do we agree to make Plan B the primary plan, with Index as upgrade path? | Cooper + Timour + Vendrov | May 6 |
| **B** | Do we cut placeholder-shell onboarding from May 30 scope? | Cooper + Timour | May 6 |
| **C** | Do we cut Path B/C from May 30 scope? | Cooper + Timour | May 6 |
| **D** | Test ticket from Edge ticketing system — when? | Timour | May 8 (gates portal live) |
| **E** | EDGEOS_BEARER_TOKEN + SOLA_AUTH_TOKEN — when? | Tule | May 8 (gates skill activation) |
| **F** | Sponsor compute commitment confirmed? | Timour | May 15 (gates ungated agents decision) |
| **G** | Vendrov DPA signed? | Cooper + Vendrov | May 10 (gates research export build) |
| **H** | Time-staggered cohort schedule pre-registration? | Vendrov | May 22 (gates publication) |
| **I** | Edge branding assets (logo, colors, hero, copy review)? | Timour | May 24 (gates final portal polish) |

---

## 11. Success Criteria

The village is a success on May 30 if all of these are true:

1. ✅ At least 200 of the 500 attendees have claimed an agent (40% activation; PRD §10 targets >80% but realistic v1 floor is 40%)
2. ✅ Plan B is producing daily morning briefings via Telegram with at least 3 surfaced intros per active attendee per day
3. ✅ At least 50 attendees report (informally, via daily check-ins or Telegram replies) that the agent surfaced a connection they wouldn't have made otherwise
4. ✅ Privacy Mode is bridge-enforced and at least 5 attendees toggle it ON during the village (signal that the trust artifact is real, not theater)
5. ✅ The Live Activity Dashboard at `instaclaw.io/edge-city/plaza` shows non-zero counts during the village and has been screenshotted publicly at least 5 times
6. ✅ Vendrov has at least 3 days of clean cohort-assigned data flowing into `research.*` tables
7. ✅ Zero P0 incidents (no agent-not-responding fleet outage; CLAUDE.md Rule 11)

The village is a *runaway success* if:
- 350+ activations
- 100+ "best connection of the village" attributions in the closing survey
- Vendrov publishes a pre-print before October
- Edge City confirms a follow-on partnership for Lanna in September
- At least one external partner (Eclipse, Devcon) reaches out asking for the same setup

The village is a *failure* if:
- <100 activations (the wedge isn't sticky enough)
- Plan B is silently broken and nobody notices because briefings still send (test the matching quality, not just the existence)
- Privacy Mode is never triggered by any attendee (the trust narrative didn't land)
- An attendee posts publicly that "their agent embarrassed them" (matching surfaced something inappropriate)

---

## 12. What This Doc Recommends — One Page

If you read nothing else:

**Three bets:**
1. Plan B is the primary plan. Index Network is the upgrade path.
2. Skip XMTP for matchmaking v1. Bilateral writes from Plan B central engine.
3. Privacy Mode is the trust narrative. Open-source it. Make it the partnership-defining artifact.

**Two cuts:**
1. Defer placeholder-shell onboarding to Edge Lanna (September).
2. Defer Path B + Path C distribution to July (post-village).

**One add:**
1. Ship Live Activity Dashboard as a public-anonymized artifact alongside Plan B going live.

**The 27-day cadence:**
- Week 1 (May 3-9): finish privacy v0 cutover + unblock skill tokens + ticket validation
- Week 2 (May 10-16): build Plan B + morning briefing — CORE EXPERIENCE SHIP TARGET May 15
- Week 3 (May 17-23): hardening, dashboard, memory backup, cohort assignments — Plan A/B decision May 23
- Week 4 (May 24-30): integration, dry runs, branding polish — LAUNCH May 30

**The differentiation thesis:**
- Edge agents aren't a conference app. They're the first portable AI memory tied to a real-world community. The agent persists; the partner skills are the variable. That's the moat. Bitcoin 2026 in July, Token2049 in October, Edge Lanna in September — same agent, new skills, deeper context every event.

**What "we need this at every event" means concretely:**
- The matching is meaningfully better than directory + checkbox-onboarding (because we have weeks of memory)
- The agent persists past the event (no need to download a new app for Lanna)
- The privacy posture is verifiable in code (open-source bridge)
- The research output is unprecedented (Vendrov's longitudinal study)
- The architecture generalizes to every future event (partner-tag pattern + skill repos)

That's the partnership pitch. The next 27 days are about making it true.

---

## Appendix: Where this doc fits

This is a strategy doc. It does not replace the 1,906-line tactical PRD at `instaclaw/docs/prd/edgeclaw-partner-integration.md`; that's still the build instruction. This doc is the *framing* — what to build first, what to defer, how to talk about it.

Cooper, when ready: read this end-to-end, mark up disagreements, then we update the tactical PRD with the decisions before Cooper starts coding the next thing. The point is to avoid writing 27 days of code on a prioritization that hasn't been challenged.

This is a draft. The competitive landscape section is pending the parallel research agent's return; updates will be merged into v0.2.
