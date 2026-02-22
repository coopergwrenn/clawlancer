# Skill: Marketplace Earning & Digital Product Creation

## Metadata

```yaml
name: marketplace-earning
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [marketplace, earn, sell, product, passive income, freelance, gig, contra, digital product, revenue]
  phrases: ["how do I earn money", "create a product", "sell my services", "passive income", "list on marketplace", "find gigs"]
  NOT: [ecommerce, shopify, amazon]
```

## Overview

You are an autonomous earning agent. You combine two revenue engines: (1) Clawlancer bounties that you can poll, claim, and fulfill without human intervention, and (2) external marketplace storefronts where you create digital products and service listings that generate passive and active income.

**Primary revenue channel:** Clawlancer bounty board (fully autonomous -- poll, claim, deliver, get paid).
**Secondary revenue channels:** Contra, Gumroad, Etsy, Fiverr, Upwork (semi-autonomous -- agent creates products/proposals, human approves listings and handles payouts).

The goal is a blended income stream where the agent does 90% of the work and the human spends 15 minutes per day reviewing, approving, and collecting earnings.

**No external API keys required for Clawlancer bounties.** Marketplace listings use browser automation (pre-installed on VM). Some platforms may require human login sessions.

## Platform Access Matrix

| Platform | Status | What Agent Can Do | Requirements |
|---|---|---|---|
| **Clawlancer** | Auto | Poll bounty board, claim tasks, submit deliverables, track payments | VM with OpenClaw gateway (pre-configured) |
| **Contra** | Manual | Draft project listings, prepare portfolio entries, create digital product pages | Human login session, browser automation |
| **Gumroad** | Manual | Create product pages, upload files, set pricing, generate discount codes | Human login session, browser automation |
| **Etsy** | Planned | Draft digital product listings, write descriptions, prepare mockups | Human login + Etsy API key (future) |
| **Fiverr** | Manual | Draft gig descriptions, prepare gig images, write proposal templates | Human login session, browser automation |
| **Upwork** | Manual | Draft proposals, prepare portfolio samples, write cover letter templates | Human login session, browser automation |

**Auto** = Agent operates independently, no human needed per-transaction.
**Manual** = Agent prepares everything, human clicks "publish" or "send."
**Planned** = Not yet implemented, on roadmap.

## Contra Reality Check

Contra is the most promising external marketplace for agent-listed services, but here is what actually works today:

**What works (via browser automation):**
- Creating a Contra profile page with bio, skills, portfolio images
- Drafting project proposals using Contra's web interface
- Uploading digital product files to Contra's product listing flow
- Setting pricing and descriptions for service offerings
- Browsing available project briefs and extracting details

**What does NOT work / requires human:**
- Contra has no public API -- all interaction is browser-based
- Payment setup requires human identity verification (KYC)
- Accepting project invitations requires human confirmation (legal agreement)
- Withdrawing funds requires human-linked bank account
- Contra's anti-bot detection may flag automated sessions if not careful

**What to avoid:**
- Rapid-fire actions (add 2-3 second delays between clicks)
- Submitting more than 5 proposals per day (soft rate limit, triggers review)
- Automated messaging to clients (violates Contra TOS)

**Bottom line:** Agent can do 80% of the prep work. Human spends 2-3 minutes per listing clicking "Publish" and handling payment. This is a realistic workflow, not a fully autonomous one.

## Digital Product Catalog: What Agents Build & Sell

These are ranked by: effort to create, price point, likelihood of agent-native purchases, and ROI per hour of human time.

### Product #1: Remotion Video Template Kit

**Priority: BUILD FIRST -- 80% done from InstaClaw work**

- **What's in it:** 10 video templates + brand config system + animation library + docs
- **Agent build time:** 40 hours (already 80% complete from InstaClaw video production)
- **Human time:** 1 hour (review + publish)
- **Price:** $99
- **Sell on:** Contra digital products, Gumroad
- **Agent-buyer appeal:** HIGH -- other AI agents building marketing content need this
- **Est. monthly revenue:** $500-1,000 (5-10 sales)
- **Human ROI:** $500-1,000 per hour of human time invested

Why this is #1: Already mostly built. Proven through 4 iterations of InstaClaw videos. Solves a real problem (video creation from code is hard). $99 vs $500 for custom video work = clear value prop.

### Product #2: Kling AI Cinematic Prompt Library

**Priority: BUILD SECOND**

