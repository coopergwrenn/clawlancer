# Pre-Bake Silent-Degradation Sweep — 2026-05-24

**Companion to**: `snapshot-bake-checklist-2026-05-24.md`
**Trigger**: Cooper's ultrathink directive after the validator-gates commit `706076dd` shipped. Pattern check: every prior snapshot bake surfaced an undetected silent failure. This is the final sweep before the v120 bake.
**Scope**: 10 items investigated. Findings reported below, with fixes shipped inline where possible.

---

## Summary

| # | Item | Status | Fix |
|---|---|---|---|
| 1 | Reconciler CDP awareness | **NOT a gap** | 30-min cron handles both provisioning + drift; CDP is backup-wallet so 30-min cycle is appropriate |
| 2 | Pool VM staleness | **NOT a gap** | v113→v120 delta (7 versions) reconciles in ~5 min; validator gates all snapshot-only artifacts |
| 3 | Vercel cron count | **NOT a gap** | 44/100 (Pro plan limit). New P2 validator gate added, warns at 80, fails at 100. |
| 4 | BANKR_MAINTENANCE staleness alert | **Real gap** | No fix tonight — needs Cooper's input on alert pattern (see below) |
| 5 | Anthropic API balance monitoring | **Real gap** | No fix tonight — needs Cooper's Admin API key provisioning (see below) |
| 6 | secret_version on configureOpenClaw | **NOT a gap** | DB default 0 → reconciler picks up on first tick (intentional default-low behavior) |
| 7 | OpenClaw version pin | **NOT a gap** | `OPENCLAW_PINNED_VERSION="2026.4.26"` (Rule 65); no upgrade path bypasses the pin |
| 8 | EDGE_CITY_RESEARCH_SALT rotation docs | **NOT a gap** | Documented in 6 places (Vendrov PRD, edgeclaw-partner PRD, matchpool-bridge.ts, README, etc.) |
| 9 | GBRAIN_ANTHROPIC_API_KEY architecture | **Validator gap (FIXED)** | 3 new gates added to `_postbake-validation.ts`; details below |
| 10 | Google OAuth verification status | **Cooper input** | No fix possible — external dependency |

**Net code change tonight**: 5 new validator gates added to `instaclaw/scripts/_postbake-validation.ts` (1 cron-count + 1 CDP-on-disk + 3 gbrain-EnvironmentFile-architecture). All compile clean and validated against vm-linode-06.

---

## Item-by-item findings

### 1. Reconciler CDP awareness — NOT A GAP

**Investigation**: `grep -nE 'cdp_wallet_address|CDP_WALLET_ADDRESS' instaclaw/lib/vm-reconcile.ts` returns ZERO matches. CDP is NOT in `SECRET_ENV_VAR_SOURCES` (which has 4 universal/edge_city secrets only).

**However**: `/api/cron/provision-missing-cdp-wallets` (every 30 min) handles BOTH provisioning AND env-vs-DB drift fixup (lines 96-148: SSH-writes `CDP_WALLET_ADDRESS` to `~/.openclaw/.env` after minting, AND rewrites `WALLET.md`). Mirrors `/api/cron/provision-missing-bankr-wallets`.

**Why the 30-min vs 3-min interval is fine**: CDP is the BACKUP wallet (used only when Bankr is in maintenance). A 30-min window for drift recovery is appropriate for a fallback path. Primary-path wallets (Bankr) follow the same pattern.

**Recommendation**: None. The current architecture is intentional.

### 2. Pool VM staleness — NOT A GAP

**Current snapshot**: `private/38977398` (v113, baked 2026-05-22).

**Delta to v120 (7 manifest versions)**:
- v114: cronJobsRemove vm-watchdog (applied by stepCronJobs, ~3 min)
- v115/v118: OPENCLAW_DISABLE_BONJOUR env (applied by stepSystemdUnit + reload, ~3 min)
- v118: typing keys (applied by stepConfigSettings → restart, ~3 min)
- v119: statusReactions=false (applied by stepConfigSettings, ~3 min)
- v120: TasksMax=infinity (applied by stepSystemdUnit, ~3 min)
- v120: STRIP_THINKING_v2026_5_20_COMPAT_v1 sentinel in strip-thinking.py (applied by stepFiles or file-drift cron, ~5 min)

`LINODE_SNAPSHOT_CV=113` < `VM_MANIFEST.version=120` → reconciler `lt(cv, manifest)` filter includes every fresh-from-snapshot VM → full delta applied within ~5 min of first message.

