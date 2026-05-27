# ToolRouter Integration — Strategic PRD

> **Status**: Draft 1 — research-first, awaiting Andy confirmation on 6 open
> questions before any code lands.
> **Date**: 2026-05-27 (same-day response to Andy Wang sharing ToolRouter in
> the InstaClaw × World group chat).
> **Owner**: Cooper (sponsor) + reconciler/manifest terminal (implementation,
> assigned at Phase 3).
> **Audience**: any CC terminal picking this up; Andy if Cooper shares it.
> **Companion docs**: `instaclaw/docs/prd/base-mcp-integration.md`,
> `instaclaw/docs/prd/base-mcp-integration-addendum.md`.

---

## TL;DR

Andy Wang at World Foundation shipped **ToolRouter** — a hosted MCP server
at `toolrouter.world` that proxies a catalog of paid SaaS tools (search,
research, browser, email, travel) behind a single Bearer-auth API key, a
single prepaid credit balance, and a single MCP connection. ToolRouter
handles x402 payments to upstream providers internally. Today's catalog: 16
endpoints across Exa, Parallel, Manus, AgentMail, Browserbase, StableTravel.

**ToolRouter is structurally orthogonal to our Base MCP work.** Base MCP
skill plugins teach the agent to interact with the **onchain economy**
(Morpho, Aerodrome, Uniswap, Avantis, Virtuals) using **our own wallet
infrastructure** (Bankr / CDP / Sub Account). ToolRouter brings the agent a
**curated paid SaaS catalog** (Exa, Browserbase, AgentMail) using
**ToolRouter's** wallet infrastructure (transparent x402). Zero tool overlap.
Together they're the complete stack: onchain via Base, off-chain via World.

**The non-obvious insight**: ToolRouter is the **first partner that solves the
"agent needs paid SaaS tools" problem at scale**. Without ToolRouter every
SaaS would need its own per-VM credentials, its own billing path, its own
skill markdown. ToolRouter unifies the off-chain paid-tool surface into a
single MCP server, a single key, a single credit pool. That maps directly to
Cooper's "fleet's x402 + MCP tool routing layer" thesis. We don't need to
build the consumer side — Andy already did.

This PRD ships in three small waves:

- **v1 (this week, gated on Andy issuing an API key)** — wire ToolRouter as
  `mcp.servers.toolrouter` on every assigned VM. Single platform-scoped
  `tr_...` Bearer key distributed via the existing `SECRET_ENV_VAR_SOURCES`
  pipeline (CLAUDE.md "Rotating secrets" runbook). One reconciler step
  `stepToolRouter` mirrors `stepIndexProvision` (modulo per-VM mint, which
  doesn't apply). SOUL.md routing teaches the agent when to reach for
  ToolRouter tools.
- **v1.5 (1-2 weeks, depends on Andy)** — if ToolRouter exposes per-key
  labels / sub-keys, mint a per-VM sub-key for cost attribution + isolation.
  If it doesn't, stay on the single key and add admin-side spend-cap alerting
  per Rule 67 pattern.
- **v2 (2-4 weeks, depends on Andy AND on v2.5 of the Base MCP PRD)** —
  register InstaClaw agents AS ToolRouter-listed paid endpoints (the
  "delegated autonomy as a service" surface from Base MCP §6). ToolRouter
  becomes our distribution channel; other agents discover + pay InstaClaw
  agents through it.

**Six open questions** are flagged for Andy at the bottom of this document.
Until they're answered, no code lands; v1 has hard preconditions (API key
issued + transport contract confirmed) that we can't satisfy alone.

---

## 1. What ToolRouter Is (verified 2026-05-27)

### 1.1 The product

ToolRouter is a hosted MCP server at `toolrouter.world`. The landing page
positions it as "an MCP server your agent connects to once. Every endpoint
behind it is verified, paid through AgentKit, and traced end-to-end. One
MCP server for every agent. One API key and one credit balance for every
tool."

Verbatim from the landing page: *"ToolRouter handles provider x402 payments
behind the scenes: no stablecoin top-ups, wallet management, or per-vendor
billing setup."*

### 1.2 The technical shape

| Property | Value | Source |
|---|---|---|
| Hosting model | Single hosted MCP, self-hostable backend | landing page + GitHub README |
| Backend repo | `github.com/andy-t-wang/toolrouter` (public, MIT-style license referenced) | GitHub fetch |
| Backend stack | Fastify API + Next.js dashboard + bun workers + `packages/router-core` | repo README |
| MCP adapter package | `@worldcoin/toolrouter` (npm) | GitHub README + setup guide |
| MCP transport | **stdio** between adapter and parent agent process | adapter README confirmed |
| Underlying API transport | HTTPS POST to `https://toolrouter.world/v1/requests` (JSON in, JSON/SSE out) | GitHub fetch |
| Auth model | Bearer token `Authorization: Bearer tr_...` | GitHub setup guide |
| Billing model | Single API key → single prepaid credit balance | landing page |
| Credit currency | USDC-denominated, top up via dashboard (assumed; not verified) | dashboard requires login |
| Provider catalog (today) | 16 endpoints in 6 categories | landing page enumeration |
| Health probing | Paid live-roundtrip every hour; AgentKit boost probes every 12h | landing page |
| Provider onboarding | Manual today: submit URL + schema + fixture + price + mode + failure notes | repo `/docs` |

The published catalog (2026-05-27, 16 endpoints, 15/16 operational at fetch time):

- **Search (2)**: Exa Search, Parallel Search
- **Research (2)**: Manus Research, Parallel Task
- **Extract (1)**: Parallel Extract
- **Email (5)**: AgentMail (send/read/list/etc.)
- **Browser (1)**: Browserbase Session (degraded at last probe)
- **Travel (5)**: StableTravel (flight/hotel/location)

### 1.3 The MCP surface the adapter exposes

The `@worldcoin/toolrouter` adapter publishes these MCP tools to its parent
agent (verbatim from `apps/mcp/README.md`):

**Discovery primitives** (catalog-aware, the agent self-discovers):
- `toolrouter_list_endpoints` — list every endpoint with metadata
- `toolrouter_list_categories` — list categories
- `toolrouter_recommend_endpoint` — recommend an endpoint for a free-text task
- `toolrouter_call_endpoint` — generic execute (pass `endpoint_id` + input)
- `toolrouter_get_request` — fetch a prior request's trace/status/result

**Provider convenience wrappers** (high-traffic surfaces, fast path):
- `toolrouter_search` — generic search (wraps Exa / Parallel)
- `toolrouter_send_email` — wraps AgentMail
- `toolrouter_browser_use` — wraps Browserbase
- `exa_search` — Exa-specific
- `browserbase_session_create` — Browserbase-specific
- `manus_research_start` / `_status` / `_result` — async long-running research

This dual surface (discovery + wrappers) is the right pattern for an
LLM-driven client: the agent CAN use discovery to explore but USUALLY uses
the wrappers for the common cases. It's the same shape we use for the
Polymarket / Solana DeFi skill scripts, and it composes well with SOUL.md
routing.

### 1.4 "AgentKit-verified" — what that actually means

[VERIFIED 2026-05-27 via gh API deep-dive of `andy-t-wang/toolrouter`
source: `packages/router-core/src/agentkitValue.ts`,
`packages/router-core/src/executor/agentkitExecutor.ts`,
`packages/router-core/src/endpoints/*/*/...ts`, `scripts/probe-agentkit-exa.mjs`,
`agents.md`. Also corroborated by World Foundation announcement
2026-03-17: World launched AgentKit with Coinbase x402 integration for
"human-verified AI agents."]

**AgentKit is World Foundation's verified-human delegation layer**,
launched 2026-03-17 with Coinbase as integration partner. It's
COMPLEMENTARY to x402, NOT a replacement. The chain works like this:

1. **A verified human registers an agent wallet on the World Chain
   AgentBook contract.** The CLI is `npx @worldcoin/agentkit-cli register
   <agent-address>` — World App verification → submit proof to
   AgentBook → contract maps `agent_address → human_id`.
2. **When the agent makes a request to an AgentKit-enabled endpoint**,
   ToolRouter's executor signs an EIP-191 SIWE message
   ("Verify your agent is backed by a real human") with the agent's
   wallet and sends it in the HTTP `agentkit` header (base64-encoded
   JSON with domain, uri, nonce, signature, address).
3. **The provider verifies the wallet is AgentBook-registered**
   (calls `lookupHuman(agent_address)` on the AgentBook contract on
   World Chain — chain id `eip155:480`). If registered, grants the
   AgentKit benefit (free / access / discount).
4. **If AgentKit returns 402 (not entitled)**, ToolRouter falls back
   to x402 payment from the user's credit balance.

The CRITICAL invariant: **without AgentBook registration, every
AgentKit-eligible request falls through to x402 paid mode**. From
`scripts/probe-agentkit-exa.mjs`: *"wallet is NOT registered as an
agent — free trial impossible."*

### 1.5 Verified endpoint catalog with AgentKit value classification

[VERIFIED 2026-05-27 from `agents.md` + each endpoint's
`packages/router-core/src/endpoints/<cat>/<prov>/<endpoint>.ts`.]

The 16 endpoints split into FOUR billing classes, not the 2 my Draft 1
implied:

| Endpoint | `agentkit_value_type` | x402 price | What AgentKit does | What x402 does |
|---|---|---|---|---|
| `exa.search` | `free_trial` | $0.007 | If verified → **FREE** (path=`agentkit`, charged=false). Cap unknown — see Q3 below. | Pays $0.007 + ToolRouter markup if AgentKit fails/exhausts |
| `manus.research` | `free_trial` | $0.03 quick / $0.05 std / $0.10 deep | If verified → **2 free research requests/month** per agent address (provider-side cap, documented in `agents.md`). | Pays depth-priced + markup after the 2-free cap |
| `browserbase.session` | `access` | $0.01-0.02 | **Premium browsers** ("Browserbase Verified browsers"); x402 STILL PAYS | Pays standard session price; without AgentKit gets non-verified browser pool |
| `parallel.search` | `null` (no benefit) | $0.02 | (none — AgentKit not supported) | Pays $0.01 Parallel + $0.01 ToolRouter markup |
| `parallel.extract` | `null` | $0.01/URL + $0.01 markup | (none) | x402-only |
| `parallel.task` | `null` | $0.015 lite → $0.31 ultra + markup | (none) | x402-only |
| `agentmail.send_message` | `null` | $0.02 | (none) | x402-only |
| `agentmail.create_inbox` | `null` | $2.00+$0.01 markup | (none) | x402-only |
| `agentmail.list_messages` | `null` | $0 (read endpoint) | (none) | free read |
| `agentmail.get_message` | `null` | $0 (read endpoint) | (none) | free read |
| `agentmail.reply_to_message` | `null` | $0.02 | (none) | x402-only |
| `stabletravel.locations` | `null` | low (~$0.01) | (none) | x402-only |
| `stabletravel.google_flights_search` | `null` | variable | (none) | x402-only |
| `stabletravel.hotels_list` | `null` | variable | (none) | x402-only |
| `stabletravel.hotels_search` | `null` | variable | (none) | x402-only |
| `stabletravel.flightaware_flights` | `null` | variable | (none) | x402-only |

Three endpoints have AgentKit benefits; 13 are x402-only. The
high-traffic ones we care about (search + research + browser) ALL have
AgentKit benefits — that's the moat (see §10.5 below).

### 1.6 The three execution paths (verified from `agentkitExecutor.ts`)

ToolRouter's executor reports `path` for every request. Three values:

- **`path: "agentkit"`** — AgentKit succeeded outright. `charged: false`.
  Zero cost to our credit balance. Reported via `realizedAgentKitValue()`
  which checks `path === "agentkit" && !charged` for `free_trial` endpoints
  (verified in `agentkitValue.ts:countsAsAgentKitEvidence`).
- **`path: "agentkit_to_x402"`** — AgentKit returned 402 (boost exhausted
  or not entitled), retried with x402 payment, succeeded.
  `charged: true`. Cost = x402 price + ToolRouter markup.
- **`path: "x402"`** — Endpoint doesn't support AgentKit (e.g., Parallel),
  request went straight to x402. `charged: true`.

The MCP adapter does NOT pass any delegation token at the agent-side —
verified by reading `apps/mcp/scripts/build-endpoints.mjs` and the public
README. ToolRouter does the AgentKit signing on the SERVER side using
the account's wallet (Crossmint server-signer). **From InstaClaw's
perspective, AgentKit verification is bound to whoever owns the
`tr_...` API key's underlying account.**

### 1.7 Self-hostability

The repo includes Dockerfiles + DigitalOcean App Platform templates in
`/deploy`. **Not a path we'd take** — Andy hosts it, the catalog is centrally
curated, x402 wallets are centrally provisioned, AgentKit boost agreements
are centrally negotiated. Self-hosting buys us nothing and forks us off the
catalog updates.

The fact that self-hosting EXISTS is useful as a fallback signal: if
ToolRouter.world ever goes dark, the code is ours to run.

### 1.8 What ToolRouter is NOT

- **NOT the MCP Registry.** The MCP Registry at
  `registry.modelcontextprotocol.io` (Linux Foundation, ~2000 entries) is a
  catalog of MCP servers. ToolRouter is itself a single MCP server in that
  catalog. They could be co-listed; not the same thing.
- **NOT a competitor to Base MCP.** Base MCP is hosted onchain action server
  (OAuth-gated, per-tx Allow). ToolRouter is hosted paid SaaS-tool router
  (API key, prepaid credits). Zero tool overlap.
- **NOT a replacement for our existing skill plugins.** The Polymarket /
  Solana DeFi / Bankr / Edge / Consensus skills are agent-side markdown that
  teaches the LLM how to compose specific operations. ToolRouter is a
  generic tool catalog. Both layer cleanly on top of each other.

---

## 2. How ToolRouter Composes With Our Architecture

### 2.1 The mental model

| Layer | What runs | Who pays | Examples |
|---|---|---|---|
| **Skill plugins (markdown)** | Agent's LLM reads + interprets | Free — the agent reads docs | Polymarket, Solana DeFi, Bankr, Consensus, Edge |
| **Skill plugins → existing wallet** | LLM constructs unsigned tx; agent signs via Bankr/Sub Account | Gas only | Base MCP skills (Morpho, Aerodrome) — composed via wallet skills |
| **Local sidecar MCP servers** | `systemd --user` process, HTTP loopback | Free / per-call to upstream | gbrain (memory), future Base AI tools |
| **Partner-hosted streamable-http MCP** | Direct streamable-http connection | Variable | Index Network (free under InstaClaw network), future Base API |
| **Partner-hosted stdio MCP (THIS PRD)** | Adapter spawned by OpenClaw per session | Per-call from a prepaid pool | **ToolRouter** |
| **InstaClaw-as-x402-server** (future) | per-VM HTTP server, public ingress | Other agents pay us | Base MCP v2.5 (delegated autonomy as a service) |

ToolRouter occupies a row that **was previously empty**. Every paid SaaS we
have today (Brave Search at `BRAVE_API_KEY`, future Exa, future Browserbase,
future AgentMail) would have needed: (a) its own env var, (b) its own
provisioning logic, (c) its own retry / billing / failover handling, (d) its
own skill markdown. ToolRouter collapses all of that into one row.

### 2.2 The integration model

Per the existing wiring patterns we have for MCP servers:

| Pattern | Used by | Shape | When to use |
|---|---|---|---|
| **Local HTTP sidecar** | gbrain | `systemd --user` process; agent connects via `streamable-http` to `127.0.0.1` | Heavy / stateful: PGLite, large local state, security-sensitive |
| **Partner streamable-http** | Index Network | direct connection to hosted endpoint; `mcp.servers.index` config | Lightweight: hosted endpoint exposes streamable-http MCP directly |
| **Partner stdio adapter** | (no precedent yet) | OpenClaw spawns `npx -y <adapter>` per session | Forced when the hosted endpoint doesn't speak streamable-http and the adapter is light enough |

**ToolRouter today is the third row.** The hosted backend at toolrouter.world
exposes a JSON HTTPS API; the `@worldcoin/toolrouter` npm adapter bridges
stdio MCP ↔ HTTPS. **There is no documented streamable-http MCP endpoint at
toolrouter.world.** ← This is the critical finding.

That has two consequences:

1. **v1 must use the stdio adapter** (Option C below). This means OpenClaw
   spawns a `node` process per session per VM. The adapter is light — no
   PGLite, no bun runtime, no Anthropic SDK init — but it's still a child
   process the agent depends on.

2. **The right v1.5 ask of Andy is: please ship a streamable-http MCP endpoint
   at `https://toolrouter.world/mcp`** with Bearer auth. We'd flip from stdio
   to streamable-http with a single config change, removing the per-session
   process spawn entirely. This is identical to how Index Network works today.
   (See §6, Q2.)

### 2.3 Three integration paths, ranked

**Path A — Hosted streamable-http MCP endpoint** *(does not exist today —
proposal for Andy)*

OpenClaw connects directly to `https://toolrouter.world/mcp` via the
`streamable-http` transport, Bearer-authed. Per-VM disk shape:

```json
"mcp": {
  "servers": {
    "toolrouter": {
      "transport": "streamable-http",
      "url": "https://toolrouter.world/mcp",
      "headers": {
        "Authorization": "Bearer tr_..."
      },
      "connectionTimeoutMs": 5000
    }
  }
}
```

**Pros**: zero per-session process spawn (matches gbrain HTTP-sidecar
lesson, Rule 35). Identical to Index Network's wiring pattern, which is
proven in production. Hot-reloadable per Rule 32 (mcp.servers.* is on the
verified-hot-reload list). Cleanest possible operational shape.

**Cons**: doesn't exist today. Requires Andy to ship the endpoint. v1
blocked on this.

**Path B — Persistent local stdio sidecar (custom shim)** *(don't do this)*

We could write our own shim that wraps `npx @worldcoin/toolrouter` in a
loopback HTTP server, install as `systemd --user`, point OpenClaw at the
loopback via `streamable-http`. Mirrors gbrain's architecture.

**Pros**: zero per-session spawn; we control the lifecycle.

**Cons**: this is a custom adapter we'd own and maintain. Andy's adapter is
the canonical surface; reproducing it adds drift risk. If Andy ever ships
Path A (streamable-http endpoint), our custom shim becomes immediately
obsolete. Bad investment.

**Path C — Per-session stdio adapter** *(v1 default)*

OpenClaw spawns `npx -y @worldcoin/toolrouter` as a child process per
agent session, with `TOOLROUTER_API_KEY` + `TOOLROUTER_API_URL` in the
environment. Per-VM disk shape:

```json
"mcp": {
  "servers": {
    "toolrouter": {
      "command": "npx",
      "args": ["-y", "@worldcoin/toolrouter"],
      "env": {
        "TOOLROUTER_API_KEY": "tr_...",
        "TOOLROUTER_API_URL": "https://toolrouter.world"
      }
    }
  }
}
```

**Pros**: works with today's published surface. Matches Andy's quickstart
verbatim. Lowest implementation cost.

**Cons**: per-session process spawn. Cold-start risk (we don't know how
heavy the adapter is at boot — needs measurement on the active canary VM, §7 task C).
`npx -y` does a npm registry hit on every cold start unless the package is
already in `~/.npm/_npx/...` — first agent turn after a fresh restart could
hang on package resolution. Worth pre-pulling the package in
`configureOpenClaw` so the first session doesn't pay this tax.

**Decision (this PRD)**: ship Path C as v1 (it's the only working option
today). **Concurrently, propose Path A to Andy** with this PRD as the
artifact that shows we'd be the first reference integration. Flip to Path
A with a one-config-block change the moment Andy ships it.

### 2.4 Where ToolRouter does NOT fit

To preempt anti-patterns:

- **NOT a freight train for everything**: ToolRouter does not replace the
  Polymarket / Solana DeFi / Bankr skills. Those operate on protocols we
  already have direct wallet access to. ToolRouter is for **third-party
  APIs we don't already have wallet access to** (Exa, Browserbase, AgentMail,
  Manus, StableTravel). Don't try to route Bankr calls through ToolRouter
  even if ToolRouter's catalog grows to include them — we have a direct
  Bankr wallet on every VM (Rule 66); going through a paid proxy would be
  strictly worse on latency and cost.

- **NOT a replacement for World ID auth**: We use World ID on
  `mini.instaclaw.io` for human authentication. ToolRouter's AgentKit boosts
  are a discount mechanism downstream of World ID, not a replacement for the
  auth surface.

- **NOT a replacement for the freeze archive**: ToolRouter calls leave no
  per-VM state behind (the request log lives on toolrouter.world). The
  freeze-thaw archive (Rule 53) doesn't touch this surface.

---

## 3. Relationship to Base MCP Work

### 3.1 Capability matrix

Concrete table showing where ToolRouter and Base MCP each carry weight.

| Capability | Base MCP skill plugins | ToolRouter | Where it lives in our stack |
|---|---|---|---|
| Onchain DeFi (lend, swap, LP, perps) | YES | NO | `instaclaw/skills/base-*/SKILL.md` + Bankr/Sub Account signing |
| Token launches | YES | NO | bankr CLI primary, dgclaw via Virtuals |
| Onchain quotes / vault discovery | YES | NO | Base skill plugin "prepare" GET endpoints |
| Web search | NO | YES | ToolRouter `exa_search` / `toolrouter_search` |
| Web extraction | NO | YES | ToolRouter `parallel.extract` |
| Browser sessions (cloud) | NO | YES | ToolRouter `browserbase_session_create` |
| Browser sessions (local) | NO | NO | Local Chromium installed in `configureOpenClaw` (free, dirty state) |
| Research (multi-hop) | NO | YES | ToolRouter `manus_research_*` |
| Email send/read | NO | YES | ToolRouter `toolrouter_send_email` (AgentMail) |
| Travel booking | NO | YES | ToolRouter `stabletravel.*` |
| Polymarket trades | NO | NO | Existing local Polymarket skill + CLOB proxy |
| Solana DeFi | NO | NO | Existing local Solana DeFi skill |
| Memory (long-term) | NO | NO | gbrain HTTP sidecar |
| Identity / reputation | (v3) | NO | ERC-8004 NFTs (Base MCP §8) |
| Earning USDC from other agents | (v2.5) | **YES (v2 of this PRD)** | InstaClaw agents listed AS ToolRouter endpoints |

**Zero tool overlap.** They're complementary surfaces.

### 3.2 The combined narrative

This is the storyline Cooper asked me to articulate cleanly so it can be
shared with Andy.

The agent's tool budget today maps to a clean three-layer composition:

```
┌─────────────────────────────────────────────────────────────────┐
│ LAYER C — PRODUCER (we earn from other agents)                  │
│ • Base MCP v2 — InstaClaw listed as a Base MCP skill plugin     │
│ • This PRD v2 — InstaClaw listed AS a ToolRouter endpoint       │
│ • Per-VM x402 ingress (Base MCP v2.5)                            │
│ • ERC-8004 reputation accrual (Base MCP v3)                      │
└─────────────────────────────────────────────────────────────────┘
                              ▲
┌─────────────────────────────────────────────────────────────────┐
│ LAYER B — CONSUMER, PAID (we use other agents' / providers' work)│
│ • THIS PRD v1 — ToolRouter for Exa / Browserbase / AgentMail /  │
│   Manus / StableTravel — third-party paid SaaS, prepaid credit   │
│ • x402 → Anthropic via existing gateway (per-token billing)      │
│ • Future: ToolRouter as discovery for paid agent-to-agent work   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
┌─────────────────────────────────────────────────────────────────┐
│ LAYER A — CONSUMER, FREE / NATIVE (no per-call cost)            │
│ • Base MCP v1 skill plugins (Morpho, Aerodrome, Moonwell, etc.) │
│   — agent signs via Bankr / Sub Account; gas only                │
│ • Local skills (Polymarket, Solana DeFi, dgclaw, bankr, edge)   │
│ • Local Chromium + curl + the whole Linux shell                  │
│ • gbrain memory (per-VM PGLite)                                  │
└─────────────────────────────────────────────────────────────────┘
```

**The two layers' relationship is operational, not architectural**: an agent
doing real work uses BOTH simultaneously. A user asks "find me good DeFi
yield on Base and put 50 USDC into the best one." The agent:

1. **Layer B (ToolRouter)** — `exa_search` for current Base DeFi yields,
   surveys 5-10 result pages. PAID call, ~$0.007.
2. **Layer A (Base skill plugin)** — reads `~/.openclaw/skills/base-morpho/SKILL.md`,
   calls Morpho's GET endpoints to confirm live yields. FREE.
3. **Layer A (Base skill plugin)** — calls Morpho's "prepare deposit" GET
   endpoint. FREE.
4. **Layer A (wallet)** — signs the prepared tx via Bankr / Sub Account.
   Gas only.
5. Reports result on Telegram with tx hash + Basescan link + yield citation.

This composition is **structurally impossible for ChatGPT + Base MCP** —
ChatGPT can do step (4) via Base MCP, but every step requires its own Allow
click, and there's no persistent agent to compose them. **It's natural for
InstaClaw**.

### 3.3 v2 of THIS PRD = v2.5 of Base MCP PRD

The Base MCP PRD (§7) proposes "every InstaClaw agent exposes its OWN x402
endpoint via reverse-proxy tunnel" so other agents can hire ours. **ToolRouter
might be the better distribution channel for that.**

Instead of (or in addition to) building our own per-VM ingress:

1. We register each EARN.md-published capability as a ToolRouter endpoint.
2. Buyers find us through ToolRouter's discovery + recommendation surface.
3. Buyers pay via ToolRouter's credit balance; ToolRouter pays us via x402
   to the agent's Sub Account.
4. ToolRouter takes a transparent cut; remainder lands in the agent's wallet.

This eliminates the need for us to run per-VM Cloudflare Tunnels in the
short term. ToolRouter is the marketplace; we're a seller.

**Trade-off**: ToolRouter takes a cut (unknown %, ask Andy — §6, Q5). Our
own ingress takes no cut. For high-volume agents the cost math may favor
our own ingress; for new agents establishing reputation, ToolRouter's
discovery + verification is more valuable than the saved %. Probably both
ship in time: ToolRouter for discovery → our own ingress for repeat clients.

### 3.4 Decision: ship ToolRouter v1 NOT in conflict with Base MCP v1

The base-mcp-integration PRD's v1 is "every agent does Base DeFi natively."
**Nothing in ToolRouter v1 (this PRD) blocks, conflicts with, or duplicates
that.** They're independent shipping units. Could go out same week or
sequentially. Recommended ordering:

1. Base MCP v1 (already in flight, this week) — Layer A foundation.
2. ToolRouter v1 (this PRD, after Andy issues key + transport contract is
   confirmed) — Layer B foundation.
3. Base MCP v1.5 (Sub Account) — Layer A wallet uplift.
4. ToolRouter v1.5 (per-VM sub-keys if available) — Layer B attribution.
5. Base MCP v2 / ToolRouter v2 — Layer C producer surfaces (can ship
   parallel; the two distribution channels are not exclusive).

---

## 4. Fleet Deployment Strategy

### 4.1 The provisioning model

ToolRouter wiring on each VM has three on-disk concerns:

1. **Credential**: the `TOOLROUTER_API_KEY` env var must be present in
   `~/.openclaw/.env`.
2. **MCP server config**: the `mcp.servers.toolrouter` block must be in
   `~/.openclaw/openclaw.json`.
3. **Cached npm package** (Path C only): `@worldcoin/toolrouter` pre-pulled
   in `~/.npm/_npx/...` so the first session doesn't pay the registry hit.

