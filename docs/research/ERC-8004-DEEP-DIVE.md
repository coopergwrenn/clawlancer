# ERC-8004 Deep Dive Research

## Overview

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) (Trustless Agents) is an Ethereum standard for discovering and establishing trust for blockchain-based agents. It was created on August 13, 2025 by Marco De Rossi (MetaMask), Davide Crapis (Ethereum Foundation), Jordan Ellis (Google), and Erik Reppel (Coinbase).

**Mainnet deployment:** January 29, 2026

---

## Contract Interfaces

### Identity Registry

The Identity Registry is an ERC-721 with URIStorage extension. Each agent gets a unique token ID (agentId) that resolves to a registration file.

```solidity
// Registration functions (3 overloads)
function register(string agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId)
function register(string agentURI) external returns (uint256 agentId)
function register() external returns (uint256 agentId)

// URI management
function setAgentURI(uint256 agentId, string calldata newURI) external

// Metadata (key-value storage)
function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external
function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory)

// Wallet association (requires EIP-712/1271 signature)
function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external
function getAgentWallet(uint256 agentId) external view returns (address)
```

**Events:**
- `Registered(uint256 indexed agentId, string tokenURI, address indexed owner)`

### Reputation Registry

Posts and retrieves feedback signals for agents.

```solidity
// Post feedback
function giveFeedback(
    uint256 agentId,
    int128 value,           // Score (-128 to 127 with decimals)
    uint8 valueDecimals,    // 0-18 decimal places
    string calldata tag1,   // Category tag (e.g., "escrow")
    string calldata tag2,   // Sub-category (e.g., "delivery")
    string calldata endpoint,
    string calldata feedbackURI,
    bytes32 feedbackHash
) external

// Revoke feedback
function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external

// Agent can respond to feedback
function appendResponse(
    uint256 agentId,
    address clientAddress,
    uint64 feedbackIndex,
    string calldata responseURI,
    bytes32 responseHash
) external

// Read feedback
function getSummary(
    uint256 agentId,
    address[] calldata clientAddresses,
    string tag1,
    string tag2
) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)

function readFeedback(
    uint256 agentId,
    address clientAddress,
    uint64 feedbackIndex
) external view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)

function readAllFeedback(
    uint256 agentId,
    address[] calldata clientAddresses,
    string tag1,
    string tag2,
    bool includeRevoked
) external view returns (
    address[] memory clients,
    uint64[] memory feedbackIndexes,
    int128[] memory values,
    uint8[] memory valueDecimals,
    string[] memory tag1s,
    string[] memory tag2s,
    bool[] memory revokedStatuses
)
```

### Validation Registry

For third-party verification of agent tasks.

```solidity
function validationRequest(
    address validatorAddress,
    uint256 agentId,
    string requestURI,
    bytes32 requestHash
) external

function validationResponse(
    bytes32 requestHash,
    uint8 response,
    string responseURI,
    bytes32 responseHash,
    string tag
) external

function getValidationStatus(bytes32 requestHash) external view returns (
    address validatorAddress,
    uint256 agentId,
    uint8 response,
    bytes32 responseHash,
    string tag,
    uint256 lastUpdate
)
```

---

## SDK / npm Packages

### @agentic-trust/8004-ext-sdk

The official TypeScript SDK for ERC-8004 integration.

**Installation:**
```bash
npm install @agentic-trust/8004-ext-sdk
```

**Main exports:**
- `AIAgentENSClient` - ENS-based agent management
- `AIAgentIdentityClient` - Agent identity operations
- `AIAgentReputationClient` - Reputation/feedback systems
- `AIAgentL2ENSDurenClient` - L2-specific operations (Base, Optimism)
- `OrgIdentityClient` - Organization management

**Basic usage:**
```typescript
import { AIAgentIdentityClient, AIAgentReputationClient } from '@agentic-trust/8004-ext-sdk';
import { base } from 'viem/chains';

// Identity client
const identityClient = new AIAgentIdentityClient(
  8453,  // Base mainnet chain ID
  'https://base-mainnet.g.alchemy.com/v2/YOUR_KEY',
  IDENTITY_REGISTRY_ADDRESS
);

// Get agent metadata
const metadata = await identityClient.getMetadata(agentId, 'agentName');
const name = await identityClient.getAgentName(agentId);
```

---

## Deployed Addresses

| Chain | Identity Registry | Reputation Registry |
|-------|------------------|---------------------|
| **Ethereum Mainnet** | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Ethereum Sepolia | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Polygon Mainnet | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| **Base Mainnet** | **Not yet deployed** | **Not yet deployed** |
| Base Sepolia | Deployed (testnet) | Deployed (testnet) |

---

## Cross-Chain Considerations

### The Problem

Our escrow contract is on **Base mainnet**, but ERC-8004 registries are currently only on **Ethereum mainnet** (and Polygon). How do we handle this?

### Options

#### Option 1: Use Ethereum Mainnet Registry (Recommended for MVP)

Register agents on Ethereum mainnet, transact on Base.

**Pros:**
- Uses canonical registry where most agents will be
- Reputation is portable across all chains
- SDK supports multi-chain

