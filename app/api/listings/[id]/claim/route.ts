/**
 * Bounty Claim API
 * POST /api/listings/[id]/claim
 *
 * Allows any agent to claim a bounty listing.
 * Creates an escrow transaction with the listing owner as buyer
 * and the claiming agent as seller.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: listingId } = await params

    // Verify auth
    const auth = await verifyAuth(request)
    if (!auth) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json()
    const { agent_id } = body

    if (!agent_id) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 })
    }

    // Verify agent ownership
    if (auth.type === 'agent' && auth.agentId !== agent_id) {
      return NextResponse.json({ error: 'API key does not match agent_id' }, { status: 403 })
    }

    // Get the listing
    const { data: listing, error: listingError } = await supabaseAdmin
      .from('listings')
      .select(`
        id, agent_id, title, description, category, listing_type,
        price_wei, currency, is_active
      `)
      .eq('id', listingId)
      .single()

    if (listingError || !listing) {
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
    }

    // Verify it's a bounty
    if (listing.listing_type !== 'BOUNTY') {
      return NextResponse.json({ error: 'This listing is not a bounty' }, { status: 400 })
    }

    // Verify it's active
    if (!listing.is_active) {
      return NextResponse.json({ error: 'This bounty is no longer available' }, { status: 400 })
    }

    // Can't claim your own bounty
    if (listing.agent_id === agent_id) {
      return NextResponse.json({ error: 'Cannot claim your own bounty' }, { status: 400 })
    }

    // Get the claiming agent
    const { data: claimingAgent, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('id, wallet_address, is_active')
      .eq('id', agent_id)
      .single()

    if (agentError || !claimingAgent) {
      return NextResponse.json({ error: 'Claiming agent not found' }, { status: 404 })
    }

    if (!claimingAgent.is_active) {
      return NextResponse.json({ error: 'Claiming agent is not active' }, { status: 400 })
    }

    // Create the transaction (bounty owner = buyer, claimer = seller)
    // For bounties, the deadline is short (1 hour for auto-release after delivery)
    const deadline = new Date()
    deadline.setHours(deadline.getHours() + 24) // 24 hour deadline to deliver

    const { data: transaction, error: txError } = await supabaseAdmin
      .from('transactions')
      .insert({
        listing_id: listing.id,
        buyer_agent_id: listing.agent_id, // Bounty poster is the buyer
        seller_agent_id: agent_id, // Claimer becomes the seller
        amount_wei: listing.price_wei,
        currency: listing.currency,
        state: 'FUNDED', // Bounties are pre-funded by the poster
        deadline: deadline.toISOString(),
        dispute_window_hours: 1, // 1 hour dispute window for bounties (auto-release)
        description: `Bounty: ${listing.title}`,
      })
      .select()
      .single()

    if (txError) {
      console.error('Failed to create transaction:', txError)
      return NextResponse.json({ error: 'Failed to claim bounty' }, { status: 500 })
    }

    // Deactivate the bounty so it can't be claimed again
    await supabaseAdmin
      .from('listings')
      .update({ is_active: false })
      .eq('id', listingId)

    // Create feed event
    await supabaseAdmin.from('feed_events').insert({
      type: 'bounty_claimed',
      preview: `${listing.title} claimed`,
      agent_ids: [agent_id, listing.agent_id],
      amount_wei: listing.price_wei,
      metadata: {
        listing_title: listing.title,
        transaction_id: transaction.id,
        listing_id: listing.id,
      },
    })

    return NextResponse.json({
      success: true,
      transaction_id: transaction.id,
      message: 'Bounty claimed successfully. Deliver your work to complete the transaction.',
      deadline: deadline.toISOString(),
    })
  } catch (error) {
    console.error('Bounty claim error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
