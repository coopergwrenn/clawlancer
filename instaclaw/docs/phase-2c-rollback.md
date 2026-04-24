# Phase 2c — Strict Reconcile Rollback Playbook

**Audience:** Cooper, future-Claude at 3am, anyone on-call.
**Goal:** recover from each failure mode in under 10 minutes without
needing to re-derive architecture from code.

## Kill-switch quick reference

| Switch | Location | Effect | Time to take effect |
|---|---|---|---|
| DB flag `strict_mode_enabled` | `instaclaw_admin_settings` table | Fleet runs all VMs in legacy mode regardless of env allowlist | Next cron cycle (≤3 min) |
| DB flag `canary_enabled` | `instaclaw_admin_settings` table | Strict mode runs config-set validation only; no canary | Next cron cycle (≤3 min) |
| Env `STRICT_RECONCILE_VM_IDS` | Vercel → Project → Environment Variables | Empty string → zero VMs in strict mode | Next cron cycle after redeploy (~3–5 min) |
| Full revert | `git revert <sha> && git push origin main` | Removes all Phase 2c code | ~3–5 min Vercel deploy |

**Prefer DB flags over env vars** for emergency response. No redeploy required.

---

## Scenario A — Strict mode over-blocks (too many false positives)

### Trigger
- `reconcile-fleet` cron response shows `strictHeld` ≥ N where N is "more than expected"
- Or: persistent-hold emails flooding your inbox
- Or: `/api/admin/strict-holds` → `persistently_held.length` > 5

### Detection
```bash
curl -s https://instaclaw.io/api/admin/strict-holds -H "x-admin-key: $ADMIN_API_KEY" | jq '.totals, .persistently_held'
```

If `total_hold_events_last_24h` is spiking relative to normal (~0 typical), we're over-blocking.

### Rollback action

**First choice (keep strict mode partially on):** shrink the allowlist.
1. In Vercel → env vars → edit `STRICT_RECONCILE_VM_IDS`. Remove the offending UUIDs.
2. Trigger a redeploy (push any commit, or use Vercel CLI `vercel --prod`).

**Second choice (fleet-wide off, instant):** flip DB kill switch.
```sql
UPDATE instaclaw_admin_settings
SET bool_value = false, updated_at = NOW(), updated_by = 'oncall-emergency'
WHERE setting_key = 'strict_mode_enabled';
```
Next reconcile-fleet cron cycle (≤3 min) will bypass strict mode entirely — all VMs advance config_version in legacy mode.

### Verification
- Next cron response: `strictHeld: 0`, `strictAllowlistSize: 0` (if env var cleared) or same size but 0 holds (if DB kill switch).
- No new per-VM hold emails.
- Existing `strict_hold_streak` values reset to 0 as VMs pass legacy reconcile.

### Expected downtime
None for users. Strict mode was a verification layer, not a serving layer. Worst case: broken config drift takes one more cycle to get caught, but next-cycle legacy reconcile marches on.

---

## Scenario B — Canary causes Anthropic rate-limit exhaustion

### Trigger
- Anthropic returns HTTP 429 on user traffic
- Logs show elevated `testProxyRoundTrip: non-200` with `status=429`
- User reports of "agent unresponsive" that correlate with cron fire times

### Detection
```bash
# Check recent canary errors in Vercel logs
vercel logs --scope=instaclaw --since=1h | grep "testProxyRoundTrip" | grep "429"

# Check anthropic rate-limit via admin-strict-holds
curl -s https://instaclaw.io/api/admin/strict-holds -H "x-admin-key: $ADMIN_API_KEY" \
  | jq '.persistently_held[] | select(.latestErrors[] | contains("429"))'
```

### Rollback action

**Only disable canary; keep config-set strict validation.** The DB flag is the fastest path here.
```sql
UPDATE instaclaw_admin_settings
SET bool_value = false, updated_at = NOW(), updated_by = 'oncall-rate-limit'
WHERE setting_key = 'canary_enabled';
```
Next cron cycle (≤3 min): reconcileVM still runs strict config-set validation, still gates `config_version` bumps on `strictErrors`, but skips the round-trip probe entirely.

