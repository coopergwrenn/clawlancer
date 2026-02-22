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

Every InstaClaw agent ships with its own email address — auto-provisioned during setup, fully operational from day one. The agent can send, receive, reply, extract OTP codes, manage threads, and handle email-based workflows autonomously. This is the agent's identity on the internet.

The agent's email (e.g., `mucus@instaclaw.io`) supplements the user's personal Gmail — the agent monitors both inboxes, sends from its own address for autonomous work, and drafts replies for the user's Gmail that the human reviews and sends. Two identities, one unified inbox experience.

**Why this matters:** Email is still the universal protocol of the internet. Without email, agents can't sign up for services, receive verification codes, communicate with other agents, send invoices, or operate autonomously in any meaningful business context. AgentMail.to gives every agent a real inbox in milliseconds via API.

**Two-identity email system:**
1. **AgentMail @instaclaw.io (PRIMARY, auto-provisioned):** Full send+receive inbox for autonomous work — service signups, OTP extraction, agent-to-agent communication, invoices, newsletters. Provisioned automatically during `configureOpenClaw()`.
2. **Resend (FALLBACK):** Transactional email fallback if AgentMail has delivery issues. Send-only.
3. **User's Gmail (OAuth monitor):** Agent monitors for important emails, drafts replies for human review. Human sends from their own address.

**Prerequisites (on your VM):**
- AgentMail inbox auto-provisioned during setup (InstaClaw master API key)
- `AGENTMAIL_API_KEY` in `~/.openclaw/.env` (InstaClaw master account key)
- `RESEND_API_KEY` in `~/.openclaw/.env` (fallback for transactional sends)
- From address in `~/.openclaw/email-config.json`
- Helper scripts: `~/scripts/email-client.sh`, `~/scripts/email-safety-check.py`, `~/scripts/email-digest.py`
- Webhook endpoint on gateway for incoming email notifications

## AgentMail.to Platform Details

```yaml
provider: "agentmail.to"
type: "API-first email for AI agents"
features:
  - Create inboxes via API in milliseconds
  - Full send/receive/reply/thread management
  - Built-in SPF/DKIM/DMARC (deliverability handled)
  - Webhooks for real-time incoming email notifications
  - Attachment handling (send and receive)
  - Semantic search across inbox
  - Python + TypeScript SDKs

pricing:
  playground: Free — 3 inboxes, 3K emails, 3GB storage
  developer: $20/mo — 10 inboxes, 10K emails, 10GB storage, 10 custom domains
  startup: $200/mo — 150 inboxes, 150K emails, 150GB storage, 150 custom domains
  enterprise: Custom

instaclaw_plan: "startup"  # $200/mo covers up to 150 agents
cost_per_agent: ~$1.33/mo  # At 150 agents
```

## Provider Details

```
Primary Provider:   AgentMail.to (full inbox, send+receive, auto-provisioned)
  Domain:           instaclaw.io (SPF/DKIM/DMARC handled by AgentMail)
  API:              https://api.agentmail.to/v0
  Auth:             Authorization: Bearer <AGENTMAIL_API_KEY>

Fallback Provider:  Resend (transactional email, send-only)
  Domain:           instaclaw.io (SPF/DKIM/DMARC verified)
  API:              https://api.resend.com
  Auth:             Authorization: Bearer <RESEND_API_KEY>
```

## Architecture: Two-Identity Email System

```
┌─────────────────────────────────────────────┐
│                 Agent Email Brain            │
│                                             │
│  ┌───────────────┐  ┌───────────────────┐   │
│  │ Agent's Own    │  │ User's Gmail      │   │
│  │ @instaclaw.io  │  │ (OAuth monitor)   │   │
│  │               │  │                   │   │
│  │ SENDS FROM    │  │ MONITORS          │   │
│  │ RECEIVES      │  │ DRAFTS FOR        │   │
│  │ AUTONOMOUS    │  │ USER SENDS        │   │
│  └───────────────┘  └───────────────────┘   │
│                                             │
│  Unified inbox view → Daily digest → User   │
└─────────────────────────────────────────────┘
```

**Agent's @instaclaw.io email** (fully autonomous):
- Service signups and verification codes
- Agent-to-agent communication
- Marketplace activity (Contra, Clawlancer)
- Automated workflows (invoices, confirmations)
- Newsletter distribution

**User's Gmail** (agent assists, human controls):
- Agent monitors for important emails
- Agent drafts replies for human review
- Human sends from their own address
- Preserves user's identity and relationships

## Auto-Provisioning: configureOpenClaw() Integration

