/**
 * Admin Dispute Resolution API
 *
 * Per PRD Section 8 (Dispute Resolution):
 * - Admin resolves dispute by calling resolveDispute(escrowId, releaseToSeller)
 * - Updates transaction state and creates reputation feedback
 * - Notifies both parties
 */

import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { oracleResolveDispute, uuidToBytes32, ESCROW_V2_ADDRESS, getEscrowV2, EscrowStateV2 } from '@/lib/blockchain/escrow-v2'
import { createReputationFeedback } from '@/lib/erc8004/reputation'
import { sendAlert } from '@/lib/monitoring/alerts'

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia'
const CHAIN = isTestnet ? baseSepolia : base

// Admin wallet addresses (from env)
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '').toLowerCase().split(',').filter(Boolean)

// POST /api/admin/disputes/[id]/resolve - Resolve a dispute
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // Check admin auth via header
  const adminWallet = request.headers.get('x-admin-wallet')?.toLowerCase()

  if (!adminWallet || !ADMIN_WALLETS.includes(adminWallet)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { release_to_seller, resolution_notes } = body

    if (typeof release_to_seller !== 'boolean') {
      return NextResponse.json({
        error: 'release_to_seller (boolean) is required'
      }, { status: 400 })
    }

    // Get transaction
    const { data: transaction, error } = await supabaseAdmin
      .from('transactions')
      .select(`
        *,
        buyer:agents!buyer_agent_id(id, name, wallet_address),
        seller:agents!seller_agent_id(id, name, wallet_address)
      `)
      .eq('id', id)
      .single()

    if (error || !transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    if (!transaction.disputed) {
      return NextResponse.json({ error: 'Transaction is not disputed' }, { status: 400 })
    }

    if (transaction.dispute_resolved_at) {
      return NextResponse.json({ error: 'Dispute already resolved' }, { status: 400 })
    }

    // Must be V2 contract for on-chain dispute resolution
    if (transaction.contract_version !== 2) {
      return NextResponse.json({
        error: 'Only V2 contract disputes can be resolved on-chain'
      }, { status: 400 })
    }

    if (!transaction.escrow_id) {
      return NextResponse.json({ error: 'No escrow_id found' }, { status: 400 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buyer = transaction.buyer as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seller = transaction.seller as any

    // Verify on-chain state is DISPUTED
    const publicClient = createPublicClient({
      chain: CHAIN,
      transport: http(process.env.ALCHEMY_BASE_URL),
    })

    try {
      const onChainEscrow = await getEscrowV2(transaction.escrow_id)

      if (onChainEscrow.state !== EscrowStateV2.DISPUTED) {
        return NextResponse.json({
          error: 'On-chain escrow is not in DISPUTED state',
          on_chain_state: EscrowStateV2[onChainEscrow.state]
        }, { status: 400 })
      }
    } catch (verifyError) {
      console.error('Failed to verify on-chain state:', verifyError)
      return NextResponse.json({
        error: 'Failed to verify on-chain escrow state'
      }, { status: 500 })
    }

    // Resolve dispute on-chain via oracle
    let resolveTxHash: string

    try {
      resolveTxHash = await oracleResolveDispute(transaction.escrow_id, release_to_seller)
    } catch (resolveError) {
      console.error('Failed to resolve dispute on-chain:', resolveError)
      await sendAlert('error', `Failed to resolve dispute on-chain: ${id}`, {
        error: resolveError instanceof Error ? resolveError.message : 'Unknown error',
        transaction_id: id,
        release_to_seller,
      })
      return NextResponse.json({
        error: 'Failed to resolve dispute on-chain',
        details: resolveError instanceof Error ? resolveError.message : 'Unknown error'
      }, { status: 500 })
    }

    // Determine final state
    const finalState = release_to_seller ? 'RELEASED' : 'REFUNDED'
    const resolution = release_to_seller ? 'SELLER_WINS' : 'BUYER_WINS'

    // Update transaction
    const { error: updateError } = await supabaseAdmin
      .from('transactions')
      .update({
        state: finalState,
        dispute_resolved_at: new Date().toISOString(),
        dispute_resolution: resolution,
        dispute_resolution_notes: resolution_notes || null,
        dispute_resolved_by: adminWallet,
        dispute_tx_hash: resolveTxHash,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (updateError) {
      console.error('Failed to update transaction:', updateError)
      return NextResponse.json({ error: 'Failed to update transaction' }, { status: 500 })
    }

    // Create reputation feedback based on outcome
    const outcome = release_to_seller ? 'disputed_release' : 'disputed_refund'
    const feedbackAgentId = release_to_seller ? seller.id : buyer.id
    const durationSeconds = Math.floor(
      (Date.now() - new Date(transaction.created_at).getTime()) / 1000
    )

    const feedback = createReputationFeedback(
      feedbackAgentId,
      id,
      transaction.escrow_id,
      transaction.amount_wei || transaction.price_wei,
      transaction.currency || 'USDC',
      outcome,
      durationSeconds,
      resolveTxHash,
      transaction.deliverable_hash
    )

    await supabaseAdmin.from('reputation_feedback').insert({
      agent_id: feedbackAgentId,
      transaction_id: id,
      rating: feedback.rating,
      context: feedback.context,
    })

    // Create feed event
    await supabaseAdmin.from('feed_events').insert({
      agent_id: release_to_seller ? seller.id : buyer.id,
      agent_name: release_to_seller ? seller.name : buyer.name,
      related_agent_id: release_to_seller ? buyer.id : seller.id,
      related_agent_name: release_to_seller ? buyer.name : seller.name,
      event_type: 'DISPUTE_RESOLVED',
      amount_wei: transaction.amount_wei || transaction.price_wei,
      currency: transaction.currency || 'USDC',
      description: `Dispute resolved: ${resolution}`,
    })

    // Send alert for audit trail
    await sendAlert('info', `Dispute resolved: ${id}`, {
      transaction_id: id,
      resolution,
      release_to_seller,
      resolved_by: adminWallet,
      tx_hash: resolveTxHash,
    })

    return NextResponse.json({
      success: true,
      message: `Dispute resolved. ${release_to_seller ? 'Funds released to seller.' : 'Funds refunded to buyer.'}`,
      resolution,
      tx_hash: resolveTxHash,
      final_state: finalState,
    })
  } catch (err) {
    console.error('Resolve error:', err)
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
