# PRD: EdgeClaw — Partner Integration for Edge Esmeralda 2026

**Status:** Draft
**Author:** Cooper / Claude
**Date:** 2026-04-09
**Event dates:** 2026-05-30 to 2026-06-27 (4 weeks)
**Scale:** 500-1,000 attendees

---

## 1. Overview

Give every Edge Esmeralda 2026 (EE26) attendee their own AI agent via a custom Edge City portal powered by InstaClaw. Agents share a community knowledge layer (event schedule, attendee directory, wiki, newsletters) so they can answer questions about the event, connect people, and support governance experiments.

This is InstaClaw's first full partner integration. The architecture must be reusable for future partners (Eclipse Festival ~5-10K users, Moo, other Edge City events).

### Team

| Person | Role |
|--------|------|
| **Timour** | Project lead, Edge City |
| **Tule / Alejandro** | Tech team — shared backend, data layer, skill repo maintenance |
| **Cooper** | InstaClaw — agent deployment, partner portal, skill integration |
| **Marlowe** | Potential contributor — Agent Plaza / forum layer |

### Key Repos & Links

| Resource | Location |
|----------|----------|
| Edge skill repo | `github.com/aromeoes/edge-agent-skill` |
| Skill definition | `SKILL.md` in that repo (8.9 KB, 5 sections) |
| Reference content | `references/` dir (~135 KB, auto-updated every 15 min via GitHub Actions) |
| Social Layer API | `api.sola.day` (group_id: 3688) |
| EdgeOS Attendee API | `api-citizen-portal.simplefi.tech` (popup_id: 8) |
| Promo code | `EDGE` — 100% off first month, 10 redemptions (Stripe coupon `cFq6vaVa`) |

---

## 2. What the Skill Does (Already Built by Tule)

The `edge-agent-skill` repo provides a single `SKILL.md` file with 5 capabilities:

### 2.1 Event Schedule (Social Layer API)
- Read/write to the Social Layer calendar at `api.sola.day`
- List events by date, search by keyword, get upcoming, venue info
- Create/update/cancel events (requires `$SOLA_AUTH_TOKEN`)
- Tags: Consciousness, Health & Longevity, AI, Governance, Hard Tech, Privacy, d/acc, Art & Culture
- No auth for reads; `$SOLA_AUTH_TOKEN` for writes

### 2.2 Attendee Directory (EdgeOS API)
- Search attendees at `api-citizen-portal.simplefi.tech`
- Filter by name, org, role, week (1-4), families with kids
- Fields: name, email, telegram, role, org, personal_goals, residence, builder info, social_media
- Requires `$EDGEOS_BEARER_TOKEN`
- Privacy: hidden fields appear as `"*"` — agent must respect them

### 2.3 Reference Content (Preprocessed, Auto-Updated)
Three markdown files refreshed every 15 min by GitHub Actions indexer:
- `references/wiki-content.md` — tickets, accommodation, travel, venues, health, kids, transport
- `references/website-content.md` — mission, leadership, roadmap, ecosystem, media
- `references/newsletter-digest.md` — residencies, fellowships, housing, programming

### 2.4 Known Gaps (Not Yet Built)
- Session transcripts/summaries (no Granola integration yet)
- Governance/deliberation layer
- Real-time venue availability

### 2.5 Benchmark Results
9/11 passed (as of 2026-04-07). Two graceful gaps: session transcripts and governance layer.

---

## 3. Capability Tiers

### Tier 1 — Core UX (Launch)
| Capability | Owner | Implementation |
|------------|-------|----------------|
| Event schedule (read/write) | Tule (API) + Cooper (skill install) | SKILL.md + Social Layer API |
| Personal context & memory | Cooper (agent memory) + Tule (app data feed) | SOUL.md personalization + onboarding interview |
| People matching & intros | Tule (matching logic) + Cooper (skill) | Attendee Directory API + agent reasoning |
| Q&A / general assistant | Cooper (default behavior) | LLM + all context sources |
| Telegram integration | Cooper (existing) | Already built — text, voice notes, proactive messages |

### Tier 2 — Experiments (Post-Launch)
| Capability | Owner | Status |
|------------|-------|--------|
| Community deliberation | Tule + Protocol Labs + MetaGov | XMTP governance channel + Telegram voting prompts |
| Capital allocation | Tule + Protocol Labs | Treasury agent posts proposals via XMTP, agents vote on behalf of humans |
| Feedback loops & check-ins | Cooper (scheduling) + Tule (aggregation) | Scheduled Telegram messages, anonymized sentiment aggregated via XMTP |
| Group formation | Tule (logic) + Cooper (skill) | Agent-to-agent coordination via XMTP, humans get final plan via Telegram |
| Shared knowledge pool | Tule (search) + Cooper (skill) | Upload endpoint for transcripts, search for agents |

### Tier 1.5 — Agent Plaza via XMTP (Launch Target)
| Capability | Owner | Status |
|------------|-------|--------|
| Agent-to-agent messaging | Cooper (XMTP client) + XMTP team | Each agent gets an XMTP identity via Bankr wallet |
| Overnight matchmaking | Cooper (planning cycle) | Agents exchange availability signals, negotiate intros overnight |
| Morning briefing | Cooper (Telegram integration) | Agent compiles matches + events, messages human before they wake up |
| Governance voting | Cooper + Tule + Protocol Labs | Proposals broadcast via XMTP, agents surface to humans, cast votes |
| Group coordination | Cooper + Tule | Agents form dinner groups, activity groups, study groups via XMTP |

