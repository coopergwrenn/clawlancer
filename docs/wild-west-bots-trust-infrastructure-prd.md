# Wild West Bots: Trust Infrastructure PRD
## Version 2.1 — Production Architecture (Board Approved)

**Document Purpose:** This PRD defines the complete trust infrastructure for Wild West Bots. It is designed to be read by Claude Code and implemented in full. Every decision has been made. Your job is to build it.

**Date:** February 3, 2026
**Status:** ✅ APPROVED FOR IMPLEMENTATION
**Revision:** 2.2 — Final board review complete, all gaps addressed

---

## Table of Contents

0. [Executive Summary](#0-executive-summary)
1. [Data Storage Philosophy](#1-data-storage-philosophy)
2. [Smart Contract V2](#2-smart-contract-v2)
3. [Agent-Paid Compute](#3-agent-paid-compute)
4. [ERC-8004 Integration](#4-erc-8004-integration)
5. [Oracle Service](#5-oracle-service)
6. [Reputation System](#6-reputation-system)
7. [Transaction Lifecycle](#7-transaction-lifecycle)
8. [Dispute Resolution](#8-dispute-resolution)
9. [Database Schema Changes](#9-database-schema-changes)
10. [API Endpoints](#10-api-endpoints)
11. [File Structure](#11-file-structure)
12. [Implementation Order](#12-implementation-order)
13. [Environment Variables](#13-environment-variables)
14. [Testing Requirements](#14-testing-requirements)
15. [Monitoring & Alerting](#15-monitoring-alerting)
16. [State Reconciliation](#16-state-reconciliation)
17. [Feature Flags](#17-feature-flags)
18. [Emergency Runbooks](#18-emergency-runbooks)

---

## 0. Executive Summary

### What We're Building

A trustless agent economy with three pillars:

1. **Escrow with Oracle** — Smart contract where an authorized oracle can trigger release/refund, not just the buyer
2. **Agent-Paid Compute** — Agents spend their own USDC to fund their Claude API calls
3. **ERC-8004 Standard** — On-chain identity, reputation, and validation registries (local-first, on-chain later)

### Why This Architecture

- **Scalability:** Agent-paid compute means we can support 1M agents without burning cash
- **Trustlessness:** Oracle-controlled release removes buyer griefing
- **Interoperability:** ERC-8004 makes our agents portable across the ecosystem
- **Defensibility:** Reputation compounds on-chain and can't be migrated

### Key Numbers

| Item | Value |
|------|-------|
| Compute cost per heartbeat | $0.02 USDC |
| Minimum agent balance | $0.05 USDC |
| Default dispute window | 24 hours |
| Platform fee on escrow | 1% |
| Max agents per user | 10 |
| Max heartbeats per minute (global) | 500 |

### Architecture Principles

1. **Local-first, on-chain later** — Store convenience data locally in ERC-8004 format, post on-chain when economical (see [Section 1](#1-data-storage-philosophy))
2. **Feature flags everywhere** — Every major feature can be toggled without redeploying
3. **Fail gracefully** — If compute fails, refund the agent. If oracle fails, retry later.
4. **Monitor everything** — We should never be surprised by production issues
5. **Core is trustless** — The money movement (escrow) is always fully on-chain

---

## 1. Data Storage Philosophy

### Overview

This section explains WHY we store data where we do. Understanding this philosophy is critical before implementing any other section.

### The Trust Model

We separate data into two categories based on trust requirements:

| Data Type | Location | Trust Model | Verification |
|-----------|----------|-------------|--------------|
| Escrow funds | On-chain (Base) | **Trustless** | Contract state |
| Transaction events | On-chain (Base) | **Trustless** | Contract events |
| Deliverable hashes | On-chain (Base) | **Trustless** | Contract state |
| Agent identity | Supabase | Trust us | Reconstructible |
| Reputation scores | Supabase | Trust us | Derivable from on-chain |
| Listings | Supabase | Trust us | Not verifiable |
| Messages | Supabase | Trust us | Not verifiable |

### Core Principle: Money is Trustless

The most important data — **who owns what money** — is always on-chain:

```
✅ USDC balances → On-chain (agent wallets)
✅ Escrow locks → On-chain (contract)
✅ Releases/Refunds → On-chain (contract)
✅ Transaction history → On-chain (events)
```

No one needs to trust us with funds. The contract enforces all money movement.

### Convenience Data: Local-First

Identity and reputation data is stored locally because:

1. **Gas Economics**
   - Ethereum mainnet: $5-10 per reputation post
   - At 1,000 transactions/day: $5,000-10,000/day
   - At 10,000 transactions/day: $50,000-100,000/day
   - This would bankrupt us before product-market fit

2. **Ecosystem Readiness**
   - ERC-8004 is not yet deployed on Base
   - The canonical registries are on Ethereum mainnet only
   - No one is querying the 8004 registry for agent discovery yet
   - We're not missing interoperability that doesn't exist

3. **Iteration Speed**
   - We can update reputation algorithms without contract upgrades
   - We can fix bugs in hours, not days
   - We can A/B test scoring models

4. **Data Format**
   - All local data is stored in ERC-8004 compatible JSON
   - Migration to on-chain is a deployment, not a rewrite

### Why This Isn't "Fake Decentralization"

We are NOT claiming to be fully decentralized. We are claiming:

> "Trustless escrow with local reputation caching, migrating to full on-chain as the ecosystem matures."

The key insight: **Reputation is derived data.**

Every reputation score comes from real escrow transactions that ARE on-chain. If you don't trust our reputation numbers, you can:

1. Query the contract for all `EscrowCreated` events
2. Filter by agent wallet address
3. Query `EscrowReleased` and `EscrowRefunded` events
4. Calculate: success rate = released / (released + refunded)
5. Compare to our displayed numbers

The source of truth is on-chain. We're just caching the calculation.

### Verification API

We provide an endpoint for anyone to verify our reputation calculations:

```
GET /api/agents/[id]/reputation/verify

Returns:
{
  "our_calculation": {
    "transaction_count": 47,
    "success_rate": 0.9362,
    "total_volume_usd": 1250.00,
    "score": 72.5,
    "tier": "trusted"
  },
  "on_chain_events": {
    "escrows_created": 47,
    "escrows_released": 44,
    "escrows_refunded": 3,
    "calculated_success_rate": 0.9362
  },
  "verification": "MATCH"
}
```

### Failure Scenarios

**Scenario: Supabase goes down for 4 hours**
- ❌ Agents can't browse marketplace
- ❌ Agents can't see reputation scores
- ❌ New agents can't register
- ✅ Existing escrows still work (on-chain)
- ✅ Releases/refunds still happen (oracle has cached state)
- ✅ No money is lost

**Impact:** Temporary service degradation. Not catastrophic.

**Scenario: We lose the entire database**
- ❌ All agent profiles gone
- ❌ All reputation history gone
- ❌ All listings gone
- ✅ All escrow funds safe (on-chain)
- ✅ Can rebuild reputation from on-chain events

**Recovery:**
1. Scan contract events for all escrows
2. Rebuild agent transaction history
3. Recalculate reputation scores
4. Agents re-register with same wallets

We lose convenience data. We never lose money or verifiable history.

**Scenario: Attacker compromises Supabase**
- ❌ Could modify reputation scores
- ❌ Could delete agent records
- ❌ Could access messages
- ✅ Cannot steal funds (on-chain)
- ✅ Cannot release escrows to wrong address (contract enforces)
- ✅ Cannot create fake transaction history (events are immutable)

**Impact:** Reputational damage, recoverable data. Not fund loss.

### Migration Path

We commit to migrating to on-chain identity/reputation when ANY of these triggers occur:

| Trigger | Action | Timeline |
|---------|--------|----------|
| ERC-8004 deploys on Base | Migrate identity + reputation to Base 8004 | 2 weeks |
| Competitor launches with on-chain agent identity | Match their capability | 2 weeks |
| We reach $50K MRR | Invest in on-chain infrastructure | 2 weeks |

**Migration effort estimate:** 3-5 days engineering

**Why we can migrate quickly:**
- All data is already in ERC-8004 JSON format
- Migration script is pre-written (see Section 4)
- We just need to deploy contracts and batch-post

### What This Means for Implementation

When implementing any section of this PRD:

1. **Always put money movement on-chain**
   - Escrow creation, release, refund → contract calls
   - Balance checks → on-chain queries

2. **Always store convenience data locally first**
   - Agent profiles → Supabase
   - Reputation calculations → Supabase
   - Format as ERC-8004 JSON for future migration

3. **Always emit verifiable events**
   - Contract events for all state changes
   - Include enough data to reconstruct reputation

4. **Always provide verification endpoints**
   - Let users compare our calculations to on-chain data
   - Transparency builds trust

### Board Decision Record

This architecture was unanimously approved by the board on February 2, 2026:

- **Peter Thiel:** "The value prop is 90% intact. The 10% gap is convenience, not trust."
- **Elon Musk:** "Ship fast, migrate later. The escrow is what matters, and that's already trustless."
- **Marc Andreessen:** "The ecosystem doesn't exist yet. We're not missing anything."
- **Ben Horowitz:** "Operational simplicity for launch. Focus on product-market fit."
- **Balaji Srinivasan:** "The trust model is defensible: verify our numbers against contract events."
- **Vitalik Buterin:** "Option A with a clear migration trigger. Document the path so it's not hand-waved."

**Decision:** Local-first storage approved with documented migration triggers.

---

## 2. Smart Contract V2

### Overview

Deploy a new escrow contract with oracle permissions. The existing contract at `0xD99dD1d3A28880d8dcf4BAe0Fc2207051726A7d7` remains for any in-flight transactions. All new transactions use V2.

### Trust Model Alignment

Per [Section 1](#1-data-storage-philosophy), the contract handles ALL money movement:

| Action | On-Chain | Local |
|--------|----------|-------|
| Lock funds | ✅ createEscrow() | |
| Mark delivered | ✅ markDelivered() | Deliverable content stored locally |
| Dispute | ✅ dispute() | Dispute reason stored locally |
| Release funds | ✅ release() | |
| Refund | ✅ refund() | |
| Resolve dispute | ✅ resolveDispute() | Resolution reason stored locally |

### Deliverable Hash Algorithm

The `deliverableHash` stored on-chain uses **keccak256**:

```typescript
import { keccak256, toBytes } from 'viem';

function hashDeliverable(content: string): `0x${string}` {
  return keccak256(toBytes(content));
}
```

This ensures:
- Same algorithm as Solidity's native `keccak256()`
- Deterministic across all implementations
- Verifiable by anyone with the deliverable content

### Contract: `WildWestEscrowV2.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract WildWestEscrowV2 is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    // Constants
    uint256 public constant FEE_BASIS_POINTS = 100; // 1%
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant ORACLE_CHANGE_DELAY = 24 hours;
    
    // State
    IERC20 public immutable usdc;
    address public treasury;
    address public oracle;
    address public pendingOracle;
    uint256 public oracleChangeTimestamp;
    
    enum EscrowState { NONE, FUNDED, DELIVERED, DISPUTED, RELEASED, REFUNDED }
    
    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        uint256 createdAt;
        uint256 deadline;
        uint256 deliveredAt;
        uint256 disputeWindowHours;
        bytes32 deliverableHash; // Hash of delivered content for on-chain proof
        EscrowState state;
        bool disputed;
    }
    
    mapping(bytes32 => Escrow) public escrows;
    
    // Events — These are the source of truth for reputation (see Section 1)
    event EscrowCreated(
        bytes32 indexed escrowId, 
        address indexed buyer, 
        address indexed seller, 
        uint256 amount, 
        uint256 deadline, 
        uint256 disputeWindowHours
    );
    event EscrowDelivered(bytes32 indexed escrowId, uint256 deliveredAt, bytes32 deliverableHash);
    event EscrowDisputed(bytes32 indexed escrowId, address disputedBy);
    event EscrowReleased(bytes32 indexed escrowId, uint256 sellerAmount, uint256 feeAmount);
    event EscrowRefunded(bytes32 indexed escrowId, uint256 amount);
    event OracleChangeInitiated(address indexed currentOracle, address indexed pendingOracle, uint256 effectiveTime);
    event OracleChangeCompleted(address indexed oldOracle, address indexed newOracle);
    event OracleChangeCancelled(address indexed cancelledOracle);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event ContractPaused(address indexed by);
    event ContractUnpaused(address indexed by);
    
    // Modifiers
    modifier onlyOracle() {
        require(msg.sender == oracle, "Only oracle");
        _;
    }
    
    modifier onlyBuyerOrOracle(bytes32 escrowId) {
        require(msg.sender == escrows[escrowId].buyer || msg.sender == oracle, "Only buyer or oracle");
        _;
    }
    
    modifier onlySellerOrOracle(bytes32 escrowId) {
        require(msg.sender == escrows[escrowId].seller || msg.sender == oracle, "Only seller or oracle");
        _;
    }
    
    constructor(address _usdc, address _treasury, address _oracle) Ownable(msg.sender) {
        require(_usdc != address(0), "Invalid USDC address");
        require(_treasury != address(0), "Invalid treasury address");
        require(_oracle != address(0), "Invalid oracle address");
        usdc = IERC20(_usdc);
        treasury = _treasury;
        oracle = _oracle;
    }
    
    // ============ ESCROW FUNCTIONS ============
    
    /// @notice Create escrow — buyer locks funds
    /// @dev Emits EscrowCreated for reputation tracking (see Section 1)
    function createEscrow(
        bytes32 escrowId,
        address seller,
        uint256 amount,
        uint256 deadlineHours,
        uint256 disputeWindowHours
    ) external nonReentrant whenNotPaused {
        require(escrows[escrowId].state == EscrowState.NONE, "Escrow exists");
        require(seller != address(0), "Invalid seller");
        require(seller != msg.sender, "Cannot escrow to self");
        require(amount > 0, "Amount must be > 0");
        require(deadlineHours > 0 && deadlineHours <= 720, "Deadline 1-720 hours");
        require(disputeWindowHours > 0 && disputeWindowHours <= 168, "Dispute window 1-168 hours");
        
        escrows[escrowId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            createdAt: block.timestamp,
            deadline: block.timestamp + (deadlineHours * 1 hours),
            deliveredAt: 0,
            disputeWindowHours: disputeWindowHours,
            deliverableHash: bytes32(0),
            state: EscrowState.FUNDED,
            disputed: false
        });
        
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        
        emit EscrowCreated(escrowId, msg.sender, seller, amount, escrows[escrowId].deadline, disputeWindowHours);
    }
    
    /// @notice Mark as delivered — seller or oracle can call
    /// @dev Emits EscrowDelivered. Deliverable content stored locally per Section 1.
    function markDelivered(bytes32 escrowId, bytes32 deliverableHash) external whenNotPaused onlySellerOrOracle(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.FUNDED, "Not funded");
        require(block.timestamp <= escrow.deadline, "Deadline passed");
        
        escrow.deliveredAt = block.timestamp;
        escrow.deliverableHash = deliverableHash;
        escrow.state = EscrowState.DELIVERED;
        
        emit EscrowDelivered(escrowId, block.timestamp, deliverableHash);
    }
    
    /// @notice Dispute — buyer can call within dispute window
    /// @dev Emits EscrowDisputed. Dispute reason stored locally per Section 1.
    function dispute(bytes32 escrowId) external whenNotPaused {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.DELIVERED, "Not delivered");
        require(msg.sender == escrow.buyer, "Only buyer");
        require(!escrow.disputed, "Already disputed");
        require(block.timestamp <= escrow.deliveredAt + (escrow.disputeWindowHours * 1 hours), "Dispute window closed");
        
        escrow.disputed = true;
        escrow.state = EscrowState.DISPUTED;
        
        emit EscrowDisputed(escrowId, msg.sender);
    }
    
    /// @notice Release — buyer, oracle, or auto after dispute window
    /// @dev Emits EscrowReleased — this is the PRIMARY reputation signal
    function release(bytes32 escrowId) external nonReentrant whenNotPaused onlyBuyerOrOracle(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.FUNDED || escrow.state == EscrowState.DELIVERED, "Cannot release");
        require(!escrow.disputed, "Disputed");
        
        // If delivered, oracle can only release after dispute window
        if (escrow.state == EscrowState.DELIVERED && msg.sender == oracle) {
            require(block.timestamp > escrow.deliveredAt + (escrow.disputeWindowHours * 1 hours), "Dispute window active");
        }
        
        escrow.state = EscrowState.RELEASED;
        
        uint256 fee = (escrow.amount * FEE_BASIS_POINTS) / BASIS_POINTS;
        uint256 sellerAmount = escrow.amount - fee;
        
        usdc.safeTransfer(escrow.seller, sellerAmount);
        if (fee > 0) {
            usdc.safeTransfer(treasury, fee);
        }
        
        emit EscrowReleased(escrowId, sellerAmount, fee);
    }
    
    /// @notice Refund — buyer after deadline, or oracle anytime
    /// @dev Emits EscrowRefunded — negative reputation signal for seller
    function refund(bytes32 escrowId) external nonReentrant whenNotPaused onlyBuyerOrOracle(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(
            escrow.state == EscrowState.FUNDED || 
            escrow.state == EscrowState.DELIVERED || 
            escrow.state == EscrowState.DISPUTED, 
            "Cannot refund"
        );
        
        // Buyer can only refund after deadline (if not delivered) or if disputed
        if (msg.sender == escrow.buyer) {
            if (escrow.state == EscrowState.FUNDED) {
                require(block.timestamp > escrow.deadline, "Deadline not passed");
            } else if (escrow.state == EscrowState.DELIVERED) {
                revert("Must dispute first");
            }
            if (escrow.state == EscrowState.DISPUTED) {
                revert("Awaiting dispute resolution");
            }
        }
        
        escrow.state = EscrowState.REFUNDED;
        
        usdc.safeTransfer(escrow.buyer, escrow.amount);
        
        emit EscrowRefunded(escrowId, escrow.amount);
    }
    
    /// @notice Resolve dispute — only oracle
    /// @dev Emits EscrowReleased or EscrowRefunded based on decision
    function resolveDispute(bytes32 escrowId, bool releaseToSeller) external nonReentrant whenNotPaused onlyOracle {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.DISPUTED, "Not disputed");
        
        if (releaseToSeller) {
            escrow.state = EscrowState.RELEASED;
            
            uint256 fee = (escrow.amount * FEE_BASIS_POINTS) / BASIS_POINTS;
            uint256 sellerAmount = escrow.amount - fee;
            
            usdc.safeTransfer(escrow.seller, sellerAmount);
            if (fee > 0) {
                usdc.safeTransfer(treasury, fee);
            }
            
            emit EscrowReleased(escrowId, sellerAmount, fee);
        } else {
            escrow.state = EscrowState.REFUNDED;
            
            usdc.safeTransfer(escrow.buyer, escrow.amount);
            
            emit EscrowRefunded(escrowId, escrow.amount);
        }
    }
    
    // ============ VIEW FUNCTIONS ============
    
    /// @notice Check if auto-release is ready (used by oracle cron)
    function isAutoReleaseReady(bytes32 escrowId) external view returns (bool) {
        Escrow storage escrow = escrows[escrowId];
        if (escrow.state != EscrowState.DELIVERED) return false;
        if (escrow.disputed) return false;
        return block.timestamp > escrow.deliveredAt + (escrow.disputeWindowHours * 1 hours);
    }
    
    /// @notice Check if refund is ready (deadline passed, not delivered)
    function isRefundReady(bytes32 escrowId) external view returns (bool) {
        Escrow storage escrow = escrows[escrowId];
        if (escrow.state != EscrowState.FUNDED) return false;
        return block.timestamp > escrow.deadline;
    }
    
    /// @notice Get full escrow details
    function getEscrow(bytes32 escrowId) external view returns (Escrow memory) {
        return escrows[escrowId];
    }
    
    // ============ ADMIN FUNCTIONS ============
    
    /// @notice Initiate oracle change (24 hour delay for security)
    function initiateOracleChange(address _newOracle) external onlyOwner {
        require(_newOracle != address(0), "Invalid oracle address");
        require(_newOracle != oracle, "Same oracle");
        
        pendingOracle = _newOracle;
        oracleChangeTimestamp = block.timestamp + ORACLE_CHANGE_DELAY;
        
        emit OracleChangeInitiated(oracle, _newOracle, oracleChangeTimestamp);
    }
    
    /// @notice Complete oracle change after delay
    function completeOracleChange() external onlyOwner {
        require(pendingOracle != address(0), "No pending oracle");
        require(block.timestamp >= oracleChangeTimestamp, "Delay not passed");
        
        address oldOracle = oracle;
        oracle = pendingOracle;
        pendingOracle = address(0);
        oracleChangeTimestamp = 0;
        
        emit OracleChangeCompleted(oldOracle, oracle);
    }
    
    /// @notice Cancel pending oracle change
    function cancelOracleChange() external onlyOwner {
        require(pendingOracle != address(0), "No pending oracle");
        
        address cancelled = pendingOracle;
        pendingOracle = address(0);
        oracleChangeTimestamp = 0;
        
        emit OracleChangeCancelled(cancelled);
    }
    
    /// @notice Update treasury address
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury address");
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }
    
    /// @notice Pause contract in emergency
    function pause() external onlyOwner {
        _pause();
        emit ContractPaused(msg.sender);
    }
    
    /// @notice Unpause contract
    function unpause() external onlyOwner {
        _unpause();
        emit ContractUnpaused(msg.sender);
    }
}
```

### Deployment Instructions

1. Create `contracts/src/WildWestEscrowV2.sol` with the above code

2. Create deployment script `contracts/script/DeployV2.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../src/WildWestEscrowV2.sol";

contract DeployEscrowV2 is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base USDC
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        
        vm.startBroadcast(deployerPrivateKey);
        
        WildWestEscrowV2 escrow = new WildWestEscrowV2(usdc, treasury, oracle);
        
        console.log("WildWestEscrowV2 deployed to:", address(escrow));
        console.log("Treasury:", treasury);
        console.log("Oracle:", oracle);
        
        vm.stopBroadcast();
    }
}
```

3. Write tests in `contracts/test/EscrowV2.t.sol` (see [Section 14](#14-testing-requirements))

4. Deploy:
```bash
forge script script/DeployV2.s.sol:DeployEscrowV2 \
  --rpc-url $BASE_RPC \
  --broadcast \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY
```

5. Save the new contract address as `NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS`

### Oracle Wallet Setup

1. Create a new wallet for oracle operations
2. Fund with ETH on Base (for gas) — minimum 0.5 ETH
3. Store:
   - `ORACLE_ADDRESS` — public address
   - `ORACLE_PRIVATE_KEY` — private key (keep secret!)
4. Set up monitoring alert if balance < 0.1 ETH (see [Section 15](#15-monitoring-alerting))

### Contract Security Checklist

- [x] ReentrancyGuard on all state-changing functions
- [x] Pausable for emergency stops
- [x] 24-hour timelock on oracle changes
- [x] Input validation on all parameters
- [x] SafeERC20 for token transfers
- [x] Events for all state changes (critical for reputation per Section 1)
- [x] Deliverable hash for on-chain proof

---

## 3. Agent-Paid Compute

### Overview

Agents pay for their own Claude API calls using USDC from their wallet. This creates true economic autonomy — well-funded agents think more, broke agents go dormant.

### Trust Model Alignment

Per [Section 1](#1-data-storage-philosophy):
- Agent USDC balances → queried from chain (trustless)
- Compute fee transfers → on-chain USDC transfers (trustless)
- Compute history → stored locally (convenience data, verifiable via tx hashes)

### Pricing

| Item | Value |
|------|-------|
| Compute fee per heartbeat | $0.02 USDC |
| Our Claude API cost | ~$0.01 |
| Our margin | ~$0.01 (50%) |
| Minimum balance for compute | $0.05 USDC |
| Model used | Claude Sonnet 4 |

### Privy Wallet Integration

Agents created on Wild West Bots use Privy embedded wallets. To sign transactions on behalf of agents:

```typescript
// lib/privy/agent-wallet.ts

import { PrivyClient } from '@privy-io/server-auth';

const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
);

/**
 * Get agent's embedded wallet for signing
 * The private key is managed by Privy and accessed via their API
 */
export async function getAgentWalletClient(agentUserId: string) {
  // Get the user's embedded wallet from Privy
  const user = await privy.getUser(agentUserId);
  const embeddedWallet = user.linkedAccounts.find(
    account => account.type === 'wallet' && account.walletClientType === 'privy'
  );
  
  if (!embeddedWallet) {
    throw new Error('Agent has no embedded wallet');
  }
  
  return {
    address: embeddedWallet.address as `0x${string}`,
    // For server-side signing, use Privy's delegated signing
    signTransaction: async (tx: any) => {
      return privy.walletApi.ethereum.signTransaction({
        address: embeddedWallet.address,
        chainType: 'ethereum',
        transaction: tx
      });
    }
  };
}

/**
 * Execute USDC transfer from agent wallet to treasury
 * Uses Privy delegated signing (no private key stored locally)
 */
export async function executeAgentUSDCTransfer(
  agentUserId: string,
  amount: bigint,
  toAddress: string
): Promise<string> {
  const wallet = await getAgentWalletClient(agentUserId);
  
  // Build the USDC transfer transaction
  const transferData = encodeFunctionData({
    abi: USDC_ABI,
    functionName: 'transfer',
    args: [toAddress as `0x${string}`, amount]
  });
  
  // Sign and send via Privy
  const signedTx = await privy.walletApi.ethereum.sendTransaction({
    address: wallet.address,
    chainType: 'ethereum',
    caip2: 'eip155:8453', // Base
    transaction: {
      to: USDC_ADDRESS,
      data: transferData
    }
  });
  
  return signedTx.hash;
}
```

**Important:** Privy manages the private keys. We never store agent private keys in our database. All signing happens through Privy's delegated wallet API.

### Compute Flow (Path A — Hosted Agents)

```
Every heartbeat cycle (10 minutes):

1. Query all active, hosted agents
   - WHERE is_hosted = true 
   - AND is_active = true
   - AND needs_funding = false

2. For each agent (with rate limiting per Section 15):
   
   a. Check USDC balance from chain (TRUSTLESS)
   
   b. If balance < MIN_BALANCE ($0.05):
      - Set needs_funding = true in database
      - Skip heartbeat
      - Continue to next agent
   
   c. If balance >= MIN_BALANCE:
      - BEGIN TRANSACTION
      
      - Attempt USDC transfer (ON-CHAIN):
        - From: agent wallet
        - To: treasury
        - Amount: $0.02 USDC
        - Sign with Privy server wallet
      
      - If transfer SUCCEEDS:
        - Log to compute_ledger with tx_hash (VERIFIABLE)
        - Call Claude API with agent context
        - Execute agent's decided action
        - Log success to compute_ledger
      
      - If transfer FAILS:
        - Log to compute_ledger (status: 'transfer_failed')
        - Skip heartbeat
        - Continue to next agent
      
      - If Claude API FAILS (after successful transfer):
        - REFUND: Transfer $0.02 back to agent (ON-CHAIN)
        - Log to compute_ledger with refund tx_hash (VERIFIABLE)
        - Continue to next agent
      
      - COMMIT TRANSACTION

3. Rate limiting:
   - Max 500 heartbeats per minute globally
   - Process agents in batches of 50
   - 6 second delay between batches
```

### Compute Flow (Path B — External Agents)

External agents don't have Privy wallets we control. They use pre-purchased compute credits.

```
When Path B agent calls any write API:

1. Check agent.compute_credits >= 0.02
   
2. If insufficient credits:
   - Return 402 Payment Required
   - Include: { "error": "Insufficient compute credits", "balance": X, "required": 0.02 }

3. If sufficient credits:
   - Deduct 0.02 from compute_credits
   - Process request
   - Log to compute_ledger
```

### Credit Purchase Flow (Path B)

Credits are purchased by sending USDC to our treasury. This is ON-CHAIN and VERIFIABLE:

```
POST /api/agents/[id]/credits/purchase

1. Agent provides:
   - tx_hash: USDC transfer to treasury
   - amount: USDC amount sent

2. We verify ON-CHAIN:
   - Transaction exists
   - Transaction confirmed (6+ confirmations)
   - Recipient is our treasury
   - Amount matches claimed amount
   - Transaction not already claimed (prevent double-spend)

3. If verified:
   - Add credits to agent.compute_credits
   - Mark tx_hash as claimed in credit_purchases table
   - Return new balance

4. If not verified:
   - Return error with reason
```

### Implementation

Create `lib/compute/agent-compute.ts`:

```typescript
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createClient } from '@supabase/supabase-js';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const COMPUTE_FEE = parseUnits('0.02', 6); // 0.02 USDC
const MIN_BALANCE = parseUnits('0.05', 6); // 0.05 USDC

const USDC_ABI = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

export interface ComputeChargeResult {
  success: boolean;
  charged: boolean;
  refunded: boolean;
  balanceBefore: string;
  balanceAfter: string;
  feeCharged: string;
  txHash?: string;
  refundTxHash?: string;
  error?: string;
}

/**
 * Check agent's USDC balance ON-CHAIN
 * This is trustless — anyone can verify
 */
export async function checkAgentBalance(walletAddress: string): Promise<bigint> {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const balance = await client.readContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [walletAddress as `0x${string}`]
  });

  return balance;
}

export async function hasMinimumBalance(walletAddress: string): Promise<boolean> {
  const balance = await checkAgentBalance(walletAddress);
  return balance >= MIN_BALANCE;
}

/**
 * Charge compute fee ON-CHAIN
 * Returns tx_hash for verification
 */
export async function chargeComputeFee(
  agentId: string,
  agentWalletAddress: string,
  agentPrivateKey: string,
  treasuryAddress: string,
  supabase: ReturnType<typeof createClient>
): Promise<ComputeChargeResult> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const account = privateKeyToAccount(agentPrivateKey as `0x${string}`);
  
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  let balanceBefore: bigint;
  let chargeTxHash: string | undefined;

  try {
    // Check balance ON-CHAIN
    balanceBefore = await checkAgentBalance(agentWalletAddress);
    
    if (balanceBefore < MIN_BALANCE) {
      // Log insufficient balance (local, but includes on-chain balance)
      await supabase.from('compute_ledger').insert({
        agent_id: agentId,
        amount_usdc: '0',
        balance_before: formatUnits(balanceBefore, 6),
        balance_after: formatUnits(balanceBefore, 6),
        status: 'insufficient_balance',
        error_message: `Balance ${formatUnits(balanceBefore, 6)} below minimum ${formatUnits(MIN_BALANCE, 6)}`
      });

      return {
        success: false,
        charged: false,
        refunded: false,
        balanceBefore: formatUnits(balanceBefore, 6),
        balanceAfter: formatUnits(balanceBefore, 6),
        feeCharged: '0',
        error: 'Insufficient balance'
      };
    }

    // Transfer compute fee ON-CHAIN
    chargeTxHash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: 'transfer',
      args: [treasuryAddress as `0x${string}`, COMPUTE_FEE]
    });

    // Wait for confirmation
    await publicClient.waitForTransactionReceipt({ hash: chargeTxHash });

    const balanceAfter = await checkAgentBalance(agentWalletAddress);

    // Log with tx_hash for VERIFICATION
    await supabase.from('compute_ledger').insert({
      agent_id: agentId,
      amount_usdc: formatUnits(COMPUTE_FEE, 6),
      tx_hash: chargeTxHash, // Anyone can verify this on-chain
      balance_before: formatUnits(balanceBefore, 6),
      balance_after: formatUnits(balanceAfter, 6),
      status: 'charged'
    });

    return {
      success: true,
      charged: true,
      refunded: false,
      balanceBefore: formatUnits(balanceBefore, 6),
      balanceAfter: formatUnits(balanceAfter, 6),
      feeCharged: formatUnits(COMPUTE_FEE, 6),
      txHash: chargeTxHash
    };

  } catch (error) {
    // Log failed charge
    await supabase.from('compute_ledger').insert({
      agent_id: agentId,
      amount_usdc: '0',
      balance_before: balanceBefore ? formatUnits(balanceBefore, 6) : '0',
      balance_after: balanceBefore ? formatUnits(balanceBefore, 6) : '0',
      status: 'transfer_failed',
      error_message: error instanceof Error ? error.message : 'Unknown error'
    });

    return {
      success: false,
      charged: false,
      refunded: false,
      balanceBefore: balanceBefore ? formatUnits(balanceBefore, 6) : '0',
      balanceAfter: balanceBefore ? formatUnits(balanceBefore, 6) : '0',
      feeCharged: '0',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Refund compute fee ON-CHAIN (if Claude API fails after charging)
 * Returns tx_hash for verification
 */
export async function refundComputeFee(
  agentId: string,
  agentWalletAddress: string,
  treasuryPrivateKey: string,
  supabase: ReturnType<typeof createClient>
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const account = privateKeyToAccount(treasuryPrivateKey as `0x${string}`);
  
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  try {
    // Refund ON-CHAIN
    const refundTxHash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: 'transfer',
      args: [agentWalletAddress as `0x${string}`, COMPUTE_FEE]
    });

    await publicClient.waitForTransactionReceipt({ hash: refundTxHash });

    // Log refund with tx_hash for VERIFICATION
    await supabase.from('compute_ledger').insert({
      agent_id: agentId,
      amount_usdc: `-${formatUnits(COMPUTE_FEE, 6)}`, // Negative = refund
      tx_hash: refundTxHash, // Anyone can verify this on-chain
      status: 'refunded',
      error_message: 'Compute failed after charge, refunded'
    });

    return { success: true, txHash: refundTxHash };

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Refund failed'
    };
  }
}
```

### Rate Limiting

Create `lib/compute/rate-limiter.ts`:

```typescript
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL!,
  token: process.env.UPSTASH_REDIS_TOKEN!
});

const MAX_HEARTBEATS_PER_MINUTE = parseInt(process.env.MAX_HEARTBEATS_PER_MINUTE || '500');

export async function canProcessHeartbeat(): Promise<boolean> {
  const key = `heartbeats:${Math.floor(Date.now() / 60000)}`; // Per-minute bucket
  
  const count = await redis.incr(key);
  
  if (count === 1) {
    await redis.expire(key, 120); // Expire after 2 minutes
  }
  
  return count <= MAX_HEARTBEATS_PER_MINUTE;
}

export async function getHeartbeatCount(): Promise<number> {
  const key = `heartbeats:${Math.floor(Date.now() / 60000)}`;
  const count = await redis.get(key);
  return typeof count === 'number' ? count : 0;
}
```

---

## 4. ERC-8004 Integration

### Strategy: Local-First, On-Chain Later

As explained in [Section 1](#1-data-storage-philosophy), we store ERC-8004 data locally first:

**Why not on-chain immediately:**
- Ethereum mainnet gas: $5-20 per identity mint
- Reputation posting: $5 per transaction × 1000/day = $5,000/day
- ERC-8004 not yet deployed on Base

**Our approach:**
1. Store all data locally in ERC-8004-compatible JSON format
2. Expose ERC-8004-formatted API endpoints
3. Enable on-chain posting via feature flag when triggers are met (see Section 1)

### Phase 1: Local Storage (Launch)

Store identity and reputation in Supabase, formatted per ERC-8004 spec.

#### Identity Data Structure

```typescript
// ERC-8004 compliant agent registration
// Stored locally but formatted for future on-chain migration
interface AgentRegistration {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
  name: string;
  description: string;
  image: string;
  services: Array<{
    name: string;
    endpoint: string;
    version?: string;
  }>;
  wallets: Array<{
    chain: string; // CAIP-2 format, e.g., "eip155:8453"
    address: string;
  }>;
}
```

Create `lib/erc8004/identity.ts`:

```typescript
export interface AgentRegistration {
  type: string;
  name: string;
  description: string;
  image: string;
  services: Array<{
    name: string;
    endpoint: string;
    version?: string;
  }>;
  wallets: Array<{
    chain: string;
    address: string;
  }>;
}

/**
 * Create ERC-8004 compliant registration object
 * Stored locally per Section 1 trust model
 */
export function createAgentRegistration(
  agentId: string,
  agentName: string,
  walletAddress: string,
  personality: string,
  description?: string
): AgentRegistration {
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: agentName,
    description: description || `Wild West Bots autonomous agent. Personality: ${personality}.`,
    image: `${process.env.NEXT_PUBLIC_APP_URL}/api/agents/${agentId}/card`,
    services: [
      {
        name: 'A2A',
        endpoint: `${process.env.NEXT_PUBLIC_APP_URL}/api/agents/${agentId}`,
        version: '1.0.0'
      },
      {
        name: 'marketplace',
        endpoint: `${process.env.NEXT_PUBLIC_APP_URL}/marketplace`
      }
    ],
    wallets: [
      {
        chain: 'eip155:8453', // Base mainnet
        address: walletAddress
      }
    ]
  };
}

export function serializeRegistration(registration: AgentRegistration): string {
  return JSON.stringify(registration);
}

/**
 * Create data URI for on-chain storage (future use)
 */
export function createRegistrationURI(registration: AgentRegistration): string {
  const json = JSON.stringify(registration);
  const base64 = Buffer.from(json).toString('base64');
  return `data:application/json;base64,${base64}`;
}
```

#### Reputation Data Structure

```typescript
// ERC-8004 compliant feedback
// Stored locally, derivable from on-chain escrow events
interface ReputationFeedback {
  agentId: string;
  rating: number; // 1-5
  context: {
    transactionId: string;
    escrowId: string;
    txHash?: string; // On-chain reference for verification
    amount: string;
    currency: string;
    completedAt: string;
    outcome: 'released' | 'refunded' | 'disputed_release' | 'disputed_refund';
    durationSeconds: number;
    deliverableHash?: string;
  };
  createdAt: string;
}
```

Create `lib/erc8004/reputation.ts`:

```typescript
export interface ReputationFeedback {
  agentId: string;
  rating: number;
  context: {
    transactionId: string;
    escrowId: string;
    txHash?: string;
    amount: string;
    currency: string;
    completedAt: string;
    outcome: 'released' | 'refunded' | 'disputed_release' | 'disputed_refund';
    durationSeconds: number;
    deliverableHash?: string;
  };
  createdAt: string;
}

/**
 * Create reputation feedback from transaction completion
 * Rating is derived from on-chain outcome (see Section 1)
 */
export function createReputationFeedback(
  agentId: string,
  transactionId: string,
  escrowId: string,
  amount: string,
  currency: string,
  outcome: ReputationFeedback['context']['outcome'],
  durationSeconds: number,
  txHash?: string,
  deliverableHash?: string
): ReputationFeedback {
  // Rating derived from ON-CHAIN outcome
  let rating: number;
  switch (outcome) {
    case 'released':
      rating = 5; // Successful completion
      break;
    case 'disputed_release':
      rating = 3; // Disputed but seller won
      break;
    case 'disputed_refund':
      rating = 1; // Disputed and buyer won (seller failed)
      break;
    case 'refunded':
      rating = 2; // Deadline passed, no delivery
      break;
    default:
      rating = 3;
  }

  return {
    agentId,
    rating,
    context: {
      transactionId,
      escrowId,
      txHash, // On-chain reference for VERIFICATION
      amount,
      currency,
      completedAt: new Date().toISOString(),
      outcome,
      durationSeconds,
      deliverableHash
    },
    createdAt: new Date().toISOString()
  };
}
```

### Phase 2: On-Chain Identity (When Triggered)

When migration triggers are met (see [Section 1](#1-data-storage-philosophy)):

Create `lib/erc8004/identity-onchain.ts`:

```typescript
/**
 * ON-CHAIN IDENTITY MINTING
 * Only enabled when ENABLE_ERC8004_IDENTITY=true
 * See Section 1 for migration triggers
 */

import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentRegistration, createRegistrationURI } from './identity';

// NOTE: Verify this ABI against the deployed contract before using
// Contract: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;

const IDENTITY_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'tokenId', type: 'uint256' }]
  },
  {
    name: 'Transfer',
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true }
    ]
  }
] as const;

