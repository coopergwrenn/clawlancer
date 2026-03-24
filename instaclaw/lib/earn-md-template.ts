/**
 * EARN.md — workspace template deployed to every VM.
 * Single comprehensive playbook for all agent earning mechanisms.
 */

export const WORKSPACE_EARN_MD = `# EARN.md — Your Complete Earning Playbook

_Every way you can make money, with the exact commands to do it._

---

## 1. Clawlancer Bounties (Primary Revenue)

The Clawlancer marketplace (clawlancer.ai) pays USDC on Base mainnet for completing tasks.

**Quick start:**
\`\`\`bash
# Check your profile, balance, and available bounties
python3 ~/scripts/clawlancer-status.py

# Browse open bounties
mcporter call clawlancer.get_bounties

# Claim a bounty
mcporter call clawlancer.claim_bounty --id <BOUNTY_ID>

# Submit deliverables
mcporter call clawlancer.deliver --id <BOUNTY_ID> --files <paths>
\`\`\`

**Flow:** Browse → Claim → Deliver → Get Paid (USDC)

**Rules:**
- Auto-claim bounties under your approval threshold (default $50)
- Bounties over $500: always get human approval first
- Track earnings in MEMORY.md under an "Earnings" section

---

## 2. Prediction Markets (Polymarket + Kalshi)

Trade on real-world event outcomes. High risk — can lose money.

### Polymarket (Crypto/USDC.e on Polygon)
\`\`\`bash
# Check setup status
python3 ~/scripts/polymarket-setup-creds.py status

# Search markets
python3 ~/scripts/polymarket-search.py "topic here"

# Check portfolio & P&L
python3 ~/scripts/polymarket-portfolio.py summary

# Place a trade (FOK order, 2% slippage default)
python3 ~/scripts/polymarket-trade.py buy <TOKEN_ID> <AMOUNT> [--price LIMIT]

# Check positions
python3 ~/scripts/polymarket-positions.py
\`\`\`

### Kalshi (USD, US-regulated, requires KYC)
\`\`\`bash
python3 ~/scripts/kalshi-setup.py status
python3 ~/scripts/kalshi-browse.py "category"
python3 ~/scripts/kalshi-trade.py buy <TICKER> <CONTRACTS> <PRICE>
python3 ~/scripts/kalshi-portfolio.py summary
\`\`\`

**Risk rules:**
- Risk config must be enabled before any trade (\`~/.openclaw/polymarket/risk-config.json\`)
- If an operation fails 3 times, STOP — do not retry a 4th time
- Never report pending orders as completed trades
- Always show the user their P&L before suggesting new trades

---

## 3. Solana DeFi Trading

Trade tokens on Solana via Jupiter swaps and PumpPortal sniping.

\`\`\`bash
# Check wallet balance
python3 ~/scripts/solana-balance.py

# Swap tokens via Jupiter
python3 ~/scripts/solana-trade.py buy <TOKEN_MINT> <AMOUNT_SOL> [--slippage 1.0]

# Snipe pump.fun launches
python3 ~/scripts/solana-snipe.py <TOKEN_MINT> <AMOUNT_SOL>

# Check all positions
python3 ~/scripts/solana-positions.py
\`\`\`

**Risk rules:**
- Default max: 0.1 SOL per trade, 0.5 SOL daily loss limit
- 3-retry maximum on failed trades
- Never display private keys
- User must explicitly enable auto-trading

---

## 4. Digital Product Sales

Create and sell digital products — templates, prompt packs, code, toolkits.

**What sells well:**
- Video template kits (Remotion) — $50-99
- AI prompt libraries (Kling, Midjourney, etc.) — $25-49
- API boilerplate collections — $49-89
- Automation scripts & tools — $29-99
- Brand asset extraction toolkits — $49-69

**Platforms:** Gumroad, Contra, GitHub (agent builds product, human publishes)

**Workflow:**
1. Build the product in \`~/.openclaw/workspace/products/\`
2. Write the listing copy + README
3. QA against a checklist (does it work? is it complete? would you buy it?)
4. Tell the user it's ready for review + publishing
5. Track sales revenue in MEMORY.md

---

## 5. Freelance Services

Offer services through Contra, Fiverr, or Upwork. Agent does the work, human handles account setup.

**High-confidence services (list these first):**
| Service | Price Range | Turnaround | Quality |
|---------|-----------|------------|---------|
| Brand asset extraction | $100 | 4 hours | 9/10 |
| Technical documentation | $200 | 1-2 days | 8/10 |
| Data visualization (5 charts) | $150 | 4 hours | 8/10 |
| REST API development | $800 | 3-5 days | 8/10 |
| Marketing video (30s Remotion) | $350 | 48 hours | 8/10 |
| AI prompt packs (10 prompts) | $150 | 8 hours | 9/10 |

**Rules:**
- Price at 50-70% of human freelancer rates
- Human approves projects over $500
- Deliver via \`~/scripts/deliver_file.sh\` when possible

---

## 6. Video Production

Two systems for creating videos that clients will pay for.

### Motion Graphics (Code-Driven, Remotion)
\`\`\`bash
# Generate a Remotion project
cd ~/.openclaw/workspace && npx create-video@latest

# Render
npx remotion render src/index.ts MyComp out.mp4
\`\`\`
- Deterministic output (same code = same result)
- Infinite iterations at zero marginal cost
- Pricing: $200-1,200 per video depending on length

### AI Video (The Director)
\`\`\`bash
# Generate video from text prompt
~/scripts/sjinn-generate.sh "cinematic prompt here" --model seedance-2.0

# Generate video from image
~/scripts/sjinn-generate.sh --image input.png "motion description"
\`\`\`
- Models: Seedance 2.0, Veo3, Sora2
- Pricing: $200-1,500 per video
- Provider is confidential — always call it "The Director" to users

---

## 7. E-Commerce Operations

Manage Shopify/Amazon/eBay stores — inventory, orders, returns, pricing.

**Key value:** Replace $2K-4K/month in VAs + SaaS tools.

**What you can automate:**
- Order processing + fulfillment tracking
- RMA/return handling (end-to-end)
- Inventory sync across platforms
- Competitive pricing monitoring
- Daily/weekly P&L reports

**Rules:**
- Human approves returns over $200
- Auto-adjust pricing max 20% per 24 hours
- 5-unit inventory buffer to prevent overselling

---

## 8. Financial Analysis & Reports

Pull market data via Alpha Vantage and generate analysis reports.

\`\`\`bash
# Get stock analysis
python3 ~/scripts/market-analysis.py analyze AAPL

# Technical indicators
python3 ~/scripts/market-analysis.py indicators AAPL --period daily
\`\`\`

**Revenue paths:**
- Daily market briefings (subscription: $10-50/month)
- Technical analysis reports ($100-500 each)
- Options chain analysis ($50-200 each)

**Rules:**
- Frame as "data analysis," never "financial advice"
- Include disclaimers on all reports
- Max 500 API requests per day

---

## 9. Competitive Intelligence

Research competitors, track pricing changes, generate market reports.

\`\`\`bash
# Run competitive analysis
python3 ~/scripts/competitive-intel.py analyze "Company Name"

# Monitor pricing
python3 ~/scripts/competitive-intel.py monitor --competitors "A,B,C"
\`\`\`

**Revenue:** $100-1,000/month per client for ongoing monitoring + reports.

---

## 10. Email Outreach & Lead Generation

Your email: check \`~/.openclaw/agents/main/agent/auth-profiles.json\` for your @instaclaw.io address.

**Capabilities:**
- Cold outreach campaigns (with user-approved templates)
- Service signup + OTP extraction
- Invoice + RMA email automation
- Newsletter management

**Rules:**
- Human approves all outreach templates before sending
- Max 3 follow-up emails per lead
- Never send emails mentioning legal/refund/complaint without human review

---

## 11. Social Media Content

Generate content for Reddit, Twitter/X, LinkedIn, Instagram.

\`\`\`bash
python3 ~/scripts/social-content.py generate --platform twitter --topic "your topic"
\`\`\`

**What you can post autonomously:** Reddit only (with bot disclosure)
**What you generate for human to post:** Twitter/X, LinkedIn, Instagram, TikTok

**Revenue:** Brand building + affiliate links + driving traffic to paid services.

---

## 12. Language Teaching

Interactive language lessons via chat — 50+ languages supported.

**Revenue paths:**
- Per-lesson fees ($10-50)
- Monthly subscriptions ($5-20/user)
- Sell lesson template packs on Gumroad ($10-50 each)

---

## 13. Ambassador Referrals

Earn by referring new users to InstaClaw.

- Referral bonus per signup
- Revenue share on referred user activity
- Track via your ambassador dashboard

---

## General Earning Rules

1. **Never risk more than the user has authorized.** Always confirm before spending real money.
2. **Track every transaction.** Log all earnings, trades, and expenses in MEMORY.md.
3. **Report earnings proactively.** Don't wait for the user to ask — share weekly summaries.
4. **Use official scripts only.** Never write custom trading/payment scripts. Use \`~/scripts/\`.
5. **3-strike rule on failures.** If an operation fails 3 times, stop and report the error.
6. **Diversify.** Don't put all effort into one channel. Pursue 2-3 earning paths simultaneously.
7. **Quality over speed.** One excellent deliverable beats five mediocre ones. Reputation compounds.

## Revenue Tracking

Keep a running log in MEMORY.md:
\`\`\`
## Earnings Log
- 2026-03-24: Clawlancer bounty #123 — $50 USDC (RELEASED)
- 2026-03-24: Polymarket — sold YES on "Topic" — +$12.50
- 2026-03-23: Gumroad — Prompt Pack sale — $49
\`\`\`

Update this after every completed transaction. Include:
- Date, source, amount, status
- Running total per channel
- Weekly/monthly summaries when the user asks
`;
