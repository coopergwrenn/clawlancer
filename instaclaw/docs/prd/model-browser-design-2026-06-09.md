# Model Picker → Multi-Provider Model Browser (Design PRD)

**Status:** DESIGN / PROPOSAL; no code written. Stop-at-PRD per request.
**Date:** 2026-06-09
**Author:** onboarding terminal (CC)
**Scope of this doc:** the composer model picker (`app/(dashboard)/tasks/page.tsx`), its data model, the model catalog, and multi-provider readiness. Builds on the just-shipped picker (Raycast material + `ModelInfoButton` tooltip + Claude sunburst).

---

## 0. TL;DR (read this first)

Three findings reframe the task before any UX work:

1. **THE HEADLINE (must decide before building): the picker's version choice is NOT honored for credit users.** Every message from an all-inclusive (credit) user is re-routed by the proxy's model-router to a hardcoded tier model (`TIER_MODELS` = `opus-4-6` / `sonnet-4-6` / `haiku-4-5`), *overriding* the user's saved `default_model`. So if a credit user picks "Opus 4.8," they are served **Opus 4.6**. Version selection IS honored for **BYOK** users (their calls go direct to Anthropic, bypassing our router). Proven below with code cites. **Listing 4.7/4.8 is meaningful only if we resolve what the picker controls.** This is decision D1.

2. **Blast radius is 6 hardcoded model lists, not 1.** The model catalog is duplicated across 3 `MODEL_OPTIONS` copies + `MODEL_INFO` + the `ALLOWED_MODELS` validation gate + `MODEL_COST_WEIGHTS`. A registry collapses these to one source. (And the 3 `MODEL_OPTIONS` copies already disagree on labels; "Haiku 4.5" vs "Claude Haiku 4.5".)

3. **The money-facing weight check passes for Anthropic, and reveals the real future risk for OpenAI.** `getModelCostWeight()` substring-matches `opus`/`sonnet`/`haiku`, so every new Opus version (`claude-opus-4-7`, `claude-opus-4-8`) correctly inherits weight **19**; proven by running the actual function. BUT a non-matching string (e.g. `gpt-5.5`) **silently falls through to the haiku default (1)**; the exact "confidently-wrong money claim" failure mode, latent for the multi-provider phase. The registry must carry explicit weights.

Everything else (UX pattern, registry shape, sequence) follows from these.

---

## 1. Critical findings (proven; code-cited)

### 1a. The model-router override; what the picker actually controls

**Proven flow** (`app/api/gateway/proxy/route.ts`):
- L400/403: `requestedModel = parsedBody.model || vm.default_model || "minimax-m2.5"`; the user's saved pick (`default_model`, set by the picker) is the *starting* value.
- L1024: `routingDecision = routeModel(routingCtx)`; the content classifier runs.
- L1027-1038: `if (routingDecision.model !== requestedModel) { requestedModel = routingDecision.model; parsedBody.model = routingDecision.model; }`; **the router's choice overwrites the user's pick.**

`routeModel` (`lib/model-router.ts`) returns `TIER_MODELS[tier]` on every path (L89/92/94/114/119…). `TIER_MODELS` (`lib/models.ts:21-25`) is hardcoded:
```
1: "claude-haiku-4-5-20251001",  2: "claude-sonnet-4-6",  3: "claude-opus-4-6"
```
The only path that honors a specific requested model is `respectExplicitModel(ctx)` (L138-139), gated on `ctx.explicitModelRequest`, which is populated **only from the `x-model-override` header** (L1021); a header normal agent messages do **not** send. So `default_model`'s *version* is discarded for every classified message; only the *tier* survives, served as the fixed `TIER_MODELS` version.

**Therefore:**
- **Credit / all-inclusive users:** pick "Opus 4.8" → served `TIER_MODELS[3]` = **Opus 4.6**. Version choice cosmetic. (Confirmed: router output overrides `requestedModel` unconditionally on mismatch.)
- **BYOK users:** calls go **direct VM→Anthropic, never through our proxy/router** (per the BYOK design; "all API calls go directly from your VM to Anthropic, never proxied"). So the VM's configured `default_model` (the picker's pick, incl. version) **is** used. Version choice real.

This split is the foundation. A multi-version browser that lets credit users pick 4.8 and silently serves 4.6 would be a misleading money/quality claim; the same class of problem this codebase has rules against.

### 1b. Blast radius; the 6 hardcoded model lists