**Cons:**
- Higher gas costs for registration (~$5-15 per agent on mainnet)
- Two chains to manage

**Implementation:**
```typescript
// Register agent on Ethereum mainnet
const ethClient = new AIAgentIdentityClient(
  1,  // Ethereum mainnet
  ETH_RPC_URL,
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
);

// Agent transacts on Base
const baseEscrow = new Contract(ESCROW_ADDRESS, escrowAbi, baseSigner);
```

#### Option 2: Wait for Base Mainnet Deployment

The ERC-8004 team has indicated L2 deployments are coming.

**Pros:**
- Lower gas costs (~$0.10 per registration)
- Single chain for everything

**Cons:**
- Unknown timeline
- May fragment reputation across chains

#### Option 3: Deploy Our Own Registry on Base

Deploy the reference implementation ourselves.

**Pros:**
- Immediate availability
- Full control

**Cons:**
- Not the canonical registry
- Reputation not portable
- Against the spirit of the standard

### Recommendation

**For MVP:** Use Ethereum mainnet for identity/reputation. Accept higher gas costs for now.

**For v2:** When Base deployment is available, migrate or bridge identities.

---

## Gas Costs

### On Ethereum Mainnet

| Operation | Gas (est.) | Cost @ 30 gwei |
|-----------|-----------|----------------|
| `register()` | ~150,000 | ~$8-15 |
| `giveFeedback()` | ~80,000 | ~$4-8 |
| `getSummary()` | ~30,000 (view) | Free |

### On Base (when available)

| Operation | Gas (est.) | Cost |
|-----------|-----------|------|
| `register()` | ~150,000 | ~$0.10 |
| `giveFeedback()` | ~80,000 | ~$0.05 |

### Cost Mitigation Strategies

1. **Batch registrations:** Register multiple agents in one tx
2. **Lazy registration:** Register agents only when needed (first transaction)
3. **Subsidize house bots:** We pay for house bot registration
4. **User-pays:** External agents pay their own registration

---

## Example Integrations

### Phala Network TEE Agent

[GitHub: erc-8004-tee-agent](https://github.com/Phala-Network/erc-8004-tee-agent)

Uses ERC-8004 with TEE attestation for verifiable AI agents.

### Vistara Example

[GitHub: erc-8004-example](https://github.com/vistara-apps/erc-8004-example)

Basic implementation showing registration and feedback flows.

### Agent0 TypeScript SDK

[GitHub: agent0-ts](https://github.com/agent0lab/agent0-ts)

Alternative TypeScript SDK for agent portability and trust.

---

## Integration Plan for Wild West Bots

### Phase 1: Identity Registration (MVP)

When an agent is created (Path A or B):

```typescript
// lib/erc8004/identity.ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { mainnet } from 'viem/chains';

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

export async function registerAgent(
  agentId: string,
  agentURI: string,
  signer: WalletClient
): Promise<bigint> {
  const hash = await signer.writeContract({
    address: IDENTITY_REGISTRY,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [agentURI],
  });

  // Parse agentId from logs
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const agentTokenId = parseAgentId(receipt.logs);

  return agentTokenId;
}
```

### Phase 2: Reputation Posting

When a transaction completes:

```typescript
// lib/erc8004/reputation.ts
export async function postTransactionFeedback(
  sellerAgentId: bigint,
  buyerAddress: Address,
  isPositive: boolean,
  transactionId: string
): Promise<void> {
  const feedbackURI = `https://wild-west-bots.vercel.app/api/feedback/${transactionId}.json`;

  await walletClient.writeContract({
    address: REPUTATION_REGISTRY,
    abi: reputationRegistryAbi,
    functionName: 'giveFeedback',
    args: [
      sellerAgentId,
      isPositive ? BigInt(100) : BigInt(-100),  // value
      0,  // decimals
      'escrow',  // tag1
      'delivery',  // tag2
      'https://wild-west-bots.vercel.app',  // endpoint
      feedbackURI,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    ],
  });
}
```

### Phase 3: Display Reputation

Show agent reputation on profiles:

```typescript
export async function getAgentReputation(agentId: bigint) {
  const [count, summaryValue, decimals] = await publicClient.readContract({
    address: REPUTATION_REGISTRY,
    abi: reputationRegistryAbi,
    functionName: 'getSummary',
    args: [agentId, [], '', ''],
  });

  return {
    feedbackCount: Number(count),
    averageScore: Number(summaryValue) / Math.pow(10, decimals),
  };
}
```

---

## Resources

- [ERC-8004 Specification](https://eips.ethereum.org/EIPS/eip-8004)
- [Official Contracts Repository](https://github.com/erc-8004/erc-8004-contracts)
- [8004.org](https://8004.org/)
- [8004scan.io](https://8004scan.io/) - Agent explorer
- [@agentic-trust/8004-ext-sdk](https://www.npmjs.com/package/@agentic-trust/8004-ext-sdk)
- [Awesome ERC-8004](https://github.com/sudeepb02/awesome-erc8004)
- [Ethereum Magicians Discussion](https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098)

---

*Research completed: 2026-02-03*
