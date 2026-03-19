---
name: instagram-automation
description: >-
  Instagram DM automation, conversation management, and comment replies via the Instagram Graph API. Use when the user mentions instagram, DMs, direct messages, check my DMs, instagram messages, reply to comments, send a DM, instagram automation, comment to DM, private reply, story mentions, or instagram conversations.
---
# InstaAgent — Instagram Automation
```yaml
name: instagram-automation
version: 1.0.0
updated: 2026-03-15
author: InstaClaw
phase: 1  # DM automation, comment replies, conversation management
triggers:
  keywords: [instagram, dm, direct message, insta, comment reply, story reply, comment-to-dm, instagram automation, ig dm, ig comment, instagram dms, instagram message]
  phrases: ["reply to my instagram", "check my dms", "instagram messages", "reply to comments", "send a dm", "instagram automation", "comment to dm", "private reply", "story mentions", "instagram conversations"]
  NOT: [post to instagram, publish, create reel, content calendar, schedule post]
```

## MANDATORY RULES — Read Before Anything Else

These rules override everything else in this skill file. Violating them risks Meta app suspension or user account bans.

**Rule 1 — 24-Hour Messaging Window:** You can ONLY send DMs within 24 hours of the user's last message to the business account. Before every DM send, verify the conversation is within the 24-hour window. If the window is closed, tell the user: "The 24-hour messaging window has expired for this conversation. The customer needs to message you first before I can reply."

**Rule 2 — No Unsolicited DMs:** NEVER send a DM to someone who hasn't interacted with the business account first. Valid triggers: they commented on a post, replied to a story, sent a DM, or clicked an ad. Invalid: sending DMs to a list of usernames, cold outreach, mass messaging.

**Rule 3 — Rate Limit (200/hr):** Instagram allows a maximum of 200 automated DMs per hour per account. Before sending, ALWAYS check the rate limit:
```bash
python3 ~/scripts/instagram-rate-check.py --json
```
If `remaining` is 0, do NOT send. Queue the message and tell the user it will be sent when the rate limit resets. If `remaining` < 10, warn the user about pacing.

**Rule 4 — No Bulk Messaging:** Every message must be contextually relevant to a specific user interaction. NEVER iterate through a list of users and send them the same message. That's spam and violates Meta's policies.

**Rule 5 — Business/Creator Accounts Only:** This skill only works with Instagram Business or Creator accounts. Personal accounts are not supported by Meta's API. If a user tries to connect a personal account, tell them: "Instagram automation requires a Business or Creator account. You can switch in Instagram Settings > Account > Switch to Professional Account."

**Rule 6 — No Fake Engagement:** NEVER generate fake comments, likes, follows, or engagement. Only respond to real user interactions.

**Rule 7 — Human Agent Tag:** After the 24-hour window closes, the only way to message is with a "Human Agent" tag — and that's ONLY for genuine customer support, NOT marketing. Do not abuse this.

**Rule 8 — Token Security:** NEVER log, display, or include the Instagram access token in any output, memory file, or chat message. The token is injected via environment variable.

---

## Overview

You have access to Instagram's official Graph API and Messaging Platform. Use this skill to manage DMs, reply to comments, and handle story interactions for the user's Instagram Business or Creator account.

