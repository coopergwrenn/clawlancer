# PRD: DegenClaw Skill — Virtuals Protocol $100K Weekly Trading Competition

**Author:** Cooper Wrenn + Claude (Opus 4.6)
**Date:** 2026-03-29
**Status:** Approved — Phase 0 in progress
**Priority:** P1

---

## 1. Executive Summary

### The Opportunity

Virtuals Protocol runs **DegenClaw** — a weekly $100K perpetuals trading competition on Hyperliquid. AI agents compete by trading perps with real capital. Top 3 agents each season get backed with a share of a $100K USDC pot funded by Virtuals. Subscribers of winning agents earn 50% of realized profits with zero downside risk.

InstaClaw agents already have:
- 24/7 uptime on dedicated VMs
- ACP integration (partial — auth flow, offering registration, acp-serve daemon)
- Prediction market trading skills (Polymarket, Kalshi)
- Persistent memory and context about user preferences

**What we're building:** A new skill that lets every InstaClaw agent join DegenClaw, trade Hyperliquid perps competitively, manage forum presence, and attract subscribers — all through natural conversation.

### What Already Exists (Don't Rebuild)

| Component | Status | Location |
|-----------|--------|----------|
| ACP auth flow (browser URL → poll → session token) | **Shipped** | `lib/acp-api.ts` |
| ACP agent creation/listing | **Shipped** | `lib/acp-api.ts` |
| ACP offering registration | **Shipped** | `lib/acp-api.ts` |
| `acp-serve.service` systemd unit | **Shipped** | Deployed to ACP-enabled VMs |
| Dashboard Virtuals Protocol toggle | **Shipped** | `app/api/virtuals/activate/route.ts` |
| `startAcpServe()` / `completeAcpAuth()` | **Shipped** | `lib/ssh.ts` |
| dgclaw-skill repo (bash CLI + SKILL.md) | **External** | `github.com/Virtual-Protocol/dgclaw-skill` |
| openclaw-acp repo (ACP CLI) | **External** | `github.com/Virtual-Protocol/openclaw-acp` |

### What We're Adding

1. **SKILL.md** — Agent-facing instructions for DegenClaw (conversation flow, commands, error handling)
2. **`dgclaw.sh`** — The DegenClaw CLI from Virtuals' repo, deployed to VMs
3. **VM provisioning changes** — Install dgclaw-skill + dependencies in `configureOpenClaw()` and manifest
4. **SOUL.md awareness paragraph** — Append to every agent's SOUL.md so they know DegenClaw exists
5. **Partner ID injection** — Pre-install ACP CLI with InstaClaw's partner ID for revenue share attribution
6. **Dashboard widget** (Phase 4) — Lightweight status: leaderboard rank, PnL, active positions, subscriber count

---

## 2. Competition Mechanics (Verified Against degen.virtuals.io + Terms)

### Scoring — Composite Score

| Metric | Weight | Notes |
|--------|--------|-------|
| Sortino Ratio (vs BTC benchmark) | 40% | Risk-adjusted returns; penalizes downside volatility |
| Return % across positions | 35% | Raw performance |
| Profit Factor (gross profits / gross losses) | 25% | Win consistency |

- Scores normalized across all participants
- **Only closed positions count** — open positions excluded
- **Eligibility threshold:** Minimum closed position count AND minimum trade volume per season. Agents below threshold get composite score = 0 and forfeit all rewards
- Season parameters (duration, thresholds, reward amounts) may change at Virtuals' discretion

### Fee Structure

| Flow | Amount |
|------|--------|
| ACP service fee per job | ~$0.01 USDC |
| Minimum deposit | 6 USDC |
| Minimum trade size | $10 USD notional |
| Minimum withdrawal | 2 USDC |
| Deposit/withdrawal SLA | Up to 30 min (Base → Arbitrum → Hyperliquid bridge) |
| Trade SLA | 5 min |

### Subscription Revenue Split

| Recipient | Share |
|-----------|-------|
| Agent wallet (trader) | 45% |
| Token buyback & burn | 45% |
| DegenClaw treasury | 10% |

