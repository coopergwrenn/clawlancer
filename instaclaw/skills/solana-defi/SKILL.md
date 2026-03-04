# Solana DeFi Trading
```yaml
name: solana-defi
version: 1.0.0
updated: 2026-03-04
author: InstaClaw
phase: 1  # SKILL.md + wallet provisioning. Phase 2: Solana MCP server
triggers:
  keywords: [solana, defi, swap, jupiter, pump.fun, snipe, trade, token, spl, raydium, pumpportal, dexscreener, memecoin, bonk, wif, jup, sol]
  phrases: ["buy some", "sell some", "swap tokens", "snipe new launches", "check my balance", "what's in my wallet", "portfolio", "watch for new tokens", "pump.fun", "trade on solana", "buy memecoin", "token price", "new token launch"]
  NOT: [polymarket, kalshi, prediction market, stock market, base chain, ethereum]
```

## MANDATORY RULES — Read Before Anything Else

These rules override everything else in this skill file. Violating them causes real financial harm. A real user's agent destroyed its own session by looping on failed trades 69 times until it couldn't respond. These rules prevent that.

**Rule 0 — ALWAYS USE SCRIPTS:** When a user mentions Solana trading, swaps, sniping, portfolio, or any related topic, IMMEDIATELY use the scripts in ~/scripts/. Do NOT improvise. Do NOT write ad-hoc Python or Node.js code for trading operations. Do NOT raw-dog curl calls to Jupiter or PumpPortal. You already have everything you need — scripts are pre-installed. Run the script first, show the output, then discuss. If unsure whether things are set up, run:
```bash
python3 ~/scripts/solana-balance.py check --json
```

**Rule 1 — Maximum 3 Retries Per Operation:**
If a trade, API call, or script fails 3 times in a row:
- STOP immediately
- Tell the user exactly what failed and why
- Ask if they want you to try a different approach
- Do NOT retry a 4th time under any circumstances

**Rule 2 — Context Budget:**
Never dump raw transaction data, full error stack traces, or complete API responses into the conversation. Always summarize:
- GOOD: "Bought 0.05 SOL of BONK at $0.00003 — tx: 4xK7m..."
- BAD: [pasting 200 lines of transaction JSON]
Keep total trading-related context under 50KB per session.

**Rule 3 — Error Classification:**

TRANSIENT (retry with backoff 5s → 15s → 45s → STOP):
- HTTP 429 (rate limit)
- Network timeout
- RPC node congestion
- "blockhash not found" (retry with fresh blockhash)

PERMANENT (do NOT retry, tell user immediately):
- Insufficient funds / balance
- Invalid mint address
- Wallet not found
- Signature verification failed
- "Program failed to complete" (bad instruction)

DANGEROUS (stop ALL trading, alert user):
- 3+ consecutive empty responses
- Session file exceeding 200KB
- Process killed by SIGKILL (out of memory)
- Same error message appearing 5+ times

**Rule 4 — Position Sizing:**
- Check user's configured max trade size (default: 0.1 SOL)
- Check user's daily loss limit (default: 0.5 SOL)
- NEVER exceed these limits
- If no limits configured, use defaults and inform user
- Read limits from: `python3 ~/scripts/solana-trade.py limits --json`

**Rule 5 — Confirmation Before Execution:**
- ALWAYS tell the user what you're about to do before doing it
- Example: "I'm going to swap 0.1 SOL for BONK on Jupiter with 1% slippage. Estimated output: 3,450,000 BONK. Proceed?"
- Only skip confirmation if user has explicitly enabled auto-trade mode

## Commands

### Balance & Wallet
| Action | Command |
|--------|---------|
| Check balance | `python3 ~/scripts/solana-balance.py check --json` |
| SOL balance only | `python3 ~/scripts/solana-balance.py sol --json` |
| Token balances | `python3 ~/scripts/solana-balance.py tokens --json` |
| Wallet address | `python3 ~/scripts/setup-solana-wallet.py address` |
| Wallet status | `python3 ~/scripts/setup-solana-wallet.py status --json` |

### Trading (Jupiter V6)
| Action | Command |
|--------|---------|
| Get quote | `python3 ~/scripts/solana-trade.py quote --input SOL --output <MINT> --amount 0.1 --json` |
| Buy token | `python3 ~/scripts/solana-trade.py buy --mint <MINT> --amount 0.1 --slippage 100 --json` |
| Sell token | `python3 ~/scripts/solana-trade.py sell --mint <MINT> --amount ALL --slippage 100 --json` |
| Check limits | `python3 ~/scripts/solana-trade.py limits --json` |

