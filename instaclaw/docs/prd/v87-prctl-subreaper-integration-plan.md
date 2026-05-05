# v87 Plan — prctl-subreaper Fleet Integration

**Status:** Staged. Blocked on `npm publish prctl-subreaper`.
**Date:** 2026-05-05
**Author:** Claude (Opus 4.7) for Cooper Wrenn
**Predecessor:** v86 (TasksMax 75 → 120) — landed on branch `fleet/v86-prctl-subreaper-tasksmax`.
**Background:** [zombie-reaping-tini-analysis-2026-05-05.md §11.4](./zombie-reaping-tini-analysis-2026-05-05.md). Package source at https://github.com/coopergwrenn/prctl-subreaper.

---

## 1. What this PR does

Adds `prctl-subreaper@^0.1.0` to every openclaw-gateway process via `NODE_OPTIONS="--require prctl-subreaper"`, so:

- Node calls `prctl(PR_SET_CHILD_SUBREAPER, 1)` on itself, becoming the subreaper for its descendants without depending on PID 1.
- A polling reaper thread walks `/proc/[pid]/status` every 1s and reaps zombies whose `ppid` is the gateway, using `waitpid(specific_pid, WNOHANG)`.
- The 5-second min-age threshold (`PRCTL_SUBREAPER_MIN_AGE_MS=5000`) prevents racing libuv's per-pid `waitpid` for tracked children.

