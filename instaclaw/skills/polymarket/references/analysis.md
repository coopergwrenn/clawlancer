# Market Analysis Framework

How to analyze prediction markets and produce actionable intelligence reports.

---

## Core Principle: Price = Probability

Every price on Polymarket represents a crowd-consensus probability:
- **$0.65 YES** = The crowd thinks there's a **65% chance** the event happens
- **$0.10 YES** = The crowd thinks it's **unlikely (10%)**
- **$0.92 YES** = The crowd thinks it's **very likely (92%)**

Prices are set by real money. Unlike polls or expert opinions, participants have financial skin in the game. This makes prediction market data one of the most reliable probabilistic signals available.

---

## Identifying Potentially Mispriced Markets

A market may be mispriced when:

### 1. News-Price Divergence
Recent news strongly suggests an outcome, but the market hasn't moved yet.

**Example:** A major credible source reports "Deal is 95% done" but the market is still at 60%. The market may be slow to react, especially if the news is very recent (<2 hours).

**How to check:**
```
1. Get current market price
2. web_search for the topic (last 24-48 hours)
3. Compare: Does the news suggest a different probability than the market?
4. Check volume: Low volume + stale price = more likely mispriced
```

### 2. Expert-Market Divergence
Domain experts or specialized data sources disagree with market pricing.

**Example:** CME FedWatch (institutional futures) shows 68% for a rate hold, but Polymarket shows 55%. The institutional data is typically more reliable for financial events.

### 3. Volume-Liquidity Mismatch
Very low liquidity markets may have stale or unreliable prices.

**Rule of thumb:**
- `liquidityNum` < $10,000 → Prices may be unreliable, note this in analysis
- `liquidityNum` > $100,000 → Prices are generally reliable
- `liquidityNum` > $1,000,000 → High confidence in price accuracy

### 4. Resolution Criteria Ambiguity
Sometimes markets have vague resolution criteria. Always read the `description` field before analyzing — a market might resolve differently than the question implies.

**What to look for:**
- **"At the sole discretion of..."** — means a committee or individual decides, introducing subjective risk. Prices may embed a discount for this uncertainty.
- **Date-dependent language** — "by March 2026" vs "before April 1, 2026" can differ by a day. Check whether the resolution date includes or excludes the boundary.
- **Ambiguous definitions** — "Will X launch Product Y?" — what counts as "launch"? A beta? A press release? Full public availability? The `description` field usually specifies, but if it doesn't, the market carries resolution risk.
- **Compound conditions** — "Will X happen AND Y happen?" — both conditions must be true. Markets on compound events tend to be cheaper than they should be because people overestimate the probability of conjunctions.

**Example:** A market asks "Will the US ban TikTok?" but the resolution criteria says "Resolves YES if legislation is signed into law requiring ByteDance to divest." This is narrower than a "ban" — a executive order blocking TikTok might NOT trigger resolution. The 5-10% gap between "ban" probability and "specific legislation" probability is where ambiguity lives.

---

## Category-Specific Analysis

### Politics
**What to look for:**
- Polling data vs. market prices — polls are lagging indicators, markets are forward-looking
- Endorsement announcements, debate performances, scandal news
- Compare to other prediction markets (PredictIt, Kalshi, Metaculus) for cross-validation
- Primary vs. general election dynamics

**Useful web searches:**
```
"[candidate] polls 2026"
"[election] latest news"
"[policy] vote count Senate"
```

**Key insight:** Political markets often overreact to single events (debates, scandals) and underreact to structural factors (demographics, incumbency advantage).

### Crypto
**What to look for:**
- On-chain data trends (if familiar) — whale movements, exchange flows
- Regulatory news (SEC, CFTC, global regulators)
- Technical levels (BTC at key support/resistance)
- Macro context (DXY strength, Treasury yields, risk sentiment)
- Halving cycles, ETF flows, institutional adoption news

**Useful web searches:**
```
"bitcoin price analysis [month] [year]"
"crypto regulation news latest"
"[token] development update"
```

**Key insight:** Crypto prediction markets often have higher volatility and wider spreads than political markets. Short-dated crypto markets can move 20%+ in hours on breaking news.

### Sports
**What to look for:**
- Injury reports, lineup changes
- Recent form and head-to-head records
- Home/away advantage
- Weather conditions (outdoor sports)
- Compare to major sportsbook odds (DraftKings, FanDuel, Bovada)

**Useful web searches:**
```
"[team] injury report today"
"[matchup] odds [sportsbook]"
"[player] status [date]"
```

**Key insight:** Sports markets on Polymarket are often less liquid than dedicated sportsbooks. Sportsbook odds are the primary reference — Polymarket prices should roughly align.

