---
name: base-avantis
description: Open and manage perpetual futures positions on Avantis (Base mainnet) — USDC-margined perps with up to 100x leverage.
---

# Base Avantis — Perps on Base

<!-- BASE_SKILL_AVANTIS_V1 -->

**Use this skill when:** the user wants to open / close / modify a leveraged position on a perpetual futures market (BTC-PERP, ETH-PERP, etc.) on Base. USDC is the collateral asset; positions are settled in USDC.

## What you can do

1. **List markets** — show available trading pairs, max leverage, current funding rate, OI
2. **Check positions** — show user's open positions, PnL, liquidation price, used margin
3. **Open a position** — long or short with USDC collateral + leverage
4. **Modify a position** — add/remove margin, change stop-loss/take-profit
5. **Close a position** — fully or partially exit, realize PnL

## Architecture (1-paragraph background)

Avantis runs a multi-asset perp DEX with pooled liquidity (USDC junior + USDC senior tranches). Trader PnL is paid from the LP pool; LPs earn fees + spread. Positions are tokenized as ERC-721 NFTs in the TradingStorage contract. Trade execution flows through the TradeExecutor contract, which interacts with PriceAggregator (Pyth) for marks.

## Key contracts on Base

- TradingStorage: `0xf16d1B91Fd64eb31BCFD8DefAa5D6f3eBe8c3CB6` (positions, params)
- TradeExecutor: `0x35e6f1f7E13F60B30dEdB8B83BdF2bcADd7eb466` (open / close / modify)
- PriceAggregator (Pyth): `0xC52F84d05D69ECc8c5C9B252c81dEcad7B0C5099`
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

**Source the actual addresses from Avantis's official docs** at https://docs.avantisfi.com — the above are illustrative and may shift; verify before executing.

## Read endpoints

**1. List active markets:**

```bash
curl -sS https://api.avantisfi.com/v1/markets \
  -H 'accept: application/json'
```

Returns per-market: pair id, max leverage, taker fee, current funding, OI long/short, mark price (from Pyth).

**2. Check user's positions:**

```bash
WALLET="${BANKR_WALLET_ADDRESS}"
curl -sS "https://api.avantisfi.com/v1/positions?trader=${WALLET}"
```

Returns each open position: pair, long/short, collateral, leverage, entry price, current mark, unrealized PnL, liquidation price.

**3. Funding rates + OI** (for the LIST view):

```bash
curl -sS "https://api.avantisfi.com/v1/markets/${PAIR_ID}/stats"
```

## Prepare endpoints — open a position

Open flow (via the SDK / direct contract call):

1. **Approve USDC** to TradingStorage for the collateral amount
2. **Call `openTrade(...)`** with trade params: pair, long/short, collateral, leverage, slippage, optional SL/TP

Encode `openTrade` calldata (this is the canonical interface; check Avantis docs for any param order changes):

```bash
# Pseudo-call — verify struct shape against current ABI
cast calldata "openTrade((address,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256))" \
  "($WALLET,$PAIR_ID,$COLLATERAL_USDC_WEI,$LEVERAGE,$OPEN_PRICE,$SLIPPAGE_BPS,$IS_LONG,$TP_PRICE,$SL_PRICE,$BLOCK)"
```

Open via the API to skip the calldata-encoding step:

```bash
curl -sS -X POST "https://api.avantisfi.com/v1/trades/open" \
  -H 'content-type: application/json' \
  --data "{\"trader\":\"${WALLET}\",\"pair_id\":${PAIR_ID},\"collateral\":${COLLATERAL},\"leverage\":${LEV},\"is_long\":${IS_LONG},\"slippage_bps\":50}"
```

The API returns the EIP-712 trade payload and the address to call; bankr signs and broadcasts.

## Prepare endpoints — close a position

```bash
cast calldata "closeTradeMarket(uint256)" $TRADE_INDEX
```

Or partial close: `closeTradeMarketPartial(uint256,uint256)` with the size to close.

## Signing — broadcast via Bankr

```bash
TRADING_STORAGE="0xf16d1B91Fd64eb31BCFD8DefAa5D6f3eBe8c3CB6"
TRADE_EXECUTOR="0x35e6f1f7E13F60B30dEdB8B83BdF2bcADd7eb466"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
COLLAT=$((200 * 10**6))  # 200 USDC

# 1. Approve
bankr send --to $USDC \
  --data $(cast calldata "approve(address,uint256)" $TRADING_STORAGE $COLLAT)

# 2. Open the trade
bankr send --to $TRADE_EXECUTOR --data $OPEN_TRADE_CALLDATA
```

Report tx hash + a https://app.avantisfi.com/profile link so the user can monitor.

## Safety checks (CRITICAL — perps are leveraged)

- **NEVER open a position > 10% of the user's total USDC balance without explicit confirmation.**
- **NEVER use leverage > 10x without explicit confirmation.** (Max is 100x but most users shouldn't.)
- **ALWAYS quote the liquidation price BEFORE confirming.** Liq price = entry × (1 ± 1/leverage × maintenance_margin_factor).
- **Set a default SL at 50% of collateral.** Most users want a hard backstop.
- If funding is extreme (>0.1%/8h), warn the user — they'll bleed PnL holding the position.

## When NOT to use this skill

- Spot trading → `base-aerodrome` / `base-uniswap` / `bankr swap`
- Token launches → `bankr launch`
- Lending → `base-morpho` / `base-moonwell`

## Worked examples

**"open a 2x long on ETH with 100 USDC"**
1. GET market data for ETH-PERP → confirm available + leverage allowed
2. Compute liquidation price (entry × 0.5)
3. Confirm with user: "Open 2x long ETH-PERP, 100 USDC collateral, $X entry, liq at $Y. OK?"
4. Approve + openTrade via bankr
5. Reply with trade index + entry price + liq price + position monitoring link

**"close my ETH long"**
1. GET positions → find the trade index
2. cast calldata "closeTradeMarket(uint256)" → bankr send
3. Reply: "Closed ETH long. Realized PnL: $Z. Tx: ..."