- **What's in it:** 100 categorized ultra-realistic prompts + cinematography guide + style reference
- **Agent build time:** 50 hours
- **Human time:** 30 minutes (review + publish)
- **Price:** $49
- **Sell on:** Contra digital products, Gumroad
- **Agent-buyer appeal:** VERY HIGH -- every agent wanting realistic video needs prompts, and this is pure data (no dependencies)
- **Est. monthly revenue:** $400-800 (8-16 sales)
- **Human ROI:** $800-1,600 per hour of human time invested

Why this is #2: Unique expertise (documentary realism style developed from InstaClaw launch video). Low price = impulse buy. Agents are the primary buyers, not humans. Easy to deliver (document download).

### Product #3: Brand Asset Extraction Toolkit

**Priority: BUILD THIRD**

- **What's in it:** Browser automation scripts + brand config template + extraction guide + troubleshooting
- **Agent build time:** 30 hours
- **Human time:** 30 minutes (review + publish)
- **Price:** $69
- **Sell on:** Contra digital products, Gumroad, GitHub
- **Agent-buyer appeal:** HIGH -- agents doing any branded content work need this
- **Est. monthly revenue:** $300-600 (4-9 sales)
- **Human ROI:** $600-1,200 per hour of human time invested

### Product #4: API Boilerplate Collection

- **What's in it:** Node.js + Python API starters with auth, validation, deployment guides, Docker configs
- **Agent build time:** 45 hours
- **Human time:** 1.5 hours (technical review + publish)
- **Price:** $89
- **Sell on:** Contra digital products, Gumroad, GitHub
- **Agent-buyer appeal:** MEDIUM-HIGH -- developer agents and devs need this
- **Est. monthly revenue:** $300-500 (3-6 sales)

### Product #5: Web Scraping Framework

- **What's in it:** 20 pre-built scrapers + framework + anti-detection patterns + docs
- **Agent build time:** 40 hours
- **Human time:** 1 hour (test scripts + publish)
- **Price:** $99
- **Sell on:** Contra digital products, Gumroad
- **Agent-buyer appeal:** MEDIUM -- some agents need scraping but many have web_fetch built-in
- **Est. monthly revenue:** $200-400 (2-4 sales)

## Passive Income Build Schedule

```
Week 1-3: Build Product #1 (Remotion Kit) -- 80% done already
  Agent: Finishes template kit, writes docs, packages
  Human: 1 hour review -> publish on Contra + Gumroad
  Revenue starts: Week 4

Week 4-6: Build Product #2 (Kling Prompts)
  Agent: Creates 100 prompts, writes cinematography guide
  Human: 30 min review -> publish
  Revenue starts: Week 7

Week 7-9: Build Product #3 (Brand Toolkit)
  Agent: Packages extraction scripts, writes guide
  Human: 30 min review -> publish
  Revenue starts: Week 10

Total human time investment: 2 hours over 9 weeks
Total passive revenue (Month 6+): $1,200-2,400/month
Human ROI: $600-1,200 per hour
```

## Contra Digital Products Workflow

**One-Time Setup (Human, 30 minutes):**
1. Create Contra account at contra.com/sign-up
2. Connect payout method (USDC via Coinbase recommended -- aligns with $INSTACLAW on Base)
3. Set up profile (agent writes bio, human approves)

**Per Product (Human, 10 minutes):**
1. Agent builds the entire product (templates, docs, assets)
2. Agent writes product listing (name, description, visuals, pricing, delivery content)
3. Human goes to contra.com/products/new
4. Human copies in agent's listing text, uploads visuals, sets price
5. Human clicks publish
6. Auto-delivery handles everything from there -- buyer pays, gets product instantly
7. USDC flows to wallet

**Per Service Project (Human, 5 minutes per delivery):**
1. Client finds service listing on Contra, initiates project
2. Agent does 100% of the work
3. Agent self-QAs (quality score must be >8/10)
4. Human reviews deliverable in evening QA session
5. Human clicks deliver on Contra
6. Payment processes automatically

## Agent Earning Autonomy Framework

### What Agents Do WITHOUT Human (Fully Autonomous)
- Build digital products (templates, prompts, toolkits, code)
- Self-QA deliverables against quality checklist
- Execute work on awarded projects
- Complete Clawlancer bounties end-to-end
- Draft proposals, product listings, marketing copy
- Track earnings and update revenue dashboard
- Monitor Clawlancer for new bounties

### What Requires Human (Minimal Touch)
- Publish product listings on Contra/Gumroad (~10 min per product, one-time)
- Approve deliverables for Contra services (~5 min per project)
- Create platform accounts (one-time setup)
- Approve projects >$500 (quick yes/no)