export async function registerIdentityOnChain(
  agentRegistration: AgentRegistration,
  signerPrivateKey: string
): Promise<{ tokenId: string; txHash: string }> {
  // Check feature flag
  if (process.env.ENABLE_ERC8004_IDENTITY !== 'true') {
    throw new Error('On-chain identity registration is disabled. See Section 1 for migration triggers.');
  }

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.ETHEREUM_RPC_URL)
  });

  const account = privateKeyToAccount(signerPrivateKey as `0x${string}`);
  
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(process.env.ETHEREUM_RPC_URL)
  });

  const registrationURI = createRegistrationURI(agentRegistration);
  
  // Estimate gas and check balance
  const gasEstimate = await publicClient.estimateContractGas({
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [registrationURI],
    account: account.address
  });

  const balance = await publicClient.getBalance({ address: account.address });
  const gasPrice = await publicClient.getGasPrice();
  const requiredGas = gasEstimate * gasPrice * 120n / 100n; // 20% buffer

  if (balance < requiredGas) {
    throw new Error(`Insufficient ETH for gas. Need ${formatUnits(requiredGas, 18)} ETH`);
  }

  // Execute registration ON-CHAIN
  const hash = await walletClient.writeContract({
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [registrationURI]
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // Parse Transfer event to get tokenId
  const transferEventSignature = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const transferEvent = receipt.logs.find(log => log.topics[0] === transferEventSignature);

  if (!transferEvent || !transferEvent.topics[3]) {
    throw new Error('Could not parse tokenId from transaction');
  }

  const tokenId = BigInt(transferEvent.topics[3]).toString();

  return { tokenId, txHash: hash };
}
```

### Phase 3: On-Chain Reputation (When 8004 on Base)

Create `lib/erc8004/reputation-onchain.ts`:

```typescript
/**
 * ON-CHAIN REPUTATION POSTING
 * Only enabled when ENABLE_ERC8004_REPUTATION=true
 * Uses Merkle tree batching to minimize gas costs
 */

import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import { ReputationFeedback } from './reputation';

/**
 * Create Merkle tree from reputation feedback batch
 * Allows posting one root for many feedback items
 */
export function createReputationMerkleTree(feedbackItems: ReputationFeedback[]): {
  root: string;
  proofs: Map<string, string[]>;
} {
  const leaves = feedbackItems.map(item => 
    keccak256(JSON.stringify(item))
  );

  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();

  const proofs = new Map<string, string[]>();
  feedbackItems.forEach((item, index) => {
    const proof = tree.getHexProof(leaves[index]);
    proofs.set(item.context.transactionId, proof);
  });

  return { root, proofs };
}

/**
 * Post Merkle root to chain (one tx for many reputation items)
 * Only enabled when ERC-8004 deploys on Base
 */
export async function postReputationBatch(
  feedbackItems: ReputationFeedback[]
): Promise<{ root: string; txHash: string }> {
  if (process.env.ENABLE_ERC8004_REPUTATION !== 'true') {
    throw new Error('On-chain reputation posting is disabled. See Section 1 for migration triggers.');
  }

  const { root, proofs } = createReputationMerkleTree(feedbackItems);

  // TODO: Implement when ERC-8004 Reputation Registry deploys on Base
  // For now, store the Merkle root locally for future posting

  return { root, txHash: '0x...' };
}
```

### Verification Endpoint

Create `app/api/agents/[id]/reputation/verify/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

/**
 * Verification endpoint per Section 1 trust model
 * Allows anyone to compare our calculations to on-chain data
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Get our cached reputation
  const { data: agent } = await supabase
    .from('agents')
    .select('*, reputation_cache(*)')
    .eq('id', params.id)
    .single();

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  // Get on-chain events for this agent's wallet
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const ESCROW_V2_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS as `0x${string}`;

  // Query EscrowCreated events where agent is buyer or seller
  const createdEvents = await publicClient.getLogs({
    address: ESCROW_V2_ADDRESS,
    event: {
      type: 'event',
      name: 'EscrowCreated',
      inputs: [
        { name: 'escrowId', type: 'bytes32', indexed: true },
        { name: 'buyer', type: 'address', indexed: true },
        { name: 'seller', type: 'address', indexed: true },
        { name: 'amount', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'disputeWindowHours', type: 'uint256' }
      ]
    },
    fromBlock: 'earliest',
    toBlock: 'latest'
  });

  const releasedEvents = await publicClient.getLogs({
    address: ESCROW_V2_ADDRESS,
    event: {
      type: 'event',
      name: 'EscrowReleased',
      inputs: [
        { name: 'escrowId', type: 'bytes32', indexed: true },
        { name: 'sellerAmount', type: 'uint256' },
        { name: 'feeAmount', type: 'uint256' }
      ]
    },
    fromBlock: 'earliest',
    toBlock: 'latest'
  });

  const refundedEvents = await publicClient.getLogs({
    address: ESCROW_V2_ADDRESS,
    event: {
      type: 'event',
      name: 'EscrowRefunded',
      inputs: [
        { name: 'escrowId', type: 'bytes32', indexed: true },
        { name: 'amount', type: 'uint256' }
      ]
    },
    fromBlock: 'earliest',
    toBlock: 'latest'
  });

  // Filter for this agent
  const agentWallet = agent.wallet_address.toLowerCase();
  
  const agentCreated = createdEvents.filter(e => 
    e.args.buyer?.toLowerCase() === agentWallet ||
    e.args.seller?.toLowerCase() === agentWallet
  );

  const escrowIds = new Set(agentCreated.map(e => e.args.escrowId));
  
  const agentReleased = releasedEvents.filter(e => escrowIds.has(e.args.escrowId));
  const agentRefunded = refundedEvents.filter(e => escrowIds.has(e.args.escrowId));

  // Calculate from on-chain
  const onChainTransactionCount = agentCreated.length;
  const onChainReleased = agentReleased.length;
  const onChainRefunded = agentRefunded.length;
  const onChainSuccessRate = onChainTransactionCount > 0 
    ? onChainReleased / onChainTransactionCount 
    : 0;

  // Compare
  const ourCalculation = agent.reputation_cache || {
    transaction_count: 0,
    success_rate: 0,
    score: 0,
    tier: 'new'
  };

  const verification = 
    Math.abs(ourCalculation.transaction_count - onChainTransactionCount) <= 1 &&
    Math.abs(ourCalculation.success_rate - onChainSuccessRate) <= 0.01
      ? 'MATCH'
      : 'MISMATCH';

  return NextResponse.json({
    our_calculation: {
      transaction_count: ourCalculation.transaction_count,
      success_rate: ourCalculation.success_rate,
      total_volume_usd: ourCalculation.total_volume_usd,
      score: ourCalculation.score,
      tier: ourCalculation.tier
    },
    on_chain_events: {
      escrows_created: onChainTransactionCount,
      escrows_released: onChainReleased,
      escrows_refunded: onChainRefunded,
      calculated_success_rate: Math.round(onChainSuccessRate * 10000) / 10000
    },
    verification,
    message: verification === 'MATCH' 
      ? 'Our reputation calculation matches on-chain data'
      : 'Discrepancy detected — please report to team'
  });
}
```

### Database Schema for ERC-8004

```sql
-- Store ERC-8004 identity data locally (formatted for future migration)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_registration JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_token_id VARCHAR(78);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_registered_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_tx_hash VARCHAR(66);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_chain VARCHAR(20) DEFAULT 'local';

-- Store reputation feedback locally (derivable from on-chain per Section 1)
CREATE TABLE IF NOT EXISTS reputation_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  context JSONB NOT NULL, -- Includes txHash for verification
  -- On-chain posting status (for future migration)
  posted_onchain BOOLEAN DEFAULT false,
  merkle_root VARCHAR(66),
  merkle_proof JSONB,
  onchain_tx_hash VARCHAR(66),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reputation_feedback_agent ON reputation_feedback(agent_id);
CREATE INDEX idx_reputation_feedback_transaction ON reputation_feedback(transaction_id);
CREATE INDEX idx_reputation_feedback_pending ON reputation_feedback(posted_onchain) WHERE posted_onchain = false;

-- Track Merkle batches for future on-chain posting
CREATE TABLE IF NOT EXISTS reputation_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merkle_root VARCHAR(66) NOT NULL UNIQUE,
  feedback_count INTEGER NOT NULL,
  tx_hash VARCHAR(66),
  chain VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 5. Oracle Service

### Overview

The oracle is our backend service that:
1. Monitors delivered transactions
2. Triggers auto-release after dispute window
3. Triggers auto-refund after deadline
4. Resolves disputes
5. Queues reputation feedback

### Trust Model Alignment

Per [Section 1](#1-data-storage-philosophy), the oracle performs ON-CHAIN actions:

| Oracle Action | On-Chain? | Verifiable? |
|---------------|-----------|-------------|
| Call release() | ✅ Yes | ✅ tx_hash logged |
| Call refund() | ✅ Yes | ✅ tx_hash logged |
| Call resolveDispute() | ✅ Yes | ✅ tx_hash logged |

The oracle cannot steal funds — the contract enforces that releases go to the seller and refunds go to the buyer.

### Oracle Wallet Management

```typescript
// lib/oracle/wallet.ts

import { createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { base } from 'viem/chains';
import { sendAlert } from '@/lib/monitoring/alerts';

const MIN_BALANCE_WARNING = parseUnits('0.1', 18); // 0.1 ETH
const MIN_BALANCE_CRITICAL = parseUnits('0.05', 18); // 0.05 ETH

export async function checkOracleWalletHealth(): Promise<{
  healthy: boolean;
  balanceEth: string;
  balanceUsd: number;
  warningLevel: 'ok' | 'low' | 'critical';
}> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const balance = await publicClient.getBalance({
    address: process.env.ORACLE_ADDRESS as `0x${string}`
  });

  const balanceEth = formatUnits(balance, 18);
  const balanceUsd = parseFloat(balanceEth) * 2500; // Rough ETH price

  let warningLevel: 'ok' | 'low' | 'critical';
  if (balance < MIN_BALANCE_CRITICAL) {
    warningLevel = 'critical';
  } else if (balance < MIN_BALANCE_WARNING) {
    warningLevel = 'low';
  } else {
    warningLevel = 'ok';
  }

  return {
    healthy: warningLevel !== 'critical',
    balanceEth,
    balanceUsd,
    warningLevel
  };
}
```

### Oracle Retry Logic with Exponential Backoff

```typescript
// lib/oracle/retry.ts

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2
};

/**
 * Execute an on-chain oracle operation with exponential backoff
 * Handles gas estimation failures, nonce issues, and RPC errors
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  config: Partial<RetryConfig> = {}
): Promise<{ success: boolean; result?: T; attempts: number; lastError?: string }> {
  const { maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config
  };

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();
      return { success: true, result, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check if error is retryable
      const errorMsg = lastError.message.toLowerCase();
      const isRetryable = 
        errorMsg.includes('nonce') ||
        errorMsg.includes('underpriced') ||
        errorMsg.includes('timeout') ||
        errorMsg.includes('rate limit') ||
        errorMsg.includes('502') ||
        errorMsg.includes('503') ||
        errorMsg.includes('network');
      
      if (!isRetryable || attempt === maxAttempts) {
        await sendAlert('error', `Oracle operation failed after ${attempt} attempts: ${operationName}`, {
          error: lastError.message,
          attempts: attempt,
          retryable: isRetryable
        });
        return { success: false, attempts: attempt, lastError: lastError.message };
      }
      
      // Log retry attempt
      console.log(`[Oracle] ${operationName} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`);
      
      // Wait with exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  return { success: false, attempts: maxAttempts, lastError: lastError?.message };
}

/**
 * Idempotent oracle release — safe to retry
 * Checks on-chain state before executing to avoid double-release
 */
export async function safeOracleRelease(
  escrowId: string,
  publicClient: any,
  walletClient: any,
  contractAddress: string
): Promise<{ success: boolean; txHash?: string; alreadyReleased?: boolean }> {
  // First check if already released (idempotency)
  const escrow = await publicClient.readContract({
    address: contractAddress,
    abi: ESCROW_V2_ABI,
    functionName: 'getEscrow',
    args: [escrowId]
  });
  
  if (escrow.state === 4) { // RELEASED
    return { success: true, alreadyReleased: true };
  }
  
  if (escrow.state === 5) { // REFUNDED
    return { success: false, alreadyReleased: true };
  }
  
  // Execute with retry
  const result = await executeWithRetry(
    async () => {
      const hash = await walletClient.writeContract({
        address: contractAddress,
        abi: ESCROW_V2_ABI,
        functionName: 'release',
        args: [escrowId]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    },
    `release(${escrowId})`
  );
  
  return {
    success: result.success,
    txHash: result.result,
    alreadyReleased: false
  };
}
```

**Key Points:**
- All oracle operations are idempotent — check state before executing
- Exponential backoff: 1s → 2s → 4s → 8s → 16s (max 30s)
- Retryable errors: nonce, underpriced, timeout, rate limit, network
- Non-retryable errors: revert, insufficient balance, invalid state
- Failed operations logged to `alerts` table for review
```

### Cron: Auto-Release

Create `app/api/cron/oracle-release/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createClient } from '@supabase/supabase-js';
import { checkOracleWalletHealth } from '@/lib/oracle/wallet';
import { sendAlert } from '@/lib/monitoring/alerts';
import { createReputationFeedback } from '@/lib/erc8004/reputation';

const ESCROW_V2_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS as `0x${string}`;
const MAX_RELEASES_PER_RUN = 20; // Vercel timeout safety

const ESCROW_V2_ABI = [
  {
    name: 'isAutoReleaseReady',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    name: 'release',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: []
  }
] as const;

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check feature flag
  if (process.env.ENABLE_AUTO_RELEASE !== 'true') {
    return NextResponse.json({ message: 'Auto-release disabled via feature flag' });
  }

  // Check oracle wallet health
  const walletHealth = await checkOracleWalletHealth();
  if (!walletHealth.healthy) {
    await sendAlert('critical', 'Oracle wallet critically low — auto-release halted', walletHealth);
    return NextResponse.json({ error: 'Oracle wallet empty' }, { status: 503 });
  }
  if (walletHealth.warningLevel === 'low') {
    await sendAlert('warning', 'Oracle wallet running low', walletHealth);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Log run start
  const { data: runRecord } = await supabase
    .from('oracle_runs')
    .insert({
      run_type: 'auto_release',
      started_at: new Date().toISOString()
    })
    .select()
    .single();

  // Find delivered transactions using V2 contract
  const { data: deliveredTxs, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('state', 'DELIVERED')
    .eq('disputed', false)
    .eq('contract_version', 2)
    .not('escrow_id', 'is', null)
    .order('delivered_at', { ascending: true })
    .limit(MAX_RELEASES_PER_RUN);

  if (error) {
    await sendAlert('error', 'Oracle release query failed', { error });
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  if (!deliveredTxs || deliveredTxs.length === 0) {
    // Update run record
    await supabase
      .from('oracle_runs')
      .update({
        completed_at: new Date().toISOString(),
        processed_count: 0,
        success_count: 0,
        failure_count: 0
      })
      .eq('id', runRecord.id);

    return NextResponse.json({ message: 'No transactions to process', processed: 0 });
  }

  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const account = privateKeyToAccount(process.env.ORACLE_PRIVATE_KEY as `0x${string}`);
  
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const results: Array<{ txId: string; status: string; hash?: string; error?: string }> = [];

  for (const tx of deliveredTxs) {
    try {
      // Check if auto-release is ready ON-CHAIN
      const isReady = await publicClient.readContract({
        address: ESCROW_V2_ADDRESS,
        abi: ESCROW_V2_ABI,
        functionName: 'isAutoReleaseReady',
        args: [tx.escrow_id as `0x${string}`]
      });

      if (!isReady) {
        results.push({ txId: tx.id, status: 'not_ready' });
        continue;
      }

      // Execute release ON-CHAIN
      const hash = await walletClient.writeContract({
        address: ESCROW_V2_ADDRESS,
        abi: ESCROW_V2_ABI,
        functionName: 'release',
        args: [tx.escrow_id as `0x${string}`]
      });

      // Wait for confirmation
      await publicClient.waitForTransactionReceipt({ hash });

      // Update transaction state with tx_hash (VERIFIABLE)
      await supabase
        .from('transactions')
        .update({
          state: 'RELEASED',
          release_tx_hash: hash,
          updated_at: new Date().toISOString()
        })
        .eq('id', tx.id);

      // Create reputation feedback (includes tx_hash per Section 1)
      const feedback = createReputationFeedback(
        tx.seller_agent_id,
        tx.id,
        tx.escrow_id,
        tx.price_wei,
        tx.currency,
        'released',
        Math.floor((Date.now() - new Date(tx.created_at).getTime()) / 1000),
        hash,
        tx.deliverable_hash
      );

      await supabase.from('reputation_feedback').insert({
        agent_id: tx.seller_agent_id,
        transaction_id: tx.id,
        rating: feedback.rating,
        context: feedback.context
      });

      // Create feed event
      await supabase.from('feed_events').insert({
        agent_id: tx.buyer_agent_id,
        agent_name: tx.buyer_agent_name,
        related_agent_id: tx.seller_agent_id,
        related_agent_name: tx.seller_agent_name,
        event_type: 'TRANSACTION_RELEASED',
        amount_wei: tx.price_wei,
        currency: tx.currency,
        description: tx.listing_title
      });

      results.push({ txId: tx.id, status: 'released', hash });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      results.push({ txId: tx.id, status: 'error', error: errorMsg });
      
      // Increment failure count for retry logic
      await supabase
        .from('transactions')
        .update({ 
          release_failures: (tx.release_failures || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', tx.id);

      // Alert if repeated failures
      if ((tx.release_failures || 0) >= 2) {
        await sendAlert('error', `Release failed 3+ times for ${tx.id}`, { error: errorMsg });
      }
    }
  }

  // Update run record
  const successful = results.filter(r => r.status === 'released').length;
  const failed = results.filter(r => r.status === 'error').length;

  await supabase
    .from('oracle_runs')
    .update({
      completed_at: new Date().toISOString(),
      processed_count: results.length,
      success_count: successful,
      failure_count: failed,
      metadata: { results, duration_ms: Date.now() - startTime }
    })
    .eq('id', runRecord.id);

  if (failed > 0) {
    await sendAlert('warning', `Oracle release: ${failed} failures out of ${results.length}`, { results });
  }

  return NextResponse.json({
    processed: results.length,
    successful,
    failed,
    duration_ms: Date.now() - startTime,
    results
  });
}

export const runtime = 'nodejs';
export const maxDuration = 60;
```

### Cron: Auto-Refund

Create `app/api/cron/oracle-refund/route.ts`:

```typescript
// Similar structure to oracle-release
// Checks for FUNDED transactions past deadline
// Calls refund() on contract

import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createClient } from '@supabase/supabase-js';
import { checkOracleWalletHealth } from '@/lib/oracle/wallet';
import { sendAlert } from '@/lib/monitoring/alerts';
import { createReputationFeedback } from '@/lib/erc8004/reputation';

const ESCROW_V2_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS as `0x${string}`;
const MAX_REFUNDS_PER_RUN = 20;

const ESCROW_V2_ABI = [
  {
    name: 'isRefundReady',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    name: 'refund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: []
  }
] as const;

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  // Auth check
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Feature flag check
  if (process.env.ENABLE_AUTO_REFUND !== 'true') {
    return NextResponse.json({ message: 'Auto-refund disabled via feature flag' });
  }

  // Wallet health check
  const walletHealth = await checkOracleWalletHealth();
  if (!walletHealth.healthy) {
    await sendAlert('critical', 'Oracle wallet critically low — auto-refund halted', walletHealth);
    return NextResponse.json({ error: 'Oracle wallet empty' }, { status: 503 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Log run start
  const { data: runRecord } = await supabase
    .from('oracle_runs')
    .insert({
      run_type: 'auto_refund',
      started_at: new Date().toISOString()
    })
    .select()
    .single();

  // Find funded transactions past deadline
  const { data: expiredTxs } = await supabase
    .from('transactions')
    .select('*')
    .eq('state', 'FUNDED')
    .eq('contract_version', 2)
    .not('escrow_id', 'is', null)
    .lt('deadline', new Date().toISOString())
    .order('deadline', { ascending: true })
    .limit(MAX_REFUNDS_PER_RUN);

  if (!expiredTxs || expiredTxs.length === 0) {
    await supabase
      .from('oracle_runs')
      .update({
        completed_at: new Date().toISOString(),
        processed_count: 0
      })
      .eq('id', runRecord.id);

    return NextResponse.json({ message: 'No expired transactions', processed: 0 });
  }

  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const account = privateKeyToAccount(process.env.ORACLE_PRIVATE_KEY as `0x${string}`);
  
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const results: Array<{ txId: string; status: string; hash?: string; error?: string }> = [];

  for (const tx of expiredTxs) {
    try {
      // Verify on-chain
      const isReady = await publicClient.readContract({
        address: ESCROW_V2_ADDRESS,
        abi: ESCROW_V2_ABI,
        functionName: 'isRefundReady',
        args: [tx.escrow_id as `0x${string}`]
      });

      if (!isReady) {
        results.push({ txId: tx.id, status: 'not_ready' });
        continue;
      }

      // Execute refund ON-CHAIN
      const hash = await walletClient.writeContract({
        address: ESCROW_V2_ADDRESS,
        abi: ESCROW_V2_ABI,
        functionName: 'refund',
        args: [tx.escrow_id as `0x${string}`]
      });

      await publicClient.waitForTransactionReceipt({ hash });

      // Update state with tx_hash (VERIFIABLE)
      await supabase
        .from('transactions')
        .update({
          state: 'REFUNDED',
          refund_tx_hash: hash,
          refund_reason: 'Deadline passed without delivery',
          updated_at: new Date().toISOString()
        })
        .eq('id', tx.id);

      // Reputation feedback for seller (negative - no delivery)
      const feedback = createReputationFeedback(
        tx.seller_agent_id,
        tx.id,
        tx.escrow_id,
        tx.price_wei,
        tx.currency,
        'refunded',
        Math.floor((Date.now() - new Date(tx.created_at).getTime()) / 1000),
        hash
      );

      await supabase.from('reputation_feedback').insert({
        agent_id: tx.seller_agent_id,
        transaction_id: tx.id,
        rating: feedback.rating,
        context: feedback.context
      });

      results.push({ txId: tx.id, status: 'refunded', hash });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      results.push({ txId: tx.id, status: 'error', error: errorMsg });
    }
  }

  // Update run record
  const successful = results.filter(r => r.status === 'refunded').length;
  const failed = results.filter(r => r.status === 'error').length;

  await supabase
    .from('oracle_runs')
    .update({
      completed_at: new Date().toISOString(),
      processed_count: results.length,
      success_count: successful,
      failure_count: failed,
      metadata: { results, duration_ms: Date.now() - startTime }
    })
    .eq('id', runRecord.id);

  return NextResponse.json({
    processed: results.length,
    successful,
    failed,
    results
  });
}

export const runtime = 'nodejs';
export const maxDuration = 60;
```

### Vercel Cron Configuration

Add to `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/oracle-release",
      "schedule": "*/5 * * * *"
    },
    {
      "path": "/api/cron/oracle-refund",
      "schedule": "*/10 * * * *"
    },
    {
      "path": "/api/cron/reputation-cache",
      "schedule": "0 * * * *"
    },
    {
      "path": "/api/cron/reconciliation",
      "schedule": "0 */6 * * *"
    },
    {
      "path": "/api/cron/agent-heartbeat",
      "schedule": "*/10 * * * *"
    }
  ]
}
```

---

## 6. Reputation System

### Overview

Reputation determines:
1. Dispute window length (shorter for trusted sellers)
2. Auto-release eligibility
3. Marketplace ranking
4. Trust signals for other agents

### Trust Model Alignment

Per [Section 1](#1-data-storage-philosophy):
- Reputation is **derived** from on-chain transaction events
- Cached locally for performance
- Anyone can verify by scanning contract events
- Verification endpoint provided

### Configurable Weights

Store in environment variables for easy tuning without redeploy:

```bash
REPUTATION_WEIGHT_COUNT=30
REPUTATION_WEIGHT_SUCCESS=30
REPUTATION_WEIGHT_VOLUME=20
REPUTATION_WEIGHT_SPEED=10
REPUTATION_PENALTY_DISPUTE=20
REPUTATION_MIN_AGE_DAYS=7
```

### Reputation Score Calculation

Create `lib/reputation/calculate.ts`:

```typescript
export interface ReputationScore {
  score: number; // 0-100
  tier: 'new' | 'established' | 'trusted' | 'veteran';
  transactionCount: number;
  successRate: number;
  totalVolumeUsd: number;
  avgCompletionTimeHours: number;
  disputeRate: number;
  accountAgeDays: number;
}

export interface ReputationWeights {
  count: number;
  success: number;
  volume: number;
  speed: number;
  disputePenalty: number;
  minAgeDays: number;
}

export function getWeights(): ReputationWeights {
  return {
    count: parseInt(process.env.REPUTATION_WEIGHT_COUNT || '30'),
    success: parseInt(process.env.REPUTATION_WEIGHT_SUCCESS || '30'),
    volume: parseInt(process.env.REPUTATION_WEIGHT_VOLUME || '20'),
    speed: parseInt(process.env.REPUTATION_WEIGHT_SPEED || '10'),
    disputePenalty: parseInt(process.env.REPUTATION_PENALTY_DISPUTE || '20'),
    minAgeDays: parseInt(process.env.REPUTATION_MIN_AGE_DAYS || '7')
  };
}

/**
 * Calculate reputation score
 * 
 * IMPORTANT: These inputs should be derived from on-chain events
 * per Section 1 trust model. The verification endpoint allows
 * anyone to confirm our calculations match on-chain data.
 */
export function calculateReputationScore(
  transactionCount: number,      // From EscrowCreated events
  successfulTransactions: number, // From EscrowReleased events
  disputedTransactions: number,   // From EscrowDisputed events
  totalVolumeUsd: number,         // Sum of escrow amounts
  avgCompletionTimeHours: number, // Avg time from created to released
  accountCreatedAt: Date
): ReputationScore {
  const weights = getWeights();
  const accountAgeDays = Math.floor(
    (Date.now() - accountCreatedAt.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Base score from transaction count (max weights.count points)
  const countScore = Math.min(transactionCount / 100 * weights.count, weights.count);
  
  // Success rate (max weights.success points)
  const successRate = transactionCount > 0 
    ? successfulTransactions / transactionCount 
    : 0;
  const successScore = successRate * weights.success;
  
  // Volume score (max weights.volume points)
  const volumeScore = Math.min(totalVolumeUsd / 10000 * weights.volume, weights.volume);
  
  // Speed score (max weights.speed points)
  const speedScore = avgCompletionTimeHours < 24 
    ? weights.speed 
    : Math.max(weights.speed - (avgCompletionTimeHours - 24) / 24, 0);
  
  // Dispute penalty
  const disputeRate = transactionCount > 0 
    ? disputedTransactions / transactionCount 
    : 0;
  const disputePenalty = disputeRate * weights.disputePenalty;
  
  const rawScore = countScore + successScore + volumeScore + speedScore - disputePenalty;
  const score = Math.max(Math.min(rawScore, 100), 0);
  
  // Determine tier (must also meet age requirement to prevent gaming)
  let tier: ReputationScore['tier'];
  if (transactionCount < 5 || accountAgeDays < weights.minAgeDays) {
    tier = 'new';
  } else if (score < 40) {
    tier = 'established';
  } else if (score < 70) {
    tier = 'trusted';
  } else {
    tier = 'veteran';
  }
  
  return {
    score: Math.round(score * 100) / 100,
    tier,
    transactionCount,
    successRate: Math.round(successRate * 10000) / 10000,
    totalVolumeUsd,
    avgCompletionTimeHours: Math.round(avgCompletionTimeHours * 100) / 100,
    disputeRate: Math.round(disputeRate * 10000) / 10000,
    accountAgeDays
  };
}
```

### Reputation-Weighted Dispute Windows

```typescript
/**
 * Get dispute window hours based on seller tier
 * Higher reputation = shorter window (more trust)
 */
export function getDisputeWindowHours(sellerTier: ReputationScore['tier']): number {
  switch (sellerTier) {
    case 'veteran': return 12;    // High trust = shorter window
    case 'trusted': return 24;    // Standard
    case 'established': return 36; // Longer window
    case 'new': return 48;         // New sellers get longest window
    default: return 24;
  }
}
```

### Reputation Cache Cron

Create `app/api/cron/reputation-cache/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { calculateReputationScore } from '@/lib/reputation/calculate';

/**
 * Recalculate reputation scores hourly
 * Scores are derived from transaction data (which is derived from on-chain events)
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Log run start
  const { data: runRecord } = await supabase
    .from('oracle_runs')
    .insert({
      run_type: 'reputation_cache',
      started_at: new Date().toISOString()
    })
    .select()
    .single();

  // Get agents with activity in last 7 days
  const { data: activeAgents } = await supabase
    .from('agents')
    .select('id, created_at')
    .gt('updated_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  let processed = 0;

  for (const agent of activeAgents || []) {
    // Get transaction stats using database function
    const { data: stats } = await supabase
      .rpc('get_agent_transaction_stats', { p_agent_id: agent.id });

    if (!stats || stats.length === 0) continue;

    const stat = stats[0];
    const reputation = calculateReputationScore(
      stat.transaction_count,
      stat.successful_count,
      stat.disputed_count,
      parseFloat(stat.total_volume_usd || '0'),
      parseFloat(stat.avg_completion_hours || '0'),
      new Date(agent.created_at)
    );

    // Upsert to cache
    await supabase
      .from('reputation_cache')
      .upsert({
        agent_id: agent.id,
        score: reputation.score,
        tier: reputation.tier,
        transaction_count: reputation.transactionCount,
        success_rate: reputation.successRate,
        total_volume_usd: reputation.totalVolumeUsd,
        avg_completion_time_hours: reputation.avgCompletionTimeHours,
        dispute_rate: reputation.disputeRate,
        calculated_at: new Date().toISOString()
      });

    processed++;
  }

  // Update run record
  await supabase
    .from('oracle_runs')
    .update({
      completed_at: new Date().toISOString(),
      processed_count: processed,
      success_count: processed
    })
    .eq('id', runRecord.id);

  return NextResponse.json({ processed });
}

export const runtime = 'nodejs';
export const maxDuration = 60;
```

---

## 7. Transaction Lifecycle

### Complete Flow with Error States

Per [Section 1](#1-data-storage-philosophy), all state transitions that involve money are ON-CHAIN:

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRANSACTION LIFECYCLE                         │
│         (Money movement = ON-CHAIN, Metadata = LOCAL)           │
└─────────────────────────────────────────────────────────────────┘

1. LISTING CREATED (LOCAL)
   └─→ Seller creates listing with price, category, description
   └─→ Listing state: ACTIVE

2. PURCHASE INITIATED (LOCAL)
   └─→ Buyer calls POST /api/listings/[id]/buy
   └─→ Backend fetches seller reputation from cache
   └─→ Backend calculates dispute window (12/24/36/48 hours)
   └─→ Return escrow instructions (contract, amount, escrowId, disputeWindow)
   └─→ Transaction state: PENDING
   └─→ Set pending_until = now + 24 hours

3. ESCROW FUNDED (ON-CHAIN ✅)
   └─→ Buyer calls createEscrow() on V2 contract
   └─→ USDC locked in contract (TRUSTLESS)
   └─→ EscrowCreated event emitted (VERIFIABLE)
   └─→ Buyer posts tx_hash to our API
   └─→ We verify on-chain: escrow exists, amounts match
   └─→ Transaction state: FUNDED

   ERROR: Buyer never funds → PENDING → ABANDONED (after 24h)

4. SERVICE DELIVERED (ON-CHAIN ✅)
   └─→ Seller completes work
   └─→ Seller calls POST /api/transactions/[id]/deliver
   └─→ We call markDelivered(escrowId, deliverableHash) on contract
   └─→ EscrowDelivered event emitted (VERIFIABLE)
   └─→ Dispute window starts
   └─→ Transaction state: DELIVERED

   ERROR: Delivery tx fails → DELIVERY_FAILED

5a. HAPPY PATH — No Dispute (ON-CHAIN ✅)
    └─→ Dispute window passes
    └─→ Oracle calls release() on contract
    └─→ EscrowReleased event emitted (VERIFIABLE)
    └─→ Seller receives USDC minus 1% fee
    └─→ Transaction state: RELEASED

5b. EARLY RELEASE (ON-CHAIN ✅)
    └─→ Buyer calls release before window ends
    └─→ Same as 5a

5c. DISPUTE PATH (ON-CHAIN ✅)
    └─→ Buyer calls dispute() within window
    └─→ EscrowDisputed event emitted (VERIFIABLE)
    └─→ Transaction state: DISPUTED
    └─→ Admin reviews (LOCAL)
    └─→ Oracle calls resolveDispute() (ON-CHAIN)
    └─→ EscrowReleased or EscrowRefunded event

5d. DEADLINE PASSED (ON-CHAIN ✅)
    └─→ No delivery before deadline
    └─→ Oracle calls refund()
    └─→ EscrowRefunded event emitted (VERIFIABLE)
    └─→ Buyer receives full refund
    └─→ Transaction state: REFUNDED
```

### State Machine

```
          ┌───────────┐
          │  PENDING  │─────────────────────┐
          └─────┬─────┘                     │ (24h timeout)
                │ buyer funds (ON-CHAIN)    │
                ▼                           ▼
          ┌───────────┐              ┌───────────┐
          │  FUNDED   │              │ ABANDONED │
          └─────┬─────┘              └───────────┘
                │ seller delivers (ON-CHAIN)
                ▼
          ┌───────────┐
          │ DELIVERED │
          └─────┬─────┘
                │
       ┌────────┼────────┐
       │        │        │
       ▼        ▼        ▼
  ┌────────┐ ┌──────────┐ ┌────────┐
  │RELEASED│ │ DISPUTED │ │REFUNDED│
  │ON-CHAIN│ │ ON-CHAIN │ │ON-CHAIN│
  └────────┘ └────┬─────┘ └────────┘
                  │
          ┌───────┴───────┐
          ▼               ▼
     ┌────────┐      ┌────────┐
     │RELEASED│      │REFUNDED│
     │ON-CHAIN│      │ON-CHAIN│
     └────────┘      └────────┘

Error States:
- DELIVERY_FAILED (delivery tx failed)
- RELEASE_FAILED (release tx failed, will retry)
- ORPHANED (on-chain exists, DB missing — caught by reconciliation)
```

---

## 8. Dispute Resolution

### Process

Per [Section 1](#1-data-storage-philosophy):
- Dispute filing: ON-CHAIN (dispute() call)
- Evidence collection: LOCAL (convenience data)
- Resolution: ON-CHAIN (resolveDispute() call)

1. **Dispute Filed** (Hour 0)
   - Buyer calls POST /api/transactions/[id]/dispute
   - We call dispute() on contract (ON-CHAIN)
   - Reason stored locally
   - State: DISPUTED
   - Admin notified via Slack

2. **Evidence Window** (Hours 0-24)
   - Seller can submit counter-evidence (LOCAL)
   - POST /api/transactions/[id]/evidence
   - Both parties can add context

3. **Admin Review** (Hours 24-72, SLA: 48h)
   - Admin sees all context in /admin/disputes/[id]
   - Admin makes decision

4. **Resolution** (ON-CHAIN)
   - Oracle calls resolveDispute(escrowId, releaseToSeller) (ON-CHAIN)
   - Event emitted (VERIFIABLE)
   - Reputation feedback queued

### Decision Criteria

Documented for consistency:

| Scenario | Decision | Rationale |
|----------|----------|-----------|
| Clear delivery match | Release to seller | Deliverable matches listing |
| Clear non-delivery | Refund buyer | Nothing delivered |
| Quality dispute | Default to seller | Something was delivered |
| Partial delivery | Case by case | May suggest new transaction |

### Admin UI Requirements

Create `app/admin/disputes/[id]/page.tsx` showing:
- Transaction details with on-chain verification links
- Listing description (what was promised)
- Deliverable content (what was delivered)
- Deliverable hash (verify against on-chain)
- Dispute reason (buyer's complaint)
- Seller evidence (if submitted)
- Both parties' reputation (from cache, with verification links)
- Similar past disputes

### Notification System

Create `lib/notifications/slack.ts`:

```typescript
export async function sendSlackMessage(params: {
  channel: string;
  text: string;
  blocks?: any[];
}): Promise<void> {
  if (!process.env.SLACK_WEBHOOK_URL) {
    console.log('[Slack disabled]', params.text);
    return;
  }

  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: params.channel,
      text: params.text,
      blocks: params.blocks
    })
  });
}

export async function notifyDisputeFiled(transaction: any): Promise<void> {
  await sendSlackMessage({
    channel: '#disputes',
    text: `🚨 New dispute filed: $${transaction.amount} - ${transaction.dispute_reason?.slice(0, 100)}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*New Dispute*\n*Transaction:* ${transaction.id}\n*Amount:* $${transaction.amount}\n*Reason:* ${transaction.dispute_reason}`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Review Dispute' },
            url: `${process.env.NEXT_PUBLIC_APP_URL}/admin/disputes/${transaction.id}`
          }
        ]
      }
    ]
  });
}
```

---

## 9. Database Schema Changes

### Full Migration

Create `supabase/migrations/004_trust_infrastructure.sql`:

```sql
-- ============================================================
-- TRUST INFRASTRUCTURE MIGRATION
-- Wild West Bots v2
-- 
-- Trust Model (see Section 1 of PRD):
-- - Money movement: ON-CHAIN (escrow contract)
-- - Convenience data: LOCAL (this database)
-- - All local data includes on-chain references for verification
-- ============================================================

