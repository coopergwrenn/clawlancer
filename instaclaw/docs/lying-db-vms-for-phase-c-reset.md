# Lying-DB VMs flagged for Phase C cohort reset

**Created:** 2026-05-09 (gbrain Phase 1 canary terminal)
**Updated:** 2026-05-11 — added 4 stragglers from full fleet census + vm-512 emergency hand-fix
**Audience:** consensus terminal running Phase C compaction-VM cohort reset
**Purpose:** include these VMs in your reset sweep — same stuck-at-cv class as the compaction-VM cohort you're handling

## TL;DR

The 2026-05-11 full fleet census probed all 44 healthy cv≥88 VMs and found **12 lying-DB (27% rate)**. Of those 12:

- **8 are from the 2026-05-05 provisioning cohort** — likely already in your Phase C reset (vm-906, 907, 908, 910, 911, 912, 914, 916)
- **5 are stragglers from earlier cohorts** — NEW work for Phase C if not already in your sweep
- **0 unreachable** (clean probe)

Full census report: `instaclaw/docs/lying-db-census-2026-05-11.md`.

## VMs to include in Phase C reset

### Cohort already in consensus's sweep (likely)
2026-05-05 batch — confirm these are in your list:

| VM | IP | cv | tier | owner | Shape | Recommended reset cv |
|---|---|---|---|---|---|---|
| **vm-910** | 66.175.210.59 | 91 | pro | buggynear@gmail.com | TOTAL_LIE (TasksMax=75, no prctl, no drop-in) | **82** |
| **vm-914** | 173.255.230.77 | 91 | starter | johnnyl.tasks@gmail.com | TOTAL_LIE | **82** |
| **vm-907** | 45.33.88.52 | 91 | pro | syhranovianti@gmail.com | TOTAL_LIE | **82** |
| **vm-916** | 45.33.94.197 | 91 | power | reddit6692@gmail.com | TOTAL_LIE | **82** |
| **vm-912** | 173.255.227.194 | 91 | power | lawdalelo42@gmail.com | TOTAL_LIE | **82** |
| **vm-911** | 66.175.210.93 | 91 | power | afshinieyesi@gmail.com | PARTIAL_LIE_DROPIN (drop-in present, npm pkg missing) | **86** |
| **vm-908** | 173.255.237.80 | 91 | starter | gong74@gmail.com | PARTIAL_LIE_DROPIN | **86** |
| **vm-906** | 45.33.88.47 | 91 | starter | briammoreno312215@gmail.com | (cohort, please confirm in your set) | **86** |

### Stragglers (likely NEW work for Phase C)
NOT in the 2026-05-05 batch — verify these are in your sweep, otherwise add:

| VM | IP | cv | tier | owner | Created | Shape | Recommended reset cv |
|---|---|---|---|---|---|---|---|
| **vm-511** | 96.126.110.152 | 89 | starter | jotap6001@gmail.com | 2026-03-19 | TOTAL_LIE (TasksMax=75, no prctl, no drop-in) | **82** |
| **vm-905** | 172.104.24.133 | 91 | power | p8123117@gmail.com | 2026-05-03 | PARTIAL_LIE_DROPIN | **86** |
| **vm-512** | 96.126.110.86 | 89 | power | spillageissue@gmail.com | 2026-03-19 | PARTIAL_LIE_DROPIN — **hand-fixed 2026-05-11, see below** | **86** |
| **vm-895** | 198.74.59.177 | 88 | pro | launchanon01@gmail.com | 2026-04-30 | SCHEMA_ZERO_LIE (TasksMax=4666, no override.conf) | **82** |
| **vm-901** | 172.104.24.64 | 89 | starter | dkatzg@gmail.com | 2026-05-03 | SCHEMA_ZERO_LIE | **82** |

### Special case: vm-512 (emergency hand-fix done 2026-05-11)

vm-512 was caught in an **active customer outage** by the census:
- Gateway in systemd `failed` state for 1d 10h (since 2026-05-10 05:59 UTC)
- Failure cause: prctl-subreaper.conf drop-in references `NODE_OPTIONS=--require prctl-subreaper`, but the npm package is missing → every gateway start crashed with `Cannot find module 'prctl-subreaper'`
- Underlying cause: disk was 100% full (79G/79G, 0 avail) — that's why the original `npm install -g prctl-subreaper` failed silently when stepPrctlSubreaper ran
- ~/.openclaw at 59GB out of 79GB disk — load-bearing follow-up

**Emergency fix applied:**
1. Removed broken `prctl-subreaper.conf` drop-in → moved to `/tmp/prctl-subreaper.conf.removed.20260511T161734Z` on the VM
2. Freed ~5.4GB disk space (deleted `/var/log/syslog.{1,2,3,4}.gz`, vacuumed journal to 200M, removed rotated auth/ufw logs)
3. `systemctl --user reset-failed` + restart → gateway recovered at t=25s post-restart
4. Confirmed stable: `active`, `/health=200`, 5GB disk available

**vm-512 is now HEALTHY but still LYING-DB.** The cv=89 still claims prctl-subreaper is installed; it's not. Consensus's Phase C reset should still include vm-512 to properly reinstall via reconciler flow once disk is sufficient.

**Caveats for vm-512 specifically:**
- Disk is still 94% full (~/.openclaw at 59GB). Will fill again. Needs root-cause investigation OUTSIDE Phase C scope — possibly user data accumulation, OR a log/cache somewhere not cleaned up. Suggest separate ticket: "investigate vm-512 ~/.openclaw size 59GB on a 79GB disk."
- When Phase C resets cv on vm-512, reconciler will retry `npm install -g prctl-subreaper`. If disk is still tight at that time, the install MAY fail again unless the disk root-cause is addressed first.

## Verification post-reset

After your reset bumps these VMs back to pre-current cv, the reconciler will re-process them on its normal cycle. Re-run the census script to confirm all become honest:

```bash
cd /Users/cooperwrenn/wild-west-bots/instaclaw
npx tsx scripts/_lying-db-census.ts
# Expected post-reset: all VMs listed above should report ✓ honest
```

## Context

These were discovered during gbrain Phase 1 pre-flight (the 6-point check refuses to install gbrain on a VM with broken v86/v87 state). The 2026-05-09 initial sample found 3/16 lying-DB (~19%); the 2026-05-11 full census of 44 cv≥88 VMs found **12/44 (27%)**. Cooper elevated this to fleet-integrity priority — see `CLAUDE.md` P1-1 (rev 2026-05-09) for the full taxonomy of 3 distinct lying-DB shapes (TOTAL_LIE, PARTIAL_LIE_DROPIN, SCHEMA_ZERO_LIE) and the per-step Rule 10 audit that needs to happen before any Phase 4 gbrain fleet rollout.

## Coordination

If consensus terminal already has these in its cohort: ignore this file (low cost, no harm).
If consensus terminal's reset has DIFFERENT semantics than just `UPDATE config_version`: tell the gbrain terminal so we can coordinate.
If consensus terminal finds the reset doesn't fully heal a VM (e.g., vm-512 disk issue): flag back here so we can do separate per-VM work.

— gbrain Phase 1 canary terminal
