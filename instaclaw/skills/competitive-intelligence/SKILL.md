# Competitive Intelligence & Market Research
```yaml
name: competitive-intelligence
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [competitor, competitive analysis, market research, industry analysis, competitor pricing, market trends, intel, surveillance, monitoring, sentiment]
  phrases: ["monitor competitors", "track the market", "competitive landscape", "what are competitors doing", "market research report", "industry trends", "watch competitor pricing", "crypto sentiment", "track mentions", "who are my competitors"]
  NOT: [internal analytics, our own metrics, user analytics, A/B test results]
```

## Overview

You are an always-on competitive intelligence analyst. You monitor competitors, track market trends, analyze sentiment, and deliver actionable briefings — daily digests, weekly deep-dives, and real-time alerts.

**Primary tool:** Brave Search API (required for 80% of this skill).
**Secondary tools:** web_fetch (full page reads), file system (historical snapshots).

Without Brave Search API configured, this skill is ~20% functional (limited to fetching known URLs).

## Prerequisites (on your VM)

- `BRAVE_SEARCH_API_KEY` in `~/.openclaw/.env` (platform-provided)
- Helper scripts: `~/scripts/competitive-intel.sh`, `~/scripts/competitive-intel.py`
- Workspace directory: `~/.openclaw/workspace/competitive-intel/`
- Heartbeat integration for scheduled scans

## Helper Scripts

### competitive-intel.sh — Brave Search API Client

```bash
# Web search
~/scripts/competitive-intel.sh search --query "CompetitorX announcement" --count 10
~/scripts/competitive-intel.sh search --query "site:competitor.com/blog" --freshness pd

# News search
~/scripts/competitive-intel.sh news --query "CompetitorX funding" --count 5

# Fetch and snapshot a page
~/scripts/competitive-intel.sh snapshot --url "https://competitor.com/pricing" --competitor CompetitorX --category pricing

# Rate limit status
~/scripts/competitive-intel.sh rate-status
```

### competitive-intel.py — Analysis Engine

```bash
# Generate daily digest
python3 ~/scripts/competitive-intel.py digest

# Generate weekly report
python3 ~/scripts/competitive-intel.py weekly-report

# Compare snapshots
python3 ~/scripts/competitive-intel.py compare --competitor CompetitorX --category pricing

# Scan all competitors (runs all workflows)
python3 ~/scripts/competitive-intel.py scan

# Initialize monitoring for a new competitor
python3 ~/scripts/competitive-intel.py init --competitor "CompetitorX" --domain "competitorx.com"
```

## Workflow 1: Competitor Monitoring Setup

When user says: "Monitor my competitors" or agent detects competitive context.

**STEP 1: Identify Competitors**
```
Agent: "Who are your main competitors? I'll set up daily monitoring."

If user provides names → proceed
If user unsure → Search "{user's product category} alternatives"
  and suggest top 5 competitors found
```

**STEP 2: Build Competitor Profile**
For each competitor, create a config in `~/.openclaw/workspace/competitive-intel/config.json`:
```json
{
  "competitors": [
    {
      "name": "CompetitorX",
      "domain": "competitorx.com",
      "urls": {
        "pricing": "https://competitorx.com/pricing",
        "blog": "https://competitorx.com/blog",
        "changelog": "https://competitorx.com/changelog",
        "careers": "https://competitorx.com/careers"
      },
      "search_queries": [
        "\"CompetitorX\" announcement",
        "site:twitter.com \"CompetitorX\"",
        "\"CompetitorX\" funding OR raised OR series"
      ],
      "social_handles": {
        "twitter": "@competitorx"
      },
      "priority": "primary"
    }
  ],
  "delivery": {
    "daily_digest": true,
    "daily_time": "08:00",
    "weekly_report": true,
    "weekly_day": "Sunday",
    "real_time_alerts": true
  }
}
```

**STEP 3: Create Baseline Snapshot**
Fetch all current data and store as day-zero:
```
~/.openclaw/workspace/competitive-intel/
  config.json
  snapshots/
    2026-02-22-competitorx.json
    2026-02-22-competitory.json
  reports/
    daily/
    weekly/
```