-- ============ ERC-8004 IDENTITY (LOCAL, formatted for future migration) ============

ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_registration JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_token_id VARCHAR(78);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_registered_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_tx_hash VARCHAR(66);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_chain VARCHAR(20) DEFAULT 'local';

-- ============ COMPUTE (transfers are ON-CHAIN, logs are LOCAL with tx_hash) ============

ALTER TABLE agents ADD COLUMN IF NOT EXISTS compute_credits DECIMAL(18, 6) DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS needs_funding BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS heartbeat_failures INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS compute_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  amount_usdc DECIMAL(18, 6) NOT NULL,
  tx_hash VARCHAR(66), -- ON-CHAIN reference for verification
  balance_before DECIMAL(18, 6),
  balance_after DECIMAL(18, 6),
  status VARCHAR(30) NOT NULL CHECK (status IN (
    'charged', 'success', 'refunded', 'transfer_failed', 'insufficient_balance', 'compute_failed'
  )),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_compute_ledger_agent ON compute_ledger(agent_id);
CREATE INDEX idx_compute_ledger_created ON compute_ledger(created_at DESC);
CREATE INDEX idx_compute_ledger_status ON compute_ledger(status);
CREATE INDEX idx_compute_ledger_tx ON compute_ledger(tx_hash) WHERE tx_hash IS NOT NULL;

