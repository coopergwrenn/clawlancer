# Competitive Intelligence Reference Guide

## Brave Search API

**Base URL:** `https://api.search.brave.com/res/v1`
**Auth:** `X-Subscription-Token: <BRAVE_SEARCH_API_KEY>` header
**Endpoints:**
- `/web/search` — Web search results
- `/news/search` — News-specific results

## Quick API Reference

### Web Search
```bash
# General search
~/scripts/competitive-intel.sh search --query "CompetitorX announcement" --count 10

# Site-specific search
~/scripts/competitive-intel.sh search --query "site:competitor.com/blog" --count 5

# Time-filtered search
~/scripts/competitive-intel.sh search --query "CompetitorX" --freshness pd    # past day
~/scripts/competitive-intel.sh search --query "CompetitorX" --freshness pw    # past week
~/scripts/competitive-intel.sh search --query "CompetitorX" --freshness pm    # past month
```

### News Search
```bash
~/scripts/competitive-intel.sh news --query "CompetitorX funding" --count 5
~/scripts/competitive-intel.sh news --query "AI agent platform" --freshness pw
```

### Page Snapshots
```bash
# Fetch and store a page for comparison
~/scripts/competitive-intel.sh snapshot \
  --url "https://competitor.com/pricing" \
  --competitor CompetitorX \
  --category pricing
```

## Useful Search Patterns

| Goal | Query Pattern |
|------|--------------|
| Blog posts | `site:competitor.com/blog` |
| Changelog | `site:competitor.com/changelog` |
| Pricing page | `site:competitor.com/pricing` |
| Job listings | `site:linkedin.com/jobs "CompanyName"` |
| Twitter mentions | `site:twitter.com "CompanyName"` |
| Funding news | `"CompanyName" funding OR raised OR series` |
| Feature launches | `"CompanyName" launch OR "new feature" OR announce` |
| Acquisitions | `"CompanyName" acquired OR acquisition OR merger` |
| Reviews | `"CompanyName" review OR alternative` |
| Reddit discussion | `site:reddit.com "CompanyName"` |

## Freshness Filters

| Value | Meaning |
|-------|---------|
| `pd` | Past day (24 hours) |
| `pw` | Past week (7 days) |
| `pm` | Past month (30 days) |

## Data Source Feasibility

| Category | Score | Method | Notes |
|----------|-------|--------|-------|
| Competitor pricing | 8/10 | Fetch pricing pages, compare snapshots | Static pages = reliable |
| New features/launches | 9/10 | Search changelogs and blogs | Companies publish these |
| Job postings | 7/10 | Search LinkedIn/Indeed | Some boards block scraping |
| Social mentions | 8/10 | Search Twitter/Reddit | Public posts searchable |
| Funding rounds | 9/10 | Search Crunchbase/TechCrunch | Well-covered by press |
| Content frequency | 9/10 | Search site:competitor.com/blog | Timestamped posts |
| App Store reviews | 6/10 | Search Product Hunt | App Store needs browser |
| SEO rankings | 5/10 | Search keywords, find position | Directional only |
| Traffic estimates | 3/10 | Requires SimilarWeb/Ahrefs | Cannot get from search |

## Alert Trigger Classification

### Critical (notify immediately)
- Competitor funding announcement
- Major feature launch
- Significant price change (>10%)
- Competitor acquisition or merger
- Negative sentiment spike (>50% increase)
- Your company mentioned alongside competitor

### Informational (bundle into daily digest)
- New blog post
- Minor price change (<10%)
- New job posting
- App store review

## Sentiment Keywords

### Positive Signals
love, amazing, great, best, excellent, impressed, recommend, fantastic, innovative, growing, winning

### Negative Signals
hate, terrible, worst, disappointed, broken, switching, leaving, frustrating, buggy, slow, expensive

### Crypto-Specific Positive
moon, gem, bullish, buying, accumulating, undervalued, based, alpha

### Crypto-Specific Negative
rug, scam, bearish, selling, dumping, dead, overvalued, avoid

## Rate Limits

| Budget | Limit |
|--------|-------|
| Brave Search calls | 30 per competitor/day |
| Web fetch calls | 20/day |
| Total daily | 200 (hard cap) |
| Alert threshold | 160 (80% warning) |

### Per-Scan Allocation
| Scan Type | Calls/Competitor | Frequency |
|-----------|-----------------|-----------|
| Price check | 3 | Daily |
| Content scan | 2 | Daily |
| Social scan | 3 total | Daily |
| Job scan | 2 | Weekly only |
| Alert reserve | 10 total | As needed |

## Workspace Structure

```
~/.openclaw/workspace/competitive-intel/
  config.json                           # Monitoring configuration
  snapshots/
    2026-02-22-competitorx-pricing.json # Page snapshots by date
    2026-02-22-competitorx-blog.json
  reports/
    daily-2026-02-22.txt               # Daily digests
    weekly-2026-02-22.txt              # Weekly reports
```

## Quality Rules

1. All data must include source URL and timestamp
2. Price comparisons: show old value, new value, % change, snapshot dates
3. Sentiment: always include sample size, not just percentages
4. Weekly reports: include strategic recommendations, not just data
5. Real-time alerts: include implications and suggested actions
6. Never hallucinate competitor details — only report what's in search results
7. Say "approximately" for any ranking data — search results are not precise
