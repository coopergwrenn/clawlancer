# Example — Multi-Page Data Extraction

Scrape a paginated table or listing page (e.g., job board, event listings, product catalog) and return structured JSON.

## When to use

- "Pull all the open Senior Engineer jobs from RemoteOK in the last week." (public)
- "List every event in Brooklyn this weekend on Eventbrite." (public)
- "Get the first 50 listings on this Zillow search." (public)

If the data is behind a login, route to Tier 4 (relay).

## Invocation

```bash
python3 ~/scripts/browser-use-task.py \
  --task "Visit the search results page. Extract every job listing on the first 3 pages of results. For each: title (string), company (string), location (string), salary_range (string|null), url (string), posted_relative (string). Paginate by clicking the 'Next' button. Stop after 3 pages or 50 results, whichever is first. Return JSON: {jobs: [...], pages_visited: number}." \
  --start-url "https://remoteok.com/remote-senior-jobs" \
  --max-steps 25 \
  --timeout-sec 240 \
  --budget-usd 0.60 \
  --headless \
  --output-format json
```

Notes on the flags:
- `--max-steps 25` — pagination + extraction across 3 pages eats steps. Starting at the cap.
- `--timeout-sec 240` — multi-page tasks need real wall-clock budget.
- Task spec includes a hard "stop after N pages or N results" — prevents runaway crawl.
- `--budget-usd 0.60` — bigger task, bigger budget.

## Expected output (success)

```json
{
  "ok": true,
  "result": {
    "jobs": [
      {"title":"Senior Backend Engineer","company":"Acme","location":"Remote (US)","salary_range":"$140-180k","url":"https://...","posted_relative":"3 days ago"},
      {"title":"Senior Platform Engineer","company":"Globex","location":"Remote (Worldwide)","salary_range":null,"url":"https://...","posted_relative":"1 day ago"}
    ],
    "pages_visited": 3
  },
  "wall_time_ms": 142500,
  "cost_usd": 0.45,
  "steps": [...]
}
```

## Pattern notes

- **Always include a hard stop in the task.** "Stop after 3 pages or 50 results, whichever first." Without this, browser-use can keep paginating indefinitely on infinite-scroll sites.
- **Specify the schema in the task.** "title (string), company (string), salary_range (string|null)." The agent extracts to that shape and you don't have to massage the output.
- **Don't try to extract every field on the page.** Pick 5-7 high-value fields. More fields = more chance of nulls and per-row errors.
- **Pagination styles vary.** "Click Next" works for most sites. For infinite scroll: "Scroll to the bottom of the page and wait for more results to load. Repeat until N results or 3 scroll cycles."

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Only first page extracted | Pagination button not found / changed | Take a screenshot via Tier 3 to inspect; rewrite the click instruction |
| 403 / Cloudflare on page 2+ | Site rate-limits anonymous crawlers | Tier 3.5: `crawlee-scrape.py --mode light` per page (slower, more reliable) |
| Some rows have null fields | Listings vary in completeness | Expected; treat null as missing-not-error |
| Hits step cap mid-page | Too many fields, too slow | Cut the schema; or split into "page 1" + "page 2" + "page 3" calls |

## Don't

- Don't try to extract 100+ pages in one call. Split into batched calls.
- Don't re-extract data you already have. Cache the URL → result keyed by date.
- Don't omit the schema in the task description. "Get all the data" is not a task; "Extract title, company, location, url for each row" is a task.
- Don't run this on the same site faster than ~1 task / 30 seconds. Anti-bot heat compounds.