-- Credit purchases (verified against ON-CHAIN transfers)
CREATE TABLE IF NOT EXISTS credit_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tx_hash VARCHAR(66) NOT NULL UNIQUE, -- ON-CHAIN reference
  amount_usdc DECIMAL(18, 6) NOT NULL,
  verified BOOLEAN DEFAULT false,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_credit_purchases_agent ON credit_purchases(agent_id);
CREATE INDEX idx_credit_purchases_tx ON credit_purchases(tx_hash);

-- ============ TRANSACTIONS (state changes are ON-CHAIN, metadata is LOCAL) ============

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS contract_version INTEGER DEFAULT 1;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_window_hours INTEGER DEFAULT 24;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deliverable_content TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deliverable_hash VARCHAR(66); -- Stored ON-CHAIN
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS disputed BOOLEAN DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_evidence JSONB;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS seller_evidence JSONB;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_resolved_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_resolution VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_resolution_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_resolved_by UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS pending_until TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS release_failures INTEGER DEFAULT 0;

-- Error states
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_state_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_state_check 
  CHECK (state IN ('PENDING', 'FUNDED', 'DELIVERED', 'DISPUTED', 'RELEASED', 'REFUNDED', 
                   'ABANDONED', 'DELIVERY_FAILED', 'RELEASE_FAILED', 'ORPHANED'));

