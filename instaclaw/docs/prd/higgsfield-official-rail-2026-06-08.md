# PRD — Higgsfield Official Rail (Cinematic Video for Every InstaClaw Agent)

**Date:** 2026-06-08
**Branch / worktree:** `higgsfield-official-rail`
**Author:** higgsfield-skill terminal (Claude)
**Status:** 🔍 PROPOSAL / PLANNING — research complete, architecture recommended, **no code written, no skill edits.** This is the artifact a build terminal picks up after Cooper selects the path + closes the commercial asks in §11.

> **One-line thesis:** Move InstaClaw video generation off the current Muapi/Sjinn back ends onto Higgsfield's **official `/agents` API**, kept behind our existing **centralized gateway proxy** (one platform credential, per-VM `GATEWAY_TOKEN` auth, central metering) so the fleet never changes — then ship a unified **video-credit** model with **estimate-then-charge** and a dedicated **Studio** surface, and make the ownable viral claim *"Text your agent. Get cinematic video back. It even tells you if it'll go viral."*

---

## ⏱ Pass-2 verification & hardening changelog (2026-06-08)

A second pass re-read every primary source and the real code (not first-pass notes). What it caught — all folded into the sections below, full detail in **§13**:

- **Corrected:** "literally swap the upstream / fleet+UX+billing invariant" was too soft. **Verified-invariant = the fleet auth+transport pattern** (`GATEWAY_TOKEN` → `instaclaw.io` proxy; `INSTACLAW_MUAPI_PROXY=https://instaclaw.io` is reliably written by `configureOpenClaw`, lib/ssh.ts ~6325). **The Higgsfield proxy + skill are real builds** (action-based like the Sjinn proxy, *not* the Muapi path-passthrough), and **billing is improved, not preserved.** (refines §1, §4.1, §6.1)
- **Corrected:** cost is **deterministic** (binary `credits` + `credits_exact`), so "settle actual vs estimate" was over-engineered → model is **charge-estimate-on-success, refund-on-failure** (§7.2, §13.2).
- **Found a real current bug:** the Muapi proxy pre-checks affordability at a **weight-1 baseline** (`instaclaw_check_limit_only(p_model:"haiku")`) but charges the true 80–250 weight after success → an underfunded user **overdraws**. New design enforces full job cost **in the proxy before submit** (§13.1, fixes §0.8).
- **Added failure modes** the happy-path PRD missed: **content-policy rejection** (`rejected/Prohibited/nsfw`), failed/timeout/partial jobs, concurrency overselling, and the **Telegram 50MB delivery cap with no link fallback today** (§13.2).
- **Added abuse/blast-radius hardening:** platform-credit-floor read + a **video spend kill-switch** mirroring the proven frontier kill-switch; confirmed video gen is **never autonomous** (heartbeat isolated) (§13.3).
- **Added migration edge cases:** existing-user credit backfill, in-flight Muapi jobs at cutover, one-flag rollback, nav coordination with the in-flight sidebar restructure (§13.4).
- **Tightened scope/limits:** video **≤15s and ≤1080p** (4K is image-only) (§5, App. C, §13.1).
- **New §11 asks:** does Higgsfield charge us for failed/rejected jobs? per-account rate limits across the fleet? platform workspace.

## ⏱ Pass-3 — the no-wait build path (2026-06-08)

A dedicated hunt for a server-side credential **found one**, on a rail pass-2 hadn't separated out. Full detail in **§14**; headline:

- **A self-serve server-side API key exists** — the **Higgsfield Cloud API** (`platform.higgsfield.ai`, official Node/Python SDKs, `Authorization: Key KEY_ID:KEY_SECRET`, pay-per-use, server-side only, webhooks). Keys mint self-serve at `cloud.higgsfield.ai/api-keys`. **No partner deal, no fleet OAuth, no human seat to start.** Pass-2's "OAuth-only" was correct *only for the consumer agent CLI* — the Cloud API is a distinct product.
- **Two official rails, now disambiguated:** (1) **Cloud API** = the build-and-try + production fleet rail; (2) **Agent rail** (`fnf.higgsfield.ai/agents`, OAuth, consumer credits, the six agent tools incl. Virality Predictor) = the BYO-account (Arch 4) tier.
- **It auto-answers R9:** Cloud lifecycle is `queued→in_progress→{completed|failed|nsfw|cancelled}` and **`failed`/`nsfw` refund credits** — provider eats failed jobs.
- **Canary = one image→video through our proxy on one Cloud key, delivered to Telegram** (§14.5). Self-serve, today, no Higgsfield dependency.
- **Only thing that still needs Higgsfield (email in parallel, does NOT block the canary):** whether one key may fund the whole fleet under ToS + fleet-scale rate limits/volume pricing (§14.6).

---

## 0. Locked findings the plan is built on (all doc/binary/code-verified)

These are not assumptions. Each is cited in the appendices.

1. **The official Higgsfield CLI is a thin Go HTTP client** over `https://fnf.higgsfield.ai/agents/*`. The npm package `@higgsfield/cli` is a wrapper that downloads a per-platform Go binary (`hf_<ver>_<os>_<arch>.tar.gz`). All logic lives in the binary. (App. A)
2. **Auth is OAuth-only. There is no API-key env var in the public CLI.** The binary reads `HIGGSFIELD_API_URL`, `HIGGSFIELD_DEVICE_AUTH_URL`, `HIGGSFIELD_APP_URL`, `HIGGSFIELD_CREDENTIALS_PATH` — but **no `HIGGSFIELD_API_KEY`**. (App. A)
3. **Auth = OAuth device-code flow with refresh tokens.** Binary contains `json:"device_code"`, `json:"refresh_token"`, `json:"verification_uri"`, `json:"expires_in"`, `json:"interval"`, strings `"Start browser-based device login"`, `"Refresh failed (HTTP %d)"`, `"Failed to build refresh request"`. Credentials persist to `credentials.json` (atomic write + lock) under `$XDG_CONFIG_HOME/higgsfield/` (overridable via `HIGGSFIELD_CREDENTIALS_PATH`). → **A one-time device login yields a durably auto-refreshing credential.** (App. A, App. B)
4. **`device_code` flow is explicitly the path for OpenClaw.** OAuth metadata `higgsfield_auth_hints` lists `potential_clients: ["openclaw","hermes","memoclaw"]` for `device_code`, vs `["anthropic","claude","claude-code"]` for `authorization_code_pkce`. Scopes: `openid email offline_access` (`offline_access` ⇒ refresh tokens). Device authz server: `https://fnf-device-auth.higgsfield.ai`. (App. B)
5. **`generate cost <model>` previews a job's exact cost without creating it.** Binary string: `"preview cost without creating a job"`; endpoint `/agents/jobs/cost`. → **This is the keystone for credit gating** (estimate-then-charge). (App. A, App. C)
6. **35 models (18 image / 17 video), full param schema is machine-readable** via `higgsfield model list` / `model get`, mirrored in repo `MODELS.md`. Video models top out at **1080p** in the CLI schema; **4K is image-side** (Nano Banana Pro, GPT Image 2, Marketing Studio, Cinematic Studio) — the marketing "up to 4K, any duration" is true for images, not for current video models. (App. C)
7. **Our current "higgsfield-video" skill does NOT talk to Higgsfield.** It routes through **Muapi** (`https://api.muapi.ai`, server-side `MUAPI_API_KEY`) via `instaclaw.io/api/gateway/muapi`, authed by each VM's `GATEWAY_TOKEN`. A sibling **`sjinn-video`** skill ("The Director") routes through `sjinn.ai` via `instaclaw.io/api/gateway/sjinn` (server-side `SJINN_API_KEY`). Both use the **centralized-proxy + per-VM gateway-token** pattern. **No per-VM OAuth exists today.** (App. D)
8. **We already run two *different* billing models for video** — a code-level inconsistency the migration should resolve:
   - **Sjinn path**: count-based daily caps (`instaclaw_check_video_limit`: Starter 5 video/day, Pro 10, Power 30; +image/audio caps). Hitting the cap → 429 → "buy a media pack."
   - **Muapi `higgsfield-video` path**: credit-**weight** model (SKILL.md table: short video 80, long 150, i2v 100–180…) checked against a credit balance.
   - **And a real overdraft bug in that path** (pass-2): the proxy authorizes on a **weight-1 baseline** (`instaclaw_check_limit_only(p_model:"haiku")`, muapi route ~159) but increments the true weight after success → an underfunded user can submit an 80–250-credit job and go negative. The official rail fixes this by enforcing full job cost in the proxy *before* submit (§13.1).
   (App. D, App. E)
