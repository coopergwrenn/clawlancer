# PRD — Consensus 2026 Agent Skill

**Author:** Cooper Wrenn
**Date:** 2026-05-02
**Status:** Draft → build immediately
**Target ship:** EOD Monday 2026-05-04 (≈48h from PRD lock)
**Event window:** Consensus Miami 2026, Tue 2026-05-05 → Thu 2026-05-07 (MBCC, Miami Beach)

---

## 1. Project Summary

Ship a Consensus 2026 partner skill for InstaClaw, modeled on the existing Edge Esmeralda partner skill. Marketing angle: **"Your personal AI agent for Consensus week."** Each user who tags as `consensus_2026` gets a VM whose agent knows the full 325-session main agenda **and** the 200+ side events, and can answer attendee questions in plain English ("which talks Wed afternoon mention staking?", "what's a good free dinner Tuesday near Brickell?", "find me other AI-infra builders attending").

Strategic role of this build:

- **Dress rehearsal for Edge City Lanna (Sept 2026)** — re-validates the partner-portal/skill-repo/SOUL-section pattern under real time pressure with a real attendee cohort.
- **User-acquisition play** — Consensus draws ~20K crypto-natives. Even 0.5% conversion is 100 InstaClaw signups in three days, with the highest-LTV ICP (crypto founders, VCs, traders) we have.
- **Fast moat test** — proves the "agent that knows your conference" wedge works on a flagship event before we commit to it as a franchise (Bitcoin 2026 Vegas in July, Token2049 Singapore in October).

---

## 2. Data Sources Identified

### 2.1 Main agenda (CoinDesk official)

- **Source:** `https://consensus.coindesk.com/agenda/venue/-{venue-slug}` — 9 venue pages: `mainstage`, `convergence-stage`, `frontier-stage`, `spotlight-stage`, `workshop-stage`, `coindesk-live-studio`, `hackathon`, `deal-flow-zone`, `meetups-area`.
- **Access method:** Server-rendered HTML with three embedded JSON blobs per venue page (`{"data":[{...session...}]}`, one per conference day). Regex-locate `{"data":[{`, walk balanced braces, `JSON.parse`. **No auth, no rate limits, no third-party SaaS** — same custom CMS CoinDesk shipped in 2024 and 2025, multi-year stable.
- **Volume:** ~325 sessions × 3 days × 9 venues. Includes title, datetime ISO-8601, speakers (with company + title), tags (Topics taxonomy with group/slug), tracks, descriptions, and `mdate` (last-modified) for delta sync.
- **Reliability:** Same CMS three years running, no migration risk. `mdate` enables 30-min refresh during conference week with delta-only updates.
- **Failure mode:** CoinDesk swaps CMS the night before (very unlikely). Mitigation: cache last successful pull as fallback.

### 2.2 Side events — primary source: plan.wtf via Google Sheets gviz

- **Source:** `https://plan.wtf/consensus` is a Next.js front end over a public Google Sheet maintained by @sheeetsxyz / @planwtf.
- **Access method (canonical):** Google Sheets gviz JSON endpoint, no auth:
  ```
  GET https://docs.google.com/spreadsheets/d/1xWmIHyEyOmPHfkYuZkucPRlLGWbb9CF6Oqvfl8FUV6k/gviz/tq?tqx=out:json&sheet=Consensus%20Miami%202026
  ```
  Strip the JSONP wrapper, parse, read `data.table.rows[].c[i].v`. Returns ~216 events with: date, start/end time, organizer, event name, address, cost, tags (Panel, Networking, VCs, DeFi, etc.), Luma link, food/bar booleans.
- **Access method (enriched fallback):** plan.wtf's Next.js RSC payload at `https://plan.wtf/consensus.json` (with browser headers) returns geocoded lat/lng + parsed `vibe` + `timeOfDay`. Use only if we ship a map view.
- **Volume:** 216 events confirmed (site advertises 219 — drift is normal as orgs add events).
- **Reliability:** ToS-safe. The sheet is "anyone with link" published; gviz is documented public read. plan.wtf actively encourages reuse.
- **Failure modes:** (a) sheet ID changes pre-event → re-resolve `https://plan.wtf/data` redirect at refresh time; (b) column reorder breaks positional parser → assert col count = 42 and validate `Date(...)` in col 0.

