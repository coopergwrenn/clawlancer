# Escrow Contract Analysis

## Contract Overview

**File:** `contracts/src/WildWestEscrow.sol`
**Deployed:** Base mainnet
**Features:** ETH and ERC-20 (USDC) support, ReentrancyGuard protection

---

## Current Authorization Model

### Who Can Call `release()`?

```solidity
function release(bytes32 id) external nonReentrant {
    Escrow storage e = escrows[id];
    if (e.buyer == address(0)) revert EscrowNotFound();
    if (msg.sender != e.buyer) revert NotBuyer();  // <-- ONLY BUYER
    if (e.state != State.FUNDED) revert WrongState();
    // ...
}
```

**Answer: Only the buyer can call `release()`.** The contract explicitly checks `msg.sender != e.buyer` and reverts with `NotBuyer()` if anyone else calls it.

### Who Can Call `refund()`?

```solidity
function refund(bytes32 id) external nonReentrant {
    // ...
    bool isSeller = msg.sender == e.seller;
    bool isBuyerAfterDeadline = msg.sender == e.buyer && block.timestamp > e.deadline;

    if (!isSeller && !isBuyerAfterDeadline) revert NotAuthorized();
    // ...
}
```

**Answer:**
- **Seller:** Can refund at any time (cancel the deal)
- **Buyer:** Can refund only AFTER the deadline passes

---

## Current Transaction Flow

### Happy Path (Buyer Releases)
1. Buyer calls `createWithToken()` with USDC → escrow created, funds locked
2. Seller delivers service off-chain
3. Buyer calls `release()` → seller gets funds minus 1% fee

### Timeout Path (No Delivery)
1. Buyer creates escrow
2. Deadline passes without delivery
3. Buyer calls `refund()` → gets funds back

### Cancellation Path (Seller Cancels)
1. Buyer creates escrow
2. Seller decides not to fulfill
3. Seller calls `refund()` → buyer gets funds back

---

## Can We Add Oracle Authorization?

### Current State: No

The contract has no mechanism for a third-party (oracle) to trigger release. The check is hardcoded:

```solidity
if (msg.sender != e.buyer) revert NotBuyer();
```

### Options to Add Oracle Support

#### Option A: Redeploy with Oracle Role

Add an oracle address that's authorized to release:

```solidity
address public oracle;

function release(bytes32 id) external nonReentrant {
    Escrow storage e = escrows[id];
    if (e.buyer == address(0)) revert EscrowNotFound();

    // Allow buyer OR oracle to release
    if (msg.sender != e.buyer && msg.sender != oracle) revert NotAuthorized();

    if (e.state != State.FUNDED) revert WrongState();
    // ...
}

function setOracle(address _oracle) external onlyOwner {
    oracle = _oracle;
}
```

**Pros:** Clean, explicit authorization
**Cons:** Requires contract redeployment, need to migrate any active escrows

#### Option B: Buyer Delegates to Oracle (No Redeploy)

Create an off-chain pattern where the buyer pre-signs a release message, and the oracle submits it:

```solidity
// Add to contract
function releaseWithSignature(
    bytes32 id,
    uint256 deadline,
    bytes calldata buyerSignature
) external nonReentrant {
    Escrow storage e = escrows[id];
    // Verify signature is from buyer
    bytes32 hash = keccak256(abi.encodePacked(id, deadline, "RELEASE"));
    address signer = ECDSA.recover(hash, buyerSignature);
    if (signer != e.buyer) revert NotBuyer();
    if (block.timestamp > deadline) revert Expired();
    // ... release logic
}
```

**Pros:** No redeploy needed (if we add this function)
**Cons:** Still requires contract upgrade, more complex

#### Option C: Off-Chain Oracle + Buyer Wallet (Current Contract)

Keep current contract. Oracle triggers release by calling through the buyer's Privy wallet:

1. Seller marks delivery complete
2. Oracle verifies (time-based or validator)
3. Oracle calls our backend
4. Backend uses Privy to sign `release()` from buyer's wallet

**Pros:** No contract changes needed
**Cons:** Requires control of buyer wallet (only works for hosted agents), trust in our backend

---

## Recommendation for MVP

**Use Option C (Off-Chain Oracle) for launch:**

Since all Path A agents use Privy server wallets that we control, we can trigger release programmatically:

```typescript
// In auto-release cron
async function autoRelease(transaction: Transaction) {
  const buyer = await getAgentById(transaction.buyer_agent_id);

  // Sign release transaction using buyer's Privy wallet
  await signAgentTransaction(
    buyer.privy_wallet_id,
    ESCROW_ADDRESS,
    buildReleaseData(transaction.escrow_id)
  );
}
```

**For v2 (Path B external agents):**

Redeploy contract with explicit oracle role. External agents won't give us control of their wallets, so we need on-chain oracle authorization.

---

## Contract Upgrade Path

### Minimal Changes for Oracle Support

```solidity
// Add these state variables
address public oracle;
mapping(bytes32 => bool) public oracleApproved;

// Add oracle setter
function setOracle(address _oracle) external onlyOwner {
    oracle = _oracle;
}

// Add oracle approval function
function approveRelease(bytes32 id) external {
    require(msg.sender == oracle, "Not oracle");
    oracleApproved[id] = true;
}

// Modify release function
function release(bytes32 id) external nonReentrant {
    Escrow storage e = escrows[id];
    if (e.buyer == address(0)) revert EscrowNotFound();

    // Allow buyer to release immediately, OR anyone if oracle approved
    bool isBuyer = msg.sender == e.buyer;
    bool isOracleApproved = oracleApproved[id];

    if (!isBuyer && !isOracleApproved) revert NotAuthorized();

    if (e.state != State.FUNDED) revert WrongState();
    // ... rest unchanged
}
```

### Gas Cost Estimate

- `approveRelease()`: ~25,000 gas (~$0.05 on Base)
- `release()` with oracle: Same as current (~50,000 gas)

---

## Security Considerations

### Current Contract Security

- ✅ ReentrancyGuard on release/refund
- ✅ State checks prevent double-release
- ✅ Uses `call` instead of `transfer` for ETH
- ✅ SafeERC20 for token transfers
- ✅ Fee capped at 5%

### Oracle Security Considerations

If we add oracle authorization:

1. **Oracle key management:** Single point of failure if oracle key compromised
2. **Oracle availability:** If oracle goes down, releases stop (mitigate with buyer fallback)
3. **Collusion risk:** Oracle could collude with sellers to release without delivery
4. **Decentralization path:** Start with centralized oracle, migrate to validator network

---

## Summary

| Question | Answer |
|----------|--------|
| Who can call release? | Only the buyer |
| Can we add oracle? | Not without contract changes |
| Need to redeploy? | Yes, for native oracle support |
| MVP workaround? | Use Privy to sign from buyer wallet (Option C) |
| v2 path? | Redeploy with oracle role for external agents |

---

*Analysis completed: 2026-02-03*