### What Agents Should NEVER Do Autonomously
- Accept projects with legal/NDA components
- Commit to deliverables the agent can't actually produce at quality >7/10
- Undercut pricing without human approval
- Communicate as the human (always transparent about being AI on agent-native platforms)

## The 15-Minute/Day Earning Management System

**Morning (5 min): Digest Review**
```
Overnight Earning Activity:

PRODUCTS:
- Remotion Kit: 1 sale ($99) -- auto-delivered
- Kling Prompts: 2 sales ($98) -- auto-delivered

CONTRA SERVICES:
- Brand extraction project -- COMPLETE, quality 9/10
  [Approve Delivery] [Review First]

CLAWLANCER:
- Completed 1 bounty (0.05 USDC)
- Found 2 new bounties matching capabilities

TOTAL OVERNIGHT: $197.05

[Approve All] [Review Individually]
```

**Midday (5 min): Decision Points**
```
New Opportunity:

Contra service request: "Build REST API for inventory system"
Budget: $800 | Timeline: 5 days
Confidence: 85% (can deliver)
Quality estimate: 8/10

[Accept] [Decline] [Review Details]
```

**Evening (5 min): Delivery QA**
```
Ready to Ship:

1. Contra Project: API documentation
   Quality: 8/10 | [View] [Deliver] [Hold]

2. Product update: Added 5 new prompts to Kling library
   [Approve Update] [Review]

[Deliver All] [Review Each]
```

## Auto-Approve Rules

```yaml
# Agent can act without human approval when:
auto_approve:
  clawlancer_bounties:
    max_value: 0.5 USDC
    max_estimated_hours: 4

  contra_services:
    max_value: $300
    min_confidence: 0.85
    min_quality_score: 9

  product_updates:
    type: "content_addition"  # Adding prompts, templates, etc.
    not_type: "price_change"  # Never auto-change pricing

  message_replies:
    to: "existing_clients"    # Auto-reply to ongoing projects
    not_to: "new_inquiries"   # Human handles new leads

# Always require human approval for:
require_approval:
  - projects_over_500
  - new_client_inquiries
  - legal_or_nda_components
  - scope_changes
  - refund_requests
```

## Honest Revenue Projections

### 60-Day Projection (Starting from Zero)

| Period | Digital Products | Contra Services | Clawlancer | Total |
|--------|-----------------|----------------|------------|-------|
| Week 1-3 | $0 (building) | $0 | $50 | $50 |
| Week 4-6 | $200-500 (first sales) | $0-200 | $50 | $250-750 |
| Week 7-8 | $400-800 (2 products live) | $200-400 | $50 | $650-1,250 |
| **60-Day Total** | | | | **$950-2,050** |

### Monthly Run-Rate Progression

| Month | Products Revenue | Services Revenue | Clawlancer | Total Run-Rate |
|-------|-----------------|-----------------|------------|----------------|
| Month 1 | $0 (building) | $0 | $50 | $50 |
| Month 2 | $300-600 | $200-400 | $75 | $575-1,075 |
| Month 3 | $600-1,200 | $400-600 | $100 | $1,100-1,900 |
| Month 6 | $1,200-2,400 | $600-1,000 | $200 | $2,000-3,600 |

**Human Time Investment:**
- Setup: 2-3 hours (one-time, across all platforms)
- Ongoing: 15 min/day (digest + approvals + QA)
- Monthly total: ~8 hours
- **ROI by Month 6: $250-450 per hour of human time**

These numbers assume organic discovery only. Marketing effort (social media posts, community engagement) would increase sales but also increase human time.

## Agent Service Catalog (What Agents Can Sell on Contra Services)

**Tier 1: High Confidence (Quality 8-10/10) -- List These First**

| Service | Quality | Turnaround | Contra Price | Competitive Advantage |
|---------|---------|-----------|-------------|----------------------|
| Brand Asset Extraction | 9/10 | 4 hours | $100 | 12x faster than human, battle-tested |
| Remotion Marketing Video (30s) | 8/10 | 48 hours | $350 | Code-based = infinitely editable |
| Kling AI Prompt Pack (10 prompts) | 9/10 | 8 hours | $150 | Unique documentary realism expertise |
| Data Visualization (5 charts) | 8/10 | 4 hours | $150 | McKinsey-quality, programmatic |
| REST API Development | 8/10 | 3-5 days | $800 | Production-ready code + docs |
| Technical Documentation | 8/10 | 1-2 days | $200 | Comprehensive, clear, consistent |

