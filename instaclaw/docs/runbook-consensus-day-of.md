# Consensus 2026 Day-of Runbook

**Purpose:** specific commands for keeping the matching engine + agent-to-agent intro flow alive at Consensus 2026, May 5-7 Miami.
**Author:** Cooper + Claude
**Last updated:** 2026-05-05 23:55 ET (eve of Day 1)
**Audience:** whoever is on call. Assume 3am. Assume something is wrong. Assume you're tired.

---

## 0. Quick reference card — copy-paste at 3am

### Kill the entire intro flow in 30 seconds
1. Vercel dashboard → instaclaw project → Settings → Environment Variables.
2. Add or set: `CONSENSUS_INTRO_FLOW_ENABLED=false`.
3. Save. Takes effect on the next request to `/api/match/v1/outreach`. No redeploy needed.
4. Existing pending state drains via the receiver path (acks still work, my-intros still works).

### Tighten the per-receiver cap mid-conference
- `CONSENSUS_INTRO_PER_RECEIVER_CAP_24H=2` (or `1`, or `0` for total inbound block) in Vercel env.
- Same path as above, no redeploy.
- `0` = refuse ALL inbound for ALL users. A softer kill-switch.

### Manually clear stuck unacked rows for a specific user
```sql
UPDATE agent_outreach_log
SET status = 'duplicate', ack_received_at = NOW(), ack_channel = 'pending'
WHERE target_user_id = '<user_uuid>'
  AND status IN ('pending', 'sent')
  AND ack_received_at IS NULL;
```
Use when a user reports being spammed AND the per-receiver cap is somehow not catching them. Rare.

### Force a fresh intro on demand
```bash
cd instaclaw && npx tsx scripts/_force-real-production-intro.ts
```
Sends one production-shape intro from vm-780 to vm-354. Used for demos or post-fix verification.

### Wake a hibernating partner VM
```bash
# SSH to admin host and run:
curl -X POST https://instaclaw.io/api/admin/wake-vm \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"vm_id":"<uuid>"}'
```

### Pre-flight a single VM
```bash
cd instaclaw && npx tsx scripts/_check-vm780-launch-readiness.ts
# Edit the script for other VMs by changing the .eq("name", ...) lookup
```

### Get a fleet snapshot
```bash
cd instaclaw && npx tsx scripts/_pre-conference-snapshot.ts
```

### Escalation
- **Code/infra:** Cooper (primary)
- **Billing (1008 errors):** gbrain
- **XMTP protocol issues:** XMTP team Slack/Telegram
- **Public outage > 5 min:** post status update on @instaclaws

---

## 1. Pre-conference baseline (snapshot @ 2026-05-05 23:55 ET)

Use these values to spot drift during the conference.

| Metric | Baseline value | Where to check |
|---|---|---|
| Ready pool | 15 unassigned, 0 provisioning | snapshot script |
| Assigned healthy VMs | 156 | snapshot script |
| Fleet max config_version | 88 | snapshot script |
| Partner VMs cv drift | 4 of 5 at cv=84 (drift=4); vm-780 at cv=87 (drift=1) | partner probe |
| agent_outreach_log total | 1 row (the test intro), 100% ack rate | snapshot script |
| Matchpool profiles | 13 (incl. ghosts), 13 opted-in | snapshot script |
| Pipeline activity (1h) | 32 deliberations, 3 cached_top3 | snapshot script |
| Per-receiver count (all 5 partners) | 0 or 1 | partner probe (well under cap=3) |
| consensus-intro-health endpoint | 200, `feature_enabled: true`, alerts: [] | curl with CRON_SECRET |
| vm-780 1008 errors (2h) | 22 (down from 105 earlier; gbrain fix partial) | journalctl on vm-780 |

If any of these drift significantly, see section 2 (hourly checks) and section 3 (failure scenarios).

---

## 2. Hourly health checks during the conference

Run these every hour. Each takes < 60 seconds. Stop at the first red.

### 2.1 Snapshot diff
```bash
cd instaclaw && npx tsx scripts/_pre-conference-snapshot.ts
```
Compare against the table in section 1. Specifically watch:
- Ready pool: should stay 10-20. Below 10 → see 3.7 (pool depletion).
- Assigned healthy: monotonic up if signups are happening. A sudden DROP > 5 → see 3.6 (mass VM unhealth).
- Pipeline deliberations (1h): should grow as activity grows. Zero growth across 2 hours of expected activity → see 3.4 (pipeline silent).

