# Phase 1 Implementation Plan — ChatGPT OAuth as Second Provider

**Companion to:** [chatgpt-oauth-history-import.md](./chatgpt-oauth-history-import.md), [chatgpt-oauth-history-import-decisions.md](./chatgpt-oauth-history-import-decisions.md), [chatgpt-oauth-phase-0-spike-report.md](./chatgpt-oauth-phase-0-spike-report.md)
**Date:** 2026-05-19
**Status:** Planning — NO CODE until Cooper approves the scope cut and the 7 blocking decisions
**Reading time:** 30-40 min

---

## TL;DR

**The verdict from deep codebase audit + live VM inspection:** the existing system supports multi-provider operation more than the earlier research realized. OpenClaw runtime natively understands `agents.defaults.model.primary: "openai/gpt-5.5"` with fallback arrays. The proxy already accepts both Anthropic-SDK (`x-api-key`) and OpenAI-SDK (`Authorization: Bearer`) auth styles at the gateway. The `auth-profiles.json` shape is already multi-profile (every healthy VM has BOTH `anthropic:default` and `openai:default` populated today, even before this feature exists — the OpenAI profile holds our server-side embeddings key).

**What's NOT supported today:** the gateway proxy's routing logic (`app/api/gateway/proxy/route.ts` lines 866-1026) only branches between Anthropic and MiniMax. There's no OpenAI Responses API code path, no WebSocket transport, no `originator: codex_cli_rs` headers, no per-user OAuth-token lookup, no Codex pricing in `MODEL_COST_WEIGHTS`.

**The scope-reducing realization that should govern Phase 1:** if we route OpenAI calls **DIRECT from the VM to `chatgpt.com/backend-api/codex/responses`** (bypassing our proxy), we sidestep all the proxy-side work. The OpenClaw runtime on the VM already speaks multi-provider; the user's OpenAI access_token sits in `auth-profiles.json` (`openai:default.key`); the agent makes the call directly. Our infrastructure isn't in the critical path. **This is the same architecture BYOK Anthropic users use today** — they bypass the proxy and call `api.anthropic.com` directly.

**Trade-off:** the per-call fallback from §Q4 (when OpenAI 429s, transparently retry on our Anthropic key — "the moat") becomes harder. Either we do it on the VM (OpenClaw runtime config) — risky, brittle — or we accept that Phase 1 ships without auto-fallback and we add it in Phase 1.5 via proxy interception once the rest is stable. **Recommendation: ship Phase 1 without auto-fallback.** Users can still manually `/switch claude` if they hit their OpenAI quota; the moat lands in Phase 1.5 (1-2 weeks of additional engineering).

**Net Phase 1 scope (4 weeks):**
1. Device-code OAuth flow → store tokens in DB → reconciler pushes to disk
2. Extend `buildAuthProfilesJson` to write the OpenAI bearer profile
3. Extend `stepAuthProfiles` to preserve the OpenAI profile AND verify the OAuth bearer
4. Extend `stepEnforceModelPrimary` to push `openai/gpt-5.5` for `api_mode='chatgpt_oauth'` users
5. New `api_mode='chatgpt_oauth'` value, new Stripe price IDs, new pricing UI, new onboarding step
6. Token refresh cron with row-level lock
7. Synthetic tests that prove Anthropic-only routing is unaffected for the existing 246 VMs

**Things explicitly OUT of Phase 1 scope** (deferred to 1.5 or 2):
- Auto-fallback on 429 (Q4 "the moat") — defer to Phase 1.5
- History import (Q15-Q23) — Phase 2
- Per-call gateway accounting for OpenAI calls — not needed (user's sub pays)
- `agents.defaults.model.fallbacks: ["anthropic/claude-sonnet-4-6"]` — STRETCH; if OpenClaw runtime auto-fails-over to fallback on 429, this gives us the moat for free. Verify in spike.

---

## 1. Mental model — how Anthropic-only routing works today (verified end-to-end)

This section is the source of truth — written from direct reading of `app/api/gateway/proxy/route.ts`, `lib/ssh.ts`, `lib/vm-reconcile.ts`, `lib/credit-constants.ts`, `lib/billing-status.ts`, and live-VM inspection of vm-050 (cv=105, healthy, all_inclusive, Sonnet 4.6 default).

### 1.1 Provisioning — how a fresh VM gets configured

`configureOpenClaw()` in `lib/ssh.ts:~5353+` runs at VM provisioning time. It calls `buildAuthProfilesJson(apiKey, proxyBaseUrl, openaiKey)` (lib/ssh.ts:5027-5055) which constructs:

```json
{
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "<gateway_token>",
      "baseUrl": "https://instaclaw.io/api/gateway"
    },
    "openai:default": {
      "type": "api_key",
      "provider": "openai",
      "key": "<process.env.OPENAI_API_KEY>"
    }
  }
}
```

(For BYOK: `baseUrl` is omitted, `key` is user's own Anthropic key, and the OpenAI profile depends on whether OPENAI_API_KEY env var is set server-side.)

The `openai:default` profile is used today **only for embeddings** (`lib/match-embeddings.ts` calls OpenAI text-embedding-3-large from the agent runtime). It's our server-side OpenAI API key, not anything user-specific. Verified on vm-050: the profile is present, the `key` starts with `sk-proj-...`.

Same file is also built byte-identically by `cloud-init-tarball.ts:519-525` (the cloud-init provisioning path). Both paths share `buildAuthProfilesJson` — they cannot diverge.

The `openclaw.json` is also written at this time. The model-related fields on vm-050 today:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-6",
        "fallbacks": ["anthropic/claude-haiku-4-5-20251001"]
      },
      "heartbeat": { "every": "3h", "session": "heartbeat" }
    }
  }
}
```

**Critical finding:** OpenClaw natively supports the `provider/model-name` prefix AND a `fallbacks` array. The earlier research-agent report missed this. Adding `openai/gpt-5.5` is at the model-name level supported — what's NOT supported today is whether OpenClaw's runtime actually KNOWS HOW to call OpenAI's Codex endpoint (the WebSocket + special headers per Phase 0 spike report). That's the spike question for week 1 of Phase 1.

### 1.2 Reconciliation — how the reconciler keeps state in sync

Two relevant steps run every reconcile cycle (every 3 min):

**`stepEnforceModelPrimary`** (`lib/vm-reconcile.ts:3599`) pushes `agents.defaults.model.primary` from `vm.default_model` (DB column). Without this, OpenClaw falls back to its built-in default `openai/gpt-5.4` — which caused a $500/month incident in April 2026. The step reads the DB value, compares to disk, runs `openclaw config set agents.defaults.model.primary '<value>'`, verifies via re-read.

**`stepAuthProfiles`** (`lib/vm-reconcile.ts:4265-4366`) verifies `auth-profiles.json` on disk:
- For `api_mode=all_inclusive`: must have `anthropic:default.baseUrl = "https://instaclaw.io/api/gateway"` AND `anthropic:default.key = vm.gateway_token`
- For `api_mode=byok`: must NOT have `baseUrl` (BYOK calls Anthropic direct)
- **Bug discovered:** when this step rebuilds for all-inclusive (lines 4342-4356), it writes ONLY the `anthropic:default` profile. The `openai:default` profile gets WIPED OUT. (Doesn't bite today because nothing else verifies the OpenAI profile, but it's a load-bearing bug for adding ChatGPT OAuth.)

Other reconciler steps (`stepConfigSettings` for the manifest's ~50 config keys, `stepFiles` for templates, `stepEnvVarPush` for env vars) are unrelated to model/auth routing for our purposes.

### 1.3 Inference — the request lifecycle

A user sends a Telegram message → OpenClaw agent on the VM packages it into Anthropic Messages API format → calls `POST https://instaclaw.io/api/gateway/v1/messages` with `Authorization: Bearer <gateway_token>` (or `x-api-key`).

