# Lying-DB VMs flagged for Phase C cohort reset

**Created:** 2026-05-09 (gbrain Phase 1 canary terminal)
**Audience:** consensus terminal running Phase C compaction-VM cohort reset
**Purpose:** include these 3 VMs in your reset sweep — they're in the same stuck-at-cv-91 class as the 20 compaction VMs you're handling

## TL;DR

Three VMs at `cv >= 88` in the DB are LYING-DB — the cv claims a state that's not actually on disk. They're stuck at cv = current-manifest because the reconciler thinks they're up-to-date and skips them. Same class of bug as the compaction-keys cohort consensus is fixing right now: cv is high, on-disk reality is low, reconciler's `lt(config_version, N)` filter excludes them forever.

If your Phase C reset is doing `UPDATE instaclaw_vms SET config_version = <some-pre-bug version> WHERE name IN (...)`, please add these three names to the IN clause.

## The 3 VMs

| VM name | IP | DB cv | tier | owner | Lying about | Recommended cv reset |
|---|---|---|---|---|---|---|
| **instaclaw-vm-907** | 45.33.88.52 | 91 | pro | syhranovianti@gmail.com | TasksMax (still 75, manifest wants 120 since v86); prctl-subreaper package + drop-in BOTH missing (v87) | **82** (force replay of v83-v91) |
| **instaclaw-vm-512** | 96.126.110.86 | 89 | power | spillageissue@gmail.com | TasksMax OK (120 ✓). prctl-subreaper drop-in PRESENT but npm package MISSING. Partial v87 install. | **86** (force replay of v87+) |
| **instaclaw-vm-904** | 172.104.24.104 | 91 | power | thakurnikhilsingh837@gmail.com | TasksMax OK. Same partial v87 shape as vm-512 — drop-in present, npm package missing. | **86** (force replay of v87+) |

## Verification post-reset

After your reset bumps these VMs back to a pre-current cv, the reconciler will re-process them on its normal cycle. To confirm the fix landed:

```bash
# Per-VM SSH probe (run from the gbrain Phase 1 terminal's pre-flight pattern)
ssh openclaw@<ip> '
  source ~/.nvm/nvm.sh
  echo "tasks_max:$(systemctl --user show -p TasksMax --value openclaw-gateway)"
  echo "prctl:$(npm ls -g --depth=0 prctl-subreaper 2>/dev/null | grep prctl-subreaper)"
  echo "dropin:$(test -f $HOME/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf && echo PRESENT || echo MISSING)"
'
# Expected after reconciler runs:
#   tasks_max=120
#   prctl=prctl-subreaper@0.1.0 (or 0.1.1)
#   dropin=PRESENT
```

OR re-run the gbrain terminal's check script after Phase C completes:

```bash
cd /Users/cooperwrenn/wild-west-bots/instaclaw
npx tsx scripts/_check-lying-db-spread.ts
# vm-907, vm-512, vm-904 should now report ✓ honest
```

## Context (one-paragraph)

These were discovered during gbrain Phase 1 pre-flight (the 6-point check that refuses to install gbrain on a VM with broken v86/v87 state). Sampled 16 random cv≥88 VMs; found 3 lying-DB (~19% rate). Cooper elevated this to fleet-integrity priority — see `CLAUDE.md` P1-1 (rev 2026-05-09) for the full taxonomy of 3 distinct lying-DB shapes ("total lie", "partial lie drop-in only", "schema-zero lie") and the per-step Rule 10 audit that needs to happen before any Phase 4 fleet rollout.

## Coordination

If consensus terminal already has these in its cohort: ignore this file (low cost, no harm).
If consensus terminal's reset has DIFFERENT semantics than just `UPDATE config_version`: tell the gbrain terminal so we can coordinate (the gbrain Phase 1 terminal will check this file after its 48h soaks complete).

— gbrain Phase 1 canary terminal
