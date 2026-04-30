# InstaClaw — Project Notes

## Quick Commands

- **"spots N"** or **"provision N VMs"** — Provision N new dedicated CPU VMs for the ready pool. Use the exact specs below. NEVER deviate.

## VM Provisioning Standard (MANDATORY)

ALL new VMs must use these exact specs:

- **Provider:** Linode ONLY (never Hetzner or DigitalOcean)
- **Type:** `g6-dedicated-2` (Dedicated 4GB — 2 dedicated vCPU, 4GB RAM, 80GB disk)
- **Region:** `us-east`
- **Snapshot:** `private/38458138` (instaclaw-base-v62-bankr-cli-0.3.1 — baked 2026-04-27 from v58 base. OpenClaw v2026.4.5, **@bankr/cli@0.3.1** (was 0.2.15 in v58 — bumped for direct claim API target POST /token-launches/:tokenAddress/fees/claim). All other v58 contents preserved: v58 manifest scripts at canonical SHAs, full concatenated SOUL.md, workspace files at canonical v58, Chromium 147, ffmpeg, Xvfb, x11vnc, websockify, node_exporter, jq, both SSH deploy keys, 7/7 crons, exec-approvals.json security=full. 5296 MB. 7/7 verified.)
- **Cost:** $29/mo per VM (negotiated Linode rate)
- **DB status:** `provisioning` (cloud-init-poll cron auto-marks as `ready` in ~3-5 min)

NEVER use old snapshots (private/36895419, private/38069990, private/38111101 (v58), or any pre-v62 image). NEVER provision shared CPU (g6-standard-2). NEVER provision on Hetzner or DigitalOcean.

## Project Structure

- `instaclaw/` — Next.js app (instaclaw.io)

## Key Info

- Git remote: https://github.com/coopergwrenn/clawlancer.git
- Branch: main
- Dev server: `npm run dev` from instaclaw/, runs on port 3001
- Production: https://instaclaw.io
- Admin email: coop@valtlabs.com

## Mandatory Rules

These are permanent rules. Never violate them.

### 1. Verify DB Schema Before Updates

NEVER add columns to a Supabase `.update()` call without first confirming the column exists on that table. Before adding any field, run:
```sql
select column_name from information_schema.columns where table_name = 'TABLE_NAME'
```
and confirm the column is present. The `consecutive_failures` bug happened because a column from one table was added to an update on a different table.

### 2. Verify Config Schema Before Changing Values

NEVER change an OpenClaw config value without checking the config validation/schema in the OpenClaw dist files on a VM. A runtime code path does NOT mean a value is accepted by the config schema validator. The `auth.mode: "none"` crash happened because the value exists in runtime code but is rejected by the config schema — crashing the gateway on startup.

### 3. Test on One VM Before Fleet-Wide Deploy

NEVER deploy a config change or patch to the entire fleet at once. Always:
1. Run on ONE VM first
2. Verify the gateway is active and health returns 200
3. Wait for manual confirmation before continuing to the rest

Fleet scripts must include a `--test-first` flag that patches one VM and pauses for approval.

### 4. Dry-Run Fleet Operations First

NEVER run a fleet operation without `--dry-run` first. All fleet scripts must support `--dry-run` and it must be run before the real execution. Review the dry-run output before proceeding.

### 5. Verify Gateway Health After Config Changes

After any config change + gateway restart via SSH, wait up to 30 seconds for the gateway to reach "active" state (`systemctl --user is-active openclaw-gateway` returns "active" AND health endpoint returns 200). If it doesn't come back:
1. REVERT the config change
2. Restart the gateway with the old config
3. Report the failure
Never leave a crash-looping gateway.

### 6. No Trailing Newlines in Environment Variables

NEVER use `<<<` (here-string) or `echo` to pipe values into `vercel env add` — both add a trailing newline that corrupts API keys and secrets. Always use `printf` which does NOT append a newline:

```bash
# CORRECT:
printf 'the_value' | npx vercel env add VAR_NAME production

# WRONG — adds trailing \n:
npx vercel env add VAR_NAME production <<< "the_value"
echo "the_value" | npx vercel env add VAR_NAME production
```

The `BANKR_PARTNER_KEY` incident: a trailing `\n` was appended to the API key, which would have caused every Bankr API call to fail with auth errors.

### 7. Snapshot Refresh After Manifest Bumps

