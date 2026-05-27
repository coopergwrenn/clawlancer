---
name: base-morpho
description: Lend USDC and other ERC20 tokens on Morpho (Base mainnet) — list vaults by APY, supply, check positions, withdraw.
---

# Base Morpho — Lending on Base

<!-- BASE_SKILL_MORPHO_V1 -->

**Use this skill when:** the user wants to lend USDC (or other ERC20 tokens) on Base to earn yield, manage Morpho vault positions, compare APYs across vaults, or withdraw funds.

## What you can do

1. **List top vaults by APY** — show the highest-yielding curated Morpho vaults on Base
2. **Supply to a vault** — deposit USDC (or WETH, cbBTC, etc.) into a named vault
3. **Check positions** — show the user's current Morpho positions across all vaults
4. **Withdraw** — pull funds back to the user's wallet

## How Morpho works (1-paragraph background)

Morpho is a permissionless lending protocol. Curators (Steakhouse, Re7, Gauntlet, MEV Capital, etc.) build "vaults" that allocate deposited capital across underlying Morpho markets. Each vault has a strategy: target APY, risk profile, allowed assets. When the user deposits USDC to a Steakhouse USDC vault, the curator allocates that capital to the best yield opportunities. The user earns the vault's net APY. ERC-4626-compliant.

## Read endpoints

**1. List top USDC vaults on Base by current net APY:**

```bash
curl -sS https://blue-api.morpho.org/graphql \
  -H 'content-type: application/json' \
  --data-raw '{"query":"query { vaults(where: { chainId_in: [8453], asset_symbol_in: [\"USDC\"] }, first: 10, orderBy: NetApy, orderDirection: Desc) { items { address symbol name asset { symbol decimals } state { netApy totalAssetsUsd fee } } } }"}'
```

Response shape: `data.vaults.items[]` with `address`, `name`, `state.netApy` (decimal, e.g. 0.082 = 8.2%), `state.totalAssetsUsd`.

**2. Check the user's positions across vaults on Base:**

```bash
WALLET="${BANKR_WALLET_ADDRESS}"  # or BASE_SUB_ACCOUNT_ADDRESS post-v1.5
curl -sS https://blue-api.morpho.org/graphql \
  -H 'content-type: application/json' \
  --data-raw "{\"query\":\"query { userByAddress(address: \\\"${WALLET}\\\", chainId: 8453) { vaultPositions { vault { address symbol name } assets assetsUsd shares } } }\"}"
```

**3. Get a specific vault's details (decimals, share price, manager):**

```bash
curl -sS https://blue-api.morpho.org/graphql \
  -H 'content-type: application/json' \
  --data-raw "{\"query\":\"query { vaultByAddress(address: \\\"${VAULT_ADDR}\\\", chainId: 8453) { name symbol asset { symbol decimals address } state { netApy } } }\"}"
```

## Prepare endpoints — supply USDC to a vault

Morpho vaults are ERC-4626. To deposit:

1. **Approve** the vault contract to spend the user's USDC
2. **Call `deposit(assets, receiver)`** on the vault contract

USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)

Calldata helper (depends on the `cast` binary, which is in PATH on all InstaClaw VMs via foundry):

```bash
# Deposit calldata
cast calldata "deposit(uint256,address)" $AMOUNT_WEI $RECEIVER

# Withdraw calldata (ERC-4626 withdraw)
cast calldata "withdraw(uint256,address,address)" $ASSETS_WEI $RECEIVER $OWNER

# Or redeem by share count
cast calldata "redeem(uint256,address,address)" $SHARES $RECEIVER $OWNER
```

## Signing — broadcast via Bankr

For the approve + deposit pair, use Bankr CLI (handles ERC-20 approve natively, can broadcast arbitrary contract calls):

```bash
# 1. Approve the vault to pull USDC
bankr send --to 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --data $(cast calldata "approve(address,uint256)" $VAULT_ADDR $AMOUNT_WEI)

# 2. Deposit into the vault
bankr send --to $VAULT_ADDR \
  --data $(cast calldata "deposit(uint256,address)" $AMOUNT_WEI $WALLET)
```

Both return tx hashes. Report them with `https://basescan.org/tx/0x...` to the user.

**v1.5+ alternative:** if `BASE_SUB_ACCOUNT_ADDRESS` is set, use `~/.openclaw/scripts/sub-account-send.sh` instead — the Sub Account spend permission lets the agent sign without per-tx user confirmation.

## When NOT to use this skill

- Token swaps → use `bankr swap` or `~/.openclaw/skills/base-aerodrome/SKILL.md`
- Borrowing → currently route to `~/.openclaw/skills/base-moonwell/SKILL.md`; Morpho borrowing requires per-market mechanics not in v1
- Non-USDC vaults beyond top-10 — out of scope for v1; check Morpho's web app

## Worked examples

**"lend 50 USDC on the top morpho vault"**
1. GET vault list → identify highest-APY vault (e.g. Steakhouse USDC at 8.2%)
2. Confirm with user: "Steakhouse USDC at 8.2% APY, depositing 50 USDC. OK?"
3. Approve + deposit; broadcast both via `bankr send`
4. Reply: "Done. Deposited 50 USDC to Steakhouse USDC at 8.2% APY. Tx: https://basescan.org/tx/0x..."

**"show me my morpho positions"**
1. GET userByAddress
2. Format as a clean list: vault name, deposited USDC, USD value, current APY

**"withdraw 25 USDC from morpho"**
1. GET userByAddress → identify which vault holds funds (or ask if multiple)
2. Build withdraw calldata; broadcast via `bankr send`
3. Reply with tx hash + new remaining balance