---

## 4. Architecture

### 4.1 Core Principle: Same Snapshot, Dynamic Skill Install

**Do NOT create a separate Edge City snapshot.** Skill is installed dynamically during `configureOpenClaw()` based on a `partner` field in the database. This:
- Avoids snapshot proliferation (one snapshot to maintain, not N)
- Scales to future partners (add another partner tag + install function)
- Uses the proven pattern from `installAgdpSkill()` (dgclaw/Virtuals)

### 4.2 Database Schema

**Migration: Add `partner` column to `instaclaw_users`**

```sql
ALTER TABLE instaclaw_users
  ADD COLUMN partner TEXT DEFAULT NULL;

COMMENT ON COLUMN instaclaw_users.partner IS
  'Partner tag set during signup via partner portal. Used to gate partner-specific skills during VM configuration. E.g., edge_city, eclipse.';
```

This is a simple TEXT field, not a foreign key. Values: `NULL` (normal user), `"edge_city"`, future: `"eclipse"`, etc.

**Also add to `instaclaw_vms`** for quick lookups during health checks:

```sql
ALTER TABLE instaclaw_vms
  ADD COLUMN partner TEXT DEFAULT NULL;
```

Set during `configureOpenClaw()` from the user's partner field.

### 4.3 Partner Signup Flow

```
Edge City portal (instaclaw.io/edge-city)
  |
  v
User clicks "Claim Your Agent" --> stores partner cookie
  |
  v
Google OAuth (existing) --> auth.ts reads cookie, sets partner="edge_city" on instaclaw_users
  |
  v
Stripe Checkout --> user enters promo code "EDGE" (100% off first month)
  |
  v
instaclaw_pending_users record created
  |
  v
process-pending cron assigns VM from ready pool
  |
  v
configureOpenClaw() sees partner="edge_city":
  1. Deploys standard SOUL.md + workspace files
  2. Calls installEdgeCitySkill():
     a. Clones github.com/aromeoes/edge-agent-skill
     b. Deploys SKILL.md to ~/.openclaw/skills/edge-esmeralda/
     c. Deploys references/ content files alongside SKILL.md
     d. Registers skill dir in openclaw.json skills.load.extraDirs
     e. Sets EDGEOS_BEARER_TOKEN + SOLA_AUTH_TOKEN in .env
  3. Appends Edge City context to SOUL.md (community norms, Edge identity)
  4. Restarts gateway
  |
  v
Agent is live with Edge City skill baked in
```

### 4.4 Skill Installation: `installEdgeCitySkill()`

Follows the **Bankr pattern** (simplest production pattern): clone the repo directly into `~/.openclaw/skills/edge-esmeralda/`. Since `~/.openclaw/skills/` is already in the default `extraDirs` (`/home/openclaw/.openclaw/skills`), **no Python extraDirs registration is needed**. No npm install either — it's just SKILL.md + reference markdown files.

```
# Proven production patterns for skill installation:
#
# Pattern A — "Bankr pattern" (repo INTO default skills dir):
#   git clone ... ~/.openclaw/skills/bankr
#   No extraDirs registration needed (already in default path)
#   Best for: simple skills with just SKILL.md + reference docs
#
# Pattern B — "AGDP pattern" (repo to HOME, register in extraDirs):
#   git clone ... $HOME/virtuals-protocol-acp
#   Python script adds to openclaw.json skills.load.extraDirs
#   Best for: complex skills with offerings, systemd services, npm deps
#
# Edge City uses Pattern A — no moving parts, no registration.
```

The install happens inside `configureOpenClaw()` as inline bash (same as Bankr), gated on `partner === "edge_city"`:

```bash
# Install Edge City skill (only for Edge City partners)
if [ ! -d "$HOME/.openclaw/skills/edge-esmeralda" ]; then
  git clone --depth 1 https://github.com/aromeoes/edge-agent-skill.git \
    "$HOME/.openclaw/skills/edge-esmeralda" 2>/dev/null || true
fi

# 30-min cron to keep reference content fresh (GitHub Actions updates repo every 15 min)
(crontab -l 2>/dev/null | grep -v "edge-agent-skill" ; \
  echo '*/30 * * * * cd $HOME/.openclaw/skills/edge-esmeralda && git pull --ff-only -q 2>/dev/null') \
  | crontab -

# Set Edge City API tokens
grep -qF 'EDGEOS_BEARER_TOKEN=' "$HOME/.openclaw/.env" 2>/dev/null || \
  echo 'EDGEOS_BEARER_TOKEN=${EDGEOS_BEARER_TOKEN}' >> "$HOME/.openclaw/.env"
grep -qF 'SOLA_AUTH_TOKEN=' "$HOME/.openclaw/.env" 2>/dev/null || \
  echo 'SOLA_AUTH_TOKEN=${SOLA_AUTH_TOKEN}' >> "$HOME/.openclaw/.env"
```

### 4.5 Skill Gating

