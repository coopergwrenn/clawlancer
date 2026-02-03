import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, encodeFunctionData } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { getOnChainEscrow, EscrowState } from '@/lib/blockchain/escrow'
import { uuidToBytes32, ESCROW_V2_ABI, ESCROW_V2_ADDRESS, getEscrowV2, EscrowStateV2 } from '@/lib/blockchain/escrow-v2'
import { agentReleaseEscrow, signAgentTransaction } from '@/lib/privy/server-wallet'
import { createReputationFeedback } from '@/lib/erc8004/reputation'

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia'
const CHAIN = isTestnet ? baseSepolia : base

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

  // V2 allows release from DELIVERED state (early release before auto-release)
  // V1 requires FUNDED state
  const validStates = transaction.contract_version === 2
    ? ['FUNDED', 'DELIVERED']
    : ['FUNDED']

  if (!validStates.includes(transaction.state)) {
    return NextResponse.json({
      error: `Transaction is not in valid state for release`,
      current_state: transaction.state,
      valid_states: validStates
    }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buyer = transaction.buyer as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seller = transaction.seller as any

  // Verify buyer ownership
  if (auth.type === 'user' && buyer.owner_address !== auth.wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Only the buyer can release' }, { status: 403 })
  } else if (auth.type === 'agent' && auth.agentId !== buyer.id) {
    return NextResponse.json({ error: 'Only the buyer can release' }, { status: 403 })
  }

  let releaseTxHash: string | null = txHash

  const publicClient = createPublicClient({
    chain: CHAIN,
    transport: http(process.env.ALCHEMY_BASE_URL)
  })

  // Handle on-chain release based on contract version
  if (transaction.contract_version === 2) {
    // V2 contract release
    const escrowIdBytes32 = transaction.escrow_id?.startsWith('0x')
      ? transaction.escrow_id as `0x${string}`
      : uuidToBytes32(transaction.escrow_id || id)

    if (txHash) {
      // External agent already released on-chain, verify
      try {
        const v2Escrow = await getEscrowV2(transaction.escrow_id || id)
        if (v2Escrow.state !== EscrowStateV2.RELEASED) {
          console.log('V2 escrow not yet RELEASED, tx may be pending')
        }
      } catch (err) {
        console.error('Failed to verify V2 on-chain release:', err)
      }
    } else if (buyer.is_hosted && buyer.privy_wallet_id) {
      // Hosted agent - release via Privy for V2
      try {
        const calldata = encodeFunctionData({
          abi: ESCROW_V2_ABI,
          functionName: 'release',
          args: [escrowIdBytes32]
        })

        const result = await signAgentTransaction(
          buyer.privy_wallet_id,
          ESCROW_V2_ADDRESS,
          calldata
        )
        releaseTxHash = result.hash

        await publicClient.waitForTransactionReceipt({ hash: releaseTxHash as `0x${string}` })
      } catch (privyError) {
        console.error('Failed to release V2 on-chain via Privy:', privyError)
        return NextResponse.json({ error: 'Failed to release on-chain escrow' }, { status: 500 })
      }
    } else {
      return NextResponse.json({
        error: 'External agents must release on-chain first and provide tx_hash',
        escrow_id: transaction.escrow_id || id,
        contract_address: ESCROW_V2_ADDRESS,
      }, { status: 400 })
    }
  } else {
    // V1 contract release (existing logic)
    if (txHash) {
      try {
        const onChainEscrow = await getOnChainEscrow(transaction.escrow_id || id)
        if (onChainEscrow.state !== EscrowState.RELEASED) {
          console.log('On-chain escrow not yet RELEASED, tx may be pending')
        }
      } catch (err) {
        console.error('Failed to verify on-chain release:', err)
      }
    } else if (buyer.is_hosted && buyer.privy_wallet_id) {
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
      return NextResponse.json({
        error: 'External agents must release on-chain first and provide tx_hash',
        escrow_id: transaction.escrow_id || id,
      }, { status: 400 })
    }
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

  // Create reputation feedback for V2 transactions
  if (transaction.contract_version === 2 && releaseTxHash) {
    const feedback = createReputationFeedback(
      seller.id,
      id,
      transaction.escrow_id || id,
      transaction.amount_wei || transaction.price_wei,
      transaction.currency || 'USDC',
      'released',
      Math.floor((Date.now() - new Date(transaction.created_at).getTime()) / 1000),
      releaseTxHash,
      transaction.deliverable_hash
    )

    await supabaseAdmin.from('reputation_feedback').insert({
      agent_id: seller.id,
      transaction_id: id,
      rating: feedback.rating,
      context: feedback.context
    }).catch((err: Error) => console.error('Failed to create reputation feedback:', err))
  }

  // Create feed event
  await supabaseAdmin.from('feed_events').insert({
    agent_id: buyer.id,
    agent_name: buyer.name || 'Buyer',
    related_agent_id: seller.id,
    related_agent_name: seller.name || 'Seller',
    event_type: 'TRANSACTION_RELEASED',
    amount_wei: amountWei.toString(),
    currency: transaction.currency || 'USDC',
    description: transaction.listing_title
  }).catch((err: Error) => console.error('Failed to create feed event:', err))

  return NextResponse.json({
    success: true,
    message: 'Escrow released to seller',
    tx_hash: releaseTxHash,
    seller_received_wei: sellerAmount.toString(),
    fee_wei: feeAmount.toString(),
  })
}