| # | Location | What it holds | Gate? |
|---|---|---|---|
| 1 | `app/(dashboard)/tasks/page.tsx:218` `MODEL_OPTIONS` | id + label ("Haiku 4.5"); the composer picker | display |
| 2 | `app/(dashboard)/settings/page.tsx:39` `MODEL_OPTIONS` | id + label ("Claude Haiku 4.5") | display |
| 3 | `app/(dashboard)/dashboard/page.tsx:40` `MODEL_OPTIONS` | id + label ("Claude Haiku 4.5") | display |
| 4 | `components/model-info-tooltip.tsx` `MODEL_INFO` | display name + tooltip copy + cost string | display |
| 5 | `app/api/vm/update-model/route.ts:7` `ALLOWED_MODELS` | **hard validation gate**; `!ALLOWED_MODELS.includes(model)` → 400 "Invalid model" | **HARD** |
| 6 | `lib/credit-constants.ts:38` `MODEL_COST_WEIGHTS` | tier→weight (haiku 1 / sonnet 4 / opus 19) | billing |

Adjacent (router-owned, not picker display, but version-relevant): `lib/models.ts:TIER_MODELS` + `TIER_BUDGET_LIMITS`.

**The load-bearing gotcha:** #5 `ALLOWED_MODELS` currently lists only the three `.6/.5` ids. **Add a model to the picker without adding it here and selection 400s, the persist fails, and `handleModelChange` reverts**; a silent "I picked it but it didn't stick" bug. Any registry refactor MUST drive `ALLOWED_MODELS` from the same source.

Labels already drift across the 3 copies; a registry fixes that for free.

### 1c. Weight mapping; the money check (PROVEN, not assumed)

`lib/credit-constants.ts:38-42`:
```ts
export const MODEL_COST_WEIGHTS: Record<string, number> = { minimax: 0.2, haiku: 1, sonnet: 4, opus: 19 };
```
`getModelCostWeight()` (L91-98) lowercases + substring-matches `minimax→haiku→sonnet→opus`, default `haiku`.

Ran the actual function against the proposed + future strings:
```
claude-opus-4-8            => 19   ✓ (catches new opus)
claude-opus-4-7            => 19   ✓
claude-opus-4-6            => 19   ✓
claude-sonnet-4-6          =>  4   ✓
claude-haiku-4-5-20251001  =>  1   ✓
claude-opus-4-8-20260101   => 19   ✓ (dated snapshot still matches)
gpt-5.5                    =>  1   ✗ FALLS THROUGH TO HAIKU DEFAULT
```
**Conclusion:** weights are **tier-keyed**, so all Opus versions = 19; adding 4.7/4.8 is weight-safe today. The `gpt-5.5 → 1` fallthrough is the future OpenAI landmine (D4): a real, silent, money-facing mis-weight. The registry must carry an explicit per-model `creditWeight` and `getCreditWeight` must read the registry first, substring only as last-resort fallback.

### 1d. The lineup (verified)

Env model-ID context + Anthropic docs/news corroborate the catalog. All are documented pinned-snapshot, dateless IDs:

| Display | API id | Tier | Weight | Notes |
|---|---|---|---|---|
| Opus 4.8 | `claude-opus-4-8` | flagship | 19 | newest, most capable |
| Opus 4.7 | `claude-opus-4-7` | flagship | 19 | |
| Opus 4.6 | `claude-opus-4-6` | flagship | 19 | current `TIER_MODELS[3]` + `default` |
| Sonnet 4.6 | `claude-sonnet-4-6` | balanced | 4 | balanced default; current `TIER_MODELS[2]` |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | fast | 1 | fastest; current `TIER_MODELS[1]`. (Alias `claude-haiku-4-5` also exists; we use the dated snapshot.) |

No Sonnet 4.7/4.8 and no Haiku 4.6+ exist (confirmed; matches your belief). **One must-confirm before build (D3):** the exact `claude-opus-4-7` / `claude-opus-4-8` strings the **gateway/Anthropic account actually accepts**; verify with a one-shot trivial completion per id (a confidently-wrong model string breaks the agent). Docs confirm the IDs exist; our account's access is the variable.