**Snapshot-only artifacts (NOT rebuilt by reconciler on fresh VM)**:
- `bun` binary (~30MB) — installed by §3.4 bake-only
- `gbrain` binary + `~/.bun/install/global/node_modules/gbrain/` (~50MB) — installed by §3.4
- `gbrain.service` systemd unit — created by install-gbrain.sh Phase E5
- `~/.openclaw/scripts/pglite-checkpoint.sh` — installed by install-gbrain.sh Phase I
- `Chromium` binary (apt package)
- `node_exporter` binary + systemd unit
- `xvfb`, `x11vnc`, `websockify` system services
- `Caddy` reverse-proxy
- ufw rules (9100/tcp, 8765/tcp) — set by setup.sh / stepUfwRules

**All of these are gated by the v120 validator** (postbake-validation.ts checks every one). As long as the validator passes pre-imagize, snapshot encodes them correctly.

**Recommendation**: None. v113→v120 reconcile is fast (<5 min), and snapshot-only artifacts are validator-gated.

### 3. Vercel cron count — NOT A GAP (NEW GATE ADDED)

**Current**: 44 crons in `instaclaw/vercel.json`. Pro plan limit per project: **100** (verified via `https://vercel.com/docs/cron-jobs/usage-and-pricing` 2026-05-24).

**Headroom**: 56 crons. Comfortable.

**Fix shipped**: New P2 gate in `_postbake-validation.ts` (gate "0b"): reads `vercel.json`, counts crons, warns P1 at 80, fails P0 at 100. Surfaces in every bake/test run so operators know the count without manual `jq`.

### 4. BANKR_MAINTENANCE staleness alert — REAL GAP (needs Cooper input)

**Investigation**: `lib/bankr-maintenance.ts` exists and gates `provisionBankrWallet` + `cron/provision-missing-bankr-wallets`. But:
- No timestamp tracking — boolean env var with no `set_at` field
- No alert cron that fires after N days of `BANKR_MAINTENANCE=true`
- No DB column tracking the maintenance state

**Risk**: If Cooper sets `BANKR_MAINTENANCE=true` and Bankr comes back online but nobody flips the flag, every signup misses the Bankr wallet path forever. Discovered only when a user reports.

**Recommended fix shapes** (Cooper picks one):
1. **Daily reminder cron** (simplest): runs at 12:00 UTC, checks `process.env.BANKR_MAINTENANCE === "true"`, sends Cooper a daily email "Bankr maintenance still on; confirm." Spammy but unmissable.
2. **DB-tracked maintenance state** (better): add `bankr_maintenance_state` table with `enabled_at` timestamp. Health-check cron writes `enabled_at` when first observing `true`, clears on `false`. Daily cron alerts if `enabled_at > NOW() - 7 days`.
3. **Vercel API timestamp lookup** (most accurate): cron calls `vercel env ls --json` via Vercel personal access token, reads the `updatedAt` field of `BANKR_MAINTENANCE`, alerts if > 7 days ago. Requires Cooper to provision a `VERCEL_PAT_FOR_AUDIT` token.

**Status**: Not shipped tonight — needs Cooper's choice. Tracking as P1 follow-up.

### 5. Anthropic API balance monitoring — REAL GAP (needs Cooper input)

**Investigation**: 
- `app/api/cron/usage-anomaly-check/route.ts` exists but monitors PER-USER usage (volume drops, cost spikes by user_id), not org-level Anthropic balance.
- `scripts/fleet-clear-billing-cache.ts` is REACTIVE — clears `auth-profiles.json` after Anthropic returns 402.
- `app/api/gateway/proxy/route.ts:1278-1388` detects 402 / "credit balance too low" in the proxy response and caches the failure state per profile.
- **No proactive Anthropic-account-level balance check.**

**Risk per Cooper's framing**: The May 14 incident hit -$0.39 → fleet-wide failure. If balance runs out during Edge Esmeralda (1000 attendees starting 2026-05-30), every agent silently 402s.

