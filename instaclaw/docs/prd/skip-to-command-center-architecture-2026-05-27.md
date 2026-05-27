# Skip to Command Center — Spec & Implementation Plan

**Date:** 2026-05-27
**Status:** UX shipped (commit `bda4d187`). Backend spec ready to implement. Every decision below is mine to make — only escalate items to Cooper if explicitly marked **DECISION REQUIRED: COOPER**.
**Companion files:** `app/channels/channels-client.tsx` (the link), `app/(dashboard)/layout.tsx` (the routing target).

## What changed since the v1 doc

The v1 doc was a proposal with 6 open questions. This v2 is a SPEC. Every question got an answer; every estimate got replaced with measurement; every assumed risk got replaced with the actual audit. Highlights:

- **The skip path is formalizing an existing state, not inventing one.** 7 production VMs already run with `channels_enabled = []` today (verified via `instaclaw_vms` query). `configureOpenClaw` is already null-safe.
- **The §4.6 configureOpenClaw refactor in v1 is dead.** Verified: `lib/ssh.ts:5260` already gates `channels.telegram` writes on `channels.includes("telegram") && config.telegramBotToken`. Same for Discord at line 5293. No refactor needed; the function already does the right thing.
- **The command-center channel audit (v1's §11 risk #4 "the /tasks page is 4,386 lines and references channels heavily") came back at 3 cosmetic line changes total.** Listed in §6.
- **The bootstrap-budget concern is stale.** The V2 split (per CLAUDE.md v106 changelog) moved most content to `AGENTS.md`; SOUL.md is now 6,415 chars on a healthy edge_city VM (vm-1005), not 34K. The WEB_ONLY_USER section should land in `AGENTS.md`, not `SOUL.md`.
- **The /onboarding/web prototype was written, type-checked against the real codebase, and verified clean.** Code in §4 below is ready-to-ship.
- **`instaclaw_users.preferred_channel` column ALREADY EXISTS** (NULL on 1000/1000 users today). It's the natural surface for "web" vs "imessage" vs "telegram" — no new BOOLEAN column needed.

## 1. The UI that shipped (commit `bda4d187`)

Single footnote link on `/channels`, above the existing "advanced" line:

> prefer the web? **skip to your command center**. connect a channel anytime.

Same typography as the advanced line; two stacked footnotes reading as a paired escape-hatch zone. `href = /dashboard`. Middleware bounces unauth → `/api/auth/signin?callbackUrl=/dashboard` automatically; authed users go straight through. Verified at 1440/768/390 — both lines wrap symmetrically (2 lines each on mobile, 1 line each on desktop/tablet).

**Today's behavior** (placeholder until §4 ships):

| User state | Outcome on click |
|---|---|
| Unauthenticated | → /signin → after OAuth → /dashboard → layout fetches /api/vm/status → no VM → **/connect (legacy BYOB Telegram page)** |
| Authenticated, no VM | Same end state — /connect |
| Authenticated, VM configuring | /deploying |
| Authenticated, healthy VM | Lands on /dashboard cleanly |

After §4 ships: link target swaps to `/onboarding/web`, every state above lands in the command center within ~30s.

## 2. What I measured in production before writing the rest of this doc

### 2.1 Population census (run 2026-05-27 against prod Supabase)

```
Total users:                                       1000
Users with preferred_channel != NULL:              0    (column is unused — safe surface)

Total assigned VMs:                                184
Assigned VMs with channels_enabled = []:           7    (already in skip state!)
Assigned VMs with channels_enabled = ["telegram"]: 177

Of the 158 healthy + assigned VMs:
  BYOB Telegram + paired (bot_token + chat_id):     5
  BYOB Telegram unpaired (bot_token only):          74
  Shared bot (chat_id only):                        0
  Neither token nor chat_id (web/pre-paired):       79

The 7 channel-less VMs:
  All starter tier + all_inclusive api_mode
  All healthy
  All created Feb-March 2026 (early seed cohort)
  All have last_user_activity_at clustered 2026-05-01..02
  None have a partner tag
  Names: vm-036, vm-040, vm-108, vm-511, vm-527, vm-603, vm-linode-10
```

**Implication:** the skip path is formalizing reality. `configureOpenClaw` running with `channels: []` is a tested, working production state — not a new branch I need to build.

### 2.2 SOUL.md / AGENTS.md byte counts (vm-1005, edge_city, healthy)

```
SOUL.md            6,415
CAPABILITIES.md   19,984
MEMORY.md            548
TOOLS.md           6,415
AGENTS.md         30,077
EARN.md           10,495
QUICK-REFERENCE.md 2,038
TOTAL             75,972
```

**Implication:** my v1 doc estimated SOUL.md at ~34,771 chars (v92 number). It's now 6,415 — the V2 split (v106 changelog) moved most content to AGENTS.md. Adding the WEB_ONLY_USER section (~600 chars) to AGENTS.md takes it to 30,677 chars. AGENTS.md is not bootstrap-budget-constrained the way SOUL.md V1 was; the section belongs there.

### 2.3 configureOpenClaw channel-write trace (lib/ssh.ts)

Single channel-write site per channel type, both already null-safe:

```
lib/ssh.ts:5260 — buildOpenClawConfig (Telegram block)
  if (config.channels?.includes("telegram") && config.telegramBotToken) {
    (ocConfig.channels as ...).telegram = { botToken: ..., ... };
    (ocConfig.plugins as ...).entries = { ...prev, telegram: { enabled: true } };
  }

lib/ssh.ts:5293 — buildOpenClawConfig (Discord block)
  if (config.channels?.includes("discord") && config.discordBotToken) {
    (ocConfig.channels as ...).discord = { botToken: ..., ... };
    (ocConfig.plugins as ...).entries = { ...prev, discord: { enabled: true } };
  }

lib/ssh.ts:6118 — configureOpenClaw (Telegram webhook delete; same guard)
  if (channels.includes("telegram") && config.telegramBotToken) {
    scriptParts.push('# Delete any old Telegram webhook ...');
  }
```

`ocConfig.channels` is `{}` (empty object) by default at line 5218 and `ocConfig.plugins.entries` is `{}` at line 5255. If neither guard fires, gateway boots with no channels and no plugins.entries.telegram. That's exactly what the 7 production channel-less VMs run.

**Verdict on v1's §4.6 refactor:** dead. No code change to configureOpenClaw needed.

### 2.4 Command-center channel-coupling audit (all `(dashboard)` pages)

Every line that references `telegram_bot_token`, `channelsEnabled`, `telegramBotUsername`, or related concepts:

| File:line | Behavior today | Skip-safe? | Change |
|---|---|---|---|
| tasks/page.tsx:2148-2152 | Default state `channelsEnabled: []`, `telegramBotUsername: null` | ✓ Safe | None |
| tasks/page.tsx:2261-2265 | Fetched state with `?? []` fallback | ✓ Safe | None |
| tasks/page.tsx:2952-2953 | `isTelegramConnected = channelsEnabled.includes("telegram") && !!telegramBotUsername` | ✓ Both false for skip | None |
| tasks/page.tsx:3068-3069 | Connectors submenu shows both as disconnected | ✓ Renders fine | None |
| tasks/page.tsx:1606-1614 | Per-task chip "Auto-sent to Telegram" / "Telegram not connected" | ⚠️ Renders "Telegram not connected" on every task — noisy | **Hide chip if `!isTelegramConnected && !isDiscordConnected`** |
| dashboard/page.tsx:206 | Popup latch gated on `vm.telegramBotUsername` | ✓ Won't fire for skip | None (web users don't need this celebration) |
| dashboard/page.tsx:661 | `agentName={vm.telegramBotUsername}` passed to Bankr card | ⚠️ null reaches the Bankr card | **Change to `agentName={vm.telegramBotUsername ?? vm.agentName}`** (agent_name column exists per schema) |
| dashboard/page.tsx:998-1017 | "Open Telegram" tile, gated on `vm.telegramBotUsername` | ✓ Hidden for skip | None |
| dashboard/page.tsx:1410-1411 | Inline "at @username", gated | ✓ Hidden for skip | None |
| settings/page.tsx:725 | "Bot username: @x or —" | ✓ Renders — | None |
| settings/page.tsx:752 | `channels_enabled?.join(", ") ?? "telegram"` | ⚠️ Empty string for `[]` | **Change to `channels_enabled?.length ? channels_enabled.join(", ") : "none yet"`** |
| settings/page.tsx:853-934 | Telegram BYOB management — paste-token UI | ✓ Skip users see the paste-token UI; that's the right place to connect later | None |
| settings/page.tsx:974, 1019, 1064 | Discord/Slack/WhatsApp sections gated on `channelsEnabled?.includes(X)` | ✓ Hidden | None |
| earn/page.tsx | "Channels" refers to *earning channels* (polymarket, etc.), not messaging | ✓ Unrelated | None |

