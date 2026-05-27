# ToolRouter v1 — Canary + Free-Fallback Verification Runbook

Operational runbook for Tasks J + K.10 + K.11 of `docs/prd/toolrouter-integration.md`. Run end-to-end before fleet rollout per Rule 64 (vm-canary first, then Cooper-approved fleet push).

## Pre-flight

1. **Cooper completes self-serve signup at toolrouter.world** (~5 min):
   - Visit `https://toolrouter.world/dashboard`
   - Magic-link email → click link → logged in
   - Dashboard auto-bootstraps a Crossmint agent wallet (copy the address)
   - Create an API key in dashboard → receive `tr_...` value
   - Add credits via Stripe Checkout (MVP cap ~$5; can top up later)

2. **Cooper completes AgentBook registration** (~2 min) — UNLOCKS the AgentKit moat. Without this, Scenario B math applies and fleet COGS goes from ~$20/mo to ~$271/mo.
   ```bash
   npx @worldcoin/agentkit-cli register <crossmint-wallet-address-from-step-1>
   ```
   Phone vibrates → World App tap → done. Verify with:
   ```bash
   npx @worldcoin/agentkit-cli status <crossmint-wallet-address>
   ```
   Should return Cooper's human_id (non-null).

3. **Cooper sets Vercel env vars** (Rule 6 — use `printf`, never `echo`):
   ```bash
   printf 'tr_<real-key-from-step-1>' | npx vercel env add TOOLROUTER_API_KEY production
   printf 'true' | npx vercel env add TOOLROUTER_ENABLED production
   printf 'stdio' | npx vercel env add TOOLROUTER_TRANSPORT production
   ```
   Plus Stripe SKU (after creating it in Stripe dashboard at $10 / 100 search pack):
   ```bash
   printf 'price_xxx' | npx vercel env add STRIPE_PRICE_TOOLROUTER_100 production
   ```

4. **Apply the migration** at `supabase/pending_migrations/20260527200000_toolrouter_allocation.sql` via Supabase Studio (Rule 56). Verify with `\d instaclaw_users` showing the 5 new columns + `\df instaclaw_consume_toolrouter_searches` returning the RPC.