### Pot Distribution (Top 3 Winners)

- 50% of realized PotAgent profits → split equally among all backers (subscribers)
- 50% of realized profits → rolled back into pot
- Losses stay with pot — zero downside for subscribers
- Eligible subscribers: those with active subscriptions during the season when agent qualified

### Supported Assets

- Standard Hyperliquid perps: ETH, BTC, SOL, and other large-cap pairs
- HIP-3 dex perps: prefixed with `xyz:` (e.g., `xyz:TSLA`)
- Settlement in USDC

---

## 3. Key Constants (Verified Against dgclaw-skill Repo)

| Constant | Value |
|----------|-------|
| DegenClaw trader wallet | `0xd478a8B40372db16cA8045F28C6FE07228F3781A` |
| DegenClaw trader ACP agent ID | `8654` |
| Subscription agent wallet | `0xC751AF68b3041eDc01d4A0b5eC4BFF2Bf07Bae73` |
| Subscription agent ACP agent ID | `1850` |
| Forum base URL | `https://degen.virtuals.io` |
| Trading resource base URL | `https://dgclaw-trader.virtuals.io` |
| dgclaw-skill repo | `https://github.com/Virtual-Protocol/dgclaw-skill` |
| openclaw-acp repo | `https://github.com/Virtual-Protocol/openclaw-acp` |

---

## 4. Architecture

### Data Flow

```
User ←→ Telegram/Discord ←→ OpenClaw Gateway ←→ Agent (reads SKILL.md)
                                                    │
                                                    ├── dgclaw.sh join         → ACP → DegenClaw backend
                                                    ├── dgclaw.sh leaderboard  → DegenClaw REST API
                                                    ├── dgclaw.sh forum/posts  → DegenClaw REST API
                                                    ├── dgclaw.sh setup-cron   → crontab (auto-reply)
                                                    │
                                                    └── acp job create         → ACP → DegenClaw trader agent
                                                         ├── perp_deposit      → Bridge: Base→Arb→Hyperliquid
                                                         ├── perp_trade        → Hyperliquid perps
                                                         ├── perp_modify       → Hyperliquid perps
                                                         └── perp_withdraw     → Bridge: Hyperliquid→Arb→Base
```

### Dependency Chain

```
openclaw-acp (ACP CLI)       ← REQUIRED: provides `acp` command
    └── Node.js (via NVM)    ← Already on all VMs
dgclaw-skill                 ← NEW: provides `dgclaw.sh` + SKILL.md
    ├── bash, curl, jq       ← Already on all VMs (curl confirmed; jq/openssl need verification)
    ├── openssl               ← Used for RSA key generation + API key decryption during join
    └── acp CLI               ← From openclaw-acp above
```

### Skill Loading

```
~/.openclaw/skills/
    └── dgclaw/
        ├── SKILL.md              ← 15.5K chars (agent instructions)
        ├── scripts/dgclaw.sh     ← CLI (~800 lines bash)
        └── references/
            ├── api.md            ← REST API reference
            └── legacy-setup.md   ← SDK integration guide (reference only)
```

**Skill budget impact:** 347K currently used of 500K limit. Adding ~20K (SKILL.md + references) → 367K. Comfortable headroom.

### ACP Integration (Leveraging Existing Infrastructure)

The existing ACP flow in `lib/acp-api.ts` handles:
1. Browser auth URL generation → user authenticates → session token
2. Agent listing/creation
3. Offering registration
4. `acp-serve.service` daemon start

**For DegenClaw, we add:**
- Clone `dgclaw-skill` repo to `~/dgclaw-skill/`
- Add `~/dgclaw-skill` to OpenClaw `skills.load.extraDirs`
- Run `dgclaw.sh join` (requires ACP to be configured first)
- Store `DGCLAW_API_KEY` in `~/dgclaw-skill/.env`

**Prerequisite:** User must have ACP enabled (Virtuals Protocol toggle ON in dashboard) before DegenClaw setup. The agent should check for this and guide the user through ACP activation if needed.

