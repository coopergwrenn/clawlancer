/**
 * ERC-8004 Local Storage
 *
 * Per PRD Section 1 (Trust Model):
 * - Store agent identity locally in ERC-8004 format
 * - Ready for future on-chain migration
 * - All data verifiable via on-chain references
 */

import { supabaseAdmin } from '@/lib/supabase/server'
import {
  ERC8004Registration,
  createERC8004Registration,
  validateRegistration,
  toTokenMetadata,
} from './schema'
import { ReputationScore } from '@/lib/reputation/calculate'

/**
 * Get ERC-8004 registration for an agent
 */
export async function getAgentERC8004(agentId: string): Promise<ERC8004Registration | null> {
  // Query only core columns that definitely exist
  const { data: agent, error } = await supabaseAdmin
    .from('agents')
    .select(`
      id,
      name,
      owner_address,
      wallet_address,
      is_hosted
    `)
    .eq('id', agentId)
    .single()

  if (error || !agent) {
    console.error('ERC8004 agent lookup failed:', error?.message || 'Agent not found')
    return null
  }

  // These columns might not exist
  const description = `Agent ${agent.name}`
  const category = 'other'

  // Try to get erc8004_registration separately
  let storedRegistration: ERC8004Registration | null = null
  try {
    const { data: regData } = await supabaseAdmin
      .from('agents')
      .select('erc8004_registration')
      .eq('id', agentId)
      .single()
    if (regData?.erc8004_registration) {
      storedRegistration = regData.erc8004_registration as ERC8004Registration
    }
  } catch {
    // Column might not exist
  }

  // Try to get additional ERC-8004 columns if they exist
  let tokenId: string | null = null
  let registeredAt: string | null = null
  let txHash: string | null = null
  let chain: string | null = null
  let reputationScore: number | null = null
  let reputationTier: string | null = null
  let reputationTransactions: number | null = null
  let reputationSuccessRate: number | null = null

  try {
    const { data: extra } = await supabaseAdmin
      .from('agents')
      .select(`
        erc8004_token_id,
        erc8004_registered_at,
        erc8004_tx_hash,
        erc8004_chain,
        reputation_score,
        reputation_tier,
        reputation_transactions,
        reputation_success_rate
      `)
      .eq('id', agentId)
      .single()

    if (extra) {
      tokenId = extra.erc8004_token_id
      registeredAt = extra.erc8004_registered_at
      txHash = extra.erc8004_tx_hash
      chain = extra.erc8004_chain
      reputationScore = extra.reputation_score
      reputationTier = extra.reputation_tier
      reputationTransactions = extra.reputation_transactions
      reputationSuccessRate = extra.reputation_success_rate
    }
  } catch {
    // Columns might not exist - continue with null values
  }

  // If registration exists, return it with current reputation
  if (storedRegistration) {
    const registration = storedRegistration

    // Update with current reputation data
    if (reputationScore !== null) {
      registration.reputation = {
        score: reputationScore,
        tier: reputationTier || 'NEW',
        totalTransactions: reputationTransactions || 0,
        successRate: reputationSuccessRate || 0,
        lastVerified: new Date().toISOString(),
      }
    }

    // Update chain status if token exists
    if (tokenId) {
      registration.chainStatus = {
        chain: (chain as ERC8004Registration['chainStatus']['chain']) || 'local',
        tokenId: tokenId,
        registrationTx: txHash || undefined,
        registeredAt: registeredAt || undefined,
      }
    }

    return registration
  }

  // Create default registration from agent data
  const registration = createERC8004Registration(
    agent.name,
    description,
    agent.owner_address,
    agent.wallet_address,
    {
      isHosted: agent.is_hosted,
      category,
    }
  )

  // Add reputation if available
  if (reputationScore !== null) {
    registration.reputation = {
      score: reputationScore,
      tier: reputationTier || 'NEW',
      totalTransactions: reputationTransactions || 0,
      successRate: reputationSuccessRate || 0,
      lastVerified: new Date().toISOString(),
    }
  }

  return registration
}

/**
 * Save ERC-8004 registration for an agent
 */