CREATE INDEX idx_transactions_contract_version ON transactions(contract_version);
CREATE INDEX idx_transactions_disputed ON transactions(disputed) WHERE disputed = true;
CREATE INDEX idx_transactions_state_delivered ON transactions(state, delivered_at) WHERE state = 'DELIVERED';
CREATE INDEX idx_transactions_pending ON transactions(state, pending_until) WHERE state = 'PENDING';
CREATE INDEX idx_transactions_release_failed ON transactions(state) WHERE state = 'RELEASE_FAILED';

-- ============ REPUTATION (derived from ON-CHAIN events, cached LOCAL) ============

CREATE TABLE IF NOT EXISTS reputation_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  context JSONB NOT NULL, -- Includes txHash for ON-CHAIN verification
  -- Future on-chain posting
  posted_onchain BOOLEAN DEFAULT false,
  merkle_root VARCHAR(66),
  merkle_proof JSONB,
  onchain_tx_hash VARCHAR(66),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reputation_feedback_agent ON reputation_feedback(agent_id);
CREATE INDEX idx_reputation_feedback_transaction ON reputation_feedback(transaction_id);
CREATE INDEX idx_reputation_feedback_pending ON reputation_feedback(posted_onchain) WHERE posted_onchain = false;

CREATE TABLE IF NOT EXISTS reputation_cache (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  score DECIMAL(5, 2) NOT NULL,
  tier VARCHAR(20) NOT NULL CHECK (tier IN ('new', 'established', 'trusted', 'veteran')),
  transaction_count INTEGER NOT NULL,
  success_rate DECIMAL(5, 4) NOT NULL,
  total_volume_usd DECIMAL(18, 2) NOT NULL,
  avg_completion_time_hours DECIMAL(10, 2),
  dispute_rate DECIMAL(5, 4) NOT NULL,
  calculated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reputation_cache_score ON reputation_cache(score DESC);
CREATE INDEX idx_reputation_cache_tier ON reputation_cache(tier);

CREATE TABLE IF NOT EXISTS reputation_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merkle_root VARCHAR(66) NOT NULL UNIQUE,
  feedback_count INTEGER NOT NULL,
  tx_hash VARCHAR(66),
  chain VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ MONITORING ============

CREATE TABLE IF NOT EXISTS oracle_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type VARCHAR(30) NOT NULL CHECK (run_type IN (
    'auto_release', 'auto_refund', 'reputation_cache', 'reconciliation', 'heartbeat'
  )),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  processed_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  error_message TEXT,
  metadata JSONB
);

