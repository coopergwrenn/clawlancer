# PRD: Login with ChatGPT — Subscription OAuth + History Import

**Status:** Draft for engineering review. Three existential risks below must be resolved before code is written.
**Author:** Cooper (CEO) + Claude Opus 4.7
**Created:** 2026-05-18
**Target ship:** Phase 1 OAuth — 4 weeks from go. Phase 2 history import — +6 weeks.
**Announced:** Public Twitter thread on 2026-05-18 ("Login with ChatGPT, coming soon"). 100K+ impressions. Retraction would be costly; ship discipline must match.

---

## TL;DR

Two-half feature. **Half 1**: users authenticate with their ChatGPT Plus/Pro subscription via OAuth so their InstaClaw agent's primary inference is charged to OpenAI, not our Anthropic key. They pay us only for infrastructure (VM, wallet, memory, skills, autonomy). **Half 2**: users export their `conversations.json` from ChatGPT and we ingest 3 years of history into their agent's gbrain memory store via an AI-powered extraction pipeline — the agent already "knows" them on day one.

The PRD is built on real, verified primary-source research: the OpenAI Codex CLI source at `github.com/openai/codex` (auth flow, token shape, endpoints, model routing), the ChatGPT export schema verified against `expelledboy/chatgpt-zod-schema` + multiple production parsers, mem0's `ADDITIVE_EXTRACTION_PROMPT` (v3) + Graphiti's bi-temporal `valid_at/invalid_at` pattern + A-MEM's enriched note schema for the extraction pipeline, and an internal codebase audit covering `lib/ssh.ts`, `lib/billing-status.ts`, `lib/auth-cache.ts`, `lib/vm-reconcile.ts`, `lib/vm-manifest.ts`, and `instaclaw/scripts/install-gbrain.sh`. Every architectural decision is cited.

**No existing product** does AI-powered fact extraction from ChatGPT exports as a productized offering. **No competitor** auto-falls-back from subscription → API-key on rate-limit exhaustion. Both are green-field. If we ship them well, they're the headline differentiators.

The biggest risk is not the build; it's **Cloudflare's TLS-fingerprint bot detection** on `auth.openai.com` and `chatgpt.com/backend-api/codex/*`. Every InstaClaw VM is a Linode dedicated-CPU box on a cloud egress IP; multiple third-party Codex clients have hit 403s from cloud IPs while desktop installs work. Section 2.1 details the mitigation tree and the kill-switch if no mitigation works.

---

## Decision Log — Three Existential Risks

Three decisions Cooper must make before engineering starts. Each one can independently kill the feature.

| # | Risk | Decision needed | Default if no decision |
|---|------|-----------------|------------------------|
| 1 | Cloudflare/TLS fingerprint blocks Linode cloud IPs from reaching `auth.openai.com` and `chatgpt.com/backend-api/codex/*` | Pick a mitigation path: **(a)** native-tls + fingerprint matching, **(b)** route OAuth+inference through user-installed Cloudflare WARP on their home network, **(c)** proxy via residential IP pool, **(d)** abandon and use API-key BYOK only | Kill the feature; revert the Twitter announcement |
| 2 | OpenAI ToS unofficially tolerates third-party OAuth clients but expressly disclaims it. Existing third-party clients (`EvanZhouDev/openai-oauth`, opencode plugins) all reuse Codex's public client_id `app_EMoamEEZ73f0CkXaXp7hrann` without OpenAI permission. End-user takes the legal risk | Decide: **(a)** apply to OpenAI for a registered InstaClaw public client (formal partner path), **(b)** reuse Codex's client_id with explicit user disclosure (unofficial path, legal review required), **(c)** ship as a desktop helper the user runs themselves (we never hold the credential) | Block engineering until legal sign-off |
| 3 | Per-VM OAuth token storage adds a 5th token location (currently 4 per CLAUDE.md MEMORY.md) requiring a new Rule-34 verifier step + a `SECRET_VERSION`-style per-user distribution mechanism. Architecturally invasive | Approve the new column set on `instaclaw_users` + reconciler step `stepChatGPTOAuthToken` + per-user secret-version mechanism (`user.openai_token_version`) | Defer to a worse design |

---

## 1. Background and Strategic Intent

### 1.1 What we announced

Tweet (2026-05-18): "Login with ChatGPT, coming soon. Bring your existing OpenAI subscription to InstaClaw — your agent runs on YOUR subscription, with all 3 years of your ChatGPT history pre-loaded into its memory. Day one, it already knows you." 100K+ impressions in the first 18 hours, thread of 8 replies clarifying scope, ~200 retweets, ~40 quote-tweets including 3 from major AI influencers. The product window is real. If we miss the ship date or have to retract, that's a public reputation hit and an industry-watcher-level credibility hit.

### 1.2 Why this matters strategically

Three reasons:

**(a) Differentiation against Claude Code, Cursor, Windsurf, Continue, Aider.** All five tools handle multi-provider auth via API-key passthrough only (Cursor / Windsurf / Continue / Aider) or single-provider OAuth (Claude Code is Anthropic-only). None compose a user's *ChatGPT subscription* with infrastructure-as-a-service. InstaClaw becomes the only place a user can spend $20/mo on ChatGPT Plus AND get a persistent always-on agent with a wallet, memory, skills, and autonomy — without paying anyone twice for inference. (Source: research subagent comparing all six tools' auth models; Claude Code docs at `code.claude.com/docs/en/authentication`.)

**(b) Memory portability as a moat.** "Your agent already knows you" is the wow line, but the *strategic* value is creating a one-way export from ChatGPT to InstaClaw. Once a user has 1,247 conversations of extracted facts living in their InstaClaw gbrain, they have switching costs against ChatGPT. The agent gets smarter with every InstaClaw conversation; ChatGPT's memory doesn't get that benefit. Six months in, switching back means losing what InstaClaw learned.

**(c) Lower marginal cost on us.** Today every paying user runs against our Anthropic API key — bundled in $29-299/mo. Sonnet 4.6 at scale is meaningful gross margin pressure. If users bring their own ChatGPT subscription, our marginal inference cost drops to ~$0 for primary chat; only embeddings (us, OpenAI text-embedding-3-large), heartbeats (us, Anthropic Haiku), and the periodic Sonnet consolidation passes stay on our books. The new "BYOS" tier (§8) can sit at $14-$39/mo gross profit on infra alone.

### 1.3 The two halves

| Half | What | Phase | Value if Phase 1 ships standalone |
|------|------|-------|-----------------------------------|
| **OAuth** | User logs in with ChatGPT subscription. Their agent's primary chat is charged to OpenAI. We charge infra-only. | Phase 1 (4 weeks) | Massive on its own — first product to compose subscription + persistent agent. Unlocks the new BYOS tier. |
| **History import** | User exports `conversations.json` from ChatGPT. We extract 3 years of facts/preferences/projects into gbrain. Agent introduces itself "knowing" the user. | Phase 2 (+6 weeks) | The viral moment. The screenshot people share. But OAuth alone is sufficient to ship and start charging. |

Phasing is non-negotiable: Half 1 is the door, Half 2 is the rug pull. Shipping them together delays the door by 10 weeks. Shipping Half 1 standalone moves us in 4 weeks and creates a milestone the market can react to.

---

## 2. The Three Risks (read these before writing any code)

### 2.1 Cloudflare TLS-fingerprint blocking cloud-IP clients

**The bug.** OpenAI's `auth.openai.com` (OAuth) and `chatgpt.com/backend-api/codex/*` (inference) sit behind Cloudflare bot-detection. The official Codex CLI uses `native-tls` (macOS) or a specific TLS-fingerprint configuration that Cloudflare's challenge engine has been tuned to allow. Non-Codex clients using `reqwest`+`rustls` (the Rust default) or many Node.js HTTP stacks present a different fingerprint and trip the challenge — yielding `403 unsupported_country_region_territory` even from non-blocked countries.

**Evidence.**
- `openai/codex#14215`: OpenClaw user reports `403 unsupported_country_region_territory` on `/oauth/token` while the official `codex` CLI works on the same machine with the same network.
- `openai/codex#17860`: "Linux/WSL2: Cloudflare 403 blocks all chatgpt.com API requests — rustls TLS fingerprint detected as bot while macOS native-tls works fine on same network."
- `EvanZhouDev/openai-oauth` README explicitly warns about cloud-IP failures.

**Why this is fatal for our default architecture.** Every InstaClaw VM is a Linode dedicated CPU (`g6-dedicated-2`, `us-east`) — datacenter egress IP block. The agent process is Node.js (OpenClaw runtime), which would make outbound HTTPS calls to OpenAI from the VM. **High probability of Cloudflare 403** for either the OAuth flow or the inference calls, or both. We will not know how high until we measure.

**Mitigation options, ranked by feasibility.**

| Option | What | Pros | Cons | Phase to validate |
|--------|------|------|------|-------------------|
| **A. Native-TLS + fingerprint match in the OpenClaw OAuth/inference client** | Patch OpenClaw's outbound HTTP for OpenAI endpoints to use a TLS-fingerprint matcher (e.g., `boring`/`rustls-platform-verifier` for Rust, `undici` + custom TLS for Node) that mimics Codex's exact ClientHello | Lowest user-facing complexity; transparent | Cat-and-mouse with Cloudflare; OpenAI may tighten the rules; ongoing maintenance | Week 1 spike — measure 403 rate from 5 Linode VMs |
| **B. Server-side proxy through residential IP pool** | Route OpenAI requests through a residential proxy (Bright Data, Smartproxy, Oxylabs) that fronts the Linode egress | Proven to bypass Cloudflare bot detection; works for many similar use cases | Cost (~$3-10/GB at scale; meaningful at fleet-wide volumes); legal/ToS posture of residential proxies; latency tax | Week 2 spike if A fails |
| **C. User-installed Cloudflare WARP on their home network, agent calls via WARP tunnel** | Distribute a small WARP-config helper; agent's OpenAI calls tunnel back to user's home IP | Bypasses cloud-IP detection entirely; user takes the residential-IP tax | Massive UX burden (user installs WARP, keeps it on); breaks our "always-on cloud agent" promise | Last resort |
| **D. Hybrid — desktop helper for auth, VM for inference (or vice versa)** | OAuth runs on user's laptop (loopback flow), token shipped to VM. Inference attempts from VM first; if 403, fall back to laptop helper relay | Survives both gating modes; works in the degraded case | Complex; requires a long-running desktop sidecar; loses the "agent runs without you" property | If A+B both fail |
| **E. Abandon and use API-key BYOK only** | Skip OAuth; users add their OpenAI API key the old way | Trivial; no Cloudflare risk; no ToS risk | Defeats the entire Twitter announcement; users still pay per-token instead of using their subscription quota | Kill switch only |

**Required spike (week 1, before any other engineering).** Stand up a single Linode `g6-dedicated-2` in `us-east` (same shape as a real ready-pool VM). Attempt a Codex-shape OAuth flow against `auth.openai.com/oauth/authorize` with the public `app_EMoamEEZ73f0CkXaXp7hrann` client_id from the official `codex` CLI binary on the same VM. Also attempt with `node:undici` + default TLS, and with `node:undici` + manual `tls.connect` tuned to mimic Codex's ClientHello. Then attempt an inference call to `chatgpt.com/backend-api/codex/responses` from the same VM with the resulting token. **Measure 403 rate at each step.** If the official `codex` CLI fails on a Linode VM, Option A is dead and we go to B or kill. If it works but our wrapping fails, Option A is alive and we just need fingerprint matching.

The spike costs <$50 in Linode + 2 engineer-days. Do it before anything else. The PRD's entire technical plan downstream of this section assumes Option A (TLS-fingerprint match) works; if it doesn't, the PRD must be revised before Phase 1 engineering begins.

### 2.2 OpenAI ToS posture

**The state of the world.** Multiple third-party clients use Codex's public client_id `app_EMoamEEZ73f0CkXaXp7hrann` (source: `codex-rs/login/src/auth/manager.rs:928`) to authenticate users via PKCE and route inference through `chatgpt.com/backend-api/codex/*`. None of them have been C&D'd by OpenAI. None of them are explicitly authorized either. Every third-party README disclaims that "misuse may result in rate limits, suspension, or termination of your ChatGPT subscription" — the legal burden is on the end user, not the tool.

**Three paths forward.**

1. **Register InstaClaw as a public OAuth client with OpenAI.** Email partnerships@openai.com (or whatever the current channel is — research subagent noted no public application page exists). Argue we're a complementary product, not a substitute, and request a registered `app_*` client_id. Pros: legitimate, no fingerprint risk on the client_id, OpenAI can't quietly revoke us by tightening rules on Codex's client_id. Cons: probably 6-12 weeks of back-and-forth; may be declined. Doesn't match our 4-week Phase 1 timeline.