## Workflow 2: Daily Competitive Digest

Runs automatically every morning via heartbeat.

```
STEP 1: Price Check (2-3 API calls per competitor)
├── Fetch current pricing pages
├── Compare to stored snapshots
└── Flag any changes

STEP 2: Content Scan (1-2 API calls per competitor)
├── Search site:competitor.com/blog OR /changelog
├── Filter for new posts since last check
└── Summarize new content

STEP 3: Social Scan (2-3 API calls total)
├── Search for competitor mentions across platforms
├── Classify sentiment (positive/negative/neutral)
└── Identify trending complaints or praise

STEP 4: Job Scan (weekly only, 1-2 API calls per competitor)
├── Search LinkedIn/Indeed for company name
├── Compare to previous week
└── Analyze hiring signals (growth, expansion, pivots)

STEP 5: Assemble & Deliver
```

**Example daily digest:**
```
🔍 Daily Competitive Intel — Feb 22, 2026

🚨 URGENT
• CompetitorX raised Series B ($50M) — TechCrunch, 2h ago
• CompetitorY launched AI voice feature — their blog, 5h ago

💰 PRICING
• No changes detected across 3 competitors

📢 MENTIONS (24h)
• CompetitorX: 47 mentions (+12% vs yesterday)
  - Positive: 68% | Negative: 17% | Neutral: 15%
  - Top complaint: "Still no mobile app"

📝 CONTENT
• CompetitorZ published: "How to Build AI Agents" (est. 4k words)

⏱ Your scan time: 2 minutes
```

## Workflow 3: Weekly Deep-Dive Report

More strategic analysis, delivered Sunday evening:
- Executive summary (top 3 developments)
- Per-competitor deep-dives (funding, hiring, pricing, mentions, sentiment)
- Market trends (search volume changes, content themes)
- Pricing matrix comparison
- Strategic recommendations

## Workflow 4: Real-Time Alerts

Triggered immediately for critical changes:

**Critical (notify immediately):**
- Competitor funding announcement
- Major feature launch
- Significant price change (>10%)
- Competitor acquisition or merger
- Negative sentiment spike (>50%)
- Your company mentioned alongside competitor

**Informational (bundle into daily digest):**
- New blog post
- Minor price change
- New job posting
- App store review

**Alert format:**
```
🚨 ALERT: CompetitorX Funding

CompetitorX raised $50M Series B
Source: TechCrunch (15 min ago)

Implications:
• War chest for customer acquisition
• Likely pricing pressure in 3-6 months

Suggested actions:
• Review pricing strategy
• Lock in annual contracts with key customers
```

## Workflow 5: Crypto-Specific Intelligence

For users with crypto/web3 interests (detected from USER.md):

**What works with Brave Search:**
- Project announcements (Twitter/Medium/blogs) — 9/10
- Crypto Twitter sentiment — 8/10
- GitHub commit activity — 7/10 (via GitHub API)
- Partnership announcements — 8/10
- Conference appearances — 7/10

**What needs specialized APIs (not search):**

| Source | Feasibility | Better Tool |
|---|---|---|
| Token price movements | 5/10 | CoinGecko API (free) |
| Whale wallet activity | 2/10 | Etherscan/Nansen API |
| DEX volume changes | 4/10 | DexScreener API |
| On-chain metrics | 3/10 | The Graph, Dune Analytics |

**Recommended approach:** Hybrid — Brave Search for announcements/sentiment/content + crypto-specific APIs (CoinGecko, GitHub) for real-time data. Agent should have both capabilities.

**Crypto sentiment keywords:**
- Positive: "moon", "gem", "bullish", "buying", "accumulating", "undervalued", "based"
- Negative: "rug", "scam", "bearish", "selling", "dumping", "dead", "overvalued"

## Data Source Feasibility Matrix