### 2.2 Outreach health
```bash
SECRET=$(grep "^CRON_SECRET=" .env.local | cut -d= -f2- | tr -d "\"'")
curl -s -X GET "https://instaclaw.io/api/cron/consensus-intro-health" \
  -H "Authorization: Bearer $SECRET" | python3 -m json.tool
```
Watch:
- `total` should grow as users opt in.
- `failure_rate` < 0.30 (alert threshold).
- `oldest_unacked_hours` < 2.0 (alert threshold).
- `by_ack_channel.polled` should be a small fraction (large fraction = XMTP→ack chain is broken; see 3.2).
- `feature_enabled: true` (if false, kill-switch is on).

### 2.3 Per-receiver cap state
```bash
cd instaclaw && npx tsx scripts/_probe-cap-and-partners.ts
```
Watch the "Per-receiver cap" section. Anyone at "🛑 AT CAP" stays at 3 for 24h — that's by design but worth knowing. "⚠ near cap" (count=2) is where to watch for complaints.

### 2.4 Vercel function errors (web UI)
- Vercel dashboard → instaclaw → Logs → filter for "ERROR".
- Specifically grep for:
  - `consensus-intro-health ALERT:` (threshold breach)
  - `5xx` on any `/api/match/v1/*` route
  - `db_query_failed` (Supabase distress)

### 2.5 Vercel cron staleness
```bash
npx vercel ls 2>&1 | head -10
```
- Latest production deployment should be Ready. If Error, see 3.8 (deploy failure).
- Cron functions surface here as separate invocations; missed-tick patterns visible.

### 2.6 vm-780 specifically (Cooper's bot)
```bash
cd instaclaw && npx tsx scripts/_check-vm780-launch-readiness.ts
```
Watch:
- 1008 error count (last 2h). Was 22 at baseline. If climbing > 50/hr — gbrain's fix regressed; see 3.3.
- Pipeline deliberations should be > 30/24h. If zero across 2 hours — pipeline died on this VM.

---

## 3. Failure scenarios

For each: **Symptoms → Detect → Threshold → Recover.**

### 3.1 Supabase load spike

**Symptoms:** "exhausting multiple resources" warning in Supabase dashboard. API calls slow (> 500ms p99). Cron locks held > 5 min.

**Detect:**
- Supabase project dashboard → CPU/IOPS chart.
- `npx tsx scripts/_diagnose-supabase-load.ts` (existing diagnostic).
- COUNT queries on small tables (instaclaw_vms, agent_outreach_log) taking > 200ms = CPU pressure.

**Threshold:** sustained > 70% CPU on Postgres; OR query latency p99 > 500ms for > 10 min.

**Recover (in priority order):**
1. **Tighten cron cadence further.** `vercel.json` health-check 2m → 5m, reconcile-fleet 3m → 10m. Push, redeploy. Halves the dominant query rate.
2. **Tighten per-receiver cap to 1.** `CONSENSUS_INTRO_PER_RECEIVER_CAP_24H=1`. Cuts new outreach volume.
3. **If still distressed, kill the intro flow temporarily.** `CONSENSUS_INTRO_FLOW_ENABLED=false`. Drains existing, blocks new.
4. **Last resort:** Supabase tier upgrade in the dashboard. ~5-10 min provisioning, no downtime.

### 3.2 XMTP delivery failures

**Symptoms:** intros showing up in `pending-intros.jsonl` with channel=`polled` instead of `telegram` or `xmtp_user`. "Polled" means XMTP didn't deliver and the server-poll fallback caught it.

**Detect:**
- consensus-intro-health: `by_ack_channel.polled` > 50% of total.
- ALERT: "high poll-fallback rate" auto-fires.
- Forensic: `select id, ack_channel from agent_outreach_log where sent_at > now() - interval '1 hour' order by sent_at desc;`

**Threshold:** > 50% polled on > 5 intros in any hour window.

**Recover:**
1. **Verify XMTP network status.** Check XMTP team Slack or status page. If they're degraded, our application-layer guarantees still deliver via poll within 30 min.
2. **No code action needed in most cases.** The 3-layer at-least-once architecture handles this; users still get their intros.
3. **If XMTP is fully down for > 4 hours**, post a status update at @instaclaws: "XMTP layer is degraded; our agents are still surfacing matches via the matches page (https://instaclaw.io/consensus/my-matches). New intros may take up to 30 min to appear."
4. **If receiver xmtp-agent service died** on a specific VM, restart it: SSH to VM, `systemctl --user restart instaclaw-xmtp`.