2. **Reuse `app_EMoamEEZ73f0CkXaXp7hrann` with explicit user disclosure.** Users see a checkbox: "I understand InstaClaw uses the OpenAI Codex OAuth client. OpenAI may revoke my access at any time. InstaClaw is not affiliated with OpenAI." Legal review required (compliance lead must sign off on the disclosure language). Pros: ships fast, matches the industry pattern. Cons: OpenAI could shut us down by revoking the client_id (would also break Codex though — unlikely they'd take that step casually); we have no legal recourse if they do.

3. **Ship as desktop helper.** User installs a tiny InstaClaw CLI on their laptop; it runs the OAuth flow locally and feeds the token to their VM via authenticated WebSocket. We never touch the credential except as a transit relay. Pros: closest to "user authorized this with their own tool, just like running Codex"; lowest legal risk. Cons: breaks our "no install required, just open the dashboard" UX; users on Chromebooks / iPads can't participate.

**Recommendation: Option 2 for Phase 1, parallel application for Option 1.** Move now with disclosed reuse; file the partnership application in parallel; switch to a registered client_id when (if) it lands. Get legal sign-off on the disclosure language before code is written.

### 2.3 The 5th token location

CLAUDE.md MEMORY.md documents 4 token locations that must stay in sync (per Rule 34): `auth-profiles.json`, `openclaw.json` (`gateway.auth.token`), `.env` (`GATEWAY_TOKEN`), and Supabase DB (`instaclaw_vms.gateway_token`). Adding ChatGPT OAuth tokens means a 5th: an OpenAI bearer JWT + refresh token, per-user (not per-VM), rotated independently.

**Decisions needed.**

- **Storage location on disk.** `~/.openclaw/agents/main/agent/openai-oauth.json` (mirrors Codex's `~/.codex/auth.json` shape) — file mode `0600`, owned by `openclaw` user.
- **Storage location in DB.** `instaclaw_users.openai_*` columns (token is per-user, not per-VM, because a user might add a second VM later and the token follows the user). Encrypted at rest with the same KMS pattern as BYOK Anthropic keys.
- **Reconciler step.** New `stepChatGPTOAuthToken` in `lib/vm-reconcile.ts`, modeled on `stepTelegramTokenVerify` per Rule 34. Reads on-disk JWT, compares against DB ciphertext (decrypted at compare time), writes if drifted, restarts gateway if `auth-profiles.json` or `openclaw.json` `agents.defaults.model.primary` changed.
- **Rotation mechanism.** Tokens refresh silently (Codex pattern, see §4.11). When refresh produces a new access_token / refresh_token, we MUST write to all three locations (DB + disk + in-memory cache) atomically. A separate `openai_token_version` per-user column (mirrors `SECRET_VERSION` from `lib/vm-reconcile.ts:136-156`) gates re-distribution to additional VMs the user owns.
- **Anthropic stays in `auth-profiles.json`.** We don't move the OpenAI token into the same file as Anthropic. They're separate profile entries.

Approve the structural changes (new columns, new step, new mechanism) before engineering starts. They're invasive enough to need an architecture sign-off, not just a PR.

---

## 3. User-facing scope

### 3.1 Half 1 — OAuth (subscription auth)

**What the user sees.** New CTA on signup ("Continue with ChatGPT") in addition to existing "Continue with Google." After Google sign-in (still required for InstaClaw account identity, billing, recovery), user sees:

```
Welcome to InstaClaw, Cooper.

How should your agent think?

[ ] Use my ChatGPT subscription
    Your agent runs on GPT-5.5 / GPT-5.4 — billed to your existing
    ChatGPT Plus or Pro account. You only pay InstaClaw for the
    infrastructure ($14/mo Starter).

[ ] Use InstaClaw's bundled inference (default)
    We provide Claude Sonnet 4.6, no setup. Standard pricing.

[ ] Use my own Anthropic API key (BYOK)
    Bring your Anthropic key. We charge $14-$99/mo for infra only.
```

If they pick option 1, they go through the OAuth dance (§4) and land on the same `/deploying` page. The agent comes up running GPT-5.x by default with their subscription quota.

**What changes under the hood.** A new value `chatgpt_oauth` for `instaclaw_users.api_mode` (joins existing `all_inclusive` / `byok`). A new shape for `auth-profiles.json` on the VM (the OpenAI profile is the bearer JWT + refresh; the Anthropic profile is either absent or holds a BYOK fallback key). The agent's `agents.defaults.model.primary` is set to `openai/gpt-5.5` (or whatever the current default is for that user's plan tier, queried at provision time from `https://chatgpt.com/backend-api/codex/models`).

### 3.2 Half 2 — History import

**What the user sees.** On the dashboard, a new card: "Make your agent already know you — import your ChatGPT history." Clicking it opens an in-app step-by-step:

```
Step 1: Open https://chatgpt.com/#settings (link click → opens in new tab)
Step 2: Click your profile picture → Settings → Data Controls → Export
Step 3: Wait for the email from OpenAI (usually < 30 min)
Step 4: Download the .zip from the link
Step 5: Drop it here ↓
        [drag-and-drop zone, accepts .zip up to 1 GB]
```

After upload, a status modal:

```
✓ Uploaded (47 MB)
✓ Parsing (1,247 conversations found)
↻ Extracting facts (35% — ~4 min remaining)
   You can close this; we'll text you when done.
```

When extraction completes, the agent sends them a Telegram message (matching the existing channel where they get their agent's notifications):

```
Hey Cooper. I just finished reading 1,247 conversations from your ChatGPT
history (3 years of context, 14M tokens).

Here's what I know about you:
You're a senior engineer at Stripe working on payments infrastructure,
you love hiking in Yosemite, you're learning Japanese, your girlfriend's
name is Sarah, you prefer dark roast coffee (Stumptown specifically),
and you've been thinking about starting a company in the climate space.

Did I get anything wrong? Reply to fix.

(I'll remember this from here on. You won't have to re-introduce
yourself again.)
```

**The hardware.** 247 extracted facts. 12 named entities resolved (Sarah, Stripe, Yosemite, Stumptown, etc.). 8 active projects identified. Communication-style profile in one paragraph. All written into gbrain pages under `profile/`, `preferences/`, `projects/`, `relationships/` with source-conversation provenance for every fact (so user can ask "where did you learn that?" and get the original ChatGPT conversation back).

### 3.3 Phasing summary

| Phase | Scope | Eng-weeks (estimate) | Calendar |
|-------|-------|----------------------|----------|
| **0 — Spike** | Cloudflare TLS spike (§2.1) + OpenAI partnership outreach (§2.2) | 1 | Week 1 |
| **1 — OAuth** | Subscription auth, model routing, per-call fallback, new BYOS tier | 4 | Weeks 2-5 |
| **2 — History import** | Upload pipeline, parser, extraction, gbrain ingestion, jaw-drop message | 6 | Weeks 6-11 |
| **3 — Ongoing sync** | Periodic re-export reminder, real-time bridge if OpenAI ever exposes one | TBD | Post-launch |

Phase 1 ships standalone — the Twitter announcement is satisfied by "Login with ChatGPT" alone. Phase 2 is the viral moment.

---

## 4. Half 1 — ChatGPT OAuth deep design

This section assumes the §2.1 Cloudflare spike succeeds (Option A: TLS-fingerprint match) and §2.2 lands on Option 2 (reuse Codex's client_id with disclosed UX + legal review). Adjustments to other paths are noted inline.

### 4.1 The OAuth flow (verified against `github.com/openai/codex`)

All endpoints and client identifiers verified against the actual `codex-rs` source — citations are file:line.

**Public client ID:** `app_EMoamEEZ73f0CkXaXp7hrann` (source: `codex-rs/login/src/auth/manager.rs:928`).
**Issuer:** `https://auth.openai.com` (constant `DEFAULT_ISSUER` in `codex-rs/login/src/server.rs`).
**Authorization endpoint:** `GET https://auth.openai.com/oauth/authorize`
**Token endpoint:** `POST https://auth.openai.com/oauth/token`
**Revoke endpoint:** `POST https://auth.openai.com/oauth/revoke`
**PKCE:** S256 (SHA-256 of a 64-byte random verifier, URL-safe base64 no padding).

**Scopes (verbatim from `server.rs build_authorize_url`):**
```
openid profile email offline_access api.connectors.read api.connectors.invoke
```

**Required extra query params on `/oauth/authorize`:**
- `id_token_add_organizations=true` — asks the IdP to embed org/workspace membership into the ID token JWT
- `codex_cli_simplified_flow=true` — server-side feature flag
- `originator=<value>` — install fingerprint (we generate per-user, persist on `instaclaw_users`)
- `state=<32 bytes base64url>` — CSRF protection, validated on callback

**Token exchange request** (verbatim shape):
```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<auth_code>
&redirect_uri=<our_callback>
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&code_verifier=<pkce_verifier>
```

**Refresh request** (note: different content-type from auth-code exchange — Codex source confirms this is JSON, not form):
```
POST https://auth.openai.com/oauth/token
Content-Type: application/json

{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":"..."}
```

### 4.2 Token shape + storage

Tokens are JWTs with documented claims (source: `codex-rs/login/src/token_data.rs`). The ID token payload contains:

```json
{
  "email": "user@example.com",
  "https://api.openai.com/profile": {"email": "user@example.com"},
  "https://api.openai.com/auth": {
    "chatgpt_plan_type": "plus",
    "chatgpt_user_id": "user-...",
    "chatgpt_account_id": "acc-...",
    "chatgpt_account_is_fedramp": false
  },
  "exp": 1747000000
}
```

`chatgpt_plan_type` is one of: `free | plus | pro | business | enterprise | edu`. **We use this for tier-gating without an extra API call** — copying Codex's pattern.

The **access token** is also a JWT carrying the same plan/account claims plus `organization_id`, `project_id`. We decode it on every refresh and persist the relevant claims to `instaclaw_users.chatgpt_plan_type` (cached for routing decisions).

**Token lifetimes** (UNVERIFIED, marked clearly in PRD): Codex source reads `exp` from JWT for expiry; the actual TTL is whatever OpenAI sets. Community reports suggest ~28 days for access tokens and ~year-ish for refresh tokens but I have no primary source. Treat as a probe: log the `exp` of the first 100 tokens we issue, derive the distribution, document the actual TTL after Phase 1 launch.

**Refresh-token rotation is mandatory.** Every refresh response returns a new refresh_token. **Using an old refresh_token twice fails permanently** with `error.code = "refresh_token_reused"` (source: `codex-rs/login/src/auth/manager.rs:864`, with class `RefreshTokenFailedReason::Exhausted`). **Concurrency control is load-bearing:** two processes refreshing the same auth.json simultaneously will produce one valid new pair + one permanent lockout. Our reconciler-driven distribution mechanism (§4.6, §4.7) MUST serialize refresh through a Postgres row-level lock on `instaclaw_users.openai_token_version` (`SELECT ... FOR UPDATE`).

**Storage shape (on disk, mirrors Codex's `auth.json`):**

File: `~/.openclaw/agents/main/agent/openai-oauth.json` on every VM the user owns, mode `0600`, owned by `openclaw` user.

```json
{
  "auth_mode": "Chatgpt",
  "tokens": {
    "id_token": "<JWT>",
    "access_token": "<JWT>",
    "refresh_token": "<opaque>",
    "account_id": "acc-..."
  },
  "last_refresh": "2026-05-18T16:00:00Z",
  "claims_cache": {
    "chatgpt_plan_type": "plus",
    "chatgpt_account_id": "acc-...",
    "chatgpt_user_id": "user-...",
    "exp": 1747000000
  }
}
```

**Storage shape (in DB):**

Columns on `instaclaw_users`:
- `openai_oauth_access_token TEXT` — encrypted with KMS, same pattern as `api_key`
- `openai_oauth_refresh_token TEXT` — encrypted
- `openai_oauth_id_token_claims JSONB` — decoded claims subset (plan_type, account_id, email, exp). Cleartext (not sensitive without the tokens).
- `openai_oauth_expires_at TIMESTAMPTZ` — derived from access token `exp`
- `openai_oauth_last_refresh_at TIMESTAMPTZ`
- `openai_oauth_account_id TEXT` — workspace identifier from id_token claim
- `openai_token_version INTEGER NOT NULL DEFAULT 0` — per-user rotation counter; bumped on every successful refresh. VM rows get a sibling `vm.openai_token_version_synced` so reconciler can detect drift.

**Encryption.** Reuse the existing BYOK Anthropic key encryption helper in `lib/billing-status.ts` (audit confirms `instaclaw_users.api_key` is the existing precedent — find the helper, lift the pattern). If no helper exists today, add `lib/secret-encryption.ts` mirroring `lib/freeze-encryption.ts` (Rule 53). AES-256-GCM with versioned key id (`FREEZE_ARCHIVE_KEY_CURRENT` pattern). New env vars: `OPENAI_OAUTH_KEY_CURRENT`, `OPENAI_OAUTH_KEY_V1`.

### 4.3 Two flows — Device Code wins for our shape

Codex implements both **browser PKCE with loopback** (`codex-rs/login/src/server.rs run_login_server`) and **OAuth Device Code** (`codex-rs/login/src/device_code_auth.rs run_device_code_login`). Both end at the same `/oauth/token` exchange.

**Why Device Code is the right primary flow for InstaClaw.** Our user is sitting in their web browser on `instaclaw.io`. The VM is in a Linode datacenter; it has no browser. Browser PKCE with loopback would require a callback URL on the user's machine — that means they'd need a desktop helper, which is the friction we're trying to avoid.

The Device Code flow lets the user authenticate on `auth.openai.com` directly in their web browser and have the resulting tokens shipped to their VM by us. End-to-end:

1. User clicks "Continue with ChatGPT" in InstaClaw dashboard.
2. Our backend (`/api/auth/openai/device-code/start`) POSTs to `https://auth.openai.com/api/accounts/deviceauth/usercode` with `{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}`. Returns `{user_code, device_auth_id, verification_uri, interval, expires_in}`.
3. We show the user: "Go to https://auth.openai.com/codex/device and enter code `ABCD-1234`. Or click here to open it for you." Open a popup pre-filled with the code.
4. Backend polls `POST https://auth.openai.com/api/accounts/deviceauth/token` with `{device_auth_id, user_code}` every `interval` seconds. Returns 403/404 while pending, 200 with `{authorization_code, code_challenge, code_verifier}` on success.
5. Backend exchanges the auth code at `/oauth/token` (`redirect_uri = https://auth.openai.com/deviceauth/callback` per Codex source).
6. Backend persists access/refresh tokens (encrypted) to `instaclaw_users`.
7. Reconciler picks up the new token on next tick and writes to the VM (§4.6).
8. UI redirects to `/deploying` showing "Your agent is being configured with your ChatGPT subscription."

**Total time visible to user: 30-60 seconds.** They never leave InstaClaw's flow.

**Device Code timeout: 15 minutes** (per Codex source). Polling interval: server-supplied. If user abandons, the device_auth_id expires; we offer a "Try again" button.

### 4.4 Where OAuth lives in the DB (concrete schema)

Migration `instaclaw/supabase/pending_migrations/20260518000000_chatgpt_oauth.sql` (note: per **CLAUDE.md Rule 56**, write to `pending_migrations/` first, then move to `migrations/` only after applying to prod):

```sql
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

ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS openai_token_version_synced INTEGER NOT NULL DEFAULT 0;

-- Extend the api_mode enum (or check constraint, depending on current shape)
-- Existing: 'all_inclusive' | 'byok'
-- New: 'chatgpt_oauth'
-- Check current constraint and extend; example assuming a check:
ALTER TABLE instaclaw_users DROP CONSTRAINT IF EXISTS instaclaw_users_api_mode_check;
ALTER TABLE instaclaw_users ADD CONSTRAINT instaclaw_users_api_mode_check
  CHECK (api_mode IN ('all_inclusive', 'byok', 'chatgpt_oauth'));

-- Track OAuth flow in progress (for the device-code polling state)
CREATE TABLE IF NOT EXISTS instaclaw_oauth_device_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,  -- 'openai_codex' for now; extensible
  device_auth_id TEXT NOT NULL,
  user_code TEXT NOT NULL,
  verification_uri TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'completed' | 'expired' | 'denied'
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS instaclaw_oauth_device_flows_user_status
  ON instaclaw_oauth_device_flows(user_id, status, expires_at);
```

### 4.5 Where OAuth lives on the VM

Two on-disk artifacts and one config-key change:

**Artifact 1: `~/.openclaw/agents/main/agent/openai-oauth.json`** — shape per §4.2. Written by `configureOpenClaw()` on initial setup and by `stepChatGPTOAuthToken` (new reconciler step, §4.6) on rotation. Mode `0600` enforced. Atomic write via `tmp + os.replace` (matches the strip-thinking.py atomic-write pattern from Rule 22).

**Artifact 2: `~/.openclaw/agents/main/agent/auth-profiles.json`** — extended to include the `openai:default` profile:

```json
{
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "<BYOK_KEY_OR_INSTACLAW_GATEWAY_TOKEN>",
      "baseUrl": "<INSTACLAW_GATEWAY_URL_OR_EMPTY>"
    },
    "openai:default": {
      "type": "oauth_bearer",
      "provider": "openai",
      "bearer_token_path": "/home/openclaw/.openclaw/agents/main/agent/openai-oauth.json",
      "baseUrl": "https://chatgpt.com/backend-api/codex"
    }
  }
}
```

The `bearer_token_path` indirection is intentional — OpenClaw's runtime reads the path and pulls the current access_token from the JWT-cache file on every request, not from `auth-profiles.json` directly. This lets us rotate the token (write to `openai-oauth.json`) without rewriting `auth-profiles.json` (which would invalidate other entries' caches).

If OpenClaw's runtime doesn't support `bearer_token_path` indirection today (audit subagent didn't confirm — flag as a question for the OpenClaw side), we add that feature as a small upstream patch in Phase 1 week 2.

**Artifact 3: `openclaw.json` config-key change.** `agents.defaults.model.primary` becomes per-user. For `chatgpt_oauth` users:

```
agents.defaults.model.primary: "openai/<discovered_model>"
```

Where `<discovered_model>` is queried from `GET https://chatgpt.com/backend-api/codex/models` at provision time (the user's account-specific available models, e.g. `gpt-5.5`, `gpt-5.4`). We store the chosen model on `instaclaw_users.default_model` and the reconciler pushes it via `stepConfigSettings` per Rule 32 (this is a `messages.*`-adjacent key — verify hot-reload behavior in Phase 1 spike).

### 4.6 Rule 34 application — DB↔disk sync

New reconciler step `stepChatGPTOAuthToken` in `lib/vm-reconcile.ts`, modeled on `stepTelegramTokenVerify` (the Rule 34 reference implementation). Inserted in the orchestrator chain after `stepFiles` and before `stepConfigSettings`.

Pseudocode:

```ts
async function stepChatGPTOAuthToken(ssh, vm, result) {
  // Only run for chatgpt_oauth users
  const user = await getSupabase()
    .from("instaclaw_users")
    .select("*")
    .eq("id", vm.assigned_to)
    .single();
  if (user.data?.api_mode !== "chatgpt_oauth") return;
  if (!user.data.openai_oauth_access_token) {
    result.errors.push("chatgpt_oauth user has no token in DB — onboarding incomplete");
    return;
  }

  // Compare DB version vs VM-synced version
  if (vm.openai_token_version_synced >= user.data.openai_token_version) {
    result.alreadyCorrect.push("openai-oauth.json: in sync");
    return;
  }

  // Read on-disk
  const diskState = await ssh.execCommand(
    `cat /home/openclaw/.openclaw/agents/main/agent/openai-oauth.json 2>/dev/null || echo ""`
  );
  const diskJson = parseJsonOrNull(diskState.stdout);

  // Decrypt DB token
  const accessToken = decryptSecret(user.data.openai_oauth_access_token, /* key_id */);
  const refreshToken = decryptSecret(user.data.openai_oauth_refresh_token, /* key_id */);

  const expected = {
    auth_mode: "Chatgpt",
    tokens: {
      id_token: /* re-derive from claims */ user.data.openai_oauth_id_token_claims.raw_jwt,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: user.data.openai_oauth_account_id,
    },
    last_refresh: user.data.openai_oauth_last_refresh_at,
    claims_cache: user.data.openai_oauth_id_token_claims,
  };

  if (deepEqual(diskJson, expected)) {
    // Disk already matches but version counter was stale — fix the counter
    await getSupabase()
      .from("instaclaw_vms")
      .update({ openai_token_version_synced: user.data.openai_token_version })
      .eq("id", vm.id);
    result.alreadyCorrect.push("openai-oauth.json: content matches; counter synced");
    return;
  }

  // Drift detected — push expected to disk via base64-encoded atomic write
  const payload = Buffer.from(JSON.stringify(expected)).toString("base64");
  const script = `
    set -e
    umask 077
    mkdir -p /home/openclaw/.openclaw/agents/main/agent
    echo "${payload}" | base64 -d > /home/openclaw/.openclaw/agents/main/agent/openai-oauth.json.tmp
    chmod 600 /home/openclaw/.openclaw/agents/main/agent/openai-oauth.json.tmp
    mv /home/openclaw/.openclaw/agents/main/agent/openai-oauth.json.tmp \\
       /home/openclaw/.openclaw/agents/main/agent/openai-oauth.json
    echo "OPENAI_OAUTH_WRITE_OK"
  `;
  const writeResult = await ssh.execCommand(script);
  if (!writeResult.stdout.includes("OPENAI_OAUTH_WRITE_OK")) {
    result.errors.push(`openai-oauth.json write failed: ${writeResult.stderr.slice(-200)}`);
    return;
  }

  // Verify-after-write (Rule 23 sentinel discipline)
  const verifyResult = await ssh.execCommand(
    `python3 -c "import json; d=json.load(open('/home/openclaw/.openclaw/agents/main/agent/openai-oauth.json')); print(d['tokens']['access_token'][:20])"`
  );
  if (!verifyResult.stdout.trim().startsWith(accessToken.slice(0, 20))) {
    result.errors.push("openai-oauth.json verify-after-write failed");
    return;
  }

  // Update VM counter
  await getSupabase()
    .from("instaclaw_vms")
    .update({ openai_token_version_synced: user.data.openai_token_version })
    .eq("id", vm.id);

  result.fixed.push(`openai-oauth.json: rotated to version ${user.data.openai_token_version}`);
  // Token rotation triggers in-process re-read on the OpenClaw runtime side via the
  // bearer_token_path indirection — no gateway restart required.
}
```

Key properties (all required for Rule-34 compliance):
- **Read-compare-write-verify discipline.** Reads disk, compares, writes only on drift, re-reads to verify the write landed (per Rule 10).
- **Idempotent.** No-op when in sync. Safe to run on every reconcile tick.
- **Per-user, not per-VM, source-of-truth.** All VMs the user owns get synced from the same DB row.
- **No gateway restart required for token rotation** (because of the `bearer_token_path` indirection). Saves cold-start time on every rotation.
- **Errors block cv-bump.** `result.errors` → `pushFailed` → cv held. Per Rule 39, this is a critical step (token missing means agent can't make any OpenAI call), not optional.

### 4.7 SECRET_VERSION application — token rotation

The existing `SECRET_VERSION` mechanism in `lib/vm-reconcile.ts:136-156` rotates fleet-wide secrets (env vars in `SECRET_ENV_VAR_SOURCES`). Per-user OAuth tokens need a similar but per-user mechanism:

- **`instaclaw_users.openai_token_version`** is bumped (+1) every time the access/refresh token pair is replaced (initial issuance, scheduled refresh, account-mismatch re-auth).
- **The reconcile-fleet cron** (`app/api/cron/reconcile-fleet/route.ts`) already filters candidates by `config_version.lt.<VM_MANIFEST.version>`. We extend the filter to also include `openai_token_version_synced < instaclaw_users.openai_token_version` via a join (or a new candidate-include path). VMs whose user's token has rotated re-enter the candidate set; `stepChatGPTOAuthToken` syncs and bumps `openai_token_version_synced` on success.

**The fast path for token rotation.** When a refresh happens (initiated by our cron, §4.11), we (a) write the new token to DB, (b) bump `openai_token_version`. Within one reconcile tick (≤3 min), every VM the user owns has the new token on disk.

**Cron for proactive refresh.** New `/api/cron/refresh-openai-oauth-tokens` running every 5 minutes:

```ts
// Find users whose access token expires within the next 30 minutes
const candidates = await supabase
  .from("instaclaw_users")
  .select("id, openai_oauth_refresh_token, openai_oauth_expires_at, openai_token_version")
  .eq("api_mode", "chatgpt_oauth")
  .lt("openai_oauth_expires_at", new Date(Date.now() + 30 * 60 * 1000).toISOString())
  .order("openai_oauth_expires_at", { ascending: true })
  .limit(50); // Bounded per-tick cost

for (const user of candidates.data ?? []) {
  // Row-level lock (CRITICAL: refresh_token reuse causes permanent lockout)
  await supabase.rpc("acquire_user_token_lock", { user_id: user.id });
  try {
    const result = await refreshOpenAIToken(user);
    if (result.success) {
      await supabase.from("instaclaw_users").update({
        openai_oauth_access_token: encryptSecret(result.access_token),
        openai_oauth_refresh_token: encryptSecret(result.refresh_token),
        openai_oauth_id_token_claims: decodeIdToken(result.id_token),
        openai_oauth_expires_at: deriveExpiry(result.access_token),
        openai_oauth_last_refresh_at: new Date(),
        openai_token_version: user.openai_token_version + 1,
        chatgpt_plan_type: decodeIdToken(result.id_token).chatgpt_plan_type,
        chatgpt_plan_last_seen_at: new Date(),
      }).eq("id", user.id);
    } else {
      // Classify failure (§4.11), surface to user, possibly suspend
      await handleRefreshFailure(user, result);
    }
  } finally {
    await supabase.rpc("release_user_token_lock", { user_id: user.id });
  }
}
```

Cron interval: 5 minutes. Per-tick batch: 50 users. Locks: per-user Postgres row lock (`SELECT ... FOR UPDATE` via RPC). Concurrent runs blocked by `instaclaw_cron_locks` per existing pattern (`lib/cron-lock.ts`).

### 4.8 Model routing on a ChatGPT-authed VM

The agent's primary model becomes `openai/<discovered_model>`. The OpenClaw runtime (which is the Claude Code fork) needs to support routing to `https://chatgpt.com/backend-api/codex/responses` when the configured model is OpenAI and the auth-profile is `oauth_bearer`-typed.

**Audit subagent's finding:** today's `toOpenClawModel` in `lib/ssh.ts:4032-4035` only maps Anthropic model names. The function and the underlying OpenClaw runtime need extension to support `openai/*` model prefixes routed to OpenAI's subscription-auth endpoint.

**Extensions required in OpenClaw runtime (upstream patch, must coordinate with OpenClaw maintainers):**

1. **New auth-profile type `oauth_bearer`.** Reads `bearer_token_path` from the profile entry, opens that file on every request to get the current `tokens.access_token` JWT. Decodes `exp`; if within `< 5 min` window or already expired, blocks for a refresh (waits on a refresh notification or triggers our cron via a side-channel HTTP call to `https://instaclaw.io/api/oauth/refresh-now?user_id=...`).

2. **New provider `openai_subscription`.** Distinct from existing `openai` (API-key path). Routes to `https://chatgpt.com/backend-api/codex/responses`. Sets headers per Codex source (`codex-rs/model-provider/src/bearer_auth_provider.rs`):
   ```
   Authorization: Bearer <access_token>
   ChatGPT-Account-ID: <chatgpt_account_id>
   X-OpenAI-Fedramp: true  ← only if chatgpt_account_is_fedramp claim is true
   ```

3. **Responses API wire format.** Codex uses OpenAI's Responses API, not chat-completions. Wire format docs: `https://developers.openai.com/api-reference/responses`. OpenClaw's existing OpenAI provider likely supports chat-completions; we need a Responses-API adapter. Verify in OpenClaw source whether this exists. If not, ~1 engineer-week to implement.

4. **Model routing in `agents.defaults.model.primary` schema.** The config key value moves from Anthropic-only (`claude-sonnet-4-6`) to provider-prefixed (`openai/gpt-5.5` | `anthropic/claude-sonnet-4-6`). Backward compatibility: unprefixed values default to Anthropic (existing behavior).

### 4.9 The multi-provider story

This is the architecture answer to Cooper's design question: "if a user signs up with their OpenAI subscription, can they STILL use Anthropic models somehow?"

**Yes.** Three concrete tracks coexist on a `chatgpt_oauth` user's VM:

| Track | Model | Cost owner | When it fires |
|-------|-------|------------|---------------|
| **Primary chat** | `openai/gpt-5.5` (or user-selected) | User's ChatGPT subscription | Every user-initiated turn |
| **Heartbeats** | `anthropic/claude-haiku-4-5` | InstaClaw (platform cost — Haiku is cheap, low-token, frequent) | Background heartbeat cycles per agent design |
| **Embeddings** | `openai/text-embedding-3-large` | InstaClaw (our OPENAI_API_KEY) | gbrain index, match-embeddings, etc. |
| **Anthropic BYOK fallback (optional)** | `anthropic/<user-chosen>` | User's Anthropic key (added via dashboard) | User-invoked via slash command or per-conversation selector |
| **Per-call sub-quota fallback** | `anthropic/claude-sonnet-4-6` on our key | InstaClaw (platform spend) | When user's OpenAI sub returns 429 mid-turn — see §4.10 |

The user can never be "locked into one provider just because they logged in with the other." A `chatgpt_oauth` user can also add an Anthropic API key via dashboard → Settings → Models, which registers as a second profile in `auth-profiles.json`. Slash commands like `/model claude-opus-4-6` route to that profile.

**Heartbeats stay on our key always.** Per Cooper's note: heartbeats use Haiku at weight 0.2 and are platform-cost (background ping pattern, not user-driven inference). We keep using our Anthropic key for them regardless of user's auth mode. Same for embeddings.

### 4.10 Per-call fallback (the moat)

**No competitor does this** (research confirms across Claude Code, Cursor, Windsurf, Continue, Aider, Codex). It's our differentiating feature.

**The mechanism.** When a primary-chat call to `chatgpt.com/backend-api/codex/responses` returns 429 ("subscription quota exhausted"), the OpenClaw runtime catches the error, surfaces a small "(switching to InstaClaw backup)" hint to the user, and retries with the Anthropic Sonnet profile on our key. The user's conversation continues without interruption.

**The cost guard.** We need a per-user monthly cap on fallback usage (so a user with a free ChatGPT account can't drain our Anthropic budget by hitting 429s constantly). New columns:

- `instaclaw_users.openai_fallback_tokens_used_this_period BIGINT NOT NULL DEFAULT 0`
- `instaclaw_users.openai_fallback_tokens_cap_this_period BIGINT NOT NULL DEFAULT <tier_cap>`
- `instaclaw_users.openai_fallback_period_start TIMESTAMPTZ`

Caps per tier (tunable, initial proposal):
- BYOS Starter ($14): 50K tokens fallback / month (~10 conversations on Sonnet)
- BYOS Pro ($39): 250K tokens / month
- BYOS Power ($99): 1M tokens / month

When the cap is exhausted, the fallback stops working; user sees "You've used your monthly InstaClaw backup quota. Either wait until {next_billing_date} or add your own Anthropic API key for unlimited Claude fallback."

**Detection:** the cron `/api/cron/track-fallback-usage` ticks every hour, queries the proxy logs for `openai_fallback` events, increments the counter, alerts admin if any user is on track to exhaust 90% of their cap (so we can up-sell them or investigate abuse).

**This is the moat.** "Your subscription powers your agent — and if you hit your OpenAI limit, we automatically catch you with Claude. You never see a quota error mid-conversation." Verbatim Twitter copy.

### 4.11 Five named refresh failures (verbatim from Codex)

Codex source (`codex-rs/login/src/auth/manager.rs:858-906`) documents five distinct refresh-failure modes. **Copy verbatim.** Generic "auth failed" errors are useless; users need to know exactly what happened.

| Error code from OpenAI | Our internal classification | User-facing copy |
|------------------------|-----------------------------|------------------|
| `refresh_token_expired` | `RefreshTokenFailedReason::Expired` | "Your ChatGPT login has expired. Please reconnect your ChatGPT account in Settings → Account → Reconnect." |
| `refresh_token_reused` | `RefreshTokenFailedReason::Exhausted` | "Your ChatGPT login was used by another process. This usually means an old session is still active. Please reconnect." |
| `refresh_token_invalidated` | `RefreshTokenFailedReason::Revoked` | "Your ChatGPT login was revoked (you may have changed your password or revoked InstaClaw's access). Please reconnect." |
| (other 401) | `RefreshTokenFailedReason::Other` | "Couldn't refresh your ChatGPT login. Please reconnect." |
| Account mismatch on refresh | `RefreshTokenFailedReason::AccountMismatch` | "The ChatGPT account on file doesn't match the account you're currently signed into. Please reconnect with the correct account." |

When any of these fires:
1. Set `instaclaw_users.api_mode = 'byok'` (or `'all_inclusive'` if user has no BYOK key) — fall back to existing inference so agent stays usable.
2. Set `instaclaw_users.openai_oauth_*` fields to NULL (token data is dead).
3. Send Telegram message to user with the appropriate copy + a deep link back to `/settings/account/reconnect-chatgpt`.
4. Log `OPENAI_TOKEN_REFRESH_FAILED` with reason code for monitoring.

### 4.12 Plan downgrade detection

OpenAI doesn't fire a webhook when a user downgrades from Pro to Plus to Free. **Detection is client-side via JWT claim re-read after every refresh.**

After every successful refresh:
1. Decode the new id_token JWT.
2. Read `chatgpt_plan_type` claim.
3. Compare against `instaclaw_users.chatgpt_plan_type` (last cached value).
4. If changed:
   - **Upgrade** (free → plus, plus → pro, etc.): silent; update cached value. May unlock new models on `agents.defaults.model.primary`.
   - **Downgrade**: depends on direction.
     - `pro → plus` or `plus → free`: agent may lose access to certain models. Send notification: "Your ChatGPT plan changed to {new}. Some models may no longer be available; we've switched your agent to {new_default}."
     - `pro/plus → free`: depending on whether free tier can use Codex API at all (unknown — needs verification). If not, we treat it as an effective subscription cancellation and fall back to BYOK/all-inclusive per §4.11 logic.
5. If `chatgpt_plan_type == "free"` and Codex returns 402/403 on inference, treat as cancellation (fallback to BYOK or all-inclusive).

### 4.13 Rate-limit handling (429s)

Per Codex source + community reports:

- **HTTP 429** from `chatgpt.com/backend-api/codex/responses` when user's 5h or weekly quota is exhausted.
- **Error body** (UNVERIFIED for subscription endpoint specifically; API endpoint shape is `{"error":{"message":"...","type":"invalid_request_error","code":"rate_limit_exceeded"}}` — verify Phase 1).
- **No `Retry-After` header guaranteed** — community reports show 429s near end-of-window can fire even with quota remaining (`openai/codex#9135`).

**Our handling:**

1. Catch 429 in OpenClaw runtime.
2. Trigger per-call fallback (§4.10) — retry with Anthropic Sonnet immediately.
3. Mark user's `instaclaw_users.openai_quota_exhausted_until` timestamp (1 hour from now, conservative — the 5h sliding window means we re-probe periodically).
4. While the timestamp is in the future, NEW chats route directly to fallback (skip the 429 round-trip).
5. Background re-probe every 30 min: send a 1-token test request to OpenAI; on 200, clear `openai_quota_exhausted_until` and resume normal routing.

This means a user who hits 429 keeps having a working agent — the fallback kicks in transparently and they just see a small UI hint that they're on "InstaClaw backup." When OpenAI quota refreshes, they auto-resume on their subscription.

### 4.14 Reconciler integration

Step list for a `chatgpt_oauth` user's VM (new steps in bold):

1. stepDiskGuard
2. stepSystemPackages
3. stepFiles (now includes `openai-oauth.json` writer when `chatgpt_oauth`)
4. **stepChatGPTOAuthToken** (NEW — §4.6)
5. stepEnvVarPush (no change; OpenAI tokens are NOT env-var-distributed, they live in their own file)
6. stepConfigSettings (now pushes `agents.defaults.model.primary = openai/<model>`)
7. stepAuthProfiles (extended to write the new `openai:default` profile entry)
8. stepGatewayRestart (only if model.primary changed or auth-profiles.json restructured — token-only rotation does NOT trigger restart)
9. Remaining existing steps unchanged

### 4.15 Onboarding integration

The Rule-33 state machine gains one new state at signup-time:

```
ANONYMOUS → [Google OAuth] → CONNECTED → [/api/onboarding/save] → PENDING
                                                                    │
                              ┌─────────────────────────────────────┤
                              ▼                                     ▼
                    [Stripe checkout completes]          [ChatGPT OAuth completes — NEW]
                              │                                     │
                              ▼                                     ▼
                       PAID_NO_VM                          OAUTH_PAID_NO_VM (NEW)
                              │                                     │
                              └──────────┬──────────────────────────┘
                                         ▼
                                 [pool assignment in
                                  process-pending / verify / webhook]
                                         │
                                         ▼
                                 ASSIGNED_CONFIGURING
                                         │
                                         ▼ [configureOpenClaw atomic write +
                                            supplemental update succeeds]
                                 FULLY_ONBOARDED
```

`OAUTH_PAID_NO_VM` differs from `PAID_NO_VM` in two ways:

1. The Stripe checkout flow uses BYOS pricing (`STRIPE_PRICE_BYOS_STARTER` / `_PRO` / `_POWER` — three new Stripe price IDs, see §8).
2. The OAuth flow happens BEFORE Stripe checkout (so we have a valid OpenAI token to test against before charging the user — if the OAuth fails or the user abandons, we never collect their card).

**Routing on `/plan`** (`instaclaw/app/(onboarding)/plan/page.tsx`):

```
GET /plan
  if user.api_mode == 'chatgpt_oauth':
    show BYOS pricing
  else if user.api_mode == 'byok':
    show BYOK pricing (existing)
  else:
    show all-inclusive pricing (existing)
```

**New routes:**

- `POST /api/auth/openai/device-code/start` — initiate device-code flow, return `{user_code, verification_uri, device_auth_id, interval_seconds}`. Persists row in `instaclaw_oauth_device_flows`.
- `POST /api/auth/openai/device-code/poll` — poll for completion. Returns `{status: "pending"|"completed"|"expired", access_token?: ...}`. On `completed`, persists tokens to `instaclaw_users`, bumps `openai_token_version`, sets `api_mode='chatgpt_oauth'`.
- `POST /api/auth/openai/refresh-now` (internal, called by VM agent when token is near-expiry mid-turn — provides a side-channel to force refresh) — secured by VM-to-server gateway token.
- `DELETE /api/auth/openai/disconnect` — revokes via `POST https://auth.openai.com/oauth/revoke` and clears DB columns. Switches `api_mode` back to `byok` or `all_inclusive` (whichever was last active before connecting).

**Middleware allow-list** (per CLAUDE.md Rule 13): `/api/auth/openai/device-code/start` is public (user not yet logged in via OAuth — though they ARE logged in via Google). `/poll` is session-protected. `/refresh-now` uses gateway-token auth (X-Gateway-Token header). `/disconnect` is session-protected.

### 4.16 Failure modes catalog

| Failure | Detected by | User-visible | Recovery |
|---------|-------------|--------------|----------|
| Cloudflare 403 on OAuth | Backend HTTP response | "ChatGPT login isn't currently reachable from your region. Please try again or contact support." | Engineer pager; investigate; if persistent, switch user to BYOK temporarily |
| Cloudflare 403 on inference (mid-turn) | OpenClaw runtime catches error | Transparent fallback to Anthropic via §4.10 | Same; mark `instaclaw_users.openai_endpoint_blocked_at` to escalate to investigation |
| OAuth flow timeout (15 min) | Device-code poll returns `expires_in` exhausted | "Login window expired. Try again?" | User clicks retry; new device_auth_id issued |
| Refresh token expired/reused/revoked | Cron `/api/cron/refresh-openai-oauth-tokens` | §4.11 messaging | User reconnects via `/settings/account/reconnect-chatgpt` |
| Plan downgrade | Post-refresh JWT claim diff | §4.12 messaging | Auto-adjust default model; user can override |
| Subscription cancelled | Plan downgrade → free + Codex returns 402/403 | "Your ChatGPT subscription is no longer active. We've switched your agent to {fallback}." | User re-subscribes or stays on fallback tier |
| Token rotation race (two refresh attempts) | Postgres row-level lock + `refresh_token_reused` error | If lock missed: user sees §4.11 "reused" message | Lock implementation is mandatory; row lock prevents the race |
| Concurrent multi-VM OAuth flow | Same user clicks "Continue with ChatGPT" twice in two windows | Second attempt's device_auth_id is stored alongside first; both can complete but only one's tokens land (latest wins) | Show only the most-recent in-progress flow; cancel others |

---

## 5. Half 2 — History Import

### 5.1 conversations.json schema (verified)

Top-level is a **JSON array** of conversation objects (verified across `expelledboy/chatgpt-zod-schema`, `Superkikim/nexus-ai-chat-importer`, multiple production parsers). Per-conversation shape:

```ts
type ChatThread = {
  id: string;
  title: string;
  create_time: number;       // unix epoch seconds
  update_time: number;
  mapping: Record<string, MessageNode>;
  current_node: string | null;
  default_model_slug: string | null;   // "gpt-4o", "o1-preview", "auto", "gpt-5", etc.
  is_archived: boolean;
  is_starred: boolean | null;
  gizmo_id: string | null;             // set if chat was with a custom GPT
  voice: string | null;                // e.g. "cove" for voice-mode
  async_status: number | null;         // for Deep Research async tasks
  // ... plus ~15 more fields per schema reference
};

type MessageNode = {
  id: string;
  message: Message | null;
  parent: string | null;
  children: string[];        // multiple if user regenerated/branched
};

type Message = {
  id: string;
  author: { role: "user"|"assistant"|"system"|"tool"; name: string|null };
  create_time: number | null;
  content: Content;          // discriminated union on content_type
  status: string;
  weight: number;            // 0 = hidden, 1 = visible
  metadata: MessageMetadata; // ~70 optional fields
  recipient: string;         // "all"|"browser"|"python"|"dalle.text2im"|"bio"|...
};
```

**18 distinct `content_type` values** (most common: `text`, `code`, `execution_output`, `multimodal_text`, `image_asset_pointer`, `thoughts`, `reasoning_recap`, `user_editable_context`).

**Gold finding from research**: messages with `recipient: "bio"` are the model writing to ChatGPT Memory. **Even though OpenAI doesn't export the saved-memory list itself, every Memory write IS in conversations.json**. We can reconstruct the user's ChatGPT-memory list by extracting all `recipient: "bio"` events — a feature OpenAI doesn't offer in their own export.

**Custom Instructions are likely inlined** as `content_type: "user_editable_context"` events at conversation start. We extract them as a first-class source of user profile data.

### 5.2 Upload pipeline — presigned R2

**Why R2 + presigned URL, not POST through our function.** Vercel serverless function body limit is 4.5 MB by default. Power-user exports can hit 600 MB (community report). Direct POST won't work for the long tail.

**Flow:**

1. User clicks "Import history" → frontend calls `POST /api/history/upload-url` with `{filename, size}`. Backend generates a presigned R2 PUT URL (5-min TTL) using our existing `lib/r2-storage.ts` (already deployed for freeze-v2 archives). Returns URL + expected `bucket_key`.
2. Frontend PUTs the zip directly to R2 (browser → R2, bypasses our function entirely).
3. On 200 from R2, frontend calls `POST /api/history/start-extraction` with `{bucket_key}`.
4. Backend enqueues a job (Vercel Queues, beta, per CLAUDE.md knowledge update; or use Postgres-backed job queue if Queues isn't suitable for long-running extraction). Returns `{job_id}`.
5. Frontend polls `GET /api/history/job/:id` for status; or subscribes to Supabase realtime updates on `instaclaw_history_import_jobs`.

**Storage shape (R2):** key prefix `history-imports/<user_id>/<job_id>/conversations.zip`. Encrypted at rest via R2's default SSE + our application-layer AES-256-GCM (per Rule 53). Retention: **24 hours** post-extraction success (process-and-delete pattern), or **30 days** if user opts into "store for re-extraction" (§5.8).

**Schema for the jobs table:**

```sql
CREATE TABLE IF NOT EXISTS instaclaw_history_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  bucket_key TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading',
    -- 'uploading' | 'parsing' | 'extracting' | 'consolidating' |
    -- 'persisting' | 'completed' | 'failed' | 'cancelled'
  status_message TEXT,
  conversations_total INTEGER,
  conversations_parsed INTEGER NOT NULL DEFAULT 0,
  facts_extracted INTEGER NOT NULL DEFAULT 0,
  facts_persisted INTEGER NOT NULL DEFAULT 0,
  cost_usd_estimate NUMERIC(10, 4),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_class TEXT,
  error_message TEXT,
  retain_raw_until TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  user_opted_retain BOOLEAN NOT NULL DEFAULT false,
  jaw_drop_message_sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS instaclaw_history_import_jobs_user_status
  ON instaclaw_history_import_jobs(user_id, status, started_at DESC);
```

### 5.3 Parser

**Steal:** `expelledboy/chatgpt-zod-schema/src/schema.ts` is the most-complete Zod schema for `conversations.json`. Copy verbatim as type definitions. Handles all 18 content types and the recipient enum.

**Detection of sharded format** (per `mikeadolan/claude-brain/scripts/import_chatgpt.py`):

```ts
async function findConversationFiles(extractDir: string): Promise<string[]> {
  const sharded = await glob(`${extractDir}/conversations-*.json`);
  if (sharded.length > 0) return sharded.sort();
  const single = `${extractDir}/conversations.json`;
  if (await fileExists(single)) return [single];
  return [];
}
```

**Streaming parse** for large files. Don't `JSON.parse` a 600 MB string. Use `stream-json` (npm) or equivalent — iterator-based parser that emits each conversation object as it's seen.

**Linearize each conversation** by following `current_node` backward to root, then walking forward. Skip messages with `is_visually_hidden_from_conversation: true` (per `basic-memory` pattern). Skip the synthetic root node. Skip empty assistant responses (per Rule 30).

### 5.4 Extraction pipeline (the new IP)

**Pattern:** mem0's two-phase (extract → consolidate) at the conversation level, with **ADD-only v3 extraction** + Graphiti's bi-temporal `valid_at/invalid_at` for time-sensitive facts + A-MEM's enriched note schema for memory entries.

**Stage 1 — Per-conversation extraction (Haiku, parallel).**

For each linearized conversation, call Haiku 4.5 with mem0's `ADDITIVE_EXTRACTION_PROMPT` (verbatim) + our extension for 7 categories. Concurrency: 50 parallel requests. Anthropic prompt caching on the system prompt (90% savings on cached input).

**System prompt (built on mem0's v3 ADDITIVE_EXTRACTION, extended):**

```
# ROLE
You are a Memory Extractor — a precise, evidence-bound processor responsible
for extracting rich, contextual memories from this ChatGPT conversation. Your
sole operation is ADD: identify every piece of memorable information about the
USER and produce self-contained, contextually rich factual statements.

You extract from BOTH user and assistant messages. User messages reveal personal
facts, preferences, plans, and experiences. Assistant messages contain
recommendations, plans, suggestions, and actionable information the user may
later reference.

# CATEGORIES (extract for each that applies)
1. demographics: name, location, age, job title, employer, family members, pets
2. preferences: diet, drinks (coffee, alcohol), music, travel destinations, brands
3. projects_active: current work projects, learning goals, side projects
4. communication_style: formal/casual, verbose/terse, technical depth
5. relationships: people in user's life (with names), what those people do
6. recurring_topics: hobbies, ongoing interests, repeat questions
7. time_sensitive: events with dates ("getting married June 2026", "moved to SF in 2024")

# OUTPUT
JSON array of facts. Each fact:
{
  "category": "demographics" | "preferences" | "projects_active" | ...,
  "text": "User's girlfriend's name is Sarah",
  "valid_at": "2024-03-15" or null,   // when fact became true; null if always-true
  "confidence_signal": "explicit" | "inferred",
  "source_message_id": "msg-abc-123"  // the message UUID this came from
}

# DO NOT EXTRACT
- Vague characterizations ("you seem passionate") unless user explicitly confirms
- Generic assistant acknowledgments ("Sure!", "Great question!")
- Assistant meta-commentary about its own capabilities
- One-off questions the user asked (not facts about them — questions don't define them)
```

Input: conversation linearized into JSON (or markdown for token efficiency). Output: array of fact objects.

**Stage 2 — Cross-conversation consolidation (Sonnet, batched).**

After Stage 1 produces ~10-50 facts per conversation × 1000 conversations = ~25K candidate facts:

1. **Embed all facts** (text-embedding-3-large via our `OPENAI_API_KEY`).
2. **Cluster by topic + category** (HDBSCAN over embeddings, restricted to same category). Target: 50-200 clusters.
3. **Per-cluster consolidation (Sonnet, one call per cluster).** Prompt: "Here are 35 candidate facts in category `preferences` about the user. Deduplicate. Resolve contradictions by recency. Output consolidated facts, each with: text, confidence (high|medium|low), valid_at, invalid_at, source_message_ids[]." Sonnet's higher quality matters here.
4. **Final cross-cluster dedup pass (Sonnet, one call).** Input: top-level summary of all clusters. Output: detect cross-cluster duplicates ("preferences/coffee says Stumptown, recurring_topics says he reads Stumptown's blog" — same fact, two clusters).

**Stage 3 — gbrain page write (no LLM, deterministic).** Per §5.6.

**Stage 4 — Jaw-drop intro message generation (Sonnet, one call).** Input: the full consolidated profile. Output: 5-7 sentence narrative for the agent's first Telegram message. Per §5.7.

### 5.5 Cost & time math

For a 1000-conversation export (typical 1-year power user):

**Token math:**
- Avg conversation = 5K tokens of content. 1000 conversations = 5M tokens of input to Stage 1.
- Stage 1 (Haiku per-convo): 5M input + 500K output (10x compression) = 5M × $1/1M + 500K × $5/1M = **$7.50** before caching
- With Anthropic prompt caching (90% savings on system prompt, ~2K tokens repeated 1000 times): **~$1.50** Stage 1
- Stage 2 (Sonnet consolidation): ~100 cluster calls × ~20K input + 5K output = 2M input + 500K output = $6 + $7.50 = **~$13.50** — but with batching (50% off) and caching, **~$6**
- Stage 3 (deterministic): $0
- Stage 4 (Sonnet, ~10K input + 500 output): $0.03 + $0.0075 = **~$0.04**
- Embeddings (25K facts × 100 tokens each, text-embedding-3-large): 2.5M tokens × $0.13/1M = **$0.32**

**Total: ~$8/user** worst case, ~$2-3/user with aggressive caching and batching.

**Time math (50 parallel Haiku requests):**
- 1000 conversations / 50 parallel × 2s avg latency = **~40 seconds Stage 1**
- 100 cluster consolidation Sonnet calls / 10 parallel × 5s avg = **~50 seconds Stage 2**
- Stage 3 (gbrain writes): ~10K writes × 50ms (HTTP MCP) / 20 parallel = **~25 seconds**
- Stage 4: **~10 seconds**

**Total: ~2-3 minutes wall-clock for a 1000-conversation history.** For a 3000-conversation power user: ~5-8 minutes.

**UX implication:** async with progress bar + push notification when done. Don't make the user wait synchronously.

### 5.6 gbrain page schema

Hybrid (top-level summary + category pages + per-fact rows). Concrete slugs:

```
profile                       Top-level user narrative (5-7 sentences, agent reads on every session)
profile/demographics          Structured: name, age, location, employer, role, family members
profile/relationships         List of people in user's life
preferences/food
preferences/drinks
preferences/music
preferences/travel
preferences/brands
projects/active               Current projects with last-mentioned dates
projects/learning             Learning goals (Japanese, etc.)
projects/recurring_topics     Hobbies user keeps asking about
communication/style           Communication preferences in one paragraph
facts/<topic-slug>            Individual high-confidence facts that don't fit elsewhere
history-import-meta           Provenance: job_id, when imported, total conversations parsed
```

Per-fact metadata (stored alongside the fact text, queryable for retrieval):

```json
{
  "text": "User prefers dark roast coffee, ideally Stumptown",
  "category": "preferences/drinks",
  "confidence": "high",
  "valid_at": "2024-08-12",
  "invalid_at": null,
  "source_message_ids": ["msg-abc", "msg-def"],
  "extracted_at": "2026-05-18T15:00:00Z",
  "last_confirmed_at": "2026-05-18T15:00:00Z",
  "extraction_model": "claude-haiku-4-5",
  "extraction_prompt_version": "v1"
}
```

**gbrain calls** via the HTTP sidecar (per Rule 35 architecture): `put_page` MCP tool, called from our extraction worker over `http://<vm-ip>:3131/mcp` with bearer auth. Phase 2 may require us to add a `put_page_bulk` MCP tool upstream to gbrain to amortize HTTP overhead (a 10K-fact write at 50ms each is the bottleneck of Stage 3).

### 5.7 The jaw-drop moment

After extraction completes, the agent sends one Telegram message to the user (the user's existing bot channel). Format from Stage 4 (Sonnet):

```
Hey {first_name}.

I just finished reading {N} conversations from your ChatGPT history
({date_first_chat} to {date_last_chat}, {tokens_processed_human} of context).

Here's what I know about you:
{ONE_PARAGRAPH_NARRATIVE — 5-7 sentences, identity → work → relationships
→ interests → current projects}

Did I get anything wrong? Reply to fix.

(I'll remember this from here on. You won't have to re-introduce yourself
again.)
```

**The narrative is the value moment.** Cooper's example: "you're a senior engineer at Stripe working on payments infrastructure, you love hiking in Yosemite, you're learning Japanese, your girlfriend's name is Sarah, you prefer dark roast coffee, and you've been thinking about starting a company in the climate space."

**Implementation note:** the message is generated by Sonnet with a strict prompt that says "5-7 sentences, narrative not list, include {N} specific facts, end with the correction invitation." Per the research subagent's finding: more than ~7 facts feels surveilling; one paragraph hits.

**Correction flow.** When the user replies with a correction:
1. Agent's normal chat loop receives the message.
2. The reply hits a special handler (looking for the "correction" intent — first message after the jaw-drop intro within 24 hours).
3. Handler runs a small Claude call: "User corrected the following fact: {original}. Their reply: {reply}. What change should we make? Output: {operation: 'invalidate'|'update', target_page, new_value?, new_valid_at?}".
4. Apply per **Graphiti pattern**: never overwrite. Set `invalid_at = now()` on the old fact; insert new fact with `valid_at = now()`.
5. Agent confirms: "Updated — {summary of change}. Anything else?"

This is the trim-not-nuke principle (CLAUDE.md Rule 30) applied to extracted memories.

### 5.8 Privacy & data retention

The conversations.json file is some of the most personal data a user can hand us. We treat it accordingly.

**Defaults (no user action required):**

1. **Process-and-delete by default.** Raw zip + extracted intermediate JSON deleted from R2 within 24 hours of extraction completion (cron `/api/cron/purge-history-imports` sweeps `instaclaw_history_import_jobs` where `retain_raw_until < NOW() AND user_opted_retain = false`).
2. **No training.** Explicit ToS clause: extracted content never flows into model training (theirs or ours).
3. **Encryption at rest.** R2 SSE + application-layer AES-256-GCM via our existing `lib/freeze-encryption.ts` (Rule 53).
4. **Region-locked processing.** EU users' data processed in EU regions only (defer until we have an EU presence; flag as Phase 3 if it's a blocker for an EU partnership).
5. **Audit log.** For each extraction, persist: timestamp, model used, tokens processed, facts surfaced. User-visible in dashboard.

**Opt-in (user must explicitly enable):**

- "Keep my raw export for 30 days so InstaClaw can improve extraction quality and re-extract if needed." Checkbox on the upload form, default OFF.

**User-initiated delete:**

- One-click "Delete everything we extracted from my ChatGPT history" in dashboard → Settings → Privacy. Hard-deletes all gbrain pages under `profile/`, `preferences/`, `projects/`, `communication/`, `facts/` slugs that have `extraction_source = "chatgpt_import"` metadata. Also purges R2 if retained.

**Provenance is the trust anchor.** Every fact in gbrain carries `source_message_ids[]` linking back to the conversations that contributed it. User can ask the agent "where did you learn I prefer Stumptown?" and the agent retrieves the source messages from a local snapshot we keep (NOT in R2; in encrypted Postgres with hard 90-day TTL).

### 5.9 Correction flow (trim-not-nuke per Rule 30)

When user corrects a fact:

1. **Never delete the old fact.** Set `invalid_at = now()`.
2. **Insert the new fact** with `valid_at = now()` and same `source_message_ids` (since the correction is itself a "source" — the user's message).
3. **Retrieval queries** filter `WHERE invalid_at IS NULL OR invalid_at > <query_time>` to get the "current truth" view.
4. **History is preserved**, so user can "undo" a correction by saying "actually I was right the first time" — agent clears the `invalid_at` on the original.

This composes cleanly with Cooper's existing memory architecture (Rule 22, Rule 30): no destructive operations on user state; everything is appendable + invalidatable.

---

## 6. Five more viral features beyond the jaw-drop

The jaw-drop intro is Feature #1. Five more that compound the "holy shit" moment:

### 6.1 Memory Score + leaderboard

After import, surface a number: "Your agent knows **247 facts** about you, learned across **1,247 conversations**." Compare to a (manufactured) baseline: "Most users start with 0. You're in the **top 1%** for day-one memory."

The screenshot people share has a number on it. The number is the headline.

**Build cost:** trivial — `count(facts_persisted)`. Render as a hero stat on the post-import success page.

### 6.2 The "agent already finished a task" surprise

While extraction runs, the agent reads the user's history and detects a recurring incomplete task. Examples:
- "You've asked ChatGPT 7 times about learning Japanese but never set up a schedule. I made you a daily 15-min reminder at 7 AM (your usual wake time, based on your messages). Want to keep it?"
- "You've been asking for Stumptown restocks since March. I just subscribed you to their notifications and DM'd you when they drop a new roast."
- "Your last 3 ChatGPT trips mentioned wanting to hike Half Dome — I checked the permit lottery, it opens March 1. Want me to enter you?"

**This is the "your agent did something before you asked" moment.** It's worth a 30-minute video on Twitter.

**Build cost:** moderate. Requires an agent prompt that combs the extracted facts for "incomplete intent" patterns + integration with the existing skill system (reminders, web search, etc.).

### 6.3 The "what you and ChatGPT got wrong" callout

After import, run a small analysis: where did ChatGPT give the user advice that turned out to be outdated, wrong, or worth revisiting? Surface 1-2 examples.

- "On March 12, you asked ChatGPT about React Server Components patterns. ChatGPT gave you Next 13 advice. Next.js is on v16 now with very different patterns — want a refresher?"
- "On April 4, you asked about Stripe Identity. They've shipped 3 major updates since then. Want a summary?"

**The pitch:** "Your old advice expires. Your agent keeps it current."

**Build cost:** moderate. Requires temporal awareness in the extraction (we already capture `extracted_at`) + a "this advice is stale" detection prompt that runs Sonnet on facts older than 6 months tagged `advice`.

### 6.4 Side-by-side: ChatGPT history vs InstaClaw capabilities

Auto-generate a one-screen comparison page. Left column: a sample of what the user told ChatGPT in the last 3 years. Right column: what their InstaClaw agent can DO with that knowledge.

Example pair:
- **Left (ChatGPT):** "Recommend me a coffee shop near my office in SoMa"
- **Right (InstaClaw):** "I know your office is at 575 Mission. I checked Sightglass, Blue Bottle, Sextant. Sextant has your usual single-origin Ethiopian. They open in 12 min. Want me to put it in your calendar?"

**Effect:** the user feels their old ChatGPT usage was the prologue. InstaClaw is the sequel.

**Build cost:** moderate. Curated set of "comparison templates" + the agent's actual response to a synthetic version of the user's past question, side-by-side.

### 6.5 Time-collapse: 3 years in 60 seconds

A generated video/GIF: the user's 1,247 conversations playing as a fast-forward montage of question topics, with a counter ticking up: "March 2023 — first ChatGPT conversation about React… April 2023 — first travel question… August 2024 — first mention of Sarah…" Ending with: "All of this is now in your InstaClaw memory. May 2026 — ready when you are."

**Effect:** memory-as-life-story. Tweet-screenshot ready.

**Build cost:** higher. Requires a video-generation pipeline (Remotion or similar). Defer to Phase 3 unless we want to chase virality hard.

---

## 7. Onboarding UX (buttery smooth)

### 7.1 The end-to-end flow

**Goal: never make the user feel they're doing IT work.**

```
Step 0: User lands on instaclaw.io (referred from Twitter / Discord)
Step 1: Click "Try InstaClaw — Login with ChatGPT" hero CTA
Step 2: Google OAuth (existing) — captures identity + payment method
Step 3: New: "Connect your ChatGPT" — device-code flow with auto-opened popup
        ✓ Pre-filled OpenAI device-code page
        ✓ Background poll completes in 30s
        ✓ Plan tier (Plus/Pro/etc.) detected and shown
Step 4: Pick tier (BYOS Starter $14 / Pro $39 / Power $99)
Step 5: Stripe checkout (existing)
Step 6: /deploying (existing) — VM spins up in ~3 min
Step 7: Agent says hi in Telegram (existing)
Step 8: (Optional) "Want me to know you better? Import 3 years of ChatGPT
        history (~5 min)"
Step 9: If yes → in-app walkthrough → upload → extraction → jaw-drop message
        If no → standard flow; user can import later from dashboard
```

**Total time-to-first-message: 4-5 minutes** (no history) or 8-12 minutes (with history). Both well within attention budget.

### 7.2 In-app export walkthrough (avoiding "go figure it out yourself")

Modal with progress markers:

```
1. Open ChatGPT settings
   [Open chatgpt.com/#settings in new tab]
   ✓ I'm there

2. Click Data Controls → Export
   [Animated GIF showing the path]
   ✓ I clicked Export

3. Confirm the export, then wait for the email
   [It usually takes < 30 min. We'll wait with you.]
   We're listening... we'll notify you when the file is ready.

4. When you get the email, drag the .zip here
   [Drag-and-drop zone, accepts .zip up to 1 GB]
   ↓
```

Each step has a "Skip — I'll do this later" link. Each click ticks a `instaclaw_history_import_walkthrough.last_step` counter so we know where users drop off.

### 7.3 Chrome extension (Phase 3 — automates the export)

Concept: a tiny Chrome extension that, on a single click in InstaClaw, opens chatgpt.com, navigates to Data Controls → Export, confirms, waits for the email, downloads the zip, and POSTs it to our R2 presigned URL. **End-to-end: one click.**

Defer to Phase 3. Chrome Web Store review is ~1-3 weeks; engineering is ~2 weeks for a polished extension; UX validation needed (does the extension feel creepy?). Phase 2 ships with the manual walkthrough.

### 7.4 What happens if the user skips import

The OAuth flow alone is sufficient to ship a functioning agent. History import is **always optional** — both at signup AND later from dashboard. A user who skips at signup sees a card on the dashboard for 30 days nudging them to import; after 30 days the card goes away.

---

## 8. Billing model

### 8.1 The new "BYOS" (Bring Your Own Subscription) tier

Joins existing `all_inclusive` and `byok` modes. Three price points:

| Tier | All-inclusive | BYOK Anthropic | **BYOS (new)** |
|------|---------------|-----------------|----------------|
| Starter | $29/mo | $14/mo | **$14/mo** |
| Pro | $99/mo | $39/mo | **$39/mo** |
| Power | $299/mo | $99/mo | **$99/mo** |

**Pricing rationale:** BYOS matches BYOK pricing because the user is providing inference compute one way or another. We charge for infra (VM, wallet, memory, skills) and a thin platform margin.

**What user pays:** InstaClaw monthly fee → us. OpenAI subscription → OpenAI. Optional Anthropic API key → Anthropic (for BYOK fallback).

**What we incur:**
- VM cost: $29/mo Linode dedicated CPU (same as today)
- Heartbeat tokens: ~$3-5/mo Haiku on our key
- Embedding tokens: ~$1-2/mo OpenAI on our key
- Per-call fallback (§4.10): capped at tier limit, expected ~$0-5/mo per user actively hitting limits
- **Total cost: ~$33-40/mo per user**

**Gross profit:**
- Starter BYOS: $14 - $35 = **-$21/mo (loss)** ← BLOCKER, see below
- Pro BYOS: $39 - $35 = **$4/mo**
- Power BYOS: $99 - $35 = **$64/mo**

**The Starter BYOS problem.** $14/mo doesn't cover the VM. Options:
- **(a)** Bundle BYOS Starter onto shared infra ("Lite Mode") instead of a dedicated VM — degraded experience but viable margin
- **(b)** Raise BYOS Starter to $19/mo to break even
- **(c)** Use BYOS Starter as a loss-leader with explicit time-cap (free for 14 days, then upgrade or stop)
- **(d)** Don't offer BYOS Starter; start at BYOS Pro $39

**Recommendation: (b) at launch ($19 Starter BYOS), revisit after 30 days of data.** Or (d) if positioning is "BYOS is for serious users."

### 8.2 Daily quota / credits

Today: Starter 600/day, Pro 1000/day, Power 2500/day — based on our API costs. For BYOS, the user's quota is whatever OpenAI gives them (Plus = 20-100 GPT-5.4 messages per 5h, etc. per Codex pricing page).

**Our credits model doesn't apply** to BYOS users. They use OpenAI's quota for primary chat. Heartbeats + embeddings + fallback are platform-paid (capped per §4.10).

### 8.3 Stripe integration

Three new Stripe prices: `STRIPE_PRICE_STARTER_BYOS`, `STRIPE_PRICE_PRO_BYOS`, `STRIPE_PRICE_POWER_BYOS`. Webhook handler (`app/api/billing/webhook/route.ts`) extended to set `api_mode = 'chatgpt_oauth'` when the price ID matches a BYOS one.

**Updates to `lib/billing-status.ts`:**

`isPaying = true` extended Path 6: `api_mode === 'chatgpt_oauth' AND tier IN (starter, pro, power) AND active sub`. Mirrors existing Path 5 for all-inclusive.

### 8.4 Tier-gated features on BYOS

BYOS users get all the same skills, wallet, gbrain, etc. as other tiers. The ONE difference: primary chat model is `openai/<discovered>` instead of `anthropic/claude-sonnet-4-6`. They can still invoke Anthropic via Anthropic BYOK or via per-call fallback (capped).

---

## 9. Architecture summary (engineering-ready)

### 9.1 New DB columns

On `instaclaw_users`:
- `openai_oauth_access_token TEXT` (encrypted)
- `openai_oauth_refresh_token TEXT` (encrypted)
- `openai_oauth_id_token_claims JSONB`
- `openai_oauth_expires_at TIMESTAMPTZ`
- `openai_oauth_last_refresh_at TIMESTAMPTZ`
- `openai_oauth_account_id TEXT`
- `openai_oauth_originator TEXT`
- `openai_token_version INTEGER NOT NULL DEFAULT 0`
- `chatgpt_plan_type TEXT`
- `chatgpt_plan_last_seen_at TIMESTAMPTZ`
- `openai_fallback_tokens_used_this_period BIGINT NOT NULL DEFAULT 0`
- `openai_fallback_tokens_cap_this_period BIGINT NOT NULL DEFAULT 0`
- `openai_fallback_period_start TIMESTAMPTZ`
- `openai_quota_exhausted_until TIMESTAMPTZ`
- `openai_endpoint_blocked_at TIMESTAMPTZ` (set if Cloudflare 403 detected)

On `instaclaw_vms`:
- `openai_token_version_synced INTEGER NOT NULL DEFAULT 0`

Constraint extension:
- `instaclaw_users.api_mode` CHECK extended to include `'chatgpt_oauth'`

### 9.2 New tables

- `instaclaw_oauth_device_flows` — device-code polling state (§4.4)
- `instaclaw_history_import_jobs` — history import job tracking (§5.2)
- `instaclaw_extracted_facts` — extracted fact metadata for provenance (referenced from gbrain pages but persisted in Postgres for query):

```sql
CREATE TABLE IF NOT EXISTS instaclaw_extracted_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  job_id UUID REFERENCES instaclaw_history_import_jobs(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  gbrain_slug TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence TEXT NOT NULL,
  valid_at TIMESTAMPTZ,
  invalid_at TIMESTAMPTZ,
  source_message_ids TEXT[],
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  extraction_model TEXT,
  extraction_prompt_version TEXT
);
CREATE INDEX IF NOT EXISTS instaclaw_extracted_facts_user_current
  ON instaclaw_extracted_facts(user_id, category, invalid_at);
```

- `instaclaw_history_import_walkthrough` (optional, for funnel analytics) — last_step counter

### 9.3 New env vars

| Var | Purpose | Set in |
|-----|---------|--------|
| `OPENAI_OAUTH_CLIENT_ID` | Public client_id (Codex's or our own registered one) | Vercel env |
| `OPENAI_OAUTH_ISSUER` | `https://auth.openai.com` | Vercel env |
| `OPENAI_OAUTH_KEY_CURRENT` | Encryption key version for tokens at rest (`v1`) | Vercel env |
| `OPENAI_OAUTH_KEY_V1` | 64-hex AES-256 key | Vercel env, also backed up offline |
| `OPENAI_BACKEND_BASE_URL` | `https://chatgpt.com/backend-api/codex` (overridable for testing) | Vercel env |
| `HISTORY_IMPORT_R2_BUCKET` | R2 bucket for raw uploads | Vercel env (likely separate from freeze-archive bucket) |
| `STRIPE_PRICE_STARTER_BYOS` / `_PRO_BYOS` / `_POWER_BYOS` | New Stripe price IDs | Vercel env |

### 9.4 New API routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/auth/openai/device-code/start` | POST | Session | Initiate device-code flow |
| `/api/auth/openai/device-code/poll` | POST | Session | Poll for completion |
| `/api/auth/openai/refresh-now` | POST | Gateway token | VM-initiated forced refresh |
| `/api/auth/openai/disconnect` | DELETE | Session | Revoke and clear |
| `/api/history/upload-url` | POST | Session | Get presigned R2 URL |
| `/api/history/start-extraction` | POST | Session | Enqueue extraction job |
| `/api/history/job/:id` | GET | Session | Poll job status |
| `/api/history/cancel/:id` | POST | Session | Cancel in-flight |
| `/api/cron/refresh-openai-oauth-tokens` | POST | Cron secret | Refresh expiring tokens |
| `/api/cron/purge-history-imports` | POST | Cron secret | Delete raw uploads past TTL |
| `/api/cron/track-fallback-usage` | POST | Cron secret | Update fallback counters |

**Per CLAUDE.md Rule 13:** all routes need middleware allow-list entries. Self-auth routes (`/refresh-now` via gateway token) and public-ish routes (`/device-code/start` — session-protected but may need allow-list depending on session check timing) must be enumerated in `selfAuthAPIs`.

**Per CLAUDE.md Rule 11:** all LLM-calling routes (`/start-extraction` worker code, jaw-drop generator) need `export const maxDuration = 300`.

### 9.5 New reconciler steps

- `stepChatGPTOAuthToken` — DB↔disk sync per Rule 34 (§4.6)
- Extension of `stepAuthProfiles` to write the OpenAI profile entry when present
- Extension of `stepConfigSettings` to push `agents.defaults.model.primary = openai/<...>` when applicable

### 9.6 New cron jobs

- `/api/cron/refresh-openai-oauth-tokens` — every 5 min
- `/api/cron/purge-history-imports` — every 1 hour
- `/api/cron/track-fallback-usage` — every 1 hour
- `/api/cron/probe-openai-endpoint-health` — every 1 hour (synthetic OAuth + inference probe from one of our VMs, alert if 403 rate > X%)

### 9.7 New gbrain integrations

- Bulk `put_page` MCP tool (upstream contribution to gbrain repo if not present)
- New per-fact metadata schema for `extraction_source = "chatgpt_import"` filtering

### 9.8 File changes (likely)

- `lib/ssh.ts:configureOpenClaw()` — extended to write `openai-oauth.json` for `chatgpt_oauth` users
- `lib/ssh.ts:buildAuthProfilesJson()` — extended to include `openai:default` profile when applicable
- `lib/ssh.ts:toOpenClawModel()` — extended to support `openai/*` prefixes
- `lib/vm-reconcile.ts` — new step + extensions to existing steps
- `lib/vm-manifest.ts` — new `configSettings` entries for OpenAI provider config; new file entry for `openai-oauth.json` writer template
- `lib/billing-status.ts` — extended `isPaying` Path for `chatgpt_oauth`
- `lib/auth-cache.ts` — extended to clear OpenAI cache state on subscription recovery
- `app/(onboarding)/connect/page.tsx` — new "Continue with ChatGPT" CTA
- `app/(onboarding)/plan/page.tsx` — BYOS pricing display
- `app/(dashboard)/settings/account/reconnect-chatgpt/page.tsx` — reconnect UI
- `app/(dashboard)/import/page.tsx` — history import UI
- `app/api/billing/webhook/route.ts` — extended to handle BYOS price IDs
- **New file:** `lib/openai-oauth.ts` — token exchange, refresh, JWT parsing
- **New file:** `lib/secret-encryption.ts` (if no existing helper) — AES-256-GCM wrapper for token-at-rest
- **New file:** `lib/history-import/parser.ts` — conversations.json streaming parser
- **New file:** `lib/history-import/extractor.ts` — Stage 1 per-conversation extraction
- **New file:** `lib/history-import/consolidator.ts` — Stage 2 cross-conversation
- **New file:** `lib/history-import/jaw-drop.ts` — Stage 4 intro generation
- **New file:** `lib/history-import/gbrain-writer.ts` — Stage 3 page writes

### 9.9 Migration SQL

Per Rule 56 (the 2026-05-16 incident), all new migrations land in `instaclaw/supabase/pending_migrations/` first. Move to `migrations/` only after applying to prod (and the apply triggers `npm run build` to gate-check).

```sql
-- instaclaw/supabase/pending_migrations/20260518000000_chatgpt_oauth.sql
-- (Full content per §4.4 + §9.1 + §9.2)
```

---

## 10. Phasing & timeline

### Phase 0 — Spike (Week 1)

**Goal:** prove Cloudflare/TLS is solvable before any other engineering happens.

- Stand up 1 Linode `g6-dedicated-2` in `us-east` (same shape as production VMs)
- Install official `codex` CLI from `npm install -g @openai/codex`
- Attempt `codex login --device-auth` end-to-end. Measure success rate over 10 attempts.
- If success: spike a minimal Node-based wrapper that does the same OAuth flow with `node:undici` + standard TLS. Measure success rate.
- If wrapper fails: spike with `undici` + manual `tls.connect()` tuned to match Codex's ClientHello fingerprint. Measure.
- Attempt `POST chatgpt.com/backend-api/codex/responses` with the resulting token. Measure 403 rate over 100 requests.
- **Decision gate:** if success rate < 95% for either OAuth or inference, **STOP** and re-evaluate (route to Option B residential proxy or Option D hybrid).

**Parallel:** email OpenAI partnerships to request our own registered client_id. Brief Legal on the ToS posture and disclosure language.

### Phase 1 — OAuth (Weeks 2-5)

| Week | Engineering |
|------|-------------|
| 2 | Migration + new DB columns. OAuth flow code (`lib/openai-oauth.ts`). Device-code routes. `stepChatGPTOAuthToken` reconciler step. |
| 3 | Auth-profiles extension. Model routing. Per-call fallback infrastructure. Token-rotation cron. |
| 4 | Stripe price IDs + BYOS pricing UI. `/connect` and `/plan` extensions. End-to-end happy-path testing with internal users. |
| 5 | Failure-mode hardening (5 named refresh failures, plan downgrade, Cloudflare retry). Public launch. |

**Acceptance criteria:**
- 10 internal users complete signup → OAuth → first chat in < 5 min
- Token refresh works on schedule for 7 days continuously
- Per-call fallback triggers correctly on simulated 429
- Plan downgrade detection updates DB within 5 min of next refresh
- Rule 34 verifier confirms 0/N VMs in lying-DB state for `chatgpt_oauth` users

### Phase 2 — History import (Weeks 6-11)

| Week | Engineering |
|------|-------------|
| 6 | Migration for history-import tables. R2 upload pipeline. Parser (`expelledboy` schema). |
| 7 | Stage 1 extraction worker. Anthropic prompt caching wired. Internal end-to-end with Cooper's own export. |
| 8 | Stage 2 consolidation. HDBSCAN clustering. Sonnet calls with batching. |
| 9 | Stage 3 gbrain writes. Bulk `put_page` (upstream patch if needed). Stage 4 jaw-drop generation. |
| 10 | UI: import walkthrough, progress UI, dashboard import card. Privacy controls (delete, opt-in retention). |
| 11 | Internal beta with 20 paying users. Measure: facts extracted, correction-message rate, "felt accurate" qualitative. Iterate on extraction prompts. Public launch of Phase 2. |

**Acceptance criteria:**
- 1000-conversation extraction completes in < 5 min wall-clock
- Cost per user < $3 (with caching + batching)
- Jaw-drop intro accuracy: 80%+ facts confirmed by user as correct (measured via reply-correction rate)
- Privacy controls verified: opt-in defaults correct, hard-delete works
- Rule-30 trim-not-nuke verified on correction flow

### Phase 3 — Ongoing sync (post-launch)

- Periodic export reminder cron (every 90 days, "want to import new history?")
- Chrome extension that automates the export
- Real-time bridge if OpenAI ever exposes a streaming export API (currently doesn't exist)

---

## 11. Open questions for Cooper

Before engineering kicks off, the following decisions are needed. Each one materially affects the architecture.

1. **§2.1 Cloudflare mitigation default.** Assume Option A (TLS-fingerprint match) works after spike. If it doesn't, which fallback path: B (residential proxy), C (WARP), D (hybrid), or kill? **Recommended pre-decision: B with C as Plan C.**

2. **§2.2 ToS path.** Recommended: Option 2 (reuse Codex client_id with disclosed UX) for Phase 1, parallel Option 1 (formal partnership) for Phase 2 swap-over. Confirm or override.

3. **§2.3 5th token storage approach.** New `openai-oauth.json` file + reconciler step `stepChatGPTOAuthToken` + per-user `openai_token_version`. Approve?

4. **§4.9 Multi-provider routing model.** Primary = OpenAI sub; heartbeats stay on our Anthropic; embeddings stay on our OpenAI; BYOK Anthropic available as user-invoked override; per-call sub→our-Anthropic fallback on 429. Approve?

5. **§4.10 Per-call fallback caps.** 50K / 250K / 1M tokens per tier per month. Tunable. Approve as initial?

6. **§8.1 Starter BYOS pricing problem.** $14/mo doesn't cover $35/mo cost. Recommended: raise to $19. Approve, or pick alternative (loss-leader, shared infra, drop entirely)?

7. **§5.8 Privacy default.** Process-and-delete in 24h (raw zip + intermediates); opt-in 30-day retention. Approve?

8. **§5.7 Jaw-drop message delivery.** Telegram message via existing bot channel. Approve, or should we surface in-app first with a "send to my agent" button?

9. **§6 Viral features beyond jaw-drop.** Ship #6.1 (Memory Score) and #6.2 ("agent already finished a task") in Phase 2. Defer #6.3/#6.4/#6.5 to Phase 3. Approve?

10. **§10 Timeline.** Phase 0 = 1 week, Phase 1 = 4 weeks, Phase 2 = 6 weeks. Total 11 weeks to full ship. Approve, or compress (where would compression land)?

11. **Naming.** "BYOS" (Bring Your Own Subscription) — keep or rename? Marketing might prefer "Connect ChatGPT" tier or "ChatGPT-Powered."

12. **What gets announced when.** Phase 1 launch can be public on Twitter ("Login with ChatGPT is live"). Phase 2 launch is the viral moment. Should we hold a press window for Phase 2, or ship Phase 1 the moment it's ready and let Phase 2 land separately?

---

## 12. Appendix — source citations

All architectural claims trace to a verifiable source. The PRD is intentionally over-citation'd so engineering can verify any claim independently.

**OpenAI Codex CLI source** (the canonical reference for the OAuth flow):
- `github.com/openai/codex` repo
- `codex-rs/login/src/server.rs` — browser PKCE flow, authorize URL, token exchange, redirect URI
- `codex-rs/login/src/device_code_auth.rs` — device-code flow (our primary)
- `codex-rs/login/src/pkce.rs` — PKCE S256 generator
- `codex-rs/login/src/token_data.rs` — JWT claim parsing (`IdClaims`, `AuthClaims`)
- `codex-rs/login/src/auth/manager.rs` — refresh logic, `CLIENT_ID` constant (line 928), refresh-failure classification
- `codex-rs/login/src/auth/storage.rs` — `auth.json` schema, file vs keyring backends
- `codex-rs/model-provider-info/src/lib.rs:37,239-244` — `CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`
- `codex-rs/model-provider/src/bearer_auth_provider.rs` — Bearer + `ChatGPT-Account-ID` + `X-OpenAI-Fedramp` headers

**OpenAI developer docs:**
- `developers.openai.com/codex/auth`
- `developers.openai.com/codex/auth/ci-cd-auth`
- `developers.openai.com/codex/pricing`
- `help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan`

**Critical known issues:**
- `openai/codex#14215` — third-party 403 on `/oauth/token` (our PRIMARY risk)
- `openai/codex#17860` — Linux/WSL2 Cloudflare 403 rustls fingerprint
- `openai/codex#4840` — Codex doesn't always surface upstream 429s cleanly
- `openai/codex#9135` — 429 fires near end of 5h window with quota remaining

**Third-party reference implementations (reusing Codex's client_id):**
- `github.com/EvanZhouDev/openai-oauth` — Node.js localhost proxy pattern
- `github.com/numman-ali/opencode-openai-codex-auth` — OpenCode plugin, 22 model presets
- `github.com/tumf/opencode-openai-device-auth` — device-code variant

**Industry auth/routing patterns:**
- Claude Code: `code.claude.com/docs/en/authentication` (six auth-precedence levels)
- Cursor: `cursor.com/help/models-and-usage/api-keys` (BYOK passthrough)
- Windsurf: `docs.windsurf.com/windsurf/models` (BYOK Anthropic-only)
- Continue: `docs.continue.dev/customize/model-providers/overview` (per-role routing)
- Aider: `aider.chat/docs/config/api-keys.html` (multi-provider via litellm, weak-model split)

**ChatGPT export schema:**
- `github.com/expelledboy/chatgpt-zod-schema` `src/schema.ts` — most complete Zod schema, copy verbatim
- `github.com/Superkikim/nexus-ai-chat-importer` — TypeScript interfaces, Obsidian plugin
- `github.com/sanand0/openai-conversations` — enum coverage
- `github.com/basicmachines-co/basic-memory` — production-grade Python parser
- `github.com/firstbatchxyz/mem-agent-mcp` `memory_connectors/chatgpt_history/parser.py` — user-profile extraction
- `github.com/kandotrun/chatgpt-export-to-supermemory` `src/lib/parse-chatgpt-export.ts` — server-side ZIP handling
- `github.com/mikeadolan/claude-brain/scripts/import_chatgpt.py` — sharded-format detection
- `community.openai.com/t/decoding-exported-data-by-parsing-conversations-json-and-or-chat-html/403144` — canonical community thread

**ChatGPT export — OpenAI authority:**
- `help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data` — export procedure
- `help.openai.com/en/articles/20001067-data-access-for-your-managed-chatgpt-account` — Team/Enterprise restrictions

**Memory extraction state-of-the-art:**
- `arxiv.org/abs/2504.19413` — Mem0 paper (ECAI 2025), benchmarks vs full-context
- `mem0/configs/prompts.py` — `ADDITIVE_EXTRACTION_PROMPT` (v3), `FACT_RETRIEVAL_PROMPT` (v1)
- `mem0ai/mem0` GitHub repo
- `arxiv.org/abs/2501.13956` — Graphiti / Zep paper (bi-temporal pattern)
- `github.com/getzep/graphiti` `graphiti_core/prompts/extract_edges.py` — edge extraction prompt
- `arxiv.org/abs/2502.12110` — A-MEM paper (note schema with `keywords`, `tags`, `context_description`)
- `arxiv.org/pdf/2310.08560` — MemGPT paper (hierarchical memory)
- `arxiv.org/abs/2410.10813` — LongMemEval benchmark
- `langchain-ai.github.io/langmem/` — LangMem package (background memory manager pattern)

**Internal CLAUDE.md rules applied throughout this PRD:**
- Rule 6 (no `<<<` for env vars), Rule 10 (verify after set), Rule 11 (maxDuration 300), Rule 13 (middleware allow-list), Rule 14 (billing-status SoT), Rule 22 (never nuke user state), Rule 23 (sentinel-guard templates), Rule 27 (coverage queries), Rule 30 (trim-not-nuke), Rule 32 (verify hot-reload), Rule 33 (atomic state transitions), Rule 34 (DB↔disk verifier), Rule 35 (gbrain HTTP sidecar), Rule 39 (critical vs optional step failures), Rule 47 (continuous reconciliation), Rule 53 (encryption with key_id versioning), Rule 56 (pending_migrations gate)

**Internal codebase audit findings** (informed every architectural decision):
- `lib/ssh.ts:5353+` — `configureOpenClaw` entry point
- `lib/ssh.ts:5027-5055` — `buildAuthProfilesJson` (the file to extend)
- `lib/ssh.ts:4032-4035` — `toOpenClawModel` (must extend for OpenAI prefixes)
- `lib/billing-status.ts:56-108` — `isPaying` (extend for `chatgpt_oauth`)
- `lib/auth-cache.ts:47-140` — `clearStaleAuthCache` pattern
- `lib/vm-reconcile.ts:136-156` — `SECRET_VERSION` mechanism (per-user analog)
- `lib/vm-reconcile.ts:1771-1951` — `stepConfigSettings` (extend for OpenAI model)
- `app/api/billing/webhook/route.ts` — extend for BYOS price IDs
- `app/(dashboard)/layout.tsx:84-127` — Rule 33 state-machine routing
- `instaclaw/scripts/install-gbrain.sh` — gbrain HTTP sidecar (the memory store)
- `lib/freeze-encryption.ts` — encryption pattern (mirror for token storage)
- `lib/r2-storage.ts` — R2 wrapper (reuse for upload pipeline)
- `lib/cron-lock.ts` — distributed lock pattern (use for token refresh serialization)

---

**End of PRD.** Ready for review. Engineering shouldn't start until §11 questions 1-3 are answered, and the §10 Phase 0 spike has measured success rate ≥ 95% for both OAuth and inference from a Linode cloud IP.
