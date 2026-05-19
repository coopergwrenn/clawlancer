# Phase 1 Design Document — Login with ChatGPT

**Companion to:** [chatgpt-oauth-history-import.md](./chatgpt-oauth-history-import.md), [chatgpt-oauth-history-import-decisions.md](./chatgpt-oauth-history-import-decisions.md), [chatgpt-oauth-phase-0-spike-report.md](./chatgpt-oauth-phase-0-spike-report.md), [chatgpt-oauth-phase-0.5-spike-report.md](./chatgpt-oauth-phase-0.5-spike-report.md), [chatgpt-oauth-phase-1-implementation-plan.md](./chatgpt-oauth-phase-1-implementation-plan.md)
**Date:** 2026-05-19
**Status:** Awaiting Cooper review. Once approved, engineering starts with the backend OAuth flow.
**Read first:** §0 (TL;DR), §1 (user journey), §3 (Telegram UX wireframes), §6 (reconciler integration)
**Skip if short on time:** §2 (competitive synthesis — depth research, lessons in §3), §11 (open questions — mostly answered)

---

## 0. TL;DR — what we're building

A user with an existing InstaClaw Anthropic-powered Telegram agent and a ChatGPT Plus subscription opens our dashboard or types `/connect-chatgpt` to their bot. We run the **device-code OAuth flow** (verified working from Linode us-east in Phase 0; verified natively supported by OpenClaw 2026.4.26 in Phase 0.5). The user authorizes in their browser. We capture their bearer JWT + refresh token, encrypt at rest, write an `openai-codex:default` profile to their VM's `auth-profiles.json`, and switch the agent's default model to `openai-codex/gpt-5.5`. From that point, every primary chat goes to `https://chatgpt.com/backend-api/codex/responses` charged against their Plus subscription. Heartbeats stay on our Anthropic Haiku. Embeddings stay on our OpenAI key. They can switch back to Claude at any time via `/model`.

**Phase 1 explicitly defers** (decisions doc Q4/Q9/Q15-Q23):
- Auto-fallback on 429 ("the moat") — Phase 1.5, ~1-2 weeks
- History import + restricted vault + multi-user detection — Phase 2, ~6 weeks
- Per-message `@gpt` mid-conversation override (Poe pattern) — Phase 1.5
- Side-by-side model comparison — Phase 3

**Phase 1 ships in 4 weeks** (after Edge Esmeralda closes May 30):
- Week 1: OAuth backend + DB migration + encryption helper
- Week 2: Device-code routes + reconciler step + extension of `buildAuthProfilesJson`
- Week 3: Telegram `/connect-chatgpt` + dashboard "Models & Providers" UI + Stripe price IDs
- Week 4: Refresh cron + monitoring + canary VM + 5-user beta

