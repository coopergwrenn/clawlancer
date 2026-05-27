# Base MCP Integration — Strategic PRD

> **Status**: Draft 1 — decision-locked architecture, phased ship plan.
> **Date**: 2026-05-26 (same-day response to Base MCP launch).
> **Owner**: Cooper. Implementation owners assigned per phase.
> **Audience**: any CC terminal picking this up.

---

## TL;DR

Base launched Base MCP today (2026-05-26). Most platforms will spend weeks
"integrating" it. We don't need to — every InstaClaw agent already has a real
Linux computer, a real wallet (Bankr + CDP), and a real shell. Base MCP's
killer asset isn't the hosted MCP server at `mcp.base.org`; it's the **markdown
skill plugin spec**, which we can compose natively. Combine that with a
**Base Sub Account + Spend Permission per VM** (one-time user grant at signup,
fully autonomous thereafter) and **x402 outbound payments** (we already use
x402 for AgentBook — production primitive), and InstaClaw becomes the only
agent platform where every agent can lend on Morpho, swap on Aerodrome, trade
perps on Avantis, AND earn USDC from other agents, all from a Telegram
message, with no per-transaction OAuth click.

The non-obvious insight: **we don't compete with Base MCP, we leapfrog it by
becoming a producer in the agentic economy while everyone else is still wiring
up the consumer side.**

This PRD ships in five waves:

- **v1 (this week)** — install Base ecosystem skill plugins (Morpho, Aerodrome,
  Moonwell, Uniswap, Avantis, Virtuals) as native InstaClaw skills. Agents
  read them on demand and call documented HTTP GET endpoints; signing uses
  the existing Bankr wallet. Marketing: "every agent now does Base DeFi
  natively, no plugins required."
- **v1.5 (1-2 weeks)** — provision a Base Sub Account with Spend Permission
  per VM at signup. Replaces the receive-only CDP backup wallet with a fully-
  autonomous signing wallet. User grants once via Base Account popup during
  onboarding; agent operates headless thereafter up to the spend limit.
- **v2 (2-3 weeks)** — publish InstaClaw as a public Base MCP skill plugin
  + skills.sh listing. Any agent on Claude / ChatGPT / Cursor can hire an
  InstaClaw agent via Base MCP for a fixed USDC price. "Delegated autonomy
  as a service."
- **v2.5 (3-4 weeks)** — every InstaClaw agent exposes its OWN x402 endpoint
  (via reverse-proxy tunnel). Other agents can hire MY agent for tasks. EARN.md
  becomes the catalog. Real revenue stream for users.
- **v3 (4-6 weeks)** — mint an ERC-8004 identity NFT per InstaClaw agent at
  provisioning. Every x402 transaction emits feedback to the agent's onchain
  reputation. We move from "platform with agents" to "registry of trustless
  agents with verifiable reputation."

---

## 1. The Strategic Moment

### 1.1 What launched today

Base MCP shipped 2026-05-26: an official Coinbase MCP server at
`https://mcp.base.org` that lets AI chat clients (Claude, ChatGPT, Cursor,
Codex, Hermes) make onchain calls on Base via OAuth 2.1 with per-transaction
human approval. Launch partners: Morpho, Moonwell, Bankr, Avantis, Aerodrome,
Virtuals, Uniswap. ([Coinbase Base MCP announcement][a], [The Block][b],
[Coindesk][c], [Fortune][d]).

Two of those launch partners — **Bankr** and **Virtuals** — are companies we
already integrate with deeply. $INSTACLAW is a Virtuals Protocol token on
Base (`0xA9E23871156718C1D55e90dad1c4ea8a33480DFd`). Every InstaClaw VM
gets a Bankr wallet (Rule 66; restored 2026-05-24 alongside CDP backup) and
the bankr skill is installed via `installAgdpSkill`. We're not outsiders to
this ecosystem. We're already inside it.

### 1.2 What launched alongside (the load-bearing primitives)

The bigger story is the **stack underneath Base MCP**, which has matured
quietly over the past six months and is what actually unlocks the agentic
economy:

- **x402** ([Coinbase][e], [GitHub: coinbase/x402][f]): HTTP-native payment
  protocol resurrecting the dormant HTTP 402 status code. Donated to the
  Linux Foundation 2026-04-02; 69K active agents, 165M transactions, $50M
  cumulative volume by late April 2026. Launch members include AWS, Google,
  Microsoft, Visa, Mastercard, Shopify, Cloudflare. **This is the path
  through which agents transact with services and each other without an
  OAuth ceremony.**
- **ERC-8004** ([EIP][g], [explainer][h]): Ethereum trustless-agent identity
  standard. Live on mainnet 2026-01-29. Each agent is an
  ERC-721URIStorage NFT with three onchain registries (identity, feedback,
  validation). **The reputation layer for the agentic economy.**
- **Base Account + Sub Accounts + Spend Permissions** ([Base docs][i]):
  smart wallet primitives that let an autonomous agent hold a siloed wallet
  with user-granted spend limits, no per-tx popup. Sub Accounts live on
  mainnet in Q2 2026. **The autonomous-signing primitive we've been
  missing.**
- **Coinbase Agentic Wallets** ([CDP docs][j]): a suite for AI agents to
  hold/spend/trade/earn stablecoins with policy guardrails. CLI tool `awal`;
  optional MCP server (discover + pay only, no send/trade). Built on the
  same CDP SDK we already wire via `@coinbase/cdp-sdk` for the backup
  wallet (Rule 66).

### 1.3 What InstaClaw already has that competitors don't

Map of the existing primitives, with citations to where they live in the
codebase. **Every one of these has at least a year of production hardening.**

| Capability | Where it lives | Status |
|---|---|---|
| Per-user dedicated Linux VM with real shell, browser, filesystem | `lib/ssh.ts:configureOpenClaw` + Linode infrastructure | Production |
| Primary EVM wallet on Base (Bankr) | `lib/bankr.ts`, `lib/bankr-provision.ts`, `~/.openclaw/.env:BANKR_API_KEY` | Production |
| Backup EVM wallet on Base (Coinbase CDP MPC) | `lib/cdp-wallet.ts`, `~/.openclaw/.env:CDP_WALLET_ADDRESS` | Production (Rule 66, restored 2026-05-24) |
| Static skill installation pattern | `vm-manifest.ts:skillsFromRepo + extraSkillFiles`, `instaclaw/skills/*` | Production (24 skills currently shipped) |
| Git-cloned partner skill installation | `lib/ssh.ts:installAgdpSkill` (`~/dgclaw-skill/`), `installBankrSkill`, `installEdgeSkill` | Production |
| MCP sidecar pattern (HTTP transport at loopback) | `scripts/install-gbrain.sh`, `lib/vm-reconcile.ts:stepGbrain` | Production (~150 VMs running gbrain) |
| Partner-MCP wiring (HTTPS transport) | `lib/index-network-client.ts:buildIndexMcpConfig` | Production (Index Network) |
| x402 payment processing | `app/api/agentbook/register-proof/route.ts`, `node_modules/@x402/core` | Production (AgentBook flow) |
| Virtuals Protocol integration (DegenClaw skill) | `instaclaw/skills/dgclaw/SKILL.md`, `installAgdpSkill` | Production |
| Wallet-routing documentation surface | `lib/ssh.ts:buildWalletMd`, `~/.openclaw/workspace/WALLET.md` | Production |
| Telegram + iMessage agent UX | `lib/ssh.ts:configureOpenClaw` (telegram bot per VM) | Production |

**Nobody else has this stack.** Claude is a chat. ChatGPT is a chat.
Cursor is an IDE plugin. Each can call mcp.base.org during a session, then
forget. **InstaClaw agents persist, hold wallets, run on real machines, and
are reachable 24/7 via the channels users actually use.** Base MCP is built
for a world where the agent is ephemeral and the wallet belongs to the user.
We're built for a world where the agent is persistent and the wallet
belongs to the agent.

[a]: https://www.base.org/agents
[b]: https://www.theblock.co/post/402631/coinbase-base-mcp-gateway-ai-interfaces-claude-chatgpt
[c]: https://www.coindesk.com/tech/2026/05/26/coinbase-s-base-launches-ai-tool-for-chatgpt-to-manage-crypto-wallets-and-defi-apps
[d]: https://fortune.com/2026/05/26/coinbase-pushes-further-into-ai-payments-with-new-mcp-for-base-network/
[e]: https://www.coinbase.com/developer-platform/products/x402
[f]: https://github.com/coinbase/x402
[g]: https://www.datawallet.com/crypto/erc-8004-explained
[h]: https://composable-security.com/blog/erc-8004-a-practical-explainer-for-trustless-agents/
[i]: https://docs.base.org/identity/smart-wallet/guides/sub-accounts/incorporate-spend-permissions
[j]: https://docs.cdp.coinbase.com/agentic-wallet/welcome

---

## 2. Architectural Thesis

### 2.1 The non-obvious insight (read this twice)

**Base MCP itself — the OAuth-gated server at `mcp.base.org` — is the wrong
abstraction for InstaClaw.** Two structural reasons:

1. **OAuth 2.1 requires a human browser to approve the initial connection.**
   InstaClaw agents are headless. They run on Linode boxes, get spoken to via
   Telegram or iMessage, and execute work while the user is asleep. There's no
   browser to receive an OAuth callback from mcp.base.org.

