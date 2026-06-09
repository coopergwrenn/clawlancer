# Higgsfield Cloud API — Catalog & Capabilities Sweep (read-only, zero spend)

**Date:** 2026-06-08
**Scope:** documentation + SDK-source sweep to make sure we're not missing catalog/capabilities before building the guardrails + video-credit product. **No jobs, no spend.** Companion to `higgsfield-cost-calibration-2026-06-08.md` (measured cost) and `higgsfield-official-rail-2026-06-08.md` (architecture).

## TL;DR — do we have the full picture?
**Mostly, but not 100% — and the gap is honest:** the **complete model catalog + per-model credit pricing + rate-limit numbers are behind the authenticated dashboard** (`cloud.higgsfield.ai/models` returns 404 unauthenticated; docs say rate limits/pricing are "in your dashboard"). Public docs + the official SDK type definitions give a solid capability map and **confirm the DoP-duration behavior is by-design (not our bug)**. For a fully exhaustive catalog + cross-checkable pricing, **Cooper should export the Models Gallery list from the dashboard** — otherwise we build around the documented subset + measured numbers + a few flagged funded spot-tests.

---

## 1. Catalog — beyond what we measured

**Confirmed on the Cloud API (docs + SDK):**
- **Image (t2i):** `higgsfield-ai/soul/standard` (flagship), `reve/text-to-image` ("versatile"). *(SDK README's `bytedance/seedream/v4/text-to-image` 404s — bogus.)*
- **Image→video:** `higgsfield-ai/dop/{lite,turbo,standard}` (+ `*/first-last-frame`), `kling-video/v2.1/pro/image-to-video`, `bytedance/seedance/v1/pro/image-to-video`.
- **Speech→video (lip-sync / talking avatar):** `/v1/speak/higgsfield` (SDK-typed `SpeakVideoInput`) — input image + **WAV audio**, quality mid/high, **duration 5/10/15s**. A real untested capability.
- **Character training:** `createSoulId` (train a face-faithful character from reference images), `listSoulIds`, reuse via `custom_reference_id` in Soul t2i.
- **Marketing Studio** (branded ads) — SDK methods present.
- **"…and many more"** via the auth-gated **Models Gallery** ("100+ models" claimed).

**Reference lineup (AGENT rail — `github.com/higgsfield-ai/cli` MODELS.md, indicative of Higgsfield's full model family; confirm Cloud availability in the Gallery):** images — Nano Banana Pro, FLUX.2, GPT Image 2, Seedream 4.5, Grok Image, Z Image; video — Veo 3.1, Kling v3.0/2.6, Seedance 2.0/1.5, **Wan 2.7/2.6**, Minimax Hailuo, Grok Video, Cinematic Studio, Soul Cast, **Virality Predictor (`brain_activity`)**.

**Cheaper image than Soul?** Moot — **Soul (flagship) already measured at 1 credit = $0.0625**, i.e. at/near the billing floor. No meaningful cost win from a "cheaper" image model; images are effectively free regardless.
**Anything beating DoP-lite (2cr) on cost?** Unlikely — video > image, and 2cr is already the video floor we found. **Anything beating Kling on long+fast?** Unknown from docs (Seedance/Wan/Veo perf on Cloud unmeasured) — see §7.

---

## 2. Long clips — the product-gap answer

- **DoP cannot do long clips, BY DESIGN.** The SDK's `DoPImage2VideoInput` type has **no `duration` field at all** — model (lite/turbo/standard), prompt, input_images, motions, seed, enhance_prompt only. So our calibration finding (DoP ignores `duration`, outputs ~2s) is **confirmed by-design, not our bug**. DoP = short clips, full stop.
- **`/v1/speak/higgsfield` supports `duration: 5 | 10 | 15`** (SDK-typed) — so **lip-sync/talking-avatar video goes to 15s**. That's a documented long-form path, but it's speech-driven (needs a WAV), not general T2V/I2V.
- **General long-form video** (Kling/Seedance/Wan/Veo): the public docs show these only with minimal `{image_url, prompt}` bodies and don't document their max duration. The agent-rail schemas show the family supports it (Wan 2.6 up to **15s**, Seedance up to **12s**, Veo 3.1 up to **8s**, Kling 2.6 **5/10s**) — so the Cloud equivalents *likely* honor duration, but it's **not docs-confirmed**. **Our pending Kling #5 test (`duration:10`, badge length awaited) is the first empirical data point** for general long-form on Cloud. Broader confirmation = Gallery params or a funded test (§7).

**Bottom line:** today's confidently-offerable long-form = **Speak (≤15s lip-sync)**. General ≤10–15s T2V/I2V is *probable* via Kling/Seedance/Wan but needs the pending Kling read + a funded Seedance/Wan test before we promise "make me a 15s video."

---

## 3. Capabilities worth knowing (untouched in calibration)

- **Batch:** Soul `batch_size: 1 | 4` — multiple images per request (cost impact untested — see §7).
- **Resolution tiers:** images to **4K** (Nano Banana Pro/GPT Image 2/Marketing Studio per agent schema); Soul 720p/1080p; video 480p/720p/1080p. Higher res = more credits (untested deltas).
- **Aspect ratios:** per-model enums (1:1, 16:9, 9:16, 4:3, 3:4, 21:9, etc.) — covers TikTok/Reels 9:16 vs YouTube 16:9 natively.
- **DoP `motions`:** `getMotions()` returns a preset library of camera moves (zoom, etc.) you pass into DoP — a real "cinematic preset" UX lever.
- **Soul `style_id`:** `getSoulStyles()` preset styles (oil painting, etc.).
- **Soul-ID character:** train once, reuse a consistent face across generations — strong retention feature (PRD tier-2).
- **`first-last-frame` DoP variants:** interpolate between a start and end image — distinct feature, unevaluated.
- **Upload:** `uploadImage`/`upload` → CDN URL (for image→video / start frames). Confirms the image-input pipeline.
- **NOT confirmed on Cloud** (were Muapi/agent-rail features): standalone music/SFX audio gen, upscaling, face-swap, video-extend. Don't assume these exist on Cloud without checking the Gallery.

---

## 4. The things that bit us — what the docs actually say

| Issue | Doc verdict |
|---|---|
| **DoP ignores `duration`** | **By design** — SDK `DoPImage2VideoInput` has no duration field. Confirmed, not our bug. |
| **API coerces/bills bad params** (`duration:"xyz"` → charged) | **Undocumented.** No doc states coercion behavior. ⇒ behavior could change; **we must validate inputs pre-submit ourselves** (gate requirement stands, reinforced). |
| **Webhook payload** | Confirmed: image `{status,request_id,status_url,cancel_url,images:[{url}]}`; video `{…,video:{url}}`. |
| **Webhook signature** | **None documented** → our "don't trust body, re-fetch `/requests/{id}/status` with our key" design is correct. |
| **Webhook retries** | **Up to 2 HOURS, until your endpoint returns 2xx.** ⇒ our always-`200` ack is essential — without it we'd get a 2-hour retry storm (and possible duplicate deliveries). Keep the idempotency-on-request_id guard. |
| **Failed / NSFW / cancelled** | **Not charged / auto-refunded** (FAQ, verbatim). Confirms refund-on-fail design; never charge users for these. |
| **Rate limits** | **Not published** — "vary by plan + model usage, view in dashboard." Unknown for fleet sizing → must read from dashboard before fleet rollout. |
| **Per-model pricing** | **Not published anywhere public.** Our measured numbers are the only cost data we have. |
| **File retention** | Outputs kept **≥7 days** (so we should pull/store delivered media, not rely on Higgsfield URLs long-term). |

---

## 5. Cross-check vs our measured costs
No public per-model pricing exists to cross-check against — **our measured numbers are authoritative.** The one external anchor (WaveSpeed reselling the same DoP model) **matched our measurements**: lite $0.125 ✓, turbo $0.406 ✓. That independent agreement gives high confidence in the measured table. (Cooper can additionally cross-check per-model credits on the dashboard's Models Gallery if it lists them.)

---

## 6. Net for the build
- **Lite-default / turbo-hidden / standard-short / images-free** all hold and are now docs-consistent.
- **Long-form** is the real open gap: Speak (15s lip-sync) is the only docs-confirmed long path; general long-form rides on the pending Kling read + a Seedance/Wan funded test.
- **Guardrail spec unchanged and reinforced:** pre-submit input validation (coercion is undocumented), always-200 webhook ack (2-hour retries), idempotency on request_id (retries/dupes), refund-on-fail (auto-refunded upstream), read rate limits from dashboard before fleet.

---

## 7. Flagged for FUTURE funded spot-tests (DO NOT run now)
Each ≈ a few credits; run only when we deliberately expand scope:
1. **Seedance 1 Pro** (`bytedance/seedance/v1/pro/image-to-video`) — cost + time + does it honor `duration` for length? (the likely Kling alternative for long-form).
2. **Wan / Veo** on Cloud (if in Gallery) — long-form (Wan 15s) + premium quality (Veo) cost/time.
3. **Speak / lip-sync** (`/v1/speak/higgsfield`) — cost + quality of a talking-avatar at 5/10/15s (a distinct, demoable product feature).
4. **first-last-frame DoP** — interpolation cost/behavior.
5. **Soul-ID training** — one-time character-training cost.
6. **Batch** (Soul `batch_size:4`) — is it 4× or discounted?
7. **Resolution-tier deltas** — 720p vs 1080p vs 4K credit cost.
8. **Virality Predictor** (`brain_activity`, if on Cloud) — the uniquely-ownable "score my video" feature from the PRD; cost + whether it's on the Cloud rail at all.

---

## 8. What we still do NOT have (auth-gated)
- The **complete Cloud Models Gallery** (full model list + endpoint paths) — `cloud.higgsfield.ai/models` is login-gated.
- **Per-model credit pricing** table (dashboard).
- **Rate-limit / concurrency numbers** (dashboard, plan-dependent) — **needed before fleet rollout** to size queue/backoff.
- **Pending:** Kling #5 clip length (the long-form-on-Kling answer).

**Recommendation:** Cooper grabs the Models Gallery list + any per-model pricing + the rate-limit page from the dashboard (read-only, no spend) → then we have 100% of the picture. Until then, build around the documented subset + measured costs; the funded spot-tests in §7 fill specific gaps when scope expands.

---

## 9. Complete docs crawl (addendum — full tree from root)

Crawled the entire tree from `docs.higgsfield.ai/docs` (`llms.txt` + `llms-full.txt` + every page). **The public docs are exactly 8 pages** — `guides/{images,video}`, `help/{faq,support}`, `how-to/{introduction,sdk,webhooks}`, `index`. **No separate model pages, no endpoint reference beyond the 3 below, no public per-model pricing.** The full catalog/pricing/rate-limits being auth-gated is confirmed (by-design, not an oversight). New/refined vs the partial read above:

- **Full API surface = 3 endpoints only:** `POST platform.higgsfield.ai/{model_id}` (submit), `GET /requests/{id}/status`, `POST /requests/{id}/cancel`.
- **Cancel = queued-only** (202 Accepted; 400 otherwise). **Once `in_progress`, cancellation is impossible → spend is committed.** A real lever: we can abort a *queued* job (user changes mind / kill-switch trips) and get refunded, but not once it starts → **product:** cancel button on pending jobs; **guardrail:** auto-cancel queued jobs if the kill-switch fires.
- **Definitive status enum:** `queued`, `in_progress`, `nsfw`, `failed`, `completed`. **No `cancelled` status** — our webhook's "cancelled" branch is harmless dead-code; `nsfw` + `failed` are the refunded terminals (re-confirmed).
- **JS/TS SDK doc-staleness:** docs say the JS/TS SDK is **"Coming soon"** (only Python "supported") — **but `@higgsfield/client` v2 is published and our working proxy is built on it.** Docs lag reality; the JS SDK is live (proven by the canary). Don't trust the docs' "coming soon."
- **"voice and audio generation"** are named platform capabilities ("image, video, voice, and audio generation") — consistent with Speak/lip-sync + audio models living in the Gallery (not in the 8 docs pages).
- **File input limits (format/size) remain undocumented** — upload methods exist (`upload`, `upload_file`, `upload_image(format='jpeg')`) but no size/format constraints published. Still unknown; our 50MB cap is Telegram-side only.
- **Long-form: docs do NOT resolve it for general video.** DoP example shows `duration:5` (but the SDK type has no duration field → ignored), Kling/Seedance examples show **no duration**; the only duration-bearing typed endpoint is **Speak (5/10/15)**. The crawl **confirms** general long-form length is not answerable from public docs → pending Kling read + Gallery/funded tests (§7).

**Verdict: the complete crawl confirms our existing picture** (cost model + the four findings unchanged) and adds the 3-endpoint surface, the **cancel-while-queued** lever, the definitive status enum, and the JS-SDK doc-staleness flag. The catalog/pricing/limits gap is real and auth-gated — §8 recommendation stands.

*Read-only doc sweep + complete crawl, 2026-06-08. No jobs, no spend.*
