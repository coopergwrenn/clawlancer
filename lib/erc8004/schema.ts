/**
 * ERC-8004 Agent Metadata Schema
 *
 * Per PRD Section 1 (Trust Model):
 * - Agent identity stored locally in ERC-8004 format
 * - Ready for future on-chain migration when standard is finalized
 * - Includes verification references for trust
 */

/**
 * ERC-8004 Agent Registration
 * Following draft ERC-8004 spec for autonomous agent identity
 */
export interface ERC8004Registration {
  // Core identity
  name: string
  description: string
  version: string // Schema version (e.g., "1.0.0")

  // Agent capabilities
  capabilities: AgentCapability[]

  // Controller/owner information
  controller: {
    address: string // Wallet address that controls the agent
    type: 'EOA' | 'CONTRACT' | 'MULTISIG'
  }

  // Agent wallet (for autonomous transactions)
  agentWallet: {
    address: string
    type: 'PRIVY_SERVER' | 'EOA' | 'SMART_WALLET'
    custodian?: string // e.g., "privy.io" for hosted wallets
  }

  // Metadata
  metadata: {
    created: string // ISO timestamp
    updated: string // ISO timestamp
    category?: string // e.g., "FINANCE", "CONTENT", "AUTOMATION"
    tags?: string[]
    avatar?: string // IPFS or URL
    externalUrl?: string
  }

  // Trust/reputation (cached, verifiable on-chain)
  reputation?: {
    score: number
    tier: string
    totalTransactions: number
    successRate: number
    lastVerified: string
    verificationTxHash?: string
  }

  // Chain registration status
  chainStatus: {
    chain: 'local' | 'base' | 'base-sepolia' | 'ethereum'
    tokenId?: string // ERC-8004 token ID if registered on-chain
    registrationTx?: string
    registeredAt?: string
  }
}

/**
 * Agent capability definition
 */
export interface AgentCapability {
  id: string // e.g., "trade", "analyze", "create"
  name: string
  description: string
  version: string
  inputSchema?: Record<string, unknown> // JSON Schema for inputs
  outputSchema?: Record<string, unknown> // JSON Schema for outputs
  pricing?: {
    model: 'FREE' | 'PER_CALL' | 'SUBSCRIPTION'
    amount?: string // In wei
    currency?: string // e.g., "USDC"
  }
}

/**
 * ERC-8004 Token Metadata (for on-chain representation)
 * Follows ERC-721 metadata standard with ERC-8004 extensions
 */
export interface ERC8004TokenMetadata {
  name: string
  description: string
  image?: string
  external_url?: string
  attributes: TokenAttribute[]

  // ERC-8004 specific extensions
  agent_version: string
  capabilities: string[] // Capability IDs
  controller: string
  agent_wallet: string
  reputation_score?: number
}

interface TokenAttribute {
  trait_type: string
  value: string | number | boolean
  display_type?: 'number' | 'date' | 'boost_percentage'
}

/**
 * Create a new ERC-8004 registration from agent data
 */
export function createERC8004Registration(
  name: string,
  description: string,
  controllerAddress: string,
  agentWalletAddress: string,
  options: {
    isHosted?: boolean
    category?: string
    capabilities?: AgentCapability[]
  } = {}
): ERC8004Registration {
  const now = new Date().toISOString()

  return {
    name,
    description,
    version: '1.0.0',
    capabilities: options.capabilities || [],
    controller: {
      address: controllerAddress.toLowerCase(),
      type: 'EOA',
    },
    agentWallet: {
      address: agentWalletAddress.toLowerCase(),
      type: options.isHosted ? 'PRIVY_SERVER' : 'EOA',
      custodian: options.isHosted ? 'privy.io' : undefined,
    },
    metadata: {
      created: now,
      updated: now,
      category: options.category,
    },
    chainStatus: {
      chain: 'local',
    },
  }
}

/**
 * Convert ERC8004Registration to token metadata for on-chain posting
 */
export function toTokenMetadata(registration: ERC8004Registration): ERC8004TokenMetadata {
  const attributes: TokenAttribute[] = [
    { trait_type: 'Version', value: registration.version },
    { trait_type: 'Controller Type', value: registration.controller.type },
    { trait_type: 'Wallet Type', value: registration.agentWallet.type },
    { trait_type: 'Chain', value: registration.chainStatus.chain },
  ]

  if (registration.metadata.category) {
    attributes.push({ trait_type: 'Category', value: registration.metadata.category })
  }

  if (registration.reputation) {
    attributes.push(
      { trait_type: 'Reputation Score', value: registration.reputation.score, display_type: 'number' },
      { trait_type: 'Reputation Tier', value: registration.reputation.tier },
      { trait_type: 'Total Transactions', value: registration.reputation.totalTransactions, display_type: 'number' },
      { trait_type: 'Success Rate', value: Math.round(registration.reputation.successRate * 100) }
    )
  }

  return {
    name: registration.name,
    description: registration.description,
    image: registration.metadata.avatar,
    external_url: registration.metadata.externalUrl,
    attributes,
    agent_version: registration.version,
    capabilities: registration.capabilities.map((c) => c.id),
    controller: registration.controller.address,
    agent_wallet: registration.agentWallet.address,
    reputation_score: registration.reputation?.score,
  }
}

/**
 * Validate an ERC-8004 registration
 */
export function validateRegistration(registration: Partial<ERC8004Registration>): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (!registration.name || registration.name.length < 2) {
    errors.push('Name must be at least 2 characters')
  }

  if (!registration.description) {
    errors.push('Description is required')
  }

  if (!registration.controller?.address) {
    errors.push('Controller address is required')
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(registration.controller.address)) {
    errors.push('Invalid controller address format')
  }

  if (!registration.agentWallet?.address) {
    errors.push('Agent wallet address is required')
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(registration.agentWallet.address)) {
    errors.push('Invalid agent wallet address format')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Default capabilities for common agent types
 */
export const DEFAULT_CAPABILITIES: Record<string, AgentCapability[]> = {
  TRADING: [
    {
      id: 'trade',
      name: 'Execute Trade',
      description: 'Execute trades on decentralized exchanges',
      version: '1.0.0',
      pricing: { model: 'PER_CALL', amount: '100000', currency: 'USDC' }, // 0.10 USDC
    },
  ],
  ANALYSIS: [
    {
      id: 'analyze',
      name: 'Market Analysis',
      description: 'Analyze market conditions and provide insights',
      version: '1.0.0',
      pricing: { model: 'PER_CALL', amount: '50000', currency: 'USDC' }, // 0.05 USDC
    },
  ],
  CONTENT: [
    {
      id: 'create',
      name: 'Content Creation',
      description: 'Create content based on prompts',
      version: '1.0.0',
      pricing: { model: 'PER_CALL', amount: '200000', currency: 'USDC' }, // 0.20 USDC
    },
  ],
}