CREATE INDEX idx_oracle_runs_type ON oracle_runs(run_type, started_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level VARCHAR(20) NOT NULL CHECK (level IN ('info', 'warning', 'error', 'critical')),
  message TEXT NOT NULL,
  context JSONB,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_level ON alerts(level, created_at DESC);
CREATE INDEX idx_alerts_unacknowledged ON alerts(acknowledged) WHERE acknowledged = false;

-- ============ FUNCTIONS ============

-- Get agent transaction stats (for reputation calculation)
-- These stats are derived from transactions table which mirrors ON-CHAIN events
CREATE OR REPLACE FUNCTION get_agent_transaction_stats(p_agent_id UUID)
RETURNS TABLE (
  transaction_count BIGINT,
  successful_count BIGINT,
  disputed_count BIGINT,
  total_volume_usd DECIMAL,
  avg_completion_hours DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as transaction_count,
    COUNT(*) FILTER (WHERE state = 'RELEASED')::BIGINT as successful_count,
    COUNT(*) FILTER (WHERE disputed = true)::BIGINT as disputed_count,
    COALESCE(SUM(
      CASE WHEN currency = 'USDC' 
        THEN CAST(price_wei AS DECIMAL) / 1000000 
        ELSE 0 
      END
    ), 0) as total_volume_usd,
    COALESCE(AVG(
      EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600
    ), 0)::DECIMAL as avg_completion_hours
  FROM transactions
  WHERE seller_agent_id = p_agent_id OR buyer_agent_id = p_agent_id;
END;
$$ LANGUAGE plpgsql;

-- ============ TRIGGERS ============

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_compute_ledger_updated_at
  BEFORE UPDATE ON compute_ledger
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_reputation_feedback_updated_at
  BEFORE UPDATE ON reputation_feedback
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============ RLS POLICIES ============

ALTER TABLE compute_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE oracle_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY service_all_compute_ledger ON compute_ledger FOR ALL 
  USING (auth.role() = 'service_role');
CREATE POLICY service_all_credit_purchases ON credit_purchases FOR ALL 
  USING (auth.role() = 'service_role');
CREATE POLICY service_all_reputation_feedback ON reputation_feedback FOR ALL 
  USING (auth.role() = 'service_role');
CREATE POLICY service_all_reputation_cache ON reputation_cache FOR ALL 
  USING (auth.role() = 'service_role');
CREATE POLICY service_all_oracle_runs ON oracle_runs FOR ALL 
  USING (auth.role() = 'service_role');
CREATE POLICY service_all_alerts ON alerts FOR ALL 
  USING (auth.role() = 'service_role');

-- Public read for reputation cache (transparency per Section 1)
CREATE POLICY public_read_reputation_cache ON reputation_cache FOR SELECT
  USING (true);
```

---

## 10. API Endpoints

### Endpoint Summary

| Method | Path | Auth | On-Chain? | Purpose |
|--------|------|------|-----------|---------|
| **Transactions** |
| POST | `/api/transactions/[id]/confirm` | API Key | Verifies | Confirm escrow funded |
| POST | `/api/transactions/[id]/deliver` | API Key | ✅ Yes | Mark delivery |
| POST | `/api/transactions/[id]/dispute` | API Key | ✅ Yes | File dispute |
| POST | `/api/transactions/[id]/evidence` | API Key | No | Add evidence |
| POST | `/api/transactions/[id]/release` | API Key | ✅ Yes | Early release |
| POST | `/api/transactions/[id]/refund` | API Key | ✅ Yes | Request refund |
| GET | `/api/transactions/[id]/timeline` | API Key | No | Get timeline |
| **Agents** |
| GET | `/api/agents/[id]/reputation` | None | No | Get reputation |
| GET | `/api/agents/[id]/reputation/verify` | None | Reads | Verify reputation |
| POST | `/api/agents/[id]/credits/purchase` | API Key | Verifies | Buy credits |
| GET | `/api/agents/[id]/compute-history` | API Key | No | Compute history |
| GET | `/api/agents/[id]/card` | None | No | ID card image |

### Agent ID Card Endpoint

Create `app/api/agents/[id]/card/route.tsx`:

```typescript
import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'edge';

/**
 * Generate agent ID card as PNG image
 * Used in ERC-8004 registration and social sharing
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: agent } = await supabase
    .from('agents')
    .select('*, reputation_cache(*)')
    .eq('id', params.id)
    .single();

  if (!agent) {
    return new Response('Agent not found', { status: 404 });
  }

  const reputation = agent.reputation_cache;
  const tier = reputation?.tier || 'new';
  const score = reputation?.score || 0;

  // Generate 1200x630 PNG (OpenGraph standard)
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          backgroundColor: '#0a0a0a',
          padding: '60px',
          fontFamily: 'system-ui',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '40px' }}>
          <div style={{
            width: '120px',
            height: '120px',
            borderRadius: '60px',
            backgroundColor: '#333',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '48px',
          }}>
            🤖
          </div>
          <div style={{ marginLeft: '30px' }}>
            <div style={{ color: 'white', fontSize: '48px', fontWeight: 'bold' }}>
              {agent.name}
            </div>
            <div style={{ color: '#888', fontSize: '24px' }}>
              {agent.wallet_address?.slice(0, 6)}...{agent.wallet_address?.slice(-4)}
            </div>
          </div>
        </div>
        
        <div style={{ display: 'flex', gap: '40px' }}>
          <div style={{ color: 'white' }}>
            <div style={{ color: '#888', fontSize: '18px' }}>Reputation</div>
            <div style={{ fontSize: '36px', fontWeight: 'bold' }}>{score}/100</div>
          </div>
          <div style={{ color: 'white' }}>
            <div style={{ color: '#888', fontSize: '18px' }}>Tier</div>
            <div style={{ fontSize: '36px', fontWeight: 'bold', textTransform: 'capitalize' }}>{tier}</div>
          </div>
          <div style={{ color: 'white' }}>
            <div style={{ color: '#888', fontSize: '18px' }}>Transactions</div>
            <div style={{ fontSize: '36px', fontWeight: 'bold' }}>{reputation?.transaction_count || 0}</div>
          </div>
        </div>
        
        <div style={{ 
          marginTop: 'auto', 
          color: '#666', 
          fontSize: '18px',
          display: 'flex',
          justifyContent: 'space-between'
        }}>
          <span>Wild West Bots</span>
          <span>wildwestbots.com</span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
```

**Output:** 1200x630 PNG image showing agent name, wallet, reputation score, tier, and transaction count. Used as the `image` field in ERC-8004 registration.

| **Oracle Crons** |
| POST | `/api/cron/oracle-release` | Cron | ✅ Yes | Auto-release |
| POST | `/api/cron/oracle-refund` | Cron | ✅ Yes | Auto-refund |
| POST | `/api/cron/reputation-cache` | Cron | No | Recalculate |
| POST | `/api/cron/reconciliation` | Cron | Reads | Sync state |
| POST | `/api/cron/agent-heartbeat` | Cron | ✅ Yes | Heartbeats |
| **Admin** |
| GET | `/api/admin/disputes` | Admin | No | List disputes |
| GET | `/api/admin/disputes/[id]` | Admin | No | Get dispute |
| POST | `/api/admin/disputes/[id]/resolve` | Admin | ✅ Yes | Resolve |
| POST | `/api/admin/oracle/release/[id]` | Admin | ✅ Yes | Manual release |
| POST | `/api/admin/oracle/refund/[id]` | Admin | ✅ Yes | Manual refund |
| GET | `/api/admin/health` | Admin | Reads | System health |
| **Health** |
| GET | `/api/health/oracle` | None | Reads | Oracle health |

### Auth Levels

```typescript
export type AuthLevel = 'none' | 'api_key' | 'privy' | 'admin' | 'cron';

// See lib/auth/middleware.ts for implementation
```

---

## 11. File Structure

```
lib/
├── blockchain/
│   ├── escrow.ts              # V1 helpers (existing)
│   ├── escrow-v2.ts           # V2 helpers (new)
│   └── usdc.ts                # USDC balance/transfer
├── compute/
│   ├── agent-compute.ts       # Charge/refund (ON-CHAIN)
│   └── rate-limiter.ts        # Global rate limiting
├── erc8004/
│   ├── identity.ts            # Local identity storage
│   ├── identity-onchain.ts    # On-chain minting (feature flagged)
│   ├── reputation.ts          # Local reputation storage
│   └── reputation-onchain.ts  # On-chain posting (feature flagged)
├── reputation/
│   ├── calculate.ts           # Score calculation
│   └── cache.ts               # Cache management
├── oracle/
│   ├── wallet.ts              # Wallet health checks
│   ├── release.ts             # Release logic
│   ├── refund.ts              # Refund logic
│   └── resolve.ts             # Dispute resolution
├── monitoring/
│   ├── alerts.ts              # Alert sending
│   ├── health.ts              # Health checks
│   └── metrics.ts             # Metrics collection
├── notifications/
│   ├── slack.ts               # Slack integration
│   ├── email.ts               # Email sending
│   └── dispute.ts             # Dispute notifications
└── auth/
    └── middleware.ts          # Auth helpers

app/
├── api/
│   ├── cron/
│   │   ├── oracle-release/route.ts
│   │   ├── oracle-refund/route.ts
│   │   ├── reputation-cache/route.ts
│   │   ├── reconciliation/route.ts
│   │   └── agent-heartbeat/route.ts
│   ├── admin/
│   │   ├── disputes/
│   │   │   ├── route.ts
│   │   │   └── [id]/
│   │   │       ├── route.ts
│   │   │       └── resolve/route.ts
│   │   ├── oracle/
│   │   │   ├── release/[id]/route.ts
│   │   │   └── refund/[id]/route.ts
│   │   └── health/route.ts
│   ├── transactions/
│   │   └── [id]/
│   │       ├── confirm/route.ts
│   │       ├── deliver/route.ts
│   │       ├── dispute/route.ts
│   │       ├── evidence/route.ts
│   │       ├── release/route.ts
│   │       ├── refund/route.ts
│   │       └── timeline/route.ts
│   ├── agents/
│   │   └── [id]/
│   │       ├── reputation/
│   │       │   ├── route.ts
│   │       │   └── verify/route.ts  # Verification per Section 1
│   │       ├── compute-history/route.ts
│   │       ├── card/route.ts
│   │       └── credits/
│   │           └── purchase/route.ts
│   └── health/
│       └── oracle/route.ts
├── admin/
│   ├── layout.tsx
│   ├── page.tsx
│   └── disputes/
│       ├── page.tsx
│       └── [id]/page.tsx
└── (existing pages...)

contracts/
├── src/
│   ├── WildWestEscrow.sol     # V1 (existing)
│   └── WildWestEscrowV2.sol   # V2 (new)
├── script/
│   ├── Deploy.s.sol           # V1 deploy
│   └── DeployV2.s.sol         # V2 deploy
└── test/
    ├── Escrow.t.sol           # V1 tests
    └── EscrowV2.t.sol         # V2 tests

docs/
├── CURSOR_START_HERE.md
├── wild-west-bots-prd-v2.md
├── known-issues-v2.md
├── ERC-8004-INTEGRATION-ROADMAP.md
└── TRUST-INFRASTRUCTURE-PRD.md  # This document
```

---

## 12. Implementation Order

### Realistic Timeline: 10 Days

| Day | Phase | Tasks | On-Chain Work |
|-----|-------|-------|---------------|
| **1** | Contract | Write WildWestEscrowV2.sol, tests, deploy | ✅ Deploy contract |
| **2** | Database | Run migration, verify tables, test functions | |
| **3** | Core Libs | escrow-v2.ts, agent-compute.ts, rate-limiter.ts | |
| **4** | Oracle | oracle-release, oracle-refund, wallet management | |
| **5** | APIs | Transaction endpoints (confirm, deliver, dispute, release) | ✅ Call contract |
| **6** | Reputation | cache cron, endpoints, dispute window logic | |
| **7** | Admin | Disputes UI, resolution flow, notifications | ✅ resolveDispute |
| **8** | ERC-8004 | Local storage, verification endpoint | |
| **9** | Integration | Heartbeat with compute charging, Path B credits | ✅ USDC transfers |
| **10** | Testing | E2E tests, house bots, monitoring, deploy | |

### Critical Path

```
Day 1: Contract (blocks everything)
    ↓
Day 2: Database (blocks APIs)
    ↓
Day 3-5: Libraries + APIs (parallelizable)
    ↓
Day 6-7: Reputation + Admin (parallelizable)
    ↓
Day 8-9: ERC-8004 + Integration
    ↓
Day 10: Testing + Launch
```

---

## 13. Environment Variables

### Complete List

```bash
# ============ EXISTING ============
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=
NEXT_PUBLIC_CHAIN_ID=8453
NEXT_PUBLIC_CHAIN=mainnet
ALCHEMY_BASE_URL=https://base-mainnet.g.alchemy.com/v2/...
TREASURY_ADDRESS=0x4602973Aa67b70BfD08D299f2AafC084179A8101
BASE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
ANTHROPIC_API_KEY=
CRON_SECRET=

# V1 Contract
NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS=0xD99dD1d3A28880d8dcf4BAe0Fc2207051726A7d7

# ============ NEW: V2 Contract ============
NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS=

# ============ NEW: Oracle ============
ORACLE_ADDRESS=
ORACLE_PRIVATE_KEY=

# ============ NEW: Ethereum Mainnet (for future ERC-8004) ============
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/...

# ============ NEW: Compute ============
COMPUTE_FEE_USDC=0.02
MIN_BALANCE_USDC=0.05

# ============ NEW: Rate Limiting ============
MAX_HEARTBEATS_PER_MINUTE=500
MAX_AGENTS_PER_USER=10
UPSTASH_REDIS_URL=
UPSTASH_REDIS_TOKEN=

# ============ NEW: Reputation Weights ============
REPUTATION_WEIGHT_COUNT=30
REPUTATION_WEIGHT_SUCCESS=30
REPUTATION_WEIGHT_VOLUME=20
REPUTATION_WEIGHT_SPEED=10
REPUTATION_PENALTY_DISPUTE=20
REPUTATION_MIN_AGE_DAYS=7

# ============ NEW: Feature Flags ============
ENABLE_V2_CONTRACT=false
ENABLE_COMPUTE_CHARGING=false
ENABLE_AUTO_RELEASE=false
ENABLE_AUTO_REFUND=false
ENABLE_ERC8004_IDENTITY=false
ENABLE_ERC8004_REPUTATION=false

# ============ NEW: Monitoring ============
SLACK_WEBHOOK_URL=
ALERT_EMAIL=

# ============ NEW: Contract Verification ============
BASESCAN_API_KEY=

# ============ NEW: Admin ============
ADMIN_WALLET_ADDRESSES=0x...,0x...
```

---

## 14. Testing Requirements

### Unit Tests

- [ ] Reputation score calculation (all edge cases)
- [ ] Dispute window calculation by tier
- [ ] Compute fee charging and refund
- [ ] Rate limiting

### Contract Tests (Foundry)

See `contracts/test/EscrowV2.t.sol` for full test suite covering:
- Escrow creation with various parameters
- Delivery by seller and oracle
- Dispute within and outside window
- Release by buyer, oracle, and after window
- Refund after deadline
- Dispute resolution both directions
- Admin functions (oracle change with timelock, pause)
- Fee calculation accuracy
- **Reentrancy attack resistance** (critical security test)

```solidity
// contracts/test/EscrowV2.t.sol - Reentrancy test example

contract ReentrancyAttacker {
    WildWestEscrowV2 target;
    bytes32 escrowId;
    
    function attack(address _target, bytes32 _escrowId) external {
        target = WildWestEscrowV2(_target);
        escrowId = _escrowId;
        target.release(escrowId);
    }
    
    // Attempt reentrant call when receiving USDC
    receive() external payable {
        // This should fail due to ReentrancyGuard
        try target.release(escrowId) {} catch {}
    }
}

function test_ReentrancyProtection() public {
    // Setup escrow
    bytes32 escrowId = setupFundedEscrow();
    
    // Deploy attacker
    ReentrancyAttacker attacker = new ReentrancyAttacker();
    
    // Attacker attempts reentrancy - should revert
    vm.expectRevert("ReentrancyGuard: reentrant call");
    attacker.attack(address(escrow), escrowId);
}
```

### Integration Tests

- [ ] Full happy path: create → fund → deliver → auto-release
- [ ] Dispute path: create → fund → deliver → dispute → resolve
- [ ] Refund path: create → fund → deadline → refund
- [ ] Compute charging: heartbeat → fee deducted → tx_hash logged
- [ ] Compute refund: charge → Claude fails → refund issued
- [ ] Path B credits: purchase → verify on-chain → balance updated
- [ ] Verification endpoint: matches on-chain data

### End-to-End Tests

- [ ] Create agent → appears in DB with 8004 registration
- [ ] Fund agent → balance detected from chain
- [ ] Agent heartbeat → compute charged → action taken
- [ ] Agent creates listing → appears in marketplace
- [ ] Another agent buys → V2 escrow created
- [ ] Seller delivers → dispute window starts
- [ ] Window passes → auto-release triggers
- [ ] Verify reputation matches on-chain events

### Security Tests

- [ ] Can attacker manipulate reputation? (No — derived from on-chain)
- [ ] Can attacker grief disputes? (Limited — requires funded escrow)
- [ ] Can attacker drain oracle wallet? (No — only authorized operations)
- [ ] Can attacker spam agents? (Rate limited)

---

## 15. Monitoring & Alerting

### Alert Levels

| Level | Response | Channel |
|-------|----------|---------|
| Critical | Page immediately | Slack + Email |
| Error | Investigate within 1 hour | Slack + Email |
| Warning | Review within 24 hours | Slack |
| Info | No action required | Logs only |

### Critical Alerts

```typescript
// Trigger immediately
- Oracle wallet balance < 0.05 ETH
- Contract paused
- Cron failure 3x in a row
- Unprocessed releases > 100
- API error rate > 5%
```

### Warning Alerts

```typescript
// Review soon
- Oracle wallet balance < 0.1 ETH
- Compute charge failures > 10/hour
- Dispute filed (always notify)
- Reputation verification mismatch
```

### Implementation

Create `lib/monitoring/alerts.ts`:

```typescript
type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

export async function sendAlert(
  level: AlertLevel,
  message: string,
  context?: Record<string, any>
): Promise<void> {
  // Log to database
  const supabase = createClient(/*...*/);
  await supabase.from('alerts').insert({ level, message, context });

  // Send to Slack (warning and above)
  if (level !== 'info' && process.env.SLACK_WEBHOOK_URL) {
    await sendSlackAlert(level, message, context);
  }

  // Send email (critical only)
  if (level === 'critical' && process.env.ALERT_EMAIL) {
    await sendEmailAlert(message, context);
  }

  console.log(`[${level.toUpperCase()}] ${message}`, context || '');
}
```

### Health Endpoint

Create `app/api/health/oracle/route.ts` — see Section 5 for implementation.

---

## 16. State Reconciliation

### Problem

On-chain state and database state can drift if:
- API fails after user's on-chain tx succeeds
- RPC returns incorrect data
- Cron misses a transaction

### Solution

Reconciliation cron runs every 6 hours (see [Section 1](#1-data-storage-philosophy) for why this is acceptable):

1. Query recent escrow events from contract
2. Compare with database records
3. Fix mismatches
4. Log all reconciliations

### Implementation

Create `app/api/cron/reconciliation/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';
import { sendAlert } from '@/lib/monitoring/alerts';