### 2.3 Side events — secondary sources (dedup + coverage)

- **Lu.ma official CoinDesk calendar** — `https://luma.com/ConsensusMiami2026`, ~16 featured events.
- **Lu.ma "Gamma Prime" community calendar** — `https://luma.com/miamisideevents`, ~20+ events.
- **Access method:** `GET https://api.lu.ma/url?url={slug}` resolves slug → `calendar_api_id`, then `GET https://api.lu.ma/calendar/get-items?calendar_api_id={id}&pagination_limit=100`. Unauthenticated, undocumented but production-stable (powers the lu.ma SPA, used by Apify scrapers).
- **Use:** dedup against plan.wtf by Luma URL slug. Anything in lu.ma but not in plan.wtf gets merged in. Skip CryptoNomads (Cloudflare anti-bot, not worth the proxy work for v1).

### 2.4 People matching — punt to v2

- **Index Network:** docs site offline during research, alpha-tier signals (low GH stars, no conference precedent, in-flight auth refactor between SDK and protocol). **Skip for 48h ship.**
- **World ID:** integrable in ~half a day under our existing mini-app id `app_a7c3e2b6b83927251a0db5345bd7146a` via a new "Incognito Action" (`consensus-register`). No app review required. Held for v2 because the bootstrap problem (need ~50 profiles before semantic match is useful) is harder than the integration.
- **48h alternative:** none — the wedge for v1 is schedule + side events. Don't dilute the launch.

---

## 3. Skill Architecture

### 3.1 Pattern: external GitHub repo + 30-min VM-side cron pull

Mirror the Edge Esmeralda pattern exactly (instaclaw/lib/ssh.ts:4034-4056). New external repo:

- **Repo:** `github.com/coopergwrenn/consensus-2026-skill` (private; deploy key reused from existing instaclaw deploy keys).
- **VM clone path:** `$HOME/.openclaw/skills/consensus-2026/`
- **Refresh:** 30-min cron `git pull --ff-only` on every VM tagged `partner: consensus_2026`.
- **GitHub Actions in the repo:** runs every 60 min during 2026-05-04 → 2026-05-08, re-bakes `events.json` and `sessions.json` from sources, commits, pushes. Combined with the VM-side cron, attendees see new events ≤90 min after they're posted to plan.wtf.

### 3.2 Repo layout

```
consensus-2026-skill/
├── SKILL.md                        # Agent-facing instructions + capabilities
├── README.md                       # Human-facing
├── data/
│   ├── sessions.json               # ~325 records, baked from CoinDesk venue pages
│   ├── events.json                 # ~220 records, baked from plan.wtf + lu.ma merge
│   ├── speakers.json               # Derived from sessions.json — speaker → talks index
│   └── venues.json                 # 9 official venues + top side-event venues with addresses
├── scripts/
│   ├── bake-sessions.ts            # CoinDesk scraper
│   ├── bake-events.ts              # plan.wtf gviz + lu.ma merge + dedup
│   └── bake-all.ts                 # Orchestrator called by GH Actions
├── .github/workflows/refresh.yml   # Hourly bake during 5/4–5/8
└── package.json                    # Standalone — only deps: cheerio, node-fetch
```

### 3.3 Skill query interface (what the agent does at runtime)

The agent reads the JSON files directly off disk via OpenClaw's existing tool calls (Read, Grep). No HTTP at query time → zero latency, no proxy.wtf dependency during a chat. SKILL.md instructs the agent on filter patterns:

- `consensus.find_sessions({ day, venue?, tag?, speaker?, query? })`
- `consensus.find_events({ day, free_only?, has_food?, near_address?, vibe?, organizer? })`
- `consensus.session_by_id(id)` / `consensus.event_by_id(id)`
- `consensus.what_now()` — time-aware "what's happening in the next 90 min"
- `consensus.recommend({ interests: [...] })` — keyword overlap against tags + descriptions