The proxy at `app/api/gateway/proxy/route.ts`:

1. **Authenticate** (lines 193-229): looks up the gateway_token in `instaclaw_vms`. If unknown → 401.
2. **Gate by api_mode** (lines 292-317):
   - If `api_mode IS NULL` → 403 "not fully configured"
   - If `api_mode !== "all_inclusive"` → 403 "BYOK users should call Anthropic directly"
   - So **today, only all-inclusive traffic hits this proxy**. BYOK bypasses entirely.
3. **Parse request body** (lines 328-339): extract `model`, `stream`. Fall back to `vm.default_model` then `"minimax-m2.5"`.
4. **Strip thinking blocks from history** (lines 341-405): defensive against OpenClaw's pre-conversion of MiniMax reasoning tags into Anthropic-shape `thinking` blocks without valid signatures.
5. **Detect tool continuation** (lines 408-417): if last user message has `tool_result` blocks, charge 0.2× (`TOOL_CONTINUATION_DISCOUNT`).
6. **Circuit breaker check** (lines 420-486): if total fleet spend > $100/day (configurable), block non-starter requests. Returns friendly assistant message.
7. **Heartbeat detection** (lines 491-606): timing-based + content-based + ping-based. If heartbeat → force `requestedModel = "minimax-m2.5"` (0.2× cost). Bypassed if `x-strict-canary: true` or `x-call-kind: match-pipeline` headers, OR if the message is a real user message (>20 chars, not a tool continuation, not a heartbeat-frame system prompt).
8. **Atomic credit check + increment** (lines 653-678): RPC `instaclaw_check_and_increment` with `(vm_id, tier, model, is_heartbeat, timezone, is_virtuals, is_tool_continuation)`. Returns `{allowed, count, source, display_limit, tier_2_calls, tier_3_calls}`. The RPC has its OWN copy of the credit weights in SQL CASE statements — must be kept in sync with `lib/credit-constants.ts` (`MODEL_COST_WEIGHTS = {minimax: 0.2, haiku: 1, sonnet: 4, opus: 19}`).
9. **Block/buffer messaging** (lines 701-775): if RPC denied → friendly upsell message. If `source=heartbeat_exhausted` → silent empty response. If `source=virtuals_exhausted` → polite message.
10. **Intelligent routing** (lines 793-861): `routeModel(routingCtx)` from `lib/model-router.ts` analyzes message content + tier budget + toggles and returns `{model, tier, reason, retryOnFailure}`. Advisory — failure is non-blocking (line 852-860). Can downgrade Opus → Sonnet → Haiku if budgets exhausted. Can upgrade default → Sonnet on long messages, code blocks, multi-step patterns.
11. **Provider routing** (lines 866-1026):
    - If `requestedModel.toLowerCase().includes("minimax")` → POST to `https://api.minimax.io/anthropic/v1/messages` with `Authorization: Bearer ${MINIMAX_API_KEY}`, rewrite body's `model` to `"MiniMax-M2.5"`
    - Otherwise → POST to `https://api.anthropic.com/v1/messages` with `x-api-key: ${ANTHROPIC_API_KEY}`, apply thinking-parameter normalization, apply prompt-caching beta header, wrap system prompt in `cache_control` blocks for >4096-char systems.
12. **Forward request** with 90s timeout. SSE if streaming, JSON if not. Pass response back verbatim.

**There is no third branch. There is no OpenAI inference path. There is no Codex Responses API support.**

### 1.4 Credits — the full accounting model

`lib/credit-constants.ts` is the single source of truth (with a warning that the SQL RPC has a duplicate copy):

- **Daily tier limits** (units): Starter=600, Pro=1000, Power=2500, Internal=5000
- **Model cost weights**: minimax=0.2, haiku=1, sonnet=4, opus=19. Matched via substring on the model name (`getModelCostWeight` lines 58-65 — `if m.includes("sonnet") return 4` etc.)
- **Tool continuation discount**: 0.2× when the last user message has `tool_result` blocks
- **Heartbeat daily budget**: 100 units (separate; never touches user limit)
- **Heartbeat per-cycle cap**: 10 calls

Two separate accounting streams:
- **Tier limit**: visible to user as "X / 600 units today". Resets at midnight in user's `vm.user_timezone`.
- **Credit pack balance**: stored in `instaclaw_users.credit_balance`. Decremented same way (weighted). Used for WLD users and Stripe credit-pack purchases. Consumed AFTER tier limit is exhausted.

**Provider routing's interaction with credits:** model name → cost weight → debit amount. If we route to OpenAI (user's sub pays), should credits be charged? **No.** A `chatgpt_oauth` user should NOT have their InstaClaw daily limit decremented when calling OpenAI — their OpenAI subscription is paying for inference. We charge them monthly for infrastructure only.

### 1.5 The 4 token locations + the openai:default 5th-but-shared profile

Per CLAUDE.md MEMORY.md, four locations must agree for the gateway_token specifically:
- `instaclaw_vms.gateway_token` (DB)
- `~/.openclaw/openclaw.json` (`gateway.auth.token`)
- `~/.openclaw/.env` (`GATEWAY_TOKEN`)
- `~/.openclaw/agents/main/agent/auth-profiles.json` (`anthropic:default.key` for all-inclusive)

Verified on vm-050 today, all four start with `af4399b5c8a6...`. Synced by `stepAuthProfiles` (Rule 34).

The `openai:default.key` in `auth-profiles.json` is a 5th location BUT it's currently fleet-wide-shared (the same `process.env.OPENAI_API_KEY` written to every VM, used for embeddings). It has no DB row, no per-VM uniqueness. Adding per-user OpenAI OAuth tokens means this profile becomes per-user — and we need a new sync mechanism.

### 1.6 The api_mode field — current taxonomy

`lib/billing-status.ts:206-273` `classify` function recognizes only `all_inclusive` and `byok` as `api_mode` values. Five `isPaying` paths:
1. Active/trialing Stripe sub, payment current
2. Same but past_due in grace
3. Positive `credit_balance` (WLD)
4. `partner` set (edge_city, etc.)
5. all_inclusive + active sub (explicit reason flag; redundant with Path 1 but improves audit logs)

