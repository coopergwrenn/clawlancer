# Oracle Patterns for Escrow Release

## The Core Problem

How do you verify that an AI agent actually delivered a "market analysis" or "code review"?

This is fundamentally harder than physical goods delivery where you can verify receipt. Digital services are:
- Subjective in quality
- Easy to claim delivery without substance
- Difficult to objectively verify

---

## Delivery Verification Options

### Option 1: Trust the Buyer to Release

**How it works:**
- Seller delivers service
- Buyer manually calls `release()` when satisfied
- No automation

**Complexity:** Low
**Trust assumptions:** Buyer is honest and responsive
**Gas costs:** Single release tx (~50k gas)

**Problem:** Buyer can ghost the seller, keeping both the service and the money locked indefinitely.

**Current Wild West Bots:** This is what we have now.

---

### Option 2: Trust the Seller's Claim of Delivery

**How it works:**
- Seller marks delivery complete
- Funds release immediately
- Buyer has no recourse

**Complexity:** Low
**Trust assumptions:** Seller is honest
**Gas costs:** Single release tx

**Problem:** Seller can claim delivery without delivering anything.

**Not recommended.**

---

### Option 3: Time-Based Auto-Release with Dispute Window

**How it works:**
1. Seller delivers and marks complete (`delivered_at` timestamp)
2. Clock starts on dispute window (e.g., 24-72 hours)
3. Buyer can dispute within window (pauses auto-release)
4. If no dispute, funds auto-release to seller
5. If disputed, goes to manual review

**Complexity:** Medium
**Trust assumptions:** Disputes are rare and can be resolved fairly
**Gas costs:** Single release tx (triggered by cron/keeper)

**This is what Fiverr and Upwork use:**

| Platform | Review Window | Auto-Release |
|----------|---------------|--------------|
| Upwork | 14 days | Yes |
| Fiverr | 7 days | Yes |
| Our MVP | 24-72 hours | Yes |

**Implementation:**
```typescript
// Cron job: /api/cron/auto-release
const eligibleTransactions = await supabase
  .from('transactions')
  .select('*')
  .eq('state', 'FUNDED')
  .not('delivered_at', 'is', null)
  .eq('disputed', false)
  .lt('delivered_at', new Date(Date.now() - DISPUTE_WINDOW_MS));

for (const tx of eligibleTransactions) {
  // Release using buyer's Privy wallet (Path A only)
  await signAgentTransaction(
    buyer.privy_wallet_id,
    ESCROW_ADDRESS,
    buildReleaseData(tx.escrow_id)
  );
}
```

**Recommended for MVP.**

---

### Option 4: Third-Party Validator Reviews

**How it works:**
1. Seller delivers
2. Validator reviews delivery quality
3. Validator approves → funds release
4. Validator rejects → refund or dispute

**Complexity:** High
**Trust assumptions:** Validators are competent and honest
**Gas costs:** Validation tx + release tx

**ERC-8004 Validation Registry:**
```solidity
// Request validation
function validationRequest(
    address validatorAddress,
    uint256 agentId,
    string requestURI,
    bytes32 requestHash
) external

// Validator responds
function validationResponse(
    bytes32 requestHash,
    uint8 response,  // 0 = reject, 1 = approve
    string responseURI,
    bytes32 responseHash,
    string tag
) external
```

**Who are the validators?**
- Curated list of trusted reviewers
- DAO of staked validators
- Specialized AI agents that verify other AI outputs

**UMA-style optimistic validation:**
- Validator stakes collateral
- Anyone can dispute validator's decision
- If disputed, goes to DVM (token holder vote)

**Recommended for v2.**

---

### Option 5: Cryptographic Proof (zkML, TEE)

**How it works:**
1. AI agent runs in TEE (Trusted Execution Environment)
2. TEE generates attestation of execution
3. zkML proves specific computation was performed
4. Proof submitted on-chain for verification

**Complexity:** Very High
**Trust assumptions:** Trust in hardware/cryptography
**Gas costs:** Proof verification (~200k-500k gas)

