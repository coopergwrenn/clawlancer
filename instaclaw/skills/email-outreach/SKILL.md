# Email & Outreach
```yaml
name: email-outreach
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [email, outreach, inbox, send email, reply, forward, newsletter, cold email, follow-up, OTP, verification code, email digest]
  phrases: ["send an email", "check my email", "draft a response", "follow up with", "email campaign", "cold outreach", "check for verification codes", "what's in my inbox", "email digest"]
  NOT: [Slack message, Discord message, SMS, phone call, text message]
```

## Overview

You can send emails from `@instaclaw.io` via Resend (always available). For receiving, you monitor the user's Gmail (connected during onboarding). If the user has connected an AgentMail inbox (BYOK), you also have a dedicated agent inbox for full send+receive.

**Two-layer email system:**
1. **Resend (default, always available):** Send transactional emails, notifications, outreach from `@instaclaw.io`. No inbox — send only.
2. **AgentMail BYOK (optional):** If user provided their own AgentMail API key, you have a dedicated inbox for send+receive, threads, OTP extraction.

**Receiving:**
- Gmail monitoring via OAuth (connected during onboarding) — you read, classify, and draft replies
- AgentMail inbox (only if BYOK configured) — full inbox with threads

**Prerequisites (on your VM):**
- Resend API key in `~/.openclaw/.env` as `RESEND_API_KEY` (always deployed)
- From address in `~/.openclaw/email-config.json`
- Helper scripts: `~/scripts/email-client.sh`, `~/scripts/email-safety-check.py`, `~/scripts/email-digest.py`
- Optionally: `AGENTMAIL_API_KEY` in `~/.openclaw/.env` (user-provided BYOK)

## Provider Details

```
Default Provider:   Resend (transactional email, send-only)
  Domain:           instaclaw.io (SPF/DKIM/DMARC verified)
  API:              https://api.resend.com
  Auth:             Authorization: Bearer <RESEND_API_KEY>

Optional BYOK:      AgentMail.to (full inbox, send+receive)
  API:              https://api.agentmail.to/v0
  Auth:             Authorization: Bearer <AGENTMAIL_API_KEY>
```

## Which Provider Am I Using?

```bash
# Check your email config
~/scripts/email-client.sh info

# If AGENTMAIL_API_KEY is set → AgentMail (full inbox)
# If only RESEND_API_KEY is set → Resend (send only)
```

## Email Autonomy Rules

**ALWAYS auto-send (no human approval needed):**
- Service signup confirmations
- Pre-approved newsletter distribution
- Agent-to-agent communication
- Automated receipts and confirmations

**NEVER auto-send (always get human approval):**
- Cold outreach to new contacts
- Emails mentioning money, pricing, invoices
- Emails mentioning legal matters
- Emails to VIP contacts (defined in USER.md)
- Emails making commitments or promises

**When in doubt:** Draft it, present it to the user, wait for approval.

## Workflow 1: Send Email (Always Available)

```bash
# Send via Resend (default) or AgentMail (if BYOK configured)
~/scripts/email-client.sh send \
  --to "recipient@example.com" \
  --subject "Subject line" \
  --body "Email body text"

# Send HTML email
~/scripts/email-client.sh send \
  --to "recipient@example.com" \
  --subject "Newsletter" \
  --body "<h1>Hello</h1><p>Content here</p>" \
  --content-type "text/html"
```

## Workflow 2: Check Inbox (AgentMail BYOK Only)

```bash
# Only works if user has connected AgentMail
~/scripts/email-client.sh check --unread --limit 10

# Search inbox
~/scripts/email-client.sh search --query "verification code"

# List threads
~/scripts/email-client.sh threads --limit 10

# Reply to thread
~/scripts/email-client.sh reply --thread-id "thread_abc" --body "Reply text"
```

If AgentMail is not configured, these commands return an error explaining that inbox features require the user to connect an AgentMail API key.

## Workflow 3: Human-Approved Outreach

1. Draft the email
2. Present to user via messaging with preview
3. Wait for explicit approval
4. Only send after [Approve]
5. Track responses and schedule follow-ups

```
OUTREACH READY FOR REVIEW

Draft: Partnership inquiry to CompanyX
  To: partnerships@companyx.com
  Subject: "Collaboration Opportunity"
  Preview: "Hi Team, I noticed your recent launch..."
  [Approve] [Edit] [Skip]
```

## Workflow 4: Gmail Draft Assistance

When the user gets an important Gmail that needs a response:
1. Detect email via Gmail monitoring
2. Draft a response
3. Present to user: [Send from Gmail] [Edit First] [I'll Handle It]

**You NEVER send from the user's Gmail directly.** You only draft. The user sends.

## Pre-Send Safety Checks

**ALWAYS run before sending any email:**

```bash
python3 ~/scripts/email-safety-check.py \
  --to "recipient@example.com" \
  --subject "Subject line" \
  --body "Email body text"

# Returns: OK, WARN (review suggested), or BLOCK (must not send)
```

**What gets blocked:**
- API keys, passwords, tokens in email body
- Dollar amounts > $999 without human approval
- Legal terms (lawsuit, legal action, confidential)
- Exceeding daily rate limits

## Rate Limits

```
Cold outreach:        20/day (hard cap)
Known contacts:       100/day
Total daily:          200/day

Warmup schedule (new from-address):
  Week 1:   10/day
  Week 2:   25/day
  Week 3:   50/day
  Week 4+:  Full limits
```

Check status: `python3 ~/scripts/email-safety-check.py --rate-status`

## Daily Email Digest

```bash
# Generate digest (works with Gmail data + AgentMail if configured)
python3 ~/scripts/email-digest.py generate
```

## Email Client Commands

| Command | Provider | Usage |
|---|---|---|
| `send` | Resend or AgentMail | `email-client.sh send --to X --subject Y --body Z` |
| `check` | AgentMail only | `email-client.sh check [--unread] [--from X]` |
| `reply` | AgentMail only | `email-client.sh reply --thread-id X --body Y` |
| `threads` | AgentMail only | `email-client.sh threads [--limit N]` |
| `search` | AgentMail only | `email-client.sh search --query "text"` |
| `info` | Any | `email-client.sh info` |
| `delete` | AgentMail only | `email-client.sh delete --message-id X` |

## Common Mistakes

1. **Sending from wrong identity.** Autonomous work uses `@instaclaw.io`. User's Gmail is draft-only. NEVER send from the user's Gmail.

2. **Over-emailing contacts.** After 3 follow-ups with no response, STOP.

3. **Missing VIP emails in noise.** Priority classification runs on EVERY incoming email. Check VIP list in USER.md.

4. **Not warming up.** Follow the warmup schedule for new from-addresses.

5. **Auto-replying to auto-replies.** Detect auto-reply headers (`Auto-Submitted: auto-replied`, `X-Autoreply: yes`). Otherwise you create infinite loops.

6. **Leaking credentials in emails.** ALWAYS run email-safety-check.py before sending.

7. **Using inbox commands without AgentMail.** The `check`, `reply`, `threads`, `search` commands only work if the user has connected AgentMail BYOK. Don't tell the user these features exist unless they have AgentMail configured.

## Quality Checklist

- [ ] Pre-send safety check passed (`email-safety-check.py`)
- [ ] Rate limits checked (not over daily cap)
- [ ] Correct identity used (@instaclaw.io for agent, draft-only for Gmail)
- [ ] Auto-reply detection active
- [ ] VIP sender list loaded from USER.md
- [ ] Credential leak detection active
- [ ] Recipients verified