Fleet today: 246 all_inclusive / 3 BYOK / 0 anything else.

### 1.7 What changes for a user — the journey today

Anthropic-only user journey:
- Sign up via Stripe checkout → webhook creates sub
- VM assigned from pool → `/api/vm/configure` → `configureOpenClaw` writes everything
- First reconcile tick verifies + repairs
- User Telegram message → agent on VM → `POST instaclaw.io/api/gateway` with anthropic SDK shape → proxy → Anthropic → response → Telegram reply

---

## 2. Gap analysis — what's missing for ChatGPT to work alongside

For ChatGPT inference to work for a user who connects their subscription, the following gaps exist today:

| Gap | Where | Severity | Phase 1 fix |
|---|---|---|---|
| **No `chatgpt_oauth` value in `api_mode`** | DB constraint, billing-status classify, proxy gate | HIGH | Add value to check constraint; add classify Path 6; UPDATE proxy gate to allow `chatgpt_oauth` through (or not — see §4) |
| **No per-user OAuth-token storage** | `instaclaw_users` columns | HIGH | Migration: 10 new columns per PRD §4.4 + `instaclaw_oauth_device_flows` table |
| **No `openai-oauth.json` on disk** | VM filesystem | HIGH | New file at `~/.openclaw/agents/main/agent/openai-oauth.json` (mode 0600), atomic-write template |
| **`buildAuthProfilesJson` doesn't accept an OAuth bearer profile** | `lib/ssh.ts:5027` | MEDIUM | Extend function signature with optional `openaiOAuthBearer` param; build new profile shape; keep backward-compatible default |
| **`stepAuthProfiles` wipes the `openai:default` profile on rebuild** | `lib/vm-reconcile.ts:4342-4356` | HIGH (existing bug; latent today, blocker for us) | Preserve `openai:default` on rebuild; also verify+write the new OAuth-bearer profile when `api_mode=chatgpt_oauth` |
| **No per-user OAuth-token rotation mechanism** | New cron + RPC | HIGH | `/api/cron/refresh-openai-oauth-tokens` + `acquire_user_token_lock` RPC. Postgres row-level lock to prevent the `refresh_token_reused` permanent-lockout failure (proven by Codex source) |
| **No token-version sync from DB → disk** | New reconciler step | HIGH | `stepChatGPTOAuthToken` modeled on `stepTelegramTokenVerify` per Rule 34. Compare `instaclaw_users.openai_token_version` to `instaclaw_vms.openai_token_version_synced`; rewrite on-disk file when stale |
| **No `openai/gpt-5.5` model in `stepEnforceModelPrimary`** | `lib/vm-reconcile.ts:3599` | HIGH | Function reads `vm.default_model` — just set it to `openai/gpt-5.5` when user is `chatgpt_oauth`; rest works |
| **`MODEL_COST_WEIGHTS` doesn't know GPT-5.x** | `lib/credit-constants.ts` | LOW (we don't charge credits on OpenAI calls) | Optionally add `gpt: 0` entries for telemetry, but daily limit is bypassed for chatgpt_oauth users anyway |
| **Proxy 866-1026 has no OpenAI provider branch** | `app/api/gateway/proxy/route.ts` | DEPENDS on architecture choice — see §4 | Either add Codex Responses API + WebSocket support (heavy) OR route OpenAI direct-from-VM (light) |
| **No new auth-profile type `oauth_bearer`** | OpenClaw runtime spec | DEPENDS | If OpenClaw 0.131.0 doesn't accept `type: "oauth_bearer"`, we use `type: "api_key"` with the access_token as the `key` value (works because the token IS a Bearer JWT) |
| **No Stripe price IDs for the new tier** | Vercel env | LOW | 3 new env vars: `STRIPE_PRICE_STARTER_CHATGPT`, `_PRO_CHATGPT`, `_POWER_CHATGPT` |
| **No onboarding UI for OAuth flow** | `app/(onboarding)/connect/page.tsx`, `app/(onboarding)/plan/page.tsx` | LOW | UI work — Add "Continue with ChatGPT" button + pricing tier display |
| **No device-code OAuth backend routes** | New `app/api/auth/openai/device-code/{start,poll}/route.ts` | MEDIUM | Standard OAuth device-code implementation. Phase 0 spike verified the OpenAI endpoints work from cloud IPs. |
| **No middleware allow-list entry** | `instaclaw/middleware.ts` `selfAuthAPIs` | LOW | Add `/api/auth/openai` (or per-route entries per Rule 13) |
| **Webhook handler doesn't recognize ChatGPT price IDs** | `app/api/billing/webhook/route.ts` | LOW | Extend `checkout.session.completed` handler to set `api_mode='chatgpt_oauth'` when ChatGPT price was purchased |

---

## 3. The 7 blocking decisions, in concrete-implementation context

Recap (from decisions doc §D): **Q3, Q7, Q17, Q18, Q19, Q20, Q22**. The first three apply to Phase 1; the last four apply to Phase 2. Here's what each means in code:

### Q3 — 5th token storage (Phase 1 BLOCKER)
**Concrete:** Migration `instaclaw/supabase/pending_migrations/20260519_chatgpt_oauth.sql` (PRD §4.4 verbatim — 10 new `instaclaw_users` columns + 1 new `instaclaw_vms` column + extended `api_mode` check constraint + new `instaclaw_oauth_device_flows` table). New `stepChatGPTOAuthToken` reconciler step modeled exactly on `stepTelegramTokenVerify` lib/vm-reconcile.ts. New refresh cron at `app/api/cron/refresh-openai-oauth-tokens/route.ts` running every 5 min with row-level Postgres lock (the `refresh_token_reused` failure mode is permanent per Codex source — locking is non-negotiable). Encryption helper: copy pattern from `lib/freeze-encryption.ts` (Rule 53) into new `lib/openai-oauth-encryption.ts` (or `lib/secret-encryption.ts` if we make it general).

**Recommendation:** APPROVE as-is. The PRD's design is correct and lines up with the existing 4-token-sync pattern. The only nuance: write the migration to `pending_migrations/` first per Rule 56 to avoid Rule-56-class build-pipeline outages.

### Q7 — Privacy defaults (Phase 2 BLOCKER)
**Phase 1 implication:** none directly. But the OAuth disclosure copy (Q2) needs legal sign-off, which gates the same legal review that gates the privacy disclosure work. **Brief legal on both in the same engagement.**

### Q17 — Restricted vault (Phase 2 BLOCKER)
**Phase 1 implication:** zero. Vault is for history-import extracted facts; Phase 1 doesn't extract anything. Defer the design work to Phase 2 kickoff.

### Q18 — Multi-user detection (Phase 2 BLOCKER) — defer
### Q19 — Output safety gate (Phase 2 BLOCKER) — defer
### Q20 — Subpoena posture (Phase 2 BLOCKER for legal sign-off) — bundle with Q2/Q7 legal review
### Q22 — Protected-identity inference (Phase 2 BLOCKER) — defer

