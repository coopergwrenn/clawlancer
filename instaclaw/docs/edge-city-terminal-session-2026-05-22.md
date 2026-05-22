# Edge City Terminal Session — 2026-05-22

Edge Esmeralda 2026 onboarding hardening session. 14 commits shipped to
production. Focus: launch blockers identified during a deep funnel audit,
then prioritized polish items. 8 days to launch with 1000 attendees at the
time of writing.

## Commits (chronological, oldest first)

All commits on main, all confirmed in production via Vercel auto-build
(latest Ready deployment created 14:08:29 EDT, 44s after the final
push). Three commits at the start of this session continued work
from the 2026-05-20 session (the Edge billing flow + idempotent cron
fix + audit pass on /api/billing/checkout); the rest were
self-contained 2026-05-22 work.

| SHA | Subject | What it does at the user level |
|---|---|---|
| `539b1b57` | feat(auth): ChatGPT as first-class sign-in alongside Google | New "Sign in with ChatGPT" button on /signin. OpenAI device-code OAuth creates an `instaclaw_users` row + establishes a NextAuth session via a new Credentials provider. Edge attendees can sign in with either Google or ChatGPT; both paths produce identical downstream state (partner tag, trial_end, VM provisioning). |
| `fe9f2195` | chore(db): promote `oauth_signup_flows` migration + add `ENABLE ROW LEVEL SECURITY` | DB migration for the session-less ChatGPT-signin flow moved from `pending_migrations/` to `migrations/` after Cooper applied to prod. Added `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` to the file so re-runs on fresh DBs (staging/recovery/local-seed) produce the correctly-protected table. |
| `1422c3f9` | chore(db): add ENABLE RLS to chatgpt_oauth migration file (device_flows audit) | Closes the same file/prod divergence on the 2026-05-19 `instaclaw_oauth_device_flows` table. Probe confirmed prod was already RLS-on (Studio prompt accepted at original apply); file now matches prod for replay safety. |
| `48f458d1` | docs(CLAUDE.md): add Rule 60 — migration files MUST be self-contained | Codifies the discipline: every `CREATE TABLE` migration in `instaclaw/supabase/migrations/` must include `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` in the same file. The Studio "Run and enable RLS" prompt is a safety net for one apply path; the file must protect all. |
| `e19edbf2` | fix(edge): F1 — replace "Free for verified ticket holders" with "Sponsor-funded through June 30" everywhere | Pre-fix, 5 surfaces claimed "free for verified ticket holders" — misleading post-trial-billing. New copy is accurate (trial really does end June 30) and feels premium (sponsorship framing > "free"). Live on /edge/claim banner + bottom strip + OG metadata, /signup Edge variant, EdgePartnerBanner used by /signup /plan /deploying, /edge-city legacy partner-portal page. |
| `01d50750` | fix(edge/dashboard): F2 — prominent "Open in Telegram" CTA on /edge/dashboard | Olive pill button + monospace `@<username>` below it, between hero and matches feed. Recovery surface for attendees who lose the bot deep-link (thread deletion, device switch, bookmark-only navigation). Renders only when `telegram_bot_username` is set; hidden in empty-state. |
| `4d45d01e` | fix(edge): F3 — universal support footer on every Edge funnel page | New `<SupportFooter />` component (single source of truth for `help@instaclaw.io`). Mounted on /edge/setup, /edge/intents, /edge/dashboard, /signin, /connect, /plan. Each mount inherits the parent's color so it drops in without per-page theming. Previously only /deploying had a support contact. |
| `074f3bd6` | fix(edge): F4 — EdgePartnerBanner on /signin closes the brand seam | After the prior routing change that sends /edge/setup → /signin, Edge attendees experienced a brand discontinuity (olive Edge palette → bare cream/orange /signin). Now /signin mounts the dark-olive EdgePartnerBanner above the centered content card. Non-Edge users see no difference (banner null when no partner cookie). |
| `e5f04d21` | fix(edge): W1 — em-dash sweep across the Edge funnel + aria-labels | 16+ user-facing em-dashes replaced (period for two-thought breaks, comma for dependent clauses, colon when introducing lists, en-dash for date ranges). 4 aria-labels also de-em-dashed (screen-reader audible). Drive-by: added SupportFooter to /edge/claim (missed it in F3). |
| `7c8b5420` | fix(auth): W5 — /signin redirects authenticated users to callbackUrl server-side | Refactored /signin from client-component into server-wrapped client. The server component calls `auth()`, sanitizes `?callbackUrl=` (rejects external URLs, protocol-relative URLs, self-referential `/signin` to prevent loops), and redirects authenticated users directly to the callback. Removes the "I clicked back and see the sign-in buttons again as if I'm not logged in" disorientation. |
| `72bf576e` | fix(edge/claim): P1 — proper verify button feedback (spinner) + fix latent inflight-ref leak | Two bugs in one commit. (1) Cooper-reported: zero visual feedback on Verify click → users double-tapped → EdgeOS rate-limited faster. Replaced subtle text-pulse with a rotating spinner SVG + "Verifying..." text. (2) Latent: `useRef` was referenced but never imported, and the synchronous in-flight guard never reset on error paths. The error-then-retry case would have silently locked out the button. Try/finally now releases the guard on every code path. |
| `aa96584d` | fix(plan): W2 — Edge-aware headline + body on /plan | "Choose Your Plan" → "Your plan." for Edge attendees. Body swapped from animated orange marketing copy ("An AI that never sleeps, never forgets...") to tight two-sentence framing ("Pro is selected and sponsor-funded through June 30. Cancel anytime."). Non-Edge users keep the existing marketing animation. |
| `29c5f668` | fix(deploying): W3 — Edge palette swap for the orange surfaces on /deploying | Three orange surfaces swapped to Edge-olive when `partner === "edge_city"`: top step-indicator orb (#3 "Deploy" active state), progress bar gradient, in-card active step orb. Same shapes/animations, only RGBs swap. Visual coherence with the Edge banner above. |
| `7414d29a` | fix(billing/checkout): Charlie #4 — Stripe back-button recovery | User-reported: back-button from Stripe checkout → "Deployment already in progress" 15-min wall, no recovery. Fix: before the lock check, list+expire any open Stripe checkout sessions for this customer, clear the `deployment_lock_at`, then proceed to create a fresh session. Safe from double-payment: an expired Stripe session cannot be paid. |

## What changed for Edge attendees at the user level

**The pitch / funnel:**
- /edge/claim trust-band, /signup Edge subtitle, /signup banner: all now say "Sponsor-funded through June 30" instead of the misleading "free for verified ticket holders."
- /edge/setup auth-choice line: "Sign in with Google or ChatGPT. Your pick." (period not em-dash).
- /edge/setup trust receipt: "First charge: June 30, 2026. Three days after the village ends." (period instead of em-dash).
- /signin h1: "Sign in" (was "Welcome Back"). Now serves first-time signups AND returning users.

**Auth:**
- Two equal-weight buttons on /signin: "Sign in with Google" + "Sign in with ChatGPT." Either creates an `instaclaw_users` row through identity resolution (`lib/openai-signup-db.ts:resolveSignupUser` for ChatGPT, `lib/auth.ts:signIn` callback for Google). Both honor the `edge_verified_email` HMAC-signed cookie and apply `partner=edge_city` identically.
- /signin shows the dark-olive EdgePartnerBanner when an Edge attendee arrives (closes the brand seam).
- /signin redirects already-authenticated users straight to their callbackUrl instead of showing the buttons again on back-button.

**Verify button (the first interactive surface):**
- Real spinner on click (was subtle opacity pulse).
- "Verifying..." text during request.
- Disabled state while in-flight.
- Synchronous in-flight ref + try/finally release guarantees no double-fire.
- Latent bug fixed: error → retry now actually works (previously silently dead-buttoned).

**Plan page:**
- Edge h1 "Your plan." with edge-ink color; body tight two-sentence framing.
- Non-Edge: animated marketing copy unchanged.

**Deploying page:**
- Top step orb, progress bar, in-card active orb all olive for Edge.
- Cloud-init "Carving out a server..." premium banner still ships per the other terminal's earlier commit. (A follow-up palette polish for THAT specific banner exists in the working tree as another terminal's WIP — see "Flags for future sessions" below.)

