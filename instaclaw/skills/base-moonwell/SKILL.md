---
name: base-moonwell
description: Supply, borrow, and manage positions on Moonwell (Base mainnet) — a Compound v2-style money market with mUSDC, mWETH, mcbETH, mcbBTC.
---

# Base Moonwell — Supply / Borrow on Base

<!-- BASE_SKILL_MOONWELL_V1 -->

**Use this skill when:** the user wants to supply collateral, borrow against it, repay a borrow, or check Moonwell positions on Base. Moonwell is a Compound v2 fork — supply earns interest, supplied assets count as collateral, borrow against collateral.

## What you can do

1. **List markets** — show available assets, supply APY, borrow APR, collateral factor, utilization
2. **Supply (mint)** — deposit an asset, receive mTokens, start earning supply APY
3. **Enter market** — mark a supplied asset as collateral (required before borrowing)
4. **Borrow** — pull an asset from a market, accruing borrow APR
5. **Repay** — pay down a borrow position
6. **Withdraw (redeem)** — pull funds back out of a supplied position
7. **Check positions** — show supply + borrow balances per market, account liquidity, health

## Key contracts on Base

- Comptroller: `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C`
- mUSDC: `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22`
- mWETH: `0x628ff693426583D9a7FB391E54366292F509D457`
- mcbETH: `0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5`
- mcbBTC: `0xF877ACaFA28c19b96727966690b2f44d35aD5976`
- mUSDbC: `0x703843C3379b52F9FF486c9f5892218d2a065cC8`

(Update list when new markets launch. The MOONWELL_MARKETS env var on each VM can override.)

## Read endpoints

**1. Per-market state** (call the market contract directly via cast):

```bash
# Supply rate per block (annualize: supplyRate * 365 * 24 * 60 * 60 / 2 for 2s blocks)
cast call 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22 \
  "supplyRatePerTimestamp()(uint256)" --rpc-url $BASE_RPC_URL

# Borrow rate
cast call $MARKET "borrowRatePerTimestamp()(uint256)" --rpc-url $BASE_RPC_URL

# Total supply + total borrows
cast call $MARKET "totalSupply()(uint256)" --rpc-url $BASE_RPC_URL
cast call $MARKET "totalBorrows()(uint256)" --rpc-url $BASE_RPC_URL

# Exchange rate (underlying per mToken share)
cast call $MARKET "exchangeRateStored()(uint256)" --rpc-url $BASE_RPC_URL
```

**2. User's account state:**

```bash
WALLET="${BANKR_WALLET_ADDRESS}"

# Supplied (mToken balance)
cast call $MARKET "balanceOf(address)(uint256)" $WALLET --rpc-url $BASE_RPC_URL

# Borrow balance
cast call $MARKET "borrowBalanceStored(address)(uint256)" $WALLET --rpc-url $BASE_RPC_URL

# Cross-market account liquidity (returns: error, liquidity, shortfall)
cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "getAccountLiquidity(address)(uint256,uint256,uint256)" $WALLET --rpc-url $BASE_RPC_URL
```

A subgraph also exists: `https://api.studio.thegraph.com/query/<id>/moonwell-base/<v>` — useful for historical positions, but direct contract reads are usually faster for live state.

## Prepare endpoints

**Supply (mint mTokens):**

```bash
# 1. Approve the mToken to spend your underlying
cast calldata "approve(address,uint256)" $MARKET $AMOUNT_WEI

# 2. Mint mTokens
cast calldata "mint(uint256)" $AMOUNT_WEI
```

**Enter market (required before borrowing against this collateral):**

```bash
# Enter a single market (Comptroller takes an array)
cast calldata "enterMarkets(address[])" "[$MARKET]"
```

**Borrow:**

```bash
cast calldata "borrow(uint256)" $AMOUNT_WEI
```

**Repay:**

```bash
# 1. Approve the mToken to pull underlying
cast calldata "approve(address,uint256)" $MARKET $AMOUNT_WEI

# 2. Repay borrow
cast calldata "repayBorrow(uint256)" $AMOUNT_WEI
# Or repay maximum: cast calldata "repayBorrow(uint256)" $(python3 -c 'print(2**256-1)')
```

**Withdraw (redeem):**

```bash
# Redeem by underlying amount
cast calldata "redeemUnderlying(uint256)" $AMOUNT_WEI

# Or by mToken share count
cast calldata "redeem(uint256)" $SHARES
```

**Note on mWETH redeem:** Moonwell's Base markets use mWETH (wrapping the ERC-20 WETH at `0x4200...0006`), not a native-ETH wrapper. `redeem()` and `redeemUnderlying()` return ERC-20 WETH to the wallet — no native ETH receive step, so no Bankr smart-account limitation in play. (If a future Moonwell market on Base wraps native ETH directly à la Compound v2's cEther, its `redeem()` would unwrap and use `transfer()` to send 2300-gas native ETH back — this would revert for Bankr-managed wallets. Treat any new mEther-style market as untested before routing through it.)

## Signing — broadcast via Bankr

```bash
# Example: supply 100 USDC to Moonwell
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
M_USDC="0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22"
AMT=$((100 * 10**6))  # 100 USDC

# 1. Approve mUSDC to spend USDC
bankr send --to $USDC --data $(cast calldata "approve(address,uint256)" $M_USDC $AMT)

# 2. Mint mUSDC
bankr send --to $M_USDC --data $(cast calldata "mint(uint256)" $AMT)
```

Always report the tx hash and a basescan.org link.

## Safety checks (do these BEFORE borrowing)

- Read `getAccountLiquidity` AFTER each supply to confirm the user has borrowing power
- NEVER borrow > 80% of available liquidity — leaves headroom for price moves
- Check `closeFactor` and `liquidationIncentive` on the Comptroller for risk math

## When NOT to use this skill

- Lending without collateral mechanics → `base-morpho` (simpler ERC-4626 vaults)
- Token swaps → `bankr swap` or `base-aerodrome`
- Perps → `base-avantis`

## Worked examples

**"supply 200 USDC to moonwell as collateral"**
1. Approve mUSDC → mint mUSDC → enterMarkets([mUSDC])
2. Reply with three tx hashes + "you now have $200 USDC supplied earning X% APY, marked as collateral"

**"borrow 50 cbBTC against my moonwell collateral"**
1. Pre-check getAccountLiquidity — confirm liquidity ≥ requested USD-equivalent borrow value
2. Compute conservative borrow size (cap at 70% of liquidity)
3. cast calldata "borrow(uint256)" → bankr send
4. Reply with tx hash, new debt position, current health factor
