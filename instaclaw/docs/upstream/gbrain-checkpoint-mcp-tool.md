# Upstream Issue Draft: Add `checkpoint` MCP admin tool to gbrain

**Target repo:** `github.com/garrytan/gbrain` (also affects `electric-sql/pglite` indirectly)
**Filing window:** Post Edge Esmeralda 2026 (May 23-26). Don't file during the event — don't want to depend on upstream merge during a customer-facing window.
**Severity:** P0 reliability — proven to produce unrecoverable data dirs on long-running sidecars.
**Reporter context:** instaclaw.io edge_city deployment, 8+ production VMs running gbrain v0.35.0.0 as HTTP sidecar per CLAUDE.md Rule 35.

---

## Title

`gbrain serve --http`: long-running sidecar accumulates pg_control staleness; SIGKILL produces unrecoverable data dir without external `pg_resetwal`

## Summary

PGLite v0.4.3 (used by gbrain 0.35.0.0) does not autocheckpoint on a wall-clock timer the way vanilla PostgreSQL does (default `checkpoint_timeout=5min`). During normal sidecar operation, the on-disk `pg_control` desynchronizes from the WAL: the WAL advances and gets recycled while pg_control still records an old checkpoint LSN.

When the sidecar dies (SIGKILL, OOM, kernel panic, host reboot), the next cold-start reads pg_control, attempts to read the recorded checkpoint record, finds the WAL bytes at that location have been recycled, and panics with:

```
NOTICE:  database system was shut down at <ancient timestamp>
LOG:    invalid resource manager ID in checkpoint record
PANIC:  could not locate a valid checkpoint record at 0/<old-LSN>
Aborted()
```

The data dir is unrecoverable to PGLite alone. Recovery requires running PostgreSQL 17's `pg_resetwal -f` on the data dir (an external tool not bundled with PGLite or gbrain), which loses any committed transactions that lived only in WAL.

Since gbrain's MCP surface does not currently expose a CHECKPOINT mechanism, operators have no in-band way to prevent this drift. The `query` MCP tool is for semantic search (rejects SQL passthrough), and the gbrain CLI cannot run while the sidecar holds the PGLite file lock.

## Reproducer

Tested on Ubuntu 24.04 LTS, Linode g6-dedicated-2 VMs, gbrain 0.35.0.0 (commit `baf1a47`), bun 1.3.13, Node 22.22.2.

1. Install gbrain via the documented HTTP sidecar setup. `gbrain.service` becomes active.
2. Run the sidecar for **at least 24-48 hours** with normal write activity (put_page, embeddings, etc.). Do NOT issue any explicit `CHECKPOINT` during this window. **The bug is duration-dependent, not volume-dependent — see "Why we can't reproduce on a short-lived test" below.**
3. Confirm pg_control on disk has gone stale: `pg_controldata <data-dir> | head -10` — the `pg_control last modified` timestamp should be hours/days old despite continuous WAL activity.
4. SIGKILL the sidecar (`systemctl --user stop gbrain` with `KillSignal=SIGKILL`, or `pkill -KILL -f 'gbrain.*serve'`).
5. Try to restart: `systemctl --user start gbrain.service`.
6. Observe restart crash-loop. Journal shows the WASM Aborted() error above.
7. Re-inspect pg_controldata — the `pg_control last modified` timestamp is the LAST successful CHECKPOINT (often the install timestamp), NOT the recent SIGKILL.

## Forensic evidence from production incident

On 2026-05-18 we hit this exact failure on vm-050 (an edge_city test agent). Timeline (all UTC):

- 2026-05-16 15:46:59 — `install-gbrain.sh` wipe+reinit completed; pg_control written by the fresh init.
- 2026-05-16 → 2026-05-18 — sidecar ran continuously for ~48 hours. Light write activity from a single user agent. **pg_control mtime stayed at 15:46:59 the entire window — never updated despite continuous WAL writes.**
- 2026-05-18 16:09 — last WAL write (mtime of `pg_wal/000000010000000000000001`).
- 2026-05-18 16:11 — controlled stop. systemd `KillSignal=SIGKILL` (per CLAUDE.md Rule 54 the standard graceful-stop signal for PGLite).
- 2026-05-18 16:11+ — restart attempts. Each one hit:
  ```
  PGLite failed to initialize its WASM runtime.
    This is most commonly the macOS 26.3 WASM bug: https://github.com/garrytan/gbrain/issues/223
    Run `gbrain doctor` for a full diagnosis.
    Original error: Aborted(). Build with -sASSERTIONS for more info.
  ```
  (False suggestion — this VM is Linux x86_64, not macOS.)
