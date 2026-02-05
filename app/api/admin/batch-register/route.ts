/**
 * Batch ERC-8004 Registration Admin Endpoint
 *
 * POST /api/admin/batch-register
 * Prepares a merkle tree batch of agent registrations for on-chain posting.
 *
 * Body: { agent_ids: string[] | "all" }
 *
 * Returns merkle root and individual proofs for on-chain verification.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { prepareBatchRegistration } from '@/lib/erc8004/sync'

export async function POST(request: NextRequest) {
  // Verify admin auth
  const authHeader = request.headers.get('authorization')
  const adminWallet = request.headers.get('x-admin-wallet')?.toLowerCase()
  const adminWallets = (process.env.ADMIN_WALLETS || '').toLowerCase().split(',')

  const isAdmin = adminWallet && adminWallets.includes(adminWallet)
  const isCronAuth = authHeader === `Bearer ${process.env.CRON_SECRET}`

  if (!isAdmin && !isCronAuth) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { agent_ids } = body

    let targetIds: string[]

    if (agent_ids === 'all') {
      // Get all agents with ERC-8004 registration data that aren't yet on-chain
      const { data: agents } = await supabaseAdmin
        .from('agents')
        .select('id')
        .not('erc8004_registration', 'is', null)
        .is('erc8004_token_id', null)

      targetIds = (agents || []).map((a: { id: string }) => a.id)
    } else if (Array.isArray(agent_ids) && agent_ids.length > 0) {
      targetIds = agent_ids
    } else {
      return NextResponse.json(
        { error: 'agent_ids must be an array of UUIDs or "all"' },
        { status: 400 }
      )
    }

    if (targetIds.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No agents to register',
        count: 0,
      })
    }

    // Prepare batch registration with merkle tree
    const batch = await prepareBatchRegistration(targetIds)

    return NextResponse.json({
      success: true,
      merkle_root: batch.merkleRoot,
      agent_count: batch.registrations.length,
      registrations: batch.registrations.map((r) => ({
        agent_id: r.agentId,
        leaf: r.leaf,
        proof: r.proof,
        metadata: {
          name: r.tokenMetadata.name,
          description: r.tokenMetadata.description,
          agent_version: r.tokenMetadata.agent_version,
        },
      })),
      instructions: {
        step_1: 'Post merkle_root to IdentityRegistry contract on Base',
        step_2: 'Call POST /api/admin/batch-register/confirm with tx_hash and merkle_root',
        contract: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        chain: 'base',
      },
    })
  } catch (error) {
    console.error('Batch registration error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/admin/batch-register
 * Get status of pending and completed batch registrations
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const adminWallet = request.headers.get('x-admin-wallet')?.toLowerCase()
  const adminWallets = (process.env.ADMIN_WALLETS || '').toLowerCase().split(',')

  const isAdmin = adminWallet && adminWallets.includes(adminWallet)
  const isCronAuth = authHeader === `Bearer ${process.env.CRON_SECRET}`

  if (!isAdmin && !isCronAuth) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Get batch history
  const { data: batches } = await supabaseAdmin
    .from('reputation_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20)

  // Get agents pending registration
  const { data: pending } = await supabaseAdmin
    .from('agents')
    .select('id, name')
    .not('erc8004_registration', 'is', null)
    .is('erc8004_token_id', null)

  // Get registered agents
  const { data: registered } = await supabaseAdmin
    .from('agents')
    .select('id, name, erc8004_token_id, erc8004_chain, erc8004_registered_at')
    .not('erc8004_token_id', 'is', null)

  return NextResponse.json({
    pending_agents: (pending || []).length,
    registered_agents: (registered || []).length,
    batches: batches || [],
    pending: (pending || []).map((a: { id: string; name: string }) => ({
      id: a.id,
      name: a.name,
    })),
    registered: (registered || []).map((a: { id: string; name: string; erc8004_token_id: string; erc8004_chain: string; erc8004_registered_at: string }) => ({
      id: a.id,
      name: a.name,
      token_id: a.erc8004_token_id,
      chain: a.erc8004_chain,
      registered_at: a.erc8004_registered_at,
    })),
  })
}
