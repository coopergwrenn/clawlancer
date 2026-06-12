# Higgsfield Allowlist Expansion — Research & Recommendation (read-only, zero spend)

**Date:** 2026-06-09 · **No spend, no code, no real generation.** Companion to
the calibration (measured costs), catalog sweep (capabilities), and guardrails
spec. This answers: *which currently-excluded Cloud models are worth measuring
next, and what do we already know about their cost shape before we spend?*

The gate today allows only MEASURED-cost models — `soul/standard`,
`dop/{lite,turbo,standard}`, `kling`. Excluded (cost never measured):
**seedance, veo, reve, speak, dop-first-last-frame**. The gate must never bill a
job whose cost it's guessing, so expanding the allowlist = measuring these.

---

## 0. Method + the validated pricing anchor (this is what makes the reads trustworthy)

The excluded models are mostly **third-party models Higgsfield resells**
(Seedance=ByteDance, Veo=Google, Reve=Reve AI), so their pricing on other
aggregators (fal.ai) is public. The question is whether Higgsfield's credit
cost tracks that public $. **It does** — the anchor is now validated on THREE
independent models:

| Model | fal.ai public $ | our MEASURED Higgsfield | credits × $0.0625 | match? |
|---|---|---|---|---|
| DoP-lite | $0.125 (WaveSpeed resale) | 2 cr | $0.125 | ✅ exact |
| DoP-turbo | $0.406 (WaveSpeed) | 6.5 cr | $0.406 | ✅ exact |
| **Kling 2.1 Pro** | **$0.98 = fal's 10s price** ($0.49/5s + 5×$0.098) | **15.68 cr** | **$0.98** | ✅ exact |

**Anchor: `Higgsfield credits ≈ fal $ ÷ $0.0625` (= fal $ × 16).** Holds for
Higgsfield's own model (DoP) AND a third-party model (Kling). High confidence
for pre-spend cost reads below.

> **Bonus finding (free to confirm):** the Kling match lands on fal's **10-second**
> price, not 5s. That strongly implies **Higgsfield's Kling default clip is ~10s** —
> which (a) likely resolves the long-pending "Kling clip length" question and
> (b) means we may **already have a ~10s long-form path** in the allowlist. Cooper
> can confirm for free by reading the badge on the existing Kling clip (req 4f40be27).

### The deeper structural insight: Higgsfield PINS cost-driving params → most models are FLAT *from our side*

The "flat vs variable" question Cooper asked isn't about the underlying model —
it's about **what Higgsfield's Cloud wrapper exposes.** DoP proves the pattern:
the underlying tech has a duration concept, but Higgsfield's `DoPImage2VideoInput`
SDK type **has no `duration` field at all** — Higgsfield pinned it, so DoP is
flat for us (one constant). The SDK's typed `EndpointInputMap` exposes only THREE
blessed endpoints, and they tell us exactly which knobs are exposed:

| SDK-typed endpoint | cost-driving params EXPOSED | ⇒ cost shape from our side |
|---|---|---|
| `/v1/image2video/dop` | none (no duration) | **FLAT** (1 constant per tier) ✓ confirmed |
| `/v1/text2image/soul` | `batch_size 1\|4`, `quality 720p\|1080p` | small matrix (≤4 cells) |
| `/v1/speak/higgsfield` | `duration 5\|10\|15`, `quality mid\|high` | **discrete matrix (≤6 cells)** |

Kling/Seedance/Veo/Reve are reachable via path-style slugs (`subscribe<string>`)
but are **un-typed** in the SDK — their exposed params are auth-gated (Gallery).
Their cost shape from our side is the key open question per model below. There is
no free SDK schema endpoint in v0.2.1 (checked — `validateInputAgainstSchema`
exists but no bundled/fetchable schema), so the exposed-param question for these
is answered only by the Gallery or a spot-measurement.

---

## 1. Per-model deep dive (the 5 excluded models)