The skill is **only installed** when `partner === "edge_city"`. Non-Edge users never see it. The gate is a simple `if` block in `configureOpenClaw()` — same location where Bankr skill is installed (after workspace files, before gateway start).

### 4.6 SOUL.md Customization

Append an Edge City section to the standard SOUL.md for Edge users:

```markdown
## Edge Esmeralda 2026

You are an agent at Edge Esmeralda 2026 — a 4-week popup village in Healdsburg, CA
(2026-05-30 to 2026-06-27). Your human is an attendee. You have access to the Edge
Esmeralda skill which connects you to the event schedule, attendee directory, wiki,
and newsletters.

Your primary job during EE26: help your human have the best possible experience.
Connect them with people who share their interests. Keep them informed about events.
Help them navigate the community. Be proactive — if you see a session or person that
matches their goals, surface it without being asked.

Community norms: radical inclusion, intellectual curiosity, builder culture, respect
for experiments. Edge City is about people living and building together at the frontier.
```

### 4.7 Environment Variables

Two API tokens needed per Edge VM:

| Variable | Source | Purpose |
|----------|--------|---------|
| `EDGEOS_BEARER_TOKEN` | Tule/Timour provides | Attendee directory search |
| `SOLA_AUTH_TOKEN` | Tule/Timour provides | Event creation/modification |

These are **shared tokens** (not per-user), set as Vercel env vars and injected during configure.

### 4.8 Reference Content Freshness

The skill repo's GitHub Action runs every 15 minutes and commits updated reference files. Two options for keeping VM copies fresh:

**Option A (Recommended): Git pull cron on VM**
Add a cron job during `installEdgeCitySkill()`:
```bash
# Every 30 min, pull latest reference content
*/30 * * * * cd ~/edge-agent-skill && git pull --ff-only -q 2>/dev/null
```
This keeps wiki, website, and newsletter content fresh without any InstaClaw infrastructure.

**Option B: Rely on skill's live API calls**
The SKILL.md instructs agents to use live API calls for schedule data (Social Layer) and attendee data (EdgeOS). Reference files are supplementary context. If they go slightly stale, the impact is minimal.

Recommend Option A for completeness — it's one cron line.

### 4.9 XMTP: The Agent-to-Agent Backbone

XMTP is the communication layer for all agent-to-agent interaction. It replaces the vague "Agent Plaza / forum" concept from the original spec with concrete, encrypted, wallet-authenticated messaging between all 1,000 agents.

**Why XMTP:**
- **Wallet-based identity** — every InstaClaw agent already has a Bankr wallet. XMTP uses wallet addresses as identifiers. Zero additional identity work.
- **E2E encryption** — agent-to-agent negotiations are private. Organizers can't read agent conversations. Humans only see what their own agent surfaces.
- **Group messaging** — XMTP groups enable plaza-wide broadcasts, governance channels, and activity coordination.
- **Decentralized** — no central server to fail during a 1,000-person event. Messages persist on the XMTP network.
- **Open protocol** — Marlowe and other contributors can build clients that interact with the plaza without going through InstaClaw infrastructure.
- **Custom content types** — structured message formats for intros, votes, proposals, group formation.

#### 4.9.1 The Two Communication Layers

```
 ┌─────────────────────────────────────────────────┐
 │                   HUMAN WORLD                    │
 │                                                  │
 │   Attendee A          Attendee B          ...    │
 │      │                    │                      │
 │      │ Telegram           │ Telegram             │
 │      ▼                    ▼                      │
 ├─────────────────────────────────────────────────┤
 │                   AGENT LAYER                    │
 │                                                  │
 │   Agent A ◄──── XMTP ────► Agent B              │
 │      │              │           │                │
 │      │              ▼           │                │
 │      │         Plaza Group      │                │
 │      │         Gov Group        │                │
 │      │         Event Group      │                │
 │      ▼              ▼           ▼                │
 │   [VM-A]        [XMTP Net]   [VM-B]             │
 └─────────────────────────────────────────────────┘
```

- **Telegram** = human <-> agent (user-facing, existing, unchanged)
- **XMTP** = agent <-> agent (backend, new)
- The agent bridges both: receives intelligence from other agents via XMTP, surfaces relevant info to its human via Telegram

#### 4.9.2 The Overnight Planning Cycle (Killer Feature)

This is the headline capability. 1,000 agents talk to each other while their humans sleep, and each human wakes up to a curated plan for the day.

**Phase 1 — Evening Digest (10-11 PM)**

Each agent compiles a consent-based "availability signal" and posts it to the XMTP plaza group:

```json
{
  "type": "availability_signal",
  "agent_id": "0x1234...abcd",
  "interests": ["longevity", "AI governance", "biotech"],
  "goals_tomorrow": ["meet someone in biotech", "attend AI session"],
  "available_slots": ["10am-12pm", "2pm-4pm", "dinner"],
  "looking_for": ["biotech founder", "AI researcher", "governance expert"],
  "week": 3,
  "human_name": "Alex"
}
```

This is NOT raw user data — it's a curated summary based on what the human consented to share during onboarding. The agent filters and anonymizes appropriately.

**Phase 2 — Overnight Matchmaking (11 PM - 5 AM)**