Sources: [Anthropic models overview](https://docs.anthropic.com/en/docs/about-claude/models/all-models) · [Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8) · [Opus 4.7](https://www.anthropic.com/news/claude-opus-4-7) · [Haiku 4.5](https://www.anthropic.com/news/claude-haiku-4-5)

---

## 2. The data model; the structured registry (foundation)

One source of truth. Proposed `lib/model-registry.ts`:

```ts
export type Provider = "anthropic" | "openai";        // extensible
export type Tier = "flagship" | "balanced" | "fast";  // cross-provider capability axis

export interface ModelEntry {
  id: string;            // EXACT API model string; the only thing sent upstream. e.g. "claude-opus-4-8"
  provider: Provider;    // grouping + logo
  family: string;        // "opus" | "sonnet" | "haiku" | "gpt"; within-provider line
  tier: Tier;            // the scannable capability axis (flagship/balanced/fast)
  version: string;       // "4.8"; for sort + "Latest" badge
  displayName: string;   // "Opus 4.8" (provider shown separately, no "Claude " prefix duplication)
  creditWeight: number;  // EXPLICIT, money-facing. NEVER inferred by substring. Cited per entry.
  tooltip: { desc: string; cost: string };  // existing ModelInfoButton copy shape; no em dashes
  flags: {
    available: boolean;  // wired + selectable. Anthropic=true this pass; OpenAI entries=false (designed, not populated)
    recommended?: boolean; // the "pick me if unsure" (Sonnet 4.6)
    latest?: boolean;      // newest in its family → "Latest" badge (Opus 4.8)
    legacy?: boolean;      // older version, de-emphasized / collapsed (Opus 4.6/4.7 under 4.8)
    default?: boolean;     // platform default for new VMs
  };
}

export const MODEL_REGISTRY: ModelEntry[] = [ /* the 5 Anthropic entries from §1d */ ];

// Derived; every current hardcoded list becomes a selector over the registry:
export const SELECTABLE_MODELS = MODEL_REGISTRY.filter(m => m.flags.available);
export const ALLOWED_MODEL_IDS = SELECTABLE_MODELS.map(m => m.id);   // drives update-model gate (#5)
export function getModel(id: string): ModelEntry | undefined;
export function getCreditWeight(id: string): number;  // registry-first; substring fallback ONLY if unknown + log a warning
export function modelsByProviderThenTier(): ...;       // drives the browser grouping
```

**What it replaces:** the 3 `MODEL_OPTIONS` (→ `SELECTABLE_MODELS`), `MODEL_INFO` (→ `entry.tooltip` + `displayName`), `ALLOWED_MODELS` (→ `ALLOWED_MODEL_IDS`), and the picker/tooltip components import from it. `MODEL_COST_WEIGHTS` stays as the tier fallback but `getCreditWeight` reads the registry first (closes the `gpt-5.5→1` hole).

**Left deliberately separate:** `lib/models.ts:TIER_MODELS` / `TIER_BUDGET_LIMITS`; these are the *router's* tier map, not picker display. They intersect with the headline D1 decision (below); the registry can *reference* them but shouldn't absorb the router's logic in this pass.

Get this shape right and every new model (or provider) is a one-array-entry change with the UI, the gate, the weights, and the copy all derived. That's the whole point of the refactor.

---

## 3. The UX pattern; recommendation

### Recommendation: **keep the popover for the 90% case, add a "See all" full browser modal for completeness.** (Not all-modal.)

Rationale: almost every switch is among 2-3 models the user actually uses. The just-shipped popover serves that instantly and beautifully; throwing it away for a modal-on-every-click taxes the common case. The completeness problem (growing, multi-provider catalog) is a *discovery* problem, which a searchable modal solves without bloating the quick path. This is the Linear/Raycast shape: a tight quick-list + a full searchable command surface behind it. It also scales: as OpenAI etc. land, the popover stays short (curated), the modal absorbs the growth.

### Layer 1; the composer popover (quick switch), evolves minimally
Curated short list, not the full catalog:
- The **current** model (lit coral, check, Claude-orange logo; as shipped).
- **Recommended** (Sonnet 4.6) if not current.
- **Recently used** (1-2, from localStorage); optional, Phase 2.
- A divider, then a **`Browse all models →`** row (opens Layer 2).

```
┌─────────────────────────────────┐
│  ✦ Sonnet 4.6      4cr   ✓  ⓘ   │  ← current (lit coral pill)
│  ✦ Opus 4.8       19cr      ⓘ   │  ← latest flagship  [Latest]
│  ✦ Haiku 4.5       1cr      ⓘ   │  ← fast
│ ───────────────────────────────  │
│  Browse all models          →   │  ← opens the modal
└─────────────────────────────────┘
```
(Keeps the shipped material: opaque card, inset rows, spring press, lit selected pill, sunburst logo, info tooltips, the select-confirm close animation.)

### Layer 2; the full model browser (modal), the scalable surface
Opens centered, opaque (`var(--card)`, glass-shadow family, NO bleed; same constraint), `max-w` ~480px, max-height with internal scroll. Structure:

```
┌───────────────────────────────────────────────┐
│  Choose a model                           ✕    │
│  ┌───────────────────────────────────────────┐ │
│  │ 🔍  Search models…                        │ │  ← filter-as-you-type
│  └───────────────────────────────────────────┘ │
│                                                 │
│  CLAUDE                                         │  ← provider section (logo + name)
│   Flagship                                      │  ← tier subhead
│    ✦ Opus 4.8     19cr   [Latest]      ✓   ⓘ   │  ← selected = lit coral
│    ✦ Opus 4.7     19cr                     ⓘ   │
│    ✦ Opus 4.6     19cr   [default]         ⓘ   │  (older versions; D2: collapse?)
│   Balanced                                      │
│    ✦ Sonnet 4.6    4cr   [Recommended]     ⓘ   │
│   Fast                                          │
│    ✦ Haiku 4.5     1cr                     ⓘ   │
│                                                 │
│  OPENAI                          (coming soon)  │  ← designed, greyed, not selectable (D4)
└───────────────────────────────────────────────┘
```

- **Grouping:** Provider (top sections) → Tier (Flagship / Balanced / Fast). Tier is the instant-scan axis ("I want the smartest" / "the cheap fast one"). Within a tier, versions newest-first, newest gets a `Latest` badge. This makes "lots of models" read as "a few tiers per provider," which is the core completeness-vs-friendly resolution.
- **Search:** filter-as-you-type across `displayName + provider + family + version + tier keywords` ("fast", "flagship", "opus", "claude", "4.8"). Empty = grouped view; typing = flat ranked results (exact-prefix first). Esc / click-outside closes.
- **Each row:** provider logo (Claude sunburst, lit Claude-orange when selected; reuse `ClaudeLogo`) · displayName · credit cost (the verified weight, e.g. "19 cr") · badges (`Latest`/`Recommended`/`default`) · the `ⓘ` info tooltip (reuse `ModelInfoButton`). Selected row = the lit coral pill + check (consistent with the popover).
- **Selected-at-a-glance:** the trigger label (composer) shows the current `displayName`; in the modal, the selected row carries the coral lit pill + check + its logo in Claude-orange; same selection language as everywhere else in the composer.
- **Reuse, not reinvent:** the modal rows ARE the picker rows (same material, spring press, lit pill, `ModelInfoButton`). New surface = the modal shell + search + grouping headers. Everything else is the shipped vocabulary.

### Interactions / states
- Open popover → quick list. Click `Browse all` → modal (popover closes, modal springs in; same enter language).
- Modal: type to filter; click a row → selects (same `handleModelChange`), confirm beat, modal closes.
- Empty search state: "No models match" + a clear-search affordance.
- Mobile: modal is full-width sheet (bottom-sheet or centered), search keyboard-friendly, rows tappable; `ModelInfoButton` already handles tap.

---

## 4. Multi-provider readiness; design for it, populate Anthropic only

**Recommendation: agree with your instinct.** Build the registry + browser to *hold* multiple providers (the `provider`/`Tier`/`flags.available` shape, provider grouping, greyed "coming soon" section), but populate **only Anthropic** this pass. OpenAI models:
- route through agents differently (OAuth/ChatGPT-subscription path, not our credit proxy) and
- need their own verified credit weights + the `getCreditWeight` registry-first fix to avoid the `gpt-5.5→1` mis-weight, and
- need the D1 router question resolved for *their* tiers.

That's a separate build with its own verification. Designing-for-it now (so adding OpenAI is a registry block + un-greying a section) is the right cost; wiring it now is premature and money-risky. **No sequencing change recommended**; Anthropic-only populate is correct.

---

## 5. Scope, sequence, MVP vs full

**Build order (each shippable, deploy-confirmed):**
1. **Registry refactor (foundation, no visible change).** Create `lib/model-registry.ts`; repoint the 3 `MODEL_OPTIONS`, `MODEL_INFO`, `ALLOWED_MODELS`, and `getCreditWeight` to it. Pure consolidation; picker looks identical, but now one source. Verify: tsc, all 4 surfaces render, `ALLOWED_MODEL_IDS` matches, weights unchanged. *This de-risks everything after.*
2. **Add the new Anthropic models to the registry** (Opus 4.8/4.7); gated on D1 (what the picker controls) + D3 (verified ids). Until D1 is resolved, this is where the "credit users get 4.6 anyway" problem must be handled (see D1 options).
3. **Layer-2 browser modal** (search + grouping) + the `Browse all →` row in the popover. Reuses shipped row material.
4. **(Later, separate) OpenAI population**; registry entries + weights + router work.

**MVP** = steps 1-2 (registry + correct, honest model list, popover only; maybe just "Browse all" deferred if the list is still ≤6). **Full** = step 3 (the searchable modal). The modal earns its keep once the catalog exceeds ~6-7 rows or OpenAI lands; at 5 Anthropic models the popover alone is arguably fine; see D5.

**Blast-radius checklist (every surface that must move together):** the 6 lists in §1b, plus `lib/models.ts:TIER_MODELS` *if* D1 = "make version real." Coverage script (Rule 27 spirit): a test asserting `ALLOWED_MODEL_IDS === registry available ids` and every registry id resolves a non-default weight.

---

## 6. Open decisions; YOUR call (the headline list)

- **D1; What does the picker control? (blocks everything; the #1 decision.)** Today credit users get `TIER_MODELS` regardless of pick (served 4.6); only BYOK honors the version. Options:
  - **(a) Platform-latest:** bump `TIER_MODELS[3]` to `claude-opus-4-8` fleet-wide (everyone on opus-tier gets 4.8). Picker stays *tier-level* (Opus/Sonnet/Haiku), versions are platform-chosen-latest, no per-version picking for credit users. Simplest, honest, no router rework. The "browser" then lists families/tiers, not a version ladder.
  - **(b) Make version real for credit users:** feed the user's chosen version into the router so opus-tier serves *their* opus version (registry-driven `TIER_MODELS` per VM, or explicit-pick bypasses the classifier). Most faithful to "pick your model," but a model-router change with billing-adjacent care.
  - **(c) BYOK-only version picking:** full version ladder shown only to BYOK users; credit users see tier-level. Honest but a split UX.
  - My lean: **(a) for credit + (c)'s honesty**; bump platform-latest to 4.8 so everyone improves, and only expose the full version ladder where it's actually honored (BYOK). Avoids shipping a misleading "pick 4.8 / get 4.6."
- **D2; Older-version treatment:** collapse Opus 4.6/4.7 under "Opus 4.8 · older versions ▸", or list all flat? (Lean: show latest per family by default, older behind a disclosure; keeps it friendly.)
- **D3; Confirm exact `claude-opus-4-7` / `claude-opus-4-8` strings against our Anthropic account** with a one-shot completion before listing (functional risk, not money). Docs confirm they exist; our access is the unknown.
- **D4; Multi-provider:** confirm "design-for, Anthropic-only populate" (my recommendation), and that OpenAI is a separate build.
- **D5; Popover + modal vs popover-only for now:** at 5 models the popover alone works; the modal is for scale. Build the modal now (future-proof) or defer until the catalog grows / OpenAI lands? (Lean: registry now, modal when count > ~6 or OpenAI arrives; but happy to build the modal now if you want the destination set.)
- **D6; `recommended` / `default` semantics:** Sonnet 4.6 = recommended; what's the platform `default` for new VMs (stays 4.6, or 4.8)?

---

**Recommendation in one line:** ship the **registry refactor first** (collapses 6 lists to 1, closes the OpenAI weight hole), resolve **D1** (I lean platform-latest-4.8 + honest BYOK version ladder), then decide modal-now vs modal-later (D5). Do not list 4.7/4.8 to credit users until D1 makes the pick honest.

---

## PHASE-2 RESEARCH RESULTS (2026-06-09, post-greenlight): all proven, labeled measured vs guessed

### R1. Availability (D3): PROVEN against our real Anthropic account (one-shot completion per id)
All 8 catalog candidates return **200 (resolve)**: `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, `claude-haiku-4-5-20251001`.
Correctly **404 (excluded):** `claude-mythos-5` (not_found, invite-only) and `claude-3-opus-20240229` (retired, confirms drop Opus 3 / Claude 3 gen).
**Fable 5 is live on our account.** Org rate limits (measured headers): Fable = 4,000 req/min, 4M input-tok/min, 800k output-tok/min; Opus 4.8 = 4,000 req/min, 10M input-tok/min, 800k output/min. Fable's input ceiling is ~2.5x tighter than Opus; fine at current scale (151 VMs, 4,000 req/min ≈ 26/min/VM headroom) but the input-token ceiling is the first thing that would 429 under heavy Fable adoption. Watch it; not blocking.

### R2. Expanded blast radius: a 7th seam (and others) beyond the 6 picker lists
Tracing every place a model string is read/compared/mapped surfaced more than the 6 display lists:
- **`lib/ssh.ts:4382` `toOpenClawModel()` (CRITICAL):** hardcoded `{minimax, haiku-4-5, sonnet-4-6, opus-4-6}` → `anthropic/`-prefixed map, unknown → **`anthropic/claude-sonnet-4-6` silent fallback**. Its own comment says "Add new entries here as new models are onboarded." Add Opus 4.8/Fable without updating this and the VM is configured as Sonnet (silent wrong-model). MUST be registry-driven.
- `lib/ssh.ts:5213` failover fallbacks `["anthropic/claude-haiku-4-5-20251001"]`; `lib/ssh.ts:6045-6052` resolvedModel haiku→sonnet swap.
- `lib/vm-reconcile.ts:5382` per-VM model target from `default_model`, fallback `claude-sonnet-4-6` (the reconciler enforces model.primary on the VM).
- `lib/recurring-executor.ts:115` rawModel from `default_model`, fallback `claude-sonnet-4-6`.
- `lib/openai-oauth-db.ts:503` resets `default_model` to `claude-sonnet-4-6` on OAuth disconnect.
- `lib/cloud-init-params.ts:78` `default_model` consumed at provision.
- Heartbeats: proxy forces `minimax-m2.5` (`proxy:723`); strip-thinking infra summaries force `claude-haiku-4-5-20251001` (`ssh.ts:1354/1556`). Neither is picker-driven; safe.
- `instaclaw_usage_log` stores `model` + `cost_weight` + `routing_tier` (logged), **NO token columns** (see R3).

Registry implication: the registry entry needs the **openclaw wire-form** (`anthropic/<id>`) as a derived field so `toOpenClawModel` is registry-driven, not a parallel hardcoded map. The reconciler's `stepEnforceModelPrimary` is the seam that PUSHES the chosen model to the VM; it must accept the new ids.

### R3. Economics: assumptions labeled, margin shown (HARD-PAUSE #1: the Fable weight)

**Inputs:**
- MEASURED (code): daily credit grants Starter 600 / Pro 1000 / Power 2500 (`credit-constants.ts:13`). All-inclusive plan prices Starter **$49.99** / Pro **$129.99** / Power **$349.99**/mo (`lib/stripe.ts:28-30`). (Note: "$99/$299" are OLD grandfathered prices; current is higher. Credits apply only to all-inclusive users; BYOK users pay Anthropic directly and consume zero of our credits.)
- MEASURED (Anthropic, today): per-MTok Haiku $1/$5, Sonnet $3/$15, Opus $5/$25, **Fable $10/$50** (exactly 2x Opus).
- MEASURED (usage_log, 48h): 151 active VMs (118 starter / 20 pro / 13 power); ~13,772 user calls/48h; model mix (1k-row sample) flagship/opus = **11% of calls but 58% of credits**, sonnet 23%/25%, haiku 65%/17%; blended consumption is a small fraction of grants (avg ≈ 170 credits/VM/day vs 600-2500 grants).
- **GUESSED (the shakiest input; NOT stored): avg flagship message ≈ 14,000 input + 2,000 output tokens.** Anchored to the codebase's own observation ("~14,000 input_tokens", `vm-manifest.ts:716`). **No prompt-cache discount modeled (conservative worst case);** with caching of the stable system prompt, real input cost is materially lower.
- DERIVED cost/msg (no cache): **Opus = $0.12** (14k×$5/M + 2k×$25/M). **Fable = $0.24** (14k×$10/M + 2k×$50/M) = exactly 2x Opus.

**The proof (not a proportional guess): Fable@38 is margin-IDENTICAL to Opus@19.** Fable costs 2x Opus per message AND weight 38 = 2x 19, so credits-consumed-per-dollar-of-our-cost is identical. N credits spent on Fable@38 costs us exactly what N credits on Opus@19 costs. **Adding Fable@38 introduces zero new margin risk relative to the existing Opus@19 baseline.** The decision collapses to: is the flagship-tier weight (19) itself healthy?

**Break-even at the TAIL (a user maxing their entire daily grant on flagship, no cache):**
| Tier (grant, price) | Opus@19 msgs/day | cost/mo | vs revenue | Fable@38 (identical) |
|---|---|---|---|---|
| Starter (600, $49.99) | 31 | ~$114 | **2.3x underwater** | same $114 |
| Pro (1000, $129.99) | 53 | ~$190 | **1.46x underwater** | same |
| Power (2500, $349.99) | 132 | ~$474 | **1.35x underwater** | same |

**Finding (answers "is Opus 19 itself profitable"):** at MAX flagship utilization the flagship tier is **already underwater on every tier today (Starter worst), pre-Fable.** Fable@38 matches it, adds nothing. BUT max-utilization is not reality: measured blended use is ~170 credits/VM/day (well under grants) and flagship is 11% of calls, so the AVERAGE user is comfortably profitable. The exposure is whale/tail users who heavily use flagship; the daily grant is the hard cap that bounds the worst-case loss per user (a Starter whale can lose us at most ~$64/mo over their $49.99). With prompt caching (likely), even the tail is far less underwater than the no-cache numbers above.

**Tier-budget impact (Fable msgs/day) at candidate weights:**
| Weight | Starter (600) | Pro (1000) | Power (2500) |
|---|---|---|---|
| 19 (=Opus) | 31 | 52 | 131 |
| **38 (2x Opus, proposed)** | **15** | **26** | **65** |
| 50 (premium headroom) | 12 | 20 | 50 |

**RECOMMENDATION (lock this): Fable weight = 38.** It is provably margin-equivalent to the Opus baseline you already run, so it adds no new risk; it is honest (2x cost = 2x credits). Three flags I will not bury:
1. The flagship tier (Opus 19, hence Fable 38) is underwater at the max-utilization tail, worst on Starter. This is pre-existing, not introduced by Fable.
2. The entire cost side rests on a GUESS (14k/2k tokens, no cache). **Strongly recommend instrumenting token logging** (add `input_tokens`/`output_tokens`/`cache_read_tokens` to `instaclaw_usage_log`) so this becomes measured. That is the real fix for margin certainty; the weight is secondary. Fast follow, ~1 migration + proxy write.
3. The tail bleed is concentrated on **Starter** (the cheapest plan, most exposed to the priciest model). You deferred tier-gating; the numbers say if you ever gate Fable, gating it to **Pro+** removes essentially all of the margin exposure. Surfaced for your decision, not wired.
If you want Fable to carry visible premium headroom over Opus rather than parity, **50** is the alternative (Starter 12/day); I do not think it is necessary given margin-equivalence, but it is defensible as "the premium model costs premium credits."

### R4. D1: what the picker controls (HARD-PAUSE #2: recommendation + tradeoffs)

Restating the proven mechanics: credit users are auto-routed to `TIER_MODELS[tier]` (fixed versions); their picked version is discarded. BYOK users get their picked model direct. So "let users pick a version" is only real for BYOK today.

**Recommendation: a 2-part split that is honest on both sides.**
- **(A) Bump the platform tier-latest fleet-wide.** Set `TIER_MODELS` flagship to the newest you trust as default. With Fable now top, the question is Fable-vs-Opus-4.8 as the auto-flagship. Given Fable is 2x cost and the router auto-routes ~11% of calls to flagship, making Fable the *auto* flagship doubles flagship cost fleet-wide with no user opt-in. **Recommend auto-flagship = Opus 4.8** (newest Opus, same cost tier as today's 4.6, a clean free upgrade for everyone), and Fable is **explicit-pick-only** (not in the auto-router), so cost only rises when a user deliberately chooses the premium model. Bump `TIER_MODELS[2]`→ keep `claude-sonnet-4-6`, `TIER_MODELS[3]`→ `claude-opus-4-8`.
- **(B) Make explicit version-pick real for credit users via `respectExplicitModel`.** Today only the `x-model-override` header triggers it. Plumb the VM's `default_model` (the picker's saved pick) into `routingCtx.explicitModelRequest` so a deliberately-picked model (incl. Fable, incl. a specific Opus version) is honored within budget, instead of being silently overridden. This is the change that makes the picker mean what it says for everyone. It is a model-router edit, billing-adjacent, so it is gated behind your explicit go (this is the D1 wiring you said to HOLD).

**What each user gets under this rec:**
- Credit user, no explicit pick: auto-routed, flagship = Opus 4.8 (upgraded from 4.6 for free).
- Credit user, explicitly picks Opus 4.7 / Fable 5: served that model (within their tier budget; weight applies), via (B).
- BYOK user: their pick direct to Anthropic, as today.

**Tradeoffs:** (A) alone is the no-risk minimum (free fleet upgrade, no router rework, picker stays tier-level-honest). (B) is the "picker actually controls the model" promise but touches billing-adjacent routing, so it earns its own canary + verification. You can ship (A) now and decide (B) separately. **HOLDING all version-ladder + (B) wiring for your explicit pick**, per your instruction. (A) is also technically a `TIER_MODELS` change I will not make without your nod, since it shifts every flagship-tier message fleet-wide.

### R5. Confirmed existing weights (not re-derived) + build status
- Existing weights confirmed verbatim at `credit-constants.ts:38-42`: minimax 0.2, **haiku 1, sonnet 4, opus 19** (unchanged; carry into the registry as explicit values).
- **Money guardrail honored:** the registry (explicit per-model weights) lands FIRST; no model enters on a substring-guessed weight. Fable's 38 is pending your lock (R3); until locked, Fable is not added (build order step 4 gates on the lock).

### Open decisions now in front of you
- **D7 (Fable weight): lock 38** (recommended, margin-equivalent) or 50 (premium headroom). HARD PAUSE.
- **D1 (picker control): approve (A) auto-flagship → Opus 4.8 now**, and decide whether to greenlight **(B)** explicit-pick-honored-for-credit-users (separate canary). HARD PAUSE on any `TIER_MODELS` change + (B).
- **D8 (legacy depth):** include legacy-available (Opus 4.7/4.6/4.5, Sonnet 4.5) collapsed under family. (All proven-available in R1.)
- **Fast-follow (my recommendation, your call):** instrument token logging in `usage_log` so cost/margin is measured, not guessed. The single highest-leverage thing for never-get-screwed-on-margin certainty.

---

## LOCKED DECISIONS + BILLING CLARIFICATION (2026-06-09)

**Locks:** Fable weight = **38** (margin-equivalent to Opus 19, explicit registry weight). D1(A) **approved**: bump auto-flagship `TIER_MODELS[3]` to `claude-opus-4-8`, keep `TIER_MODELS[2]` = `claude-sonnet-4-6`; **Fable is explicit-pick-only and MUST NEVER be auto-routed** (cost-safety line). D1(B) **HELD** (plumbing `default_model` into `respectExplicitModel` for credit users ships later as its own canary). Any tier-gating wiring HELD.

**Billing clarification (proven, corrects earlier framing):** the live billing weight is **tier-based**, computed at `proxy/route.ts:1762-1765` (usage_log) + `:1815` (tier-usage RPC) from `routingDecision.tier` mapped to {1,4,19} (minimax 0.2, tool-continuation x0.2). It does NOT call `getModelCostWeight`; the model string is only a substring fallback when `routingDecision` is null (and even then maps to tier 1/2/3, so a Fable string falls to tier 1). `getModelCostWeight` is used only by `cron-guard.ts:66` (cron cost projection). Consequence: the registry's explicit per-model `creditWeight` (Fable 38) governs (a) tooltip display, (b) cron projection if repointed, (c) FUTURE (B) per-model billing; it does NOT change live billing. **The registry refactor must NOT touch the proxy billing computation.** Fable@38 becomes a live charge only when (B) ships AND the billing path is made model/registry-aware (part of the (B) workstream).

**Honesty gap handling (step 2 plan):** with (B) held, a credit user picking Fable/a legacy version gets neither the model (router overrides) nor the 38-credit charge. Plan: the expanded catalog (Fable + version ladder) is **BYOK-gated**; credit users see the honest auto-tier set (Haiku 4.5 / Sonnet 4.6 / Opus 4.8) reflecting what the router serves. Revisit when (B) ships.

## NEAR-TERM FOLLOW-UPS (captured, not building now)

1. **Token logging (the real margin fix; highest leverage).** `instaclaw_usage_log` has no token columns, so the entire cost side of the Fable/Opus margin analysis is an estimate (14k in / 2k out, no cache). Add `input_tokens`, `output_tokens`, `cache_read_tokens` to `instaclaw_usage_log` + write them in the proxy usage-log insert (`proxy/route.ts:~1786`). Turns margin from estimated into measured. ~1 migration + ~3 line proxy change + a coverage query. Do before any future flagship-weight decision.

2. **Fable -> Pro+ tier gating (one-decision lever).** Proven: the max-utilization tail bleed concentrates on Starter (cheapest plan, $49.99, can max the priciest model: ~$114/mo cost vs $49.99 at Opus-19/Fable-38 weight, 2.3x underwater at the tail). Gating Fable to Pro+ removes essentially all of that exposure. Left ungated now (per decision); the registry data model SUPPORTS a tier flag (unwired). If flagship margin ever bites, flipping Fable to Pro+ is a one-field change. Numbers: at weight 38, Fable msgs/day = Starter 15 / Pro 26 / Power 65.