**What this skill does:**
- Read and reply to Instagram DMs
- Reply to comments on posts
- Send private DM replies to commenters (comment-to-DM — the #1 use case)
- Read conversation history
- Get account profile info and recent media
- Process keyword-triggered automated responses

**What this skill does NOT do (yet — Phase 3):**
- Publish posts, reels, or stories
- Schedule content
- Access Instagram Insights/analytics
- Moderate comments (hide/delete)

**Account requirements:**
- Instagram Business or Creator account (NOT personal)
- Connected via OAuth in the InstaClaw dashboard
- Meta App Review approved for production use

## Script Reference

All scripts accept `--json` for structured output. All require `INSTAGRAM_ACCESS_TOKEN` and most require `INSTAGRAM_USER_ID` as environment variables (injected by gateway).

### Send a DM
```bash
python3 ~/scripts/instagram-send-dm.py --recipient <IGSID> --text "Hello!"
python3 ~/scripts/instagram-send-dm.py --recipient <IGSID> --image <URL>
python3 ~/scripts/instagram-send-dm.py --recipient <IGSID> --text "Check this" --image <URL> --json
```
- `--recipient`: Instagram-scoped user ID (IGSID) — NOT the @username
- `--text`: Message text
- `--image`: URL of an image to attach
- Respects 24-hour window and 200/hr rate limit
- GIFs and stickers are NOT supported by the API

### Reply to a Comment
```bash
python3 ~/scripts/instagram-reply-comment.py --comment-id <ID> --text "Thanks!" --json
```
- `--comment-id`: ID of the comment to reply to
- This posts a public reply under the comment
- No rate limit specific to comment replies (standard Graph API limits apply)

### Private Reply (Comment-to-DM)
```bash
python3 ~/scripts/instagram-private-reply.py --comment-id <ID> --text "Here's your link: ..." --json
```
- `--comment-id`: ID of the comment that triggered this reply
- Sends a DM to the person who posted the comment
- The comment must be on a post owned by the connected account
- This is the most common Instagram automation flow (keyword triggers)
- Counts toward the 200/hr DM rate limit

### List DM Conversations
```bash
python3 ~/scripts/instagram-get-conversations.py --json
python3 ~/scripts/instagram-get-conversations.py --limit 5 --json
```
- Returns recent conversations with participant info and latest messages
- Default limit: 20 conversations

### Read Messages in a Conversation
```bash
python3 ~/scripts/instagram-get-messages.py --conversation-id <ID> --json
python3 ~/scripts/instagram-get-messages.py --conversation-id <ID> --limit 50 --json
```
- Returns messages in chronological order
- Includes sender, text, attachments, and timestamps

### Get Account Profile
```bash
python3 ~/scripts/instagram-get-profile.py --json
```
- Returns: username, name, bio, website, followers, following, post count, profile picture URL

### List Recent Media
```bash
python3 ~/scripts/instagram-get-media.py --json
python3 ~/scripts/instagram-get-media.py --limit 10 --json
```
- Returns: post ID, caption, type (IMAGE/VIDEO/CAROUSEL_ALBUM), permalink, likes, comments
- Default limit: 25 items

### Check Rate Limit
```bash
python3 ~/scripts/instagram-rate-check.py --json
```
- Shows DMs sent this hour, remaining budget, and status (OK/LOW/RATE LIMITED)
- ALWAYS check before sending DMs

---

## Common Flows

### Comment-to-DM (Keyword Trigger)

The most popular Instagram automation pattern. User configures a trigger: when someone comments a keyword (e.g., "LINK", "FREE", "PRICE"), the agent automatically sends them a DM.

**Flow:**
1. Webhook receives a comment event with the keyword
2. Agent detects the keyword match from the trigger configuration
3. Agent checks rate limit (`instagram-rate-check.py`)
4. If within limits, agent sends private reply (`instagram-private-reply.py`)
5. If trigger has a template, use the template text
6. If trigger has `ai_response: true`, craft a contextual response

**Example:**
```
User configured trigger: keyword "LINK" → template "Here's the link to our product: https://example.com/shop"

Someone comments "LINK please!" on user's post
→ Agent sends DM: "Here's the link to our product: https://example.com/shop"
```

### Reply to Unread DMs

When user says "reply to my Instagram DMs" or "check my DMs":

1. Fetch conversations: `instagram-get-conversations.py --limit 10 --json`
2. For each conversation, read messages: `instagram-get-messages.py --conversation-id <ID> --json`
3. Identify conversations where the last message is FROM a customer (not from the business)
4. Check rate limit before each reply
5. Craft contextual AI response based on the message content and user's business context
6. Send reply: `instagram-send-dm.py --recipient <IGSID> --text "..." --json`
7. Report back: "Replied to X conversations. Y were already answered. Z couldn't be replied to (24hr window expired)."

### Story Reply Handling

When someone replies to the user's story:
1. Webhook delivers the event with the reply text and story reference
2. Agent reads the reply in context of the story content
3. Check 24-hour window (story replies create a DM thread)
4. Craft a contextual response
5. Send via `instagram-send-dm.py`

---

## Error Handling

### Meta API Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| 190 | Invalid/expired access token | Tell user: "Your Instagram connection has expired. Please reconnect in Settings." |
| 10 | Permission denied | Check if the required scope is granted. User may need to reconnect with updated permissions. |
| 100 | Invalid parameter | Check the API call parameters. The IGSID or comment ID may be wrong. |
| 613 | Rate limit hit | Stop sending. Check `instagram-rate-check.py`. Wait for next hour. |
| 551 | User cannot be messaged | The recipient has opted out of business DMs or blocked the account. Skip this user. |
| 2018278 | 24-hour window expired | Cannot send. Tell user to wait for the customer to message again. |

### General Error Rules

- If a script returns `"success": false`, report the exact error to the user
- Maximum 2 retries per operation
- If the token is expired (code 190), do NOT retry — tell user to reconnect
- If rate limited (code 613), do NOT retry — wait for next hour
- NEVER go silent after an error — always report back

---

## What the Agent CANNOT Do

- Send unsolicited DMs (cold outreach)
- Mass message a list of users
- Bypass the 24-hour messaging window
- Work with personal Instagram accounts
- Send GIFs or stickers via DM (API limitation)
- Access Instagram Reels/Stories insights (Phase 3)
- Publish content (Phase 3)
- Follow/unfollow users programmatically
- Like posts programmatically
- Access other users' private profiles

---

## Cross-Skill Integration

### With web-search-browser
When crafting AI responses to DMs, search the web for relevant context if the query is about a product, event, or factual question.

### With brand-design
For comment-to-DM flows that include branded content or images, use the brand-design skill to generate visual assets.

### With competitive-intelligence
If a DM asks about competitors or market positioning, use the competitive-intelligence skill to research before responding.

### With recurring tasks (heartbeat system)
Set up recurring DM checks:
```
"Check my Instagram DMs every 2 hours and reply to any new messages"
→ Recurring task: fetch conversations, identify unread, reply with AI responses
```

---

## File Paths Reference

| File | Purpose |
|------|---------|
| `~/scripts/instagram-send-dm.py` | Send a DM to a specific Instagram user |
| `~/scripts/instagram-reply-comment.py` | Reply to a comment on a post |
| `~/scripts/instagram-private-reply.py` | Comment-to-DM (private reply to a commenter) |
| `~/scripts/instagram-get-conversations.py` | List recent DM conversations |
| `~/scripts/instagram-get-messages.py` | Read messages in a conversation |
| `~/scripts/instagram-get-profile.py` | Get account profile info |
| `~/scripts/instagram-get-media.py` | List recent posts/reels |
| `~/scripts/instagram-rate-check.py` | Check DM rate limit budget |
| `~/.openclaw/instagram/rate-limit.json` | Local rate limit tracker |

---

## Safety Rules

- **Compliance first** — Always operate within Meta's platform policies. When in doubt, don't send.
- **Rate limit discipline** — Check before every send. Never exceed 200 DMs/hour.
- **24-hour window** — Verify before every outbound DM. No exceptions.
- **No hallucinated responses** — If you can't read the message or conversation, say so. Don't make up what someone said.
- **Token security** — Never expose the access token in any output.
- **User opt-in** — Only enable automation the user explicitly configured. Don't auto-reply to everything without the user's consent.
- **Respectful engagement** — Craft responses that are helpful, not spammy. The user's reputation is at stake.
