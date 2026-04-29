# Example — Multi-Step Research with Synthesis

Research a topic across N pages and return a synthesized answer with citations. Use this when the user asks an open-ended research question that goes beyond a single search result.

## When to use

- "Compare the pricing of [3 SaaS competitors]." (multi-page, multi-source)
- "Summarize what AI labs are saying about agent safety this quarter." (multi-page synthesis)
- "What are the top 5 features users complain about for [product X]?" (review aggregation across review pages)

If the answer is on a single page, use Tier 2 (`web_fetch`) or Tier 1 (`web_search`) instead.

## Invocation

```bash
python3 ~/scripts/browser-use-task.py \
  --task "Research the pricing of Linear, Notion, and Asana for teams of 50 users. For each: visit their pricing page, find the team plan, extract per-user monthly cost (in USD, billed annually) and key feature limits. Return JSON: {linear: {price_per_user_usd: number, key_features: [string]}, notion: {...}, asana: {...}, comparison_notes: string}. Cite the URL you got each price from." \
  --max-steps 25 \
  --timeout-sec 300 \
  --budget-usd 1.00 \
  --headless \
  --output-format json
```

Notes on the flags:
- No `--start-url` — the task description names the targets; the agent searches/navigates as needed.
- `--max-steps 25` and `--timeout-sec 300` — research is the long-pole task class.
- `--budget-usd 1.00` — top of normal range. Watch the actual `cost_usd` in output.

## Expected output (success)

```json
{
  "ok": true,
  "result": {
    "linear": {
      "price_per_user_usd": 8,
      "key_features": ["Unlimited members", "Cycles", "Roadmaps", "API access"],
      "url": "https://linear.app/pricing"
    },
    "notion": {
      "price_per_user_usd": 10,
      "key_features": ["Unlimited blocks", "Permission groups", "SAML SSO"],
      "url": "https://notion.so/pricing"
    },
    "asana": {
      "price_per_user_usd": 11,
      "key_features": ["Timeline", "Forms", "Workflow Builder"],
      "url": "https://asana.com/pricing"
    },
    "comparison_notes": "Linear is cheapest with strong dev-team focus. Notion includes docs+wiki at $10. Asana is the most expensive but has the broadest project-mgmt features."
  },
  "wall_time_ms": 187000,
  "cost_usd": 0.72
}
```

## Pattern notes

- **Always require citations.** The task description says "Cite the URL you got each price from." This forces the agent to keep track of provenance and makes the output verifiable.
- **Specify the schema fully.** Don't ask for "info about pricing" — ask for `price_per_user_usd: number, key_features: [string], url: string`. The output is more useful and compresses better.
- **Specify the user-context (team size, billing cycle, region) in the task.** Prices vary; you want a deterministic comparison.
- **Pre-search vs in-task search.** If you already have the URLs, pass them in the task (skips the search phase). If you don't, the agent will search-and-navigate (~3-5 extra steps).

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Two of three competitors extracted, one failed | One site has an unusual pricing page layout | Re-run with that one site as `--start-url`, more focused task |
| Hits step cap, partial result | Too many sites or too many fields per site | Split: research each site as a separate call, then ask the agent to synthesize |
| One source's price is null | Site requires "Contact us" for pricing | Expected for enterprise tiers; treat null as "not publicly listed" |
| Hits CAPTCHA on one site | That site has bot protection | Tier 3.5 fallback: `crawlee-scrape.py` for that single URL |

## When to split into multiple wrapper calls

If the research has more than ~3 sources, split:

1. Call 1: research source A → get JSON A.
2. Call 2: research source B → get JSON B.
3. Call 3: research source C → get JSON C.
4. Final synthesis: agent combines the JSONs in its own reasoning (no wrapper call needed for synthesis).

This bounds blast radius — if source B's wrapper call fails, sources A and C still succeed. One big wrapper call is all-or-nothing.

## Don't

- Don't ask for "everything" about a topic. Specify what you want.
- Don't omit citations. Always require URLs in the output schema.
- Don't run research tasks faster than ~1 per minute on the same domain set — anti-bot heat compounds.
- Don't combine research with action ("research X and then book Y"). Split the research phase from the action phase. Action phase typically goes through the relay.
