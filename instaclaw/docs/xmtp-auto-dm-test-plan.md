# XMTP Auto-First-Message — Test Plan

**Feature branch:** `feat/xmtp-auto-first-message`
**Commit:** `4487716` (code) + docs commit
**Tested against:** one fresh test VM provisioned from production snapshot, never on existing production VMs.

---

## Pre-flight

1. Confirm feature branch is checked out: `git rev-parse --abbrev-ref HEAD` → `feat/xmtp-auto-first-message`.
2. Confirm Vercel preview deploy is up for this branch (Vercel auto-deploys feature branches as preview URLs).
3. Have the test user's World ID-verified wallet ready (so `instaclaw_users.world_wallet_address` is populated).
4. Have a fresh `ready` VM in the pool that has NOT been assigned yet.

## One-VM single-user test

### Step 1 — assign the VM to the test user

Use the staging billing webhook or admin endpoint to assign one specific ready VM to the test user account. Do NOT use production billing.

### Step 2 — trigger configure via the preview URL

Hit `POST /api/vm/configure` on the Vercel preview deploy with the test user's mini-app token. This kicks off `configureOpenClaw()` synchronously and the XMTP `after()` block in the background.

### Step 3 — observe the agent setup logs on the VM

SSH into the assigned VM:

```
ssh -i <key> openclaw@<vm-ip>
journalctl --user -u instaclaw-xmtp -f
```

Wait for these log lines (in order) within ~30 s of configure firing:

| Look for | Meaning |
|---|---|
| `Loaded XMTP env from /home/openclaw/.openclaw/xmtp/.env` | env file written, agent reading it |
| `XMTP agent started. Address: 0x...` | agent connected to XMTP network |
| `Address written to /home/openclaw/.openclaw/xmtp/address` | setupXMTP poller will see this and mark success |
| `Proactive greeting sent { target: "0xABC..." }` | **the new behavior — confirms greeting fired** |

If `USER_WALLET_ADDRESS not set — skipping proactive greeting (reactive mode)` appears instead: the user's `world_wallet_address` was null at configure time. Verify the user is World ID verified and that the column is populated.

### Step 4 — verify the marker file

```
cat ~/.openclaw/xmtp/.greeting-sent
```

Should print an ISO timestamp. Confirms the idempotency marker was written.

### Step 5 — verify in World Chat from the test user's phone

Open World App → World Chat. The agent's DM should already be there, with the canonical fb5612c greeting visible:

> "Hey! I'm your InstaClaw agent. You can chat with me right here in World Chat — same AI, same skills, same memory as Telegram and the mini app."

**Critical:** the test user must NOT have tapped any "World Chat" button. The DM should appear without any user-side action beyond completing configure.

### Step 6 — restart the agent and confirm idempotency

```
systemctl --user restart instaclaw-xmtp
journalctl --user -u instaclaw-xmtp -n 20
```

Look for: `Proactive greeting already sent (marker present) — skipping`. Confirms the marker prevents re-greeting on `Restart=on-failure`.

### Step 7 — reply from the user side, confirm reactive flow still works

User sends a message in World Chat. Agent should respond normally (Claude reply via gateway). Confirms the new code did not regress reactive messaging.

## Failure-mode checks

Run each in isolation on a separate test VM (do NOT chain).

| Scenario | Setup | Expected behavior |
|---|---|---|
| User has no World ID | `world_wallet_address IS NULL` | Log: `USER_WALLET_ADDRESS not set — skipping proactive greeting (reactive mode)`. Agent remains reactive-only. No crash. |
| Malformed wallet column (data corruption sim) | Manually set `world_wallet_address = '0xnotvalid'` in staging DB | Log: server-side warn `setupXMTP: malformed userWalletAddress, skipping USER_WALLET_ADDRESS env`. Env var never written. Agent runs reactive-only. |
| XMTP relay slow/down at start | Trigger configure during a known-bad XMTP window or simulate by null-routing relay IP | Log: `Failed to send proactive greeting`. Marker NOT written. Agent restarts (`Restart=on-failure`) and retries the send on next start. |
| User wallet not yet on XMTP | Use a brand-new World ID wallet that has never opened World App / World Chat | Send may succeed (XMTP supports send-to-address even before recipient activation) — message lands when recipient activates. If send fails, marker not written, retry on restart. |
| Supabase lookup fails | Block staging Supabase egress on the Next.js side | Log: `XMTP user wallet lookup failed (proceeding without proactive greeting)`. setupXMTP runs without the env var. Agent reactive-only. |

## Rollback validation steps

If the feature behaves badly in staging:

1. On the affected VM, stop service: `systemctl --user stop instaclaw-xmtp`
2. Edit `~/.openclaw/xmtp/.env` and remove the `USER_WALLET_ADDRESS=` line
3. Delete marker: `rm ~/.openclaw/xmtp/.greeting-sent`
4. Restart: `systemctl --user start instaclaw-xmtp`
5. Confirm log shows `USER_WALLET_ADDRESS not set — skipping proactive greeting (reactive mode)`. VM is back to pre-feature behavior.

For full rollback (revert the feature branch deploy):

1. `git revert 4487716` on a hotfix branch
2. Vercel auto-redeploys
3. New VMs no longer get the env var, behave as before
4. Existing VMs that already received a greeting are unaffected (greeting was already delivered)

## Pass criteria

All of the following must hold before promoting to fleet-wide deploy:

- [ ] Step 3 shows `Proactive greeting sent` log line on at least one fresh VM
- [ ] Step 5 shows the message in World Chat without user interaction
- [ ] Step 6 shows the idempotency log on agent restart
- [ ] Step 7 confirms reactive replies still work
- [ ] All five failure-mode checks behave as expected
- [ ] Rollback step 5 returns the VM to pre-feature behavior
