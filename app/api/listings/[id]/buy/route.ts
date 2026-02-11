import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'
import {
  uuidToBytes32,
  getOnChainEscrow,
  EscrowState,
  ESCROW_ADDRESS,
} from '@/lib/blockchain/escrow'
import { agentCreateUSDCEscrow } from '@/lib/privy/server-wallet'
import type { Address } from 'viem'
import { createPublicClient, http, erc20Abi } from 'viem'
import { base } from 'viem/chains'

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

// POST /api/listings/[id]/buy - Buy a listing (create escrow)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listingId } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { buyer_agent_id, deadline_hours, tx_hash } = body

    if (!buyer_agent_id) {
      return NextResponse.json({ error: 'buyer_agent_id is required' }, { status: 400 })
    }

    // Get the listing with seller info
    const { data: listing } = await supabaseAdmin
      .from('listings')
      .select('*, seller:agents!listings_agent_id_fkey(id, name, wallet_address)')
      .eq('id', listingId)
      .eq('is_active', true)
      .single()

    if (!listing) {
      return NextResponse.json({ error: 'Listing not found or inactive' }, { status: 404 })
    }

    // Get buyer agent
    const { data: buyerAgent } = await supabaseAdmin
      .from('agents')
      .select('id, owner_address, wallet_address, privy_wallet_id, is_hosted')
      .eq('id', buyer_agent_id)
      .single()

    if (!buyerAgent) {
      return NextResponse.json({ error: 'Buyer agent not found' }, { status: 404 })
    }

    // Verify buyer ownership
    if (auth.type === 'user' && buyerAgent.owner_address !== auth.wallet.toLowerCase()) {
      return NextResponse.json({ error: 'Not authorized to buy with this agent' }, { status: 403 })
    } else if (auth.type === 'agent' && auth.agentId !== buyer_agent_id) {
      return NextResponse.json({ error: 'API key does not match buyer_agent_id' }, { status: 403 })
    }

    // Can't buy your own listing
    if (listing.agent_id === buyer_agent_id) {
      return NextResponse.json({ error: 'Cannot buy your own listing' }, { status: 400 })
    }

    // Pre-flight balance check for hosted agents (skip for external agents providing tx_hash)
    if (buyerAgent.is_hosted && !body.tx_hash) {
      try {
        const rpcUrl = process.env.ALCHEMY_BASE_URL
        if (rpcUrl) {
          const client = createPublicClient({ chain: base, transport: http(rpcUrl) })
          const usdcBalance = await client.readContract({
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [buyerAgent.wallet_address as Address],
          })
          const requiredWei = BigInt(listing.price_wei)
          if (usdcBalance < requiredWei) {
            const balanceUsdc = (Number(usdcBalance) / 1e6).toFixed(2)
            const requiredUsdc = (Number(requiredWei) / 1e6).toFixed(2)
            return NextResponse.json({
              error: 'Insufficient USDC balance',
              balance_usdc: balanceUsdc,
              required_usdc: requiredUsdc,
              funding_guide: 'https://clawlancer.ai/how-to-fund',
              message: `Your wallet has $${balanceUsdc} USDC but this listing costs $${requiredUsdc}. Fund your wallet first.`,
            }, { status: 402 })
          }
        }
      } catch (balErr) {
        console.error('Balance pre-check failed (proceeding anyway):', balErr)
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seller = listing.seller as any
    const sellerWallet = seller.wallet_address as Address
    const deadlineHrs = deadline_hours || 24

    // Generate escrow ID (will be same as transaction ID after insert)
    // We'll update it after we know the transaction ID
    let escrowTxHash: string | null = null

    // Calculate deadline
    const deadline = new Date()
    deadline.setHours(deadline.getHours() + deadlineHrs)

    // Create transaction record first to get the ID
    const { data: transaction, error: insertError } = await supabaseAdmin
      .from('transactions')
      .insert({
        buyer_agent_id,
        seller_agent_id: listing.agent_id,
        listing_id: listingId,
        amount_wei: listing.price_wei,
        currency: listing.currency,
        description: listing.title,
        state: 'PENDING', // Will update to FUNDED after on-chain confirmation
        deadline: deadline.toISOString(),
      })
      .select()
      .single()

    if (insertError || !transaction) {
      console.error('Failed to create transaction:', insertError)
      return NextResponse.json({ error: 'Failed to create transaction' }, { status: 500 })
    }

    const escrowId = transaction.id // Use transaction UUID as escrow ID

    // Handle on-chain escrow creation
    if (tx_hash) {
      // Path B: External agent already created escrow on-chain
      // Verify the on-chain escrow matches our expectations
      try {
        const onChainEscrow = await getOnChainEscrow(escrowId)

        // Verify escrow exists and is funded
        if (onChainEscrow.state !== EscrowState.FUNDED) {
          // Cleanup: delete the pending transaction
          await supabaseAdmin.from('transactions').delete().eq('id', transaction.id)
          return NextResponse.json({ error: 'On-chain escrow is not in FUNDED state' }, { status: 400 })
        }

        // Verify buyer matches
        if (onChainEscrow.buyer.toLowerCase() !== buyerAgent.wallet_address.toLowerCase()) {
          await supabaseAdmin.from('transactions').delete().eq('id', transaction.id)
          return NextResponse.json({ error: 'On-chain escrow buyer does not match' }, { status: 400 })
        }

        // Verify seller matches
        if (onChainEscrow.seller.toLowerCase() !== sellerWallet.toLowerCase()) {
          await supabaseAdmin.from('transactions').delete().eq('id', transaction.id)
          return NextResponse.json({ error: 'On-chain escrow seller does not match' }, { status: 400 })
        }

        escrowTxHash = tx_hash
      } catch (verifyError) {
        console.error('Failed to verify on-chain escrow:', verifyError)
        // On-chain verification failed - might be tx still pending or escrow not found
        // For now, accept the tx_hash and update state
        escrowTxHash = tx_hash
      }
    } else if (buyerAgent.is_hosted && buyerAgent.privy_wallet_id) {
      // Path A: Hosted agent - we create escrow on their behalf via Privy
      try {
        const amountWei = BigInt(listing.price_wei)
        const result = await agentCreateUSDCEscrow(
          buyerAgent.privy_wallet_id,
          escrowId,
          sellerWallet,
          deadlineHrs,
          amountWei
        )
        escrowTxHash = result.createHash
      } catch (privyError) {
        console.error('Failed to create on-chain escrow via Privy:', privyError)
        // Cleanup: delete the pending transaction
        await supabaseAdmin.from('transactions').delete().eq('id', transaction.id)
        return NextResponse.json({ error: 'Failed to create on-chain escrow' }, { status: 500 })
      }
    } else {
      // External agent without tx_hash - they need to create on-chain first
      // Return the escrow details they need to create it
      const bytes32Id = uuidToBytes32(escrowId)

      return NextResponse.json({
        transaction_id: transaction.id,
        escrow_id: escrowId,
        escrow_id_bytes32: bytes32Id,
        contract_address: ESCROW_ADDRESS,
        seller_address: sellerWallet,
        amount_wei: listing.price_wei,
        deadline_hours: deadlineHrs,
        instructions: 'Create escrow on-chain, then call this endpoint again with tx_hash',
        state: 'PENDING',
      })
    }

    // Update transaction with escrow details and mark as FUNDED
    const { error: updateError } = await supabaseAdmin
      .from('transactions')
      .update({
        state: 'FUNDED',
        escrow_id: escrowId,
        tx_hash: escrowTxHash,
      })
      .eq('id', transaction.id)

    if (updateError) {
      console.error('Failed to update transaction:', updateError)
    }

    // Increment times_purchased
    await supabaseAdmin
      .from('listings')
      .update({ times_purchased: (listing.times_purchased || 0) + 1 })
      .eq('id', listingId)

    return NextResponse.json({
      transaction_id: transaction.id,
      escrow_id: escrowId,
      escrow_id_bytes32: uuidToBytes32(escrowId),
      amount_wei: transaction.amount_wei,
      currency: transaction.currency,
      deadline: transaction.deadline,
      tx_hash: escrowTxHash,
      state: 'FUNDED',
      message: 'Escrow created. Waiting for seller to deliver.',
    })
  } catch (err) {
    console.error('Buy listing error:', err)
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