**Net change in the command center: 3 lines (one in tasks, one in dashboard, one in settings). Not a 1-week build — a 1-hour polish pass.**

## 3. The canonical skip-path architecture

```
/channels                  User clicks "skip to your command center"
   ↓
/onboarding/web            NEW route — server-side
   ↓                       (auth check → /signin if needed)
   ↓                       SELECT pending_users for in-flight row:
   ↓                         - existing 'web' row → reuse (idempotent refresh)
   ↓                         - existing 'imessage'/'telegram' → bail to /dashboard
   ↓                         - none → INSERT (user_id, channel='web', channel_identity=user_id)
   ↓                       UPDATE instaclaw_users.preferred_channel = 'web'
   ↓                       assignOrProvisionUserVm via after()
   ↓                       redirect /plan?web=1&session=<id>  (Edge: /onboarding/done?session=<id>&web=1)
   ↓
/plan?web=1                Stripe Checkout (Edge skips)
   ↓
/onboarding/done?web=1     Personalization form, copy adapted for web users
   ↓
/api/onboarding/done/submit  Branches on pending.channel:
   ↓                         - imessage/telegram: existing M_RETURN dispatch
   ↓                         - 'web': INSERT into instaclaw_message_log as pre-seeded
   ↓                                  agent welcome. NO Sendblue/Telegram call.
   ↓
/dashboard → /tasks        Command center renders the welcome as message #1.
                            Persistent banner offers "connect iMessage or Telegram".
```

