# Edge Esmeralda 2026 — Pre-Launch Pre-Flight Checklist

**Audience**: Cooper, immediately after the P0 + P1 fix bundle deploys.
**Time to run**: ~10 minutes end-to-end.
**Goal**: confirm every external system the channel-first funnel depends
on is wired correctly before texting the test phone.

Two things in this checklist can ONLY be verified outside the codebase:
the Sendblue dashboard's webhook configuration and the actual Telegram
webhook registration. Everything else is covered by automated checks
or the manual E2E test at the bottom.

---

## 1. Telegram shared-bot webhook registration

The token is Sensitive-flagged in Vercel so `vercel env pull` returns
empty for the local registration script. Use the new admin endpoint
that runs in Vercel's serverless context (where the secret IS visible).

**Step 1a — register the webhook:**

```bash
curl -X POST https://instaclaw.io/api/admin/telegram-shared-bot-webhook \
  -H "X-Admin-Key: $ADMIN_API_KEY" | jq
```

Expected response:
```json
{
  "ok": true,
  "registeredUrl": "https://instaclaw.io/api/telegram/shared-bot/inbound",
  "telegram": { "ok": true, "result": true, "description": "Webhook was set" }
}
```

**Step 1b — verify Telegram accepted it:**

```bash
curl https://instaclaw.io/api/admin/telegram-shared-bot-webhook \
  -H "X-Admin-Key: $ADMIN_API_KEY" | jq
```

Expected `info` block:
```json
{
  "url": "https://instaclaw.io/api/telegram/shared-bot/inbound",
  "has_custom_certificate": false,
  "pending_update_count": 0,
  "last_error_message": null,         ← MUST be null/absent
  "last_error_date": null,
  "max_connections": 40,
  "allowed_updates": ["message"]
}
```

If `last_error_message` is set, Telegram's delivery attempts are
failing. Read the error string — usually it's a stale URL (wrong
deployment), a TLS issue, or our endpoint returning 5xx.

---

## 2. Sendblue dashboard configuration

Cooper has to check this on the Sendblue dashboard (sendblue.co/dashboard)
— we have no API surface that exposes it. Open the dashboard and confirm
each item below.

| # | What to check | Expected | Where |
|---|---|---|---|
| 2.1 | Account number assigned | `+1 (407) 242-5197` matches `SENDBLUE_FROM_PHONE` | Account / Numbers |
| 2.2 | Inbound webhook URL | `https://instaclaw.io/api/imessage/inbound` | Webhooks tab |
| 2.3 | Inbound webhook secret | matches `SENDBLUE_WEBHOOK_SECRET` in Vercel (Sensitive — can't compare directly, but the production probe at the bottom of this doc proves it works) | Webhooks tab |
| 2.4 | Webhook events subscribed | `Receive` (inbound messages) | Webhooks tab |
| 2.5 | Number type | iMessage-capable (dedicated, not shared / non-iMessage SMS only) | Account / Numbers |
| 2.6 | Account credit / spend limits | Enough credit to send at least 5000 messages (~$25-50 budget for launch) | Billing |
| 2.7 | Anti-spam filter | Verify our number is NOT flagged. Try sending one outbound to a test phone to confirm delivery works. | Outbound test |

**Production probe (verifies webhook secret end-to-end):**

```bash
# no header → should return 401, NOT 500
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST \
  https://instaclaw.io/api/imessage/inbound \
  -H "Content-Type: application/json" -d '{}'
```

Expected: `HTTP 401` with body `{"error":"Missing signing secret"}`. If
you get `HTTP 500` with `"Webhook not configured"`, the env var got
unset and Sendblue inbound is dead — investigate Vercel env.

---

## 3. EdgeOS bearer token (carryover from 2026-05-24 audit)

The May 24 audit flagged EDGEOS_EVENTS_BEARER_TOKEN as a P0. It was
provisioned but is Sensitive-flagged so we can't verify the value from
CLI. Run the existing verifier:

```bash
cd /Users/cooperwrenn/wild-west-bots/instaclaw
npx tsx scripts/_verify-edgeos-api-key.ts
```

Expected: 9/9 edge VMs show `EDGEOS_API_KEY` present in both DB and
on-disk `.env`, with matching values. Any miss → re-mint per the
"EdgeOS bearer split" runbook in CLAUDE.md.

---

## 4. Pool capacity for launch surge

Per the P0-2 → item 5 fix: channel-first cloud-init now works, so pool
exhaustion is no longer a hard fail. Still, pool path is faster (~30s
vs ~5min cloud-init), so size for the burst.

**Check current pool:**

```bash
psql ... -c "SELECT count(*) FROM instaclaw_vms WHERE status='ready';"
# or via Supabase Studio
```

**For ~1000 Edge attendees signing up over 5 days at peak ~30/hr:**
- Default `POOL_TARGET=15`, `POOL_FLOOR=10`, `MAX_PER_RUN=10`, replenish every 5min
- **Recommended bump**: `POOL_TARGET=30`, `MAX_PER_RUN=15`. Covers ~180 signups/hr peak.
- Configured in `app/api/cron/replenish-pool/route.ts` constants.

---

## 5. End-to-end smoke test (the bar Cooper sets)

After steps 1-4 pass, this is THE test that proves everything works.

1. Text `+1 (407) 242-5197` from a test phone with the body `edge` (or `hi`).
2. Within 5 seconds: receive Welcome 1, Welcome 2, Welcome 3 (link).
3. Tap the link → should land on `/auth`.
   - If you texted `edge`, the URL should include `?p=edge_city` and the
     downstream flow skips `/plan`.
4. Pick OAuth provider (ChatGPT or Google).
5. After OAuth:
   - Non-Edge: lands on `/plan` → pick a tier → enter card (test mode if
     possible per option (1) in the P0 audit) → Stripe Checkout success.
   - Edge: lands directly on `/onboarding/done` (skips `/plan`).
6. Fill personalization form (or skip).
7. Submit.
8. Within ~30-90s, receive M_RETURN from the agent — should be a REAL
   LLM response in the agent's voice, NOT the template.
   - If it's the template ("hey [name]. ready when you are. what do
     you want to do first?"), the gateway call timed out / failed —
     check Vercel logs for `[m-return-dispatch] gateway` warnings.
9. **Reply with a real question** like "what's the weather in healdsburg?"
10. Agent should actually respond. Multi-turn should work — try
    follow-ups, ask about preferences you mentioned, etc.

If step 9 fails (silence), the channel-routing relay is broken — check
Vercel logs for `forwardInboundToVm` errors.

If step 8 falls back to template, the gateway is up but slow / config
mismatch on the agent — check the VM's `/health` endpoint via Linode
dashboard.

---

## 6. Operational rollback cheatsheet

If something is broken post-deploy and you need to revert just the
2026-05-27 changes:

```bash
cd /Users/cooperwrenn/wild-west-bots
git log --oneline | head -10
# Find the commit hash for the items-1-9 bundle. Revert with:
git revert -m 1 <commit-hash>
git push origin main
```

P0 fixes from earlier today are commit `6bf5a703` — DON'T revert that
or the channel-routing breaks again.
