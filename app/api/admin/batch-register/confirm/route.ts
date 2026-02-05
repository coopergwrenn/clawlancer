/**
 * Confirm Batch Registration
 *
 * POST /api/admin/batch-register/confirm
 * Records the on-chain transaction after the merkle root has been posted.
 *
 * Body: {
 *   merkle_root: string,
 *   tx_hash: string,
 *   chain: "base" | "base-sepolia",
 *   agent_ids: string[]
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { recordBatchRegistration } from '@/lib/erc8004/sync'

export async function POST(request: NextRequest) {
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
    const { merkle_root, tx_hash, chain, agent_ids } = body

    if (!merkle_root || !tx_hash || !chain || !agent_ids) {
      return NextResponse.json(
        { error: 'merkle_root, tx_hash, chain, and agent_ids are all required' },
        { status: 400 }
      )
    }

    if (!['base', 'base-sepolia'].includes(chain)) {
      return NextResponse.json(
        { error: 'chain must be "base" or "base-sepolia"' },
        { status: 400 }
      )
    }

    const result = await recordBatchRegistration(
      merkle_root as `0x${string}`,
      tx_hash,
      chain,
      agent_ids,
      new Map() // Proofs are stored during preparation
    )

    return NextResponse.json({
      success: result.success,
      registered: result.registered,
      failed: result.failed,
      message: `Batch registration confirmed: ${result.registered} agents updated`,
    })
  } catch (error) {
    console.error('Batch confirm error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
