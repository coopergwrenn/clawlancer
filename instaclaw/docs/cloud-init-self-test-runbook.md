# Cloud-Init Self-Test Runbook

**For:** Cooper, 2026-05-17 ~10AM ET
**Reading on phone:** scroll past §0 only if flag is already enabled.

---

## §0. Pre-flight (do this FIRST)

**The flag must be on, or the signup takes the pool path and you've tested nothing.**

```bash
# Set flag in Vercel production env (Rule 6: printf, never <<<)
printf 'true' | npx vercel env add CLOUD_INIT_ONDEMAND_ENABLED production
# Trigger redeploy
git commit --allow-empty -m "chore: redeploy for cloud-init test" && git push
# Wait ~3 min for Vercel deploy
```

Confirm it's live:
```bash
curl -s https://instaclaw.io/api/health | jq .  # any 200 = deploy is done
```

You also need:
- **A fresh Google account that has NEVER signed in to InstaClaw.** Verify by querying `instaclaw_users WHERE email = '<test-email>'` returns 0 rows. Account-with-VM short-circuits at `vm/assign:104-115` and the cloud-init path is never invoked.
- A real credit card (Stripe is on real production keys; charge yourself the starter $X, refund after).

---

## §1. Sign up

1. Open `https://instaclaw.io/signup` in incognito.
2. Sign in with the fresh Google account.
3. Choose **Starter** tier, complete Stripe checkout.
4. Browser redirects to `/deploying`. **Note the time** — call this **T+0**.

---

## §2. Watch the bootstrap (~8 min)

Re-run this every 1-2 min in Supabase Studio (sub in your email):

```sql
SELECT name, status, health_status,
       gateway_url, ip_address, config_version,
       assigned_at, cloud_init_config_consumed_at, cloud_init_callback_consumed_at
FROM instaclaw_vms
WHERE assigned_to = (SELECT id FROM instaclaw_users WHERE email = '<your-test-email>')
ORDER BY created_at DESC LIMIT 1;
```

Expected timeline (relative to T+0):

| Time | What you should see |
|---|---|
| T+0–30s | Row exists, `status='provisioning'`, `ip_address=NULL`, `gateway_token` set |
| T+30s–2min | `ip_address` populates (Linode booted) |
| T+2–6min | `cloud_init_config_consumed_at` populates (bootstrap fetched tarball) |
| T+6–10min | `cloud_init_callback_consumed_at` + `status='assigned'` + `health_status='healthy'` + `gateway_url=http://{ip}:18789` |
| T+8–12min | `gateway_url` flips to `https://{uuid}.vm.instaclaw.io` (TLS landed) |
| T+12–17min | `config_version=100` (reconciler caught up) |

If `cloud_init_config_consumed_at` is still NULL at T+8min → bootstrap never fetched the tarball. SSH to the VM, check `/var/log/cloud-init-output.log`.

---

## §3. Five verification queries (run at T+17min)

```sql
-- Substitute <email> and <user_id> below.

-- Q1: User onboarded (P0-C fix)
SELECT email, onboarding_complete, deployment_lock_at
FROM instaclaw_users WHERE email = '<email>';
-- EXPECT: onboarding_complete=true, deployment_lock_at=NULL

-- Q2: VM on HTTPS (P0-A fix + TLS hook landed)
SELECT name, gateway_url, control_ui_url
FROM instaclaw_vms WHERE assigned_to = '<user_id>';
-- EXPECT: gateway_url starts with 'https://' AND ends with '.vm.instaclaw.io'

-- Q3: VM at current manifest version
SELECT name, config_version
FROM instaclaw_vms WHERE assigned_to = '<user_id>';
-- EXPECT: config_version=100 (or whatever VM_MANIFEST.version is)

-- Q4: VM healthy
SELECT name, health_status, last_health_check
FROM instaclaw_vms WHERE assigned_to = '<user_id>';
-- EXPECT: health_status='healthy', last_health_check within last 5 min

-- Q5: Heartbeat scheduled (CRITICAL — guards against PROVISIONING_BLOCKED)
SELECT name, heartbeat_next_at, heartbeat_interval, heartbeat_cycle_calls
FROM instaclaw_vms WHERE assigned_to = '<user_id>';
-- EXPECT: heartbeat_next_at ~3h in future, heartbeat_interval='3h', heartbeat_cycle_calls=0
```

**All 5 must pass.** Any single failure = bug.

---

## §3.5. Byte-parity audit (G2 gate from Phase 1C scope)

After Q1–Q5 pass, run the on-disk byte-comparison script to verify setup.sh's outputs match what configureOpenClaw would have produced. Pick any cv=100 healthy pool VM as the baseline (run `SELECT name FROM instaclaw_vms WHERE status='assigned' AND health_status='healthy' AND created_via IS NULL AND config_version=100 LIMIT 1` to grab one).

```bash
cd instaclaw
npx tsx scripts/_compare-old-vs-new-path.ts \
  --new=<your-test-vm-name> \
  --old=<baseline-pool-vm-name> \
  --report=/tmp/byte-parity.md
```

