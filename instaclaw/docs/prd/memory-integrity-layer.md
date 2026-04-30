# PRD — Memory Integrity Layer

**Status:** Draft for review (no implementation)
**Owner:** Cooper
**Author:** Claude Opus 4.7 (1M context)
**Created:** 2026-04-30
**Branch target:** `prd-memory-integrity` (to be created)

---

## TL;DR

This PRD covers two intertwined fleet-wide reliability problems surfaced during the 2026-04-30 vm-729 (Textmaxmax) investigation, and specs an integrity layer to prevent recurrence.

**Problem 1 — Reconciler restarts mid-task.** Heavy users with long-running operations (Remotion compiles, multi-page browser scrapes, video transcoding, large data exports) get their gateways killed by the Vercel reconciler-fleet cron's `systemctl restart openclaw-gateway` calls during config-version catch-up. Each kill destroys 7-8+ subprocess descendants (chrome-headless, node, ffmpeg, etc.) and forces the agent to restart from scratch.

**Problem 2 — MEMORY.md is unbacked.** The canonical persistent agent memory file lives at exactly one path on disk with zero backups. Any wipe (agent error, file-truncate bug, disk corruption, rogue tool call, accidental `> MEMORY.md`) is permanent and unrecoverable.

The two problems intersect: a long-running task killed mid-write to MEMORY.md leaves the file in an indeterminate state, and there's no integrity check that detects or recovers from this.

This PRD specs four components — pre-restart backup hook, post-startup restore, continuous snapshot cron, in-flight task detection — that together make MEMORY.md durable across all known failure modes and make reconciler restarts safe for users with long tasks.

**Implementation is gated on Cooper sign-off on the architecture below.**

---

## 1. Empirical Findings (run today, 2026-04-30)

All findings are reproducible from `/tmp/memory-canary-and-paths.ts`, `/tmp/sigterm-source.ts`, `/tmp/memory-md-fleet-audit.ts`, `/tmp/vm-729-systemic-investigation.ts`.

### 1.1 Canary test — MEMORY.md survives gateway restart

```
pre-canary:    9 bytes (template-only, vm-729)
write canary:  246 bytes including token "PURPLE_GIRAFFE_LIGHTHOUSE_8472"
restart gateway:  systemctl --user restart openclaw-gateway
post-restart:  246 bytes, token intact (1 hit)
```

OpenClaw's bootstrap uses `writeFileIfMissing` (verified in source `cli-CTrBc6fw.js`):

```javascript
async function writeFileIfMissing(filePath, content, createdFiles) {
  if (await pathExists$3(filePath)) return;
  await fs$1.writeFile(filePath, content, "utf8");
}
```

**Conclusion:** OpenClaw does NOT wipe MEMORY.md. It creates an empty stub if missing, but never overwrites existing content.

### 1.2 SIGTERM source — reconciler, not OpenClaw

Three weeks of hypotheses about "stuck session timeouts" or "watchdog kill loops" all proved wrong. Empirical tracing:

```
vm-729 config_version: 69
manifest version:      72
fleet distribution:    149/202 still at v67 (74%)
                         37/202 at v69 (vm-729 here)
                          4/202 at v72 (caught up)
```

Vercel cron `reconcile-fleet` runs every 3 min. Picks up to 10 VMs at `config_version < manifest.version` ordered by oldest-first. For each: SSHs in, runs `auditVMConfig` + `reconcileVM`, calls `systemctl --user restart openclaw-gateway` after fixing drift. **vm-729 is in this queue every cycle until it advances to v72.**

The "stuck session" diagnostic OpenClaw emits is purely a log warning — verified in `diagnostic-DitKp9ni.js`:

```javascript
function logSessionStuck(params) {
  diagnosticLogger.warn(`stuck session: ...`);
  emitDiagnosticEvent({ type: "session.stuck", ... });
}
```

No `process.kill`, no `systemctl` call, no exit code 1. Pure telemetry.

### 1.3 Fleet MEMORY.md audit — most write, some don't

Audit on 30 most-active VMs:

```
empty/template (<50B):   1/30  (3%)   ← vm-729 (Textmaxmax)
small (50B-500B):        1/30
medium (500B-5KB):      26/30
large (>5KB):            2/30   ← vm-043 (21KB), vm-295 (8.7KB)
```

