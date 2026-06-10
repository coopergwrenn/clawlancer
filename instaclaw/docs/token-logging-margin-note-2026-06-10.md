# Token logging → the 2-week margin readout (note, not a build)

**Date:** 2026-06-10 · **Status:** capture SHIPPED (this PR); analysis is future work once ~2 weeks of data exist.

This note records what the margin analysis will *need* so the capture we built now is sufficient. **We are NOT building the analysis yet** — only the four token columns + proxy capture. Writing this down so the readout, when run, doesn't discover a missing input.

## What we now capture (per `instaclaw_usage_log` row)

`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` — Anthropic's four billed legs — attributable by `model`, `call_type`, `routing_tier`, `vm_id`, `created_at` (all already on the row).

## The cost formula the readout must use (all four legs)

Anthropic per-MTok rates (measured 2026-06-09, R3): Haiku $1/$5, Sonnet $3/$15, Opus $5/$25, **Fable $10/$50**. The cache multipliers are the reason 3 columns weren't enough:

```
cost_usd = (input_tokens          × input_rate)
         + (output_tokens         × output_rate)
         + (cache_read_tokens     × input_rate × 0.10)    -- cache hit: ~10% of input
         + (cache_creation_tokens × input_rate × 1.25)    -- cache write: ~125% of input
```

The R3 estimate assumed **zero cache** (conservative worst case). Our ~32K system prompt is cached, so in reality `cache_read_tokens` should dominate the input leg and `input_tokens` (fresh) should be small — meaning **real cost/msg is materially below R3's $0.12 (Opus) / $0.24 (Fable)**, and the "tail underwater" picture is softer than R3 painted. The readout must compute effective cost WITH cache, not the no-cache estimate.

## The "does 38 hold?" calculation

R3's lock rests on one hypothesis: **Fable costs exactly 2× Opus per message**, so Fable@38 is margin-identical to Opus@19. With real tokens:

1. Per-model effective cost/msg = `AVG(cost_usd)` over the window, `GROUP BY model`, `call_type='user'` (exclude infra/heartbeat — those are platform-funded, separate line).
2. Compute the **real Fable/Opus cost ratio**. If ≈2.0 → 38 holds. If >2.0 → Fable is under-weighted (consider 50, the R3 alternative). If <2.0 → 38 is conservative (fine).
3. Cross-check against credits-consumed: a credit is worth `model_cost_usd / credit_weight`. Fable@38 and Opus@19 should yield the same $/credit if the ratio is 2.0.

## Aggregations the readout needs (query shapes, not built)

- **Per-model cost + volume:** `SELECT model, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens) FROM instaclaw_usage_log WHERE call_type='user' AND created_at > now()-interval '14 days' GROUP BY model`.
- **Cache-hit ratio per model:** `SUM(cache_read_tokens) / NULLIF(SUM(input_tokens + cache_read_tokens),0)` — confirms the system prompt is actually being cached (if low, the cache discount isn't materializing and the no-cache estimate is closer to truth).
- **Tail analysis:** per-VM daily `SUM(cost_usd)` vs that VM's plan price — find the whale/tail users R3 flagged, now with real cost.
- **Cost by call_type:** isolate the minimax/heartbeat line, the tool-continuation discount (0.2×), and the infra line — each is a separate margin component, all now measurable because every call_type already logs a row.

## What's explicitly NOT in scope now

- No analysis script, no dashboard, no alerting on margin. Just capture.
- No cost_usd column (derive at read time from tokens × rates — rates change, don't bake them into rows).
- The Fable→Pro+ tier-gating decision (R3 follow-up #2) waits on this data.

## Caveat to verify once data flows

`cache_creation_tokens` is the leg I added beyond the 3 originally specced. Confirm in the first readout that it's non-trivial (the system prompt gets re-cached periodically); if it's always ~0, the column is harmless but the cache-write premium isn't a real cost factor and the cost formula simplifies to input + output + cache_read.
