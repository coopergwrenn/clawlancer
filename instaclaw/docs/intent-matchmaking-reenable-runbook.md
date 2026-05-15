# Intent-Matchmaking Re-Enable Runbook

**Status as of 2026-05-15:** the consensus matchmaking pipeline + cross-agent intro flow are **DISABLED**. This document is the *only* approved path to bring them back. Follow it from top to bottom. Don't shortcut.

This is the playbook for when matchmaking ships again. Read it end-to-end **before** you touch anything. If you find a step that doesn't make sense, the answer is to fix the doc first, not improvise.

---

## Why this is currently off (and what hit Timour)

On **2026-05-15**, Timour Kosters reported "5 connection requests in the past 4 hours" via Telegram. Cooper flipped the global kill switch in Vercel (`CONSENSUS_INTRO_FLOW_ENABLED=false`); Timour was *still* getting hit. Investigation showed:

**There are THREE outbound paths from a VM, only TWO of which were gated by the kill switch:**

| Path | Originates | Gated by `CONSENSUS_INTRO_FLOW_ENABLED`? | Status before fix |
|---|---|---|---|
| **A. Reserve → XMTP** (`consensus_agent_outreach.py`) | VM cron, via pipeline | ✅ Yes — reserve route refuses → script bails before XMTP send | Working (kill flowed through correctly) |
| **B. Retry → XMTP** (`retry_unacked_outreach` in `consensus_match_pipeline.py:702`) | VM cron, via pipeline | ❌ **No** — script sends XMTP via the local listener FIRST, then POSTs `phase=retry` to the API. The API gate fires AFTER the send. | Latent bug. Not the immediate spam source but actively dangerous. |
| **C. Owner Telegram notification** (`maybe_send_match_notification` → `notify_user.sh`) | VM cron, via pipeline | ❌ **No** — fires from the local script every cycle a new top-1 match is found, regardless of whether outreach was sent. Writes Telegram via the VM's own bot. | **This was the actual Timour spam source.** Each pipeline cycle (every 30 min) on Timour's vm-354 found a new top-1, his bot DM'd him "Found a match — Cooper Wrenn" 5 times in 4 hours. Same on every other user's VM. |

**The mental model fix:** the Vercel kill switch is *only* the API gate. The VM cron is *also* a gate — for paths B and C, the only effective off-switch. **You need both.**

What Cooper did to fully stop the spam:
1. `CONSENSUS_INTRO_FLOW_ENABLED=false` in Vercel (kills path A reliably)
2. Fleet script removed the cron from every VM (kills paths B + C entirely)
3. `vm-manifest.ts` consensus_match_pipeline entry commented out (prevents reconciler / new-VM-provision re-install)

All three layers stayed in place. **All three must be reversed, in order, to re-enable.**

---

## Pre-flight: fix the retry-path bug FIRST

**Do not skip this.** Without it, the API kill switch is leaky — if you ever flip it back on later in an incident, the retry path will bypass it.

### The bug

`scripts/consensus_match_pipeline.py`, function `retry_unacked_outreach()` (around line 655–722 as of 2026-05-15).

The current flow:
```
1. GET /api/match/v1/my-pending-retries  (pull pending unacked rows)
2. For each row:
   a. Send XMTP via http://127.0.0.1:18790/send-intro    ← happens NOW
   b. POST /api/match/v1/outreach with phase=retry       ← API gate checked HERE
```

The API gate at step 2b *is* enforcing `CONSENSUS_INTRO_FLOW_ENABLED=false`, but it's too late — the XMTP already went out at 2a.

### The fix

Reorder so the API call is the gate, not the bookkeeping. Mirror the reserve path (`consensus_agent_outreach.py:269–298`) which does:

```
1. POST /api/match/v1/outreach reserve
2. If response.allowed == false → bail
3. Else → build envelope, send XMTP
4. POST /api/match/v1/outreach finalize
```

For retry, the equivalent shape is:

```
1. POST /api/match/v1/outreach with phase=retry-check  ← NEW, returns allowed: bool
2. If response.allowed == false → bail
3. Else → send XMTP via local listener
4. POST /api/match/v1/outreach with phase=retry to bump retry_count
```

OR, simpler if you don't want to add a `retry-check` phase: just call the existing `isOutreachEnabled()` check at the top of `retry_unacked_outreach`:

```python
# Cheap path: a single API ping at the top of the function before
# iterating pending rows. One round-trip per cycle, not per row.
status, resp = post_json(OUTREACH_URL, {"phase": "kill-switch-probe"}, token)
if status != 200 or not resp or resp.get("disabled"):
    log("retry_skipped kill_switch_active")
    return summary
```

(The probe phase needs a server-side handler that returns `{disabled: !isOutreachEnabled()}` and nothing else. Trivial addition to `app/api/match/v1/outreach/route.ts`.)

