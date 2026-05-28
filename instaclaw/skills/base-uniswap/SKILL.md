---
name: base-uniswap
description: Swap tokens and manage liquidity on Uniswap v3 (Base mainnet) — Universal Router for swaps, NonfungiblePositionManager for v3 positions.
---

# Base Uniswap — Swaps & v3 Positions on Base

<!-- BASE_SKILL_UNISWAP_V1 -->

**Use this skill when:** the user wants to swap tokens on Base via Uniswap, get a Uniswap price quote for comparison against Aerodrome, or manage Uniswap v3 concentrated-liquidity positions.

<!-- BASE_SKILL_WALLET_LIMITS_V1 -->
## Wallet Limitations — read before composing any swap that touches ETH

Your Bankr wallet is an **EIP-7702-delegated smart account** that executes via ERC-4337 UserOperations. This has one practical consequence for Uniswap routing on Base: **anything that tries to send native ETH back to your wallet via `transfer()` will revert.**

What this rules out, even if it looks like a normal swap:

- **`IWETH9.withdraw()` (selector `0x2e1a7d4d`)** — the canonical WETH-to-native-ETH unwrap. Reverts with `simulation_reverted` because WETH9 uses `address.transfer(wad)` which forwards 2300 gas; the wallet's `receive()` needs more.
- **Universal Router `UNWRAP_WETH9` command (0x0c)** — invokes the same WETH9.withdraw() under the hood. Same revert.
- **SwapRouter02 swap variants that output to native ETH** — internally unwrap. Same revert.
- **Any path described as "swap to ETH" or "buy native ETH"** — all of them ultimately call WETH9.withdraw.

What works:

- **Swap token → WETH** (any fee tier, any router). WETH lands as a normal ERC-20 in the wallet. Use this for every "I want ETH" request.
- **Swap token → token** (USDC → cbBTC, USDC → AERO, etc.). No ETH receive step.
- **Receive native ETH** via a direct transfer (someone sends with `value > 0`). The EVM runs the wallet's `receive()` with the full transaction gas, not the 2300-gas stipend, so it succeeds. It's only the contract-mediated `transfer()` / `send()` pattern (2300 gas) that fails.

When the user asks "swap X for ETH" or "get me some ETH":

1. Quote token → **WETH** (not native ETH). WETH and ETH are 1:1 and interchangeable for every other Base DeFi operation in your skill catalog.
2. Execute the swap; the wallet receives WETH.
3. In the reply, tell the user honestly: "You now have X WETH (= the same as X ETH on Base). Gas is sponsored by InstaClaw via Bankr, so you don't need native ETH for transactions. If you want to send actual native ETH off-platform, ask me and I'll explain the workaround."

If they truly need native ETH (e.g., to bridge to another chain that doesn't recognize WETH): the workaround is to swap to USDC, transfer USDC to a self-custodied wallet on the destination side, and convert there. Don't promise an unwrap inside the agent's wallet — it won't work.

<!-- /BASE_SKILL_WALLET_LIMITS_V1 -->

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