**Confidence: HIGH.** Both Phase 0 (the OAuth flow itself, from a Linode us-east IP) and Phase 0.5 (OpenClaw's native support for the OAuth profile shape) passed decisively. The integration points in the existing codebase (`buildAuthProfilesJson`, `stepAuthProfiles`, `stepEnforceModelPrimary`, `configureOpenClaw` privacy guard, freeze tarball exclusion of `auth-profiles.json`) are all read end-to-end and the diffs are small.

**One important calibration from the competitive research.** A research agent claimed "there is no way for a third-party app to use a user's ChatGPT Plus/Pro subscription — Plus and API are billed separately." This is **half true and half wrong**. It's true that you can't use a Plus user's API quota for direct OpenAI API key calls. It's wrong about the OAuth path: the Codex device-code flow returns a bearer JWT that **does** authenticate against `chatgpt.com/backend-api/codex/responses` and **does** charge usage against the Plus subscription. Phase 0 ran 10 successful inferences with Cooper's real Plus account. We have ground truth that the general internet doesn't have. The marketing positioning is the user's ChatGPT subscription powers their InstaClaw agent.

---

## 1. User journey mapping

Two primary entry points: web dashboard (high-discoverability, supports first-time onboarding) and Telegram bot (high-conversion, the surface a paying user already lives in). Both routes converge at the same OAuth flow.

### 1.1 Discovery — how the user learns this exists

| Surface | Mechanism | Trigger condition |
|---|---|---|
| Twitter announcement (2026-05-18, already shipped) | "Login with ChatGPT coming soon" thread | Cold prospects |
| Dashboard banner on first login post-launch | Persistent dismissible banner: "NEW · Bring your ChatGPT subscription" | Every paying user |
| Telegram bot `/help` text update | Append: "💡 You can now use your ChatGPT Plus subscription. Type /connect-chatgpt" | Every paying user |
| Telegram proactive message (one-time, opt-in) | Bot DMs each user once: "Your ChatGPT Plus subscription can power your agent. Want to connect? It takes 60 seconds." | Top decile by msg volume — they'll feel the cost relief most |
| Onboarding flow for new signups | New step in `/onboarding/plan` showing 3 modes: bundled Claude / BYOK Anthropic / Connect ChatGPT | New users only |
| Limit-hit upsell | When user hits daily Sonnet cap, the friendly upsell message includes "Or connect your ChatGPT subscription for unlimited GPT-5.5" | Heavy users |

**Decision:** ship the dashboard banner + Telegram `/help` text update + onboarding step on day 1. Defer the proactive Telegram DM to week 5 (post-beta) — proactive comms is high-risk-of-perceived-spam.

### 1.2 Trigger — starting the connect flow

Three entry points all converge on the same backend route `POST /api/auth/openai/device-code/start`:

1. **Dashboard:** click "Connect ChatGPT" button in `/dashboard/settings/integrations` (NEW page) or in the dashboard banner.
2. **Telegram bot:** type `/connect-chatgpt` (or the simpler `/connect chatgpt`).
3. **Onboarding flow:** select "Use my ChatGPT Plus subscription" on the plan-picker page (new option).

All three flows hit the same backend that:
- Generates a state nonce, persists row in `instaclaw_oauth_device_flows`
- POSTs to `https://auth.openai.com/api/accounts/deviceauth/usercode` with `client_id=app_EMoamEEZ73f0CkXaXp7hrann`
- Returns `{user_code, device_auth_id, verification_uri, interval, expires_in}` to the calling client (dashboard JS or Telegram bot)

### 1.3 The OAuth device-code dance — what the user sees

This is the most critical 60 seconds. The user needs to (a) see the code and URL clearly, (b) trust the flow is legit, (c) get confirmation when it's done. **Three different surfaces, all of which we must polish.**

#### 1.3.1 Dashboard surface (web)

A modal opens (does not navigate away — preserves dashboard context):

```
┌────────────────────────────────────────────────┐
│   Connect ChatGPT                          [X] │
├────────────────────────────────────────────────┤
│                                                 │
│   To use your ChatGPT subscription with         │
│   InstaClaw:                                    │
│                                                 │
│   ① Open this page in your browser:            │
│                                                 │
│   ┌─────────────────────────────────────────┐  │
│   │   auth.openai.com/codex/device          │  │
│   │   [Open in new tab →]                   │  │
│   └─────────────────────────────────────────┘  │
│                                                 │
│   ② Enter this code:                           │
│                                                 │
│              92PM-PLU8N                         │
│              [Copy code]                        │
│                                                 │
│   ③ Sign in to OpenAI and click "Authorize"    │
│                                                 │
│   Code expires in 14:32                         │
│                                                 │
│   ⏳ Waiting for you to authorize…             │
│                                                 │
│   [Cancel] [I authorized, refresh status]      │
└────────────────────────────────────────────────┘
```

Behind the scenes, JS polls `POST /api/auth/openai/device-code/poll` every 5s (the interval OpenAI returned). On 200 with `{status: "completed"}`, the modal transitions to:

```
┌────────────────────────────────────────────────┐
│   ✓ Connected to ChatGPT Plus              [X] │
├────────────────────────────────────────────────┤
│                                                 │
│   Your account: coop***@gmail.com               │
│   Plan: ChatGPT Plus                            │
│                                                 │
│   Default model for your agent:                 │
│   GPT-5.5 (Codex)                               │
│                                                 │
│   Anthropic Claude stays available for          │
│   fallback. You can switch defaults anytime     │
│   from Settings → Models.                       │
│                                                 │
│   Updating your agent's configuration…          │
│   ▓▓▓▓▓▓▓▓▓░░░ (~30 sec, reconciler tick)      │
│                                                 │
│   [Done] [Use Claude instead]                   │
└────────────────────────────────────────────────┘
```

On error (token expired, OAuth declined, our backend hiccup), explicit error states per §1.7.

#### 1.3.2 Telegram surface — the load-bearing UX

**This is where the magic happens.** Users live in Telegram day-to-day. The connect flow must feel native to chat, not like a developer tool.

User initiates:
```
User: /connect-chatgpt
```

Bot reply (single message, edits in place as state changes):
```
🔑 Connect your ChatGPT subscription

To use GPT-5.5 with this agent, authorize InstaClaw 
to use your ChatGPT Plus account.

Tap to open OpenAI's authorization page:
👉 auth.openai.com/codex/device

Enter this code when prompted:

       92PM-PLU8N

Code expires in 15 min.

⏳ Waiting for you to authorize…
```

Bot edits this message every 3-5 seconds:
- Countdown updates ("14:32 → 14:28 → ...")
- Spinner emoji cycles (`⏳ → ⏰ → ⏳`)

On completion, the message edits to:
```
✓ Connected to ChatGPT Plus

I'll use GPT-5.5 by default from now on.

Switch back to Claude anytime with /model.
Disconnect with /disconnect-chatgpt.

🔄 Reconfiguring your agent... (this takes ~30 sec)
```

Then ~30 seconds later (after the reconciler tick + gateway restart):

```
✓ Connected to ChatGPT Plus

I'll use GPT-5.5 by default from now on.

Try me — ask me anything.
```

The user can immediately send their next message. Their agent's reply comes from GPT-5.5.

**Critical design choices and the reasoning:**

- **One message, edited in place** — not five new messages. Keeps the chat clean. Matches the canonical Telegram bot pattern (per the research agent's findings on `terranc/claude-telegram-bot-bridge`).
- **The URL is shown plainly** — not hidden behind a button — because Telegram users want to long-press to copy, share to another device, or just see the domain. Hidden buttons feel sus.
- **The code is in its own line, monospace, large** — Telegram renders code blocks distinctively. The user needs to be able to read it in one glance.
- **Expiration countdown is concrete (15 min)** — not vague ("soon"). Reduces anxiety, encourages immediate action.
- **The "I'll use GPT-5.5 from now on" line is critical** — sets expectations. Without it, the user has no idea what changed.

#### 1.3.3 Onboarding surface (new users)

Extends the existing `/onboarding/plan` page. Currently shows two tiers per the codebase audit: all-inclusive (bundled Claude) and BYOK (user's Anthropic key). New third option:

```
Choose your model setup:

  ⓘ  Bundled (default)
     Claude Opus 4.7 — Anthropic billing handled by us
     Starter $29 · Pro $99 · Power $299

  ⚙️  Bring your own Anthropic key (BYOK)
     Use your Anthropic API account · we charge infra only
     Starter $14 · Pro $39 · Power $99

  🆕  Connect your ChatGPT (NEW)
     Use your ChatGPT Plus / Pro subscription · GPT-5.5
     Starter $19 · Pro $49 · Power $149
     [Most popular for ChatGPT power users]
```

Selecting "Connect ChatGPT" routes to the dashboard modal flow (§1.3.1) BEFORE Stripe checkout — we want OAuth grant BEFORE collecting payment, so if the OAuth fails we don't take their money. Once OAuth completes, then Stripe checkout, then VM provisioning, then first message.

### 1.4 What changes in the agent's behavior after connecting

Material changes the user will notice:

| Change | Visible to user? | Surfacing strategy |
|---|---|---|
| Primary model is now GPT-5.5 instead of Claude Opus 4.7 | YES — replies feel different | Send the "✓ Connected" confirmation message; subtle reminder in `/help` text |
| Their daily message cap effectively doesn't apply (we don't credit-debit primary chat) | YES — they can send 1000s of messages/day | Update dashboard usage chart to show "ChatGPT mode — no daily cap" instead of "X/600 today" |
| Latency may shift (GPT-5.5 cold-start vs Claude cold-start) | Probably not — both ~3-8s | None |
| Telegram persona / SOUL.md is unchanged | NO | None (the persona is plumbing — see §3 below) |
| Skills work identically (Bankr, dgclaw, etc.) | NO (they continue to work) | None |
| Heartbeats keep using Anthropic Haiku at 3h interval | NO (background) | None |
| Embedding-based memory recall still works (OpenAI text-embedding-3-large via our key) | NO | None |

**The agent's persona stays constant.** This is critical. The user picked InstaClaw because of the agent's personality, not because of the model. Changing models is plumbing; the persona is the product (per the competitive research's Pi.ai/Replika lesson).

### 1.5 Switching between Claude and ChatGPT after connecting

Phase 1 ships **default-model-only switching**. Per-message `@gpt` override (the Poe pattern) is Phase 1.5.

User journey for switching default:

```
User: /model
Bot: ⚡ Default model: GPT-5.5 (Codex · your subscription)

     ─── Your providers ───

     OpenAI (your ChatGPT)
       ● GPT-5.5 Thinking      $0/msg (your sub)
       ○ GPT-5.5 Instant       $0/msg (your sub)
       ○ GPT-5.5 Pro           $0/msg (your sub)

     Anthropic (bundled)
       ○ Claude Opus 4.7       19 credits/msg
       ○ Claude Sonnet 4.6     4 credits/msg
       ○ Claude Haiku 4.5      1 credit/msg

     [Done]
```

Tapping a model: bot edits the message to mark the new selection, the reconciler picks up the DB change within ~3 min and pushes `agents.defaults.model.primary` via `openclaw config set`. Gateway restart applies it. Bot edits the message once more to confirm "✓ Default model is now Claude Opus 4.7. Active in ~30s."

**Why no per-message switching in Phase 1:** the agent's runtime caches the model setting at request time. Per-message override would require either (a) modifying the agent's prompt-processing code (heavy + risky), (b) intercepting messages at the Telegram bridge layer (lightweight but invasive). Both are worth doing in Phase 1.5 but not gating the headline feature on it.

### 1.6 Error states — what happens when something goes wrong

Each error gets a friendly, action-oriented message. **Never a generic "something went wrong."**

| Failure | Trigger | User-visible response | Recovery action |
|---|---|---|---|
| Device-code expired (>15 min) | Poll endpoint returns `expired_token` | "The 15-minute window expired. Want me to generate a fresh code?" + button | Re-issue code on user click |
| OAuth declined by user | User clicked "Deny" in OpenAI's browser flow | "You denied access. No problem — your agent is still on Claude. Try again with /connect-chatgpt." | Restart the flow |
| ChatGPT Plus expired mid-session | Inference returns 401/402 from chatgpt.com/backend-api | "Your ChatGPT subscription seems to have expired or your access was revoked. I've switched back to Claude. Reconnect with /connect-chatgpt." | Auto-switch `api_mode` back to `all_inclusive` or `byok`, surface to user |
| Rate limit on Plus (per OpenAI 429) | pi-ai returns 429 from chatgpt.com | "⚠️ ChatGPT rate-limited (this happens during peak hours). I'll wait 60 seconds and retry. If it keeps happening, I'll switch you to Claude temporarily." | Phase 1: retry once after 60s. Phase 1.5: auto-fallback to Anthropic with cost notification |
| Token refresh failed (refresh_token_reused) | pi-ai or our cron gets `refresh_token_reused` | "Your ChatGPT login was used by another process and got locked out. Please reconnect: /connect-chatgpt" | Clear DB tokens, push update to VM (reconciler clears the OAuth profile), require new OAuth flow |
| Token refresh failed (refresh_token_expired) | Refresh returns 401 with `error.code=refresh_token_expired` | "Your ChatGPT login expired. Reconnect with /connect-chatgpt to keep using GPT-5.5." | Same as above |
| OpenAI service outage | All requests 5xx for >5 min | "OpenAI is having issues right now (status.openai.com). I've temporarily switched you to Claude. I'll switch back when they recover." | Auto-flip `default_model` temporarily, monitor for recovery |
| Our backend hiccup mid-OAuth | Internal 500 during device-code start/poll | "Our system had a hiccup — try /connect-chatgpt again. If this keeps happening, message support@instaclaw.io." | Allow retry; log to alert channel |

**Implementation detail:** each error path includes a structured logger event so we can monitor failure rates. Per Rule 49 / partner-secrets pattern, alert thresholds:
- Token refresh failure rate >2% in 1h window → P1 admin alert
- Plus-rate-limit rate >5% in 1h window → telemetry only (expected at peak)
- OpenAI 5xx rate >10% in 5min → P0 alert (likely OpenAI outage)

### 1.7 Disconnecting

Three paths:

1. Dashboard: `/dashboard/settings/integrations` → ChatGPT card → "Disconnect" button → confirmation modal → click.
2. Telegram: `/disconnect-chatgpt` → bot confirms with inline button "Yes, disconnect" / "Cancel".
3. Automatic (after several refresh failures): bot proactively messages "I had to disconnect ChatGPT because the login kept failing. Use /connect-chatgpt to reconnect."

What disconnect does:
1. **Revoke at OpenAI:** POST `https://auth.openai.com/oauth/revoke` with the refresh_token. Best-effort — if this fails (CF 5xx etc.), still proceed with local cleanup.
2. **Clear DB:** set `instaclaw_users.openai_oauth_*` columns to NULL. Bump `openai_token_version` to invalidate cached copies on VMs.
3. **Update `api_mode`:** flip back to whatever it was before. If user signed up directly into ChatGPT mode (no prior Anthropic relationship), default to `all_inclusive` and notify.
4. **Reconciler step removes the OAuth profile from disk** on next tick (`stepChatGPTOAuthToken` sees no token in DB → removes `openai-codex:default` from auth-profiles.json).
5. **Switch default model:** if `vm.default_model` was `openai-codex/*`, set to `claude-sonnet-4-6` (or user's prior choice).
6. **Confirm:** "✓ Disconnected from ChatGPT. Your agent is now on Claude."

---

## 2. Competitive research synthesis

Full research artifact in conversation history (~10K words). Distilled findings most relevant to our design:

### 2.1 The five UX patterns to steal

1. **Poe's `@mention` per-message override on top of per-conversation default** — gold standard for multi-provider chat. Avatar attribution makes routing visible. **Phase 1.5** for us; the connector ships first.
2. **Cursor's "Paste → Verify → Save" key flow** — the Verify button is load-bearing. We're not collecting a pasted key, but the analogous moment is the device-code-completion screen: show plan tier, available models, estimated cost BEFORE the user clicks "Use as default."
3. **OpenRouter's pricing transparency** — show cost per message inline in the model picker, including "$0/msg (your sub)" for ChatGPT-mode. Sets expectations, prevents surprises.
4. **Continue's per-task model defaults (lite version)** — "Use Claude for chat, GPT for code generation, Haiku for cron summaries." Defer to Phase 1.5 (Advanced settings); Phase 1 ships single-default-model only.
5. **Telegram-bot canonical `/model` + inline-keyboard with current model marked** — universally understood, one-tap interaction, no chat clutter. Ship Phase 1.

### 2.2 The five UX patterns to avoid

1. **Cursor's "BYOK doesn't work for our killer feature"** — every InstaClaw feature must work whether the user is in Anthropic, BYOK Anthropic, or ChatGPT mode. No silent feature gates. Skills, gbrain, dispatch — all model-agnostic.
2. **ChatGPT's auto-router with no transparency** — never silent. Always show which model produced a response when it's not the default.
3. **Continue's config-file-first setup** — Telegram users will not edit YAML. All configuration must be in-bot or in-dashboard.
4. **Cody's admin-only BYOK** — every paying user, including Starter, gets to connect their ChatGPT.
5. **Silent fallback without notification** — when we fall back from GPT to Claude (Phase 1.5), tell the user in the same message. "via Claude (OpenAI rate limited)."

### 2.3 The naming question — corrected

The competitive research agent recommended calling this "Bring your own OpenAI key" instead of "Connect your ChatGPT subscription." **Their reasoning was based on the (incorrect) assumption that there's no way for a third-party app to use a Plus subscription.** Phase 0 + Phase 0.5 proved otherwise.

We are using the **Codex device-code OAuth flow** — the same one OpenAI's official Codex CLI uses. The user's Plus subscription quota powers their InstaClaw agent. This is real. The agent's research was reasoning from general internet knowledge that doesn't include this fact.

**Recommended naming: "Login with ChatGPT" or "Connect your ChatGPT subscription."** Both are accurate. Cooper's Twitter thread used "Login with ChatGPT" and that's been seen by 100K+ people; sticking with that maintains continuity.

We should still include the disclaimer:
> "InstaClaw uses the same OAuth flow as OpenAI's official Codex CLI. Inference usage counts against your ChatGPT Plus / Pro quota. We're not affiliated with OpenAI."

This protects us legally and sets correct expectations. Per the decisions doc Q2.

---

## 3. Telegram-first UX

Detailed wireframes for the chat surface. **Every interaction must feel native to Telegram, not like a port of a web UI.**

### 3.1 Discovery via `/help`

Current bot `/help` text gets one new line appended:

```
[existing /help content]

💡 NEW: You can now use your ChatGPT subscription with this agent.
       Type /connect-chatgpt to connect, takes 60 seconds.
```

### 3.2 The connect flow — single edited message

Implementation: one Telegram message, edited via `editMessageText` on each state transition. Reduces clutter to one card. Per the canonical pattern from `yym68686/chatgpt-telegram-bot` and `terranc/claude-telegram-bot-bridge`.

**State 1 — initial code display:**
```
🔑 Connect your ChatGPT subscription

Tap to open OpenAI's authorization page:
👉 auth.openai.com/codex/device

Enter this code:

       92PM-PLU8N

Expires in 15:00

⏳ Waiting for authorization…
```

**State 2 — countdown ticks (edit every 10s):**
```
🔑 Connect your ChatGPT subscription

Tap to open OpenAI's authorization page:
👉 auth.openai.com/codex/device

Enter this code:

       92PM-PLU8N

Expires in 14:30

⏳ Waiting for authorization…
```

**State 3 — user authorized, configuring:**
```
✓ Authorized as coop***@gmail.com (ChatGPT Plus)

Setting up your agent to use GPT-5.5…

This takes ~30 seconds.
```

**State 4 — fully ready:**
```
✓ Connected to ChatGPT Plus

Your agent now uses GPT-5.5 by default.

• Switch back to Claude anytime: /model
• Disconnect: /disconnect-chatgpt
• Settings: instaclaw.io/dashboard/settings

Try me — ask me anything.
```

### 3.3 Model picker — `/model`

Per the canonical pattern. Inline keyboard (Telegram-native), edited in place.

**Initial state:**
```
[Bot message body]
⚡ Default model: GPT-5.5 Thinking (your ChatGPT sub)

Tap a model to set as default:

[Inline keyboard, 8 buttons in 2-column layout]
[● GPT-5.5 Thinking] [○ Sonnet 4.6 (4 cr)]
[○ GPT-5.5 Instant ] [○ Opus 4.7 (19 cr)]
[○ GPT-5.5 Pro     ] [○ Haiku 4.5 (1 cr)]
[              Cancel              ]
```

On tap: bot edits message, marks new selection with `●`, shows "Updating in ~30s..." line under header. Within ~30s the line clears and reads "✓ Default: <new model>."

### 3.4 Active-model indicator (subtle, not annoying)

**Decision:** show model attribution ONLY when the response is from a non-default model. This avoids "every message is labeled" annoyance.

- **Default model used:** no label. Reply is just the text.
- **Non-default model used** (e.g., Phase 1.5 `@gpt` override, or fallback): tiny italic line at top:
  ```
  _via Claude Haiku (you said use Haiku)_
  
  [reply text]
  ```
- **Fallback fired** (Phase 1.5): explicit label:
  ```
  _⚠️ via Claude (OpenAI rate-limited — your daily Plus cap hit)_
  
  [reply text]
  ```

Users who want always-on labeling can enable a setting (`/settings` → "Show model in replies: ON/OFF").

### 3.5 Status surfacing — when to remind, when to be quiet

**Don't remind:** every message. That's spam.

**Do remind:**
- First message after connect: "Try me — ask me anything." (one-time)
- First message after switching default: implicit (the reply just uses the new model; user notices the personality shift)
- After 7 days of use: optional weekly digest (opt-in): "This week: 247 messages on GPT-5.5, $0 cost to you (your ChatGPT sub paid). 12 messages fell back to Claude (4 credits used)."

### 3.6 The disconnect message

Triggered by `/disconnect-chatgpt`:

```
Disconnect from ChatGPT?

You'll switch back to Claude (bundled).

Your ChatGPT account will be unlinked from InstaClaw.
This won't affect your subscription on OpenAI's side.

[Inline keyboard]
[ Yes, disconnect ] [ Cancel ]
```

On confirm:
```
✓ Disconnected from ChatGPT.

Your agent is now on Claude Opus 4.7.
Reconnect anytime with /connect-chatgpt.
```

---

## 4. Credit system integration

**The decision:** ChatGPT-mode primary chat costs **0 InstaClaw credits**. Tier-based daily caps still apply but are reinterpreted as "max agent-turns per day across all models" rather than "max Anthropic credits per day."

### 4.1 The full accounting model under ChatGPT mode

| Track | Model | Who pays | Credit-system behavior |
|---|---|---|---|
| Primary chat (user → agent → user) | `openai-codex/gpt-5.5` | User's ChatGPT Plus quota | **0 credits.** Counts toward `display_count` (tier daily cap for abuse prevention) but `cost_weight=0`. |
| Heartbeats | `anthropic/claude-haiku-4-5` | InstaClaw (platform) | Heartbeat budget (existing, separate from tier daily cap). Unchanged. |
| Embeddings | `openai/text-embedding-3-large` | InstaClaw (our `OPENAI_API_KEY`) | Not tracked in credits (existing behavior). Unchanged. |
| Manual `/use sonnet` (chatgpt_oauth user calls Anthropic anyway) | `anthropic/claude-sonnet-4-6` (our key) | InstaClaw (platform) | Standard credit weight (4 for Sonnet, 19 for Opus, 1 for Haiku). |
| Auto-fallback (Phase 1.5) | `anthropic/claude-sonnet-4-6` (our key) | InstaClaw (capped per Q5 decisions) | Separate "fallback budget" counter, capped per tier |

### 4.2 Why this design

- **Zero-cost primary chat** is what makes ChatGPT mode attractive. Users want unlimited GPT for $19-149/mo. If we still debit credits, the tier cap caps their usage and the value prop collapses.
- **Daily message cap (display_count) stays** as an abuse-prevention floor. Without it, a runaway cron could send 100K agent-turns/day and saturate our infra (gbrain, scripts, telegram bot). Reasonable cap: 2000 turns/day for Starter, 5000 for Pro, 15000 for Power. (Adjust based on real data.)
- **Manual Claude usage charges credits** because the user is explicitly opting into our Anthropic spend. This prevents the abuse case of "I'll connect ChatGPT to skip the daily cap, then use `/use opus` to get unlimited Opus for $19/mo."
- **Fallback budget (Phase 1.5)** is the careful version — see decisions doc Q5 for the soft-overage in $5 blocks design.

### 4.3 Implementation

In `app/api/gateway/proxy/route.ts` the existing `instaclaw_check_and_increment` RPC needs to learn about `chatgpt_oauth` mode. But wait — chatgpt_oauth users' primary chats don't hit the proxy at all (they go direct VM → chatgpt.com). So credit accounting for primary chat happens... not via the proxy.

**Where it must happen:** somewhere ON the VM. Options:
1. OpenClaw runtime hook fires after each completion (pi-ai supports this)
2. Periodic sync from VM to our DB (every N min, agent reports turn count)
3. Don't track per-turn; just count Telegram messages received

**Decision: option 3 for Phase 1.** The Telegram bot handler already counts incoming user messages. When the user is in `chatgpt_oauth` mode, increment `instaclaw_daily_usage.message_count` by 1 (no cost weight). When in `all_inclusive` or `byok`, the existing proxy-path accounting handles it as today. No new RPC, no VM-side instrumentation, just a one-line conditional in the existing bot handler. Cheapest possible implementation.

**For the dashboard usage chart:** when `api_mode='chatgpt_oauth'`, display the daily count as "X / 2000 messages" (no credits language). When `all_inclusive`, display as today ("X / 600 credits").

### 4.4 What about Anthropic-routed manual usage (`/use sonnet`)?

If a chatgpt_oauth user manually invokes Claude via `/use sonnet` or `@sonnet`, that call still goes through our proxy (because their auth-profiles.json still has `anthropic:default` pointing at our proxy — we keep that profile intact). The proxy's existing flow handles it: weighted credit debit. No change to the proxy.

**Edge case:** what if a chatgpt_oauth user runs out of InstaClaw credits while invoking Claude manually? Today's behavior: friendly upsell. Same applies. Their ChatGPT mode is unaffected — they just can't manually use Claude past the cap until next billing cycle.

---

## 5. Security + token lifecycle

The Phase 0.5 spike confirmed pi-ai 0.70.2 handles OAuth refresh natively. But security has several other concerns.

### 5.1 On-disk token storage

**Location:** `~/.openclaw/agents/main/agent/auth-profiles.json` — the SAME file that already holds the Anthropic gateway token and the OpenAI embeddings key. We add a new `openai-codex:default` profile entry.

**File permissions:** `0600`, owned by `openclaw` user (matches existing). Only the `openclaw` process (and root) can read.

**Exact shape we write** (per Phase 0.5 verified `OAuthCredential` type):
```json
{
  "version": 1,
  "profiles": {
    "anthropic:default": { ... existing ... },
    "openai:default": { ... existing embeddings, server key ... },
    "openai-codex:default": {
      "type": "oauth",
      "provider": "openai-codex",
      "clientId": "app_EMoamEEZ73f0CkXaXp7hrann",
      "access": "<bearer JWT>",
      "refresh": "<refresh token>",
      "expires": 1779144190000,
      "accountId": "<chatgpt_account_id from id_token>",
      "email": "<from id_token, optional>",
      "idToken": "<id_token JWT, optional>"
    }
  }
}
```

### 5.2 In-DB token storage (per PRD §4.4)

New columns on `instaclaw_users`:
- `openai_oauth_access_token TEXT` — encrypted with AES-256-GCM via `lib/openai-oauth-encryption.ts` (new file mirroring `lib/freeze-encryption.ts` per Rule 53)
- `openai_oauth_refresh_token TEXT` — encrypted
- `openai_oauth_id_token_claims JSONB` — decoded claims subset (plan_type, account_id, email, exp). Cleartext (not sensitive without the tokens).
- `openai_oauth_expires_at TIMESTAMPTZ`
- `openai_oauth_last_refresh_at TIMESTAMPTZ`
- `openai_oauth_account_id TEXT`
- `openai_oauth_originator TEXT` — install fingerprint we generate per-user
- `openai_token_version INTEGER NOT NULL DEFAULT 0` — bumped on every successful refresh
- `chatgpt_plan_type TEXT` — cached for routing decisions
- `chatgpt_plan_last_seen_at TIMESTAMPTZ`

On `instaclaw_vms`:
- `openai_token_version_synced INTEGER NOT NULL DEFAULT 0` — reconciler uses this to detect drift

New table:
- `instaclaw_oauth_device_flows` — in-flight polling state per PRD §4.4 SQL

**Encryption key management:** mirror `lib/freeze-encryption.ts` exactly. Versioned key id (`v1`), env vars `OPENAI_OAUTH_KEY_CURRENT=v1` + `OPENAI_OAUTH_KEY_V1=<64-hex>`. Cooper backs up the key offline.

### 5.3 VM reassignment safety (the biggest unaddressed concern in the PRD)

What if a user disconnects, their VM gets unassigned, and the SAME VM gets reassigned to a different user — does the new user inherit the old user's OAuth tokens?

**Today's behavior, verified from code:**

1. `lib/vm-freeze-thaw.ts:313` notes `auth-profiles.json (Anthropic key)` in cleanup context — explicit acknowledgment that this file holds secrets.
2. `lib/ssh.ts:8634` shows the freeze tarball uses `--exclude=agents/main/agent/auth-profiles.json` — **the freeze archive doesn't include auth-profiles.json.** On thaw, configureOpenClaw writes a fresh one.
3. `lib/ssh.ts:5430` (`privacy_guard_check`) in `configureOpenClaw` wipes existing session/memory/auth files before reconfigure if the new user differs from the prior user.

**Conclusion: the existing freeze + privacy-guard path naturally handles VM reassignment.** OAuth tokens never leak to a new user. Verified at three levels.

**Defensive addition:** add a synthetic test that explicitly verifies this — provision a VM as User A with chatgpt_oauth, simulate freeze + thaw + reassign to User B, confirm `~/.openclaw/agents/main/agent/auth-profiles.json` does NOT contain User A's OAuth profile after reassignment.

### 5.4 Disconnect = revoke at OpenAI + delete locally

Per §1.7. Order matters:
1. **Revoke at OpenAI first** (`POST https://auth.openai.com/oauth/revoke`) — failing silently is acceptable (we keep the local cleanup anyway), but we try first so the access_token is invalidated on OpenAI's side.
2. **Clear DB columns** — bump `openai_token_version` to invalidate cached state.
3. **Reconciler picks up on next tick** — `stepChatGPTOAuthToken` sees no token, removes the `openai-codex:default` profile entry from auth-profiles.json on disk.
4. **Update `default_model`** to a non-Codex model (back to Sonnet/Opus/etc.).
5. **Notify user** via Telegram or dashboard.

### 5.5 Refresh failure monitoring

pi-ai handles refresh on-VM, BUT we want central monitoring. Two paths to detect failure:

1. **Our refresh cron** (`/api/cron/refresh-openai-oauth-tokens` every 5 min): hits OpenAI's refresh endpoint with the user's refresh_token, captures the result. This is our safety net — even if pi-ai's on-VM refresh works, our cron also runs and either succeeds (idempotent — the new token replaces what pi-ai wrote) or fails (alerts us).
2. **Reconciler step** notices `vm.openai_token_version_synced < user.openai_token_version` (drift) and triggers a write. If write fails, push to `result.errors`, cv held per Rule 10. Surfaces via existing fleet-health alerts.

Alert thresholds (per Rule 49 pattern):
- Token refresh failure rate >2% per 1h sliding window → P1 admin email
- Token refresh classified as `refresh_token_reused` (the permanent-lockout case) → P0 alert per user, surface to user immediately

### 5.6 Audit logging

Every OAuth-touching operation writes a structured logger event:
- `OPENAI_OAUTH_FLOW_STARTED` (start)
- `OPENAI_OAUTH_FLOW_COMPLETED` (success)
- `OPENAI_OAUTH_REFRESH_SUCCESS` (rotation)
- `OPENAI_OAUTH_REFRESH_FAILED:{reason}` (failure, reason ∈ {expired, reused, revoked, account_mismatch, other})
- `OPENAI_OAUTH_DISCONNECTED` (user-initiated)
- `OPENAI_OAUTH_AUTO_DISCONNECTED:{reason}` (system-initiated, e.g., 3+ refresh failures)
- `OPENAI_OAUTH_PROFILE_WRITTEN_TO_VM` (reconciler)
- `OPENAI_OAUTH_PROFILE_VERIFIED_ON_VM` (reconciler post-write)

Per CLAUDE.md Rule 27 (coverage queries): ship `scripts/_coverage-chatgpt-oauth.ts` on day 1. Sample 5 random chatgpt_oauth users, verify DB + disk state matches.

---

## 6. Reconciler integration — concrete file changes

This is the engineering meat of Phase 1. Three files in `lib/`, one new file, one extended function, one bug fix.

### 6.1 `lib/openai-oauth.ts` (NEW)

The OAuth primitives. ~150 LOC. Mirrors pi-ai's `utils/oauth/openai-codex.js` exactly — copy the constants:

```typescript
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";  // matches Codex CLI + pi-ai
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5000;
```

Functions:
- `startDeviceFlow(userId, originator?): Promise<{user_code, device_auth_id, verification_uri, interval, expires_in}>`
- `pollDeviceFlow(deviceAuthId, codeVerifier): Promise<{status: "pending"|"completed"|"expired"|"denied", tokens?: TokenSet}>`
- `exchangeAuthCode(code, verifier): Promise<TokenSet>`
- `refreshToken(refreshToken): Promise<RefreshResult>` — returns one of `{success, expired, reused, revoked, account_mismatch, other}`
- `parseJwtClaims(jwt): IdTokenClaims` — extract plan_type, account_id, user_id, exp from `https://api.openai.com/auth` claim
- `revokeToken(refreshToken): Promise<void>` — POST `/oauth/revoke`, best-effort

All implementations modeled on pi-ai source (we have it on disk from Phase 0.5). No invention.

### 6.2 `lib/openai-oauth-encryption.ts` (NEW)

AES-256-GCM with versioned key id. ~80 LOC. Mirrors `lib/freeze-encryption.ts` exactly.

### 6.3 `lib/ssh.ts:buildAuthProfilesJson` (EXTENDED)

Current signature:
```typescript
export function buildAuthProfilesJson(
  apiKey: string,
  proxyBaseUrl: string,
  openaiKey?: string | null,
): string
```

Extended signature:
```typescript
export function buildAuthProfilesJson(
  apiKey: string,
  proxyBaseUrl: string,
  openaiKey?: string | null,
  chatgptOAuth?: {
    accessToken: string;
    refreshToken: string;
    expires: number;  // unix ms
    accountId?: string;
    email?: string;
    idToken?: string;
  } | null,
): string
```

When `chatgptOAuth` is truthy, emit a 3rd profile entry:
```typescript
if (chatgptOAuth) {
  profiles["openai-codex:default"] = {
    type: "oauth",
    provider: "openai-codex",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    access: chatgptOAuth.accessToken,
    refresh: chatgptOAuth.refreshToken,
    expires: chatgptOAuth.expires,
    ...(chatgptOAuth.accountId && { accountId: chatgptOAuth.accountId }),
    ...(chatgptOAuth.email && { email: chatgptOAuth.email }),
    ...(chatgptOAuth.idToken && { idToken: chatgptOAuth.idToken }),
  };
}
```

**Same byte-identical discipline applies** — extend `lib/cloud-init-tarball.ts:buildAuthProfilesJsonForTarball` to pass through the same param so SSH and cloud-init paths produce identical output.

`configureOpenClaw` is extended to look up the user's OAuth tokens (decrypted) and pass them through when `api_mode='chatgpt_oauth'`.

### 6.4 `lib/vm-reconcile.ts:stepAuthProfiles` (BUG FIX + EXTENSION)

**Bug fix first** (current behavior, lines 4342-4356): when rebuilding for all-inclusive, only writes `anthropic:default`. Loses `openai:default` (embeddings) and would lose the new `openai-codex:default` (OAuth). 

**Fix:** before rebuild, READ existing profiles, preserve `openai:default` and `openai-codex:default` (and any other non-anthropic profiles) in the new file.

```typescript
// Read existing file (we already do this for the comparison step)
const existing = authReadResult.code === 0 ? JSON.parse(authReadResult.stdout) : null;
const existingProfiles = existing?.profiles ?? {};

// Build new file preserving non-anthropic profiles
const newProfiles: Record<string, unknown> = {
  "anthropic:default": authProfileData,
};
for (const [pid, profile] of Object.entries(existingProfiles)) {
  if (pid !== "anthropic:default" && profile) {
    newProfiles[pid] = profile;
  }
}
const authProfile = JSON.stringify({ profiles: newProfiles });
```

**Synthetic test** for this: start with both `anthropic:default` AND `openai:default` AND `openai-codex:default` on disk; trigger rebuild; verify all three survive. **Must ship before any OAuth user goes live.**

### 6.5 `lib/vm-reconcile.ts:stepChatGPTOAuthToken` (NEW)

Inserted in `reconcileVM` orchestrator after `stepFiles` and before `stepConfigSettings`. Only runs for `api_mode='chatgpt_oauth'` users.

```typescript
async function stepChatGPTOAuthToken(
  ssh: SSHConnection,
  vm: VMRecord,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<boolean> {
  // 1. Skip if not chatgpt_oauth
  const user = await fetchUserForVM(vm.assigned_to);
  if (user?.api_mode !== "chatgpt_oauth") return false;

  // 2. Skip if user has no tokens (recently disconnected — separate step would clean up)
  if (!user.openai_oauth_access_token) {
    result.alreadyCorrect.push("openai-codex:default (no token, not configured)");
    return false;
  }

  // 3. Skip if VM is already at the user's token version
  if ((vm.openai_token_version_synced ?? 0) >= (user.openai_token_version ?? 0)) {
    result.alreadyCorrect.push(`openai-codex:default (version ${vm.openai_token_version_synced})`);
    return false;
  }

  // 4. Drift detected — decrypt, build the profile, write
  const decrypted = decryptOAuthTokens(user);
  const expectedProfile = {
    type: "oauth",
    provider: "openai-codex",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    access: decrypted.accessToken,
    refresh: decrypted.refreshToken,
    expires: user.openai_oauth_expires_at.getTime(),
    accountId: user.openai_oauth_account_id ?? undefined,
    email: user.openai_oauth_id_token_claims?.email ?? undefined,
  };

  if (dryRun) {
    result.fixed.push(`[dry-run] openai-codex:default → version ${user.openai_token_version}`);
    return false;
  }

  // 5. Atomic write — preserve other profiles
  const writeScript = `
    set -e
    umask 077
    AUTH_FILE=~/.openclaw/agents/main/agent/auth-profiles.json
    EXISTING=$(cat "$AUTH_FILE" 2>/dev/null || echo '{"version":1,"profiles":{}}')
    echo "$EXISTING" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.setdefault('profiles', {})['openai-codex:default'] = ${JSON.stringify(expectedProfile)}
print(json.dumps(d))
" > "$AUTH_FILE.tmp"
    mv "$AUTH_FILE.tmp" "$AUTH_FILE"
    chmod 600 "$AUTH_FILE"
    # Verify-after-write (Rule 23 sentinel)
    python3 -c "
import json
d = json.load(open('$HOME/.openclaw/agents/main/agent/auth-profiles.json'))
p = d['profiles'].get('openai-codex:default')
assert p and p.get('type') == 'oauth' and p.get('provider') == 'openai-codex'
print('OAUTH_PROFILE_OK')
"
  `;
  const writeResult = await ssh.execCommand(writeScript);
  if (!writeResult.stdout.includes("OAUTH_PROFILE_OK")) {
    result.errors.push(`openai-codex:default write failed: ${writeResult.stderr.slice(-200)}`);
    return false;
  }

  // 6. Bump VM version counter
  await getSupabase()
    .from("instaclaw_vms")
    .update({ openai_token_version_synced: user.openai_token_version })
    .eq("id", vm.id);

  result.fixed.push(`openai-codex:default → version ${user.openai_token_version}`);
  result.gatewayRestartNeeded = false;  // pi-ai re-reads on next call; no restart needed
  return true;
}
```

**Note**: pi-ai re-reads `auth-profiles.json` per call (or close to it — verify), so a gateway restart isn't strictly required after just rotating the OAuth token. After much testing, if pi-ai DOES require restart, set `gatewayRestartNeeded = true`. Validate in week 1.

### 6.6 `lib/vm-reconcile.ts:stepEnforceModelPrimary` (NO CHANGE NEEDED)

Reads `vm.default_model`, calls `toOpenClawModel()`, pushes via `openclaw config set`. For chatgpt_oauth users, we set `vm.default_model = "openai-codex/gpt-5.5"` (or whatever the user-selected variant is). `toOpenClawModel` needs to know what to do with this.

### 6.7 `lib/ssh.ts:toOpenClawModel` (EXTENDED)

Current implementation (lib/ssh.ts:4032-4035):
```typescript
function toOpenClawModel(model: string): string {
  if (model.includes("claude-")) return `anthropic/${model}`;
  return "anthropic/claude-sonnet-4-6";  // fallback default
}
```

Extended:
```typescript
function toOpenClawModel(model: string): string {
  // Provider-prefixed models pass through (e.g., "openai-codex/gpt-5.5")
  if (model.includes("/")) return model;
  // Anthropic models get the anthropic/ prefix
  if (model.includes("claude-")) return `anthropic/${model}`;
  // GPT models (when api_mode is chatgpt_oauth) → openai-codex
  if (model.match(/^gpt-/i)) return `openai-codex/${model}`;
  // Fallback
  return "anthropic/claude-sonnet-4-6";
}
```

### 6.8 `lib/ssh.ts:configureOpenClaw` (EXTENDED)

Currently calls `buildAuthProfilesJson(apiKey, proxyBaseUrl, process.env.OPENAI_API_KEY)`. Extended to look up the user's OAuth tokens (decrypted) and pass through:

```typescript
let chatgptOAuth: ChatGPTOAuthArgs | null = null;
if (config.api_mode === "chatgpt_oauth" && config.user_id) {
  const user = await fetchUserOAuth(config.user_id);
  if (user?.openai_oauth_access_token) {
    chatgptOAuth = {
      accessToken: decrypt(user.openai_oauth_access_token),
      refreshToken: decrypt(user.openai_oauth_refresh_token),
      expires: user.openai_oauth_expires_at.getTime(),
      accountId: user.openai_oauth_account_id,
      email: user.openai_oauth_id_token_claims?.email,
    };
  }
}

const authProfile = buildAuthProfilesJson(
  apiKey,
  proxyBaseUrl,
  process.env.OPENAI_API_KEY,
  chatgptOAuth,
);
```

### 6.9 New API routes (in `app/api/auth/openai/...`)

Per the implementation plan + decisions doc. Files:
- `app/api/auth/openai/device-code/start/route.ts` — POST, session-protected
- `app/api/auth/openai/device-code/poll/route.ts` — POST, session-protected
- `app/api/auth/openai/disconnect/route.ts` — DELETE, session-protected
- `app/api/auth/openai/refresh-now/route.ts` — POST, gateway-token-protected (for VM-initiated forced refresh)
- `app/api/cron/refresh-openai-oauth-tokens/route.ts` — POST, cron-secret-protected, every 5 min, `maxDuration=300` per Rule 11

### 6.10 Middleware allow-list (Rule 13)

Add to `instaclaw/middleware.ts:selfAuthAPIs`:
- `/api/auth/openai/device-code/start` (session-protected but flow context needs bypass)
- `/api/auth/openai/device-code/poll` (same)
- `/api/auth/openai/refresh-now` (gateway-token auth)
- `/api/auth/openai/disconnect` (session-protected)
- `/api/cron/refresh-openai-oauth-tokens` (cron-secret auth)

### 6.11 The Telegram bot (`/connect-chatgpt`, `/model`, `/disconnect-chatgpt`)

The Telegram bot lives in `lib/ssh.ts`'s OpenClaw configuration — Telegram is wired as an OpenClaw plugin/channel on every VM, not a separate service in our backend.

**Implication:** the slash commands `/connect-chatgpt`, `/model`, `/disconnect-chatgpt` are best implemented as **OpenClaw skills or system-prompt-driven behaviors**, not as new bot routes. The agent itself parses the slash command and calls our backend API.

Two approaches:
1. **OpenClaw skill** (preferred): a tiny skill installed on every VM that recognizes the slash commands, makes HTTP calls to `/api/auth/openai/*` with the user's gateway token, displays the device code + URL in chat. Pros: clean, native to OpenClaw model. Cons: requires per-VM skill install (existing pattern; not heavy).
2. **System-prompt-driven**: the agent's SOUL.md instructs it to recognize the commands and invoke a tool. Pros: zero new code. Cons: relies on model behavior, fragile.

**Recommendation: skill approach.** Defer to Phase 1 week 3.

---

## 7. Dashboard UI

The dashboard needs a new section. Current `/dashboard/settings/` already exists. Add:

### 7.1 New page: `/dashboard/settings/integrations`

```
Settings → Integrations

Models & Providers
──────────────────

Default model: GPT-5.5 Thinking         [Change]

Connected providers:

┌──────────────────────────────────────────────────┐
│ 🆕 OpenAI (ChatGPT)                              │
│                                                   │
│ Connected as: coop***@gmail.com                  │
│ Plan: ChatGPT Plus                                │
│ Token expires: 2026-06-08 (refreshes auto)       │
│ Health: ✓ Valid                                   │
│ Used today: 47 messages                          │
│                                                   │
│ [Disconnect]                                      │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ 🤖 Anthropic                                     │
│                                                   │
│ Mode: Bundled (you don't pay per message)        │
│ Used today: 3 messages (manual /use sonnet)      │
│                                                   │
│ [Switch to BYOK]                                  │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ Google Gemini                                    │
│                                                   │
│ Not connected                                     │
│                                                   │
│ [Coming soon]                                     │
└──────────────────────────────────────────────────┘

──────────────────

Advanced: per-task model routing [Configure]
   Chat replies → GPT-5.5 Thinking
   Cron summaries → Claude Haiku
   Code generation → GPT-5.5 Pro
```

### 7.2 Connected state — health indicators

- ✓ Valid (green) — token is fresh, last verified <1h ago
- ⚠️ Expires soon (yellow) — within 24h of expiry, no recent refresh
- 🔄 Refreshing (yellow, animated) — refresh in progress
- ❌ Failed (red) — last refresh failed; user needs to reconnect

### 7.3 Disconnect flow

```
┌──────────────────────────────────────────────────┐
│ Disconnect ChatGPT?                              │
│                                                   │
│ • Your agent will switch back to Claude          │
│ • Your ChatGPT subscription is NOT affected       │
│ • You can reconnect anytime                       │
│                                                   │
│ ☐ Also revoke this app's access on OpenAI's side │
│   (recommended)                                   │
│                                                   │
│              [Cancel]  [Disconnect]               │
└──────────────────────────────────────────────────┘
```

### 7.4 Discovery banner (dashboard home)

For users who haven't connected yet:

```
┌──────────────────────────────────────────────────┐
│ 🆕 Use your ChatGPT subscription                 │
│                                                   │
│ Connect ChatGPT to your agent and get GPT-5.5    │
│ at no extra cost (your sub pays).                 │
│                                                   │
│ [Connect ChatGPT]  [Learn more]   [Dismiss]      │
└──────────────────────────────────────────────────┘
```

Dismissible per user. Doesn't reappear after dismiss.

---

## 8. File-by-file changes (engineering checklist)

| File | Status | Change |
|---|---|---|
| `instaclaw/supabase/pending_migrations/20260519100000_chatgpt_oauth.sql` | NEW | Per PRD §4.4: 10 new `instaclaw_users` columns + 1 new `instaclaw_vms` column + `instaclaw_oauth_device_flows` table + `instaclaw_users_api_mode_check` constraint extension. Rule 56: in `pending_migrations/` first. |
| `instaclaw/lib/openai-oauth.ts` | NEW | OAuth primitives. ~150 LOC. Mirrors pi-ai's `utils/oauth/openai-codex.js`. |
| `instaclaw/lib/openai-oauth-encryption.ts` | NEW | AES-256-GCM with versioned key id. Mirrors `lib/freeze-encryption.ts`. |
| `instaclaw/lib/ssh.ts:buildAuthProfilesJson` | EXTEND | Add optional 4th arg `chatgptOAuth?`. Emit `openai-codex:default` profile. |
| `instaclaw/lib/ssh.ts:configureOpenClaw` | EXTEND | Look up user OAuth tokens for `chatgpt_oauth` users; pass to `buildAuthProfilesJson`. |
| `instaclaw/lib/ssh.ts:toOpenClawModel` | EXTEND | Handle `openai-codex/*` prefix and `gpt-*` model names. |
| `instaclaw/lib/cloud-init-tarball.ts:buildAuthProfilesJsonForTarball` | EXTEND | Pass through `chatgptOAuth` param byte-identically. |
| `instaclaw/lib/vm-reconcile.ts:stepAuthProfiles` | BUG FIX | Preserve non-anthropic profiles on rebuild (loads existing file first, merges). |
| `instaclaw/lib/vm-reconcile.ts:stepChatGPTOAuthToken` | NEW | Writes `openai-codex:default` profile to disk when DB version > VM-synced version. Per Rule 34. |
| `instaclaw/lib/vm-reconcile.ts:reconcileVM` | EXTEND | Insert `stepChatGPTOAuthToken` after `stepFiles`, before `stepConfigSettings`. |
| `instaclaw/app/api/auth/openai/device-code/start/route.ts` | NEW | POST, session auth. Start device-code flow. |
| `instaclaw/app/api/auth/openai/device-code/poll/route.ts` | NEW | POST, session auth. Poll for completion. |
| `instaclaw/app/api/auth/openai/disconnect/route.ts` | NEW | DELETE. Revoke + clear DB. |
| `instaclaw/app/api/auth/openai/refresh-now/route.ts` | NEW | POST, gateway-token auth. VM-initiated forced refresh. |
| `instaclaw/app/api/cron/refresh-openai-oauth-tokens/route.ts` | NEW | Every 5 min. Row-locked per user. `maxDuration=300`. |
| `instaclaw/middleware.ts:selfAuthAPIs` | EXTEND | Add the 5 new routes. |
| `instaclaw/lib/billing-status.ts:classify` | EXTEND | New Path 6 for `chatgpt_oauth` users (isPaying true if they have a tier sub OR explicit "chatgpt_only" tier). |
| `instaclaw/lib/stripe.ts:TIER_DISPLAY` | EXTEND | Add 3 new price points. |
| `instaclaw/app/api/billing/webhook/route.ts:checkout.session.completed` | EXTEND | When the price ID matches `STRIPE_PRICE_*_CHATGPT`, set `api_mode='chatgpt_oauth'`. |
| `instaclaw/app/(dashboard)/settings/integrations/page.tsx` | NEW | The "Models & Providers" page (§7). |
| `instaclaw/app/(dashboard)/dashboard/page.tsx` | EXTEND | Add the discovery banner (§7.4). |
| `instaclaw/app/(onboarding)/plan/page.tsx` | EXTEND | Add ChatGPT-mode tier option (§1.3.3). |
| `instaclaw/app/api/cron/track-fallback-usage/route.ts` | DEFERRED | Phase 1.5 only — auto-fallback budget tracking. |
| `instaclaw/scripts/_coverage-chatgpt-oauth.ts` | NEW | Rule 27 coverage query. |
| `vercel.json` (or cron config) | EXTEND | Add the refresh cron schedule. |
| **Vercel env vars** | EXTEND | `OPENAI_OAUTH_KEY_CURRENT=v1`, `OPENAI_OAUTH_KEY_V1=<64hex>`, `STRIPE_PRICE_STARTER_CHATGPT`, `STRIPE_PRICE_PRO_CHATGPT`, `STRIPE_PRICE_POWER_CHATGPT`. Per Rule 6: use `printf`, not `<<<`. |
| **Telegram skill** (`/connect-chatgpt`, `/model`, `/disconnect-chatgpt`) | NEW | OpenClaw skill installed on every VM. Recognizes commands, calls our API, renders chat UI per §3. |

---

## 9. Testing strategy

### 9.1 Pre-merge synthetic tests (CI gates)

Per the Phase 1 implementation plan + new tests specific to this design:

| Test | What it verifies |
|---|---|
| `test_encryption_roundtrip` | AES-256-GCM encrypt/decrypt with versioned key id; tamper detection |
| `test_oauth_device_flow` | Mock OpenAI; verify start → poll-pending → poll-completed lifecycle |
| `test_oauth_refresh_concurrency` | 5 concurrent refresh attempts → exactly 1 OpenAI call; others wait |
| `test_oauth_refresh_failure_classification` | Each of 5 failure modes routes to correct classification |
| `test_build_auth_profiles_with_oauth` | Emits 3-profile shape when chatgptOAuth arg passed; backwards-compat without |
| `test_step_auth_profiles_preserves_non_anthropic` | Start with anthropic+openai+openai-codex profiles; rebuild; all 3 survive |
| `test_step_auth_profiles_anthropic_only_unchanged` | All-inclusive VM with no OAuth: rebuild matches today's byte-for-byte output |
| `test_step_chatgpt_oauth_token_writes_correct_shape` | Disk version 3, DB version 5 → file gets new OAuth profile in correct OAuthCredential shape |
| `test_step_chatgpt_oauth_token_noop_when_in_sync` | Disk version 5, DB version 5 → no-op (alreadyCorrect) |
| `test_step_chatgpt_oauth_token_removes_on_disconnect` | User clears their tokens; reconciler removes profile from disk |
| `test_to_openclaw_model_handles_codex_prefix` | `openai-codex/gpt-5.5` passes through unchanged; `gpt-5.5` gets `openai-codex/` prefix |
| `test_proxy_chatgpt_oauth_user_routes_anthropic_via_proxy` | chatgpt_oauth user manually calling Sonnet through proxy: routes to Anthropic with our key, charges credits |
| `test_proxy_chatgpt_oauth_user_heartbeat_routes_minimax` | chatgpt_oauth user heartbeat: still routes to MiniMax, doesn't burn user's quota |
| `test_proxy_byok_still_403` | BYOK user calling proxy: still 403 (existing behavior preserved) |
| `test_vm_reassign_wipes_oauth_tokens` | Provision as User A with chatgpt_oauth → freeze → thaw to User B → verify User A's OAuth tokens are NOT on disk |
| `test_kill_switch_disables_cleanly` | Set `OPENAI_OAUTH_ENABLED=false`; verify all code paths short-circuit |
| `test_jwt_claim_extraction` | Decode the Phase 0 captured JWT; extract `chatgpt_plan_type=plus` etc. |
| `test_disconnect_revokes_at_openai` | Call disconnect; verify POST to `/oauth/revoke` happens |

### 9.2 Canary VM testing (week 4)

Per Phase 1 implementation plan §7.2. Cooper's vm-050 stays on `all_inclusive` (production canary). Use a fresh `g6-dedicated-2` for the chatgpt_oauth canary.

Steps:
1. Provision fresh VM. Assign to a test user.
2. Set `api_mode='chatgpt_oauth'`. Cooper completes OAuth flow in his browser.
3. Verify token lands in DB. Verify reconciler writes auth-profiles.json with correct shape. Verify `openclaw config get agents.defaults.model.primary` returns `openai-codex/gpt-5.5`.
4. Send 10 Telegram messages. Verify replies come from GPT-5.5. Verify usage shows up in Cooper's ChatGPT account dashboard.
5. Test `/use sonnet`: verify routing through our proxy → Anthropic. Verify InstaClaw credits debited.
6. Test heartbeats: verify they continue to MiniMax.
7. Test `/disconnect-chatgpt`: verify revoke at OpenAI + clear DB + reconciler removes profile.
8. Reconnect, then deliberately corrupt the refresh token in DB → verify our refresh cron detects failure and surfaces to user.
9. Verify Anthropic-only VMs (sample 5) are unchanged.

### 9.3 5-user beta (week 5)

5 hand-selected paying users opt in (Cooper, plus 4 internal/friendly). Real OAuth flow. Real billing. Monitor for 48h with all telemetry events streaming to a dedicated Slack channel.

Success criteria:
- 5/5 successful OAuth flow
- 50/50 inference calls succeed (10 per user)
- Token refresh fires correctly within 30 min of expiry
- No Anthropic-only-fleet regressions
- No silent failures (every failure surfaces to user with action-oriented message)

### 9.4 Public launch (week 6)

Open to general signups. Twitter announcement. Monitor closely for 1 week.

### 9.5 Post-rollout monitoring (Rule 27)

Coverage query `scripts/_coverage-chatgpt-oauth.ts`:
- For every user with `api_mode='chatgpt_oauth'`, verify (a) DB has tokens, (b) disk has tokens (SSH probe), (c) `openclaw config get agents.defaults.model.primary` returns `openai-codex/*`, (d) `chatgpt_plan_type` is current.
- Alert on any miss.

Refresh failure rate alert (Rule 49 pattern):
- If >2% of refresh attempts fail in 1h → P1.
- If any `refresh_token_reused` → P0 per user.

Anthropic-only regression alert:
- Weekly sample 10 all_inclusive VMs, confirm cv-current + auth-profiles.json byte-identical to baseline + inference call still hits Anthropic with our key.

---

## 10. Rollback plan

### 10.1 Granular rollbacks

| Component breaks | Detection | Recovery |
|---|---|---|
| OAuth flow (users can't connect) | Telegram bot reports start-flow failures | Disable `/api/auth/openai/device-code/start` (return 503). Users in flight get error + retry button. Existing connected users keep working until token expires (10 days). |
| Refresh cron breaks | Telemetry: refresh attempts drop to 0 | Disable cron via Vercel toggle. Tokens expire in ~10 days. After expiry, users get the refresh-failed message + reconnect prompt. |
| `stepChatGPTOAuthToken` breaks (cv held) | Coverage query: chatgpt_oauth VMs with cv stuck | Temporarily filter chatgpt_oauth users out of reconciler candidate query (one-line cron-route diff). Fix root cause. Re-enable. |
| `stepAuthProfiles` regression breaks an all-inclusive VM | Anthropic-only regression alert | Revert the manifest bump immediately (Rule 47 means caught-up VMs only see the bad change post-bump). |
| Anthropic users get OAuth profile written to them | Synthetic test would catch; if production: Coverage query | Reconciler step has explicit `if (api_mode !== "chatgpt_oauth") return false` gate. If somehow bypassed, the kill switch disables the step entirely. |

### 10.2 Full feature kill switch

Set `OPENAI_OAUTH_ENABLED=false` in Vercel env (use `printf` per Rule 6). Within ~3 min:
- All OAuth API routes 503
- Reconciler step short-circuits
- Webhook ignores ChatGPT price IDs
- Refresh cron skips all users

Within ~10 days (token expiry):
- Existing chatgpt_oauth users hit 401 from chatgpt.com
- Their on-VM token is stale
- Graceful-downgrade cron runs (we build this as part of Phase 1 kill switch): for each chatgpt_oauth user, switch `api_mode` back to `all_inclusive`, push update via reconciler.

**The graceful-downgrade cron is the most important rollback safety net.** Build it on day 1 of Phase 1 alongside the kill switch.

### 10.3 Migration rollback

Pre-launch: migration in `pending_migrations/` (Rule 56). Reverting is `git revert`.

Post-launch: migration in `migrations/`. Columns are NULLABLE → can stay in place if we disable the feature. No destructive rollback.

### 10.4 The Anthropic-only-fleet safety net

The 246 existing all-inclusive users + 3 BYOK users have ZERO new code paths in Phase 1 IF we ship correctly. Specifically:
- Proxy at `app/api/gateway/proxy/route.ts` is unchanged in provider routing logic (lines 866-1026)
- `stepAuthProfiles` change is small, targeted, covered by synthetic test
- `stepEnforceModelPrimary` unchanged for non-chatgpt_oauth
- `toOpenClawModel` adds new cases but doesn't change existing
- `buildAuthProfilesJson` adds optional param; calls without it produce byte-identical output to today

**If any of these get touched accidentally, the synthetic tests catch it.** The Anthropic-only safety net is the synthetic test suite.

---

## 11. Open questions for Cooper

Most decisions are settled. A few details to confirm before engineering starts:

| # | Question | Default if you don't answer |
|---|---|---|
| 1 | **Model name probe strategy:** at connect-time, query `GET https://chatgpt.com/backend-api/codex/models` with the user's bearer to discover their available models, OR just pin `openai-codex/gpt-5.5` for everyone? | Pin `gpt-5.5` for Phase 1; probe in Phase 1.5 |
| 2 | **Daily message cap for chatgpt_oauth tier:** Starter 2000, Pro 5000, Power 15000 messages/day? Or different? | Use the proposed numbers; tune post-launch |
| 3 | **The discovery proactive Telegram DM** (one-time, top-decile users): ship in week 5 or skip entirely? | Skip for Phase 1; revisit post-launch based on dashboard banner conversion rate |
| 4 | **Telegram skill for slash commands:** implement as new OpenClaw skill installed on every VM, OR add to existing skills? | New skill (cleaner separation, easier rollback) |
| 5 | **Naming:** keep "Connect ChatGPT" / "Login with ChatGPT" per Cooper's Twitter announcement? | YES (the research agent's "BYOK OpenAI Key" was based on a false premise) |
| 6 | **OpenAI partnership outreach:** file the developer interest form on day 1? | YES (free, asymmetric, takes ~10 min) |
| 7 | **Phase 1.5 timeline:** start ~6 weeks after Phase 1 launches? | Yes — let Phase 1 soak, gather real fallback-rate data, then build the per-call fallback |

---

## 12. What happens after Cooper approves

Engineering kicks off with the safest piece first (Phase 0 already validated):

**Day 1-2:** Write `lib/openai-oauth.ts` + `lib/openai-oauth-encryption.ts`. Run against the Phase 0-captured JWT (still valid ~9 days). Verify all functions behave correctly. Pure-function unit tests.

**Day 3-5:** Migration + DB scaffold. Encryption key env var setup. Synthetic tests 1-3.

**Day 6-10:** Device-code API routes + middleware allow-list + dashboard UI for the modal flow. Internal manual testing via dashboard.

**Day 11-15:** `stepAuthProfiles` bug fix + synthetic test. `stepChatGPTOAuthToken` new step + synthetic tests 6-8. `toOpenClawModel` + `buildAuthProfilesJson` extensions.

**Day 16-18:** Refresh cron + monitoring telemetry + Coverage query + alerts. Stripe price IDs + webhook handler extension. Kill switch + graceful-downgrade cron.

**Day 19-20:** Canary VM testing. Internal beta with Cooper + 1 friendly.

**Day 21-23:** 5-user beta.

**Day 24-28:** Public launch + Twitter announcement.

---

**End of Phase 1 design document.** Once Cooper approves, engineering starts Day 1 with `lib/openai-oauth.ts`. The doc is comprehensive enough that any engineer can pick up the work and have full context.

The flagship-feature posture matters. We are first to compose ChatGPT subscription auth + persistent agent + on-chain wallet + cross-channel messaging. No competitor does this. Done well, this is the headline of the year for InstaClaw.