**Net: only Q3 actually gates Phase 1 code.** The other 6 gate Phase 2.

---

## 4. Architecture decision — proxy-route-OpenAI vs direct-from-VM

This is THE design choice that determines Phase 1 complexity. Two options:

### Option A — Route OpenAI through our gateway proxy

User's agent sends inference call to `instaclaw.io/api/gateway` as today. The proxy:
- Detects `model` starts with `openai/` or similar
- Looks up user's `openai_oauth_access_token` from DB (per-call DB hit, or cache layer)
- Opens WebSocket to `wss://chatgpt.com/backend-api/codex/responses` with all the Codex-impersonation headers
- Streams response back to agent

**Pros:**
- Central observability of every OpenAI call
- Enables per-call fallback to Anthropic on 429 (the moat)
- Single chokepoint for credit accounting (we know to NOT debit credits for chatgpt_oauth calls)
- Token storage stays server-side; never written to VM disk → eliminates one of the 4-location-sync risks
- BYOK Anthropic users can also use ChatGPT — the proxy decides per-call

**Cons:**
- ~600-1000 lines of new proxy code (Codex Responses wire format conversion + WebSocket transport + Cloudflare-friendly headers + impersonate `originator: codex_cli_rs`)
- Higher latency (proxy hop adds 30-80ms)
- Phase 1 timeline extends by ~2 weeks
- Per-user DB lookup hit per call (cacheable, but new infrastructure)
- The Codex Responses wire format isn't well-documented publicly (we'd reverse-engineer from `@earendil-works/pi-ai` and `openai/codex`)

### Option B — Route OpenAI DIRECT from the VM, bypass our proxy

The VM's agent makes a direct `wss://chatgpt.com/backend-api/codex/responses` call from the VM's OpenSSL Node stack using the access_token stored in `auth-profiles.json`. **This is exactly what BYOK Anthropic users do today** — their agent calls `api.anthropic.com` directly with their own key, bypassing our proxy.

**Pros:**
- Zero changes to `app/api/gateway/proxy/route.ts`. Anthropic-only routing is bit-for-bit unchanged for the 246 existing all-inclusive users.
- Smallest possible blast radius — if ChatGPT integration breaks, it can't break Anthropic.
- ~75% less code to write.
- Latency: direct path = faster (no proxy hop).
- Architectural symmetry with BYOK Anthropic.

**Cons:**
- No per-call fallback in Phase 1 (the moat). The agent gets 429, surfaces it to user, user has to manually switch.
- No central observability of OpenAI calls (we can't see them — they don't touch our infra).
- Token must be on VM disk → 5th-token-location sync work (which we'd do anyway per Q3).
- If OpenClaw's runtime doesn't support the WebSocket + special headers natively, we'd need an OpenClaw-side patch (Cooper's call: contribute upstream or fork).

### Recommendation: **Option B for Phase 1**, plan Option A for Phase 1.5

Rationale:
- Cooper's stated goal: "both models need to work flawlessly with instaclaw without any issue. so users can come in, connect their gpt account and use chat gpt 5.5 mode with their instaclaw agent." This is achievable with Option B. The moat from Q4 (auto-fallback) is desirable but not the headline.
- Option B's smaller blast radius is the right risk posture for shipping into a fleet of 249 paying users. Anthropic-only stays unchanged byte-for-byte.
- Phase 1.5 (auto-fallback via proxy interception) becomes a clean follow-on: once the OAuth + storage + reconciler infrastructure is proven in production, add the proxy branch in isolation.
- Phase 0 spike already proved direct calls work from Linode us-east IPs with the right request shape — using the official Codex CLI on the VM is the simplest possible implementation.

**Cooper decision needed:** approve Option B for Phase 1 OR commit to the larger Option A scope (which extends Phase 1 to ~6 weeks).

### Implementation note for Option B — the OpenClaw runtime question

For Option B to work, OpenClaw on the VM must be able to:
1. Read an `auth-profiles.json` profile with `provider: "openai"` and a Bearer token
2. Make WebSocket calls to `chatgpt.com/backend-api/codex/responses` with the right headers (`originator: codex_cli_rs`, `User-Agent: codex_cli_rs/<version>`, `version`, `OpenAI-Beta: responses_websockets=2026-02-06`)
3. Speak the OpenAI Responses API wire format

**Phase 0 spike answers part of this** — it ran the official Codex CLI (the Rust binary) on the VM and it worked. But that's a SEPARATE binary; what we need is the **OpenClaw runtime** (the agent on every InstaClaw VM, currently version 2026.4.26) to do this. Their support depends on what OpenClaw 2026.4.26 ships.

**Spike question (Phase 0.5, 2 days):** On a fresh VM, install OpenClaw 2026.4.26, write a synthetic `auth-profiles.json` with the OAuth bearer profile and `agents.defaults.model.primary: "openai/gpt-5.5"`, send a test message via the OpenClaw CLI, observe the actual outbound network call. Three outcomes:

| Outcome | Phase 1 implication |
|---|---|
| OpenClaw natively supports → Bearer + WebSocket + headers all work | **Best case.** Just write the profile; ship. |
| OpenClaw supports the profile but uses wrong transport/headers | Wrap `@earendil-works/pi-ai` as an MCP server on the VM; agent calls via MCP, which proxies to OpenAI with correct shape. ~3-5 days of work. |
| OpenClaw doesn't support `provider: "openai"` for inference at all | Two paths: (a) contribute upstream — likely 2-4 weeks turnaround, (b) write a tiny VM-side sidecar that mimics Anthropic Messages API but translates to Codex Responses, then point `anthropic:default.baseUrl` at localhost for `chatgpt_oauth` users — ~1 week of work |

**If outcome (c)**, the Phase 1 timeline extends by 1-2 weeks. Mitigation: the spike happens in week 1 of Phase 1; the OAuth-storage + reconciler-step work proceeds in parallel and is unblocked regardless of outcome.

---

## 5. Phase 1 implementation plan — file by file

Assumes Option B above. ~4 weeks at one engineer.

### Week 1 — Foundation + spike

**Day 1-2: Phase 0.5 spike** (per §4 above). Verify OpenClaw runtime's behavior with an OpenAI-provider auth profile. Document outcome. Branch the plan accordingly.

**Day 2-5: Migration + auth/token infrastructure**