Every time `VM_MANIFEST.version` is bumped in `vm-manifest.ts`, the base snapshot used for new VMs becomes stale. The reconciler fixes existing VMs automatically, but NEW VMs provisioned from the old snapshot start with outdated config until reconciler catches them.

**After every manifest version bump, STOP and tell Cooper:**

> "Manifest bumped to v{N}. The fleet reconciler will push this to existing VMs automatically. However, the base snapshot is now stale — new VMs provisioned from it won't have these changes until reconciler runs. Should we bake a new snapshot now, or wait until we've accumulated more changes?"

**When to bake a new snapshot:**
- After 3+ manifest bumps since last snapshot
- Before any large provisioning run (e.g., "spots 20")
- After major changes (new scripts, new crons, new workspace files, OpenClaw version upgrade)
- Cooper explicitly asks

NEVER provision a batch of VMs from a snapshot that's >3 manifest versions behind.

### 8. NEVER Manually Provision VMs (replenish-pool Owns the Pool)

VM ready pool replenishment is **fully automated** via `/api/cron/replenish-pool` (runs every 5 min via Vercel cron). This cron:

- Maintains the ready pool between `POOL_FLOOR` (10) and `POOL_TARGET` (15)
- Provisions up to `MAX_PER_RUN` (10) VMs per cycle from `LINODE_SNAPSHOT_ID`
- Uses a distributed lock (`instaclaw_cron_locks` table) to prevent concurrent runs
- Counts ready + provisioning as in-flight inventory (prevents over-provision)
- Sends admin alerts on critical depletion, cost ceiling, stuck VMs, lock failures

**NEVER manually provision VMs** (via Linode API directly, scripts, or "spots N" commands) **while the cron is the system of record.** Manual provisioning will:

- Race with the cron's `getNextVmNumber()` query → duplicate VM names
- Push the pool past `POOL_CEILING` (30) → wasted spend
- Confuse the cron's "in-flight" decision logic
- Break the cron lock semantics (the lock only protects cron-vs-cron, not cron-vs-human)

**The ONLY acceptable reasons to manually provision:**

1. **The cron is broken or disabled.** Verify by checking Vercel cron logs and querying `instaclaw_cron_locks`. If the cron has not run successfully in >30 min, fix it FIRST. Don't paper over the issue with manual provisioning.
2. **An emergency batch >10 VMs is needed in <10 min** (e.g., a viral launch). Even then, raise `MAX_PER_RUN` and let the cron handle it across 2-3 cycles, OR pause the cron in vercel.json before manually provisioning to avoid races.

If you think you need to manually provision, **STOP and tell Cooper first.** Explain why the cron isn't sufficient. Get explicit approval. Then take the cron lock from your manual script:

```typescript
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";

const acquired = await tryAcquireCronLock("replenish-pool", 600, "manual-script");
if (!acquired) throw new Error("Replenish-pool cron is currently running, aborting manual provision");
try {
  // ... provision VMs ...
} finally {
  await releaseCronLock("replenish-pool");
}
```

**This rule applies to YOU (Claude Code) too.** Do NOT provision VMs in scripts unless you've explicitly disabled the cron and told Cooper.

### 9. Partner Portal Tagging Must Update Existing Users (Not Just Set a Cookie)

Partner portals (`/edge-city`, future `/eclipse`, etc.) tag a user's account with their `partner` field so partner-specific skills, env vars, and SOUL.md context get installed during `configureOpenClaw()`. The original mechanism — set an `instaclaw_partner` cookie that `lib/auth.ts` reads at user creation — **only fires once, on first signup**. Existing users who later visit a partner portal get the cookie but their existing user record is never tagged.

**The Timour incident (2026-04-30):** Timour signed up at `/signup` on 2026-04-01 with `timour.kosters@gmail.com`. Got vm-354 assigned 2026-04-03. Later visited `/edge-city`, which redirected him through signup again — he created a *second* account `t@timour.xyz` with `partner = edge_city` but no VM. His real working agent (vm-354 / `edgeclaw1bot`) sat with `partner: null` for ~4 weeks. The Edge skill, EDGEOS env vars, and SOUL.md edge section were never installed because every code path is gated on `partner === "edge_city"`. Cooper's own `edgecitybot` (vm-780) had the identical bug. Two partners, same dual-account failure mode.

