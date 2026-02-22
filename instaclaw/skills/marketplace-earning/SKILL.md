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

## Digital Product Catalog

These are products the agent can create end-to-end and list for sale on Gumroad, Contra, and Etsy.

### Product 1: Market Research Reports

```
Format:         PDF (20-40 pages) + executive summary (2 pages)
Pricing:        $29 (single industry) / $49 (comparative) / $99 (deep-dive + data)
Delivery:       Instant download via Gumroad or Contra
Turnaround:     4-6 hours to produce from scratch
Data sources:   Brave Search API, web_fetch, public financial filings, industry databases
Contents:       Market size, growth rate, key players, SWOT analysis, trend analysis,
                competitive landscape, customer segments, 5-year outlook
Refresh cycle:  Monthly updates increase perceived value (subscription model at $19/mo)
```

### Product 2: Brand Audit Documents

```
Format:         PDF (15-30 pages) + brand-config.json + screenshot comparisons
Pricing:        $49 (basic audit) / $99 (audit + recommendations) / $149 (audit + rebrand brief)
Delivery:       24-48 hour turnaround (requires target brand URL)
Components:     Typography analysis, color palette extraction, logo variant inventory,
                competitor brand comparison, consistency score (1-10), accessibility check,
                mobile vs desktop brand presentation, social media brand alignment
Dependencies:   Brand Asset Extraction skill (Skill 8) feeds directly into this product
```

### Product 3: Content Calendar Templates

```
Format:         Google Sheets template + PDF guide (10 pages)
Pricing:        $19 (single platform) / $29 (multi-platform) / $49 (multi-platform + content ideas)
Delivery:       Instant download
Platforms:      Instagram, Twitter/X, LinkedIn, TikTok, YouTube, Newsletter
Contents:       30-day posting schedule, content pillars framework, hashtag strategy,
                optimal posting times by platform, content repurposing matrix,
                engagement tracking template, monthly review checklist
Dependencies:   Social Media Content Engine skill provides the content strategy knowledge
```

### Product 4: Competitive Analysis Packs

```
Format:         PDF (25-50 pages) + spreadsheet with raw data + executive brief (3 pages)
Pricing:        $79 (3 competitors) / $149 (5 competitors) / $199 (10 competitors + quarterly updates)
Delivery:       48-72 hour turnaround
Depth levels:
  Basic:        Pricing comparison, feature matrix, social presence
  Standard:     + hiring signals, content strategy analysis, customer sentiment
  Premium:      + market positioning map, strategic recommendations, quarterly refresh
Data sources:   Brave Search API, Competitive Intelligence skill output, public data
Dependencies:   Competitive Intelligence skill (Skill 4) provides the analysis engine
```

### Product 5: Custom Data Dashboards

```
Format:         Interactive HTML dashboard + PDF snapshot + raw CSV data
Pricing:        $99 (single metric set) / $199 (multi-source) / $299 (custom + monthly refresh)
Delivery:       72-hour turnaround for initial build, 24h for refreshes
Data sources:   Public APIs, web scraping, user-provided data, financial feeds
Contents:       KPI tracking, trend visualization, comparison charts, anomaly detection,
                automated insights summary, export-ready tables
Tech stack:     HTML/CSS/JS (Chart.js), runs in any browser, no server needed
```

## Passive Income Build Schedule

### Week 1: Foundation Setup

```
Day 1-2:  Set up Gumroad account (human does KYC, agent builds profile page)
Day 3:    Set up Contra profile (human verifies, agent writes bio + uploads portfolio)
Day 4-5:  Agent creates first 2 digital products (Market Research Report template,
          Content Calendar Template) using existing skill outputs
Day 6:    Human reviews products, agent uploads to Gumroad
Day 7:    Agent creates product landing page copy, social media announcement drafts
```

### Week 2: First Products Live

```
Day 8-9:  Agent produces 2 more products (Brand Audit template, Competitive Analysis sample)
Day 10:   Agent lists products on Contra digital products section
Day 11:   Agent drafts 5 Fiverr gig descriptions for services (human creates account + publishes)
Day 12:   Agent creates email sequences for product launch (Email Outreach skill)
Day 13-14: Agent monitors first sales, collects feedback, adjusts pricing
```

### Week 3: Marketing Push

```
Day 15-16: Agent creates social media content promoting products (Social Media skill)
Day 17:    Agent writes 3 blog posts / articles demonstrating expertise (SEO play)
Day 18:    Agent produces free lead magnet (mini report) to capture emails
Day 19:    Agent sets up automated email drip for lead magnet subscribers
Day 20-21: Agent A/B tests product titles and descriptions, tracks conversion rates
```

### Week 4: Optimization & Scale

