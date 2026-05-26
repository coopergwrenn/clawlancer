# InstaClaw Onboarding v2 — Spec

**Date:** 2026-05-26 (revised) · **Author:** Claude Opus 4.7 (with Cooper)
**Status:** Draft for review · do NOT begin implementation until approved
**Why it matters:** Onboarding is the entire business. We have 4 days
until Edge Esmeralda (1,000+ attendees, mostly seeing InstaClaw for
the first time). We're shipping the cleanest possible path between
"I want to try this" and "I'm talking to my real AI agent."

---

## 1. The central move: streamlined signup, real agent from the start

We've stripped onboarding down to the minimum number of steps between
"I want to try this" and "I'm talking to my real agent." No fake
conversations, no lightweight stand-ins, no two-tier hand-off where
one thing talks first and a different thing shows up later. The user
signs up, the real VM provisions, the real agent messages them
proactively in the messaging app of their choice. From that first
real message forward, everything works.

Here's the whole shape:

1. User scans a QR code, or clicks **Get Started** on the web.
2. iMessage opens with our number and `hi` pre-filled, or they pick a
   channel from the new selection page. One tap to send.
3. Within two seconds, two short template messages arrive. The first
   is a hint of the agent's personality and an honest line about
   what's happening. The second is the signup link.
4. The user taps the link. A beautiful auth page asks them to
   continue with ChatGPT (the differentiated path) or with Google
   (the simple path).
5. After OAuth, plan selection and card capture for a free trial.
6. A "you're in" page lets them answer three optional personalization
   questions while the VM spins up. Or close the tab; the agent will
   text them.
7. The real dedicated agent fires its bootstrap greeting in the same
   iMessage thread. Full voice, full memory, full skills. The
   conversation begins.

The UX improvements over today's flow:

- A clear channel selection page as the front door, not a forced
  Telegram-only path
- A beautiful auth page where the ChatGPT button is doing real work
  (BYOK to lower the plan cost)
- The "while you wait, personalize" pattern stolen from Zo and made
  better (Zo's mistake is that it's the destination; ours is a
  fifteen-second optional sidebar before the user closes the tab)
- And the most important one: the agent comes TO the user, in their
  messaging app. They don't have to find a bot, set up a token, type
  /start, or know what BotFather is. The agent arrives.

That's the whole product change. Everything else in this spec serves
those moments.

## 1.1 One voice, end to end

The two template welcome messages are NOT LLM responses. They're
static copy served by the Sendblue webhook handler. But the user
shouldn't be able to tell. They should sound like an early, briefer
version of the same voice the real agent uses.

What that means concretely:

- Lowercase, warm, declarative. The v122 voice.
- No "Welcome to InstaClaw!" enthusiasm.
- No customer-support tone, no "Thanks for reaching out!"
- Honest about what's happening. The user knows we're spinning up
  their agent. We say so.
- Not pretending to be the agent itself. The templates don't say "Hi
  I'm Pip." They say "spinning up your agent."

The user reads the templates as the system speaking in the agent's
tone. Then the real agent shows up, bootstrap greeting in full voice,
distinctly alive. Because the voice is consistent across both
surfaces, the transition feels coherent rather than jarring.

---

## 2. Honest diagnosis of today's flow

We have one channel (Telegram) and a six-screen path. From landing to
first real agent message, the typical happy path is:

1. Land on `instaclaw.io`
2. Click **Get Started** to `/signup`
3. Google OAuth to `/connect`
4. Read instructions, open Telegram, message @BotFather, type
   `/newbot`, pick a name, pick a username, copy the long bot token,
   paste it back into our site
5. Choose a plan, then Stripe Checkout (full card capture)
6. `/deploying`, watch a progress bar for 2-10 minutes
7. Eventually, open Telegram, find the bot, type `/start`, wait for
   the first reply

The brutal read:

- **Step 4 is a tax on non-developers.** A consumer attendee at Edge
  Esmeralda has no idea what a "bot token" is and has never heard of
  BotFather. Roughly half don't make it past this step.
- **Step 6 is dead time.** Two to ten minutes of "Configuring your
  agent" with nothing happening on the user's side. No preview, no
  reason to stay on the page, no signal that anything is alive yet.
- **Step 7 is a context switch plus a slash-command.** After all the
  work and the payment, the user has to open another app and type a
  command to finally meet their agent. The first thing the agent
  says is generic.

The infrastructure works. It provisions a real dedicated VM running
OpenClaw, which is remarkable. But the **experience around that
infrastructure has six different surfaces and three context switches
before the agent says hello.** A consumer doesn't see infrastructure.
They see seven hoops to jump through.

---

## 3. What Zo and Clawputer figured out, and what they missed

Both shipped the same primary insight: **the messaging app the user
already has open is a better onboarding surface than a web form.**
The QR on their landing page is the entire signup. Scan, send a
pre-filled text, you're in.

What they got right:

- The QR replaces the signup form
- The user never has to download anything
- The product surface (iMessage) is the user's daily-driver, not a
  new app they have to learn

What they missed:

- The reply is a robotic system message ("Welcome to Zo, use this
  link to verify"). Not the agent. A verification flow with a chat
  skin.
- The link is a long ugly URL with query params. Cooper had to copy
  and paste from iMessage to Safari manually.
- Their reply got filtered into iOS's Unknown Senders tab. At scale
  this kills the channel.
- Nothing about the choreography says "you're meeting an AI agent."

The gap: **the agent should be the first thing they meet, with full
personality, full voice, and the ability to actually do something.**
Zo's mistake is the user signs up and then meets the agent in a chat
window labeled "SMS Onboarding." The magic is gone before it starts.

Our move is different. We don't try to fake an agent with a shadow
service. We get the user through signup as fast as we can, then the
real agent arrives in their iMessage thread, proactively, knowing
their name and preferences. **The agent comes to them.** That's the
thing nobody else does.

---

## 4. The three moments

There are three points in any onboarding where the user is paying
full attention. We design for these three specifically. Everything
between them is connective tissue.

### Moment 1, decide

> User is standing in a hallway at Edge Esmeralda with a coffee. They
> see a poster: a QR code, a single line of copy, an illustration of
> an agent texting them back. They have five seconds.

The decide moment is about lowering the cost of trying until it's
lower than the cost of NOT trying. Free trial obvious. Card not
mentioned anywhere on the poster. The QR is the entire CTA, no
"sign up" button, no form, no email field.

### Moment 2, first contact

> User has scanned, hit send on a pre-filled text, and is staring at
> their phone wondering if they did the right thing.

Within two seconds, two short messages arrive. The first is warm and
honest. The second has the signup link. The user thinks: "okay, this
is real, takes a minute, let me do it." They tap the link.

This moment used to be 2-10 minutes of `/deploying` page. Now it's
two short texts that set expectations and route them forward.

### Moment 3, the agent comes alive

> User has finished the auth detour, closed the tab, and is back in
> iMessage. A new message arrives in the same thread. The agent is
> talking. It knows their name, it knows their preferences if they
> filled out the form, and it's offering to do something concrete.

This is the moment they screenshot for Twitter. The agent didn't
make them find a bot or type /start. The agent came to them.

---

## 5. The new flow, end to end

### 5.1 Two entry surfaces

**Surface A, physical QR (Edge Esmeralda, posters, stickers, business
cards):**

The QR encodes `sms:+1XXXXXXXXXX&body=hi`. Scanning with the iPhone
Camera app pops up a banner: "Open Messages, text +1 (XXX) XXX-XXXX."
One tap. Messages opens with the recipient and body pre-filled.
User taps send. Zero web pages, zero intermediate screens.

**Surface B, web landing page:**

`instaclaw.io`, then **Get Started**, then `/channels`. The channel
selection page is the front door for users who arrive via web. Picking
iMessage opens the QR modal. Picking Telegram routes to today's
`/signup` flow unchanged. Picking Discord or Slack captures email
for a waitlist.

Both surfaces lead to the same place: the user texts our number, the
two welcome templates fire, and they enter the signup flow.

### 5.2 The channel selection page

```
                    ┌────────────────────────────────┐
                    │     Where do you want to       │
                    │     talk to your agent?         │
                    │                                 │
                    │  ┌───────────────────────────┐ │
                    │  │ 💬  iMessage              │ │
                    │  │     Apple Messages         │ │
                    │  └───────────────────────────┘ │
                    │  ┌───────────────────────────┐ │
                    │  │ ✈️  Telegram              │ │
                    │  │     Most popular today     │ │
                    │  └───────────────────────────┘ │
                    │  ┌───────────────────────────┐ │
                    │  │ 🎮  Discord     (coming)  │ │
                    │  └───────────────────────────┘ │
                    │  ┌───────────────────────────┐ │
                    │  │ 💼  Slack       (coming)  │ │
                    │  └───────────────────────────┘ │
                    │                                 │
                    │  InstaClaw is portable. Pick    │
                    │  where you want to start. You   │
                    │  can connect every other        │
                    │  channel from your dashboard    │
                    │  once you're set up.            │
                    └────────────────────────────────┘
```

Mobile-first, single column, every tile is a tap target. The
"portable" line is load-bearing copy. It tells the user this isn't a
one-shot decision and signals product depth.

### 5.3 The iMessage flow, end to end

Seven steps from QR to first conversation. None of them are LLM calls
until step 7.

**Step 1.** User scans the QR. Messages opens with our number and
`hi` pre-filled. They tap send.

**Step 2.** Within 1-2 seconds, Welcome Message 1 arrives. Template
copy, agent voice. (Exact copy in §6.)

> Hey. Got your text. About to spin up your own AI agent. Takes about
> a minute, real computer behind it, real memory, real skills.

**Step 3.** Welcome Message 2 arrives immediately after. The signup
link. (Exact copy in §6.)

> Tap here to finish setting up, then come back. I'll text you the
> second I'm ready.
>
> instaclaw.io/go/r7k2x

**Step 4.** User taps the link. Browser opens to `/auth` (the §5.4
page). Two doors: **Connect ChatGPT** as the visibly primary action,
**Sign in with Google** as the clean secondary. They pick one, OAuth
runs.

**Step 5.** OAuth completes. User lands on `/plan`, the plan + card
capture page (§5.5). They pick a tier, enter card for a free trial,
submit. No charge today. Free trial starts. The pending_users row is
created or updated with their selection and stripe_session_id.

**Step 6.** Card captured. User lands on `/onboarding/done`, the
"you're in" page (§5.6). It has a "head back to Messages" CTA at
the top, three optional personalization questions below (name, what
for, vibe), and a real progress bar showing VM provisioning. They
can fill the form, or skip, or close the tab. The agent will text
them either way.

**Step 7.** VM ready. The real dedicated agent fires its bootstrap
greeting in the same iMessage thread, proactively. This is the first
LLM response the user has seen. Full voice, full memory, full
skills. If they filled the personalization form, the agent already
knows their name, intended use, and vibe (the data was injected into
USER.md before the agent ever booted). If they skipped, the agent
gracefully introduces itself and asks.

From this moment forward, the user is in a normal conversation with
their dedicated agent. Future incoming messages route through the
Sendblue webhook to the user's VM gateway, agent responds via the
Sendblue API.

### 5.4 The auth page (Google + Connect ChatGPT)

This is the only web page in the entire onboarding flow. It is the
single moment we pull the user out of iMessage. **It has to be worth
it.** Generic OAuth pages are unacceptable.

The page presents exactly two options. They are NOT equal-weight by
design. The visual hierarchy does the heavy lifting.

```
┌──────────────────────────────────────────────────────┐
│                                                        │
│                      [InstaClaw mark]                  │
│                                                        │
│              you're almost in.                         │
│                                                        │
│       Your agent is finishing setup in iMessage.       │
│        Ten seconds and you're back to it.              │
│                                                        │
│                                                        │
│   ┌────────────────────────────────────────────────┐  │
│   │                                                  │  │
│   │      Connect ChatGPT  →                          │  │
│   │                                                  │  │
│   │      Uses your existing subscription to lower    │  │
│   │      your plan cost.                             │  │
│   │                                                  │  │
│   └────────────────────────────────────────────────┘  │
│                                                        │
│                       or                               │
│                                                        │
│           ┌──────────────────────────────────┐        │
│           │   Sign in with Google             │        │
│           └──────────────────────────────────┘        │
│                                                        │
│                                                        │
└──────────────────────────────────────────────────────┘
```

**Design treatment, non-negotiable:**

- **ChatGPT card is the primary action.** Larger surface area, filled
  with the coral accent color, single-line supporting copy in lighter
  weight beneath the button label. The card itself is the tap target.
- **Google button is the secondary action.** Smaller, outlined, no
  supporting copy. Clean, simple, a one-tap escape hatch for users
  who don't have ChatGPT.
- **The single supporting line under the ChatGPT card** is the most
  important sentence on the page for power users: *Uses your existing
  subscription to lower your plan cost.* One sentence, no jargon. The
  benefit is obvious without being shouted.
- **The "or" divider is a single line of thin small-caps**, plenty of
  whitespace either side. A breath, not a confrontation.
- **Headline is the agent's voice.** *"you're almost in."* Lowercase,
  period included, declarative, warm.
- **Subhead reassures continuity.** *"Your agent is finishing setup in
  iMessage. Ten seconds and you're back to it."* The agent is the
  subject, not InstaClaw, not "your account."
- **No nav, no footer, no legal links cluttering the page.** Terms +
  Privacy live as tiny links at the very bottom in low-contrast grey.
- **Mobile-first.** Full-width buttons stacked vertically. The
  ChatGPT card occupies roughly 60% of the visual weight.

**What "Connect ChatGPT" does technically:**

We reuse the existing ChatGPT OAuth flow exactly as it works today
(`/api/auth/openai/signup/start`, `/api/auth/openai/signup/poll`).
Tokens land in the existing user columns (`openai_oauth_access_token`,
`openai_oauth_refresh_token`, etc.). When `api_mode='byok'` is set on
the user record, the user's gateway routes through their OpenAI
subscription for OpenAI-model calls instead of through our proxy.
That's the cost-reduction benefit, end to end.

**What "Connect ChatGPT" does NOT do in v1:**

The previous version of this spec included a background worker that
fetched the user's ChatGPT conversation history, summarized it, and
injected it into MEMORY.md so the agent already knew the user. **That
is deferred to a future release.** Reasoning: confirming OpenAI's
conversation-history API scope is a research dependency, and the
spec ships better without it for v1. The ChatGPT button still does
real work via BYOK; the history-import magic comes later as an
additive upgrade.

**Skipping ChatGPT is a fine path.** Some users will tap Google. That
works. Google OAuth completes, no BYOK, M_RETURN uses the default
agent introduction.

### 5.5 Plan + card capture

After OAuth, the user lands on `/plan`. This is similar to today's
`/plan` page, with two surgical changes:

- The page is now styled to match the glass system + coral accent +
  serif headlines of `/auth` and `/onboarding/done`. Same brand bar
  as the rest of the flow.
- The page transitions to `/onboarding/done` instead of `/deploying`
  for iMessage users. (Telegram users still go to `/deploying`, per
  the preserved flow.)

The user picks a tier and enters card info for a free trial. Stripe
Checkout handles the form. On success, the pending_users row is
finalized, the free trial is recorded, and the user is redirected to
`/onboarding/done`. No charge happens today; the trial roll-over
charges fire on day 7 unless cancelled.

**Edge Esmeralda attendees** skip card capture. The existing
`partner='edge_city'` logic sets a sponsored trial with `trial_end =
June 30` and no card. They go from `/auth` directly to
`/onboarding/done`. No behavioral change to existing Edge logic; the
spec just routes them through `/onboarding/done` instead of
`/deploying`.

### 5.6 The "you're in" page

This page is the most important UX decision in the spec after the
welcome templates. It's where Zo's flow falls apart (they make the
"while you wait" screen feel like a destination). Ours inverts the
framing.

```
        ┌───────────────────────────────────────────────┐
        │                                                 │
        │              ✓ you're in.                       │
        │                                                 │
        │   Your agent's finishing up in iMessage.        │
        │   Head back when you're ready. It'll text       │
        │   you the moment it's set up.                   │
        │                                                 │
        │            [ Head back to Messages ]            │
        │                                                 │
        │  ─────────  Or, while you wait:  ─────────     │
        │                                                 │
        │   Quick context, none of this is required.      │
        │   Skip and the agent will figure it out as      │
        │   you talk. But if you give it a few seconds,   │
        │   it'll show up already knowing.                │
        │                                                 │
        │   What should we call you?                     │
        │   [ Cooper                              ]      │
        │                                                 │
        │   What do you want to use it for?              │
        │   ○ Work    ○ Personal    ○ Both              │
        │                                                 │
        │   What's your vibe?                            │
        │   ○ Just get things done                       │
        │   ○ Chatty and warm                            │
        │   ○ Wry and minimal                            │
        │                                                 │
        │   ────────────────────────────────────────     │
        │                                                 │
        │   Setting up your computer.                    │
        │   ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░  47%        │
        │                                                 │
        │            [ Skip ]    [ Save & Close ]         │
        │                                                 │
        └───────────────────────────────────────────────┘
```

Three patterns we steal from Zo explicitly:

- **"While you wait, personalize"** is brilliant. We use it. But it's
  not the headline. It's below the "head back to Messages" CTA.
- **Skip button is always visible** on every form element.
- **Honest progress communication.** The progress bar is real, the
  labels are accurate ("Setting up your computer." then "Started your
  computer."). Lying about progress destroys trust.

What we do differently:

- **The "head back to Messages" button is the primary CTA.** Bigger
  than the personalization form. Above the fold.
- **The personalization has a reason attached.** "If you give it a
  few seconds, it'll show up already knowing." Not "fill these out
  to complete signup." Filling them out is OPTIONAL VALUE.
- **The web dashboard is NOT in this flow.** Zo's flow ends on a web
  app interface. Ours ends in iMessage. The web page exists to bind
  auth, capture personalization, and provision the VM. The user
  never has to come back to the web.
- **The user can close the tab.** The agent will text them. The web
  page is service to the conversation; the conversation is the
  product.

The personalization fields write to a new `instaclaw_user_profile`
table. On VM provisioning, `configureOpenClaw` reads this and
injects:

- `Name: Cooper` into USER.md
- `Mode: work` and `Vibe: wry-and-minimal` into IDENTITY.md

These get loaded into the dedicated agent's context before the
bootstrap greeting fires.

### 5.7 The Telegram flow, shared bot as primary + BYOB preserved

Cooper's directive: do NOT touch, break, or remove anything in the
existing Telegram onboarding flow (the BotFather token paste path).
We honor that absolutely. **But we also ship a parallel path that
eliminates the BotFather step entirely**, mirroring the iMessage
flow's architecture. The two paths coexist; existing customers see
zero change.

**The new primary Telegram path: a shared `@myinstaclaw_bot`.**

Picking Telegram on the channel selection page no longer routes
straight to today's `/signup` + `/connect` BotFather flow. Instead,
it goes through the same channel-specific routing pattern as
iMessage, with the existing BYOB path available as the alternative:

```
        ┌──────────────────────────────────────────┐
        │   Talk to your agent on Telegram         │
        │                                            │
        │   ┌──────────────────────────────────────┐ │
        │   │  Open Telegram  →                    │ │
        │   │                                       │ │
        │   │  Message @myinstaclaw_bot and we'll      │ │
        │   │  spin up your agent right here.       │ │
        │   └──────────────────────────────────────┘ │
        │                                            │
        │   Or, advanced: bring your own bot,        │
        │   custom name and avatar.                  │
        │   [Set up your own bot] →                  │
        │                                            │
        └──────────────────────────────────────────┘
```

The primary action is "Open Telegram" with the shared bot. The BYOB
path is a smaller link below for power users.

**Shared bot flow (mirrors iMessage exactly):**

1. User taps "Open Telegram". Deep link
   `https://t.me/InstaClawBot?start=channels` opens Telegram with
   @myinstaclaw_bot and pre-fills `/start channels`. User taps Start.
2. Telegram pushes the inbound message to our shared bot's webhook
   at `/api/telegram/shared-bot/inbound`.
3. Handler extracts the `chat_id`, looks up bindings, sees this is
   a new user. Creates a `pending_users` row with
   `channel='telegram'`, `channel_identity=<chat_id>`, generated
   `short_code`.
4. Handler sends **Welcome Message 1** via Telegram Bot API
   (template, same copy as iMessage's Welcome 1 modulo "I'll text
   you" becomes "I'll message you here").
5. Handler immediately sends **Welcome Message 2** with the signup
   link, also via Telegram Bot API.
6. User taps the link. Browser opens to `/auth`. OAuth, then
   `/plan` for card capture, then `/onboarding/done`.
7. VM provisions. The user's `chat_id` is bound to their `user_id`
   in `instaclaw_user_channel_bindings`. The user's VM is configured
   with NO Telegram bot token (the shared bot is the relay).
8. **M_RETURN fires via the shared bot.** Our backend hits
   `sendMessage` on the Telegram Bot API with the shared bot's
   token and the user's `chat_id`. The agent's first message lands
   in the same @myinstaclaw_bot thread.

From step 8 forward, every message exchange is: user types in
@myinstaclaw_bot → Telegram webhook → backend looks up chat_id → routes
to user's VM gateway via HTTP → VM responds → backend sends response
via Telegram Bot API to that chat_id. **The VM never knows it's on
Telegram.** It just sees inbound messages and responds. Same routing
abstraction as iMessage.

**BYOB flow, unchanged in every detail:**

Tapping "Set up your own bot" routes to today's existing `/signup`
flow. From there: Google OAuth → `/connect` with BotFather token
paste → `/plan` → Stripe → `/deploying` → user's own custom bot.
**Zero behavior changes.** Every existing paying customer is on
this path and stays there. Power users who want their own bot name
and avatar choose this deliberately.

**Critical architectural distinctions:**

| Property | Shared bot path (new) | BYOB path (existing) |
|---|---|---|
| Bot used | `@myinstaclaw_bot` (shared by all users) | User's own bot from BotFather |
| Routing | Backend webhook → VM HTTP gateway | VM polls Telegram directly |
| VM config | No bot token in openclaw.json | User's bot token in openclaw.json |
| Onboarding screens | 0 (Open Telegram → talk) | 6 (signup, connect, token, plan, Stripe, deploying) |
| Bot name shown to user | "InstaClaw" | Whatever the user named theirs |
| Customization | None (same bot for everyone) | Full (custom username, avatar, bio) |
| Migration | Can later upgrade to BYOB | Already BYOB |

The paths are intentionally separated. A shared-bot user has no bot
token on their VM. A BYOB user owns their bot. The two never collide
because the routing is determined by which channel handler the
inbound message arrived through.

**Why the shared bot path is the new primary:**

The BotFather step in today's funnel is the single biggest drop-off
in our current onboarding. For a non-developer at Edge Esmeralda, it
might as well be the Sahara. By moving the shared bot to primary,
we cut Telegram onboarding from 6 screens to the same 7-step flow
iMessage users follow (and only 3 of those are web pages). The
agent comes to them.

**Why BYOB stays:**

For users who want their agent under a custom Telegram identity
(personal name, brand, etc.), BYOB is the right answer. Cooper's
constraint that existing customers can't be disrupted is also
absolute. So BYOB stays as a clean, dedicated path with zero
changes.

**Operational notes on the shared bot:**

- **Username**: `@myinstaclaw_bot`. Registered via BotFather (Cooper,
  2026-05-26). Bot owner is Cooper's account.
- **Token**: stored as `TELEGRAM_SHARED_BOT_TOKEN` env var in Vercel
  production. NEVER hardcoded in any file checked into the repo. Per
  the partner-secret discipline (CLAUDE.md Rule 49), the token is
  read at runtime by the webhook handler and the outbound send
  function from `process.env`.
- **Webhook URL**: `https://instaclaw.io/api/telegram/shared-bot/inbound`.
  Registered with Telegram once via a one-shot bootstrap script
  (`scripts/_register-telegram-shared-bot-webhook.ts`) that calls
  Telegram's `setWebhook` API with the configured URL. Run once per
  environment (prod, preview) at deploy time. Telegram persists the
  registration on its side; no per-request setup needed.
- **Rate limits**: Telegram bots can send ~30 messages/sec across
  all chats with ~1/sec per individual chat (soft limits). For
  1,000+ Edge attendees with realistic peak concurrency of 100,
  we're orders of magnitude under. Higher-throughput tier is free
  if needed via Telegram application.
- **Per-user privacy**: bot DMs are private per-user by design.
  Telegram users cannot see other users' conversations with
  @myinstaclaw_bot. Each chat_id is a separate, isolated thread.
- **Future migration to BYOB**: an `instaclaw_user_channel_bindings`
  row per user supports adding a new BYOB binding without removing
  the shared-bot one. Dashboard could later expose "switch to your
  own bot" as a one-tap upgrade. Out of scope for v1.

**Voice continuity for shared-bot users:**

The two template welcome messages on Telegram use the same canonical
copy as iMessage, with one wording tweak ("I'll text you" → "I'll
message you here"). M_RETURN fires the same v122 bootstrap greeting
from the dedicated VM, with personalization injection if the user
filled the form. Voice is identical across iMessage and Telegram
shared-bot users. The channel is invisible; the agent is the same.

**Clawputer's misses on this same pattern:**

Cooper saw their screenshots. They run the same shared-bot
architecture but their copy is generic and their agent names are
machine-generated ("eager-tiger-878" type slugs). We don't make
those mistakes. Our Welcome 1 + Welcome 2 + M_RETURN are
hand-crafted in the v122 voice; the agent's name is either the
user's name (if they answered the personalization form's "what
should we call you?" question literally) or one of a curated short
list (Pip, Riv, Olm, Sal, Bea, Wren, Hex) assigned at provisioning.
Never a slug.

### 5.8 Discord and Slack

Both are placeholders for this release. Tapping either greyed tile
reveals a one-field form:

```
        ┌──────────────────────────────────────────┐
        │  We're working on it.                     │
        │                                            │
        │  Drop your email and we'll text you when  │
        │  Discord support is live.                 │
        │                                            │
        │  [ your@email.com         ]    [Notify Me]│
        └──────────────────────────────────────────┘
```

Stores in `instaclaw_waitlist` (email, requested_channel, created_at).
Cooper can email these users when we ship.

### 5.9 Edge Esmeralda specifics

When the entry context indicates Edge (poster QR with `?src=edge`
parameter, or the user arrives via `/edge/*` URLs):

- The channel selection page reads the `instaclaw_partner` cookie and
  pre-selects iMessage as the recommended channel.
- The user's pending_users row carries the partner tag forward.
- The plan + card capture page (§5.5) is skipped for `edge_city`
  users via the existing sponsored-trial logic. They go straight to
  `/onboarding/done`.
- The personalization form on `/onboarding/done` includes a fourth
  question for Edge users: their attendee intent. The captured intent
  writes to the same backend destination today's `/edge/intents` page
  uses, so the matching engine has what it needs.
- The real agent's bootstrap greeting (§6, M_RETURN) acknowledges the
  Edge context. Server-side conditional copy.

The existing Edge code path stays intact end to end: `/edge/claim`
still verifies tickets, the partner cookie still routes through OAuth
callback, Stripe trial_end is still set to June 30 server-side. The
spec wraps the existing flow; it doesn't modify it.

---

## 6. The messages

Four messages in total. Three are templates (Welcome 1, Welcome 2,
Welcome 3 — the bare link in its own bubble). One is a real LLM
response from the dedicated VM (M_RETURN, the bootstrap greeting). A
fifth (M_BILLING) is an optional courtesy heads-up on day 6 of the
free trial.

The link being its own message bubble is intentional: bare URLs on
their own line are the most tappable form on both iOS and Telegram,
and the visual separation matches the choreography (excitement →
instruction → action).

### Welcome Message 1

| Property | Value |
|---|---|
| When | 1-2 seconds after user's first inbound text/message |
| Job | Acknowledge the user, paint the picture of a dedicated machine being spun up RIGHT NOW just for them, distill what that unlocks into ONE punchy line, set expectation. |
| Constraints | No link. All lowercase. No em-dashes. Under 300 chars. First-person agent voice. Template, NOT an LLM call. |

Canonical copy (same for iMessage and Telegram shared bot):

> hey. fresh linux computer spinning up right now, just for you and me. browser, terminal, file system, my own little corner of the internet to work from. anything you'd open a laptop for, just text me. give me about a minute and i'll be ready to actually do things for you, not just talk about it.

296 chars. Under the 300 limit. No channel-specific words — same copy in both surfaces.

The five beats:

1. **"hey."** — opening greeting, lowercase, soft.
2. **"fresh linux computer spinning up right now, just for you and me."** — what's literally happening, with the brand-defining shared-space framing. "Just for you and me" reframes the product: not a service being provisioned for a customer, but two entities getting their own shared space. That's the brand.
3. **"browser, terminal, file system, my own little corner of the internet to work from."** — the agent enumerating its tools. Three-beat comma rhythm + the "little corner of the internet" line (a humble-poetic agent-perspective phrase that hints at Zo's "home on the internet" energy without copying it).
4. **"anything you'd open a laptop for, just text me."** — the tangible meaning. What having a dedicated computer ACTUALLY unlocks for the user, in one line. The "open a laptop" image is universal; "just text me" closes the loop on what the user did to initiate this.
5. **"give me about a minute and i'll be ready to actually do things for you, not just talk about it."** — expectation + the differentiator closer. "Do things for you, not just talk about it" is the v122-voice contrast vs every other AI product.

The Welcome 1 + Welcome 2 + Welcome 3 burst is the agent's three-act arc: birth + capabilities + meaning → anticipation → action.

### Welcome Message 2

| Property | Value |
|---|---|
| When | Immediately after Welcome 1, in the same webhook response (1 second gap, so the user reads them in order) |
| Job | Instruction with soul. Shift to first-person agent voice with the "i genuinely cannot wait" line that carries the self-aware enthusiasm of the v122 bootstrap greeting. |
| Constraints | No link (the link is its own message). Lowercase. No em-dashes. Under 200 chars. Template. |

Canonical copy (same for both iMessage and Telegram shared bot):

> quick signup so i know who you are. then head back here, i genuinely cannot wait to meet you and show you what i can do.

The "i genuinely cannot wait" is the soul-line. It's the agent waking
up just enough to anticipate meeting the user. It pays off when
M_RETURN arrives.

### Welcome Message 3 (the link, alone)

| Property | Value |
|---|---|
| When | Immediately after Welcome 2, third message in the burst |
| Job | Deliver the link in the most tappable form possible. Its own message bubble. Nothing else. |
| Constraints | Bare URL. No surrounding text. Same in both channels. |

Canonical copy:

> instaclaw.io/go/r7k2x

That is the entire message. iOS and Telegram both auto-link a bare
URL into a tap target. A bubble containing only a URL is the
maximum-tappable, minimum-friction form. No "tap here," no padding,
no hunting through paragraphs.

The 5-character code is generated server-side per pending_users row.

### M_RETURN, the real agent's first message

| Property | Value |
|---|---|
| When | When the dedicated VM is ready, conversation history is loaded, personalization (if any) is injected into USER.md, and the agent has had its bootstrap greeting moment. |
| Job | Bootstrap greeting. Voice continuity from the templates. Knows the user's name and preferences if they filled the personalization form. Offers something concrete to do. |
| Constraints | This is an LLM response from the dedicated agent. NOT a template. The agent reads BOOTSTRAP.md, USER.md, IDENTITY.md, and crafts its first message. |

**With personalization (user filled out the §5.6 form):**

> Okay, I'm up. Cooper, right? You said work mode, wry-and-minimal
> vibe. Cool, that's how I'll show up.
>
> What do you want me to do first?

**Without personalization (user skipped the form):**

> Okay, I'm up. Real Linux computer behind me, memory persists from
> here on out, can actually do stuff on the internet.
>
> What do you want me to do first?

**Edge variant (Edge attendee, personalization possibly skipped):**

> Okay, I'm up. I know you're at Edge Esmeralda. I've got the village
> schedule loaded and can do real stuff, not just chat.
>
> Want a daily 9am brief with what's happening that day? Or just tell
> me what you need.

**Critical implementation note:** the v122 BOOTSTRAP.md template is
what the dedicated agent reads to construct M_RETURN. The current
template says "Hey! I just came online, first moment awake. Fresh
workspace, empty memory, no name yet." That's still the foundation
voice, but the agent layers in what it knows from USER.md
(name, intended_use, vibe) and IDENTITY.md (any pre-set name from
personalization). The agent doesn't recite the fields, it
demonstrates knowing them naturally.

### M_BILLING, the trial-end heads-up (optional, day 6)

With card capture upfront, M_BILLING is less critical than the
previous version of this spec implied. The user has already given
us a card. Day 6, the trial converts. Day 7, we charge. That works.

But a courtesy heads-up on day 6 is good UX, and it's a chance for
the agent to demonstrate it's been doing work for them.

| Property | Value |
|---|---|
| When | Day 6 of the free trial |
| Job | Polite reminder that the card converts tomorrow. Honest read on whether the agent has been useful. Easy cancel path. |
| Constraints | Agent voice, not billing-system voice. References specific value delivered. No em-dashes. |

Canonical copy:

> Heads up. Your free week ends tomorrow. I'll charge the card
> automatically unless you tell me not to.
>
> Honest read on whether I've been useful, in the last six days I
> {summarize 3 concrete things, e.g., "set 4 reminders, ran 12
> searches for you, sent 2 morning briefs"}.
>
> If you'd rather not continue, just tell me. No drama.

The summary is generated server-side by the agent (real LLM call,
this time with access to the conversation history). Personality
includes graceful endings. The "no drama" closer matters.

---

## 6.5 Timing choreography

> Timing is the UX. Every second of the user's attention is either being rewarded with content or used for background work they don't need to see. This section documents the exact sequence, in real-world seconds measured from the existing code, so any engineer wiring up the build knows precisely when each call fires.

### 6.5.1 The real latency numbers (from the code, not guessed)

Read from `lib/createUserVM.ts:530-535` and the maxDuration comment in `/api/checkout/verify/route.ts`:

| Phase | p50 | p99 | Source |
|---|---|---|---|
| Pool VM atomic claim (`assignVMWithSSHCheck` → DB RPC + SSH probe) | ~5s | ~10s | `lib/createUserVM.ts:524` |
| `configureOpenClaw` on pool VM (no partner) | ~30s | ~60s | `lib/createUserVM.ts:530` |
| `configureOpenClaw` on pool VM (partner=edge_city: skill clone + EDGEOS + Index Network) | ~60s | ~90s | composite of `stepDeployEdgeOverlay` + `stepIndexProvision` + base configure |
| Total pool path (assignment → `gateway_url` populated) | **~40s** | **~100s** | composite |
| Cloud-init fallback (used only when pool is empty) | ~5min | ~10min | `lib/createUserVM.ts:533` |
| Sendblue API outbound (per message) | ~300ms | ~700ms | empirical estimate; verify post-launch |
| ChatGPT OAuth device-code (poll loop, user side) | ~20s | ~40s | `app/api/auth/openai/signup/*` |
| Google OAuth (NextAuth flow) | ~8s | ~15s | typical for OAuth-popup roundtrip |
| Stripe Checkout (user enters card) | ~30s | ~60s | typical e-commerce checkout |

**The single most important number: pool VM ready in ~40s p50.** Everything we do is choreographed around hiding this latency behind active user work.

### 6.5.2 The architectural decision: start VM provisioning at OAuth, not card capture

This is the structural change vs. today's flow. Today, `/api/checkout/verify` triggers `assignOrProvisionUserVm` AFTER Stripe Checkout completes. The user lands on `/deploying` and stares at a polling progress bar for the full ~40s while the VM configures.

In the new flow, we trigger VM assignment **immediately after OAuth succeeds**, before the user even reaches `/plan`. This gives us a ~30-50s head start while the user enters their card. By the time they land on `/onboarding/done`, the VM is either ready or finishing the last 10s of configure.

**The risk:** if the user abandons at `/plan` (doesn't enter card), we've consumed a pool VM slot for nothing.

**The mitigation:** the assigned VM is held in `status='assigned'` with `consumed_at IS NULL` on the pending row. If `consumed_at` doesn't land within 10 minutes, a cron sweeps the VM back to `status='ready'` (the existing `process-pending` reclaim infrastructure already handles this lifecycle — we extend its precondition to "assigned VM whose pending row hasn't consumed in 10 min").

**The size of the risk:** pool target is 15, replenish runs every 5 min, MAX_PER_RUN=10. Even with 10% abandon rate at /plan during a 100-attendee/hour Edge surge, we lose 10 VMs/hr that are reclaimed in 10 min. Net: pool stays above POOL_FLOOR=10 with comfortable headroom.

**For Edge partner flow (no card capture)**: same trigger point — at OAuth. There's no `/plan` step, so the user goes directly from `/auth` → `/onboarding/done`. The 15-30s of personalization fills the gap while VM configures.

### 6.5.3 The Welcome 1+2+3 burst — variable gaps, not uniform

The three messages have very different reading-load:

| Message | Length | Reading time |
|---|---|---|
| Welcome 1 | 296 chars | ~5-7s |
| Welcome 2 | 118 chars | ~3-4s |
| Welcome 3 (just the URL) | ~25 chars | ~1s |

A uniform 900ms gap means Welcome 2 arrives BEFORE the user finishes reading Welcome 1, and Welcome 3 arrives while they're still on Welcome 2. The bubbles pile up. The user's eye gets confused. The choreography breaks down.

**The variable-gap timing:**

- Welcome 1 sent at **T+0**
- Welcome 2 sent at **T+2.0s** (gives the user 2s of reading time for the long first message — they're still mid-read when W2 arrives, but they've absorbed enough of the dedication beat to feel the moment land)
- Welcome 3 sent at **T+2.5s** (only 500ms after W2 — W2 is short and the link should appear immediately after the instruction "head back here")

Reasoning: the goal isn't "give the user time to finish reading each one." The goal is "let each beat land before the next interrupts." Welcome 1's dedication beat ("just for you and me") needs maybe 2s to register; Welcome 2's instruction lands fast; the link is just an action artifact and shouldn't be separated from the instruction.

**Implementation note**: this is the webhook handler's job (`app/api/imessage/inbound/route.ts`), not `sendImessageBurst`'s. The handler orchestrates the three sends explicitly with `setTimeout` so the timing is documented in the user-facing code, not buried in a library default.

### 6.5.4 The end-to-end timeline (iMessage path, with card)

```
USER ACTIONS (left)                                BACKEND (right)
═══════════════════════════════════════════════════════════════════════

T+0:00s  User taps QR / saved contact ────────────────► Messages opens
                                                        sms: scheme pre-fills
                                                        "hi" as message body

T+0:02s  User taps send ──────────────────────────────► Sendblue receives,
                                                        POSTs /api/imessage/inbound

T+0:02.3s                                              Webhook: signature
                                                        verified, payload
                                                        parsed, classified
                                                        as new user
                                                        INSERT pending_users
                                                        (50ms)
                                                        Schedule burst via
                                                        after(), return 200

T+0:02.6s                                              Welcome 1 fires
                                                        (~300ms Sendblue latency)

T+0:02.9s  ◄────────────────────────── Welcome 1 arrives in Messages
[User reads Welcome 1 — 5-7s]

T+0:04.9s                                              Welcome 2 fires
                                                        (T+0+2.0s gap from W1)

T+0:05.2s  ◄────────────────────────── Welcome 2 arrives in Messages
[User absorbs the instruction — 2-3s]

T+0:05.4s                                              Welcome 3 fires
                                                        (T+2.5s, 500ms gap from W2)

T+0:05.7s  ◄────────────────────────── Welcome 3 (link) arrives
[User reads + taps the link — 1-3s]

T+0:08s  User taps link, in-app browser
         opens to instaclaw.io/go/r7k2x

T+0:08.5s ─────────────────────────────────────────────► /go/r7k2x route
                                                        302 → /auth?session=...

T+0:09s  /auth page renders.
         User sees ChatGPT + Google
         cards, picks ChatGPT.

[OAuth flow — ChatGPT device-code ~20s, OR Google ~8s]

T+0:30s  OAuth complete. User redirected
         to /plan.
         ─────────────────────────────────────────────► **VM ASSIGNMENT STARTS**
                                                        Pool VM claimed
                                                        (~5s atomic RPC + SSH)

T+0:35s                                                Pool VM in hand.
                                                        configureOpenClaw fires
                                                        in after() — backend
                                                        keeps working while
                                                        user is on /plan.

[User on /plan — picks tier, clicks Continue, Stripe Checkout opens]

T+0:35-60s  User enters card                            configureOpenClaw running:
                                                        - opens SSH (~2s)
                                                        - writes openclaw.json
                                                        - installs partner skills
                                                        - mints gateway_token
                                                        - starts gateway
                                                        - verifies /health=200

T+1:05s  Stripe Checkout completes.
         User redirected back.       ──────────────────► /api/checkout/verify
                                                        (idempotent — VM is
                                                        already configured by now)

T+1:05.5s                                              **gateway_url populated**
                                                        — VM is READY

T+1:06s  User lands on /onboarding/done

[User fills personalization form — name, intended_use, vibe — 15-30s]
         OR taps Skip                                  Form submit writes
                                                        instaclaw_user_profile

T+1:30s  User taps "Done" or "Skip"   ──────────────────► **M_RETURN dispatch**
                                                        Reads channel binding
                                                        + personalization
                                                        Sends agent's first
                                                        message via Sendblue

T+1:32s  ◄────────────────────────── M_RETURN arrives in Messages
[User has closed browser tab, gone back to Messages, sees the new message]

✓ Total time from first text to M_RETURN: ~90 seconds
✓ The user never waited without doing something
✓ The VM was ready by the time the user came back
```

### 6.5.5 The Edge partner path (no card capture)

```
T+0:00-08s  Same: text → 3 welcome messages → tap link

T+0:09s   /auth renders (Edge cookie present from /edge/claim flow,
          partner='edge_city' set on user creation)

[OAuth ~20s]

T+0:30s   OAuth complete.
          ─────────────────────────────────────────────► **VM ASSIGNMENT STARTS**

T+0:31s   /auth detects partner='edge_city',
          skips /plan, redirects to /onboarding/done

[User on /onboarding/done — fills personalization 15-30s OR skips]

T+1:00s                                                **gateway_url populated**
                                                        (60-90s configure time
                                                        for edge_city VM)

T+1:00-1:30s  User taps Done/Skip ──────────────────► M_RETURN dispatches

✓ Total ~90s same as paid flow
✓ The personalization fills the 30s gap between OAuth completion and gateway_url ready
```

### 6.5.6 The two edge cases — handle both gracefully

**Edge case A: user is FAST.** They tap Skip on personalization within 5s of landing. Then they go back to Messages. VM might still need 20-30s to finish configuring.

What they see in Messages: their original "hi" + Welcome 1+2+3, then silence. After ~20-30s of silence, M_RETURN arrives.

Is 20-30s of silence okay? **Yes.** The user is in their normal messaging app, doing other things. They're not staring at a progress bar. A message arriving 30s later feels like "the agent is ready" not "the agent was broken for 30s."

We do NOT send a "still setting up, one more moment" message. That would break immersion and plant doubt. The silence is the correct UX.

**Edge case B: user is SLOW.** They take 60s on /onboarding/done filling out the form thoughtfully. VM was ready at T+1:00 but user doesn't finish until T+1:30. M_RETURN dispatches at T+1:30 when the form submits.

What they see: form-submit success page ("you're all set, head back to messages"), they go back to Messages, M_RETURN is waiting. Perfect.

### 6.5.7 The five timing invariants

The implementation must guarantee these five properties. Any deviation is a UX defect.

1. **No silent waiting.** From the moment the user texts to the moment M_RETURN arrives, every second is either content (a message arriving, a page rendering) or active work (OAuth, typing card, filling form). The user is never staring at a blank screen counting seconds.

2. **VM provisioning starts at OAuth complete**, not at Stripe Checkout complete. The 30-60s of card-entry time is fully overlapped with configureOpenClaw.

3. **Welcome messages use variable gaps**: 2s between W1→W2 (dedication beat needs to land), 500ms between W2→W3 (short message + link).

4. **M_RETURN fires when BOTH conditions hold**: (a) VM has `gateway_url`, (b) the user has either submitted the personalization form OR is detected to have closed the tab. If user is still active on `/onboarding/done` when VM becomes ready, we wait until they submit. This avoids the agent's first message arriving while the user is still mid-flow on the web.

5. **No "still setting up" interim message.** Silence is the correct UX when the user is back in their messaging app waiting for M_RETURN. Breaking immersion with a placeholder is worse than the natural pause.

### 6.5.8 What gets implemented to enforce these invariants

| Concern | Implementation locus | Notes |
|---|---|---|
| Welcome burst variable gaps | `app/api/imessage/inbound/route.ts` (and Telegram equivalent) | Explicit setTimeout orchestration; do NOT use `sendImessageBurst`'s uniform-gap default. |
| VM assignment at OAuth complete | `app/(auth)/auth/page.tsx` post-OAuth callback OR `/api/auth/[...nextauth]/route.ts` signIn callback | Fires `assignOrProvisionUserVm` via `after()` so the user's redirect to /plan or /onboarding/done isn't blocked. |
| 10-min unassign reclaim | Extend `/api/cron/process-pending`'s reclaim Pass to also catch `(status='assigned' AND consumed_at IS NULL AND assigned_at < NOW() - 10min)` | One-line predicate change in the existing reclaim logic. |
| M_RETURN dispatch trigger | `/api/onboarding/done` (form submit) AND `/api/cron/m-return-sweep` (catches users who closed the tab without submitting) | Sweep cron runs every 1 min, picks up rows where `pending_users.consumed_at IS NOT NULL AND m_return_sent_at IS NULL AND vm.gateway_url IS NOT NULL`. |
| M_RETURN idempotency | `pending_users.m_return_sent_at TIMESTAMPTZ` (new column, follow-up migration) | Set on first successful M_RETURN. Cron + form-submit handlers both check before sending. |
| Real progress signals on /onboarding/done | Poll `/api/onboarding/status` which returns `{ stage: 'personalizing' | 'configuring' | 'ready' }` | `stage='ready'` when both VM and personalization are done. |

### 6.5.9 What we do NOT do

- **No fake spinners**: the `/onboarding/done` page does NOT show "Configuring your AI agent..." progress. The user is filling out a form; we don't need to perform progress. If they ask "is it ready?", the answer is in the page state itself (the form's submit button reflects readiness).
- **No "we're sending you the first message now" page**: when the user submits the personalization form, they see "you're all set, head back to messages" — not a status page that polls for M_RETURN to fire. The page is disposable; the agent will reach them.
- **No artificial delay** to make the experience feel "weighty": if the VM is ready in 30s, M_RETURN fires at 30s. We don't pad to make it feel like more work happened.

### 6.5.10 The reclaim path — abandonment recovery without silent cost leak

> The decision in §6.5.2 (provision at OAuth, not card-success) creates a window of time where a $29/mo Linode VM is allocated to a user who hasn't paid. If we get the reclaim wrong, we recreate the configure_failed-class silent cost leak — by design. This section closes that window.

#### The seven abandonment scenarios

Every place a user can abandon between OAuth-success and consumed_at-set. For each, the recovery path, the maximum cost exposure, and the time until reclaim.

| # | Scenario | State after abandon | Reclaim trigger | Max exposure |
|---|---|---|---|---|
| A | Tab close at /plan (no Checkout started) | pending: user_id set, consumed_at NULL, stripe_session_id NULL. VM: status=assigned, configured | Pass 6 (assigned_at < NOW-10min) | ~10-20 min ($0.013) |
| B | Stripe Checkout abandon mid-card-entry | pending: stripe_session_id set, consumed_at NULL. VM: configured. | Pass 6 | ~10-20 min ($0.013) |
| C | Browser crash before /plan loads | Same as A | Pass 6 | ~10-20 min ($0.013) |
| D | Return 2h later, new text to number | New webhook hit. Old pending row reclaimed already. user_channel_bindings empty. | N/A — old VM already reclaimed; new flow starts fresh. | $0 incremental |
| E | In-app browser kills session, tap link again | OAuth session lost; /auth replays. pending row has user_id; resume detected. | Resume, not reclaim. | $0 |
| F | Cloud-init VM at OAuth (pool empty) | VM mid-provision when user abandons. | Pass 6 catches it AFTER cloud-init-callback finishes (status=assigned). Until then, status=provisioning is invisible to Pass 6. | ~15-25 min ($0.017) |
| G | Edge partner: OAuth, no card, abandon /onboarding/done | VM assigned + configured; consumed_at NULL. | Pass 6 (same predicate; partner check NOT required) | ~10-20 min ($0.013) |

**Worst-case math at 1000 attendees over 5 days with 30% abandon rate**: 300 reclaims × $0.013 = **$3.90 total**. Negligible. The reclaim path makes the OAuth-trigger decision safe.

#### The new Pass 6 — extend `/api/cron/process-pending`

Per the existing Pass-numbered architecture, this lands as a new pass after Pass 5 (consumed cleanup). Renaming would risk Rule 23-class regressions; safer to add than to modify.

```typescript
// Pass 6: Reclaim abandoned-after-OAuth VMs.
// Catches: VMs assigned via the channel-onboarding OAuth-trigger flow
// (post-2026-05-26 redesign) where the user did not complete signup
// within 10 minutes. Without this, VMs stay in 'assigned but unpaid'
// limbo, billing $29/mo each forever.
//
// Distinguishing channel-onboarding rows from BYOB:
//   pending_users.channel IS NOT NULL → channel onboarding (this Pass)
//   pending_users.channel IS NULL     → BYOB Telegram (Pass 4 cleanup)
//
// The 10-minute timeout is generous (OAuth + card entry is typically
// 30-60s, max-case ~3 min). 10 min protects against slow users without
// holding VMs hostage.

const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

const { data: abandoned } = await supabase
  .from("instaclaw_pending_users")
  .select("*, instaclaw_vms!inner(id, name, ip_address, gateway_token)")
  .is("consumed_at", null)
  .not("channel", "is", null)       // channel-onboarding only
  .lt("created_at", tenMinutesAgo)   // pending row is at least 10 min old
  .limit(10);
```

Per row, the reclaim is atomic and race-safe:

```typescript
// 1. Atomic claim — compare-and-swap on consumed_at.
const { data: claimed } = await supabase
  .from("instaclaw_pending_users")
  .update({
    consumed_at: new Date().toISOString(),
    reclaimed_at: new Date().toISOString(),  // new column
  })
  .eq("id", pending.id)
  .is("consumed_at", null)  // only if still NULL — beats any /onboarding/done submit
  .select()
  .maybeSingle();

if (!claimed) {
  // Someone else won the race (e.g., /onboarding/done submitted at the
  // last second). Skip — the row is already consumed legitimately.
  continue;
}

// 2. We own the reclaim. Wipe + release the VM.
const vmRecord = await getVmById(pending.user_id);
if (vmRecord) {
  const wipeResult = await wipeVMForNextUser(vmRecord);
  if (!wipeResult.success) {
    // Wipe failed. Don't mark VM as ready — could leak data.
    // Alert ops, leave VM in 'assigned' state until manual review.
    logger.error("[pass-6] wipe failed; VM held for manual review", {
      vmId: vmRecord.id, error: wipeResult.error,
    });
    sendAdminAlertEmail(
      "[P1] Reclaim wipe failed",
      `VM ${vmRecord.name} (id=${vmRecord.id}) could not be wiped for reclaim. Manual review required.`,
    ).catch(() => {});
    continue;
  }

  // 3. Return VM to pool. Match Pass 2c's field-clearing surface so we
  //    don't leave per-user state on the row.
  await supabase
    .from("instaclaw_vms")
    .update({
      status: "ready",
      health_status: "healthy",
      assigned_to: null,
      assigned_at: null,
      gateway_url: null,
      gateway_token: null,
      configure_lock_at: null,
      configure_attempts: 0,
      telegram_bot_token: null,
      telegram_bot_username: null,
      telegram_chat_id: null,
      // Note: partner field cleared so the recycled VM doesn't carry
      // Edge identity into a non-Edge next-user.
      partner: null,
    })
    .eq("id", vmRecord.id);

  // 4. Reset onboarding flags on the user so they can re-try cleanly.
  await supabase
    .from("instaclaw_users")
    .update({
      onboarding_complete: false,
      deployment_lock_at: null,
    })
    .eq("id", pending.user_id);

  logger.info("[pass-6] reclaimed abandoned VM", {
    vmId: vmRecord.id, userId: pending.user_id,
    channel: pending.channel, ageMinutes: ...,
  });
}
```

#### The race-condition guard

Three writers can touch `pending_users.consumed_at`:
1. `/api/onboarding/done` submit handler (user finishes web flow)
2. `/api/cron/m-return-sweep` (closed-tab catch-up dispatcher)
3. Pass 6 reclaim (abandonment cleanup)

All three use the same compare-and-swap pattern: `UPDATE ... SET consumed_at=NOW() WHERE id=$id AND consumed_at IS NULL`. PostgreSQL guarantees row-level lock during the UPDATE. Whoever's UPDATE returns a row wins. The other two see 0 rows updated and abort.

This means: even if user submits at T=9:59 and cron starts SELECTing at T=10:00, the user's UPDATE lands first; cron's UPDATE matches 0 rows; cron skips that row.

#### What happens when the user comes back after reclaim

**iMessage path**: user texts again. Webhook lookup chain:
1. `user_channel_bindings` lookup → empty (never written — pending was never consumed by /onboarding/done's success path)
2. `pending_users` lookup by (channel, channel_identity) WHERE consumed_at IS NULL → empty (the reclaimed row has consumed_at IS NOT NULL now)
3. Falls through to "new user" path. Creates a fresh pending row + new short_code + new welcome burst.

**Net effect**: from the user's POV, they get the same first-time experience again. No "session expired" error, no stuck state. They sign up clean.

**Web path** (user with stale tab tries to submit /onboarding/done): the UPDATE consumed_at=NOW WHERE id=$id AND consumed_at IS NULL returns 0 rows. The handler detects this and redirects to /channels with a friendly "your session expired — let's start again" message.

**Telegram shared bot**: same as iMessage. The dedup chain finds nothing in-flight and treats them as new.

#### Why we don't DELETE the row

Per CLAUDE.md Rule 22 (never destructively modify user state without a recovery path), we mark the row as reclaimed (`reclaimed_at IS NOT NULL`) instead of deleting it. Three reasons:

1. **Audit trail.** Ops can query "how many users abandoned at /plan in the last 7 days?" to monitor funnel health.
2. **Forensics.** If a reclaimed user complains ("I signed up but never got my agent"), the row tells us when we reclaimed and what state existed at reclaim.
3. **Pass 5 already handles row cleanup.** Pass 5 deletes consumed rows older than 24h. Reclaimed rows are consumed (we set both `consumed_at` and `reclaimed_at`), so Pass 5 sweeps them on the same cadence.

#### Migration additions

Already added to the migration earlier in this session:
- `pending_users.reclaimed_at TIMESTAMPTZ` (new) — set alongside `consumed_at` when Pass 6 reclaims.
- `pending_users.m_return_sent_at TIMESTAMPTZ` (new) — orthogonal but related (M_RETURN dispatch idempotency).

#### Monitoring — defense in depth

Per Cooper's directive, alert if any VM stays in "assigned but unconsumed" state for > 15 minutes. This is a "Pass 6 is broken" alert, not a normal-operations signal.

New cron `/api/cron/reclaim-health` at `*/5 * * * *`:

```typescript
const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

const { data: stuck } = await supabase
  .from("instaclaw_pending_users")
  .select("id, user_id, channel, created_at, instaclaw_vms!inner(id, name)")
  .is("consumed_at", null)
  .not("channel", "is", null)
  .lt("created_at", fifteenMinutesAgo);

if (stuck && stuck.length > 0) {
  await sendAdminAlertEmail(
    "[P1] Reclaim health: stuck VMs detected",
    `${stuck.length} VM(s) in 'assigned but unconsumed' state for > 15 min.\n` +
    `Pass 6 should have caught these. Investigate /api/cron/process-pending.\n\n` +
    stuck.map(s => `  - vm=${s.instaclaw_vms.name} channel=${s.channel} stuck=${ageMinutes(s.created_at)}min`).join("\n"),
  );
}
```

6-hour dedup via `instaclaw_admin_alert_log` keyed by `reclaim-health-stuck` so we don't spam during incidents.

#### The cloud-init edge case (Scenario F)

If pool is empty when /auth fires `assignOrProvisionUserVm`, `createUserVM` (cloud-init path) kicks in. The VM is `status='provisioning'` while Linode boots (~3-5 min) and setup.sh runs (~2-5 min). During that window, the VM is invisible to Pass 6 (the predicate requires `assigned_at`, which only gets populated by cloud-init-callback).

After callback fires and `status='assigned'`, Pass 6 starts watching. If the user abandoned during the cloud-init wait, Pass 6 sees a fresh `assigned_at` from the callback and waits another 10 min before reclaiming. Total worst case: 5 min cloud-init + 10 min reclaim = 15 min from abandon to reclaim. Cost: $0.017. Still negligible.

After reclaim, the cloud-init VM is wiped and returned to pool. It's now a pool VM, indistinguishable from one provisioned via replenish-pool. Future signups use it the same way. We don't waste the cloud-init investment.

#### What this section enforces

| Property | Implementation |
|---|---|
| Cost exposure per abandon | Bounded to ~$0.017 max (15 min × $0.04/hr Linode) |
| Detection lag | Reclaim within 10-20 min of abandonment |
| Alert on broken reclaim | `/api/cron/reclaim-health` every 5 min, fires at 15-min threshold |
| Race safety | Compare-and-swap on `consumed_at IS NULL` for all three writers |
| Re-signup after reclaim | Fresh pending row with new short_code; same first-time UX |
| Forensic trail | `reclaimed_at` column preserves the abandonment timestamp |
| Audit log | Pass 5's 24h sweep removes the row after the forensic window closes |

---


The architecture is straightforward: webhook handlers per channel,
shared signup state, the existing dedicated-agent provisioning stack
unchanged. Four channels from day one (two live, two placeholder).

```
┌──────────────────────────────────────────────────────────────────┐
│ Channel-specific entry handlers                                    │
│                                                                     │
│  ┌─────────────┐  ┌──────────────────────┐  ┌─────────┐  ┌─────┐   │
│  │ iMessage    │  │ Telegram              │  │ Discord │  │Slack│   │
│  │             │  │                       │  │         │  │     │   │
│  │ Sendblue    │  │ - shared bot (new)    │  │ wait    │  │wait │   │
│  │ webhook +   │  │   webhook +           │  │ list    │  │list │   │
│  │ template    │  │   template response   │  │         │  │     │   │
│  │ response    │  │                       │  │         │  │     │   │
│  │             │  │ - BYOB (existing,     │  │         │  │     │   │
│  │             │  │   completely          │  │         │  │     │   │
│  │             │  │   unchanged)          │  │         │  │     │   │
│  └─────────────┘  └──────────────────────┘  └─────────┘  └─────┘   │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ Inbound webhook handlers (iMessage + Telegram shared bot)          │
│                                                                     │
│  /api/imessage/inbound (Sendblue):                                  │
│  1. Receive inbound text                                            │
│  2. Look up phone number in pending_users / channel_bindings       │
│  3. If new, create pending_users row, send templates               │
│  4. If bound, route to user's VM gateway via HTTP                  │
│                                                                     │
│  /api/telegram/shared-bot/inbound (Telegram shared bot, IDENTICAL pattern):    │
│  1. Receive inbound from Telegram webhook                          │
│  2. Look up chat_id in pending_users / channel_bindings            │
│  3. If new, create pending_users row, send templates               │
│  4. If bound, route to user's VM gateway via HTTP                  │
│                                                                     │
│ No LLM calls in either handler for new-user templates. Pure        │
│ webhook → template + short-code generation → link delivery.        │
│ For routing existing users, the handler is a thin HTTP proxy to    │
│ the user's VM gateway.                                              │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ /auth → OAuth → /plan → Stripe → /onboarding/done                  │
│                                                                     │
│  - /go/:code resolves to /auth with signup_session context         │
│  - OAuth (Google or ChatGPT) completion writes user_id,             │
│    binds phone_number, sets api_mode if ChatGPT                    │
│  - /plan captures card via Stripe Checkout, finalizes pending row  │
│  - /onboarding/done collects optional personalization              │
│  - Personalization writes to instaclaw_user_profile                │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ VM provisioning (existing infrastructure, UNCHANGED)               │
│                                                                     │
│  - createUserVM (pool or cloud-init)                               │
│  - configureOpenClaw reads instaclaw_user_profile + user row       │
│  - Personalization (name, intended_use, vibe) injected into USER.md │
│    and IDENTITY.md before agent's first read                       │
│  - VM provisions, agent boots, BOOTSTRAP.md drives first message   │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ M_RETURN trigger (post-VM-ready hook), channel-aware                │
│                                                                     │
│  Existing post-provisioning callback (today fires sendVMReadyEmail) │
│  is extended with channel-aware message routing:                    │
│                                                                     │
│  - iMessage user: send via Sendblue API to channel_identity         │
│    (the phone number)                                                │
│  - Telegram shared bot user: send via Telegram Bot API with         │
│    @myinstaclaw_bot's token to channel_identity (the chat_id)          │
│  - Telegram BYOB user: NO message sent from backend. The user's     │
│    VM polls its own bot and the bootstrap greeting fires inside     │
│    the existing dedicated-agent loop. Unchanged from today.         │
│                                                                     │
│  The channel is determined by reading the user's                    │
│  preferred_channel or the binding that was created during signup.   │
└──────────────────────────────────────────────────────────────────┘

**The VM gateway's role doesn't change for any of these.** It's HTTP-
accessible (existing). For iMessage and Telegram shared-bot users,
inbound messages arrive over HTTP from our backend webhook handlers
and the VM responds over HTTP. For Telegram BYOB users, the VM
polls Telegram with its own bot token and responds to Telegram
directly. Same agent, same skills, same memory, three transport
modes.
```

### Database surface

**Existing tables (unchanged where possible):**

- `instaclaw_users`: add one column, `preferred_channel ENUM('imessage','telegram','discord','slack')` with default null.
- `instaclaw_pending_users`: extend with three columns:
  - `channel ENUM('imessage','telegram','discord','slack')` default null
  - `short_code VARCHAR(8) UNIQUE` (the URL token in `instaclaw.io/go/XXXX`)
  - `channel_identity TEXT` (phone number for iMessage, telegram_user_id for Telegram)
- `instaclaw_vms`: unchanged.
- `instaclaw_subscriptions`: unchanged.

**New tables:**

- `instaclaw_user_profile`: user_id (FK), name, intended_use ENUM('work','personal','both'), vibe ENUM('just-get-things-done','chatty-and-warm','wry-and-minimal'), edge_intent (text, nullable, Edge attendees only), filled_at. Populated by the `/onboarding/done` form. Read by configureOpenClaw and injected into USER.md and IDENTITY.md.
- `instaclaw_user_channel_bindings`: user_id, channel, channel_identity. Many-to-many. Supports the future "connect another channel" feature.
- `instaclaw_waitlist`: email, requested_channel, created_at.

**What we explicitly do NOT change:**

- `instaclaw_pending_users` lifecycle is the same. Created when user enters signup, consumed when VM is ready.
- `configureOpenClaw` is the same function with three new optional fields in UserConfig (`personalization_name`, `personalization_intended_use`, `personalization_vibe`). Threaded through to the workspace file builders.
- The 6-pass cron rescue in `process-pending` is unchanged.
- Stripe checkout flow is unchanged.
- The OAuth flow (NextAuth + ChatGPT device-code) is unchanged structurally.

### iMessage webhook flow, end-to-end

1. **Inbound message** from a phone arrives at Sendblue's webhook.
2. **Sendblue posts** to `/api/imessage/inbound/route.ts` with the
   sender's phone number and message body.
3. **Backend**:
   - Look up phone number in `instaclaw_pending_users WHERE
     channel='imessage' AND channel_identity=<phone>`.
   - If found, this is an existing user mid-signup or post-signup.
     Route to user's VM gateway via existing channel-router.
   - If not found, this is a new signup. Generate a short_code,
     INSERT into pending_users with channel='imessage', short_code,
     channel_identity=phone.
4. **For new signups**, send Welcome Message 1 and Welcome Message 2
   via Sendblue API. Pure template, no LLM.
5. **The user taps the link**, lands on `/go/:code`, which looks up
   the pending_users row by short_code and redirects to `/auth` with
   the signup_session context.
6. **OAuth + plan + onboarding/done** flows happen on the web,
   updating the pending_users row.
7. **VM provisioning fires** when the pending_users row is finalized
   (existing trigger).
8. **VM ready** triggers the M_RETURN message send via Sendblue API to
   the same phone number, using the existing channel-router that
   today routes Telegram bot messages.

No LLM calls in steps 1-6. The first LLM call for any iMessage user
is the dedicated agent's bootstrap greeting after provisioning.

---

## 8. iMessage infrastructure, phased

The choice is between three classes of provider:

| Option | Bubble | Time to ship | Approval | Cost (1 line) | Spam risk |
|---|---|---|---|---|---|
| **Sendblue / Loop / Blooio** (Mac-as-server APIs) | Blue | 1-2 days | None | $39-100/mo | High initially |
| **Apple Messages for Business** (official) | Blue + logo + brand name | 4-8 weeks | Apple + MSP | per-message via MSP | None, verified sender |
| **Twilio SMS (long-code)** | **Green** | 1 day | None | $0.0079/msg | Low but green bubble breaks UX |

**Phase A, ships before Edge Esmeralda:**

- **Sendblue or similar.** Real blue bubble. Single line for launch.
- **One number** for the launch. Easy to monitor and rotate if flagged.
- **Spam mitigation**: vCard "Save InstaClaw to contacts" button on the
  QR modal + on Edge Esmeralda printed materials. We measure spam
  rate (compare Welcome 2 tap-rate to Welcome 2 send-rate) and react
  fast.

**Phase B, long-term, applied for in parallel with Phase A launch:**

- **Apple Messages for Business** registration starts the day this
  spec is approved. 4-8 weeks.
- Unlocks: brand name + logo in the chat ("InstaClaw" with our mark,
  no phone number visible), no spam filter, **Apple Pay sheets in the
  thread** (replaces Stripe Checkout link for the M_BILLING trial
  closer), rich interactive messages (lists, pickers, date pickers).
- Approval requires a human-escalation path. We satisfy this by
  shipping a `/help` command in iMessage that pages Cooper via email
  + a "talk to a human" button on the website.

---

## 9. Spam-filter avoidance, the existential question

What Cooper saw in his Zo screenshot (the reply landed in iOS's
"Unknown Senders" filter) is the user's own per-device opt-in filter
in Settings > Messages. It doesn't block messages, but it suppresses
notifications and segregates them into a separate tab. At scale this
kills the channel.

Three things to know:

1. The filter is per-user, opt-in. Not Apple's risk engine flagging
   us.
2. Apple's true cross-user anti-spam system only kicks in after many
   users actively report a sender.
3. The fix for both is becoming a known sender on the user's phone.
   Either (a) the user has us in contacts, or (b) the user has texted
   us first (one-way trust established).

**Mitigations in order of strength:**

1. **Make the user text us first, not the other way around.** This is
   already the design. They send "hi" first, our reply responds to
   them. iOS treats reply-to-my-text as trusted even from non-contacts.
2. **Save-contact step on the QR modal.** vCard download, one tap to
   add. Pre-empts the filter entirely.
3. **Apple Business Chat (Phase B).** Verified senders bypass the
   filter by design.
4. **No link in Welcome Message 1.** Reduces the heuristic that
   catches "first-contact + URL" as spammy. Welcome 1 is pure copy,
   the link arrives in Welcome 2 (right after the user has already
   engaged by sending "hi").
5. **Domain reputation.** Always link to `instaclaw.io`, never
   shortened third-party domains.
6. **Volume management.** Don't blast a single number at high volume.

**Measurement:** every Welcome 2 has a unique short-code. We compare
"Welcome 2 sent" to "tap" rates per number, per cohort, per
time-of-day. Tap rate below 50% on a single number is the spam
signal. Rotate or escalate.

---

## 10. Migration plan, phased rollout

### This week, before Edge Esmeralda (2026-05-30)

**Day 1 (today, 2026-05-26):** spec approval.

**Days 2-3 (May 27-28):** build sprint
- `/channels` page (channel selection, glass design + brand polish)
- `/auth` page (the two-doors OAuth screen described in §5.4, glass
  + coral accent + serif headlines, no shortcuts on design)
- `/plan` styling refresh to match `/auth`
- `/onboarding/done` page (the "head back to Messages" page with
  optional personalization form)
- **iMessage path:**
  - Sendblue integration (`lib/imessage-send.ts`)
  - `/api/imessage/inbound` webhook handler (templates for new
    users + HTTP-proxy routing for existing users)
- **Telegram shared bot path (parallel architecture):**
  - `@myinstaclaw_bot` already registered via BotFather (Cooper,
    2026-05-26).
  - Token stored as `TELEGRAM_SHARED_BOT_TOKEN` env var in Vercel.
    NEVER hardcoded.
  - One-shot bootstrap script
    (`scripts/_register-telegram-shared-bot-webhook.ts`) that calls
    Telegram `setWebhook` with our URL. Run once per environment at
    deploy time.
  - `/api/telegram/shared-bot/inbound` webhook handler (mirror
    iMessage handler's logic, just for Telegram chat_ids). Reads
    `TELEGRAM_SHARED_BOT_TOKEN` from `process.env` for outbound
    sends.
  - `lib/telegram-shared-send.ts` (Telegram Bot API wrapper for the
    shared bot, send messages by chat_id, reads env var).
- **Shared infrastructure both paths use:**
  - `/go/:code` short-link route
  - Channel-identity binding on OAuth callback (write
    `user_channel_bindings`, set `preferred_channel`)
  - M_RETURN trigger via channel-aware post-provisioning hook (knows
    whether to send via Sendblue, Telegram shared bot, or skip for
    BYOB users)
  - Edge entry context detection (`?src=edge` and `start=channels`
    param routing for both iMessage and Telegram)
- vCard endpoint + Save Contact button (iMessage path only)

**Day 4 (May 29):** stage on a preview deploy. End-to-end test on
Cooper's phone. Tune Welcome 1 and Welcome 2 copy. Verify the M_RETURN
voice continuity from templates to the real agent.

**Day 5 (May 30, Edge starts):** ship behind a feature flag. Edge
attendees scanning the new QR posters land in the iMessage flow.
Telegram-preferring attendees still get the existing flow.

### Weeks 1-4 post-Edge

- Measure: Welcome 2 tap rate, time-from-first-text to first-real-
  message, day-1 retention, day-6 trial-to-paid conversion.
- A/B Welcome 1 / Welcome 2 / M_RETURN copy variants.
- Apple Business Chat application submitted week 1.
- General-traffic rollout to `/channels` (off the dark-launch flag)
  once Edge numbers stabilize.

### Weeks 4-8 post-Edge

- Apple Business Chat approved (hoped-for timeline). Sendblue traffic
  migrates. Brand name + logo replaces phone number. Apple Pay sheets
  replace Stripe link in M_BILLING.

### Quarter 2

- **ChatGPT history import** built as an additive upgrade (the magic-
  moment feature deferred from v1).
- Discord and Slack real implementations.
- Dashboard "connect another channel" flow.

---

## 11. Edge Esmeralda, the physical surface

Four days. 1,000+ attendees. The proving ground.

What we ship for Edge:

1. **The poster.** Single A2 sheet, hung in high-traffic surfaces.
   Bottom 80% of the poster is a single huge QR code. Top has one
   line of copy and an illustration. Above the QR: "first, save this
   number to your contacts so my messages don't end up in your spam
   folder." Below the main QR: a smaller QR that's a vCard download.

2. **A pre-scan instruction.** The save-contacts step is critical.
   Even with one bypass we want both belt and suspenders.

3. **The iMessage flow above**, with Edge personalization. M_RETURN
   references the village.

4. **A fallback.** Printed below the QR for Android / broken-scanner
   cases: `instaclaw.io/edge`. Routes to
   `/channels?partner=edge_city`.

5. **A booth presence.** Cooper or designate near the poster Day 1 to
   watch reactions and catch UX cracks live. Superhuman's lesson:
   white-glove the first 100 onboardings even if the product is
   self-serve.

The poster headline: *"meet your AI agent."* Lowercase, period
included. The QR is the verb.

---

## 12. Risks and open questions

### Hard risks

- **Sendblue number flagged on Day 1 of Edge.** Mitigation: pre-warm
  the number with team's own iMessage threads for 3+ days before
  Edge. vCard Save Contact step on the poster. Failover number ready.
  Booth team monitoring tap rate live.
- **VM provisioning is slow (cloud-init path).** Welcome 1 says
  "about a minute." Pool path is 30-60 seconds. Cloud-init can be
  3-8 minutes. Mitigation: prefer pool for iMessage and Telegram
  shared-bot entries (existing flag); if pool empty, Welcome 1 copy
  varies to "couple minutes" (server-side conditional).
- **Card capture step drops users.** Reintroducing card capture
  before VM provisioning has a measurable drop-off cost. We accept
  this because (a) Stripe Checkout is universally understood and
  trusted UX, and (b) deferring billing to day 6 in the previous
  spec was a worse alternative for unit economics. Measure drop-off
  precisely; if it's worse than expected, consider a "trial without
  card" path for a subset of channels.
- **Apple Business Chat denies our application.** Mitigation: the
  `/help` to Cooper-email path satisfies the human-escalation
  requirement literally. We document this explicitly in the
  application.
- **`@myinstaclaw_bot` webhook delivery failures.** Telegram's
  webhook delivery is generally reliable but has occasional
  hiccups. Mitigation: webhook handler is idempotent on chat_id
  (re-sending Welcome 1 + 2 if delivery failed has no side
  effects), and Telegram retries failed webhook deliveries
  automatically for ~24 hours.
- **Telegram outbound rate limits.** Soft limit ~1 msg/sec per
  chat, ~30/sec across the bot. At Edge peak (estimated 100
  concurrent new users in a 10-minute window), we'd send ~200
  Welcome messages in 10 minutes (well under 30/sec). No issue
  at this scale. If we exceed in the future, apply for Telegram's
  higher-throughput tier (free, application-based).
- **VM gateway HTTP routing latency for shared-bot users.** For
  iMessage and Telegram shared-bot users, every inbound message
  is: Telegram/Sendblue → backend → VM gateway → backend →
  Telegram/Sendblue. Adds ~200-500ms over BYOB Telegram (which
  polls directly). User-perceived response time goes from ~2s to
  ~2.5s. Acceptable. If it becomes a problem, the VM could
  long-poll for messages from a backend queue instead.

### Open questions for Cooper

1. **Welcome 1 + Welcome 2 copy, the exact words.** Drafted in §6,
   variants in Appendix A. Which to ship?
2. **Card capture UX: integrate into `/onboarding/done` or keep as
   a separate `/plan` page?** Recommendation: separate `/plan` page
   (cleaner UX, trusted Stripe surface, surgical reuse of existing
   page). Confirm.
3. **Trial length with card upfront.** Today's Stripe trial is 3
   days (non-Edge), 28 days (Edge). For iMessage users with card
   upfront, what's right? Intuition: 7 days. Same as before.
4. **Agent naming.** Random short names (Pip, Riv, Olm) assigned at
   M_RETURN? Or generic ("your agent") with user-named via
   conversation? Or named at OAuth via a fourth personalization
   question? Recommendation: random short name assigned, user can
   rename in the conversation.
5. **The Edge channel default.** When `partner=edge_city` is
   detected, skip the `/channels` page entirely (straight to
   iMessage QR) or show the page with iMessage pre-highlighted?
6. **iMessage number area code.** (650) is SF/startup-tech. (415)
   is also SF. (929) is Brooklyn. What signal?
7. **vCard contents.** Just name and number, or also website field,
   photo, etc.?

### Explicit non-goals for v1

- Changing anything in the existing Telegram BotFather flow.
- Moving existing paying users to iMessage (they stay on Telegram
  forever unless they opt in).
- Shipping Discord or Slack actually working.
- Building a desktop or iOS app.
- ChatGPT conversation history import (deferred to Q2).

---

## 13. Recommendation

Approve the spec. Build the channel selection page, the auth page, the
plan/card step, the "you're in" page, the Sendblue integration, and
the M_RETURN trigger this week. Ship behind a feature flag. Point
Edge Esmeralda's QR codes at the new flow. Leave the existing
Telegram flow untouched.

Measure obsessively the first week. The single most consequential bet
in this spec is **the agent comes TO the user.** Welcome 1 and Welcome
2 set the bar that the v122 bootstrap greeting then has to clear. If
voice continuity holds across all three messages, we've made
something Zo and Clawputer didn't make: a real AI agent that shows up
in your iMessage thread already knowing your name.

That's not a feature difference. It's a product category difference.

---

## 14. The design quality bar

Cooper's directive: no corner cutting on UX/UI anywhere in this flow.
The agent is incredible. If the surfaces surrounding it look like a
hackathon project, we lose. Every screen, every transition, every
piece of copy has to match the quality of the thing being introduced.

### What "the bar" means concretely

Reference apps the team studies before building any screen:

- **Linear** for typography, spacing, the discipline of one primary
  action per screen
- **Cal.com** for post-OAuth confirmation patterns
- **Arc Browser (first-run)** for progressive reveal
- **Bunq (onboarding)** for card-based hierarchy where visual weight
  communicates priority
- **Stripe Checkout** for trust signals on the auth surface

The bar: a designer who uses those apps as their daily drivers opens
our flow and feels they're in the same tier. Not "close to." In it.

### Brand requirements, non-negotiable

- **Glass design system.** Frosted surfaces, gentle inner shadows,
  blurred backdrops. Already in the codebase.
- **Coral accent color**, `#E96F4D`, for primary actions only (the
  ChatGPT card, "Head back to Messages," send confirmations). Used
  sparingly so it always means "this is the action."
- **Cream / olive surfaces** (the Edge palette) for background depth.
  Background isn't pure white.
- **Display typography is serif** (the marketing hero typeface),
  matching "your home on the internet" energy. Not generic sans. Body
  type is the existing system font stack.
- **Lowercase headlines where the agent's voice goes there**
  ("you're almost in." with a period). Sentence-case body copy.
- **Motion is restrained.** No spinners. Buttons morph (color pulse,
  subtle scale) rather than disappearing and getting replaced.
- **Mobile-first, full bleed.** Every page works full-screen on iPhone
  12 mini without horizontal scroll.

### Screens that need the full treatment, priority order

1. **`/auth` (§5.4).** The single web surface in the iMessage flow.
   The ChatGPT card here is the moment of differentiation.
2. **`/channels` (§5.2).** The public face of the funnel.
3. **`/onboarding/done` (§5.6).** "Head back to Messages" CTA is the
   focal point. Optional personalization below the fold.
4. **`/plan` (§5.5).** Inheriting the same brand bar.
5. **The QR modal (§5.1).** Save Contact button, large QR, phone
   number visible. Modal with backdrop blur.

If a screen ships and doesn't meet the bar, we ship a v0 behind the
flag, hold beta traffic on it, iterate within the week. We don't
ship a mediocre design publicly and "improve it later."

---

## Appendix A, copy bank (single canonical voice, variants where A/B matters)

The canonical voice for every message in the onboarding is the v122
bootstrap voice. No marketing copy with personality on top. The agent
is the same voice through the templates and the real bootstrap
greeting.

### Welcome 1 variants (iMessage)

**A. Canonical (recommended):**
> Hey. Got your text. About to spin up your own AI agent. Takes about
> a minute, real computer behind it, real memory, real skills.

**B. Shorter:**
> Hey. Spinning up your own AI agent right now. About a minute. Real
> computer, real memory, real skills.

**C. With more personality:**
> Hey. Your AI agent is coming online. Takes about a minute. Not a
> chatbot, a real Linux computer with memory and skills.

### Welcome 1 variants (Telegram shared bot)

Same copy with one wording tweak: "Got your text" → "Got your
message" since Telegram isn't a text. Otherwise identical voice.

**A. Canonical (recommended):**
> Hey. Got your message. About to spin up your own AI agent. Takes
> about a minute, real computer behind it, real memory, real skills.

### Welcome 2 variants (iMessage)

**A. Canonical (recommended):**
> Tap here to finish setting up, then come back. I'll text you the
> second I'm ready.
>
> instaclaw.io/go/r7k2x

**B. More urgent:**
> Quick signup, ten seconds, then back here. I'll text you when I'm
> ready.
>
> instaclaw.io/go/r7k2x

**C. More casual:**
> Sign in real quick so I know who you are, then I'll text you when
> setup's done.
>
> instaclaw.io/go/r7k2x

### Welcome 2 variants (Telegram shared bot)

One wording tweak: "I'll text you" → "I'll message you here" since
Telegram is not a text. Otherwise identical voice.

**A. Canonical (recommended):**
> Tap here to finish setting up, then come back. I'll message you
> here the second I'm ready.
>
> instaclaw.io/go/r7k2x

### Edge poster headline variants

- *meet your AI agent.* (canonical)
- *an AI agent, in iMessage.*
- *your AI agent is one scan away.*
- *instaclaw is here.*

---

## Appendix B, explicit non-goals for v1

- Changing anything in the existing Telegram BotFather flow.
- Moving existing paying users to iMessage.
- Shipping Discord or Slack as functional integrations.
- Building a desktop or iOS app.
- ChatGPT conversation history import (deferred to Q2 as additive
  upgrade).
- Removing or modifying `configureOpenClaw` core logic.
- Multi-language support.
- Group chats with the agent.
- Agent customization UI beyond the personalization form.
