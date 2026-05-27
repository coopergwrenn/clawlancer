---
name: base-aerodrome
description: Swap tokens, provide liquidity, and stake on Aerodrome (Base mainnet) — Base's leading DEX, Velodrome v2 fork with stable + volatile pools.
---

# Base Aerodrome — Swaps & Liquidity on Base

<!-- BASE_SKILL_AERODROME_V1 -->

**Use this skill when:** the user wants to swap tokens on Base, add or remove liquidity from a pool, look up pool stats (TVL, APR, volume), or earn AERO emissions by staking LP positions.

## What you can do

1. **Swap tokens** — exact-input swaps via the Aerodrome router
2. **Quote a swap** — preview output amount + slippage before executing
3. **List top pools** — discovery by TVL or emissions APR
4. **Add liquidity** — deposit token pair into a pool
5. **Remove liquidity** — pull funds back
6. **Stake / unstake** — boost APR via gauge staking for AERO emissions
7. **Claim AERO rewards** — collect accrued emissions

## Key contracts on Base

- Router: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- Factory: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`
- Voter: `0x16613524e02ad97eDfeF371bC883F2F5d6C480A5`
- AERO token: `0x940181a94A35A4569E4529A3CDfB74e38FD98631`
- Sugar (LP data): `0x68c19e13618c41158fE4bAba1b8fb3A9c74bDb0A`

## Read endpoints

**1. Quote a swap (router's `getAmountsOut` for exact-input):**

```bash
ROUTER="0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"
FACTORY="0x420DD381b31aEf6683db6B902084cB0FFECe40Da"
TOKEN_IN="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"   # USDC
TOKEN_OUT="0x4200000000000000000000000000000000000006"  # WETH
AMT_IN=$((50 * 10**6))  # 50 USDC

# Route: [(from, to, stable, factory), ...]
# stable=false for volatile pools (most major pairs)
cast call $ROUTER "getAmountsOut(uint256,(address,address,bool,address)[])(uint256[])" \
  $AMT_IN "[($TOKEN_IN,$TOKEN_OUT,false,$FACTORY)]" --rpc-url $BASE_RPC_URL
```

The returned uint256[] gives the input amount at index 0 and the output amount at index 1.

**2. List top pools by TVL** (via Sugar LP contract — fast on-chain query):

```bash
SUGAR="0x68c19e13618c41158fE4bAba1b8fb3A9c74bDb0A"
# Sugar exposes paginated views — limit=20 offset=0 returns top 20 pools by TVL.
# The exact ABI varies by Sugar version; pin to the deployed version on Base.
cast call $SUGAR "all(uint256,uint256,address)(...)" 20 0 $WALLET --rpc-url $BASE_RPC_URL
```

For richer queries (volume, fees, emissions APR), the Aerodrome subgraph is more ergonomic:

```bash
curl -sS https://api.studio.thegraph.com/query/40526/aerodrome-v1/v0.0.6 \
  -H 'content-type: application/json' \
  --data-raw '{"query":"{pools(first:10,orderBy:totalValueLockedUSD,orderDirection:desc){id token0{symbol}token1{symbol}totalValueLockedUSD volumeUSD feesUSD stable}}"}'
```

**3. User's LP positions:**

```bash
WALLET="${BANKR_WALLET_ADDRESS}"
# Check LP token balance for a specific pool
cast call $POOL "balanceOf(address)(uint256)" $WALLET --rpc-url $BASE_RPC_URL

# Or via subgraph for full portfolio view
curl -sS https://api.studio.thegraph.com/query/40526/aerodrome-v1/v0.0.6 \
  -H 'content-type: application/json' \
  --data-raw "{\"query\":\"{liquidityPositions(where:{user:\\\"${WALLET}\\\"}){pool{id token0{symbol}token1{symbol}}liquidityTokenBalance}}\"}"
```

## Prepare endpoints

**Swap exact-input (single hop):**

```bash
# Compute minOut: amountOut * (1 - slippage). Use 0.5% = 50bps as a safe default.
MIN_OUT=$((AMT_OUT * 9950 / 10000))
DEADLINE=$(($(date +%s) + 600))  # 10 minutes from now

cast calldata "swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)" \
  $AMT_IN $MIN_OUT \
  "[($TOKEN_IN,$TOKEN_OUT,false,$FACTORY)]" \
  $WALLET $DEADLINE
```

**Add liquidity (volatile pool):**

```bash
cast calldata "addLiquidity(address,address,bool,uint256,uint256,uint256,uint256,address,uint256)" \
  $TOKEN_A $TOKEN_B false \
  $AMT_A $AMT_B $MIN_A $MIN_B \
  $WALLET $DEADLINE
```

**Remove liquidity:**

```bash
cast calldata "removeLiquidity(address,address,bool,uint256,uint256,uint256,address,uint256)" \
  $TOKEN_A $TOKEN_B false \
  $LIQUIDITY $MIN_A $MIN_B \
  $WALLET $DEADLINE
```

## Signing — broadcast via Bankr

```bash
# Example: swap 50 USDC for WETH
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
ROUTER="0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"

# 1. Approve router to pull USDC
bankr send --to $USDC \
  --data $(cast calldata "approve(address,uint256)" $ROUTER $AMT_IN)

# 2. Execute the swap
bankr send --to $ROUTER --data $SWAP_CALLDATA
```

**Simpler path for common pairs:** `bankr swap` natively supports USDC↔ETH↔cbBTC on Base. Prefer it for those pairs — it does its own routing. Use Aerodrome explicitly only when the user asks for it or when Bankr doesn't support the pair.

## Quote comparison best practice

Before any swap, also quote via Uniswap (`~/.openclaw/skills/base-uniswap/SKILL.md`) and present the better-priced route. Don't silently route to Aerodrome if Uniswap gives a better rate.

## When NOT to use this skill

- Token launches → use `bankr launch` (Bankr CLI)
- Lending → `base-morpho` or `base-moonwell`
- Perps → `base-avantis`

## Worked examples

**"swap 100 USDC for ETH"**
1. Quote on both Aerodrome AND Uniswap; pick the better-priced route
2. Confirm rate + slippage with user
3. Approve + swap via `bankr send` to the chosen router
4. Reply with tx hash + actual output amount + price impact

**"show me the top aerodrome pools by TVL"**
1. Query Sugar contract or subgraph (limit 10)
2. Format: pair, TVL, 24h volume, emissions APR
3. Suggest top-3 with brief one-line risk note
