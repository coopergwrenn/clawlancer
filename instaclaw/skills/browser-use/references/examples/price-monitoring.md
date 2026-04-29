# Example — Price Monitoring

Watch a public product page and report whether the current price is below a threshold.

## When to use

- "Watch this Amazon listing and tell me if it drops under $X."
- "Check the price on this Zillow listing once an hour."
- Anything where the data is publicly visible (no user account required) and the user wants a value-vs-threshold check.

If the user wants alerts in their account-bound UI (push, email-from-our-system), schedule via `recurring-executor.ts` and have the recurring task call this wrapper.

## Invocation

```bash
python3 ~/scripts/browser-use-task.py \
  --task "Open the product page, find the current price as a number in USD, and return JSON with fields: price_usd (number), in_stock (bool), title (string), url (string). Do not buy anything." \
  --start-url "https://www.amazon.com/dp/B0EXAMPLE" \
  --max-steps 8 \
  --timeout-sec 90 \
  --budget-usd 0.15 \
  --headless \
  --output-format json
```

Notes on the flags:
- `--max-steps 8` — single-page extract; should not need many steps. If it does, the page changed structure; rebuild the task.
- `--timeout-sec 90` — Amazon pages can be slow to render; 90s gives JS time to settle.
- `--budget-usd 0.15` — small task, small budget. Reported in output, not pre-enforced.
- Task description explicitly says "Do not buy anything" — defense in depth.

## Expected output (success)

```json
{
  "ok": true,
  "result": {
    "price_usd": 1099.00,
    "in_stock": true,
    "title": "Some Product Name",
    "url": "https://www.amazon.com/dp/B0EXAMPLE"
  },
  "wall_time_ms": 24500,
  "cost_usd": 0.08,
  "steps": [...],
  "screenshots": [...]
}
```

## Threshold logic (in agent code, not the wrapper)

The wrapper returns the value. The agent compares:

```python
# Pseudocode in the agent's reasoning
result = json.loads(stdout)
if not result.get("ok"):
    notify_user(f"Couldn't check price: {result['error']}")
elif result["result"]["price_usd"] < threshold_usd:
    notify_user(f"Price dropped to ${result['result']['price_usd']} (below your ${threshold_usd} threshold)")
else:
    log_no_change()
```

## Edge cases

- **Anti-bot intercept (Amazon CAPTCHA, Cloudflare).** Wrapper returns `ok:false` with the error. Escalate to `python3 ~/scripts/crawlee-scrape.py --url "URL" --mode light` (Tier 3.5).
- **Out of stock.** Some sites hide the price when out of stock. The task description handles this with `in_stock` field; agent should treat missing price as `in_stock=false`, not as an error.
- **Currency.** If the listing might render in non-USD (international Amazon, Zillow Canada), specify the currency explicitly in the task: "find the price in USD; if the page is in another currency, return null."
- **Dynamic pricing per session.** Some sites show different prices to different users. Browser-use uses a clean profile each call, so prices are session-anonymous.

## Recurring schedule

To run hourly:

1. Use `recurring-executor.ts` infrastructure (see InstaClaw codebase).
2. Schedule fires `python3 ~/scripts/browser-use-task.py ...` with the same task.
3. Recurring executor compares current vs prior result; on threshold breach, dispatches a notification.
4. Don't run faster than once an hour for the same URL — pattern triggers anti-bot heat.

## Don't

- Don't pass `--max-steps` higher than ~10 for single-page extracts. If the page genuinely needs more, you're probably extracting the wrong page (e.g., a search results page where the agent has to click through).
- Don't drop `--headless`. Visible Chromium is for debugging; headless is the default for cron-style monitoring.
- Don't ignore `ok:false`. Always read the error and decide: retry, escalate, or surface to user.