2. **Every write transaction requires a human "Allow" click in the Base
   Account UI** (per Base MCP docs: *"Every write action requires your
   approval in Base Account"*). InstaClaw's UX promise is that the agent does
   the work and reports back. Inserting "now open your phone and confirm
   this swap" breaks the contract for every user not actively watching.

**But the most valuable part of Base MCP isn't the server. It's the markdown
skill plugin spec.** Each launch partner published a `.md` file that teaches
an LLM agent how to:
- Discover state via HTTP GET endpoints
- Build unsigned calldata via "prepare" GET endpoints
- Map the response into `wallet_sendCalls` for signing

Those markdown files **don't require Base MCP to be useful.** They're just
docs. Any agent with a shell, `curl`, `jq`, and a signing wallet can:

1. Read the markdown
2. Call the documented GET endpoints
3. Get back unsigned tx calldata
4. Sign and broadcast via its own wallet infrastructure

**InstaClaw agents have all of those.** We can drop the Morpho, Aerodrome,
Moonwell, Uniswap, Avantis, Virtuals skill plugins into
`~/.openclaw/skills/base-*/SKILL.md` on every VM and the agent immediately
gains access to the entire Base ecosystem **without ever touching
mcp.base.org**. The signing happens via our existing Bankr wallet (or, in
v1.5, the Sub Account).

This is the "of course InstaClaw was first" moment: we don't need Base MCP
because our agents have real computers.

### 2.2 The three-layer thesis

Frame the integration as three independent layers, each with separate
ship cadence and separate marketing story:

```
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 3 — PRODUCER (we earn from Base agents)                   │
│ • InstaClaw as Base MCP skill plugin (v2)                        │
│ • Per-agent x402 endpoints — agents earn USDC (v2.5)            │
│ • ERC-8004 identity + onchain reputation per agent (v3)         │
└─────────────────────────────────────────────────────────────────┘
                              ▲
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 2 — IDENTITY (every agent has autonomous spend authority) │
│ • Base Sub Account per VM (provisioned at signup)               │
│ • Spend Permission grant (one-time browser popup, headless     │
│   thereafter up to user-set limits)                              │
│ • CDP Agentic Wallet (awal CLI) on every VM                     │
│ • Replaces / augments CDP backup wallet (Rule 66 layered)       │
└─────────────────────────────────────────────────────────────────┘
                              ▲
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 1 — CONSUMER (every agent does Base DeFi natively)        │
│ • Morpho, Aerodrome, Moonwell, Uniswap, Avantis, Virtuals       │
│   skill plugins (markdown files, dropped into                    │
│   ~/.openclaw/skills/base-*/SKILL.md)                            │
│ • Agent reads on demand, calls documented GET endpoints,         │
│   signs via existing Bankr wallet                                │
└─────────────────────────────────────────────────────────────────┘
```

Each layer is independently valuable. Layer 1 ships in days and is
marketable today. Layer 2 ships in 1-2 weeks and is the moat. Layer 3 ships
in 2-6 weeks and is the new revenue stream.

### 2.3 What this is NOT

Anti-patterns to avoid on this work:

- **Not "install Base MCP on every VM as an MCP server."** Base MCP is
  hosted, OAuth-gated, and human-in-loop. It doesn't fit a headless multi-
  tenant fleet. We are not the user-of-Base-MCP; we are the platform-Base-
  MCP-runs-alongside.
- **Not "replace Bankr with Base MCP."** Bankr is a launch partner *of*
  Base MCP. Bankr's API and CLI continue to be the simplest path for
  agent-driven token swaps, transfers, and launches. Sub Accounts add a
  parallel signing path; they don't deprecate Bankr.
- **Not "wait for Base MCP to add SDK / headless auth."** We don't need it.
  We have a better path.
- **Not "make our agents `awal` clients only."** `awal` is the CLI for one
  variant of CDP Agentic Wallets and is a useful tactical add — but the
  strategic primitive is the Sub Account + Spend Permission, not the CLI.

---

## 3. Phased Ship Plan

| Phase | Ships when | Owns | Core unlock | Marketing window |
|---|---|---|---|---|
| **v1**   | This week (3-5 days) | Reconciler / manifest terminal | Every agent does Base DeFi natively via composed skill plugins, signed by Bankr | Same-week post: "Of course InstaClaw was first" |
| **v1.5** | 1-2 weeks | Wallet / configure terminal | Every agent has its own Base Sub Account with autonomous spend authority | Quote tweet of v1 launch: "and now they sign autonomously" |
| **v2**   | 2-3 weeks | Public-API terminal | InstaClaw is a public Base MCP skill plugin; other agents can hire ours | Launched alongside skills.sh listing |
| **v2.5** | 3-4 weeks | Public-API terminal | Every agent earns USDC from other agents via x402 | EARN.md UX redesign — "your agent earned $X while you slept" |
| **v3**   | 4-6 weeks (gated on ERC-8004 ecosystem readiness) | Identity terminal | ERC-8004 NFT per agent, onchain reputation accrued from every job | Position InstaClaw as the registry, not just a host |

The waves are **strictly independent**. v1.5 doesn't gate v2. v2 doesn't gate
v3. We could ship v1+v2 without v1.5 if Spend Permission integration hits
unforeseen complexity. We don't ship anything that depends on Base MCP being
up — only on the underlying primitives (skills.sh registry, Base RPC, x402
foundation, ERC-8004 contracts on mainnet).

---

## 4. v1 Spec — Native Base DeFi Skill Plugins

### 4.1 Goal

Every InstaClaw agent (all ~150 healthy + assigned VMs) gains the ability to
interact with the entire Base DeFi ecosystem (Morpho, Aerodrome, Moonwell,
Uniswap, Avantis, Virtuals) via natural language. "Hey, lend my 50 USDC on
the highest-yield Morpho vault" works, the agent reads
`~/.openclaw/skills/base-morpho/SKILL.md`, calls the documented GET endpoint
to discover vaults, calls the prepare endpoint to get unsigned calldata,
signs via Bankr CLI, broadcasts on Base mainnet, replies on Telegram.

### 4.2 Architecture

**Skill plugins live as static markdown files** on each VM under
`~/.openclaw/skills/base-<protocol>/SKILL.md`. They're deployed via the
existing `vm-manifest.ts:skillsFromRepo` + `extraSkillFiles` mechanism (same
path used for the existing 24 skills like `dgclaw`, `consensus-2026`,
`xmtp-agent`).

**Source**: each skill plugin's markdown is published either at
`https://skills.sh/base` or in each partner's own GitHub repo. We vendor a
copy into `instaclaw/skills/base-<protocol>/SKILL.md` at the InstaClaw repo
root, with a header comment recording the upstream source + commit SHA so
we can audit drift later.

**Signing path**: every skill plugin documents how to construct an unsigned
transaction (the "prepare" endpoint). The agent's last step — broadcasting
the signed transaction — uses our existing wallet infrastructure:

- **Bankr CLI** for swaps, transfers, token launches (already wired —
  `BANKR_API_KEY` in `.env`, `bankr` command in PATH per `installAgdpSkill`)
- **Direct cdp-sdk signing** for sends from CDP wallet (when v1.5 ships,
  this gets a Sub Account address too)
- **Raw RPC + ethers / viem CLI** for protocols Bankr doesn't cover —
  Morpho deposit, Aerodrome LP, Moonwell supply, Avantis position open

**Skill routing**: SOUL.md and AGENTS.md get a new section:

```markdown
## Base DeFi Skill Routing

| User intent                                        | Skill / tool                                |
|----------------------------------------------------|---------------------------------------------|
| Lend on Morpho, view vaults, check positions       | `~/.openclaw/skills/base-morpho/SKILL.md`   |
| Supply / borrow on Moonwell                        | `~/.openclaw/skills/base-moonwell/SKILL.md` |
| Swap tokens, LP on Aerodrome                       | `~/.openclaw/skills/base-aerodrome/SKILL.md` |
| Swap on Uniswap, manage Uniswap positions          | `~/.openclaw/skills/base-uniswap/SKILL.md`  |
| Open / manage perps on Avantis                     | `~/.openclaw/skills/base-avantis/SKILL.md`  |
| Discover newest Virtuals agent launches            | `~/.openclaw/skills/base-virtuals/SKILL.md` |
| Token launch, primary swap path                    | `bankr` CLI (existing, fastest)             |
| Token launch via Virtuals competition (DegenClaw)  | `~/dgclaw-skill/scripts/dgclaw.sh`          |
```

This is small (~500-700 chars) and fits the budget per `feedback_skill_size_budget.md`.

### 4.3 What ships

1. **`lib/base-skills-registry.ts`** — the source-mode abstraction (see §4.5
   below). This is the layering primitive that makes everything else
   swappable. Lands first.
2. **One new skill directory per protocol** under `instaclaw/skills/`:
   - `instaclaw/skills/base-morpho/SKILL.md`
   - `instaclaw/skills/base-moonwell/SKILL.md`
   - `instaclaw/skills/base-aerodrome/SKILL.md`
   - `instaclaw/skills/base-uniswap/SKILL.md`
   - `instaclaw/skills/base-avantis/SKILL.md`
   - `instaclaw/skills/base-virtuals/SKILL.md`
3. **Catalog metadata** baked into `BASE_SKILL_CATALOG` in
   `lib/base-skills-registry.ts` (upstream URL + commit SHA + imported-at
   date per entry — audit trail per Rule 24 / Rule 47). Replaces an earlier
   draft that put this in `skills/base-_source.md`; centralizing in the
   registry module is what lets the catalog itself become API-driven later.
4. **`scripts/_fetch-base-skills.ts`** — invokes the registry module in
   `live-fetch` mode against the catalog, computes diff vs vendored copies,
   updates `BASE_SKILL_CATALOG` SHAs. Operator runs on demand; also wired
   as the live-fetch backend that runs from the reconciler when the env
   var flips to `live-fetch`.
5. **`stepBaseSkills` reconciler step** in `lib/vm-reconcile.ts` — calls
   `getBaseSkillCatalog()` + `getBaseSkillContent()` from the registry
   module, SHA-compares against on-disk copy, atomic-writes on drift.
   Mode-agnostic — works the same whether the catalog is hardcoded or
   API-fetched.
6. **SOUL.md / AGENTS.md routing** in `lib/workspace-templates-v2.ts` —
   the routing table above.
7. **VM manifest bump** to deploy the new skills + routing across the
   fleet (per Rule 47 — file-drift cron picks up the new skills in ~5 min
   for caught-up VMs; reconciler picks up cv<new for stale VMs).
8. **`cron/probe-base-skills-registry`** (hourly) — watches for a Base
   registry API and for upstream URL drift. See §4.6.
9. **One coverage script** `scripts/_coverage-base-skills.ts` per Rule 27 —
   samples 5 VMs and confirms all 6 base-* skill dirs exist with non-empty
   SKILL.md (so we catch deploy regressions).

### 4.4 Open question: Bankr-launch-partner overlap

Bankr is BOTH our primary wallet AND a Base MCP skill plugin. When a user
says "swap 50 USDC to ETH", the agent could route through:
(a) Bankr's CLI (existing, ~1 step, single source of failure)
(b) The Base MCP Bankr plugin (documented, but composes through 3-4 GETs)

**Decision**: keep `bankr swap` as the primary path for token operations
Bankr handles natively. Use the Base MCP skill plugins **only for things
Bankr doesn't cover** — Morpho lending, Aerodrome LPing, Avantis perps,
Moonwell supply, Uniswap-specific routing. This avoids regressing a known-
good UX and keeps the Base skill plugins as additive capability.

A future v1.x can A/B the routing if Bankr's API becomes a bottleneck.

### 4.5 Architectural guardrail — source-mode abstraction

> **Added 2026-05-26 at Cooper's direction.** This guardrail is mandatory for v1.

Vendoring markdown into `instaclaw/skills/base-*/SKILL.md` is the right v1
shipping mode — zero external dependencies, manual control over what lands
on every VM, easy rollback. But we MUST design the deployment so flipping
to "live fetch from upstream" or an eventual "registry API" mode is a
**one-line env-var change, not a rewrite**.

Without this guardrail, we end up writing bespoke fetch / parse / deploy
plumbing for Morpho, Aerodrome, Moonwell, etc., and we have to redo it six
more times as Base adds new launch partners — then redo it again when Base
ships a proper registry API. With this guardrail, switching modes is a
single Vercel env-var change; the on-VM agent runtime is untouched; new
Base partners light up automatically once we're on registry-api mode.

**Goal**: zero ongoing maintenance for keeping skill plugins current, even
as Base evolves its plugin distribution mechanism.

**The abstraction**: a single module
`instaclaw/lib/base-skills-registry.ts` exporting:

```typescript
export type BaseSkillSourceMode = "vendored" | "live-fetch" | "registry-api";

export interface BaseSkillEntry {
  name: string;                  // "morpho", "aerodrome", "moonwell", ...
  vendoredPath: string;          // directory under instaclaw/skills/
  upstreamUrl: string;           // canonical markdown URL (today: github raw)
  upstreamCommitSha?: string;    // pinned for vendored mode (audit trail)
  importedAt?: string;           // ISO date of last vendoring
  references?: Array<{ remotePath: string; upstreamUrl: string }>;
}

// Source of truth for vendored + live-fetch modes. In registry-api mode
// this becomes a fallback used when the API is unreachable.
export const BASE_SKILL_CATALOG: BaseSkillEntry[] = [ /* 6 entries */ ];

export async function getBaseSkillCatalog(
  mode: BaseSkillSourceMode = currentSourceMode(),
): Promise<BaseSkillEntry[]>;

export async function getBaseSkillContent(
  entry: BaseSkillEntry,
  mode: BaseSkillSourceMode = currentSourceMode(),
): Promise<{ content: string; sourceMode: BaseSkillSourceMode; fetchedAt: Date }>;

function currentSourceMode(): BaseSkillSourceMode {
  const raw = process.env.BASE_SKILLS_SOURCE_MODE;
  return raw === "live-fetch" || raw === "registry-api" ? raw : "vendored";
}
```

**Three modes, swappable via the single env var `BASE_SKILLS_SOURCE_MODE`**:

| Mode | Content source | Catalog source | When to use |
|---|---|---|---|
| `vendored` (default) | `instaclaw/skills/base-*/SKILL.md` in repo, deployed via `skillsFromRepo` | Hardcoded `BASE_SKILL_CATALOG` | v1 shipping mode. Zero external dependency. Full audit trail per commit. |
| `live-fetch` | HTTP GET to each entry's `upstreamUrl`, cached per reconcile cycle | Same hardcoded `BASE_SKILL_CATALOG` | When we trust upstream stability and want partner-shipped updates without a PR. Falls back to vendored copy on fetch failure. |
| `registry-api` | Query Base's registry API endpoint (TBD when shipped) | API-returned (auto-discovers new partners) | When Base ships a proper API. New partners light up automatically. |

**Critical layering invariant**: the agent runtime NEVER changes. It always
reads from `~/.openclaw/skills/base-*/SKILL.md` on disk. What changes per
mode is **how that file gets there** — the new `stepBaseSkills` reconciler
step resolves content via `getBaseSkillContent()` and writes to disk
atomically. Switching modes is a single Vercel env-var change followed by
the next reconcile cycle (~3-5 min for the fleet); the on-VM agent never
needs to know.

**Idempotency**: `stepBaseSkills` SHA-compares the resolved content
against the on-disk file (mirroring `stepDeployEdgeOverlay` in
`lib/vm-reconcile.ts`). Writes only on drift. Atomic write + verify-after-
write per Rule 10 / Rule 38. Sentinel grep per Rule 23 against
`BASE_SKILL_*_V1` markers in each upstream SKILL.md (added by the registry
module's import path so we detect upstream content that's been hollowed
out).

**Failure tolerance**: in `live-fetch` and `registry-api` modes, upstream
fetch failures NEVER brick the fleet. The step falls through to the
vendored copy (still present in the repo / VM image) and pushes
`result.warnings` per Rule 39. A broken Base API cannot take agents
offline; worst case, the fleet runs on the most-recent vendored snapshot.

**Mode-flip operational flow** (when we want to swap modes):

1. Test the new mode locally against vm-1019: `BASE_SKILLS_SOURCE_MODE=live-fetch
   npx tsx scripts/_canary-base-skills-mode.ts vm-1019`
2. Confirm content matches expectations + Cooper approves per Rule 64.
3. `printf 'live-fetch' | npx vercel env add BASE_SKILLS_SOURCE_MODE production`
   (per Rule 6 + Rule 61 — `printf` not `echo`, validated value).
4. Vercel redeploys; next reconcile cycle picks up the new mode; full
   fleet at new mode within ~3-5 min (per Rule 47 — continuous
   reconciliation, no version-gate needed).
5. No on-VM change. No agent restart. No customer-visible event.

### 4.6 Monitoring for the registry-api endpoint

We don't know WHEN Base will ship a proper registry API for skill plugins.
To get notified the moment they do — and to detect upstream URL drift in
the meantime — add an hourly cron at
`app/api/cron/probe-base-skills-registry/route.ts`:

```typescript
// Hourly probe (HEAD + GET) against a list of guessed registry endpoints:
//   - https://skills.sh/api/v1/skills?source=base
//   - https://skills.sh/api/skills?registry=base
//   - https://docs.base.org/ai-agents/api/skills
//   - https://mcp.base.org/api/skills
//   - (Extend as Base publishes hints in docs / blog / changelogs.)
//
// For each:
//   - HTTP GET with 5s timeout
//   - Pass criteria: 200 + application/json content-type + body parses as
//     { skills: [...] } or { plugins: [...] } or similar registry shape
//   - On hit: 24h-deduped admin alert via instaclaw_admin_alert_log
//     (subject "[P1] Base skills registry API detected at <url> — review
//     for BASE_SKILLS_SOURCE_MODE flip", body includes the parsed sample
//     payload)
//
// Also: for every entry in BASE_SKILL_CATALOG, HEAD-probe upstreamUrl.
//   - On 404 / 403 / redirect-to-different-host / content-type drift:
//     24h-deduped admin alert "[P2] Base skill upstream changed for
//     <name> at <url> — re-vendor via _fetch-base-skills.ts or
//     investigate"
//
// Idempotent. Read-only. Never mutates fleet state. Never auto-flips the
// mode. The cron buys zero discovery latency — Cooper or an operator
// approves the mode change manually after testing on vm-1019 (Rule 64).
```

Dedup uses `instaclaw_admin_alert_log` with key shapes
`base_skills_registry_api:<url-hash>` (24h) and
`base_skills_upstream_drift:<entry-name>` (24h), mirroring Rule 49 / Rule
67 alert patterns.

The same cron also covers the live-fetch failure mode: broken canonical
sources surface as alerts within an hour rather than degrading fleet
behavior silently. In live-fetch mode the reconciler falls back to the
vendored copy on per-request fetch failure, but the cron tells us we have
a structural problem to fix — not just transient HTTP noise.

### 4.7 v1 done-when

- `lib/base-skills-registry.ts` exists, exports the three modes + catalog
- 6 new `instaclaw/skills/base-*/SKILL.md` files exist on disk, referenced
  by `BASE_SKILL_CATALOG` entries with pinned upstream SHAs
- `scripts/_fetch-base-skills.ts` exists, runs clean against the catalog
- `stepBaseSkills` reconciler step lands, idempotent, SHA-gated
- `cron/probe-base-skills-registry` exists and is wired in `vercel.json`
- SOUL.md / AGENTS.md routing block updated in `workspace-templates-v2.ts`
- VM manifest bumped + deployed (per Rule 64 — vm-1019 canary first,
  Cooper approval before fleet push)
- 5/5 sampled VMs have all 6 base-* skill dirs (coverage script returns 0)
- Local switch-mode rehearsal: temporarily `export
  BASE_SKILLS_SOURCE_MODE=live-fetch` on the canary script against
  vm-1019, confirm `stepBaseSkills` resolves content via HTTP fetch and
  the same SKILL.md content lands on disk (proves the abstraction works
  end-to-end before we need it in anger)
- Cooper sends one of: "lend my 25 USDC on the top Morpho vault" to
  vm-1019 via Telegram, agent reads the skill, executes via Bankr or
  direct RPC, reports back with a tx hash and a Basescan link, all in
  under 2 minutes.

---

## 5. v1.5 Spec — Base Sub Account + Spend Permission per VM

### 5.1 Goal

Every InstaClaw agent has a **Base Sub Account** that it controls
autonomously via a key the agent holds on-VM (managed via CDP), with a
**Spend Permission** granted by the user's parent Base Account that lets
the agent pull funds up to a configurable limit per period.

User UX: at signup, after they connect their Base Account, ONE popup says
"Authorize your InstaClaw agent to spend up to [X] USDC per week for
[Y] days." User clicks Allow once. Agent operates headless thereafter, up
to the limit, with the user able to monitor / revoke at
`account.base.app` at any time.

### 5.2 Why this is the moat

ChatGPT users will install Base MCP, get prompted to Allow each individual
transaction, click each one. That's friction designed-in. **InstaClaw users
do this dance ONCE at signup, then their agent operates autonomously
forever (or until the period limit is hit / they revoke).** Same user-
controls-funds guarantee, dramatically better UX.

This is the architectural counter to "but ChatGPT can do swaps now too" —
yes, but each swap requires the user to be holding their phone. InstaClaw
agents swap while you sleep.

### 5.3 Architecture

```
┌──────────────────────────────────┐
│  User's Base Account (parent)    │
│  Controlled by user wallet       │
│  Holds: USDC, ETH, etc.          │
└──────────────────────────────────┘
              │
              │ Spend Permission grant
              │ (one-time, browser-confirmed)
              │ "Sub Account 0xABC can spend
              │  up to 100 USDC / week
              │  for 90 days"
              ▼
┌──────────────────────────────────┐
│  Agent Sub Account (per VM)      │
│  Owner: agent's CDP key          │
│  Signs via CDP SDK on-VM         │
│  Address persistent across VM    │
│  lifecycle (freeze/thaw)         │
└──────────────────────────────────┘
              │
              │ Direct signing
              │ (no per-tx popup)
              ▼
       Morpho deposit, Aerodrome swap,
       Avantis perp, etc. —
       composed via v1 skill plugins
```

**Key generation**: at VM signup, our backend calls CDP SDK to mint a new
agent key (this replaces the current `provisionCdpWallet` call from Rule
66). The CDP key is the Sub Account's signer.

**Sub Account creation**: backend constructs a `wallet_addSubAccount` RPC
call with `account.type = "deployed"` and the agent's CDP-managed public
key. Returned Sub Account address gets persisted to
`instaclaw_vms.base_sub_account_address` (new column, additive — see
section 5.6).

**Spend Permission grant**: at the moment user connects their Base
Account during signup, we trigger a `requestSpendPermission` flow via
the Base Account SDK. Default policy: 100 USDC per week, 90-day expiry.
User-overridable in onboarding settings. Permission is recorded onchain.

**On-VM signing**: agent's bash environment gets a new env var
`BASE_SUB_ACCOUNT_ADDRESS` and a script `~/.openclaw/scripts/sub-account-send.sh`
that wraps CDP SDK calls to sign + broadcast on the agent's behalf.
SOUL.md routing tells the agent: "for any onchain action, prefer the Sub
Account path; it has user-granted spend authority."

### 5.4 Relationship to Bankr (no deprecation)

This is **additive to Bankr, not a replacement**. Three wallets, three
distinct roles:

| Wallet | Role | Signing path | When used |
|---|---|---|---|
| **Bankr** | Token operations (swap, transfer, launch) | Bankr API + bankr CLI | "Swap 50 USDC to ETH"; "Launch a token called RFT5" |
| **Sub Account** | Generic Base DeFi (Morpho, Aerodrome, Moonwell, Avantis, Uniswap LP, arbitrary contracts) | CDP SDK + sub-account-send.sh | "Deposit my USDC into the top Morpho vault"; "Open a 2x long on ETH-PERP" |
| **CDP MPC backup** | Receive-only fallback (Rule 66) | Server-managed, address-only on VM | Bankr outage → user sends to CDP backup address |

WALLET.md (`lib/ssh.ts:buildWalletMd`) gets a 4th section documenting the
Sub Account, with explicit routing for the agent on which wallet to use
for which intent.

### 5.5 What ships

1. **One new DB column** on `instaclaw_vms`: `base_sub_account_address TEXT`
   (additive; existing rows NULL; populated forward and via backfill).
2. **One new helper** `lib/base-sub-account.ts` exporting
   `provisionBaseSubAccount({ vmId, userId, parentAccountAddress })`:
   - Mints CDP-managed signer key (reusing `lib/cdp-wallet.ts` patterns)
   - Calls `wallet_addSubAccount` via Base Account SDK
   - Persists address to `instaclaw_vms`
   - Same DB-first idempotency guard as `provisionCdpWallet` (CDP has no
     idempotency key — Rule 66 lesson)
3. **One new onboarding step** in the signup flow (likely
   `app/api/onboarding/*` or `app/(onboarding)/*`): trigger Spend
   Permission grant immediately after Base Account connect. Default policy
   100 USDC/week, 90-day expiry, user-adjustable.
4. **One new env var** + **on-VM script** deployed via `configureOpenClaw`
   + reconciler `stepFiles`:
   - `BASE_SUB_ACCOUNT_ADDRESS` in `~/.openclaw/.env`
   - `~/.openclaw/scripts/sub-account-send.sh` (CDP-SDK signing wrapper)
5. **WALLET.md update** in `lib/ssh.ts:buildWalletMd` — new "## Agent Sub
   Account (Autonomous Spend)" section.
6. **SOUL.md / AGENTS.md routing** — teach the agent when to use
   Sub Account vs Bankr.
7. **Backfill cron** at `/api/cron/provision-missing-sub-accounts` per
   Rule 66 pattern (every 30 min, concurrency 3, PER_RUN_LIMIT 50).
8. **Coverage script** `scripts/_coverage-base-sub-account.ts`.
9. **Migration** `instaclaw/supabase/pending_migrations/<ts>_vm_base_sub_account.sql`
   — applied via Studio per Rule 56 BEFORE moving to `migrations/`.

### 5.6 Open questions / risks

- **Q1**: Does the CDP SDK expose a clean path to mint a signer key that
  can own a Base Sub Account, or do we need to roll our own ECDSA key
  management on-VM? **Investigation owed** before phase kickoff.
- **Q2**: What's the UX for users who connect with an EOA (MetaMask /
  hardware wallet) rather than a Base Account smart wallet? Sub Accounts
  + Spend Permissions are smart-wallet primitives. Likely answer: prompt
  them to upgrade to a Base Account or fall back to Bankr-only mode.