**Dashboard:**
- Prominent "Open in Telegram" pill on /edge/dashboard, between hero and matches feed.
- `@<username>` shown beneath the pill in monospace.
- Trial indicator (shipped 2026-05-20) continues to render: "Sponsor-funded trial ends June 30. Manage" with billing-portal redirect.

**Support / recovery:**
- "Need help? help@instaclaw.io" footer line on every Edge funnel page (was only on /deploying).

**Stripe back-button case:**
- Pre-fix: 15-min stuck wall.
- Post-fix: prior Stripe sessions auto-expired, lock cleared, user can create a fresh session with potentially-different plan tier.

## What's still on the audit backlog (deferred)

Items from the 2026-05-22 audit that did NOT ship this session:

- **W4** — /connect serif h1 ("Connect Your Bot") + serif body don't match the Edge sans-serif uppercase typography. Palette swap landed; typography swap deferred (would touch the underlying font stack and risks visual regression on the non-Edge variant).
- **W6** — "Back to /edge" footer link on every funnel page. Partially absorbed by F3 (SupportFooter exists everywhere now); the explicit "Back to /edge" link still missing on /signin /connect /plan /deploying for users who want to back out of the funnel.
- **W8** — `instaclaw_oauth_signup_flows` cleanup cron (the table's docstring promises one; doesn't exist yet). Low-impact (table grows slowly), worth adding pre-launch.
- **Concurrent-POST race on /api/billing/checkout** — pre-existing weakness in the deployment_lock check. Two simultaneous POSTs can both pass the lock check before either sets it. Today's Charlie #4 fix addresses the back-button case but doesn't make the lock atomic. A conditional UPDATE (`UPDATE ... WHERE deployment_lock_at IS NULL OR deployment_lock_at < now() - interval '15 minutes'`) would close this; not shipped yet.
- **Marketing-component em-dashes** — fixed in the onboarding funnel + 4 aria-labels. Remaining em-dashes in `app/edge/components/*` (nav, plaza-section, faq, etc.) and section-divider JSX comments throughout the codebase are out of scope for the audit's "onboarding funnel" framing. Worth a sweep before launch but not urgent.