### Tech & Business
**What to look for:**
- Product launch timelines, earnings reports, regulatory decisions
- Company press releases, SEC filings, patent applications
- Industry analyst predictions, supply chain reports
- Historical pattern (does this company usually ship on time?)

**Useful web searches:**
```
"[company] [product] release date"
"[company] earnings preview [quarter]"
"[regulatory body] [decision] timeline"
```

**Key insight:** Tech markets often hinge on specific dates. Check if the resolution date aligns with known events (earnings calls, product events, regulatory deadlines).

### Entertainment & Pop Culture
**What to look for:**
- Streaming numbers, box office projections
- Awards season predictions, betting odds
- Social media buzz, viral moments
- Industry insider reports

**Useful web searches:**
```
"[show/movie] ratings latest"
"[awards show] predictions [year]"
"[celebrity] news"
```

**Key insight:** Entertainment markets tend to have lower volume and wider spreads. Fun to analyze but treat with lower confidence.

---

## Analysis Report Template

Use this structure for any market analysis the user requests:

```markdown
**Market Analysis: [Market Question]**
https://polymarket.com/event/[event_slug]/[market_slug]

**Current Market Pricing:**
| Outcome | Price | Implied Probability |
|---------|-------|-------------------|
| [Outcome 1] | $X.XX | XX% |
| [Outcome 2] | $X.XX | XX% |

Volume (24h): $X,XXX,XXX | Total: $XX,XXX,XXX | Liquidity: $X,XXX,XXX
Resolution: [Date] | 24h Change: [+/-X.X%]

**Recent Developments:**
- [Date]: [Key news item 1] (Source: [source])
- [Date]: [Key news item 2] (Source: [source])
- [Date]: [Key news item 3] (Source: [source])

**Assessment:**
[2-3 sentences analyzing whether the market price seems accurate given recent news.
Identify if the market appears overpriced or underpriced and explain why.
Reference specific data points or expert sources.]

**Key Factors to Watch:**
- [Factor 1 — date or trigger]
- [Factor 2 — date or trigger]
- [Factor 3 — date or trigger]

**Confidence in Market Price:**
[High/Medium/Low] — [1 sentence explanation. High = deep liquidity + aligned with expert sources. Low = thin liquidity or significant news-price divergence.]

*This is market analysis based on publicly available data, not financial advice.
Prediction market prices reflect crowd consensus, not guaranteed outcomes.*
```

---

## Opportunities Report Template

When scanning for market opportunities:

```markdown
**Polymarket Opportunities Report**
Generated: [Date and Time]

**Top 10 Most Active Markets (24h Volume)**
| # | Market | Yes | No | 24h Vol | Liquidity |
|---|--------|-----|-----|---------|-----------|
| 1 | [Question] | XX% | XX% | $X.XM | $X.XM |
...

**Biggest Movers (24h Price Change)**
| Market | Direction | Change | Current | Volume |
|--------|-----------|--------|---------|--------|
| [Question] | [up/down arrow] | +/-XX% | XX% Yes | $X.XM |
...

**Closing Soon (Next 7 Days)**
| Market | Resolves | Yes | No | Volume |
|--------|----------|-----|-----|--------|
| [Question] | [Date] | XX% | XX% | $X.XM |
...

**Spotlight Analysis** (top 3 markets by interest)
[Brief analysis paragraph for each, with news cross-reference]

*Data sourced from Polymarket Gamma API. Prices as of [timestamp].*
*This is market analysis, not financial advice.*
```

---

## Disclaimer Templates

### Standard (use on every analysis)
> *This is market analysis based on publicly available data, not financial advice. Prediction market prices reflect crowd consensus, not guaranteed outcomes.*

### Extended (use when discussing trading or specific positions)
> *This analysis is for informational purposes only and does not constitute financial advice, investment advice, or a recommendation to buy or sell any prediction market positions. Prediction market prices represent crowd consensus probabilities and can change rapidly. Past market behavior does not predict future outcomes. Always do your own research before making any financial decisions.*

---

## Common Analysis Mistakes

1. **Treating prices as certainties** — 80% probability means it DOESN'T happen 1 in 5 times. Always present as probabilities, not predictions.

2. **Ignoring liquidity** — A market with $500 in liquidity and a "90% Yes" price is far less reliable than one with $5M liquidity at "65% Yes".

3. **Recency bias** — One news article doesn't invalidate a market price backed by millions in volume. Markets may already have priced in the news.

4. **Hallucinating expert consensus** — Only cite specific sources you actually found via web search. Never invent "experts say..." without a source.

5. **Forgetting the vig** — Multi-outcome markets may have prices summing to >100% (the vig/overround). This is normal. Adjust by normalizing: `normalized_prob = price / sum_of_all_prices`.

6. **Not checking resolution criteria** — The `description` field contains the exact rules for how a market resolves. Read it before analyzing — a market might resolve differently than the question implies.