But many "medium" entries are bootstrap templates with the same byte count (1179B / 33 lines on 6 VMs; 961B / 28 lines on 8 VMs). **~14 VMs have template-only memory with no real agent edits.** Headline: ~3% empty, ~50% under-utilized, ~10% genuinely populated.

vm-395 (Caleb Stork) hasn't touched MEMORY.md since 2026-03-26 despite recent VM activity. The agent stopped writing memory over a month ago.

### 1.4 No backups exist anywhere

```
find / -name 'MEMORY.md*' (excluding node_modules/dist):
  /home/openclaw/.openclaw/workspace/MEMORY.md  ← single instance
```

Zero versioned snapshots. Zero rollback path. The file is one disk corruption or bad tool call away from total loss.

---

## 2. Why the existing layers don't cover this

| Layer | What it does | Why it doesn't help here |
|---|---|---|
| systemd `Restart=always` | Restarts gateway on crash | Doesn't preserve workspace state; only restarts the process |
| systemd `KillMode=mixed` | SIGTERM main + SIGKILL children | Actively destroys long-running subprocesses |
| OpenClaw `writeFileIfMissing` | Avoids overwriting existing MEMORY.md | Doesn't recover if file becomes empty |
| Reconciler `stepWorkspaceIntegrity` | Ensures MEMORY.md exists | Creates an EMPTY one if missing — doesn't restore content |
| Reconciler `stepBackup` | Pre-audit workspace backup (line 147 vm-reconcile.ts) | Single backup overwritten on each reconcile pass; no rotation |

The `stepBackup` is the closest existing mechanism but it's:
- Single-slot (no history)
- Triggered by reconciler only (not on every restart)
- Stored in workspace (could be wiped same way)
- Never auto-restored

---

## 3. Proposed Architecture

Four components, layered defense-in-depth:

### 3.1 Component A — Pre-restart backup hook

Add to `openclaw-gateway.service` drop-in:

```ini
[Service]
ExecStopPost=/bin/bash -c '/home/openclaw/scripts/snapshot-workspace.sh pre-stop'
```

`snapshot-workspace.sh` writes a timestamped tar of `~/.openclaw/workspace/*.md` to `~/.openclaw/snapshots/`. Runs after every gateway stop (clean OR signaled). Fast (<1s for typical 50KB workspace).

Captures: SOUL.md, USER.md, MEMORY.md, AGENTS.md, IDENTITY.md, TOOLS.md, EARN.md, CAPABILITIES.md, plus `memory/` directory contents.

Retention: keep last 24 snapshots (rolling 24h × hourly avg = ~24 typical reconciler restarts).

**Risk:** if pre-stop hook itself fails, no snapshot written — but that's no worse than today.

### 3.2 Component B — Post-startup auto-restore

Add to gateway service drop-in:

```ini
[Service]
ExecStartPre=/bin/bash -c '/home/openclaw/scripts/restore-workspace.sh check'
```

Logic in `restore-workspace.sh`:
1. Read current `MEMORY.md`. If size > 100 bytes AND not template-only, return — file is healthy.
2. Else find newest snapshot in `~/.openclaw/snapshots/` (mtime).
3. If newest snapshot's MEMORY.md > 100 bytes AND not template-only, **restore it** (with original `# Memory` header preserved if user-edited beyond template).
4. Log restoration event to `~/.openclaw/snapshots/restore.log` so we can detect this happening fleet-wide.

**Critical safety:** never restore over an EDITED file. Only restore when current is empty/template. This means an agent that intentionally cleared MEMORY.md (rare) won't get force-restored.

### 3.3 Component C — Continuous snapshot cron

Add to manifest cron jobs:

```typescript
{
  schedule: "*/15 * * * *",  // every 15 min
  command: "bash ~/.openclaw/scripts/snapshot-workspace.sh continuous",
  marker: "snapshot-workspace.sh continuous",
}
```

Same script, different invocation: append a snapshot without stopping the gateway. Provides recovery point even if a long uptime period accumulates content that was never restart-snapshotted.

Storage cost: 50KB workspace × 4/hr × 24h = ~5MB/day per VM. 7-day retention = 35MB. Trivial.

### 3.4 Component D — In-flight task detection (defers reconciler restart)