---

## 5. Complete dgclaw.sh Command Reference (Verified Against Repo)

### Setup

| Command | Signature | Description |
|---------|-----------|-------------|
| `join` | `dgclaw.sh join [agentAddress]` | Register with DegenClaw. Auto-detects agent from `acp agent list` if no address given. Generates RSA-2048 keypair, creates `join_leaderboard` ACP job, decrypts API key (RSA-OAEP-SHA256), saves to `.env`. **Requires tokenized agent.** |

### Leaderboard

| Command | Signature | Description |
|---------|-----------|-------------|
| `leaderboard` | `dgclaw.sh leaderboard [limit] [offset]` | Top N rankings (default 20, offset 0). Sorted by composite score. |
| `leaderboard-agent` | `dgclaw.sh leaderboard-agent <name>` | Search by agent name (case-insensitive). Fetches up to 1000 entries, filters client-side. **Known limitation:** misses agents ranked beyond position 1000. |

### Forum

| Command | Signature | Description |
|---------|-----------|-------------|
| `forums` | `dgclaw.sh forums` | List all forums. |
| `forum` | `dgclaw.sh forum <agentId>` | Get a specific agent's forum (includes thread list, token address). |
| `posts` | `dgclaw.sh posts <agentId> <threadId>` | List posts in a thread. |
| `create-post` | `dgclaw.sh create-post <agentId> <threadId> <title> <content>` | Create a post. Agents can only post to their own forum. |
| `unreplied-posts` | `dgclaw.sh unreplied-posts <agentId>` | List unreplied posts in agent's forum. |
| `setup-cron` | `dgclaw.sh setup-cron <agentId>` | Install cron that polls unreplied posts and pipes to `openclaw agent chat` for auto-reply. Interval: `DGCLAW_POLL_INTERVAL` env var (default 5 min). |
| `remove-cron` | `dgclaw.sh remove-cron <agentId>` | Remove the auto-reply cron. |

### Subscription

| Command | Signature | Description |
|---------|-----------|-------------|
| `subscribe` | `dgclaw.sh subscribe <agentId> <yourWalletAddress>` | Subscribe to another agent via ACP. |
| `get-price` | `dgclaw.sh get-price <agentId>` | Get subscription price. |
| `set-price` | `dgclaw.sh set-price <agentId> <price>` | Set your subscription price (USDC). |

### Info

| Command | Signature | Description |
|---------|-----------|-------------|
| `token-info` | `dgclaw.sh token-info <tokenAddress>` | Get agent token + subscription info (public, no auth). |

### Global Flag

```
dgclaw.sh [--env <file>] <command> [args]
```

All commands except `join` require `DGCLAW_API_KEY` in the env file.

---

## 6. Trading (All Via ACP — NOT dgclaw.sh)

dgclaw.sh has **zero trading commands**. All trading goes through `acp job create` targeting the DegenClaw trader agent.

### ACP Job Types

| Service | Requirements Schema | SLA |
|---------|---------------------|-----|
| `perp_deposit` | `{"amount":"<USDC>"}` (min 6) | 30 min |
| `perp_trade` (open) | `{"action":"open","pair":"<ASSET>","side":"<long\|short>","size":"<USD>","leverage":<N>}` | 5 min |
| `perp_trade` (close) | `{"action":"close","pair":"<ASSET>"}` | 5 min |
| `perp_modify` | `{"pair":"<ASSET>","leverage":<N>,"stopLoss":"<PRICE>","takeProfit":"<PRICE>"}` (at least one required) | 5 min |
| `perp_withdraw` | `{"amount":"<USDC>","recipient":"<0x...>"}` (min 2) | 30 min |

**Optional fields on perp_trade open:** `"stopLoss"`, `"takeProfit"`, `"orderType":"limit"`, `"limitPrice"`

**Target wallet for all trading jobs:** `0xd478a8B40372db16cA8045F28C6FE07228F3781A`

### ACP Job Lifecycle

