# Social Media Content Engine
```yaml
name: social-media-content
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [social media, tweet, thread, LinkedIn post, Instagram caption, Reddit post, content calendar, social content, hashtags, engagement, trending]
  phrases: ["write a tweet", "create a thread", "LinkedIn post about", "social media calendar", "content for this week", "what should I post", "trending topics", "write a Reddit post"]
  NOT: [social media analytics, follower count, social login, social API key setup]
```

## Overview

You are a content team. You generate platform-native content — threads, posts, captions — adapted to each platform's culture, format, and audience expectations. You manage content calendars, detect trends (with Brave Search), and schedule posting via heartbeat/cron.

**Current reality:** You can generate excellent content for any platform. Actual posting depends on API access:
- **Reddit:** Works today (browser or OAuth, bot-friendly if disclosed)
- **Twitter/X:** Needs API key ($100/mo) — generate + queue for manual posting
- **LinkedIn:** Needs API registration — generate + queue for manual posting
- **Instagram/TikTok:** No viable posting path — generate captions only

## Prerequisites (on your VM)

- Helper scripts: `~/scripts/social-content.py`
- Workspace: `~/.openclaw/workspace/social-content/`
- Brave Search API (optional, for trend detection — check `~/.openclaw/.env`)
- User voice profile in USER.md (optional, improves quality)

## Helper Scripts

### social-content.py — Content Engine

```bash
# Generate content for a platform
python3 ~/scripts/social-content.py generate --platform twitter --topic "AI agents earning revenue" --type thread
python3 ~/scripts/social-content.py generate --platform linkedin --topic "New feature launch" --type update
python3 ~/scripts/social-content.py generate --platform reddit --topic "Building an AI agent platform" --subreddit artificial

# Content calendar
python3 ~/scripts/social-content.py calendar --action show                    # Show this week
python3 ~/scripts/social-content.py calendar --action add --platform twitter --topic "Topic" --day Monday --time "10:00"
python3 ~/scripts/social-content.py calendar --action draft --id 1            # Generate draft for calendar item

# Humanize content (anti-AI filter)
python3 ~/scripts/social-content.py humanize --input "content to humanize"

# Detect trending topics (requires Brave Search)
python3 ~/scripts/social-content.py trends --industry "AI agents"
```

## Platform Access Matrix

| Platform | Generate | Post | Method | Status |
|---|---|---|---|---|
| Reddit | ✅ | ✅ | Browser or OAuth | Tier 1 — works now |
| LinkedIn | ✅ | ⚠️ | API (needs registration) | Tier 2 — with API key |
| Twitter/X | ✅ | ❌ | API ($100/mo Basic) | Tier 2 — with API key |
| Instagram | ✅ | ❌ | Mobile-only | Tier 3 — generate only |
| TikTok | ✅ | ❌ | Mobile-only | Tier 3 — generate only |

## Content Quality Ratings

| Content Type | Quality | Notes |
|---|---|---|
| Twitter/X thread (technical) | 7/10 | Good structure, needs personality injection |
| LinkedIn company update | 8/10 | Specific numbers, professional tone |
| Blog post / article draft | 8/10 | Specific examples, transparent |
| Reddit post | 7/10 | Conversational, needs subreddit adaptation |
| Newsletter copy | 7/10 | Punchy opening, clear CTA |
| Instagram caption + hashtags | 5/10 | Generic — visual medium limits text value |

## Workflow 1: Content Generation

### STEP 1: Understand Voice

Before generating content, analyze the user's existing writing to learn their voice. Store in USER.md:
```yaml
voice_profile:
  tone: "casual-technical"
  emoji: "moderate"
  sentence_style: "mix-short-long"
  opinion: "bold-with-data"
  vocabulary: "industry-specific"
  contractions: "always"
  anecdotes: "frequent"
```

If no voice profile exists, ask the user for 3-5 past posts/tweets to analyze.

### STEP 2: Generate Platform-Native Content

Each platform has different culture:
```
Platform Rules:
├── Twitter/X: Short sentences, line breaks, emoji but not every line, casual, typos okay
├── LinkedIn: More formal, longer paragraphs, 3-5 hashtags, professional-warm
├── Reddit: Conversational, self-deprecating, specific details, sources, edit notes
├── Instagram: Visual-first copy, heavy emoji, 20-30 hashtags, aspirational
└── Blog: Long-form, headers, specific examples, transparent about AI authorship
```

### STEP 3: Anti-ChatGPT Filter (MANDATORY)

Every piece of content MUST run through the humanization filter. If you can tell it's AI-written, the skill failed.

**Kill generic openings:**
- "In today's fast-paced world" → DELETE
- "It's no secret that" → DELETE
- "As we all know" → DELETE
- "In the ever-evolving landscape" → DELETE

**Kill overused AI words:**
- "game-changer" → "shift"
- "unlock" → "find"
- "leverage" → "use"
- "synergy" → DELETE
- "paradigm" → DELETE
- "utilize" → "use"
- "facilitate" → "help"
- "groundbreaking" → "new"

**Force contractions:** "do not" → "don't", "it is" → "it's", "I am" → "I'm", "cannot" → "can't"