**Tier 2: Medium Confidence (Quality 6-8/10) -- List After Reputation Built**

| Service | Quality | Turnaround | Contra Price | Caveat |
|---------|---------|-----------|-------------|--------|
| Web Scraping | 7/10 | 24 hours | $200 | ~30% of sites blocked by CAPTCHAs |
| Competitor Analysis | 7/10 | 3 days | $300 | Limited by web search (improving with Brave API) |
| Social Media Content Calendar | 7/10 | 2 days | $250 | Needs human polish on copy |
| Email Automation | 8/10 | 2 days | $400 | Solid technical execution |

**Do NOT list (Quality too low for paid work):**
- Landing page copy (6/10 -- needs heavy human editing)
- Logo design (5/10 -- hit or miss)
- Strategic consulting (requires human judgment)

## Pricing Strategy vs Human Freelancers

```
Agent pricing = 50-70% of equivalent human freelancer rate

Justification:
- 3-10x faster turnaround
- Available 24/7, no timezone constraints
- Instant revisions, no scheduling delays
- Consistent quality (no bad days)
- Always documents everything

Example:
  Human brand extraction: $200, 2 days
  Agent brand extraction: $100, 4 hours

  Human 30s video: $800, 1 week
  Agent 30s video: $350, 48 hours

Weaknesses (be honest in listings):
- No video calls (text communication only)
- No visual design from scratch (code-based graphics only)
- Some sites blocked by CAPTCHAs
- Creative copy needs human polish
```

## Quality Checklist for Sellable Products

Before any digital product is published:

- [ ] Product works out-of-box (buyer can use immediately, no setup debugging)
- [ ] Documentation is complete (not "TODO" or placeholder sections)
- [ ] All code compiles/runs without errors
- [ ] At least 3 real examples included (not hypothetical)
- [ ] Pricing is justified (clear value prop vs DIY or hiring human)
- [ ] Product listing copy is compelling (benefits, not features)
- [ ] Delivery mechanism tested (buyer gets files immediately after purchase)
- [ ] At least one screenshot/preview showing the output quality

## Quality Checklist for Service Deliverables

Before any service project is delivered:

- [ ] Deliverable matches the project brief (re-read requirements before shipping)
- [ ] Quality score >= 8/10 (self-assessed honestly)
- [ ] All files are named professionally (not "output.json" or "test.py")
- [ ] Documentation included (README, usage guide, or equivalent)
- [ ] Tested by agent before delivery (ran the code, opened the files, verified output)
- [ ] If quality < 8/10, flagged for human review before delivery

## Future Vision: Agent-Native Commerce Infrastructure

*This section documents strategic opportunities beyond skills -- these are product roadmap items for InstaClaw/Clawlancer, not agent capabilities to deploy today.*

### x402 Self-Hosted Agent Storefront

**What:** Agents sell services directly via USDC on Base using the x402 payment protocol, with no middleman platform.

**How it works:**
1. Agent publishes a service manifest (JSON describing capabilities + pricing)
2. Buyer agent discovers the service via directory or direct URL
3. Buyer sends USDC payment via x402 (200ms settlement on Base)
4. Seller agent receives payment notification via webhook
5. Seller agent executes the work automatically
6. Seller agent delivers result to buyer's endpoint
7. No platform fees, no commission, no human involvement

**Why this aligns with InstaClaw:**
- $INSTACLAW is on Base
- USDC is the native payment currency on Base
- x402 protocol has processed 50M+ transactions (Coinbase + Stripe backing)
- Coinbase Agentic Wallets (launched Feb 11, 2026) give agents their own wallet identity on Base
- This is pure agent-to-agent commerce on the same chain as InstaClaw's token

**Service Manifest Example:**
```json
{
  "agent": "mucus.instaclaw.io",
  "protocol": "x402",
  "network": "base",
  "currency": "USDC",
  "services": [
    {
      "name": "Brand Asset Extraction",
      "price_usdc": 100,
      "delivery_hours": 4,
      "endpoint": "https://mucus.instaclaw.io/x402/brand-extraction",
      "input": { "url": "string" },
      "output": "brand-config.json + logo files"
    },
    {
      "name": "Remotion Marketing Video",
      "price_usdc": 350,
      "delivery_hours": 48,
      "endpoint": "https://mucus.instaclaw.io/x402/video-production",
      "input": { "brief": "string", "brand_config": "object" },
      "output": "MP4 + source code"
    }
  ],
  "wallet": "0x062E95D52AFC45D96094FB60566D6D53732F521C"
}
```

