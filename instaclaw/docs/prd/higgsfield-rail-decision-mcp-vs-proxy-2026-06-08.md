# Higgsfield Rail Decision — Official MCP / CLI / Skill vs. our Direct Proxy

**Date:** 2026-06-08 · **Read-only research, zero spend.** Companion to `higgsfield-official-rail-2026-06-08.md` (architecture), `higgsfield-cost-calibration-2026-06-08.md` (measured cost), `higgsfield-catalog-capabilities-sweep-2026-06-08.md` (catalog).

## TL;DR — STAY on our direct proxy. The official MCP/CLI/Skill are the wrong rail for the managed product.
Higgsfield ships **two rails for two different audiences**, and the official MCP/CLI/Skill are all on the rail that **breaks our managed model**:

| | **Agent rail** = official **MCP + CLI + Skill** | **Cloud API rail** = **our proxy** |
|---|---|---|
| Host | `mcp.higgsfield.ai` / `fnf.higgsfield.ai/agents` | `platform.higgsfield.ai` |
| Auth | **OAuth device-flow → per-USER Higgsfield account** | **one API key** (`KEY_ID:KEY_SECRET`), server-side |
| Billing | the **user's own plan credits** | **one central prepaid balance** (we buy @ 16/$1) |
| Metering | per Higgsfield account (no per-user attribution under a shared account) | **per-user via OUR gateway token + credit gate** |
| Audience | a **solo creator** connecting their own agent to their own account | a **platform** building a product on Higgsfield |

**Our entire product is "one central key + WE meter/gate/charge in our credits."** The official MCP/CLI/Skill assume the opposite (each user authes their own Higgsfield account). So for the managed multi-tenant path they're **disqualified on billing/identity** — not because they're bad, but because they're built for solo users. We're already on the rail Higgsfield designed for exactly our case (build-a-product → Cloud API + SDK). **Recommendation: keep the direct proxy; adopt the Skill/CLI's *knowledge* (model slugs, prompt patterns, status logic) as a hybrid; reserve the official CLI/Skill for internal ops tooling only.**

---

## What each official piece actually is (read in full)

- **CLI** (`@higgsfield/client` Go binary `hf`): `higgsfield auth login` = OAuth device flow → `credentials.json` (per-user account, refresh token). Commands: auth/account/workspace/model/generate/upload/soul-id/marketing-studio. Hits `fnf.higgsfield.ai/agents/*`. Env overrides exist (`HIGGSFIELD_API_URL`, `_CREDENTIALS_PATH`) but **no API-key auth** — OAuth only. `account status → <email> — <plan> plan, <N> credits` (consumer plan credits).
- **MCP** (`mcp.higgsfield.ai/mcp`): hosted remote MCP server. Discovery (`/.well-known/oauth-protected-resource`): scopes `openid email offline_access`; **`device_code` flow for clients `openclaw / hermes / memoclaw`** (upstream identity = Clerk). Same per-user-account model as the CLI, exposed as MCP tools.
- **Skill** (`github.com/higgsfield-ai/skills`, v0.3.0, MIT): 4 Markdown skills — `higgsfield-generate`, `higgsfield-soul-id`, `higgsfield-product-photoshoot`, `higgsfield-marketplace-cards` — with rich references (model-catalog, prompt-engineering, marketing modes, troubleshooting). **It is a prompt layer that "wraps the `higgsfield` CLI."** `INSTALL_FOR_AGENTS.md`: Step 1 install the CLI, Step 2 *"Ask the user to run `higgsfield auth login` … opens a browser for OAuth,"* Step 4 verify with `higgsfield account status`. → **assumes a local CLI on `$PATH` authenticated interactively to one user's account.**

---

## The five questions, answered against our reality