The script SSHes to both VMs read-only and diffs 12 sections (A through L): openclaw.json keys, .env vars, workspace files, agent dir, openclaw scripts, outer scripts, skills, crontab, systemd units, npm globals, pip packages, service health.

Verdicts per diff:
- **EXPECTED** — per-user content that SHOULD differ (MEMORY.md, agent.key, IDs). Ignore.
- **WARNING** — acceptable variance (skill-pull commit SHA within 2 of each other). Glance, ignore.
- **BUG** — should be byte-identical. **ANY BUG = Phase 1C halt + fix.**

Script exits 0 if BUGS=0, exits 1 otherwise. Skim the report at /tmp/byte-parity.md for the full diff list.

---

## §4. End-user test

1. Open `https://instaclaw.io/dashboard` while signed in.
   - **MUST NOT bounce to `/connect`.** Bouncing = Rule 33 trap state (P0-C regression).
2. Find your bot in Telegram, send: `say hi`.
3. Agent replies within ~30s.

---

## §5. If anything fails — rollback

### Emergency fleet-wide disable (flips back to pool path):

```bash
# Quickest: delete the env var
npx vercel env rm CLOUD_INIT_ONDEMAND_ENABLED production
git commit --allow-empty -m "chore: disable cloud-init" && git push
# OR set to false (same effect):
printf 'false' | npx vercel env add CLOUD_INIT_ONDEMAND_ENABLED production
```

### Clean up the test user (SQL — run in Supabase Studio):

```sql
-- 1. Capture IDs first
SELECT u.id AS user_id, v.id AS vm_id, v.name, v.provider_server_id, v.ip_address
FROM instaclaw_users u
LEFT JOIN instaclaw_vms v ON v.assigned_to = u.id
WHERE u.email = '<email>';

-- 2. Mark VM failed (don't delete — keep for forensics)
UPDATE instaclaw_vms
SET assigned_to=NULL, status='failed', health_status='unhealthy', ip_address=NULL
WHERE id = '<vm_id>';

-- 3. Soft-delete user row
DELETE FROM instaclaw_pending_users WHERE user_id = '<user_id>';
DELETE FROM instaclaw_subscriptions WHERE user_id = '<user_id>';
DELETE FROM instaclaw_users WHERE id = '<user_id>';
```

### Destroy the Linode (after forensics — bill is $29/mo per orphan):

```bash
curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
  "https://api.linode.com/v4/linode/instances/<provider_server_id>"
```

### Refund the Stripe charge:

Stripe dashboard → Payments → find the charge → Refund.

---

## §6. Common failure modes — what to check first

1. **VM stuck `status='provisioning'` past T+12min.** Bootstrap or setup.sh failed.
   - Vercel logs: search for `cloud-init-config` and `cloud-init-callback`. Neither hit = bootstrap never ran.
   - SSH to VM (`openclaw@<ip>`): `cat /var/log/cloud-init-output.log` and `cat /var/log/instaclaw-setup.log`.

2. **`gateway_url` stays `http://` past T+15min.** TLS upgrade failed (not a customer-down issue — VM works on HTTP).
   - Vercel logs: search `setupTLSBackground`. Look for GoDaddy DNS errors or Caddy install errors.
   - SSH to VM: `systemctl status caddy`.
   - Manual fix: `UPDATE instaclaw_vms SET gateway_url='https://{vm_id}.vm.instaclaw.io', control_ui_url=... WHERE id='<vm_id>'` after Caddy is up.

3. **`config_version` stays at 0 past T+17min.** Reconciler isn't picking up.
   - Check Vercel cron logs for `reconcile-fleet`.
   - Check `reconcile_consecutive_failures` and `reconcile_last_error` columns.
   - Force-run with `npx tsx scripts/_catch-up-stuck-cohort.ts --vms=<vm_name> --yes`.

4. **`onboarding_complete=false` but VM is healthy.** Rule 33 trap state — the P0-C fix's `instaclaw_users.update` failed.
   - Vercel logs: search for `instaclaw_users update failed (Rule 33 trap-state risk)`.
   - Manual fix: `UPDATE instaclaw_users SET onboarding_complete=true, deployment_lock_at=NULL WHERE id='<user_id>'`.

5. **Telegram bot silent.** Token mismatch or gateway crash-loop.
   - SSH to VM: `journalctl --user -u openclaw-gateway | tail -50`.
   - Verify `jq '.channels.telegram.botToken' ~/.openclaw/openclaw.json` matches DB's `telegram_bot_token`.

---

## §7. After a successful run

```bash
# Leave the flag ON if you want to keep new signups on cloud-init.
# Toggle it off if you want to revert to pool until next decision:
npx vercel env rm CLOUD_INIT_ONDEMAND_ENABLED production
# (then redeploy)
```

Then post the result in the relevant Slack/notes:
- ✓ if Q1–Q5 all passed + dashboard didn't bounce + Telegram bot replied
- ✗ + which step failed