These are SKILL.md natural-language patterns, not new tools — the agent uses Read/Grep against the JSON. Keeps the implementation surface tiny.

### 3.4 InstaClaw-side wiring

Files to touch in `wild-west-bots/instaclaw/`:

- `app/api/partner/tag/route.ts:28` — add `"consensus_2026"` to `VALID_PARTNERS`.
- `app/(marketing)/consensus/page.tsx` (new) — clone `app/(marketing)/edge-city/page.tsx`, rebrand, swap copy.
- `app/(marketing)/consensus/consensus-client.tsx` (new) — clone `edge-city-client.tsx`, swap partner slug.
- `lib/ssh.ts` — add a partner-gated install block mirroring 4034-4056 (clone repo, install 30-min cron) and a SOUL.md injection block mirroring 4336-4355 (Consensus event context + onboarding interview prompts).
- `middleware.ts` — confirm `/api/partner/tag` already in `selfAuthAPIs`. (It is — added 2026-04-30 in commit 35e031e9.)

No manifest version bump needed — the install path is partner-gated and applies only when a user tags. Existing fleet is untouched.

### 3.5 SOUL.md injection (what the agent learns about Consensus)

Append-if-marker-absent block to SOUL.md when `partner === "consensus_2026"`. Contents:

- Event window (Tue–Thu, MBCC Miami Beach)
- Brief on the data files and how to use them
- Onboarding interview script: name, what brings you to Consensus, areas of interest (DeFi/AI/infra/L2/staking/etc), days attending, who you want to meet
- Instruction to write answers to `MEMORY.md` for cross-session continuity
- Reminder that side events are the killer feature — recommend them proactively, not just on direct ask

---

## 4. Feature Scope

### Must-have (ship-blockers for Monday EOD)

1. **Main schedule lookup** — agent answers session questions against `sessions.json`.
2. **Side events lookup** — agent answers party/dinner/meetup questions against `events.json`.
3. **Time-aware "what's happening now"** — agent computes "next 90 min" from current ET time.
4. **Filter combinations** — day + venue + tag, day + free + has-food, etc.
5. **Partner portal at `/consensus`** — claim flow that calls `/api/partner/tag` with `{ partner: "consensus_2026" }`, sets cookie, redirects logged-out users through signup.
6. **Skill repo bake pipeline** — bake-sessions + bake-events scripts with GH Actions hourly cron.
7. **VM install path** — clone + cron + SOUL.md injection on next reconcile cycle for tagged users.
8. **Canary test on 1 VM** — full smoke test with real chat completions before pushing to main.

### Nice-to-have (push to v2 if time slips)

- Speaker → talks index lookup (`speakers.json`)
- Map view / geocoded events (requires plan.wtf RSC fallback path)
- Lu.ma dedup merge (v1 can ship plan.wtf-only and add lu.ma overlap in a hotfix)
- Personal itinerary builder ("save this session to my schedule")
- Cross-VM attendee directory (gated on World ID, see v2)
- Push notifications when a saved session starts

### Out of scope for this build (v2 / future)

- World ID people-matching layer (separate ~3-day project)
- Index Network integration
- Live API calls per query
- Multi-conference franchise (Bitcoin 2026, Token2049) — copy this skill once it lands

---

## 5. Marketing Post Strategy

### Where to post

1. **Cooper's X account** — primary launch post. Tag `@CoinDesk`, `@ConsensusEvent`, `@planwtf`, `@sheeetsxyz` (credit + ride engagement). Quote-tweet from `@instaclaw_app`.
2. **Farcaster** — mirror the X post, no edits. Higher conversion in our ICP.
3. **Telegram crypto group DMs** — Cooper sends to 5–10 founder friends attending Consensus. Highest signal.
4. **Reply guy mode** — Cooper replies to every "going to Consensus?" tweet on Sunday/Monday with a one-liner + link.
5. **Optional:** Bankless / Decrypt newsletter pitch via existing Bankr partnership relationships — too slow for Tuesday but plants seeds for Bitcoin 2026.