Catches three classes of zombies:
- **Class A** (orphan reparenting) — same as `tini-as-PID-1` would catch.
- **Class B** ([libuv #1911](https://github.com/libuv/libuv/issues/1911) close-before-exit) — tini-as-PID-1 does NOT catch this.
- **Class C** (`child.kill()` leak) — caught once parent dies; with prctl-subreaper, caught while parent is alive.

In our diagnostic snapshot of n=50 fleet VMs (`instaclaw/docs/zombie-classification-2026-05-05.json`), 0 zombies fell in any tini-fixable bucket. The value of v87 is forward-looking — adding gbrain (Phase 4 of [PRD-gbrain-integration.md](./PRD-gbrain-integration.md)) introduces Bun + dream-cycle subprocess churn that may surface Class B zombies for the first time. v87 hardens before that arrives.

## 2. Hard prerequisites

- [ ] Cooper runs `npm publish prctl-subreaper` from `~/Development/prctl-subreaper/` (his account; the npm token isn't in this session). After publish, `npm view prctl-subreaper version` should return `0.1.0`.
- [ ] (Optional) Cooper restores the workflow file: `mv docs/ci.yml.example .github/workflows/ci.yml && git add . && git commit -m "ci: enable github actions" && git push`. Requires either a fresh `gh auth login` with `workflow` scope OR direct UI add. Workflow yaml is preserved in `docs/ci.yml.example`.
- [ ] Verify `build-essential` and `python3` are available on a representative fleet VM (for node-gyp). Spot-check vm-050 with `which gcc python3`. If absent, add to `vm-manifest.ts:systemPackages` BEFORE this PR lands.

## 3. Manifest changes (to be applied in v87)

### 3.1 systemd Environment directive

In `instaclaw/lib/vm-manifest.ts:systemdOverrides` (the `[Service]` block):

```typescript
systemdOverrides: {
  // ... existing keys (KillMode, Delegate, RestartSec, ExecStartPre, ExecStopPost,
  //     MemoryHigh, MemoryMax, TasksMax (now 120 per v86), OOMScoreAdjust,
  //     RuntimeMaxSec, RuntimeRandomizedExtraSec, Environment=PARTNER_ID=INSTACLAW)
  "Environment": [
    "PARTNER_ID=INSTACLAW",
    "NODE_OPTIONS=--require prctl-subreaper",
    "NODE_PATH=/usr/local/lib/node_modules",
    "PRCTL_SUBREAPER_INTERVAL_MS=1000",
    "PRCTL_SUBREAPER_MIN_AGE_MS=5000",
  ].join("\n"),
  // ... rest unchanged
},
```

NOTE: systemd permits multiple `Environment=` directives in the same `[Service]` block, OR a single multi-line value. Either form works; the multi-line form is what reconciler's existing override-writer can emit cleanly.

### 3.2 New reconciler step `stepPrctlSubreaper`

In `instaclaw/lib/vm-reconcile.ts`, **before** the systemd override write step:

```typescript
async function stepPrctlSubreaper(ctx: ReconcileContext): Promise<void> {
  const { ssh, result } = ctx;

  // 1. Already installed at correct version?
  const versionCheck = await ssh.execCommand(
    `bash -lc 'source ~/.nvm/nvm.sh && npm ls -g prctl-subreaper 2>/dev/null | grep -oE "prctl-subreaper@[0-9.]+"'`
  );
  const target = `prctl-subreaper@${PRCTL_SUBREAPER_PINNED_VERSION}`;
  if (versionCheck.stdout.trim() === target) {
    return; // No-op fast path.
  }

  // 2. Install / upgrade.
  const install = await ssh.execCommand(
    `bash -lc 'source ~/.nvm/nvm.sh && npm install -g prctl-subreaper@${PRCTL_SUBREAPER_PINNED_VERSION} 2>&1'`,
    { execOptions: { pty: false } }
  );
  if (install.code !== 0) {
    result.errors.push({
      step: "stepPrctlSubreaper",
      reason: "npm-install-failed",
      stderr: install.stderr.slice(0, 500),
    });
    return;
  }

  // 3. Verify the native addon actually built (Rule 10 — verify after set).
  const binPath = await ssh.execCommand(
    `bash -lc 'source ~/.nvm/nvm.sh && find $(npm root -g)/prctl-subreaper/build/Release -name "*.node" 2>/dev/null | head -1'`
  );
  if (!binPath.stdout.trim()) {
    result.errors.push({
      step: "stepPrctlSubreaper",
      reason: "native-addon-not-built",
      hint: "Check that build-essential + python3 are installed on the VM.",
    });
    return;
  }

  // 4. Smoke test: load it in a transient node and verify isSupported().
  const smoke = await ssh.execCommand(
    `bash -lc 'source ~/.nvm/nvm.sh && PRCTL_SUBREAPER_SILENT=1 NODE_PATH=/usr/local/lib/node_modules node -e "const s=require(\\"prctl-subreaper\\"); console.log(JSON.stringify({sup:s.isSupported(), running:s.stats().running}))"'`
  );
  if (!smoke.stdout.includes('"sup":true') || !smoke.stdout.includes('"running":true')) {
    result.errors.push({
      step: "stepPrctlSubreaper",
      reason: "smoke-test-failed",
      stdout: smoke.stdout.slice(0, 200),
    });
    return;
  }

  result.fixed.push("prctl-subreaper-installed");
}
```

Place this step BEFORE `stepSystemdUnit` (the override writer). If it fails, `result.errors` blocks the systemd override from getting `NODE_OPTIONS=--require prctl-subreaper` set — gateway keeps running without prctl-subreaper, no breakage.

### 3.3 Pinned version constant

In `vm-manifest.ts` near other `*_PINNED_VERSION`:

```typescript
export const PRCTL_SUBREAPER_PINNED_VERSION = "0.1.0";
```

## 4. Canary plan (per Upgrade Playbook)

### Phase 0 — vm-050 manual install (Day 0, 30 min)

1. SSH vm-050.
2. `source ~/.nvm/nvm.sh && npm install -g prctl-subreaper@0.1.0`.
3. Verify `find $(npm root -g)/prctl-subreaper/build/Release -name "*.node"` returns a path.
4. Smoke test: `PRCTL_SUBREAPER_SILENT=1 NODE_PATH=/usr/local/lib/node_modules node -e "console.log(require('prctl-subreaper').stats())"` — should print `{ running: true, pid: <PID>, intervalMs: 1000, minAgeMs: 5000, reapedCount: 0n }`.
5. Add to systemd override manually (drop a `tini.conf` drop-in equivalent at `~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf` with the Environment lines).
6. `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`.
7. Verify gateway active + /health 200 (Rule 5).
8. Run a real chat completion: should succeed in <30s.
9. Hold 24h.

### Phase 1 — Three-VM tier canary (Day 1–7)

Same flow, applied to one paying VM per tier (power, pro, starter). Hold 1 week.

### Phase 2 — Manifest PR (Day 8)

After Phase 1 green:
1. Apply changes from §3 to a new feature branch `fleet/v87-prctl-subreaper`.
2. Bump version 86 → 87 with v87 docstring.
3. Push to GitHub for Vercel preview.
4. Cooper reviews, merges to main.
5. Reconciler picks up the change over the next ~10 cycles (~30 min).
6. Watch the audit: `_audit-fleet-zombie-classification.ts` should see prctl-subreaper-installed VMs reap zombies on a 1s cycle.

### Phase 3 — Fleet validation (Day 9)

Re-run the diagnostic on n=50 random VMs. Expected outcome:
- BEFORE (n=50 from 2026-05-05): 2 zombies fleet-wide, 0 fitting tini-fixable shape.
- AFTER (n=50, post-rollout): expect 0 zombies if no Class B leaks are happening, OR a non-zero `reapedCount` from `prctl-subreaper.stats()` per VM (proof the reaper is working).

If we synthetically induce a Class B leak (for the demo): SSH a VM, run a Node REPL that calls `child_process.spawn` then immediately `child.unref()` + `child.kill()`. Without prctl-subreaper, zombie persists. With it, zombie is reaped within ~6s (5s min-age + 1s poll).

## 5. The post-publish trigger for the Garry reply

Once Phase 3 confirms reaper-active across the fleet:

1. Capture `stats().reapedCount` from a sample of VMs (e.g., 10 VMs, sum the bigints).
2. Compute "before" baseline from the 2026-05-05 diagnostic JSON.
3. Compose the tweet thread with real numbers. Suggested skeleton:

> T1: re: tini for OpenClaw zombies — tini catches orphans, but libuv #1911 leaks zombies attached to node directly. tini-as-PID-1 can't reap those (parent's alive). Built `prctl-subreaper` to close that gap: prctl(PR_SET_CHILD_SUBREAPER, 1) on the node process itself + a 1s polling waitpid reaper. ~30 lines of N-API.
>
> T2: deployed across our 190-VM fleet. Before: <X> zombies surfaced over 24h, <Y> fork errors. After: <Z> zombies reaped by the in-process reaper, 0 user-visible. Linux only. MIT. github.com/coopergwrenn/prctl-subreaper · npmjs.com/package/prctl-subreaper
>
> T3: design notes — uses `waitpid(specific_pid)` not `waitpid(-1)` so we never race libuv (whoever wins, ECHILD on the loser, harmless). 5s min-age before reaping gives libuv first crack at its tracked children. Bun-compatible (load via `--preload`). Shopify shipped this for Ruby in 2017; Node ecosystem didn't have one.

Numbers `<X>`, `<Y>`, `<Z>` come from the actual diagnostic. **Do not draft until the numbers are real.**

## 6. Rollback plan

Per Rule 22 (trim, don't nuke):

- **Per-VM rollback:** SSH, remove the systemd Environment lines containing `NODE_OPTIONS=--require prctl-subreaper`, `daemon-reload`, restart gateway. Package stays installed (idle). Gateway runs without the addon.
- **Fleet rollback:** revert the v87 PR. Reconciler removes the Environment directive on next cycle. Package stays installed.
- **Crash-loop scenario:** if the addon causes openclaw-gateway to fail-to-start on a real VM, the existing systemd `Restart=on-failure` + `StartLimitBurst=10` would burst-restart 10× then stop. Watchdog alerts. Manual recovery: SSH in, drop the Environment lines from the override, daemon-reload, manual `systemctl --user start openclaw-gateway`. Detection time <5 min via /health=503 alerts.

## 7. Why this is staged separately from v86

Both changes target the same incident (vm-724 fork errors), but:

- **v86 (TasksMax 75 → 120)** is a single-line, low-risk, well-understood manifest tweak. Solves the proven cliff. Independently valuable. Already committed to `fleet/v86-prctl-subreaper-tasksmax` branch.
- **v87 (prctl-subreaper)** introduces a new dependency, a new C++ extension, a new install path, and a new systemd Environment directive. Multiple failure modes. Each must be canaried.

Bundling would make v87 failures roll back v86's clear win. Splitting keeps each change reversible on its own merits.

## 8. Open questions

1. **Path resolution for `--require prctl-subreaper`**: Node resolves bare specifiers via NODE_PATH + global paths. Setting `NODE_PATH=/usr/local/lib/node_modules` in the systemd Environment should work, but verify on vm-050.
2. **node-gyp on each VM**: confirm `gcc`, `make`, `python3` are available. The OpenClaw snapshot likely has them (NVM-installed Node ships with node-gyp dependencies). Spot-check before fleet rollout.
3. **Bun reaches the gateway?** Currently no — gateway is Node only. gbrain's Bun process is separate. v87 only needs to work for Node.
4. **Per-VM reapedCount visibility**: should we expose `stats()` over `gbrain doctor`-style health endpoint, or via a dedicated cron that writes to Supabase? Phase 3 metric collection design TBD.
5. **gbrain interaction**: gbrain serve under MCP stdio is a child of openclaw-gateway. Once openclaw-gateway has prctl-subreaper, any zombies under gbrain's Bun runtime reparent to openclaw-gateway (which IS the subreaper). gbrain doesn't need its own subreaper. ✓
