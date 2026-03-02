# X/Twitter Search
```yaml
name: x-twitter-search
version: 3.0.0
updated: 2026-03-02
author: InstaClaw
triggers:
  keywords: [twitter, tweet, x.com, tweets, trending, hashtag, viral, thread]
  phrases: ["search twitter", "search x", "find tweets", "what's trending on x", "latest tweets about", "check twitter for", "who tweeted", "twitter mentions", "x posts about"]
  NOT: [post to twitter, send tweet, tweet this, schedule tweet]
```

## Overview

You can search X/Twitter using the Twitter API v2 directly from your VM. This gives you real-time access to tweets from the last 7 days with full engagement metrics, author info, and direct links.

**This is a read-only search skill.** You can find and read tweets but cannot post, like, retweet, or interact with Twitter accounts.

**How it works:** Your VM calls the Twitter API v2 directly using your own `TWITTER_BEARER_TOKEN` environment variable.

## Setup Check

Before making any Twitter API call, check that the token is set:

```bash
TWITTER_BEARER_TOKEN=$(grep TWITTER_BEARER_TOKEN ~/.openclaw/.env | cut -d= -f2)
if [ -z "$TWITTER_BEARER_TOKEN" ]; then
  echo "TWITTER_BEARER_TOKEN not set"
fi
```

### If `TWITTER_BEARER_TOKEN` is not set

Tell the user:

> Your Twitter API key isn't configured yet. To enable X/Twitter search:
>
> 1. Go to your **InstaClaw dashboard → Environment Variables** and add `TWITTER_BEARER_TOKEN`
> 2. To get a key: go to [developer.x.com](https://developer.x.com), create a Project, create an App, then generate a **Bearer Token** under "Keys and Tokens"
> 3. Note: X Basic API tier costs $200/mo and includes 10,000 tweet reads/month
>
> Once added, the token syncs to your VM automatically.

Then stop — do not attempt the search.

## How to Search

```bash
TWITTER_BEARER_TOKEN=$(grep TWITTER_BEARER_TOKEN ~/.openclaw/.env | cut -d= -f2)
curl -s "https://api.x.com/2/tweets/search/recent?query=AI%20agents%20-is%3Aretweet&max_results=10&tweet.fields=text,created_at,author_id,public_metrics,entities,note_tweet,referenced_tweets,in_reply_to_user_id&expansions=author_id&user.fields=username,name,profile_image_url,verified,public_metrics" \
  -H "Authorization: Bearer $TWITTER_BEARER_TOKEN"
```

### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Twitter search query (1-512 chars). Supports Twitter v2 operators. |
| `max_results` | No | Results to return (10-100, default 10) |
| `sort_order` | No | `"recency"` (default) or `"relevancy"` |
| `tweet.fields` | No | Comma-separated fields: `text,created_at,author_id,public_metrics,entities,note_tweet,referenced_tweets,in_reply_to_user_id` |
| `expansions` | No | `author_id` to include user data |
| `user.fields` | No | `username,name,profile_image_url,verified,public_metrics` |

### Response Format

```json
{
  "data": [
    {
      "id": "1234567890123456789",
      "text": "Full tweet text...",
      "author_id": "12345",
      "created_at": "2026-03-01T18:40:40.000Z",
      "public_metrics": {
        "like_count": 42,
        "retweet_count": 5,
        "reply_count": 2,
        "quote_count": 1
      }
    }
  ],
  "includes": {
    "users": [
      {
        "id": "12345",
        "username": "exampleuser",
        "name": "Example User",
        "verified": false,
        "public_metrics": {
          "followers_count": 1500
        }
      }
    ]
  },
  "meta": {
    "result_count": 10,
    "newest_id": "...",
    "oldest_id": "..."
  }
}
```

To build tweet URLs: `https://x.com/{username}/status/{tweet_id}`

## Twitter v2 Query Operators

Use these in the `query` parameter to refine your search:

| Operator | Description | Example |
|----------|-------------|---------|
| `from:username` | Tweets from a specific user | `from:elonmusk` |
| `to:username` | Replies to a user | `to:OpenAI` |
| `-is:retweet` | Exclude retweets (recommended) | `AI agents -is:retweet` |
| `is:reply` / `-is:reply` | Filter replies in or out | `from:sama -is:reply` |
| `has:media` | Tweets with images/video | `AI art has:media` |
| `has:links` | Tweets with URLs | `startup funding has:links` |
| `lang:en` | Language filter | `trending lang:en` |
| `"exact phrase"` | Exact match | `"GPT-5 release"` |
| `(A OR B)` | Boolean OR | `(crypto OR bitcoin)` |
| `-word` | Exclude a term | `AI -spam -bot` |
| `#hashtag` | Hashtag search | `#BuildInPublic` |
| `conversation_id:ID` | Tweets in a thread | `conversation_id:123456` |

## Search Patterns

### Pattern 1: Topic Search
Find tweets about a subject.

```
User: "What are people saying about Claude 4 on Twitter?"

Query: Claude 4 -is:retweet lang:en
max_results: 15

Deliver:
  - Summarize the main opinions and reactions
  - Quote notable tweets with attribution (@username)
  - Note the sentiment balance (positive/negative/mixed)
  - Include direct x.com links to interesting tweets
```

### Pattern 2: Account Search
Find tweets from a specific user.

```
User: "What has @elonmusk been posting about lately?"

Query: from:elonmusk
max_results: 15

Deliver:
  - List their recent posts chronologically
  - Summarize themes and topics
  - Include engagement metrics (likes, retweets)
```

### Pattern 3: Trending Discussions
Find what's getting traction.

```
User: "What's trending in AI on Twitter?"

Query: AI trending -is:retweet lang:en
sort_order: relevancy
max_results: 15

Deliver:
  - Top topics with brief context
  - Notable viral posts with engagement numbers
  - Links to representative tweets
```

### Pattern 4: Combined Filters
Mix operators for precise results.

```
User: "Find tweets from AI researchers about GPT-5"

Query: GPT-5 (AI OR "machine learning") -is:retweet lang:en
max_results: 15

Deliver:
  - Key insights and opinions
  - Quote high-engagement tweets
  - Summarize the overall narrative
```

### Pattern 5: Hashtag Search
Find posts using a specific hashtag.

```
User: "Show me tweets with #BuildInPublic"

Query: #BuildInPublic -is:retweet
max_results: 15

Deliver:
  - Interesting projects being built in public
  - High-engagement posts
  - Themes and trends in the hashtag
```

### Pattern 6: Brand Monitoring
Track mentions of a company or product.

```
User: "What are people saying about Stripe on Twitter?"

Query: Stripe OR @stripe -is:retweet
max_results: 15

Deliver:
  - Overall sentiment summary
  - Common praise and complaints
  - Notable posts from verified/industry accounts
```

### Pattern 7: Conversation Thread
Follow a specific thread or conversation.

```
User: "Show me the full thread from this tweet"

Query: from:username conversation_id:1234567890123456789
max_results: 25

Deliver:
  - Thread content in order
  - Key points from the author
  - Notable replies if applicable
```

### Pattern 8: Media Posts
Find tweets with images or video.

```
User: "Find AI art being shared on Twitter"

Query: AI art has:media -is:retweet
max_results: 15

Deliver:
  - Describe the media content from the tweet text
  - Include x.com links so user can view the media
  - Note engagement levels
```

## Rate Limits

These are your own API limits based on your X developer tier:

| Tier | Requests / 15 min | Tweet reads / month | Cost |
|------|-------------------|---------------------|------|
| Basic | 450 | 10,000 | $200/mo |
| Pro | 450 | 1,000,000 | $5,000/mo |

If you get a 429 response, check the `retry-after` header and wait before retrying.

## Best Practices

1. **Use `-is:retweet` by default** — Removes duplicates, gives you more unique content per search.

2. **Quote tweets with attribution** — Always include the @username when quoting. Format: `"Tweet text" — @username`

3. **Include engagement metrics** — The API returns likes, retweets, replies, and quotes. Use them to highlight popular takes.

4. **Include direct links** — Build tweet URLs as `https://x.com/{username}/status/{tweet_id}`. Include x.com links to notable tweets.

5. **Don't fabricate tweets** — Only report tweets that appear in your search results. Never invent tweet text or attribute fake quotes to real accounts.

6. **Use `sort_order=relevancy`** for discovery — When the user wants popular/important tweets rather than the most recent.

7. **Combine operators** — Stack `from:`, `-is:retweet`, `lang:en`, `has:media` etc. for precise results.

8. **URL-encode the query** — When building the curl URL, ensure special characters in the query are percent-encoded (spaces → `%20`, colons → `%3A`, etc.).

## Known Limitations

- **7-day window** — Twitter API v2 search/recent only covers the last 7 days. Older tweets are not available.
- **No DMs or protected accounts** — Only public tweets are searchable.
- **Read-only** — Cannot post, like, retweet, or follow.
- **No media content** — You get tweet text and metadata, not image/video files. Link the user to x.com for media viewing.
- **Rate limits are yours** — You are using the user's own API quota. Be mindful of monthly read caps.

## Error Handling

| HTTP Status | Meaning | What to Do |
|-------------|---------|------------|
| 400 | Bad request / invalid query | Check query syntax and encoding |
| 401 | Unauthorized | Token is invalid or expired — tell user to check their TWITTER_BEARER_TOKEN |
| 403 | Forbidden | Token lacks permissions or tier doesn't support this endpoint |
| 429 | Rate limited | Wait for `retry-after` seconds, then retry |
| 503 | Service unavailable | Twitter is having issues — retry in a few minutes |

## Quality Checklist

- [ ] Checked `TWITTER_BEARER_TOKEN` is set before calling
- [ ] Used `-is:retweet` to filter noise
- [ ] Quoted tweets with @username attribution
- [ ] Included direct x.com links to notable tweets
- [ ] Reported engagement metrics (likes, retweets)
- [ ] Summarized sentiment (not just listed tweets)
- [ ] Did not fabricate or hallucinate tweet content