### 3.3 MiniMax credits depleted (1008 errors return)

**Symptoms:** vm-780 (and possibly other VMs) returning "insufficient balance (1008)". Users say "my agent isn't responding."

**Detect:**
- vm-780 readiness check: `1008 / insufficient balance` line count in last 2h.
- Baseline: 22. > 100 in any 1h window → fix regressed.
- User report: "my agent stopped working."

**Threshold:** > 100 1008 errors per hour across any partner VM.

**Recover:**
1. **Top up MiniMax credits.** This is gbrain's domain. Ping gbrain immediately.
2. **No code change needed** — once credits are added, the gateway proxy starts succeeding again.
3. **Verify recovery:** wait 5 min, re-run vm-780 readiness check, count should drop.

### 3.4 Matching pipeline silent on a VM

**Symptoms:** vm-XXX hasn't produced new deliberations in > 2 hours. Users on that VM report "I don't see any matches."

**Detect:**
```sql
SELECT name, last_health_check FROM instaclaw_vms WHERE name = 'instaclaw-vm-XXX';
SELECT COUNT(*) FROM matchpool_deliberations
  WHERE user_id = (SELECT assigned_to FROM instaclaw_vms WHERE name = 'instaclaw-vm-XXX')
  AND deliberated_at > NOW() - INTERVAL '2 hours';
```
If health is healthy but deliberations = 0, pipeline is silent on that VM.

**Threshold:** > 2 hours of zero deliberations on an opted-in user's VM.

**Recover:**
1. **SSH to the VM.** Check `journalctl --user -u openclaw-gateway --since='1 hour ago' | tail -30`.
2. **Common causes:**
   - Cron not firing: `crontab -l | grep consensus_match_pipeline.py`. If missing, reinstall via reconciler.
   - Lock file stuck: `rm -f ~/.openclaw/.consensus_match.lock` (lock is fcntl-based; stale only if process killed).
   - Skill disabled: `python3 ~/.openclaw/scripts/consensus_match_consent.py` — should return `skill_enabled=true`.
3. **Nuclear option:** `python3 ~/.openclaw/scripts/consensus_match_pipeline.py --force --no-jitter` to manually fire one cycle. Logs go to journalctl.

### 3.5 Popular user gets flooded despite the cap

**Symptoms:** user reports "I'm getting too many intros" but per-receiver cap is set to 3.

**Detect:**
```sql
SELECT count(*), date_trunc('hour', sent_at) AS hr
FROM agent_outreach_log
WHERE target_user_id = '<user_uuid>'
GROUP BY hr ORDER BY hr DESC LIMIT 24;
```
If counts > 3 per rolling-24h window, the cap is being bypassed somehow.

**Threshold:** > 3 successful intros in any 24h window for a single target.

**Recover:**
1. **Tighten cap globally:** `CONSENSUS_INTRO_PER_RECEIVER_CAP_24H=2` or lower. Affects all users.
2. **Per-user pause:** manually clear unacked rows AND mark target as opted-out in agent_outreach_log via:
   ```sql
   UPDATE agent_outreach_log
   SET status = 'duplicate', ack_received_at = NOW(), ack_channel = 'pending'
   WHERE target_user_id = '<user_uuid>'
     AND status IN ('pending', 'sent')
     AND ack_received_at IS NULL;
   ```
3. **Investigate root cause.** The cap is enforced server-side at reserve time. A bypass means either:
   - The query in `outreach/route.ts` reserve phase has a bug (SELECT count off, race condition).
   - Cap was set higher and we forgot.
   - User ID is being recycled across multiple instaclaw_users rows (dual account from CLAUDE.md Rule 9).

Apologize to the user via DM from Cooper personally.

### 3.6 Mass VM unhealth (5+ flip to unhealthy in < 30 min)

**Symptoms:** assigned_healthy count drops by 5+ in a single cron cycle. Multiple users report "my agent went silent."

**Detect:**
- Snapshot diff: `assigned_healthy` count drops sharply.
- `instaclaw_vms.health_status='unhealthy'` rows query — sudden cluster.

**Threshold:** ≥ 5 VMs flipping to unhealthy in any 30-min cycle.

