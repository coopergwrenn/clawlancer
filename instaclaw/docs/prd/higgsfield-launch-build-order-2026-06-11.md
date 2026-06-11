# Consolidated Build Order — Higgsfield Official Rail → Fleet Launch

**Date:** 2026-06-11 · **Branch:** `worktree-higgsfield-official-rail` · **Author:** higgsfield-skill terminal
**Status:** RATIFIED build order. Prices + quality fixes locked by Cooper. This is the artifact a build terminal executes. Nothing here is shipped to the fleet yet; the fleet-flip is the final gate (§8).

> One-liner: ship cinematic t2v video to every InstaClaw agent — verbatim-prompt quality, clip-priced packs ("videos from 99¢"), free first taste, on a central key that never runs dry.

---

## 0. Already done (on branch, NOT fleet)

- Gate (`app/api/gateway/higgsfield/route.ts`) + webhook + billing RPCs (reserve/settle/release/claim_delivery) — canary, behind `HIGGSFIELD_GATE_ENABLED`.
- t2v/i2v ladder wired by input (`resolve_model`, commit `967ced02`).
- Telegram delivery dims fix (`lib/telegram.ts` `parseMp4Dimensions` + explicit w/h/duration/supports_streaming) — shipped on branch; widescreen confirmed.
- Quality investigation CLOSED (see §1 for the proven fixes).
- Skill (`higgsfield-cloud`) deployed to vm-050 ONLY. Fleet rollout = §8.

---

## 1. Quality fixes — the 4, evidence-proven (SKILL.md + MEMORY.md; NO gate change)

All four proven by live testing + DB/ffprobe ground truth (dose-response: raw=perfect → +1 clause=slightly slow → detail=slower → style=fully slow; agent uses image-first + `--quality fast` almost always).

