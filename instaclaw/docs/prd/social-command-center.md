# PRD: Social Command Center + InstaAgent Skill for InstaClaw

**Author:** Cooper Wrenn / Claude
**Date:** March 14, 2026
**Status:** Draft
**Priority:** P0 — High-demand feature, competitive differentiator

---

## 1. Vision

Every InstaClaw agent should be capable of operating as a fully autonomous social media creator and manager. Users should be able to:

1. **Manage their own social accounts** — Agent handles DMs, comments, posting, engagement, and analytics for the user's existing accounts
2. **Create an agent persona** — Agent gets its own social accounts with its own personality, voice, aesthetic, and content strategy — running autonomously like a real creator
3. **See everything in one place** — A Social Command Center in the dashboard where users manage, monitor, and control their agent's social presence across all platforms

This is not just DM automation. This is giving every InstaClaw user a full-time AI social media manager that creates content, engages audiences, grows followers, and reports back with analytics — across Instagram, X/Twitter, TikTok, YouTube, and more.

---

## 2. Problem Statement

InstaClaw agents cannot interact with social platforms programmatically. Browser automation (CDP) is explicitly blocked by Instagram and most major platforms. Meanwhile, tools like ManyChat ($15-65/mo), CreatorFlow ($15/mo), Hootsuite ($99/mo), and Buffer ($6-120/mo) handle pieces of social media management using official APIs.

Users currently need 3-5 separate tools to manage their social presence. Each costs money, requires separate setup, and none of them have AI that actually understands the user's business, voice, or goals.

InstaClaw should replace all of them with one agent.

---

## 3. Architecture Overview: Social Command Center

### 3.1 Dashboard — Social Command Center (`/social`)

A new top-level section in the InstaClaw dashboard accessible from the nav bar. This is the control room for everything social.

**Pages:**

| Page | URL | Purpose |
|------|-----|---------|
| Overview | `/social` | Cross-platform analytics dashboard — followers, engagement rate, DM volume, post performance, agent activity feed |
| Accounts | `/social/accounts` | Connect/disconnect social accounts. Shows status, permissions, token health for each platform |
| Content | `/social/content` | Content calendar view — scheduled posts, published posts, drafts. Agent can auto-populate or user can manually add |
| Conversations | `/social/conversations` | Unified inbox — DMs from all platforms in one view. See what the agent replied, override if needed |
| Triggers | `/social/triggers` | Keyword triggers, auto-reply rules, comment-to-DM configs across platforms |
| Persona | `/social/persona` | Agent persona configuration — name, bio, voice/tone, aesthetic, content pillars, posting schedule. For users who want their agent to run its own accounts |
| Analytics | `/social/analytics` | Deep analytics — follower growth, engagement trends, best posting times, top content, audience demographics |

### 3.2 Platform Integrations

Each platform is a separate integration with its own OAuth, webhooks, and API layer:

| Platform | API | Status | Posting | DMs | Comments | Analytics | Cost |
|----------|-----|--------|---------|-----|----------|-----------|------|
| **Instagram** | Graph API + Messenger Platform | **Phase 1 (Now)** | Yes (photos, reels, stories) | Yes (24hr window) | Yes | Yes | Free (app review required) |
| **X/Twitter** | X API v2 | **Phase 2** | Yes (1,500/mo free, unlimited at $200/mo) | Yes | Yes (replies) | Limited on free | Free tier: write-only, 1,500 posts/mo. Basic: $200/mo |
| **TikTok** | Content Posting API | **Phase 3** | Yes (videos) | Limited | Yes | Yes | Free (app review required) |
| **YouTube** | YouTube Data API v3 | **Phase 4** | Yes (videos, shorts, community) | No (no DM API) | Yes | Yes | Free (quota-based) |
| **LinkedIn** | Marketing API | **Phase 5** | Yes (posts, articles) | Limited | Yes | Yes | Free (app review required) |
| **Facebook** | Graph API | **Phase 5** | Yes | Yes (via Messenger) | Yes | Yes | Bundled with Instagram integration |

### 3.3 Skill Architecture

One meta-skill orchestrates platform-specific sub-skills:

```
Social Command Center (meta-skill / dashboard)
├── InstaAgent (Instagram Graph API)
│   ├── instagram-send-dm.py
│   ├── instagram-reply-comment.py
│   ├── instagram-private-reply.py
│   ├── instagram-publish-post.py
│   ├── instagram-publish-reel.py
│   ├── instagram-publish-story.py
│   ├── instagram-get-conversations.py
│   ├── instagram-get-messages.py
│   ├── instagram-get-insights.py
│   └── instagram-get-media.py
├── XAgent (X/Twitter API v2) — Phase 2
│   ├── x-post-tweet.py
│   ├── x-reply-tweet.py
│   ├── x-send-dm.py
│   ├── x-get-mentions.py
│   ├── x-get-timeline.py
│   └── x-get-analytics.py
├── TikTokAgent — Phase 3
├── YouTubeAgent — Phase 4
└── LinkedInAgent — Phase 5
```

### 3.4 Agent Persona System

```json
{
  "persona_name": "TechLobster",
  "bio": "AI agent built on InstaClaw. Reviews tech, trades crypto, vibes.",
  "voice": "casual, witty, slightly sarcastic. uses lowercase. never uses emojis excessively.",
  "aesthetic": "dark mode, neon accents, minimal",
  "content_pillars": ["AI news", "crypto analysis", "tech reviews", "behind-the-scenes of being an AI agent"],
  "posting_schedule": {
    "instagram": { "posts_per_week": 5, "stories_per_day": 2, "best_times": ["9am", "12pm", "6pm"] },
    "x": { "tweets_per_day": 3, "threads_per_week": 2 }
  },
  "engagement_rules": {
    "reply_to_comments": true,
    "reply_to_dms": true,
    "follow_back": false,
    "like_mentions": true
  },
  "content_generation": {
    "use_director_skill": true,
    "use_brand_design": true,
    "use_voice_audio": false,
    "preferred_video_model": "seedance-2.0"
  }
}
```

The agent reads this persona config on every social interaction and content creation task. It informs SOUL.md-level behavior when operating social accounts — the agent literally becomes the persona.

**Autonomous Creator Loop (Heartbeat-driven):**
```
Every heartbeat cycle (configurable, e.g., every 6 hours):
1. Check content calendar — is a post due?
2. If yes → generate content using creative skills (Director, Brand Design, etc.)
3. Publish to connected platforms via API
4. Check notifications — new DMs, comments, mentions
5. Respond using persona voice
6. Check analytics — what performed well?
7. Adjust future content strategy based on performance
8. Report summary to user via Telegram
```

---

## 4. Phase 1 Deep Dive: InstaAgent (Instagram Graph API)

*The rest of this section focuses on the Instagram integration as the first platform. Other platforms follow the same architecture pattern.*

### 4.1 Critical Technical Constraints

These are non-negotiable rules from Meta's platform. Violating any of them risks app suspension or user account bans.

#### 4.1.1 Account Requirements
- **Only Instagram Business or Creator accounts** — personal accounts are NOT supported
- **Must be linked to a Facebook Page** — this is required by Meta's API infrastructure
- The Instagram DM API is built on the **Messenger Platform** infrastructure, not the Graph API directly

#### 4.1.2 Messaging Rules
- **24-hour messaging window** — automated responses are ONLY allowed within 24 hours of the user's last message to the business account
- **No unsolicited DMs** — automation must start from a user-initiated action (comment, story reply, DM, or ad click)
- **Human Agent tag** — after the 24-hour window closes, only a "Human Agent" message tag can be used, and only for genuine customer support (not marketing)
- **No bulk/mass messaging** — every message must be contextually relevant to a user interaction

#### 4.1.3 Rate Limits (2026)
- **200 automated DMs per hour** per account (down from 5,000 in 2025 — 96% reduction)
- Standard Graph API call limits based on app tier
- Must implement **smart pacing and queueing** — bursts during viral moments will hit the ceiling fast
- Rate limit violations result in temporary message throttling, not bans (if using official API)

#### 4.1.4 Required Permissions (Scopes)

**New mandatory scopes (since Jan 27, 2025):**

| Permission | Purpose | Access Level Needed |
|-----------|---------|-------------------|
| `instagram_business_basic` | Read basic profile and media data | Standard |
| `instagram_business_manage_messages` | Read and send DMs, manage conversations | **Advanced** (requires app review) |
| `instagram_business_manage_comments` | Read and reply to comments, hide/delete comments | Standard |

**Legacy scopes (deprecated Jan 27, 2025 — do NOT use):**
- `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`
- `pages_manage_metadata`, `pages_show_list`, `pages_messaging`

