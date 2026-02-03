/**
 * Dispute Endpoint
 *
 * Per PRD Section 8 (Dispute Resolution):
 * - Buyer calls dispute() on V2 contract (ON-CHAIN)
 * - Reason stored locally
 * - Admin notified via Slack
 * - State: DISPUTED
 */

import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { uuidToBytes32, ESCROW_V2_ABI, ESCROW_V2_ADDRESS } from '@/lib/blockchain/escrow-v2'
import { signAgentTransaction } from '@/lib/privy/server-wallet'
import { sendAlert } from '@/lib/monitoring/alerts'

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia'
const CHAIN = isTestnet ? baseSepolia : base

// POST /api/transactions/[id]/dispute - Buyer disputes the transaction
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { reason } = body

    if (!reason || reason.trim().length < 10) {
      return NextResponse.json({
        error: 'Dispute reason is required (minimum 10 characters)'
      }, { status: 400 })
    }

    // Get transaction with agent details
    const { data: transaction } = await supabaseAdmin
      .from('transactions')
      .select(`
        *,
        buyer:agents!buyer_agent_id(id, owner_address, name, privy_wallet_id, is_hosted, wallet_address),
        seller:agents!seller_agent_id(id, name, wallet_address)
      `)
      .eq('id', id)
      .single()

    if (!transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    // Can only dispute DELIVERED transactions
    if (transaction.state !== 'DELIVERED') {
      return NextResponse.json({
        error: 'Can only dispute delivered transactions',
        current_state: transaction.state
      }, { status: 400 })
    }

    // Check if already disputed
    if (transaction.disputed) {
      return NextResponse.json({ error: 'Transaction already disputed' }, { status: 400 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buyer = transaction.buyer as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seller = transaction.seller as any

    // Verify buyer ownership
    if (auth.type === 'user' && buyer.owner_address !== auth.wallet.toLowerCase()) {
      return NextResponse.json({ error: 'Only the buyer can dispute' }, { status: 403 })
    } else if (auth.type === 'agent' && auth.agentId !== buyer.id) {
      return NextResponse.json({ error: 'Only the buyer can dispute' }, { status: 403 })
    }

    // Check dispute window (only for V2)
    if (transaction.contract_version === 2 && transaction.delivered_at) {
      const deliveredAt = new Date(transaction.delivered_at)
      const windowHours = transaction.dispute_window_hours || 24
      const windowEnd = new Date(deliveredAt.getTime() + windowHours * 60 * 60 * 1000)

      if (new Date() > windowEnd) {
        return NextResponse.json({
          error: 'Dispute window has closed',
          delivered_at: transaction.delivered_at,
          window_hours: windowHours,
          window_ended_at: windowEnd.toISOString()
        }, { status: 400 })
      }
    }

    let disputeTxHash: string | null = null

    // For V2 transactions, call dispute() on-chain
    if (transaction.contract_version === 2 && transaction.escrow_id) {
      const escrowIdBytes32 = transaction.escrow_id.startsWith('0x')
        ? transaction.escrow_id as `0x${string}`
        : uuidToBytes32(transaction.escrow_id)

      const publicClient = createPublicClient({
        chain: CHAIN,
        transport: http(process.env.ALCHEMY_BASE_URL)
      })

      // For hosted buyers, use Privy to sign
      if (buyer.is_hosted && buyer.privy_wallet_id) {
        try {
          const calldata = encodeFunctionData({
            abi: ESCROW_V2_ABI,
            functionName: 'dispute',
            args: [escrowIdBytes32]
          })

          const result = await signAgentTransaction(
            buyer.privy_wallet_id,
            ESCROW_V2_ADDRESS,
            calldata
          )
          disputeTxHash = result.hash

          await publicClient.waitForTransactionReceipt({ hash: disputeTxHash as `0x${string}` })
        } catch (privyError) {
          console.error('Failed to dispute via Privy:', privyError)
          return NextResponse.json({
            error: 'Failed to dispute on-chain',
            details: privyError instanceof Error ? privyError.message : 'Unknown error'
          }, { status: 500 })
        }
      } else {
        // For external buyers, use oracle wallet
        try {
          const account = privateKeyToAccount(process.env.ORACLE_PRIVATE_KEY as `0x${string}`)
          const walletClient = createWalletClient({
            account,
            chain: CHAIN,
            transport: http(process.env.ALCHEMY_BASE_URL)
          })

          const txHash = await walletClient.writeContract({
            address: ESCROW_V2_ADDRESS,
            abi: ESCROW_V2_ABI,
            functionName: 'dispute',
            args: [escrowIdBytes32]
          })
          disputeTxHash = txHash

          await publicClient.waitForTransactionReceipt({ hash: txHash })
        } catch (oracleError) {
          console.error('Failed to dispute via oracle:', oracleError)
          return NextResponse.json({
            error: 'Failed to dispute on-chain',
            details: oracleError instanceof Error ? oracleError.message : 'Unknown error'
          }, { status: 500 })
        }
      }
    }

    // Update transaction state
    const { error: updateError } = await supabaseAdmin
      .from('transactions')
      .update({
        state: 'DISPUTED',
        disputed: true,
        disputed_at: new Date().toISOString(),
        dispute_reason: reason,
        dispute_tx_hash: disputeTxHash,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to record dispute' }, { status: 500 })
    }

    // Create feed event
    await supabaseAdmin.from('feed_events').insert({
      agent_id: buyer.id,
      agent_name: buyer.name,
      related_agent_id: seller.id,
      related_agent_name: seller.name,
      event_type: 'TRANSACTION_DISPUTED',
      amount_wei: transaction.amount_wei || transaction.price_wei,
      currency: transaction.currency || 'USDC',
      description: `Dispute: ${reason.slice(0, 100)}`
    })

    // Notify admin via Slack
    await sendAlert('warning', `New dispute filed: ${transaction.listing_title}`, {
      transaction_id: id,
      amount: transaction.amount_wei || transaction.price_wei,
      buyer: buyer.name,
      seller: seller.name,
      reason: reason.slice(0, 200),
      admin_url: `${process.env.NEXT_PUBLIC_APP_URL}/admin/disputes/${id}`
    })

    return NextResponse.json({
      success: true,
      message: 'Dispute filed successfully. Admin will review within 48 hours.',
      disputed_at: new Date().toISOString(),
      tx_hash: disputeTxHash,
    })
  } catch (err) {
    console.error('Dispute error:', err)
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
