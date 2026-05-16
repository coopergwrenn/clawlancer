# Phase 1B-1 Runbook — Cloud-init On-Demand Self-Test

**Created:** 2026-05-15
**Trigger:** Phase 1B-1 self-test signup (Cooper-driven)
**Scope:** one canary signup through the cloud-init bootstrap+fetch path,
then Phase 1B-2 byte-parity verification against a control pool VM.

This runbook is structured as four sequential phases, each with a clear
abort gate. If any check inside a phase fails, STOP and follow the
corresponding entry in §3 Rollback before continuing.

---

## §0. Prerequisites — verify BEFORE flipping the flag

| # | Check | How to verify | Pass criteria |
|---|---|---|---|
| 0.1 | All Phase 1A + 1B-1 code on `origin/main` | `git fetch origin main && git log origin/main --oneline \| head -10` | Top commit references `Phase 1B-1 wire-up — flag-gated cloud-init signup path` (currently `7d550a9f` or later) |
| 0.2 | Latest Vercel deploy is green | `npx vercel ls instaclaw \| head -3` | Most recent row shows `● Ready Production` |
| 0.3 | `NEXTAUTH_URL` set on all envs | `npx vercel env ls production \| grep NEXTAUTH_URL` | Value is `https://instaclaw.io` (no trailing slash) |
| 0.4 | `SUPABASE_SERVICE_ROLE_KEY` set | `npx vercel env ls production \| grep SUPABASE_SERVICE` | Listed |
| 0.5 | `LINODE_API_TOKEN` + `LINODE_SNAPSHOT_ID` set | `npx vercel env ls production \| grep LINODE_` | Both listed |
| 0.6 | Pool has ≥3 ready VMs (rollback fallback) | `curl -sS "$SUPABASE_URL/rest/v1/instaclaw_vms?status=eq.ready&select=id&limit=10" -H "..." \| jq length` | `>= 3` — if pool empty, replenish FIRST (rollback path won't work otherwise) |
| 0.7 | Cooper's test user account state | See §0.7 below | Clean state — no in-flight provisioning |
| 0.8 | Flag is currently OFF | `npx vercel env ls production \| grep CLOUD_INIT_ONDEMAND_ENABLED` | Not present, or value is anything other than `true` |
| 0.9 | All 5 cloud-init test suites pass locally | `npx tsx scripts/_test-cloud-init-tarball.ts && npx tsx scripts/_test-cloud-init-config-endpoint.ts && npx tsx scripts/_test-cloud-init-callback-endpoint.ts && npx tsx scripts/_test-createUserVM.ts && npx tsx scripts/_test-assignOrProvisionUserVm.ts` | All print `ALL PASS` |

### 0.7 Test user state check

If Cooper is testing as himself (existing account), verify his user row
isn't in a weird state from prior testing:

```sql
SELECT id, email, onboarding_complete, deployment_lock_at, partner
FROM instaclaw_users WHERE email = 'coopergrantwrenn@gmail.com';

SELECT id, name, status, health_status, created_via,
       cloud_init_config_token IS NOT NULL AS has_config_token,
       cloud_init_callback_token IS NOT NULL AS has_callback_token,
       cloud_init_config_consumed_at, cloud_init_callback_consumed_at,
       assigned_to, created_at
FROM instaclaw_vms WHERE assigned_to = (
  SELECT id FROM instaclaw_users WHERE email = 'coopergrantwrenn@gmail.com'
) ORDER BY created_at DESC LIMIT 5;

SELECT id, consumed_at, telegram_bot_username, created_at
FROM instaclaw_pending_users WHERE user_id = (
  SELECT id FROM instaclaw_users WHERE email = 'coopergrantwrenn@gmail.com'
) ORDER BY created_at DESC LIMIT 3;
```

**Pass criteria for an EXISTING test account**:
- `instaclaw_users`: `onboarding_complete = true` (Cooper has at least one working VM), `deployment_lock_at IS NULL`
- `instaclaw_vms`: ≥1 row exists (his current working VM, vm-050 per memory)
- `instaclaw_pending_users`: most recent row has `consumed_at IS NOT NULL` (no in-flight signup)

For a CLEAN test (new email), skip this; the signup wizard will populate
everything fresh.

---

## §1. Self-test checklist — happy path

Execute in order. Each step has a VERIFY clause that gates the next step.

### 1.1 Flip the flag — PREVIEW environment first

**Why preview first**: catches misconfiguration in a non-customer-facing
environment. Production flip happens only after preview self-test passes.

```bash
# Use printf (Rule 6) — NEVER <<< or echo
printf 'true' | npx vercel env add CLOUD_INIT_ONDEMAND_ENABLED preview

# Trigger redeploy (env-add doesn't auto-redeploy)
npx vercel deploy --prod=false
```

**VERIFY**:
- `npx vercel env ls preview | grep CLOUD_INIT_ONDEMAND_ENABLED` shows value = `true`
- Wait for the redeploy: `npx vercel ls instaclaw | head -3` shows the new preview as `Ready`
- Hit the preview URL (e.g., `https://instaclaw-git-main-cooper-wrenns-projects.vercel.app/`) — homepage loads

### 1.2 Pick / prepare the test user

**Option A** — use an existing test account (recommended for speed):
- Cooper's signup-test email (whatever he uses for QA — NOT his prod account)
- Verify §0.7 state is clean

**Option B** — fresh email:
- Sign up at preview URL with a new Gmail / Google OAuth
- Wizard generates `instaclaw_users` + (eventually) `instaclaw_pending_users`

### 1.3 Walk the signup wizard

Through the preview URL:
1. `/signup` — sign in (Google OAuth or email magic link)
2. `/connect` — paste a Telegram bot token + username (create via @BotFather)
3. `/plan` — pick a tier (e.g., starter @ $20/mo)
4. Click "Subscribe" — redirects to Stripe checkout

**VERIFY** before checkout completes:
```sql
SELECT id, user_id, tier, api_mode, default_model,
       telegram_bot_token IS NOT NULL AS has_bot_token,
       telegram_bot_username, consumed_at
FROM instaclaw_pending_users
WHERE user_id = '<your-user-id>'
ORDER BY created_at DESC LIMIT 1;
```
Expected: row exists, `consumed_at IS NULL`, telegram fields populated.

### 1.4 Complete Stripe checkout

Use Stripe's test card `4242 4242 4242 4242` (any future exp, any CVC).
Click pay. Stripe redirects back to instaclaw.io/deploying.

**Critical observation window opens here.** From this moment, 4 things
run in parallel:
- Stripe webhook fires → `assignOrProvisionUserVm` → `createUserVM`
- Verify endpoint fires (post-redirect) → same wrapper
- `/deploying` page starts polling `/api/vm/status`
- (background) Linode begins booting the new VM

### 1.5 Watch the `/deploying` page

UI behavior expectations:
- Initial state: "Deploying your agent…" with a spinner
- Pool path used to land in ~30-60s
- **Cloud-init path takes ~3-5 min** (Linode boot + cloud-init bootstrap
  + per-user tarball download + setup.sh + gateway start)
- After ~3-5 min the page should redirect to `/dashboard`

**If the page hangs for >7 min**: something failed. Go to §3 Rollback.

### 1.6 VERIFY the row state during boot

Run this every 30s while the page is polling:

```sql
SELECT name, status, health_status, ip_address, created_via,
       cloud_init_config_token IS NOT NULL AS has_ct,
       cloud_init_config_consumed_at IS NOT NULL AS ct_consumed,
       cloud_init_callback_token IS NOT NULL AS has_cb,
       cloud_init_callback_consumed_at IS NOT NULL AS cb_consumed,
       gateway_url, provider_server_id,
       updated_at
FROM instaclaw_vms
WHERE assigned_to = '<your-user-id>'
ORDER BY created_at DESC LIMIT 1;
```

**Expected state machine** (each subsequent observation must show forward
progress; backward transitions or stalls are the abort signal):

| Time | status | health_status | created_via | has_ct | ct_consumed | has_cb | cb_consumed | gateway_url |
|---|---|---|---|---|---|---|---|---|
| t+0s (row exists) | provisioning | (null/whatever) | **on_demand** | true | false | true | false | null |
| t+30-60s | provisioning | (null) | on_demand | true | **true** | true | false | null |
| t+3-5min | **assigned** | **healthy** | on_demand | true | true | true | **true** | non-null |

**Pass criteria**:
- `created_via = 'on_demand'` (NOT null — that's the pool path)
- `ct_consumed` flips to true within ~60s (bootstrap fetched the tarball)
- `cb_consumed` flips to true within ~5 min (setup.sh successfully called back)
- Final `status = 'assigned'` AND `health_status = 'healthy'` AND `gateway_url` set

### 1.7 VERIFY the VM itself via SSH (deep inspection)

Once the row hits `health_status='healthy'`, SSH in and confirm:

```bash
# Bootstrap key
[ -f /tmp/ic_ssh_key ] || (grep '^SSH_PRIVATE_KEY_B64=' \
  /Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key | head -1 | \
  sed 's/^SSH_PRIVATE_KEY_B64=//' | sed 's/"//g' | base64 -d > /tmp/ic_ssh_key \
  && chmod 600 /tmp/ic_ssh_key)

ssh -i /tmp/ic_ssh_key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  openclaw@<NEW_VM_IP> 'bash -s' <<'REMOTE'
echo "== /tmp/.instaclaw-ready (success sentinel) =="
[ -f /tmp/.instaclaw-ready ] && echo "PRESENT" || echo "MISSING"
echo "== /tmp/.instaclaw-failed (failure sentinel) =="
[ -f /tmp/.instaclaw-failed ] && echo "PRESENT" || echo "ABSENT (expected)"
echo "== bootstrap log =="
tail -20 /var/log/instaclaw-bootstrap.log 2>/dev/null || echo "MISSING"
echo "== setup log =="
tail -20 /var/log/instaclaw-setup.log 2>/dev/null || echo "MISSING"
echo "== gateway active =="
systemctl --user is-active openclaw-gateway
echo "== /health =="
curl -sf -o /dev/null -w "  http=%{http_code}\n" -m 5 localhost:18789/health
echo "== agent.key generated on-VM (Day 9-10 design) =="
[ -f ~/.openclaw/wallet/agent.key ] && wc -c ~/.openclaw/wallet/agent.key || echo "MISSING"
ls -la ~/.openclaw/wallet/agent.key 2>/dev/null
echo "== openclaw.json per-user fields present =="
grep -oE '"botToken":"[0-9]+:' ~/.openclaw/openclaw.json | head -1
echo "== AGENTBOOK_ADDRESS in .env (should be empty per Day 11-12 fix) =="
grep "^AGENTBOOK_ADDRESS=" ~/.openclaw/.env || echo "ABSENT (also acceptable — Day 9-10 conditional)"
echo "== partner overlays (if edge_city) =="
ls -la ~/.openclaw/skills/edge-esmeralda/SKILL.md 2>/dev/null | head -1 || echo "no edge overlay"
REMOTE
```

**Pass criteria**:
- `/tmp/.instaclaw-ready` PRESENT, `/tmp/.instaclaw-failed` ABSENT
- bootstrap.log ends with `bootstrap complete`
- setup.log ends with `setup.sh complete (CRITICAL + BE-1 + ...)`
- `systemctl --user is-active openclaw-gateway` → `active`
- `/health` returns 200
- `wallet/agent.key` exists, mode 600, owner `openclaw:openclaw`,
  64 chars (32-byte hex)
- openclaw.json contains the user's botToken (signal that the tarball's
  openclaw.json landed)
- AGENTBOOK_ADDRESS is either empty string OR absent (per Day 9-10
  + Day 11-12 design — on-VM-gen path doesn't yet derive the address)

### 1.8 VERIFY Telegram round-trip (the load-bearing test)

This is what proves the VM is END-TO-END functional. Everything above
just verifies the wiring; this verifies the user-visible product.

Send a Telegram message to the bot username (e.g., `@<cooperbot1>`):

```
hello, can you tell me what time it is?
```

**Pass criteria**:
- Bot replies within 30 seconds
- Response is sensible and English (not a parser error, not a stack trace)
- No "Something went wrong" message

If reply doesn't arrive within 60s, the cloud-init path produced a VM
that boots but doesn't actually work. Go to §3 Rollback.

### 1.9 Initial smoke pass — DECISION GATE

**If §1.1 → §1.8 all pass**: proceed to §2 (byte-parity audit).
**If any step fails**: STOP. Go to §3 Rollback.

---

## §2. Phase 1B-2 byte-parity audit

Compares the cloud-init test VM against a control pool VM to surface
any silent divergences (Rule 23 / Rule 33 territory).

### 2.1 Pick the control VM

The control should be:
- Same `tier` as test VM
- Same `partner` as test VM (`NULL` if test is vanilla; `'edge_city'` if test partner is edge_city)
- Same `config_version = VM_MANIFEST.version` (otherwise manifest-content
  differences will dominate the diff and bury real bugs)
- `created_via IS NULL` (i.e., pool-provisioned — `'on_demand'` is the
  on-demand marker)
- Healthy and recently provisioned (not "lived in" — older VMs have
  agent-edited workspace files that would appear as bugs)

Query to pick:

```sql
SELECT name, ip_address, tier, partner, config_version, created_via,
       health_status, created_at
FROM instaclaw_vms
WHERE tier = '<test-vm-tier>'           -- match test VM
  AND COALESCE(partner, '') = COALESCE('<test-vm-partner>', '')
  AND created_via IS NULL                -- pool-provisioned
  AND config_version = (SELECT max(config_version) FROM instaclaw_vms)
  AND health_status = 'healthy'
  AND status = 'assigned'
  AND assigned_to IS NOT NULL            -- has a real user (already configured)
ORDER BY created_at DESC                  -- prefer most recent
LIMIT 5;
```

Pick one. Verify with the owner (or use a VM whose owner won't notice
SSH reads). The compare script is read-only — no state changes — so
this is safe.

### 2.2 Run the comparison

```bash
cd /Users/cooperwrenn/wild-west-bots/instaclaw

npx tsx scripts/_compare-old-vs-new-path.ts \
  --new=<TEST_VM_NAME> \
  --old=<CONTROL_VM_NAME> \
  --report=docs/phase-1b-2-report-$(date +%Y-%m-%d).md
```

Runtime: ~2-5 min (SSH + md5 on ~150 paths, plus dir walks).

### 2.3 Read the report

Open the generated markdown. The summary block at the top says:

```
- Total artifacts compared: N
- Byte-match: N1 ✓
- Expected divergence (per-user): N2 ✓
- Warnings: N3
- BUGS: 0 ✓                          ← pass criteria
- **PASS — no bugs found**            ← OR "FAIL — fix N bugs..."
```

**Pass criteria**:
- `BUGS = 0`
- Each EXPECTED divergence reviewed (workspace MEMORY.md, IDENTITY.md,
  etc. — per-user content should differ; this is correct)
- Each WARNING reviewed:
  - `DEFERRED` markers (SOUL.md partial-match, chat-completion behavior)
    are known deferrals — acknowledge and move on
  - Skill-clone SHA drift within 2 commits — acceptable (Rule 24
    git-pull cron variance)
  - Other warnings: investigate

### 2.4 Decision gate — production flag flip

**If BUGS = 0**: cloud-init path is byte-parity-verified. Proceed to
flip the production flag.

**If BUGS > 0**: STOP. File each bug. Fix in a Phase 1A patch. Roll
back §2 + §1 (clean up test VM, flag off). Re-run from §1.1 after fix.

### 2.5 Production flag flip (only after §2.4 PASS)

```bash
printf 'true' | npx vercel env add CLOUD_INIT_ONDEMAND_ENABLED production
npx vercel deploy --prod
```

Wait for redeploy. Verify `npx vercel env ls production | grep CLOUD_INIT`
shows `true`.

From here, all new signups go through the cloud-init path. The pool
stays alive (replenish-pool cron continues) as a safety net.

### 2.6 First-hour monitoring

After production flip, watch for 60 minutes:

- Every 5 min: query `instaclaw_vms WHERE created_via='on_demand' AND
  created_at > now() - interval '1 hour'`. Confirm new rows transition
  to `status='assigned'` + `health_status='healthy'` within 5-7 min.
- Watch `instaclaw_cloud_init_outcomes` (Phase 1A migration's audit
  table) for `status='failed'` or `status='timeout'` entries.
- Watch the admin alert log: any new `reconcile_failure_alert` or
  `Stuck-Onboarding Users` alerts for new VMs.

If anything spikes red: flip flag off (§3.1) immediately. Existing
on-demand VMs continue working (already healthy); the flag-off prevents
NEW on-demand VMs from being created.

---

## §3. Rollback — when things go wrong

Rollback severity tiers. Pick the row that matches the worst observation
and follow the steps in that row. Higher tiers include all lower-tier
steps.

### Tier 1 — flag off, no other action needed

**Trigger**: §1.1 preview deploy doesn't go green; flag was never
flipped in production.

```bash
# Remove the preview flag (or set to false)
npx vercel env rm CLOUD_INIT_ONDEMAND_ENABLED preview
```

Verify with `npx vercel env ls preview`. No further action — pool path
takes over immediately on next deploy.

### Tier 2 — flag off + clean up test VM (no production exposure)

**Trigger**: preview self-test failed at §1.5–§1.8. Test VM exists in
DB + Linode but isn't healthy.

```bash
# 1. Flag off in preview
npx vercel env rm CLOUD_INIT_ONDEMAND_ENABLED preview

# 2. Identify the test VM
TEST_VM_NAME="<from §1.6>"
TEST_VM_PROVIDER_ID="<provider_server_id from §1.6>"

# 3. Delete the Linode instance
curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
  "https://api.linode.com/v4/linode/instances/${TEST_VM_PROVIDER_ID}"

# 4. Mark the DB row terminated (don't actually DELETE — preserve audit trail)
psql ... <<SQL
UPDATE instaclaw_vms
SET status='terminated', health_status='unhealthy',
    assigned_to=NULL, assigned_at=NULL,
    ip_address=NULL, provider_server_id=NULL
WHERE name='${TEST_VM_NAME}';
SQL

# 5. Clear consumed_at on the user's pending_users so they can retry
psql ... <<SQL
UPDATE instaclaw_pending_users
SET consumed_at=NULL
WHERE user_id='<test-user-id>' AND created_at > now() - interval '1 hour';
SQL

# 6. Clear onboarding state on the user
psql ... <<SQL
UPDATE instaclaw_users
SET onboarding_complete=false, deployment_lock_at=NULL
WHERE id='<test-user-id>';
SQL
```

### Tier 3 — production flag was flipped, customer-impacting

**Trigger**: §2.5 flipped the flag and §2.6 observed failure spikes.

```bash
# 1. URGENT: flag off in production
npx vercel env rm CLOUD_INIT_ONDEMAND_ENABLED production
npx vercel deploy --prod

# 2. While the redeploy is running, identify any in-flight on-demand VMs
psql ... <<SQL
SELECT name, ip_address, status, health_status, created_at
FROM instaclaw_vms
WHERE created_via='on_demand' AND created_at > now() - interval '15 minutes'
ORDER BY created_at DESC;
SQL

# 3. For each stuck on-demand VM (status='provisioning' >5 min old):
#    a. SSH in and check /tmp/.instaclaw-failed
#    b. If failed: mark status='failed' (cloud-init-poll's 30-min timeout
#       would do this anyway; doing it now unsticks the UI faster)
#    c. If somehow stuck-but-recovering: leave it (callback may fire)

# 4. Customer-facing: existing on-demand VMs that successfully transitioned
#    to status='assigned' before the flag flip are FINE — they're real VMs.
#    Don't delete them. The flag flip stops NEW signups, not existing VMs.

# 5. Notify Cooper + Stripe team about the incident window. Any customer
#    that hit /deploying during the broken window and didn't get a VM
#    needs manual attention.
```

### Tier 4 — silent customer-down (the most expensive class)

**Trigger**: VM transitioned to `assigned/healthy` per DB but the customer
reports the agent isn't responding. This is the Rule 33 / Rule 22 class
of silent failure.

Steps:
1. Run §3 Tier 3 (flag off + cleanup in-flight).
2. SSH into the broken VM directly. Check gateway logs (`journalctl
   --user -u openclaw-gateway --since "1h ago"`).
3. Check session jsonl files for corruption (Rule 22).
4. Compare against the test VM that worked in §1: what's structurally
   different?
5. File a P0 incident doc in `instaclaw/docs/incidents/<date>-cloud-init-
   silent-fail-<id>.md`.

---

## §4. Operational reference

### Useful queries

```sql
-- All on-demand VMs (Phase 1B-1 canary + beyond)
SELECT name, status, health_status, created_at, ip_address, partner, tier
FROM instaclaw_vms WHERE created_via = 'on_demand' ORDER BY created_at DESC;

-- Active config + callback tokens (should be NULL once consumed)
SELECT name, cloud_init_config_consumed_at, cloud_init_callback_consumed_at
FROM instaclaw_vms WHERE created_via = 'on_demand'
  AND (cloud_init_config_consumed_at IS NULL
       OR cloud_init_callback_consumed_at IS NULL);

-- cloud-init outcome audit (Phase 1A migration table)
SELECT vm_id, action, status, failure_reason, duration_seconds, created_at
FROM instaclaw_cloud_init_outcomes
WHERE created_at > now() - interval '1 day'
ORDER BY created_at DESC;
```

### Key logs to watch

- `logger.info "createUserVM: provisioned"` — successful row insert +
  Linode create + IP update
- `logger.info "cloud-init-config: tarball served"` — bootstrap fetched
- `logger.info "cloud-init-callback: VM transitioned to assigned/healthy"`
  — setup.sh successfully called back
- `logger.warn "cloud-init-config: claim failed"` — bootstrap failed
  the atomic claim (expected on retries; concerning at first attempt)
- `logger.warn "cloud-init-callback: claim failed"` — same for callback
- `logger.error "createUserVM: Linode createServer failed"` — Linode
  API hiccup
- `logger.error "assignOrProvisionUserVm threw"` — wrapper-level throw
  (validation error in cloud-init path OR transient Linode error)

### Code references

- Wrapper: `lib/createUserVM.ts:assignOrProvisionUserVm`
- Endpoint (config token): `app/api/vm/cloud-init-config/route.ts`
- Endpoint (callback token): `app/api/vm/cloud-init-callback/route.ts`
- Tarball builder: `lib/cloud-init-tarball.ts:buildCloudInitTarball`
- Bootstrap script: `lib/cloud-init-userdata.ts:buildCloudInitUserdata`
- Setup.sh template: `lib/cloud-init-setup-sh.ts:buildSetupSh`
- Compare script: `scripts/_compare-old-vs-new-path.ts`
- 5 callsites: `app/api/billing/webhook/route.ts`, `app/api/checkout/
  verify/route.ts`, `app/api/vm/assign/route.ts`,
  `app/api/cron/process-pending/route.ts` (×2)

### Out-of-scope items (Phase 1B-1 deferred)

These are KNOWN limitations of the current cloud-init path. If a self-test
reveals one of these, it's expected and not a blocker for proceeding:

1. **VM-ready email** doesn't fire on cloud-init-callback success.
   Cooper polls the dashboard for now. Future enhancement.
2. **SOUL.md partial-match** in the compare script is `DEFERRED` —
   surfaces as WARNING in §2 report. Doesn't block the audit.
3. **5-prompt chat-completion behavior comparison** in §L of the report
   is `DEFERRED`. Section L verifies service is-active + /health 200 only.
4. **AGENTBOOK_ADDRESS backfill** — on-VM-generated key isn't yet
   reported back to the DB. The column stays NULL until a future
   cloud-init-callback enhancement derives + posts the address.
5. **health-check auto-migration** still uses the pool path. Recovery
   from a dead VM doesn't yet use cloud-init.

None of these block production rollout. They're tracked as Phase 2
follow-ups.