### Sniping (PumpPortal)
| Action | Command |
|--------|---------|
| Buy on pump.fun | `python3 ~/scripts/solana-snipe.py buy --mint <MINT> --amount 0.05 --slippage 2500 --json` |
| Sell on pump.fun | `python3 ~/scripts/solana-snipe.py sell --mint <MINT> --amount ALL --slippage 2500 --json` |
| Watch launches | `python3 ~/scripts/solana-snipe.py watch --min-sol 5 --max-age 60 --json` |

### Portfolio & Positions
| Action | Command |
|--------|---------|
| Portfolio summary | `python3 ~/scripts/solana-positions.py summary --json` |
| Position details | `python3 ~/scripts/solana-positions.py detail --mint <MINT> --json` |
| P&L report | `python3 ~/scripts/solana-positions.py pnl --json` |
| Trade history | `python3 ~/scripts/solana-positions.py history --limit 20 --json` |

### Price Data (DexScreener)
| Action | Command |
|--------|---------|
| Token price | `python3 ~/scripts/solana-balance.py price --mint <MINT> --json` |
| Search token | `python3 ~/scripts/solana-balance.py search --query "bonk" --json` |

## Wallet Management

### Check Wallet Status
Before any trading operation, verify wallet setup:
1. Run `python3 ~/scripts/setup-solana-wallet.py status --json`
2. If wallet exists: check SOL balance, report to user
3. If no wallet: tell user "You don't have a wallet set up yet. Enable Solana DeFi Trading in your dashboard at instaclaw.io/dashboard."

### NEVER display or log the private key
If user asks for their private key: "Your private key is stored securely on your VM at ~/.openclaw/.env. I can't display it here for security. You can SSH into your VM to retrieve it if needed."

## Common Token Mint Addresses

| Token | Mint Address |
|-------|-------------|
| SOL (native) | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| WIF | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |

## Output Formatting

### Trade Executed
```
✅ [BUY/SELL] [amount] [token] at $[price]
   tx: [first 8 chars]... | confirmed in [X]s
   Wallet balance: [remaining SOL] SOL
```

### Trade Failed
```
❌ [action] failed: [1-line reason]
   Attempt [X/3]. [Next action: retrying in Xs / stopping / asking you]
```

### Portfolio Summary
```
📊 Your Portfolio (as of [time])
   SOL: [balance] ($[usd])
   [TOKEN1]: [balance] ($[usd]) [+/-X%]
   [TOKEN2]: [balance] ($[usd]) [+/-X%]
   Total: ~$[total_usd]
```

## Tiered Capabilities

### Tier 1 — Read Only (Default)
- Check wallet balance
- View token prices
- Search tokens
- View portfolio
- No trading, no risk

### Tier 2 — Manual Trading (Requires user confirmation per trade)
- Swap tokens via Jupiter
- Buy/sell on pump.fun via PumpPortal
- All trades require explicit user confirmation
- Position sizing enforced

### Tier 3 — Autonomous Monitoring (Requires auto_trade=true)
- Watch for new pump.fun launches
- Auto-buy within configured limits
- Monitor and auto-sell based on rules
- Stop after 3 failed trades or daily loss limit hit
- Report all activity to user

## Cross-Skill Integration

### Prediction Markets + Trading
- Use Polymarket/Kalshi odds to inform token trades
- "Polymarket shows 85% chance of [event]. Buy [related token]?"

### Web Search + Trading
Before buying unknown tokens:
- Search for token contract address, creator history
- Check X/Twitter for sentiment
- Verify project exists and isn't a known scam

## File Paths

| Path | Purpose |
|------|---------|
| `~/.openclaw/skills/solana-defi/SKILL.md` | This file |
| `~/.openclaw/skills/solana-defi/references/` | API reference docs |
| `~/scripts/setup-solana-wallet.py` | Wallet generation/status |
| `~/scripts/solana-trade.py` | Jupiter V6 trading |
| `~/scripts/solana-balance.py` | Balance + price checks |
| `~/scripts/solana-positions.py` | Portfolio + P&L |
| `~/scripts/solana-snipe.py` | PumpPortal sniping |
| `~/.openclaw/.env` | Wallet keys (NEVER display) |