Symmetric to the channel-first chain. Every step has the same name and role; the differences are localized to `/onboarding/web` (new route), the `'web'` branch of `m-return-dispatch`, and the dashboard banner.

## 4. Backend implementation — ready to ship

Implementation order. Each step is independent and individually testable.

### 4.1 Migration: extend channel enum + add 'web' as valid

`preferred_channel` already exists on `instaclaw_users`. `channel` already exists on `instaclaw_pending_users`. Neither has an enum constraint (verified — both are plain TEXT). **Zero schema change needed** for the `'web'` value to be insertable.

**Telemetry-friendly column** (DECISION: ship a new audit/funnel-friendly column, see §5.6):

`instaclaw/supabase/pending_migrations/20260527180000_users_skip_path_columns.sql`

```sql
-- preferred_channel already exists; just document the 'web' value going live.
-- Add a dismissed_channel_nudge_at for the banner cadence.

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS dismissed_channel_nudge_at TIMESTAMPTZ NULL;

-- No RLS changes needed — instaclaw_users already has RLS on with the
-- existing service-role-bypasses + session-callback-reads posture.
-- Per Rule 60: this migration is self-contained.

COMMENT ON COLUMN public.instaclaw_users.dismissed_channel_nudge_at IS
  'Last time the user dismissed the "connect a channel" nudge banner on
   /dashboard. Banner re-appears if NULL or older than 14 days. Set by
   POST /api/onboarding/dismiss-channel-nudge.';
```

Per Rule 56 procedure: write to `pending_migrations/`, apply via Studio, then `git mv` to `migrations/`.

### 4.2 New route: `app/(onboarding)/onboarding/web/page.tsx`

**Prototyped, type-check passed in-tree.** Ready to ship as-is:

```tsx
import { redirect } from "next/navigation";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { assignOrProvisionUserVm } from "@/lib/createUserVM";
import { logger } from "@/lib/logger";

export default async function OnboardingWebPage() {
  const authSession = await auth();

  // Unauthenticated → /signin with callbackUrl preserved.
  if (!authSession?.user?.id) {
    redirect("/signin?callbackUrl=/onboarding/web");
  }
  const userId = authSession.user.id;
  const supabase = getSupabase();

  // Idempotency: SELECT before INSERT. In-flight rows are sacred.
  const { data: existing, error: selectErr } = await supabase
    .from("instaclaw_pending_users")
    .select("id, channel")
    .eq("user_id", userId)
    .is("consumed_at", null)
    .maybeSingle();

  if (selectErr) {
    logger.error("[/onboarding/web] pending select failed", {
      route: "onboarding/web", userId, error: selectErr.message,
    });
    redirect("/dashboard");
  }

  let pendingId: string;
  if (existing) {
    if (existing.channel === "web") {
      // Page-refresh case — reuse.
      pendingId = existing.id;
    } else {
      // In-flight channel attempt. Don't override.
      logger.info("[/onboarding/web] user has in-flight channel pending; bailing to dashboard", {
        route: "onboarding/web", userId, existingChannel: existing.channel,
      });
      redirect("/dashboard");
    }
  } else {
    // channel_identity = userId (UUID sentinel). Can't collide with E.164
    // or Telegram chat-id (different shape).
    const { data: inserted, error: insertErr } = await supabase
      .from("instaclaw_pending_users")
      .insert({
        user_id: userId,
        channel: "web",
        channel_identity: userId,
      })
      .select("id")
      .single();

    if (insertErr || !inserted) {
      logger.error("[/onboarding/web] pending insert failed", {
        route: "onboarding/web", userId, error: insertErr?.message,
      });
      redirect("/dashboard");
    }

    pendingId = inserted.id;

    // Surface the choice — drives SOUL.md / banner / settings.
    await supabase
      .from("instaclaw_users")
      .update({ preferred_channel: "web" })
      .eq("id", userId);

    logger.info("[/onboarding/web] created web pending row + flagged user", {
      route: "onboarding/web", userId, pendingId,
    });
  }

  // Fire VM provision in after() — VM warms up while user is on /plan.
  const userIdForProvision = userId;
  after(async () => {
    try {
      await assignOrProvisionUserVm(userIdForProvision, { supabase });
      logger.info("[/onboarding/web] VM provision fired via after()", {
        route: "onboarding/web", userId: userIdForProvision, pendingId,
      });
    } catch (err) {
      logger.error("[/onboarding/web] assignOrProvisionUserVm threw", {
        route: "onboarding/web", userId: userIdForProvision, pendingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Edge partner → skip /plan (sponsored trial).
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

Compile status: ✓ verified by copying to `app/(onboarding)/onboarding/web/page.tsx` and running `npx tsc --noEmit` — zero errors. Removed before committing this doc.

Middleware: the matcher at `middleware.ts:130` does NOT include `/onboarding/:path*` — that route group handles its own auth in page components (same as `/auth`). The page-level `auth()` check above is the source of truth. No middleware edit needed.

### 4.3 `lib/m-return-dispatch.ts` — `'web'` branch

**Decision (was Q1): reuse `instaclaw_message_log` (Option A).** Rationale: the command center already renders from that table; writing the welcome there makes it appear as message #1 with zero UI changes. Option B (new `dashboard_inbox` table) would require a new fetch + new render path for negative incremental value.

Concrete edit at `lib/m-return-dispatch.ts:253-262`:

```typescript
// Before:
if (pending.channel === "imessage") {
  await sendImessage(pending.channel_identity, message);
} else if (pending.channel === "telegram") {
  await sendTelegramSharedBot(pending.channel_identity, message);
} else {
  await rollbackMReturnClaim(supabase, pendingId, nowIso);
  return { ok: false, reason: "unsupported_channel", detail: pending.channel };
}

// After:
if (pending.channel === "imessage") {
  await sendImessage(pending.channel_identity, message);
} else if (pending.channel === "telegram") {
  await sendTelegramSharedBot(pending.channel_identity, message);
} else if (pending.channel === "web") {
  // No external dispatch — store as agent's first message in the command
  // center's source-of-truth table. Renders as message #1 when the user
  // lands on /dashboard → /tasks.
  await storeDashboardWelcome(supabase, pending.user_id!, message);
} else {
  await rollbackMReturnClaim(supabase, pendingId, nowIso);
  return { ok: false, reason: "unsupported_channel", detail: pending.channel };
}
```

`storeDashboardWelcome` is a new helper at the bottom of the file:

```typescript
async function storeDashboardWelcome(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  message: string,
): Promise<void> {
  // Schema matches existing agent-message rows in instaclaw_message_log
  // (verify exact column names against migrations + existing inserts in
  // app/api/gateway/proxy/route.ts before shipping — message_log is the
  // most-touched table in the codebase, names are stable).
  const { error } = await supabase
    .from("instaclaw_message_log")
    .insert({
      user_id: userId,
      role: "assistant",
      content: message,
      source: "m_return_web",
      // created_at defaults to NOW()
    });
  if (error) {
    // Don't crash the dispatch flow — the welcome being absent is a
    // degraded but recoverable state. M_RETURN's CAS already marked the
    // row sent; user lands in dashboard with an empty inbox. The
    // dashboard's first-load could surface a "we got you set up — say
    // hi to your agent" prompt as a fallback.
    throw new Error(`message_log insert failed: ${error.message}`);
  }
}
```

**Implementation note:** before this lands, verify the `instaclaw_message_log` columns match. Migrations index suggests the table exists; one quick `SELECT * LIMIT 1` query during implementation will pin the exact column names.

### 4.4 `lib/auth.ts` session callback — surface `preferredChannel` + `dismissedChannelNudgeAt`

The session callback already populates `partner`, `onboardingComplete`, `indexLastIntentAt`. Add `preferredChannel` (TEXT, can be null) and `dismissedChannelNudgeAt` (ISO timestamp or null). Frontend reads from `session.user.*`.

### 4.5 Dashboard banner: "Connect a channel for the full experience"

Component renders on every `(dashboard)` route layout, above the page content. Conditional:

```tsx
const showBanner =
  session?.user?.preferredChannel === "web" &&
  (!session?.user?.dismissedChannelNudgeAt ||
    Date.now() - new Date(session.user.dismissedChannelNudgeAt).getTime() > 14 * 24 * 60 * 60 * 1000);