This is the harder one. Goal: if the gateway has an in-flight long-running task, the reconciler should DEFER its restart until idle.

Two approaches considered:

**(D1) Health-endpoint marker.** Agent's gateway exposes `/health/restart-safe` returning `200` when idle, `503` when in long task. Reconciler's `restartGateway` step checks this before issuing `systemctl restart`. If `503`, reconciler logs and tries again next cycle.

**(D2) Process inspection.** Reconciler greps for known long-task signatures (`remotion`, `chrome-headless` with persistent argv, ffmpeg with long input) before restart. If any found and recently-started (<10min), skip restart.

Recommendation: **(D1)** because it's deterministic and OpenClaw owns the readiness signal. We'd need to either patch OpenClaw to expose this OR write our own sidecar endpoint that introspects active sessions.

**Caveat:** if (D1) requires OpenClaw upstream changes, it may take weeks. Short-term: (D2) as a heuristic, expand to (D1) when feasible.

---

## 4. Implementation plan

### Phase 0 — Verify the canary doesn't expand to a fleet-wide problem

Run the canary test on 5 VMs of varying sizes/activity. Confirm none of them wipe MEMORY.md across multiple restart cycles. (Today's vm-729 test was n=1.)

### Phase 1 — Snapshot infrastructure (Components A+C)

1. Write `~/.openclaw/scripts/snapshot-workspace.sh` (~30 lines bash). Two modes: `pre-stop` (single snapshot, replaces oldest if >24 exist) and `continuous` (timestamped, keep 7 days).
2. Add to manifest `cronJobs` array.
3. Add `ExecStopPost` to gateway service drop-in via `lib/vm-reconcile.ts:stepSystemdUnit`.
4. Bump manifest version (e.g., v73).
5. Reconciler propagates over normal cycle.

Each snapshot is `~/.openclaw/snapshots/YYYY-MM-DDTHH:MM:SSZ.tar.gz` containing:
```
workspace/SOUL.md
workspace/MEMORY.md
workspace/USER.md
workspace/IDENTITY.md
workspace/AGENTS.md
workspace/TOOLS.md
workspace/EARN.md
workspace/CAPABILITIES.md
workspace/memory/
```

### Phase 2 — Auto-restore (Component B)

1. Write `restore-workspace.sh` (~50 lines bash with safety guards).
2. Add `ExecStartPre` to gateway service drop-in.
3. Manual canary on vm-729: blank MEMORY.md, restart gateway, verify restoration kicks in.
4. Soak 24h on vm-729 watching for false-positive restorations (agent-cleared content getting force-restored).
5. Roll out fleet-wide via manifest bump.

### Phase 3 — Restart deferral (Component D2 first, D1 later)

1. Patch `lib/vm-reconcile.ts` `restartGateway` to first SSH-check for long-running subprocess signatures.
2. If found and the subprocess is younger than its likely completion window (heuristic per signature), log and skip the restart this cycle.
3. Reconciler's existing "errors block bump" path: this is a soft-skip, not an error.
4. Iterate on signature list as we observe more failure cases.

D1 (health-endpoint marker) tracked separately as a longer-term OpenClaw upstream contribution.

### Phase 4 — Observability

Add HQ dashboard tile (`/hq/memory-health` already exists per codebase grep) that shows:
- Per-VM current MEMORY.md size
- Per-VM last snapshot timestamp
- Fleet-wide template-only-MEMORY.md count
- Restore events from `restore.log` aggregated

Surfaces the underlying "agents not writing memory" problem (separate from this PRD's scope but adjacent).

---

## 5. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Pre-stop hook fails → no snapshot for that cycle | No worse than today; continuous cron fills the gap |
| Restore logic mistakes user-cleared MEMORY.md for "empty" | Restore ONLY runs when size <100B AND no non-template content; agent intentionally clearing > 100B keeps gets respected |
| Snapshot tar grows unbounded if cron fails to prune | Add nightly prune cron (similar to v71's backup-prune); keep size bounded |
| Disk fill from snapshots | 7-day rolling × 4/hr × 50KB = 35MB ceiling per VM. Trivial vs 80GB disk. Plus prune step. |
| Restart deferral causes config drift to persist | Drift waits 1 reconcile cycle (3 min), no significant exposure |
| Restart deferral hides real reconciler errors | `errors` array still populated; only the restart action is deferred |
| Heuristic in (D2) catches a non-task subprocess | False-positives just delay restart by 3 min — annoying not dangerous |

---

## 6. Out of scope

- **Why agents aren't writing MEMORY.md.** Separate concern (SOUL.md instructions, agent training, prompt design). This PRD focuses on durability of whatever they DO write.
- **Why heavy users have so many subprocesses.** They're using the agent for real work. Not a bug.
- **Cross-VM memory portability.** If a user moves to a new VM, restoring their memory there. Out of scope; future work.
- **Encrypted snapshots.** MEMORY.md may contain user PII. For now snapshots are plain on the same VM (same threat model as the live file). Rotation reduces blast radius.

---

## 7. Open questions

1. **What if `ExecStopPost` blocks systemd's stop sequence?** Need to test. If it adds 1-3s to stop, that's fine. If it adds 30s+, it'll hit `TimeoutStopSec=30` and the snapshot will be skipped.
2. **Should snapshots include `~/.openclaw/agents/main/sessions/`?** Sessions can be large (some are 100KB+ each). Full session backup is more expensive and rarely useful — agents can recover from MEMORY.md without prior session jsonl. Recommend NO unless user explicitly asks.
3. **Restoration triggers a write — does the agent see the restore on next session start?** Yes, OpenClaw's bootstrap-cache (`bootstrap-cache-BNTty1Eq.js`) reloads files on session start; restored content propagates immediately.
4. **Should the snapshot/restore script be agent-callable?** Probably yes — `~/.openclaw/scripts/snapshot-workspace.sh manual` for the agent to use as part of major workspace edits.
5. **Per-VM opt-out?** Some users may prefer no snapshots (privacy). Need a flag (e.g., `discovery.memorySnapshots.enabled` in openclaw config). Default ON.

---

## 8. Decisions needed from Cooper before implementation

1. Approve the 4-component architecture as drafted, OR amend
2. Approve manifest bump to v73 to deploy Phase 1
3. Approve canary on vm-729 specifically for Phase 2 testing (it's the worst-case VM)
4. Confirm 7-day snapshot retention (or pick a different number)
5. Confirm "restore only when current is template-empty" safety guard
6. Phase 3 D2 (heuristic) ship now vs. wait for D1 (OpenClaw upstream)?
7. OK with HQ dashboard adds in Phase 4?

---

## Appendix A — Cost model

**Snapshot storage per VM, 7-day retention:**
- Workspace size: ~50KB typical, up to 1MB for power users
- Snapshots per day: 4/hr (continuous) + ~10/day (restart-triggered) = 106/day
- 7-day storage: 50KB × 106 × 7 ≈ 35MB ceiling
- 200 VMs × 35MB = 7GB fleet-wide aggregate (irrelevant — local to each VM)

**Snapshot CPU cost:**
- tar of 8 markdown files + memory/ dir = <100ms typical
- 4/hr cron = 0.4 sec CPU/hr per VM = negligible

**Reconciler complexity from D2 (heuristic restart deferral):**
- Adds 1 SSH command per VM per pass: `ps -ef | grep -E "remotion|chrome-headless|ffmpeg-long-input" | head -3`
- ~50ms overhead per VM
- 10 VMs/cycle × 50ms = 500ms additional reconcile time. Trivial.

## Appendix B — Sources / scripts

- `/tmp/memory-canary-and-paths.ts` — canary test + source dive
- `/tmp/sigterm-source.ts` — systemd unit + lifecycle investigation
- `/tmp/memory-md-fleet-audit.ts` — 30-VM MEMORY.md size audit
- `/tmp/vm-729-systemic-investigation.ts` — full vm-729 RCA
- OpenClaw source: `~/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/cli-CTrBc6fw.js` (writeFileIfMissing), `diagnostic-DitKp9ni.js` (logSessionStuck), `bootstrap-cache-BNTty1Eq.js` (session-level cache)
- Existing related code: `lib/vm-reconcile.ts:stepBackup` (single-slot pre-audit backup), `app/api/vm/sync-memory/route.ts` (manual sync endpoint), `app/api/hq/memory-health/route.ts` + `app/(hq)/hq/memory-health/page.tsx` (existing dashboard)