### 1. What do MCP/CLI/Skill give us that the proxy doesn't — and vice versa?
**They give (that we'd otherwise build ourselves):**
- A polished, **Higgsfield-maintained prompt layer** — model-selection logic, UX rules, a discovery guardrail, prompt-engineering references, Marketing-Studio/product modes, Virality-Predictor routing. (Genuinely good prompt craft.)
- An **auto-updated model catalog** + `/higgsfield:generate` UX.
- OAuth so a **solo user's own account "just works."**

**They DON'T give (and we require):**
- **Central spend control** (one key we own), **per-user metering/attribution**, **our credit currency / gate / charge**, **fleet-wide kill-switch + caps**. They assume one account = one user.

**Our proxy gives (that they can't):** the central-key + per-user-gateway-token + credit-gate that *is* the managed product. **It lacks** (today) only the polished prompt layer and the maintained catalog — both of which we can lift (Q4), not adopt the rail for.

### 2. Billing + identity — the decisive question
**The official MCP/CLI/Skill bill the USER's own Higgsfield account (OAuth).** For the managed product that means one of:
- **(a) Every user gets their own Higgsfield account + billing.** Breaks the managed model outright — our users don't have (and shouldn't need) Higgsfield accounts; we lose central control and the credit product. ❌
- **(b) Run all ~164 VMs under ONE shared OAuth account.** Technically possible but **three-way broken**: (i) **refresh-token rotation race** — 164 VMs refreshing one token invalidate each other (the "Arch 2" disqualifier from the architecture PRD); (ii) it spends **consumer *plan* credits** (monthly allotment), not pay-per-use, so it doesn't scale with usage the way our prepaid balance does; (iii) **no per-user attribution** — one account is a single usage pool, so **we cannot meter, gate, or charge per user** — which is the whole product. ❌

**Only the Cloud API rail gives all three at once:** one central key (we own spend) + pay-per-use (scales) + **per-user attribution via our gateway token** (we meter/gate/charge). → **MCP/CLI/Skill are not viable for the managed billing model. Verdict locked.**

### 3. Does the official Skill fit a multi-tenant fleet?
**No — it assumes a single-user, local, interactive-OAuth runtime.** `INSTALL_FOR_AGENTS.md` literally has the agent *ask the human to run `higgsfield auth login` in a browser* and verify `account status`. There is no platform-owner-controls-spend mode; spend is the logged-in user's plan. **Disqualifier for the managed product.** *(It could be handy for OUR internal/ops tooling — an operator generating on a Higgsfield account from their own machine — but never the customer path.)*

### 4. Can we adopt PIECES while keeping our gateway + central key + credit gate?
**Yes — and we should. Concrete, no-rail-adoption lifts:**
- **Model slugs + param schemas** (Skill `references/model-catalog.md` + CLI `MODELS.md`) → seed our **proxy model-allowlist + pre-submit input validation** (directly closes the param-coercion guardrail gap from the calibration doc).
- **Prompt patterns** (Skill `references/prompt-engineering.md` + the `generate` SKILL.md's model-selection logic, UX rules — concise, no JSON dumps, detect-user-language, `--wait`/async) → fold into **our own on-VM SKILL.md**, rewired to call our proxy instead of the CLI.
- **Mode taxonomies** (Marketing-Studio 9 modes, product-photoshoot 10 modes) → if/when we expose those tiers.
- **Status/polling logic** (queued → in_progress → completed/nsfw/failed) → already mirrored in our proxy; confirmed against docs.
- **Feature concepts** — Virality Predictor (`brain_activity`), Soul-ID (train-once-reuse), Marketing Studio — as product-feature references (confirm Cloud-API availability per the sweep doc §7; Soul-ID + Marketing Studio are in the Cloud SDK, Virality TBD on Cloud).
- **Long-form cross-reference:** the Skill states **Seedance 2.0 does "4–15s, 12s valid"** — so Seedance (not just Kling) is a long-clip candidate; confirm the Cloud `seedance` slug's duration support (sweep §7).

### 5. Net recommendation
**Direct proxy (Cloud API rail) for the managed product. Not MCP/CLI/Skill.** Hybrid = **lift the Skill/CLI's knowledge** (slugs, schemas, prompt patterns, mode taxonomies, status logic) into our own SKILL.md + proxy. Optionally keep the official **CLI/Skill for internal ops tooling** (operator-on-their-own-account), never for customers.

**Why, from our constraints (not shininess):** the central-key + we-meter-and-charge architecture is the product. The official MCP is elegant *for a solo user with their own Higgsfield plan*, but it has no central-spend or per-user-metering hook and bills the user's account — so it **breaks the managed model**. Higgsfield itself splits these: the Cloud API is their "build a product on us" rail; MCP/CLI/Skill is their "connect your own agent to your own account" rail. **We are already on the correct rail.** Building the guardrails on our proxy is the right move — do not switch.

---

## One caveat to keep honest
The official Skill/CLI catalog is the **agent rail** (30+ models incl. Veo 3.1, Kling 3.0, Seedance 2.0, Virality Predictor, Soul-ID, Marketing Studio). The **Cloud API** catalog (what our key can hit) is the auth-gated Gallery — overlapping but possibly a different subset. Some agent-rail features (notably **Virality Predictor / `brain_activity`**) are **not yet confirmed on the Cloud API**. If a feature we want (e.g. the uniquely-ownable "score my video") turns out to be agent-rail-only, the options are: confirm it on the Cloud Gallery, request Cloud access from Higgsfield, or (worst case) run that one feature via a server-side CLI under our own account as an internal bridge. Track under the sweep doc's §7 funded-test / Gallery-export follow-ups — it does **not** change the rail decision for the core generate-and-deliver product.

*Read-only rail analysis, 2026-06-08. No jobs, no spend, nothing built.*
