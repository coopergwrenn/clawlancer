/**
 * ERC-8004 On-Chain Registration
 *
 * Per PRD Section 4 - On-chain identity registration
 * Registers agents on the canonical ERC-8004 IdentityRegistry on Base mainnet
 */

import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toBytes } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getAgentERC8004, recordOnChainRegistration } from './storage'
import { buildERC8004Identity, type ERC8004Identity } from './identity'

// ERC-8004 Contract Addresses on Base Mainnet
// Source: https://github.com/erc-8004/erc-8004-contracts
export const ERC8004_IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const
export const ERC8004_REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const

// ERC-8004 IdentityRegistry ABI (minimal interface for registration)
const IDENTITY_REGISTRY_ABI = parseAbi([
  // Registration functions
  'function register(string agentURI) external returns (uint256 agentId)',
  'function register() external returns (uint256 agentId)',

  // Configuration functions
  'function setAgentURI(uint256 agentId, string newURI) external',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature) external',
  'function getAgentWallet(uint256 agentId) external view returns (address)',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external',
  'function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes)',

  // Query functions
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function totalSupply() external view returns (uint256)',

  // Events
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI)',
])

// ERC-8004 ReputationRegistry ABI (minimal interface for feedback)
const REPUTATION_REGISTRY_ABI = parseAbi([
  // Post feedback
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external',
  // Revoke feedback
  'function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external',
  // Read summary (view — free)
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  // Read individual feedback
  'function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) external view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
])

// Create clients
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.ALCHEMY_BASE_URL),
})

/**
 * Get wallet client for signing transactions (uses oracle/treasury wallet)
 */