```
Day 22-23: Agent analyzes sales data, identifies best-performing product
Day 24:    Agent creates 2 variants of best seller (different price points / bundles)
Day 25:    Agent drafts Upwork proposals for 5 relevant projects
Day 26:    Agent creates monthly subscription version of top product
Day 27-28: Agent generates first monthly earnings report, identifies next growth lever
```

## Contra Digital Products Workflow

Step-by-step for listing a digital product via browser automation.

```
STEP 1: Navigate to Contra dashboard
  browser.open({ profile: "openclaw", targetUrl: "https://contra.com/dashboard" })
  Wait 3 seconds for page load

STEP 2: Click "Create New" or "Add Product"
  browser.click({ selector: '[data-testid="create-project"]' })  // selector may vary
  If selector not found, use: browser.act({ request: "Click the button to create a new product" })

STEP 3: Fill product details
  Title:        [Product name from catalog above]
  Description:  [Generated description, 200-500 words, benefit-focused]
  Price:        [From pricing tier in catalog]
  Category:     "Digital Products" or "Templates"
  Tags:         [Relevant keywords, max 5]

STEP 4: Upload product file
  browser.upload({ selector: 'input[type="file"]', file: "/path/to/product.pdf" })

STEP 5: Upload cover image
  Agent generates a cover image description, human provides or agent uses placeholder
  browser.upload({ selector: '[data-testid="cover-upload"]', file: "/path/to/cover.png" })

STEP 6: Preview listing (DO NOT publish)
  Take screenshot of preview
  Save draft
  Notify human: "Product listing ready for review. Please check draft and click Publish."

STEP 7: Human publishes
  Human reviews draft, clicks Publish
  Agent confirms listing is live via page check
```

**Important:** Never auto-publish on Contra. Always save as draft and notify human. This protects against listing errors and maintains human oversight of public-facing content.

## Agent Earning Autonomy Framework

### Tier 1: Fully Autonomous

The agent handles everything without human involvement.

```
Scope:          Clawlancer bounty board
Actions:        Poll for new bounties every 15 minutes
                Evaluate bounty requirements against agent capabilities
                Claim bounties that match skill set (market research, content, analysis)
                Produce deliverables using existing skills
                Submit completed work
                Track payment status
Earnings:       Variable, depends on bounty availability
Human effort:   Zero per transaction
Guardrails:     Max 3 active bounties at once
                Max $500 total outstanding (uncollected) at any time
                Auto-reject bounties requiring skills not installed
                Auto-reject bounties with turnaround < 2 hours (quality risk)
```

### Tier 2: Semi-Autonomous

Agent does the production work, human approves before it goes live.

```
Scope:          Digital product creation + marketplace listings
Actions:        Create product content (reports, templates, analyses)
                Draft marketplace listings (title, description, pricing)
                Prepare cover images and preview materials
                Upload as draft to marketplace
                Notify human for review and publish
Earnings:       Passive income from product sales
Human effort:   2-3 minutes per product review
Guardrails:     Never publish without human approval
                Never change pricing on live listings without approval
                Never respond to customer messages without approval
                Max 5 new product drafts per week (quality over quantity)
```

### Tier 3: Human-Led

Agent assists but human drives the process.

```
Scope:          Custom client work, proposals, negotiations
Actions:        Research potential clients and their needs
                Draft proposals and cover letters
                Prepare portfolio samples
                Write deliverable outlines
                Produce drafts of client deliverables
Earnings:       Service-based income (highest per-project value)
Human effort:   15-30 minutes per client interaction
Guardrails:     Agent never sends proposals directly to clients
                Agent never negotiates pricing or scope
                Agent never makes commitments on timelines
                All client communication goes through human
```

## 15-Min/Day Management System

The human spends exactly 15 minutes per day managing the earning system.

### Morning Check (5 minutes) -- 8:00 AM

```
1. Review overnight bounty completions        [1 min]
   - Agent shows: bounties claimed, submitted, paid
   - Human action: acknowledge or flag issues

2. Review new product orders                   [1 min]
   - Agent shows: orders received, auto-fulfilled, pending
   - Human action: confirm auto-fulfilled orders look correct

3. Review marketplace notifications            [2 min]
   - Agent shows: new messages, reviews, listing performance
   - Human action: respond to any messages requiring personal touch

4. Approve pending drafts                      [1 min]
   - Agent shows: product drafts or proposals awaiting publish
   - Human action: approve or request changes
```

### Midday Production (5 minutes) -- 12:00 PM

```
1. Check deliverable progress                  [2 min]
   - Agent shows: active bounties and their completion status
   - Human action: review any flagged quality concerns

2. Review product creation queue               [2 min]
   - Agent shows: products in progress, next in pipeline
   - Human action: confirm priorities are correct

3. Quick earnings check                        [1 min]
   - Agent shows: today's earnings vs target
   - Human action: none (informational)
```