#### 4.1.5 Meta App Review
- **Timeline: 2-6 weeks** for approval
- Requires: working screencast demo, privacy policy URL, detailed use case description
- `instagram_business_manage_messages` specifically requires **Advanced Access** — this is the longest review
- App must be set to **Live** mode (not Development) for production use
- Must demonstrate a clear, non-spammy use case

#### 4.1.6 Token Management
- **Short-lived tokens** expire in ~1 hour
- **Long-lived tokens** last ~60 days
- Must implement automatic token refresh before expiration
- Store tokens encrypted in Supabase
- Authorization endpoint: `https://www.instagram.com/oauth/authorize`
- Token exchange: `https://api.instagram.com/oauth/access_token`
- Long-lived exchange: `https://graph.instagram.com/access_token`
- Token refresh: `https://graph.instagram.com/refresh_access_token`

### 4.2 Authentication Flow

```
User clicks "Connect Instagram" in Social Command Center or Settings
  → Redirect to Instagram OAuth consent screen (www.instagram.com/oauth/authorize)
  → User grants permissions (instagram_business_basic, instagram_business_manage_messages, etc.)
  → Instagram redirects back with authorization code
  → Backend exchanges code for short-lived User Access Token (api.instagram.com/oauth/access_token)
  → Backend exchanges for long-lived User Access Token (~60 days) (graph.instagram.com/access_token)
  → Backend fetches Instagram user profile (user_id, username)
  → Store encrypted token + account info in Supabase
  → Subscribe to webhooks (messages, comments, story mentions)
  → Mark integration as "connected" in dashboard
```

### 4.3 Webhook Architecture

Meta sends real-time events to our webhook endpoint when:
- Someone DMs the business account
- Someone comments on a post
- Someone replies to a story
- Someone mentions the account in a story
- Messages are read or deleted

```
Instagram event occurs
  → Meta sends POST to https://instaclaw.io/api/webhooks/instagram
  → Webhook endpoint verifies signature (X-Hub-Signature-256 header using App Secret)
  → Parses event type and extracts sender ID, message content, metadata
  → Looks up which InstaClaw user owns this Instagram account (via Supabase)
  → Forwards the event to the user's VM via gateway proxy
  → Agent processes the event and decides how to respond
  → Agent calls instagram-send-dm.py or instagram-reply-comment.py
  → Script makes API call to Meta with the Access Token
  → Response delivered to the Instagram user
```

### 4.4 Webhook Endpoint Requirements

**Verification (GET request):**
- Meta sends a GET with `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`
- Must respond with `hub.challenge` value if `hub.verify_token` matches our secret
- Must respond within 5 seconds

**Event Processing (POST request):**
- Verify `X-Hub-Signature-256` header using HMAC-SHA256 with App Secret
- Must respond with 200 OK within 5 seconds (process async)
- Deduplicate events (Meta may send duplicates)
- Handle all event types: messages, messaging_postbacks, messaging_referrals, comments, story_mentions, story_replies, message_deletes

### 4.5 Database Schema

```sql
-- instaclaw_instagram_integrations — OAuth tokens + account info
CREATE TABLE instaclaw_instagram_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  instagram_user_id TEXT NOT NULL,
  instagram_username TEXT,
  access_token TEXT NOT NULL,              -- Encrypted via encryptApiKey()
  token_expires_at TIMESTAMPTZ,
  webhook_subscribed BOOLEAN DEFAULT false,
  scopes TEXT[],
  connected_at TIMESTAMPTZ DEFAULT now(),
  last_webhook_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',            -- active, disconnected, token_expired
  UNIQUE(user_id),
  UNIQUE(instagram_user_id)
);

-- instaclaw_instagram_rate_limits — per-hour message counter
CREATE TABLE instaclaw_instagram_rate_limits (
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  hour_bucket TIMESTAMPTZ NOT NULL,
  messages_sent INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, hour_bucket)
);

-- instaclaw_instagram_triggers — keyword automation rules
CREATE TABLE instaclaw_instagram_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,               -- 'comment_keyword', 'dm_keyword', 'story_reply', 'new_follower_dm'
  keywords TEXT[],
  response_template TEXT,
  ai_response BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 5. Components to Build

### 5.1 Meta Developer App Setup (Manual, one-time)
- Create Meta App at developers.facebook.com
- App type: Business
- Add products: Instagram Graph API, Messenger, Webhooks
- Configure OAuth redirect URI: `https://instaclaw.io/api/auth/instagram/callback`
- Configure webhook callback URL: `https://instaclaw.io/api/webhooks/instagram`
- Request permissions and submit for App Review
- **Environment variables needed:** `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`