**Recover:**
1. **Identify the common factor.** Are they all on the same Linode region? All on same OpenClaw version? All hit by a specific SSH or HTTP error?
   ```sql
   SELECT name, ip_address, config_version, health_status, last_health_check
   FROM instaclaw_vms WHERE health_status = 'unhealthy' AND assigned_to IS NOT NULL
   ORDER BY last_health_check DESC LIMIT 20;
   ```
2. **If region-wide (Linode network issue):** wait. Watchdog v2 will recover when the network heals.
3. **If config-version-correlated:** the latest manifest bump may have broken something. Roll back via `LINODE_SNAPSHOT_ID` env (in Vercel) to the previous stable.
4. **Per-VM recovery:** SSH and `systemctl --user restart openclaw-gateway`.

### 3.7 Pool depletion under viral surge

**Symptoms:** instaclaw.io/signup or /consensus signups stuck. New users see "provisioning..." for > 5 min.

**Detect:**
- Snapshot: `ready_unassigned: 0`, `provisioning > 0` for more than 1 cycle.
- Vercel cron logs: `replenish-pool` last successful provision > 30 min ago.

**Threshold:** ready_unassigned = 0 AND no provisioning attempt in last 5 min.

**Recover:**
1. **Verify Linode quota.** `/var/log/replenish-pool` (or Vercel logs). If "quota_exceeded" — Linode account has hit its instance cap. File ticket with Linode immediately.
2. **Manual provision (per CLAUDE.md Rule 8 — only if cron is broken):**
   - Pause the cron in Vercel.
   - Take the cron lock via `tryAcquireCronLock("replenish-pool", 600, "manual-emergency")`.
   - Provision N VMs via direct Linode API call.
   - Release lock, unpause cron.
3. **Communicate:** post a "high demand" message on @instaclaws with ETA (typically 5-10 min for Linode provisioning).

### 3.8 Vercel deploy failure

**Symptoms:** push to main, build red. Endpoints serve stale code.

**Detect:**
- `npx vercel ls 2>&1 | head -3` — latest deployment status.
- Vercel email/Slack notification.

**Threshold:** any production deploy in Error state.

**Recover:**
1. **Read the build log:** `npx vercel inspect --logs <deploy-url> | tail -30`. Common: `verify-migrations` blocked on PostgREST schema cache lag (5-min wait + nudge file re-trigger).
2. **For schema-cache lag:**
   ```bash
   printf "\n-- nudge\n" >> instaclaw/supabase/migrations/<latest>.sql
   git add instaclaw/supabase/migrations/<latest>.sql
   git commit -m "chore: nudge build re-trigger"
   git push origin main
   ```
3. **For genuine compile error:** revert the offending commit (`git revert HEAD && git push`). Last-known-good deploy stays live; no user impact.

### 3.9 Anthropic API rate limit hit

**Symptoms:** matching pipelines fail at Layer 2 (rerank) or Layer 3 (deliberate) with 429. Vercel logs: "anthropic rate limit exceeded."

**Detect:**
- Pipeline log lines: `layer2_failed status=429` or `layer3_failed status=429`.
- Anthropic console: usage / rate-limit dashboard.

**Threshold:** > 10% of pipeline cycles failing with 429 across any 1h window.

**Recover:**
1. **Verify our tier.** Anthropic console → Billing → API tier. If we're on Tier 1 (80K TPM), we'll hit limits at 50+ active users. Upgrade to Tier 4 takes 5 min.
2. **In the interim:** widen pipeline jitter (currently MAX_JITTER_SECONDS = 240). Bump to 600 to spread load over 10 min instead of 4.
3. **Worst case:** disable matching pipeline crons temporarily. Existing intros still surface; no new matches generated.

### 3.10 User reports "I never got an intro"

**Symptoms:** specific user reports they were promised an intro but it never arrived.

**Detect:**
- Forensic SQL:
  ```sql
  SELECT id, status, ack_received_at, ack_channel, sent_at, retry_count
  FROM agent_outreach_log
  WHERE target_user_id = (SELECT id FROM instaclaw_users WHERE name = '<user>')
    AND sent_at > NOW() - INTERVAL '24 hours'
  ORDER BY sent_at DESC LIMIT 10;
  ```

**Recovery:**
- If ack_received_at is set but ack_channel = 'pending': the intro went to disk only. SSH to the VM, check `~/.openclaw/xmtp/pending-intros.jsonl`. The agent should have surfaced it on the next user pull.
- If status = 'sent' but ack_received_at is NULL > 30 min: the receiver's xmtp-agent died or didn't process. Restart `instaclaw-xmtp` service on the receiver VM, run `consensus_match_pipeline.py --force` to trigger receiver poll.
- If no rows at all: the sender's pipeline never fired the outreach. Check the sender's pipeline logs.