### Verification
- Next cron response: `canariesSkippedBudget` may tick up (unrelated) but no new `strictErrors` starting with `"canary: "`.
- Anthropic rate-limit headers recover in minutes.
- Real user traffic unaffected.

### Expected downtime
None. Strict mode remains active in reduced-coverage mode (catches config-set rejections; misses runtime breakage until canary is re-enabled).

### Re-enabling after recovery
```sql
UPDATE instaclaw_admin_settings
SET bool_value = true, updated_at = NOW(), updated_by = 'oncall-recovered'
WHERE setting_key = 'canary_enabled';
```

---

## Scenario C — Bad migration

### Trigger
- `reconcile-fleet` cron returns 500 with PostgreSQL error mentioning `strict_hold_streak`, `instaclaw_strict_holds`, `instaclaw_strict_daily_stats`, or `instaclaw_admin_settings`
- Or: migration itself failed to apply cleanly in prod

### Detection
```bash
curl -s https://instaclaw.io/api/cron/process-pending -H "authorization: Bearer $CRON_SECRET"
# Look for 500, or "relation does not exist", or column-missing errors
```
Supabase dashboard → SQL editor → `\d instaclaw_strict_holds` to verify table exists with expected columns.

### Rollback action

**1. Revert the migration (Supabase doesn't support down-migrations; run inverse SQL):**
```sql
-- Drop everything Phase 2c added, in reverse order.
DROP TABLE IF EXISTS instaclaw_strict_daily_stats;
DROP TABLE IF EXISTS instaclaw_strict_holds;
DROP TABLE IF EXISTS instaclaw_admin_settings;
ALTER TABLE instaclaw_vms DROP COLUMN IF EXISTS strict_hold_streak;
```

**2. Revert the code commit:**
```bash
git revert <phase-2c-merge-sha>
git push origin main
```
Wait for Vercel deploy (~3-5 min).

### Verification
- `reconcile-fleet` response returns the pre-2c shape (no `strictHeld`, no `strict_hold_streak_max`).
- No 500s referencing Phase 2c tables.
- `/api/admin/strict-holds` returns 404 (route removed).

### Expected downtime
3-5 min of `reconcile-fleet` failures while the revert deploys. No user-facing impact — the cron is background infrastructure.

---

## Scenario D — Strict mode silently passes when it shouldn't

### Trigger
- Manifest bump introduces a known-bad config value.
- Expected: strict-mode VMs hold config_version.
- Actual: config_version advances on strict-mode VMs → bug is latent somewhere in the gate chain.

### Detection

Every Monday morning (pre-stage-3), run a manual probe against a canary VM to confirm strict mode is still catching:

```bash
# 1. Pick a VM in the allowlist.
export VM_ID=<strict-vm-uuid>

# 2. Inject a known-bad key into the VM manually.
ssh openclaw@$VM_IP
source ~/.nvm/nvm.sh
openclaw config set gateway.nonexistent.key 'fake' 2>&1
# Expected: schema rejection output

# 3. Run the strict reconcile via admin endpoint.
curl -X POST https://instaclaw.io/api/admin/reconcile-vm \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d "{\"vmId\": \"$VM_ID\", \"strict\": true, \"dryRun\": false}"

# 4. Inspect result.
# Expected: strictErrors non-empty, wouldAdvanceConfigVersion: false
```

If `wouldAdvanceConfigVersion: true` with a known-bad key present, the gate chain is broken.

### Rollback action

Not a rollback — an investigation:
1. Check `instaclaw_admin_settings.strict_mode_enabled` — is it `true`?
2. Check `instaclaw_admin_settings.canary_enabled` — is it `true`?
3. Check `STRICT_RECONCILE_VM_IDS` env var — does it include the test VM's UUID?
4. Check reconcile-fleet response — is the VM in the `strictAllowlistSize` count?
5. Check `reconcileVM` result shape — does `strictErrors` contain entries?

If all inputs look right and the gate still fails: **revert to the prior commit**. This is a correctness regression.

### Expected downtime
Investigation-dependent. Reverting the Phase 2c merge is always safe (Scenario C's action).

---

## Scenario E — x-strict-canary header leaks to user traffic

### Trigger
Someone (attacker, confused client, misconfigured SDK) starts sending `x-strict-canary: true` on regular gateway requests.

### What actually happens

Per the bypass logic at `app/api/gateway/proxy/route.ts` (check for header fires first; forces `isHeartbeat = false`):

- The request SKIPS heartbeat-cheap-path classification.
- It takes the user-chat path through Anthropic instead of the MiniMax heartbeat shortcut.
- Anthropic cost (haiku for short messages) applies rather than MiniMax's 0.2× weight.
- Request succeeds normally.

### Is this exploitable?

**No.** The bypass only flips classification FROM heartbeat (cheap) TO user-chat (expensive). It makes the caller's request more expensive, not cheaper. Attacker setting this header is self-foot-shooting.

What it does NOT do:
- Does not grant access to premium models.
- Does not bypass usage limits.
- Does not skip auth (gateway_token check runs before the header check).
- Does not skip the daily spend circuit breaker.
- Does not escalate privileges.

### Mitigation if desired

If we want to lock down the header to "internal callers only":
```typescript
// In app/api/gateway/proxy/route.ts, after the bypass detection:
if (strictCanaryBypass) {
  // Future hardening: reject x-strict-canary from clients other than our own
  // Vercel IP block or with a shared signing secret. Not needed today since
  // the bypass is non-privileged.
}
```

Not blocking. Document in phase-2c-v2-todo.md as low-priority hardening.

### Verification
Check Vercel logs for `proxy: strict canary bypass active` with `gatewayTokenPrefix` values you don't recognize. If you see high volume from a single prefix, that client is misconfigured — contact the user.

---

## Scenario F — Phase 2c breaks an unrelated flow

### Trigger
Post-deploy, something unrelated starts failing: /api/vm/configure, /api/cron/health-check, /api/vm/repair, etc.

### Detection
Vercel error rate spike on any `/api/*` route. Cross-correlate against the Phase 2c deploy timestamp.

### Rollback action

**Full revert is safe and fast:**
```bash
git log --oneline main -10   # find the Phase 2c merge SHA
git revert <phase-2c-merge-sha>
git push origin main
```

Wait ~3-5 min for Vercel to deploy the revert. The migration is backward-compatible (adding columns + tables doesn't break existing reads), so no DB rollback needed unless Scenario C is also hit.

### Verification
- Vercel error rate returns to baseline within 5 min.
- Broken flow recovers.
- Phase 2c features (admin/strict-holds, strict mode cron logic) become 404/no-op.

### Re-deploy after fix
Once the root cause is identified + fixed:
```bash
git revert <revert-sha>   # revert the revert
# OR: make the fix on a new branch, preview, merge
```

---

## Escalation contacts

- **Cooper** (primary) — coop@valtlabs.com
- **Supabase dashboard** — for SQL kill-switch flips
- **Vercel dashboard** — for env var changes + redeploys
- **GitHub repo** — github.com/coopergwrenn/clawlancer

## What NOT to do in any scenario

- **Do not `git reset --hard` main.** Always use `git revert` — preserves history.
- **Do not manually edit `instaclaw_strict_holds` rows.** Event log is append-only for a reason.
- **Do not disable the reconcile-fleet cron entirely** (in vercel.json). That stops ALL drift reconciliation, not just strict mode — worse than the problem.
- **Do not set `STRICT_RECONCILE_VM_IDS` to the full fleet as a rollout shortcut.** Always stage 1 → 2 → 3.
