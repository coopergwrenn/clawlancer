# Crawlee Stealth Scraping

Crawlee is a stealth web scraping tool installed on this VM. It bypasses anti-bot systems (Cloudflare, DataDome, PerimeterX) using TLS fingerprint impersonation and browser fingerprint randomization. Use it as a **fallback** when basic requests/BeautifulSoup get blocked.

## Decision Flow

1. Try basic `requests` or `urllib` first (fastest)
2. If blocked (403, CAPTCHA, "verify you're human") → try `crawlee-scrape.py --mode light`
3. If still blocked or site requires JavaScript → try `crawlee-scrape.py --mode browser`
4. If still blocked → report to user that site has strong anti-bot protection

## When to Use Crawlee

- Site returns 403 Forbidden with basic requests
- Site shows CAPTCHA or "verify you're human" page
- Site uses Cloudflare, DataDome, PerimeterX, or similar WAF
- E-commerce product data (Amazon, Shopify stores, eBay)
- Financial data from protected sources
- Competitive intelligence on corporate websites

## When NOT to Use Crawlee

- Simple API calls that return JSON — use requests directly
- Static HTML pages with no bot protection — use requests/BeautifulSoup
- Sites the agent has scraped successfully before with basic tools
- Internal URLs or known-friendly endpoints

## Commands

### Light Mode (default — fast HTTP with TLS stealth)
```bash
python3 ~/scripts/crawlee-scrape.py --url "https://target.com"
```

### Browser Mode (full Chromium with fingerprint randomization)
```bash
python3 ~/scripts/crawlee-scrape.py --url "https://spa-app.com" --mode browser
```

### Extract Specific Elements
```bash
python3 ~/scripts/crawlee-scrape.py --url "https://store.com" --selector ".price,.product-title"
```

### Multiple URLs
```bash
python3 ~/scripts/crawlee-scrape.py --urls "https://a.com" "https://b.com"
```

### Text Output (instead of JSON)
```bash
python3 ~/scripts/crawlee-scrape.py --url "https://target.com" --output text
```

## Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--url` | required | Single URL to scrape |
| `--urls` | — | Multiple URLs |
| `--mode` | `light` | `light` or `browser` |
| `--output` | `json` | `json`, `text`, `html`, or `markdown` |
| `--selector` | — | CSS selector(s), comma-separated |
| `--max-pages` | 1 | Max pages (single-page only in v1) |
| `--timeout` | 30 | Per-request timeout in seconds |
| `--total-timeout` | 120 | Total execution timeout |

## Output Format (JSON)

```json
{
  "success": true,
  "results": [
    {
      "url": "https://target.com",
      "status_code": 200,
      "title": "Page Title",
      "text_content": "Extracted text...",
      "html_content": "<html>...</html>",
      "links": ["https://link1.com"],
      "selected_elements": ["$99.99", "Product Name"],
      "scraped_at": "2026-03-08T14:30:00Z"
    }
  ],
  "stats": {
    "total_urls": 1,
    "successful": 1,
    "failed": 0,
    "mode_used": "light",
    "duration_seconds": 2.3,
    "retries": 0
  },
  "errors": []
}
```

## Mode Selection Guide

| Scenario | Mode | Why |
|----------|------|-----|
| Amazon product pages | `light` | TLS impersonation bypasses Cloudflare |
| Shopify stores | `light` | Static HTML, stealth HTTP sufficient |
| Nike, React/Vue SPAs | `browser` | Needs JavaScript execution |
| News articles | `light` | Simple HTML |
| Financial dashboards | `browser` | JS-rendered data |
| Unknown site | `light` first | Escalate to `browser` if blocked |

## Limits

- Single-page scraping only (no link following)
- 120 second total timeout
- Light mode: up to 5 concurrent requests, max 30 per run
- Browser mode: 1 page at a time, max 10 per run
- No proxy support in v1