- **Q3**: Spend Permission revocation — how do we monitor revocations and
  reflect them in the agent's behavior? Likely: every Sub Account action
  catches a revert-on-spend-exceeded, marks the permission as expired in
  DB, prompts the user to re-grant.
- **R1**: If the CDP key is compromised (VM disk image leaked, supply-
  chain attack on cdp-sdk), the attacker can drain up to the user's
  remaining spend allowance for the current period. **Mitigation**: keep
  defaults conservative (100 USDC/week, 90-day expiry), surface clear
  revocation UX, log all Sub Account activity to an admin dashboard.
- **R2**: Cooper has chargeback / dispute exposure on Spend Permission
  grants if user later disputes ("my agent went rogue"). **Mitigation**:
  every Sub Account txn must be (a) attributable to a user prompt,
  (b) logged in the user's session jsonl, (c) recoverable via the per-VM
  freeze backups (Rule 53).

### 5.7 v1.5 done-when

- Migration applied to prod, column populated for ≥1 test user
- vm-1019 has a working Sub Account address, signs and broadcasts via
  Cooper's prompt: "deposit 5 USDC into Morpho's USDC vault" → tx lands
  on Base mainnet, no popup
- Backfill cron green for 24 hours, ≥95% coverage
- WALLET.md routing surfaces the Sub Account in clean form
- Cooper signs off per Rule 64