| Intel Category | Feasibility | Method | Reliability |
|---|---|---|---|
| Competitor pricing changes | 8/10 | Fetch pricing pages, compare snapshots | HIGH |
| New feature launches | 9/10 | Search site:competitor.com/changelog | VERY HIGH |
| Job postings (hiring signals) | 7/10 | Search LinkedIn/Indeed | MEDIUM-HIGH |
| Social media mentions | 8/10 | Search site:twitter.com "CompanyName" | HIGH |
| Funding rounds | 9/10 | Search Crunchbase/TechCrunch | VERY HIGH |
| Content publishing frequency | 9/10 | Search site:competitor.com/blog | VERY HIGH |
| App Store reviews | 6/10 | Product Hunt via search | MEDIUM |
| SEO keyword rankings | 5/10 | Directional only, not precise | MEDIUM |
| Website traffic estimates | 3/10 | Requires SimilarWeb/Ahrefs | LOW |

## Data Storage

**Snapshot format** (`snapshots/YYYY-MM-DD-competitorname.json`):
```json
{
  "date": "2026-02-22",
  "competitor": "CompetitorX",
  "pricing": { "starter": 29, "pro": 99, "enterprise": "custom" },
  "social": { "twitter_mentions_7d": 89 },
  "content": { "blog_posts_30d": 8, "changelog_updates_30d": 3 },
  "hiring": { "open_positions": 7, "new_this_week": 2 }
}
```

**Comparison logic:** Load today's snapshot vs last week's snapshot, compute deltas for pricing, social, content, hiring. Report percentage changes.

### Phase 2: SQLite Database (If Scaling)

When snapshot count exceeds 100 files, migrate to SQLite for efficient querying:

```sql
CREATE TABLE competitor_snapshots (
  id INTEGER PRIMARY KEY,
  date DATE,
  competitor TEXT,
  category TEXT,  -- pricing, social, hiring, features
  data JSON,
  created_at TIMESTAMP
);

CREATE TABLE price_changes (
  id INTEGER PRIMARY KEY,
  date DATE,
  competitor TEXT,
  tier TEXT,
  old_price REAL,
  new_price REAL,
  change_pct REAL
);

-- "Show all CompetitorX price changes in Q1"
SELECT * FROM price_changes WHERE competitor = 'CompetitorX' AND date >= '2026-01-01';

-- "Average blog posts per month by competitor"
SELECT competitor, AVG(json_extract(data, '$.blog_posts_30d'))
FROM competitor_snapshots WHERE category = 'content' GROUP BY competitor;
```

**Migration path:** Start with JSON files → SQLite when data grows. Agent handles migration automatically when it detects >100 snapshot files in the snapshots directory.

## Rate Limiting & Budget

```
Brave Search calls:    30 per competitor/day (5 competitors = 150 total)
Web fetch calls:       20 per day
Total daily limit:     200 (hard cap)

Allocation per scan type:
  Price check:    3 per competitor
  Content scan:   2 per competitor
  Social scan:    3 total (batch queries)
  Job scan:       2 per competitor (weekly only)
  Alerts reserve: 10 for alert follow-ups
```

## Common Mistakes

1. **Over-alerting** — Only critical events (funding, major launches, price changes >10%) get real-time alerts. Everything else goes in the daily digest.
2. **Stale comparisons** — Always show the date of the last snapshot when reporting changes.
3. **Confusing correlation with causation** — Present data, don't speculate on connections unless evidence supports it.
4. **Ignoring rate limits** — 5 competitors x 10 queries = 50 API calls. Budget carefully. Job scans are weekly, not daily.
5. **Presenting search rankings as precise** — Say "approximately rank #8" not "rank #8."

## Quality Checklist

- [ ] All data includes source URL and timestamp
- [ ] Price comparisons show old + new values with percentage change
- [ ] Sentiment analysis includes sample size (not just percentages)
- [ ] Weekly report includes strategic recommendations
- [ ] Real-time alerts include "so what" implications and suggested actions
- [ ] Historical snapshots stored after every scan
- [ ] Rate limits respected — total API calls within daily budget
- [ ] Competitor data is accurate (no hallucinated company details)
- [ ] Delivery format matches user preference (Telegram/Discord/email)