- `instaclaw/supabase/pending_migrations/20260519000000_chatgpt_oauth.sql` (Rule 56: write to `pending_migrations/` first)
  ```sql
  -- New columns on instaclaw_users (10 of them per PRD §4.4)
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS openai_oauth_access_token TEXT;
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS openai_oauth_refresh_token TEXT;
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS openai_oauth_id_token_claims JSONB;
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS openai_oauth_expires_at TIMESTAMPTZ;
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS openai_oauth_last_refresh_at TIMESTAMPTZ;
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS openai_oauth_account_id TEXT;
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS openai_oauth_originator TEXT;
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS openai_token_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS chatgpt_plan_type TEXT;
  ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS chatgpt_plan_last_seen_at TIMESTAMPTZ;
  -- New column on instaclaw_vms
  ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS openai_token_version_synced INTEGER NOT NULL DEFAULT 0;
  -- New api_mode value (verify current constraint shape first)
  ALTER TABLE instaclaw_users DROP CONSTRAINT IF EXISTS instaclaw_users_api_mode_check;
  ALTER TABLE instaclaw_users ADD CONSTRAINT instaclaw_users_api_mode_check
    CHECK (api_mode IN ('all_inclusive', 'byok', 'chatgpt_oauth'));
  -- New oauth device-flow table (PRD §4.4 verbatim)
  CREATE TABLE IF NOT EXISTS instaclaw_oauth_device_flows (...);
  -- RPC for per-user token-refresh locking
  CREATE OR REPLACE FUNCTION acquire_user_token_lock(user_id UUID, lock_timeout_ms INTEGER DEFAULT 30000)
    RETURNS BOOLEAN AS $$ ... $$;
  ```

- `lib/openai-oauth-encryption.ts` (NEW): AES-256-GCM with versioned key id, mirror `lib/freeze-encryption.ts` pattern. Env vars: `OPENAI_OAUTH_KEY_CURRENT=v1`, `OPENAI_OAUTH_KEY_V1=<64-hex>`. Cooper backs up the key offline (Rule 53 pattern).

- `lib/openai-oauth.ts` (NEW): OAuth flow primitives.
  - `startDeviceFlow(userId)` → POST to `https://auth.openai.com/api/accounts/deviceauth/usercode`, return `{user_code, device_auth_id, verification_uri, interval, expires_in}`, persist to `instaclaw_oauth_device_flows`
  - `pollDeviceFlow(deviceAuthId)` → POST to `https://auth.openai.com/api/accounts/deviceauth/token`, returns 403/404 while pending, 200 with `{authorization_code, code_challenge, code_verifier}` on success
  - `exchangeAuthCode(authorizationCode, codeVerifier)` → POST to `https://auth.openai.com/oauth/token`, returns `{id_token, access_token, refresh_token}`
  - `refreshToken(refreshToken)` → POST to `https://auth.openai.com/oauth/token` with `Content-Type: application/json` (NOT form-encoded — Codex source confirms)
  - `parseJwtClaims(jwt)` → decode + extract `chatgpt_plan_type`, `chatgpt_account_id`, `chatgpt_user_id`, `exp`
  - `classifyRefreshFailure(error)` → returns one of 5 modes (Expired / Exhausted / Revoked / AccountMismatch / Other) per Codex source

**Day 5: middleware allow-list + tests for the encryption helper**

### Week 2 — OAuth user-facing routes + reconciler integration

**Day 6-8: OAuth API routes**

- `app/api/auth/openai/device-code/start/route.ts` (NEW): POST, session-protected. Calls `startDeviceFlow(session.user.id)`. Returns `{user_code, device_auth_id, verification_uri}` to client. Must be in middleware `selfAuthAPIs` allow-list per Rule 13 (session-protected but bypass is needed because session auth flow context).
- `app/api/auth/openai/device-code/poll/route.ts` (NEW): POST. Polls. On completion, `acquireUserTokenLock(userId)`, then `exchangeAuthCode`, then `parseJwtClaims`, encrypt tokens, INSERT into `instaclaw_users` columns, bump `openai_token_version` to 1, set `api_mode='chatgpt_oauth'`, release lock. Returns `{status: "completed"}`.
- `app/api/auth/openai/refresh-now/route.ts` (NEW): VM-initiated forced refresh. Gateway-token auth (X-Gateway-Token). For mid-turn refresh when access_token is near expiry.
- `app/api/auth/openai/disconnect/route.ts` (NEW): DELETE. Session-protected. POST to `https://auth.openai.com/oauth/revoke` then clear DB columns. Switches `api_mode` back to `byok` or `all_inclusive`.

**Day 9-10: Reconciler step**

- `lib/vm-reconcile.ts` — new function `stepChatGPTOAuthToken` modeled on `stepTelegramTokenVerify`. Inserted in `reconcileVM` orchestrator after `stepFiles` and before `stepConfigSettings`. ~150 lines.
  - Only runs for `api_mode=chatgpt_oauth` users
  - Reads `vm.openai_token_version_synced`, compares to user's `openai_token_version`
  - If in sync, push to `alreadyCorrect`, return
  - If stale, decrypt the access/refresh tokens from DB, build the JSON shape, atomic-write to `~/.openclaw/agents/main/agent/openai-oauth.json` (mode 0600), verify-after-write (Rule 23 sentinel: file is valid JSON + contains `tokens.access_token`)
  - On success, bump `instaclaw_vms.openai_token_version_synced` to match user's version
  - Errors → `result.errors` → `pushFailed` → cv held (Rule 10)

### Week 3 — auth-profiles.json + model defaults + Stripe + UI

**Day 11-12: Extend buildAuthProfilesJson + stepAuthProfiles**

- `lib/ssh.ts:5027-5055` `buildAuthProfilesJson` — extend signature to accept optional `openaiOAuthBearer?: {accessToken: string, bearerTokenPath?: string}`. When present, emit a 3rd profile entry. Update `cloud-init-tarball.ts` to pass the same value (byte-identical output discipline).
- `lib/vm-reconcile.ts:4265-4366` `stepAuthProfiles` — **FIX THE LATENT BUG**: when rebuilding, preserve the existing `openai:default` profile (read it, merge in). Then ALSO verify the `openai:default` (for OAuth) when `api_mode=chatgpt_oauth`.
- `lib/ssh.ts:configureOpenClaw` — on initial setup, if user is `chatgpt_oauth`, look up their token from DB and pass to `buildAuthProfilesJson`.

**Day 13: Extend stepEnforceModelPrimary**