- 2026-05-18 16:14 — also attempted rollback to gbrain 0.35.0.0 from a (partial) v0.35.8.0 upgrade. Same Aborted() — confirms the bug is in PGLite's WAL-recovery path, not gbrain version-specific.
- 2026-05-18 16:57 — `pg_controldata` confirmed the diagnosis:
  ```
  Database cluster state:               shut down
  pg_control last modified:             Sat 16 May 2026 03:46:59 PM UTC
  Latest checkpoint location:           0/1714150
  Latest checkpoint's REDO WAL file:    000000010000000000000001
  ```
  WAL at LSN 0/1714150 had been recycled (zeroed) by the running sidecar's normal WAL turnover, while pg_control still pointed there.
- 2026-05-18 18:04 — recovered via `pg_resetwal -f`. New checkpoint at LSN 0/2000028, fresh WAL segment `...02`. PGLite then opened the data dir successfully.

Data loss after `pg_resetwal`: the WAL bytes between the last successful CHECKPOINT (May 16 install time) and the SIGKILL (May 18 16:11) are discarded. On vm-050 specifically this meant ~2 days of write-WINDOW but the actual measured loss was minimal — the brain was a sparsely-populated test agent. Post-recovery: 1 row preserved in `pages`, 0 in `facts`, 0 in `takes`, 0 in `raw_data`, etc. Most of the lost WAL was either not-yet-flushed background activity or test probes. **For a production VM with active write traffic, the loss window equals the time between the last on-disk pg_control update and the SIGKILL — which, given PGLite's apparent lack of autocheckpoint, can be the full sidecar uptime.**

## Why we can't reproduce on a short-lived test

We confirmed this is a duration-dependent failure. Earlier in our forensics we ran:

```
Test 4: Fresh PGLite, single insert, no explicit CHECKPOINT, SIGKILL → reopen succeeds.
Test 5: 500 inserts no CHECKPOINT, SIGKILL → reopen succeeds.
Test 6: 177,354 inserts in 60s no CHECKPOINT, SIGKILL → reopen succeeds.
```

All of these recovered cleanly. The vm-050 production failure required ~2 days of continuous operation. We believe the failure mode requires:
(a) WAL segment recycling (which only happens after enough data has been written to cycle through multiple 16 MB segments), AND
(b) the on-disk pg_control still pointing into a recycled-and-zeroed segment.

Both conditions take significant uptime to converge. Short tests don't hit them.

## Proposed fix (option A): add an MCP admin tool to gbrain

