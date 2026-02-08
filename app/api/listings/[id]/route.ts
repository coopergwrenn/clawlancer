import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/listings/[id] - Get listing details with transaction status
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await verifyAuth(request)

  // Get listing with agent/poster info
  const { data: listing, error: listingError } = await supabaseAdmin
    .from('listings')
    .select(`
      id, agent_id, poster_wallet, title, description, category,
      listing_type, price_wei, price_usdc, currency,
      is_negotiable, is_active, times_purchased, avg_rating,
      created_at, updated_at,
      agent:agents(id, name, wallet_address, reputation_tier, transaction_count)
    `)
    .eq('id', id)
    .single()

  if (listingError || !listing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
  }

  // Get transaction for this listing (if any)
  const { data: transaction } = await supabaseAdmin
    .from('transactions')
    .select(`
      id, state, amount_wei, currency, created_at, deadline,
      delivered_at, completed_at, deliverable, deliverable_content,
      dispute_window_hours, contract_version,
      buyer_agent_id, buyer_wallet, seller_agent_id,
      seller:agents!seller_agent_id(id, name, wallet_address, reputation_tier),
      buyer:agents!buyer_agent_id(id, name, wallet_address)
    `)
    .eq('listing_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  // Check if user is authorized to see private details
  let isOwner = false
  let canTakeAction = false

  if (auth) {
    if (listing.agent_id && auth.type === 'agent' && listing.agent_id === auth.agentId) {
      isOwner = true
      canTakeAction = true
    } else if (listing.agent_id && auth.type === 'user') {
      // Check if user owns the agent
      const { data: agent } = await supabaseAdmin
        .from('agents')
        .select('owner_address')
        .eq('id', listing.agent_id)
        .single()
      if (agent && agent.owner_address === auth.wallet.toLowerCase()) {
        isOwner = true
        canTakeAction = true
      }
    } else if (listing.poster_wallet && auth.type === 'user' && listing.poster_wallet.toLowerCase() === auth.wallet.toLowerCase()) {
      isOwner = true
      canTakeAction = true
    }

    // Also check if user is the seller (can deliver/see details)
    if (transaction && auth.type === 'agent' && transaction.seller_agent_id === auth.agentId) {
      canTakeAction = true
    } else if (transaction && transaction.seller_agent_id && auth.type === 'user') {
      const { data: sellerAgent } = await supabaseAdmin
        .from('agents')
        .select('owner_address')
        .eq('id', transaction.seller_agent_id)
        .single()
      if (sellerAgent && sellerAgent.owner_address === auth.wallet.toLowerCase()) {
        canTakeAction = true
      }
    }
  }

  // Compute time remaining for dispute window
  let disputeWindowEndsAt: string | null = null
  let disputeWindowMinutesRemaining: number | null = null

  if (transaction && transaction.state === 'DELIVERED' && transaction.delivered_at && transaction.dispute_window_hours) {
    const deliveredAt = new Date(transaction.delivered_at)
    const windowEnd = new Date(deliveredAt.getTime() + transaction.dispute_window_hours * 60 * 60 * 1000)
    disputeWindowEndsAt = windowEnd.toISOString()
    disputeWindowMinutesRemaining = Math.max(0, Math.floor((windowEnd.getTime() - Date.now()) / 60000))
  }

  return NextResponse.json({
    listing,
    transaction: transaction || null,
    isOwner,
    canTakeAction,
    disputeWindowEndsAt,
    disputeWindowMinutesRemaining,
  })
}
