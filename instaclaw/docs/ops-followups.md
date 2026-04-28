# Ops Notes — follow-ups not blocking the current ship

## 2026-04-28 — Suspended VMs are getting their gateway service restart-looped

**Surfaced by:** vm-729 (45.33.76.93) failing `gw.health_responds` in the v64 pre-bake fleet audit. Re-probe ~1 min later passed. Triage showed the failure was transient — gateway happened to be in its `start-pre` window when the audit hit.

**The shape:** vm-729 is **suspended** (`suspended_at = 2026-04-11`, `assigned_user_id = null`, `last_assigned_to = null`) — it has no user, no agent traffic, no business reason for the gateway to be running at all. Yet `journalctl --user -u openclaw-gateway` shows a clean **~11.5-minute stop/start cycle** going back hours:

```
18:55:03 Started → 18:55:12 ready    (~11min healthy)
19:06:30 Stopping (SIGTERM) → 19:06:31 Started → 19:06:40 ready
19:18:01 Stopping → 19:18:03 Started → 19:18:12 ready
19:29:30 Stopping → ...               ← my SSH probe landed here
```

Pattern is `systemd[675]: Stopping ...` followed by `Starting ...` — **external `systemctl` invocations**, not crash-restarts, not unit-file `Restart=` triggered. Something is calling `systemctl --user stop openclaw-gateway && systemctl --user start openclaw-gateway` on a loop. On a *suspended* VM that should be quiescent.

**Why it's not the heal-suspended fix shipped today (`9f3aff5`):** that commit fixed *heal steps*. The restart loop runs every ~11.5 min, which doesn't match any heal cadence. Likelier candidates:

- A watchdog cron (`vm-watchdog.py`, `silence-watchdog.py`) that kicks the gateway when probes fail and isn't gating on `suspended_at`
- One of the new heal scripts (`_heal-fleet-gaps.ts`, `_audit_remote.sh`) running on a loop somewhere and calling restart
- A reconciler code path that drift-corrects suspended VMs as if they were active
- Some upstream watchdog at the systemd `override.conf` level (this VM has a Drop-In at `~/.config/systemd/user/openclaw-gateway.service.d/override.conf` worth inspecting)

**Why it matters even though vm-729 is suspended:**

1. **Audit false positives** — any audit run during the start-pre window will red-flag the VM and force re-probes. Annoying for ops; could mask real failures if it normalizes "vm-729 is always flaky, ignore it."
2. **Wasted CPU + Linode cost** — the gateway is fully launching (43s CPU per cycle, ~628MB peak RSS per the journal), then being killed. ~125 cycles per day on a $29/mo dedicated VM that has no user.
3. **Class of bug** — if this hits one suspended VM it likely hits others. Probably more visible after running the next fleet audit with timing-aware probes.

**Investigation steps when picked up:**

1. `cat ~/.config/systemd/user/openclaw-gateway.service.d/override.conf` on vm-729 — see if Drop-In is doing anything weird
2. `systemctl --user list-timers` on vm-729 — any timers that match an 11.5min cadence?
3. `crontab -l` on vm-729 — anything restarting the gateway?
4. Grep the codebase for `systemctl.*restart.*openclaw-gateway` and check whether each call gates on `suspended_at IS NULL`
5. Check Vercel cron logs for any heal/reconcile job that ran around the SIGTERM timestamps (every ~11.5 min from 18:55 onwards on 2026-04-28)

**Other suspended VMs to check before fixing:** Once a code path is suspected, run `select id, name, ip_address, suspended_at from instaclaw_vms where suspended_at is not null` and SSH-spot-check 3-5 of them for the same restart pattern. If the symptom is fleet-wide on suspended VMs, that's confirmation.

**Severity:** medium — not a customer impact (suspended VMs have no users), but wastes resources and adds audit noise. Not blocking v64 bake.

**Files of interest:**
- `instaclaw/scripts/_full-configureOpenClaw-audit.ts` — audit script (consider adding retry-on-start-pre logic to its `gw.health_responds` probe so transient windows don't show as red)
- `instaclaw/scripts/_audit_remote.sh` — remote probe script
- `instaclaw/scripts/_heal-fleet-gaps.ts` — recently added; check its `suspended_at` gating
- `lib/ssh.ts` — central place restarts may originate from
