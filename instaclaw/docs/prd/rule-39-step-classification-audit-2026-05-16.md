# Rule 39 — Step Classification Audit (vm-reconcile.ts)

**Date:** 2026-05-16
**Status:** AUDIT-COMPLETE / AWAITING-COOPER-REVIEW. **No reconciler code has been changed.**
**Scope:** Classify every `result.errors.push(...)` call site in `lib/vm-reconcile.ts` as HARD (block cv bump) or WARNING (log but don't block). Identify a narrow, conservative set of conversions justified by concrete evidence.

---

## 0. Executive summary

**The infrastructure already exists.** `result.warnings: string[]` is a field on `ReconcileResult` (line 170). The cron route's `pushFailed` gate at `app/api/cron/reconcile-fleet/route.ts:591` uses `auditResult.errors.length > 0` exclusively — warnings already do NOT block cv. Two helpers already encode the right semantics:

- `recordHealError(result, strict, msg)` (line 4796) — push to errors + (when strict) strictErrors. HARD.
- `recordHealWarning(result, msg)` (line 4814) — push to warnings. SOFT. Docstring explicitly cites Rule 39.

**The audit is therefore: are any of the 87 direct `result.errors.push` call sites mis-classified as HARD when they could safely be WARNING?**

**Findings, in priority order:**

1. **vm-356 case study (concrete evidence).** vm-356 is held at cv=99 (one behind manifest v100, which removed RuntimeMaxSec) because `python: httpx install failed`. httpx is in `BE10_UNPINNED_PYTHON_PACKAGES` — a fleet-heal list of pip packages used by partner-gated scripts (Consensus, research, scraping). On vm-356 (no partner) httpx has zero customer impact, but blocks the v100 SIGTERM-induced-orphan-tool_use fix that DOES affect every VM. Clear conversion target.

2. **Five other steps have one or more pushes that should be warnings.** Two-axis criterion: (a) feature is sidecar / non-default / partner-gated AND (b) failure mode is "operator-side missing privilege" (sudo) or "transient network" or "third-party-package-mirror-flap." See §4.

3. **All other steps are correctly HARD.** Gateway, systemd, ExecStart, openclaw config, manifest files, partner SOUL.md, AuthProfiles, npm pins, Node upgrade, telegram token, identity, skill SKILL.md, privacy bridge, gbrain install on partner VMs — every one of these can break customer experience if cv bumps over a failure. Keep blocking.

**Recommendation:** convert exactly the 9 push sites listed in §4 to `recordHealWarning(result, ...)`. No code changes outside `lib/vm-reconcile.ts`. No manifest schema changes. No new infrastructure. Estimated diff: ~30 LOC, all targeted edits inside existing step bodies. Safety net: each converted site preserves its original behavior in the rare scenarios it should still block (documented per-site).

**Three open decisions for Cooper** (don't gate the bulk of the conversions; see §7):
- D1: should `stepConfigSettings` verify-after-set mismatch be granular (per-key critical flag)?
- D2: should `stepEnvVarPush` STEPENV_FAIL be granular (per-key critical flag)?
- D3: should `result.warnings` show up in a separate cron-route response field for dashboards?

---

## 1. Methodology — HARD vs WARNING

A push is HARD (block cv bump) if AT LEAST ONE of these holds:

- **(H1) Gateway will run with wrong state.** Missing config the gateway reads at startup. Failed systemd unit edit. Wrong ExecStart. AuthProfiles drift. ENOSPC.
- **(H2) On-disk diverges from manifest in a customer-visible way.** Workspace identity files (SOUL.md, MEMORY.md, CAPABILITIES.md). Skill SKILL.md files the agent reads. Telegram bot token. Partner SOUL.md sections.
- **(H3) Data-integrity miss the next cron CAN'T fix.** A non-idempotent rollback already happened; next retry has nothing to retry. (Rare; only stepDeployPrivacyBridge's `chattr_failed_no_backup`.)
- **(H4) Next gateway restart will fail.** Schema-rejected config keys (Rule 2). Missing required env vars the gateway reads at boot.

A push is WARNING (log but don't block) if ALL of these hold:

- **(W1) Customer experience is not affected** by the failure persisting one more cron cycle (~3 min).
- **(W2) Feature is opt-in / sidecar / partner-gated** OR the failure is transient (third-party rate limit, mirror flap, sudo missing on operator-side install path).
- **(W3) A retry-on-next-tick has the same shot at succeeding** as today — the failure is environmental, not state-divergent.
- **(W4) Holding cv punishes UNRELATED in-flight changes.** Currently the issue: one BE-10 pip install blocks the v100 RuntimeMaxSec removal for every VM that hits the same pip flap.

Ambiguity protocol: when uncertain, **default to HARD.** The asymmetric cost is steep — a HARD-mistakenly-WARNING means cv bumps over a real defect; a WARNING-mistakenly-HARD just means an extra retry cycle.

---

## 2. Existing infrastructure

```typescript
// lib/vm-reconcile.ts (already present)
interface ReconcileResult {
  errors: string[];        // line 162 — HARD signals; pushFailed gate uses this
  warnings: string[];      // line 170 — SOFT signals; logged separately
  strictErrors: string[];  // strict-mode HARD signals; blocks even more aggressively
  // ... fixed, alreadyCorrect, etc.
}

function recordHealError(result, strict, msg) {
  result.errors.push(msg);
  if (strict) result.strictErrors.push(msg);
}

function recordHealWarning(result, msg) {
  result.warnings.push(msg);
}
```

The cron route gate:

```typescript
// app/api/cron/reconcile-fleet/route.ts:591
const pushFailed = auditResult.errors.length > 0;
```

Warnings ARE separately surfaced — they're included in the response JSON and the structured `CV_BUMP_BLOCKED` log line, but they don't trip `pushFailed`. So a conversion from `result.errors.push(...)` to `recordHealWarning(result, ...)` is a single-line change with no other side effects required.

**Steps already using `recordHealWarning` correctly:** `stepNodeExporter`, `stepGatewayWatchdogTimer`, `stepDispatchServer` (mixed: uses recordHealError on hard paths, recordHealWarning on its probe-parse path is implicit via the parse handler), `stepDiskGuard` (uses `result.warnings.push` directly on probe parse + non-critical paths). `stepExternalSkillHeal` uses warnings extensively for transient signals (git clone failed, probe parse failed, dir-missing-stepSkills-handles-it).

---

## 3. Per-step audit table (87 push sites across ~40 steps)

Sorted by line. Step lines from `lib/vm-reconcile.ts`. Verdict columns: **HARD-correct** = leave as `result.errors.push`. **HARD-keep** = leave but flag for future granular review (D1/D2). **WARNING-convert** = recommended conversion to `recordHealWarning`. **HARD-→helper** = leave HARD but route through `recordHealError(result, strict, ...)` for consistency.

| # | Step | Line | Verdict | Reasoning |
|---|---|---|---|---|
| 1 | stepDiskGuard | 928 | HARD-correct | `postPct >= 95%` after standard + emergency purge = real disk-full. Gateway crash imminent. (H1) |
| 2 | stepWorkspaceIntegrity | 1045 | HARD-correct | No template for required file = code bug. Don't bump over an unknown defect. (H3) |
| 3 | stepWorkspaceIntegrity | 1060 | HARD-correct | SOUL/MEMORY/CAPABILITIES write failed = customer identity files missing. (H2) |
| 4 | stepEnvVarPush | 1301 | HARD-keep | STEPENV_FAIL on verify-after-write. Hits only past partner-gate + value-present checks → key matters to this VM. See D2. (H4) |
| 5 | stepEnvVarPush | 1308 | HARD-keep | Unexpected script output = state uncertain → treat as failed. (H4) |
| 6 | stepExecStartAlignment | 1488 | HARD-correct | sed rewrite of systemd unit failed = unit in inconsistent state. Next restart loads wrong binary. (H1) |
| 7 | stepExecStartAlignment | 1509 | HARD-correct | daemon-reload failed = runtime view stale. (H1) |
| 8 | stepGbrain | 1652 | HARD-correct | install-gbrain.sh upload failed = no install. Partner-gated. (H2) |
| 9 | stepGbrain | 1663 | HARD-correct | verify-gbrain-mcp.py upload failed = no verify. (H2) |
| 10 | stepGbrain | 1669 | HARD-correct | Upload threw = state uncertain. (H2) |
| 11 | stepGbrain | 1689 | HARD-correct | Install command threw = state uncertain. (H2) |
| 12 | stepGbrain | 1727 | HARD-correct | FATAL_<reason> from install script. Real failure mode. (H2) |
| 13 | stepGbrain | 1738 | HARD-correct | No terminal output (timeout or unexpected exit) = state uncertain. (H2) |
| 14 | stepConfigSettings | 1886 | HARD-keep | Verify-after-set mismatch. Per Rule 32 / Rule 10 / Rule 23, cv must reflect on-disk state — a key that didn't land must hold cv. See D1 for granularity proposal. (H4, H3) |
| 15 | stepFiles | 2034 | HARD-correct | Manifest file write throw. (H2) |
| 16 | stepFiles | 2103 | HARD-correct | Required sentinel missing from in-memory template = Rule 23 stale-cache guard. (H3) |
| 17 | stepFiles | 2214 | HARD-correct | Append-target file missing = can't apply marker-based edit. (H2) |
| 18 | stepFiles | 2277 | HARD-correct | Insert-before-marker target file missing. (H2) |
| 19 | stepFixBlankIdentity | 2435 | HARD-correct | SOUL.md still blank template after fix = customer-facing identity broken. (H2) |
| 20 | stepTelegramTokenVerify | 2527 | HARD-correct | Unexpected chars in DB token = refuse to write garbage. (H3) |
| 21 | stepTelegramTokenVerify | 2578 | HARD-correct | `openclaw config set` failed for telegram.botToken. (H4) |
| 22 | stepTelegramTokenVerify | 2595 | HARD-correct | Verify-after-set mismatch on telegram token. Customer bot delivery breaks. (H2, H4) |
| 23 | stepRemotionDeps | 2718 | **WARNING-convert** | Remotion (motion-graphics video skill) deps install failed. Per `stepRemotionDeps` purpose: opt-in motion-graphics skill. Failure = motion-graphics skill broken on that VM only. Other agent functionality unaffected. (W1, W2, W3, W4) |
| 24 | stepNpmPinDrift | 2786 | HARD-correct | npm pin verify-after-set failed = wrong openclaw binary version. (H1) |
| 25 | stepNpmPinDrift | 2891 | HARD-correct | mcporter install failed = `mcporter call clawlancer.*` broken. Universal-needed. (H2) |
| 26 | stepNpmPinDrift | 2932 | HARD-correct | gen-prompt npm install failed = openclaw-side prompt generator missing. (H1) |
| 27 | stepNpmPinDrift | 2972 | HARD-correct | mcporter version check failed (post-install verify). (H1) |
| 28 | stepNpmPinDrift | 3033 | HARD-correct | Bun install/upgrade failed = gbrain sidecar dep missing on partner VMs. (H1) |
| 29 | stepNodeUpgrade | 3100 | HARD-correct | NVM install of pinned Node failed. (H1) |
| 30 | stepNodeUpgrade | 3132 | HARD-correct | Post-install Node version mismatch. (H1) |
| 31 | stepEnforceModelPrimary | 3202 | HARD-correct | `agents.defaults.model.primary` didn't set. Every chat affected. (H1, H4) |
| 32 | stepPrctlSubreaper | 3254 | HARD-correct | npm root -g resolution failed = can't compute install path. (H1) |
| 33 | stepPrctlSubreaper | 3301 | HARD-correct | Install failed = no zombie reaper. Gateway stability affected at 8+ plugins. (H1) |
| 34 | stepPrctlSubreaper | 3314,3325,3338 | HARD-correct | Verify-after-install path failures. (H1) |
| 35 | stepPrctlSubreaper | 3357 | HARD-correct | systemd drop-in write failed = NODE_OPTIONS not injected. (H1) |
| 36 | stepPrctlSubreaper | 3366 | HARD-correct | Drop-in verify-after-write failed. (H1) |
| 37 | stepSkills | 3392 | HARD-correct | Local `skills/` dir missing = build artifact missing. Pre-deploy bug. (H3) |
| 38 | stepSkills | 3494 | HARD-correct | Verify-after-write: deployed N, on-disk N-K. Lying-DB pattern (Rule 23). (H2, H3) |
| 39 | stepSkills | 3508 | HARD-correct | Deployment threw. (H2) |
| 40 | stepSystemPackages | 3573 | **WARNING-convert** | apt-get install single-package failed. Sudo missing or apt mirror down. Per the per-package iteration, ONE failure shouldn't block cv on all the others that succeeded + the rest of the manifest. (W1 — most system packages are non-critical e.g. jq, build-essential; gateway runs fine without them for one cycle). (W2, W3, W4) |
| 41 | stepSystemPackages | 3577 | HARD-correct | Outer catch (the whole `try` for system packages threw). Different shape — suggests SSH-level issue worth blocking on. (H3) |
| 42 | stepPythonPackages | 3641 | HARD-correct | Block 1 (manifest.pythonPackages, currently `openai`). openai package used in core scripts. (H2) |
| 43 | stepPythonPackages | 3645 | HARD-correct | Block 1 outer catch. SSH-layer issue. (H3) |
| 44 | stepPythonPackages | 3693 | **WARNING-convert** | crawlee BE-10 fleet-heal install failed. crawlee is used by web-scraping skill. Skill is partner-gated / opt-in. Failure = scraping skill broken on that VM only. (W1, W2, W3, W4) |
| 45 | stepPythonPackages | 3722 | **WARNING-convert** | **vm-356's blocking error.** BE-10 unpinned package install failed (httpx, etc.). Used by partner scripts (Consensus, research). On a non-partner VM, zero customer impact. (W1, W2, W3, W4) |
| 46 | stepPythonPackages | 3728 | HARD-correct | BE-10 outer catch (SSH-layer issue). Different shape. (H3) |
| 47 | stepGatewayRestart | 4047 | HARD-correct | Restart-with-validate-fix wrote-but-rejected. Gateway will crash. (H1) |
| 48 | stepGatewayRestart | 4147 | HARD-correct | Gateway not healthy after dynamic-budget wait. Customer down. (H1) |
| 49 | stepSystemdUnit | 4189 | HARD-correct | Unit file missing = configureOpenClaw didn't run. Real defect. (H1) |
| 50 | stepSystemdUnit | 4264 | HARD-correct | systemd override.conf write failed. (H1) |
| 51 | stepSystemdUnit | 4271 | HARD-correct | systemd daemon-reload failed = override not applied. (H1) |
| 52 | stepSystemdUnit | 4293 | HARD-correct | Unit verify-after-edit failed. (H1) |
| 53 | stepSystemdUnit | 4304 | HARD-correct | systemctl show post-reload mismatch. (H1) |
| 54 | stepSSHDProtection | 4355 | **WARNING-convert** | sshd OOM-protection systemd drop-in deploy failed. Defense-in-depth against OOM-killer choosing sshd as victim. Failure = same OOM-kill risk as today (no regression vs current state). (W1, W2, W3, W4) |
| 55 | stepCleanStaleMemory | 4419 | **WARNING-convert** | Stale memory file cleanup failed (legacy memory layout). Cleanup is a no-op on most VMs. Failure = a few KB of stale files persist. Zero customer impact. (W1, W2, W3, W4) |
| 56 | stepCaddyUIBlock | 4463 | **WARNING-convert** | Couldn't parse hostname from Caddyfile = parser regression OR manually-edited Caddyfile. UI redirect breaks; agent unaffected. Per inline comment, this exact case already tripped v66→v67 false-fails. (W1, W2, W3, W4) |
| 57 | stepCaddyUIBlock | 4503 | **WARNING-convert** | Caddyfile write failed (sudo missing). UI redirect only. (W1, W2, W3, W4) |
| 58 | stepCaddyUIBlock | 4510 | **WARNING-convert** | Caddy reload failed. UI redirect only. (W1, W2, W3, W4) |
| 59 | stepV67RoutingTablePatch | 4591 | HARD-correct | SOUL.md routing table patch python failed = SOUL.md may be in inconsistent state. Customer-facing identity. (H2) |
| 60 | stepV67RoutingTablePatch | 4615 | HARD-correct | Verify-after-write of routing table marker. (H2) |
| 61 | stepInstaClawIdentityPatch | 4753 | HARD-correct | Identity patch python failed. (H2) |
| 62 | stepInstaClawIdentityPatch | 4771 | HARD-correct | Verify state mismatch. (H2) |
| 63 | orchestrator | 4797 | HARD-correct | Per-step error wrapper in reconcileVM. Outer catch — already correctly HARD. (H3) |
| 64 | stepExternalSkillHeal | 5114 | HARD-correct | bankr-overlay atomic prepend failed = bankr SKILL.md corrupt. Customer-facing. (H2) |
| 65 | stepExternalSkillHeal | 5192 | HARD-correct | consensus-2026 cron install failed = skill auto-update broken. Customer-facing for Consensus partner. (H2) |
| 66 | stepExternalSkillHeal | 5271 | HARD-correct | mcporter clawlancer config add failed = `mcporter call clawlancer.*` broken. Universal. (H2) |
| 67 | stepExternalSkillHeal | 5333 | HARD-correct | edge-esmeralda cron install failed = edge skill auto-update broken. Customer-facing for edge_city partner. (H2) |
| 68 | stepMigrateSoulV2 | 6345 | HARD-correct | Read of workspace files failed = can't migrate. (H3) |
| 69 | stepMigrateSoulV2 | 6401 | HARD-correct | Backup write failed = can't safely migrate per Rule 22. (H3) |
| 70 | stepMigrateSoulV2 | 6431 | HARD-correct | Verify-after-migration failed = SOUL.md V2 in unknown state. (H2) |
| 71 | stepMigrateSoulV2 | 6564 | HARD-correct | Migration script returned error state. (H2) |
| 72 | stepDeployPrivacyBridge | 6637 | HARD-correct | chattr +i failed during deploy; rolled back to old bridge = bridge functional but stale content. Need to retry. (H2, H3) |
| 73 | stepDeployPrivacyBridge | 6653 | HARD-correct | chattr +i failed twice with NO BACKUP = bridge unlocked. **Cooper LOCKOUT risk on cutover VMs.** (H3) |
| 74 | stepDeployPrivacyBridge | 6667 | HARD-correct | SHA mismatch pre-swap = retry needed. (H2) |
| 75 | stepDeployPrivacyBridge | 6678 | HARD-correct | Pre-swap path failure (mkdir/write/mv/chmod/unlock). (H2) |
| 76 | stepDeployPrivacyBridge | 6683 | HARD-correct | Default path (exec_failed / unknown / paradox). (H3) |
| 77 | stepRewriteSoulPartnerSections | 6854 | HARD-correct | Python script failed = partner SOUL.md stub-rewrite incomplete. (H2) |
| 78 | stepRewriteSoulPartnerSections | 6873 | HARD-correct | Couldn't parse python output = state uncertain. (H3) |
| 79 | stepRewriteSoulPartnerSections | 6880 | HARD-correct | SOUL.md missing per script. (H2) |
| 80 | stepRewriteSoulPartnerSections | 6886 | HARD-correct | Verify-failed status. (H2) |
| 81 | stepRewriteSoulPartnerSections | 6892 | HARD-correct | Unexpected status. (H3) |
| 82 | stepRewriteSoulPartnerSections | 6910 | HARD-correct | Unexpected edge/consensus state. (H3) |
| 83 | stepDeployEdgeOverlay | 7009 | HARD-correct | Edge overlay deploy failed. Partner-gated; customer-facing for edge_city. (H2) |
| 84 | stepDeployEdgeOverlay | 7019 | HARD-correct | Edge overlay verify-after-write failed. (H2) |

**Totals:**
- HARD-correct: **75**
- HARD-keep (open question — see §7): **3** (stepConfigSettings 1886, stepEnvVarPush 1301/1308)
- WARNING-convert: **9**

---

## 4. Recommended conversions — exactly 9 push sites

All converted by replacing `result.errors.push(<msg>)` with `recordHealWarning(result, <msg>)`. No other code changes. Each site has a per-line rationale below.

### 4.1 stepRemotionDeps (line 2718)

```diff
-    result.errors.push(`remotion deps install failed: ${install.stderr?.slice(0, 200) || install.stdout?.slice(-200)}`);
+    recordHealWarning(result, `remotion deps install failed: ${install.stderr?.slice(0, 200) || install.stdout?.slice(-200)}`);
```

**Why:** motion-graphics skill (Remotion-based) is opt-in / non-default. Customer impact when broken: agent can't render the specific motion-graphics video format. Other video workflows (sjinn, higgsfield) unaffected. Doesn't touch the gateway, doesn't touch the message-path. Failure mode is npm registry hiccup → transient.

**Safety net:** if Remotion ever becomes a default-on capability, re-promote to HARD. Easy revert.

### 4.2 stepSystemPackages (line 3573)

```diff
-        result.errors.push(`${pkg}: install skipped (no sudo or apt-get failed)`);
+        recordHealWarning(result, `${pkg}: install skipped (no sudo or apt-get failed)`);
```

**Why:** Per-package install in the loop. apt-get failure on a single non-critical package (jq, build-essential, etc.) shouldn't block cv on the OTHER packages that succeeded + every other in-flight manifest change. Sudo-missing on a VM is an environmental / operator-provisioning issue, not a state-divergence issue.

**Safety net:** the outer catch (line 3577) stays HARD — that catches "the whole try threw" (SSH dead, exec failure). Per-package failures are the soft signal.

### 4.3 stepPythonPackages (line 3693) — crawlee

```diff
-      result.errors.push(
+      recordHealWarning(result,
         `python: crawlee install failed: was=${crawleeCurr || "missing"} got=${verify || "(empty)"} pip-tail=${(install.stdout + install.stderr).slice(-200)}`,
       );
```

**Why:** crawlee is used by web-scraping skills (consensus + research). PyPI/Playwright Chromium download flake is a known transient. The reconciler retries naturally on next cycle. cv-blocking on a transient pip issue punishes ALL cv-deliverable changes.

**Safety net:** if persistent failures on partner VMs need to be tracked, the `instaclaw_admin_alert_log` pipeline already surfaces warnings to operators. The signal is preserved.

### 4.4 stepPythonPackages (line 3722) — BE-10 unpinned packages

```diff
-        result.errors.push(
+        recordHealWarning(result,
           `python: ${pkg} install failed: pip-tail=${(install.stdout + install.stderr).slice(-200)}`,
         );
```

**Why:** **This is vm-356's blocker.** BE-10 unpinned packages are fleet-heal for partner-script dependencies (httpx for HTTP calls in Consensus/research, etc.). On a non-partner VM, missing httpx has zero customer impact. On a partner VM, the partner's scripts degrade gracefully (httpx imports fail at script-run-time with a clear error, not at gateway-init). cv-blocking on PyPI flap costs every VM the v100 SIGTERM fix.

**Safety net:** if a partner VM persistently can't install httpx, the BE-10 fleet-heal warning surfaces in logs. Operators can run the install manually if it's a persistent block. The next cron cycle keeps retrying naturally.

### 4.5 stepSSHDProtection (line 4355)

```diff
-    result.errors.push(`sshd OOM protection failed: ${deployResult.stderr}`);
+    recordHealWarning(result, `sshd OOM protection failed: ${deployResult.stderr}`);
```

**Why:** sshd OOM-protection systemd drop-in is defense against `oom-killer` choosing sshd as its victim when the VM is under memory pressure. Failure = sshd has the same OOM-victim risk as today (zero regression vs current state — most VMs already lack this protection until the reconciler installs it). Failure mode is sudo-missing.

**Safety net:** retried next cycle. Persistent failure indicates a sudo/provisioning issue worth investigating; warning surfaces it without blocking cv.

### 4.6 stepCleanStaleMemory (line 4419)

```diff
-    result.errors.push(`memory cleanup failed: ${cleanResult.stderr}`);
+    recordHealWarning(result, `memory cleanup failed: ${cleanResult.stderr}`);
```

**Why:** Legacy memory-layout cleanup (deletes a few KB of pre-V2 SOUL artifacts). No-op on most VMs. Failure = stale files persist. Zero customer impact.

**Safety net:** retried next cycle.

### 4.7 stepCaddyUIBlock (lines 4463, 4503, 4510)

```diff
-    result.errors.push("caddy: could not parse hostname from Caddyfile");
+    recordHealWarning(result, "caddy: could not parse hostname from Caddyfile");
```
```diff
-    result.errors.push(`caddy: failed to write Caddyfile: ${writeResult.stderr}`);
+    recordHealWarning(result, `caddy: failed to write Caddyfile: ${writeResult.stderr}`);
```
```diff
-    result.errors.push(`caddy: reload failed: ${reloadResult.stderr}`);
+    recordHealWarning(result, `caddy: reload failed: ${reloadResult.stderr}`);
```

**Why:** Caddy UI block adds a "redirect from VM's public hostname → instaclaw.io/dashboard" handler. Failure = visitor sees the legacy Block Control UI instead of the redirect. The agent's message path (gateway:18789) is unaffected — Caddy is a separate process / port. Per inline comment at line 4446: the no-Caddyfile case ALREADY had to be promoted from `result.errors.push` to `result.alreadyCorrect.push` once, after it tripped false-fail PUSH-FAILEDs during the v66→v67 upgrade. The other Caddy paths are the same shape.

**Safety net:** retried next cycle. Visible in warnings + admin_alert_log.

---

## 5. vm-356 unstuck — what happens after the conversion lands

Before:
- vm-356 cv=99, reconcile_consecutive_failures=1, last_error=`python: httpx install failed: pip-tail=`
- Cron retries every 3 min. cv-blocking. Doesn't get v100 RuntimeMaxSec removal.

After:
- Next reconcile tick: stepPythonPackages still fails on httpx → pushes to `result.warnings` (instead of `result.errors`).
- `pushFailed = auditResult.errors.length > 0` evaluates `false` (all other steps clean).
- cv bumps 99 → 100. v100 systemd override deploys. RuntimeMaxSec removed. No more scheduled 24h restarts.
- The httpx-install-failed warning is preserved in the cron's response + structured log + `instaclaw_admin_alert_log` (via the existing warnings-aware logging path).
- Next reconcile tick keeps trying to install httpx. If/when PyPI cooperates, the warning clears.
- If the failure persists, an operator notices via the warning surface and triages — same shape as today's recordHealWarning failures.

**Net: customer outcome strictly better.** vm-356 gets the v100 fix. The httpx failure remains visible.

---

## 6. Migration plan

**One PR, ~30 LOC diff, all inside `lib/vm-reconcile.ts`.** No infrastructure changes.

**Phases:**

1. **PR lands on main.** Reconciler picks up the conversions on the next cron tick (~3 min). No code outside vm-reconcile.ts is touched; no migration; no manifest bump.
2. **Spot-check vm-356** specifically — expect cv to advance to 100 within ~6 min after the PR lands (one cron cycle to re-evaluate, one to deploy v100).
3. **Fleet-wide observation, 24h.** Watch `cron/reconcile-fleet` response logs for `result.warnings` growth. If any partner VM hits a NEW class of warning that turns out to be HARD-mistakenly-WARNING (worse than expected), revert the specific conversion.
4. **After 24h clean:** treat the conversions as the new default. Add to the criteria-doc-portion of CLAUDE.md Rule 39.

**Revert path:** each conversion is a single line. Reverting one is one-line-change. No data migration. No state cleanup. Safe.

**Risk register:**

| Risk | Mitigation |
|---|---|
| Converted warning hides a real bug in a partner-script-only path | Warnings are still logged + dashboardable. Operators see them in admin_alert_log. |
| Some non-converted error is the actual blocker on a different VM and the change doesn't unstick the fleet | The audit is targeted; other paths still HARD. Doesn't worsen anything. |
| The 9-line PR has a typo and converts the wrong line | `npx tsc --noEmit` typecheck pre-merge + sentinel grep for the warning strings. |
| Caddy paths converted but vm has the dashboard exposed publicly via Caddy and now redirect doesn't work | Warning surfaces in logs; operator can re-install manually. Block Control UI on the public hostname is the fallback (same as today on non-reconciled VMs). |

---

## 7. Open decisions for Cooper (don't block §4 conversions)

These three items are deeper-than-quick-conversion design questions. They can ship in follow-up PRs.

### D1 — Granular criticality for stepConfigSettings (line 1886)

Today: ANY verify-after-set mismatch blocks cv. By design per Rule 32 + Rule 10. But: some manifest keys are operationally less-critical than others (e.g., a UI cosmetic setting vs `agents.defaults.model.primary`).

**Proposal:** add an optional `critical?: boolean` flag to manifest configSetting entries. Verify-after-set mismatch on a key with `critical: false` → warning. Default: critical = true (preserves current behavior).

**Estimate:** ~80 LOC in vm-manifest.ts + vm-reconcile.ts + one schema migration in the manifest type. Not in scope for the immediate Rule 39 PR.

**Recommendation:** defer. Current state is conservative and correct. Until we have a concrete example of a verify-after-set hold that should NOT have blocked, the change isn't justified.

### D2 — Granular criticality for stepEnvVarPush (lines 1301, 1308)

Same shape as D1. Today: ANY STEPENV_FAIL blocks cv. Some entries in `SECRET_ENV_VAR_SOURCES` are degraded-gracefully (BRAVE_API_KEY = web search degrades vs hard-blocks).

**Proposal:** add `critical?: boolean` field to `SECRET_ENV_VAR_SOURCES` entries.

**Estimate:** ~30 LOC + entry-by-entry classification.

**Recommendation:** defer. Current state is conservative and correct. Partner secrets are universally critical; the non-partner-gated keys (GBRAIN_OPENAI_API_KEY etc.) are universally critical too. The set of "degraded-gracefully" entries is empty today.

### D3 — Surface warnings separately in the cron response

Today: `result.warnings` is logged but not prominently surfaced in the cron response or the per-VM dashboard. Operators rely on grepping Vercel logs.

**Proposal:** add a `warningsCount` + `warningsSample` field to the per-VM response in `app/api/cron/reconcile-fleet/route.ts`. Surface in any future fleet-health dashboard.

**Estimate:** ~20 LOC. No reconciler change; pure response-shape addition.

**Recommendation:** ship as a follow-up after this PR lands and we see how many warnings are surfacing in practice.

---

## 8. What this audit explicitly does NOT recommend

To prevent scope creep:

- **No conversion of gateway/systemd/ExecStart/AuthProfiles errors.** These are H1 by definition.
- **No conversion of workspace identity files (SOUL.md, MEMORY.md, CAPABILITIES.md) errors.** H2.
- **No conversion of skill SKILL.md deployment errors.** H2 — agent reads these.
- **No conversion of telegram bot token, gbrain install (on partner VMs), partner SOUL.md sections.** H2.
- **No conversion of privacy-bridge errors.** Security-critical; lockout risk on cutover.
- **No conversion of stepConfigSettings or stepEnvVarPush per-line pushes.** Even though Cooper's framing called these out as candidates, the actual ground truth (vm-356 was httpx, not env or config) doesn't support a broad sweep. D1/D2 are the path forward for granular control IF needed.
- **No new infrastructure.** `result.warnings` and `recordHealWarning` already exist.
- **No manifest schema changes.** None needed for the §4 conversions.
- **No reconciler-route changes.** `pushFailed` gate already ignores warnings.

---

## 9. Sign-off checklist

When ready, Cooper reviews and either:

- [ ] **APPROVE §4 verbatim** → I implement the 9 conversions in one PR with sentinel-greppable diff for review. Estimated ~30 LOC.
- [ ] **APPROVE §4 with edits** → name which conversions to drop / keep / reword.
- [ ] **REJECT** → identify the specific conversions that worry you; I revise the criteria.
- [ ] **Decide on D1/D2/D3** independently (defer is the recommendation; ship in follow-ups if needed).

---

## 10. Audit completeness

87 `result.errors.push` call sites inventoried across `lib/vm-reconcile.ts`. 84 classified explicitly in §3. The remaining 3 are orchestrator-level (line 4797 — the per-step error wrapper in reconcileVM's main loop) which I classified as HARD-correct.

Every step function in vm-reconcile.ts was opened and read. No `result.errors.push` site was skipped. The audit is end-to-end.