### Evening Wrap-Up (5 minutes) -- 6:00 PM

```
1. Update listings if needed                   [2 min]
   - Agent shows: listing performance data, suggested price adjustments
   - Human action: approve or reject price changes

2. Reconcile daily earnings                    [2 min]
   - Agent shows: total earned today, breakdown by source
   - Human action: verify amounts match platform dashboards

3. Tomorrow's plan                             [1 min]
   - Agent shows: planned bounty targets, product pipeline, proposals to send
   - Human action: adjust priorities if needed
```

## Auto-Approve Rules

```yaml
auto_approve:
  clawlancer_bounties:
    claim:
      max_value: 200            # Auto-claim bounties up to $200
      required_skills: true     # Only if agent has all required skills
      max_active: 3             # Never hold more than 3 active bounties
    submit:
      quality_check: true       # Agent runs quality checklist before submit
      auto_submit: true         # Submit without human review
    reject:
      turnaround_under: 2h      # Reject bounties with < 2hr deadline
      skills_missing: true      # Reject if missing required skills

  digital_products:
    create_draft: true          # Agent can create product drafts freely
    publish: false              # NEVER auto-publish -- human must approve
    price_change: false         # NEVER auto-change prices
    respond_to_customer: false  # NEVER auto-respond to customers
    fulfill_order: true         # Auto-send digital files on purchase
    refund: false               # NEVER auto-refund -- human decides

  proposals:
    draft: true                 # Agent can draft proposals freely
    send: false                 # NEVER auto-send proposals
    negotiate: false            # NEVER auto-negotiate
    accept_project: false       # NEVER auto-accept projects

human_required:
  - Publishing any marketplace listing
  - Changing pricing on live products
  - Responding to customer messages
  - Accepting client projects
  - Processing refunds
  - Withdrawing funds
  - Any action involving payment information
  - Anything that creates a legal obligation
```

## Revenue Projections

### 60-Day Ramp Table

| Day | Milestone | Cumulative Revenue | Active Products | Active Bounties |
|---|---|---|---|---|
| 1-7 | Account setup, first product created | $0 | 0 | 0 |
| 8-14 | First 2 products live, first bounty claimed | $25-75 | 2 | 1 |
| 15-21 | Marketing push, 4 products live | $100-250 | 4 | 2 |
| 22-28 | Optimization, best sellers identified | $200-500 | 5 | 2-3 |
| 29-35 | Subscription products, repeat customers | $350-800 | 6 | 3 |
| 36-42 | Proposals on Upwork/Fiverr generating leads | $500-1200 | 7 | 3 |
| 43-49 | First client project completed | $750-1800 | 8 | 3 |
| 50-56 | Referral and repeat business building | $1000-2500 | 9 | 3 |
| 57-60 | System running at target velocity | $1200-3000 | 10 | 3 |

### Monthly Projections (Steady State)

| Month | Bounty Income | Product Sales | Service Income | Total Range |
|---|---|---|---|---|
| Month 1 | $50-150 | $50-150 | $100-200 | $200-500 |
| Month 2 | $100-300 | $150-400 | $200-500 | $450-1200 |
| Month 3 | $200-500 | $300-800 | $500-1200 | $1000-2500 |
| Month 4 | $250-600 | $400-1000 | $600-1500 | $1250-3100 |
| Month 5 | $300-700 | $500-1200 | $800-2000 | $1600-3900 |
| Month 6 | $400-900 | $700-1600 | $1200-3000 | $2300-5500 |
| Month 9 | $500-1000 | $1000-2500 | $1500-4000 | $3000-7500 |

**Assumptions:** Agent is active 20+ hours/day, human spends 15 min/day managing, bounty board has consistent volume, 2-3% conversion rate on marketplace listings, average product price $49, average service project $350.

**Conservative vs Optimistic:** Low end assumes slow marketplace traction and limited bounty supply. High end assumes good product-market fit and growing bounty ecosystem.

## Agent Service Catalog

### Tier 1: Fully Autonomous Delivery (6 Services)

These services the agent can deliver end-to-end without human intervention.

| Service | Description | Delivery Time | Price Range |
|---|---|---|---|
| **Market Research** | Industry analysis, competitor mapping, trend reports | 4-8 hours | $29-99 |
| **Content Writing** | Blog posts, articles, newsletters, website copy | 2-4 hours | $19-79 |
| **Data Analysis** | Spreadsheet analysis, visualization, insight reports | 4-6 hours | $49-149 |
| **Email Campaigns** | Sequence writing, subject line optimization, A/B variants | 3-5 hours | $29-99 |
| **Social Media Content** | 30-day content calendars, post copy, hashtag strategy | 3-6 hours | $19-49 |
| **Competitive Monitoring** | Weekly competitor digest, alert setup, trend tracking | Ongoing | $49-99/mo |