```

**Decision (was Q2): 14 days, not 7.** Rationale: web-only users chose deliberately (filed the choice via explicit click on /channels). 7-day re-nudge is for accidental states; 14 is the right register for a deliberate one. Cooper confirmed.

Banner copy (matches Cooper voice — lowercase, sentence case, no em-dashes):

> connect iMessage or telegram for the full experience. your agent works best when you can message it like a friend.
> [connect a channel →]  [maybe later]

The "[maybe later]" button POSTs to `/api/onboarding/dismiss-channel-nudge` which sets `dismissed_channel_nudge_at = NOW()`. Returns 200. No-op if user reconnects a channel — at that point `preferred_channel != 'web'` so the banner won't render regardless.

### 4.6 ~configureOpenClaw refactor~ — DELETED. Not needed.

Verified in §2.3 above: `buildOpenClawConfig` already short-circuits when `channels.includes(X)` is false or the matching bot token is missing. The 7 production VMs at `channels_enabled = []` run on exactly this code path. **No edit needed.**

### 4.7 SOUL.md → AGENTS.md template — `WEB_ONLY_USER` section

Per the V2 architecture (CLAUDE.md v106 changelog: "GBRAIN_SOUL_ROUTING_V1 REPLACES the legacy MEMORY.md-first section in SOUL.md"), most agent-context content lives in AGENTS.md now. SOUL.md is only 6,415 chars on a healthy edge VM (measured §2.2); AGENTS.md is 30,077. The WEB_ONLY_USER section belongs in **AGENTS.md**, not SOUL.md as v1 said.

Section content (~600 chars):

```markdown
## Web-Only User (WEB_ONLY_USER_V1)

The user is currently chatting with you via the web command center on
instaclaw.io/dashboard — they haven't connected iMessage or Telegram.

- Don't try to proactively message them outside the dashboard. They're
  not listening on a phone.
- When they ask you to "text me" or "send me a reminder", explain warmly
  that you'd need a messaging channel for that, and that connecting one
  is a single tap at /channels. Don't be pushy.
- Some users prefer the web. That's a valid permanent choice; don't
  assume they'll connect later.
