# X/Twitter Search
```yaml
name: x-twitter-search
version: 1.0.0
updated: 2026-03-02
author: InstaClaw
triggers:
  keywords: [twitter, tweet, x.com, tweets, trending, hashtag, viral, thread]
  phrases: ["search twitter", "search x", "find tweets", "what's trending on x", "latest tweets about", "check twitter for", "who tweeted", "twitter mentions", "x posts about"]
  NOT: [post to twitter, send tweet, tweet this, schedule tweet]
```

## Overview

You can search X/Twitter using the built-in `web_search` tool (Brave Search API) with `site:` filters. This gives you access to indexed tweets, threads, profiles, and trending discussions — no Twitter API key required.

**This is a read-only search skill.** You can find and read tweets but cannot post, like, retweet, or interact with Twitter accounts.

**Primary tool:** `web_search` (Brave Search API — already configured on your VM)
**Secondary tool:** `web_fetch` (for reading full thread pages when search snippets aren't enough)

## How It Works

Brave Search indexes public X/Twitter pages. By adding `site:x.com` or `site:twitter.com` to your search query, results are filtered to only return content from X/Twitter.

Both domains work — `x.com` is the current domain, `twitter.com` still resolves. Use both for maximum coverage.

## Search Patterns

### Pattern 1: Posts About a Topic

Find recent tweets discussing a specific subject.

```
User: "What are people saying about Claude 4 on Twitter?"

Search queries (run both):
  web_search("Claude 4 site:x.com", count=10, freshness="pw")
  web_search("Claude 4 site:twitter.com", count=10, freshness="pw")

Deliver:
  - Summarize the main opinions and reactions
  - Quote notable tweets with attribution (@username)
  - Note the sentiment balance (positive/negative/mixed)
  - Include direct links to interesting tweets
```

### Pattern 2: Posts from a Specific Account

Find tweets from a particular user.

```
User: "What has @elonmusk been posting about lately?"

Search queries:
  web_search("from:elonmusk site:x.com", count=10, freshness="pw")
  web_search("elonmusk site:x.com", count=10, freshness="pw")

Note: The "from:" operator may not always work via Brave indexing.
If "from:" returns poor results, fall back to searching the username directly.

Deliver:
  - List their recent posts chronologically
  - Summarize themes and topics
  - Note any posts with high engagement (if visible in snippets)
```

### Pattern 3: Trending Discussions

Discover what's currently trending or viral on X.

```
User: "What's trending on Twitter right now?"

Search queries:
  web_search("trending on twitter today site:x.com", freshness="pd")
  web_search("viral tweet today site:x.com", freshness="pd")
  web_search("twitter trending topics today", freshness="pd")

The third query (without site: filter) catches news articles ABOUT
Twitter trends, which are often more useful than individual tweets.

Deliver:
  - Top 5-10 trending topics with brief context
  - Notable viral posts
  - Links to representative tweets for each trend
```

### Pattern 4: Time-Filtered Search

Find tweets from a specific time period.

```
User: "What did people tweet about the Super Bowl last week?"

Search queries:
  web_search("Super Bowl site:x.com", count=15, freshness="pw")
  web_search("Super Bowl reactions site:twitter.com", count=10, freshness="pw")

Freshness values:
  "pd" = past day (24 hours)
  "pw" = past week
  "pm" = past month

Note: Brave Search freshness is approximate. For precise date ranges,
mention the date in the query itself:
  web_search("Super Bowl February 2026 site:x.com")
```

### Pattern 5: Combined Filters

Combine multiple search operators for precise results.

```
User: "Find tweets from AI researchers about GPT-5 this month"

Search queries:
  web_search("GPT-5 AI researcher site:x.com", count=15, freshness="pm")
  web_search("GPT-5 \"machine learning\" site:x.com", count=10, freshness="pm")
  web_search("GPT-5 announcement site:twitter.com", count=10, freshness="pm")

Operator reference:
  "exact phrase"     — Match exact text
  word1 OR word2     — Match either term
  -word              — Exclude a term
  site:x.com         — Only X/Twitter results

Examples:
  "OpenAI" GPT-5 -rumors site:x.com
  (crypto OR bitcoin) announcement site:x.com
  "breaking news" AI site:x.com -bot -spam
```

### Pattern 6: Hashtag Search

Find posts using a specific hashtag.

```
User: "Show me tweets with #BuildInPublic"

Search queries:
  web_search("#BuildInPublic site:x.com", count=15, freshness="pw")
  web_search("BuildInPublic site:x.com", count=10, freshness="pw")

Search both with and without the # symbol — Brave may index either form.
```

### Pattern 7: Conversation and Thread Discovery

Find Twitter threads and discussions.

```
User: "Find good Twitter threads about startup fundraising"

Search queries:
  web_search("startup fundraising thread site:x.com", count=15)
  web_search("startup fundraising \"a thread\" site:x.com", count=10)
  web_search("startup fundraising tips site:x.com", count=10)

When you find a promising thread:
  web_fetch("https://x.com/username/status/1234567890")

  Use web_fetch to read the full thread content if the search snippet
  only shows the first tweet.
```

### Pattern 8: Monitoring Brand/Company Mentions

Track what people are saying about a specific brand.

```
User: "What are people saying about Stripe on Twitter?"

Search queries:
  web_search("Stripe site:x.com", count=15, freshness="pw")
  web_search("Stripe payments site:x.com", count=10, freshness="pw")
  web_search("@stripe site:x.com", count=10, freshness="pw")

Deliver:
  - Overall sentiment summary
  - Common praise points
  - Common complaints
  - Notable posts from verified accounts or industry figures
  - Comparison to competitor mentions if relevant
```

## Freshness Quick Reference

| Filter | Meaning | Best For |
|--------|---------|----------|
| `freshness="pd"` | Past 24 hours | Breaking news, today's viral content |
| `freshness="pw"` | Past 7 days | Recent discussions, weekly trends |
| `freshness="pm"` | Past 30 days | Broader sentiment, monthly roundups |
| _(omit)_ | All time | Historical tweets, evergreen content |

## Best Practices

1. **Always run two queries** — one with `site:x.com` and one with `site:twitter.com`. Brave indexes both domains and results may differ.

2. **Use freshness filters** — Without them, you'll get old results mixed with new. Default to `"pw"` (past week) unless the user specifies otherwise.

3. **Quote tweets with attribution** — Always include the @username when quoting. Format: `"Tweet text" — @username`

4. **Acknowledge limitations upfront** — Tell the user this searches indexed content, not the live firehose. Some very recent tweets (minutes old) may not appear yet.

5. **Follow up with web_fetch** — If a search result links to an interesting thread, use `web_fetch` on the full URL to get the complete content.

6. **Don't fabricate tweets** — Only report tweets that appear in your search results. Never invent tweet text or attribute fake quotes to real accounts.

7. **Note engagement when visible** — If Brave snippets show reply counts, retweets, or likes, include them. But don't guess engagement numbers.

8. **Cross-reference with news** — For trending topics, also search without `site:x.com` to get news coverage that provides context for the Twitter conversation.

## Known Limitations

- **Not real-time** — Brave indexes X/Twitter pages with a delay (minutes to hours). Very fresh tweets may not appear.
- **No structured metadata** — You get tweet text and URLs, not like counts, retweet counts, or follower numbers.
- **No reply threads** — Search returns individual tweets, not full conversation threads. Use `web_fetch` on the tweet URL for thread context.
- **No DMs or protected accounts** — Only public tweets are indexed.
- **Rate limits** — Shared with other web_search uses. Budget ~20 searches per X/Twitter research task.
- **from: operator** — May not work consistently via Brave. Fall back to searching the username as plain text.
- **Brave site: is experimental** — The `site:` operator is documented by Brave as experimental. If results seem incomplete, try the query without `site:` and scan for x.com/twitter.com URLs in general results.

## Quality Checklist

- [ ] Used both `site:x.com` and `site:twitter.com` for coverage
- [ ] Applied appropriate freshness filter
- [ ] Quoted tweets with @username attribution
- [ ] Included direct links to notable tweets
- [ ] Summarized sentiment (not just listed tweets)
- [ ] Disclosed this is indexed search, not live firehose
- [ ] Did not fabricate or hallucinate tweet content
- [ ] Followed up with web_fetch for full threads when needed