function getOracleWalletClient() {
  const privateKey = process.env.ORACLE_PRIVATE_KEY
  if (!privateKey) {
    throw new Error('ORACLE_PRIVATE_KEY not configured')
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`)

  return createWalletClient({
    account,
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL),
  })
}

/**
 * Build agent URI for on-chain registration
 * This points to our API endpoint that serves ERC-8004 compliant metadata
 */
export function buildAgentURI(agentId: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://clawlancer.ai'
  return `${baseUrl}/api/agents/${agentId}/erc8004/metadata`
}

/**
 * Convert our ERC8004Identity to the canonical format expected by the registry
 */
export function toCanonicalMetadata(identity: ERC8004Identity): object {
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: identity.name,
    description: identity.description,
    image: identity.image,
    external_url: identity.external_url,
    attributes: identity.attributes,
    properties: {
      ...identity.properties,
      supportedTrust: ['ERC-8004'],
    },
    services: [
      {
        type: 'A2A',
        endpoint: `${process.env.NEXT_PUBLIC_APP_URL || 'https://clawlancer.ai'}/api/agents/${identity.properties.wallet_address}/a2a`,
      },
    ],
  }
}

/**
 * Register an agent on the ERC-8004 IdentityRegistry
 */
export async function registerAgentOnChain(agentId: string): Promise<{
  success: boolean
  tokenId?: string
  txHash?: string
  error?: string
}> {
  try {
    // Get agent's ERC-8004 data
    const registration = await getAgentERC8004(agentId)
    if (!registration) {
      return { success: false, error: 'Agent not found or has no ERC-8004 registration' }
    }

    // Check if already registered on-chain
    if (registration.chainStatus?.chain === 'base' && registration.chainStatus?.tokenId) {
      return {
        success: true,
        tokenId: registration.chainStatus.tokenId,
        txHash: registration.chainStatus.registrationTx,
        error: 'Already registered on-chain',
      }
    }

    // Build the agent URI
    const agentURI = buildAgentURI(agentId)

    // Get wallet client
    const walletClient = getOracleWalletClient()

    // Get current nonce to avoid conflicts
    const nonce = await publicClient.getTransactionCount({
      address: walletClient.account.address,
      blockTag: 'pending',
    })

    // Estimate gas
    const gasEstimate = await publicClient.estimateContractGas({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'register',
      args: [agentURI],
      account: walletClient.account,
    })

    // Get current gas prices and add premium to replace stuck txs
    const gasPrice = await publicClient.getGasPrice()
    const maxFeePerGas = gasPrice * BigInt(3) // 3x current gas price
    const maxPriorityFeePerGas = BigInt(100000) // 0.0001 gwei — sufficient for Base L2

    // Send registration transaction
    const hash = await walletClient.writeContract({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'register',
      args: [agentURI],
      gas: gasEstimate + BigInt(50000), // Add buffer
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
    })

    if (receipt.status !== 'success') {
      return { success: false, error: 'Transaction failed', txHash: hash }
    }

    // Extract token ID from logs
    const transferLog = receipt.logs.find(log =>
      log.address.toLowerCase() === ERC8004_IDENTITY_REGISTRY.toLowerCase() &&
      log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' // Transfer event
    )

    let tokenId: string | undefined
    if (transferLog && transferLog.topics[3]) {
      tokenId = BigInt(transferLog.topics[3]).toString()
    }

    // Record in our database
    if (tokenId) {
      await recordOnChainRegistration(agentId, tokenId, hash, 'base')
    }

    return {
      success: true,
      tokenId,
      txHash: hash,
    }
  } catch (error) {
    console.error('ERC-8004 registration failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Verify an agent's on-chain registration
 */
export async function verifyAgentRegistration(tokenId: string): Promise<{
  exists: boolean
  owner?: string
  uri?: string
}> {
  try {
    const [owner, uri] = await Promise.all([
      publicClient.readContract({
        address: ERC8004_IDENTITY_REGISTRY,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'ownerOf',
        args: [BigInt(tokenId)],
      }),
      publicClient.readContract({
        address: ERC8004_IDENTITY_REGISTRY,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'tokenURI',
        args: [BigInt(tokenId)],
      }),
    ])

    return {
      exists: true,
      owner: owner as string,
      uri: uri as string,
    }
  } catch {
    return { exists: false }
  }
}

/**
 * Get total number of agents registered in the ERC-8004 registry
 */
export async function getTotalRegistered(): Promise<number> {
  try {
    const total = await publicClient.readContract({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'totalSupply',
    })
    return Number(total)
  } catch {
    return 0
  }
}

/**
 * Update agent URI on-chain (for metadata updates)
 */
export async function updateAgentURI(tokenId: string, newURI: string): Promise<{
  success: boolean
  txHash?: string
  error?: string
}> {
  try {
    const walletClient = getOracleWalletClient()

    const hash = await walletClient.writeContract({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'setAgentURI',
      args: [BigInt(tokenId), newURI],
    })

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    return {
      success: receipt.status === 'success',
      txHash: hash,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Get agent's wallet address from registry
 */
export async function getAgentWallet(tokenId: string): Promise<string | null> {
  try {
    const wallet = await publicClient.readContract({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'getAgentWallet',
      args: [BigInt(tokenId)],
    })
    return wallet as string
  } catch {
    return null
  }
}

/**
 * Format the global agent identifier per ERC-8004 spec
 * Format: eip155:{chainId}:{identityRegistry}:{agentId}
 */
export function formatGlobalAgentId(tokenId: string): string {
  return `eip155:8453:${ERC8004_IDENTITY_REGISTRY}:${tokenId}`
}

/**
 * Parse a global agent identifier
 */
export function parseGlobalAgentId(globalId: string): {
  chainId: number
  registry: string
  tokenId: string
} | null {
  const parts = globalId.split(':')
  if (parts.length !== 4 || parts[0] !== 'eip155') {
    return null
  }
  return {
    chainId: parseInt(parts[1]),
    registry: parts[2],
    tokenId: parts[3],
  }
}

/**
 * Post feedback on-chain to the ERC-8004 Reputation Registry
 */
export async function postFeedbackOnChain(
  agentTokenId: string,
  rating: number,
  transactionId: string,
  reviewId: string,
  reviewText?: string | null
): Promise<{
  success: boolean
  txHash?: string
  error?: string
}> {
  try {
    const walletClient = getOracleWalletClient()

    // rating * 100 (e.g., 5 → 500, 3 → 300)
    const value = BigInt(rating * 100) as unknown as bigint
    const valueDecimals = 2

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://clawlancer.ai'
    const feedbackURI = `${baseUrl}/api/reviews/${reviewId}`
    const feedbackHash = reviewText
      ? keccak256(toBytes(reviewText))
      : ('0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`)

    const nonce = await publicClient.getTransactionCount({
      address: walletClient.account.address,
      blockTag: 'pending',
    })

    const gasEstimate = await publicClient.estimateContractGas({
      address: ERC8004_REPUTATION_REGISTRY,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'giveFeedback',
      args: [
        BigInt(agentTokenId),
        value as unknown as bigint,
        valueDecimals,
        'escrow',
        'review',
        baseUrl,
        feedbackURI,
        feedbackHash,
      ],
      account: walletClient.account,
    })

    const gasPrice = await publicClient.getGasPrice()
    const maxFeePerGas = gasPrice * BigInt(3)
    const maxPriorityFeePerGas = BigInt(100000) // 0.0001 gwei — sufficient for Base L2

    const hash = await walletClient.writeContract({
      address: ERC8004_REPUTATION_REGISTRY,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'giveFeedback',
      args: [
        BigInt(agentTokenId),
        value as unknown as bigint,
        valueDecimals,
        'escrow',
        'review',
        baseUrl,
        feedbackURI,
        feedbackHash,
      ],
      gas: gasEstimate + BigInt(30000), // buffer
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
    })

    if (receipt.status !== 'success') {
      return { success: false, error: 'Transaction failed', txHash: hash }
    }

    return { success: true, txHash: hash }
  } catch (error) {
    console.error('ERC-8004 feedback posting failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Read on-chain reputation from the ERC-8004 Reputation Registry
 * View function — free, no gas needed
 */
export async function getOnChainReputation(agentTokenId: string): Promise<{
  count: number
  summaryValue: number
  summaryValueDecimals: number
} | null> {
  try {
    const result = await publicClient.readContract({
      address: ERC8004_REPUTATION_REGISTRY,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'getSummary',
      args: [
        BigInt(agentTokenId),
        [], // empty clientAddresses = all clients
        'escrow',
        'review',
      ],
    })

    const [count, summaryValue, summaryValueDecimals] = result as [bigint, bigint, number]

    return {
      count: Number(count),
      summaryValue: Number(summaryValue),
      summaryValueDecimals,
    }
  } catch (error) {
    console.error('ERC-8004 reputation read failed:', error)
    return null
  }
}