### 3.11 The kill-switch itself fails

**Symptoms:** flipped `CONSENSUS_INTRO_FLOW_ENABLED=false` but new intros still firing.

**Detect:**
- Watch new rows in agent_outreach_log within 2 minutes of the env flip.

**Recover:**
1. **Verify the env var landed:** Vercel dashboard → Environment Variables → confirm `CONSENSUS_INTRO_FLOW_ENABLED=false` exists for Production.
2. **Force redeploy:** `git commit --allow-empty -m "force redeploy" && git push origin main`. New env vars are picked up on every request, but a redeploy guarantees a clean start.
3. **Last resort — disable at the database level:** Open Supabase Studio, run:
   ```sql
   ALTER TABLE agent_outreach_log DISABLE TRIGGER ALL;
   -- this won't stop new INSERTs on its own; better is to drop the unique index
   -- temporarily, then INSERTs will fail
   ALTER TABLE agent_outreach_log DROP CONSTRAINT idx_outreach_idempotency;
   -- inserts now succeed but you'll need to remember to re-add. Or:
   -- REVOKE INSERT ON agent_outreach_log FROM service_role;
   -- (most aggressive — blocks all writes)
   ```
   Use this ONLY in a true emergency. Tell Cooper before doing.

---

## 4. Escalation paths

### Tier 0 — automated, no human needed
- Sender retry on no-ack (every 30 min, capped at 3).
- Server-poll fallback (every cron tick).
- Watchdog v2 restarts unhealthy VMs.
- Telegram delivery → XMTP fallback → pending-intros.jsonl cascade.

### Tier 1 — Cooper / on-call human
- Anything in section 3 with no auto-recovery.
- New code changes during the conference (only for true blockers).
- Comms to users / public.

### Tier 2 — domain experts
- **Billing (1008 errors):** gbrain. Channel: their thread.
- **XMTP protocol issues:** XMTP team Slack/Telegram (their channel).
- **Linode / infra:** Joey (account) or Pat (technical).
- **Anthropic rate limits:** Anthropic dashboard → support.

### Tier 3 — public
- If Consensus attendees report multi-hour outage:
  - Post status on @instaclaws.
  - DM affected users from Cooper personally with apology + ETA.
  - Avoid technical detail in public — keep it human.

---

## 5. Comm templates

### Status post: short outage
```
quick heads up: instaclaw matching is degraded for ~30 min. agents
are still online; new intros may be slow. fix in flight, will update
when clear.
```

### Status post: longer outage (> 1 hour)
```
matching engine is down right now. existing intros that already
landed are unaffected. new intros not firing.

cause: <one-sentence honest summary>. fix ETA: <timestamp>.

apologies for the timing — we're on it.
```

### DM to affected user
```
hey, saw you mentioned not getting an intro from <name>. checked
the system — <one-sentence forensics>. fixed now. sorry for the
delay.
```

---

## 6. Post-incident discipline

After any tier-1+ recovery:

1. **Commit the fix.** Even if it's a 1-line change, branch + PR + review (no direct main if avoidable).
2. **Update CLAUDE.md** if the incident reveals a new class of bug (Rule 25, 26, ...).
3. **Update this runbook** if a failure scenario surfaced that wasn't covered.
4. **Snapshot the agent_outreach_log + matchpool_deliberations** before truncating any state during recovery. Forensic preservation.
5. **Note the incident in @instaclaws DMs / changelog** if user-facing.

---

## 7. End of conference (May 8 morning)

Closing checks:
- [ ] Final agent_outreach_log dump for the 3-day window: `select count(*), ack_channel from agent_outreach_log where sent_at > '2026-05-05' group by ack_channel;` — saves the success metrics for the post-mortem post.
- [ ] Disable `CONSENSUS_INTRO_FLOW_ENABLED` (default to false post-conference, re-enable for next event).
- [ ] Set `live-events` skill `consensus-2026` row to `is_default=false, status='retired'` so the skill drops out of the active set.
- [ ] Backup any partner VMs that had unique conference state.
- [ ] Write the post-mortem post: what shipped, what landed, what the metrics say, what we'd do differently.

---

**End of runbook.**

If you're reading this at 3am and something isn't covered: Cooper's number is in the team contact sheet. Don't suffer in silence.