9. **The Stripe media-credit reload path is proven and idempotent.** `/api/billing/credit-pack` → checkout w/ metadata `{type:credit_pack, vm_id, credits, target:"media"}` → webhook `handleCreditPackPurchase` (synchronous, `instaclaw_credit_purchases` UNIQUE on payment_intent) → `instaclaw_add_credits` → `instaclaw_vms.credit_balance` + `instaclaw_credit_ledger`. Media packs today: `media_500` $4.99, `media_1200` $9.99, `media_3000` $19.99; "never expire, stack on daily allowance." (App. E)

---

## 1. Executive summary & recommendation

**Recommended architecture: "Official backend behind our centralized proxy" (Arch 1), with "Bring-Your-Own Higgsfield account" (Arch 4) as a later opt-in power tier.**

The single most important realization from the research: **our current architecture is the *right* architecture for a fleet** — one server-side credential, per-VM gateway-token auth, central metering/abuse-control/billing. The thing that's "unofficial" is only the *backend* (Muapi/Sjinn). So the clean move is **not** to bolt OAuth onto 164 VMs. It is to **swap the proxy's upstream to Higgsfield's official `/agents` API** and keep everything else.

The second realization de-risks the one commercial unknown: **the proxy absorbs whichever credential model Higgsfield grants us.** If they give a partner/enterprise **API key**, the proxy uses it directly (cleanest). If they only offer **OAuth**, the proxy holds *one* platform refresh token and refreshes server-side (one place, no fan-out race). **Either way the fleet's auth+transport pattern is invariant** (verified: every VM already talks to `instaclaw.io/api/gateway/*` with its `GATEWAY_TOKEN`). The proxy and the on-VM skill are *real builds* (action-based, mirroring the Sjinn proxy — not a one-line upstream flip), and billing is *unified and fixed*, not merely preserved (§13.1). We can therefore design and build the fleet/UX/billing layers before the commercial terms are finalized.

**Why not put the official CLI + OAuth on each VM (Arch 2):** sharing one account's refresh token across 164 machines is very likely fatal — OAuth servers commonly **rotate** the refresh token on every use and invalidate the prior one. 164 VMs racing to refresh would invalidate each other into a mass-auth-failure loop. This is precisely the "onboarding nightmare" intuition, and it's a real, named disqualifier (§4.3).

**Scope we turn on first (the ownable slice):** text→video, image→video, a cheap image on-ramp (text→image), and **Virality Predictor**. Hold Soul-ID (character) for tier 2 and the Marketing-Studio "ad engine / brand builder" for a later B2B tier — those are *Higgsfield's* agency pitch, not ours. Our claim is the consumer-magic one (§5).

**Billing:** unify the two existing video-billing models onto **one weight-based "video credits" currency**, priced off Higgsfield's live `generate cost` with a margin multiplier, gated by **estimate-then-charge** (quote → hold → settle → refund-on-fail). Extend the existing Stripe credit-pack reload mechanic with video packs. **Yes, video gets its own dashboard surface** — a `/dashboard/studio` page (balance + reload + live job queue + a **gallery** of past renders), because video's mental model (per-render cost, async jobs, a library of outputs) is fundamentally unlike "messages per day" (§7).

**The viral feature shape:** the whole loop in chat with zero app-switching — brief → generate → playable video delivered in Telegram → "score its virality" — plus a shareable render page with a soft "made by my InstaClaw agent" footer as a built-in growth loop (§8).

---

## 2. What we have today (and why it needs replacing)

### 2.1 Two video skills, two back ends, two billing models

| | `higgsfield-video` (misnamed) | `sjinn-video` ("The Director") |
|---|---|---|
| Backend | **Muapi** `api.muapi.ai` | **Sjinn** `sjinn.ai` |
| Proxy | `instaclaw.io/api/gateway/muapi` | `instaclaw.io/api/gateway/sjinn` |
| Server credential | `MUAPI_API_KEY` | `SJINN_API_KEY` |
| VM auth | `GATEWAY_TOKEN` (per-VM) | `GATEWAY_TOKEN` (per-VM) |
| Billing | credit-**weight** (80–250/job) | **count**-based daily caps |
| Models | Kling/Wan/Sora/Veo/Seedance via Muapi naming | Seedance 2.0 / Veo3 / Sora2 |

This is genuinely confusing for users and for us: two "make a video" skills, two cost models, overlapping models. The official migration is the moment to **collapse to one rail, one billing model, one vocabulary.**

### 2.2 The good part we must preserve

The **centralized-proxy + per-VM-gateway-token** pattern (see `app/api/gateway/sjinn/route.ts`) is exactly right for a fleet:
- One server-side credential; VMs never hold provider secrets.
- Per-VM auth via the `GATEWAY_TOKEN` already provisioned at VM creation.
- Central limit-check → forward → meter, with provider billing errors *never* exposed to users (e.g. Sjinn code 100/101 → generic "at capacity").
- Async submit/poll with response normalization (`data.video_url` always present).

**The migration keeps this pattern verbatim and only changes the upstream.**

### 2.3 What "unofficial" actually means here

Cooper's framing was "Open-Higgsfield / unofficial setup." Precisely: the skill is *named* Higgsfield but is **Muapi-backed** — a multi-model aggregator that resells Kling/Veo/Seedance-class models. It is not Higgsfield's product, doesn't bill a Higgsfield account, and can't access Higgsfield-exclusive surfaces (Soul, Marketing Studio, Virality Predictor, Cinematic Studio, presets). Going official gets us the real product, the exclusive models, and a partner relationship — plus a clean story to post about.

---

## 3. The official Higgsfield rail — all three paths, understood

Higgsfield ships three install paths (`higgsfield.ai/mcp`). All three ultimately speak the same backend: **`https://fnf.higgsfield.ai/agents/*`** with an OAuth bearer.

### 3.1 Path A — MCP (`https://mcp.higgsfield.ai/mcp`)
- Hosted remote MCP server. Auth via OAuth (PKCE for Claude-class clients; **device-code for OpenClaw/Hermes/Memoclaw**).
- Exposes **six high-level tools**: Video analyzer, Marketing video generator, Soul character training, Cinematic image-to-video, Viral clip generator, Virality prediction.
- Setup is a per-client connector + interactive sign-in. **Higgsfield itself says: "If you are using Claude Code or Codex, it's better to use the CLI."**
- **Fit for us:** poor as a *fleet* mechanism. MCP-per-VM means OAuth-per-VM (same fan-out problem as Arch 2) and couples us to their tool granularity. Useful as a *reference* for tool design and as the path a BYO power-user might use, but not our fleet rail.

### 3.2 Path B — CLI (`@higgsfield/cli`, the `hf`/`higgsfield` binary)
- Go binary; `higgsfield auth login` (device flow) → `credentials.json`; auto-refresh.
- Command surface (App. C): `auth`, `account`, `workspace`, `model`, **`generate` (create/cost/wait/get/list)**, `upload`, `soul-id`, `marketing-studio`, `product-photoshoot`, `version`.
- `--wait`/`--wait-timeout`/`--wait-interval`/`--json` make it trivially scriptable; `--json` is machine-readable; paths auto-upload.
- **Crucial overrides:** `HIGGSFIELD_API_URL`, `HIGGSFIELD_DEVICE_AUTH_URL`, `HIGGSFIELD_CREDENTIALS_PATH`.
- **Fit for us:** this is the *backend contract* we build against. We do **not** need the binary on the VM (see Arch 1) — but the binary's behavior tells us exactly how to (a) call `/agents/*` directly from our proxy, or (b) optionally run the CLI **server-side** in the proxy.

### 3.3 Path C — Skill (`npx skills add higgsfield-ai/skills`)
- Pulls three prompt-skills (`generate`, `soul`, `product-photoshoot`) that **wrap the `hf` CLI** ("submit jobs through the hf CLI"). Requires `higgsfield auth login`. Invoked as `/higgsfield:generate`.
- **Fit for us:** it's CLI + prompt wrappers, so it inherits the CLI's per-account OAuth. Their prompt-skills are a useful *reference* for our own SKILL.md authoring, but we won't adopt their skill package wholesale — our SKILL.md must speak to *our* proxy, *our* credit model, and *our* Telegram delivery, none of which their generic skill knows about.

### 3.4 Auth model deep-dive (the crux)
- Device flow: `POST` device-authorization → `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}` → user approves at `https://higgsfield.ai/device?code=XXXX` → poll token endpoint on `interval` → `{access_token, refresh_token, expires_in}`. Backed by Clerk (`clerk.higgsfield.ai`) upstream.
- Access tokens are short-lived; **refresh tokens (offline_access) renew them**. The CLI persists both to `credentials.json` and refreshes automatically. The README's "tokens are short-lived, re-run auth login" most plausibly refers to *refresh-token* expiry/revocation, **TTL unknown — see §11 ask.**
- **`workspace` + `/agents/workspaces/select`** ⇒ one account can hold multiple billing workspaces. This is the hook for a **platform workspace** in a partner deal.

---