## Flags for future sessions

**Other terminals' WIP currently in the working tree** (do not touch unless they're your work):

- `instaclaw/app/(onboarding)/deploying/page.tsx` — uncommitted W3 polish that adds an isEdge palette swap to the cloud-init banner (the "Carving out a server just for you" panel). The diff comment attributes this to "Edge terminal's `29c5f668`" — so a different terminal is extending my W3 work. Their commit when it lands will close one remaining orange surface on /deploying for cloud-init-path Edge attendees.
- `instaclaw/lib/workspace-templates-v2.ts` — uncommitted SOUL.md V2 routing-meta additions (model/reasoning routing guidance for agents). Not mine.
- `instaclaw/supabase/migrations/20260517000100_village_attendees_phase3_hybrid_overlay.sql` — pre-existing dirty since the start of this session. Not mine.

**Stashes** (all not mine; explicitly tagged "WIP-not-mine", "cross-terminal-changes-not-mine", or pre-existing from prior sessions). Left alone per Cooper's instruction.

**Auth verification status:**
- F1, F3, W1 verified LIVE via `curl` against instaclaw.io. "Sponsor-funded through June 30" rendered correctly on /edge/claim, support footer rendered on /signin, "Google or ChatGPT. Your pick." rendered on /edge/setup.
- F2, F4, W2, W3, Charlie #4, P1, W5 ship via the same auto-build pipeline; the Ready deployment that includes them was created 14:08:29 EDT (44s after the last push). Auth-gated or server-side surfaces, so visual verification requires a real Edge attendee session. Build success is the proof for those — type-check passed on every commit before push.

**Important known-but-deferred:**
- **P1 inflight-ref leak**: the `useRef` import was missing in claim-client.tsx pre-fix. This would have shipped if the type-checker hadn't been run since the synchronous guard's introduction. Worth a `grep -rn "useRef\(" app/ | grep -v "import.*useRef"` sweep to find other files that reference useRef without importing it. (One-line bash; would catch this class fleet-wide.)
- **TASK 9 dual-option personalization popup** (`8c9577bc`) and **TASK 4-sub extension stepTelegramBotDescription** (`60979082`) are by other terminals that share the Co-Authored-By tag. Their working interplay with the Edge funnel is intentional but worth a visual smoke-check at 390px and 1280px once they're ready.

## Session metrics

- Commits authored: 14 today + 3 from the prior 2026-05-20 session that continued into this one (`d78d48f0`, `5450513a`, `1541175f`).
- Total lines changed: ~2500 added, ~250 removed across 30+ files (heaviest commits: ChatGPT signin auth, Charlie #4 Stripe recovery, ChatGPTConnectModal extension).
- Type-check: clean on every commit before push.
- Migrations applied to prod: 1 (instaclaw_oauth_signup_flows).
- Rules added to CLAUDE.md: 1 (Rule 60).
- TODOs/FIXMEs left in code: 0.
- Live-verified deployments: F1, F3, W1 (curl-confirmed against instaclaw.io). Others trusted via Vercel Ready status.