**Recommended fix shapes** (Cooper picks one):
1. **Anthropic Admin API balance check** (correct): hourly cron calls `GET /v1/organizations/usage` with `sk-ant-admin-...` key, alerts at < $50, hard alerts at < $10. Requires Cooper to mint an Admin API key (different from the regular `sk-ant-api...` keys we already have) and stash in `ANTHROPIC_ADMIN_API_KEY` Vercel env.
2. **Auto-reload enabled** (best): set Anthropic billing to auto-reload at $50, top up to $500. This is a one-time toggle in Cooper's Anthropic console — no code change. Would have prevented the May 14 incident outright.
3. **Probe-based heuristic** (worst): minimax-canary already pings a low-cost endpoint. Could extend to log proxy 402 errors → alert. Reactive, not proactive — won't prevent the outage, just shorten its duration.

**Cooper's call needed**: which fix (or all three).

**Status**: Not shipped tonight. Tracking as P0 follow-up (paying-customer impact if balance runs out during Edge).

### 6. secret_version on configureOpenClaw — NOT A GAP

**Investigation**: `vmUpdate` object at `lib/ssh.ts:8895` does NOT include `secret_version`. The DB column has `DEFAULT 0` per migration `20260514120000_secret_version.sql`.

**Why this is correct**: Default-low (0) means every fresh VM enters the reconciler's candidate query (`secret_version.lt.4`) on its first 3-min tick. `stepEnvVarPush` runs and writes all current secrets to `.env`. Idempotent overwrite if the .env values are already correct (from snapshot bake time).

**Edge case**: between configureOpenClaw completion and the first reconcile tick (3 min), the agent runs with whatever was in the snapshot's .env. If GBRAIN_ANTHROPIC_API_KEY was rotated between bake and provision, gbrain runs with the OLD key for those 3 min — but gbrain doesn't strictly need ANTHROPIC_API_KEY for /health (only embeds + put_page), so the user-visible impact is bounded.

**Recommendation**: None. The current architecture is intentional and self-healing.

### 7. OpenClaw version pin — NOT A GAP

**Investigation**: `OPENCLAW_PINNED_VERSION = "2026.4.26"` (`lib/ssh.ts:97`). Used by:
- `lib/vm-reconcile.ts:4348-4421` (`stepNpmPinDrift` — reinstalls if mismatch)
- `lib/ssh.ts:8270-8271` (rollback REINSTALL_CMD path)
- `lib/ssh.ts:12358` (`upgradeOpenClaw` standalone helper — also uses the constant)

No code path can accidentally install `openclaw@2026.5.20`. Even `npm install openclaw@latest` would be a manual operator action; no cron/reconciler step does this.

**Defense-in-depth**: `lib/agent-intelligence.ts:983` instructs the agent itself never to `npm install -g openclaw` — soft rail but real.

**Recommendation**: None. Pin discipline is solid.

### 8. EDGE_CITY_RESEARCH_SALT rotation — NOT A GAP

**Investigation**: Documented in 6 places, all findable by a future terminal via `grep -rn EDGE_CITY_RESEARCH_SALT`:
- `docs/edge-vendrov-prereg-template-2026-05-30.md:122` — "rotated 7 days post-village close"
- `docs/cloud-init-implementation-map.md:1741`
- `docs/prd/index-network-signal-schema-spec.md:139`
- `docs/prd/matching-engine-design-2026-05-03.md:536`
- `docs/prd/edgeclaw-partner-integration.md` (3 references: 1054, 1068, 1966, 2012, 2891, 3030)
- `lib/research-export/matchpool-bridge.ts:34` + `lib/research-export/README.md`

**However**: I did NOT find an OPERATIONAL runbook for HOW to rotate (just WHEN). The mechanics (regenerate hex, `printf '<new>' | vercel env add EDGE_CITY_RESEARCH_SALT production`, update `saltVersion` tag from `ee26-v1` to `ee26-v2`, invalidate Vendrov export cache if any) aren't documented as a checklist.

**Recommendation (P2)**: Post-Edge, write a one-page rotation runbook. Not urgent — Cooper can derive the steps from the documented `lib/research-export/matchpool-bridge.ts` interface.

### 9. GBRAIN_ANTHROPIC_API_KEY architecture — VALIDATOR GAP (FIXED)

**Investigation via SSH on 3 edge VMs** (vm-922 / 173.255.236.248, vm-050 / 172.239.36.76, vm-917 / 45.33.94.224):

| VM | gbrain active | GBRAIN_ANTHROPIC in `~/.openclaw/.env` | `~/.gbrain/.env` exists | Inline key in unit |
|---|---|---|---|---|
| vm-922 | yes (health 200) | **count=0** | no | yes (legacy) |
| vm-050 | yes (health 200) | count=1 | no | yes (legacy) |
| vm-917 | yes (health 200) | count=1 | no | yes (legacy) |