### A. Seedance 1 Pro — `bytedance/seedance/v1/pro/image-to-video`  ⭐ pivotal
- **Slug:** confirmed (sweep + fal mirror); Cloud-reachable via path-slug, un-typed.
- **Underlying (fal):** token cost `(h×w×fps×dur)/1024`, Pro $2.5/1M tok → **5s 1080p ≈ $0.62**; lite 720p ≈ $0.18/5s. Durations 2–12s. Genuinely **variable** upstream.
- **Cost shape from our side — THE open question:** does Higgsfield expose `duration`/`resolution`, or pin them like DoP? Seedance's *entire value* is longer clips, so it's more likely than DoP to expose duration → a **cost function** (probably a small discrete set, 5s/10s, like Kling — not continuous).
- **Predicted credit cost (anchor):** ~**10 cr @ 5s/1080p** ($0.62×16), ~**3 cr** if pinned 720p, ~**19 cr** if it does ~10s. Range driven entirely by the pin question.
- **Product value:** **HIGH** — the long-form gap-filler (up to 12s, possibly cheaper or longer than Kling; different aesthetic). The single most product-moving add *if* Kling-at-10s isn't enough.
- **Open cost-questions:** (1) is `duration` a param? (2) is `resolution` a param? (3) cost at 5s vs 10s? (4) does it actually honor duration (real 10s clip, unlike DoP)?
- **Gate work:** flat→trivial (1 constant); duration-variable→a small lookup table (5s/10s), moderate.

### B. Veo 3.1 — (Google; Cloud slug UNCONFIRMED)  💎 premium hero
- **Slug:** **NOT confirmed on Cloud.** Veo 3.1 is on the *agent rail* (CLI MODELS.md); Cloud Gallery membership unverified. **First question is "is it even on our rail."**
- **Underlying (fal):** **$0.40/sec + audio** (720p/1080p), $0.20/sec no-audio, 4K $0.60/sec+audio; **Fast** variant $0.15/sec+audio. 8s+audio = **$3.20**; Fast 8s+audio = $1.20.
- **Cost shape:** **VARIABLE** (per-second × audio × resolution × standard/fast) unless Higgsfield pins one config. Almost certainly a cost function.
- **Predicted credit cost (anchor):** ~**19 cr** (Fast 8s) to ~**51 cr** (Standard 8s+audio) → user-facing ~$2.40–$5.90. The most expensive model by far.
- **Product value:** **HIGH** — best-in-class quality + **native audio** (uniquely demoable: "a video with real sound"). The flagship "wow" tier.
- **Open cost-questions:** (1) on Cloud at all? (read-only Gallery check) (2) standard vs fast? (3) audio toggle exposed + its cost? (4) duration range? (5) cost per config.
- **Gate work:** **highest** — variable + expensive (margin/pricing care) + audio param + a real cost function. Don't approach casually.

### C. DoP first-last-frame — `higgsfield-ai/dop/{lite,standard}/first-last-frame`  🪙 cheap win
- **Slug:** DoP variant (sweep saw `*/first-last-frame`; SDK `Motion.start_end_frame?: boolean`). Takes a **start + end image**, interpolates between them.
- **Cost shape:** **FLAT** — same DoP engine, no duration. Almost certainly **= the DoP tier cost** (2 cr lite / 9 cr standard).
- **Predicted credit cost:** **2 cr (lite f-l-f) / 9 cr (standard f-l-f)**, HIGH confidence (engine identity).
- **Product value:** **LOW–MED** — a slick morph/transition effect (photo A → photo B). Niche but cute, demoable.
- **Open cost-questions:** (1) exact slug form; (2) confirm cost == DoP tier; (3) param shape (2 images + how start/end are designated).
- **Gate work:** **lowest** — likely reuses an existing DoP constant; one measurement to confirm.

### D. Speak (lip-sync / talking avatar) — `/v1/speak/higgsfield`  🎤 novel but gated
- **Slug:** the **one excluded model the SDK fully types** — `input_image`, `input_audio` (audio_url, WAV), `prompt`, `quality mid|high`, **`duration 5|10|15`**, seed.
- **Cost shape:** **VARIABLE over a SMALL DISCRETE MATRIX** (3 durations × 2 qualities = **≤6 cells**) → a lookup table, not a continuous function. Param shape already known (big plus).
- **Predicted credit cost:** **no clean external anchor** (Higgsfield-own lip-sync model) → genuinely unknown; scales with duration.
- **Product value:** **HIGH-NOVELTY** — "make my photo talk" is viral-grade. BUT it needs an **audio-input pipeline** (TTS or user-supplied WAV) — a product lift *beyond* the gate.
- **Open cost-questions:** (1) cost across the ≤6 cells (5/10/15 × mid/high); (2) WAV format/size constraints; (3) the upstream audio source (how the agent supplies WAV).
- **Gate work:** medium (6-cell lookup, params known) **+ separate audio-pipeline product work** (the real cost).