### 5.2 Dashboard UI

**Phase 1: "Connect Instagram" in Settings page (instaclaw/app/(dashboard)/settings/page.tsx)**
- Shows connected/disconnected status
- "Connect Instagram" button → initiates OAuth flow
- Once connected, shows: @username, account type, permissions granted, token expiry
- "Disconnect" button to revoke access
- "Manage Triggers" → opens trigger configuration UI

**Phase 2: Full Social Command Center (/social/*)**
- See Section 3.1 for full page list

### 5.3 API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/instagram` | GET | Initiates OAuth redirect to Meta |
| `/api/auth/instagram/callback` | GET | Handles OAuth callback, exchanges code for tokens |
| `/api/webhooks/instagram` | GET | Webhook verification (hub.challenge) |
| `/api/webhooks/instagram` | POST | Receives and routes Instagram events |
| `/api/instagram/disconnect` | POST | Revokes token and clears integration |
| `/api/instagram/triggers` | GET/POST/DELETE | CRUD for keyword triggers |
| `/api/cron/instagram-token-refresh` | GET | Refreshes tokens expiring within 7 days + cleans up rate limit records |

### 5.4 VM Scripts (deployed to every VM)

| Script | Purpose |
|--------|---------|
| `instagram-send-dm.py` | Sends a DM to a specific Instagram user (requires IGSID) |
| `instagram-reply-comment.py` | Replies to a comment on a post |
| `instagram-private-reply.py` | Sends a private DM reply to a commenter (comment-to-DM) |
| `instagram-get-conversations.py` | Lists recent DM conversations |
| `instagram-get-messages.py` | Reads messages in a specific conversation |
| `instagram-get-profile.py` | Gets the connected account's profile info |
| `instagram-get-media.py` | Lists recent posts/reels for the account |
| `instagram-rate-check.py` | Checks remaining rate limit budget for current hour |
| `instagram-publish-post.py` | Publishes a photo post (Phase 3) |
| `instagram-publish-reel.py` | Publishes a reel/video (Phase 3) |
| `instagram-publish-story.py` | Publishes a story (Phase 3) |
| `instagram-get-insights.py` | Gets account insights/analytics (Phase 3) |

**All scripts:**
- Accept the Access Token via environment variable (injected by gateway from Supabase)
- Include rate limit checking before every send operation
- Return structured JSON responses
- Handle and log API errors with Meta error codes
- Respect the 24-hour messaging window (check `last_message_timestamp` before sending)

### 5.5 SKILL.md (skills/instagram-automation/SKILL.md)

Must cover:
- When to use each script
- 24-hour window rules and how to check
- Rate limit awareness (200/hr) and pacing
- Comment-to-DM flow (most common use case)
- Keyword trigger processing
- How to craft contextual AI responses vs template responses
- What the agent CANNOT do (no unsolicited DMs, no bulk messaging, no personal accounts)
- Error handling for expired tokens, rate limits, permission errors
- Story reply and mention handling
- Media message support (images, videos in DMs)
- Content publishing guidelines (Phase 3)

### 5.6 Cron Jobs

| Cron | Schedule | Purpose |
|------|----------|---------|
| Token refresh + rate limit cleanup | Daily | Refreshes tokens expiring within 7 days. Deletes rate limit records older than 24h. |

---

## 6. User Flow

### 6.1 Setup (one-time)
1. User goes to instaclaw.io/settings (Phase 1) or /social/accounts (Phase 2+)
2. Clicks "Connect Instagram"
3. Redirected to Instagram OAuth — logs in, selects Instagram Business/Creator account
4. Grants permissions
5. Redirected back to dashboard — shows connected with @username
6. Optionally configures keyword triggers (e.g., "LINK" → sends product URL)

### 6.2 Daily Usage — Agent-Driven
- Someone comments "LINK" on user's post → agent detects keyword trigger → sends DM with link
- Someone DMs the business account → webhook fires → agent receives message → crafts AI response → sends reply (within 24hr window)
- Someone replies to user's story → agent receives event → responds contextually
- User tells agent: "reply to all my unread DMs" → agent reads conversations → responds to each

### 6.3 Daily Usage — Dashboard-Driven
- User configures new triggers in dashboard
- User views conversation analytics
- User checks rate limit usage

### 6.4 Autonomous Creator Mode (Phase 5)
- Agent checks content calendar every heartbeat cycle
- Generates content using creative skills (Director, Brand Design, etc.)
- Publishes to connected platforms
- Responds to comments/DMs in persona voice
- Analyzes performance and adjusts strategy
- Sends weekly summary to user via Telegram

---

## 7. Implementation Phases

### Phase 1 — InstaAgent Foundation (Tonight/This Week)
**Goal:** Build the Instagram integration so it's ready the moment Meta approves the app.

- [ ] Create Meta Developer App (manual — Cooper)
- [ ] Submit for App Review with screencast
- [ ] Build OAuth flow (dashboard + API routes)
- [ ] Build webhook endpoint (verification + event processing)
- [ ] Build database schema (migrations)
- [ ] Build VM scripts (send DM, reply comment, get conversations, etc.)
- [ ] Build InstaAgent SKILL.md
- [ ] Build token refresh cron
- [ ] Dashboard: "Connect Instagram" in settings

### Phase 2 — Social Command Center Dashboard (While Waiting for Meta Review)
**Goal:** Build the dashboard UI so everything is ready when integrations go live.

- [ ] Build `/social` route and nav item in dashboard
- [ ] Build `/social/accounts` — connect/disconnect page for all platforms
- [ ] Build `/social/conversations` — unified inbox (starts with Instagram only)
- [ ] Build `/social/triggers` — trigger configuration UI
- [ ] Build `/social/content` — content calendar view (manual + agent-scheduled)
- [ ] Build `/social/analytics` — cross-platform analytics (starts with Instagram insights)
- [ ] Build `/social/persona` — agent persona configuration page
- [ ] Test InstaAgent in Development mode (limited to app admins/testers)

### Phase 3 — InstaAgent Launch + Content Publishing (After Meta App Review)
**Goal:** Go live with Instagram for all users. Add content publishing.

- [ ] Switch Meta app to Live mode
- [ ] Fleet deploy InstaAgent skill + scripts to all VMs
- [ ] Enable "Connect Instagram" for all users
- [ ] Add content publishing scripts (instagram-publish-post.py, instagram-publish-reel.py, instagram-publish-story.py)
- [ ] Add Instagram insights/analytics to Social Command Center
- [ ] Announce feature on X + email to all users
- [ ] Monitor rate limits, error rates, token refreshes

### Phase 4 — XAgent (X/Twitter API v2)
**Goal:** Add X/Twitter as second platform in Social Command Center.

**X API Constraints:**
- Free tier: write-only, 1,500 posts/mo, no read access
- Basic ($200/mo): 15,000 reads, 50,000 writes per month
- Pay-as-you-go: launched Feb 2026, variable pricing
- OAuth 2.0 (recommended) or OAuth 1.0a
- DMs supported via API
- No app review required — just developer account + API key

**Implementation:**
- [ ] Build X OAuth flow in dashboard
- [ ] Build XAgent SKILL.md
- [ ] Build VM scripts (x-post-tweet.py, x-reply-tweet.py, x-send-dm.py, x-get-mentions.py)
- [ ] Add X to Social Command Center (conversations, content calendar, analytics)
- [ ] Decide tier strategy: offer free tier for basic posting, recommend Basic for full features
- [ ] Add X to unified inbox in /social/conversations

### Phase 5 — Autonomous Creator Mode
**Goal:** Agents can run their own social accounts as autonomous creators.

- [ ] Build persona engine (persona config stored in Supabase, loaded into SOUL.md at runtime)
- [ ] Build content generation pipeline (agent uses Director, Brand Design, Remotion, Voice skills to create content)
- [ ] Build autonomous posting loop (heartbeat-driven content calendar execution)
- [ ] Build engagement autopilot (auto-reply to comments/DMs in persona voice)
- [ ] Build performance-based content adjustment (agent analyzes what works, adjusts strategy)
- [ ] Build weekly report generation (agent sends Telegram summary of growth, engagement, top content)
- [ ] Add persona switcher in Social Command Center (manage personal accounts vs agent persona accounts)

### Phase 6 — Additional Platforms
- [ ] TikTok Content Posting API integration
- [ ] YouTube Data API v3 integration
- [ ] LinkedIn Marketing API integration
- [ ] Facebook (bundled with Instagram Graph API)
- [ ] Cross-posting engine (one piece of content → adapted and published to all platforms)

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Meta App Review rejection | Can't launch | Clear use case documentation, screencast demo, privacy policy. Resubmit with feedback. |
| Token expiration mid-conversation | Agent can't reply | Daily cron refreshes tokens 7 days before expiry. Alert if refresh fails. |
| Rate limit hit during viral moment | Messages delayed | Smart queueing with exponential backoff. Dashboard shows queue depth. |
| User doesn't have Business/Creator account | Can't connect | Clear messaging during onboarding: "Requires Instagram Business or Creator account" with link to Meta's guide on switching. |
| 24-hour window closes | Can't reply | Agent checks window before every send. If closed, notifies user to manually re-engage. |
| Meta changes API rules | Integration breaks | Subscribe to Meta developer changelog. Version our API calls. |
| X API costs ($200/mo for full access) | Limits adoption | Start with free tier (write-only, 1,500/mo). Offer upgrade path. |

---

## 9. Competitive Positioning

### DM Automation (vs ManyChat, CreatorFlow)

| Feature | ManyChat | CreatorFlow | InstaClaw |
|---------|----------|-------------|-----------|
| Price | $15-65/mo ON TOP of agent | $15/mo ON TOP of agent | **Included with subscription** |
| AI responses | Basic GPT integration | No | **Full Sonnet/Opus AI agent** |
| Setup | 15-30 min | 5 min | **One-click OAuth** |
| Context awareness | None | None | **Agent knows user's business, history, preferences** |
| Other capabilities | DMs only | DMs only | **DMs + 20 other skills (trading, video, research, etc.)** |
| Trigger + respond | Template-based | Template-based | **AI-crafted contextual responses** |

### Social Management (vs Hootsuite, Buffer, Later)

| Feature | Hootsuite | Buffer | InstaClaw |
|---------|-----------|--------|-----------|
| Price | $99-739/mo | $6-120/mo | **Included with subscription** |
| Content creation | Manual | Manual | **AI generates content autonomously** |
| Posting | Scheduled only | Scheduled only | **Autonomous — agent decides what/when to post based on strategy** |
| Engagement | Manual inbox | No | **AI replies to comments/DMs in your voice** |
| Analytics | Dashboard only | Dashboard only | **Agent analyzes AND acts on insights** |
| Video creation | No | No | **Full video production (Sora2, Veo3, Seedance, Remotion)** |
| Multi-purpose | Social only | Social only | **Social + trading + research + email + 20 more skills** |

### Autonomous Creator (vs nothing — this doesn't exist yet)

No platform currently offers a fully autonomous AI creator that:
- Has its own social identity and personality
- Creates original content using multiple AI models
- Posts, engages, and grows an audience autonomously
- Adjusts strategy based on performance analytics
- Operates 24/7 without human intervention
- Reports back to the owner with weekly summaries

This is a category-creating feature. The closest comparison is AI influencers like Lil Miquela — but those are manually produced by creative teams. InstaClaw's version is fully autonomous.

The killer differentiator: ManyChat sends template responses. Hootsuite schedules posts you create. InstaClaw's agent actually **understands** the conversation, creates the content, posts it, engages the audience, analyzes what works, and adjusts — all autonomously. That's not automation. That's an AI employee running your entire social presence.

---

## 10. Success Metrics

### Phase 1-3 (InstaAgent)
- **Adoption:** 30% of active users connect Instagram within 30 days of launch
- **Engagement:** Average 50+ automated responses per connected user per week
- **Retention:** Users with Instagram connected have 2x higher 30-day retention
- **Compliance:** Zero account bans or Meta policy violations
- **Reliability:** 99.5% webhook delivery success rate
- **Latency:** <3 second response time from webhook receipt to DM delivery

### Phase 4+ (Social Command Center)
- **Multi-platform:** 20% of Instagram-connected users also connect X within 30 days
- **Content creation:** Agent generates 10+ posts per week for users with content autopilot enabled
- **Autonomous creators:** 50+ agent personas created within 90 days of Persona launch
- **Engagement growth:** Connected accounts see 20%+ follower growth within 60 days of agent management
- **Tool replacement:** Track how many users cancel ManyChat/Hootsuite/Buffer after connecting
