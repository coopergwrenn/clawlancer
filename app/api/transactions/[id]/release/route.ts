import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { getOnChainEscrow, EscrowState } from '@/lib/blockchain/escrow'
import { agentReleaseEscrow } from '@/lib/privy/server-wallet'

// POST /api/transactions/[id]/release - Buyer releases escrow to seller
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  // Parse optional tx_hash from body (for Path B external agents)
  let txHash: string | null = null
  try {
    const body = await request.json()
    txHash = body.tx_hash || null
  } catch {
    // No body or invalid JSON is fine
  }

  // Get transaction with agent details
  const { data: transaction } = await supabaseAdmin
    .from('transactions')
    .select(`
      *,
      buyer:agents!buyer_agent_id(id, owner_address, wallet_address, privy_wallet_id, is_hosted),
      seller:agents!seller_agent_id(id, wallet_address)
    `)
    .eq('id', id)
    .single()

  if (!transaction) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  if (transaction.state !== 'FUNDED') {
    return NextResponse.json({ error: 'Transaction is not in FUNDED state' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buyer = transaction.buyer as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seller = transaction.seller as any

  // Verify buyer ownership (unless system auth)
  if (auth.type === 'user' && buyer.owner_address !== auth.wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Only the buyer can release' }, { status: 403 })
  }

  let releaseTxHash: string | null = txHash

  // Handle on-chain release
  if (txHash) {
    // Path B: External agent already released on-chain
    try {
      const onChainEscrow = await getOnChainEscrow(transaction.escrow_id || id)
      if (onChainEscrow.state !== EscrowState.RELEASED) {
        // Might still be pending, accept the tx_hash anyway
        console.log('On-chain escrow not yet RELEASED, tx may be pending')
      }
    } catch (err) {
      console.error('Failed to verify on-chain release:', err)
    }
  } else if (buyer.is_hosted && buyer.privy_wallet_id) {
    // Path A: Hosted agent - release via Privy
    try {
      const result = await agentReleaseEscrow(
        buyer.privy_wallet_id,
        transaction.escrow_id || id
      )
      releaseTxHash = result.hash
    } catch (privyError) {
      console.error('Failed to release on-chain via Privy:', privyError)
      return NextResponse.json({ error: 'Failed to release on-chain escrow' }, { status: 500 })
    }
  } else {
    // External agent needs to release on-chain first
    return NextResponse.json({
      error: 'External agents must release on-chain first and provide tx_hash',
      escrow_id: transaction.escrow_id || id,
    }, { status: 400 })
  }

  // Update transaction state
  const { error: updateError } = await supabaseAdmin
    .from('transactions')
    .update({
      state: 'RELEASED',
      completed_at: new Date().toISOString(),
      release_tx_hash: releaseTxHash,
    })
    .eq('id', id)

  if (updateError) {
    console.error('Failed to update transaction:', updateError)
    return NextResponse.json({ error: 'Failed to update transaction state' }, { status: 500 })
  }

  // Update agent stats
  const amountWei = BigInt(transaction.amount_wei)
  const feeAmount = (amountWei * BigInt(100)) / BigInt(10000) // 1% fee
  const sellerAmount = amountWei - feeAmount

  // Update seller earnings
  await supabaseAdmin
    .from('agents')
    .update({
      total_earned_wei: (BigInt(seller.total_earned_wei || '0') + sellerAmount).toString(),
    })
    .eq('id', seller.id)
    .catch((err: Error) => console.error('Failed to update seller earnings:', err))

  // Update buyer spending
  await supabaseAdmin
    .from('agents')
    .update({
      total_spent_wei: (BigInt(buyer.total_spent_wei || '0') + amountWei).toString(),
    })
    .eq('id', buyer.id)
    .catch((err: Error) => console.error('Failed to update buyer spending:', err))

  // Increment transaction counts for both
  await supabaseAdmin.rpc('increment_transaction_count', { agent_id: seller.id }).catch(() => {})
  await supabaseAdmin.rpc('increment_transaction_count', { agent_id: buyer.id }).catch(() => {})

  return NextResponse.json({
    success: true,
    message: 'Escrow released to seller',
    tx_hash: releaseTxHash,
    seller_received_wei: sellerAmount.toString(),
    fee_wei: feeAmount.toString(),
  })
}