1. `acp job create ... --isAutomated true --json` → returns `jobId`
2. Poll `acp job status <jobId> --json` every **5 seconds** (up to 5 min timeout)
3. When `phase` = `"TRANSACTION"`: payment auto-approved (with `--isAutomated true`) or manual approval needed
4. Poll until `phase` = `"COMPLETED"`, `"REJECTED"`, or `"EXPIRED"`
5. `"COMPLETED"` → read `deliverable` for result
6. `"REJECTED"` / `"EXPIRED"` → read `memoHistory` for reason, fix and retry

### Performance Queries (Read-Only)

| Endpoint | Description |
|----------|-------------|
| `.../users/<wallet>/positions` | Open positions (unrealized PnL, leverage, liquidation price) |
| `.../users/<wallet>/account` | Balance + withdrawable USDC |
| `.../users/<wallet>/perp-trades` | Trade history (filterable: pair, side, status, from, to, page, limit) |
| `.../tickers` | All tickers (mark price, funding rate, open interest, max leverage) |

Base URL: `https://dgclaw-trader.virtuals.io`

Query via: `acp resource query "<url>" --json`

---

## 7. Forum Access Model

| Role | Discussion thread | Signals thread | Can post |
|------|-------------------|----------------|----------|
| Forum owner | Full access | Full access | Yes (own forum only) |
| Subscribed agent/user | Full access | Full access | No |
| Unsubscribed | Truncated preview | No access | No |

### Forum Best Practice for Agents

**On every trade open:** Post to Signals thread with entry rationale, key levels (entry/TP/SL), leverage, risk/reward ratio.

**On every trade close:** Post exit reason, realized PnL, what worked, next plan.

**Auto-reply cron:** `dgclaw.sh setup-cron <agentId>` — automatically replies to subscriber questions via OpenClaw. This is a key differentiator for InstaClaw agents (always-on forum engagement).

---

## 8. Implementation Phases

### Phase 0: Prerequisites Verification (Day 1)

**Goal:** Confirm all dependencies exist on VMs before writing any deployment code.

- [ ] SSH into a canary VM and verify: `which jq`, `which openssl`, `which curl`, `openssl version`
- [ ] Verify `acp` CLI exists on ACP-enabled VMs: `which acp`, `acp whoami --json`
- [ ] Verify `acp token info --json` works (needed for join flow)
- [ ] Verify `acp token launch` command exists and works (needed for token creation)
- [ ] Test manual clone + join flow on canary VM:
  ```bash
  cd ~ && git clone https://github.com/Virtual-Protocol/dgclaw-skill.git
  cd dgclaw-skill && chmod +x scripts/dgclaw.sh
  export PATH="$HOME/dgclaw-skill/scripts:$PATH"
  dgclaw.sh join
  ```
- [ ] Measure RAM impact: `free -m` before and after

**Canary VM:** Pick one ACP-enabled VM with an active user who can test.

### Phase 1: Skill Deployment (Day 2-3)

**Goal:** Deploy dgclaw-skill to all VMs as a loadable skill. No user-facing changes yet.

#### 1a. Create SKILL.md

Create `instaclaw/skills/dgclaw/SKILL.md` — the agent-facing instructions. This is what the agent reads to know how to help users with DegenClaw.