- **(a) Hard t2v directive** (Rule-28 strength) in `skills/higgsfield-cloud/SKILL.md`: text-only video request → submit `--kind video` with NO `--image-url`, **never generate an image first**. Image-first produces a 4:3 i2v clip, not cinematic t2v.
- **(b) MEMORY.md correction** on vm-050 (and any fleet VM with the pattern): remove the entries reinforcing "generate a source image then animate" (Rule 22/29 — correct, don't wipe).
- **(c) VERBATIM-ONLY prompts** in SKILL.md: the agent passes the user's request to t2v **unmodified** — no motion clause, no realism word, no additions of any kind. Intent fidelity, not authorship. **Banned-style fence** (hard): `cinematic, cinematic slow motion, film look, 35mm, anamorphic, depth of field, moody, atmospheric, golden hour, slow, graceful, elegant, deliberate, epic, art-film`. Self-handles aesthetics: a user who wants slow-mo/cinematic says so in their own words → passes through verbatim.
- **(d) Never-default-`fast`** in SKILL.md: open-ended / "surprise me" / unspecified-quality → cinematic premium (t2v), NOT `--quality fast`/dop-lite. `--quality fast` only on explicit "quick/draft" asks or the free fallback.

**Estimate:** S (SKILL.md rewrite + 1 MEMORY.md edit). No code, no migration. Test on vm-050 with the exact prod prompt before merge.

---

## 2. COGS correction (proven)

Registry over-states kling at 15cr; the real cost reconciled to your June dashboard (171 cr) exactly = **13 cr/render**.

- `lib/higgsfield-models.ts`: set `hfCostCredits: 13` on all four kling entries (t2v, v3.0-i2v, v2.6, v2.1). soul=1, dop-lite=2 unchanged (measured).
- **Estimate:** XS.

---

## 3. Pricing / purchase path — the money build

### 3.1 Locked prices (sell as CLIPS, not abstract credits)

COGS basis: plan at **6.25¢/cr** (real best = 6.0¢ via 500-packs; 6.25¢ is the safety margin). Kling clip COGS = 13 × $0.0625 = **$0.8125**.

| Pack (slug) | User pays | Premium clips | $/clip | COGS | Margin | Margin @ HF+25% |
|---|---|---|---|---|---|---|
| **Taste** (`video_taste`) | **$3.99** | 4 | $0.99 | $3.25 | $0.74 (18.5%) | **−1.8% (loss-leader anchor — acceptable, $4 absolute)** |
| **Creator** (`video_creator`) | **$14.99** | 12 | $1.25 | $9.75 | $5.24 (35%) | 18.7% |
| **Studio** (`video_studio`) | **$39.99** | 32 | $1.25 | $26.00 | $13.99 (35%) | 18.7% |

- Headline: **"videos from 99¢."** The $0.99/clip rate exists ONLY on Taste.
- **STANDING RULE: no other pack or promo below $1.25/clip without re-running the HF+25% stress math.** (At $1.25/clip the catalog holds 18.7% even if Higgsfield raises 25%; below it, the catalog goes underwater on a price hike.)
- Upside if the 6.0¢ rate holds: Creator/Studio margins rise to ~37.6%.

### 3.2 Stripe price IDs to CREATE (Cooper, in Stripe dashboard)

Create 3 one-time prices, then add the IDs to Vercel env (all 3 environments, `printf` not `<<<` — Rule 6):

| Env var | Product | Amount |
|---|---|---|
| `STRIPE_PRICE_VIDEO_TASTE` | "4 premium videos" | $3.99 |
| `STRIPE_PRICE_VIDEO_CREATOR` | "12 premium videos" | $14.99 |
| `STRIPE_PRICE_VIDEO_STUDIO` | "32 premium videos" | $39.99 |

### 3.3 Migration (Rule 56 — stage in `pending_migrations/`, apply to prod, THEN `git mv` to `migrations/`)

`video_credit_balance` column already exists. Add:
- `instaclaw_add_video_credits(p_vm_id, p_credits, p_ref)` RPC — clone of `instaclaw_add_credits`; increments `video_credit_balance`, writes a ledger row with source `video_topup`. (This is the ONLY increment path — today the column is decrement-only.)
- Ledger source enum/values: `video_topup`, `video_settle` (debit), `video_refund` (already effectively the release), `video_free_seed` (free taste).
- Migration must `ENABLE ROW LEVEL SECURITY` on any new table (Rule 60).

### 3.4 Code

- `app/api/billing/credit-pack/route.ts`: add the 3 packs to `CREDIT_PACKS` with `target: "video"` and the clip→credit mapping. Extend the `target` union to include `"video"`.
- `app/api/billing/webhook/route.ts` `handleCreditPackPurchase`: route `target === "video"` → `instaclaw_add_video_credits`. Idempotency via the existing `instaclaw_credit_purchases` UNIQUE(payment_intent).
- Internal metering: 1 premium clip = a fixed credit unit. **Drop the inherited 1.15 `VIDEO_MARGIN` multiplier** — the margin lives in the pack price now, not the metering. Set 1 clip = 13 vc (or define 1 clip = 1 "premium render unit"; pick the cleaner of the two during build).
- Reconcile the gate denial copy: now that a top-up path EXISTS, `insufficient_credits` → "You're out of video credits — grab a pack to keep creating" + the Studio/Creator link is CORRECT (previously contradictory). Update `denialResponse` + SKILL.md free-allowance copy together.

**Estimate:** M (migration + RPC + 2 route edits + copy). Failure-mode test per Rule 31: purchase → webhook → balance increments → render settles against it.

---

## 4. Free taste

- **Seed 1 free premium t2v clip per new user, triggered on their FIRST VIDEO REQUEST** (not at signup — spends only on engaged users; ~3× cheaper).
- Mechanism: a per-user `video_free_seed_used` flag; on first `?action=create` for a kling t2v with the flag unset, the reserve treats this ONE render as free (charges 0, `is_free=true`, sets the flag).
- COGS: $0.8125 per seeded clip.
- **Breakeven (FLAG — instrument day one):** payback requires conversion to **Creator/Studio** (15.5% / 5.8% breakeven). A free-taste user who converts ONLY to the **Taste** pack is a **net loss** (Taste margin $0.74 < seeded-clip COGS $0.8125). Track the taste→creator/studio progression; if tasters stall at the Taste pack, revisit the seed policy or the Taste margin.
- Sizing (signups proven from DB: ~10/day recent, 79/day 30-day-avg incl. Edge spike): ~$73/mo at 1×, ~$731/mo at 10×, assuming ~30% of signups try video.

**Estimate:** S (one flag + one branch in the reserve path).

---

## 5. Central-account ops — LAUNCH BLOCKER

Current central HF balance = **134 cr = ~10 premium renders = $8.38**. At any fleet scale this dies in minutes.

- **Auto-top-up (Cooper enables on Higgsfield — currently DISABLED, hard gate):** trigger when balance < **2,000 cr** (~154 renders / ~$125); top up to ceiling **~8,000 cr** (~615 renders / ~$500) so it doesn't re-fire during a launch spike.
- **Our-side backstop cron (BUILD):** `app/api/cron/higgsfield-balance-check` — P0-alert when central balance < **1,000 cr** (~77 renders). Mirror the Rule-67 Anthropic-balance pattern (`sendAdminAlertEmail` + `instaclaw_admin_alert_log` 6h dedup). Register in `vercel.json`. Add `maxDuration` if it calls the HF API (Rule 11).
- **OPEN DEPENDENCY:** does the Higgsfield API expose account balance? If yes, the cron reads it directly. If no, infer from render-rate since last known top-up (less precise — flag in the cron's comment). **Cooper: confirm on the API/dashboard trip.**

**Estimate:** S–M (cron + alert; +S if balance must be inferred rather than read).

---

## 6. i2v Telegram-photo upload (the #3 gap — non-Muapi)

The i2v free path (and the frontier-grade real-photo path) currently depends on the LEGACY `higgsfield-video` skill's uploader, which targets the deprecated **Muapi CDN**. The `higgsfield-cloud` SKILL.md documents no upload step → the agent leaked "Need to upload the image to get a public URL first" before improvising.

- **Build a gate `?action=upload`:** agent posts the Telegram `file_id`; gate fetches via the VM's bot token (server-side), stores to **Supabase Storage** (public bucket) or **Vercel Blob**, returns the public URL for `--image-url`. On our rail, off Muapi.
- Add the upload step to `higgsfield-cloud` SKILL.md (silent — never narrate "get a public URL" to the user).
- Middleware allow-list the new route (Rule 13); `maxDuration` (Rule 11).

**Estimate:** M (upload endpoint + storage wiring + SKILL.md step).

---

## 7. Compliance checklist for the new routes (do NOT skip)

- **Rule 13:** add `/api/gateway/higgsfield/upload` (and any new public/self-auth route) to `middleware.ts` `selfAuthAPIs`. Probe with curl post-deploy — must not return `Unauthorized`.
- **Rule 11:** `export const maxDuration = 300` on every new route that calls HF/Stripe/Supabase-heavy paths.
- **Rule 60:** `ENABLE ROW LEVEL SECURITY` in the same migration that creates any new table.
- **Rule 56:** new migrations live in `pending_migrations/` until applied to prod, then `git mv` to `migrations/` (the build pipeline gate refuses otherwise).
- **Rule 31:** each feature ships a failure-mode test (purchase-webhook-race, free-seed double-fire, balance-at-zero mid-render).

---

## 8. Fleet-flip gate (G9) — the final rollout, Cooper-approved (Rule 64)

The flip from canary→fleet requires ALL of:

1. **Quality fixes (§1) merged + verified on vm-050** with the exact prod prompt.
2. **Purchase path (§3) live + smoke-tested** end-to-end on a real Stripe test purchase → balance → render.
3. **Auto-top-up ENABLED + balance-alert cron live (§5).** Do NOT flip with 10 renders of runway.
4. **Skill added to `skillsFromRepo`** (this is what deploys `higgsfield-cloud` fleet-wide) + manifest version bump + snapshot bake at the new version.
5. **`HIGGSFIELD_GATE_ENABLED=true` on prod** (verify — it's sensitive-typed; confirm at runtime, not via pull).
6. **Per Rule 64:** explicit Cooper "ship to fleet" after the vm-050 verification, in-session.

Roll via reconciler waves (Rule: concurrency ≤ 3); the skill is the deploy unit. The free taste + the "from 99¢" headline are the launch's viral surface — coordinate with the copy playbook (Rule 55) for the announcement.

---

## 8b. PRIORITY FOLLOW-UP — fork (b): in-chat checkout link (its own session, full ceremony)

**Ruled 2026-06-11:** fork (a) shipped (the 3 video packs on `/billing/credit-packs` +
`/dashboard/credits` via the existing `handleBuy` → `/api/billing/credit-pack` flow);
**(b) deferred deliberately** — not because it's wrong ("it's the right product and the
conversion-dies-on-a-login-wall read is correct") but because a new money-adjacent
purchase surface deserves full ceremony, not a same-night rush.

**What (b) is:** a gate action (`?action=buy&pack=video_taste`) that creates the Stripe
Checkout session server-side from the VM's gateway token and returns the URL; the agent
drops it in chat at the upsell moment. The user never leaves Telegram.

**Risk-shape notes (preserved from the fork presentation):**
- New purchase-initiation surface authed by **gateway token** (not session). A stolen
  token could spam checkout-link creation — payment still flows through Stripe to OUR
  account and links are VM-bound, so the abuse is annoyance-shaped, not theft-shaped,
  but it needs rate-limiting + the Rule-13 middleware decision made deliberately.
- Requires server-side VM → user → Stripe-customer mapping in the gate (today that
  mapping lives in the session-authed billing route).
- Checkout `success_url`/`cancel_url` UX from a chat context needs design (the user
  lands in a browser mid-conversation).

**The data gate:** `scripts/_coverage-video-funnel.ts` measures exactly what the login
wall costs (seed → pack conversion with (a) as the only path). Build (b) off that
number, not instinct. If conversion is healthy with (a), (b) may not be worth the
surface; if tasters stall at the wall, (b) jumps the queue.

## 9. Ops note — negotiate volume pricing with Higgsfield (post-launch, at scale)

The top-up form's **flat 16cr=$1 (6.0¢ best via 500-packs) is a RETAIL CEILING, not a wall.** At fleet scale (hundreds–thousands of premium renders/day), reach out to Higgsfield directly for **negotiated wholesale**. Every cent off the credit rate drops straight to margin: at 5.0¢/cr the kling clip COGS falls $0.8125 → $0.65, lifting Creator/Studio from 35% → ~48%. Owner: Cooper, once daily render volume justifies the conversation.

---

## Effort summary

| Section | Estimate |
|---|---|
| §1 Quality fixes (SKILL/MEMORY) | S |
| §2 COGS correction | XS |
| §3 Pricing / purchase path | M |
| §4 Free taste | S |
| §5 Central-account ops (cron + alert) | S–M |
| §6 i2v photo upload | M |
| §7 Compliance | (woven into each) |
| §8 Fleet flip + snapshot bake | M |

**Critical path to launch:** §5 auto-top-up (ops, Cooper) and §3 purchase path are the two hard gates — without them the launch either runs dry mid-render or has no way for the 999/1000 zero-credit users to pay. §1 quality fixes are independent and can land first (they improve the canary immediately).

### Proven vs assumed (carried from the pricing model)
- **PROVEN:** $0.0625/cr; 13cr/$0.8125 per kling clip (reconciled to 171 exactly); soul/dop-lite COGS; signup rates; central balance runway; flat wholesale (no volume discount, per Cooper's top-up-flow check).
- **ASSUMED (instrument):** free-taste conversion rate (~15–20% to Creator/Studio breakeven); ~30% of signups try video; whether the HF API exposes balance for §5's cron.
