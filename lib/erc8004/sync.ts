/**
 * ERC-8004 Sync Utilities
 *
 * Per PRD Section 1 (Trust Model):
 * - Prepare for future on-chain migration
 * - Batch registration when ERC-8004 standard is finalized
 * - Merkle tree for efficient on-chain verification
 */

import { keccak256, toHex, encodePacked } from 'viem'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getAgentERC8004, recordOnChainRegistration } from './storage'
import { ERC8004Registration, toTokenMetadata } from './schema'

/**
 * Generate Merkle tree leaf for an agent registration
 */
export function generateRegistrationLeaf(
  agentId: string,
  registration: ERC8004Registration
): `0x${string}` {
  // Hash core identity data
  return keccak256(
    encodePacked(
      ['bytes32', 'address', 'address', 'string', 'uint256'],
      [
        keccak256(toHex(agentId)),
        registration.controller.address as `0x${string}`,
        registration.agentWallet.address as `0x${string}`,
        registration.name,
        BigInt(registration.reputation?.totalTransactions || 0),
      ]
    )
  )
}

/**
 * Generate Merkle root for a batch of registrations
 */
export function generateMerkleRoot(
  leaves: `0x${string}`[]
): { root: `0x${string}`; proofs: Map<string, `0x${string}`[]> } {
  if (leaves.length === 0) {
    return {
      root: '0x0000000000000000000000000000000000000000000000000000000000000000',
      proofs: new Map(),
    }
  }

  // Sort leaves for deterministic ordering
  const sortedLeaves = [...leaves].sort()
  const proofs = new Map<string, `0x${string}`[]>()

  // Initialize proofs
  sortedLeaves.forEach((leaf) => proofs.set(leaf, []))

  // Build tree level by level
  let currentLevel = sortedLeaves

  while (currentLevel.length > 1) {
    const nextLevel: `0x${string}`[] = []

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]
      const right = currentLevel[i + 1] || currentLevel[i] // Duplicate last if odd

      // Hash pair (sorted for consistency)
      const [first, second] = [left, right].sort()
      const parentHash = keccak256(
        encodePacked(['bytes32', 'bytes32'], [first, second])
      )

      nextLevel.push(parentHash)

      // Update proofs
      if (left !== right) {
        const leftProof = proofs.get(left) || []
        leftProof.push(right)
        proofs.set(left, leftProof)

        const rightProof = proofs.get(right) || []
        rightProof.push(left)
        proofs.set(right, rightProof)
      }
    }

    currentLevel = nextLevel
  }

  return {
    root: currentLevel[0],
    proofs,
  }
}

/**
 * Verify a Merkle proof
 */
export function verifyMerkleProof(
  leaf: `0x${string}`,
  proof: `0x${string}`[],
  root: `0x${string}`
): boolean {
  let computedHash = leaf

  for (const proofElement of proof) {
    const [first, second] = [computedHash, proofElement].sort()
    computedHash = keccak256(
      encodePacked(['bytes32', 'bytes32'], [first, second])
    )
  }

  return computedHash === root
}

/**
 * Prepare batch for on-chain posting
 */
export async function prepareBatchRegistration(agentIds: string[]): Promise<{
  merkleRoot: `0x${string}`
  registrations: Array<{
    agentId: string
    leaf: `0x${string}`
    proof: `0x${string}`[]
    tokenMetadata: ReturnType<typeof toTokenMetadata>
  }>
}> {
  const registrations: Array<{
    agentId: string
    registration: ERC8004Registration
    leaf: `0x${string}`
  }> = []

  // Fetch and hash all registrations
  for (const agentId of agentIds) {
    const registration = await getAgentERC8004(agentId)
    if (registration) {
      const leaf = generateRegistrationLeaf(agentId, registration)
      registrations.push({ agentId, registration, leaf })
    }
  }

  // Generate Merkle tree
  const leaves = registrations.map((r) => r.leaf)
  const { root, proofs } = generateMerkleRoot(leaves)

  // Build result with proofs
  return {
    merkleRoot: root,
    registrations: registrations.map((r) => ({
      agentId: r.agentId,
      leaf: r.leaf,
      proof: proofs.get(r.leaf) || [],
      tokenMetadata: toTokenMetadata(r.registration),
    })),
  }
}

/**
 * Record batch registration on-chain (when ERC-8004 contract is available)
 */
export async function recordBatchRegistration(
  merkleRoot: `0x${string}`,
  txHash: string,
  chain: 'base' | 'base-sepolia' | 'ethereum',
  agentIds: string[],
  proofs: Map<string, `0x${string}`[]>
): Promise<{ success: boolean; registered: number; failed: number }> {
  let registered = 0
  let failed = 0

  // Record batch in database
  const { data: batch, error: batchError } = await supabaseAdmin
    .from('reputation_batches')
    .insert({
      merkle_root: merkleRoot,
      feedback_count: agentIds.length,
      tx_hash: txHash,
      chain,
    })
    .select()
    .single()

  if (batchError) {
    console.error('Failed to record batch:', batchError)
    return { success: false, registered: 0, failed: agentIds.length }
  }

  // Update each agent's ERC-8004 record
  for (const agentId of agentIds) {
    const proof = proofs.get(agentId)

    const { error } = await supabaseAdmin
      .from('agents')
      .update({
        erc8004_token_id: merkleRoot, // Use merkle root as pseudo-token ID for batch
        erc8004_tx_hash: txHash,
        erc8004_chain: chain,
        erc8004_registered_at: new Date().toISOString(),
        erc8004_registration: supabaseAdmin.rpc('jsonb_set', {
          target: 'erc8004_registration',
          path: ['chainStatus'],
          value: JSON.stringify({
            chain,
            tokenId: merkleRoot,
            registrationTx: txHash,
            registeredAt: new Date().toISOString(),
            merkleProof: proof,
          }),
        }),
      })
      .eq('id', agentId)

    if (error) {
      console.error(`Failed to update agent ${agentId}:`, error)
      failed++
    } else {
      registered++
    }
  }

  return { success: failed === 0, registered, failed }
}

/**
 * Check if agent registration can be verified on-chain
 */
export async function verifyOnChainRegistration(agentId: string): Promise<{
  verified: boolean
  merkleRoot?: string
  proof?: `0x${string}`[]
  txHash?: string
  chain?: string
}> {
  const registration = await getAgentERC8004(agentId)

  if (!registration || registration.chainStatus.chain === 'local') {
    return { verified: false }
  }

  // Get agent's proof data
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('erc8004_registration, erc8004_token_id, erc8004_tx_hash, erc8004_chain')
    .eq('id', agentId)
    .single()

  if (!agent || !agent.erc8004_token_id) {
    return { verified: false }
  }

  const regData = agent.erc8004_registration as ERC8004Registration & {
    chainStatus?: { merkleProof?: `0x${string}`[] }
  }

  const proof = regData?.chainStatus?.merkleProof || []
  const leaf = generateRegistrationLeaf(agentId, registration)
  const merkleRoot = agent.erc8004_token_id as `0x${string}`

  const verified = verifyMerkleProof(leaf, proof, merkleRoot)

  return {
    verified,
    merkleRoot,
    proof,
    txHash: agent.erc8004_tx_hash,
    chain: agent.erc8004_chain,
  }
}