5. **Move migration to migrations/**:
   ```bash
   git mv instaclaw/supabase/pending_migrations/20260527200000_toolrouter_allocation.sql instaclaw/supabase/migrations/
   ```

6. **Verify partner-secret verifier passes**:
   ```bash
   npx tsx scripts/_verify-partner-secrets.ts
   ```
   `TOOLROUTER_API_KEY` row should show `ok`.

## Task J — vm-canary canary

Run this AFTER the reconciler has had at least one tick to pick up the new env vars (~3 min after the Vercel deploy).

1. **Pick the active canary VM** (Cooper's choice — current operating standard is whatever VM Cooper is using as the personal-test canary at the time).

2. **Verify the canary VM has the wiring**:
   ```bash
   ssh -i /tmp/ic_ssh_key openclaw@<canary-ip> 'grep ^TOOLROUTER_API_KEY ~/.openclaw/.env | head -c 20; echo; jq .mcp.servers.toolrouter ~/.openclaw/openclaw.json'
   ```
   Should print `TOOLROUTER_API_KEY=tr_` followed by 8 chars, then a JSON block with `"command": "toolrouter"`.

3. **Test prompts via Telegram to the canary's bot**:
   - Prompt 1: *"Search for 5 articles about Edge Esmeralda using a paid search tool"*  
     Expect: agent invokes `exa_search`, returns 5 results in <30s. Reply mentions specific results. AgentKit path → `charged: false` → allocation NOT decremented. Confirm via `GET /api/toolrouter/balance` (same number before and after).
   - Prompt 2: *"Spin up a clean browser session and screenshot example.com"*  
     Expect: `browserbase_session_create` → screenshot URL. AgentKit-access path → `charged: true` → 3 premium searches deducted from balance.
   - Prompt 3: *"Research the top 5 AI infra startups in NYC this month (multi-step)"*  
     Expect: `manus_research_start` → polling → final synthesis. First 2/mo free (AgentKit cap), then 8 (standard) or 15 (deep) deducted per call.

4. **Per-call cost cross-check**: every call should appear in `instaclaw_toolrouter_call_log` with `path`, `allocation_source`, and `amount_usd` populated. Query:
   ```sql
   SELECT endpoint_id, path, allocation_source, amount_usd, weight, ts
   FROM instaclaw_toolrouter_call_log
   WHERE user_id = '<cooper-user-id>'
   ORDER BY ts DESC LIMIT 20;
   ```

5. **Sum should match ToolRouter dashboard** balance burn for the canary window.

## Task K.10 — Upsell flow canary

This is the user-visible payment flow. Run on the same canary VM.

1. **Temporarily lower Cooper's allocation override** to force the upsell to fire:
   ```sql
   UPDATE instaclaw_users SET toolrouter_grant_override = 5 WHERE id = '<cooper-user-id>';
   ```

2. **Wait for the next reconcile tick** so `TOOLROUTER_BALANCE` env in `~/.openclaw/.env` updates to 5 (or whatever remains after current cycle's consumption).

3. **Send a deep Manus research prompt** (15 weight, exceeds the 5-cap):
   *"Do a deep research dive on the top 10 AI infra startups in NYC, with their funding histories"*
   
   Expect: agent emits M1 pre-action transparency hint THEN OR INSTEAD-OF the M3 100%-reached message with two equal paths.

4. **Reply with "(b)"** to pick the paid path.

5. **Expect**: agent returns a Stripe Checkout URL pointing at the `toolrouter_100` pack.

6. **Open the URL in browser**, complete a test purchase (use Stripe test card `4242 4242 4242 4242` if `STRIPE_ALLOW_LIVE_CHECKOUT=true`; otherwise temporarily set the toolrouter env var to a test-mode price ID).

7. **Webhook fires**: verify `instaclaw_users.toolrouter_topup_balance` increased by 100 via:
   ```sql
   SELECT toolrouter_topup_balance FROM instaclaw_users WHERE id = '<cooper-user-id>';
   ```

8. **Send next message**: expect agent emits M4 ("100 added. running ... now.") with the deep research result.

9. **Reset Cooper's allocation override** post-canary:
   ```sql
   UPDATE instaclaw_users SET toolrouter_grant_override = NULL WHERE id = '<cooper-user-id>';
   ```

## Task K.11 — Free-fallback adequacy verification

Cooper's mandate: *"if the free fallback is garbage, the upsell feels like extortion."* Verify the free path returns usable results BEFORE shipping.

Temporarily disable ToolRouter on the canary VM to force free-fallback:
```bash
ssh -i /tmp/ic_ssh_key openclaw@<canary-ip> 'sed -i "s/^TOOLROUTER_API_KEY=.*/TOOLROUTER_API_KEY=tr_disabled_for_test/" ~/.openclaw/.env'
```

Send each of the following prompts and confirm the agent produces a USEFUL response using only free tools:

1. *"Find the latest news about Edge Esmeralda"* → Brave Search via `BRAVE_API_KEY`. Expect: 3-5 recent links, agent summarizes top 2.
2. *"Research the top 5 AI infra startups in NYC"* → Brave + curl + manual chaining. Expect: a respectable list with names + brief funding context. May be less polished than Manus but should NOT be "I can't help with this."
3. *"Screenshot example.com"* → local `chromium`. Expect: PNG file path returned + agent sends it via Telegram.
4. *"Extract the headlines from cnn.com"* → curl + jq. Expect: 10 headlines parsed. May miss JS-rendered items.
5. *"Send an email to my landlord"* → agent should acknowledge there's no good free email path, offer to draft a message Cooper can copy-paste, OR ask if Cooper wants to add a premium pack.

If ANY of 1-4 returns "I can't help" or garbage, the free-fallback table in §5.3.3a / §16.2 needs revision before fleet ship.

Restore the API key after testing:
```bash
ssh -i /tmp/ic_ssh_key openclaw@<canary-ip> 'sed -i "s/^TOOLROUTER_API_KEY=.*/TOOLROUTER_API_KEY=<real-key>/" ~/.openclaw/.env'
```
Or let the next reconcile tick restore it.

## Fleet rollout (only after all of above passes)

Per Rule 64: Cooper sends explicit "ship it to fleet" in chat. THEN:

1. Bump `VM_MANIFEST.version` in `lib/vm-manifest.ts` (forces all cv-stale VMs to re-reconcile).
2. Add changelog entry under §11 Decision Log of the PRD documenting the cv bump.
3. Push to main. Vercel deploys.
4. Watch reconciler logs for ~30 min. Should see all 150 VMs converge to having `mcp.servers.toolrouter` on disk + non-zero `TOOLROUTER_BALANCE` in `.env`.
5. Run coverage script:
   ```bash
   npx tsx scripts/_coverage-toolrouter.ts --verbose
   ```
   All sampled VMs should pass env + mcp + (eventually) balance checks.
6. Cooper sends a real prompt to a non-canary user's bot (random sample) to confirm the wiring works there too.

## Rollback path (if something breaks)

1. Flip the gate:
   ```bash
   printf 'false' | npx vercel env add TOOLROUTER_ENABLED production
   ```
2. Next reconcile tick: `stepToolRouter` Gate 1 short-circuits. The
   `mcp.servers.toolrouter` block REMAINS on disk (cold storage), but the
   v1 ship state was off-by-default, so this is the rollback target.
3. For a full hot rollback (remove the MCP config from disk): write a one-shot
   `_rollback-toolrouter-mcp.ts` script that runs `openclaw mcp delete toolrouter`
   on each VM. Hot-reloadable; agent's next tick doesn't see ToolRouter.

## Post-ship metrics (review weekly per §15.8)

Three observability metrics drive v1.5 allocation tuning:

1. **% of calls on `sponsored_agentkit`** — World pays. Watch for this dropping (AgentKit cap exhaustion, AgentBook registration lapsed).
2. **% of users hitting allocation each month** — target 10-15% per Cooper's reframe. <5% = allocations too generous; >25% = allocations too tight.
3. **Top-up conversion of hitters** — target 8-15%. Tune copy in §5.3.3 if too low.

Adjust via `instaclaw_users.toolrouter_grant_override` (per-user) or `TOOLROUTER_TIER_GRANTS` constant (fleet-wide, requires manifest bump per Rule 47).
