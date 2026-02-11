import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, createWalletClient, http } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { hashDeliverable, uuidToBytes32, ESCROW_V2_ABI, ESCROW_V2_ADDRESS } from '@/lib/blockchain/escrow-v2'
import { signAgentTransaction } from '@/lib/privy/server-wallet'
import { notifyDeliveryReceived, notifyHumanBuyerDelivery } from '@/lib/notifications/create'

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia'
const CHAIN = isTestnet ? baseSepolia : base

// POST /api/transactions/[id]/deliver - Seller delivers the service
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
    const { deliverable } = body

    if (!deliverable) {
      return NextResponse.json({ error: 'deliverable content is required' }, { status: 400 })
    }

    // Get transaction with agent details (buyer can be agent OR human wallet)
    const { data: transaction } = await supabaseAdmin
      .from('transactions')
      .select(`
        *,
        seller:agents!seller_agent_id(id, owner_address, name, privy_wallet_id, is_hosted, wallet_address),
        buyer:agents!buyer_agent_id(id, name),
        buyer_wallet
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
    const seller = transaction.seller as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buyer = transaction.buyer as any

    // Verify seller ownership
    if (auth.type === 'user' && seller.owner_address !== auth.wallet.toLowerCase()) {
      return NextResponse.json({ error: 'Only the seller can deliver' }, { status: 403 })
    } else if (auth.type === 'agent' && auth.agentId !== seller.id) {
      return NextResponse.json({ error: 'Only the seller can deliver' }, { status: 403 })
    }

    // Hash the deliverable content for on-chain proof
    const deliverableHash = hashDeliverable(deliverable)
    let deliverTxHash: string | null = null

    // For V2 transactions, call markDelivered on-chain
    // Exception: oracle-funded transactions skip on-chain markDelivered because
    // the oracle is both the on-chain buyer and the caller. If we mark DELIVERED
    // on-chain, the contract's dispute window prevents oracle from calling release()
    // until the window expires. By keeping on-chain state as FUNDED, the oracle can
    // release immediately when the buyer approves. Delivery proof is stored in the DB.
    if (transaction.contract_version === 2 && transaction.escrow_id && !transaction.oracle_funded) {
      const escrowIdBytes32 = transaction.escrow_id.startsWith('0x')
        ? transaction.escrow_id as `0x${string}`
        : uuidToBytes32(transaction.escrow_id)

      const publicClient = createPublicClient({
        chain: CHAIN,
        transport: http(process.env.ALCHEMY_BASE_URL)
      })

      // For hosted sellers, use Privy to sign
      if (seller.is_hosted && seller.privy_wallet_id) {
        try {
          // Build markDelivered calldata
          const { encodeFunctionData } = await import('viem')
          const calldata = encodeFunctionData({
            abi: ESCROW_V2_ABI,
            functionName: 'markDelivered',
            args: [escrowIdBytes32, deliverableHash as `0x${string}`]
          })

          const result = await signAgentTransaction(
            seller.privy_wallet_id,
            ESCROW_V2_ADDRESS,
            calldata
          )
          deliverTxHash = result.hash

          // Wait for confirmation
          await publicClient.waitForTransactionReceipt({ hash: deliverTxHash as `0x${string}` })
        } catch (privyError) {
          console.error('Failed to mark delivered via Privy:', privyError)
          return NextResponse.json({
            error: 'Failed to mark delivered on-chain',
            details: privyError instanceof Error ? privyError.message : 'Unknown error'
          }, { status: 500 })
        }
      } else {
        // For external sellers, they need to call markDelivered themselves
        // and provide the tx_hash (similar to how release works for external agents)
        // For now, use oracle wallet as fallback
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
            functionName: 'markDelivered',
            args: [escrowIdBytes32, deliverableHash as `0x${string}`]
          })
          deliverTxHash = txHash

          await publicClient.waitForTransactionReceipt({ hash: txHash })
        } catch (oracleError) {
          console.error('Failed to mark delivered via oracle:', oracleError)
          return NextResponse.json({
            error: 'Failed to mark delivered on-chain',
            details: oracleError instanceof Error ? oracleError.message : 'Unknown error'
          }, { status: 500 })
        }
      }
    }

    // Update transaction with deliverable
    const { error: updateError } = await supabaseAdmin
      .from('transactions')
      .update({
        state: 'DELIVERED',
        deliverable,
        deliverable_content: deliverable,
        deliverable_hash: deliverableHash,
        delivered_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to record delivery' }, { status: 500 })
    }

    // Note: Messaging is now handled via XMTP (decentralized)
    // The deliverable content is stored in the transaction record

    // Create feed event
    const buyerName = buyer?.name || 'A Human'
    await supabaseAdmin.from('feed_events').insert({
      type: 'delivery',
      preview: `${seller.name} delivered work to ${buyerName}`,
      agent_ids: [seller.id, buyer?.id].filter(Boolean),
      amount_wei: transaction.amount_wei,
      metadata: {
        transaction_id: transaction.id,
        currency: transaction.currency || 'USDC',
      }
    })

    // Notify buyer that work was delivered (agent OR human)
    if (buyer?.id) {
      // Agent buyer
      await notifyDeliveryReceived(
        buyer.id,
        seller.name,
        transaction.listing_title || transaction.description || 'Delivery',
        transaction.id
      ).catch(err => console.error('Failed to send notification:', err))
    } else if (transaction.buyer_wallet) {
      // Human buyer
      await notifyHumanBuyerDelivery(
        transaction.buyer_wallet,
        seller.name,
        transaction.listing_title || transaction.description || 'Delivery',
        transaction.id
      ).catch(err => console.error('Failed to send notification:', err))
    }

    return NextResponse.json({
      success: true,
      message: transaction.contract_version === 2
        ? 'Delivery recorded on-chain. Dispute window started.'
        : 'Delivery recorded. Waiting for buyer to release escrow.',
      delivered_at: new Date().toISOString(),
      deliverable_hash: deliverableHash,
      tx_hash: deliverTxHash,
      dispute_window_hours: transaction.dispute_window_hours || 24,
    })
  } catch (err) {
    console.error('Deliver error:', err)
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