## 4. Architecture decision (the fork, reasoned end-to-end)

Four candidate fleet architectures. Decision: **Arch 1 primary + Arch 4 opt-in. Arch 2 disqualified. Arch 3 is an implementation option *within* Arch 1.**

### 4.1 Arch 1 — Official backend behind our centralized proxy ✅ RECOMMENDED
```
VM agent → higgsfield-video skill scripts
        → POST instaclaw.io/api/gateway/higgsfield   (x-gateway-token = per-VM GATEWAY_TOKEN)
            → proxy: lookupVMByGatewayToken → estimate (cost) → check/hold video-credits
            → forward to https://fnf.higgsfield.ai/agents/*  with PLATFORM credential
               (API key if partner deal; else server-side OAuth refresh of ONE platform token)
            → meter (settle credits) → normalize → return {request_id | result_url}
```
- **Per-VM auth:** unchanged — the `GATEWAY_TOKEN` every VM already has. **Zero per-VM Higgsfield OAuth.**
- **Credential:** exactly one, server-side. Proxy is built to accept **either** an API key **or** a single platform OAuth refresh token (the proxy refreshes; one writer, no rotation race).
- **Migration:** swap the existing `higgsfield-video` skill's upstream from Muapi to our new `/api/gateway/higgsfield` proxy. VM-side surface barely changes. **Zero-downtime** (§4.5).
- **Pros:** fleet-correct; central billing/metering/rate-limit/abuse-control (required for estimate-then-charge); resilient to Higgsfield CLI churn (we call HTTP directly or run the CLI server-side); identical to the pattern we already operate twice (Muapi, Sjinn).
- **Cons / dependency:** needs Higgsfield to bless a platform account/workspace (or API key) that funds many agents (§11 ask #1). If OAuth-only with per-account rate limits, we need a partner workspace with appropriate limits.

### 4.2 Arch 4 — Bring-Your-Own Higgsfield account (opt-in power tier) ✅ LATER
- A user who already has (or buys) Higgsfield Pro links it: the agent runs the **device flow in chat** ("Open `https://higgsfield.ai/device?code=AB12-CD34` and approve") → store *that user's* `credentials.json` on *their* VM (`HIGGSFIELD_CREDENTIALS_PATH`) → generations bill the **user's** Higgsfield credits, not InstaClaw's.
- This is the device-code flow exactly as designed (OpenClaw is a named client). No token sharing ⇒ no rotation race.
- **Pros:** zero media-cost exposure for these users; the "link your real Higgsfield account, in chat" moment is itself a wow/demoable beat; perfect for creators/power users.
- **Cons:** requires a Higgsfield plan (friction; minority of users); off-platform billing (no margin); we own token lifecycle per VM (refresh, re-auth on expiry).
- **Verdict:** ship after Arch 1 as a premium toggle ("Use my own Higgsfield account"). Not the default.

### 4.3 Arch 2 — Official CLI + shared platform token on every VM ❌ DISQUALIFIED
- Install `hf` on all VMs; distribute one platform `credentials.json` to all 164.
- **Fatal risk:** refresh-token **rotation**. If Higgsfield rotates+invalidates the refresh token on each use (common), 164 VMs refreshing independently invalidate one another → fleet-wide auth collapse. Also: no central metering, and one runaway VM burns the shared account.
- Even if rotation weren't an issue, we'd lose the estimate-then-charge gate (metering would move on-VM, which is exactly the lying-DB/abuse surface we avoid).

### 4.4 Arch 3 — Official CLI on VMs, pointed at our proxy ⚠️ FOLD INTO ARCH 1
- `hf` on VMs with `HIGGSFIELD_API_URL=instaclaw.io/api/gateway/higgsfield`.
- Real value of this idea is **server-side**: the proxy *itself* could shell out to the official `hf` binary (authed once to the platform account) instead of re-implementing the `/agents/*` HTTP calls. That gives us free `model list`, `generate cost`, `--wait` polling, and upload handling.
- **Decision:** treat "run `hf` server-side in the proxy" as an **implementation option for Arch 1's proxy** (§6.4), chosen at build time based on whether direct HTTP or the binary is more robust. Not a separate fleet model.

### 4.5 Migration (zero-downtime, staged)
1. **Stand up the proxy** `/api/gateway/higgsfield` (mirror `sjinn/route.ts`), pointed at the platform credential. Ship dark.
2. **Canary one VM** (vm-1019, the standard canary): point a *copy* of the skill at the new proxy via an env flag (`INSTACLAW_HIGGSFIELD_PROXY`), run real generations end-to-end (cost → create → poll → deliver), confirm metering + delivery. (Mirrors the fleet's canary discipline.)
3. **Dual-run** behind a per-VM flag: new rail for canaries, Muapi for everyone else. Compare cost/quality.
4. **Flip the default** in the skill: upstream = official proxy; keep Muapi as a **fallback** branch (the Sjinn proxy already demonstrates auto-fallback) for one release, then remove.
5. **Deprecate** the second skill: merge `sjinn-video` capabilities into the one official `higgsfield-video` skill (or rename to a single user-facing "video" skill — naming in §8.4). Retire `MUAPI_API_KEY`/`SJINN_API_KEY` once traffic is zero.
6. Per fleet discipline (CLAUDE.md Rule 47): a skill/template change reaches caught-up VMs only via a manifest version bump **or** a one-shot fleet-push — the build plan must include one (the SKILL.md + script changes are file-content changes).

**No VM is ever without a working video path during migration** — the skill points at exactly one live upstream at all times, with Muapi as the staged fallback.

---

## 5. Scope decision — the ownable slice (turn this on, hold the rest)

Higgsfield markets the **full studio** (ad engine that "replaces your agency," brand builder, marketing studio, presets). That is *their* pitch for *their* ICP (DTC brands, agencies). **We must not relabel it.** Our claim has to be uniquely ours.

### 5.1 Phase 1 — turn ON (the consumer-magic slice)
| Capability | Models | Why it's in |
|---|---|---|
| **Text → video** | Kling 3.0, Seedance 2.0, Veo 3.1 (+ lite/fast tiers) | The headline. Cinematic clip from a sentence. |
| **Image → video** | same (start-image) | The single most magical Higgsfield moment — "bring this still to life." Highest wow/share. |
| **Text → image** (on-ramp) | Nano Banana Pro, Seedream 4.5, GPT Image 2 | Cheap, instant, low-stakes entry; natural upsell into motion. |
| **Virality Predictor** | `brain_activity` | Cheap, shareable, *on-brand for InstaClaw*, and a top-of-funnel hook (§8). |

### 5.2 Phase 2 — hold (tier 2, retention)
- **Soul-ID (character)**: train a face-faithful character once, reuse everywhere. Sticky and on-brand with the platform's memory/identity story ("your agent remembers your character"). Gate behind a higher tier or pack.

### 5.3 Phase 3 — maybe-later (B2B, *not* our headline)
- **Marketing Studio / Ad Engine / Brand Builder / Presets / DTC Ads.** Powerful, but it's Higgsfield's claim and a different ICP. Revisit only if we deliberately court e-commerce/agency users. Surfacing it Phase 1 dilutes the consumer story and invites "isn't this just Higgsfield?".

### 5.4 The ownable claim (decided here; copy written later per Rule 55)
> **"Text your agent. Get back cinematic video. Then it tells you if it'll go viral."**

What makes it *ours* and not Higgsfield-relabeled: it's **in your existing agent, in chat, with delivery + a virality verdict in one loop** — Higgsfield sells a studio you operate; we sell an agent that just *does it for you* and grades it. The Virality Predictor as the closing beat is the uniquely-InstaClaw twist (the agent that helps you go viral, now measuring it).

---

## 6. Architecture detail — the proxy & the on-VM skill

### 6.1 New route: `app/api/gateway/higgsfield/route.ts`
Mirror `sjinn/route.ts`. Actions via `?action=`:
- `cost` → `POST fnf/agents/jobs/cost` → returns Higgsfield credit cost → proxy converts to **our** video-credit quote. (No charge.)
- `create` → estimate (cost) → **check + hold** video-credits (new RPC, §7.3) → `POST fnf/agents/jobs` → return `request_id`. (Async; mirrors `--submit-only`.)
- `poll` → `GET fnf/agents/jobs/poll?...` → on completion **settle** the hold (charge actual) and normalize `result_url`/`video_url`.
- `upload` → `POST fnf/agents/uploads` (multipart) → return UUID for image→video / start-image.
- `models` → cached `model list` (so the agent/UX always has the live catalog + schemas).
Auth: identical gateway-token → `lookupVMByGatewayToken` pattern. Provider billing errors never surface to users (generic "at capacity"), per the Sjinn precedent.

### 6.2 Credential handling in the proxy (absorbs either model)
- **If API key (partner deal):** `Authorization: <key>` (or header per Higgsfield spec) server-side. Simplest.
- **If OAuth only:** store the platform `refresh_token` in a server secret; a single refresh routine mints/caches the access token (with a lock so concurrent requests don't double-refresh); attach as bearer. One writer ⇒ no rotation race. Cache the access token in memory/Edge Config until ~60s before `expires_in`.

### 6.3 On-VM skill (evolves the existing `higgsfield-video` skill)
- Keep the Python-scripts-only discipline (Rule 0 in the current SKILL.md) — scripts call the new proxy, not the provider.
- New/changed scripts: `higgsfield-generate.py` (cost→create→deliver, `--submit-only` async default for video), `higgsfield-cost.py` (explicit estimate), `higgsfield-status.py` (poll), `higgsfield-upload.py`, `higgsfield-virality.py` (`brain_activity`). Setup script swaps `INSTACLAW_MUAPI_PROXY` → `INSTACLAW_HIGGSFIELD_PROXY` (keep reading `GATEWAY_TOKEN`).
- Delivery: result lands as a **native Telegram video** via existing `deliver_file.sh`/`notify_user.sh`, not a bare link (§8.2).

### 6.4 Build-time choice: direct HTTP vs server-side `hf`
- **Direct HTTP** (recommended default): proxy calls `fnf/agents/*` itself. Fewest moving parts, no binary on our serverless infra, full control of payloads.
- **Server-side `hf`** (fallback option): if the `/agents/*` payloads prove fiddly, run the official binary in the proxy environment authed once. Gains `cost`/`model`/polling for free. Risk: binary in a serverless runtime, refresh timing. Decide during build; the route interface is identical either way.

---

## 7. Billing / video-credits model

### 7.1 Decision: ONE weight-based "video-credit" currency, estimate-then-charge
Collapse the two existing models (count-based Sjinn caps + weight-based Muapi credits) into **one weight-based video-credit currency**, because:
- Higgsfield costs vary 5–10× by model/duration/resolution; a flat "N videos/day" count is either too generous (Veo 4K) or too stingy (a 5s lite clip). Weight-based is honest.
- `generate cost` gives us the **exact** per-job cost *before* running ⇒ we can quote and gate precisely. Count-based throws that away.
- One currency removes the user confusion of two "video" skills with two limits.

### 7.2 Estimate-then-charge flow (keystone)
```
user asks → agent builds brief → proxy: cost(model,params) → Higgsfield credits
          → convert to OUR video-credits (× margin) → QUOTE to user in chat:
            "This 10s Veo 3.1 clip is 180 credits. You have 600. Generate?"
          → on yes: HOLD 180 → create → poll
          → on success: SETTLE (charge actual, release remainder of hold)
          → on failure/timeout: RELEASE hold fully (never charge for a failed render)
```
- Cost is **deterministic** (Higgsfield returns `credits` + optional `credits_exact`), so there's no "actual vs estimate" delta to reconcile: **hold the quoted amount → charge it on success → release the hold fully on any non-success.** The `cost` endpoint makes the quote exact rather than guessed. The hold must be **atomic** (row-locked, like `instaclaw_check_and_increment`) and **idempotent on the Higgsfield `request_id`** so concurrent jobs can't oversell a balance and a re-poll can't double-charge. Full state machine (rejected / failed / timeout / partial) in **§13.2**.
- Refusal when insufficient: "This needs 180 credits; you have 90. Want a quick top-up?" → link to Studio reload (§7.5). Never a dead-end.

### 7.3 Data model (extends existing, low-risk)
- Reuse `instaclaw_vms.credit_balance` + `instaclaw_credit_ledger` (proven) **or** add a dedicated `video_credit_balance` column + ledger source `video_deduction`. **Recommendation: a dedicated `video_credit_balance`** so the Studio surface and packs are unambiguous and never collide with message-credit overage logic. (The ledger already supports a `media_deduction` source; add `video_hold`/`video_settle`/`video_refund` sources.)
- New RPCs (mirror existing patterns): `instaclaw_video_hold(vm_id, credits, ref)`, `instaclaw_video_settle(vm_id, ref, actual)`, `instaclaw_video_release(vm_id, ref)`. All ledgered, idempotent on `ref` (the Higgsfield `request_id`).
- Keep `instaclaw_usage_log` inserts (call_type `video`) for forensics (Rule 69 taxonomy).
- **Daily allowance + packs hybrid:** each plan tier includes a small **daily video allowance** (a free taste to drive habit + virality — e.g. enough for ~1–2 short clips/day, tier-scaled); beyond that, spend `video_credit_balance`; reload via packs (never expire, stack). The "free taste" is essential — a viral feature must be tryable without paying.

### 7.4 Pricing inputs we need (then this section closes)
The dollar mapping needs Higgsfield's **per-generation pricing to us** (from the partner deal). Anchor from our existing media packs: ~$0.0067–$0.01 per credit retail; today implicitly ~80 credits ≈ one short video (~$0.53–$0.80 retail). The build sets: `our_credits(job) = ceil(higgsfield_credits(job) × MARGIN)`, MARGIN chosen to hit target gross margin once Higgsfield's wholesale price is known (§11 ask #2).

### 7.5 Dedicated dashboard surface — **YES**, build `/dashboard/studio`
Video deserves its own surface; do **not** fold it into the general credits page. Reasoning:
- Different mental model: per-render cost + async jobs + a **library of outputs**, vs "messages per day."
- The **gallery is the product's value made visible** — re-watch, re-download, re-share, **remix** (regenerate with tweaks), make-a-9:16-version. This is what turns a one-off render into retention.
- A live **job queue** ("Veo 3.1 clip — rendering ~2 min") sets expectations for async generation in a way chat alone can't.
Surface contents:
1. **Video-credit balance + reload** (Stripe packs, §7.6).
2. **Live job queue** (pending/processing/done/failed) with cost per job.
3. **Gallery** of completed renders: thumbnail, model, prompt, cost, actions (download, share-link, remix, "score virality").
4. (Tier 2) **My Characters** (Soul-IDs).
Keep `/dashboard/billing` (subscriptions) and `/dashboard/credits` (message credits) as-is; cross-link to Studio. (Existing nav already has `/dashboard/files`, `/dashboard/economy`, etc., so a new top-level Studio entry fits.)

### 7.6 Stripe reload — extend the proven path
Add `video_500/1200/3000` packs to `CREDIT_PACKS` in `app/api/billing/credit-pack/route.ts` with `target:"video"`, new env price IDs (`STRIPE_PRICE_VIDEO_*`). The webhook's `handleCreditPackPurchase` routes by `target` → new `instaclaw_add_video_credits` RPC (clone of `instaclaw_add_credits`, writes `video_credit_balance` + ledger). Idempotency via existing `instaclaw_credit_purchases` UNIQUE(payment_intent). **No new payment plumbing — just a new target.**

---

## 8. The viral feature shape + Agent UX (best-in-class)

### 8.1 The "Director's Brief" flow (propose-then-refine, never interrogate)
Higgsfield's docs stress the **prompt is the key creative input.** So the agent must be a good director — but in **one smart move**, not a 20-question form:
- User: "make me a video of my product on a beach."
- Agent (one message, sensible defaults pre-filled, platform-aware): *"On it — a 9:16 6-second cinematic clip, slow push-in, golden-hour. I'll add ambient sound. Want a different vibe (e.g. hyper-motion, noir) or longer?"* → then generates on confirm or refines on feedback.
- The agent **auto-upgrades a lazy prompt** into a cinematic one (it speaks Higgsfield's `genre`/`mode`/camera vocabulary natively) **and shows the upgraded prompt** so the user learns and trusts it.
- Platform-aware aspect defaults: 9:16 for TikTok/Reels/Shorts, 16:9 for YouTube/landscape, 1:1 for feed.

### 8.2 Delivery = effortless, in chat
- Result is delivered as a **playable native Telegram video** (existing `lib/telegram.ts sendTelegramVideo`), one-line caption, and quick-action buttons: **Remix · Make 9:16 · Score virality · Save to Studio.**
- **Delivery gap (pass-2, must-fix):** Telegram bot `sendVideo` is a hard **50MB** cap with **no link fallback today** (`lib/telegram.ts` rejects >50MB). A 15s/1080p clip can approach/exceed this. The skill must, on >50MB or send failure, **fall back to a result link** ("your clip's ready → [link] — also saved in your Studio") and **always pin the render to the Studio gallery** so nothing is ever lost (§13.2 G4).
- Async is honest and calm: "Submitted to Veo 3.1 — ~2–3 min, I'll ping you." Then it pings with the video. (Async pattern already in the current SKILL.md; keep it.)

### 8.3 Model auto-selection + cost-aware tiers (the agent is the expert)
- The user never has to know "Kling vs Seedance vs Veo." The agent maps intent→model→params using the live `model list` schema. Defaults: short cinematic → Kling 3.0 / Seedance 2.0; talking/realistic human → Veo 3.1; cheapest taste → a lite model.
- Because we have `generate cost`, offer **good/better/best with live credit prices**: *"Quick draft (40), Cinematic (120), or Premium Veo (250)?"* — cost becomes a feature, not a gate.

### 8.4 Naming (resolve the two-skill mess)
- One user-facing video capability. Internally `higgsfield-video`; user-facing name TBD (candidates: keep neutral "video"/"Studio"; the "Director" persona from sjinn-video is strong and could carry over). Per the current sjinn SKILL.md, provider names stay backstage. **Decision deferred to build + Cooper**, but the migration collapses to one skill regardless.

### 8.5 What makes it post-worthy (the growth loops)
- **The whole loop in chat, zero app-switching:** brief → cinematic video back → "score its virality." That demo *is* the ad: "I texted my agent and it sent back a cinematic clip — and told me it'd hit."
- **Virality Predictor as the hook**, possibly **free/cheap**: "send me any video and I'll grade its viral potential" — top-of-funnel, inherently shareable, on-brand, and a natural lead-in to "now let me generate a better one."
- **Shareable render page** `instaclaw.io/v/<id>` with a subtle "made by my InstaClaw agent" footer → every shared video is a growth ad. (Opt-in/togglable.)
- **Image→video upsell**: whenever the agent makes/sees an image, offer "want me to bring that to life?" — the cheapest path to the most magical output.

---

## 9. Novel ideas worth considering (beyond the spec)

1. **Virality Predictor as the wedge, not the generator.** The uniquely-ownable, cheap, shareable, on-brand feature. Could even be a standalone free tool that funnels into generation. Strongest "only InstaClaw does this in your chat" claim.
2. **Cost-aware model routing in the proxy.** Given `generate cost`, the proxy can pick the cheapest model that satisfies a brief, or expose good/better/best tiers with live prices — margin control + a UX feature simultaneously.
3. **The Studio gallery as retention surface.** A library of your renders with one-tap **remix** is what makes video sticky rather than novelty. The remix action (regenerate with a tweak) reuses prompt+params and is a delight loop.
4. **"Bring your own Higgsfield account" as a premium toggle (Arch 4).** Power users on Higgsfield Pro link their account in chat via device flow; their generations bill *their* credits. Zero cost to us, maximal ceiling for them, and the in-chat device-link is itself a wow beat.
5. **Character continuity tied to agent identity (Soul-ID, tier 2).** "Your agent remembers your character" dovetails with the platform's memory/identity story — a differentiated retention hook, not just a feature.
6. **Hybrid "free daily taste + never-expire packs."** The free taste is what lets the feature spread; packs are the monetization. Make the taste explicit per tier.
7. **Auto-aspect by destination.** The agent infers 9:16/16:9/1:1 from where the user says they'll post — small touch, large "it just gets it" effect.

---

## 10. Risks & open questions (honest)

| # | Risk / unknown | Severity | Mitigation / how it resolves |
|---|---|---|---|
| R1 | **Does Higgsfield permit one platform account/workspace to fund many agents?** (Arch 1's dependency) | **High** | §11 ask #1 — confirm in the partner conversation. Their public OpenClaw courtship + `/agents` API + `workspace` concept all point yes, but it must be explicit. |
| R2 | **Is there a partner/enterprise API key, or OAuth-only?** | Medium | Either works (proxy absorbs both, §6.2). API key is cleaner; OAuth-refresh is fine with one server-side writer. Confirm in deal. |
| R3 | **Refresh-token TTL / rotation behavior** | Medium | If we use a platform OAuth token, we must know TTL + whether refresh rotates. (Disqualifies Arch 2 regardless; for Arch 1 it's a server-side detail.) Ask Higgsfield or measure empirically with a test account. |
| R4 | **Per-account rate limits across fleet traffic** | Medium | Partner workspace with platform-appropriate limits; proxy can queue/backoff. Confirm limits in deal. |
| R5 | **Wholesale pricing → our margin** | High (for billing) | §11 ask #2. `generate cost` gives live unit cost; we need $/Higgsfield-credit to set MARGIN. |
| R6 | **Video resolution reality vs marketing** | Low | CLI video tops at 1080p today; 4K is image-side. Don't claim 4K video. (App. C.) |
| R7 | **Migration regressions** | Low | Staged dual-run + Muapi fallback + canary (vm-1019) before flip (§4.5). Rule 47 fleet-push discipline. |
| R8 | **Two-currency user confusion** (message vs video credits) | Low | Dedicated Studio surface + distinct `video_credit_balance` + clear copy. |
| R9 | **Does Higgsfield charge us for failed/rejected/moderated jobs?** (we refund the user regardless ⇒ we eat it) | Medium | §11 ask. Track platform loss; alert if failure/rejection rate spikes (model instability or abuse signal). |
| R10 | **Telegram 50MB delivery cap, no link fallback today** | **Must-fix** | Link-fallback + always pin to Studio gallery; optional downscaled variant (§13.2 G4). |
| R11 | **Proxy is a real action-based build, not a passthrough flip** | Low | Mirror the Sjinn route, not the Muapi catch-all; estimate-then-charge needs structured cost/create/poll. Scoped in §12 Phase 0. |
| R12 | **Existing-user credit-model cutover** (count→weight, in-flight jobs) | Medium | Backfill + grandfather + dual-poll one release (§13.4). |

---

## 11. What I need from Cooper (the asks that unblock build)

1. **Commercial: a platform arrangement with Higgsfield.** Confirm (a) one InstaClaw-owned account/**workspace** may fund generations for the whole fleet via the `/agents` API, and (b) whether we get a **partner/enterprise API key** or must use **OAuth** (we'll handle either). Get the **per-account rate limits**. *(This is the single gating item for Arch 1.)*
2. **Pricing sheet:** Higgsfield's **wholesale per-generation cost** (or $/Higgsfield-credit) so we can set the video-credit MARGIN and pack prices.
3. **Account + plan tier:** which Higgsfield plan/workspace we run on, and credentials/seat for us to authenticate the platform account once.
4. **Refresh-token TTL/rotation** behavior (if OAuth) — or a test account so we can measure it.
5. **Green-light the scope** (§5: Phase-1 = text→video, image→video, image on-ramp, Virality Predictor; hold Soul-ID/Marketing Studio) and the **dedicated `/dashboard/studio` surface** (§7.5).
6. **Pick the architecture** (recommended: Arch 1 now, Arch 4 later) so the build prompt can be written.
7. **Failed-job billing (pass-2):** does Higgsfield charge the account for jobs that end `failed` / `rejected` / `nsfw` / `canceled`? (Drives whether refund-on-fail costs us anything — R9.)
8. **Per-account rate limits** when one platform account/workspace fans out to the whole fleet (so the proxy can size queue/backoff — R4).
9. **Confirm the credential is workspace-scoped** so platform spend is isolated from any personal Higgsfield use and revocable independently.

---

## 12. Build plan (for the hand-off terminal, once §11 closes)

**Phase 0 — Proxy + credential (no VM changes):** build `app/api/gateway/higgsfield/route.ts` (mirror `sjinn/route.ts`), credential handling (§6.2), actions cost/create/poll/upload/models. Unit-test against a real platform credential. Ship dark.

**Phase 1 — Billing primitives:** `video_credit_balance` column + ledger sources; `instaclaw_video_hold/settle/release` RPCs (idempotent on Higgsfield `request_id`); daily video allowance per tier; `usage_log` call_type `video`. Migrations self-contained + RLS (Rules 56, 60).

**Phase 2 — Skill rewrite:** evolve `higgsfield-video` scripts to call the proxy (cost→quote→create→poll→deliver), native Telegram video delivery, model auto-select, Director's Brief flow, virality script. SKILL.md authored to speak Higgsfield vocabulary natively + the new credit UX. `requiredSentinels` per Rule 23.

**Phase 3 — Stripe video packs:** `video_500/1200/3000` in `CREDIT_PACKS` + env price IDs + `instaclaw_add_video_credits` + webhook `target:"video"`.

**Phase 4 — Studio dashboard:** `/dashboard/studio` (balance + reload + job queue + gallery + remix). Cross-link from billing/credits.

**Phase 5 — Migration:** canary vm-1019 → dual-run flag → flip default (Muapi fallback one release) → deprecate `sjinn-video` + retire `MUAPI_API_KEY`/`SJINN_API_KEY`. Manifest bump or fleet-push per Rule 47.

**Phase 6 — Arch 4 (later):** in-chat device-flow account linking; per-VM `HIGGSFIELD_CREDENTIALS_PATH`; bill user's Higgsfield credits.

**Verification at every phase:** real generation end-to-end (cost→create→poll→deliver→settle), failure-mode tests (insufficient credits, failed render → hold released, provider 5xx → generic message), and a coverage query for "% of fleet on official rail" (Rule 27).

---

## Appendix A — CLI binary static analysis (verified, `@higgsfield/cli` v0.1.40, linux/amd64)

- npm package = wrapper (`bin/higgsfield.js`, `bin/higgs.js`, `bin/run.js`, `install.js` postinstall) that downloads `hf_<ver>_<os>_<arch>.tar.gz` from GitHub Releases (Go binary `hf`). `run.js` sets `HIGGSFIELD_INSTALL_METHOD`, `HIGGSFIELD_PACKAGE_MANAGER`.
- **Env vars the binary reads:** `HIGGSFIELD_API_URL`, `HIGGSFIELD_APP_URL`, `HIGGSFIELD_DEVICE_AUTH_URL`, `HIGGSFIELD_CREDENTIALS_PATH`, `HIGGSFIELD_NO_UPDATE_CHECK`, `HIGGSFIELD_DISABLE_TELEMETRY`, `HIGGSFIELD_TELEMETRY`, `HIGGSFIELD_SENTRY_DSN`, `HIGGSFIELD_INSTALL_METHOD`, `HIGGSFIELD_PACKAGE_MANAGER`. **No `HIGGSFIELD_API_KEY`.**
- **Auth/OAuth literals:** `json:"device_code"`, `json:"refresh_token"`, `json:"verification_uri"`, `json:"expires_in"`, `json:"interval"`, `json:"prompt_interval_seconds"`; `"Start browser-based device login"`, `"Cannot reach token endpoint."`, `"Refresh failed (HTTP %d): %s"`, `"Failed to build refresh request."`, `"Session expired."`
- **Credential storage:** `credentials.json` (+ `credentials.*.tmp` atomic write, `"Failed to acquire credentials lock."`, `"Failed to create credentials dir."`), under `$XDG_CONFIG_HOME` / `$HOME` (`"neither $XDG_CONFIG_HOME nor $HOME are defined"`). Override: `HIGGSFIELD_CREDENTIALS_PATH`.
- **Hosts:** `https://fnf.higgsfield.ai` (API), `https://fnf-device-auth.higgsfield.ai` (device auth), `https://higgsfield.ai` (app), `dev.higgsfield.ai`/`dev-fnf.higgsfield.ai` (dev).
- **API paths:** `/agents/jobs`, `/agents/jobs/cost` (*"preview cost without creating a job"*), `/agents/jobs/poll`, `/agents/uploads`, `/agents/transactions`, `/agents/workspaces/select`, `/agents/custom-references`, `/agents/marketing-studio/*`, `/agents/marketplace-cards/enhance`. Error: `"Higgsfield API error (HTTP %d)."`

## Appendix B — OAuth metadata (verified)

`GET https://mcp.higgsfield.ai/.well-known/oauth-protected-resource`:
- `resource: https://mcp.higgsfield.ai`; `authorization_servers: [mcp.higgsfield.ai, fnf-device-auth.higgsfield.ai]`; `scopes_supported: [openid, email, offline_access]`; `bearer_methods_supported: [header]`.
- `higgsfield_auth_hints.options`:
  - `authorization_code_pkce` → upstream `clerk.higgsfield.ai`, clients `[anthropic, claude, claude-ai, claude-code]`.
  - `device_code` → server `fnf-device-auth.higgsfield.ai`, clients **`[openclaw, hermes, memoclaw]`**, "client cannot receive redirects, verify out-of-band."
- (`fnf-device-auth.../.well-known/oauth-authorization-server` returned 404; endpoints are embedded in the binary instead.)

## Appendix C — Command + model surface (from README + MODELS.md, v0.1.40)

- **Commands:** `auth` (login/logout/inspect), `account` (credits/transactions), `workspace` (list/select/unset billing workspace), `model` (list/get schema), `generate` (create/cost/wait/get/list), `upload`, `soul-id`, `marketing-studio`, `product-photoshoot`, `version`.
- **Flags:** `--wait`, `--wait-timeout` (10m), `--wait-interval` (3s), `--json`, `--no-color`.
- **Video models (17):** `veo3_1` (dur 4/6/8, quality basic/high/ultra, 16:9|9:16), `veo3_1_lite`, `veo3`, `kling3_0` (dur int, mode pro/std, sound on/off), `kling2_6` (dur 5/10, sound), `seedance_2_0` (dur int, genre auto/action/horror/comedy/noir/drama/epic, mode std/fast, res 480/720/1080p), `seedance1_5` (dur 4/8/12), `wan2_7`, `wan2_6` (dur 5/10/15), `minimax_hailuo` (dur 6/10, res 512/768/1080), `grok_video`, `cinematic_studio_3_0`, `cinematic_studio_video` (dur 5/10, slow_motion, sound), `cinematic_studio_video_v2` (genre enum, mode pro/std), `soul_cast` (has `--budget`), `marketing_studio_video` (ugc/tv_spot/wild_card… modes, res 480/720/1080p), `brain_activity` (Virality Predictor — input `--video` only).
- **Image models (18):** `nano_banana_2` (Pro, up to 4k), `nano_banana_flash`, `nano_banana`, `flux_2` (pro/flex/max), `flux_kontext`, `gpt_image_2` (quality low/med/high, up to 4k), `text2image_soul_v2` (`--soul-id`), `seedream_v4_5`, `seedream_v5_lite`, `grok_image`, `openai_hazel`, `image_auto`, `z_image`, `kling_omni_image`, `cinematic_studio_2_5` (up to 4k), `soul_cinematic`, `soul_location`, `marketing_studio_image` (up to 4k), `dtc_ads`.
- **Inputs:** media flags (`--image`, `--start-image`, `--end-image`, `--video`, `--audio`) accept a UUID **or** a local path (auto-uploaded). Every model requires `--prompt`.
- **Reality check:** video is **≤1080p** in the CLI schema and **≤15s** (MCP page: "up to 15 seconds"); **4K and "up to 4K" are image-only.** "Any aspect ratio" is per-model (each model's enum above). Don't market 4K video or arbitrary-length video.

## Appendix D — Current InstaClaw video wiring (verified)

- `instaclaw/skills/higgsfield-video/SKILL.md` (v2.1.0) + `scripts/higgsfield-setup.py`: reads `GATEWAY_TOKEN` (fallback `MUAPI_API_KEY`) from `~/.openclaw/.env`; base URL `INSTACLAW_MUAPI_PROXY` → `…/api/gateway/muapi`, else `https://api.muapi.ai`. Scripts-only discipline; async `--submit-only` for video; pre-gen credit check; max-3-retry.
- `instaclaw/app/api/gateway/sjinn/route.ts`: gateway-token → `lookupVMByGatewayToken` → `instaclaw_check_video_limit` → forward to `sjinn.ai` w/ server `SJINN_API_KEY` → `instaclaw_increment_video_usage`; auto-fallback agent→tool; normalize `data.video_url`; provider billing errors hidden.
- `instaclaw/app/api/gateway/muapi/[...path]/route.ts`: gateway-token → forward to `api.muapi.ai` w/ server `MUAPI_API_KEY`.

## Appendix E — Current billing system (verified)

- **Video caps (count-based):** `instaclaw_check_video_limit(vm_id, generation_type, tz)` + `instaclaw_video_usage`; Starter 5 video/10 img/10 aud, Pro 10/30/30, Power 30/100/100, BYOK 5/15. (`supabase/migrations/20260304_video_usage_tracking.sql`)
- **Credit balance:** `instaclaw_vms.credit_balance` + `instaclaw_credit_ledger` (sources stripe/usage_deduction/media_deduction/…); `instaclaw_add_credits(vm_id, credits, ref)`. (`…/20260323_credit_ledger.sql`)
- **Message daily limits:** `instaclaw_daily_usage` + `instaclaw_check_and_increment`; display limits Starter 600 / Pro 1000 / Power 2500; model weights minimax 0.2× / haiku 1× / sonnet 4× / opus 19×.
- **Stripe packs:** `app/api/billing/credit-pack/route.ts` `CREDIT_PACKS` (targets messages/media/toolrouter; env price IDs `STRIPE_PRICE_MEDIA_*`); webhook `handleCreditPackPurchase` synchronous + idempotent (`instaclaw_credit_purchases` UNIQUE payment_intent) → `instaclaw_add_credits`.
- **Media packs:** `media_500` $4.99 / `media_1200` $9.99 / `media_3000` $19.99 ("never expire, stack on daily allowance"), surfaced at `/dashboard/billing/credit-packs` + `/dashboard/credits`.
- **Tiers:** Starter $49.99 (BYOK $35.99) / Pro $129.99 ($49.99) / Power $349.99 ($119.99); price IDs in `lib/stripe.ts` `NEW_PRICE_IDS`.
- **Dashboard pages:** `/dashboard/{billing, billing/credit-packs, credits, skills, files, history, economy, …}` — a new `/dashboard/studio` fits the existing structure.

---

## 13. Verification & hardening (pass 2 — 2026-06-08)

> The driving question this pass: *"what would make this NOT world-class, and have we caught it?"* Everything below is re-verified against the bytes/code, not first-pass notes.

### 13.1 Corrections to pass-1 claims (each re-checked against source/code)

| Pass-1 claim | Pass-2 correction | Evidence |
|---|---|---|
| "literally swap the proxy upstream… fleet/UX/billing invariant" | **Only the fleet auth+transport pattern is invariant.** The Higgsfield proxy is an **action-based build** (mirror `sjinn/route.ts`: cost/create/poll/upload), **not** the Muapi `[...path]` passthrough — because billing needs the structured cost step. The on-VM skill is a real rewrite (Muapi endpoint names → Higgsfield `job_set_type` + cost/create/poll). Billing is **unified + fixed**, not preserved. | `app/api/gateway/muapi/[...path]/route.ts` (passthrough + weight-inference) vs `sjinn/route.ts` (action-based); `INSTACLAW_MUAPI_PROXY=https://instaclaw.io` written by `configureOpenClaw` (lib/ssh.ts ~6325) → transport invariant confirmed |
| "estimate-then-charge with hold→settle-actual→refund" | Cost is **deterministic**; no actual-vs-estimate delta. Model = **hold quoted → charge on success → release on any non-success.** | binary structs `Credits float64` + `CreditsExact *float64 "json:\"credits_exact\""`; `generate cost` = "Estimate credits without creating a job." |
| (not stated) **Current Muapi proxy overdraft bug** | Pre-check authorizes at **weight-1** (`instaclaw_check_limit_only(p_model:"haiku")`, route ~159–170) but the post-success increment charges the **true 80–250 weight** (`instaclaw_increment_media_usage`, ~270). An underfunded user can overdraw. **The official rail must enforce full job cost in the proxy before submit.** | muapi route lines 155–212, 268–292 |
| "video, any duration, up to 4K" tone | Video **≤15s, ≤1080p**; 4K is image-only. | MODELS.md video schemas (≤1080p); MCP page "up to 15 seconds"; image models list 4k |
| (not stated) **Two metering systems are genuinely divergent** | Muapi increments weight into `credit_balance`/daily; Sjinn uses count caps (`instaclaw_check_video_limit`). Unify on **weight**. | both route handlers read |
| OAuth refresh "implemented" | Re-confirmed; **single server-side holder ⇒ no rotation race** (Arch 1 safe; Arch 2 still disqualified). | binary: `"Cannot reach refresh endpoint."`, `"Failed to build refresh request."`, `json:"refresh_token"` |
| Skill update "via manifest bump or fleet-push (Rule 47)" | higgsfield-video deploys via `skillsFromRepo` (git-synced); SKILL/script changes **likely** propagate via the skill-repo pull without a manifest bump. **Confirm the exact path at build time**; default to Rule-47 discipline if unsure. | `vm-manifest.ts skillsFromRepo:true` (~2810); exact pull cadence to verify |

**Re-verified and held true:** binary env overrides `HIGGSFIELD_API_URL`/`DEVICE_AUTH_URL`/`CREDENTIALS_PATH` (no `API_KEY`); device-code flow with `openclaw` client; API on `fnf.higgsfield.ai/agents/*`; `generate cost` takes the **full job spec** (`generate cost <model> --prompt … --image …`), so the proxy's `cost` action must accept full params. `account` returns `{Credits, SubscriptionPlanType}` and `/agents/transactions` is paginated `{DisplayName, Credits, Action, CreatedAt}` — usable for platform-credit monitoring (§13.3).

### 13.2 Failure-mode & edge-case matrix (folds into §6/§7/§8)

Job lifecycle (verified in binary): `queued → pending → processing → {completed | failed | rejected | canceled}`. Plus our-side `poll_timeout` (we stopped waiting; the job may still finish server-side).

| Situation | User charged? | What the agent says | System action |
|---|---|---|---|
| `completed` | **Yes** — settle the hold | deliver video + actions (§8.2) | log usage; pin to Studio |
| `failed` (model/infra) | **No** — release hold | "That one didn't render — won't cost you. Retry?" | log; if Higgsfield charged us, track platform loss (R9) |
| `rejected` / `Prohibited` / `nsfw` | **No** — release hold | calm, non-judgy: "I can't make that one — let's tweak the idea." **Never echo provider policy text.** | log for abuse signal; rate-limit repeat offenders |
| `canceled` | **No** — release hold | "Cancelled, nothing charged." | — |
| `poll_timeout` (still processing) | **Not yet** — keep hold | "Still rendering — I'll ping you / it's in your Studio." | background poll; settle only at terminal state; **idempotent on `request_id`** so a late finish can't double-charge/double-deliver |
| insufficient balance at quote | **No** (refused pre-submit) | "Needs N credits, you have M — quick top-up?" → Studio reload | never submit |
| concurrent jobs draining balance | enforced by **atomic row-locked hold** | — | N in-flight holds can't oversell; idempotency key = `request_id` |
| result >50MB or `sendVideo` fails | charged (it succeeded) | "Ready → [link] — also saved in your Studio." | **link fallback + Studio pin** (G4); optional downscale |
| daily free-allowance available | **No** (free tier) | "On the house from today's allowance." | decrement allowance before balance (§13.4 precedence) |

### 13.3 Abuse & blast-radius hardening (new; folds into §6)

- The shared platform credential lives **only server-side** (Arch 1 guarantees VMs never hold it). Leak blast radius = the platform Higgsfield account's credit balance.
- **Mitigations (build these):**
  1. **Platform-credit-floor monitor** — the proxy reads platform `account` credits (binary `account` → `{Credits}`) and `/agents/transactions`; alert + auto-halt below a floor.
  2. **`video_spend_kill_switch`** in `instaclaw_admin_settings`, mirroring the proven **frontier kill-switch** (`lib/frontier-kill-switch.ts`, instant, zero-deploy) — halts all video submits fleet-wide.
  3. **Per-VM daily video-spend ceiling** (mirror frontier per-tier bands, `lib/frontier-policy.ts`) — caps a single runaway VM.
  4. **Every generation gated on explicit user confirm** (the quote step) — bounds prompt-injection/runaway loops.
  5. **No autonomous generation** — verified: heartbeats run an isolated session (`agents.defaults.heartbeat.session`), skills fire only on user messages. Keep this invariant; never let a cron/heartbeat path call the video skill.

### 13.4 Migration & fleet edge cases (folds into §4.5)

- **Credit-model cutover (count→weight):** existing users have count-based `instaclaw_video_usage` + a shared media `credit_balance`. Plan: introduce `video_credit_balance`; on cutover **grandfather a starting balance** (convert remaining media credits and/or seed goodwill — Cooper's call), **honor already-purchased media packs**, and message the change. Backfill migration idempotent + RLS (Rules 56/60).
- **Allowance vs paid precedence:** consume the daily free video allowance first (quote shows "free"), then `video_credit_balance`; the quote copy must distinguish the two.
- **In-flight jobs at cutover:** flip **create** to the official rail but keep the **Muapi poll path alive for one release** so pre-flip jobs still resolve (skill handles both id shapes); drain before retiring `MUAPI_API_KEY`/`SJINN_API_KEY`.
- **Rollback lever:** a single per-VM env flag selects the skill's upstream (+ the Muapi fallback branch). Rolling back is one env/fleet-push, no redeploy. Document the exact command in the build PR.
- **Nav coordination:** the `/dashboard/studio` nav entry must coordinate with the **in-flight sidebar-restructure** work (separate branch) so it lands in the right group (primary vs overflow) instead of colliding.
- **Skill propagation:** confirm whether higgsfield-video rides the `skillsFromRepo` git-sync or needs a manifest bump/fleet-push; state the chosen path in the build PR (Rule 47).

### 13.5 Ranked gaps

**Must-fix before ship:**
- **G1** — proxy enforces **full job cost** (estimate → atomic hold) before submit (fixes the weight-1 overdraft bug).
- **G2** — content-rejection path: no charge, calm message, never echo policy text, log for abuse.
- **G3** — failure/timeout/partial **refund state machine**, idempotent on `request_id` (§13.2).
- **G4** — Telegram **50MB delivery fallback** (link + Studio pin).
- **G5** — confirm Higgsfield **failed/rejected-job billing** (R9) + track platform loss.
- **G6** — **platform-credit-floor + `video_spend_kill_switch`** (§13.3).
- **G7** — **atomic, concurrency-safe hold** keyed on `request_id`.
- **G8** — **existing-user credit backfill** + cutover comms (§13.4).

**Nice-to-have:**
- **G9** in-flight Muapi drain · **G10** one-flag rollback doc · **G11** upload format/size constraints (Telegram image → CDN → Higgsfield UUID) · **G12** free-allowance vs paid precedence + quote copy · **G13** fleet rate-limit backoff/queue on one account · **G14** delivery idempotency.

### 13.6 What I still can't verify (stays on §11 asks, not papered over)
Higgsfield's **commercial terms** for one account funding the fleet; whether a **partner API key** exists; **refresh-token TTL**; **per-account rate limits**; **failed/rejected-job billing**; **wholesale pricing**. Each is an explicit ask in §11 — the architecture is designed to absorb either answer, but the numbers (margin, pack pricing, rate-limit sizing) can't be set until these land.

---

## 14. The Cloud API rail — build-and-try, no-wait (pass 3 — 2026-06-08)

### 14.1 Partner/server-key finding — **IT EXISTS, self-serve, on a separate rail**
There are **two official rails**, and pass-2 only inspected one:

| Rail | Host | Credential | Billing | Tools | Fit |
|---|---|---|---|---|---|
| **Cloud API** | `platform.higgsfield.ai` | **self-serve API key** `Key KEY_ID:KEY_SECRET` | pay-per-use | image, image→video, Soul, "100+ models" | **build-and-try + production fleet** |
| **Agent rail** | `fnf.higgsfield.ai/agents` | OAuth device-flow (consumer account) | consumer plan credits | the six agent tools incl. **Virality Predictor**, T2V studio | **BYO-account opt-in (Arch 4)** |

Keys mint self-serve at **`cloud.higgsfield.ai/api-keys`** (email/Google/Apple/MS sign-in). **No partner deal, no fleet OAuth, no human seat.** Pass-2's "no `HIGGSFIELD_API_KEY`" was right *for the consumer CLI binary* — the key lives in this distinct developer product. *(Don't confuse with `anil-matcha…mintlify "Open Higgsfield"` or pixazo/videogenapi/unifically — those are unofficial resellers.)* Verified: official SDK READMEs (`higgsfield-ai/higgsfield-client`, `higgsfield-ai/higgsfield-js`), `docs.higgsfield.ai`, OAuth-AS metadata (`grant_types_supported:["authorization_code","refresh_token"]` — no client_credentials/device_code on the agent AS).

### 14.2 Verified Cloud API facts
- Base `https://platform.higgsfield.ai`; auth header `Authorization: Key {KEY_ID}:{KEY_SECRET}`; env `HF_CREDENTIALS` (or `HF_KEY`) / `HF_API_KEY`+`HF_API_SECRET`; **server-side only** (SDK blocks browser).
- SDKs: Python `higgsfield-client`, **Node `@higgsfield/client` v2 (recommended)** — drops straight into our TS proxy.
- Submit `POST platform.higgsfield.ai/<model-path>` with `{input:{…}}` → `request_id`; poll `GET /requests/{id}/status`; cancel `/requests/{id}/cancel`. Lifecycle `queued → in_progress → {completed | failed | nsfw | cancelled}`; **`failed`/`nsfw` auto-refund credits** (answers R9 / §11-ask-7). Result `{images:[{url}], video:{url}}`. Webhooks via `?hf_webhook=<url>` + secret.
- Catalog (confirmed paths): image `bytedance/seedream/v4/text-to-image`, `flux-pro/kontext/max/text-to-image`; **image→video** `higgsfield-ai/dop/preview|standard`, `kling-video/v2.1/pro/image-to-video`, `bytedance/seedance/v1/pro/image-to-video`; `higgsfield-ai/soul/standard`. Docs claim **"100+ models"** + a Models Gallery. **Confirm at signup (self-serve):** text→video coverage, and whether **Virality Predictor** is on Cloud (it's an agent-rail tool; may be Cloud-absent → see §14.3).
- Pricing: **pay-per-use, $ rate not published in docs — visible in the cloud dashboard at signup.** Consumer-plan credit costs are only a *relative* anchor (Veo3-Fast 22cr/8s, Veo3 58cr/8s, Kling3.0 ~8.7cr, Nano-Banana-Pro ~2cr), not the Cloud $ rate.

### 14.3 No-wait credential decision (supersedes §4.2's credential sub-options)
**Arch 1 stands; the credential is concretely a single Cloud API key, server-side in our proxy.** This is strictly cleaner than the OAuth-platform-token sub-option — no device login, no refresh/rotation lifecycle. The OAuth-refresh path is demoted to "only if we ever need an agent-rail-only tool (e.g. Virality Predictor, a T2V studio model) under a platform account and Cloud doesn't expose it." **Arch 4 (BYO consumer account via device flow → agent rail) stays the opt-in power tier** and is the home of agent-only tools. If Virality Predictor is Cloud-absent, the "score virality" beat ships via (a) a later Cloud addition, (b) the agent rail under a platform account, or (c) a Phase-2 feature — it does **not** block the Phase-1 generate-and-deliver core.

### 14.4 Async design note (avoids the serverless-timeout trap — CLAUDE.md Rule 11)
Video takes 2–4 min; a blocking `withPolling` call would exceed Vercel's function limit. So the proxy `create` action = **submit + return `request_id` immediately** (no in-request blocking poll); completion arrives via **Higgsfield webhook → our `/api/gateway/higgsfield/webhook`** → settle credits + trigger delivery. The on-VM skill keeps its existing async "submitted — I'll ping you" UX.

### 14.5 Smallest canary slice that proves the rail (today, one account)
1. Sign up `cloud.higgsfield.ai` → mint key → **record the pay-per-use pricing shown in the dashboard** (closes the pricing unknown).
2. `HIGGSFIELD_CLOUD_KEY=KEY_ID:KEY_SECRET` in Vercel **server** env (`printf`, Rule 6). **Not** on VMs.
3. Minimal `/api/gateway/higgsfield` proxy — ONE action `create` (**image→video** via `kling-video/v2.1/pro/image-to-video` or `higgsfield-ai/dop/preview`) using `@higgsfield/client/v2`. Gateway-token auth in (`lookupVMByGatewayToken`); submit → return `request_id`; webhook → deliver.
4. Canary on **vm-1019**: user sends an image + "animate this" → skill → our proxy → Cloud API → webhook → delivered as a **native Telegram video** (+ the 50MB link/Studio fallback, §13.2 G4).
5. Then layer `cost`/estimate (confirm Cloud has a pre-cost endpoint; if not, seed a static per-model price table from the dashboard and reconcile against account debits) → the atomic credit hold → the rest.

**Minimum proof = one image→video through our proxy on one Cloud key, delivered to Telegram.** Credits, Studio page, model auto-select, virality, migration all layer on *after* the rail is green.

### 14.6 The one thing trying-it-ourselves can't resolve (email in parallel; does NOT block the canary)
Whether **one Cloud key may fund the whole ~164-VM fleet** under Higgsfield's ToS, plus **fleet-scale rate limits + volume pricing.** It's a developer API explicitly pitched for "social-media content generators / e-commerce visual tools / thousands of concurrent requests," so platform use is the *intended* use — but per-user-resale terms and limits aren't published. Email: *"InstaClaw — ~164 hosted agents — building on your Cloud API. Confirm multi-tenant/resale is permitted; share volume pricing + rate limits."* The canary (our own testing on one key) needs none of this resolved.

### 14.7 Updated §11 asks (most now self-serve-closed)
Self-serve closes most pass-2 asks: **API key ✓** (self-serve), **failed/rejected-job billing ✓** (auto-refund), **pricing ≈visible at signup**. **Remaining true asks for Higgsfield:** (1) fleet/multi-tenant ToS + rate limits + volume pricing (§14.6); (2) confirm Cloud catalog covers text→video + Virality Predictor (else agent-rail/later phase, §14.3). Everything else is build-and-try.

---

*Sources: `higgsfield.ai/mcp`; `github.com/higgsfield-ai/cli` (README, MODELS.md, install.sh, binary v0.1.40 linux/amd64); `github.com/higgsfield-ai/higgsfield-client` + `higgsfield-ai/higgsfield-js` (official Cloud SDKs); `docs.higgsfield.ai` (guides/video, how-to/introduction, llms.txt); `cloud.higgsfield.ai`; `mcp.higgsfield.ai/.well-known/oauth-protected-resource` + `/oauth-authorization-server`; in-repo code (`app/api/gateway/{muapi,sjinn}/route.ts`, `app/api/billing/credit-pack/route.ts`, `lib/telegram.ts`, `lib/ssh.ts`, `lib/frontier-{policy,kill-switch}.ts`, `vm-manifest.ts`, dashboard `layout.tsx`/`credits`/`billing`) as cited in Appendices D–E and §§13–14. Verified 2026-06-08 (pass 1 + pass 2 hardening + pass 3 no-wait build path).*