### Tier 2: Human Oversight Required (4 Services)

Agent produces 80% of the deliverable, human reviews and finalizes.

| Service | Description | Agent Role | Human Role | Price Range |
|---|---|---|---|---|
| **Website Development** | Landing pages, simple sites | Code generation, content | Design review, deployment | $199-999 |
| **Graphic Design Assets** | Social templates, banners, presentations | Layout drafts, copy | Visual polish, brand approval | $49-199 |
| **Video Production** | Short-form video, motion graphics | Script, Remotion template, editing | Creative direction, final cut | $99-499 |
| **Ad Campaign Management** | Meta/Google ad copy, targeting suggestions | Copy variants, audience research | Budget approval, bid management | $149-499/mo |

### Do NOT List (3 Services to Avoid)

These services create legal, ethical, or safety risks. Never offer them.

| Service | Why Not |
|---|---|
| **Legal Advice** | Unauthorized practice of law. Agent is not a licensed attorney. Even "legal templates" risk liability. |
| **Financial Planning** | Regulated activity requiring licenses (Series 65, CFP). Market research is OK; personalized financial advice is not. |
| **Medical Content** | Health claims require clinical expertise. Misinformation risk is too high. General wellness content is a gray area -- avoid. |

## Pricing Strategy vs Human Freelancers

The agent's structural advantages are speed (24/7 availability) and zero marginal labor cost. This allows significant underpricing while maintaining margins.

| Service | Human Freelancer Price | Agent Price | Agent Discount | Agent Advantage |
|---|---|---|---|---|
| Market Research Report | $200-500 | $29-99 | 60-80% cheaper | 4-8hr delivery vs 5-10 days |
| Blog Post (1500 words) | $100-300 | $19-49 | 75-85% cheaper | 2hr delivery vs 3-5 days |
| Competitive Analysis | $500-2000 | $79-199 | 80-90% cheaper | 48hr delivery vs 2-4 weeks |
| Content Calendar (30 day) | $200-500 | $19-49 | 85-90% cheaper | 3hr delivery vs 1 week |
| Email Campaign (5 emails) | $250-750 | $29-99 | 85-90% cheaper | 4hr delivery vs 1-2 weeks |
| Data Dashboard | $500-2000 | $99-299 | 75-85% cheaper | 72hr delivery vs 2-4 weeks |

**Pricing philosophy:** Price at 40-60% below the cheapest human option. This makes the agent the obvious value choice while still generating meaningful revenue. Avoid pricing so low that buyers question quality (under $15 signals low effort).

**Race-to-bottom protection:** Bundle products (report + dashboard + monitoring = $199) rather than competing on individual item price. Subscriptions ($49/mo for weekly reports) create recurring revenue that isolated products cannot.

## Quality Checklists

### Products Quality Checklist

- [ ] Content is original and not copy-pasted from sources (rephrase all research)
- [ ] All data points include source attribution with URLs
- [ ] PDF formatting is clean: consistent fonts, proper headings, page numbers
- [ ] Pricing tier is correctly set and matches product depth
- [ ] Product description accurately represents contents (no over-promising)
- [ ] Cover image is professional and matches brand style
- [ ] File size is reasonable (under 10MB for PDFs, under 50MB for dashboards)
- [ ] Test download works correctly on the target marketplace

### Services Quality Checklist

- [ ] Deliverable matches the scope agreed in the proposal
- [ ] Turnaround time commitment was met
- [ ] All sources and research are cited
- [ ] Output format matches client's stated preference
- [ ] Spelling, grammar, and formatting are clean (run through review pass)
- [ ] Deliverable has been compared against quality standard for the service tier
- [ ] Client brief requirements are checked off one by one
- [ ] Final file is in the correct format and opens without errors

## Future Vision

### x402 Micropayments

When the x402 payment protocol is live, agents will be able to:
- Sell individual data points for $0.01-0.50 via HTTP 402 responses
- Charge per-API-call for research queries (machine-to-machine commerce)
- Stream earnings in real-time rather than waiting for marketplace payouts
- Enable true pay-per-use pricing for all agent services

This transforms the agent from a marketplace seller into an API-first service provider. A competitive analysis that costs $79 as a PDF could be served as 200 individual API calls at $0.25 each = $50 total, but with zero production overhead per request.

### Clawlancer v2: Agent-to-Agent Marketplace

The next phase of Clawlancer enables agents to hire other agents:
- Agent A (specialized in research) posts a bounty for "design a cover image"
- Agent B (specialized in design) claims the bounty and delivers
- Payment is automatic, agent-to-agent, no human in the loop
- Agents build reputation scores based on delivery quality and speed

This creates a true agent economy where specialized agents collaborate on complex projects, each earning for their contribution. A single client project worth $500 could flow through 3-4 specialized agents, each earning their share.

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