---

## 6. v2 Spec — InstaClaw as Base MCP Skill Plugin

### 6.1 Goal

Anyone using Base MCP — on Claude, ChatGPT, Cursor, Codex, Hermes — can
say "hire an InstaClaw agent to monitor this contract and DM me when it
changes" and a markdown skill plugin teaches their assistant how to:
1. Quote the price (instaclaw API)
2. Take payment (x402 PAYMENT-REQUIRED)
3. Spawn a fresh InstaClaw VM and task it
4. Stream status / final result back

This makes InstaClaw a **first-class citizen of the Base agentic economy**.
We're not asking other agents to install our SDK; we're publishing a
markdown spec they can already consume.

### 6.2 Architecture

Three new public endpoints under `app/api/v1/x402/`:

```
GET  /v1/x402/agent-types         → [ { type: "monitor", price_usdc: "0.10", desc: "..." }, ... ]
GET  /v1/x402/quote               → { task_spec_hash, price_usdc, x402_endpoint, expires_at }
                                    (caller submits task spec in query / body)
POST /v1/x402/hire                → on payment-required: 402 + PaymentRequired header
                                    on payment: 200 + { instaclaw_task_id, status_url, result_url }
GET  /v1/x402/task/:id/status     → { state, progress, last_message, eta_sec }
GET  /v1/x402/task/:id/result     → final result blob (URI to gist, screenshot URL, etc.)
```

