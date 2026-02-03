import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { getOnChainEscrow, EscrowState } from '@/lib/blockchain/escrow'
import { agentRefundEscrow } from '@/lib/privy/server-wallet'

// POST /api/transactions/[id]/refund - Refund escrow to buyer
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
      seller:agents!seller_agent_id(id, owner_address, wallet_address, privy_wallet_id, is_hosted)
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
  const now = new Date()
  const deadline = transaction.deadline ? new Date(transaction.deadline) : null
  const isPastDeadline = deadline && now > deadline

  // Determine who is making the request and if they're authorized
  let refundingAgent: { id: string; privy_wallet_id: string | null; is_hosted: boolean } | null = null
  let refundReason = ''

  if (auth.type === 'system') {
    // System can always refund (e.g., cron job for expired escrows)
    // Use seller's wallet to refund (seller canceling) or buyer if past deadline
    refundingAgent = isPastDeadline ? buyer : seller
    refundReason = isPastDeadline ? 'deadline_expired' : 'system_refund'
  } else if (auth.type === 'user') {
    const isSellerOwner = seller.owner_address === auth.wallet.toLowerCase()
    const isBuyerOwner = buyer.owner_address === auth.wallet.toLowerCase()

    if (!isSellerOwner && !isBuyerOwner) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    if (isSellerOwner) {
      // Seller can always cancel/refund
      refundingAgent = seller
      refundReason = 'seller_cancelled'
    } else if (isBuyerOwner) {
      // Buyer can only refund after deadline
      if (!isPastDeadline) {
        return NextResponse.json(
          { error: 'Buyer can only refund after deadline has passed' },
          { status: 400 }
        )
      }
      refundingAgent = buyer
      refundReason = 'deadline_expired'
    }
  }

  if (!refundingAgent) {
    return NextResponse.json({ error: 'Could not determine refunding agent' }, { status: 500 })
  }

  let refundTxHash: string | null = txHash

  // Handle on-chain refund
  if (txHash) {
    // Path B: External agent already refunded on-chain
    try {
      const onChainEscrow = await getOnChainEscrow(transaction.escrow_id || id)
      if (onChainEscrow.state !== EscrowState.REFUNDED) {
        console.log('On-chain escrow not yet REFUNDED, tx may be pending')
      }
    } catch (err) {
      console.error('Failed to verify on-chain refund:', err)
    }
  } else if (refundingAgent.is_hosted && refundingAgent.privy_wallet_id) {
    // Path A: Hosted agent - refund via Privy
    try {
      const result = await agentRefundEscrow(
        refundingAgent.privy_wallet_id,
        transaction.escrow_id || id
      )
      refundTxHash = result.hash
    } catch (privyError) {
      console.error('Failed to refund on-chain via Privy:', privyError)
      return NextResponse.json({ error: 'Failed to refund on-chain escrow' }, { status: 500 })
    }
  } else {
    // External agent needs to refund on-chain first
    return NextResponse.json({
      error: 'External agents must refund on-chain first and provide tx_hash',
      escrow_id: transaction.escrow_id || id,
    }, { status: 400 })
  }

  // Update transaction state
  const { error: updateError } = await supabaseAdmin
    .from('transactions')
    .update({
      state: 'REFUNDED',
      completed_at: new Date().toISOString(),
      refund_tx_hash: refundTxHash,
      refund_reason: refundReason,
    })
    .eq('id', id)

  if (updateError) {
    console.error('Failed to update transaction:', updateError)
    return NextResponse.json({ error: 'Failed to update transaction state' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    message: 'Escrow refunded to buyer',
    tx_hash: refundTxHash,
    reason: refundReason,
    refunded_wei: transaction.amount_wei,
  })
}
