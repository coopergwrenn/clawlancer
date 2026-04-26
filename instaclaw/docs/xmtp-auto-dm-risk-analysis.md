# XMTP Auto-First-Message — Risk Analysis

**Feature branch:** `feat/xmtp-auto-first-message`
**Author:** Claude (synthesized for Cooper, 2026-04-26)
**Scope:** the three-file change that lets a freshly provisioned agent greet its owner in World Chat without user interaction.

## Threat model

The change touches the VM provisioning critical path. Provisioning healthy is a hard requirement for inbound traffic (currently elevated due to the World Build talk launch). A regression that breaks provisioning is the worst-case outcome — worse than the feature failing to fire.

## Risks, ranked

### 1. (HIGH) Provisioning critical path

**Impact:** new sign-ups can't get a working agent. Direct revenue impact.

**Surface:** the new code sits inside the existing `after(async () => { ... })` block in `vm/configure/route.ts`. That block already exists; we extended it.

**Defenses:**
- The whole XMTP block is wrapped in two layers of try/catch. Existing pattern says "non-fatal" for setupXMTP failures.
- The new Supabase lookup is in its own try/catch. If it throws, `userWalletAddress` stays `undefined` and setupXMTP runs in legacy mode.
- The greeting send itself is fire-and-forget INSIDE the agent process running on the VM. It does not run on the Vercel side. No way for it to break the configure response.
- setupXMTP's 15-second address-file poller is unchanged — the start handler writes the address file synchronously BEFORE spawning the greeting work, so the poller is not delayed.

**Residual risk:** very low. The greeting code is fully isolated from the configure response.

### 2. (MEDIUM) Greeting fires but message never lands in World Chat

**Impact:** user thinks the feature is broken even though the agent is working. Trust hit, support ticket volume.

**Surface:** several failure modes:
- User's wallet is not yet XMTP-enabled (brand-new World ID wallet)
- XMTP network is slow or transient relay outage during the send
- `createDmWithAddress` succeeds but `sendText` silently drops on a network blip
- Wallet exists but the user has the World App backgrounded — message lands but no notification

**Defenses:**
- We log every failure with structured log lines that grep cleanly: `Failed to send proactive greeting`.
- Marker file is only written on confirmed success — failures retry on next agent restart.
- `Restart=on-failure` in the systemd unit means an agent crash-loop attempts the send up to a few times automatically.

**Residual risk:** moderate. We will see some users who never get the proactive greeting. The reactive path (commit fb5612c's "World Chat" button) is still there as a fallback, so those users can still establish the DM by tapping the button.

### 3. (MEDIUM) User completes World ID AFTER VM is provisioned

**Impact:** silent feature gap — the user who eventually verifies World ID doesn't get a greeting because their VM was set up without the env var.

**Surface:** `setupXMTP` is idempotent (skips if `xmtp_address` is already set). On a re-configure for an already-set-up VM, the function returns early and never re-writes the env file. So even if `world_wallet_address` is populated later, the agent's env never gets `USER_WALLET_ADDRESS`.

**Defenses:** none in this PR. Out of scope for v1.

**Residual risk:** known limitation. Document follow-up:

> _Follow-up_: separate code path (e.g., a "post-World-ID-verification" hook or a once-per-VM backfill cron) to write `USER_WALLET_ADDRESS` to the agent env and restart the service for VMs whose user verified World ID after initial setup. Not blocking — affected users can still tap "World Chat" to trigger the fb5612c reactive path.

### 4. (LOW) Existing production VMs never get the auto-greeting

**Impact:** the feature only benefits NEW VMs provisioned after the deploy. Existing fleet (~250+ VMs as of writing) keeps reactive-only behavior.

**Surface:** existing VMs were configured without `USER_WALLET_ADDRESS` in their agent env. Their `setupXMTP` won't re-run unless explicitly re-invoked.

**Defenses:** none in this PR — by design. Backfilling existing VMs is a fleet-wide operation that should be a separate, opt-in script with `--test-first` and `--dry-run` flags per project rule #3 / #4.

**Residual risk:** acceptable. Existing users keep their current experience (reactive button works fine). New users get the upgraded UX.

### 5. (LOW) Malformed wallet address in the DB

**Impact:** an attempt to send to a malformed address could throw, fail, or behave unpredictably in the XMTP SDK.

**Surface:** `world_wallet_address` is populated by the World ID verification flow. Bad data could come from a race condition, a manual DB edit, or an SDK version bump that changes the format.

**Defenses:** server-side regex `/^0x[a-fA-F0-9]{40}$/` in `setupXMTP` PLUS agent-side regex with the same pattern. Defense in depth: even if the env var slips through one check, the other catches it. Both log when they trip.

**Residual risk:** very low.

### 6. (LOW) Provisioning speed impact

**Impact:** a slower configure response degrades user experience.

**Surface:** the new code adds one Supabase SELECT inside the `after()` block. The `after()` block runs AFTER the response is sent — so it cannot affect the response time the user sees. The Supabase select is a single-row primary-key lookup (instaclaw_users by id) — sub-50 ms on average.

**Defenses:** the new lookup is in the post-response background path. Zero impact on the configure response time.

**Residual risk:** none observed. Provisioning latency stays within the existing 60-150 s window.

### 7. (LOW) Sensitive data leak in logs

**Impact:** if logs leak wallet addresses to third parties (Datadog, Vercel logs, etc.), the user's on-chain identity is partially exposed.

**Surface:** the agent log line `Proactive greeting sent { target: "0xABC..." }` includes only the first 10 chars of the wallet (truncated). The server-side warn for malformed addresses also truncates. `journalctl` on the VM logs the full address one time at greeting send.

**Defenses:** truncation in user-facing log lines. Full address only in agent-VM journalctl which is not centralized. Acceptable.

**Residual risk:** very low.

## Monitoring recommendations (for after deploy)

These are NOT in this PR. Recommended follow-up if we promote to fleet-wide:

1. **Add a `proactive_greeting_sent_at` timestamp column to `instaclaw_vms`.** Backfilled by an admin endpoint that the agent hits once on successful greeting send. Lets us answer "what % of new VMs sent the greeting in the first 60 s?" via SQL.

2. **Alert on greeting-failure log volume.** Pattern: `Failed to send proactive greeting` in journalctl. Cron-tail logs from a small VM sample, alert if rate exceeds 5% of new VMs/day.

3. **Add to `/api/admin/audit-fleet-health`.** A new check that grep's recent journalctl on each VM for `Proactive greeting sent` and reports the % that have it. Lets us see drift over time.

## Summary verdict

- **Code-level risk to provisioning critical path:** very low (multiple try/catch layers, no synchronous changes to configure response).
- **User-facing risk:** moderate but bounded — failures fall back to the existing reactive button (fb5612c).
- **Known limitations:** existing VMs won't auto-upgrade; users who verify World ID after configure won't get the greeting. Documented as follow-ups.
- **No new dependencies, no schema changes, no secret handling changes.**

Recommended posture: deploy to a Vercel preview, run the test plan against ONE fresh VM, validate Pass Criteria, then proceed to fleet-wide via the project's mandatory `--test-first` then `--dry-run` rollout sequence (CLAUDE.md rules #3 + #4).