### E. Reve — `reve/text-to-image`  ⏭️ skip
- **Slug:** confirmed (sweep), un-typed params.
- **Underlying (fal):** ~**$0.04/image** → ~**1 cr** (anchor). Flat.
- **Product value:** **LOW** — redundant with `soul/standard` (already ~1 cr / effectively free). No cost win, no capability win; only aesthetic/text-rendering variety.
- **Verdict:** not worth a measurement slot now. Trivial to add later if we ever want image-style variety.

---

## 2. Ranked candidate list (product value × ease-to-add)

| Rank | Model | Product value | Cost shape (our side) | Predicted cr | Gate work | Net |
|---|---|---|---|---|---|---|
| **1** | **Seedance Pro** | HIGH (long-form) | OPEN: flat or 5/10s function | ~3–19 | low→med | **measure first** |
| **2** | **DoP first-last-frame** | LOW–MED (morph) | FLAT (=DoP tier) | 2 / 9 | **lowest** | **cheap win, measure w/ #1** |
| 3 | Veo 3.1 | HIGH (premium+audio) | VARIABLE (fn) | ~19–51 | **highest** | hold — confirm Cloud first, then a deliberate premium tier |
| 4 | Speak | HIGH-novelty | discrete (≤6) | unknown | med + audio pipeline | hold — gated on audio pipeline |
| 5 | Reve | LOW (redundant) | FLAT | ~1 | low | skip |

---

## 3. Recommendation — measure these 1–2 first

**① Seedance Pro — the one measurement that matters most.** A single funded
spot-test (run i2v at `duration:5` then `duration:10`, read the credit burn off
each) resolves *everything* at once:
- **Same cost both runs →** duration is pinned → **flat** → add as one constant (~10 cr) and we get whatever clip length it pins to "for free."
- **10s costs more →** duration is exposed + honored → we've learned the exact cost points → build a tiny 5s/10s lookup (the only variable-cost gate work, and it's small).
- Either way we learn whether Seedance is a cheaper/longer long-form path than Kling. **Highest information-per-credit of any test; unblocks the biggest product gap.** (~$0.6–$1.2 of spend.)

**② DoP first-last-frame — bundle it in, near-free.** One i2v with a start+end
image; confirm the cost == its DoP tier (expected 2 or 9 cr). If confirmed, it's
a **near-zero-effort allowlist add** (reuse the existing DoP constant) that ships
a fun morph/transition feature. (~$0.13–$0.56 of spend.)

**Hold (don't measure yet):**
- **Veo 3.1** — first do the *free* read-only check: is it in the Cloud Models Gallery at all? Only measure when we're deliberately standing up a premium ~$5/clip hero tier (it's variable + expensive → real pricing/margin design, not a casual add).
- **Speak** — measure the 6-cell matrix only once we've scoped the **audio-input pipeline** (the gate is the easy part; sourcing the WAV is the lift).

**Skip:** **Reve** — redundant with the soul image model; no cost or capability win.

**Free, do-anytime:** confirm the **Kling clip-length badge** (req 4f40be27). If it
reads ~10s as the pricing math predicts, we already have a ~10s long-form path and
Seedance's urgency drops from "fills the gap" to "cheaper/longer alternative."

---

## 4. What stays true regardless

- The gate's discipline is unchanged: **measure before allowlisting; never bill a
  guessed cost.** Variable-cost models (if Seedance/Veo turn out exposed) need a
  cost **function/lookup**, not a constant — `estimateVideoCredits` would take the
  validated params (duration/quality), and the **settle clamp already guarantees
  `charge ≤ hold`**, so even a mis-estimate can't over-bill.
- All param additions still flow through pre-submit validation (no passthrough).
- This is research only. **No allowlist edit, no code, no spend, no real
  generation.** Cooper decides what we measure.

*Sources: fal.ai model pages (Seedance v1 Pro, Veo 3.1, Kling 2.1 Pro, Reve),
the @higgsfield/client v0.2.1 SDK type definitions, and our own measured
calibration. Read-only, 2026-06-09.*