(Note: per the Base MCP plugin spec, **POST is not usable in consumer
Claude/ChatGPT surfaces**. The `/hire` endpoint should also be reachable
via a `GET /v1/x402/hire?spec=<base64>&nonce=<n>` form so the skill
plugin works in chat-only environments.)

**Skill plugin file**: a public markdown at
`github.com/coopergwrenn/instaclaw/blob/main/docs/base-skill-plugin/SKILL.md`
that documents the four endpoints per the Base MCP custom plugin spec.

**Listing**: submit to `skills.sh/base` (the public registry). One-line
addition; uses GitHub as source of truth.

**Backend wiring**: re-uses `lib/vm-lifecycle` provisioning logic
already in production. Per-task VM either (a) provisions a fresh dedicated
Linode (slow, ~3-5min wall) or (b) pulls a pre-warm pool VM (fast,
~5-15s wall). v2 starts with option (b) — reserve a pre-warm pool of
~5-10 VMs specifically for x402 short-lived jobs. v2.x can add (a) for
long-running tasks.

**Result delivery**: short-form results return inline. Long-form results
(screenshots, web pages, file outputs) get uploaded to existing CDN or
returned as gist URLs. Per-job VMs get destroyed (or returned to pool)
on task completion.

### 6.3 What ships

1. **Three new public routes** under `app/api/v1/x402/`.
2. **One new `lib/x402-server.ts`** wrapping x402 facilitator integration
   (we already use `@x402/core` for the AgentBook flow — same SDK).
3. **One new pre-warm pool** sized for x402 jobs (~5-10 VMs), separate
   from the main signup pool, with shorter idle-timeout (~60 min instead
   of 24h) for cost control.
4. **One new task lifecycle table** `instaclaw_x402_tasks`
   (`id, task_spec, payer_address, vm_id, status, result_uri, paid_amount,
   created_at, completed_at`). Migration per Rule 56.
5. **One public skill plugin markdown** at
   `instaclaw/docs/base-skill-plugin/SKILL.md` (vendored in our own repo)
   + cross-published at the canonical Base MCP plugin path
   (`github.com/coopergwrenn/instaclaw-base-mcp-skill`).
6. **One listing PR** to `skills.sh/base` GitHub.
7. **Dashboard widget** at `instaclaw.io/earn` showing recent x402 task
   completions (gross-revenue counter for the InstaClaw operator —
   Cooper).

### 6.4 v2 done-when

- A user on Claude with Base MCP installed can prompt:
  "hire an InstaClaw agent to summarize the latest @ethereum tweets"
  → skill plugin fires, x402 quote returned, user clicks Allow once for
  payment, fresh VM provisioned, task runs, result delivered in <60s
- Listed on skills.sh
- One paying x402 task per day for 7 days straight (proof of pipeline)

---

## 7. v2.5 Spec — Every InstaClaw Agent Earns USDC via x402

### 7.1 Goal

Each InstaClaw VM exposes its own x402 endpoint over a reverse-proxy
tunnel (Cloudflare Tunnels, or our own ingress at
`agent-<id>.agents.instaclaw.io`). Other agents — instaclaw agents or
external — can pay USDC to hire MY agent for tasks.

**Marketing**: "your agent earned $X while you slept" — a number on the
dashboard that grows.

### 7.2 Architecture

- **Per-VM ingress**: subdomain routing
  (`agent-<vm-id>.agents.instaclaw.io`) terminates at our load balancer
  and proxies to a small HTTP server on the VM (port 18790, loopback-
  bound, exposed via SSH reverse tunnel or Cloudflare Tunnel agent).
- **Per-VM x402 server**: a new systemd --user sidecar
  `instaclaw-x402.service` running a tiny Node/Bun HTTP server that
  exposes:
  - `GET /skills` — agent's published capability menu (sourced from EARN.md)
  - `GET /quote?skill=<name>&payload=<base64>` — x402 quote
  - `GET /execute?token=<paid-token>` — runs the skill, returns result
- **EARN.md becomes the catalog**: agent (and/or user via dashboard)
  declares which capabilities are exposed to the public x402 endpoint
  and at what price. Defaults: nothing exposed; user must opt in.
- **Funds flow**: USDC payments land in the agent's Sub Account
  (the v1.5 wallet). Auto-rewarded; user can withdraw to their Base
  Account at any time.
- **Spam protection**: x402 itself is the spam tax — every request
  costs USDC. Plus rate-limiting at the ingress.

### 7.3 What ships

1. **Per-VM x402 sidecar** — new file
   `instaclaw/scripts/install-instaclaw-x402.sh` mirroring
   `install-gbrain.sh` pattern: bash installer, systemd --user unit,
   loopback HTTP, bearer auth.
2. **Reverse-proxy ingress** — Cloudflare Tunnel daemon installed on
   each VM (well-trodden production pattern, low maintenance).
3. **EARN.md template update** in `lib/ssh.ts:buildEarnMd` — adds an
   "x402 service catalog" section the user fills out.
4. **Dashboard at `instaclaw.io/dashboard/earn`** showing per-VM earnings
   over time, recent x402 hires, withdrawal button.
5. **New DB columns**: `instaclaw_vms.x402_enabled BOOLEAN`,
   `x402_total_earned_usdc NUMERIC`, `x402_endpoint_url TEXT`.
6. **One-page UX in onboarding** — "do you want your agent to earn from
   other agents while you sleep?" toggle, defaults off, can enable later.

### 7.4 v2.5 done-when

- vm-1019 exposes its x402 endpoint publicly, returns a quote for "fetch
  a tweet by URL" at 0.01 USDC, accepts a real payment, executes
- Cooper publishes EARN.md catalog with 3 published skills
- One paid execution per day for 7 days
- Dashboard counter increments and is auditable

---

## 8. v3 Spec — ERC-8004 Identity per Agent

### 8.1 Goal

Every InstaClaw agent gets an **ERC-8004 identity NFT** at provisioning.
Every x402 transaction emits feedback to the agent's onchain feedback
registry, so the agent's reputation accrues onchain and can be queried by
any other ERC-8004-aware agent.

**Strategic positioning**: InstaClaw becomes a **registry of trustless
agents**, not just a hosting platform. The pitch shifts from "buy an
agent from us" to "find the right agent — and ours have the longest
reputation tails."

### 8.2 Architecture

- **Mint at provisioning**: `configureOpenClaw` calls into a new
  `lib/erc8004.ts` to mint an ERC-721URIStorage NFT on the ERC-8004
  registry contract on Base mainnet. The token URI points to a public
  profile at `instaclaw.io/agents/<vm-id>` (capabilities, recent jobs,
  reputation score).
- **Feedback emission**: when an x402 task completes, the buyer's agent
  can rate the seller's agent. The seller's reputation accrues in the
  ERC-8004 feedback registry.