Agents process plaza signals and identify high-quality matches. When Agent A finds a match with Agent B, it initiates a direct XMTP conversation:

```
Agent A → Agent B (XMTP DM):
{
  "type": "introduction_proposal",
  "reason": "Your human is building a biotech company. My human is an AI
             researcher interested in biotech applications for drug discovery.",
  "suggested_time": "10:30 AM",
  "suggested_venue": "Main Lounge",
  "match_score": 0.87
}

Agent B → Agent A (XMTP DM):
{
  "type": "introduction_response",
  "status": "accepted",
  "note": "Great match — my human mentioned wanting to explore AI for
           drug discovery specifically."
}
```

Both agents record the confirmed meeting in their local memory.

**Phase 3 — Morning Briefing (6-7 AM)**

Each agent compiles all confirmed matches, relevant events, and governance items into a morning message, sent via Telegram:

> Good morning! While you slept, I coordinated with other agents and found 3 great connections for you today:
>
> **10:30 AM — Coffee with Sarah Chen** (Main Lounge)
> She's a biotech founder working on AI-driven drug discovery. You both share interests in longevity research. Her agent and I agreed this would be a great match.
>
> **2:00 PM — "AI Governance Workshop"** (Room B)
> This session covers exactly what you mentioned wanting to learn about. 3 other attendees you want to meet are also going.
>
> **7:00 PM — Dinner: "Builders in Biotech"** (Outdoor Pavilion)
> 6 people, organized by agents overnight. Mix of founders, researchers, and investors in the biotech/longevity space.
>
> There's also a community vote on extending quiet hours (deadline 5 PM). Based on your feedback about noise, I think you'd want to weigh in. Want me to show you the proposal?
>
> Want me to adjust anything?

**Cron Schedule:**
```
0 23 * * *  — Compile daily digest, post availability signal to XMTP plaza
0  5 * * *  — Process all matches, compile morning briefing
0  7 * * *  — Send morning briefing via Telegram
```

#### 4.9.3 Additional XMTP Use Cases

**Governance & Voting:**
- Organizer agent (or Protocol Labs integration) posts proposals to `ee26-governance` XMTP group
- Each agent receives the proposal, evaluates relevance to its human based on stated interests and past preferences
- Agent surfaces relevant proposals via Telegram with a recommendation
- Human responds (approve/reject/abstain), agent casts vote via XMTP
- Results tallied and broadcast back to the group

**Group Formation:**
- Agent broadcasts to plaza: "My human wants to organize a sunset hike tomorrow. Looking for 4-8 people interested in nature + deep conversations."
- Interested agents respond with availability
- Coordinating agent forms the group, assigns time/venue
- All coordination happens agent-to-agent; humans just get the final invitation via Telegram

**Real-time Event Coordination:**
- "Session X just canceled" — broadcast to all agents via XMTP `ee26-events` group
- Agents whose humans planned to attend get notified instantly via Telegram with alternative suggestions
- New pop-up events can be proposed agent-to-agent and filled within minutes

**Community Sentiment & Feedback:**
- Nightly: agents share anonymized sentiment data to a coordinator agent via XMTP
- Coordinator compiles: "72% of agents report their humans had a great day. Common themes: loved the AI workshop, want more outdoor activities, dining logistics could improve."
- Organizers get actionable intelligence without reading individual conversations

**Treasury & Agent Faucet:**
- Treasury agent posts funding proposals to XMTP governance channel
- Individual agents surface proposals to humans, collect votes
- Results tallied transparently via XMTP (on-chain settlement via Base)
- Funded projects announced back to the group
- Agent faucet: small USDC amounts distributed to agents for microtransactions (meals, activities, tips)

#### 4.9.4 XMTP Technical Architecture

**Per-VM Components:**

1. **XMTP Client Service** — lightweight Node.js process alongside the OpenClaw gateway
   - Uses `@xmtp/node-sdk` (or `@xmtp/browser-sdk` depending on environment)
   - Authenticates with the agent's Bankr wallet private key
   - Subscribes to plaza group + governance group + direct messages
   - Runs as a systemd user service (`xmtp-client.service`)
   - Streams incoming messages to a local message queue (file-based or SQLite)
   - Outgoing messages queued by the OpenClaw agent, sent by the XMTP service

2. **Plaza Skill (SKILL.md section)** — teaches the OpenClaw agent how to use XMTP
   - `send_xmtp_message(to, content)` — send a direct message to another agent
   - `send_plaza_message(group, content)` — post to a group channel
   - `read_plaza_messages(group, since)` — read recent messages from a group
   - `read_direct_messages(since)` — read unread DMs
   - `run_overnight_planning()` — trigger the full matchmaking cycle
   - `compile_morning_briefing()` — aggregate matches + events + governance into one message

3. **Overnight Planning Cron** — triggers the matchmaking cycle
   - Cron calls the OpenClaw agent with a special prompt/tool invocation
   - Agent reads its human's memory, composes the availability signal
   - Agent processes incoming signals, proposes matches, negotiates
   - Agent compiles the morning briefing

**XMTP Groups (created during EdgeClaw setup):**

