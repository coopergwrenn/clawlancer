# Onboarding Redesign — Codebase Compatibility Audit (revised)

**Date:** 2026-05-26 · **Companion to:** `onboarding-redesign-2026-05-26.md`
**Purpose:** Section-by-section reconciliation between the spec and what
already exists in the codebase. With the shadow agent removed and the
Telegram shared bot added, the architecture is simpler and the build
list is shorter than the previous version of this audit suggested.

---

## Headline finding

| Spec section group | Compatibility | Build size |
|---|---|---|
| §1-4 (vision, diagnosis, moments) | Conceptual, no code impact | None |
| §5.1 (entry surfaces) | Surgical addition to landing CTA | Small |
| §5.2 (channel selection page) | NEW build, isolated | Small |
| §5.3 (iMessage flow) | NEW infrastructure (Sendblue + webhook) | Small |
| §5.4 (auth page + ChatGPT) | OAuth exists; UI is new design | Medium |
| §5.5 (plan + card) | Reuse today's `/plan`, restyle | Small |
| §5.6 (you're in page) | NEW route, iMessage/Telegram only | Small |
| §5.7 (Telegram, shared bot + BYOB) | BYOB unchanged; shared bot is NEW | Medium |
| §5.8 (Discord/Slack waitlist) | NEW placeholder | Tiny |
| §5.9 (Edge specifics) | Surgical extension of existing flow | Small |
| §6 (the messages) | Templates + existing dedicated-agent bootstrap | Tiny |
| §7 (architecture / DB) | Extend pending_users; 3 new tables | Small |
| §8 (iMessage infra) | NEW Sendblue integration | Small |
| §9 (spam mitigation) | Operational + design | Tiny |
| §10-14 (plan, risks, design bar) | Conceptual | None |

**Verdict: every area is SURGICAL or NEW-but-isolated. Zero rewrites of existing systems.** The existing dedicated-agent stack (createUserVM, configureOpenClaw, the cron rescue layers, Stripe webhook, Edge partner cookie logic) is preserved end-to-end. The BYOB Telegram flow is preserved end-to-end. iMessage and the Telegram shared bot are net-new infrastructure that follows an identical architectural pattern.

The simplification versus the previous audit: shadow agent service and ChatGPT history import are gone. Net build is roughly **5 days** instead of 8.

---

## Section-by-section detail

### §1, §1.1, §2, §3, §4 — vision, diagnosis, moments

No code impact. Voice continuity (§1.1) is now a documentation constraint on copy, not a service-architecture constraint (since there's no shadow agent the two surfaces have to align).

---

### §5.1 — Two entry surfaces

**Existing code:**
- Landing CTA in `components/landing/` routes to `/signup`
- `app/(auth)/signup/page.tsx` is today's first-screen-after-CTA

**Spec proposes:** landing CTA routes to NEW `/channels` page; physical QR opens iMessage directly with no web surface.

**Verdict:** ✅ SURGICAL. Two changes:
1. Landing CTA's `href` changes from `/signup` to `/channels` (one line per affected component).
2. `/signup` becomes a fallback URL (works exactly as today for users coming from bookmarks or old links — they enter the existing Telegram BYOB flow).

**Risk:** none.

---

### §5.2 — Channel selection page

**Existing code:** nothing equivalent.

**Spec proposes:** NEW `/channels` page with four tiles (iMessage primary, Telegram primary, Discord placeholder, Slack placeholder) + "InstaClaw is portable" copy + Edge cookie pre-selection.

**Verdict:** ✅ NEW BUILD, fully isolated. Reads `instaclaw_partner` cookie (existing pattern from `/edge/claim`) to pre-select.

**Build size:** small. ~250 lines including the mobile-first design and the Telegram sub-picker (shared bot primary, BYOB secondary).

---

### §5.3 — iMessage flow

**Existing code:** nothing. Telegram is the only messaging channel today.

**Spec proposes:** the 7-step talk-via-templates flow. Sendblue inbound webhook fires two template messages; user goes through web; M_RETURN fires from the dedicated VM via Sendblue API.

**Verdict:** 🟡 NEW infrastructure, cleanly bounded:
- Sendblue API integration (~150 LOC in `lib/imessage-send.ts`)
- `/api/imessage/inbound/route.ts` webhook (template response + new-user creation + bound-user proxying)
- M_RETURN trigger via post-provisioning hook

**No existing code is touched.** The shadow agent service is gone, replaced by static templates — much simpler than the previous version of this audit estimated.

**Build size:** small. ~400 lines total across the iMessage handlers.

---

### §5.4 — Auth page with Google + Connect ChatGPT

**Existing code:**
- NextAuth + Google OAuth configured at `lib/auth.ts`.
- **ChatGPT OAuth:** complete device-code flow exists at
  `app/api/auth/openai/signup/start/route.ts` and
  `/poll/route.ts`. Tokens stored in `instaclaw_users.openai_oauth_*`
  columns. BYOK activation flips `api_mode='byok'` and the gateway
  routes through the user's OpenAI subscription for OpenAI-model
  calls. Confirmed against earlier audit + CLAUDE.md Rule 16.
- Feature-flagged on `OPENAI_OAUTH_ENABLED`.

**Spec proposes:** new `/auth` page with ChatGPT card as primary visual action, Google as secondary. Single-sentence copy under ChatGPT: "uses your existing subscription to lower your plan cost."

**Verdict:** ✅ SURGICAL. The OAuth flows themselves are preserved exactly. What's new is the **page design** — a glass + coral + serif treatment of the existing OAuth options, replacing the current implicit-redirect-to-NextAuth pattern. Build size: medium (~300 LOC including design polish).

**No ChatGPT conversation history import in v1.** That feature is deferred to Q2 as an additive upgrade. The spec previously specced the import worker; it's removed.

**Risk:** low. The ChatGPT button still does real work (BYOK), just without the history-import magic.

---

### §5.5 — Plan + card capture

**Existing code:**
- `app/(onboarding)/plan/page.tsx` — today's plan selection screen.
- Stripe Checkout integration in `/api/checkout/*` and `app/(onboarding)/plan/`.
- Stripe webhook in `app/api/billing/webhook/route.ts` handles subscription.created with `trial_end` logic for Edge.

**Spec proposes:** keep today's `/plan` page, restyle to match `/auth`'s glass + coral + serif treatment. After OAuth, the user lands here. After Stripe Checkout success, redirect to `/onboarding/done` for iMessage and Telegram-shared-bot users; `/deploying` for BYOB Telegram users.

**Verdict:** ✅ SURGICAL. Two changes:
1. Restyle `/plan` to match the new brand bar (no logic change).
2. The post-checkout redirect chooses between `/onboarding/done` (new) and `/deploying` (existing) based on the user's `preferred_channel`.

For Edge attendees: the existing `partner='edge_city'` sponsored-trial logic continues to work. They skip `/plan` (server-side bypass) and go straight to `/onboarding/done`.

**Risk:** very low. Restyling is isolated; the post-checkout redirect is one branch added to existing logic.

---

### §5.6 — The "you're in" page

**Existing code:** the analogous page is `/deploying`, a 1305-line polling state machine. Telegram users land there today.

**Spec proposes:** NEW `/onboarding/done` page for iMessage and Telegram-shared-bot users. Has the "head back to Messages" CTA at the top, optional 3-question personalization form, progress bar showing VM provisioning. Closeable; agent texts the user when ready.

**Verdict:** ✅ SURGICAL — conditional bypass of `/deploying`, not deletion. Telegram BYOB users still go to `/deploying` (preserved). iMessage and Telegram-shared-bot users go to `/onboarding/done`. Routing decision in OAuth callback / post-Stripe redirect.

**Build size:** small. ~200 LOC for the page + form + progress bar.

**Risk:** medium on the routing logic — if buggy, could send Telegram BYOB users to the wrong page. Mitigation: explicit channel check, default to `/deploying` if unknown.

---

### §5.7 — Telegram, shared bot as primary + BYOB preserved

**Existing code (don't touch any of this):**
- `app/(auth)/signup/page.tsx` — OAuth entry
- `app/(onboarding)/connect/page.tsx` — BotFather token paste
- `app/(onboarding)/plan/page.tsx`
- `/api/onboarding/save/route.ts` — persists to pending_users
- `/api/checkout/verify/route.ts`
- `/api/vm/assign/route.ts`
- `app/(onboarding)/deploying/page.tsx`
- `lib/createUserVM.ts`
- `lib/ssh.ts:configureOpenClaw`

**Spec proposes:** ADD a shared bot path (`@myinstaclaw_bot`) as the primary Telegram entry, with BYOB preserved as the alternative. Two completely separate channel-specific routing handlers:
- Shared bot: webhook → template messages → web signup → backend relays messages between Telegram and the user's VM gateway via HTTP. VM has no bot token configured.
- BYOB: today's flow exactly, no changes. VM polls Telegram with the user's own bot token.

**Verdict:** ✅ NEW INFRASTRUCTURE (shared bot path), ZERO changes (BYOB path).

**New code needed:**
- Register `@myinstaclaw_bot` via BotFather (one-time, Cooper).
- Telegram webhook setup pointed at `/api/telegram/shared-bot/inbound`.
- `/api/telegram/shared-bot/inbound/route.ts` (~200 LOC, mirrors the iMessage inbound handler's logic): receives webhook, extracts chat_id, creates pending_users row for new users + sends template messages, proxies bound-user messages to their VM gateway.
- `lib/telegram-shared-send.ts` (~80 LOC): Telegram Bot API wrapper for sending messages from the shared bot to a specific chat_id.
- Channel-aware M_RETURN trigger: when the user's preferred_channel is "telegram" AND they came in via the shared bot (no telegram_bot_token in their VM's config), the post-provisioning hook sends M_RETURN via the shared bot's API instead of via the user's own bot.
- VM provisioning conditional: for shared-bot users, skip writing a telegram bot token into the VM's openclaw.json. The VM operates in "HTTP-receive" mode (already supported by the existing gateway).

**No code changes needed in:**
- `configureOpenClaw` core logic — UserConfig gets a new optional field (`telegram_polling_enabled?: boolean`, default true) that the existing code already handles via the BYOB-or-not check.
- BYOB flow at every step from `/signup` to `/deploying`.
- Anything related to the user's existing bot setup logic.

**Build size:** medium (~400 LOC for the shared bot path + a flag in UserConfig).

**Risk:** medium. The biggest risk is that the VM's existing OpenClaw process expects to poll Telegram. We need to verify it handles "no bot token configured" gracefully (i.e., it doesn't crash, just listens for HTTP traffic on its gateway). This is a 30-minute manual test before the build sprint commits.

---

### §5.8 — Discord/Slack waitlist

**Existing code:** nothing.

**Spec proposes:** two greyed tiles, one-field email form, captures into `instaclaw_waitlist`.

**Verdict:** ✅ NEW, TINY. One table, one API route, one modal. ~80 LOC.

---

### §5.9 — Edge Esmeralda specifics

**Existing code:**
- `app/edge/page.tsx`, `app/edge/claim/page.tsx`, `app/edge/setup/page.tsx`, `app/edge/intents/page.tsx`
- `app/api/edge/*` (verify-ticket, partner-tag, etc.)
- `instaclaw_users.partner='edge_city'` set by sign-in callback when cookie present
- Stripe webhook sets `trial_end=June 30` when `user.partner='edge_city'`

**Spec proposes:** Edge users land on `/channels` with iMessage pre-selected (or skip channel selection entirely with iMessage default). Edge personalization question (the attendee intent) added to `/onboarding/done` form. M_RETURN's Edge variant references the village.

**Verdict:** ✅ SURGICAL extension. Three changes:
1. `/channels` reads the `instaclaw_partner` cookie (existing pattern) and pre-selects iMessage if `edge_city`.
2. `/onboarding/done` personalization form includes a fourth field for Edge users (intent text). Writes to the same backend destination today's `/edge/intents` writes to.
3. M_RETURN's Edge variant copy (already in §6).

**No changes** to `/edge/claim`, `/edge/setup`, `/edge/intents` (the last becomes optional/gated for Edge users who completed intent capture on `/onboarding/done`, but the page itself is untouched).

**Risk:** low. The Stripe `trial_end=June 30` server-side logic is preserved.

---

### §6 — The messages

**Existing code:**
- `lib/ssh.ts` builds BOOTSTRAP.md, USER.md, IDENTITY.md, MEMORY.md from templates inside `configureOpenClaw`.
- The v122 bootstrap greeting voice lives in BOOTSTRAP.md.
- `sendVMReadyEmail` in `lib/email.ts` is the today's post-provisioning callback.

**Spec proposes:**
- Welcome 1 + Welcome 2 = static templates in the inbound webhook handlers (no LLM, no DB).
- M_RETURN = the dedicated agent's existing bootstrap greeting, fired automatically when the VM is ready. Voice carries through because it's the same BOOTSTRAP.md template that produces today's first message.
- M_BILLING = day-6 cron, optional, fires from the dedicated agent (real LLM call with conversation summary).

**Verdict:** ✅ Templates are TINY (static strings in handler files). M_RETURN reuses existing dedicated-agent bootstrap (no new code needed for the greeting itself; the trigger is part of §5.7's post-provisioning hook). M_BILLING is a future cron, optional for v1.

**Build size:** tiny for templates. Zero for M_RETURN's content (existing BOOTSTRAP.md, possibly enhanced with personalization injection from §7 below).

---

### §7 — Architecture / database

**Existing tables:**
- `instaclaw_users` — extensive columns already (`partner`, `openai_oauth_*`, `world_id_*`, etc.)
- `instaclaw_pending_users` — has `telegram_bot_token`, `telegram_bot_username`, `api_mode`, `tier`, etc., plus `consumed_at` for lifecycle
- `instaclaw_vms` — unchanged
- `instaclaw_subscriptions` — unchanged

**Spec's new schema:**

| Table | Action | Notes |
|---|---|---|
| `instaclaw_pending_users` | **Extend with 3 columns** | `channel`, `short_code`, `channel_identity`. Avoids a separate signup_sessions table. |
| `instaclaw_users` | **Add 1 column** | `preferred_channel` ENUM. |
| `instaclaw_user_profile` | NEW table | Personalization from `/onboarding/done` form. Read by configureOpenClaw. |
| `instaclaw_user_channel_bindings` | NEW table | Many-to-many: user_id × channel × channel_identity. Supports multi-channel future. |
| `instaclaw_waitlist` | NEW table | Discord/Slack signups. |

**Total schema delta:** 3 columns added to existing tables, 3 new tables. Down from the previous spec's 5 new tables (shadow_conversations and chatgpt_imports are gone).

**Verdict:** ✅ Small migration. Backward-compatible. ~1 hour of migration work.

---

### §8 — iMessage infrastructure (Sendblue)

**Existing code:** none.

**Spec proposes:** Phase A Sendblue ($100/mo per line) for immediate launch; Phase B Apple Messages for Business for verified sender + Apple Pay (4-8 week approval).

**Verdict:** ✅ NEW integration, isolated. ~150 LOC. Same as previous audit.

---

### §9 — Spam-filter mitigation

**Existing code:** none applicable.

**Spec proposes:** vCard "Save Contact" button, no link in Welcome 1, conservative volume, per-number tap-rate monitoring.

**Verdict:** ✅ Tiny. vCard endpoint is ~30 LOC.

---

### §10-§14 — Plan, Edge surface, risks, recommendation, design bar

Conceptual sections. The migration plan, Edge poster spec, risks, and design quality bar (§14) are operational/strategic guidance with no direct code impact.

---

## Surprising findings (vs the previous audit)

### Things made easier by the simplification

1. **No shadow agent service.** ~500 LOC saved. The "is it Sonnet or Haiku?" decision is gone. The capability gate logic is gone. Conversation transfer from shadow to dedicated is gone. The schema dependency on `instaclaw_shadow_conversations` is gone.

2. **No ChatGPT history import.** ~300 LOC saved. The OpenAI scope research dependency is gone (we'd have had to verify the conversation-history scope existed; now we don't need to). The `instaclaw_chatgpt_imports` table is gone. The summarization-via-Claude pipeline is gone.

3. **Telegram shared bot mirrors iMessage architecture exactly.** The webhook handler for `/api/telegram/shared-bot/inbound` is essentially the same handler as `/api/imessage/inbound`, with the transport API swapped (Telegram Bot API vs Sendblue API). Code reuse is high.

4. **`configureOpenClaw` extension is even smaller** than the previous audit suggested. We need to thread three personalization fields (name, intended_use, vibe) through to USER.md / IDENTITY.md. That's ~30 LOC across 3 spots, unchanged from previous estimate. ChatGPT history summary injection is no longer needed.

### Things that are genuinely new infrastructure but cheap

1. **Telegram shared bot path** (~400 LOC). The biggest single new build. But it mirrors iMessage so code patterns are reusable.

2. **iMessage Sendblue integration** (~400 LOC including the inbound handler, outbound API wrapper, and short-link plumbing).

3. **`/auth` page redesign** (~300 LOC). The single web surface during onboarding; design polish dominates LOC.

4. **`/onboarding/done` page** (~200 LOC). Form + progress bar + skip behavior.

5. **`/channels` page** (~200 LOC).

### Things easier than the spec implies

- **The dedicated agent's bootstrap greeting is the M_RETURN content.** We don't write new M_RETURN code; we let the existing BOOTSTRAP.md template fire as it does today. The personalization injection makes the bootstrap context-aware. Zero new code for the message content itself.

- **The Telegram shared bot doesn't require any agent-side changes.** The OpenClaw gateway on each VM is already HTTP-accessible. We just route messages over HTTP for shared-bot users instead of having the VM poll Telegram.

### Things that need confirmation before build

1. **The VM gracefully handles "no bot token configured" in openclaw.json.** I believe it does (the gateway is HTTP-first, polling is one transport option), but a 30-minute manual smoke test confirms this before committing the build sprint.

2. **Sendblue line provisioning and number selection.** Needs to be ordered TODAY so it's pre-warmed for Edge.

3. **`@myinstaclaw_bot` Telegram username availability.** Cooper to register via BotFather. If `@myinstaclaw_bot` is taken, fallback to `@instaclaw_bot` or similar.

---

## The actual build list (revised, simpler than before)

**New code:**

1. `/channels` page (channel selection UI + waitlist tile handlers + Telegram sub-picker).
2. `/auth` page (two-doors OAuth screen — reuses existing Google and ChatGPT OAuth flows).
3. `/plan` styling refresh (no logic change, just brand consistency).
4. `/onboarding/done` page (the "head back to Messages" interstitial + optional personalization form + progress bar).
5. `lib/imessage-send.ts` + `/api/imessage/inbound/route.ts` (Sendblue integration).
6. `lib/telegram-shared-send.ts` + `/api/telegram/shared-bot/inbound/route.ts` (Telegram shared bot integration, mirrors iMessage handler).
7. `/go/:code` short-link route.
8. vCard endpoint for "Save Contact" (iMessage only).
9. M_RETURN trigger via channel-aware post-provisioning hook (one new function, ~50 LOC, hooks into existing post-provisioning callback).
10. Database migration: 3 columns on `instaclaw_pending_users`, 1 column on `instaclaw_users`, 3 new tables (`instaclaw_user_profile`, `instaclaw_user_channel_bindings`, `instaclaw_waitlist`).

**Modified code (surgical):**

1. `configureOpenClaw` — add `personalization_name`, `personalization_intended_use`, `personalization_vibe`, `telegram_polling_enabled` to UserConfig. Thread through to workspace file builders. ~40 LOC across 3 spots.
2. `lib/email.ts:sendVMReadyEmail` — add `channel` parameter, conditionally render Telegram-specific copy or omit if iMessage/Telegram-shared-bot. ~20 LOC.
3. Landing CTA — change href from `/signup` to `/channels`. 1 line per affected component.
4. Post-Stripe redirect — route to `/onboarding/done` for iMessage and Telegram-shared-bot users, `/deploying` for Telegram BYOB users. ~10 LOC.

**Untouched (preserved per directive):**

- The entire existing Telegram BYOB flow (`/signup`, `/connect`, `/plan`'s logic, `/deploying`, `/dashboard`).
- `lib/createUserVM.ts` (pool + cloud-init).
- `lib/ssh.ts:configureOpenClaw` core logic (only UserConfig surface extends).
- `/api/vm/assign` (channel-aware via the existing pending_users channel column extension).
- All Stripe / billing logic.
- All Edge partner cookie / Stripe trial_end / intent capture logic.
- All `/api/cron/*` recovery passes.

---

## Estimated effort, revised

| Bundle | Days |
|---|---|
| `/channels` page + design polish | 0.5 |
| `/auth` page (the §5.4 centerpiece) + design polish | 1.0 |
| `/plan` restyle | 0.25 |
| `/onboarding/done` page + personalization form + design polish | 0.5 |
| Sendblue integration (outbound, inbound webhook) | 0.75 |
| Telegram shared bot integration (mirrors iMessage) | 0.75 |
| `configureOpenClaw` extensions + workspace file injection | 0.25 |
| Database migrations | 0.25 |
| Email channel-awareness | 0.25 |
| vCard + short-link plumbing | 0.25 |
| Edge integration testing | 0.25 |
| QA + Cooper's vm-1019 canary + Edge dry-run | 0.5 |
| **Total** | **~5.5 days** |

**Edge Esmeralda is 4 days away.** The 5.5-day estimate puts us roughly on the edge. Two options:

1. **Ship full scope for Edge (recommended).** Trim non-critical polish; iterate post-launch. Risk: tight timeline, but the architecture is straightforward.

2. **Ship iMessage + channel selection page + Telegram BYOB unchanged for Edge** (the Telegram shared bot ships in week 2). Edge attendees get iMessage as the primary flow; those who picked Telegram still go through today's BYOB path. Defers ~0.75 days of work. Lower risk.

Option 2 is the safer choice. The Telegram shared bot is the bigger product win long-term, but iMessage is the bigger win at Edge specifically (most attendees on iPhones, the QR poster strategy works best for iMessage).

**Recommendation:** ship iMessage + channels page + restyled auth + onboarding-done page for Edge. Ship Telegram shared bot the following week. BYOB users at Edge see no change.

---

## What I'm asking Cooper to confirm before any build starts

1. **Welcome 1 + Welcome 2 copy** — variants in §6 and Appendix A, recommendation noted (Canonical A for both). Final words?
2. **`instaclaw_pending_users` extension** vs new signup_sessions table — recommending extension. Confirm.
3. **New `/auth` page** vs extending existing `/signin` in place — new is cleaner. Confirm.
4. **Sendblue line provisioning + `@myinstaclaw_bot` username** — both need ordering THIS WEEK.
5. **The 5.5-day estimate vs Edge's 4 days** — confirm option 2 (defer Telegram shared bot to week 2) or option 1 (ship everything for Edge with tighter timeline).
6. **The VM-handles-no-bot-token smoke test** — 30 min of manual verification on a dev VM before committing the build sprint.

---

## Bottom line

The spec is buildable as written. The simplification (no shadow agent, no ChatGPT history import) makes everything cleaner and faster. The Telegram shared bot mirrors the iMessage architecture exactly, so code reuse is high.

**Roughly 5.5 days of focused work. 4 days to Edge.** The shippable-for-Edge scope is iMessage + channels page + restyled auth + onboarding-done. Telegram shared bot ships the following week. BYOB users see no behavioral change throughout.

The previous open question about ChatGPT conversation-history scope is no longer blocking (deferred). The single most important pre-build confirmation is now Cooper-side: register `@myinstaclaw_bot` and provision the Sendblue line **today** so they're pre-warmed for Edge.
