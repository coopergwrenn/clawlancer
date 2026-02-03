/**
 * Confirm Escrow Funded Endpoint
 *
 * Per PRD Section 7 (Transaction Lifecycle):
 * - Buyer posts tx_hash after funding escrow on-chain
 * - We verify on-chain: escrow exists, amounts match
 * - Transaction state: FUNDED
 */

import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, formatUnits } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { getEscrowV2, uuidToBytes32, EscrowStateV2, ESCROW_V2_ADDRESS } from '@/lib/blockchain/escrow-v2'
import { getOnChainEscrow, EscrowState } from '@/lib/blockchain/escrow'

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia'
const CHAIN = isTestnet ? baseSepolia : base

// POST /api/transactions/[id]/confirm - Confirm escrow is funded on-chain
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
    const { tx_hash, escrow_id } = body

    if (!tx_hash) {
      return NextResponse.json({ error: 'tx_hash is required' }, { status: 400 })
    }

    // Get transaction
    const { data: transaction } = await supabaseAdmin
      .from('transactions')
      .select(`
        *,
        buyer:agents!buyer_agent_id(id, owner_address, name, wallet_address),
        seller:agents!seller_agent_id(id, wallet_address)
      `)
      .eq('id', id)
      .single()

    if (!transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    if (transaction.state !== 'PENDING') {
      return NextResponse.json({
        error: 'Transaction is not in PENDING state',
        current_state: transaction.state
      }, { status: 400 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buyer = transaction.buyer as any

    // Verify buyer ownership
    if (auth.type === 'user' && buyer.owner_address !== auth.wallet.toLowerCase()) {
      return NextResponse.json({ error: 'Only the buyer can confirm' }, { status: 403 })
    } else if (auth.type === 'agent' && auth.agentId !== buyer.id) {
      return NextResponse.json({ error: 'Only the buyer can confirm' }, { status: 403 })
    }

    const publicClient = createPublicClient({
      chain: CHAIN,
      transport: http(process.env.ALCHEMY_BASE_URL)
    })

    // Wait for transaction to be mined
    try {
      await publicClient.waitForTransactionReceipt({ hash: tx_hash as `0x${string}` })
    } catch (receiptError) {
      return NextResponse.json({
        error: 'Transaction not found or not yet mined',
        tx_hash
      }, { status: 400 })
    }

    // Determine contract version and verify on-chain state
    const escrowIdToCheck = escrow_id || transaction.escrow_id || id
    let contractVersion = transaction.contract_version || 1
    let onChainAmount: string | null = null
    let deadline: string | null = null
    let disputeWindowHours: number | null = null

    // Try V2 first if escrow_id looks like a bytes32
    if (escrowIdToCheck.startsWith('0x') || process.env.ENABLE_V2_CONTRACT === 'true') {
      try {
        const escrowIdBytes32 = escrowIdToCheck.startsWith('0x')
          ? escrowIdToCheck
          : uuidToBytes32(escrowIdToCheck)

        const v2Escrow = await getEscrowV2(escrowIdToCheck)

        if (v2Escrow.state === EscrowStateV2.FUNDED) {
          contractVersion = 2
          onChainAmount = formatUnits(v2Escrow.amount, 6)
          deadline = new Date(v2Escrow.deadline * 1000).toISOString()
          disputeWindowHours = v2Escrow.disputeWindowHours
        } else if (v2Escrow.state !== EscrowStateV2.NONE) {
          return NextResponse.json({
            error: 'Escrow is not in FUNDED state',
            on_chain_state: EscrowStateV2[v2Escrow.state]
          }, { status: 400 })
        }
      } catch {
        // V2 escrow not found, try V1
      }
    }

    // Try V1 if V2 didn't work
    if (contractVersion === 1) {
      try {
        const v1Escrow = await getOnChainEscrow(escrowIdToCheck)

        if (v1Escrow.state === EscrowState.FUNDED) {
          onChainAmount = formatUnits(v1Escrow.amount, 6)
        } else {
          // V1 only has FUNDED, RELEASED, REFUNDED states
          return NextResponse.json({
            error: 'Escrow is not in FUNDED state',
            on_chain_state: EscrowState[v1Escrow.state]
          }, { status: 400 })
        }
      } catch (v1Error) {
        return NextResponse.json({
          error: 'Could not verify escrow on-chain',
          details: v1Error instanceof Error ? v1Error.message : 'Unknown error'
        }, { status: 400 })
      }
    }

    // Verify amount matches (with some tolerance for rounding)
    const expectedAmount = parseFloat(transaction.amount_usdc || formatUnits(BigInt(transaction.amount_wei || '0'), 6))
    const actualAmount = parseFloat(onChainAmount || '0')

    if (Math.abs(expectedAmount - actualAmount) > 0.01) {
      return NextResponse.json({
        error: 'Amount mismatch',
        expected: expectedAmount,
        on_chain: actualAmount
      }, { status: 400 })
    }

    // Update transaction to FUNDED
    const updateData: Record<string, unknown> = {
      state: 'FUNDED',
      escrow_id: escrowIdToCheck,
      escrow_tx_hash: tx_hash,
      contract_version: contractVersion,
      funded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (deadline) {
      updateData.deadline = deadline
    }
    if (disputeWindowHours) {
      updateData.dispute_window_hours = disputeWindowHours
    }

    const { error: updateError } = await supabaseAdmin
      .from('transactions')
      .update(updateData)
      .eq('id', id)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update transaction' }, { status: 500 })
    }

    // Create feed event
    await supabaseAdmin.from('feed_events').insert({
      agent_id: buyer.id,
      agent_name: buyer.name,
      related_agent_id: transaction.seller_agent_id,
      event_type: 'ESCROW_FUNDED',
      amount_wei: transaction.amount_wei || transaction.price_wei,
      currency: transaction.currency || 'USDC',
      description: transaction.listing_title
    })

    return NextResponse.json({
      success: true,
      message: 'Escrow confirmed and funded',
      escrow_id: escrowIdToCheck,
      contract_version: contractVersion,
      amount_usdc: onChainAmount,
      deadline,
      dispute_window_hours: disputeWindowHours,
    })
  } catch (err) {
    console.error('Confirm error:', err)
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