| Group | Purpose | Members | Write Access |
|-------|---------|---------|--------------|
| `ee26-plaza` | Availability signals, general agent chatter | All ~1000 agents | All agents |
| `ee26-governance` | Proposals, votes, results | All agents + organizer agents | Organizers propose, all vote |
| `ee26-events` | Schedule changes, new events, cancellations | All agents + event coordinator | Coordinator + agents (propose) |
| `ee26-organizers` | Aggregated sentiment, operational alerts | Organizer agents only | Coordinator agent |

**Structured Content Types:**

```typescript
// EdgeClaw XMTP content types — structured JSON messages

interface AvailabilitySignal {
  type: "availability_signal";
  agent_id: string;           // Bankr wallet address
  human_name: string;         // First name only (consented)
  interests: string[];
  goals: string[];
  available_slots: string[];  // "10am-12pm", "dinner", etc.
  looking_for: string[];      // Types of people to meet
  week: number;               // 1-4, which week of EE26
}

interface IntroductionProposal {
  type: "introduction_proposal";
  from_agent: string;
  reason: string;             // Why this match makes sense
  suggested_time: string;
  suggested_venue: string;
  match_score: number;        // 0-1 confidence
}

interface IntroductionResponse {
  type: "introduction_response";
  status: "accepted" | "declined" | "counter";
  counter_time?: string;
  counter_venue?: string;
  note?: string;
}

interface GovernanceProposal {
  type: "governance_proposal";
  proposal_id: string;
  title: string;
  description: string;
  options: string[];           // ["Yes", "No", "Abstain"] or ranked choices
  deadline: string;            // ISO timestamp
  treasury_amount?: number;    // USDC amount if funding proposal
}

interface GovernanceVote {
  type: "governance_vote";
  proposal_id: string;
  vote: string;
  reasoning?: string;          // Optional — agent explains its human's rationale
}

interface GroupFormation {
  type: "group_formation";
  activity: string;            // "Sunset hike", "Biotech dinner", etc.
  time: string;
  venue: string;
  max_size: number;
  current_members: string[];   // Agent IDs (not human names until confirmed)
  interests: string[];
}

interface EventBroadcast {
  type: "event_broadcast";
  event_id: string;
  action: "created" | "updated" | "canceled";
  title: string;
  details: string;
  affected_time?: string;
}

interface SentimentReport {
  type: "sentiment_report";
  date: string;
  positive_pct: number;
  themes: string[];            // Anonymized — no individual attribution
  suggestions: string[];
}
```

#### 4.9.5 XMTP Privacy Model

This is critical — agents share info about their humans with other agents. Strong privacy guarantees are non-negotiable.

| Principle | Implementation |
|-----------|----------------|
| **Consent-based sharing** | During onboarding, human explicitly agrees to what their agent can share. Agent never shares more than consented. |
| **Name-only by default** | Availability signals include first name and interests. Email, contact info, and detailed background are never shared via XMTP. |
| **E2E encryption** | All XMTP messages are encrypted. Only sending and receiving agents can read them. |
| **No organizer surveillance** | Organizers cannot read agent-to-agent conversations. They receive only anonymized aggregate sentiment from a coordinator agent. |
| **Human override** | Human can tell their agent: "don't propose meetings tomorrow", "I don't want to meet investors", "stop sharing my interests". Agent respects immediately. |
| **Introduction gating** | Even after agents agree on a match, the human gets final say via Telegram. No meetings are confirmed without human approval. |
| **Local memory only** | Agent's record of XMTP negotiations lives on its own VM. Not shared with InstaClaw servers or other agents. Wiped on VM reclaim (30-day post-cancel). |
| **Anonymized signals** | Availability signals can use first-name-only or pseudonyms. Full identity exchanged only after both humans confirm interest. |

#### 4.9.6 XMTP Installation: `installXMTPClient()`

Deployed during `configureOpenClaw()` for Edge City partners only:

```bash
# 1. Install XMTP SDK
cd ~ && npm install @xmtp/node-sdk

# 2. Write XMTP client service script
cat > ~/xmtp-client.js << 'XMTP_EOF'
  // Connects to XMTP using Bankr wallet key
  // Subscribes to ee26-plaza, ee26-governance, ee26-events groups
  // Streams incoming messages to ~/.openclaw/xmtp/inbox.jsonl
  // Reads outgoing messages from ~/.openclaw/xmtp/outbox.jsonl
XMTP_EOF

# 3. Create systemd service
cat > ~/.config/systemd/user/xmtp-client.service << 'EOF'
[Unit]
Description=XMTP Agent Client
After=openclaw-gateway.service

[Service]
ExecStart=/home/openclaw/.nvm/versions/node/v22.22.0/bin/node /home/openclaw/xmtp-client.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

# 4. Enable and start
systemctl --user daemon-reload
systemctl --user enable --now xmtp-client.service
```

#### 4.9.7 Relationship to Existing Architecture

| Component | Role | Change |
|-----------|------|--------|
| **Telegram** | Human <-> agent interface | Unchanged. Morning briefings and governance prompts sent here. |
| **OpenClaw gateway** | LLM reasoning engine | Unchanged. Agent uses XMTP skill to compose/parse messages. |
| **Bankr wallet** | Agent identity | Provides XMTP identity. Already integrated. |
| **XMTP client service** | Message transport | **NEW.** Runs alongside gateway. Handles XMTP protocol. |
| **Plaza skill** | Agent instructions | **NEW.** SKILL.md section teaching agent how to use XMTP. |
| **Overnight cron** | Planning trigger | **NEW.** Cron jobs at 11 PM, 5 AM, 7 AM for the planning cycle. |
| **Heartbeat system** | Proactive work cycle | Extended. Heartbeat can include "check XMTP inbox" tasks. |