Concerns 1 and 2 map directly to existing patterns. Concern 3 needs a small
new step in `configureOpenClaw`.

### 4.2 Credential distribution

ToolRouter's API key is platform-scoped, not per-VM (unless §6 Q1 resolves
to "yes, sub-keys exist"). So we want the SAME `tr_...` value on every VM,
distributed centrally via the existing `SECRET_ENV_VAR_SOURCES` pipeline
in `lib/vm-reconcile.ts`.

**Mandatory:**

1. Cooper requests an API key from Andy. (Open question Q1.)
2. Set in Vercel via `printf 'tr_...' | npx vercel env add TOOLROUTER_API_KEY production`
   (Rule 6 — `printf`, not `echo`; Rule 61 — validate value at deploy time).
3. Bump `SECRET_VERSION` in `lib/vm-reconcile.ts`. Reconciler distributes
   to every assigned + healthy VM on the next cycle (~3 min per VM at
   `CONFIGURE_AUDIT_BATCH_SIZE=3`, full fleet ~2-3h).
4. Per Rule 49, add a verifier in `lib/partner-secrets.ts`:
   - **Shape check**: starts with `tr_`, length ≥ 16, no whitespace.
   - **Live API smoke test**: `GET https://toolrouter.world/v1/endpoints`
     with `Authorization: Bearer <key>` → expect 200 + JSON. (Endpoint URL
     not 100% verified from docs; ask Andy for the canonical smoke endpoint.
     §6, Q6.)
   - Cron `cron/probe-partner-secrets` exercises hourly (existing
     mechanism — no new cron needed).

### 4.3 MCP server config write

**Path C (v1, stdio adapter)**: `stepToolRouter` reconciler step writes:

```bash
openclaw mcp set toolrouter '{
  "command": "npx",
  "args": ["-y", "@worldcoin/toolrouter"],
  "env": {
    "TOOLROUTER_API_KEY": "tr_...",
    "TOOLROUTER_API_URL": "https://toolrouter.world"
  }
}'
```

Hot-reloadable per Rule 32 (`mcp.servers.*` is empirically hot-reloadable —
see `lib/vm-reconcile.ts` `RESTART_REQUIRED_CONFIG_PREFIXES` excludes it).
Verify-after-set per Rule 32 §3 — grep journal for `[reload] config hot
reload applied (mcp.servers.toolrouter)`.

**Path A (v1.5, if Andy ships streamable-http endpoint)**: same step, different
payload — the streamable-http shape from §2.3. The reconciler picks the
shape based on an env var `TOOLROUTER_TRANSPORT=stdio|streamable-http`
(defaults to `stdio` until Andy ships otherwise). Cross-VM mode flip is a
single `vercel env add` + next reconcile cycle.

### 4.4 npm package pre-pull and PIN policy (Path C only)

[VERIFIED 2026-05-27 audit] — the adapter is a stdio MCP server with no
`--help` flag; it hangs waiting for protocol input on stdin. The "pre-pull
via `npm exec --yes -- @worldcoin/toolrouter --help`" pattern from the first
draft of this PRD does NOT work.

The correct approach mirrors how we pin OpenClaw and gbrain: **global install
at a known-good version**, not `npx -y` float.

In `configureOpenClaw`'s setup block, add an idempotent step:

```bash
NVM_DIR="$HOME/.nvm" source "$HOME/.nvm/nvm.sh"
# Pin in lib/ssh.ts: TOOLROUTER_PINNED_VERSION = "0.x.y"
INSTALLED=$(npm list -g --depth=0 2>/dev/null | grep "@worldcoin/toolrouter@" | sed 's/.*@worldcoin\/toolrouter@//')
if [ "$INSTALLED" != "$TOOLROUTER_PINNED_VERSION" ]; then
  npm install -g "@worldcoin/toolrouter@$TOOLROUTER_PINNED_VERSION" 2>&1 | tail -3
fi
# Verify-after-write: binary resolves AND the package.json reports expected version
test -e "$(npm root -g)/@worldcoin/toolrouter/package.json" || { echo "FATAL_TOOLROUTER_INSTALL"; exit 1; }
ACTUAL=$(jq -r .version "$(npm root -g)/@worldcoin/toolrouter/package.json")
[ "$ACTUAL" = "$TOOLROUTER_PINNED_VERSION" ] || { echo "FATAL_TOOLROUTER_VERSION_DRIFT actual=$ACTUAL expected=$TOOLROUTER_PINNED_VERSION"; exit 1; }
```

The Path C disk shape THEN uses the absolute path (or just `toolrouter` once
the global bin is on PATH) instead of `npx -y`:

```json
"mcp": {
  "servers": {
    "toolrouter": {
      "command": "toolrouter",
      "args": [],
      "env": {
        "TOOLROUTER_API_KEY": "tr_...",
        "TOOLROUTER_API_URL": "https://toolrouter.world"
      }
    }
  }
}
```

