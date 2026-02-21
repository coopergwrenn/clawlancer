# InstaClaw — Project Notes

## Quick Commands

- **"spots N"** — Run `./instaclaw/scripts/open-spots.sh N` to provision N new VMs and open spots for users. Example: "spots 3" opens 3 spots. Run from the repo root.

## Project Structure

- `instaclaw/` — Next.js app (instaclaw.io)
- `instaclaw/scripts/open-spots.sh` — Self-contained VM provisioning script (reads creds from .env.local, talks to Hetzner + Supabase directly)

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