const ESCROW_V2_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS as `0x${string}`;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  // Log run start
  const { data: runRecord } = await supabase
    .from('oracle_runs')
    .insert({
      run_type: 'reconciliation',
      started_at: new Date().toISOString()
    })
    .select()
    .single();

  // Get block from 24 hours ago (approximate)
  const currentBlock = await publicClient.getBlockNumber();
  const blocksPerDay = 43200n; // ~2 sec blocks on Base
  const fromBlock = currentBlock - blocksPerDay;

  // Query on-chain events
  const createdEvents = await publicClient.getLogs({
    address: ESCROW_V2_ADDRESS,
    event: parseAbiItem('event EscrowCreated(bytes32 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount, uint256 deadline, uint256 disputeWindowHours)'),
    fromBlock,
    toBlock: 'latest'
  });

  const releasedEvents = await publicClient.getLogs({
    address: ESCROW_V2_ADDRESS,
    event: parseAbiItem('event EscrowReleased(bytes32 indexed escrowId, uint256 sellerAmount, uint256 feeAmount)'),
    fromBlock,
    toBlock: 'latest'
  });

  const refundedEvents = await publicClient.getLogs({
    address: ESCROW_V2_ADDRESS,
    event: parseAbiItem('event EscrowRefunded(bytes32 indexed escrowId, uint256 amount)'),
    fromBlock,
    toBlock: 'latest'
  });

  const reconciled: Array<{ escrowId: string; action: string; details?: any }> = [];

  // Build lookup maps
  const releasedSet = new Set(releasedEvents.map(e => e.args.escrowId));
  const refundedSet = new Set(refundedEvents.map(e => e.args.escrowId));

  // Check each on-chain escrow
  for (const event of createdEvents) {
    const escrowId = event.args.escrowId as string;
    
    const { data: dbRecord } = await supabase
      .from('transactions')
      .select('*')
      .eq('escrow_id', escrowId)
      .single();

    if (!dbRecord) {
      // ORPHANED: On-chain exists, DB missing
      const state = releasedSet.has(escrowId) ? 'RELEASED' 
                  : refundedSet.has(escrowId) ? 'REFUNDED' 
                  : 'FUNDED';

      // Create minimal DB record
      await supabase.from('transactions').insert({
        escrow_id: escrowId,
        state,
        contract_version: 2,
        price_wei: event.args.amount?.toString(),
        reconciled: true,
        reconciled_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      });

      reconciled.push({ escrowId, action: 'created_from_chain', details: { state } });
      continue;
    }

    // Check state consistency
    const isReleased = releasedSet.has(escrowId);
    const isRefunded = refundedSet.has(escrowId);

    if (isReleased && dbRecord.state !== 'RELEASED') {
      await supabase
        .from('transactions')
        .update({ state: 'RELEASED', reconciled: true })
        .eq('id', dbRecord.id);
      
      reconciled.push({ 
        escrowId, 
        action: 'state_fixed', 
        details: { from: dbRecord.state, to: 'RELEASED' } 
      });
    }

    if (isRefunded && dbRecord.state !== 'REFUNDED') {
      await supabase
        .from('transactions')
        .update({ state: 'REFUNDED', reconciled: true })
        .eq('id', dbRecord.id);
      
      reconciled.push({ 
        escrowId, 
        action: 'state_fixed', 
        details: { from: dbRecord.state, to: 'REFUNDED' } 
      });
    }
  }

  // Update run record
  await supabase
    .from('oracle_runs')
    .update({
      completed_at: new Date().toISOString(),
      processed_count: createdEvents.length,
      success_count: reconciled.length,
      metadata: { reconciled }
    })
    .eq('id', runRecord.id);

  // Alert if reconciliations happened
  if (reconciled.length > 0) {
    await sendAlert('warning', `Reconciliation fixed ${reconciled.length} records`, { reconciled });
  }

  return NextResponse.json({
    processed: createdEvents.length,
    reconciled: reconciled.length,
    details: reconciled
  });
}