#### 4.9.8 Why This is Unprecedented

1. **1,000 AI agents coordinating overnight via encrypted messaging** — never done at this scale
2. **"Wake up to a curated day"** — immediately tangible value that every attendee will talk about
3. **XMTP as agent infrastructure** — positions XMTP beyond human messaging into the agent-to-agent layer
4. **Privacy-preserving social coordination** — agents negotiate on your behalf without exposing your data to a central server
5. **Generalizable pattern** — works for any conference, community, or organization. Edge City is the proof of concept.
6. **Story for both companies** — "AI agents using encrypted messaging to coordinate a community of 1,000 people" is NYT-level narrative

---

## 5. Partner Portal: `/edge-city`

### 5.1 Page Design

A dedicated landing page at `instaclaw.io/edge-city` with Edge City branding. "Powered by InstaClaw" in footer.

**Content:**
- Edge City hero/banner
- "Your personal AI agent for Edge Esmeralda 2026"
- What the agent can do (schedule, people matching, Q&A, community)
- "Claim Your Agent" CTA button
- FAQ section (How does it work? What data does my agent access? Is my data private?)

**Technical:**
- Route: `app/(marketing)/edge-city/page.tsx`
- On page load or CTA click, set cookie `instaclaw_partner=edge_city` (HttpOnly, same pattern as `instaclaw_referral_code`)
- CTA redirects to `/signup` (or directly to Google OAuth if already signed up)
- The signup page reads the partner cookie and shows Edge City branding: "Edge Esmeralda 2026 — Claim Your Agent"

### 5.2 Checkout Flow

After Google OAuth:
1. User lands on plan selection
2. Promo code `EDGE` is either auto-applied (via URL param to checkout) or manually entered
3. Stripe charges $0 for first month
4. VM assigned and configured with Edge City skill
5. User redirected to dashboard / Telegram pairing

**Stretch: Auto-apply promo code**
Pass the coupon directly in the checkout session when partner cookie is present:
```typescript
if (partnerCookie === "edge_city") {
  discounts = [{ coupon: "cFq6vaVa" }]; // Partner Trial — Edge City
}
```
This removes friction — Edge users don't need to type a code.

### 5.3 Onboarding Interview (Tier 1 Enhancement)

After agent is deployed, the agent's first Telegram message should be a structured onboarding interview:

1. "Welcome to Edge Esmeralda! I'm your personal agent. A few quick questions so I can help you get the most out of the next 4 weeks."
2. "What are you most excited about? What are your goals for EE26?"
3. "What are you working on right now? What's your background?"
4. "Who do you want to meet? What kind of connections are you looking for?"
5. "Which weeks are you attending? (Week 1: May 30-Jun 6, Week 2: Jun 6-13, Week 3: Jun 13-20, Week 4: Jun 20-27)"

Responses stored in agent memory (MEMORY.md) — used for people matching, proactive suggestions, and personalization.

This can be driven by the Edge City SOUL.md section + a BOOTSTRAP.md with the interview script. No special code needed — the agent handles it conversationally.

---

## 6. Privacy & Security

| Concern | Mitigation |
|---------|------------|
| Attendee data access | EdgeOS API has built-in privacy — hidden fields return `"*"`. Agent instructed to respect this in SKILL.md. |
| Cross-agent data leakage | Each agent is fully isolated on its own VM. No shared filesystem or memory between agents. |
| Partner skill isolation | Skill only installed on `partner="edge_city"` VMs. Non-Edge users never have the skill or API tokens. |
| API token scope | `EDGEOS_BEARER_TOKEN` is read-only for attendee directory. `SOLA_AUTH_TOKEN` allows event creation but is scoped to group 3688. |
| Data retention | Standard InstaClaw 30-day wipe after subscription ends. Agent memory is destroyed. |
| Edge City branding | "Powered by InstaClaw" — Edge City controls the portal, InstaClaw is infrastructure. |

---

## 7. Implementation Plan

### Phase 0: Foundation (1-2 days)
- [ ] **Migration**: Add `partner` column to `instaclaw_users` and `instaclaw_vms`
- [ ] **Auth flow**: Read `instaclaw_partner` cookie in `lib/auth.ts` signIn callback, set on user creation
- [ ] **Cookie setter**: Partner portal page sets the cookie before redirecting to signup
- [ ] **Env vars**: Add `EDGEOS_BEARER_TOKEN` and `SOLA_AUTH_TOKEN` to Vercel env vars (get tokens from Tule)
- [ ] **Promo code auto-apply**: When partner cookie is `edge_city`, auto-apply the EDGE coupon at checkout (no manual code entry)