export async function saveAgentERC8004(
  agentId: string,
  registration: Partial<ERC8004Registration>
): Promise<{ success: boolean; errors?: string[] }> {
  // Get existing agent
  const { data: agent, error: fetchError } = await supabaseAdmin
    .from('agents')
    .select('id, erc8004_registration')
    .eq('id', agentId)
    .single()

  if (fetchError || !agent) {
    return { success: false, errors: ['Agent not found'] }
  }

  // Merge with existing registration if present
  const existingReg = agent.erc8004_registration as ERC8004Registration | null
  const mergedRegistration: ERC8004Registration = {
    ...existingReg,
    ...registration,
    metadata: {
      ...existingReg?.metadata,
      ...registration.metadata,
      updated: new Date().toISOString(),
    },
    chainStatus: {
      ...existingReg?.chainStatus,
      ...registration.chainStatus,
    },
  } as ERC8004Registration

  // Validate
  const validation = validateRegistration(mergedRegistration)
  if (!validation.valid) {
    return { success: false, errors: validation.errors }
  }

  // Save
  const { error: updateError } = await supabaseAdmin
    .from('agents')
    .update({
      erc8004_registration: mergedRegistration,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agentId)

  if (updateError) {
    return { success: false, errors: ['Failed to save registration'] }
  }

  return { success: true }
}

/**
 * Update agent reputation in ERC-8004 registration
 */
export async function updateAgentERC8004Reputation(
  agentId: string,
  reputation: ReputationScore
): Promise<boolean> {
  const { data: agent, error: fetchError } = await supabaseAdmin
    .from('agents')
    .select('erc8004_registration')
    .eq('id', agentId)
    .single()

  if (fetchError || !agent) {
    return false
  }

  const registration = (agent.erc8004_registration as ERC8004Registration) || {}

  registration.reputation = {
    score: reputation.score,
    tier: reputation.tier,
    totalTransactions: reputation.totalTransactions,
    successRate: reputation.breakdown.successRate,
    lastVerified: new Date().toISOString(),
  }

  const { error: updateError } = await supabaseAdmin
    .from('agents')
    .update({
      erc8004_registration: registration,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agentId)

  return !updateError
}

/**
 * Record on-chain registration (for future use when ERC-8004 is finalized)
 */
export async function recordOnChainRegistration(
  agentId: string,
  tokenId: string,
  txHash: string,
  chain: 'base' | 'base-sepolia' | 'ethereum'
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('agents')
    .update({
      erc8004_token_id: tokenId,
      erc8004_tx_hash: txHash,
      erc8004_chain: chain,
      erc8004_registered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', agentId)

  return !error
}

/**
 * Get token metadata for on-chain posting
 */
export async function getTokenMetadata(agentId: string) {
  const registration = await getAgentERC8004(agentId)
  if (!registration) {
    return null
  }

  return toTokenMetadata(registration)
}

/**
 * List agents with ERC-8004 registrations
 */
export async function listERC8004Agents(options: {
  chain?: string
  hasReputation?: boolean
  limit?: number
  offset?: number
} = {}) {
  let query = supabaseAdmin
    .from('agents')
    .select(`
      id,
      name,
      wallet_address,
      erc8004_registration,
      erc8004_token_id,
      erc8004_chain,
      reputation_score,
      reputation_tier
    `)
    .not('erc8004_registration', 'is', null)

  if (options.chain) {
    query = query.eq('erc8004_chain', options.chain)
  }

  if (options.hasReputation) {
    query = query.not('reputation_score', 'is', null)
  }

  query = query
    .order('created_at', { ascending: false })
    .range(options.offset || 0, (options.offset || 0) + (options.limit || 50) - 1)

  const { data, error } = await query

  if (error) {
    return []
  }

  return data
}

/**
 * Get agents pending on-chain registration
 */
export async function getPendingOnChainRegistrations(limit: number = 100) {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select(`
      id,
      name,
      wallet_address,
      erc8004_registration
    `)
    .not('erc8004_registration', 'is', null)
    .is('erc8004_token_id', null)
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error) {
    return []
  }

  return data
}
