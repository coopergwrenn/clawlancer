# Email Operations Reference Guide

## Provider Architecture

| Layer | Provider | What It Does | Always Available? |
|---|---|---|---|
| Sending | Resend | Transactional email from @instaclaw.io | Yes (platform key) |
| Receiving | Gmail OAuth | Monitor user's inbox, draft replies | If connected at onboarding |
| Full Inbox | AgentMail BYOK | Dedicated agent inbox (send+receive+threads) | Only if user provides key |

## Resend API (Default Send Provider)

**Base URL:** `https://api.resend.com`
**Auth:** `Authorization: Bearer <RESEND_API_KEY>`
**Domain:** `instaclaw.io` (SPF/DKIM/DMARC verified)

### Send Email
```bash
curl -X POST "https://api.resend.com/emails" \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from": "agent@instaclaw.io", "to": ["recipient@example.com"], "subject": "Subject", "text": "Body"}'
```

## AgentMail API (BYOK Only)

**Base URL:** `https://api.agentmail.to/v0`
**Auth:** `Authorization: Bearer <AGENTMAIL_API_KEY>`

### Endpoints (only available with user's AgentMail key)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/inboxes/{id}/messages` | List messages |
| POST | `/inboxes/{id}/messages` | Send from inbox |
| GET | `/inboxes/{id}/threads` | List threads |
| POST | `/inboxes/{id}/search` | Search inbox |
| POST | `/threads/{id}/reply` | Reply to thread |
| DELETE | `/messages/{id}` | Delete message |

## Email Classification Priority

| Level | Criteria | Action |
|---|---|---|
| CRITICAL | VIP sender (from USER.md) | Notify user immediately |
| HIGH | Urgent keywords in subject | Include in urgent digest |
| NORMAL | Standard email | Include in daily digest |
| AUTO | Verification/OTP emails | Extract code, handle |
| LOW | Newsletter/marketing | Skip or filter |

## Auto-Reply Detection

Check these headers before replying to prevent infinite loops:
- `Auto-Submitted: auto-replied`
- `X-Autoreply: yes`
- `X-Auto-Response-Suppress: All`
- `Precedence: auto_reply` or `bulk`

If ANY present → do NOT reply.

## Rate Limits

| Category | Limit |
|---|---|
| Cold outreach | 20/day |
| Known contacts | 100/day |
| Total daily | 200/day |

### Warmup Schedule (New From-Address)

| Period | Daily Limit |
|---|---|
| Week 1 | 10 |
| Week 2 | 25 |
| Week 3 | 50 |
| Week 4+ | 200 |

## Credential Leak Patterns (Blocked in All Outbound)

| Pattern | What It Catches |
|---|---|
| `sk-[a-zA-Z0-9]{32+}` | OpenAI API keys |
| `sk_[a-zA-Z0-9]{20+}` | ElevenLabs/Stripe keys |
| `ghp_[a-zA-Z0-9]{36}` | GitHub PATs |
| `AKIA[0-9A-Z]{16}` | AWS access keys |
| `Bearer [token]` | Bearer auth tokens |
| `password: value` | Plaintext passwords |

## Deliverability Tips

1. **SPF/DKIM/DMARC** — Handled by Resend for instaclaw.io
2. **Warm up gradually** — Follow warmup schedule
3. **Avoid spam triggers** — No "FREE MONEY", "ACT NOW"
4. **Include unsubscribe** — Required for bulk/newsletter sends
5. **Honor bounces** — Remove addresses that bounce
6. **Personalize** — Generic mass emails get flagged