### Copy angle (one of two A/B options)

**Option A — utility-first, dataset-flex:**
> Your personal AI agent for Consensus 2026.
>
> Knows all 325 sessions across 9 stages.
> Knows all 219 side events from plan.wtf.
> Asks what you care about. Tells you where to be.
>
> Free for the first 100 attendees → instaclaw.io/consensus

**Option B — vibes-first:**
> I made an AI agent that goes to Consensus with you.
>
> Ask it where the free dinner is on Tuesday. Ask it which talks mention zk. Ask it who's at Mainstage right now.
>
> First 100 free → instaclaw.io/consensus

Recommend A. The numbers do the work; "325 sessions, 219 side events" reads as a weekend hack done well, not a product claim.

### Timing

- **Monday 2026-05-04, 7:00 AM ET** — primary X post. Crypto Twitter is most active 7–10am ET on Mondays; gives 24h of organic surface area before Day 1.
- **Monday 6:00 PM ET** — Farcaster mirror.
- **Tuesday 2026-05-05, 8:00 AM ET** — second X post: "Day 1 of Consensus. Here's what my agent says is worth showing up for at 9:30 AM." Live demo screenshot. Drives FOMO from people on the ground.
- **Wednesday + Thursday** — daily morning post with the agent's "today's recommendations" output. Treat each as a proof-of-utility ad.

### Pre-launch checklist