**Choose one approach.** Either ships before re-enable. The first is more correct (gates per-row, so a kill flipped mid-cycle takes effect immediately); the second is simpler and fine because the kill switch is rarely flipped mid-cycle.

### Verify the fix

Before merging the PR that fixes this:

1. Run the script on a test VM with `CONSENSUS_INTRO_FLOW_ENABLED=false` set locally.
2. Confirm zero XMTP sends in the local `xmtp-agent.mjs` log.
3. Confirm the API received zero `phase=retry` requests.

---

## Re-enable checklist (in this order)

### Step 1. Land the retry-path fix on main

PR title: `fix(consensus-pipeline): gate retry_unacked_outreach on kill switch`. Single-file change in `scripts/consensus_match_pipeline.py`. Once merged, the manifest version bumps and the reconciler propagates the corrected script to every VM.

**Wait for the manifest version to bump and the reconciler to walk the fleet** before proceeding. Check via:

```bash
SB_URL=$(awk -F= '/^NEXT_PUBLIC_SUPABASE_URL=/{gsub(/^"|"$/,"",$2); print $2}' .env.local)
SB_KEY=$(awk -F= '/^SUPABASE_SERVICE_ROLE_KEY=/{gsub(/^"|"$/,"",$2); print $2}' .env.local)
curl -s -G "$SB_URL/rest/v1/instaclaw_vms" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  --data-urlencode "health_status=eq.healthy" \
  --data-urlencode "assigned_to=not.is.null" \
  --data-urlencode "config_version=lt.$NEW_MANIFEST_VERSION" \
  --data-urlencode "select=name,config_version" | head
```

Empty result = fleet caught up. **Don't proceed if there are stale VMs** — they'd run the unfixed retry path.

### Step 2. Un-comment the manifest entry

In `lib/vm-manifest.ts` (around line 2107), restore the consensus matching pipeline cron entry. The disabled block left the exact content as inline comments — un-comment those three lines:

```ts
{
  schedule: "*/30 * * * *",
  command: "python3 ~/.openclaw/scripts/consensus_match_pipeline.py >> /tmp/consensus_match.log 2>&1",
  marker: "consensus_match_pipeline.py",
},
```

Same PR as Step 1, or a separate PR — your call. Important: **before pushing, bump the manifest `version` field** so the reconciler picks up the change and walks the fleet to install the cron. The reconciler does not re-process VMs at the current version, so a no-bump merge means new VMs get the cron via `configureOpenClaw` but existing VMs don't get it until the reconciler has a reason to touch them.

### Step 3. Verify the deployment

After merging, Vercel auto-deploys. Wait for the new deployment to go live (~2 min). Verify:

```bash
# Hit the gate route — should return a "ready" signal, not "disabled"
curl -s -X POST https://instaclaw.io/api/match/v1/outreach \
  -H "Content-Type: application/json" \
  -d '{"phase":"kill-switch-probe"}' | head
```

If you get `{disabled: true}` here, the env var is still on (proceed to step 4). If you get any 5xx, the deploy is broken — debug before continuing.

### Step 4. Re-install the cron across the fleet

Two paths:

**Path A (fast — recommended for re-enable day):** run the re-enable script. Touches all healthy assigned VMs in ~3 minutes. Idempotent — VMs that already have the cron via the manifest bump will report `ALREADY_ENABLED`.

```bash
# Dry-run first — sanity-check the candidate list
npx tsx scripts/_reenable-consensus-pipeline-cron.ts --dry-run

# Test on Cooper's vm-050 — print before+after crontab for visual confirm
npx tsx scripts/_reenable-consensus-pipeline-cron.ts --test-vm instaclaw-vm-050

# Fleet rollout
npx tsx scripts/_reenable-consensus-pipeline-cron.ts
```

Expect ~140 VMs reported, mix of `OK` and `ALREADY_ENABLED`. Anything else (especially `VERIFY_FAILED` or `SSH_ERROR`) requires per-VM follow-up.

**Path B (slow — natural propagation):** wait for the reconciler to walk every cv-stale VM. With ~140 VMs and the current `CONFIG_AUDIT_BATCH_SIZE=3` cron config, this takes ~24h. Acceptable if you're not in a hurry, but Path A is dramatically faster.

### Step 5. Remove the Vercel kill switch

**Only after the cron is back on every VM.** If you remove the env var first, the cron is still off so it's no-op — but it leaves you in a confusing "API is on, no VMs are sending" state.

```bash
cd instaclaw
npx vercel env rm CONSENSUS_INTRO_FLOW_ENABLED production
# Confirm "yes" when prompted
```

### Step 6. Redeploy to pick up the env change

Vercel env-var removals don't take effect until the next deploy.

```bash
# Find the latest production deployment URL
npx vercel ls --prod | head -3

# Redeploy it (no rebuild — uses the existing build with the new env)
npx vercel redeploy https://instaclaw-<latest>-cooper-wrenns-projects.vercel.app
```

Wait for `Aliased: https://instaclaw.io` in the output.