**Mandatory behavior for any partner portal:**

- Partner portal pages MUST call `POST /api/partner/tag` with `{ partner: "<slug>" }` on the primary CTA. The endpoint:
  - Updates `instaclaw_users.partner` on the existing record if logged in
  - Syncs `instaclaw_vms.partner` for any assigned VMs (so admin queries are immediately accurate)
  - Sets the `instaclaw_partner` cookie (defensive — covers the not-logged-in path)
  - Validates `partner` against `VALID_PARTNERS` allow-list — never accept arbitrary strings
- Existing-cookie-only flow (`document.cookie = ...; router.push("/signup")`) is the legacy path. **Do not ship a new partner portal that uses only cookies.**
- When adding a new partner (Eclipse, Devcon, etc.), the changes are: (a) one-line addition to `VALID_PARTNERS` in `app/api/partner/tag/route.ts`, (b) new portal page that calls the endpoint with the right slug. Nothing else.

**Backfill any historical drift:**

Partner-tagged users may exist in the database but their assigned VMs have `partner: null` (because the configure that synced user → VM happened before the partner field was set). Periodically check:

```sql
SELECT u.email, v.name, u.partner AS user_partner, v.partner AS vm_partner
FROM instaclaw_users u
JOIN instaclaw_vms v ON v.assigned_to = u.id
WHERE u.partner IS NOT NULL AND v.partner IS NULL;
```

If any rows return: those VMs are missing partner-gated skills. Fix by setting `vm.partner = u.partner`, then either (a) running a one-shot SSH install of the partner skill (idempotent: clone-if-missing + cron + env vars + SOUL.md append with marker), or (b) waiting for the next reconciler tick to pick up the change. **Do NOT** force-run `configureOpenClaw` on an already-onboarded user — that triggers the workspace-wipe path (per the bf46ee3d wipe-guard fix). Use `auditVMConfig` or direct SSH instead.

**Dual-account hazard:** any time you discover a user with a tagged-but-VM-less account AND an untagged-but-VM account with similar identifiers (same name, similar email, partner-themed Telegram bot like `edgecitybot` or `edgeclaw1bot`), suspect the same bug. Confirm by checking `vm_lifecycle_log` — the tagged account will show 0 lifecycle entries.

### 10. Reconciler Must Verify Every Config Set — `|| true` Pattern Is BANNED

`stepConfigSettings` in `lib/vm-reconcile.ts` MUST verify every `openclaw config set` succeeded BEFORE any code path advances `config_version`. Silent failures cause permanent fleet drift: once `config_version` reaches the manifest version, the reconcile-fleet route's `lt("config_version", VM_MANIFEST.version)` filter (route.ts:122) excludes the VM forever, so a setting that silently failed once will NEVER be retried.

**The 2026-04-30 streaming.mode incident:** v68 manifest added `channels.telegram.streaming.mode = "off"`. The non-strict reconciler path used `openclaw config set <key> '<val>' || true` then unconditionally pushed every key to `result.fixed` and let `config_version` bump. For ~53% of the fleet, the config-set transiently failed (concurrent gateway-config write, lock conflict — root cause unconfirmed) but no signal made it to the cron route. Result: 16/30 sampled VMs locked at `streaming.mode = partial`, leaking raw tool-call output to Telegram users. Same failure mode as the 2026-04-27 v59/v60 incident with `gateway.openai.chatCompletionsEnabled` — supposedly fixed by strict mode, but strict mode is gated on `STRICT_RECONCILE_VM_IDS` env var which most of the fleet doesn't have.

**Mandatory pattern for any reconciler step that mutates VM state:**

1. Read current state.
2. Apply change.
3. **Re-read state.** Compare to expected.
4. If mismatch: push to `result.errors` (which the reconcile-fleet `pushFailed` gate at route.ts:245 uses to refuse the `config_version` bump). DO NOT push to `result.fixed`.
5. The next cron cycle will retry naturally because `config_version` didn't advance.

**Banned patterns:**
- `command || true` followed by unconditional success counting
- `swallowing exit codes via 2>/dev/null || true`
- Any pattern where "we tried" is treated as "we succeeded"

**Detection:** any `result.fixed.push(...)` that doesn't have a verify-after-set immediately above it is suspect. Strict mode (per-key with exit-code check) is the simplest correct pattern when batched verification is too complex.

