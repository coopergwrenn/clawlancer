# Phase 2c v2 — Deferred Items

Items explicitly acknowledged out-of-scope for PR 1 (core strict-mode fix +
monitoring + migration) and PR 2 (CI + unit tests + docs). Tracked here so
they don't drop off the table.

## High-value, low-effort — ship soon after stage 3

### 1. Weekly digest email
- **Why:** stage 3 is 191 VMs across ~20 cron runs/day. Trend detection via a
  weekly email beats pointwise inspection.
- **Shape:** cron at `/api/cron/strict-digest`, schedule `0 12 * * 1` (Mondays
  12:00 UTC). Queries `instaclaw_strict_daily_stats` for the last 7 days and
  `instaclaw_strict_holds` grouped by error pattern. Renders a plain-text
  email summary: probes/day, holds/day, top error classes, VMs by streak,
  week-over-week latency delta.
- **Effort:** ~1 file (new cron route), ~150 lines.

### 2. `/api/gateway/health` non-billable endpoint
- **Why:** currently every strict canary incurs Anthropic haiku cost
  (~$0.00001/call; ~$0.08/day at stage 3 — negligible but not zero, and each
  call consumes 1 unit of the target VM's daily budget via
  `instaclaw_check_and_increment`).
- **Shape:** new route that validates gateway_token + returns 200 without
  forwarding to any provider. Canary could alternate: every Nth run hits the
  full round-trip (real coverage), other runs hit /health (cheap liveness).
- **Trade-off:** loses the "did Anthropic actually respond" signal on most
  runs.

### 3. Canary-budget bypass RPC flag
- **Why:** today the canary consumes 1 unit of the VM's daily budget (via
  `instaclaw_check_and_increment` RPC). We skip canary when VM ≥ 95% of
  limit (see `stepCanaryProbe`). A cleaner fix: extend the RPC with
  `p_is_canary: boolean` that bypasses the increment entirely.
- **Effort:** 1 migration (RPC signature change), 2 callers update (proxy +
  canary path). Opens the door to full-budget VMs still getting canary
  coverage.

## Medium-value — ship before stage 3 if possible

### 4. Percentage-based rollout
- **Why:** allowlist is explicit and deterministic, but for % rollouts
  (1% → 5% → 50%) it's tedious. `STRICT_RECONCILE_PERCENT=10` using
  `hash(vm.id) < threshold` would auto-stage.
- **Trade-off:** loses deterministic "test THIS specific VM" capability.
  Would add AS WELL AS the allowlist, not replace it.

### 5. Per-step canary (catch which config key broke the gateway)
- **Why:** current canary runs AFTER all writes. If it fails we know SOMETHING
  broke but not which config set caused it. Per-step would fire a canary
  after each `config set` and pinpoint.
- **Cost:** 18 canaries per VM per strict reconcile vs 1 today. Stage 3 =
  ~18× more canary volume. Probably worth it for diagnosis; prohibitive for
  always-on.
- **Compromise:** a "bisect" mode that only runs per-step after a failed
  end-of-reconcile canary. Most reconciles stay at 1 canary; only failing
  ones upgrade to 18.

### 6. Signal-threaded cancellation for the outer 180s deadline
- **Why:** `Promise.race` leaves in-flight SSH commands running on the VM
  side when the deadline fires. Next cron cycle re-evaluates (idempotent)
  so the VM doesn't land in bad state, but "deadline fires mid-command →
  VM does a no-op half-write → next cycle fixes" is noisier than
  "deadline fires → VM interrupts cleanly".
- **Shape:** thread an `AbortController` down through every `stepXXX`
  function. ~20 function-signature changes.

## Low-priority — track so it's not forgotten

### 7. DB-backed strict allowlist
- **Why:** env var can hold ~60KB worth of UUIDs (~1600 VMs). We won't hit
  that ceiling soon, but if the fleet grows 10×, migrate the allowlist to
  an `instaclaw_strict_vm_allowlist` table.

### 8. Admin endpoint HTTP surface tests
- **Why:** PR 2's unit tests cover the gate logic. HTTP surface
  (`POST /api/admin/reconcile-vm`, `GET /api/admin/strict-holds`) is
  untested end-to-end. Worth adding when we have a test-harness pattern
  for Next.js route handlers.

### 9. Classes strict mode STILL does not catch (track for awareness)

Even with Option A canary (real Anthropic haiku round-trip + READY
assertion), the following failure classes are NOT covered by strict mode:

- **Non-chat surfaces:** Telegram delivery, Discord, XMTP, video generation,
  skill-specific APIs. Each has its own latent failure modes unrelated to
  config reconcile.
- **Model-specific failures on non-haiku models.** Canary hits haiku. If
  Sonnet-4.6 is broken but haiku works, canary passes while real Sonnet
  users see errors. Mitigation: expand canary to hit sonnet too (cost:
  ~4× current canary cost).
- **Per-user state issues.** Workspace corruption, session bloat, auth-
  profiles drift, ACP auth request expiry. These live in per-user state,
  not config. Strict mode doesn't check them.
- **Schema-valid config with subtle runtime effect.** Example: changing
  `session.reset.idleMinutes` from 10080 to 1 would pass schema validation
  AND pass the canary (gateway works) but silently wipe user sessions
  every minute. Value correctness is beyond strict mode's scope —
  manifest review + canary VM observation is the control.

### 10. x-strict-canary header hardening
- **Why:** current bypass is non-privileged (makes the request more
  expensive, not cheaper) so not exploitable. But if we ever want to
  restrict the header to our own callers (e.g., Vercel IP allowlist or a
  shared signing secret), this is where the work lives.
- **Trigger:** if audit ever shows non-our-IP traffic setting the header.

## When to revisit

After stage 3 completes (fleet-wide strict mode live) and we've observed one
full manifest bump cycle end-to-end:
- Decide if 1/2/3 are launch-blockers for future bumps or still-deferrable.
- Kick 4/5/6 to a "Phase 2d" PR if there's appetite.
- Leave 7/8/9/10 as "when a reason surfaces" work.
