/**
 * Transaction Review API
 *
 * POST /api/transactions/[id]/review - Submit a review for a completed transaction
 *
 * Both buyer and seller can review each other after the transaction is RELEASED.
 * Each party can only submit one review per transaction.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: transactionId } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { agent_id, rating, review_text } = body

    // Validate rating
    if (!rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
      return NextResponse.json(
        { error: 'Rating must be a number between 1 and 5' },
        { status: 400 }
      )
    }

    // Validate review text if provided
    if (review_text && (typeof review_text !== 'string' || review_text.length > 1000)) {
      return NextResponse.json(
        { error: 'Review text must be a string under 1000 characters' },
        { status: 400 }
      )
    }

    // Get the transaction
    const { data: transaction, error: txError } = await supabaseAdmin
      .from('transactions')
      .select('id, buyer_agent_id, seller_agent_id, state')
      .eq('id', transactionId)
      .single()

    if (txError || !transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    // Check transaction is completed (RELEASED)
    if (transaction.state !== 'RELEASED') {
      return NextResponse.json(
        { error: 'Can only review completed (RELEASED) transactions' },
        { status: 400 }
      )
    }

    // === REVIEW DEBUG ===
    console.log('=== REVIEW DEBUG ===')
    console.log('Auth object:', JSON.stringify(auth, null, 2))
    console.log('Request body agent_id:', agent_id, 'type:', typeof agent_id)
    console.log('Transaction object:', JSON.stringify(transaction, null, 2))
    console.log('Comparing body agent_id to buyer:', agent_id, '===', transaction.buyer_agent_id, '→', agent_id === transaction.buyer_agent_id)
    console.log('Comparing body agent_id to seller:', agent_id, '===', transaction.seller_agent_id, '→', agent_id === transaction.seller_agent_id)
    if (auth.type === 'agent') {
      console.log('Auth agentId:', auth.agentId, 'type:', typeof auth.agentId)
      console.log('Comparing auth.agentId to buyer:', auth.agentId, '===', transaction.buyer_agent_id, '→', auth.agentId === transaction.buyer_agent_id)
      console.log('Comparing auth.agentId to seller:', auth.agentId, '===', transaction.seller_agent_id, '→', auth.agentId === transaction.seller_agent_id)
    }
    console.log('===================')

    // Determine reviewer and reviewed based on agent_id
    // Keep original for DB operations, normalize for comparisons
    const originalAgentId = String(agent_id).trim()
    const reviewerAgentIdNorm = originalAgentId.toLowerCase()
    const buyerAgentIdNorm = String(transaction.buyer_agent_id).toLowerCase().trim()
    const sellerAgentIdNorm = String(transaction.seller_agent_id).toLowerCase().trim()
    let reviewedAgentId: string
    let reviewerAgentId: string  // The actual DB-compatible ID

    // Additional normalized comparison debug
    console.log('Normalized comparison:', {
      reviewerAgentIdNorm,
      buyerAgentIdNorm,
      sellerAgentIdNorm,
      buyerMatch: reviewerAgentIdNorm === buyerAgentIdNorm,
      sellerMatch: reviewerAgentIdNorm === sellerAgentIdNorm,
    })

    if (reviewerAgentIdNorm === buyerAgentIdNorm) {
      // Buyer is reviewing seller
      reviewerAgentId = transaction.buyer_agent_id
      reviewedAgentId = transaction.seller_agent_id
    } else if (reviewerAgentIdNorm === sellerAgentIdNorm) {
      // Seller is reviewing buyer
      reviewerAgentId = transaction.seller_agent_id
      reviewedAgentId = transaction.buyer_agent_id
    } else {
      console.error('Agent not party to transaction:', {
        originalAgentId,
        reviewerAgentIdNorm,
        buyerAgentIdNorm,
        sellerAgentIdNorm,
        transactionId,
      })
      return NextResponse.json(
        { error: 'Agent is not a party to this transaction' },
        { status: 403 }
      )
    }

    // Verify auth permissions
    if (auth.type === 'agent' && String(auth.agentId).toLowerCase().trim() !== reviewerAgentIdNorm) {
      return NextResponse.json(
        { error: 'Not authorized to review as this agent' },
        { status: 403 }
      )
    }

    if (auth.type === 'user') {
      // Verify user owns the reviewer agent
      const { data: agent } = await supabaseAdmin
        .from('agents')
        .select('owner_address')
        .eq('id', reviewerAgentId)
        .single()

      if (!agent || agent.owner_address !== auth.wallet.toLowerCase()) {
        return NextResponse.json(
          { error: 'Not authorized to review as this agent' },
          { status: 403 }
        )
      }
    }

    // Check if already reviewed
    const { data: existingReview } = await supabaseAdmin
      .from('reviews')
      .select('id')
      .eq('transaction_id', transactionId)
      .eq('reviewer_agent_id', reviewerAgentId)
      .single()

    if (existingReview) {
      return NextResponse.json(
        { error: 'You have already reviewed this transaction' },
        { status: 400 }
      )
    }

    // Create the review
    const { data: review, error: reviewError } = await supabaseAdmin
      .from('reviews')
      .insert({
        transaction_id: transactionId,
        reviewer_agent_id: reviewerAgentId,
        reviewed_agent_id: reviewedAgentId,
        rating,
        review_text: review_text?.trim() || null,
      })
      .select(`
        id, rating, review_text, created_at,
        reviewer:agents!reviewer_agent_id(id, name),
        reviewed:agents!reviewed_agent_id(id, name)
      `)
      .single()

    if (reviewError) {
      console.error('Failed to create review:', reviewError)
      return NextResponse.json({ error: 'Failed to create review' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      review: {
        id: review.id,
        rating: review.rating,
        review_text: review.review_text,
        created_at: review.created_at,
        reviewer: review.reviewer,
        reviewed: review.reviewed,
      },
    })
  } catch (error) {
    console.error('Review error:', error)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}

// GET /api/transactions/[id]/review - Get reviews for a transaction
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: transactionId } = await params

  const { data: reviews, error } = await supabaseAdmin
    .from('reviews')
    .select(`
      id, rating, review_text, created_at,
      reviewer:agents!reviewer_agent_id(id, name, avatar_url),
      reviewed:agents!reviewed_agent_id(id, name)
    `)
    .eq('transaction_id', transactionId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Failed to fetch reviews:', error)
    return NextResponse.json({ error: 'Failed to fetch reviews' }, { status: 500 })
  }

  return NextResponse.json({ reviews: reviews || [] })
}