- `/consensus` portal page deployed, claim button works end-to-end (tested unauth + auth)
- One real VM (Cooper's own) tagged + skill installed + agent answers a Consensus question correctly in chat
- 100-credit promo code for first 100 signups (existing Stripe coupon mechanism)
- Screenshots ready: agent answering "what's at 2pm Wed on Mainstage", agent answering "free dinner Tuesday near Brickell"

---

## 6. Build Timeline

Total budget: ~48 hours wall, ~16h focused work. Cooper = sole builder.

| Step | Task | Owner | Est. | Cumulative |
|------|------|-------|------|------------|
| 1 | Create `consensus-2026-skill` GitHub repo, deploy key wired | Cooper | 0.5h | 0.5h |
| 2 | Write `bake-events.ts` (plan.wtf gviz scraper) — copy-paste curl from PRD §2.2, add normalization | Cooper | 1.0h | 1.5h |
| 3 | Write `bake-sessions.ts` (CoinDesk venue scraper) — fetch 9 venues, regex JSON blobs, merge | Cooper | 2.0h | 3.5h |
| 4 | Run bake locally, validate counts (≥215 events, ≥320 sessions), spot-check 5 records | Cooper | 0.5h | 4.0h |
| 5 | Write `SKILL.md` — query patterns, file layout, agent instructions, onboarding tone | Cooper | 1.5h | 5.5h |
| 6 | GH Actions hourly bake workflow + commit pipeline | Cooper | 0.5h | 6.0h |
| 7 | Add `consensus_2026` to `VALID_PARTNERS` (route.ts:28); confirm `/api/partner/tag` allow-listed | Cooper | 0.25h | 6.25h |
| 8 | Build `/consensus` portal page + client component (clone `/edge-city`, rebrand) | Cooper | 2.0h | 8.25h |
| 9 | Add ssh.ts partner-gated install block (clone repo + 30-min cron) | Cooper | 1.0h | 9.25h |
| 10 | Add ssh.ts SOUL.md injection block (Consensus section + onboarding) | Cooper | 0.75h | 10.0h |
| 11 | **Canary test on Cooper's VM**: tag account, force reconcile, verify clone + cron + SOUL section, run real chat completion against 5 representative queries | Cooper | 1.5h | 11.5h |
| 12 | Fix anything the canary surfaces | Cooper | 1.0h | 12.5h |
| 13 | Deploy InstaClaw to production (push to main, Vercel deploy, smoke `/consensus` live) | Cooper | 0.5h | 13.0h |
| 14 | Set up 100-credit promo code in Stripe + verify checkout flow | Cooper | 0.5h | 13.5h |
| 15 | Write launch post (X + Farcaster), prep screenshots | Cooper | 1.0h | 14.5h |
| 16 | Buffer for blockers | — | 1.5h | 16.0h |

**Wall-clock plan:**

- **Sat 5/2 evening:** steps 1–4 (bake pipelines done, data validated)
- **Sun 5/3:** steps 5–10 (skill repo + InstaClaw wiring)
- **Mon 5/4 AM:** steps 11–12 (canary + fixes)
- **Mon 5/4 PM:** steps 13–15 (deploy + launch post live)
- **Tue 5/5 7 AM ET:** primary X post → Day 1 of Consensus

---

## 7. Dependencies and Blockers

### Hard dependencies

- **plan.wtf gviz endpoint stays up.** No SLA, single point of failure. Mitigation: bake locally on day 1 and commit raw JSON to the skill repo as fallback. If gviz dies, attendees still get the day-1 corpus.
- **CoinDesk venue page structure unchanged through 5/7.** Multi-year-stable but not contractual. Mitigation: same — committed JSON fallback.
- **Existing partner-tag flow works.** Verified live as of 2026-04-30 (Timour incident hotfix). No further work needed — just add to VALID_PARTNERS.
- **Existing Edge Esmeralda install pattern in ssh.ts.** Confirmed at lines 4034-4056. Pure copy-paste with substitutions.

### Soft dependencies / nice-to-have

- New 100-credit Stripe coupon (Cooper creates manually in dashboard).
- GitHub Actions runner availability (free tier, no concern at hourly cadence).

### Known blockers

- **None hard-blocking.** The skill is end-to-end buildable with public data and existing patterns.

### Risks (non-blocking)

1. **Snapshot is at v62, manifest may have moved.** New VMs provisioned from snapshot will be one or more manifest versions behind. Reconciler catches up but adds ~5 min lag. Acceptable for the launch window. Per CLAUDE.md Rule 7, do **not** bake a new snapshot just for this — it's a partner-only path; existing fleet stays put.
2. **bootstrapMaxChars ceiling (30,000).** SOUL.md is already 31,905 chars before the Consensus section is added (per CLAUDE.md OpenClaw Upgrade Playbook). The Consensus section must be ≤500 chars OR we must trim something elsewhere. Mitigation: keep the section terse; offload detail into SKILL.md (which is read on-demand, not bootstrapped).
3. **OpenClaw timeout regression.** Per CLAUDE.md Rule 11, every LLM route needs `maxDuration = 300`. We're not adding routes, but the canary chat-completion test will catch a regression if one exists.
4. **Reconciler can't push the SOUL.md addition for already-tagged users.** SOUL.md is `append_if_marker_absent`, so this is the intended mode — the marker is a unique string only this PRD's section uses. Newly-tagged users get it on first configure; pre-tagged users (n=0 today since `consensus_2026` doesn't exist yet) get it on next reconcile.
5. **48h is tight if Cooper hits a SSH/auth wedge.** Buffer is 1.5h. If Sunday slips, drop the lu.ma dedup nice-to-have and ship plan.wtf-only.

---

## 8. Success Metrics

### Primary (the launch is a success if)

- **≥100 partner-tagged signups by EOD Thu 2026-05-07.** Caps the free-VM grant; the metric IS the cap.
- **≥30 of those 100 have ≥3 conversations with their agent** during the conference week. Engagement, not just claim-and-bounce.
- **≥1 organic mention by a Consensus attendee on X or Farcaster** (not us, not us reposting). Proof of distribution outside our owned channels.

### Secondary

- **Median time-to-first-meaningful-message** under 10 min from claim → first chat. Validates the partner-tagging + reconciler path under real load.
- **Zero P0 incidents during 5/5–5/7.** No agent-not-responding crisis (CLAUDE.md Rule 11), no SSH bridge failure. Conference week is a watch-and-don't-deploy window.
- **plan.wtf source still resolving at end of Wed.** If it goes down and we have no fallback, that's a learning we bake into v2.

### Tracking

- New-user analytics already report `partner` field — filter `partner = consensus_2026` for cohort.
- Conversation count: existing `instaclaw_session_logs` table, group by user × date.
- Organic mentions: manual — Cooper sets a Tweetdeck column for `instaclaw consensus`.
- Time-to-first-message: query `instaclaw_users.created_at` vs. first row in session logs.

### What "great" looks like

- 250+ signups (overshoot the cap; raise the cap mid-week if approve rate stays healthy)
- A repost from `@CoinDesk` or a top crypto journalist
- One post-Consensus inbound from another conference asking us to do the same for theirs

### What "this didn't work" looks like

- <30 signups by EOD Tue
- Crickets on the launch tweet (no replies, no quote tweets)
- Agent answering main-schedule questions wrong because the bake parser broke and nobody noticed

If we hit the bottom case, the post-mortem question is **not** "should we have built this?" but "did the wedge fail or did the marketing fail?" — and the next conference (Bitcoin 2026 in Vegas, ~9 weeks later) is the rerun with a fixed variable.

---

## 9. Post-Consensus Follow-Through

Out of scope for the 48h build; recorded here so it doesn't get lost.

- **Scheduled cleanup agent (per /schedule pattern):** in 2 weeks (2026-05-19), open a PR to (a) freeze the GH Actions hourly bake, (b) commit a final post-conference snapshot of the data, (c) decide whether to keep the `/consensus` portal page up as evergreen or 410 it.
- **Franchise decision (2026-05-12):** Bitcoin 2026 (Las Vegas, July 28–30) and Token2049 Singapore (October) use the same lu.ma + custom-CMS pattern per side-event research. If Consensus signups clear 100, fork the skill repo for both within 2 weeks of Consensus close.
- **People-matching v2 (2026-05-15 → 2026-05-29):** revisit World ID + pgvector for Bitcoin 2026 launch. The bootstrap problem (need ~50 profiles before queries are useful) is the actual hard part, not the integration.

---

## Appendix A — Reference Files in InstaClaw Repo

When building, read these in full first:

1. `instaclaw/app/api/partner/tag/route.ts` — partner tagging logic + VALID_PARTNERS
2. `instaclaw/lib/ssh.ts` lines 4034-4056 (clone block) and 4336-4355 (SOUL.md injection block) — install pattern to mirror
3. `instaclaw/app/(marketing)/edge-city/page.tsx` — portal page template
4. `instaclaw/app/(marketing)/edge-city/edge-city-client.tsx` — claim-button component
5. `CLAUDE.md` Rules 7, 9, 11 + the OpenClaw Upgrade Playbook section — manifest, partner, timeout, bootstrapMaxChars constraints

## Appendix B — Sample Records (real)

**Session (CoinDesk, Frontier Stage, Tue 9:45 AM ET):**
```json
{
  "id": "11F118C9079E3AEF98D30263DE4AB8DB",
  "title": "Advanced Staking: The Internet Bond as a Benchmark",
  "start_datetime": "2026-05-05T09:45:00-04:00",
  "end_datetime": "2026-05-05T10:15:00-04:00",
  "venue_full_name": "MBCC: Frontier Stage",
  "agenda_track_ref": [{"name": "Capital Markets Summit"}],
  "agenda_tag_ref": [{"group": "Topics", "title": "Staking", "slug": "staking"}],
  "agenda_speaker_ref": [{"ref": "Lucas Bruder", "company": "Jito Labs", "jobtitle": "Co-Founder & CEO"}]
}
```

**Side event (plan.wtf, gviz row 0, Sat 5:00 PM):**
```json
{
  "date": "2026-05-02",
  "start_time": "5:00p",
  "end_time": "7:00p",
  "organizer": "ABFinance Events",
  "name": "From Exchange to the Future of Finance — A Private Fireside",
  "address": "2134 W 18th St Chicago, IL 60608, USA",
  "cost": "Free",
  "tags": ["Panel/Talk", "Networking", "VCs/Angels", "DeFi"],
  "link": "https://luma.com/djm6xtnp",
  "has_food": false,
  "has_bar": false
}
```