- `lib/vm-reconcile.ts:3599` `stepEnforceModelPrimary` — read `vm.default_model` (already does). For `chatgpt_oauth` users, the value will be `openai/gpt-5.5` (set at provision time from the user's plan).
- `app/api/vm/configure/route.ts` (or wherever configure routes set `default_model`) — when api_mode is chatgpt_oauth, query `https://chatgpt.com/backend-api/codex/models` with user's bearer token to get available models for their plan; pick the highest tier (probably `gpt-5.5`); set `instaclaw_users.default_model` (or `instaclaw_vms.default_model` — need to verify which is SoT). Fallback to `gpt-5.5` if probe fails.

**Day 14: Stripe + webhook**

- Vercel env vars: `STRIPE_PRICE_STARTER_CHATGPT`, `_PRO_CHATGPT`, `_POWER_CHATGPT`. (Rule 6: use `printf` not `<<<`.)
- `lib/stripe.ts` — extend `TIER_DISPLAY` with ChatGPT-mode prices. Default proposals per decisions doc Q6: $19/$49/$149 (subject to Cooper's broader pricing review).
- `app/api/billing/webhook/route.ts` — `checkout.session.completed` extended: if the price ID matches `STRIPE_PRICE_*_CHATGPT`, set the user's `api_mode='chatgpt_oauth'` AND check the user already has an OAuth grant before completing checkout. If they don't, redirect them to the OAuth flow as a "complete your signup" step.

**Day 15: UI**

- `app/(onboarding)/connect/page.tsx` — add "Continue with ChatGPT" button next to existing Google sign-in (or treat as a follow-on after Google: Google for InstaClaw identity, ChatGPT for inference auth).
- `app/(onboarding)/plan/page.tsx` — show three tiers x three modes (all-inclusive / BYOK / ChatGPT) in a comparison table. Highlight ChatGPT mode as new.
- `app/(onboarding)/oauth-chatgpt/page.tsx` (NEW) — device-code flow UI. Shows the URL + code prominently, opens popup, polls.
- `app/(dashboard)/settings/integrations/page.tsx` (NEW or extend existing) — show connected ChatGPT account, plan type, last refresh, disconnect button.

### Week 4 — Token-refresh cron + testing + rollout discipline

**Day 16-17: Refresh cron**

- `app/api/cron/refresh-openai-oauth-tokens/route.ts` (NEW). Every 5 min. Query users where `openai_oauth_expires_at < NOW() + 30 minutes`. For each (batch 50): `acquire_user_token_lock(userId)`, refresh via `lib/openai-oauth.ts:refreshToken`, on success encrypt new tokens, write to DB, bump `openai_token_version`, release lock. On failure: classify per the 5 named modes, surface to user via Telegram message, possibly set `api_mode` back to fallback. **Per Rule 11: `export const maxDuration = 300`**.
- `vercel.json` or vercel-cron config — schedule the cron.

**Day 18-19: Tests + telemetry**

- **Synthetic test 1: Anthropic-only fleet unchanged.** Test that a synthetic `all_inclusive` user with no ChatGPT OAuth goes through the proxy exactly as today. Mock the entire request lifecycle; assert no new code paths fire.
- **Synthetic test 2: ChatGPT OAuth round-trip.** Mock the device-flow endpoints. Verify token-storage, encryption, DB persistence.
- **Synthetic test 3: stepAuthProfiles preserves openai:default.** Construct a VM with `auth-profiles.json` containing both anthropic + openai profiles. Run the reconciler step. Verify both profiles survive.
- **Synthetic test 4: Concurrent refresh = no `refresh_token_reused`.** Spawn 5 concurrent refresh attempts for the same user. Verify exactly one succeeds and the others wait for the lock. Verify no double-refresh against OpenAI.
- **Real test: one canary VM, one canary user.** Provision a real VM under Cooper's test account, set api_mode='chatgpt_oauth', complete the OAuth flow, send 10 test messages via Telegram, verify all hit OpenAI (not Anthropic) successfully, verify no other VMs in the fleet are affected.
- **Telemetry:** new logger events `OPENAI_OAUTH_FLOW_STARTED`, `OPENAI_OAUTH_FLOW_COMPLETED`, `OPENAI_OAUTH_REFRESH_SUCCESS`, `OPENAI_OAUTH_REFRESH_FAILED:{reason}`, `OPENAI_INFERENCE_CALL` (from VM-side if possible). Coverage queries per Rule 27.

**Day 20: Manifest bump + fleet rollout discipline**

- Bump `VM_MANIFEST.version` so existing-cv-current VMs re-enter the reconcile queue and pick up the `stepAuthProfiles` fix
- Per CLAUDE.md OpenClaw Upgrade Playbook: ship to vm-050 canary first; run 3 chat completions over 5 minutes; verify journal clean; hold 1 hour
- Per CLAUDE.md Rule 56: migration file moves from `pending_migrations/` to `migrations/` only after applying to prod
- Per CLAUDE.md Rule 47: the `buildAuthProfilesJson` change reaches caught-up VMs via the manifest bump

---

## 6. Integration risks + mitigations

### Risk 1: `stepAuthProfiles` rebuild wipes existing openai:default profile (already-latent bug; we trip it)

**Today:** When `stepAuthProfiles` detects a broken `anthropic:default` (e.g., baseUrl drift), it rewrites the WHOLE `auth-profiles.json` with only the `anthropic:default` profile (lib/vm-reconcile.ts:4342-4356). The existing `openai:default` (for embeddings) gets clobbered. This is latent today — the embeddings still work because the OpenClaw runtime might cache the key, OR because the embedding code re-reads from `OPENAI_API_KEY` env var, OR (most likely) because `stepAuthProfiles` rarely fires the rebuild path. But it's a real bug.

**Impact for us:** Our new OAuth profile would ALSO get wiped if we don't fix this. And if a VM is on `api_mode=chatgpt_oauth` and `stepAuthProfiles` rebuilds, the user's agent suddenly can't reach OpenAI.

**Mitigation:** In the same PR that adds OAuth support, FIX the rebuild logic in `stepAuthProfiles` to read existing profiles + preserve any non-anthropic ones + merge. **Required**. Ship a synthetic test for this specifically.

### Risk 2: `default_model` mismatch when OpenClaw checks against an "unknown" model name

**Today:** `stepEnforceModelPrimary` pushes the value from `vm.default_model`. If we set it to `openai/gpt-5.5` and OpenClaw doesn't recognize that model name, it might fall back to its built-in default `openai/gpt-5.4` (which incurred a $500/month bill in April 2026 per vm-reconcile.ts:548).

**Mitigation:** The Phase 0.5 spike (week 1, day 1-2) verifies OpenClaw's behavior with `openai/gpt-5.5`. If OpenClaw rejects the model name, we either (a) probe the user's account for the actual available models via `GET /backend-api/codex/models` and pin the lowest-named one, or (b) use a model name OpenClaw definitely accepts (e.g., `openai/gpt-5.4` if that's the supported default). The DB column `vm.default_model` is the SoT; we control what gets pushed.

### Risk 3: A `chatgpt_oauth` user's agent calls our gateway proxy and gets 403'd

**Today:** Proxy at lines 312-316 returns 403 for any `api_mode !== "all_inclusive"`. A user on `chatgpt_oauth` whose agent for some reason calls our proxy (heartbeat? embeddings? misconfigured fallback?) gets blocked.

**Mitigation:** Extend the gate to allow `chatgpt_oauth` users through for specific endpoints — they still need the proxy for `MiniMax` heartbeats (per Q4 — heartbeats stay on our key). Concretely: change line 312 to `if (vm.api_mode === "byok") return 403`. For chatgpt_oauth users, the proxy still does its work for Anthropic-routed calls (e.g., if they manually switch with `/use sonnet`, the request comes through with `model=claude-sonnet-4-6` and the proxy routes to Anthropic with our key — same path as all_inclusive). Heartbeats also route through normally (forced to MiniMax).

**Important interaction with credits:** If a chatgpt_oauth user manually routes a call to Anthropic via the proxy, do we charge their credits? **Yes for Phase 1.** It's an explicit user override using our infrastructure. Once Phase 1.5 ships auto-fallback, that's where we'd add per-call cost-eating logic.

### Risk 4: Token refresh fails for an entire cohort of users simultaneously

If OpenAI rotates their JWT signing key, or changes the refresh endpoint, every user's token refresh fails at once. Our cron at 5-min intervals would hit hundreds of failures in a single tick.

**Mitigation:** The cron has an alerting threshold: if >5% of users in a single batch refresh fail with the SAME `error.code`, fire a P0 admin alert. Don't disconnect any users automatically — wait for human review (could be an OpenAI API hiccup, not a real breakage).

### Risk 5: `refresh_token_reused` permanent lockout from concurrent refresh

**Documented in Codex source** (`codex-rs/login/src/auth/manager.rs:864`). If two processes refresh the same user's token simultaneously, one gets a valid new pair, the other gets `error.code = "refresh_token_reused"` permanently. The user is locked out.

**Mitigation:** Postgres row-level lock via `acquire_user_token_lock` RPC (`SELECT ... FOR UPDATE` with timeout). All token refresh code paths MUST acquire the lock first. Synthetic test in week 4 verifies this works.

### Risk 6: OpenClaw runtime doesn't support the OAuth-bearer profile shape

Per §4's spike. If outcome is (c) — runtime can't handle it — we need either an upstream OpenClaw patch (slow) or a VM-side translation sidecar (~1 week).

**Mitigation:** Spike answers in week 1. If (c), we have ~3 weeks of remaining buffer to build the sidecar before Phase 1 end-date.

### Risk 7: Stripe webhook race between price-purchase and OAuth completion

User buys ChatGPT-mode subscription → webhook fires `checkout.session.completed` → we set `api_mode='chatgpt_oauth'`. But the user hasn't completed the OAuth flow yet. Their agent gets provisioned with `chatgpt_oauth` mode but no token → reconciler errors on missing token → cv held → agent never reaches healthy.

**Mitigation:** Onboarding flow REQUIRES OAuth completion BEFORE checkout. Order: Google sign-in → ChatGPT OAuth → plan selection → Stripe checkout. If the user abandons after Stripe checkout, the webhook records sub but `instaclaw_users.openai_oauth_access_token IS NULL` — the configure route should detect this and either (a) email the user "complete your ChatGPT connection," (b) refund and switch them to all_inclusive, OR (c) hold the VM in `pending_oauth` state.

### Risk 8: Real-money rollback during incident — how to disable ChatGPT cleanly

If post-launch we discover the integration is broken, we need a kill switch.

**Mitigation:** Environment variable `OPENAI_OAUTH_ENABLED=false` checked at the start of EVERY code path that touches OpenAI OAuth:
- Reconciler step `stepChatGPTOAuthToken` short-circuits → returns
- OAuth API routes return 503 "Temporarily disabled"
- Webhook never sets `api_mode='chatgpt_oauth'` (signups to that tier fail cleanly with a "please use all_inclusive instead" message)
- Refresh cron skips all users

Flip the env var → next reconcile tick (~3 min) → all VMs stop getting token rewrites → existing chatgpt_oauth users keep working on their current token until it expires (~10 days), at which point they fall back to... we need to define this. Likely: switch them to `api_mode='all_inclusive'` automatically when refresh fails AND the kill switch is on. Effectively a 10-day soft-degradation path.

### Risk 9: Anthropic-only routing regression

The biggest fear: changes break the 246 existing all-inclusive users.

**Mitigation matrix:**
- Synthetic test 1 ("Anthropic-only fleet unchanged") is mandatory in CI
- `lib/vm-reconcile.ts:stepAuthProfiles` change is small and targeted; covered by synthetic test 3
- No changes to `app/api/gateway/proxy/route.ts` provider routing (lines 866-1026) — Anthropic path bit-for-bit unchanged
- No changes to credit accounting RPC
- No changes to `stepEnforceModelPrimary` for non-chatgpt_oauth users
- Manifest bump rollout discipline per OpenClaw Upgrade Playbook: vm-050 canary first, 1 hour soak, then 3 paying-user VMs, then waves of 10

---

## 7. Testing strategy

### 7.1 Pre-merge synthetic tests (CI gates)

| Test | What it verifies |
|---|---|
| `test_encryption_helper_roundtrip` | AES-256-GCM encrypt/decrypt with versioned key id works; tamper detection works |
| `test_oauth_device_flow_polling` | Mock OpenAI; verify start → poll-pending → poll-completed lifecycle |
| `test_oauth_refresh_concurrency` | 5 concurrent refresh attempts → exactly 1 OpenAI call; others wait for lock |
| `test_oauth_refresh_failure_classification` | Each of 5 failure modes routes to the correct internal classification |
| `test_jwt_claim_extraction` | Decodes Cooper's spike-captured JWT; extracts `chatgpt_plan_type=plus` etc. |
| `test_build_auth_profiles_chatgpt_mode` | With OAuth bearer arg, emits 3-profile shape; without, emits 2-profile shape (backward compat) |
| `test_step_auth_profiles_preserves_openai` | Start with both profiles on disk; trigger rebuild; both profiles survive |
| `test_step_auth_profiles_anthropic_only_unchanged` | All-inclusive VM with no OAuth: rebuild matches today's byte-for-byte output |
| `test_step_chatgpt_oauth_token_sync` | DB version 5, disk version 3 → rewrite; DB version 5, disk version 5 → no-op |
| `test_proxy_chatgpt_oauth_user_routes_anthropic_call` | chatgpt_oauth user manually calling Sonnet through proxy: routes to Anthropic, charges credits |
| `test_proxy_chatgpt_oauth_user_heartbeat_routes_minimax` | chatgpt_oauth user heartbeat: routes to MiniMax, doesn't burn user's quota |
| `test_proxy_byok_still_403` | BYOK user calling proxy: still 403 |
| `test_kill_switch_disables_cleanly` | Set `OPENAI_OAUTH_ENABLED=false`; verify all code paths short-circuit |

### 7.2 Canary VM testing

- **Cooper's vm-050 (already on cv=105)** — keep it on `all_inclusive` for now. Use a NEW VM for the canary.
- Provision a fresh `g6-dedicated-2` (NOT from ready pool — manual provision per CLAUDE.md Rule 8 with cron pause). Assign to a test user.
- Set api_mode='chatgpt_oauth'. Run OAuth flow. Verify token lands in DB. Verify reconciler writes to disk. Verify `openclaw config get agents.defaults.model.primary` returns `openai/gpt-5.5`.
- Send 10 messages via Telegram. Verify they reach gpt-5.5. Verify usage shows up in OpenAI's ChatGPT account (Cooper's plan dashboard).
- Test slash command `/use sonnet`: verify the message routes through our proxy → Anthropic. Verify credits are charged.
- Test heartbeats: verify they continue to route to MiniMax (not OpenAI).
- Wait 24h. Verify token refresh fires on schedule (10-day TTL means we won't see refresh in 24h — instead, manually trigger via `/api/auth/openai/refresh-now`).
- Verify Anthropic-only VMs (sample 5) are unchanged: cv didn't bump, auth-profiles.json still has byte-identical anthropic:default + openai:default.

### 7.3 Production rollout

- Week 4 Day 19: synthetic tests + canary VM all green
- Week 4 Day 20: invite 5 friendly users to opt into ChatGPT-mode. Real OAuth. Real billing. Monitor for 48h.
- Week 5 Day 21+: open to general signups. Monitor for 1 week.
- Week 6+: announce on Twitter (per decisions doc Q12).

### 7.4 Post-rollout monitoring

- Cron coverage query (Rule 27): `scripts/_coverage-chatgpt-oauth.ts` — for every user with `api_mode='chatgpt_oauth'`, verify (a) DB has tokens, (b) disk has tokens (SSH probe), (c) `openclaw config get agents.defaults.model.primary` returns `openai/*`. Alert on miss.
- Refresh failure rate alert: if >2% of refresh attempts fail in a 1h window, P1 alert.
- Anthropic-only regression alert: weekly sample 10 all_inclusive VMs, confirm cv-current + auth-profiles.json unchanged + sample inference call hits Anthropic with our key.

---

## 8. Rollback plan

### Granular rollbacks

**OAuth flow breaks (users can't connect):** Disable the OAuth API routes (return 503). Users in flight get an error and can retry. Existing chatgpt_oauth users keep working until their token expires.

**Refresh cron breaks (tokens stop refreshing):** Disable the cron (Vercel cron toggle). Tokens expire in ~10 days. Existing users have a 10-day window for us to fix. After expiry, their agent gets an OpenAI 401 → we'd want a fallback path (see kill switch).

**Reconciler step breaks (cv held):** Most likely failure shape. The step is in `result.errors` → cv held → user's VM can't get OTHER reconciler fixes either. Detection: any chatgpt_oauth VM with cv stuck > 1 hour. Recovery: temporarily filter out chatgpt_oauth from the reconciler's candidate query, fix the bug, re-enable.

**stepAuthProfiles regression breaks an all-inclusive VM:** Highest-risk regression. Mitigation: synthetic test 8 covers this. If it ships broken, revert the manifest bump immediately. The bad change reaches caught-up VMs only via Rule 47 — if we don't bump manifest, only newly-provisioned VMs see it (smaller blast radius).

### Full feature kill switch

Set `OPENAI_OAUTH_ENABLED=false` in Vercel env (use `printf` per Rule 6). Within ~3 min:
- Reconciler step short-circuits
- OAuth routes 503
- Webhook ignores ChatGPT price IDs
- Refresh cron skips

Within ~10 days (token expiry): existing chatgpt_oauth users hit 401 → their `openai-oauth.json` is stale → either we ship a one-off VM fix that switches their `auth-profiles.json` back to anthropic:default-only and sets their DB `api_mode='all_inclusive'` (graceful downgrade), OR we leave them broken and surface "ChatGPT integration is temporarily disabled, please contact support."

Recommended: build the graceful-downgrade path BEFORE launching — it's a one-time cron run, and having the option means we can flip the kill switch without panicking.

### Migration rollback

Pre-launch: migration in `pending_migrations/` (Rule 56). Reverting is `git revert`.

Post-launch: migration in `migrations/`. Reverting would orphan data. The columns being `NULLABLE` means they can stay in place if we disable the feature — no destructive rollback needed.

---

## 9. Open questions for Cooper before engineering starts

These map directly to the decisions doc but include the new context from the codebase audit.

| # | Question | Recommended | Blocking |
|---|---|---|---|
| A | **Option A (proxy routes OpenAI) vs Option B (direct from VM)?** | **Option B for Phase 1; Option A for Phase 1.5** for the per-call fallback moat | YES |
| B | **Run the Phase 0.5 OpenClaw-runtime spike before committing to Phase 1?** | YES — 2 days, answers whether outcome (a)/(b)/(c) | YES |
| C | **Migration path: write to `pending_migrations/` first per Rule 56?** | YES — non-negotiable per the 2026-05-16 incident | YES |
| D | **Defer history import + restricted vault + multi-user detection to Phase 2?** | YES — Phase 1 = OAuth-only; Phase 2 = history. Keeps Phase 1 to 4 weeks | YES |
| E | **Defer per-call fallback (Q4 "the moat") to Phase 1.5?** | YES — ship Phase 1 without it; users can `/use sonnet` manually; auto-fallback is 1-2 weeks of additional work that requires proxy-side OpenAI routing (Option A) | YES |
| F | **Synthetic-test-driven CI before any prod deploy?** | YES — 13 synthetic tests in §7.1 are mandatory | NO (process) |
| G | **Approve the 7 blocking decisions from the decisions doc?** Particularly Q3 (token storage) which gates the migration | YES with the file-by-file scope above | YES |
| H | **Approve the latent-bug fix in `stepAuthProfiles` (preserve openai:default)?** | YES — has to ship with this work; it's a real bug that would otherwise corrupt VMs | YES |
| I | **Confirm the model-name choice for ChatGPT users (`openai/gpt-5.5` or probe-per-user)?** | Probe at provision time via `GET /backend-api/codex/models`; pin per-user in DB. Re-probe on plan-tier change. | NO |
| J | **Approve the kill switch design** (`OPENAI_OAUTH_ENABLED` env var, graceful-downgrade cron)? | YES | NO |

---

## 10. Phase 1.5 preview (not in scope for this doc)

Auto-fallback ("the moat") via proxy-side OpenAI routing. Requirements:
- Proxy at `app/api/gateway/proxy/route.ts` learns to route OpenAI calls
- New code: OpenAI Responses API wire-format adapter (Anthropic Messages ⇄ OpenAI Responses), WebSocket transport with Codex-impersonation headers
- Per-user token lookup from DB (with caching; ~3min TTL since tokens last 10 days)
- 429 detection → automatic retry on Anthropic with our key → debit user's monthly fallback cap (Q5)
- ~1-2 additional engineer-weeks

Ship Phase 1.5 once Phase 1 has been in production for 2+ weeks and we have real signal on:
- OpenAI 429 rates for our users
- Manual switch frequency (`/use sonnet` usage)
- Edge cases in token expiry handling

---

## End of plan

**Engineering does NOT start until Cooper signs off on §9 (especially A, B, C, D, E, G, H).** Most likely conversation: Cooper picks Option B for Phase 1, defers fallback to 1.5, approves the migration discipline, approves the latent-bug fix. That gives engineering a clean 4-week scope to start on after Edge Esmeralda (May 30) closes.

The Phase 0 spike (May 18) verified OAuth + inference work from Linode us-east. This Phase 1 plan turns that verified architecture into a production-ready integration that protects the 246 existing Anthropic-only users from any risk while opening a clean path for ChatGPT-mode users to onboard.