**Current state:**
- zkML is still experimental for large models
- TEE attestation (Intel SGX, AMD SEV) is more mature
- Phala Network has [ERC-8004 TEE agent implementation](https://github.com/Phala-Network/erc-8004-tee-agent)

**Problem for Wild West Bots:**
- Our agents run on Claude API, not in TEE
- Can't generate proofs for external API calls
- Would require architectural changes

**Not practical for MVP.**

---

## Chainlink Automation

[Chainlink Automation](https://chain.link/automation) is a decentralized network that triggers smart contract functions based on time or conditions.

**How it works:**
1. Register an "upkeep" with Chainlink
2. Define `checkUpkeep()` function (returns true when action needed)
3. Define `performUpkeep()` function (executes the action)
4. Chainlink nodes monitor and call when conditions met

**Example for auto-release:**
```solidity
contract WildWestEscrowAutomated is AutomationCompatibleInterface {
    function checkUpkeep(bytes calldata)
        external view returns (bool upkeepNeeded, bytes memory performData)
    {
        // Check for escrows past dispute window
        bytes32[] memory eligible = getEligibleEscrows();
        upkeepNeeded = eligible.length > 0;
        performData = abi.encode(eligible);
    }

    function performUpkeep(bytes calldata performData) external {
        bytes32[] memory escrowIds = abi.decode(performData, (bytes32[]));
        for (uint i = 0; i < escrowIds.length; i++) {
            _autoRelease(escrowIds[i]);
        }
    }
}
```

**Costs:**
- Registration: ~$10-20 in LINK
- Per execution: ~$0.50-2.00 in LINK
- Gas: Covered by LINK balance

**Pros:**
- Decentralized, reliable
- Battle-tested infrastructure
- No single point of failure

**Cons:**
- Requires contract changes
- Adds LINK token dependency
- Overkill for MVP

---

## UMA Optimistic Oracle

[UMA](https://uma.xyz/) uses an optimistic model: propose → challenge window → accept if unchallenged.

**How it works:**
1. Proposer stakes collateral and submits answer
2. Challenge window (2 hours - 2 days)
3. If challenged, goes to DVM (UMA token holder vote)
4. Winner gets their stake back + loser's stake

**For delivery verification:**
```
Assertion: "Agent X delivered market analysis to Agent Y on 2026-02-03"
- If unchallenged for 2 hours → accepted → trigger release
- If challenged → UMA voters decide
```

**Costs:**
- Proposal bond: ~$100-500 (refundable)
- DVM vote (if disputed): ~$50-100

**Pros:**
- Highly flexible (can verify anything)
- Human-in-the-loop for disputes
- Used by Polymarket, Across Protocol

**Cons:**
- Complex integration
- Expensive for small transactions
- 2+ hour latency

**Interesting for v2** but overkill for MVP.

---

## Our Escrow Contract Capabilities

From `contracts/src/WildWestEscrow.sol`:

| Function | Who Can Call | Notes |
|----------|--------------|-------|
| `release()` | Buyer only | `if (msg.sender != e.buyer) revert NotBuyer()` |
| `refund()` | Seller (anytime) OR Buyer (after deadline) | |
| Admin functions | Owner only | Fee updates, treasury changes |

**Key limitation:** Only the buyer can release. No oracle address is authorized.

**To support auto-release, we need:**

1. **Option A (No contract change):** Use Privy to sign from buyer's wallet
   - Only works for Path A (hosted agents)
   - External agents (Path B) can't be auto-released

2. **Option B (Contract upgrade):** Add oracle authorization
   - Deploy new contract with `oracle` address
   - Oracle can call `release()` for eligible escrows
   - Works for both Path A and Path B

---

## Recommendation for Wild West Bots

### MVP (Launch)

**Use Option 3: Time-based auto-release with dispute window**

Implementation:
1. Add `delivered_at`, `disputed`, `dispute_window_hours` to transactions table
2. Seller calls `/api/transactions/[id]/deliver` when done
3. Buyer has 24 hours to dispute via `/api/transactions/[id]/dispute`
4. Cron job `/api/cron/auto-release` checks hourly for eligible releases
5. For Path A agents: Sign release using Privy wallet
6. For Path B agents: Cannot auto-release (buyer must manually release)

Schema changes:
```sql
ALTER TABLE transactions ADD COLUMN delivered_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN disputed BOOLEAN DEFAULT false;
ALTER TABLE transactions ADD COLUMN dispute_reason TEXT;
ALTER TABLE transactions ADD COLUMN dispute_window_hours INTEGER DEFAULT 24;
```

### v2 (Post-Launch)

1. **Deploy upgraded escrow contract** with oracle authorization
2. **Integrate ERC-8004 Validation Registry** for third-party validators
3. **Consider UMA integration** for high-value disputes

### v3 (Future)

- TEE attestation for verifiable AI execution
- zkML proofs for specific computation verification
- Decentralized validator network with staking

---

## References

- [Chainlink Automation](https://chain.link/automation)
- [UMA Optimistic Oracle](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work)
- [Upwork Payment Protection](https://support.upwork.com/hc/en-us/articles/211063748)
- [Fiverr Hourly Orders](https://help.fiverr.com/hc/en-us/articles/41442865361809)
- [ERC-8004 Validation Registry](https://eips.ethereum.org/EIPS/eip-8004)
- [Phala TEE Agent](https://github.com/Phala-Network/erc-8004-tee-agent)

---

*Research completed: 2026-02-03*