---

## OpenClaw Upgrade Playbook (MANDATORY)

> **Institutional memory from the OpenClaw 2026.4.5 → 2026.4.26 (manifest v67) upgrade incident, 2026-04-29 → 2026-04-30.** A multi-day fleet-wide outage. **Read this end-to-end BEFORE bumping `OPENCLAW_PINNED_VERSION`, `VM_MANIFEST.version`, `WORKSPACE_SOUL_MD`, or any agent-context template.** Every step here was learned the hard way.

### What went wrong (post-mortem)

Cascading failure across five layers:

1. **OpenClaw 2026.4.26 had stricter default timeouts** than 2026.4.5. Agent chat-completion requests with ~29K-token prompts started aborting before Anthropic finished generating. /health stayed 200; chat broke silently.
2. **The in-VM watchdog's 3-minute FROZEN threshold then killed gateways** that were mid-completion-but-slow. Each kill triggered a systemd restart, the gateway took ~90s to reach `ready`, the watchdog killed it again — kill loop.
3. **The reconciler's manifest entries for SOUL.md / CAPABILITIES.md are all `append_if_marker_absent` / `insert_before_marker`, never `overwrite`.** The v67 routing-table edit was an in-place row replacement, which no manifest mode supports. SOUL.md never updated on existing VMs even after `config_version` advanced. Required a one-shot fleet patch + a new surgical reconciler step (`stepV67RoutingTablePatch`).
4. **The npm-install verify in `stepNpmPinDrift` was racy.** The local-side `node-ssh` timeout fired before the remote install finalized, so `openclaw --version` returned empty and the script reported PUSH-FAILED — even when the install was already complete on disk. The bin symlink was created seconds AFTER the local-side `await` returned. Required: 600s timeout + on-disk verify (test bin symlink + package.json version + `dist/index.js`) + auto-retry on first verify miss.
5. **A fleet patch script bumped `config_version=v67` after only editing SOUL.md content.** VMs still on Node v22.22.0 + OpenClaw 2026.4.5 got tagged v67 in the DB, so the upgrade script skipped them as "already at manifest version." Recovery required a from-disk SSH audit (`_db-reset-config-version-from-disk.ts`) on ~115 VMs to reset `config_version` to actual on-disk state — corrected 83 VMs.

By the end: 83/88 v67-marked VMs couldn't complete chat completions. ~15 VMs needed individual forensics. Three days of fleet thrash. /health was green throughout.

### Pre-flight checklist (before bumping `OPENCLAW_PINNED_VERSION`)

Run **all** of these before touching anything:

1. **Read the OpenClaw release notes line by line** for the version range you're crossing. Look for: timeout/deadline default changes, config schema changes (added/removed/renamed keys), watchdog or health-check changes, plugin loader changes, Node compat changes, any "BREAKING" markers. The 2026.4.5→.26 jump introduced silent timeout-default changes that no commit message flagged.
2. **Measure prompt size against `bootstrapMaxChars`.** The agent's upfront context is `WORKSPACE_SOUL_MD + SOUL_MD_INTELLIGENCE_SUPPLEMENT + SOUL_MD_LEARNED_PREFERENCES + "\n\n" + SOUL_MD_OPERATING_PRINCIPLES + SOUL_MD_DEGENCLAW_AWARENESS + SOUL_MD_MEMORY_FILING_SYSTEM` plus CAPABILITIES.md and TOOLS.md. If the resolved total exceeds 30,000 chars (the `bootstrapMaxChars` ceiling at `lib/ssh.ts:2939`), upfront context is being silently truncated. As of v67 the SOUL.md component alone is 31,905 chars — already over. Treat any further bump as a hard stop until trimmed.
3. **Confirm the reconciler can actually push your changes.** If your edit is an in-place line replacement in SOUL.md / CAPABILITIES.md / any append-managed file, the reconciler **cannot** apply it via the existing manifest modes. You must either (a) add a surgical reconciler step (see `stepV67RoutingTablePatch` in `lib/vm-reconcile.ts`), (b) ship a one-shot fleet patch, or (c) accept that only newly-provisioned VMs will get the change. Cooper's commit message claiming "reconciler picks up the template change" is wrong by default — append modes can't replace existing rows.
4. **Walk every `stepX(...)` in `lib/vm-reconcile.ts`** and confirm none has a hard-coded assumption (timeout, schema, path, version regex) that the new OpenClaw version invalidates.