- **Validation registry**: optional — InstaClaw itself can act as a
  validator and emit attestations (e.g., "this agent is hosted on a
  dedicated VM with a real wallet — verified by InstaClaw").

### 8.3 What ships

1. **One new helper** `lib/erc8004.ts` for minting / reading from the
   three ERC-8004 registries on Base.
2. **One new DB column** `instaclaw_vms.erc8004_agent_id BIGINT`
   (additive).
3. **One new public page** at `app/agents/[vmId]/page.tsx` rendering
   the agent's onchain profile.
4. **One x402-post-completion hook** writing feedback to the registry.

### 8.4 v3 done-when

- Every newly-provisioned VM has a populated `erc8004_agent_id`
- Public profile page renders for any agent
- Feedback writes succeed for at least 10 x402 transactions
- An external ERC-8004 client (e.g., a competing agent platform) can
  query and verify our agents' reputation

### 8.5 Risk

ERC-8004 is YOUNG (mainnet 2026-01-29). Tooling, indexers, and adoption
are all in flux. v3 is **explicitly gated on ecosystem maturity**. If by
the time v2.5 ships there are still no other agents writing to the
ERC-8004 registries, v3 becomes "ship our writer-side, surface the data
on our own profiles, wait for the ecosystem to catch up."

---

## 9. Interaction with Existing Bankr Integration

Bankr is BOTH a launch partner of Base MCP AND our existing primary
wallet provider. This section makes the relationship explicit.

### 9.1 Wallet stack post-v1.5

| Wallet | Role | Source-of-truth | Funded by |
|---|---|---|---|
| **Bankr** | Token swaps, transfers, token launches via Bankr API | `lib/bankr-provision.ts` | User direct deposit or platform onboarding credits |
| **Base Sub Account** (v1.5) | Generic Base DeFi: Morpho, Aerodrome, Moonwell, Avantis, arbitrary contract calls | `lib/base-sub-account.ts` (new) | User's parent Base Account via Spend Permission (auto-pulled on-demand) |
| **CDP MPC backup** (Rule 66) | Receive-only EVM address; fallback when Bankr is down | `lib/cdp-wallet.ts` | User can manually send funds here |
| **Bankr-issued agent token** (DegenClaw / Virtuals path) | Tokenized agent reputation; trades on Virtuals | `instaclaw/skills/dgclaw/` | Auto-minted via Virtuals process |

All four addresses are surfaced in WALLET.md with explicit routing for
the agent. The agent picks the right wallet for the right intent.

### 9.2 Bankr API outages (production lesson)

We've had Bankr API 500s in production (memory notes "currently blocked
on Bankr API 500s"). Post-v1.5, the failure mode degrades gracefully:

- Bankr down → token swaps fall back to Aerodrome via the v1 skill
  plugin, signed by the Sub Account
- CDP MPC backup still receives funds independently
- DegenClaw / Virtuals path is independent of Bankr API

### 9.3 Bankr as Base MCP launch partner (mutual)

Igor (Bankr team) may want to know that we're shipping deeper Base MCP
integration. Useful to coordinate:
- Cross-marketing on launch day
- Confirm that Bankr's own Base MCP skill plugin is the canonical version
  we vendor (not a fork)

Coordination task: send Cooper a draft DM to Igor on v1 ship day.

---

## 10. Marketing Narrative

### 10.1 Counter-positioning (the architectural truth)

Most agent platforms will spend May-July 2026 wiring up Base MCP — adding
the OAuth connector, building the chat UX, dealing with the per-tx popup
flow. They'll have done a lot of work to make their agents Base-aware
*during a chat session*.

InstaClaw doesn't need any of that, because:
- Our agents already run on real computers
- Our agents already have wallets (Bankr now, Sub Accounts soon)
- Our agents can compose Base MCP's skill plugin markdown natively
- Our agents are reachable 24/7 via Telegram and iMessage

When ChatGPT users want to swap on Aerodrome, they need to be holding
their phone. When InstaClaw users want to swap on Aerodrome, they go to
sleep and wake up to a "done — tx hash" message.

### 10.2 Voice rules

Per Rule 55 (and `feedback_viral_hook_counter_positioning.md`): bold
claims in line 1, weapons-check every line, no banned phrases. Voice:
Cooper's. Identity-strip test: if you remove `@coopwrenn` /
`instaclaw.io` and the post still reads as plausibly about any AI agent
product, it's wrong.

**This PRD does NOT generate the final posts.** Per Rule 64 and Rule 55,
hooks get generated when Cooper triggers `/viral` / `/launch` / `/post`.
What this section provides is the **positioning skeleton** for those
sessions.

### 10.3 Positioning skeleton (for the future /launch session)

Three angles to triangulate the hook from:

**Angle 1 — Counter-positioning by negation**

> Most agent platforms have to add Base MCP. We added the Base economy.
>
> Every InstaClaw agent now does Morpho, Aerodrome, Moonwell, Uniswap,
> Avantis natively. No plugins. No OAuth. No "Allow" buttons. It just
> works, because every agent has a real computer and a real wallet.

**Angle 2 — The structural unlock**

> Base MCP requires you to click "Allow" for every transaction your
> agent makes.
>
> InstaClaw users click "Allow" once at signup. Then their agent
> spends, swaps, lends, and earns while they sleep — up to their
> chosen weekly limit, fully revocable at account.base.app.
>
> Most platforms can't ship this. They don't have agents with real
> wallets.

**Angle 3 — The double role (consumer + producer)**

> Today every Claude / ChatGPT / Cursor user can call onchain apps via
> Base MCP.
>
> Today every InstaClaw agent can use Base MCP's apps natively AND earn
> USDC by selling its own services to other agents via x402.
>
> Most agents will buy from the agentic economy. Ours sell into it too.

**Receipts the hook can cite**:
- $INSTACLAW token on Base via Virtuals: `0xA9E23871156718C1D55e90dad1c4ea8a33480DFd`
- DegenClaw skill / Virtuals partnership
- Existing Bankr integration (launch partner)
- Existing x402 production usage (AgentBook flow)
- ~150 healthy production VMs each with real shell, wallet, browser

### 10.4 Coordination

Coordination opportunities at launch:
- **Base / @basedotorg**: pre-announce 24h ahead, request retweet
- **Bankr / Igor**: cross-marketing as fellow launch partner
- **Virtuals / @virtuals_io**: mention $INSTACLAW token + DegenClaw
- **CDP / @coinbasedev**: cite Agentic Wallet usage in production
- **skills.sh listing PR** lands same day as the marketing post

---

## 11. Risks & Open Questions

### 11.1 Architectural risks

| Risk | Mitigation |
|---|---|
| Base Sub Account SDK requires browser CryptoKey by default; headless flow needs custom signer | Investigate CDP SDK + `wallet_addSubAccount` `publicKey` parameter early in v1.5. If blocked, fall back to wallet contract owned by CDP-managed EOA. |
| Spend Permission UX requires user has Base Account smart wallet | Default flow assumes Base Account; EOA users get Bankr-only mode with clear upgrade prompt |
| x402 facilitator availability / cost | x402 Foundation backed by Linux Foundation; widely supported. Our existing AgentBook flow already proves the infrastructure works. |
| ERC-8004 ecosystem too immature for v3 | v3 is explicitly gated on ecosystem readiness. Ship writer-side, wait for readers. |
| Bankr API instability affects v1 | v1 falls back to direct RPC + Sub Account for protocols Bankr doesn't natively cover |
| Per-VM x402 ingress (v2.5) is operationally complex | Use Cloudflare Tunnels (well-trodden), or postpone v2.5 until ingress infrastructure exists |

### 11.2 Rules from CLAUDE.md that this work must respect

- **Rule 6 (no trailing newlines in env vars)**: any new env var (CDP keys,
  Sub Account address, x402 secrets) set via `vercel env add` MUST use
  `printf`, never `echo` or `<<<`.
- **Rule 10 (verify every config set)**: every reconciler step in this PRD
  must verify-after-write.
- **Rule 19 (`.select("*")` for safety-critical reads)**: any read of
  wallet/sub-account addresses for action MUST use `.select("*")`.
- **Rule 23 (sentinel-grep)**: new templates (sub-account-send.sh,
  install-instaclaw-x402.sh, base-* skill markdowns) MUST add
  `requiredSentinels` to the manifest.
- **Rule 24 (skill installation completeness)**: v1's base-* skills must
  follow the static-extracted pattern (no `.git/`, single SKILL.md +
  optional `references/`). Verify-after-write per the rule.
- **Rule 27 (coverage scripts)**: every new column / on-VM artifact gets
  a `scripts/_coverage-base-*.ts` script.
- **Rule 32 (hot-reload classification)**: if any new `agents.defaults.*`
  or other closure-captured config keys land, `RESTART_REQUIRED_CONFIG_PREFIXES`
  must be updated and reconciler restart triggered.
- **Rule 33 (atomic onboarding)**: v1.5's signup-flow Spend Permission
  grant must be atomic — partial-commit states (user has Sub Account
  but no permission, or vice versa) must be detected and self-heal.
- **Rule 34 (DB ↔ disk drift)**: every new column representing on-disk
  state needs a reconciler verify step.
- **Rule 47 (continuous reconciliation)**: skill plugin markdown updates
  reach all VMs via file-drift, no version-gate needed for content-only
  refreshes. Manifest bump only for behavioral changes.
- **Rule 49 (partner secrets actively verified)**: if any new partner
  secrets land (e.g., x402 facilitator API key), add a verifier to
  `lib/partner-secrets.ts`.
- **Rule 53 (freeze-v2 archive encryption)**: any new persistent agent
  state (sub-account key material, x402 task state) goes through the
  freeze archive flow with AES-256-GCM.
- **Rule 56 (migration self-containment)**: new tables / columns ship in
  `pending_migrations/`, applied via Studio, THEN moved to `migrations/`.
- **Rule 58 (cross-consumer token sync)**: Sub Account address on VM
  (`.env`) and in DB must always match; reconciler step verifies.
- **Rule 64 (manifest bump approval)**: every manifest bump per phase
  goes through vm-1019 canary first, then Cooper approval before fleet.
- **Rule 66 (every agent has BOTH primary + backup wallet)**: v1.5
  ADDS the Sub Account as a third wallet; does NOT remove Bankr or CDP
  receive-only fallback.
- **Rule 67 (Anthropic balance monitoring)**: irrelevant to this work
  but illustrates the alerting pattern we should mirror for any new
  external dependency (x402 facilitator, Base RPC, CDP SDK quotas).

### 11.3 Sequencing dependencies (real, not nice-to-have)

- v1.5 depends on v1 only for the routing surface in SOUL.md (additive).
- v2 does NOT depend on v1.5; the public API can ship against the existing
  pre-warm pool with no Sub Account change.
- v2.5 depends on v1.5 (the Sub Account is where x402 earnings land).
- v3 is independent — can ship alongside any earlier phase, gated on
  ecosystem readiness.

### 11.4 What we are NOT shipping (deliberate non-goals)

- **No bot that talks ON ChatGPT.** We are not building an InstaClaw
  ChatGPT app or Claude desktop integration in this PRD. Our agents live
  on Telegram / iMessage / future Discord / Slack. ChatGPT users can
  HIRE one of our agents via the v2 Base MCP plugin — but the day-to-day
  interaction surface stays where it is.
- **No deprecation of any existing wallet.** Bankr stays, CDP MPC
  backup stays. Sub Account is additive.
- **No bespoke per-protocol skills (Morpho-specific UI, Aerodrome-
  specific UI).** We compose the Base MCP skill plugins as-published.
  If Morpho changes their skill plugin, we re-pull and re-deploy.
- **No on-VM hosted Base MCP server.** Base MCP is a hosted service at
  `mcp.base.org`; we don't replicate it. We compose what it composes,
  without it.

---

## 12. Implementation Plan (Phase 3)

This section is concrete enough that a CC terminal can pick it up and
start. Each task lists the files to touch, the manifest deltas, the
testing surface, and the done-when.

### 12.1 v1 implementation

**Owner**: reconciler / manifest terminal.
**Cycle**: 3-5 days end-to-end.

**Task A — build the source-mode abstraction module FIRST**

This is the layering primitive. Everything else depends on it.

1. Create `instaclaw/lib/base-skills-registry.ts` per the §4.5 spec:
   - Export `BaseSkillSourceMode`, `BaseSkillEntry`, `BASE_SKILL_CATALOG`,
     `getBaseSkillCatalog()`, `getBaseSkillContent()`, `currentSourceMode()`.
   - All three modes implemented as branches in `getBaseSkillContent()`:
     `vendored` reads from `instaclaw/skills/base-<name>/SKILL.md` (via
     `fs.promises.readFile` against repo path resolved from `process.cwd()`
     or an env-injected `INSTACLAW_REPO_ROOT`).
     `live-fetch` does HTTP GET on `entry.upstreamUrl` with 10s timeout,
     5-minute in-memory cache keyed by `(entry.name, mode)`, falls back to
     vendored copy on fetch failure (returns `sourceMode: "vendored"` in
     the response so the caller knows the fallback fired).
     `registry-api` calls a placeholder `fetchFromRegistryApi(entry)` that
     throws `RegistryApiNotYetAvailable` today; the §4.6 probe cron lights
     up when Base ships the real endpoint, then we implement this branch.
2. Unit test `instaclaw/scripts/_test-base-skills-registry.ts`:
   - 12+ scenarios covering all three modes, fetch-failure fallback, cache
     hit/miss, sentinel mismatch, unknown env-var value (defaults to
     vendored per Rule 61 pattern), and content-shape validation.

**Task B — vendor the initial skill plugin set**

1. Create directories under `instaclaw/skills/`:
   `base-morpho/`, `base-moonwell/`, `base-aerodrome/`, `base-uniswap/`,
   `base-avantis/`, `base-virtuals/`.
2. Pull each protocol's skill plugin markdown from its canonical source
   (https://skills.sh/base or each partner's official GitHub repo).
   Write to `instaclaw/skills/base-<protocol>/SKILL.md`.
3. Populate `BASE_SKILL_CATALOG` in `lib/base-skills-registry.ts` with
   each entry's `name`, `vendoredPath`, `upstreamUrl`, `upstreamCommitSha`,
   `importedAt`, and `references` array if applicable.
4. The catalog IS the source-of-truth manifest — replaces the earlier
   draft's `skills/base-_source.md` (centralizing in the module is what
   lets the catalog itself become API-driven later in registry-api mode).

**Task C — write the fetch / refresh script**

1. Create `instaclaw/scripts/_fetch-base-skills.ts`:
   - Iterates `BASE_SKILL_CATALOG`
   - For each entry: imports the registry module, calls
     `getBaseSkillContent(entry, "live-fetch")` to get latest upstream
     content WITHOUT writing anything to disk
   - Computes SHA diff against the vendored copy
   - On drift: prompts operator (`--yes` flag for non-interactive),
     writes new vendored copy + updates `upstreamCommitSha` +
     `importedAt` in `BASE_SKILL_CATALOG` via AST edit (or simpler:
     prints the diff and asks operator to commit by hand)
   - Always prints a clean summary (entries up-to-date / drifted /
     failed-to-fetch)
2. Run once to populate; commit the initial vendored copies + filled
   catalog metadata.

**Task D — reconciler step `stepBaseSkills`**

1. Add `stepBaseSkills` to `instaclaw/lib/vm-reconcile.ts` after the
   existing partner-skill steps (mirror `stepDeployEdgeOverlay`'s
   structure at `lib/vm-reconcile.ts`):
   - `await getBaseSkillCatalog()` — works in all three modes
   - For each entry: `await getBaseSkillContent(entry)`; SHA-compare
     against on-VM `~/.openclaw/skills/<vendoredPath>/SKILL.md` via SSH
     - On match: `result.alreadyCorrect.push(...)`, continue
     - On drift: backup existing, atomic write `.tmp` + `mv`, verify
       (Rule 10), push to `result.fixed`
   - For `references[]`: same flow per file
2. Add to orchestrator chain in `reconcileVM` right after the existing
   skills deploy.
3. Per Rule 39: `stepBaseSkills` failures push to `result.warnings`, NOT
   `result.errors`. Base ecosystem skills are non-critical to gateway
   uptime; a transient upstream fetch failure should not hold cv-bump for
   a paying customer's VM.

**Task E — file-drift cron path (Rule 47)**

1. The existing `cron/file-drift` already calls `runFileDriftPass` which
   iterates `vm-manifest.ts:files[]`. The static `instaclaw/skills/*`
   files are picked up via `skillsFromRepo: true` and will continue to
   reach all VMs through that path in `vendored` mode.
2. For `live-fetch` / `registry-api` modes: extend `runFileDriftPass`
   (or add a sibling `runBaseSkillsDriftPass`) that calls `stepBaseSkills`
   continuously, no version gate (per Rule 47), so upstream content
   changes reach the fleet within one cron tick (~5 min) without a
   manifest version bump.

**Task F — SOUL.md / AGENTS.md routing**

1. `lib/workspace-templates-v2.ts`: add the "Base DeFi Skill Routing"
   table from §4.2 above into the V2 templates. Keep under 600 chars
   total per `feedback_skill_size_budget.md`.
2. Mirror in `lib/agent-intelligence.ts` for V1 SOUL.md supplement.
3. New marker `BASE_DEFI_ROUTING_V1` per Rule 23 pattern.

**Task G — registry-API probe cron**

1. Create `app/api/cron/probe-base-skills-registry/route.ts` per §4.6.
2. Wire in `vercel.json` under `crons`: schedule `0 * * * *` (hourly).
3. Probe list: hardcoded array of guessed registry-API endpoints (see
   §4.6). Make easy to extend — first place to look when Base announces
   anything new.
4. Per Rule 49: also exercise this probe from
   `scripts/_verify-partner-secrets.ts` (or a sibling
   `_verify-partner-endpoints.ts`) so operator can run on demand.
5. Per Rule 39: probe failures are not errors — they're the expected
   normal state until Base ships the API.

**Task H — coverage script**

1. Create `instaclaw/scripts/_coverage-base-skills.ts`:
   - Random-sample 5 healthy + assigned VMs
   - For each, SSH `ls ~/.openclaw/skills/base-*/SKILL.md` AND `wc -c`
     each file
   - Confirm all 6 skill directories exist with non-empty SKILL.md
   - Also confirm content SHA matches the registry's expected SHA in
     `BASE_SKILL_CATALOG` (catches drift in either direction)
   - Exit 1 on any miss; report which VMs / skills.

**Task I — env-var registration**

1. Add `BASE_SKILLS_SOURCE_MODE` (default unset → `vendored`) to the
   `BOOLEAN_ENVS` / equivalent table in `scripts/_pre-bake-check.ts`
   so we validate it per Rule 61.
2. Document the env var + the three valid values + the operational
   flip procedure (§4.5) in `instaclaw/docs/operations/env-vars.md`
   (or create the doc if it doesn't exist — Cooper has a similar
   reference doc for other env vars).

**Task J — vm-1019 canary + mode-flip rehearsal + Cooper approval +
fleet deploy**

Per Rule 64:
1. Apply Tasks A-I locally + run the unit test from Task A2.
2. Push to a preview branch; deploy to Vercel preview.
3. SSH to vm-1019, run `npx tsx scripts/_canary-base-skills.ts vm-1019`:
   - Confirms all 6 base-* skill files land on disk via reconciler
   - Confirms SHA matches catalog
4. **Rehearse the mode flip** (this is the load-bearing test that
   proves the abstraction works):
   ```bash
   BASE_SKILLS_SOURCE_MODE=live-fetch npx tsx \
     scripts/_canary-base-skills-mode.ts vm-1019
   ```
   - Confirms `getBaseSkillContent()` resolves via HTTP in live-fetch
     mode
   - Same content lands on disk
   - SHA still matches
5. Cooper sends "lend my 25 USDC on the top Morpho vault" to vm-1019
   via Telegram. Agent reads skill, executes, replies with tx hash +
   Basescan link in <2min.
6. Wait for Cooper's explicit "ship it" per Rule 64.
7. Bump manifest version, push to main.
8. Watch reconciler propagate over ~30 min.
9. Run coverage script — confirm 5/5 sampled VMs have all 6 skills with
   correct SHAs.

**v1 done-when**: see §4.7.

---

### 12.2 v1.5 implementation

**Owner**: wallet / configure terminal.
**Cycle**: 1-2 weeks end-to-end.

**Task A — DB migration**

1. Create `instaclaw/supabase/pending_migrations/<ts>_vm_base_sub_account.sql`:
   ```sql
   ALTER TABLE public.instaclaw_vms
     ADD COLUMN IF NOT EXISTS base_sub_account_address TEXT,
     ADD COLUMN IF NOT EXISTS base_sub_account_provisioned_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS base_sub_account_failed_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS base_spend_permission_active BOOLEAN DEFAULT FALSE,
     ADD COLUMN IF NOT EXISTS base_spend_permission_expires_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS base_spend_permission_limit_usdc NUMERIC;
   ```
2. Apply to prod via Supabase Studio per Rule 56.
3. `git mv` to `migrations/`.

**Task B — provisioning helper**

1. Create `instaclaw/lib/base-sub-account.ts` exporting
   `provisionBaseSubAccount({ vmId, userId, parentAccountAddress })`.
2. Idempotency guard (DB-first check, Rule 66 pattern):
   ```ts
   const { data: vm } = await sb
     .from("instaclaw_vms")
     .select("*")
     .eq("id", vmId)
     .single();
   if (vm?.base_sub_account_address) return { reused: true, address: vm.base_sub_account_address };
   ```
3. Mint CDP-managed signer key via `@coinbase/cdp-sdk` (resolve Q1
   from section 5.6 first).
4. Call `wallet_addSubAccount` via Base Account SDK (resolve Q2 first).
5. Persist `base_sub_account_address` to DB before anything else.

**Task C — onboarding flow Spend Permission grant**

1. Add a new step in the signup flow (likely in
   `app/api/onboarding/save/route.ts` or the dashboard onboarding UI):
   immediately after Base Account connect, trigger
   `requestSpendPermission` with default policy (100 USDC / week,
   90-day expiry).
2. On success, write to DB: `base_spend_permission_active=TRUE`,
   `base_spend_permission_expires_at`, `base_spend_permission_limit_usdc`.

**Task D — on-VM env + signer script**

1. `lib/ssh.ts:configureOpenClaw` — emit
   `BASE_SUB_ACCOUNT_ADDRESS=<addr>` to `~/.openclaw/.env`.
2. Create `instaclaw/scripts/sub-account-send.sh` — CDP-SDK signing
   wrapper. Add to `vm-manifest.ts:files[]` with `requiredSentinels`
   per Rule 23.
3. Deploy via `stepFiles` (file-drift cron picks up within ~5 min).

**Task E — WALLET.md update**

1. `lib/ssh.ts:buildWalletMd` — add "## Agent Sub Account (Autonomous
   Spend)" section conditional on `subAccountAddress` parameter.