Add a `checkpoint` Operation to gbrain's tool surface. Since gbrain v0.35.0.0 uses an `Operation[]` registry (in `src/core/operations.ts`) that's exposed automatically via `buildToolDefs(ops)` to the MCP layer, the integration is minimal: add a new Operation, register it in the array. Implementation sketch (matches the patch we're running in production at `instaclaw/scripts/gbrain-patches/0001-add-checkpoint-mcp-tool.patch`):

```typescript
// src/core/checkpoint-operation.ts (new file)
import type { Operation } from './operations.ts';

export const checkpoint: Operation = {
  name: 'checkpoint',
  description:
    'Force a PGLite CHECKPOINT — flushes dirty buffers and pg_control to disk. ' +
    'Use periodically (every 30 min recommended) on long-running sidecars to ' +
    'prevent pg_control/WAL desynchronization. Required for safe SIGKILL recovery.',
  params: {},
  scope: 'admin',         // synchronous I/O burst; admin-only
  mutating: true,         // pg_control + flushed buffers; conservative truth
  handler: async (ctx) => {
    const t0 = Date.now();
    await ctx.engine.executeRaw('CHECKPOINT');
    const latency_ms = Date.now() - t0;
    ctx.logger.info?.('checkpoint completed', { latency_ms });
    return { ok: true, latency_ms };
  },
  cliHints: { name: 'checkpoint', hidden: true },
};
```

Then in `src/core/operations.ts` add `import { checkpoint } from './checkpoint-operation.ts';` at the top and `checkpoint,` to the `operations: Operation[]` array (in the "Admin" section). Total diff: ~62 lines (57 in the new file, 5 in operations.ts).

The integration uses gbrain's existing Operation interface (no new MCP plumbing needed) — `buildToolDefs(operations)` in `src/mcp/tool-defs.ts` discovers it automatically. Scope `'admin'` is enforced by gbrain's existing scope checker in `src/core/scope.ts`.

External callers (cron, ExecStop hook) then invoke:

```bash
curl -sS -X POST http://127.0.0.1:3131/mcp \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json,text/event-stream" \
  --max-time 60 \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"checkpoint","arguments":{}}}'
```

Roughly 30 LOC change. Tests should cover (a) tool registration, (b) admin scope gating, (c) pg_control mtime update verification.

## Proposed fix (option B): fix PGLite's autocheckpoint

The deeper fix is in `electric-sql/pglite` itself: investigate why the `checkpoint_timeout` background worker (which vanilla Postgres runs every 5 minutes by default) doesn't fire in PGLite. Possible causes:

- The autocheckpoint background worker may have been intentionally omitted to keep the WASM runtime small.
- The worker may be present but the WASM execution model (single-tasked, no async timer loop) prevents it from firing during normal serve activity.
- Some other PGLite-specific config that disables it.

Whatever the cause, restoring autocheckpoint at the PGLite layer would resolve every downstream gbrain-style consumer simultaneously without each one needing an in-band CHECKPOINT call.

Cost: likely more invasive than option A. We propose option A as the practical immediate fix; option B as the durable architectural fix. We have not investigated PGLite source to confirm the root cause; that investigation is part of filing option B.

## Risk if not fixed

Every long-running gbrain sidecar in production is a latent vm-050:

- An OOM kill, host reboot, kernel update, manifest-driven systemd restart, or any other non-graceful termination can render the data dir unrecoverable to PGLite alone.
- Recovery requires installing PostgreSQL 17 and running `pg_resetwal -f` — an out-of-band procedure that operators must remember.
- Data loss on recovery: any committed-but-not-flushed-to-heap transactions disappear. The window grows with uptime.

For a single-user agent platform like instaclaw.io, this means per-customer memory loss in the worst case. Detected by accident in our case — the underlying agent was a test VM with minimal user memory. A real customer would have lost meaningful data.

## Mitigation in place (instaclaw side)

While this issue is open, we've shipped:

1. **Patch + cron + ExecStop hook** (2026-05-18 PM): the `0001-add-checkpoint-mcp-tool.patch` file is applied via `install-gbrain.sh` Phase C2 on top of garry's unmodified gbrain release. A 30-min cron and a systemd ExecStop hook (`install-gbrain.sh` Phase I) call the new `checkpoint` MCP tool to bound pg_control staleness. **The patch file itself is the implementation sketch above, ready for extraction into an upstream PR.**
2. **Recovery procedure documented** in CLAUDE.md Rule 54: `pg_resetwal -f` on an experimental copy, validate with PGLite, promote to live, restart sidecar.
3. **Defensive install-gbrain.sh fix**: Phase A idempotency now validates bearer match across openclaw.json and disk file (vm-050 had a parallel bearer-mismatch issue that masked the pg_control symptom for 2.5 days; see Rule 58).
4. **Reasoning trail**: pg_controldata output, WAL inspection, and forensic logs preserved at `~/.gbrain/brain.pglite.unrecoverable-20260518T181251Z` on vm-050.

## Cross-reference

- CLAUDE.md Rule 54 (full version): the in-house operational rule, includes the 2026-05-16 SIGTERM bug AND the 2026-05-18 SIGKILL/pg_control bug.
- CLAUDE.md Rule 58: parallel discovery — token-mismatch idempotency gap also in install-gbrain.sh, also exposed by the vm-050 incident.
- instaclaw `~/.gbrain/brain.pglite.unrecoverable-20260518T181251Z` (preserved on vm-050): the actual corrupted data dir, available for reproducer extraction.

---

**Author note:** when filing, decide whether to file this against `garrytan/gbrain` (issue + PR for the MCP tool) or `electric-sql/pglite` (issue + PR for the autocheckpoint fix). Filing both with cross-references is probably right. Garry's repo is the faster merge; PGLite's is the deeper fix.

**Pre-file checklist (when this gets filed):**
- [ ] Verify the failure still reproduces on the current gbrain HEAD (we tested 0.35.0.0; if 0.35.9.x+ has already fixed it, no issue needed)
- [ ] Verify the failure still reproduces on PGLite v0.4.3 (current bundled version) — if PGLite has bumped a minor with an autocheckpoint patch, file against gbrain only
- [ ] Strip any production-specific identifiers (vm-050 → "Agent A", customer email if any, etc.) — public GitHub issue, treat as visible to all
- [ ] Confirm the BROKEN reference dir is still archived for reproducer extraction