**Contents (adapted from Virtuals' SKILL.md, customized for InstaClaw):**
- Activation triggers (when user mentions trading competition, DegenClaw, etc.)
- Prerequisites check flow (ACP enabled? Token launched?)
- Setup walkthrough with user checkpoints
- Trading command reference
- Forum posting best practices
- Error handling table
- Security reminders

Add supporting references:
- `instaclaw/skills/dgclaw/references/api.md` — REST API reference (from repo)

#### 1b. Update SOUL.md (DegenClaw Awareness)

Add an `append_if_marker_absent` entry to `vm-manifest.ts` files array that appends a short DegenClaw awareness paragraph to every agent's SOUL.md. Without this, agents won't proactively know the skill exists. The paragraph triggers the agent to reference the full SKILL.md when relevant keywords come up.

Marker: `DEGENCLAW_AWARENESS`

#### 1c. Update VM Manifest

In `lib/vm-manifest.ts`:
- Add dgclaw skill files to manifest (SKILL.md, references/api.md) via `extraSkillFiles`
- Add `jq` to `systemPackages`
- Bump manifest version

In `lib/ssh.ts` (`installAgdpSkill()`):
- Add dgclaw-skill git clone (or git pull if exists)
- Add `chmod +x ~/dgclaw-skill/scripts/dgclaw.sh`
- Add `~/dgclaw-skill/scripts` to PATH via `.bashrc`
- Fix extraDirs python script to APPEND (not replace) — add both ACP and dgclaw dirs
- Add partner ID placeholder injection

#### 1d. Update Manifest JSON

In `instaclaw/skills/manifest.json`:
- Add dgclaw entry with metadata

#### 1e. Canary Deploy

- Deploy to ONE VM first (CLAUDE.md rule #3)
- Verify gateway health after config change (CLAUDE.md rule #5)
- Verify skill loads: `openclaw skill list` should show dgclaw
- Verify `dgclaw.sh --help` works from agent context
- Wait for manual approval before fleet rollout

### Phase 2: Fleet Rollout (Day 4-5)

**Goal:** Push dgclaw-skill to all active VMs.

#### 2a. Fleet Push Script

Create `instaclaw/scripts/_fleet-push-dgclaw-skill.ts`:
- SSH to each healthy/degraded VM
- Git clone `dgclaw-skill` (or `git pull` if exists)
- Chmod dgclaw.sh
- Update openclaw.json extraDirs if needed
- Restart gateway
- Verify health
- **Must support `--dry-run` and `--test-first`** (CLAUDE.md rules #3, #4)

#### 2b. Rollout

1. `--dry-run` first — review output
2. `--test-first` — patches one VM, pauses for approval
3. Full fleet rollout (8 concurrent, health-checked)

### Phase 3: Agent Token + Registration (Day 5-7)

**Goal:** Enable the agent-guided setup flow so users can join DegenClaw through conversation.

This phase is purely about the SKILL.md quality — the agent reads the skill and guides users through:

1. **Check ACP status** — Is Virtuals Protocol enabled? If not, guide to dashboard toggle.
2. **Check token status** — `acp token info --json`. If no token, guide through `acp token launch`.
3. **Join DegenClaw** — `dgclaw.sh join`
4. **Fund account** — Guide deposit amount, create `perp_deposit` ACP job
5. **First trade** — Help user decide on first position, execute via `perp_trade`
6. **Forum setup** — `dgclaw.sh setup-cron <agentId>` for auto-replies

**User checkpoints (where agent MUST stop and ask):**
1. ACP authentication URL — user must click and sign in
2. Agent selection/creation — which agent to use
3. Token symbol + description — for `acp token launch`
4. Deposit amount — how much USDC to fund
5. Trade parameters — always confirm asset, direction, size, leverage before executing
6. Withdrawal amount — confirm before executing
7. Wallet topup URL — if insufficient USDC

### Phase 4: Dashboard Widget (Week 2, Optional)

**Goal:** Lightweight status widget on settings/earn page. Four numbers only.

- Leaderboard rank
- Current PnL (realized + unrealized)
- Active positions count
- Subscriber count

No full trading dashboard — users trade through conversation. Separate PRD if demand emerges.

**Data source:** `acp resource query` endpoints, cached in Supabase.

---

## 9. Error Handling

| Error | Diagnosis | Fix |
|-------|-----------|-----|
| `acp` not found | openclaw-acp not installed | `cd ~ && git clone .../openclaw-acp && npm install && npm run acp -- setup` |
| `acp whoami` errors | ACP not configured | Run `acp setup` or guide user through Virtuals toggle in dashboard |
| `dgclaw.sh join` → "token required" | Agent not tokenized | Run `acp token launch <SYMBOL> "<description>"` first |
| `dgclaw.sh join` → "agent not found" | Wrong agent address or ACP not set up | Verify with `acp agent list --json` |
| `DGCLAW_API_KEY` not found | Haven't joined yet | Run `dgclaw.sh join` |
| ACP job `REJECTED` | Invalid requirements or insufficient funds | Read `memoHistory`, fix params, create new job |
| ACP job `EXPIRED` | Timed out (>5 min) | Create new job — don't retry old one |
| Deposit/withdrawal slow | Bridge takes up to 30 min | Keep polling, don't create duplicate jobs |
| Insufficient balance | Not enough USDC in trading account | Check `/account` endpoint, deposit more |
| Wallet shows 0 USDC | ACP wallet unfunded | `acp wallet topup --json`, show user the topup URL |
| `jq` not found | Missing dependency | `sudo apt-get install -y jq` (add to provisioning) |
| `openssl` not found | Missing dependency | `sudo apt-get install -y openssl` (add to provisioning) |
| Gateway won't restart after config change | extraDirs path wrong or SKILL.md parse error | Revert config, restart with old config (CLAUDE.md rule #5) |

---

## 10. Security

- **Never commit `.env` or `private.pem`** — `.gitignore` in dgclaw-skill already covers this
- **API keys delivered encrypted** — RSA-OAEP-SHA256, no plaintext over network
- **DGCLAW_API_KEY grants forum access** — treat like a credential
- **Trade confirmations** — Agent must ALWAYS confirm trade parameters with user before executing (no autonomous trading without explicit instruction)
- **No autonomous deposits/withdrawals** — Always require user confirmation for fund movements
- **Private key lifecycle** — RSA keypair generated during `join`, private key used once to decrypt API key, then stored in temp dir that gets cleaned up

---

## 11. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Skill budget overflow | Low | High (skills silently drop) | Currently 347K/500K; dgclaw adds ~20K → 367K. Safe. Monitor on each manifest bump. |
| RAM pressure from dgclaw | Very Low | Medium | Pure bash CLI, no daemon. ACP daemon already accounted for. |
| ACP CLI breaking changes | Medium | Medium | Pin openclaw-acp to known-good commit hash in deployment |
| DegenClaw API changes | Medium | Medium | dgclaw.sh version pinning; `DGCLAW_BASE_URL` override for testing |
| Season rule changes | High | Low | Terms explicitly allow parameter changes. Agent should caveat advice. |
| User loses USDC from bad trades | High | High | SKILL.md must include risk disclaimers. Agent should never pressure users to trade or increase leverage. |
| Bridge delays cause timeout | Medium | Low | SLA is 30 min. Agent should warn user and avoid duplicate deposits. |

---

## 12. Rollout Checklist

- [x] **Phase 1a:** Write SKILL.md + references (`instaclaw/skills/dgclaw/`)
- [x] **Phase 1b:** Add SOUL.md DegenClaw awareness paragraph (`vm-manifest.ts`)
- [x] **Phase 1c:** Update vm-manifest.ts (extraSkillFiles, jq, manifest v49)
- [x] **Phase 1c:** Update ssh.ts (dgclaw clone in installAgdpSkill, partner ID placeholder, fix extraDirs append)
- [x] **Phase 1d:** Update manifest.json (add dgclaw entry)
- [x] **Phase 1d:** Update PRD with resolved questions + partner ID section
- [ ] **Phase 0:** Verify deps on canary VM (jq, openssl, acp token launch)
- [ ] **Phase 0:** Manual end-to-end test (join → deposit → trade → forum post)
- [ ] **Phase 1e:** Deploy to canary VM, verify gateway health
- [ ] **Phase 1e:** Get manual approval from Cooper
- [ ] **Phase 2a:** Write fleet push script with `--dry-run` + `--test-first`
- [ ] **Phase 2b:** Dry run → test first → full fleet
- [ ] **Phase 3:** Test agent-guided setup flow with a real user
- [ ] **Phase 3:** Verify forum auto-reply cron works
- [ ] **Phase 4:** Dashboard widget (separate PR)
- [ ] **Partner ID:** Fill in `ACP_PARTNER_ID` when Virtuals delivers

---

## 13. Resolved Questions

1. **Token launch command** — Confirmed: `acp token launch <SYMBOL> "<description>" --image "<url>"` exists in the ACP SKILL.md (line 173). Verify on live VM in Phase 0, but the command is real. **Agent must get explicit user approval before launching.**

2. **ACP version pinning** — Pin both repos to specific commit hashes. Added `DGCLAW_SKILL_COMMIT` and `ACP_SKILL_COMMIT` placeholders. Test upgrades on canary before fleet push.

3. **Autonomous trading** — Default: per-trade confirmation. Opt-in autonomous mode when user explicitly requests it (e.g., "trade autonomously"). SKILL.md makes default clear and has a checkpoint for switching modes. Deposits/withdrawals always require confirmation regardless of mode.

4. **Subscription pricing** — No default. Agent asks during setup and suggests $5-50 range. If user skips, leave unset and remind them later.

5. **jq + openssl** — openssl is on all VMs. jq added to `systemPackages` in vm-manifest.ts as a safety net. Phase 0 verification will confirm.

6. **Auto-reply safety** — Guardrails added to SKILL.md: no price predictions, no financial advice, no guarantees, share rationale not recommendations, always caveat past performance. Legal + reputational protection.

7. **Dashboard Phase 4** — Lightweight status widget only. Four numbers on settings/earn page: leaderboard rank, current PnL, active positions, subscriber count. No full trading dashboard — users trade through conversation. Separate PRD if demand emerges.

---

## 14. Virtuals Protocol Partner ID (Revenue Share)

### How It Works

Virtuals Protocol is adding a **partner ID** to the ACP CLI. When InstaClaw pre-installs the ACP CLI with our partner ID:

1. We pre-install the ACP CLI (`openclaw-acp`) on every agent VM with our partner ID injected
2. When a user sets up their agent on ACP and tokenizes, they get automatically tagged with InstaClaw as the partner
3. A share of token generation and trading fees gets routed back to InstaClaw

### Implementation

- `ACP_PARTNER_ID` constant in `lib/ssh.ts` — currently empty placeholder
- Injection point: `installAgdpSkill()` writes `partner.json` to the ACP directory after clone
- When Virtuals delivers the actual ID + mechanism (expected 2026-03-29 or 2026-03-30), update:
  1. The `ACP_PARTNER_ID` constant with our assigned ID
  2. The injection code if the mechanism differs from `partner.json` (could be env var, config key, or CLI flag)

### Zero User Impact

This is transparent attribution — users don't see or interact with the partner ID. No additional cost, no behavior change. It's a distribution/referral mechanism.

---

## Appendix A: Differences From Original Draft

This PRD was audited against:
- Live website: `https://degen.virtuals.io` (homepage + /terms)
- GitHub repo: `https://github.com/Virtual-Protocol/dgclaw-skill` (SKILL.md, dgclaw.sh, references/api.md)
- InstaClaw codebase: `lib/acp-api.ts`, `lib/ssh.ts`, `lib/vm-manifest.ts`, `skills/manifest.json`

**Key corrections made:**
1. Fixed ACP install command (`npm run acp -- setup`, not `npm link`)
2. Added missing `recipient` field to `perp_withdraw` schema
3. Corrected polling interval from 10-15s to 5s
4. Added 7 missing dgclaw.sh commands (`forums`, `posts`, `unreplied-posts`, `setup-cron`, `remove-cron`, `token-info`, `subscribe`)
5. Added forum auto-reply cron feature (high-value, was completely absent)
6. Added `token-info` command
7. Acknowledged existing ACP infrastructure (was being rebuilt from scratch)
8. Added deployment architecture (vm-manifest, configureOpenClaw, fleet push)
9. Added phased rollout with canary (per CLAUDE.md rules #3, #4)
10. Separated agent conversation instructions from product spec (those belong in SKILL.md)
11. Added leaderboard eligibility rules from Terms (min trades + volume or score = 0)
12. Added risk assessment and security considerations
13. Added `DGCLAW_BASE_URL` env override for staging
14. Added dependency verification step (jq, openssl)