2. Update `~/.openclaw/workspace/WALLET.md` on existing VMs via
   `scripts/_backfill-wallet-md.ts` (mirror Rule 66 pattern).

**Task F — SOUL.md / AGENTS.md routing**

1. Teach the agent when to use Sub Account vs Bankr (see section 5.4
   table).
2. Both V1 and V2 templates.

**Task G — backfill cron**

1. Create `app/api/cron/provision-missing-sub-accounts/route.ts` —
   every 30 min, concurrency 3, PER_RUN_LIMIT 50.
2. Mirror Rule 66's `provision-missing-cdp-wallets` cron pattern
   exactly (idempotency, locking, alerts).

**Task H — coverage script + reconciler verify step**

1. `scripts/_coverage-base-sub-account.ts` per Rule 27.
2. Reconciler step `stepBaseSubAccountVerify` in `lib/vm-reconcile.ts`:
   reads on-VM `BASE_SUB_ACCOUNT_ADDRESS`, compares to DB, repairs
   drift via merge write per Rule 34 / Rule 58.

**Task I — vm-1019 canary + Cooper approval + fleet deploy**

Same as v1 Task F, but the test prompt is "deposit 5 USDC into
Morpho's USDC vault" — must land onchain without any popup or click.

**v1.5 done-when**: same as section 5.7.

