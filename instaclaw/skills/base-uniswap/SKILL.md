---
name: base-uniswap
description: Swap tokens and manage liquidity on Uniswap v3 (Base mainnet) — Universal Router for swaps, NonfungiblePositionManager for v3 positions.
---

# Base Uniswap — Swaps & v3 Positions on Base

<!-- BASE_SKILL_UNISWAP_V1 -->

**Use this skill when:** the user wants to swap tokens on Base via Uniswap, get a Uniswap price quote for comparison against Aerodrome, or manage Uniswap v3 concentrated-liquidity positions.

## What you can do

1. **Quote a swap** — preview output and best fee tier via Quoter
2. **Swap via Universal Router** — execute exact-input swaps
3. **Compare against Aerodrome** — best practice: always quote both DEXes
4. **List v3 positions** — show open concentrated-liquidity positions
5. **Mint a v3 position** — provide concentrated liquidity in a fee tier
6. **Collect fees** — pull accrued fees from a v3 position
7. **Burn a position** — close out a v3 LP position

## Key contracts on Base

- Universal Router: `0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD`
- SwapRouter02: `0x2626664c2603336E57B271c5C0b26F421741e481`
- QuoterV2: `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
- NonfungiblePositionManager: `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`
- Factory: `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`
- WETH: `0x4200000000000000000000000000000000000006`
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## Read endpoints — quoting

**1. Quote a single-pool exact-input swap (QuoterV2):**

```bash
QUOTER="0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"
TOKEN_IN="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"   # USDC
TOKEN_OUT="0x4200000000000000000000000000000000000006"  # WETH
FEE=500   # 0.05% — typical for stable-volatile pairs. Try 3000 (0.3%) for less liquid.
AMT_IN=$((50 * 10**6))  # 50 USDC

# Returns (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
cast call --rpc-url $BASE_RPC_URL $QUOTER \
  "quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)" \
  "($TOKEN_IN,$TOKEN_OUT,$AMT_IN,$FEE,0)"
```

For multi-hop, use `quoteExactInput(bytes,uint256)` with a packed path.

**2. Pool data subgraph:**

```bash
curl -sS https://api.studio.thegraph.com/query/<id>/uniswap-v3-base/<v> \
  -H 'content-type: application/json' \
  --data-raw '{"query":"{pools(first:10,orderBy:totalValueLockedUSD,orderDirection:desc){id token0{symbol}token1{symbol}feeTier totalValueLockedUSD volumeUSD}}"}'
```

**3. Per-fee-tier quote sweep — pick the best:**

```bash
for FEE in 100 500 3000 10000; do
  echo "fee=$FEE:"
  cast call --rpc-url $BASE_RPC_URL $QUOTER \
    "quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)" \
    "($TOKEN_IN,$TOKEN_OUT,$AMT_IN,$FEE,0)" 2>&1 | head -1
done
```

## Prepare endpoints — swaps

**SwapRouter02 (simpler than Universal Router for single-pool swaps):**

```bash
ROUTER="0x2626664c2603336E57B271c5C0b26F421741e481"
DEADLINE=$(($(date +%s) + 600))
# minOut = expectedOut * (1 - slippage). 0.5% slippage:
MIN_OUT=$((EXPECTED_OUT * 9950 / 10000))

cast calldata "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" \
  "($TOKEN_IN,$TOKEN_OUT,$FEE,$WALLET,$AMT_IN,$MIN_OUT,0)"
```

**Universal Router** is more flexible (multi-hop, permit2, mixed protocols) but the calldata is opaque — encode via a viem/ethers script if you need it. For 95% of single-pool swaps, SwapRouter02 is simpler.

## Signing — broadcast via Bankr

```bash
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
ROUTER="0x2626664c2603336E57B271c5C0b26F421741e481"

# 1. Approve router to pull USDC
bankr send --to $USDC \
  --data $(cast calldata "approve(address,uint256)" $ROUTER $AMT_IN)

# 2. Execute swap
bankr send --to $ROUTER --data $SWAP_CALLDATA
```

**Note:** `bankr swap` natively supports common Base pairs and will use the better of Uniswap/Aerodrome under the hood. Prefer it for routine swaps. Use this skill explicitly when the user asks for Uniswap specifically, when comparing quotes, or for less-liquid pairs.

## Cross-DEX quote comparison (the standard pattern)

ALWAYS quote both Uniswap AND Aerodrome before executing a non-trivial swap. Pseudocode:

```
quote_uni = quote_uniswap(token_in, token_out, amount_in)
quote_aero = quote_aerodrome(token_in, token_out, amount_in)
chosen = max(quote_uni, quote_aero)  # higher output wins
report_to_user("Best route: <DEX>, output: X tokens, price impact: Y%")
execute_via_chosen_router()
```

This is the difference between "agent did a swap" and "agent did a good swap." Always quote both.

## When NOT to use this skill

- Common pairs (USDC↔ETH, USDC↔cbBTC) with no comparison needed → just `bankr swap`
- Lending → `base-morpho` / `base-moonwell`
- Perps → `base-avantis`

## Worked examples

**"swap 100 USDC for the most ETH you can get"**
1. Quote on Uniswap (try fee tiers 100, 500, 3000) → pick best
2. Quote on Aerodrome (`base-aerodrome` skill) → compare
3. Use the better-priced route
4. Confirm slippage + execute
5. Report: "Used <DEX>, swapped 100 USDC for X ETH at $Y/ETH, tx: ..."