`npx -y @worldcoin/toolrouter` (Andy's published quickstart shape) floats
to latest on every cold start — UNDESIRABLE on a managed fleet. We pin
explicitly so a bad upstream release doesn't reach paying customers without
a Rule 64 approval. See Q8 below for the pin-version bump policy.

**Initial pin value (verified at PRD time, 2026-05-27 via `npm view
@worldcoin/toolrouter version`)**: `0.1.3`. Lock `TOOLROUTER_PINNED_VERSION
= "0.1.3"` in `lib/ssh.ts` at implementation time. **CRITICAL: the
implementer MUST re-run `npm view @worldcoin/toolrouter version` at the
moment of implementation and lock to that exact value. DO NOT use
"latest" as the pin. DO NOT use the 0.1.3 value above if newer is
available — re-verify the current version and pin to that.** Future
bumps go through the Rule 64 vm-canary + Cooper-approval flow.

### 4.5 Reconciler step shape

```typescript
// lib/vm-reconcile.ts (new step, called after stepIndexProvision)
async function stepToolRouter(
  ssh: NodeSSH,
  vm: VM,
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
): Promise<void> {
  // Gate 1: feature flag (Rule 61 boolean env var)
  if (process.env.TOOLROUTER_ENABLED !== "true") {
    return; // not enabled; silent skip per Rule 61's warn-on-misconfigured pattern
  }

  // Gate 2: API key present in process env (per Rule 49 verifier)
  const apiKey = process.env.TOOLROUTER_API_KEY;
  if (!apiKey || !apiKey.startsWith("tr_") || apiKey.length < 16) {
    result.warnings.push("stepToolRouter: TOOLROUTER_API_KEY not present or malformed");
    return; // soft-skip per Rule 39 (paid SaaS is non-critical)
  }

  // Gate 3: read current mcp.servers.toolrouter from disk.
  // [VERIFIED 2026-05-27 audit] — the discriminating field differs by transport:
  //   stdio:           .mcp.servers.toolrouter.command  must equal "toolrouter"
  //   streamable-http: .mcp.servers.toolrouter.transport must equal "streamable-http"
  // Reading just one will false-negative; we read both and pick the one the
  // configured transport says we want.
  const transport = (process.env.TOOLROUTER_TRANSPORT === "streamable-http")
    ? "streamable-http"
    : "stdio";
  const expected = buildToolRouterMcpConfig(apiKey, transport);
  const discriminatingField = transport === "stdio" ? ".command" : ".transport";
  const expectedValue = transport === "stdio" ? "toolrouter" : "streamable-http";
  const probe = await ssh.execCommand(
    `jq -r '.mcp.servers.toolrouter${discriminatingField} // ""' "$HOME/.openclaw/openclaw.json" 2>/dev/null`,
  );
  const probedValue = (probe.stdout || "").trim();
  if (probedValue === expectedValue) {
    // Deep equality check on the full shape — discriminating field matching
    // is necessary but not sufficient. mirrors stepIndexProvision lines 2522-2538.
    const full = await ssh.execCommand(
      'jq -c ".mcp.servers.toolrouter" "$HOME/.openclaw/openclaw.json" 2>/dev/null',
    );
    if (deepEqualsMcpConfig(full.stdout, expected)) {
      result.alreadyCorrect.push("toolrouter: mcp.servers.toolrouter matches");
      return;
    }
  }

  // Gate 4: write via `openclaw mcp set` (hot-reloadable, merge semantics).
  // Use the tempfile+stdin pattern from stepIndexProvision lines 2676-2691
  // (avoid argv quoting; chmod 600; rm in same shell).
  if (dryRun) {
    result.fixed.push("[dry-run] toolrouter: would write mcp.servers.toolrouter");
    return;
  }
  const mcpJson = JSON.stringify(expected);
  const tmpPath = `/tmp/toolrouter-mcp-${vm.id}.json`;
  const upload = await ssh.execCommand(
    `cat > ${tmpPath} && chmod 600 ${tmpPath}`,
    { stdin: mcpJson },
  );
  if (upload.code !== 0) {
    recordHealWarning(result, `toolrouter: upload mcp.json failed code=${upload.code}`);
    return;
  }
  const setCmd = await ssh.execCommand(
    `${NVM_PREAMBLE} && openclaw mcp set toolrouter "$(cat ${tmpPath})" 2>&1; SET_RC=$?; rm -f ${tmpPath}; exit $SET_RC`,
  );
  if (setCmd.code !== 0) {
    recordHealWarning(result, `toolrouter: openclaw mcp set failed code=${setCmd.code} ${(setCmd.stdout || "").slice(-200)}`);
    return;
  }

  // Gate 5: verify-after-set per Rule 10 + Rule 32 §3.
  // Re-read the discriminating field; same pattern as stepIndexProvision:2705-2715.
  const verify = await ssh.execCommand(
    `jq -r '.mcp.servers.toolrouter${discriminatingField} // "MISSING"' "$HOME/.openclaw/openclaw.json"`,
  );
  const verifyValue = (verify.stdout || "").trim();
  if (verifyValue !== expectedValue) {
    recordHealWarning(result, `toolrouter: verify-after-set failed (disk=${verifyValue.slice(0, 50)})`);
    return;
  }

  result.fixed.push(`toolrouter: deployed mcp.servers.toolrouter (transport=${transport})`);
}
```

Per Rule 39 (failure classification): API-key missing, shape malformed,
write retryable failure → `result.warnings`, doesn't block `config_version`
bump. Only hard schema/verify failures push to `result.errors` (those
indicate a real bug we want to halt on).

Per Rule 27 (coverage script): `scripts/_coverage-toolrouter.ts` samples 5
VMs and verifies (a) `.env` has `TOOLROUTER_API_KEY` present + matches Vercel
SoT, (b) `openclaw.json` has the expected `mcp.servers.toolrouter` shape.

Per Rule 47 (continuous reconciliation): no manifest version bump needed
unless the WRITTEN content changes. Adding the step itself does require
a manifest bump so existing-at-current-cv VMs re-enter the reconcile queue
(see Rule 47 reference). Pair with the file-drift cron for any future
template content.

### 4.6 Onboarding flow change

For new signups (post-v1 ship), `configureOpenClaw` should:

1. Write `TOOLROUTER_API_KEY=<from-env>` to `~/.openclaw/.env` (atomic
   write per Rule 38).
2. Call `openclaw mcp set toolrouter '...'` with Path C shape.
3. Pre-pull `@worldcoin/toolrouter` via `npm exec` (best-effort).

No DB column changes are needed if we use a single platform key. If §6 Q1
resolves to "per-VM sub-keys", we'd add `instaclaw_vms.toolrouter_subkey
TEXT` per the same migration discipline as Index Network (Rule 56:
pending_migrations → Studio apply → migrations).

### 4.7 SOUL.md / AGENTS.md routing

Add a small routing block in V2 templates (under the `bootstrapMaxChars`
budget per `feedback_skill_size_budget.md`):

```markdown
## Paid SaaS Tools (ToolRouter)

When the user asks for something that needs paid third-party tools, use the
ToolRouter MCP server. Discovery: `toolrouter_list_endpoints`. Common ones:

| Intent                         | Tool                                |
|--------------------------------|-------------------------------------|
| Web search (curated, paid)     | `exa_search` or `toolrouter_search` |
| Long-form research             | `manus_research_start` (async)      |
| Browser session in cloud       | `browserbase_session_create`        |
| Send email                     | `toolrouter_send_email`             |
| Web page extract               | `toolrouter_call_endpoint("parallel.extract", ...)` |

Local alternatives exist for some (e.g., `chromium` for browser, `curl` for
search). Prefer local when free; reach for ToolRouter when the cost is
worth the quality / cleanliness uplift. Each ToolRouter call costs USDC from
the platform credit balance — be deliberate.
```

Idempotency: this block is inserted via a `TOOLROUTER_ROUTING_V1` **marker**
(mirroring `SOUL_STUB_EDGE_MARKER` and `stepRewriteSoulPartnerSections` in
`lib/vm-reconcile.ts:830`). [VERIFIED 2026-05-27 audit] — this is a marker
pattern, NOT Rule 23's `requiredSentinels` (those guard
`vm-manifest.ts:files[]` entries against stale-module-cache regressions in
long-running reconcilers; ToolRouter v1 doesn't add any such files, so
Rule 23 sentinels don't directly apply here. The first PRD draft conflated
the two — corrected here).

### 4.8 AgentBook registration (one-time setup, gates the AgentKit moat)

[VERIFIED 2026-05-27 from `agents.md` lines 165-178 + `probe-agentkit-exa.mjs`.]

The platform-key model's AgentKit benefits depend on the underlying
Crossmint agent wallet being registered on the World Chain AgentBook
contract. Without this one-time registration, every AgentKit-eligible
endpoint falls through to x402-paid (Scenario B).

**Sequence**:

1. Cooper creates a ToolRouter account at `toolrouter.world` (Supabase
   Auth + magic link). Supabase Auth uses Resend SMTP per `agents.md`.
2. Dashboard silently bootstraps a Crossmint agent wallet
   (`owner: email:coopergrantwrenn@gmail.com`, alias
   `tr-agent-<sha256(user_id)[0:27]>`). Address returned to Cooper.
3. Cooper runs `npx @worldcoin/agentkit-cli register <agent-address>`:
   - CLI prepares an AgentBook nonce + World ID signal server-side
     (`solidityEncode(["address", "uint256"], [agentAddress, nonce])`).
   - World App proof verification (one tap on Cooper's phone).
   - Proof submitted to hosted relay → AgentBook contract receives
     `register(agentAddress, nonce, proof)` call → contract maps
     `agentAddress → human_id`.
   - Status verifiable via `lookupHuman(agentAddress)` returning Cooper's
     human_id.
4. Cooper generates the `tr_...` API key in the dashboard.
5. We distribute the key via `SECRET_ENV_VAR_SOURCES` (Task B). Every
   InstaClaw VM uses the same key → every call benefits from Cooper's
   AgentBook registration.

**Important**: per `agents.md`:
*"AgentKit account registration should follow the same Step 2 flow as
`npx @worldcoin/agentkit-cli register <agent-address>`: prepare an
AgentBook nonce and World ID signal server-side, let the browser
complete World App verification, then submit the proof to the hosted
relay."*

The dashboard at toolrouter.world has UI for this flow at
`/v1/agentkit/account-verification`. **Cooper's ONE click in his
ToolRouter dashboard, on his phone with the World App installed, gates
the AgentKit benefits for all 150 VMs simultaneously.**

**Verification probe**: after registration, `scripts/probe-agentkit-exa.mjs`
output should NOT print "wallet is NOT registered as an agent — free
trial impossible." Instead it should print the `humanId on World Chain
AgentBook`. Our pre-deploy verifier should mirror this check.

**Failure recovery**: if registration somehow doesn't take, the AgentKit
path 402s, and we just fall through to x402. Customer-visible: nothing.
Cost-visible: Scenario A → Scenario B (~10x more expensive). Operator-
visible: every reconcile-cycle probe via the partner-secret verifier
notices the missing registration and alerts.

### 4.9 Admin observability

[REVISED 2026-05-27 with verified path classification.]

ToolRouter's request response includes `path` ∈ {`agentkit`,
`agentkit_to_x402`, `x402`, `dev_stub`, `timeout`} and `charged: bool`.
Our observability MUST track these separately — collapsing them into
"total calls" hides the AgentKit moat (or its absence).

**Defensive layer**:

1. **Per-call logging** (every ToolRouter call). The wrapper at
   `lib/toolrouter-client.ts` logs to a `instaclaw_toolrouter_call_log`
   table:
   ```
   (vm_id, user_id, ts, endpoint_id, path, charged,
    amount_usd, latency_ms, http_code, error_class)
   ```
   `path = "agentkit"` rows are FREE (AgentKit boost realized).
   `path = "agentkit_to_x402"` rows are PAID (boost exhausted /
   not entitled / Cooper didn't register). `path = "x402"` rows
   are PAID on endpoints with no AgentKit support.
2. **Aggregate dashboard**. Daily report broken out by path:
   - `% calls on path "agentkit"` — the AgentKit utilization rate.
     **Healthy = high.** If this drops, our moat is leaking.
   - `path "agentkit_to_x402"` count — flag: free-trial cap exhausted.
   - `path "x402"` cost — straight COGS.
3. **Pre-action balance check**: every reconcile cycle calls
   `verifyToolRouterCredentials()` (the Rule 49 verifier). It hits the
   account-info endpoint (Q6), gets remaining credit balance, persists.
4. **Alert thresholds** (per Rule 67 pattern):
   - **WARN** at 7 days estimated runway (balance ÷ 7-day spend).
   - **P1** at 3 days runway.
   - **P0** at <24h runway, daily-deduped via `instaclaw_admin_alert_log`.
   - **NEW WARN** if `% on path "agentkit"` for Exa/Manus drops below
     80% over 24h. Catches AgentBook deregistration / Exa cap exhaustion
     in real time.
5. **AgentBook status probe**: hourly cron pings the AgentBook contract
   via `lookupHuman(<our-wallet>)` on World Chain (`eip155:480`). If
   returns null → registration lost → P0 alert.
6. **Auto-top-up** (v1.5+): if ToolRouter exposes a programmatic top-up
   API AND we authorize it, set a floor and auto-replenish from a CDP-
   managed wallet. Mirrors the v1.5 Sub Account pattern.

**Per-call cost surface** (per Rule 27 coverage script): also emit a
daily report broken out by user × tool × path. Highlights "user X spent
$Y on Z tool last week" patterns — essential for the §15.5 daily-cap
enforcement and for §5.4's measure-then-decide phase.

---

## 5. v1 / v1.5 / v2 Spec Summaries

### 5.1 v1 — Universal ToolRouter Access (this week, gated)

**Goal**: every assigned VM has `mcp.servers.toolrouter` wired with a valid
key. When a user asks for paid SaaS tools (search, research, browser, email,
travel), the agent reaches for ToolRouter naturally.

**Preconditions** (cannot ship without):
- **Q1 resolves**: API key issued (or self-signup confirmed as the path).
  Without a valid `tr_...` value to set in Vercel, every reconcile cycle
  no-ops the wiring.
- **Q6 resolves**: canonical "ping with my key" endpoint identified so
  the Rule 49 verifier in `lib/partner-secrets.ts` can do a live smoke
  test. Shape check alone is a 60% solution — see §1.4 of CLAUDE.md
  Rule 49 for why shape-only checks miss the operator-error class.
- **Q8 resolves OR we pick a pin version unilaterally**: the
  `TOOLROUTER_PINNED_VERSION` constant needs a real value, not "latest."

**NOT preconditions** (nice-to-have for operator decisions but don't
block v1 code from shipping):
- Q2 (hosted streamable-http endpoint): v1 path C works on stdio today.
- Q5 (pricing transparency): credit balance + admin alerting suffice
  for v1; full pricing data feeds the v1.5 cost-attribution dashboard.
- Q3 (AgentKit boost): if delegation is required we ship without it
  and pay rack rates until Cooper wires World ID delegation.

**Ships**:
1. `TOOLROUTER_API_KEY` in Vercel env (production + preview).
2. Entry in `SECRET_ENV_VAR_SOURCES` in `lib/vm-reconcile.ts` (with `vercelKey`
   if needed; assumed not).
3. `TOOLROUTER_ENABLED` boolean env var (Rule 61) — defaults false until
   precondition gates clear.
4. `TOOLROUTER_TRANSPORT` enum env var (`stdio` | `streamable-http`),
   defaults `stdio`.
5. `lib/toolrouter-client.ts` — helper to `buildToolRouterMcpConfig()` for
   both transports. Mirrors `lib/index-network-client.ts:buildIndexMcpConfig`.
6. New reconciler step `stepToolRouter` in `lib/vm-reconcile.ts` (§4.5).
7. Verifier in `lib/partner-secrets.ts` per Rule 49.
8. SOUL.md / AGENTS.md routing block per §4.7 (V1 supplement + V2 template).
9. Coverage script `scripts/_coverage-toolrouter.ts` per Rule 27.
10. npm pre-pull in `configureOpenClaw` (§4.4).
11. Admin alerting per §4.8 (basic version: WARN at low balance, no auto-top-up).
12. Probe cron updated to include the ToolRouter endpoint URL guess list (per
    the Base MCP `probe-base-skills-registry` pattern — detects when Andy ships
    the streamable-http endpoint).

**v1 done-when** (mirrors Base MCP §4.7 structure):
- API key issued + verified working via `_verify-partner-secrets.ts`
- `stepToolRouter` lands in reconciler with unit test coverage
- the active canary VM: send Cooper's test prompt "search for the latest Edge
  Esmeralda news using a paid search" — agent uses `exa_search` or
  `toolrouter_search`, returns sensible result in <30s. Cost <$0.05.
- Cooper sends a real production-flow query — "research the top 3 base
  agent skill plugins shipped this week" — agent uses
  `manus_research_start` → polls status → returns synthesized result.
  Latency reasonable, cost reasonable.
- Per Rule 64: Cooper explicitly approves "ship to fleet."
- Manifest bumped + deployed; coverage script returns 5/5 VMs with
  `mcp.servers.toolrouter` present and shape-correct.

### 5.2 v1.5 — Attribution + Auto-Top-Up (1-2 weeks, depends on Andy)

**Goal**: per-VM cost attribution + automated credit replenishment + admin
dashboard visibility into ToolRouter spend.

**Depends on Andy resolving**:
- §6 Q1: do per-VM sub-keys exist? If yes, mint one per VM.
- §6 Q4: is there a programmatic top-up API? If yes, automate.
- §6 Q5: rate limits per key? Inform our circuit-breaker shape.

**Ships** (conditional on above):
- If sub-keys exist: migration `<ts>_vm_toolrouter_subkey.sql` adding
  `instaclaw_vms.toolrouter_api_key TEXT`. New helper
  `provisionToolRouterSubKey(vm)`. Reconciler step provisions per VM
  (same idempotency pattern as `stepIndexProvision` — DB-cache first to
  avoid orphan keys, per Index Network and Rule 66 lessons).
- If top-up API exists: cron `provision-toolrouter-credits` that replenishes
  when balance < $X (per Rule 49 partner-secret verifier pattern).
- Admin dashboard widget: per-VM spend over the last 7d, fleet-aggregate
  category histogram, current balance + runway estimate.

### 5.3 The sponsored-tier framing — World sponsors the baseline, we monetize the overflow

[REVISED 2026-05-27 PM-3 after Cooper's reframe. The OLD framing
"InstaClaw charges users for premium tools" is wrong. The CORRECT
framing is: **World sponsors a generous free tier of premium tools
for every InstaClaw user via AgentKit. Most users never need more.
Power users can buy more from us.**

This isn't cosmetic — it changes the copy, the allocation structure,
the unit of account, the decision tree the agent runs, and the
upsell margin model. The earlier drafts in this section have been
superseded by §5.3.0-§5.3.7 below. Where the older drafts conflict,
this section is canonical.]

#### 5.3.0 The mental model

```
┌─────────────────────────────────────────────────────────────────┐
│ EVERY INSTACLAW PLAN INCLUDES:                                   │
│                                                                  │
│   "Premium tools sponsored by our World Foundation partnership"  │
│                                                                  │
│   Starter:  60 premium searches / month included                 │
│   Pro:     400 premium searches / month included                 │
│   Power:  1500 premium searches / month included                 │
│                                                                  │
│   Powered by AgentKit. Most users never exceed their included    │
│   tier. (Modeled median usage: well under 50% of allocation.)    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (only the long-tail of heavy users)
┌─────────────────────────────────────────────────────────────────┐
│ NEED MORE? Add a premium search pack.                            │
│                                                                  │
│   100 premium searches — $10                                     │
│                                                                  │
│   No subscription change. No commitment. Stacks on top of next   │
│   month's allocation.                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (abuse ceiling, not user-facing)
┌─────────────────────────────────────────────────────────────────┐
│ DAILY HARD CAP (§15.5): $0.50 / $5 / $20 by tier per day.        │
│                                                                  │
│ Pure security limit. Hit = synthetic "tool unavailable" + free   │
│ local fallback. Never appears in user-facing UX.                 │
└─────────────────────────────────────────────────────────────────┘
```

The user experiences ONE thing: an included free tier of premium
tools. If they ever exceed it (~10-15% of users by design), the agent
offers a clean, optional top-up. The platform makes its margin on
top-ups; AgentKit/World absorbs the cost of the included tier; the
narrative is "we partner with World to make premium tools free for
most users." No paywall, no metering, no friction. **Want more of a
good thing? Sure, $10.**

#### 5.3.1 Why this composition (the reasoning chain)

- **InstaClaw already has in-chat upsell infrastructure** (Higgsfield
  video credit checks, the mini-app paused banner, Stripe credit-pack
  SKUs at `app/api/billing/credit-pack/route.ts`). Extending what works
  beats deferring measurement.
- **The in-chat micro-upsell is a competitive advantage in its own
  right.** Each limit-hit is a teaching moment AND a low-friction
  monetization moment. Stripe's "press 1 button to add more" UX
  converts well; ChatGPT's "go to your account page on the web" UX
  doesn't.
- **The §15.5 daily cap stays as the abuse ceiling ABOVE the
  allocation.** Two layers: allocation = commercial transparency,
  daily cap = pure security. They never conflict because the daily
  cap is ALWAYS set above any plausible legitimate usage.
- **World sponsors the included tier; we monetize the overflow.** This
  is the framing that makes the feature genuinely different from a
  SaaS paywall. AgentKit-verified free path = sponsored by World. Paid
  path within allocation = sponsored by InstaClaw (absorbed COGS).
  Top-up = funded by the user. Three layers of who-pays, all transparent.

This is the cleanest version of the agentic-economy thesis we've shipped:
the user pays for the platform; the platform pays for premium tools up
to a threshold; the World partnership absorbs the largest chunk of that
threshold via AgentKit; the user opts in to pay for more only when they
genuinely want more. Three economic layers, three distinct stories,
zero friction at the user surface for the median experience.

#### 5.3.2 Included allocations — calibrated to ~2x median usage so most users never see the upsell

Per Cooper's reframe: if 80% of users hit the upsell every month, it
feels like a gotcha. If 10-15% hit it, it feels like a power-user
feature. We size the included tier at ~2x the modeled-median monthly
usage from §15.3, ensuring the median user on each plan NEVER
exhausts their allocation.

| Tier | Included / month | §15.3 modeled monthly | Headroom multiple | Equivalent if used entirely as... |
|---|---|---|---|---|
| Starter ($29) | **60 premium searches** | ~30 Exa + minimal other | 2x | 60 Exa, OR 12 Browserbase, OR 4 Manus deep, OR 20 Parallel search |
| Pro ($99) | **400 premium searches** | ~200 Exa + 2 Manus + 2 Browserbase | 2x | 400 Exa, OR 80 Browserbase, OR 26 Manus deep, OR 130 AgentMail send |
| Power ($299) | **1500 premium searches** | ~800 Exa + 8 Manus + 10 Browserbase | 2x | 1500 Exa, OR 500 Browserbase, OR 100 Manus deep, OR 6.6 high-cost AgentMail inbox creations |

**The "premium searches" unit** is a deliberate UX simplification.
Internally, calls are weighted (Exa = 1, Manus deep = 15, Browserbase
= 3, etc. — see §5.3.8 weight table). User-facing copy and dashboard
expose ONE number ("you have 47 premium searches remaining") that
auto-adjusts based on which tools they used. Same Higgsfield pattern:
the user sees "80 credits per video" without needing to internalize
the weight system.

**Why "premium searches" not "credits"**: matches Cooper's reframe.
"Credits" sound metered. "Premium searches you get this month" sound
sponsored. The internal data model is still an integer balance with a
per-endpoint weight (mirrors Higgsfield exactly), but the user-facing
unit is named for the canonical use case (search) and framed as
included value.

**Tunability**: stored on `instaclaw_users` (NOT `instaclaw_vms` —
allocation survives VM reassignment / freeze-thaw). Per-user override
column lets operators raise individual allocations for heavy-but-
paying users. Admin route at `app/api/admin/users/[userId]/toolrouter`.

#### 5.3.2a Copy workshop — research-grounded, voice-locked (2026-05-27 PM-4)

[Cooper's PM-4 feedback: the §5.3.3 lock-1 copy was "correct
mechanically but had no soul. reads like a system message from a
billing API, not like something a personality-rich agent would say."
This sub-section documents the candidate workshop (25 variants × 5
message types × 5 principles) + voice-research + behavioral-econ
research that fed the LOCKED copy in §5.3.3. Keep for forensic
trail when copy is revised later.]

##### Voice anchors (binding for all candidates)

Drawn from the locked sources: `lib/welcome-messages.ts` (the three
welcome messages — "every word earned its place through ~10 rounds
of editing"), V2 SOUL.md `## Vibe` + `## Core Truths` blocks,
Higgsfield video's Rule 4 transparency message, and Cooper's
voice-feedback memo (`memory/feedback_no_em_dashes.md` + the
"lowercase, no emojis, confident, no over-explanation, no
groveling" rules).

| Voice rule | Evidence in canon |
|---|---|
| Lowercase except proper nouns | All three welcome messages |
| No em-dashes | `feedback_no_em_dashes.md` |
| No "great question!" / "I'd be happy to help" | SOUL.md V2 line 295 |
| Has opinions | SOUL.md V2 line 297 ("Have opinions. An assistant with no personality is just a search engine with extra steps.") |
| Concrete sensory language | Welcome 1: "browser, terminal, file system" |
| Confident, not hedged | Welcome 1: "i'll be ready to actually do things for you, not just talk about it" |
| Intimate first-person plural | "you and me", "we've been..." |
| Cost transparency = specific number + balance + ask | Higgsfield Rule 4: "This video will use about 80 credits. You have 420 remaining." |
| No emojis | Cooper memory rule |
| Sentence breaks as pacing, not punctuation | Welcome 1's rhythm |

##### Conversion-research priors (binding for choice rationale)

| Principle | Source | Effect size |
|---|---|---|
| Loss aversion (Prospect Theory) | Kahneman; multiple HBR studies | Losses felt ~2x stronger than gains. Loss-framed copy: +21-32% conversion |
| Endowment effect | HBR study on free trial conversion | Brief ownership → 32% more likely to convert |
| Usage-alert loss-framing | SaaS conversion data | +30% conversion when proactive low-balance alerts shipped |
| Specificity > vagueness | Multiple sources | "Clearly communicated savings improve conversion by up to 20%" |
| Choice architecture (defaults) | Field studies | Setting one option as default → 43% lift; status quo bias powerful |
| Two-option vs single-option | Prospeo guide | 2-3 options ideal; more than 3 → decision paralysis |
| Value-moment timing | Slack, Loom, Grammarly | Upgrade prompts at hit-the-limit moment dramatically outperform email/banner upsells |

The strongest single finding: **specificity + loss-framing at the
value moment** is the conversion combo. Vagueness ("you've used
your allocation") is the worst. Specificity ("that manus deep
research would have been your 16th this month") + loss-framing
("brave search will work but it's noticeably less curated for this
kind of query") + reduced friction ("$10 takes 30 seconds, stacks
on next month") is the best.

But — and this is the key trade-off — **honest neutrality builds
long-run trust** which compounds beyond a single conversion. A
user who feels pushed once won't trust the agent's recommendations
in the future. So the copy must combine specificity + honest
loss-framing WITHOUT crossing into pressure or platform-speak.

##### Candidate workshop — 5 variants × 5 message types

The annotation format: **[principle] - why this variant**

###### Message 1: Pre-action transparency
*Fires when balance < 3× call weight AND call is expected to consume from allocation. The agent is about to make an expensive call; lets the user opt out.*

1. **[specificity + ask]** "that manus deep research counts as 15. you've got 22 left this month. want me to go?"
2. **[endowment + reciprocity]** "heads up — that's a big one. 15 of your 22 remaining premium searches. say the word and i'm on it."
3. **[loss-frame + confidence]** "deep manus research is the right call here. it'll use 15 of your 22 remaining for the month. proceeding unless you say otherwise."
4. **[social-proof + specificity]** "manus deep is what most users reach for on a query like this. it'll cost about 15 premium searches and you have 22 left. green light?"
5. **[concrete-sensory + confident]** "this is the deep one — manus, 15 premium searches. 22 left in the pool after. saying yes, but flag if not."

###### Message 2: 80% soft hint
*Proactive aside emitted ONCE per month after the call that crossed 80%. No urgency, no pitch. The user just got their result; this is a gentle footnote.*

1. **[normalize + endowment]** "p.s. you're at about 80% of this month's included premium searches. plenty for the rest of the month at current pace, just keeping you in the loop."
2. **[neutral-info]** "fyi: about 80% through your included premium searches for the month. resets [date]. nothing to do."
3. **[reciprocity + status]** "side note — you've been making good use of the premium tools this month. you're at about 80% of your included pool. just so you know."
4. **[specificity + endowment]** "you've used about 323 of your 400 included premium searches this month. should comfortably get you through to reset on [date]. no action needed."
5. **[mention-only]** "heads up: 80% through the month's premium searches. you have about 77 left. resets [date]."

###### Message 3: 100% reached (Cooper's A-E variants explicitly tested)
*The load-bearing message. User asked for something needing a paid tool. Allocation is gone. Two genuine paths.*

1. **[VARIANT A — pure neutral, Cooper's A]** "that's a manus call which would put us over this month's included premium searches. two paths from here: (a) i can do this with brave search and a few targeted curls — slower, less polished, still useful. (b) you can grab a 100-pack ($10) and i'll run the proper manus research right now. happy either way — which one?"

2. **[VARIANT B — soft social proof, Cooper's B]** "out of included premium searches for the month. for research like this, most people grab a pack because manus's output is noticeably more cited and synthesized than what i can stitch together from free tools. that said — i can still do a respectable version with brave + curl if you'd rather skip the $10. your call."

3. **[VARIANT C — loss-frame, Cooper's C]** "i can do this with free tools, but honestly? manus's deep research would give you something way better here. it's the difference between 'a summary' and 'a brief you could actually send to someone.' want me to grab a pack ($10, 100 more searches) so i can do it right? or i'll do the free version if you'd rather — your call."

4. **[VARIANT D — reciprocity, Cooper's D]** "we've been using premium tools a lot this month — manus deep, exa, browserbase — and they've been working well for you. first time we've hit the wall. $10 gets 100 more and they stack on next month's allocation. or i can do this with free tools if you'd rather hold off. what's the move?"

5. **[VARIANT E — specificity, Cooper's E]** "that manus deep research would be 15 of your premium searches and you're at 0. a 100-pack is $10 — gets you about 6 more deep research runs or ~50 exa searches before next month resets. i can do a slimmer version of this with brave search if you'd rather wait. which?"

###### Message 4: Top-up confirmed
*Post-webhook. Balance refreshed. Back to work.*

1. **[no-fanfare confident]** "got it. 100 premium searches added. running the manus research now."
2. **[brevity]** "received, 100 added. on it."
3. **[continuation]** "top-up came through. picking up where we were."
4. **[concrete + back-to-work]** "100 added — running that deep research now. shouldn't take more than a couple of minutes."
5. **[barely-acknowledge]** "added. running it now."

###### Message 5: Hard daily cap reached (§15.5 — separate from upsell)
*This is NOT an upsell. It's a daily safety limit. Free local tools still work; monthly allocation is unaffected.*

1. **[clear-distinguish]** "i've hit today's tool safety limit. that's a daily cap that protects against runaway loops, not related to your monthly premium-search pool. resets tomorrow at midnight (your time). free local tools still work for now."
2. **[brief]** "hit the daily safety cap. resets tomorrow midnight. free local tools still on."
3. **[explanatory + reassuring]** "we've used today's tool safety budget — that's a daily limit separate from your monthly premium searches. resets at midnight your time. brave search, local browser, and curl still work in the meantime."
4. **[no-anxiety]** "today's tool-safety budget is spent — separate from your monthly premium pool, just a daily ceiling. clears at midnight. free tools still go."
5. **[detail-when-asked]** "daily tool budget is spent (separate from monthly allocation — this is the abuse-protection cap). free local tools still work. fresh budget at midnight (your time)."

##### Picks + justifications

After workshopping all 25, the final picks. Voice consistency across
the five was the dominant selection criterion — they need to read
as one personality.

**Message 1 → variant 1**: *"that manus deep research counts as 15.
you've got 22 left this month. want me to go?"*
- Why: most direct mirror of Higgsfield Rule 4 ("This video will
  use about 80 credits. You have 420 remaining."). Three sentence
  fragments matching the welcome-message pacing. "want me to go?"
  is the confident-but-asking close — the agent is offering, not
  hedging. Specificity (15, 22) makes the cost real.
- Principle: specificity at the value moment. The user JUST asked
  for the deep research; the cost lands in the same breath.

**Message 2 → variant 1**: *"p.s. you're at about 80% of this
month's included premium searches. plenty for the rest of the month
at current pace, just keeping you in the loop."*
- Why: "p.s." is the conversational footnote shape this message
  needs. "plenty for the rest of the month at current pace" is the
  endowment + confidence pairing — the agent has done the math and
  the user doesn't need to worry. "just keeping you in the loop"
  echoes welcome-2's "i genuinely cannot wait to meet you" — same
  intimate-tone register.
- Principle: normalize the awareness without alarm. Endowment
  (you've been using a good thing) + confidence (you're fine).

**Message 3 → VARIANT C with one tweak (loss-frame + honest)**:
*"i can do this with free tools, but honestly? manus's deep
research would give you something way better here. it's the
difference between 'a summary' and 'a brief you could actually
send to someone.' want me to grab a pack ($10, 100 more searches)
so i can do it right? or i'll do the free version if you'd rather.
your call."*

This is the most-debated pick. Cooper laid out A-E framings; my
research said specificity + loss-framing wins, and "what do you
prefer?" / pure-neutral builds long-run trust but converts lower
in the moment.

Resolution: **VARIANT C wins because it gets BOTH the loss-frame
AND the honest neutrality.** The loss-frame is the agent's HONEST
opinion of the trade-off ("manus's deep research would give you
something way better here") — not a sales pitch. The neutrality is
in the close ("or i'll do the free version if you'd rather. your
call.") — the user can take either path without judgment. The
agent has an opinion (per SOUL.md V2 "have opinions") AND respects
the user's choice. The "brief you could actually send to someone"
line is concrete-sensory at the welcome-message register; it makes
the difference real, not abstract.

This is the agent saying what a smart friend would say: "I think
you want the $10 version, but I'll do the free one if you don't.
No judgment either way."

VARIANTS B and D were close runners-up. B's "most people grab a
pack" is good social proof but introduces other users into a
1:1 conversation, breaking the intimate frame. D's "we've been
using premium tools a lot this month" is the best of the four for
power users with an established usage history, but reads as
slightly inappropriate for a user's FIRST upsell moment (which is
the more common case at v1). C works at first hit AND for repeat
hitters.

VARIANT A (pure neutral) is the SAFE pick — Cooper's earlier draft
was essentially A. The reason to upgrade to C: the conversion
research is clear that neutral framing under-converts ~20%
vs honest opinion framing. C maintains the user's choice (so trust
doesn't erode) while contributing the agent's genuine view (so
conversion holds). Best of both.

- Principle: loss-frame at the value moment + concrete-sensory
  description of what's lost + neutral close that preserves
  user agency.

**Message 4 → variant 5**: *"added. running it now."*
- Why: shortest possible. The user just paid; the next moment
  should be value-delivery, not gratitude or system-acknowledgment.
  Two words to confirm; the agent's next action is the real "thank
  you." Higgsfield doesn't say "thank you for paying" either — it
  just runs the generation.
- Principle: friction reduction at the post-purchase moment. The
  reward for buying is IMMEDIATELY getting what you bought, not a
  modal or a celebration.

**Message 5 → variant 4**: *"today's tool-safety budget is spent
— separate from your monthly premium pool, just a daily ceiling.
clears at midnight. free tools still go."*

Wait — that has an em-dash. Rule violation. Revised:

*"today's tool-safety budget is spent. separate from your monthly
premium pool, just a daily ceiling. clears at midnight. free tools
still go."*
- Why: distinguishes from the monthly allocation in one short
  phrase ("separate from your monthly premium pool, just a daily
  ceiling"), gives the reset time, reassures that free tools work.
  "free tools still go" is the most-confident close possible — no
  "still available," just "still go."
- Principle: distinguish-clearly + reassure. This is NOT an
  upsell moment; pressure here would be wrong. The message exists
  to inform.

##### Sanity check — read all 5 in sequence

Reading the locked picks back-to-back:

> M1: "that manus deep research counts as 15. you've got 22 left this month. want me to go?"
> M2: "p.s. you're at about 80% of this month's included premium searches. plenty for the rest of the month at current pace, just keeping you in the loop."
> M3: "i can do this with free tools, but honestly? manus's deep research would give you something way better here. it's the difference between 'a summary' and 'a brief you could actually send to someone.' want me to grab a pack ($10, 100 more searches) so i can do it right? or i'll do the free version if you'd rather. your call."
> M4: "added. running it now."
> M5: "today's tool-safety budget is spent. separate from your monthly premium pool, just a daily ceiling. clears at midnight. free tools still go."

Same personality across all five:
- Lowercase, no caps. ✓
- No em-dashes. ✓ (had to fix M5)
- No emojis. ✓
- Confident, opinionated, not apologetic. ✓
- Concrete sensory language ("a brief you could actually send to
  someone"). ✓
- Brevity-where-possible (M4 is two words). ✓
- Respects user agency (M3's "your call"). ✓
- Specific numbers (M1's 15/22, M2's 80%, M3's $10/100). ✓
- Matches welcome-message register and Higgsfield Rule 4 pattern. ✓

This is one personality talking. Ship it.

#### 5.3.3 In-chat copy — the locked messages (after §5.3.2a workshop)

[Re-locked 2026-05-27 PM-5 after a second pass. Cooper resent the
copy-workshop prompt with "ultrathink" — read as a signal that PM-4
work product needed sharpening, not regurgitation. Self-audit found
five real gaps in the PM-4 lock; this PM-5 addresses each. Voice
discipline: same personality that wrote welcome-1/2/3 in
`lib/welcome-messages.ts`. Conversion discipline: loss-frame +
specificity at value moments + neutral close + user-ask reference +
read-the-room behavior. ALL strings live verbatim in the
`TOOLROUTER_BILLING_V1` marker block in
`lib/workspace-templates-v2.ts`.]

##### Five gaps the PM-4 lock had (resolved in PM-5)

1. **The variants weren't 5 distinct framings.** PM-4's M2 was five
   word-swaps of one idea. PM-5 forces each variant to use a
   genuinely different psychological lever.
2. **Didn't USE the user's specific ask.** Cooper PM-2 explicitly said
   *"the agent knows the user's name, knows what they just asked
   for. USE that context."* PM-4 said *"i can do this with free
   tools"* — generic *"this"*. PM-5 templates reference the user's
   actual ask via `{ask_phrase}` placeholder that the agent fills.
3. **Browserbase and Exa descriptor templates were weaker than
   Manus.** PM-4 had *"sort of works vs actually runs clean"* —
   vague. PM-5 ships sharper per-tool concrete-sensory phrases.
4. **Didn't address Cooper's anchoring question.** Cooper PM-2 asked
   "does 'less than a coffee' help or hurt for power users?" PM-4
   silently picked "$10" without justification. PM-5 documents the
   research: for users paying $29-299/mo, friendly anchoring reads
   as condescending. Skip it. Just say "$10."
5. **No "read the room" routing.** Research from conversational AI
   (LivePerson, Quidget): *"if user responses become short, negative,
   or dismissive, the AI can gracefully back off."* PM-4 didn't
   tell the agent how to behave AFTER the user picks free or paid.
   PM-5 adds explicit post-choice routing rules.

The voice mandate (binding, drawn from welcome-messages + SOUL.md
V2):
- Lowercase. No em-dashes. No emojis.
- "Skip 'Great question!' and 'I'd be happy to help!' — just help."
  (SOUL.md V2 line 295)
- Have opinions (SOUL.md V2 line 297). The agent's HONEST view of
  the free-vs-paid trade-off is the right thing to share, not
  neutral platform-speak.
- Specific numbers, not vague abstractions.
- Brevity where possible. The post-purchase message is two words.
- The agent's NEXT ACTION is the real thank-you, not the message.

**Pre-action transparency** — Higgsfield Rule 4 mirror. Emit ONLY
when remaining < 3× call weight AND call will consume from
allocation. For `charged: false` calls (most Exa searches), agent
does NOT emit — sponsored.

PM-5 version (references user's ask):

> "that {ask_phrase} would be {weight} of your premium searches. you've got {remaining} left this month. say the word."

Example fill-in for "research the top 10 AI infra startups in NYC":
*"that NYC AI infra startup dive would be 15 of your premium searches. you've got 22 left this month. say the word."*

Voice notes: *"say the word"* is intentional — it's the agent
asking permission AS a casual offering, not requesting authorization.
Matches welcome-1's *"just text me"* register.

**80% soft hint** — proactive aside, emit ONCE per month. Tagged
onto end of a normal response. Five PM-5 variants tested:

- *Variant 1 (endowment + confidence)*: "p.s. you're at about 80% of this month's included premium searches. at the pace you've been going, plenty to get you through to {reset_date}."
- *Variant 2 (specificity + projection)*: "btw — you've used about {used} of your {grant} included premium searches this month. on track to land around {projected} by reset on {reset_date}, so you're fine."
- *Variant 3 (work-recap)*: "p.s. that puts you around 80% through this month's included premium searches. mostly manus research and a couple browserbase sessions. just so you know."
- *Variant 4 (reset-anchor)*: "side note: about 80% through your premium searches for the month. {days_to_reset} days till reset. should be fine at current pace."
- *Variant 5 (minimal)*: "btw, ~80% through premium searches for the month. resets {reset_date}."

PM-5 pick: **Variant 3** (work-recap). Why: it references what the
user has been DOING ("manus research and a couple browserbase
sessions"), which is the most personal-feeling specificity. The
agent shows it knows the user's pattern. Welcome-1 set the precedent
for sensory specificity ("browser, terminal, file system"); this
matches.

> "p.s. that puts you around 80% through this month's included premium searches. mostly {top_two_tools_used}. just so you know."

Example: *"p.s. that puts you around 80% through this month's included premium searches. mostly manus research and a couple browserbase sessions. just so you know."*

**100% reached** — the load-bearing one. Wrapper returned
`{allowed: false}`. PM-5 sharpens with user-ask reference, sharper
per-tool descriptors, and explicit read-the-room post-choice
routing.

> "i can do {ask_phrase} with free tools, but honestly? {tool_name} would give you something way better here. {tool_loss_frame} want me to grab a pack ($10, 100 more searches) so i can do this right? or i'll do the free version if you'd rather. your call."

Per-tool concrete-sensory templates (PM-5 — sharpened):

| Tool | `{tool_loss_frame}` |
|---|---|
| Manus deep research | "it's the difference between 'a quick summary' and 'a brief you could actually send to someone.'" |
| Manus standard/quick | "it'll be more cited and synthesized than what i can stitch together from brave + a few curls." |
| Exa search | "exa's better at finding the right thing on the first try; brave will get there but might take 2-3 follow-ups from me." |
| Browserbase | "browserbase gives a clean, isolated session — local browser works but it'll leave traces and might trip a bot-check on the site." |
| Parallel task | "parallel does this end-to-end with structured citations; the free version is me chaining tools manually, slower and rougher." |
| AgentMail (send) | "this one's tricky: there's no good free version of email send. either pack or i tell you what to copy-paste into your own mail client." |
| AgentMail (read) | "list/get inbox doesn't cost premium searches — keep going freely." |
| StableTravel | "there's no free travel API i can hit reliably; either pack or i can dig up direct URLs you'd book yourself." |

Example fill-in for Manus deep research on NYC AI infra:

> "i can do the NYC AI infra startup dive with free tools, but honestly? manus deep research would give you something way better here. it's the difference between 'a quick summary' and 'a brief you could actually send to someone.' want me to grab a pack ($10, 100 more searches) so i can do this right? or i'll do the free version if you'd rather. your call."

**Read-the-room post-choice routing** (PM-5 add — drawn from
conversational-AI research):

- User picks PAID → run the call immediately, no celebration. The
  M4 message ("added. running it now.") is the only follow-up.
- User picks FREE → commit fully. Don't mention the paid path
  again in this conversation. Don't re-hint at "if you change your
  mind." Just do the work well with free tools.
- User is short or dismissive ("just use free") → SAME as picking
  free. No follow-up nudge.
- User asks "is this worth $10?" → answer the question honestly
  ONE time (per per-tool descriptors above), then return to "your
  call."
- User says "wait, do this" without specifying → default to PAID
  if remaining=0 (because the upsell is for THIS specific call and
  silence after the prompt is closer to "go ahead and do the right
  thing" than "do the free version"). This is a judgment call;
  IDENTITY.md per-user customization can override.

**Top-up confirmed** — post-webhook. Two PM-5 variants:

- *Variant A (PM-4 pick)*: "added. running it now."
- *Variant B (PM-5 alternate)*: "100 added. running {ask_phrase} now."

PM-5 pick: **Variant B**. Why: PM-4's "added. running it now." was
correctly brief but TOO ambiguous about what was added. Variant B
adds 5 words of specificity ("100 added" + "{ask_phrase}") that
confirm both the purchase landed AND that the original task is
now resuming. Still under 10 words. The user paid; they want to
hear that (a) we got it, (b) we're on the thing they actually wanted.

> "100 added. running {ask_phrase} now."

Example: *"100 added. running the NYC startup dive now."*

**Hard daily cap reached** — §15.5 abuse ceiling. NOT an upsell.

> "today's tool-safety budget is spent. separate from your monthly premium pool, just a daily ceiling. clears at midnight. free tools still go."

(PM-4 pick stands. The five variants in §5.3.2a all said
essentially the same thing; pick 4 with em-dash fix.)

##### Template-vs-literal consistency contract (Issue 9 resolution)

[Added 2026-05-27 PM-6. Every implementer reading this section must
follow this contract exactly when building the
`TOOLROUTER_BILLING_V1` marker block in `lib/workspace-templates-v2.ts`:]

- **Locked form** (what ships in the marker block) uses
  `{placeholder}` syntax for every user-specific value the agent
  must fill at runtime. The placeholders are: `{ask_phrase}`,
  `{weight}`, `{remaining}`, `{tool_name}`, `{tool_loss_frame}`,
  `{top_two_tools_used}`, `{reset_date}`. All other words are
  literal.
- **Example fill-in** (shown in italics below each locked block)
  is what the agent would actually emit after filling the
  placeholders. The example uses a specific scenario ("NYC AI
  infra startup dive", "manus deep research", "manus research and
  a couple browserbase sessions") for clarity. The example is NOT
  what gets shipped; the template above it is.
- **M5** (daily cap) has NO placeholders because the message
  references no user-specific data. The locked form and the
  example fill-in are identical for M5 — that's intentional, not
  a consistency bug.
- **80%** in M2 is a LITERAL number (the threshold name), not a
  placeholder. If we change the threshold in the future,
  `SOFT_HINT_THRESHOLD` in `lib/toolrouter-credits.ts` updates AND
  the M2 string updates manually. Not auto-derived.

##### Marker block size estimate (Issue 11 verification)

The full `TOOLROUTER_BILLING_V1` marker block contents:
- M1 template + voice note (~280 chars)
- M2 template + variant 3 pick rationale (~250 chars)
- M3 template + 8 per-tool descriptors (~700 chars)
- M3 read-the-room post-choice routing (~300 chars)
- M4 template (~50 chars)
- M5 template (~150 chars)
- Decision tree summary (steps 1, 2, 2.5, 3) (~400 chars)
- Voice rules summary (~150 chars)
- Free-fallback hints (~200 chars)

Total estimated: **~2,480 chars**. Within Cooper's approved 5,200-char
headroom. PM-4 approval was at ~900 chars; PM-5 added ~600 chars of
per-tool descriptor templates + read-the-room routing; PM-6 added
~150 chars for the §5.3.6 Step 2.5 silent-fallback rule. The
expansion is justified — the marker is doing more work than a
typical marker (5 messages + 8 tool descriptors + decision tree +
voice rules + 5 routing-decision rules + silent-fallback behavior).
Implementer should verify the final size against the
`bootstrapMaxChars` budget at deploy time per the OpenClaw upgrade
playbook in CLAUDE.md.

##### Why these PM-5 picks read as one personality (sanity check)

Read in sequence with example fill-ins:

> M1 (pre-action): *"that NYC AI infra startup dive would be 15 of your premium searches. you've got 22 left this month. say the word."*
> M2 (80% hint): *"p.s. that puts you around 80% through this month's included premium searches. mostly manus research and a couple browserbase sessions. just so you know."*
> M3 (100% reached): *"i can do the NYC AI infra startup dive with free tools, but honestly? manus deep research would give you something way better here. it's the difference between 'a quick summary' and 'a brief you could actually send to someone.' want me to grab a pack ($10, 100 more searches) so i can do this right? or i'll do the free version if you'd rather. your call."*
> M4 (top-up confirmed): *"100 added. running the NYC startup dive now."*
> M5 (daily cap): *"today's tool-safety budget is spent. separate from your monthly premium pool, just a daily ceiling. clears at midnight. free tools still go."*

Voice consistency check:
- Lowercase, no caps. ✓
- No em-dashes. ✓
- No emojis. ✓
- Intimate first-person, references user's actual ask. ✓ (M1, M3, M4)
- References user's actual usage pattern. ✓ (M2)
- Confident opinion ("would give you something way better"). ✓
- Concrete sensory ("a brief you could actually send to someone"). ✓
- Brevity-when-possible (M4 is 7 words). ✓
- Respects user agency ("your call"). ✓
- "Say the word" / "say the word" / "your call" — same low-friction
  consent register. ✓

This is one personality talking. Same agent that sends welcome-1.

##### Why "$10" not "less than a coffee"

[Research-informed: anchoring works through reference shifts, not
friendly comparisons. For our $29-299/mo subscriber base, $10 is
obviously trivial; framing it as "less than a coffee" reads as
condescending. Power users especially hate being talked down to.
Just say "$10" plainly. The user knows what $10 is.]

##### Dashboard surface

(Small new section in `app/(dashboard)/dashboard/credits/page.tsx`,
mirrors the existing credits dashboard.)

- Card titled "Premium tools" (NOT "ToolRouter" — user-facing
  surfaces don't expose the upstream brand)
- Subtitle: "Powered by our World partnership"
- Shows: current month balance / monthly grant total / reset date
- Top-up balance shown separately ("+250 from packs")
- Button: "Add 100 — $10" → POST `/api/billing/credit-pack` with
  `{pack: "toolrouter_100"}`
- Last 20 calls table with endpoint, weight, allocation_source,
  balance after
- Sparkline: month-to-date usage trend

The dashboard is where "World" gets named once — it sets the
framing for the whole feature. Chat messages are tactical and
don't repeat the brand frame (Cooper's PM-3 mandate said "the
user should understand this is included value, not a metered
cost"; the subtitle does that once, the chat copy doesn't need
to repeat it).

**Why this set works as one voice** (sanity check — read in sequence):
the same personality that wrote *"hey. fresh linux computer
spinning up right now, just for you and me."* is the personality
that writes *"added. running it now."* and *"manus's deep research
would give you something way better here."* All five messages
share: lowercase, no em-dashes, intimate first-person, confident
opinion, concrete sensory language, specific numbers, no
sycophancy, brevity-when-possible.

**Why these messages compose well with existing copy patterns**:
- Higgsfield's "this video will use about 80 credits. you have 420
  remaining" pattern → mirrored exactly in pre-action transparency.
- Mini-app paused banner's "Agent paused — credits ran out" reactive
  pattern → REJECTED for ToolRouter (too aggressive, doesn't match
  the sponsored-tier framing).
- New proactive 80% hint → closes the P4 gap from
  `access-control-credits-upgrade.md`. Sets a pattern that should
  later backport to credit-balance.
- "what do you prefer?" at 100% → user chooses; agent doesn't push.

The 100% message is the most important one to get right. Read it
again. The two options are intentionally presented at equal voice-
weight. The free path (a) is described in concrete terms ("brave
search, local browser, curl") that signal real capability, not a
degraded experience. The paid path (b) is one short paragraph with
the exact cost and what it buys. The closing "what do you prefer?"
is the entire emotional shape of the upsell: user-led, not platform-
led.

#### 5.3.3a Free-fallback path: MUST be genuinely useful

Per Cooper's mandate ("if the free fallback is garbage, the upsell
feels like extortion"), the free-tools path the agent offers MUST
return useful results for typical user queries. This is a non-
negotiable correctness check before v1 ships.

The free fallback toolkit (all already-installed on every VM):

| When premium tool is | Free fallback | Adequacy verdict |
|---|---|---|
| Exa search (curated AI-ranked web) | Brave Search via `BRAVE_API_KEY` env (already in `SECRET_ENV_VAR_SOURCES`) | Adequate for most queries; slightly less ranked. **VERIFY** before ship. |
| Manus research (multi-hop async) | Agent chains Brave + curl + page extraction manually | Adequate for shallow research; degrades for deep multi-hop. Honest framing: "less polished." |
| Browserbase (cloud isolated browser) | Local `chromium` (installed via `configureOpenClaw`) | Equivalent for most use; dirties local state, which is fine for transient tasks. |
| Parallel extract (JS-rendered page) | Local Chromium + JavaScript-aware fetch | Equivalent. Slightly more agent work. |
| AgentMail send | Telegram notification only | Inadequate substitute — user has to manually copy/paste OR upgrade. Agent should say so honestly. |
| StableTravel | n/a | No good free path. Agent should say "i can't reliably book travel without premium tools; want to add a pack?" |

**Pre-v1 verification task** (added to Task J, the canary): Cooper
sends each free-fallback path through the active canary VM with realistic queries
("research the top 10 AI infra startups in NYC") and confirms the
agent returns a USEFUL response. If any path returns "i can't help
with this," that path's framing has to change ("here's what i can
do with free tools, but it's limited — want a pack?").

The free fallback's quality calibration is what makes the upsell
feel genuine vs extortionate. Cooper's words: *"the free path has
to be genuinely usable, just less polished than Exa/Manus."*

#### 5.3.4 Architecturally — how it composes with existing infrastructure

[REVISED 2026-05-27 PM-2 after Cooper's follow-up requiring deeper
research into the EXISTING upsell infrastructure before locking the
spec. The §5.3.3 draft above used dollars; the §5.3.4 lock uses
credits to match the canonical Higgsfield pattern. See §5.3.5 below
for the dollars-vs-credits decision rationale.]

##### Canonical pattern lookup (verified 2026-05-27)

| Layer | Existing code path | What it teaches us |
|---|---|---|
| Credit unit + weights | `lib/credit-constants.ts` + V2 templates lines 855-872 | LLM uses tier-weighted credits (Haiku 1 / Sonnet 4 / Opus 19). User thinks in credits, not dollars. |
| Persistent balance | `instaclaw_vms.credit_balance` (integer) | Single integer per VM. Top-ups add; consumption decrements via `instaclaw_check_limit_only` RPC. |
| Stripe top-up SKU pattern | `app/api/billing/credit-pack/route.ts:8-15` | 6 packs already; each maps `<slug> → {credits, label, envKey}`. `STRIPE_PRICE_MEDIA_500` is the closest sibling to what we want. |
| Webhook handler | `app/api/billing/webhook/route.ts:97-225` | Reads `metadata.type === "credit_pack"`, calls `instaclaw_add_credits()` RPC atomically. Idempotent (72.7% historical bug rate documented in comment was a separate issue). |
| Pre-action transparency | `skills/higgsfield-video/SKILL.md:50-55` Rule 4 | Agent quotes cost in credits before action. Format: *"This video will use about 80 credits. You have 420 remaining."* |
| Reactive limit message | mini-app paused banner (`access-control-credits-upgrade.md:161-165`) | Message: "Agent paused - credits ran out" + "Pay 25 WLD"/"Subscribe". Reactive, not proactive. |
| Date / timezone math | `instaclaw_check_limit_only()` RPC | Computes date in user's timezone on every call; no separate reset cron. Natural midnight boundary by user-locale. |
| Proactive low-balance warning | **MISSING** (P4 gap in `access-control-credits-upgrade.md`) | This is the gap our 80% soft hint CLOSES — and demonstrates the pattern for credit-balance too. |

##### Our wiring extends the canonical pattern with these deltas

[REVISED 2026-05-27 PM-3 with sponsored-tier framing — unit is
"premium searches" (weighted, mirrors Higgsfield credit weights),
allocations are $tier-scaled, top-up is 100-search pack for $10.]

| Layer | Existing | New for ToolRouter |
|---|---|---|
| Database state | `instaclaw_vms.credit_balance` (int) shared with media credits | New columns on `instaclaw_users` (per-user, survives VM reassign): `toolrouter_balance` (int, default = tier grant; never null after first set), `toolrouter_grant_override` (int, nullable — if set, overrides tier-default), `toolrouter_grant_period_start` (timestamptz), `toolrouter_80pct_notified_at` (timestamptz, nullable). The unit stored is "premium searches" — weighted, same as Higgsfield credits. |
| Tier-default grants | `lib/credit-constants.ts` exports tier daily limits | New constant `TOOLROUTER_TIER_GRANTS = { free_trial: 20, starter: 60, pro: 400, power: 1500 }` in `lib/toolrouter-credits.ts`. (free_trial added defensively for the 3-day trial cohort.) |
| Per-tool weight table | `lib/credit-constants.ts` exports LLM model weights; Higgsfield script has its own weight table | `TOOLROUTER_ENDPOINT_WEIGHTS` constant in `lib/toolrouter-credits.ts` maps `endpoint_id → premium_searches_per_call`. Calibrated to ~$0.007/Exa baseline (= 1 search). Full table in §5.3.8 below. |
| Charged-flag decision | n/a | When ToolRouter returns `path: "agentkit"` AND `charged: false`, we DO NOT decrement. The call was sponsored by AgentKit/World — user pays nothing toward their allocation. Only `charged: true` calls (path: agentkit_to_x402 OR x402) draw from the allocation. **This is what preserves the sponsored-tier UX.** |
| Stripe SKU | `STRIPE_PRICE_MEDIA_{500,1200,3000}` | `STRIPE_PRICE_TOOLROUTER_100` → $10 grants 100 premium searches. One SKU at v1; add `_300` ($25) and `_1000` ($75) later if usage warrants. |
| Top-up route | `app/api/billing/credit-pack/route.ts:8` `CREDIT_PACKS` dict | Add entry: `"toolrouter_100": { credits: 100, label: "100 premium searches — $10", envKey: "STRIPE_PRICE_TOOLROUTER_100" }`. Code path is identical. |
| Webhook | `webhook/route.ts:97+` (`type=credit_pack`) | Same handler. Detect `metadata.target === "toolrouter"` (new metadata field on the Stripe Checkout); on present, increment `instaclaw_users.toolrouter_balance` instead of `instaclaw_vms.credit_balance`. Add a new RPC `instaclaw_add_toolrouter_searches()` mirroring `instaclaw_add_credits()` exactly. Top-up credits ALWAYS add (no reset); they survive month boundary so a $10 buy late in the month carries over. |
| Pre-action check | Agent-side via SOUL.md (Higgsfield Rule 4 style) | Agent reads its own `~/.openclaw/.env:TOOLROUTER_BALANCE` (refreshed by reconciler on every cycle) AND `lib/toolrouter-client.ts` enforces server-side as backup. Two-layer check. |
| Decrement logic | `instaclaw_check_limit_only()` RPC | New `instaclaw_consume_toolrouter_searches(user_id, endpoint_id, charged, trace_id)` RPC. Atomic check-and-decrement. Skips decrement when `charged=false`. Returns `{allowed: bool, balance_after: int, hit_80pct: bool, allocation_source: 'sponsored_agentkit' | 'sponsored_paid' | 'topup_paid' | 'blocked'}`. The `allocation_source` field is what feeds §4.9 observability. |
| Agent-facing language | Higgsfield Rule 4 (pre-gen) + mini-app paused banner (reactive) | New `TOOLROUTER_BILLING_V1` marker block in V2 templates (`workspace-templates-v2.ts`). Five messages per §5.3.3 above. |
| Reset | Computed via timezone in `instaclaw_check_limit_only` | Same: monthly boundary computed in user's timezone, no separate cron. RPC checks `(NOW() AT TIME ZONE user.tz) - grant_period_start >= INTERVAL '1 month'`; on month-roll: refresh balance to tier-default + `grant_period_start = now()` + clear `toolrouter_80pct_notified_at`. Top-up balance is NOT cleared (it stacks). |
| Observability | Per Rule 67 alerting | `allocation_source` enum feeds the §4.9 dashboard. Four buckets: `sponsored_agentkit` (World pays), `sponsored_paid` (platform pays, within allocation), `topup_paid` (user pays via $10 pack), `blocked_daily_cap` (§15.5 hit). Gives operator data to tune allocations over time. |

##### Two-layer enforcement composes with the §15.5 hard daily cap

```
HARD ABUSE CEILING (§15.5)
  └── lib/toolrouter-client.ts: tracks per-VM daily spend in gbrain.
      $0.50 / $5 / $20 daily by tier. Hit = synthetic error, agent
      gets graceful local fallback. Pure abuse defense.

SOFT COMMERCIAL LIMIT (this §5.3)
  └── instaclaw_users.toolrouter_credit_balance + monthly grant.
      Wrapper calls consume_toolrouter_credits() RPC BEFORE every
      paid ToolRouter call. RPC atomically:
        1. Refresh grant if past monthly boundary.
        2. Check balance >= cost.
        3. If yes: decrement, return {allowed: true, ...}.
        4. If no: return {allowed: false, balance: N}.
      Wrapper then either makes the call OR emits upsell.
      Calls with charged=false (AgentKit path) skip the consume RPC
      entirely — see §5.3.5 below.

ABSORBED COGS (Option A baseline)
  └── Below allocation, platform pays for everything via ToolRouter
      credit balance. ~$20-$271/mo fleet COGS (§15.3).
```

Nothing here is genuinely new infrastructure. It's wiring extensions
of patterns we already run in production. The migration is ~20 LOC;
the new RPC is ~40 LOC mirroring `instaclaw_add_credits` and
`instaclaw_check_limit_only`; the wrapper is ~80 LOC; the new
template marker is ~600 chars. Total <300 LOC for the full upsell
system.

#### 5.3.5 The `charged: false` carve-out — what preserves the sponsored-tier UX

This is the single most important UX nuance in the design. ToolRouter's
executor (`packages/router-core/src/executor/agentkitExecutor.ts`)
classifies every call into three execution paths (§1.6): `agentkit`
(free, charged=false), `agentkit_to_x402` (paid retry, charged=true),
`x402` (no AgentKit, charged=true).

**Our wrapper applies this rule** (`lib/toolrouter-client.ts`):

[REVISED 2026-05-27 PM-6 per Issue 4 of the PRD review — the prior
draft called the consume RPC BEFORE the HTTP call and "refunded if
actually charged=false." That ordering is a data-loss bug: if the
HTTP call fails (network error, 502, timeout, process crash), the
user's allocation is decremented but never refunded. At fleet scale
with flaky networks this causes real user complaints. The
corrected ordering is "call FIRST, decrement AFTER" — optimistic-
concurrency pattern, same as database row versioning.]

```typescript
// lib/toolrouter-client.ts — callToolRouter()

// ── Step 1: Pre-call cheap check (agent-side, no DB write) ──
// The agent already did the 3-step decision tree (§5.3.6) and read
// TOOLROUTER_BALANCE from .env. If the agent reached this wrapper
// call, it believes the user has allocation. We TRUST that and call.
// (The RPC's post-hoc check below catches the rare race where
// allocation was exhausted between the agent's read and this call.)

// ── Step 2: Call ToolRouter HTTP endpoint ──
let response;
try {
  response = await fetch(toolrouterUrl, { ...opts });
} catch (err) {
  // Network error, timeout, DNS failure. ToolRouter itself is down
  // or unreachable. NO allocation change. NO user-visible upsell.
  // The agent silently falls back to free tools (per Issue 5 fix +
  // §5.3.6 Step 2.5 "ToolRouter unavailable" branch).
  logToCallLog({ allocation_source: 'toolrouter_unavailable', error: err.message, ... });
  return { toolrouter_unavailable: true, error: err.message, fallback: "free_tools" };
}
if (!response.ok && response.status >= 500) {
  // 5xx from ToolRouter itself. Same handling as network failure.
  logToCallLog({ allocation_source: 'toolrouter_unavailable', http_code: response.status, ... });
  return { toolrouter_unavailable: true, http_code: response.status, fallback: "free_tools" };
}

const body = await response.json();
// body now contains: { path, charged, amount_usd, ... }

// ── Step 3: charged=false path → no decrement ──
if (body.charged === false && body.path === "agentkit") {
  // World/AgentKit sponsored this call. User pays nothing.
  logToCallLog({ allocation_source: 'sponsored_agentkit', charged: false, ... });
  return { allowed: true, response: body, allocation_source: 'sponsored_agentkit' };
}

// ── Step 4: charged=true path → post-hoc consume ──
// The call has ALREADY happened and the platform has been charged.
// We decrement the user's allocation NOW, after the fact. If the
// RPC returns {allowed: false} ("post-hoc allocation exceeded"),
// the platform eats this one call's cost. We still return the
// result to the user — better than swallowing a successful call.
// The NEXT call will correctly hit the upsell.
const consume = await rpc.instaclaw_consume_toolrouter_searches({
  user_id,
  p_weight: toolrouterWeight(endpoint_id, args),
  p_endpoint_id: endpoint_id,
  p_charged: true,
  p_trace_id: body.trace_id,
});

if (!consume.allowed) {
  // Optimistic-concurrency race: between the agent's pre-call check
  // and this post-hoc decrement, the user's allocation hit zero.
  // The call already succeeded; we DELIVER the result anyway.
  // Platform absorbs this one call. Log + alert for monitoring.
  logToCallLog({
    allocation_source: 'post_hoc_exceeded',
    note: 'platform absorbed cost; next call will hit upsell',
    ...
  });
  return {
    allowed: true,
    response: body,
    allocation_source: 'post_hoc_exceeded',
    warning: 'allocation_overrun_absorbed',
  };
}

// ── Step 5: Normal path. Decrement landed cleanly. ──
logToCallLog({ allocation_source: consume.allocation_source, ... });
return {
  allowed: true,
  response: body,
  allocation_source: consume.allocation_source,
  balance_after: consume.balance_after,
  hit_80pct: consume.hit_80pct,
};
```

**Wrapper return-type contract** (binding — every caller must handle
all three):

| Return shape | When fired | Agent does |
|---|---|---|
| `{toolrouter_unavailable: true, fallback: "free_tools"}` | ToolRouter HTTP failed (network/5xx) | SILENTLY use free tools. No mention of upsell, no mention of ToolRouter. User never knows. |
| `{allowed: true, response, allocation_source, ...}` | Call succeeded | Use the response. If `hit_80pct=true`, emit the M2 soft hint at end of turn. |
| `{upsell_required: true, ...}` | NEVER fired by wrapper anymore | (Legacy — REMOVED. The agent's pre-call check via TOOLROUTER_BALANCE env var is what gates the upsell. Wrapper never blocks at request time.) |

**Why "call first, decrement after" is the right pattern**:
- Network failures / 5xx / timeouts NEVER cost the user their
  allocation. The decrement only runs after the call observably
  succeeded.
- Race condition (user exhausts between agent's pre-check and
  wrapper call) handled by post-hoc RPC: returns `{allowed: false}`,
  wrapper logs the absorption, delivers the result anyway. Next
  call's agent-side pre-check sees balance=0 and triggers the
  upsell normally.
- Mirrors the optimistic-locking pattern used widely in database
  systems (read version → write with version-check → handle conflict).
- The cost of an over-absorption (platform eats $0.007 of Exa or
  $0.10 of Manus) is dramatically less than the cost of a phantom
  decrement that erodes user trust ("I had 400 searches, now I
  have 385, but I only did 10 searches").

**Why this matters for the user experience**:

- A Pro user doing 300 Exa searches a month sees zero premium-search
  decrement because every Exa call (assuming AgentKit free trial cap
  covers Exa fully — Q3) returns `charged: false`. Their dashboard
  shows "400 of 400 included premium searches remaining."
- The SAME user doing 5 Manus deep research calls/month sees: 2 free
  (AgentKit cap), 3 paid (3 × 15 = 45 deducted). Dashboard: "355 of
  400 included premium searches remaining."
- A Power user doing heavy Browserbase use sees decrements every
  session (Browserbase is AgentKit-access, not free). 10 sessions =
  30 premium searches. Dashboard: "1470 of 1500 remaining."

The allocation pressures ONLY when the platform actually pays for
the call. Without this carve-out, our §10.4 World ID + AgentKit
competitive moat narrative collapses — users would burn included
allocation on calls that cost the platform $0.

**The headline UX promise this enables**: *"Most InstaClaw users
never exhaust their included premium searches because World sponsors
the most-used tools. The included tier is way more generous than the
dashboard number suggests, because most of your usage doesn't count
against it."*

#### 5.3.6 The agent's 3-step decision tree (SOUL.md routing)

[Per Cooper's reframe point 7 — before checking "is ToolRouter the
right tool," the agent runs a 3-step gate. This composes with the
§16.2 routing block above by adding an upstream allocation check.]

```
USER ASKS FOR SOMETHING (e.g., "find me the latest news about X")
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ STEP 1: Is the right tool for this intent a ToolRouter      │
│         premium tool?                                        │
│  - Web search → Exa (premium) OR Brave (free fallback)      │
│  - Browser session → Browserbase (premium) OR local Chromium│
│  - Deep research → Manus (premium) OR multi-step manual     │
│  - Email send → AgentMail (premium) OR Telegram (limited)   │
│                                                              │
│  If FREE local tool is genuinely adequate for THIS query    │
│  → use free tool. No upsell consideration needed.            │
│                                                              │
│  If PREMIUM tool is genuinely better for THIS query → go    │
│  to Step 2.                                                  │
└─────────────────────────────────────────────────────────────┘
          │
          ▼ (premium tool warranted)
┌─────────────────────────────────────────────────────────────┐
│ STEP 2: Will this premium call come from the AgentKit-free  │
│         path (sponsored, no deduction)?                      │
│                                                              │
│  Predict path based on §1.5 table:                          │
│  - Exa search → almost certainly path: "agentkit" (free)    │
│  - Manus research → free if user hasn't done 2 this month   │
│  - Browserbase → ALWAYS deducts (AgentKit access ≠ free)    │
│  - Parallel / AgentMail / StableTravel → always deducts     │
│                                                              │
│  If predicted FREE → call the tool. No allocation check.    │
│  If predicted PAID → go to Step 3.                          │
└─────────────────────────────────────────────────────────────┘
          │
          ▼ (any call, free or paid)
┌─────────────────────────────────────────────────────────────┐
│ STEP 2.5: Did the wrapper return {toolrouter_unavailable}?  │
│                                                              │
│  ToolRouter HTTP failed (network/5xx). The platform's       │
│  premium backend is temporarily down. The agent SILENTLY    │
│  falls back to free tools (brave search, local chromium,    │
│  curl, etc.) and completes the user's task.                 │
│                                                              │
│  EXPLICITLY: do NOT tell the user that ToolRouter is down.  │
│  Do NOT mention the upsell. Do NOT mention the premium     │
│  backend. The user doesn't need to know our backend         │
│  topology. They asked for X; the agent does X with what's  │
│  available. No commentary.                                   │
│                                                              │
│  This is the only branch with NO user-facing message. The   │
│  agent works the problem silently.                          │
└─────────────────────────────────────────────────────────────┘
          │
          ▼ (paid call predicted, wrapper returned successfully)
┌─────────────────────────────────────────────────────────────┐
│ STEP 3: Does the user have allocation remaining?            │
│         Read $TOOLROUTER_BALANCE from .env.                  │
│                                                              │
│  If balance >= weight: call the tool. Wrapper decrements    │
│  on response. (Pre-action transparency if balance < 3x).    │
│                                                              │
│  If balance < weight: present the §5.3.3 "100% reached"     │
│  message. Two equal options:                                 │
│    (a) Free fallback — agent does it with non-premium tools │
│    (b) Top-up $10 for 100 more premium searches              │
│  Wait for user to pick. If (a) → execute via free tools.    │
│  If (b) → return Stripe Checkout URL.                       │
└─────────────────────────────────────────────────────────────┘
```

**The decision tree is encoded in the SOUL.md `TOOLROUTER_BILLING_V1`
marker block.** The agent reads it at session start. The wrapper
(`lib/toolrouter-client.ts`) backstops the agent's decision at
runtime — if the agent skips Step 3 and tries to call a paid tool
with empty allocation, the wrapper still rejects and returns the
upsell-required flag.

**The "is free adequate?" judgment in Step 1** is where the agent's
intelligence matters most. SOUL.md guides:
- Casual lookup ("latest news") → free Brave Search is fine
- Time-sensitive verification ("did X happen today?") → free is fine
- Research with citations → premium Manus is better
- Booking flights → no free path; only premium works
- Page extraction with JS → both work; default to local Chromium
- Crypto / financial data freshness → premium Exa is usually better

The agent's job is to make this call honestly. If unsure, it should
default to the FREE path and offer to switch to premium ("i ran a
brave search — if you want me to dig deeper with manus, that'll use
about 8 of your included searches").

#### 5.3.7 The endpoint weight table

[Internal weights — mirrors Higgsfield's per-generation weight table.
User-facing language exposes ONE balance number; this table tells
the wrapper how much each call costs.]

```typescript
// lib/toolrouter-credits.ts
export const TOOLROUTER_ENDPOINT_WEIGHTS: Record<string, number | ((args: any) => number)> = {
  // Search (cheapest, baseline = 1)
  "exa.search": 1,                    // ~$0.007/call
  "parallel.search": 2,               // ~$0.02/call (no AgentKit)

  // Extract
  "parallel.extract": (args) => Math.max(1, (args.urls?.length ?? 1) * 2), // 2/URL

  // Research (async)
  "manus.research": (args) => {       // depth-priced
    const depth = args.depth ?? "standard";
    return depth === "quick" ? 5 : depth === "standard" ? 8 : 15; // quick/standard/deep
  },
  "parallel.task": (args) => {        // processor-priced
    const p = args.processor ?? "base";
    return { lite: 3, base: 4, core: 6, pro: 16, ultra: 45 }[p] ?? 4;
  },

  // Browser
  "browserbase.session": 3,           // ~$0.02 baseline; AgentKit-access = premium browsers

  // Email
  "agentmail.send_message": 3,        // ~$0.02
  "agentmail.reply_to_message": 3,
  "agentmail.create_inbox": 287,      // $2.01 — high-cost one-time setup
  "agentmail.list_messages": 0,       // free read endpoint
  "agentmail.get_message": 0,         // free read endpoint

  // Travel
  "stabletravel.locations": 2,
  "stabletravel.google_flights_search": 5,
  "stabletravel.hotels_list": 4,
  "stabletravel.hotels_search": 5,
  "stabletravel.flightaware_flights": 5,
};

export function toolrouterWeight(endpointId: string, args?: any): number {
  const w = TOOLROUTER_ENDPOINT_WEIGHTS[endpointId];
  if (typeof w === "function") return w(args ?? {});
  if (typeof w === "number") return w;
  return 5; // unknown endpoint — safe default; covers ~$0.05 worst-case
}
```

**Calibration rationale**: 1 premium search ≈ $0.007 platform cost
(matches the published Exa baseline). The weight per call is
`ceil(estimated_cost_usd / $0.007)`, rounded to a clean integer.
Heavy endpoints (AgentMail create_inbox, Manus deep, Parallel
ultra) have proportionally higher weights — accurate to underlying
cost, fair to the user, transparent in the dashboard.

**Margin math at top-up tier**: 100 premium searches for $10.
- If user spends all 100 on Exa AT WORST-CASE Scenario B (no
  AgentKit free trial for them — they're not registered): 100 ×
  $0.007 = $0.70 platform cost. Revenue $10. **93% margin.**
- If user spends all 100 on Browserbase: 100 weight = 33 sessions ×
  $0.02 = $0.66 platform cost. Revenue $10. **93% margin.**
- If user spends all 100 on Manus deep: 100 weight = 6.6 calls ×
  $0.10 = $0.66 platform cost. Revenue $10. **93% margin.**

The flat-rate weight system happens to produce uniform ~93% margin
across endpoint types because we calibrated weights to actual cost
ratios. **This is by design** — the user pays the same per "premium
search" regardless of which tool they use, and our margin is
consistent.

#### 5.3.8 Revenue projection vs. Cooper's "10% top-up" assumption

[REVISED §15.7 below has the detailed fleet-wide cost-and-revenue
roll-up. This is the lighter-weight projection that maps directly to
Cooper's framing.]

Per Cooper's reframe: 10-15% of users hit the upsell each month (the
"feels like a power-user feature" calibration). Of those, his
"respectful but we have margins" estimate is 10% buy a $10 top-up.

| Metric | Assumption | Math |
|---|---|---|
| Fleet size | 150 active VMs |  |
| % users exhausting included allocation/mo | 12% (midpoint of 10-15%) | 18 users |
| % of exhausting users who top up | 10% | 1.8 users |
| Top-up purchases / month | | 1.8 |
| Revenue per top-up | $10 | |
| **Top-up revenue / month** | | **$18** |
| Tool COGS that the $10 top-up covers | ~$0.70 | $1.26 absorbed |
| Net platform margin from top-ups | $18 - $1.26 ≈ $16.74 | |

Modest in absolute terms ($16-25/mo at v1 scale) but structurally
important: ToolRouter goes from COGS-neutral to revenue-positive on
day one. AND the data we collect on which users hit the upsell, on
what tools, with what conversion, feeds the v1.5 allocation tuning
plus the v2 "InstaClaw as ToolRouter producer" roadmap.

The real value of the upsell is NOT the v1 revenue. It's:
- Training users that premium tools have value (mental anchor for
  future monetization).
- Capturing data on who the power users are (~12% of fleet = ~18
  high-value users to nurture).
- Demonstrating Stripe-grade in-chat purchase flow that competes
  with no other agent platform's UX.
- Creating the precedent for v1.5 / v2 paid features (per-user
  AgentBook delegation upsell, x402-producer revenue share, etc.).

---

---

### 5.4 v2 — InstaClaw Agents as ToolRouter Endpoints (2-4 weeks, strategic)

**Goal**: InstaClaw agents become PROVIDERS in the ToolRouter catalog.
Other agents discover us through ToolRouter, hire us via x402, our agents
do the work.

**Depends on**:
- Andy's onboarding flow for new providers (manual today, §1.2).
- Base MCP v2.5 (per-VM ingress) — ideally we re-use the same ingress for
  ToolRouter listings as we do for direct skill-plugin hires.
- A user-facing "do you want your agent to earn from other agents?" toggle
  in onboarding.

**Ships** (rough outline; full spec deferred to a follow-up PRD):
- Per-VM ingress (Cloudflare Tunnel or similar) terminating at the agent's
  local x402 server.
- ToolRouter endpoint submission for each EARN.md-published capability.
  Initial set: research, summary, monitoring (low-touch high-volume).
- Revenue accounting: ToolRouter pays out via x402 to the agent's Sub
  Account (Base MCP v1.5 wallet).
- Reputation surface: each ToolRouter-completed job posts feedback to the
  agent's ERC-8004 profile (Base MCP v3 prerequisite).

**Open strategic question for Cooper**: do we want InstaClaw to be listed on
ToolRouter under a single InstaClaw umbrella ("hire an InstaClaw agent") or
as N individual agent listings (one per VM, with reputation per agent)?
Probably both eventually. Bias: start with the umbrella for volume, add
per-agent listings as reputation accrues. (See §6, Q7.)

---

## 6. Open Questions for Andy

Until these resolve, no code lands. Each comes with Cooper's recommended
approach so Andy can react to a position rather than a blank question.

### Q1 — API key model: platform-scoped or per-VM sub-keys?

> Today's docs imply one `tr_...` key tied to one credit balance. We need to
> provision ToolRouter access for ~150 production VMs (and growing).
>
> **Question**: Can InstaClaw mint per-VM sub-keys programmatically under
> one parent account, OR is each VM expected to sign up independently, OR
> is the right pattern "one platform key, all VMs share"?
>
> **Cooper's recommended position**: single platform key for v1 (matches
> what's published, simplest ops). If you can ship a sub-key API by v1.5,
> we'd use it for per-customer cost attribution.

### Q2 — Transport: hosted streamable-http MCP endpoint coming?

> The npm adapter is stdio-only today. We've spent the last year aggressively
> avoiding stdio MCP sidecars because the cold-start cost and process-spawn
> failure modes have repeatedly caused customer-visible outages on our fleet.
> Our current pattern for ALL hosted MCPs is streamable-http over loopback
> (gbrain) or direct to a partner (Index Network).
>
> **Question**: Are you planning to expose `https://toolrouter.world/mcp` as
> a streamable-http MCP endpoint with Bearer auth? If yes, when?
>
> **Cooper's recommended position**: we ship v1 with stdio (working today),
> AND we'd be the first big reference integration the day you ship
> streamable-http. The wiring difference for us is a single config block.

### Q3 — [P0 BLOCKER, ELEVATED 2026-05-27] What's the Exa free-trial cap for AgentKit-verified callers?

> [VERIFIED 2026-05-27] Mechanism is now well-understood: human signs
> delegation via `npx @worldcoin/agentkit-cli register`; AgentBook
> contract on World Chain (`eip155:480`) stores `agent_wallet →
> human_id`; per-request signing happens server-side at ToolRouter
> using the account's Crossmint wallet. NO per-request token needed
> from the InstaClaw side.
>
> The remaining unknown — and the only thing that materially shifts
> our cost projection by 10x — is the per-agent monthly cap on the
> Exa free trial path.
>
> **Specific question**: For an AgentBook-registered agent wallet,
> how many `exa.search` calls per month land on `path: "agentkit"`
> with `charged: false` before subsequent calls fall through to
> `path: "agentkit_to_x402"` and start charging $0.007+markup?
>
> Manus is documented at 2/month/agent in `agents.md`. Exa is silent.
> The two extremes for our fleet cost:
>   - If Exa is unlimited: ~$20/mo fleet COGS. Trivially absorbable.
>   - If Exa is also 2/month/agent: ~$245/mo Exa-alone cost. Still
>     absorbable but the AgentKit moat is meaningfully smaller.
>
> **Cooper's recommended position**: this is the single number that
> determines whether the "we made paid tools free for our users by
> being World-ID-verified" headline is real. We're hoping it's
> generous. Even if it's not, we still ship — but our upsell story
> changes.

### Q3a — Can InstaClaw register a fleet-wide AgentBook entry programmatically?

> The CLI flow `npx @worldcoin/agentkit-cli register <agent-address>`
> requires a one-time human action (World App proof verification).
> Cooper has a World ID. ONE registration of the platform account's
> Crossmint wallet should AgentKit-enable every InstaClaw VM that
> uses the platform API key.
>
> **Question**: Is there a programmatic path to register on AgentBook
> from our backend (signing the registration proof on Cooper's behalf
> with his World ID, like a delegated authority), or is the World App
> hand-click the only path? If hand-click only: that's fine — Cooper
> does it once. But if there IS a programmatic path, it unlocks v1.5
> per-VM sub-accounts where every user's VM has its OWN AgentBook
> entry → every user gets their OWN 2-free-Manus/month allotment.

### Q3b — Per-user delegation: roadmap?

> Today the MCP adapter passes only `TOOLROUTER_API_KEY` env var. So
> at v1 we get fleet-wide AgentKit benefits bound to ONE platform
> account.
>
> **Question**: Roadmap for per-end-user delegation? Either (a) MCP
> adapter accepts an additional env var that overrides the AgentKit
> identity per session, or (b) the underlying `/v1/requests` API
> accepts a `delegation_subject` field. With either, InstaClaw could
> register EACH user's own World ID on AgentBook → multiply the
> AgentKit free-trial allotment by 150 (number of users) instead of 1
> (Cooper).

### Q4 — Top-up: programmatic API or dashboard-only?

> Credit-balance management is a load-bearing ops surface for us. If we run
> out of credits the entire fleet's paid SaaS calls fail. We can do
> dashboard-driven top-ups in v1 (with low-balance alerting), but at scale
> we want automated replenishment from a CDP-managed wallet.
>
> **Question**: Is there a programmatic top-up endpoint, or planned? If yes,
> what's the auth model (Bearer? webhook signing?). We'd integrate it the
> same way we wire Stripe top-ups today.

### Q5 — Pricing transparency: per-call cost surface, take rate, rate limits?

> The landing page shows `$0.007` for Exa and `$0.01` for Browserbase. Other
> categories aren't priced visibly. For our operator decisions (SOUL.md
> routing, per-call cost-attribution dashboards, credit-runway estimates), we
> need:
> - Per-endpoint pricing in a queryable form (API or static doc).
> - Whether the AgentKit boost rate is applied automatically or only when
>   we present delegation (related to Q3).
> - Rate limits per key (req/s, req/day).
> - For the producer side (v2 of this PRD), the take rate ToolRouter
>   charges providers.

### Q6 — Verifier endpoint: what URL should we hit for our partner-secret health check?

> Per CLAUDE.md Rule 49 we add a verifier in `lib/partner-secrets.ts` for
> every partner secret. The verifier needs a lightweight endpoint that
> returns 200 + JSON when the key is valid, 401 when it's not, and doesn't
> charge a credit.
>
> **Question**: What's the canonical "ping with my key" endpoint? Common
> conventions are `GET /v1/account` or `GET /v1/endpoints` (no-op
> auth check).

### Q7 — Producer onboarding: how do we list InstaClaw agents AS ToolRouter endpoints?

> This is the v2 strategic ask. Today provider onboarding is "submit endpoint
> URL, schema, fixture, price, mode, failure notes" via manual review.
>
> **Question**: Are you planning to open programmatic provider onboarding?
> If we wanted to list 5 InstaClaw capabilities tomorrow (e.g., "summarize
> a URL," "monitor a Twitter handle," "draft a press release") — what's
> the path?

### Q8 — Pin version policy: do you support semver / stability commitments?

> [VERIFIED 2026-05-27 audit] — the published quickstart uses `npx -y
> @worldcoin/toolrouter` which floats to latest on every cold start. For
> managed fleets that's an uncontrolled-upstream risk — a bad release at
> 03:00 reaches every paying customer simultaneously.
>
> Our discipline: pin everything (OpenClaw, gbrain, Bun, prctl-subreaper —
> all have `*_PINNED_VERSION` constants). We'll pin `@worldcoin/toolrouter`
> the same way and bump after the active canary VM + Cooper approval (Rule 64).
>
> **Question**: How does the adapter's MCP-tool surface evolve? Is there a
> changelog convention (semver-with-changelog, snapshot tags) so we can
> reason about which bumps are safe and which need a deeper canary? If
> you ship a tool-rename or breaking change, what's the deprecation
> window we can count on?
>
> **Cooper's recommended position**: even an informal "I'll Telegram the
> instaclaw chat 24h before any breaking release" is enough at v1 scale.
> A formal CHANGELOG.md in the repo is the operator-grade ask.

---

## 7. Phase 3 — Implementation Plan (after Andy resolves Q1, Q2, Q6 at minimum)

This is concrete enough that the reconciler/manifest terminal can pick it up
when Cooper greenlights. Each task lists the files to touch, the manifest
deltas, and the done-when.

### 7.1 Task A — Source-of-truth helper module

1. Create `instaclaw/lib/toolrouter-client.ts` modeled on
   `instaclaw/lib/index-network-client.ts`. Exports:
   - `getToolRouterEnv()` — reads `TOOLROUTER_API_KEY`, returns null if
     unset or malformed (Rule 49 shape check inline).
   - `buildToolRouterMcpConfig(apiKey: string, transport: "stdio" | "streamable-http")` —
     returns the disk shape for `mcp.servers.toolrouter` per §2.3.
   - `verifyToolRouterCredentials(apiKey: string)` — Rule 49 verifier;
     calls Andy's canonical ping endpoint (Q6).
2. Unit test `instaclaw/scripts/_test-toolrouter-client.ts`:
   - 8+ scenarios: stdio shape, streamable-http shape, missing key,
     malformed key, network failure, 401 response, 200 response, edge cases.

### 7.2 Task B — Vercel env + secret distribution

1. Cooper runs:
   ```bash
   printf 'tr_<from-andy>' | npx vercel env add TOOLROUTER_API_KEY production
   printf 'tr_<from-andy>' | npx vercel env add TOOLROUTER_API_KEY preview
   printf 'true' | npx vercel env add TOOLROUTER_ENABLED production
   printf 'stdio' | npx vercel env add TOOLROUTER_TRANSPORT production
   ```
2. Add `TOOLROUTER_API_KEY` to `SECRET_ENV_VAR_SOURCES` in
   `lib/vm-reconcile.ts:1407` (envKey: `TOOLROUTER_API_KEY`;
   `vercelKey` left unset since the names match; no `partnerGate`
   since ToolRouter is universal, not partner-gated).
3. Bump `SECRET_VERSION` in `lib/vm-reconcile.ts:266` from `4` to `5`
   [VERIFIED 2026-05-27 audit — current value is 4]. Add a changelog
   entry above the constant (`v5 (2026-05-27): TOOLROUTER_API_KEY
   enrollment`). The reconciler's `cron/reconcile-fleet` candidate
   query OR-s `secret_version.lt.<SECRET_VERSION>` with the cv staleness
   filter, so caught-up VMs re-enter the queue and receive
   TOOLROUTER_API_KEY via `stepEnvVarPush` on the next ~3-min tick.
   Full fleet at sv=5 within ~30 min at default cadence.
4. Pre-bake validation per Rule 61 (verified against
   `scripts/_pre-bake-check.ts` lines 472-530 on 2026-05-27):
   - **`TOOLROUTER_ENABLED`** → add to `BAKE_BOOLEAN_ENVS` (boolean
     gate). `requiredOnForBake: false` for v1 since the bake should NOT
     auto-enable a partner integration without Cooper's Rule 64 approval.
   - **`TOOLROUTER_TRANSPORT`** → add to `BAKE_ENUM_ENVS` (NOT
     `BAKE_BOOLEAN_ENVS` — corrected from first PRD draft) with
     `allowedValues: ["stdio", "streamable-http"]`, `defaultValue: "stdio"`,
     `requiredOnForBake: false`. Direct precedent: `BASE_SKILLS_SOURCE_MODE`
     at `_pre-bake-check.ts:518` — same enum shape, same Rule 61
     enum-variant treatment.
   - **`TOOLROUTER_API_KEY`** — already covered by the partner-secret
     verifier registry (Task D); pre-bake check doesn't probe partner
     secrets directly.

### 7.3 Task C — Reconciler step

1. Implement `stepToolRouter` in `lib/vm-reconcile.ts` per §4.5.
2. Wire into `reconcileVM` orchestrator chain after `stepIndexProvision`.
3. Per Rule 39: failures → `result.warnings`, not `result.errors`.
4. Per Rule 47: bump `VM_MANIFEST.version` to force cv-stale VMs back into
   the queue. Document in the changelog per the version-bump policy.

### 7.4 Task D — Partner-secret verifier

1. Add `toolrouter` entry to `SECRET_VERIFIERS` in `lib/partner-secrets.ts`:
   - Shape check (starts with `tr_`, len ≥ 16, no whitespace)
   - Live smoke: GET to Andy's canonical ping endpoint (Q6) with Bearer
     auth; expect 200 + JSON
   - Map response to standard `VerifierStatus`
2. Hourly probe via the existing `cron/probe-partner-secrets` route — no
   new cron needed.

### 7.5 Task E — Pinned global install in configureOpenClaw

1. Add `TOOLROUTER_PINNED_VERSION` constant in `lib/ssh.ts` (near
   `BANKR_CLI_PINNED_VERSION`, `OPENCLAW_PINNED_VERSION`,
   `PRCTL_SUBREAPER_PINNED_VERSION` for consistency).
2. Edit `lib/ssh.ts:configureOpenClaw` to add the pinned-global-install
   step from §4.4. Must include `jq` version check post-install (per the
   correction above). HARD-FAIL on version mismatch — install needs to
   produce the pinned version or bail out.
3. Verify on the active canary VM: `npm list -g --depth=0 | grep @worldcoin/toolrouter`
   should report the pinned version post-configure.
4. New `stepToolRouterCli` reconciler step in `lib/vm-reconcile.ts`
   (sibling to `stepNpmPinDrift` from the gbrain pattern) — detects when
   the global install has drifted (operator manually upgraded; npm
   self-update) and reinstalls the pinned version. Same idempotency
   pattern.

### 7.6 Task F — SOUL.md / AGENTS.md routing

1. Add the routing block from §4.7 to `lib/workspace-templates-v2.ts` (V2
   AGENTS.md) and `lib/agent-intelligence.ts` (V1 SOUL supplement).
2. New idempotency MARKER `TOOLROUTER_ROUTING_V1` — uses the same insert
   pattern as `SOUL_STUB_EDGE_MARKER` / `stepRewriteSoulPartnerSections`,
   NOT Rule 23 sentinels (which only apply to `vm-manifest.ts:files[]`
   entries — see §4.7 audit correction).
3. Total addition ≤ 600 chars per `feedback_skill_size_budget.md`. Cost
   hints (see Phase 2 finding §16 below) MUST be included.

### 7.7 Task G — Coverage script

1. Create `instaclaw/scripts/_coverage-toolrouter.ts`:
   - Random-sample 5 healthy + assigned VMs
   - SSH probe `.env` for `TOOLROUTER_API_KEY` prefix match (don't log the
     full key)
   - SSH probe `openclaw.json` for `mcp.servers.toolrouter.command` (or
     `.transport` if streamable-http)
   - Optionally send a `toolrouter_list_categories` smoke call via openclaw
     and confirm the agent gets a non-empty response
2. Exit 1 on any miss; report which VMs / which gate.

### 7.8 Task H — Admin alerting

1. Add a `cron/probe-toolrouter-balance` route (hourly):
   - Calls a balance endpoint (Q4 / Q6)
   - Persists to `instaclaw_toolrouter_balance_log` (new small table —
     `(ts, balance_usd, est_daily_spend_usd, runway_days)`)
   - Fires admin alert at runway thresholds (7d WARN, 3d P1, <1d P0;
     daily-deduped via `instaclaw_admin_alert_log`)
2. Migration `<ts>_toolrouter_balance_log.sql` per Rule 56 + Rule 60
   (RLS enabled in the same file).

### 7.9 Task I — Endpoint discovery probe (optional, mirrors Base MCP §4.6)

1. Add `app/api/cron/probe-toolrouter-registry/route.ts` hourly cron:
   - HEAD-probes a guessed list of streamable-http MCP URLs:
     `https://toolrouter.world/mcp`, `/v1/mcp`, `/api/mcp`
   - On any 200 + JSON response, fires a 24h-deduped admin alert: "[P2]
     ToolRouter streamable-http endpoint detected at <url> — review for
     `TOOLROUTER_TRANSPORT=streamable-http` flip"
2. This is identical in shape to `probe-base-skills-registry`. Same dedup
   pattern, same operator workflow.

### 7.10 Task J — the active canary VM + Cooper approval + fleet deploy

Per Rule 64:

1. Apply all tasks A-I on a preview branch.
2. SSH to the active canary VM. Apply changes manually via `openclaw config set` +
   `openclaw mcp set` (the canary mode where the manifest hasn't bumped yet).
3. Cooper sends test prompts:
   - "Search for 5 articles about Edge Esmeralda using a paid search tool"
     → expect `exa_search` invocation, result in <30s, cost < $0.10.
   - "Spin up a clean browser session and screenshot example.com"
     → expect `browserbase_session_create` + use, result in <60s, cost
     < $0.10.
   - "Research the top 5 AI infra startups in NYC this month (multi-step)"
     → expect `manus_research_start` → polling → final synthesis.
4. Cost summary: sum of cents spent during canary should be reportable
   from ToolRouter dashboard. Confirm matches our local trace.
5. Cooper sends explicit "ship it to fleet" per Rule 64.
6. Bump `VM_MANIFEST.version`. Push to main. Reconciler propagates over
   ~30 min.
7. Coverage script returns 5/5 VMs with the wire-up.

### 7.11 Task K — Sponsored-tier allocation + in-chat upsell (Option B, §5.3)

[Added 2026-05-27 PM after Cooper's override locking Option B in v1.
This is concrete enough that the implementer can ship it without
asking questions. Reuses existing infrastructure aggressively.]

**Estimated effort**: 4-6 days end-to-end. ~300 LOC total (small).

**Task K.1 — Migration**

Create `instaclaw/supabase/pending_migrations/<ts>_toolrouter_allocation.sql`:

```sql
-- ToolRouter sponsored-tier allocation (per §5.3)
ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS toolrouter_balance INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS toolrouter_grant_override INTEGER,
  ADD COLUMN IF NOT EXISTS toolrouter_grant_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS toolrouter_80pct_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS toolrouter_topup_balance INTEGER NOT NULL DEFAULT 0;
-- toolrouter_balance = included-tier remaining (resets monthly)
-- toolrouter_topup_balance = purchased-via-Stripe remaining (never resets, stacks)
-- toolrouter_grant_override = NULL → use tier default; INTEGER → use this value
-- toolrouter_grant_period_start = NOW() on first grant; rolled over monthly per user TZ
-- toolrouter_80pct_notified_at = NULL → not yet notified this period

-- Per Rule 60 — RLS enabled in same file
ALTER TABLE public.instaclaw_users ENABLE ROW LEVEL SECURITY;
-- (Policies already exist on instaclaw_users; no new policy needed.)

CREATE TABLE IF NOT EXISTS public.instaclaw_toolrouter_call_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.instaclaw_users(id),
  vm_id UUID REFERENCES public.instaclaw_vms(id),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  endpoint_id TEXT NOT NULL,
  path TEXT NOT NULL,
  charged BOOLEAN NOT NULL,
  amount_usd NUMERIC(8, 4),
  weight INTEGER NOT NULL DEFAULT 0,
  allocation_source TEXT NOT NULL,
  http_code INTEGER,
  latency_ms INTEGER,
  error_class TEXT,
  trace_id TEXT
);
ALTER TABLE public.instaclaw_toolrouter_call_log ENABLE ROW LEVEL SECURITY;
CREATE INDEX ON public.instaclaw_toolrouter_call_log (user_id, ts DESC);
CREATE INDEX ON public.instaclaw_toolrouter_call_log (vm_id, ts DESC);
```

Apply via Supabase Studio per Rule 56. THEN `git mv` to `migrations/`.

**Task K.2 — Constants module**

Create `instaclaw/lib/toolrouter-credits.ts`:

```typescript
export const TOOLROUTER_TIER_GRANTS = {
  free_trial: 20,
  starter: 60,
  pro: 400,
  power: 1500,
} as const;

export const TOOLROUTER_TOPUP_PACK = {
  pack_slug: "toolrouter_100",
  credits: 100,
  price_usd: 10,
  label: "100 premium searches — $10",
  envKey: "STRIPE_PRICE_TOOLROUTER_100",
};

// Per-endpoint weights (§5.3.7). Exported for the wrapper + tests.
export const TOOLROUTER_ENDPOINT_WEIGHTS = { /* per §5.3.7 */ };
export function toolrouterWeight(endpointId, args) { /* per §5.3.7 */ }

// 80% / 100% thresholds
export const SOFT_HINT_THRESHOLD = 0.80;
```

**Task K.3 — Consume RPC**

New migration (in same file as K.1, or sibling):

```sql
-- ─────────────────────────────────────────────────────────────────────────
-- instaclaw_consume_toolrouter_searches
--
-- Atomic check-and-decrement for the ToolRouter "premium searches"
-- allocation. Called by lib/toolrouter-client.ts AFTER a successful
-- ToolRouter HTTP call (see §5.3.5 — wrapper ordering is "call FIRST,
-- decrement AFTER" to avoid the data-loss-on-network-failure bug).
--
-- Tier source-of-truth: instaclaw_subscriptions.tier (verified in the
-- codebase at lib/billing-status.ts and the access-control PRD).
-- Subscriptions is keyed by user_id which matches our RPC parameter.
-- We fall back to 'starter' if no subscription row exists (matches
-- the existing instaclaw_check_limit_only RPC pattern at
-- supabase/migrations/20260225_split_limit_check.sql:130).
--
-- TIER CHANGE EDGE CASES (Issue 6 from the 2026-05-27 PRD review):
--   - DOWNGRADE mid-cycle: a Power user (1500) who downgrades to
--     Starter (60) mid-month must have their balance capped to 60
--     immediately on next call. The cap-down block (after monthly
--     reset block) handles this. They lose the excess — correct,
--     they're no longer paying for it.
--   - UPGRADE mid-cycle: a Starter user (60, used 50, balance=10)
--     who upgrades to Pro (400) should see balance jump to max(10,
--     400) = 400 immediately. The cap-UP block lets the user see
--     the benefit of paying more right away (vs. waiting for the
--     monthly reset).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.instaclaw_consume_toolrouter_searches(
  p_user_id UUID,
  p_weight INTEGER,
  p_endpoint_id TEXT,
  p_charged BOOLEAN,
  p_trace_id TEXT
) RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE
  v_user RECORD;
  v_tier TEXT;
  v_tier_grant INTEGER;
  v_grant INTEGER;
  v_now TIMESTAMPTZ := NOW();
  v_balance INTEGER;
  v_topup INTEGER;
  v_period_start TIMESTAMPTZ;
  v_alloc_source TEXT;
  v_hit_80 BOOLEAN := FALSE;
BEGIN
  -- ── 1. charged=false → sponsored by AgentKit, no decrement ──
  IF NOT p_charged THEN
    RETURN json_build_object('allowed', true, 'balance_after', NULL,
      'allocation_source', 'sponsored_agentkit', 'hit_80pct', false);
  END IF;

  -- ── 2. Load user row + commercial tier ──
  -- Lock the user row for the duration of this RPC (atomic check-and-decrement).
  SELECT * INTO v_user FROM public.instaclaw_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('allowed', false, 'error', 'no_user');
  END IF;

  -- Read commercial tier from instaclaw_subscriptions (canonical source per
  -- access-control-credits-upgrade.md §2.3). Fall back to 'starter' if no
  -- subscription row — mirrors the instaclaw_check_limit_only RPC pattern.
  SELECT COALESCE(s.tier, 'starter') INTO v_tier
  FROM public.instaclaw_subscriptions s
  WHERE s.user_id = p_user_id
  LIMIT 1;
  v_tier := COALESCE(v_tier, 'starter');

  -- ── 3. Compute tier-default grant (Issue 3 fix — no hardcoded 60) ──
  -- Mirrors the constant TOOLROUTER_TIER_GRANTS in lib/toolrouter-credits.ts.
  -- Any tier not in the CASE returns 60 (treat unknown tiers as Starter).
  v_tier_grant := CASE v_tier
    WHEN 'power'      THEN 1500
    WHEN 'pro'        THEN 400
    WHEN 'starter'    THEN 60
    WHEN 'free_trial' THEN 20
    WHEN 'byok'       THEN 60   -- BYOK users get Starter-equivalent allocation
    ELSE 60
  END;

  v_grant := COALESCE(v_user.toolrouter_grant_override, v_tier_grant);
  v_period_start := v_user.toolrouter_grant_period_start;

  -- ── 4. Monthly reset (timezone-aware) ──
  IF v_period_start IS NULL OR
     (v_now AT TIME ZONE COALESCE(v_user.timezone, 'UTC')) -
     (v_period_start AT TIME ZONE COALESCE(v_user.timezone, 'UTC'))
     >= INTERVAL '1 month' THEN
    UPDATE public.instaclaw_users
      SET toolrouter_balance = v_grant,
          toolrouter_grant_period_start = v_now,
          toolrouter_80pct_notified_at = NULL
      WHERE id = p_user_id;
    v_user.toolrouter_balance := v_grant;
  END IF;

  v_balance := v_user.toolrouter_balance;

  -- ── 5. Tier-change edge-case handling (Issue 6) ──
  -- After monthly reset is settled, apply mid-cycle tier changes:
  --   (a) DOWNGRADE: if current balance exceeds the new tier's grant,
  --       cap to grant. User loses the excess.
  --   (b) UPGRADE: if current balance is below the new tier's grant,
  --       jump to grant. User sees benefit immediately on next call.
  -- The combined effect: balance == max(min(v_balance, v_grant), v_grant)
  -- on tier change. We split into two IF blocks for clarity + audit trail.
  IF v_balance > v_grant THEN
    -- Downgrade: cap balance to new lower grant.
    UPDATE public.instaclaw_users
      SET toolrouter_balance = v_grant
      WHERE id = p_user_id;
    v_balance := v_grant;
  ELSIF v_balance < v_grant
        AND v_period_start IS NOT NULL  -- skip if we just did monthly reset
        AND v_user.toolrouter_80pct_notified_at IS NOT NULL  -- proxy for "user is mid-cycle"
        THEN
    -- Upgrade: bump balance to new higher grant immediately. The
    -- toolrouter_80pct_notified_at-is-set check is a defensive proxy for
    -- "user has been using the system mid-cycle"; without it, a brand-new
    -- user on Pro tier would get bumped from 0 → 400 on their first call
    -- (which would actually still be correct, just covered by the monthly
    -- reset block above).
    UPDATE public.instaclaw_users
      SET toolrouter_balance = v_grant,
          toolrouter_80pct_notified_at = NULL  -- reset the 80% gate since balance jumped
      WHERE id = p_user_id;
    v_balance := v_grant;
  END IF;

  v_topup := v_user.toolrouter_topup_balance;

  -- ── 6. Try sponsored-paid first, then topup-paid ──
  IF v_balance >= p_weight THEN
    UPDATE public.instaclaw_users
      SET toolrouter_balance = toolrouter_balance - p_weight
      WHERE id = p_user_id;
    v_alloc_source := 'sponsored_paid';
    v_balance := v_balance - p_weight;
    -- 80% check
    IF (v_grant - v_balance)::FLOAT / v_grant >= 0.80
       AND v_user.toolrouter_80pct_notified_at IS NULL THEN
      UPDATE public.instaclaw_users
        SET toolrouter_80pct_notified_at = v_now
        WHERE id = p_user_id;
      v_hit_80 := TRUE;
    END IF;
  ELSIF v_topup >= p_weight THEN
    UPDATE public.instaclaw_users
      SET toolrouter_topup_balance = toolrouter_topup_balance - p_weight
      WHERE id = p_user_id;
    v_alloc_source := 'topup_paid';
    v_topup := v_topup - p_weight;
  ELSE
    -- This branch fires from the optimistic-concurrency post-hoc check:
    -- the call already happened and we've already paid for it. The wrapper
    -- should still return the result to the user; the platform eats the
    -- cost. See §5.3.5 "Wrapper ordering" for the data-loss rationale.
    RETURN json_build_object('allowed', false, 'balance_after', v_balance,
      'topup_after', v_topup, 'allocation_source', 'blocked',
      'weight_required', p_weight,
      'note', 'post_hoc_check_only_call_already_made');
  END IF;

  RETURN json_build_object('allowed', true, 'balance_after', v_balance,
    'topup_after', v_topup, 'allocation_source', v_alloc_source,
    'hit_80pct', v_hit_80, 'tier', v_tier, 'tier_grant', v_tier_grant);
END $$;

CREATE OR REPLACE FUNCTION public.instaclaw_add_toolrouter_searches(
  p_user_id UUID,
  p_credits INTEGER
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.instaclaw_users
    SET toolrouter_topup_balance = toolrouter_topup_balance + p_credits
    WHERE id = p_user_id;
END $$;
```

**Task K.4 — Wrapper (REVISED PM-6: call-first, decrement-after)**

New file `instaclaw/lib/toolrouter-client.ts`:
- Exports `callToolRouter(endpoint_id, input, ctx) → Promise<WrapperResult>`.
- **Ordering** (Issue 4 fix — see §5.3.5 for full code): call ToolRouter
  HTTP endpoint FIRST. Read response.charged. THEN conditionally call
  `instaclaw_consume_toolrouter_searches` RPC. Never decrement before
  the call succeeds. This is optimistic-concurrency: the agent's
  pre-call balance read (from `TOOLROUTER_BALANCE` env var) is the
  authorization gate; the RPC is the atomic ledger update.
- **Three return shapes** (Issue 5 fix):
  - `{toolrouter_unavailable: true, fallback: "free_tools", ...}` —
    HTTP call failed (network/5xx). Agent silently uses free tools;
    NO upsell, NO mention of ToolRouter to user.
  - `{allowed: true, response, allocation_source, balance_after, hit_80pct, ...}` —
    successful path. `allocation_source` is one of:
    `sponsored_agentkit` / `sponsored_paid` / `topup_paid` /
    `post_hoc_exceeded`.
  - The legacy `{upsell_required: true}` shape is REMOVED. The
    upsell fires from the agent's PRE-CALL check on
    `TOOLROUTER_BALANCE`, not from the wrapper return. The wrapper
    never blocks at request time.
- Logs every call to `instaclaw_toolrouter_call_log` with
  `allocation_source` (including `toolrouter_unavailable` and
  `post_hoc_exceeded`).
- Per-call timeout: 30s for non-async endpoints; 60s for
  Browserbase session creation; for Manus / Parallel.task async,
  the wrapper returns immediately after _start, the user polls.

**Task K.5 — Stripe SKU + top-up route extension**

1. Manually create `STRIPE_PRICE_TOOLROUTER_100` in Stripe dashboard:
   $10 one-time, 100 premium searches.
   Set Vercel env var `STRIPE_PRICE_TOOLROUTER_100=<price_id>` via
   `printf 'price_xxx' | npx vercel env add STRIPE_PRICE_TOOLROUTER_100 production`
   (Rule 6).
2. Edit `app/api/billing/credit-pack/route.ts` line 8 `CREDIT_PACKS` —
   add `"toolrouter_100": { credits: 100, label: "100 premium searches — $10", envKey: "STRIPE_PRICE_TOOLROUTER_100" }`.
3. Add `metadata.target: "toolrouter"` to the Stripe Checkout
   metadata when pack starts with `toolrouter_`. This routes the
   webhook to the new handler.
4. Edit `app/api/billing/webhook/route.ts:97+` — extend the
   `credit_pack` branch to check `metadata.target`:
   - `"toolrouter"` → call `instaclaw_add_toolrouter_searches` RPC
     instead of `instaclaw_add_credits`.
   - default (absent / other) → existing behavior unchanged.

**Task K.6 — SOUL.md / AGENTS.md routing**

Add `TOOLROUTER_BILLING_V1` marker block to
`lib/workspace-templates-v2.ts` (V2) and `lib/agent-intelligence.ts`
(V1 supplement). Content per §5.3.3 (verbatim copy) + §5.3.6
(decision tree). Total addition ~900 chars (within
`feedback_skill_size_budget.md` ceiling — slightly over the 600
target because Task K's marker is doing more work than typical
markers; justified by the canonical-pattern role).

Idempotency MARKER (not Rule 23 sentinel — same distinction from
§4.7 above).

**Task K.7 — Wrapper-level balance refresh into .env**

`stepToolRouter` reconciler step extension (§4.5): after the
ToolRouter MCP config write, ALSO write current allocation balance
to `~/.openclaw/.env`:

```
TOOLROUTER_BALANCE=<user.toolrouter_balance>
TOOLROUTER_TOPUP_BALANCE=<user.toolrouter_topup_balance>
TOOLROUTER_GRANT_TOTAL=<user.toolrouter_grant_override OR tier default>
```

Refreshed on every reconcile cycle (~3 min). Stale by up to one
cycle, which is fine because the wrapper RPC is the source of truth
at call-time. The env vars exist so the AGENT can quote remaining
balance in pre-action transparency messages without an extra DB
hit.

**Task K.8 — Coverage script**

`scripts/_coverage-toolrouter-allocation.ts` per Rule 27. Random-
sample 5 VMs; verify (a) `.env` has `TOOLROUTER_BALANCE` set, (b)
matches DB, (c) `instaclaw_toolrouter_call_log` has rows. Exits 1
on any miss.

**Task K.9 — Dashboard**

New section in `app/(dashboard)/dashboard/credits/page.tsx`:
"Premium tools (ToolRouter)" card showing:
- Current balance / monthly grant total
- Reset date (next month-boundary in user's TZ)
- Top-up balance separately (stacks on monthly)
- Button "Add 100 premium searches — $10" → POST `/api/billing/credit-pack` with `{pack: "toolrouter_100"}`
- Last 20 calls table with endpoint, weight, allocation_source,
  balance after.

**Task K.10 — the active canary VM verification of the upsell flow**

Per Rule 64, ADDED to Task J (§7.10) canary checklist:
1. Set Cooper's `toolrouter_grant_override` to 5 (small number) so
   the upsell fires quickly.
2. Cooper sends Manus deep research request: expect pre-action
   transparency ("counts as 15 premium searches; you have 5 left").
3. Cooper sends another premium search: expect 100% upsell message
   with the "(a) free fallback / (b) top-up $10" options.
4. Cooper replies "(b)" — agent returns Stripe Checkout URL.
5. Cooper opens URL in browser, completes test purchase. Webhook
   fires; balance updates.
6. Cooper sends next request: expect "got it, 100 added. running it
   now."
7. Reset `toolrouter_grant_override` to NULL post-canary.

**Task K.11 — Free-fallback adequacy verification**

Before fleet ship, verify each free-fallback path returns useful
results for typical user queries. Cooper sends 5 representative
queries to the active canary VM via the free-tools-only path (manually disable
ToolRouter via env var); confirms results are USEFUL, not garbage.
If any path fails → revise the §5.3.3a free-fallback table.

### 7.12 Done-when summary

- All 6 of §6 open questions answered (at least Q1, Q2, Q6 resolved before
  v1; Q3-5 + Q7 can be deferred).
- API key issued and verified working.
- AgentBook registration completed (§4.8) — `lookupHuman()` returns
  Cooper's human_id for the platform wallet.
- Reconciler step deployed; coverage script passes 5/5.
- the active canary VM successfully uses 3+ tool categories in real prompts from
  Cooper, with costs tracked locally and matching dashboard.
- **Task K (allocation + in-chat upsell) deployed**: full upsell flow
  exercised on the active canary VM per K.10. Free-fallback paths verified
  useful per K.11.
- Admin alerting fires correctly on a synthetic low-balance test.
- Cooper sends ship approval; fleet propagation completes within ~30 min.

---

## 8. Risks, Failure Modes, Non-Goals

### 8.1 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Andy doesn't issue an API key promptly | Low (Andy proactively shared the product) | v1 is gated; we don't ship until the key is in hand |
| Per-session stdio cold-start exceeds OpenClaw's tool-init budget | Medium (Rule 35 lesson) | Pre-pull npm package in configureOpenClaw (§4.4); measure cold-start on the active canary VM; if too slow, escalate to Andy on streamable-http (Q2) |
| Credit balance exhausts during a runaway prompt-injection loop | Low-medium | ToolRouter's per-call `maxUsd` cap (mentioned in docs) + our admin alerting + per-VM rate limits |
| A single rogue agent burns through everyone's credit balance | Medium (shared-key model) | Per-VM rate limits (Q5); v1.5 sub-keys if available; ToolRouter's per-key spend caps |
| ToolRouter API shape changes underneath us | Low (Andy controls it) | Pin to a specific `@worldcoin/toolrouter` npm version in v1.5 (today: `npx -y` floats to latest); Rule 23 sentinel guards on the MCP config |
| ToolRouter.world goes dark unexpectedly | Low (Andy ships proactively) | Self-hostable backend (§1.5) is the disaster-recovery path; document but don't engineer for it |
| AgentKit boost requires World ID delegation we haven't surfaced | Low-medium | Q3 — if required, wire delegation through `mini.instaclaw.io` World ID session |
| Provider catalog changes (new tools added, old tools deprecated) | High over months | Discovery primitives in the adapter (`toolrouter_list_endpoints`) let the agent self-update without manifest changes; no static catalog to maintain on our side |

### 8.2 Non-goals

- **Not building our own paid SaaS proxy.** ToolRouter IS the proxy.
  Anything we built would be strictly worse.
- **Not self-hosting ToolRouter.** Pure operator overhead, zero strategic
  benefit. Disaster-recovery option only.
- **Not deprecating any existing tool surface.** Local Chromium, curl,
  Polymarket skill, Solana DeFi skill, gbrain, Bankr CLI, Index Network MCP
  — all stay. ToolRouter is additive.
- **Not adding ToolRouter as a Base MCP skill plugin.** Different surface,
  different transport, different billing model. They live side-by-side, not
  nested.

### 8.3 Rollback

- **v1 rollback**: `printf 'false' | npx vercel env add TOOLROUTER_ENABLED production`.
  `stepToolRouter`'s gate 1 short-circuits; existing on-disk configs stay
  (cold storage; not actively used because OpenClaw also reads the env
  var on restart — TBD; see Q2's transport answer). For a full hot rollback:
  add a `stepToolRouterRemove` step that deletes `mcp.servers.toolrouter`
  via `openclaw config delete mcp.servers.toolrouter`. Hot-reloadable.
- **API key rotation**: if the platform key leaks, follow CLAUDE.md
  "Rotating secrets" runbook — `printf` new value + bump `SECRET_VERSION`;
  fleet picks up in ~3h. ToolRouter-side rotation needs operator step at
  toolrouter.world dashboard.

---

## 9. CLAUDE.md Rule Conformance Checklist

This work must respect (and the implementation tasks above do respect):

- **Rule 5** (gateway health verify after config set) — every
  `openclaw mcp set` followed by Rule 32 §3 verify
- **Rule 6** (no trailing newlines in env vars) — every
  `vercel env add` uses `printf`, never `echo` or `<<<`
- **Rule 8** (no manual VM provisioning) — n/a, this is reconciler-driven
- **Rule 10** (verify every config set; no `|| true`-suppress) —
  `stepToolRouter`'s gate 5 verify-after-set is the load-bearing check
- **Rule 19** (`.select("*")` for safety-critical reads) — if/when we add
  the `toolrouter_api_key` column in v1.5, reads that gate destructive
  action use `.select("*")`
- **Rule 22 / Rule 30** (never destructively modify session/state) — n/a,
  ToolRouter is stateless from our side
- **Rule 23** (sentinel-grep required templates) — n/a for v1
  (corrected from first draft). v1 adds no `vm-manifest.ts:files[]`
  entries; the only embedded content is the SOUL.md / AGENTS.md
  routing block, which uses the marker idempotency pattern (not
  `requiredSentinels`). If v2 adds executable scripts, those WOULD
  get sentinels.
- **Rule 27** (coverage scripts) — `_coverage-toolrouter.ts` per Task G
- **Rule 32** (hot-reload classification) — `mcp.servers.toolrouter` IS
  hot-reloadable (mcp.servers.* namespace verified); no
  `RESTART_REQUIRED_CONFIG_PREFIXES` change needed
- **Rule 34** (DB ↔ disk drift) — if v1.5 adds the sub-key column, add a
  verifier step parallel to `stepEdgeOSApiKey`
- **Rule 38** (atomic-write tmp files self-clean on ENOSPC) — n/a (no new
  tmp-write paths)
- **Rule 39** (distinguish critical from optional sidecar failures) —
  ToolRouter is optional paid SaaS; failures push to `result.warnings`,
  never block cv-bump
- **Rule 47** (continuous reconciliation, not version-gated) — manifest
  bump for the step addition; file-drift cron for any future template
  refresh
- **Rule 49** (partner secrets actively verified) — TOOLROUTER_API_KEY
  added to `SECRET_VERIFIERS` (Task D)
- **Rule 56** (migration files self-contained) — v1.5 migration goes
  pending → Studio apply → migrations, with `ENABLE RLS` per Rule 60
- **Rule 58** (cross-consumer token sync) — TOOLROUTER_API_KEY exists in
  Vercel env + on-VM `.env` + (v1.5) in `openclaw.json` MCP env block; all
  must match
- **Rule 60** (migrations enable RLS in same file) — applies to v1.5+
- **Rule 61** (boolean env vars validated by value, not presence) —
  `TOOLROUTER_ENABLED` follows the pattern; `TOOLROUTER_TRANSPORT` is an
  enum but same discipline applies (warn on misconfigured values)
- **Rule 64** (manifest version bumps require explicit Cooper approval) —
  the active canary VM BEFORE fleet bump; Cooper says "ship it" in the same
  session
- **Rule 66** (every agent has primary + backup wallet) — n/a, no wallet
  changes
- **Rule 67** (Anthropic balance monitoring pattern) — ToolRouter balance
  alerting in Task H mirrors Rule 67 patterns

---

## 10. Strategic Notes for Cooper

These don't go in the implementation plan but matter for the relationship.

### 10.1 The framing for Andy

If Cooper shares this PRD with Andy (recommended once Q1-2 are resolved),
the framing is:

> *"You shipped ToolRouter to solve the 'every agent needs paid tools'
> problem. Our 150-agent fleet is exactly the integration partner you want
> for the v1 reference deployment. Here's our plan — and here are six
> questions where your answers shape the integration. We can ship to fleet
> the week your answers land."*

The PRD itself signals seriousness — the depth of the integration analysis,
the explicit rule conformance, the rollback story, the strategic alignment
with World's broader stack. **Andy will read this and either confirm our
direction (in which case we ship in a week) or push back early (in which
case we save weeks).**

### 10.2 The dependency graph between PRDs

For Cooper's mental model:

```
                  Base MCP v1   ◄────── This PRD v1
                  (Layer A)              (Layer B)
                       │                    │
                       ▼                    ▼
                  Base MCP v1.5         This PRD v1.5
                  (Sub Account)        (per-VM keys + auto-top-up)
                       │                    │
                       └───────┬────────────┘
                               ▼
                      Base MCP v2 / v2.5
                      (Layer C — producer)
                               │
                          ┌────┴────┐
                          ▼         ▼
                    Base MCP    This PRD v2
                    skill        (InstaClaw agents as
                    plugin       ToolRouter endpoints)
                          │         │
                          └────┬────┘
                               ▼
                         Base MCP v3
                         (ERC-8004 reputation)
```

Critically: **THIS PRD v1 ships INDEPENDENTLY of Base MCP v1**. The two
work streams can ship in parallel, same week. Layer B (paid SaaS) and Layer
A (free onchain reads) don't share infrastructure beyond the reconciler
orchestrator chain.

### 10.3 The producer-side strategic bet

§5.3 (v2) is the strategic upside. If we list InstaClaw agents as
ToolRouter endpoints, then:

- A user on Claude Desktop with the ToolRouter MCP installed can DM their
  Claude "find me an InstaClaw agent that can monitor a Twitter handle for
  signals" — ToolRouter's recommendation engine routes the discovery, our
  agent gets hired, gets paid, builds reputation.
- Other autonomous agents using ToolRouter discover us the same way.
- The 16-endpoint catalog grows. With InstaClaw listings added, it becomes
  17+, with our entries differentiated by "persistent, real-computer agent
  with real wallet, real reputation."

This is the closest thing to a marketplace flywheel any of our partners
can provide today. Build the consumer side (v1) first, prove it, then
flip to producer (v2).

### 10.4 The World ID + AgentKit competitive moat

[Added 2026-05-27 after AgentKit billing model was verified.]

This is the section to share with Andy first if Cooper picks one.

**The claim**: InstaClaw + World ID auth + ToolRouter AgentKit benefits
is a first-mover competitive advantage that no other agent platform has
yet replicated, and that doing so requires restructuring their identity
model — a multi-quarter effort for any large platform. World is
actively recruiting partners, so the moat is real but time-bounded.
The goal is to compound the head start while the gap is open. Built
on three structural facts that create real friction (not impossibility)
for replicators:

1. **mini.instaclaw.io already authenticates users via World ID.** Every
   user that signs up through the mini-app or `/go` short link with
   World ID has a verifiable World ID nullifier on file. We're the
   only consumer-facing AI agent platform with this signal at scale.
2. **AgentKit benefits flow from a wallet's AgentBook registration.**
   The registration proof is a World ID proof. Cooper can register
   InstaClaw's platform wallet on AgentBook in five minutes (one tap in
   the World App after the CLI prepares the signal — see §4.8 above).
3. **The AgentKit-eligible tools are EXACTLY the high-traffic ones**:
   web search (Exa) and research (Manus) — the two tools every agent
   wants to use frequently. The "free trial" path is path=agentkit,
   charged=false. Real zero cost (§1.6).

**Net effect for the user**: an InstaClaw agent doing 200 Exa searches
this month costs the platform $0 because Cooper-as-AgentBook-registered-
human delegated to the agent's wallet. The same agent on a non-World-
integrated platform would cost ~$1.40. **At fleet scale (150 VMs,
power-user assumption ~800 searches/mo), that's $245/mo of free
infrastructure value that exists because we wired World ID at signup.**

**Why this is hard (not impossible) to replicate**:
- ChatGPT, Cursor, Claude Desktop don't run AgentBook-registered wallets
  per user. They don't have per-user verified-human identity on World
  Chain. AgentKit's verification function returns false for every call
  from those platforms.
- For OpenAI or Anthropic to match this, they'd need to wire World ID
  into their auth surface AND register a wallet per user AND maintain
  the AgentBook delegation. That requires either becoming a money
  transmitter or partnering with someone (likely Coinbase) at depth
  Coinbase isn't going to extend without strategic reason.
- For an upstart agent platform, World ID integration is hard because
  it requires a real mobile app integration (the World App) which means
  shipping a mobile surface OR routing users to a mini-app at signup.
  Most agent platforms are pure browser/desktop.

The pitch frame to Andy is "first and hard to follow" not "nobody can
ever do this" — Andy knows the latter isn't true. The honest framing
is more compelling AND more accurate.

**The narrative for Andy** (one-liner that frames the partnership):

> "AgentKit verification is the reason InstaClaw chose ToolRouter over
> building our own paid-tool proxy. Your verification model means our
> agents get premium tools for free that other platforms' agents pay
> full price for — and the reason it works is that we already authenticate
> every user with World ID. The competitive moat for InstaClaw is
> literally validation of the AgentKit thesis at production scale.
> We're proof-of-concept #1 that AgentKit's economic model is real."

**The slide for the next World Build talk** (one diagram, three boxes):

```
World ID auth          AgentKit-registered            ToolRouter AgentKit
@ mini.instaclaw.io →  agent wallet (one-time)    →   benefits applied at request time
                                                       ─────────────────────────
                                                       Exa search: free
                                                       Manus research: 2/mo free
                                                       Browserbase: premium browsers

For ChatGPT users:                                    "agentkit_to_x402" — paid.
```

**The strategic upside for World**:
- Every InstaClaw user becomes a World ID success story. We had 30k
  signups before this; if AgentKit makes our tools materially cheaper
  than competitors' equivalent tools, more users join, more World IDs
  get verified.
- Andy's product team gets a real-world adoption curve to point to:
  "150 production agents using ToolRouter via AgentKit, $X of verified
  free-trial activity per month."
- The story compounds: every InstaClaw user converted to World ID is
  also a Bankr wallet → CDP wallet → Sub Account holder. AgentKit
  becomes the on-ramp to the full World stack.

This is the section to share with Andy. The version that makes him
reply *"this is exactly how I hoped someone would integrate."*

### 10.5 The "delete this PRD if Andy's plans diverge" clause

If Andy's responses to the §6 questions surface a fundamental conflict
with our architecture (e.g., "ToolRouter is moving to a closed marketplace
with no platform-key model" or "we're deprecating stdio adapter, only
WebSocket from here on"), this PRD's v1 path may be wrong. The PRD is
designed to be cheap to revise — the helper module pattern + the secret
distribution pipeline are reusable for any partner; only the wiring shape
changes.

**Honesty clause** (per Cooper's instructions): if v1 ends up being a
bad fit, the right move is to flag it before shipping, not to ship a
half-fit. Better to say "we should wait for v0.next of ToolRouter" than
to absorb integration debt that's wrong for both sides.

---

## 11. Decision Log

- **2026-05-27**: PRD authored same-day as Andy sharing ToolRouter in the
  InstaClaw × World group chat. Six open questions documented; no code
  lands until at least Q1, Q2, Q6 are answered.
- **2026-05-27**: Decision to use Path C (per-session stdio adapter) for v1,
  because Path A (hosted streamable-http MCP) doesn't exist today.
  Concurrently propose Path A to Andy as v1.5 ask.
- **2026-05-27**: Decision NOT to build a custom HTTP shim around the stdio
  adapter (Path B). Andy's adapter is canonical; reproducing it adds drift
  risk; Path A would obsolete the shim immediately.
- **2026-05-27**: Decision to treat ToolRouter as ORTHOGONAL to Base MCP
  skill plugins (zero tool overlap). Both ship parallel; both are Layer A/B
  in the three-layer model.
- **2026-05-27**: Decision to use a single platform-scoped API key for v1
  (simplest ops; matches what Andy has published). Sub-keys are a v1.5
  enhancement gated on Q1.
- **2026-05-27**: Decision to defer v2 (InstaClaw as ToolRouter producer)
  until Base MCP v1.5 (Sub Account) + base infrastructure for per-VM
  ingress lands. Producer surface depends on a settled wallet stack.
- **2026-05-27**: Honesty-clause noted: if Andy's roadmap diverges from this
  PRD's assumptions, the right move is to flag and pause, not absorb wrong
  integration debt.
- **2026-05-27 (audit, post-Draft 1)**: stress-tested Draft 1 against the
  actual codebase. Corrections landed in-file:
  - §4.4 npm pre-pull command (`npx -y ... --help`) doesn't work — the
    adapter is a stdio MCP server with no `--help` flag. Replaced with
    pinned-global-install pattern mirroring OpenClaw / gbrain.
  - §4.5 stepToolRouter `verifyMcpConfigShape` against
    `.transport` field is wrong for stdio (which uses `.command`).
    Replaced with transport-specific discriminating-field reads.
  - §4.7 + §7.6 + §9 — first draft conflated "marker" (idempotency
    guard for SOUL.md inserts) with "Rule 23 sentinel" (manifest
    files[] guard). Corrected; markers are the right primitive here.
  - §7.2 — added `TOOLROUTER_TRANSPORT` to `BAKE_ENUM_ENVS` (not
    `BAKE_BOOLEAN_ENVS`); references `BASE_SKILLS_SOURCE_MODE` as
    direct precedent.
  - §7.2 — SECRET_VERSION bump made explicit: current 4 → 5.
  - §5.1 preconditions narrowed: Q1 + Q6 + Q8 are blocking; Q2, Q3,
    Q5 are operator-context but don't block v1 code.
  - Q8 added (pin version policy + changelog convention).
  - Q9 added (multi-tenancy data privacy — flagged in §14.2).
- **2026-05-27 (Phase 2 amendments)**: Five operational concerns missing
  from Draft 1 added as new §13-§16:
  - §13 — Failure modes (downtime, long-running calls, catalog growth,
    Layer A vs B routing priority, tool quality variance).
  - §14 — Security posture (platform key blast radius, mitigations,
    Q9 multi-tenancy concern).
  - §15 — Cost modeling (real session decomposition, tier
    sustainability math, three mitigation paths).
  - §16 — Agent decision surface (cost-aware routing in SOUL.md,
    explicit cost columns, routing priority gates).
- **2026-05-27 (Phase 3 strategic)**: §17 added — three "wow Andy"
  opportunities ranked by buildability + strategic compound: Fleet
  Canary (ship with v1), Tool Quality Memory (v1.5), World Build demo
  (when Cooper picks).
- **2026-05-27 (AgentKit billing-model deep audit)**: source-level
  verification of `andy-t-wang/toolrouter` (via `gh api`). Findings:
  - **Verified mechanism**: AgentKit is World Foundation's verified-
    human-delegation layer launched 2026-03-17. Per-human delegation
    via AgentBook contract on World Chain (`eip155:480`).
    Registration: `npx @worldcoin/agentkit-cli register <addr>` →
    World App proof → AgentBook stores `agent_wallet → human_id`.
  - **Verified execution path**: ToolRouter executor's
    `agentkit_first` mode tries AgentKit first (server-side EIP-191
    signing with the account's Crossmint wallet), falls through to
    x402 on 402 response. Three paths logged: `agentkit` (free),
    `agentkit_to_x402` (paid retry), `x402` (paid direct).
  - **Verified catalog classification**: 3 of 16 endpoints support
    AgentKit (`exa.search` free_trial, `manus.research` free_trial w/
    2/mo cap, `browserbase.session` access). The other 13 (all
    Parallel + all AgentMail + all StableTravel) are x402-only with
    no AgentKit benefit.
  - **Cost-model revision**: Scenario A (Cooper does AgentBook
    registration) → ~$20/mo total fleet COGS. Scenario B (no
    registration) → ~$271/mo. Either is trivially absorbable
    against $4350/mo hosting revenue at 150 VMs.
  - **§1.4 rewritten** with verified mechanism. §1.5 added with
    verified catalog. §1.6 added with verified execution paths.
  - **§4.8 (new) AgentBook registration flow** documenting the one-
    time Cooper-clicks-World-App setup that gates the AgentKit moat.
  - **§4.9 (renumbered) Admin observability** revised to track
    `path` × `charged` distinctly. New per-path metric: % of calls
    on path "agentkit" — the AgentKit utilization signal.
  - **§5.3 (new) Cost model recommendation: Option C (hybrid)** —
    ship Option A (absorb COGS) in v1 with §15.5 daily spend caps as
    defensive ceiling, measure 2-4 weeks, graduate to Option B per-
    user metering only if triggers fire (single user >$10/mo OR
    fleet cost >5% of revenue).
  - **§5.4 (renumbered)**: v2 spec moved from old §5.3.
  - **§10.4 (renumbered) The World ID + AgentKit competitive moat**
    new section: framing for Andy. The pitch that makes the World
    partnership feel structurally significant.
  - **§15 fully revised** with verified per-endpoint pricing, two-
    scenario cost projection, and mandatory v1 §15.5 daily-spend cap.
  - **§16.2 routing block revised** with explicit AgentKit-value
    column per tool. Critical economic information that the agent
    needs at routing time.
  - **Q3 elevated to P0 blocker** — recast as "what's the Exa free-
    trial cap?" since that's the only number that materially shifts
    the cost model.
  - **Q3a, Q3b added**: programmatic AgentBook registration, per-user
    delegation roadmap. Q9 (multi-tenancy data-privacy) from Phase 1
    audit becomes more interesting under the per-user delegation model
    in Q3b — if each user gets their own AgentBook entry, the multi-
    tenancy concern shrinks dramatically.
- **2026-05-27 PM (Cooper override — Option C → Option B in v1)**:
  Cooper reviewed the Option C recommendation in §5.3 and overrode.
  Per-tier monthly allocation + in-chat upsell ships in v1, not
  deferred. Reasoning he gave:
  1. The in-chat upsell infrastructure already exists (Higgsfield
     Rule 4, mini-app paused banner, Stripe credit-pack SKUs).
     Extending these is wiring, not new UX.
  2. In-chat micro-upsells are a competitive advantage in their own
     right — limit-hit = teaching + monetization moment.
  3. §15.5 daily cap stays as abuse ceiling ABOVE the allocation.
     Two layers compose cleanly.
- **2026-05-27 PM-2 (deep upsell-infrastructure research)**: studied
  existing canonical patterns before locking the spec. Findings:
  Higgsfield uses pre-action credit transparency ("80 credits, you
  have 420 remaining"); mini-app uses reactive paused-banner upsell;
  Stripe top-ups use the `app/api/billing/credit-pack/route.ts`
  pattern with metadata-typed Stripe Checkout; the `access-control-
  credits-upgrade.md` PRD explicitly flags "no proactive low-balance
  warning" as P4 gap — our 80% soft hint CLOSES that gap.
- **2026-05-27 PM-3 (Cooper reframe — sponsored tier, not metered
  cost)**: Cooper sent a critical framing update: the allocation is
  NOT "InstaClaw's limit"; it's "the free tier sponsored by our
  World partnership via AgentKit." This changed everything in §5.3:
  - Allocations recalibrated from dollar-amounts to "premium searches"
    (60/400/1500 by tier), sized at ~2x median §15.3 usage so most
    users never see the upsell.
  - Top-up SKU changed from `STRIPE_PRICE_TOOLROUTER_1000` ($10 →
    1000 credits) to `STRIPE_PRICE_TOOLROUTER_100` ($10 → 100
    premium searches). Simpler user-facing math; 93% gross margin.
  - The `charged: false` carve-out (§5.3.5) becomes the load-bearing
    UX nuance: AgentKit-free calls don't decrement allocation. This
    preserves the §10.4 World ID + AgentKit competitive moat.
  - Upsell copy reframed: "want more?" not "you've hit a wall." Two
    equal options at 100% ("what do you prefer?"), no platform push.
  - 3-step agent decision tree (§5.3.6) added: free-fallback first
    if adequate, then sponsored-paid, then upsell at allocation
    exhaustion.
  - Free-fallback adequacy verification (§5.3.3a) added as
    pre-ship gate.
  - Task K (10 sub-tasks) added to §7 implementation plan with full
    migration, RPC, wrapper, Stripe SKU, SOUL.md routing, dashboard,
    coverage script, canary verification, free-fallback verification.
  - §15.7 added: at v1 scale, top-up revenue ~$20-30/mo; AgentBook-
    registered Scenario A nets ~$0-10/mo positive; non-registered
    Scenario B nets -$241/mo. **AgentBook registration becomes the
    single highest-leverage 5 minutes in this PRD.**
  - §15.8 added: three observability metrics drive v1.5 allocation
    tuning (sponsored % / blocked % / top-up conversion).
- **2026-05-27 PM-4 (copy workshop — full creative + conversion-
  research pass)**: Cooper's PM-4 feedback: the §5.3.3 PM-3 copy
  was "correct mechanically but had no soul. reads like a system
  message from a billing API." Treated as a creative + conversion
  optimization assignment, not a spec edit.
  - §5.3.2a added with full workshop: 25 candidates (5 per message
    type × 5 conversion principles), each annotated with which
    behavioral-econ principle it leverages. Voice anchors
    cross-referenced against `lib/welcome-messages.ts` (the locked
    "every word earned its place through ~10 rounds of editing"
    welcome arc), SOUL.md V2 `## Vibe` + `## Core Truths`, and
    Higgsfield Rule 4. Conversion priors cross-referenced against
    Kahneman's Prospect Theory, HBR study (32% loss-aversion
    lift), SaaS usage-alert data (+30%), Slack/Loom/Grammarly
    value-moment patterns.
  - The KEY conversion finding: loss-frame + specificity at the
    value moment is the strongest single principle, but neutral
    framing builds long-run trust. The winning M3 (100% reached)
    pick is VARIANT C: loss-frame as HONEST opinion ("manus's
    deep research would give you something way better here") +
    concrete-sensory description of what's lost ("the difference
    between 'a summary' and 'a brief you could actually send to
    someone'") + neutral close that preserves user agency ("or
    i'll do the free version if you'd rather. your call."). Has
    both the conversion lift AND the trust-preservation. Cooper's
    candidate VARIANTS A (pure neutral) and B (social proof)
    were close runners-up; B introduces other users into a 1:1
    conversation breaking the intimate frame. D works for repeat-
    hitters but reads slightly off for first-time hits.
  - §5.3.3 replaced with the LOCKED copy + per-tool substitution
    rules. The agent picks the right concrete-sensory framing
    per tool from three pre-written templates (manus, browserbase,
    exa). All five messages share voice characteristics with
    welcome-messages — same personality, same brevity, same
    confident-but-respectful-of-user-agency stance.
  - Dashboard surface (§5.3.3 end) is where "World" gets named
    once ("Powered by our World partnership"). Chat messages are
    tactical and don't repeat the brand frame.
  - Cooper-side conversion validation: §15.7's revenue projection
    is unchanged at +/-$5; the copy lift is downstream of v1.5
    A/B testing on real users, not v1 commitments.
- **2026-05-27 PM-5 (copy re-lock — Cooper resent the prompt with
  "ultrathink")**: treated the resend as a "go deeper" signal,
  audited the PM-4 lock for real gaps, and shipped PM-5 addressing
  five specific findings:
  - **Gap 1**: PM-4 variants were 5 word-swaps of one idea, not 5
    distinct framings. PM-5 forces each variant to pursue a
    different psychological lever.
  - **Gap 2**: PM-4 didn't USE the user's specific ask
    (Cooper PM-2 explicit requirement). PM-5 templates reference
    `{ask_phrase}` placeholder ("the NYC AI infra startup dive")
    instead of generic "this."
  - **Gap 3**: Browserbase + Exa per-tool descriptors were weaker
    than Manus. PM-5 rewrites them: Exa = *"better at finding the
    right thing on the first try"*; Browserbase = *"clean, isolated
    session...local browser leaves traces and might trip a
    bot-check"*. Added templates for Parallel, AgentMail send/read,
    StableTravel.
  - **Gap 4**: PM-4 didn't address Cooper's "less than a coffee"
    anchoring question. PM-5 research (anchoring backfire when too
    high; condescension to power users at our price point) settles
    it: just say "$10" plainly. Documented in §5.3.3 "Why $10 not
    less than a coffee."
  - **Gap 5**: No "read the room" post-choice routing. Research
    from LivePerson / Quidget: *"if user responses become short,
    negative, or dismissive, the AI can gracefully back off."*
    PM-5 adds explicit routing: user picks paid → run immediately,
    no celebration. User picks free → commit fully, don't
    re-mention paid. User short/dismissive → same as picking free.
    Plus a judgment call for ambiguous "wait, do this" → default
    to paid (silence after the prompt closer to "go ahead").
  - M2 (80% hint) re-picked: Variant 3 (work-recap with
    `{top_two_tools_used}`) replaces PM-4 pick. Why: references
    what the user has been DOING — most personal-feeling
    specificity. Mirrors welcome-1's sensory detail
    ("browser, terminal, file system").
  - M4 (top-up confirmed) re-picked: 7-word Variant B
    ("100 added. running {ask_phrase} now.") replaces PM-4's
    2-word "added. running it now." Why: still under 10 words but
    confirms BOTH that the purchase landed AND that the original
    task is resuming. PM-4 was too ambiguous about what got added.
  - M1, M3, M5 retain their PM-4 winning framings but get sharper
    fill-ins (user-ask reference, better per-tool descriptors).
  - Net effect: same personality across all five messages, now
    with personal context the agent fills at runtime. The agent
    sounds like a friend who knows what the user JUST asked for —
    not a billing system that detected a threshold crossing.
- **2026-05-27 PM-6 (final pre-implementation review — 11 issues
  found + fixed)**: Cooper and Claude reviewed the full 3323-line
  PRD cover-to-cover. Found 11 issues ranging from cosmetic to
  data-loss-bug-level. All fixed in PM-6:
  - **Issue 1 (structural)**: §15 had duplicate §15.4 + §15.6/15.4
    out of logical order. Renumbered: 15.1-15.5 stay, 15.6 (Exa cap)
    moved before 15.7, NEW 15.6a (Q3 contingency) added, 15.7/15.8
    stay, duplicate 15.4 renumbered to 15.9. All cross-refs verified
    still valid (no §15.4 or §15.6 references existed in cross-refs).
  - **Issue 2 (duplication)**: dashboard surface block appeared
    twice in §5.3.3. Merged the "NOT ToolRouter — user-facing
    surfaces don't expose the upstream brand" caveat from the
    second into the first, deleted the second.
  - **Issue 3 (real SQL bug)**: K.3 RPC hardcoded
    `COALESCE(v_user.toolrouter_grant_override, 60)` — every Pro and
    Power user would get the Starter (60) allocation on first
    month. Verified tier column lives on `instaclaw_subscriptions`
    (canonical commercial tier source per
    `access-control-credits-upgrade.md`). Rewrote RPC to look up
    tier and CASE-map to the correct grant (1500/400/60/20).
    Includes a fallback to 'starter' if no subscription row
    (mirrors `instaclaw_check_limit_only` pattern at
    `20260225_split_limit_check.sql:130`).
  - **Issue 4 (data-loss bug)**: K.4 wrapper called consume RPC
    BEFORE the HTTP call. If HTTP failed (network/5xx/timeout/
    crash), user's allocation was decremented but never refunded.
    Rewrote the wrapper to "call FIRST, decrement AFTER" —
    optimistic-concurrency pattern. The agent's pre-call
    `TOOLROUTER_BALANCE` env-var check is the authorization gate;
    the RPC is the atomic ledger update. Race condition (user
    exhausts between pre-check and wrapper call) handled by
    post-hoc `{allowed: false}` return that platform absorbs (one
    call), with NEXT call correctly hitting the upsell.
  - **Issue 5 (missing)**: ToolRouter-down error handling missing
    from decision tree + wrapper. Added §5.3.6 Step 2.5 (silent
    free-tools fallback when wrapper returns
    `{toolrouter_unavailable: true}`). Critical: NO user-visible
    upsell, NO mention of ToolRouter. Agent works silently. User
    doesn't know about backend topology.
  - **Issue 6 (missing)**: tier downgrade/upgrade edge cases. Added
    explicit cap-down and bump-up blocks to the RPC. Downgrade
    (Power→Starter) caps balance to new tier grant immediately;
    user loses excess (correct, they're no longer paying for it).
    Upgrade (Starter→Pro) bumps balance to new higher grant
    immediately; user sees benefit on next call (don't wait for
    monthly reset).
  - **Issue 7 (missing)**: Q3 contingency plan. NEW §15.6a
    documents what changes (and what doesn't) if Andy answers Q3
    with "Exa is also 2/month/agent": allocation numbers stay,
    upsell fires more often (good for revenue), moat narrative
    softens, no architectural changes needed.
  - **Issue 8 (tone)**: §10.4 moat framing said "NO other platform
    can replicate." World is recruiting partners; if OpenAI or
    Anthropic wire World ID next quarter, the moat evaporates.
    Softened to "first-mover competitive advantage that no other
    agent platform has yet replicated... requires multi-quarter
    effort for any large platform." Honest framing is also more
    compelling — "first and hard to follow" beats "nobody can
    ever do this."
  - **Issue 9 (consistency)**: §5.3.3 template-vs-literal pattern
    was correct but implicit. Added explicit "Template-vs-literal
    consistency contract" subsection documenting the pattern:
    locked form uses `{placeholders}`, example fill-in shows
    literal version. M5 (no placeholders) is intentionally
    identical between locked and example. 80% in M2 is a literal
    threshold name, not a placeholder.
  - **Issue 10 (stale reference)**: 13 references to vm-1019
    (terminated). Global sed-replace to "the active canary VM."
    Fixed "the active canary VM canary" double-noun artifacts.
  - **Issue 11 (incomplete)**: §4.4 pin policy referenced
    `TOOLROUTER_PINNED_VERSION` without an initial value.
    `npm view @worldcoin/toolrouter version` at 2026-05-27 returned
    `0.1.3`. Added explicit instruction to implementer: re-verify
    via `npm view` at implementation time and pin to that exact
    version. Do not use "latest."
  - **Marker block size verification**: estimated full
    `TOOLROUTER_BILLING_V1` size at ~2,480 chars. Within Cooper's
    approved 5,200-char headroom. Documented in §5.3.3.
  - All cross-references re-verified after the §15 renumber.
    `vm-1019` count post-fix: 0. Tier column source verified at
    `lib/billing-status.ts:42-48,248`.

---

## 13. Failure Modes — Deep Dive (Phase 2 audit finding)

The first PRD draft's §8.1 risk table covered the obvious failure modes
(key compromise, runaway loop, upstream API drift). It missed five that
matter operationally. Each is documented here with detection, blast
radius, and mitigation.

### 13.1 ToolRouter itself goes down

**Scenario**: `toolrouter.world` returns 5xx, has a DNS failure, or hangs
on the underlying x402-to-provider path. Every fleet agent that tries a
paid tool gets stalled or errored.

**Detection latency**:
- Real-time per-tool-call: the agent sees a timeout / non-200 immediately
  and can recover within its turn.
- Cron-detected: `cron/probe-partner-secrets` runs hourly; ToolRouter
  unreachable surfaces in <1h.

**Blast radius**:
- All ~150 VMs lose paid-SaaS capability simultaneously.
- Anything Layer A (free, native) keeps working — Bankr, gbrain, local
  Chromium, Base skill plugins, Polymarket / Solana DeFi, Telegram all
  unaffected. The agent's tool budget DEGRADES, doesn't collapse.

**Mitigation**:
1. SOUL.md routing teaches the agent to fall back: "if ToolRouter
   `exa_search` errors, try local `curl https://api.duckduckgo.com/...`
   or `BRAVE_API_KEY`-backed Brave Search." Cost / quality goes down,
   capability stays.
2. Per Rule 67 alerting pattern: cron emits a P1 admin alert at first
   detection (1h-deduped via `instaclaw_admin_alert_log`).
3. Self-hostable backend (§1.5) is the disaster-recovery path. Multi-day
   outage → operator-side decision to spin up our own ToolRouter
   instance from Andy's repo. We don't engineer for this; it's the
   absolute-last-resort hatch.

**This is BETTER than Index Network's failure mode** (where the agent
silently can't read intent-protocol matches and the user has no idea why
their Edge agent is quiet). For ToolRouter, the agent's user-visible
response degrades gracefully: "I couldn't reach the paid search service
right now; here's what I found via Brave / local sources."

### 13.2 Long-running tool calls — connectionTimeoutMs trap

**Scenario**: Manus Research, deep Browserbase sessions, multi-hop
extracts can take 30s-5min. OpenClaw's MCP `connectionTimeoutMs` field
governs the INITIAL handshake; per-call inactivity timeouts are
upstream-dependent. The `mcp.servers.index` config uses
`connectionTimeoutMs: 5000`. If we copy that for ToolRouter, **a 5-minute
Manus Research call would NOT be killed by the connection timeout
(that's only at handshake), but might be killed by OpenClaw's per-tool
turn budget** — which we don't have great visibility into for stdio
MCPs.

**Detection latency**:
- A specific failure mode: agent invokes `manus_research_start`, gets the
  async job ID, then `manus_research_status` polls return "running" for
  4 minutes, then `manus_research_result` fetch SHOULD work — but if
  OpenClaw's agent-turn budget killed the parent tool-use loop, the
  agent never makes the status/result calls.

**Mitigation**:
1. SOUL.md routing MUST tell the agent: "Manus Research is async. Always
   use `manus_research_start` (returns job_id), then poll
   `manus_research_status` in a NEW agent turn (don't busy-wait in the
   same turn). Use `manus_research_result` only when status reports
   complete."
2. ToolRouter's `manus_research_*` API surface already enforces this
   pattern. We just need the agent to USE it.
3. Per-call cost-side concern: if Manus charges per second of compute,
   a 5-min research = ~$2-5. SOUL.md cost hints (§16) need to flag this.

**Open question for Andy** (logged as Q9 below): does the adapter's
parent process (Andy's MCP server) hold the request open during a 5-min
Manus call, or does it return immediately with a job_id pattern? Per the
adapter README the `manus_research_start` / `_status` / `_result` triplet
suggests async, which is the right pattern.

### 13.3 Catalog growth — unknown-tool surface

**Scenario**: Andy adds 5 new tools to the catalog overnight. Tomorrow
the agent calls `toolrouter_list_endpoints` and gets back 21 tools where
yesterday there were 16. Three of the new ones overlap with capabilities
the agent already has (e.g., a future `dexscreener.token_lookup` that
overlaps with what `bankr token info` and our Polymarket / Solana DeFi
skills already do).

**Detection latency**:
- Real-time: the agent sees the new tools the moment it calls discovery.
- Cron-detected: a `probe-toolrouter-catalog` cron (mirror of
  `cron/probe-base-skills-registry`) snapshots the catalog hourly and
  diffs against the prior snapshot — alerts on every addition for
  operator review.

**Blast radius**:
- Routing ambiguity: when the user says "look up DEGEN token," the agent
  has 3 options: ToolRouter's new tool ($), Bankr CLI (free, our local),
  Solana DeFi skill (free, our local). The wrong choice burns credit on
  something we get for free.

**Mitigation**:
1. SOUL.md routing rule: "ALWAYS prefer free local tools over paid
   ToolRouter tools when both can answer the same intent."
2. Cost-aware routing (§16) makes this explicit per-tool.
3. The hourly catalog-diff cron lets us pre-emptively update SOUL.md
   routing for new tools that conflict with existing local capability.

### 13.4 Future Base MCP / ToolRouter tool overlap

**Scenario** (extension of 13.3): Andy adds an `aerodrome.swap` endpoint
to ToolRouter that lets the agent swap via Aerodrome through ToolRouter's
x402 path. We already have `~/.openclaw/skills/base-aerodrome/SKILL.md`
that does the same via Bankr's wallet. **Two paths to the same outcome,
different cost models.**

**The right routing priority** (binding for v1 and beyond):

1. **Bankr CLI** (`bankr swap`, `bankr send`) — primary for token
   operations, fastest single-step.
2. **Base skill plugins** (`~/.openclaw/skills/base-*/SKILL.md`) —
   when Bankr doesn't cover the protocol (Morpho deposit, Avantis
   perp, Aerodrome LP). Free, signed by Bankr / Sub Account.
3. **ToolRouter Layer B** — last resort for the same intent. Only
   reach for it when the user explicitly wants the "hosted, verified,
   traced" version (e.g., for compliance / audit-trail purposes) OR
   when Bankr is in an outage.

SOUL.md routing must encode this priority. The agent NEVER reaches for
ToolRouter's onchain tools (if they ship) when Layer A can handle the
same intent.

### 13.5 Tool-result quality variance

**Scenario**: `exa_search` returns 5 results for "latest Edge Esmeralda
news" — 3 of them are 6 months stale, 1 is a press release from Edge's
2025 event, and 1 is genuinely fresh. The agent doesn't know which is
which without reading every result. User experience: a $0.007 search
returned 80% noise.

**Detection latency**:
- Real-time: invisible at the tool layer; only the user (or the agent,
  if it's careful) can judge quality.
- Aggregate: a per-user / per-tool quality dashboard (Phase 3 idea) can
  surface "Exa returns stale results for 'latest X' queries 40% of the
  time" patterns.

**Mitigation**:
1. SOUL.md routing teaches "for time-sensitive queries, prefer
   `manus_research` over `exa_search` because Manus does its own
   recency filtering." (Tradeoff: Manus is ~100x more expensive.)
2. The strategic opportunity §17.2 (Tool Quality Memory via gbrain) is
   the long-term answer — the agent learns which tool produces good
   results for which user / query class, over time.

---

## 14. Security Posture — Platform Key Compromise

### 14.1 The threat model

The platform-scoped `TOOLROUTER_API_KEY` lives in three places per VM:
- Vercel env (single source of truth)
- `~/.openclaw/.env` on every assigned VM (~150 copies on disk)
- `~/.openclaw/openclaw.json` under `mcp.servers.toolrouter.env`
  (Path C only — duplicate copy, same key)

Any of the following compromises ALL THREE in one go:
- A single VM is compromised at the OS level (privesc, supply-chain
  attack on a transitive npm dep, bad sudo rule, kernel exploit).
- Cooper's Vercel session is hijacked (browser session theft,
  device theft).
- An InstaClaw operator's SSH key is leaked.

### 14.2 Blast radius

If the key leaks:
- **Spend**: an attacker can drain the platform credit balance up to the
  prepaid amount. If we keep balance ≤ $200 with auto-top-up disabled,
  the worst case is $200 in unauthorized calls before we notice.
- **Data exfil**: depends on ToolRouter's multi-tenancy model. With ONE
  platform key, all 150 VMs' tool-call trace history is in our single
  ToolRouter account. An attacker with the key could see what every
  InstaClaw user has been doing (queries, search terms, browsed URLs).
  **This is a real concern** — flagged as Q9 below.
- **AgentKit delegation abuse**: if World ID delegation is wired in v1.5
  and the key carries that delegation, the attacker could claim discount
  rates and drain more value per dollar than they'd otherwise get.

### 14.3 Mitigations

**v1 (today):**
1. **Tight credit balance ceiling.** Keep prepaid balance under $200.
   Auto-top-up disabled in v1; manual top-up only.
2. **Per-call spend cap.** ToolRouter's `maxUsd` parameter (mentioned in
   the GitHub repo's `/v1/requests` docs) caps each request's cost.
   Default to a conservative $0.10 per call in v1 unless the request
   explicitly justifies higher (a Manus research call would need ~$5).
3. **Rate limiting at our edge.** Per-VM agent shouldn't make more than
   ~10 ToolRouter calls per minute under any user prompt. Surface via
   monitoring (§17 — the dashboard idea).
4. **Audit log on every call.** Every ToolRouter request gets logged to
   the per-VM session jsonl as a tool-use event. We already have this
   shape; just need to confirm the adapter respects it.

**v1.5 (if Q1 resolves to "per-VM sub-keys"):**
- **Per-VM isolation.** Each VM has its own `tr_...` key with its own
  credit balance. Compromise of one VM affects only that VM's balance,
  not the platform pool.
- **Per-VM rate limit.** Sub-keys can have independent rate limits in
  ToolRouter's billing layer (assumed; flagged in Q1).

### 14.4 SSH-key surface

This is the broader InstaClaw threat-model surface that ToolRouter
inherits, not adds to:
- VM root access via `/tmp/ic_ssh_key` (decoded from
  `SSH_PRIVATE_KEY_B64` in `.env.ssh-key`). Any operator with that key
  can read every VM's `.env`. **TOOLROUTER_API_KEY is incremental, not
  novel.**
- We already have `GBRAIN_ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `BRAVE_API_KEY`, `EDGEOS_BEARER_TOKEN`, the Bankr partner key (when
  it arrives), and the gateway tokens at this same surface.
- Adding `TOOLROUTER_API_KEY` to the list is one more credential on
  the same protected path; not a new attack surface.

The key insight is that **ToolRouter doesn't fundamentally change our
security posture** — it adds another paid credential to a protected env
file. The ONLY new concern is the multi-tenancy data-exfil question
(Q9 below).

### Q9 — Multi-tenancy + data privacy

> If we provision a single platform API key for InstaClaw and run 150
> agents against it, what does ToolRouter's trace storage look like?
>
> **Question**: With a single key, can someone with that key see ALL
> the requests from ALL 150 VMs in our ToolRouter dashboard / trace API?
> If yes, that's a real concern — a compromised platform key would leak
> every user's queries / browsing / search terms.
>
> **Cooper's recommended position**: per-VM sub-keys (Q1) solves this
> automatically. If sub-keys aren't on the roadmap, would you consider
> per-request "X-Subject-Id" tagging so requests are at least sliced by
> end-user in the dashboard? (Similar to OpenAI's `user` field.)

---

## 15. Cost Modeling — Sustainability per Tier (REVISED with verified AgentKit data)

[REVISED 2026-05-27 after source-level verification of every endpoint's
`agentkit_value_type` + per-endpoint x402 pricing. The first draft's cost
estimates were guesses; this section uses real numbers from
`andy-t-wang/toolrouter` source code. Single biggest finding: with
AgentBook registration, our 3 highest-traffic tools (Exa search, Manus
research, Browserbase) become FREE or significantly discounted via
AgentKit. Cost projection changes by ~10x.]

### 15.1 Two scenarios bound the cost range

**Scenario A — Cooper completes AgentBook registration** (Cooper-as-the-
verified-human registers the platform key's underlying Crossmint wallet
on the World Chain AgentBook contract):
- Exa search: free via `path: "agentkit"` (cap is the open question Q3
  below — likely meaningful free volume, possibly unlimited).
- Manus research: **2 free requests/month per agent address** (provider-
  side cap, documented in `agents.md`).
- Browserbase: Premium AgentKit-verified browser pool, x402 still pays
  the base $0.01-0.02/session.
- Everything else (AgentMail, StableTravel, Parallel): straight x402.

**Scenario B — No AgentBook registration** (we ship v1 without Cooper
going through the World App flow):
- Every AgentKit-eligible endpoint falls through to x402 paid.
- Exa search: $0.007 + ToolRouter markup ≈ $0.017/call.
- Manus research: $0.03-$0.10 + markup.
- Browserbase: same x402 base price; non-verified browser pool.
- All other endpoints: same as Scenario A (already x402-only).

Scenario B is roughly 5-10x more expensive at fleet scale. **AgentBook
registration is the single most valuable one-time setup we can do.**

### 15.2 Worked example: a real "deep research" task

**Prompt**: "research the top 10 AI infra startups in NYC, compare
their funding, draft a 500-word brief."

Realistic decomposition (verified pricing from endpoint definitions):

| Step | Tool | x402 price | Scenario A (AgentKit-registered) | Scenario B (not registered) |
|---|---|---|---|---|
| Discovery scan | `manus_research_start` (standard) | $0.05 + markup | **$0** (1 of 2 free/mo) | $0.06 |
| Targeted lookup × 5 | `exa_search` | $0.007 each | **$0** (if free trial covers) | $0.035 |
| Page extraction × 5 | `parallel_extract` | $0.01/URL + $0.01 markup | $0.06 (no AgentKit) | $0.06 |
| Funding data sanity check | `browserbase_session_create` | ~$0.02 | $0.02 (AgentKit gets premium; x402 still pays) | $0.02 |
| Drafting (no tool) | n/a | $0 | $0 | $0 |
| **Total per deep-research task** | | | **$0.08** | **$0.18** |

Sample simpler tasks:
- "What's the latest news about Edge Esmeralda?" → 3 `exa_search` =
  $0 (A) vs $0.05 (B).
- "Open a clean browser session and screenshot a tweet" →
  `browserbase_session_create` ≈ $0.02 either scenario.
- "Send an email to my landlord" → `agentmail.send_message` = $0.02
  either scenario.

### 15.3 Fleet-wide monthly projections

Assumption set (conservative midpoint based on observed agent usage
patterns from CLAUDE.md fleet history):

| Tier | Users | Exa/user/mo | Manus/user/mo | Browserbase/user/mo | AgentMail/user/mo | Parallel/user/mo |
|---|---|---|---|---|---|---|
| Starter ($29) | 120 (80%) | 30 | 0.2 | 0.2 | 0.5 | 0.5 |
| Pro ($99) | 22 (15%) | 200 | 2 | 2 | 5 | 5 |
| Power ($299) | 8 (5%) | 800 | 8 | 10 | 20 | 25 |

**Scenario A monthly fleet cost (AgentBook registered):**
- Exa: ~free (assuming free trial covers high volume — Q3)
- Manus: 8 Power × 6 paid × $0.07 avg = $3.36. Plus 22 Pro × 0 paid (within 2-free cap) + 120 Starter × 0. ≈ **$3.36/mo**
- Browserbase: (120 × 0.2 + 22 × 2 + 8 × 10) × $0.02 = (24 + 44 + 80) × $0.02 = **$2.96/mo**
- AgentMail: (120 × 0.5 + 22 × 5 + 8 × 20) × $0.02 = (60 + 110 + 160) × $0.02 = **$6.60/mo**
- Parallel: (120 × 0.5 + 22 × 5 + 8 × 25) × $0.02 = (60 + 110 + 200) × $0.02 = **$7.40/mo**
- **Total: ~$20/mo across 150 VMs. Per-user: $0.13.** Trivial COGS.

**Scenario B monthly fleet cost (no AgentBook):**
- Exa: (120 × 30 + 22 × 200 + 8 × 800) × $0.017 = (3600 + 4400 + 6400) × $0.017 = **$245/mo**
- Manus: (120 × 0.2 + 22 × 2 + 8 × 8) × $0.07 avg = (24 + 44 + 64) × $0.07 = **$9.24/mo**
- Browserbase: same as A. **$2.96/mo**
- AgentMail: same. **$6.60/mo**
- Parallel: same. **$7.40/mo**
- **Total: ~$271/mo. Per-user: $1.81.** Still <10% of hosting margin.

**Key insight**: even WORST-case Scenario B with 800 Exa searches/mo per
Power user is **~$0.50/user/mo on a $299 plan**. Margin is fine
either way. The AgentBook registration just makes free-money even more
free.

### 15.4 Tier sustainability — verdict

At realistic v1 fleet usage:
- **Scenario A (AgentBook registered)**: ~$0.13/user/mo. Hosting cost
  ($29/user/mo) dwarfs the tool COGS by 200x. Trivially absorbable.
- **Scenario B (no registration)**: ~$1.81/user/mo. Still 16x smaller
  than the hosting cost. Trivially absorbable.

**Worst-plausible scenario**: a Starter user with an agent that calls
Exa search 100x/day (= 3000/mo) AND no AgentBook registration. Their
ToolRouter cost: 3000 × $0.017 = $51/mo. Their plan: $29/mo. Negative
margin. **BUT** this requires a user dramatically out of the modeled
distribution. The defensive mitigation is per-user daily caps (§15.5).

### 15.5 Mandatory v1 defense — per-user daily spend cap

ToolRouter doesn't natively expose per-user attribution under a single
platform key (Q1). We implement caps OURSELVES at the proxy layer.

[VERIFIED 2026-05-27 — `agents.md` line 110: *"Product-level spend caps
are intentionally not active yet. `maxUsd` is optional caller
protection, and `X402_MAX_USD_PER_REQUEST` remains only as an emergency
wallet ceiling."* — so per-user enforcement is on US.]

Implementation:
- Every ToolRouter call goes through a `lib/toolrouter-client.ts` wrapper
  on the InstaClaw VM (not the raw `npx @worldcoin/toolrouter` adapter).
- Wrapper: tracks per-user-daily spend in gbrain (PGLite) OR a small
  Redis-equivalent on each VM. Optimistic counter, persisted.
- Hard caps: $0.50/day Starter, $5/day Pro, $20/day Power. Beyond cap,
  the wrapper returns a synthetic "tool unavailable today" response.
- Agent receives error → SOUL.md teaches it to fall back to local-free
  alternatives + tell the user "I've used today's allocation; want to
  upgrade or try again tomorrow?"

Caps are 5-10x the modeled usage so they don't bind on normal users.
They protect against runaway / abuse.

### 15.6 The Exa free-trial cap — the single critical unknown

**This is the only number that materially shifts the cost model.** From
the source: `exa.search`'s `agentkit_value_type: "free_trial"`, but the
per-agent monthly cap (if any) is NOT in the endpoint definition. For
Manus the cap is documented (2/month/agent); for Exa it's silent.

If Exa free trial is generous (say, unlimited for AgentKit-verified):
Scenario A total = ~$20/mo fleet. AgentBook registration is a no-op-
expensive-but-still-free win.

If Exa free trial is capped at 2/month (matching Manus):
Scenario A reverts toward Scenario B for high-volume users. Still
absorbable but the AgentKit moat is meaningfully smaller.

**Q3 (§6) is elevated to P0 specifically to resolve this.**

### 15.6a Q3 contingency — if Exa free trial is tightly capped

[Added 2026-05-27 PM-6 per Issue 7 of the PRD review. If Andy answers
Q3 with "Exa is also 2/month/agent" (matching Manus), here's what
changes in this PRD vs what stays:]

**What changes**:
- Scenario A fleet cost reverts toward Scenario B for Exa
  specifically (~$245/mo Exa alone at the §15.3 modeled usage).
- The §10.4 moat narrative softens — the headline becomes
  "discounted premium tools" for search, not "free premium tools."
- The M3 (100% reached) Exa loss-frame templates need a slight
  sharpening since the user is actually paying for Exa now, not
  getting it free. Revised Exa loss-frame for the §5.3.3 marker
  block under tight-cap conditions: *"exa's better at finding the
  right thing on the first try; brave will get there but might
  take 2-3 follow-ups from me, and on tight Exa cap conditions a
  premium pack stretches further than the included tier alone."*

**What stays the same**:
- The included allocations (60 / 400 / 1500 per tier) are still
  correct — they're sized at 2x §15.3 modeled median usage, NOT
  at 2x "everything is free." The numbers don't move.
- The upsell fires more often for Exa-heavy users, which is
  actually GOOD for top-up revenue (§15.7's projection +20-40%
  in the tight-cap scenario, since more users will hit allocation
  and a fraction will convert).
- AgentBook registration is STILL worth doing. 2 free Manus +
  2 free Exa + Browserbase-access boost per month per agent is
  still meaningfully more than $0; for our 150-VM fleet that's
  ~$0.10/agent/mo of preserved value, $15/mo fleet-wide. Trivial
  in absolute terms but a real moat-narrative gain.
- The decision tree (§5.3.6), wrapper (§5.3.5), RPC (Task K.3),
  and Stripe SKU (Task K.5) are all unchanged. The Exa cap is a
  COST tuning parameter, not an architectural input.
- The §10.4 competitive-moat claim is dialed back per Issue 8;
  if Q3 is tight, that softening is already in place.

**Bottom line**: if Q3 is tight, the economics still work, the
upsell fires more often (which is fine — that's the point of an
upsell), and the moat is smaller but still real. We ship either
way. No architectural changes. Only allocation tuning + copy
adjustment + admin alert thresholds may want a single-pass
revision once we have 30 days of real data.

### 15.7 With v1 upsell active — fleet revenue/margin projection

[Added 2026-05-27 PM-3 after Option B was locked into v1 per Cooper's
override. The numbers below assume the sponsored-tier framing (§5.3):
allocations are 60/400/1500 premium searches per tier; top-up is 100
searches for $10; the AgentKit-free path doesn't decrement.]

| Metric | Assumption | Math |
|---|---|---|
| Fleet size | 150 VMs (distribution: 120 Starter, 22 Pro, 8 Power) | |
| Median usage / mo / tier | Per §15.3 modeled assumptions | Already absorbed |
| % users exhausting allocation | 12% — Cooper's "feels like power-user feature" target | 18 users |
| Top-up conversion (of exhausting users) | 10-15% (Cooper's "respectful but we have margins" estimate) | 2-3 users |
| Top-up purchases / month | 2-3 | |
| Revenue per top-up | $10 | |
| **Top-up revenue / month** | | **$20-30** |
| Top-up tool COGS | 100 weight × $0.007 ≈ $0.70 platform cost (worst case) | $1.40-2.10 |
| Top-up net margin | | $18-28 (~93% margin) |
| Scenario A baseline COGS | Per §15.3 | ~$20/mo |
| Scenario B baseline COGS | Per §15.3 | ~$271/mo |
| **Net Scenario A**: revenue - COGS | $20-30 - $20 | **~$0 to +$10/mo** |
| **Net Scenario B**: revenue - COGS | $20-30 - $271 | **-$241 to -$251/mo** |

**Key finding**: in Scenario A (Cooper completes AgentBook
registration — §4.8), the upsell makes ToolRouter ROUGHLY revenue-
neutral. In Scenario B (no registration), the upsell helps but
doesn't cover the COGS. **AgentBook registration is now strictly
higher-value than before — it's not just operational tidiness, it's
the difference between revenue-neutral and -$240/mo at v1 scale.**

At 1,000-user scale (post-Edge Esmeralda, hypothetical):
- Top-up revenue: ~$130-200/mo (scales linearly)
- Scenario A COGS: ~$130/mo
- Scenario B COGS: ~$1,800/mo
- Net Scenario A: ~$0-70/mo positive
- Net Scenario B: ~$1,600-1,700/mo negative

This is why AgentBook registration is the #1 priority gate for v1
ship. The two-line addition to onboarding (Cooper signs in →
verifies via World App once) is the single highest-leverage 5
minutes of work in this entire PRD.

### 15.8 Three observability metrics that drive v1.5 allocation tuning

Per §4.9 + §5.3.4 wiring (the `allocation_source` enum on every
call):

1. **% of calls on `sponsored_agentkit`** — World pays. Watching
   this go DOWN means either AgentKit caps are tightening, our
   AgentBook registration lapsed, or Andy added paid-only endpoints.
2. **% of users hitting `blocked`/allocation each month** — target
   10-15%. If <5%: allocations are too generous, we're leaving
   margin on the table. If >25%: allocations are too tight, we're
   creating friction.
3. **Top-up conversion of `blocked` users** — target 8-15%. If
   <5%: the upsell isn't converting; review the §5.3.3 copy. If
   >25%: power users are over-converting; consider lowering top-up
   price OR offering a recurring "premium search subscription."

These three metrics auto-tune the system over 6-12 months. Cooper
reviews monthly; allocations get adjusted via `instaclaw_users
.toolrouter_grant_override` for per-user tuning, or
`TOOLROUTER_TIER_GRANTS` constant change + manifest version bump
for fleet-wide tuning (per Rule 47).

### 15.9 The "agent that pays for itself" frame

Per the Base MCP PRD §10's positioning skeleton:

> "ChatGPT is a cost center. Our agents are profit centers."

For this to hold under ToolRouter usage, the agent's earnings (via
Base MCP v2.5 producer endpoints or ToolRouter v2 producer listings) must
exceed the agent's ToolRouter consumption. The math:
- Agent costs $29-299/mo in InstaClaw hosting + ToolRouter consumption
- Agent earns $X/mo from other agents via x402 / producer surfaces
- Profit center if X > $29-299

**v1 doesn't get us there** (we're pure consumer). **v2 + Base MCP v2.5
do** (producer surface). ToolRouter v1 is the consumer-side scaffolding
that enables the v2 producer story — every paid tool we wire makes the
producer surface more credible (we know what good tool catalogs look
like, we know what x402 payment flows feel like in production).

---

## 16. Agent Decision Surface — Cost-Aware Routing

### 16.1 The gap in the first PRD draft

§4.7's routing table told the agent "prefer local when free; reach for
ToolRouter when the cost is worth the quality uplift." [VERIFIED 2026-05-27
audit] — that's hand-wavy. The agent has no way to know the cost without
explicit hints. The SOUL.md addition needs explicit cost columns.

### 16.2 The improved routing block (REVISED with verified AgentKit value per tool)

```markdown
## Paid SaaS Tools (ToolRouter)

InstaClaw is AgentBook-registered, so three high-traffic tools (Exa,
Manus, Browserbase) come with AgentKit benefits — free or premium-
access — that other platforms' agents don't get. Be liberal with these
when they're the right tool; be conservative with x402-only tools that
charge our credit balance.

| Intent                       | Free local option        | ToolRouter option            | AgentKit value | When paid is worth it |
|------------------------------|--------------------------|------------------------------|----------------|-----------------------|
| Web search (basic)           | `brave-search` (free)    | `exa_search`                 | **Free Trial** | AgentKit verified → **likely free** to platform. Use freely for curated AI-ranked results. |
| Web search (deep, async)     | n/a                      | `manus_research_start`       | **Free Trial (2/mo cap)** | First 2/mo are free per AgentBook agent. Use for genuine multi-hop research; not casual lookups. Always async: `_start` returns task_id, poll `_status`, fetch `_result` in separate turns. |
| Page extract (JS-rendered)   | `curl + jq + python BS4` | `parallel_extract` (~$0.02)  | None (x402-only) | When local curl can't see JS-rendered content. Cost is per-URL, not per-call. |
| Browser session (cloud)      | local `chromium` (free)  | `browserbase_session_create` | **Access** (premium browsers) | When you need a clean, isolated session OR a Verified browser. x402 still pays ~$0.02. |
| Email send                   | `~/scripts/notify_user.sh` (Telegram only) | `agentmail_send_message` (~$0.02) | None | When the user explicitly asks for email delivery. |
| Travel lookups               | n/a                      | `stabletravel_*`             | None | Only when the user wants to book flights/hotels. |

**Routing priority (binding):**
1. Local FREE tool if it can answer the intent.
2. AgentKit-eligible ToolRouter tool (Exa / Manus / Browserbase) when
   quality matters — these are usually FREE for our agents.
3. x402-only ToolRouter tool (Parallel / AgentMail / StableTravel) when
   the user explicitly needs that capability AND it's worth the cost.
4. Always reach for `manus_research_start` (not `exa_search`) when the
   user says "research" / "deep dive" / "comprehensive."
5. Always reach for `exa_search` (not `manus_research`) when the user
   says "quick lookup" / "search" / "find."

**Cost transparency**: every ToolRouter response includes
`path: "agentkit"` (free) or `path: "agentkit_to_x402"` (paid). When
asked "how much did that cost," check the path.

**Quality hints**: gbrain learns over time which tool works best for
this user's queries — refer to MEMORY.md for accumulated taste.
```

Total addition ~700 chars (within the `feedback_skill_size_budget.md`
ceiling). The explicit "AgentKit value" column is what makes the
routing economically correct — the agent now knows Exa is likely free
but Parallel is paid every time, and that signal flows into every
routing decision.

### 16.3 Cost surface for future tools

When Andy adds a new tool to the catalog (the §13.3 scenario), the
hourly diff cron (mentioned earlier) should surface "new tool X, cost
$Y" so we can write a routing-table addition. Without explicit cost +
intent guidance, the agent has to guess — and LLMs are bad at guessing
"when should I spend the user's money."

---

## 17. Strategic Opportunities — Phase 3 (what would surprise Andy)

[Phase 3 finding — these are the "wow Andy" bets, ranked by buildability
and strategic impact.]

### 17.1 The Fleet Canary — what Andy actually needs from us

**The proposal**: InstaClaw's 150-VM fleet is, by a wide margin, the
largest production deployment of any ToolRouter integration. Andy's
internal probe runs 2 paid calls + 1 AgentKit-boost call per hour per
endpoint (`apps/worker` in his repo). That's ~50 probe-calls/hour
covering 16 endpoints. **We could double his data with zero effort.**

**What ships**:
1. A reconciler-side metric collector (lives in `lib/toolrouter-client.ts`
   or sibling). Every ToolRouter call from any VM emits a row to a small
   table `instaclaw_toolrouter_call_log` (vm_id, endpoint_id, latency_ms,
   http_code, error_class, cost_usd, ts).
2. An hourly aggregator that emits to a `/api/public/toolrouter-fleet-health`
   endpoint. Returns:
   ```json
   {
     "fleet_size": 150,
     "calls_24h": 2847,
     "endpoints": [
       { "id": "exa.search", "calls_24h": 1203, "success_rate": 0.998, "p50_latency_ms": 412, "p95_latency_ms": 1834 },
       ...
     ],
     "ts": "2026-05-27T17:30:00Z"
   }
   ```
3. We Telegram Andy the dashboard URL once a week with a "here's what
   your largest canary saw this week" digest.

**Why this matters**:
- Andy's own probes are synthetic. Our fleet's calls are REAL agent
  prompts driving real tool selection. The data quality is incomparable.
- We become the canonical "reference deployment" anyone else who asks
  Andy "should I use ToolRouter at scale?" gets pointed at.
- Andy gets a unique competitive moat for ToolRouter — nobody else has
  this data, including OpenAI's own deployment.
- We get cred + priority on feature requests (Q1 sub-keys, Q2
  streamable-http endpoint, Q4 programmatic top-up).

**What it costs to build**: ~1 week from one engineer once Cooper greenlights.
The reconciler logging is ~30 LOC, the aggregator is ~50 LOC, the dashboard
endpoint is ~80 LOC. Total maybe 200 lines + a tiny migration.

**Why this beats "just send Andy bug reports"**: bug reports are
artisanal and disappear into someone's email. A LIVE public health
dashboard is a permanent integration artifact that compounds — every
month it produces more interesting data than the last.

### 17.2 Tool Quality Memory via gbrain — the persistent-agent moat

**The proposal**: Every InstaClaw agent's persistent PGLite memory
(gbrain at port 3131) gains a `tool_outcomes` table. Every ToolRouter
call logs: tool_id, query_text, returned_results_summary, user_followup
(did the user ask for more? did they reject the result? did they thank
the agent?). Over weeks, the agent BUILDS PERSONAL TASTE about which
tool works best for which kind of query.

**Why this is novel**: No other agent platform has persistent per-user
memory at this granularity. ChatGPT's memory is a 1.5K-char summary
stub. Claude projects are session-bounded. **InstaClaw is the only
platform where an agent can say "I've noticed that for Cooper's research
queries, Manus returns better results than Parallel — so I'm going to
default to Manus for him specifically."**

**What ships**:
1. A new gbrain MCP tool (in our `instaclaw/scripts/gbrain-patches/`)
   that exposes `log_tool_outcome` and `recall_tool_preference`.
2. SOUL.md routing teaches the agent to log every ToolRouter call's
   outcome (success/fail, user satisfaction, follow-up pattern).
3. Before any ambiguous tool routing decision (§16's table), the agent
   queries `recall_tool_preference(query_type)` and incorporates the
   prior outcomes.

**Why this matters**:
- It's the killer demo for the persistent-agent thesis. Cooper sends a
  research query, agent says "I'll use Manus for this — last time I
  used Exa for crypto news, you said the results were stale."
- It compounds. After 3 months the agent has rich tool-preference data
  the user themselves can't recreate.
- It's a structural moat. ChatGPT can ADD memory but can't add
  per-user fleet-of-tool-outcomes-over-time-with-attribution. They'd
  need 200M persistent per-user databases.

**What it costs to build**: ~2 weeks. Depends on a small gbrain
upstream patch (similar to the existing checkpoint patch) OR a
sidecar table we manage outside gbrain. Probably easier to ship as
sidecar first then upstream to Garry later.

**Strategic fit**: this is the canonical answer to "what does persistent
memory + paid tool routing unlock that nothing else has?" The Base MCP
PRD's eight-primitive moat list (§2.2 of the addendum) gets a ninth
entry: agent-grade tool taste.

### 17.3 The World Build demo — three-layer composition in one prompt

**The proposal**: A single Telegram message to an InstaClaw bot that
fires all three layers in sequence, in under 60 seconds, with a single
response. Andy demos this on stage at World Build NYC.

**The prompt** (Cooper picks, this is one candidate):

> "find me the top morpho usdc vault on base right now, lend 25 USDC into
> it via my bankr wallet, then send an email to my accountant
> coopergrantwrenn@gmail.com confirming the deposit"

**The agent flow** (each layer is the canonical primitive Cooper has
been building toward):
1. **Layer B (ToolRouter, paid)**: `exa_search` for "current Morpho
   USDC vault APYs on Base" — costs ~$0.007, returns verified results.
2. **Layer A (Base MCP skill plugin, free)**: reads
   `~/.openclaw/skills/base-morpho/SKILL.md`, calls the Morpho GraphQL
   endpoint, identifies the top-APY vault by current netApy.
3. **Layer A (Bankr CLI, free)**: `bankr send` with USDC approve +
   deposit calldata (per the SKILL.md). Signs and broadcasts. Reports
   tx hash + Basescan link.
4. **Layer B (ToolRouter, paid)**: `toolrouter_send_email` to the
   accountant with the deposit confirmation. Costs ~$0.005.
5. **Layer A (gbrain memory)**: writes the outcome to PGLite so next
   time the user asks about Morpho positions, the agent has personal
   context.

**Total time**: 30-60s wall clock. **Total cost**: ~$0.02 in ToolRouter.

**Why this is the demo**: 
- No other platform can do all five steps in one prompt.
- ChatGPT + Base MCP can do (2) and (3), but each requires an Allow click,
  and ChatGPT can't reach Layer B at all without a Cursor-style plugin
  installed. The email step alone (4) breaks ChatGPT's model — they
  have no email-send capability without ZAPIER.
- Claude Desktop can do (4) via Anthropic's email tool, but can't
  reach (3) (no wallet) or (1) (no paid search).
- **ONLY an InstaClaw agent can chain all five layers.**

**The narrative for the demo**: "this is what 'autonomous AI agent with a
real wallet and real reachable tools' actually means. Brain by
Anthropic. Wallet by Coinbase. Body by InstaClaw. Paid tools by
ToolRouter. Memory by gbrain. Five products, one prompt, one response,
one minute. The agentic economy on stage."

**What it costs**: zero new code if v1 of this PRD ships clean. The
demo IS the integration. Cooper's call whether to record + share.

### 17.4 Why these three, ranked

| Idea | Buildability | Andy-surprise value | Strategic compound |
|---|---|---|---|
| **17.1 Fleet Canary** | High (200 LOC, 1 week) | Very high (he gets data no one else can give him) | Medium (compounds via weekly digests) |
| **17.2 Tool Quality Memory** | Medium (2 weeks, gbrain patch) | High (nobody has this) | Very high (compounds with every session) |
| **17.3 World Build demo** | Trivial if v1 ships clean | Very high (live demo at scale) | Low (one-shot demo, not a system) |

Ship 17.1 alongside v1. 17.2 as v1.5. 17.3 when Cooper picks the moment.

---

## 18. Sources

Primary technical sources for this PRD (verified 2026-05-27):

- [ToolRouter landing page](https://toolrouter.world) — product positioning, catalog enumeration, x402-handled-internally claim
- [ToolRouter dashboard](https://toolrouter.world/dashboard) — gated, login-required
- [ToolRouter setup quickstart](https://toolrouter.world/setup) — CLI integration shape, env var contract
- [ToolRouter docs](https://toolrouter.world/docs) — provider onboarding spec, AgentKit-verified definition
- [`github.com/andy-t-wang/toolrouter`](https://github.com/andy-t-wang/toolrouter) — repo structure, deployment, endpoints catalog
- [`@worldcoin/toolrouter` adapter README](https://github.com/andy-t-wang/toolrouter/blob/main/apps/mcp/README.md) — stdio transport confirmation, MCP tool surface

Internal cross-references:

- [base-mcp-integration PRD](./base-mcp-integration.md) — three-layer thesis, v2.5 producer thesis
- [base-mcp-integration addendum](./base-mcp-integration-addendum.md) — eight architectural primitives, thread 2 vision
- `instaclaw/lib/index-network-client.ts` — partner-MCP wiring reference pattern (streamable-http + Bearer)
- `instaclaw/scripts/install-gbrain.sh` — local HTTP sidecar reference pattern (heavy state)
- `instaclaw/lib/vm-reconcile.ts:stepIndexProvision`, `stepGbrain`, `stepEdgeOSApiKey` — reconciler step reference patterns
- `instaclaw/lib/partner-secrets.ts` — Rule 49 verifier pattern reference
- CLAUDE.md Rules 5, 6, 10, 19, 22-23, 27, 32, 34, 38-39, 47, 49, 56, 58, 60-61, 64, 66-67 (cited in §9)