---

### 12.3 v2 implementation

**Owner**: public-API terminal.
**Cycle**: 2-3 weeks end-to-end.

(Detailed implementation deferred to a follow-up PRD —
`instaclaw/docs/prd/base-mcp-skill-plugin-v2.md` — to be written when v1
+ v1.5 are stable. Outline above in section 6 is sufficient for
sequencing.)

Key prerequisites:
- v2 needs a pre-warm pool variant — coordinate with `lib/vm-lifecycle`
  + `app/api/cron/replenish-pool` to add a smaller, shorter-idle
  x402 pool.
- v2 needs `lib/x402-server.ts` mirroring our existing `@x402/core`
  AgentBook usage.
- v2 needs DB table `instaclaw_x402_tasks` per Rule 56.

---

### 12.4 v2.5 implementation

**Owner**: public-API terminal.
**Cycle**: 3-4 weeks end-to-end.

(Detailed implementation deferred to a follow-up PRD —
`instaclaw/docs/prd/instaclaw-x402-earnings.md` — to be written when v2
is in beta.)

Key prerequisites:
- v2.5 needs v1.5 (Sub Account is the earnings landing zone)
- v2.5 needs per-VM ingress (Cloudflare Tunnel or similar)
- v2.5 needs EARN.md template extension

---

### 12.5 v3 implementation

**Owner**: identity terminal.
**Cycle**: 4-6 weeks (gated on ecosystem readiness).

(Detailed implementation deferred to a follow-up PRD —
`instaclaw/docs/prd/erc8004-agent-identity.md` — to be written when v2.5
is in beta AND ERC-8004 reader-side ecosystem has measurable adoption.)

---

## 13. Glossary

- **Base MCP**: hosted MCP server at `https://mcp.base.org`, OAuth-gated,
  per-tx human approval. Launched 2026-05-26.
- **Base Account**: Coinbase smart wallet (smart contract wallet) on Base.
- **Sub Account**: child wallet of a Base Account, addressable separately,
  signs separately. ERC-7895.
- **Spend Permission**: onchain authorization for a third-party signer
  (e.g., a Sub Account) to pull funds from a parent Base Account up to
  defined rules.
- **Agentic Wallet** (CDP): Coinbase's agent wallet suite. CLI `awal`.
  Built on Sub Accounts + Spend Permissions.
- **x402**: HTTP-native payment protocol; HTTP 402 status code +
  PAYMENT-REQUIRED header. Linux Foundation steward as of 2026-04-02.
- **ERC-8004**: Ethereum trustless-agent identity standard. Three
  registries: identity (NFT-based), feedback, validation. Live on
  Ethereum mainnet 2026-01-29.
- **skill plugin**: a markdown file defining how an LLM agent should
  interact with a protocol's HTTP endpoints to discover state and
  construct unsigned calldata.
- **skills.sh**: Base's public skill plugin registry. Submit via GitHub PR.

---

## 14. Decision log

- **2026-05-26**: PRD authored. Three-layer thesis (consumer / identity
  / producer) and five-phase ship plan locked.
- **2026-05-26**: Decision NOT to install mcp.base.org as a per-VM MCP
  server. Reason: OAuth + human-in-loop is incompatible with headless
  autonomous fleet. We compose the skill plugins natively instead.
- **2026-05-26**: Decision NOT to deprecate Bankr or CDP MPC wallets.
  Sub Account is additive (4th wallet, distinct role).
- **2026-05-26**: Decision to defer v2 / v2.5 / v3 implementation
  details to follow-up PRDs once v1 + v1.5 are in production.
- **2026-05-26**: Decision to defer marketing post generation to a
  separate `/launch` / `/viral` session per Rule 55. This PRD provides
  positioning skeleton only.
- **2026-05-26** (revision, Cooper-directed): Added §4.5 architectural
  guardrail — source-mode abstraction via `lib/base-skills-registry.ts`
  and §4.6 hourly probe cron for the future Base registry API.
  Rationale: Base will add new launch partners and likely ship a proper
  registry API; we must design the deployment so flipping from vendored
  to live-fetch to registry-api is a single env-var change, not a
  rewrite. Goal: zero ongoing maintenance for keeping skill plugins
  current as the ecosystem evolves.
- **2026-05-26** (revision): Implementation plan §12.1 reordered to put
  the abstraction module FIRST (Task A) before any vendoring or fetch
  work. The mode-flip rehearsal (Task J step 4) is the canonical
  acceptance test for the guardrail — it must pass before fleet deploy.