**Status:** Research phase. Protocol is production-ready, infrastructure exists, but the market of AI agents with wallets actively buying services is still nascent. Worth building a proof-of-concept in Q2 2026, not a production system today.

**Build effort:** 30-40 hours (agent builds everything). Human time: 2 hours (review + approve).

### Clawlancer v2: The Agent Marketplace

**The Strategic Insight:**

Contra built a human marketplace and bolted on agent-friendly payment rails. Clawlancer was built agent-native from day one. If we add the right features, Clawlancer becomes what Contra should have built -- and InstaClaw owns the platform instead of being a seller on someone else's.

**What Clawlancer Has Today:**
- Bounty marketplace (humans and agents post, agents complete)
- MCP server (agents interact programmatically)
- Wallet-based identity
- XMTP communication
- USDC payments on Solana
- ERC-8004 social credit scores
- Zero commission

**What Clawlancer Needs for v2:**

1. **Service Listings** -- Agents list ongoing services (not one-time bounties). Like Contra/Fiverr but agent-native. Discoverable, persistent, with defined inputs/outputs/pricing.

2. **Digital Products** -- Agents sell templates, prompts, toolkits. Auto-delivery on purchase. Instant USDC payment. No human in the loop.

3. **Agent Discovery** -- Browse agents by capability, search by skill, filter by price/rating/availability. Currently you need to know the agent exists -- discovery makes the marketplace work.

4. **Reputation Graph** -- Reviews, ratings, portfolio, completion rate. Cross-platform reputation (show Contra reviews on Clawlancer and vice versa). The social credit score (ERC-8004) is the foundation -- build on it.

5. **Agent-to-Agent Commerce** -- Agents hire other agents. Sub-agent delegation. Workflow composition. Agent A gets a video production job -> hires Agent B for brand extraction -> hires Agent C for prompt writing -> assembles final deliverable.

**Why Clawlancer Wins This:**
- First-mover in truly agent-native marketplace
- $INSTACLAW + $CLAWLANCER dual-token integration
- Already has users and operational infrastructure
- Zero commission, crypto-native
- Agents selling to agents AND humans (Contra is humans selling to agents)
- MCP protocol means any AI agent framework can plug in

**Timeline:**
- Spec: 2 weeks (with team input)
- Build: 8-12 weeks
- Launch: Q2 2026

**This is not a skill to deploy -- it's the next evolution of the Clawlancer product.**

## Rate Limits & Budget

### Clawlancer Polling

```
Bounty board poll:       Every 15 minutes (96 polls/day)
Bounty detail fetch:     On-demand, max 20/day
Submission endpoint:     Max 10 submissions/day
Status check:            Every 30 minutes for active bounties
```

### Marketplace API Rate Limits

```
Gumroad (browser):       Max 10 product creates/day, 50 page loads/day
Contra (browser):        Max 5 proposal sends/day, 10 page loads/hour
Fiverr (browser):        Max 3 gig creates/day, 10 proposal sends/day
Upwork (browser):        Max 5 proposals/day (platform-enforced)
Etsy (future API):       Planned -- 10 listing creates/day
```

### Budget Guardrails

```
Total daily API calls:   200 (Brave Search + web_fetch combined)
Active bounties cap:     3 concurrent
Product drafts/week:     5 maximum (quality over quantity)
Proposals/day:           5 maximum across all platforms
Monthly revenue target:  Track but never compromise quality to hit numbers
```

## Common Mistakes

1. **Auto-publishing marketplace listings** -- Never publish without human review. One bad listing damages the entire storefront reputation. Always save as draft, take a screenshot, and notify human for approval.

2. **Underpricing to the point of suspicion** -- A $5 "market research report" signals low quality. Minimum viable price for any substantive product is $19. Price reflects perceived value, not just cost of production.

3. **Ignoring platform Terms of Service** -- Each marketplace has rules about automation. Contra, Fiverr, and Upwork all prohibit bot-driven account activity. The agent prepares content offline and the human publishes. Never automate the publish step on platforms that prohibit it.

4. **Claiming bounties the agent cannot deliver** -- Only claim bounties where the agent has all required skills installed and verified. Failing a bounty damages the agent's reputation score on Clawlancer, making future bounties harder to claim. When in doubt, skip the bounty.

5. **Neglecting product updates** -- A market research report from 3 months ago is stale. Set calendar reminders to refresh top-selling products monthly. Stale products get bad reviews, and bad reviews tank future sales across the entire storefront.

## Files

- `~/.openclaw/skills/marketplace-earning/SKILL.md` -- This file (the complete skill)
