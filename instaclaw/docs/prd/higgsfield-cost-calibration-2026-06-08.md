# Higgsfield Cloud API — Measured Cost Calibration & Money Model

**Date:** 2026-06-08
**Method:** live generations through the official Higgsfield Cloud API, via our canary proxy (`app/api/gateway/higgsfield`) on **vm-050** (preview deploy, gateway-token auth), one at a time, measured by **balance delta** on the Higgsfield Cloud dashboard. Rate: **16 credits = $1 → $0.0625/credit**. Auto top-up OFF (500-credit hard cap during testing).
**Status:** ✅ all six cost points MEASURED. One qualitative cell open (Kling clip length). This doc is the **foundation for the guardrail build + the video-credit product** — do not let it evaporate.

> Companion to the architecture PRD `higgsfield-official-rail-2026-06-08.md`. That doc = how the rail works; this doc = what it costs and what we charge.

---

## (A) Measured cost table — every number real

| Capability | Model / endpoint | Credits | **$ (16/$1)** | Gen time (submit→deliver) | Output | request_id |
|---|---|---|---|---|---|---|
| Image (t2i) | `higgsfield-ai/soul/standard` (flagship, 720p) | **1** | **$0.0625** | <1 min | image | be853742 |
| Image→video | **`higgsfield-ai/dop/lite`** | **2** | **$0.125** | **3m15s** | short (~2–5s) | d61e3bac |
| Image→video | `higgsfield-ai/dop/turbo` | **6.5** | **$0.406** | 5m23s | short | f20cac70 |
| Image→video | `higgsfield-ai/dop/standard` | **9** | **$0.5625** | **1m47s – 6m22s** (highly variable) | short (~2s) | d2adde8d / 9f0ada5b / 935dfa01 |
| Image→video | **`kling-video/v2.1/pro/image-to-video`** | **15.68** | **$0.98** | **2m06s** | **length = PENDING badge read** | 4f40be27 |

**Cost spread: $0.0625 → $0.98 = ~16×.**
**Balance trail:** 500 → 491 (canary std 9) → 489 (lite 2) → 482.5 (turbo 6.5) → [2× preview validation-fail: 0] → 473.5 (std-10s 9) → 448.82 (probe-std 9 + Kling 15.68) → 447.82 (image 1). **Total matrix spend = 52.18 cr ≈ $3.26.**

### Notes on individual rows
- **DoP-standard time is wildly inconsistent** — three runs at 6m22s / 1m47s / 5m14s. Same tier, same params, 3.6× time variance. Not a dependable-latency tier.
- **DoP-standard ignores `duration`** — `duration:10` (req 9f0ada5b) produced a ~2s clip at the same flat 9cr as a 5s standard. So DoP duration is *not user-controllable* (see findings).
- **Kling = the fastest video tier (2m06s)** — faster than DoP-lite (3m15s) despite being the most expensive. Kling cost isolated cleanly (probe 935dfa01 = standard = 9cr confirmed; 24.68 combined − 9 = 15.68).
- **Image** measured on the *flagship* Soul model, so the absolute-cheapest image is **≤ $0.0625** — images are effectively free to us.

---

## The four product findings (LOCKED)

1. **DoP-lite is the default — on BOTH levers.** Cheapest ($0.125) *and* fastest (3m15s). Everything routes here unless the user asks for more.
2. **DoP-turbo is hidden (dominated).** 3.25× lite's cost *and slower* (5m23s) — buys nothing. Do not expose it as a user-facing choice.
3. **DoP-standard is short-only + slow/variable.** Top DoP quality tier, but ~2s output, ignores duration, 1m47s–6m22s latency. Premium-quality short clips only; not a default.
4. **Images are ~free** ($0.06). Can be generously included in plan allowances; near-zero cost risk.