### Canary testing (NON-NEGOTIABLE before fleet rollout)

**Never bump the manifest version until canary tests pass.** Order matters:

1. **vm-050 (Cooper's test agent), full reconcile.** Reconcile to the new manifest. Send a real `POST /v1/chat/completions` with a representative ~29K-token prompt (sample the actual SOUL.md + CAPABILITIES.md + EARN.md upfront load). Verify it completes in <30 s with a non-empty response. Run the same probe **3× over 5 minutes** — single-shot success doesn't catch watchdog kill-loops, which surface on the second or third request.
2. **3 paying-user VMs, one per tier (power / pro / starter).** Pick VMs with real usage history — non-trivial sessions, customized SOUL.md identity, real bot tokens. Reconcile each. Run the same chat-completion probe on each. Watch `journalctl --user -u openclaw-gateway -f` for the full 5-minute window. Look for: SIGTERM, "received SIGTERM" within seconds of "ready", watchdog kills, OOMs, "Cannot find module" errors.
3. **Hold for at least 1 hour after the third canary completes** before bumping `VM_MANIFEST.version`. Watchdog cycles run every minute; a kill-loop will surface within 5–10 cycles.

If any canary fails, **DO NOT proceed**. Re-read the OpenClaw changelog, fix the divergence (timeout default, config key, watchdog threshold), and restart the canary cycle from step 1.

### Fleet rollout

Only after canaries are green for ≥1 hour:

- **`--concurrency=3` is the maximum.** Higher values amplify any per-VM failure into a fleet-wide stampede. The v67 rollout at concurrency=5 produced ~30% transient failure rate in wave 1; dropping to 3 stabilized it. Reliability beats speed.
- **Waves of 10 with an audit gate between each.** The audit must HALT the upgrade on the first per-VM failure (see next section).
- **Hold the `reconcile-fleet` cron lock for the duration** so the Vercel cron can't race the local script. Use `tryAcquireCronLock("reconcile-fleet", 8*3600, "manual-fleet-upgrade-vN")`.
- **Do not bake a new snapshot until the fleet upgrade is fully clean** AND has soaked for ≥1 hour. Stale snapshots cause new VMs to provision behind the manifest version and race the reconciler — same drift, same lying-DB problem.

### Wave audit gates (NON-NEGOTIABLE)

After every wave of 10, audit each VM. If any check fails, halt and investigate before the next wave.

Each audit must verify, in this order:

1. **`systemctl --user is-active openclaw-gateway` returns `active` AND `curl localhost:18789/health` returns 200**, paired in the same iteration of a 6×10s retry loop. Decoupling the two lets a flaky watchdog cycle false-pass on "active in iter 1, healthy in iter 4."
2. **Real chat completion:** `POST /v1/chat/completions` with a ~29K-token prompt. Must complete in <30 s with a non-empty response. /health is necessary but not sufficient — the gateway can be active and /health 200 while chat aborts on every request. **This is the load-bearing check.** If the wave audit doesn't include this, the audit is theater.
3. **`openclaw --version`** matches `OPENCLAW_PINNED_VERSION`.
4. **`test -f $(npm root -g)/openclaw/dist/index.js`** — the systemd unit's actual `ExecStart` entry point. Bin symlink alone isn't enough; vm-831 had the bin symlink but missing `dist/`, gateway crash-looped with `Cannot find module`.
5. **`agents.defaults.timeoutSeconds`** actually applied (read `~/.openclaw/openclaw.json`, not just the manifest spec). OpenClaw silently rejects unknown config keys and timeout-default changes can land mid-version.
6. **Watchdog thresholds** (in `~/.openclaw/scripts/vm-watchdog.py` and related crons) match the manifest's expected values.
7. **`WORKSPACE_SOUL_MD + supplements` on disk ≤ `bootstrapMaxChars`** (currently 30,000). Anything past that is silently truncated.

If any check fails on any VM in the wave, **halt the script**. Investigate the specific VM. Only resume after the failure mode is understood AND fixed at the reconciler level — not just patched on the one VM.

### Rollback plan (must exist before rollout starts)

- **Previous `OPENCLAW_PINNED_VERSION`** documented and pinnable. For the v67 incident the rollback target was 2026.4.5.
- **Keep the previous snapshot for at least 1 week** after baking a new one (per the Snapshot Creation Process). Do not delete `private/<old>` until the new version has soaked.
- **`_rollback-fleet-to-vN.ts` script** ready, mirroring `_upgrade-fleet-to-v64.ts` but pinning the OLDER version. Dry-run tested before the rollout begins, not invented during the outage.
- **DB drift recovery:** `_db-reset-config-version-from-disk.ts` SSH-audits each VM and writes `config_version` to the actual on-disk state. This is the only way to recover when the DB starts lying about what's been deployed. Required for all 3 of the v67 incident's recovery passes.

### NEVER list

These cost real production time. None are negotiable.

- **Never bump `config_version` on a VM that hasn't been fully reconciled.** Editing SOUL.md content is not the same as reconciling Node, OpenClaw, dist/, systemd unit, watchdog, and channels. A fleet patch that touches only one of these MUST NOT touch `config_version`.
- **Never trust `/health` as proof the agent works.** /health is "HTTP server is bound." Real chat completion is the only ground truth. If you didn't just send a `/v1/chat/completions` and read the response, you don't actually know if the upgrade succeeded.
- **Never fleet-roll at `concurrency > 3`.** It will look fine on the first wave and catastrophic by the third.
- **Never bump `OPENCLAW_PINNED_VERSION` without reading the OpenClaw changelog** for that version range. Timeout defaults and config schema have changed silently between point releases.
- **Never assume "PUSH-FAILED" means the VM is broken.** The script's local-side timeout can fire before the remote install finalizes; verify on-disk state (bin symlink + package.json version + `dist/index.js`) before treating it as a real failure. Conversely, never assume "✓ success" means the VM works — only a real chat completion proves that.
- **Never skip the canary phase, even for what looks like a "small" version bump.** OpenClaw point releases have shipped breaking watchdog and timeout changes.
- **Never claim a manifest content change "will propagate via reconciler"** without verifying the reconciler actually has a step that can apply that specific change. Append-managed files cannot have rows replaced via append modes.

### The watchdog interaction (critical)

Any change to OpenClaw, watchdog scripts, gateway config, or agent context **must be tested against the actual prompt size that production agents load** — currently ~29K tokens of upfront context (SOUL.md + supplements + CAPABILITIES.md + tools + pinned references).

A change that "works" on a fresh VM with no real SOUL.md will pass /health and fail every chat completion under load. The watchdog kills the gateway when it detects the agent has been "frozen" for >3 min — a slow-but-progressing chat completion looks identical to a crashed gateway from the watchdog's perspective. The result is a kill-loop that masquerades as a healthy active service: gateway "active", /health 200, chat completions all aborting at the timeout boundary.

The only safe test is: load the actual production prompt, run a real chat completion, watch journal output for the full watchdog cycle (≥5 min, ≥3 completions). If completions finish faster than the watchdog's threshold AND the journal shows no SIGTERM/restart, the upgrade is safe. Anything else, halt.

---

## Snapshot Creation Process (COMPLETE REFERENCE)

### Prerequisites

- `LINODE_API_TOKEN` in `.env.local` (or `.env.ssh-key`)
- `SSH_PRIVATE_KEY_B64` for SSH access to the bake VM
- SSH key ID `626767` (label: `instaclaw-deploy`) in Linode profile

### Step-by-Step Checklist

**1. Provision a fresh nanode from the CURRENT snapshot:**
```
POST https://api.linode.com/v4/linode/instances
{
  "label": "snapshot-bake-v{VERSION}",
  "region": "us-east",
  "type": "g6-nanode-1",
  "image": "{CURRENT_SNAPSHOT_ID}",
  "root_pass": "{RANDOM}",
  "authorized_keys": ["{SSH_KEY}"],
  "booted": true,
  "tags": ["instaclaw", "snapshot-bake"]
}
```
Wait for status=running. Note the IP address.

**2. SSH in and upgrade OpenClaw:**
```bash
source ~/.nvm/nvm.sh
npm install -g openclaw@latest
openclaw --version  # Verify latest
```

**3. Install/update system and Python packages:**
```bash
# pip may not be installed on base image
curl -sS https://bootstrap.pypa.io/get-pip.py | sudo python3 - --break-system-packages
python3 -m pip install --break-system-packages openai
```

**4. Extract and deploy manifest files from the codebase:**

The scripts, workspace files, and SOUL.md sections are embedded as template string constants in `lib/ssh.ts`, `lib/agent-intelligence.ts`, `lib/vm-manifest.ts`, and `lib/earn-md-template.ts`.

To extract them, run the extraction script from the project root:
```bash
node /tmp/extract-manifest-files.mjs .
```
This writes all files to `/tmp/snapshot-files/`. For `strip-thinking.py`, use Node.js `eval` to process `${...}` template expressions:
```javascript
// The regex extraction doesn't evaluate ${200 * 1024} expressions
// Use: eval('`' + templateBody + '`') to get the actual Python script
```

Then SCP the files to the bake VM and deploy:
- `~/.openclaw/scripts/` — strip-thinking.py, auto-approve-pairing.py, vm-watchdog.py, silence-watchdog.py, push-heartbeat.sh, generate_workspace_index.sh
- `~/scripts/` — deliver_file.sh, notify_user.sh
- `~/.openclaw/workspace/` — SOUL.md (built from components: base + intelligence supplement + learned preferences + memory filing system), MEMORY.md, CAPABILITIES.md, QUICK-REFERENCE.md, TOOLS.md, EARN.md
- `~/.openclaw/workspace/memory/` — session-log.md, active-tasks.md
- All scripts `chmod +x`

**5. Install cron jobs (7 total):**

| Schedule | Command | Marker |
|----------|---------|--------|
| `0 * * * *` | `ipcs -m ... SHM_CLEANUP` | SHM_CLEANUP (already in snapshot) |
| `* * * * *` | `python3 ~/.openclaw/scripts/strip-thinking.py` | strip-thinking.py |
| `* * * * *` | `python3 ~/.openclaw/scripts/auto-approve-pairing.py` | auto-approve-pairing.py |
| `* * * * *` | `python3 ~/.openclaw/scripts/vm-watchdog.py` | vm-watchdog.py |
| `0 * * * *` | `bash ~/.openclaw/scripts/push-heartbeat.sh` | push-heartbeat.sh |
| `* * * * *` | `python3 ~/.openclaw/scripts/silence-watchdog.py ...; sleep 30 && ...` | silence-watchdog.py |
| `0 4 * * *` | `/home/openclaw/.nvm/.../openclaw memory index` | openclaw memory index |

Use marker-based idempotent install: check `crontab -l | grep -q "MARKER"` before adding.

**6. Clean caches aggressively:**
```bash
source ~/.nvm/nvm.sh && npm cache clean --force
sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/*
python3 -m pip cache purge; sudo rm -rf /root/.cache/pip ~/.cache/pip
rm -rf /tmp/* ~/.nvm/.cache
sudo journalctl --vacuum-time=1d
sudo rm -rf /var/log/*.gz /var/log/*.1 /var/log/*.old
```

**7. Run 15-point verification (ALL must pass):**

| # | Check | Command |
|---|-------|---------|
| 1 | OpenClaw installed | `openclaw --version` |
| 2 | Node.js v22 | `node --version \| grep v22` |
| 3 | Chromium | `test -x /usr/local/bin/chromium-browser` |
| 4 | ffmpeg | `which ffmpeg` |
| 5 | jq | `which jq` |
| 6 | node_exporter | `which node_exporter` |
| 7 | Xvfb + x11vnc + websockify | `which Xvfb && which x11vnc && which websockify` |
| 8 | exec-approvals.json (security=full) | `cat ~/.openclaw/exec-approvals.json \| python3 -c "..."` |
| 9 | SSH deploy keys (≥2) | `wc -l < ~/.ssh/authorized_keys` |
| 10 | loginctl linger enabled | `loginctl show-user openclaw \| grep Linger=yes` |
| 11 | strip-thinking.py has session-end hook | `grep -q run_session_end_hook ~/.openclaw/scripts/strip-thinking.py` |
| 12 | SOUL.md has memory filing system | `grep -q MEMORY_FILING_SYSTEM ~/.openclaw/workspace/SOUL.md` |
| 13 | memory/session-log.md exists | `test -f ~/.openclaw/workspace/memory/session-log.md` |
| 14 | memory/active-tasks.md exists | `test -f ~/.openclaw/workspace/memory/active-tasks.md` |
| 15a | Cron: strip-thinking.py | `crontab -l \| grep -q "strip-thinking.py"` |
| 15b | Cron: auto-approve-pairing.py | `crontab -l \| grep -q "auto-approve-pairing.py"` |
| 15c | Cron: vm-watchdog.py | `crontab -l \| grep -q "vm-watchdog.py"` |
| 15d | Cron: push-heartbeat.sh | `crontab -l \| grep -q "push-heartbeat.sh"` |
| 15e | Cron: silence-watchdog.py | `crontab -l \| grep -q "silence-watchdog.py"` |
| 15f | Cron: openclaw memory index | `crontab -l \| grep -q "openclaw memory index"` |
| 15g | Cron: SHM cleanup | `crontab -l \| grep -q "SHM_CLEANUP"` |

**CRITICAL: ALL 7 crons (15a-15g) must be present.** Missing crons caused a P0 incident on 2026-04-08 where sessions grew to 4MB+ and burned credits 20x faster (see commit 68e9e4c). The reconciler does NOT catch missing crons on freshly configured VMs — configureOpenClaw() now installs them, but they must also be in the snapshot as defense-in-depth.

**8. Check disk usage — MUST be under 5.9GB:**
```bash
df -h / | tail -1
# Used must be < 5.9GB. Image limit is 6144MB.
# If over, clean more aggressively: rm -rf ~/.cache, check /usr/local for bloat
```

**9. Power off VM cleanly:**
```
POST /v4/linode/instances/{ID}/shutdown
```
Poll until status=offline. **DO NOT delete SSH host keys or machine-id** — cloud-init regenerates them on first boot.

**10. Create image:**
```
# Get disk ID (ext4 disk, not swap)
GET /v4/linode/instances/{ID}/disks

# Create image
POST /v4/images
{
  "disk_id": {DISK_ID},
  "label": "instaclaw-base-v{VERSION}-{description}",
  "description": "OpenClaw {version} + {changes}. 15/15 verified."
}
```
Poll `GET /v4/images/{IMAGE_ID}` until status=available. Verify size < 6144MB.

**11. Update all references:**
- `CLAUDE.md` — snapshot ID and description in "VM Provisioning Standard"
- `.env.local` — `LINODE_SNAPSHOT_ID="private/{NEW_ID}"`
- `reference_vm_provisioning.md` (project memory) — snapshot ID + contents list
- `MEMORY.md` (project memory) — snapshot ID
- **Vercel environment variables** — Cooper must update `LINODE_SNAPSHOT_ID` in Vercel dashboard

**12. Clean up:**
- Delete the temp nanode: `DELETE /v4/linode/instances/{ID}`
- Keep the OLD snapshot for 1 week as rollback
- After 1 week with no issues, delete the old snapshot

### Snapshot Gotchas (Lessons Learned)

- **6144MB hard limit** — Linode images over this silently fail. Current images are ~5.8GB. Always check `df -h` before imaging.
- **DO NOT delete SSH host keys or machine-id** — cloud-init regenerates these on first boot from snapshot. Deleting them before imaging breaks SSH access on deployed VMs.
- **DO NOT use ready-pool VMs as the base** — they were provisioned from the OLD snapshot and may have inconsistent state from partial reconciler runs, failed health checks, or stale cron output. Always provision a FRESH nanode from the current snapshot.
- **Always use a nanode (g6-nanode-1)** for baking — 25GB disk keeps the image small. Dedicated-2 VMs have 80GB disks which produce larger images that may exceed the 6144MB limit.
- **Template string extraction needs eval** — scripts like strip-thinking.py use JavaScript template expressions (`${200 * 1024}`) that must be evaluated by Node.js, not extracted as raw text.
- **strip-thinking.py modifies all session files** — it touches every .jsonl file on every run (strips thinking blocks), which equalizes their mtimes. The session-end hook uses sessions.json session IDs for transition detection, NOT file modification times.
- **OpenClaw caches MEMORY.md at session creation** — changes to MEMORY.md during an active session are NOT visible until the next session starts. This is by design for cross-session memory.
- **Image creation takes ~5 minutes** — poll status every 20 seconds. Size field shows disk size (25088MB) during creation, then actual image size after completion.
- **Old images can pile up** — Linode had 196 orphaned images (2TB) from deleted VMs. Periodically audit with `GET /v4/images` and delete unused ones.