**All 3 edge VMs are on the OLD inline architecture**. vm-922 additionally has `GBRAIN_ANTHROPIC_API_KEY` missing from `~/.openclaw/.env` — gbrain still works because the key is INLINE in the systemd unit, but rotation will silently fail until `stepGbrainEnvSync` runs.

**The new architecture (commit c9d3c5b1, 2026-05-22)**: `install-gbrain.sh` Phase E5 (lines 1166-1253) writes `EnvironmentFile=-$HOME/.gbrain/.env` to the gbrain.service unit. Rotation now works automatically because `stepGbrainEnvSync` updates `~/.gbrain/.env` and `systemctl restart gbrain` re-reads the file (no daemon-reload needed).

**The new bake will use the new architecture** because `install-gbrain.sh` was updated. The snapshot will encode `EnvironmentFile=` directive + `~/.gbrain/.env` file. Fresh-from-snapshot VMs ship rotation-safe.

**Existing edge VMs** are migrating via `stepGbrainEnvSync` over time. Not urgent.

**Fix shipped**: 3 new validator gates in `_postbake-validation.ts` (partner-gated to gbrain-installed VMs):
- `gbrain.service uses EnvironmentFile architecture` (P0)
- `gbrain.service has NO inline Environment=ANTHROPIC_API_KEY` (P0)
- `~/.gbrain/.env present + contains ANTHROPIC_API_KEY=sk-ant-` (P0)

These catch the regression class where install-gbrain.sh reverts to pre-c9d3c5b1 emission. On the bake VM these are hard-P0 (§3.4 contract installs gbrain); on operator-audit against non-edge VMs they're P2.

### 10. Google OAuth verification — COOPER INPUT NEEDED

**Investigation**: No code references to Google OAuth verification status / pending review found in `docs/`, `instaclaw/docs/`, `CLAUDE.md`, or memory files. The earlier comment Cooper referenced ("replied to Google May 21, awaiting response") lives only in the chat session — not codified.

**Risk if Google rejects before Edge**: Dashboard login at `instaclaw.io` breaks for new signups. Existing logged-in users unaffected (cookie-based session).

**Fallback paths**:
- **ChatGPT OAuth** (already implemented per `docs/prd/chatgpt-oauth-*` files) — can become primary signup if Google breaks
- **Email/password** — not implemented; would require a new auth path
- **World Mini App** — paths exist (`docs/PRD-world-mini-app-*`) but partner-specific

**Recommendation**: 
- Cooper: forward the Google OAuth response to a place a future terminal can find (file `docs/google-oauth-verification-status.md`, even one paragraph).
- If high-risk: pre-cutover to ChatGPT OAuth as primary BEFORE the response arrives.

**Status**: Cooper input needed. Not actionable from terminal-side.

---

## Net deliverable tonight

**Code changes**: 5 new validator gates in `instaclaw/scripts/_postbake-validation.ts`:
1. Vercel cron count under 100 (P2/P1/P0 tiered by count, gate "0b")
2. CDP_WALLET_ADDRESS in `~/.openclaw/.env` (P0 test-mode)
3. gbrain.service uses EnvironmentFile architecture (P0 gbrain-installed)
4. gbrain.service has NO inline ANTHROPIC_API_KEY (P0 gbrain-installed)
5. `~/.gbrain/.env` present + contains ANTHROPIC_API_KEY (P0 gbrain-installed)

**Doc changes**: This file.

**Validator delta against vm-linode-06**: 219 checks → 221 checks. P0 fails went 2→3 (CDP gate correctly catches that this legacy serving VM doesn't have CDP_WALLET_ADDRESS in .env; the 30-min cron will mint+push within 30 min). The 3 new gbrain gates didn't fire because vm-linode-06 isn't edge_city (correctly partner-gated).

**Items requiring Cooper input** (P0/P1 follow-ups):
- Item 5 — **Anthropic auto-reload toggle** (one-click in console; would have prevented May 14 outage). Strongly recommend toggling before Edge.
- Item 4 — pick a shape for BANKR_MAINTENANCE staleness alert.
- Item 10 — drop a one-paragraph note about Google OAuth status in `docs/`.

---

## Files modified

- `instaclaw/scripts/_postbake-validation.ts` (+5 gates, ~75 LOC)
- `instaclaw/docs/pre-bake-silent-degradation-sweep-2026-05-24.md` (NEW — this file)