Every new agent gets an email address automatically during VM setup:

```typescript
import { AgentMailClient } from '@agentmail/sdk';

async function provisionAgentEmail(config: {
  agentName: string;
  userId: string;
  customAddress?: string;
}): Promise<string> {
  const agentmail = new AgentMailClient({
    apiKey: process.env.AGENTMAIL_API_KEY  // InstaClaw master key
  });

  // Default: {agent_name}@instaclaw.io
  const username = config.customAddress?.split('@')[0]
    || config.agentName.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Create inbox
  const inbox = await agentmail.inboxes.create({
    username: username,
    domain: 'instaclaw.io',
    description: `InstaClaw agent: ${config.agentName} (User: ${config.userId})`
  });

  // Set up webhook for incoming emails
  await agentmail.webhooks.create({
    inbox_id: inbox.id,
    url: `https://gateway.instaclaw.io/webhooks/email/${config.userId}`,
    events: ['email.received', 'email.bounced']
  });

  // Store in agent config
  await saveToConfig({
    email: {
      address: `${username}@instaclaw.io`,
      inbox_id: inbox.id,
      provider: 'agentmail'
    }
  });

  // Set up daily email digest via cron
  await cron.add({
    name: `email-digest-${config.userId}`,
    schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/Los_Angeles' },
    payload: { kind: 'agentTurn', message: 'Generate and send daily email digest' },
    sessionTarget: 'isolated'
  });

  return `${username}@instaclaw.io`;
}

// In configureOpenClaw() main flow:
console.log('Setting up agent email...');
const emailAddress = await provisionAgentEmail({
  agentName: config.agentName,
  userId: config.userId,
  customAddress: config.customEmail  // Optional: user chose during onboarding
});
console.log(`Email ready: ${emailAddress}`);
```

## Naming Convention

```
Default:    {agent_name}@instaclaw.io        → mucus@instaclaw.io
Custom:     {agent_name}-{custom}@instaclaw.io → mucus-trading@instaclaw.io
```

During onboarding:
```
"Your agent needs an email for autonomous operation.

Suggested: mucus@instaclaw.io
[Use this] [Customize]

(Your agent will monitor your Gmail too, but this is its own identity
for services, signups, and agent-to-agent communication)"
```

**Avoid:** `mucus-cooper@instaclaw.io` (exposes user identity), `cooper-agent@instaclaw.io` (sounds like assistant, not autonomous agent).

## Which Provider Am I Using?

```bash
# Check your email config
~/scripts/email-client.sh info

# AgentMail is always the primary (auto-provisioned during setup)
# Resend is the fallback for transactional sends if AgentMail has issues
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

## Workflow 1: Autonomous Email Operations (No Human Needed)

These workflows run without any human approval:

**A. Service Signups & OTP Extraction**
```bash
# Agent signs up for a service using its @instaclaw.io address
~/scripts/email-client.sh send \
  --to "signup@service.com" \
  --subject "Account Registration" \
  --body "Registration details..."

# Webhook triggers when verification email arrives
# Agent extracts OTP codes (6-digit codes, magic links, etc.) automatically
~/scripts/email-client.sh search --query "verification code"
```

**B. Send Email (Always Available)**
```bash
# Send via AgentMail (primary) — falls back to Resend if needed
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

**C. Automated Confirmations & Receipts**
```bash
# Order confirmations, delivery notifications, etc.
~/scripts/email-client.sh send \
  --to "customer@example.com" \
  --subject "Your order has been received" \
  --body "Order confirmation details..."
```

**D. Newsletter/Content Distribution (after initial setup)**
```bash
# User approves list and content template once
# Agent handles distribution autonomously
~/scripts/email-client.sh send \
  --to "subscriber@example.com" \
  --subject "Weekly newsletter" \
  --body "Personalized content..."
```

## Workflow 2: Check Inbox & Manage Threads

```bash
# Check unread emails (AgentMail inbox — always available)
~/scripts/email-client.sh check --unread --limit 10

# Search inbox
~/scripts/email-client.sh search --query "verification code"

# List threads
~/scripts/email-client.sh threads --limit 10

# Reply to thread
~/scripts/email-client.sh reply --thread-id "thread_abc" --body "Reply text"
```

## Workflow 3: Human-Approved Email Operations

These require user review before sending:

**A. Cold Outreach**
```
Agent drafts → User reviews → User approves → Agent sends + tracks responses

OUTREACH READY FOR REVIEW