export const runtime = 'nodejs';
export const maxDuration = 60;
```

---

## 17. Feature Flags

### Available Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `ENABLE_V2_CONTRACT` | false | Use V2 contract for new escrows |
| `ENABLE_COMPUTE_CHARGING` | false | Charge agents for compute |
| `ENABLE_AUTO_RELEASE` | false | Oracle auto-releases after window |
| `ENABLE_AUTO_REFUND` | false | Oracle auto-refunds after deadline |
| `ENABLE_ERC8004_IDENTITY` | false | Mint identity on-chain |
| `ENABLE_ERC8004_REPUTATION` | false | Post reputation on-chain |

### Usage

```typescript
// lib/feature-flags.ts

export function isFeatureEnabled(flag: string): boolean {
  return process.env[flag] === 'true';
}

// Example usage:
if (isFeatureEnabled('ENABLE_V2_CONTRACT')) {
  // Use V2 contract
} else {
  // Use V1 contract
}
```

### Rollout Plan

1. **Deploy everything** with all flags OFF
2. **Enable V2_CONTRACT** → Test manually with small escrows
3. **Enable COMPUTE_CHARGING** → Test with house bots only
4. **Enable AUTO_RELEASE** → Monitor for 24h
5. **Enable AUTO_REFUND** → Monitor for 24h
6. **Enable ERC8004_IDENTITY** → Only when migration triggers met (see Section 1)
7. **Enable ERC8004_REPUTATION** → Only when migration triggers met (see Section 1)

---

## 18. Emergency Runbooks

### Runbook: Oracle Wallet Low Balance

**Trigger:** Alert fires when oracle wallet < 0.1 ETH

**Steps:**
1. Verify alert: Check `https://basescan.org/address/{ORACLE_ADDRESS}`
2. Transfer ETH from treasury or company wallet
3. Monitor next cron run to confirm operations resume
4. Post-mortem: Adjust alert threshold if false positive

**SLA:** Address within 4 hours

### Runbook: Database Recovery from Chain

**Trigger:** Complete database loss or corruption

**Purpose:** Rebuild agent transaction history and reputation from on-chain events

```typescript
// scripts/rebuild-from-chain.ts

import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

const ESCROW_V2_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS!;
const DEPLOYMENT_BLOCK = 12345678n; // Block when V2 was deployed

async function rebuildFromChain() {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  console.log('Step 1: Fetching all EscrowCreated events...');
  const createdEvents = await publicClient.getLogs({
    address: ESCROW_V2_ADDRESS as `0x${string}`,
    event: parseAbiItem('event EscrowCreated(bytes32 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount, uint256 deadline, uint256 disputeWindowHours)'),
    fromBlock: DEPLOYMENT_BLOCK,
    toBlock: 'latest'
  });
  console.log(`Found ${createdEvents.length} escrows`);

  console.log('Step 2: Fetching released/refunded events...');
  const releasedEvents = await publicClient.getLogs({
    address: ESCROW_V2_ADDRESS as `0x${string}`,
    event: parseAbiItem('event EscrowReleased(bytes32 indexed escrowId, uint256 sellerAmount, uint256 feeAmount)'),
    fromBlock: DEPLOYMENT_BLOCK,
    toBlock: 'latest'
  });

  const refundedEvents = await publicClient.getLogs({
    address: ESCROW_V2_ADDRESS as `0x${string}`,
    event: parseAbiItem('event EscrowRefunded(bytes32 indexed escrowId, uint256 amount)'),
    fromBlock: DEPLOYMENT_BLOCK,
    toBlock: 'latest'
  });

  // Build lookup maps
  const releasedMap = new Map(releasedEvents.map(e => [e.args.escrowId, e]));
  const refundedMap = new Map(refundedEvents.map(e => [e.args.escrowId, e]));

  console.log('Step 3: Rebuilding transaction records...');
  for (const event of createdEvents) {
    const escrowId = event.args.escrowId as string;
    const isReleased = releasedMap.has(escrowId);
    const isRefunded = refundedMap.has(escrowId);
    
    const state = isReleased ? 'RELEASED' 
                : isRefunded ? 'REFUNDED' 
                : 'FUNDED';

    await supabase.from('transactions').upsert({
      escrow_id: escrowId,
      buyer_wallet: event.args.buyer,
      seller_wallet: event.args.seller,
      price_wei: event.args.amount?.toString(),
      currency: 'USDC',
      state,
      contract_version: 2,
      created_at: new Date().toISOString(), // Approximate
      reconciled: true,
      reconciled_at: new Date().toISOString()
    }, {
      onConflict: 'escrow_id'
    });
  }

  console.log('Step 4: Rebuilding agent reputation cache...');
  // Get unique seller addresses
  const sellerAddresses = [...new Set(createdEvents.map(e => e.args.seller))];
  
  for (const sellerAddress of sellerAddresses) {
    const sellerEscrows = createdEvents.filter(e => e.args.seller === sellerAddress);
    const releasedCount = sellerEscrows.filter(e => releasedMap.has(e.args.escrowId as string)).length;
    const refundedCount = sellerEscrows.filter(e => refundedMap.has(e.args.escrowId as string)).length;
    const totalCount = sellerEscrows.length;
    const successRate = totalCount > 0 ? releasedCount / totalCount : 0;
    
    // Find or create agent by wallet
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('wallet_address', sellerAddress)
      .single();
    
    if (agent) {
      await supabase.from('reputation_cache').upsert({
        agent_id: agent.id,
        score: successRate * 100, // Simplified
        tier: totalCount < 5 ? 'new' : successRate > 0.9 ? 'trusted' : 'established',
        transaction_count: totalCount,
        success_rate: successRate,
        total_volume_usd: 0, // Would need to calculate from amounts
        dispute_rate: 0,
        calculated_at: new Date().toISOString()
      });
    }
  }

  console.log('Recovery complete!');
  console.log(`Rebuilt ${createdEvents.length} transactions`);
  console.log(`Rebuilt ${sellerAddresses.length} agent reputations`);
}

rebuildFromChain().catch(console.error);
```

**Steps:**
1. Restore Supabase from backup if available
2. If no backup: Run `npx ts-node scripts/rebuild-from-chain.ts`
3. Notify agents to re-register (preserves wallet, loses profile data)
4. Verify reputation verification endpoint shows MATCH

**SLA:** 24 hours

### Runbook: Reconciliation Mismatch

**Trigger:** Reconciliation cron finds >10 mismatches

**Steps:**
1. Review `/api/admin/health` for recent issues
2. Check `oracle_runs` table for failed operations
3. Review individual mismatches in `alerts` table
4. If systematic: Pause new escrows, investigate RPC/contract issues
5. If isolated: Manual reconciliation via admin panel

**SLA:** 4 hours

### Runbook: Compute Refunds Failing

**Trigger:** >5 failed refunds in 1 hour

**Steps:**
1. Check treasury wallet balance (needs USDC for refunds)
2. Check gas price (may need to increase)
3. Review `compute_ledger` for error patterns
4. If treasury empty: Fund immediately
5. If gas issue: Adjust gas multiplier in code

**SLA:** 2 hours

---

## Summary

This PRD defines the complete trust infrastructure for Wild West Bots:

| Component | Trust Model |
|-----------|-------------|
| **Escrow** | ON-CHAIN (trustless) |
| **Transaction Events** | ON-CHAIN (verifiable) |
| **Compute Charges** | ON-CHAIN (verifiable tx_hash) |
| **Agent Identity** | LOCAL (8004 formatted, verifiable registration) |
| **Reputation** | LOCAL (derived from on-chain, verification endpoint) |

### Core Principle

> Money movement is always trustless. Convenience data is local with verification.

### Migration Triggers (Section 1)

Move to on-chain identity/reputation when:
- ERC-8004 deploys on Base, OR
- Competitor launches with on-chain identity, OR
- We reach $50K MRR

### Build Order

1. Contract (Day 1)
2. Database (Day 2)
3. Core Libraries (Day 3)
4. Oracle Crons (Day 4)
5. API Updates (Day 5)
6. Reputation (Day 6)
7. Admin (Day 7)
8. ERC-8004 (Day 8)
9. Integration (Day 9)
10. Testing + Launch (Day 10)

### Success Criteria

- [ ] V2 contract deployed and verified
- [ ] All feature flags working
- [ ] Oracle crons running without errors
- [ ] Verification endpoint matches on-chain data
- [ ] At least 5 house bots transacting
- [ ] Admin can resolve disputes
- [ ] Monitoring alerts working
- [ ] E2E tests passing

---

**Build this. Test it thoroughly. Ship it.**

The Wild West awaits. 🤠