### Plus three structural findings (fold into the build)
5. **DoP cannot do long clips.** `duration` is accepted-but-ignored (5 / 10 / even `"xyz"` all → ~2s). **Long clips (10–15s) must come from Kling/Seedance/Veo** — Kling is the candidate (length pending). "Make me a 15s video" is *not* offerable on DoP.
6. **The Higgsfield API silently COERCES bad params instead of rejecting them.** `duration:"xyz"` was accepted (HTTP 200) and **billed a job** — it did not 422. ⇒ **the pre-call gate MUST validate inputs before submit** (model-slug against the allowlist, `duration` type/range, `image_url` shape). We cannot rely on the API to reject malformed agent requests; a bad request = unintended spend.
7. **Billing is FRACTIONAL** (turbo = 6.5 cr). The charge math must carry fractional cost end-to-end and `ceil()` **only** at the final user-charge step — never round the cost itself.
   Also: **failed / nsfw / cancelled jobs are auto-refunded** by Higgsfield → never charge the user for them (release the hold).

---

## (B) Recomputed credit-weights on the measured costs

**Decision (reaffirmed by the 16× spread): meter video SEPARATELY from the daily text allowance.** A flat weight cannot span a $0.0625 image and a $0.98 Kling clip; and one premium clip would vaporize a Starter's 600/day text budget. Video draws from a dedicated balance.

**Model: a dedicated "video credit" ≈ $0.10 sold** (packs, never expire). `charge = ceil(higgsfield_credits × 1.15)` video-credits → margin ~1.6–2.4× on real cost:

| Model | our cost | charge (video-credits) | user pays | margin |
|---|---|---|---|---|
| Image | $0.0625 | 2 | $0.20 | 3.2× *(or simply free within allowance)* |
| **DoP-lite (default)** | $0.125 | **3** | **$0.30** | 2.4× |
| DoP-standard | $0.5625 | 11 | $1.10 | 2.0× |
| **Kling (premium)** | $0.98 | **19** | **$1.90** | 1.9× |

- **Free daily allowance** (cost-bounded, in DoP-lite-equivalents @ $0.125): Starter ~2/day (~$7.5/mo cost ≈ 15% of a $50 plan), Pro ~5/day (~$19/mo on $130), Power ~15/day (~$56/mo on $350). Images near-unlimited (≈free).
- Beyond allowance → video credits, **estimate-then-charge** (quote → hold → settle → refund-on-fail), fractional cost preserved.
- **Default = DoP-lite.** Premium (Kling/standard) is explicit opt-in with the price shown. Turbo not offered.

*(Alternative framing if we don't introduce a new currency: charge existing media credits at `M ≈ 15–19` — DoP-lite ≈ 45 media-cr, Kling ≈ 235 media-cr. Works, but the dedicated $0.10 video-credit reads far cleaner to users. Either preserves margin since the charge is pinned to measured cost × multiplier.)*

---

## Catalog corrections learned during calibration (save these — the docs/SDK are wrong in places)

- **DoP valid model slugs:** `lite`, `standard`, `turbo` (+ `*/first-last-frame` variants). **There is no `preview`** (WaveSpeed/marketing naming artifact).
- **DoP / Kling request shape:** path-style endpoint + **flat** body `{ image_url, prompt, duration }`. NOT `/v1/image2video/dop` and NOT `{params:{…}}` or `{model, input_images}` (those 422).
- **Image endpoints:** `higgsfield-ai/soul/standard` (flagship), `reve/text-to-image` (+ Models Gallery at cloud.higgsfield.ai). **The SDK README's `bytedance/seedream/v4/text-to-image` path 404s** — bogus on the live API.
- **`first-last-frame` DoP variants** exist (start+end-frame interpolation) — unevaluated; possible future feature.

---

## Open / next

- **Kling clip length (PENDING):** the ~5:08 PM clip badge. **~10s** → Kling locked as premium tier ($0.98 buys length + speed, the long-clip path DoP can't do). **~2s** → skip/deprioritize Kling, DoP-lite stays sole default. *(Fill this cell, then Kling's verdict is final.)*
- Feeds: **(C) guardrail build** (pre-call credit gate + input validation + per-VM cap + fleet kill switch + low-balance alert) and the **video-credit product** (dedicated credit, packs, daily allowance, estimate-then-charge, /studio surface).
- Cheapest-absolute image (if ever needed) is in the Models Gallery; flagship Soul at $0.0625 is the upper bound, so not urgent.

*Measured 2026-06-08 via vm-050 canary on the official Higgsfield Cloud API. Total calibration spend ≈ $3.26 of the $30 funded.*