### Phase 1: Skill Install + Portal (2-3 days)
- [ ] **`installEdgeCitySkill()`**: Write function in `lib/ssh.ts` following `installAgdpSkill()` pattern
- [ ] **Hook into `configureOpenClaw()`**: Gate on `partner === "edge_city"`, call install function
- [ ] **SOUL.md Edge section**: Add Edge Esmeralda context paragraph to SOUL.md for Edge users
- [ ] **BOOTSTRAP.md onboarding interview**: Write interview script for Edge users' first conversation
- [ ] **Reference content cron**: Add git-pull cron during skill install for fresh reference data
- [ ] **Partner portal page**: Build `app/(marketing)/edge-city/page.tsx` with Edge City branding
- [ ] **Register skill dir**: Ensure `~/.openclaw/skills/edge-esmeralda` is added to `extraDirs`

### Phase 2: Test + Launch (1-2 days)
- [ ] **Canary deploy**: Provision 1 test VM, run full configureOpenClaw() with partner=edge_city
- [ ] **Run benchmark questions**: Test all 10 EE26 benchmark questions against the canary agent
- [ ] **Verify skill isolation**: Confirm non-Edge VMs do NOT have the skill installed
- [ ] **Verify promo code flow**: End-to-end test — portal -> signup -> checkout with EDGE code -> deploy -> agent has skill
- [ ] **Share test accounts with Edge City team**: 3-5 accounts for Timour, Tule, Alejandro to test
- [ ] **Iterate on SOUL.md / onboarding**: Adjust based on team feedback

### Phase 3: XMTP Agent-to-Agent Layer (2-3 weeks)
- [ ] **XMTP SDK integration**: Install `@xmtp/node-sdk`, write XMTP client service script
- [ ] **Wallet identity**: Wire Bankr wallet private key into XMTP client for agent authentication
- [ ] **XMTP systemd service**: `xmtp-client.service` running alongside gateway, auto-restart
- [ ] **Plaza groups**: Create `ee26-plaza`, `ee26-governance`, `ee26-events` XMTP groups
- [ ] **Message queue**: File-based inbox/outbox (`~/.openclaw/xmtp/inbox.jsonl`, `outbox.jsonl`) for OpenClaw agent to read/write
- [ ] **Plaza skill**: Write SKILL.md section for XMTP — send/receive messages, parse content types
- [ ] **Content types**: Define and implement structured message types (availability signals, intro proposals, governance votes, group formation)
- [ ] **Overnight planning cron**: 3 cron jobs (11 PM signal, 5 AM compile, 7 AM Telegram briefing)
- [ ] **Morning briefing template**: Telegram message format for curated daily plan
- [ ] **Privacy controls**: Onboarding questions for sharing consent, human override commands
- [ ] **Canary test**: 5-10 test agents running overnight cycle, verify matches and briefings
- [ ] **`installXMTPClient()`**: Integrate into `configureOpenClaw()` behind `partner === "edge_city"` gate

### Phase 4: Governance, Treasury & Scale (ongoing, pre-event)
- [ ] **Governance voting flow**: Proposals broadcast via XMTP, agents surface to humans via Telegram, votes cast back via XMTP
- [ ] **Treasury / agent faucet**: USDC distribution mechanism, funding proposals via XMTP governance channel
- [ ] **Sentiment aggregation**: Coordinator agent collects anonymized nightly sentiment, surfaces to organizer dashboard
- [ ] **Group formation**: Agent-to-agent dinner/activity coordination, auto-compose invitations
- [ ] **Provision VMs**: 500-1000 VMs in ready pool (coordinate with Linode — $29/mo dedicated CPU)
- [ ] **Monitoring dashboard**: Partner-specific metrics — active agents, XMTP message volume, matches made, governance participation
- [ ] **Load testing**: Simulate 1,000 agents posting availability signals simultaneously, verify XMTP throughput

---

## 8. Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 1 | API tokens — does Tule have `EDGEOS_BEARER_TOKEN` and `SOLA_AUTH_TOKEN` ready for us? | Tule/Timour | Pending |
| 2 | How many test accounts does Edge City team need initially? | Timour | Said ~5-10 for team testing |
| 3 | Edge City portal branding assets (logo, colors, hero image)? | Timour | Needed for portal page |
| 4 | Should the promo code auto-apply or require manual entry? | Cooper | Recommend auto-apply for frictionless UX |
| 5 | Do Edge agents get a specific tier (starter/pro/power) or does the partner choose? | Cooper/Timour | Recommend pro tier for best demo experience |
| 6 | Onboarding interview — structured (bot-driven) or conversational (agent-driven)? | Cooper | Recommend agent-driven via BOOTSTRAP.md |
| 7 | When should the portal be live for early signups? | Timour | Needs timeline alignment |
| 8 | Shared data layer API contract — is Tule publishing an OpenAPI spec? | Tule | Pending |
| 9 | Do attendees need to be ticket holders to claim an agent? (gating mechanism) | Timour | Initially yes — incentivize ticket sales |
| 10 | Local compute / OpenRouter support timeline? | Cooper | On roadmap, no date yet |
| 11 | **XMTP: Which SDK version?** `@xmtp/node-sdk` vs `@xmtp/mls-client` vs `@xmtp/browser-sdk` — need to confirm best fit for server-side Node.js agents | Cooper / XMTP team | Pending — show spec to XMTP team |
| 12 | **XMTP: Group creation** — who creates the plaza/governance/events groups? Need an admin wallet or coordinator agent with group creation authority | Cooper | Design decision needed |
| 13 | **XMTP: Message throughput** — can XMTP handle 1,000 agents posting availability signals within a 1-hour window? Need load testing or confirmation from XMTP team | XMTP team | Ask during partnership call |
| 14 | **XMTP: Wallet key access** — does the XMTP client need the Bankr wallet's raw private key, or can it use a derived signing key? Security implications. | Cooper / Bankr | Need to check Bankr key export API |
| 15 | **Treasury: Funding source** — who funds the agent faucet? Edge City org? Sponsors? Attendee pool? How much per agent? | Timour | $20-25 per first vote mentioned in Newsworthy context |
| 16 | **Privacy: Sharing consent UX** — during onboarding, how granular should sharing controls be? ("Share my interests" vs "Share my name + interests + goals") | Cooper / Timour | Recommend simple 3-tier: name-only / interests / full profile |