**Require specifics over generics:**
```
❌ "AI agents are transforming how we work"
✅ "I watched an AI agent earn $400 last week doing data analysis bounties"

❌ "This is a game-changer for productivity"
✅ "I saved 8 hours this week because my agent handles email triage"

❌ "Leverage AI to unlock new opportunities"
✅ "My agent found 3 competitor price changes I would've missed"
```

**Include authenticity markers:**
- A specific example with numbers (always)
- A mistake or failure (Reddit especially loves this)
- Something that surprised you (shows learning)
- A genuine question (shows curiosity, not just broadcasting)

## Workflow 2: Content Calendar Management

Maintain a rolling content calendar at `~/.openclaw/workspace/social-content/calendar.json`:

```json
{
  "week_of": "2026-02-24",
  "posts": [
    {
      "id": 1,
      "platform": "twitter",
      "scheduled": "Monday 10:00",
      "type": "thread",
      "topic": "AI agents earning revenue — 60-day update",
      "status": "drafted",
      "content": "...",
      "approval_required": true
    }
  ]
}
```

**Status flow:** `pending_draft` → `drafted` → `approved` → `posted` / `failed`

**Weekly planning notification (Sunday evening):**
```
📅 Content Calendar — Week of Feb 24

Monday 10am — Twitter Thread
"AI Agents Earning Revenue: 60-Day Update"
Status: Draft ready for review
[Review] [Approve] [Reschedule]

Tuesday 8am — LinkedIn Update
"New Feature: Voice & Audio for All Agents"
Status: Needs draft
[Generate Draft] [Skip]

Wednesday 12pm — Reddit Post (r/artificial)
"How I Built an Autonomous AI Agent Platform"
Status: Auto-approved
[Review Anyway] [Let It Post]

Total posts this week: 3
Approval needed: 2
Auto-posting: 1
```

## Workflow 3: Trend-Jacking (Requires Brave Search)

1. **Detect** — Search for trending topics in user's industry (every 2 hours via heartbeat)
2. **Filter** — Is it relevant? Have we already posted? Do we have a unique angle?
3. **Generate** — Create platform-native content with user's voice
4. **Post or Queue** — Auto-post if allowed, otherwise queue for approval

Full cycle: 2-4 hours from trend detection to posted content.

## Workflow 4: Scheduled Posting via Heartbeat

Optimal posting times (defaults, agent learns from engagement data):
```
Twitter:  9am, 12pm, 5pm
LinkedIn: 8am, 12pm, 4pm
Reddit:   10am, 2pm, 8pm
```

Agent checks content calendar during each heartbeat cycle, posts approved content at scheduled times.

## Platform-Specific Templates

### Twitter/X Thread
```
1/ [Hook — surprising stat or controversial take]

2/ [Context — what's happening and why it matters]

3/ [Your experience — specific examples with numbers]
• Bullet with data point
• Bullet with data point

4/ [Insight — what you learned that others haven't]

5/ [CTA — question that drives engagement]

What would you do? 👇
```

### LinkedIn Post
```
[Bold opening statement — 1 line, no fluff]

[2-3 sentence context paragraph]

Here's what I've learned:

→ [Insight 1 with specific number]
→ [Insight 2 with specific number]
→ [Insight 3 with specific number]

[1-2 sentence takeaway]

[Question for engagement]

#Hashtag1 #Hashtag2 #Hashtag3
```

### Reddit Post
```
Title: [Specific, descriptive, no clickbait]

Hey r/[subreddit],

[1 paragraph context — who you are, what you built]

[2-3 paragraphs of substance — details, numbers, lessons]

[What went wrong / what surprised you — Reddit loves honesty]

[Ask for community input]

---
Disclosure: [agent name] is an AI agent. This post was reviewed by a human.
```

## Content Autonomy Rules

**Auto-post allowed:**
- Reddit (to pre-approved subreddits, max 2/day, disclosure required)

**Always require approval:**
- Twitter/X (default off — high reputation risk)
- LinkedIn (default off — professional risk)
- Cold outreach posts
- Controversial topics
- Posts mentioning competitors by name
- Posts with financial claims
- First post on any new platform

**Never auto-post:**
- Political content
- Content claiming human authorship (always disclose AI)
- Posts with unverified claims
- Posts to unapproved subreddits

## Common Mistakes

1. **Posting the same content to all platforms** — Each platform has different culture. A LinkedIn post on Reddit gets roasted. Generate platform-native content.
2. **Over-posting** — 3 excellent posts/week beats 3 mediocre posts/day. Quality over quantity.
3. **Forgetting AI disclosure** — Always be transparent, especially on Reddit.
4. **Generic hashtags** — `#AI #Innovation #FutureOfWork` screams automated. Use niche-specific hashtags.
5. **Ignoring engagement** — Posting is half the job. Monitor and respond for 2-4 hours after posting.
6. **Not learning from performance** — Track engagement data. Adjust calendar based on what works.

## Quality Checklist

- [ ] Content matches user's voice profile (not generic AI tone)
- [ ] Anti-ChatGPT filter applied (no banned phrases, contractions, specifics over generics)
- [ ] Platform-native formatting (not cross-posted copypaste)
- [ ] Includes specific examples with real numbers
- [ ] AI disclosure included where appropriate (especially Reddit)
- [ ] Hashtags are niche-specific, not generic
- [ ] Scheduled at optimal time for platform
- [ ] Approval workflow triggered for high-risk content
- [ ] Content calendar updated after posting
