# Skip to Command Center — Architecture & Edge Cases

**Date:** 2026-05-27
**Status:** UX shipped. Backend work documented below; needs Cooper review before any code lands.
**Companion files:** `app/channels/channels-client.tsx` (the link), `app/(dashboard)/layout.tsx` (the routing target).

## 1. What just shipped

A single footnote link on `/channels`, sitting above the existing "advanced: prefer your own Telegram bot?" line:

> prefer the web? **skip to your command center**. connect a channel anytime.

The link's `href` is `/dashboard`. Middleware (`middleware.ts:34`) bounces unauthenticated visitors to `/api/auth/signin?callbackUrl=/dashboard` automatically; authenticated visitors go straight to `/dashboard` where the layout's data-driven redirect (`app/(dashboard)/layout.tsx:101-144`) takes them to the next step based on VM state.

**Today, what happens when someone clicks it:**

| User state | Click outcome |
|---|---|
| Unauthenticated | Middleware → `/api/auth/signin?callbackUrl=/dashboard` → OAuth picker → after OAuth, `/dashboard` → layout `needsOnboarding` effect → fetch `/api/vm/status` → no VM → **`/connect`** (legacy BYOB Telegram setup) |
| Authenticated, no VM | Same as above — drops to `/connect` |
| Authenticated, configuring VM | `/dashboard` → layout redirect → `/deploying` (existing progress screen) |
| Authenticated, healthy VM, `onboarding_complete=false` | **Stays on /dashboard** (per Rule 33's data-driven gate; this is the working "skipped supplemental update" recovery path) |
| Authenticated, healthy VM, `onboarding_complete=true` | Stays on /dashboard. Cleanest experience. |

The first row is the unhappy path that the canonical design (§3) fixes. For Edge Esmeralda users, the layout's second effect (lines 187-241) also routes them through `/edge/intents` if `index_last_intent_at` is null — that gate fires regardless of skip choice and is correct behavior.

The immediate-ship link target (`/dashboard`) is the placeholder. The canonical target is `/onboarding/web` (a new route that lands in §3 of this doc). The link copy was chosen so that it doesn't make a promise the placeholder can't keep: "skip to your command center" lets the user know where they're going; the actual page they land on (today `/connect`, tomorrow the command center) still feels like progress, not a dead end.

## 2. The full onboarding chain (so the skip path is honest about what it bypasses)

The current channel-first funnel (verified via code reads):

```
/channels                  Public landing. No auth. Picks iMessage or Telegram.
   ↓                        User texts SMS or DMs @myinstaclaw_bot.
   ↓
inbound webhook            Sendblue or Telegram fires:
   ↓                        app/api/imessage/inbound/route.ts
   ↓                        app/api/telegram/shared-bot/inbound/route.ts
   ↓                        Both call lib/onboarding-signup.ts:resolveInbound
   ↓                        which INSERTs into instaclaw_pending_users
   ↓                        (channel, channel_identity, short_code; no user_id yet)
   ↓
Welcome 1 + 2 + 3          lib/welcome-messages.ts; W3 contains /go/<short_code>
   ↓
/go/<code>                 Server resolves short_code → pendingId, 302s to
   ↓                        /auth?session=<pendingId>
   ↓
/auth?session=<id>         app/(auth)/auth/page.tsx
   ↓                        Renders OAuth picker if unauthenticated.
   ↓                        Post-OAuth: binds pending.user_id, fires
   ↓                        assignOrProvisionUserVm() in after(),
   ↓                        redirects to /plan or /onboarding/done (Edge).
   ↓
/plan?channel=1&session=...  Stripe Checkout. Edge users skip this.
   ↓
/onboarding/done?session=... app/(onboarding)/onboarding/done/page.tsx
   ↓                          Personalization form. Submit fires
   ↓                          /api/onboarding/done/submit which marks
   ↓                          consumed_at and dispatches M_RETURN
   ↓
M_RETURN                    lib/m-return-dispatch.ts
   ↓                        Sends "hey {name}. what do you want to do first?"
   ↓                        via Sendblue (iMessage) or Telegram Bot API.
   ↓
Channel inbox               Agent's first message arrives in user's
                             iMessage / Telegram.
```

The skip path bypasses **all of**: inbound webhook, welcome burst, /go/, the binding step in /auth, M_RETURN's channel-side dispatch. It needs analogues for every one of those that doesn't depend on the user having a `channel + channel_identity` pair.

## 3. Canonical skip-path architecture (after Cooper's review)

```
/channels                  User clicks "skip to your command center".
   ↓
/dashboard (today)         Placeholder while §4 backend work pending.
   ↓
/signin (if unauthed)      Existing NextAuth OAuth picker.
   ↓ post-OAuth
/onboarding/web            NEW route — replaces /dashboard as the link target
   ↓                        once §4 ships. Server-side:
   ↓                        1. Auth check (404 if not authed; should never
   ↓                           happen because middleware enforces).
   ↓                        2. Idempotent: SELECT pending_users WHERE user_id
   ↓                           = me AND consumed_at IS NULL. If exists, reuse.
   ↓                           If not, INSERT pending_users(user_id=me,
   ↓                           channel='web', channel_identity=user_id,
   ↓                           short_code=NULL, skipped_channel_setup=true).
   ↓                        3. Fire assignOrProvisionUserVm in after().
   ↓                        4. Redirect to /plan?web=1&session=<id> or
   ↓                           /onboarding/done?session=<id>&web=1 for
   ↓                           Edge partners (sponsored trial, no card).
   ↓
/plan?web=1                Existing Stripe Checkout. The web=1 param flows
   ↓                        through to the success_url so /onboarding/done
   ↓                        knows the user is web-only.
   ↓
/onboarding/done?web=1     Existing personalization form, copy adapted:
   ↓                        instead of "the agent will text you back" we say
   ↓                        "the agent will be ready in your command center."
   ↓
/api/onboarding/done/submit  Branches on pending.channel:
   ↓                        - iMessage/Telegram: existing M_RETURN dispatch
   ↓                        - 'web': INSERT into a new dashboard_inbox table
   ↓                          (or reuse instaclaw_message_log) as the
   ↓                          pre-seeded welcome. NO Sendblue/Telegram call.
   ↓
/dashboard                  Command center renders the pre-seeded welcome
                             as the first message. Persistent nudge banner
                             shown above (§6).
```

The shape is intentionally symmetric to the channel path. Every step has the same name and the same role; the only thing that changes is the body of `/api/onboarding/done/submit`'s send-or-store branch and the `channel` value on the pending row.

## 4. Backend changes required (Cooper review before any code)

These are listed in order of dependency. None of them should ship as a one-off; each is a building block for the next.

### 4.1 New `channel` enum value: `'web'`

`instaclaw_pending_users.channel` is currently a TEXT column with three observed values: `'imessage'`, `'telegram'`, and `null` (for legacy /signup flow rows). Add `'web'` as a recognized value. No migration needed if the column is plain TEXT; if there's a CHECK constraint, add `'web'` to it.

Risks:
- `lib/m-return-dispatch.ts:254-261` switches on `pending.channel === "imessage" | "telegram"` and falls through to `unsupported_channel` for everything else. We need to add a `'web'` branch that stores instead of sends (§4.4).
- `lib/onboarding-signup.ts:findInFlightPending` keys uniqueness on `(channel, channel_identity)`. For `'web'`, `channel_identity` is meaningless (there's no inbound webhook to bind a phone or chat-id). We should set `channel_identity = user_id` for uniqueness, and treat that as a sentinel.
- The `(channel, channel_identity)` partial unique index needs to allow `('web', <user_id>)` with no clash. UUID format → no clash with E.164 phone or Telegram chat id. Safe.

### 4.2 New column: `instaclaw_users.skipped_channel_setup BOOLEAN DEFAULT false`

Surfaces the user's choice to:
- The dashboard layout (drives the "connect a channel" banner — §6)
- SOUL.md template generation (drives the "this user is web-only" section — §7)
- Analytics (so we can measure skip→connect conversion later)

Migration (per Rule 60, must enable RLS and be self-contained):
```sql
ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS skipped_channel_setup BOOLEAN NOT NULL DEFAULT false;
-- No new policies needed; instaclaw_users already has RLS on. Service-role
-- writes bypass; user reads via session callback. Existing posture covers it.
```

Per Rule 56: write to `instaclaw/supabase/pending_migrations/` first, apply to prod via Studio, then `git mv` to `migrations/`.

### 4.3 New route: `app/(onboarding)/onboarding/web/page.tsx`

Server component. Auth-required (middleware allow-list extension if it isn't already covered by `/onboarding/:path*`).

```typescript
// Sketch — not for ship without Cooper review
export default async function OnboardingWebPage() {
  const authSession = await auth();
  if (!authSession?.user?.id) redirect("/signin?callbackUrl=/onboarding/web");
  const userId = authSession.user.id;
  const supabase = getSupabase();

  // Idempotent — if user already has an in-flight pending row, reuse it
  // (this is critical: refresh on this page must not create duplicates).
  const { data: existing } = await supabase
    .from("instaclaw_pending_users")
    .select("id, channel")
    .eq("user_id", userId)
    .is("consumed_at", null)
    .maybeSingle();

  let pendingId: string;
  if (existing) {
    pendingId = existing.id;
    // If the existing row is from a channel attempt, do NOT clobber it.
    // The user can still complete that channel flow if they want; we
    // just don't create a parallel 'web' row.
  } else {
    const { data: inserted, error } = await supabase
      .from("instaclaw_pending_users")
      .insert({
        user_id: userId,
        channel: "web",
        channel_identity: userId, // sentinel — UUID can't collide with phone/tg-id
      })
      .select("id")
      .single();
    if (error || !inserted) {
      logger.error("[/onboarding/web] pending insert failed", { userId, error });
      redirect("/dashboard"); // fallback — they're authed, /dashboard layout will route
    }
    pendingId = inserted.id;

    // Flip the user-level flag so SOUL.md gen + dashboard banner know.
    await supabase
      .from("instaclaw_users")
      .update({ skipped_channel_setup: true })
      .eq("id", userId);
  }

  // Fire VM provisioning in after() so the redirect isn't blocked.
  after(async () => {
    try { await assignOrProvisionUserVm(userId, { supabase }); } catch (err) { /* logged */ }
  });

  // Branch: Edge partner skips /plan (sponsored trial, no Stripe).
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("partner")
    .eq("id", userId)
    .maybeSingle();
  if (user?.partner === "edge_city") {
    redirect(`/onboarding/done?session=${pendingId}&web=1`);
  }
  redirect(`/plan?web=1&session=${pendingId}`);
}
```

Notes:
- Mirrors the structure of `app/(auth)/auth/page.tsx` so future maintenance is symmetric.
- The `idempotent on refresh` property is load-bearing — a user who reloads the page must not create N pending rows.
- Skipping a channel attempt's existing pending row preserves Rule 22-class invariant: never destroy user state. If a user texted iMessage, then changed their mind and went back to skip, we don't clobber the iMessage row; we just don't create a parallel.

### 4.4 `lib/m-return-dispatch.ts` — `'web'` branch

Replace the existing dispatch-or-fail block:

```typescript
// Existing (lines 253-262):
if (pending.channel === "imessage") {
  await sendImessage(pending.channel_identity, message);
} else if (pending.channel === "telegram") {
  await sendTelegramSharedBot(pending.channel_identity, message);
} else {
  await rollbackMReturnClaim(supabase, pendingId, nowIso);
  return { ok: false, reason: "unsupported_channel", detail: pending.channel };
}

// Replace with:
if (pending.channel === "imessage") { /* unchanged */ }
else if (pending.channel === "telegram") { /* unchanged */ }
else if (pending.channel === "web") {
  await storeDashboardWelcome(supabase, pending.user_id!, message);
}
else { /* unsupported_channel */ }
```

`storeDashboardWelcome` is a new helper that writes the M_RETURN string into whatever table the command center reads from. Two options:

**Option A (preferred — minimal):** Reuse `instaclaw_message_log` or whichever table the existing command center renders as agent messages. The pre-seeded welcome appears as the first message in the conversation, identical visual treatment as any other agent reply. This requires zero new UI work.

**Option B (more invasive):** Create a `dashboard_inbox` table. Command center reads from both `dashboard_inbox` (system-generated) and `message_log` (chat history) and renders both. Useful if we want different visual treatment for system messages, but it's net more code.

Pick A unless there's a strong reason to discriminate.

### 4.5 `lib/auth.ts` session callback — surface `skippedChannelSetup`

The session callback already populates `session.user.partner` and `session.user.onboardingComplete` from `instaclaw_users`. Add `skippedChannelSetup`. Dashboard layout + SOUL.md generators read it. No frontend changes needed beyond exposing the field on the session type.

### 4.6 `lib/ssh.ts:configureOpenClaw` — channel-agnostic mode

This is the deepest refactor and the riskiest. Today configureOpenClaw expects to write `channels.telegram.botToken` (or equivalent for iMessage) as part of its atomic A-write. For a web-only user, none of those fields exist; the function needs to:

1. Skip the channel-specific config writes (`channels.telegram.botToken`, `channels.imessage.sendblueNumber`, etc.) when `vm.channel = 'web'` (or equivalent flag).
2. Still write everything else (gateway, wallets per Rule 66, env vars, OpenClaw plugins).
3. Preserve Rule 33's atomicity invariants — if any critical step fails, mark `configure_failed` so the retry machinery re-attempts.

Safest refactor shape:
- Add `vm.channel TEXT NULL` to `instaclaw_vms` (mirrors the pending_users column).
- At the start of configureOpenClaw, branch on `vm.channel`:
  - `'imessage'` | `'telegram'`: existing path.
  - `'web'` | `null`: skip the channel block.
- The supplemental update at the end of /api/vm/configure (writes `telegram_bot_username`, `partner`, etc.) is unaffected — those fields are unconditional and OK to be null.

Risk note (Rule 33): the supplemental update writes `onboarding_complete=true` and `pending_users.consumed_at=NOW()` in the same atomic block as `telegram_bot_username`. If we make `telegram_bot_username` conditional (skip for web users), the supplemental update needs to still fire. We're not making telegram_bot_username required; we're just letting it stay NULL. The supplemental update should land regardless.

### 4.7 SOUL.md template — `WEB_ONLY_USER` section

Add a marker-bounded section that ships only when `user.skipped_channel_setup = true`. Per Rule 23, the section must have a sentinel that `stepInstaClawIdentityPatch` (or a new sibling step) can grep for to verify presence.

Sketch content (~600 chars):

```markdown
## Web-Only User (WEB_ONLY_USER_V1)

The user is currently chatting with you via the web command center on
instaclaw.io/dashboard — they haven't connected iMessage or Telegram.

- Don't try to proactively message them outside the dashboard. They're
  not listening on a phone.
- When they ask you to "text me" or "send me a reminder", explain
  warmly that you'd need a messaging channel for that, and that
  connecting one is a single tap at /channels. Don't be pushy.
- Some users prefer the web. That's a valid permanent choice; don't
  assume they'll connect later.
```

Bootstrap-budget impact: ~600 chars. Per Rule 65 / v92 changelog notes, the SOUL.md bootstrap is currently 34,771 chars on edge_city VMs against a 40,000-char ceiling. Headroom available: ~5,200 chars. Safe to add.

Section must live BELOW the `OPENCLAW_CACHE_BOUNDARY` marker so the Anthropic prompt cache doesn't invalidate when a user later connects a channel and we remove the section.

### 4.8 New reconciler step: `stepWebOnlyUserSoul`

Marker-guarded (`WEB_ONLY_USER_V1`). When `vm.user.skipped_channel_setup = true`, inserts the section. When false (user later connected a channel), removes the section. Mirror of `stepInstaClawIdentityPatch` exactly — surgical Python in-place edit, backup, verify-after-write, idempotent.

## 5. The dashboard first-load experience for a skip user

Today (placeholder phase): user lands on `/connect` (BYOB Telegram setup), which doesn't match their intent. This is the unhappy path the §3 plan fixes.

After §4 ships: user lands on `/dashboard`. Command center (`/tasks`) is the primary surface. They see:

1. **The pre-seeded welcome message** (from M_RETURN web branch): "hey {name}. ready when you are. what do you want to do first?" — identical voice as the channel version. First and only message in their inbox.
2. **A persistent banner** (above the command center, dismissable but re-appears periodically):

   > Connect iMessage or Telegram for the full experience. Your agent works best when you can message it like a friend. **[Connect a channel →]**

   The button goes to `/channels`. The banner uses muted brand colors (no orange CTA — that competes with the command center input). Dismissal sets `dismissed_channel_nudge_at` (new column on `instaclaw_users` or a JSONB preferences blob) with 7-day TTL. Re-appears after.

3. **Input field is functional immediately.** Type, send, agent replies. Gateway is provisioned and ready (configureOpenClaw ran during the OAuth → /plan transition, identically to the channel path).

What they cannot do:
- Receive proactive messages from the agent (no channel = no push surface).
- Have the agent send them a photo or media (Sendblue/Telegram is the transport for that).
- Get "text me at 9am" reminders. The agent can SET reminders but has no way to reach them outside the browser. See §6 for how the agent handles this.

## 6. Nudge strategy (after §4)

Three surfaces. Each independent; failure of one doesn't break the others.

### 6.1 Persistent banner (always visible, dismissible)

Above the command center on every dashboard route. Renders when `user.skipped_channel_setup = true` AND `dismissed_channel_nudge_at` is either NULL or older than 7 days. Single sentence + button. Cooper voice.

Threshold for converting a skip → connect: probably high friction (you have to leave the dashboard, pick a channel, complete pairing). So the banner has to be high-trust, low-pressure. "for the full experience" is the right register — descriptive, not coercive.

### 6.2 Capability-aware nudges (in-conversation)

When the user asks the agent to do something that requires a channel:
- "remind me at 9am" / "text me when the deploy finishes" / "send me a daily digest"
- "send me a photo of X"

…the agent's SOUL.md WEB_ONLY_USER section instructs it to respond with a warm offer to connect a channel. Example reply (not hardcoded; the agent generates this from the SOUL.md guidance):

> Happy to set that up — but I'd need a way to reach you outside the browser. iMessage or Telegram, both take ~60 seconds. Want to connect one?
> [reply: "yeah" → agent links to /channels]
> [reply: "no, just check in here" → agent acknowledges, sets the reminder to fire on next dashboard load]

This is the highest-converting nudge because it surfaces at the exact moment the user feels the missing capability.

### 6.3 SOUL.md proactivity (light touch, every ~10 conversations)

Once every ~N turns, the agent can mention channels naturally if the conversation lulls: "by the way, if you connected iMessage I could ping you when the price hits your target — no need to refresh."

Frequency cap is critical. Annoying nudges churn. Aim for "you'd notice if it disappeared, but you don't get tired of it."

## 7. Edge cases (each named with recommended handling)

### 7.1 User skips, then immediately texts the SMS number anyway

Common — they read about /channels, decided to skip, then thought "actually let me also test iMessage." The inbound webhook fires `resolveInbound` which:
- Finds the existing `('web', user_id)` pending row from /onboarding/web? **No** — `findInFlightPending` keys on `(channel, channel_identity)` and they don't match ('web' ≠ 'imessage', user_id ≠ phone).
- Tries to insert `('imessage', phone)`. Partial unique index allows because no `('imessage', <this_phone>)` row exists.
- Creates a NEW pending row, fires welcome burst.

Result: user has TWO pending rows. The web row consumes via /onboarding/done (or never — they might never visit it). The imessage row tries to consume via M_RETURN.

**Handling:** the auth/bind step in `/auth?session=<imessage_pending_id>` (when they click /go/<code>) should check `findKnownUserBinding` first. If the user already has a known VM (because the web flow already provisioned one), `resolveInbound` returns `{ kind: "known" }` and the imessage webhook just acknowledges them as a returning user — sends a "welcome back" SMS instead of a new welcome burst.

This is already what the code does (lines 157-161 of `lib/onboarding-signup.ts`). Verify the binding lookup correctly recognizes a web-onboarded user.

Risk: the binding lookup keys on `(channel, channel_identity) → user_id`. If the web user has no `imessage` row in the binding table, the lookup returns null and we treat them as new. We need to ALSO check `instaclaw_pending_users` directly for any consumed-or-in-flight row by user_id when the channel doesn't match — and if we find one, decide whether to add the channel to their existing user (yes — this is the "user connected a channel after skip" success path).

**Recommended:** extend `resolveInbound` to also do a phone/tg-chat-id → user lookup (if we have it cached anywhere; if not, this is a future-work item). Until then, the dual-pending case is a known minor wart — the user gets a small welcome SMS they don't really need. Not breaking, just slightly awkward.

### 7.2 User skips while already mid-flow on a channel

User: pulls up /channels in two tabs. Texts the SMS in tab A (pending row created, welcome sent). Comes back to tab B and clicks skip.

- Tab B → /onboarding/web → SELECTs existing pending row for this user. Wait — but the imessage row from tab A doesn't have user_id set yet (it's bound at /auth, not at webhook time). So the SELECT in /onboarding/web returns NULL. We create a fresh `('web', user_id)` row.
- Now there are TWO in-flight rows for the same eventual user. The user's session-id from tab A is bound via /auth → user_id = X. The session-id from tab B is bound via /onboarding/web → user_id = X.
- assignOrProvisionUserVm fires twice. The function should be idempotent (verify); if not, race.

**Handling:** confirm `assignOrProvisionUserVm` is idempotent on `user_id`. If two callers race and a second VM is allocated, that's wasted Linode spend + confusion. The existing process-pending Pass 0 likely catches this (Rule 33's machinery), but worth a code-level audit.

### 7.3 Skip user clicks "Connect a channel" later

Banner button → /channels. They tap iMessage → text the number. Inbound webhook fires.

- `resolveInbound` checks `findKnownUserBinding('imessage', phone)`. No binding yet. Returns null.
- Tries to insert `('imessage', phone)`. Succeeds.
- New pending row. Welcome burst sent.

User then clicks /go/<code> in W3 → /auth?session=<new_id>. They're already signed in.

- `/auth` binds pending.user_id = me.
- Fires assignOrProvisionUserVm again. Should be idempotent — already-assigned user returns early.

But now the user has TWO pending rows: the original `('web', user_id)` consumed weeks ago, and the new `('imessage', phone)` in-flight.

- M_RETURN dispatches via iMessage successfully (the imessage pending row consumes).
- After M_RETURN, the user's VM gets `vm.channel = 'imessage'` (or however we track current channel) and `user.skipped_channel_setup = false`.

**Handling:** `/api/onboarding/done/submit` (or equivalent post-channel-connect path) updates `instaclaw_users.skipped_channel_setup = false` AND `instaclaw_vms.channel = 'imessage'`. The reconciler's `stepWebOnlyUserSoul` (§4.8) detects the flag change on next tick and removes the SOUL.md WEB_ONLY_USER section. SOUL.md realigns within ~3-5 min via reconciler.

### 7.4 M_RETURN web branch fires before VM is ready

Per `lib/m-return-dispatch.ts:209-211`, if `vm.gateway_url` is null, dispatch returns `{ ok: false, reason: "vm_not_ready" }` and the sweep cron retries on the next minute. This works identically for web users — we just substitute `sendImessage` / `sendTelegramSharedBot` with `storeDashboardWelcome`.

**Verify:** `storeDashboardWelcome` MUST be safe to call before the VM is fully ready. If it writes to a table the command center reads, that's fine — the table exists regardless of VM state. If it does anything that depends on `vm.gateway_url`, we have a problem. Recommend: just INSERT the row, ignore VM state.

### 7.5 Skip user lands on dashboard while VM is still configuring

`/dashboard` layout's `needsOnboarding` effect (lines 101-144) fetches `/api/vm/status`. If `status === 'assigned' && !vm.gatewayUrl`, redirects to `/deploying`. Skip user sees the deploying screen — same UX as a channel user. Fine.

If `status === 'assigned' && vm.healthStatus === 'configure_failed'`, redirects to `/deploying` (retry UI). Also fine.

### 7.6 Skip user on the World mini app

The mini app embeds `/dashboard` directly. A mini-app user clicking "skip" would already be authenticated, already in the app. They'd skip channels and stay in the mini app. No conflict.

But: a mini-app user typically already has a "channel" of sorts (the mini-app itself). The skip flow doesn't make sense for them — they're already web-only by definition. The /channels page might need a `?source=miniapp` query param that hides the skip link entirely (since it's redundant). Defer this until the mini app's onboarding path actually routes through /channels (it currently doesn't — it has its own flow).

### 7.7 Skip user signs up via partner portal (Edge City, future Eclipse, etc.)

Partner-tagged users skip /plan (sponsored trial). The /onboarding/web sketch in §4.3 handles this: it branches on `user.partner === 'edge_city'` and redirects to `/onboarding/done` directly. Partner-specific skill installs (per Rule 9) are independent of channel choice; they fire from `configureOpenClaw` regardless.

Edge users with skip choice: SOUL.md gets BOTH the WEB_ONLY_USER section AND the Edge partner stub. Bootstrap budget: ~600 chars for web-only + ~220 chars for Edge stub = 820 chars added. Still inside the 40K cap.

### 7.8 Skip user cancels their subscription

Same path as any cancellation — Stripe webhook fires `customer.subscription.deleted`, the billing webhook tears down. Skip doesn't change anything here.

### 7.9 Skip user is past_due (Rule 14 grace window)

Per Rule 14, `lib/billing-status.ts:getBillingStatusVerified` treats `payment_status='past_due'` within 7 days as still-paying. Skip doesn't change billing classification; web users get the same grace.

### 7.10 Race: M_RETURN sweep cron fires for a 'web' pending row while user is on /onboarding/done

The submit endpoint's CAS on `m_return_sent_at` (lines 229-247 of m-return-dispatch) protects this. Whichever caller wins the CAS owns the dispatch. The other returns `{ ok: false, reason: "already_sent" }` and silently no-ops. No duplicate welcome.

### 7.11 Skip user gets a `frozen` VM (90+ day inactivity, per Rule 14 / Rule 15)

Same thaw path as any frozen VM — `lib/vm-freeze-thaw.ts:thawVM` re-provisions from snapshot. Skip doesn't change anything about freeze/thaw.

But: the SOUL.md WEB_ONLY_USER section content is regenerated by the reconciler post-thaw based on `user.skipped_channel_setup`. If the user wakes up after 90 days and they're still web-only, the section returns. Good.

## 8. Open questions for Cooper

1. **Pick A or B for the welcome-storage table?** §4.4 prefers reusing `instaclaw_message_log`; B creates a dedicated `dashboard_inbox`. Recommend A unless the command center renders need to discriminate.
2. **Banner copy and dismissal cadence?** §6.1 proposed 7-day TTL after dismissal. Too short = annoying, too long = no nudge. Cooper's call.
3. **Capability-aware nudge tone?** §6.2 example reply tries to be warm but not pushy. Iterate on actual SOUL.md guidance once we see real conversations.
4. **Should /channels show the skip link to authenticated users only, or to everyone?** Currently the implementation shows it to everyone. An unauthenticated visitor clicking skip will be bounced to /signin first. That's fine for the placeholder phase but worth deciding for the canonical phase — maybe pre-auth visitors get a different copy ("create an account to go straight to the command center") that's slightly more explicit about the OAuth step.
5. **Migration for existing legacy /signup users?** They have `skipped_channel_setup = false` by default. If we want to flip them to true (since they don't have a channel via the new model — they have BYOB Telegram tokens), we need a backfill. Or we could leave them as-is and just trust `vm.telegram_bot_token IS NOT NULL` as the actual signal. The backend code should probably read `vm.channel` (planned in §4.6) rather than the user-level flag, since `vm.channel` is the source of truth for "what does this VM actually use." The user-level flag is more about analytics/funnel intent.
6. **Telemetry?** Add a `skip_to_command_center` event on the link click (PostHog or whatever). Funnel: /channels view → skip clicks → /onboarding/web reached → VM provisioned → first command-center message sent → channel connected later. We want all five.

## 9. What I'd build first (suggested order)

1. **Migration + column** (§4.2). 10 LOC, low risk. Lands the field without any consumer.
2. **/onboarding/web route** (§4.3). Self-contained; no other code reads from it yet. Test by manually visiting; verifies pending row is created and VM is fired.
3. **M_RETURN web branch** (§4.4). Reuse `instaclaw_message_log`. Test by completing the web flow end-to-end and confirming the welcome appears in command center.
4. **Dashboard banner** (§6.1). Conditional render on `session.user.skippedChannelSetup`. Visual-only; no backend hookup.
5. **SOUL.md template change** + reconciler step (§4.7, §4.8). Last because it's the deepest and depends on the user-flag being live.

Phase 1 (steps 1-3): canonical /onboarding/web exists, welcome lands in command center. Skip link target switches from `/dashboard` to `/onboarding/web`. Phase 1 ships an experience that matches the link's promise.

Phase 2 (steps 4-5): the polish layer. Nudge banner + agent self-awareness. Conversion lift comes from these.

## 10. What I'd NOT build

- A dedicated `dashboard_inbox` table (§4.4 Option B). The existing message log is enough.
- A multi-channel switcher on the dashboard ("I want to add a second channel"). The /channels page already supports this — connecting iMessage after Telegram, etc.
- A "skip permanently" preference. The user can simply ignore the banner. Adding a "never ask me again" toggle is feature bloat at this stage.
- Push notifications as a substitute for messaging channels. Different surface, different problem. Out of scope.

## 11. Risks I'm flagging without being asked

- **Race: skip + concurrent inbound webhook (§7.1, §7.2).** Two pending rows for the same user. Not breaking, but ugly. Worth a 30-min audit of `assignOrProvisionUserVm`'s idempotency before §4.3 ships.
- **VM provisioning latency vs. dashboard land time.** A user clicks skip → OAuth → Stripe → /onboarding/done → submits → lands on /dashboard. The VM might still be configuring. They see /deploying instead of the command center. UX-wise that's the same as the channel path; functionally fine. But for a skip user the value prop is "fast access to the command center" — and /deploying breaks that promise. Worth measuring: median time from skip click to first usable command-center input. If it's >2 minutes routinely, we have a problem.
- **Bootstrap budget creep (§4.7).** Adding the WEB_ONLY_USER section eats ~600 chars of headroom. We have ~5,200 left. Each future partner / each future user-type-specific section eats more. At some point we need the deep trim of `WORKSPACE_SOUL_MD` (21K chars) tracked as a P1 in CLAUDE.md. Skip isn't the cause but it's another straw on the camel.
- **Command center maturity.** The /tasks page is 4,386 lines and references channels heavily. For a web-only user the "Telegram is connected" status banner shouldn't render; the "send me a photo via iMessage" type of CTA shouldn't appear. Audit needed (§6 doesn't fully cover this).
- **The placeholder phase (today through §4 ship) routes skip users to /connect (legacy BYOB).** This is misleading. The longer this gap, the more we should consider a `redirect("/coming-soon-web-onboarding")` interstitial that's honest about it. Or just sprint §4.

---

## Companion files

- `app/channels/channels-client.tsx` — the link itself (line ~234, two-line footer block).
- `app/(dashboard)/layout.tsx:101-144` — the dashboard's data-driven routing for users with `onboarding_complete=false`. Today the skip target.
- `lib/m-return-dispatch.ts:254-261` — where the `'web'` branch lands in §4.4.
- `lib/onboarding-signup.ts:resolveInbound` — channel-binding logic; §7.1 race-handling lives here.
- `app/(auth)/auth/page.tsx` — the structural model for the new `/onboarding/web` route.
- `app/(onboarding)/onboarding/done/page.tsx` — submit page; needs minor copy adaptation in §3 if `web=1` query is present.

## Related CLAUDE.md rules

- **Rule 22 / Rule 30** — never destructively modify user state. Applies to §7.2 (don't clobber existing pending rows on skip).
- **Rule 23** — sentinel-grep required templates. Applies to §4.8 WEB_ONLY_USER section.
- **Rule 33** — onboarding state machine, trap-state detection. Skip is a NEW transition in the state machine; the data-driven dashboard redirect already accommodates `onboarding_complete=false + healthy VM` so the skip path doesn't introduce a new trap.
- **Rule 47** — file-drift cron continuous reconciliation. The SOUL.md section change lands via this path even without a manifest version bump.
- **Rule 56** — migration self-containment. §4.2 column add follows this.
- **Rule 60** — RLS on every new table/column. §4.2 covers.
- **Rule 64** — manifest bumps need explicit approval. The §4.8 reconciler step requires a manifest bump; that's gated on Cooper's review of the whole arch doc.
- **Rule 66** — every VM gets both Bankr + CDP wallets. Skip doesn't change this; wallets are provisioned by `configureOpenClaw` regardless of channel.