### Step 7. Verify end-to-end on one VM

Pick a single healthy test VM (Cooper's vm-050 is the standard). Confirm:

```bash
# SSH the VM
ssh -i ~/your_deploy_key openclaw@<vm-050-ip>

# Cron line is present
crontab -l | grep consensus_match_pipeline

# The next pipeline cycle should run (it runs every 30 min — be patient or
# trigger manually). Watch the log:
tail -f /tmp/consensus_match.log

# When you see a cycle complete, check that:
# 1. The reserve API didn't refuse (no "disabled" reason in stderr)
# 2. A real outreach completed end-to-end (look for "sent log_id=..." line)

# Confirm the Telegram-notify path works as intended (test on a VM whose
# owner can verify): the top-1 match Telegram message arrives correctly.
```

If step 7 succeeds: **intent matchmaking is fully re-enabled.** Update this doc's status header.

---

## Rollback (if intros go wrong again)

If at any time after re-enable something looks off — owner complaints, unexpected XMTP volume, etc. — you have two graduated kills:

### Soft kill (instant — API only, takes effect on next request)

```bash
printf 'false' | npx vercel env add CONSENSUS_INTRO_FLOW_ENABLED production
npx vercel redeploy https://instaclaw.io  # use latest from `vercel ls --prod`
```

This stops new outreach via the API. Pipeline cron keeps running on every VM, owner notifications keep firing. **This was the partial-fix that didn't help Timour.** Use it only as a holding action while you go to the hard kill.

### Hard kill (instant — cron off everywhere)

```bash
npx tsx scripts/_disable-consensus-pipeline-cron.ts
```

This kills paths A, B, AND C across the fleet in ~3 minutes. Pipeline stops running, no notifications, no retries. **This is the kill that actually stopped Timour's spam.**

If you also want to prevent the reconciler from re-installing the cron, immediately follow the hard kill with:
1. Comment out the consensus matching pipeline entry in `lib/vm-manifest.ts` (as it was on 2026-05-15)
2. Push to main, wait for Vercel auto-deploy

The pre-commit hook auto-touches the reconcile-fleet route's nft cache-bust comment so the new manifest actually loads on the live cron (per CLAUDE.md P1-4).

---

## Future hardening (not blocking re-enable, but track)

These are real follow-ups, not just nice-to-haves. They came out of the 2026-05-15 incident.

### A separate kill switch for the owner-notification path

`CONSENSUS_INTRO_FLOW_ENABLED` gates the cross-agent intro send. There's no equivalent for the per-VM Telegram-notify path. Add `CONSENSUS_NOTIFY_OWNER_ENABLED` (default `true`) read by `send_telegram_notification` in `consensus_match_pipeline.py`. Lets you turn off the owner spam without killing the underlying matching — useful if a specific user wants quiet without us disabling matching globally.

### Per-user opt-out for owner notifications

The pipeline's "pause intros" / "N/day" knob is currently surfaced only via the agent's free-text chat (the user tells their bot "pause intros" and the agent calls the cap-update endpoint). Promote this to a first-class CLI/UI affordance — under `/account` settings — so users can self-serve without needing a conversation with their bot.

### A daily fleet probe

Add a Vercel cron that runs `_disable-consensus-pipeline-cron.ts --dry-run` once a day and asserts the cron is present on every healthy assigned VM IF matchmaking is meant to be on (manifest entry un-commented), AND absent IF off (manifest entry commented). Wrong direction → admin email. Catches drift between "what the manifest says should be running" and "what's actually on disk."

### Owner-notification cadence cap

The current "top-1 changed" gate fires every cycle the top changes. With matchmaking running every 30 min, a fluctuating top-1 produces a notification every 30 min indefinitely. Add a per-user cap (e.g., max 3 owner-notifications per day) inside `maybe_send_match_notification` so a busy match-pool day doesn't drown the owner.

---

## Files referenced

- `scripts/consensus_match_pipeline.py` — the per-VM pipeline orchestrator. Retry-path bug at `retry_unacked_outreach`.
- `scripts/consensus_agent_outreach.py` — outreach reserve → XMTP send → finalize.
- `lib/outreach-feature-flag.ts` — `isOutreachEnabled()` / `flagName()` exports.
- `lib/vm-manifest.ts` — manifest entry for the consensus pipeline cron (commented out 2026-05-15).
- `app/api/match/v1/outreach/route.ts` — server-side reserve + finalize + retry handler. Checks `isOutreachEnabled()` on lines 199 and 308.
- `scripts/_disable-consensus-pipeline-cron.ts` — fleet kill of the cron.
- `scripts/_reenable-consensus-pipeline-cron.ts` — fleet re-install of the cron.
- `scripts/_block-reconciler-2h.ts` — emergency reconciler lock-hold if the deploy lags.

---

## Update log

- **2026-05-15** Cooper Wrenn / Claude — initial writeup; disabled state established.