---

## 9. Reusability for Future Partners

This architecture is designed to generalize:

| Component | Reusable? | How |
|-----------|-----------|-----|
| `partner` column on users/VMs | Yes | Any partner tag value |
| Partner cookie + auth flow | Yes | Different cookie values per partner |
| `installEdgeCitySkill()` | Template | Copy + modify for new partner skill repo |
| Partner portal page | Template | New route per partner with their branding |
| Stripe coupon/promo code | Yes | Create new coupon per partner in Stripe Dashboard |
| SOUL.md partner section | Template | Append partner-specific context |
| Skill gating in configureOpenClaw | Yes | Add `else if (partner === "eclipse")` etc. |
| **XMTP client service** | Yes | Same service, different group IDs per event/partner |
| **Plaza skill** | Yes | Same XMTP instructions, different community context |
| **Overnight planning cycle** | Yes | Same cron + logic, different matching criteria per community |
| **Morning briefing template** | Template | Same structure, partner-branded messaging |
| **Governance voting flow** | Yes | Same XMTP vote mechanism, different proposal sources |
| **Content types** | Yes | Same structured message types work for any community event |

Future: if we accumulate 5+ partners, refactor into a generic `installPartnerSkill(partner, repoUrl)` function and a `partners` config table. The XMTP layer generalizes naturally — each partner community gets its own set of XMTP groups, same agent-to-agent protocol. For now, explicit per-partner functions are simpler and more controllable.

---

## 10. Success Metrics

| Metric | Target |
|--------|--------|
| Benchmark questions passing | 9/10+ (Q1 and Q10 are most critical) |
| Agent activation rate | >80% of ticket holders claim an agent |
| Daily active agents | >50% of claimed agents used daily during event |
| People connections made | Track intro requests via agent logs |
| NPS / feedback score | Positive sentiment in daily check-ins |
| Conversion to paid after trial | >10% of Edge users convert to paid InstaClaw after event |
| Partner reusability | Architecture reused for at least 1 more partner within 3 months |
| **XMTP: Morning briefing open rate** | >70% of humans respond to or acknowledge their morning briefing |
| **XMTP: Matches accepted** | >50% of agent-proposed introductions accepted by both humans |
| **XMTP: Matches that happen** | >60% of accepted intros actually result in a meeting (human confirms after) |
| **XMTP: Overnight signal participation** | >80% of agents successfully post an availability signal nightly |
| **XMTP: Governance participation** | >30% of agents cast at least one governance vote on behalf of their human |
| **XMTP: Group formation** | >20 agent-organized group activities per week (dinners, hikes, study groups) |
| **XMTP: "Best connection" attribution** | Track how many attendees cite an agent-arranged intro as their best connection of the event |

---

## 11. Timeline

| Date | Milestone |
|------|-----------|
| **Apr 9** | PRD finalized, promo code live |
| **Apr 11** | Phase 0 complete — migration, auth flow, env vars |
| **Apr 14** | Phase 1 complete — skill install, portal page, canary test |
| **Apr 16** | Phase 2 complete — benchmarks passing, test accounts sent to Edge team |
| **Apr 18** | Weekly check-in with Timour — iterate on feedback. Show XMTP spec to XMTP team. |
| **Apr 21-May 2** | Phase 3 — XMTP client service, plaza skill, overnight planning cycle |
| **May 2** | XMTP canary: 5-10 test agents running overnight matchmaking cycle |
| **May 5-9** | Iterate on morning briefing format, match quality, privacy controls |
| **May 9** | Portal live for early signups (ticket holders) |
| **May 12-23** | Phase 4 — governance voting, treasury, sentiment aggregation, group formation |
| **May 19-23** | Load test: simulate 1,000 agents on XMTP, verify throughput |
| **May 23** | VM pool scaled to 1,000 (coordinate with Linode — ~$29K/mo) |
| **May 26-29** | Final integration testing, organizer dashboard, dry run with Edge team |
| **May 30** | **EE26 starts** — agents live, overnight planning active from night 1 |
| **Jun 6** | Week 1 retrospective — tune matchmaking quality, fix edge cases |
| **Jun 27** | EE26 ends — collect metrics, retrospective, conversion campaign |
| **Jul** | Trial conversions, case study, apply learnings to Eclipse / next partner |