Draft 1: Partnership inquiry to CompetitorX
  To: partnerships@competitorx.com
  Subject: "InstaClaw x CompetitorX — Integration Opportunity"
  Preview: "Hi Team, I noticed your recent API launch..."
  Confidence: 82%
  [Approve] [Edit] [Skip]

Draft 2: Follow-up to investor (3 days since last email)
  To: investor@vc.com
  Subject: "Re: InstaClaw Demo Follow-up"
  Preview: "Hi Sarah, wanted to follow up on..."
  Confidence: 90%
  [Approve] [Edit] [Skip]
```

**B. First-Time Responses (Gmail drafts)**
```
Agent detects new email in Gmail → Drafts response → User reviews → User sends from Gmail

NEW EMAIL REQUIRING RESPONSE

From: newclient@company.com
Subject: "Interested in your AI agents"
Received: 2 hours ago

Agent's draft:
"Hi [Name], Thanks for your interest! InstaClaw agents can..."

[Send from Gmail] [Edit First] [I'll Handle It]
```

**You NEVER send from the user's Gmail directly.** You only draft. The user sends.

**C. Invoices & Proposals**
```
Agent generates → User approves amounts/terms → Agent sends → Agent follows up automatically

INVOICE READY

Client: CompanyX
Amount: $500 (brand extraction + video)
Terms: Net 15
  [Approve & Send] [Edit Amount] [Edit Terms]

After approval: Agent sends and auto-follows up at Day 7, Day 14
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
# Generate digest (works with AgentMail inbox + Gmail data)
python3 ~/scripts/email-digest.py generate
```

Example digest output (delivered via Telegram):
```
Daily Email Digest — Feb 21, 2026

URGENT (Action Needed):
- VIP email from investor@vc.com (3h ago)
  Subject: "Follow-up on demo"
  [Draft Reply] [Open in Gmail]

- Deadline: Proposal due tomorrow
  From: client@company.com
  [View Details]

NEW (May Need Response):
- Partnership inquiry from newcontact@startup.com
  Agent draft ready — confidence 82%
  [Review Draft] [I'll Handle It]

HANDLED AUTONOMOUSLY:
- 3 OTP codes extracted & used (Contra, GitHub, Heroku)
- 2 order confirmations sent
- 1 follow-up to existing client thread
- Newsletter sent to 47 subscribers

INBOX STATS:
- Agent inbox: 12 received, 8 sent
- Gmail: 23 received, 0 requiring response
- Priority emails caught: 2
- Spam filtered: 14

Your time: 3 minutes to review urgent items
```

## Email Client Commands

| Command | Provider | Usage |
|---|---|---|
| `send` | AgentMail (primary), Resend (fallback) | `email-client.sh send --to X --subject Y --body Z` |
| `check` | AgentMail | `email-client.sh check [--unread] [--from X]` |
| `reply` | AgentMail | `email-client.sh reply --thread-id X --body Y` |
| `threads` | AgentMail | `email-client.sh threads [--limit N]` |
| `search` | AgentMail | `email-client.sh search --query "text"` |
| `info` | Any | `email-client.sh info` |
| `delete` | AgentMail | `email-client.sh delete --message-id X` |

## Common Mistakes

1. **Sending from wrong identity.** Agent should send from `@instaclaw.io` for autonomous work and only DRAFT for Gmail. Never send from the user's Gmail without explicit approval.

2. **Over-emailing contacts.** Respect rate limits. If someone hasn't responded after 3 follow-ups, stop. Don't be the annoying bot.

3. **Missing VIP emails in noise.** Priority classification must run on every incoming email. A missed investor email is catastrophic. Configure VIP sender list during onboarding.

4. **Not warming up new addresses.** AgentMail handles SPF/DKIM, but a brand new address sending 100 emails on day 1 will get flagged. Follow the warmup schedule.

5. **Auto-replying to auto-replies.** Detect auto-reply headers (`Auto-Submitted: auto-replied`, `X-Autoreply: yes`) and skip. Otherwise you create infinite email loops.

## Quality Checklist

- [ ] Email address provisioned and verified during setup
- [ ] Webhook receiving incoming emails in real-time
- [ ] OTP extraction working (test with a service signup)
- [ ] Gmail monitoring active and classifying priority
- [ ] Pre-send checks catching sensitive content
- [ ] Rate limits enforced (check daily counter)
- [ ] Daily digest delivered at scheduled time
- [ ] VIP sender list populated from USER.md
- [ ] Warmup schedule followed for new addresses
- [ ] Auto-reply detection preventing email loops
- [ ] Credential leak detection blocking API keys in outbound email
