# EdgeClaw — Sponsor Inference Budget

**Event:** Edge Esmeralda 2026 · 28-day popup village · Healdsburg, CA
**Dates:** May 30 – Jun 27, 2026 · **Scale:** ~500 attendees, 500 dedicated AI agents
**Document version:** 2026-04-29 · **Owner:** Cooper Wrenn / InstaClaw

---

## TL;DR

**Recommended sponsor commitment: $60,000** to fully cover model inference for 500 personal AI agents across the 28-day village, fully ungated, with 25% headroom for power-user usage and unexpected demand.

| Tier | Amount | Coverage |
|------|-------:|----------|
| Conservative | **$40,000** | Light-to-moderate community engagement, no buffer |
| **Recommended** | **$60,000** | Realistic mixed usage + 25% headroom for power users |
| Stretch | **$90,000** | Heavy adoption, premium model upgrades (Opus on demand), full safety net |

This document outlines what the sponsor commitment funds, the per-agent usage model behind the number, and what InstaClaw covers separately as part of providing the infrastructure.

---

## What sponsor funds cover

| Line item | Cost (28-day total) |
|-----------|--------------------:|
| Anthropic Claude inference (Sonnet 4.6 default + Haiku fallback) | $46,000 |
| OpenAI inference (embeddings for matching, GPT-4 fallback, Whisper voice transcription) | $700 |
| Index Network compute pass-through (TBD final structure with Index team) | $1,500 |
| **Subtotal — projected inference cost** | **$48,200** |
| Power-user / unexpected-demand headroom (25%) | $12,000 |
| **Recommended sponsor commitment** | **$60,200** |

Inference costs are the variable cost of running 500 agents continuously for 28 days. They scale with usage. Sponsor funding routes through one of three structures (final structure decided with the lead sponsor):

- **Model A** — sponsor provides one shared Anthropic + OpenAI key; all EE26 agents route through it. *Simplest, fastest to confirm. Sponsor sees aggregate token usage but no per-agent or per-message content.*
- **Model B** — sponsor mints / funds individual API keys; each agent uses its own. *Per-agent attribution. Higher operational overhead.*
- **Model C** — sponsor pays InstaClaw, InstaClaw provisions inference using its own Anthropic / OpenAI accounts. *Cleanest UX for sponsors. InstaClaw becomes the billing intermediary.*

---

## Per-agent usage model

The $46K Claude line assumes the following daily activity for an average agent in the village. Numbers reflect *fully ungated* usage — no daily token caps, no feature throttling.

### Daily activity per agent (model: Claude Sonnet 4.6 with prompt caching)

| Activity | Frequency | Tokens (input / output) | Cost / day |
|----------|----------:|------------------------:|-----------:|
| Heartbeat runs (every 3h, 8/day) | 8 | 50K / 5K each | $1.15 |
| Telegram conversations | ~10 turns/day | 30K / 5K per turn | $0.70 |
| Overnight matchmaking cycle (Index Network query + XMTP negotiation) | 1/night | 200K / 30K | $0.50 |
| On-demand discovery queries ("who's working on X?") | ~3/day | 75K / 10K each | $0.50 |
| Skill executions (research, summarization, calendar) | varies | varies | $0 – $1.65 |

Prompt caching cuts input cost by ~60% on repeated context (workspace files, attendee directory, recent conversation). Without caching, raw cost is ~2.5× higher; the $46K figure assumes caching is on.

### User distribution (weighted average → $3.28 / agent / day)

500 agents are not all equally active. Realistic distribution at a residential village:

| User type | % of attendees | Daily Claude cost / agent |
|-----------|---------------:|--------------------------:|
| Light (basic chat + scheduling) | 40% | $2.00 |
| Moderate (active community engagement) | 40% | $3.20 |
| Heavy (power users — frequent skill use, lots of intros) | 20% | $6.00 |
| **Weighted average** | **100%** | **$3.28** |

### Compounding to 28 days

500 agents × 28 days × $3.28/agent/day = **$45,920 (Claude)**, plus ~$700 OpenAI + $1,500 Index Network pass-through = **$48,200 inference**.

---

## What sponsor funding does NOT cover

InstaClaw covers the following as part of providing the infrastructure — these are platform costs that exist whether or not the village is sponsored:

- **VM compute** — 500 dedicated Linode VMs at ~$29/mo each (~$14,500/mo) — InstaClaw absorbs
- **Engineering time** — building the Index Network integration, XMTP layer, governance flows, data export pipeline — InstaClaw absorbs
- **Platform infrastructure** — Supabase, Vercel hosting, monitoring, billing — InstaClaw absorbs
- **Operational overhead** — fleet management, support during the village, on-the-ground iteration — InstaClaw absorbs

The sponsor commitment is purely the variable inference cost — the marginal compute that exists *because* 500 agents are running, not the platform that lets us run them.

---

## Variance scenarios

Inference cost scales with usage, which is hard to predict for a first-of-its-kind event. Three scenarios:

| Scenario | Avg daily / agent | 28-day total inference |
|----------|------------------:|-----------------------:|
| Conservative — most users light, low Claude burn | $2.10 | ~$30,000 |
| Recommended — realistic mixed distribution | $3.28 | ~$48,200 |
| Heavy — high adoption, premium model usage | $7.00 | ~$100,000 |

The **$60K recommended ask** sits between the realistic and heavy scenarios with a 25% buffer. If actual usage runs lighter, unused funds either roll forward to the next event or refund per the sponsor agreement.

---

## What sponsors get

- **Funding-page recognition** on the Edge Esmeralda research overview and the agent-village landing page
- **Acknowledgment in published research** (Vendrov's paper, Oct 2026) and weekly synthesis posts
- **Aggregate token usage dashboard** showing actual inference burn by week
- **Co-marketing opportunity** — sponsors can publish their own writeup of the experiment, citing the data they helped fund
- **Direct access to Vendrov's published dataset** when it ships (Sep 2026) — the same anonymized research output any reader of the paper will get

Sponsors do **not** see per-agent or per-message content. Agent-to-agent conversations are encrypted (XMTP) and the sponsor's only visibility into usage is aggregate token counts.

---

## Why this matters

The Agent Village experiment at Edge Esmeralda is the first longitudinal field study of personal AI agents tethered to real humans living together for a month. Without sponsor coverage, agents would have to be gated to keep platform economics viable — which would compromise the experiment design (every attendee needs a working agent for the research to produce clean data).

Sponsor funding *directly enables* the ungated agent experience that makes the research credible. It's the single biggest unlock between "interesting demo" and "publishable AI research."

**Contact:** Cooper Wrenn · cooper@instaclaw.io · [@coopwrenn](https://x.com/coopwrenn)
**Research lead:** Ivan Vendrov · [vendrov.ai](https://vendrov.ai)
**Project lead:** Timour Kosters · timour@edgecity.live