```

Sentinel: `WEB_ONLY_USER_V1` (per Rule 23, added to `requiredSentinels` on the corresponding `vm-manifest.ts:files[]` entry or — if AGENTS.md is generated dynamically per user via reconciler — verified by the step itself).

### 4.8 New reconciler step: `stepWebOnlyUserAgents`

Marker-guarded (`WEB_ONLY_USER_V1`). On every reconcile tick:

1. Read `user.preferred_channel` for this VM's owner.
2. If `preferred_channel === 'web'` AND marker absent in AGENTS.md → insert section.
3. If `preferred_channel !== 'web'` AND marker present → remove section.
4. Backup + atomic write per Rule 22 / Rule 30.

Pattern mirrors `stepInstaClawIdentityPatch` (lib/vm-reconcile.ts, surgical Python in-place edit with sentinel verify-after-write). Failures go to `result.warnings` per Rule 39 (not load-bearing for chat function — agent works fine without the section, just slightly less aware of the user's web-only state).

**Manifest bump impact:** stepWebOnlyUserAgents adds one new step. Per CLAUDE.md "Version-bump policy", this MUST bump `VM_MANIFEST.version`. Per Rule 64, requires Cooper approval at bump time — but the bump itself is mechanical once the step is in place.

### 4.9 Three command-center polish edits (per §2.4 audit)

Single PR; ~10 LOC:

1. `app/(dashboard)/tasks/page.tsx` lines 1606-1614: wrap the chip in `{(isTelegramConnected || isDiscordConnected) && (...)}`. Skip users no longer see the "Telegram not connected" repeat-on-every-task.
2. `app/(dashboard)/dashboard/page.tsx` line 661: `agentName={vm.telegramBotUsername ?? vm.agentName ?? null}`.
3. `app/(dashboard)/settings/page.tsx` line 752: `{channels_enabled?.length ? channels_enabled.join(", ") : "none yet"}`.

### 4.10 Capability-aware nudges (in-conversation, lives in AGENTS.md WEB_ONLY_USER section)

**Decision (was Q3): ship the §6.2 example tone as the authoritative SOUL.md/AGENTS.md instruction.** No additional engineering work — the agent generates its own reply from the AGENTS.md guidance per turn. The tone document IS the implementation.

Example reply pattern (the agent decides the exact wording in the moment):

> Happy to set that up — but I'd need a way to reach you outside the browser. iMessage or Telegram, both take ~60 seconds. Want to connect one?

### 4.11 Telemetry (5-step funnel)

**Decision (was Q6): ship telemetry.** Use whatever event-tracking is already wired (PostHog, internal `instaclaw_funnel_events` table, etc. — investigate during implementation; don't add a new vendor for this).

Events:

| Event | Where | Properties |
|---|---|---|
| `skip_channels_link_click` | /channels (client) | `{ source: "channels-page", auth_state: "authed" \| "anonymous" }` |
| `skip_channels_authed_landed` | /onboarding/web (server) | `{ user_id, partner }` |
| `skip_channels_pending_created` | /onboarding/web after INSERT | `{ user_id, pending_id }` |
| `skip_channels_vm_provisioned` | /api/vm/configure success (when pending.channel='web') | `{ user_id, vm_id }` |
| `skip_channels_first_message_sent` | /api/gateway/proxy first agent message for a 'web' pending user | `{ user_id, vm_id }` |
| `skip_channels_channel_connected_later` | webhook flow when 'web' user gets first iMessage/Telegram pending | `{ user_id, channel, days_since_skip }` |

The last one is the conversion metric. Hypothesis: 10-20% of skip users connect a channel within 7 days. We'll learn from data.

## 5. Decisions (was "open questions")

### 5.1 Welcome storage: reuse `instaclaw_message_log`

Was Q1. Option A. Rationale: command center already renders from `message_log`. New table = new fetch + new render path for zero incremental value.

### 5.2 Banner cadence: 14 days

Was Q2. 7 too naggy for a deliberate choice; 14 is the right register.

### 5.3 In-conversation nudge tone: §4.10 example, ship as-is

Was Q3. Tone is captured in the AGENTS.md instruction; agent generates the wording per turn.

### 5.4 Skip link visible to all visitors, including unauthenticated

Was Q4. The OAuth bounce is transparent (Apple/Stripe/Linear convention). Auth-conditional rendering = a complication for no upside.

### 5.5 No backfill for legacy /signup users

Was Q5. Source of truth is `vm.channels_enabled` (existing column), not the new `preferred_channel` flag. Legacy BYOB users have `channels_enabled=["telegram"]` and a `telegram_bot_token`; they're correctly classified as "has a channel" without any backfill. The new `preferred_channel` flag is FORWARD-LOOKING — set only on users who explicitly chose 'web' from /channels.

**Empirical check that the no-backfill is safe:** in the §2.1 census, of 158 healthy assigned VMs, 79 have BYOB telegram, 0 use shared-bot-only, 79 don't have either token. The 79 token-less group is either (a) the 7 channel-less + 72 in some kind of pre-paired state, OR (b) a real cohort we should investigate separately. Either way the `preferred_channel='web'` flag doesn't need to be retroactively applied — these users will continue to behave exactly as they do today, and only NEW skip users get the flag set.

### 5.6 Telemetry: ship full 5-step funnel

Was Q6. Investigated upstream — instaclaw uses an internal event-log pattern (search the codebase for `instaclaw_funnel_events` or similar during implementation). The 6 events in §4.11 are the spec.

## 6. The command-center skip-friendliness audit (was v1 risk #4)

**Result: 3 cosmetic edits across the entire (dashboard) surface.** Lines listed in §2.4. Net change ~10 LOC. The /tasks page's 4,386 lines reference channels in well-guarded ways — `channelsEnabled.includes(...)`, `??` fallbacks, gated `{vm.telegramBotUsername && (...)}` blocks. **The command center was already designed to render with empty channels.** This is a polish pass, not a rebuild.

## 7. Edge cases (final list — 11 from v1, all resolved)

### 7.1 Skip user texts SMS anyway (channel + skip races)
Inbound webhook fires `resolveInbound` → finds no existing binding for `('imessage', phone)` → tries INSERT → may conflict with the user's existing `('web', userId)` row IF the partial unique index keys on `(channel, channel_identity)` alone. Verified: index allows the new row because `('imessage', '+1...')` ≠ `('web', 'uuid')`. **Result: dual pending rows, both eventually consume.** The M_RETURN dispatcher's CAS prevents duplicate sends.

**Mitigation:** extend `resolveInbound` to also lookup by `user_id` when the channel doesn't match an existing binding (P2 follow-up — not required for ship). For now, dual rows is a known minor wart, not a bug.

### 7.2 Dual-tab race (skip in tab B while channel pending in tab A)
Both flows fire `assignOrProvisionUserVm(userId)` separately. Function MUST be idempotent on userId. Quick verification I'll add to the implementation step: read `lib/createUserVM.ts:assignOrProvisionUserVm` for the early-return-if-already-assigned check. Per §4.6 prototype, the call is in `after()` so race-induced double-provision would be caught by the function's own state-check.

### 7.3 Skip-then-connect-later
User clicks skip → ends up in command center. Later clicks banner → /channels → texts iMessage. The imessage inbound webhook creates a new pending row, M_RETURN fires via iMessage successfully. `instaclaw_users.preferred_channel` flips from 'web' to 'imessage'. `vm.channels_enabled` gets 'imessage' appended. Reconciler's `stepWebOnlyUserAgents` detects the change → removes the WEB_ONLY_USER section from AGENTS.md.

The SOUL.md realignment lag is ~3-5 min (next reconcile tick). For that window, the agent has a slightly-stale "user is web-only" instruction. No functional impact.

### 7.4 M_RETURN web branch fires before VM ready
`m-return-dispatch.ts:209-211` returns `{ ok: false, reason: "vm_not_ready" }` if `gateway_url` is null. Sweep cron retries every minute. Identical behavior for web users.

`storeDashboardWelcome` writes to `message_log` which doesn't depend on VM state — safe to call before VM is ready. If we want strict ordering ("welcome only after VM is ready"), gate on `vm.gateway_url IS NOT NULL`. **Decision: don't gate.** The welcome can land in message_log before the VM is up; when the user lands on /dashboard, the gateway will be up by then (configureOpenClaw ran during OAuth/plan transit per §4.2's `after()` call).

### 7.5 VM still configuring when skip user lands on dashboard
Same path as a channel user — dashboard layout redirects to /deploying. Skip users see the same deploying screen. Not ideal for the "fast access" value prop, but identical to existing flow. Future improvement: measure median configureOpenClaw time for `channels=[]` VMs; if significantly faster than `channels=["telegram"]` VMs, market this advantage.

### 7.6 Skip user on the World mini app
The mini-app embeds `/dashboard` directly. A mini-app user clicking skip wouldn't, because they're already past /channels via the mini-app's own onboarding. The /channels page is only reachable via the public web; mini-app users land on /dashboard. **Not an edge case for skip — the path doesn't intersect.**

### 7.7 Skip user signs up via partner portal (Edge City)
§4.2 prototype branches: `if (user?.partner === "edge_city") redirect(/onboarding/done?session=<id>&web=1)`. Edge users skip /plan (sponsored trial). Partner skill installs continue via `configureOpenClaw` regardless of channel choice (Rule 9). SOUL.md gets BOTH Edge partner stub AND WEB_ONLY_USER section — added ~820 chars to AGENTS.md (well within budget).

### 7.8 Skip user cancels subscription
Same as any cancellation. Stripe webhook → billing teardown. Skip doesn't change anything.

### 7.9 Skip user past_due grace
Per Rule 14, `getBillingStatusVerified` treats 7-day past_due as still-paying. Skip-agnostic.

### 7.10 M_RETURN CAS race
Existing `m_return_sent_at` CAS handles this for all channels. Web is no different — `storeDashboardWelcome` is the only consequence of winning the CAS.

### 7.11 Skip user frozen + thawed
After 90+ days inactivity, `vm-freeze-thaw.ts:freezeVM` archives to R2. Thaw via `thawVM` re-provisions from snapshot. Per §4.8, `stepWebOnlyUserAgents` re-injects the WEB_ONLY_USER section based on `user.preferred_channel` on the next reconcile tick. Same restore behavior as any other reconciler-managed section.

## 8. Implementation phasing

| Phase | Effort | Ships |
|---|---|---|
| **Phase 1 — Skip path works end-to-end** | 1 day | Migration §4.1 (10 LOC), route §4.2 (140 LOC, prototyped), M_RETURN web branch §4.3 (30 LOC + helper), session callback §4.4 (5 LOC), 3 command-center polish edits §4.9 (10 LOC). Skip link target swaps from `/dashboard` to `/onboarding/web`. |
| **Phase 2 — Nudge + agent-awareness** | 1 day | Banner component §4.5, AGENTS.md section §4.7, reconciler step §4.8, manifest bump (Rule 64 approval). |
| **Phase 3 — Telemetry** | 0.5 day | 6 events §4.11 wired into existing event-log surface. |

**Total: ~2.5 days of work.** v1 doc estimated this as a 1-week build. The audit + measurements collapsed the scope by ~half.

## 9. Risks I'm flagging (after audit, not before)

The pre-audit risks in v1 were mostly empty (configureOpenClaw refactor doesn't exist; command center is fine). Post-audit:

- **Phase 1 ships before Phase 2.** During the gap, skip users get a working command center but no nudge banner — they won't see the path to connect a channel later. Mitigation: ship Phase 1 + the banner stub (just the visible component without the dismiss endpoint) on the same day.
- **`instaclaw_message_log` schema verification.** §4.3 needs to verify the table's exact column names before the welcome INSERT. Single SQL check during implementation. If column names differ from my assumption (`role`, `content`, `source`), the implementation reads them and adapts.
- **Race in §7.1 dual pending row.** Known minor wart. P2 follow-up to extend `resolveInbound` with user_id lookup.
- **Phase 2 manifest bump.** Per Rule 64, requires Cooper approval at bump time. Not blocking Phase 1 (the WEB_ONLY_USER section is a nice-to-have for agent voice consistency; the chat still works without it).
- **Bootstrap budget for non-edge users.** Edge users land at ~75K total bootstrap. Non-edge users are lighter (no partner overlay), so the WEB_ONLY_USER addition is well-budgeted. Not flagging as a hard risk; just calling out for future awareness.

## 10. Open items genuinely requiring Cooper

Per the meta-directive, only items below need your decision; everything else is decided above.

1. **Phase 2's manifest bump approval.** Per Rule 64. Will request after Phase 1 ships clean and we have early skip-user data.

That's it. One item.

## 11. Empirical findings reference (for future maintainers)

Data measured 2026-05-27:
- 7 production VMs already run with `channels_enabled = []` (vm-036, vm-040, vm-108, vm-511, vm-527, vm-603, vm-linode-10). Proof that `configureOpenClaw` is channel-agnostic in production.
- `instaclaw_users.preferred_channel` is NULL on 1000/1000 users. Safe to use without backfill.
- Healthy edge_city VM (vm-1005) bootstrap context: SOUL=6.4KB, AGENTS=30KB, CAPABILITIES=20KB, TOTAL=76KB.
- Command-center channel coupling: 14 lines total, 3 needing edits.
- configureOpenClaw channel writes: 3 sites total (lib/ssh.ts:5260, 5293, 6118), all already guarded.

## 12. References

- `app/channels/channels-client.tsx` — skip link itself
- `app/(dashboard)/layout.tsx:101-144` — data-driven routing
- `app/(auth)/auth/page.tsx` — structural model for /onboarding/web
- `lib/m-return-dispatch.ts:253-261` — channel dispatch site
- `lib/onboarding-signup.ts:resolveInbound` — channel-binding race ground
- `lib/createUserVM.ts:assignOrProvisionUserVm` — VM provision
- `lib/ssh.ts:5260, 5293, 6118` — channel writes in configureOpenClaw
- `lib/auth.ts` — session callback (needs preferredChannel + dismissedChannelNudgeAt added in §4.4)
- CLAUDE.md Rules: 22, 23, 33, 47, 56, 60, 64, 66

## Sources (web research)

- [Slack — Create a good onboarding experience](https://api.slack.com/best-practices/onboarding) — "any non-essential onboarding past welcome message should be skippable"
- [SaaS onboarding flows that convert in 2026](https://www.saasui.design/blog/saas-onboarding-flows-that-actually-convert-2026) — top-quartile PLG products hit 8-10% free-to-paid; 30%+ trial conversion
