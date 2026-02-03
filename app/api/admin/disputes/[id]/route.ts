/**
 * Admin Dispute Detail API
 *
 * Per PRD Section 8 (Dispute Resolution):
 * - Admin can view full dispute details
 * - Includes transaction history, messages, deliverable
 */

import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// Admin wallet addresses (from env)
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '').toLowerCase().split(',').filter(Boolean)

// GET /api/admin/disputes/[id] - Get dispute details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // Check admin auth via header
  const adminWallet = request.headers.get('x-admin-wallet')?.toLowerCase()

  if (!adminWallet || !ADMIN_WALLETS.includes(adminWallet)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Get full transaction details
  const { data: transaction, error } = await supabaseAdmin
    .from('transactions')
    .select(`
      *,
      buyer:agents!buyer_agent_id(
        id,
        name,
        wallet_address,
        reputation_score,
        reputation_tier,
        reputation_transactions,
        total_earned_wei,
        total_spent_wei,
        created_at
      ),
      seller:agents!seller_agent_id(
        id,
        name,
        wallet_address,
        reputation_score,
        reputation_tier,
        reputation_transactions,
        total_earned_wei,
        total_spent_wei,
        created_at
      )
    `)
    .eq('id', id)
    .single()

  if (error || !transaction) {
    return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
  }

  if (!transaction.disputed) {
    return NextResponse.json({ error: 'Transaction is not disputed' }, { status: 400 })
  }

  // Get messages between buyer and seller
  const { data: messages } = await supabaseAdmin
    .from('messages')
    .select('*')
    .or(`and(from_agent_id.eq.${transaction.buyer_agent_id},to_agent_id.eq.${transaction.seller_agent_id}),and(from_agent_id.eq.${transaction.seller_agent_id},to_agent_id.eq.${transaction.buyer_agent_id})`)
    .order('created_at', { ascending: true })
    .limit(100)

  // Get listing details if available
  let listing = null
  if (transaction.listing_id) {
    const { data: listingData } = await supabaseAdmin
      .from('listings')
      .select('*')
      .eq('id', transaction.listing_id)
      .single()
    listing = listingData
  }

  // Get reputation feedback for both parties
  const { data: buyerFeedback } = await supabaseAdmin
    .from('reputation_feedback')
    .select('*')
    .eq('agent_id', transaction.buyer_agent_id)
    .order('created_at', { ascending: false })
    .limit(10)

  const { data: sellerFeedback } = await supabaseAdmin
    .from('reputation_feedback')
    .select('*')
    .eq('agent_id', transaction.seller_agent_id)
    .order('created_at', { ascending: false })
    .limit(10)

  return NextResponse.json({
    transaction,
    messages: messages || [],
    listing,
    buyerHistory: {
      recentFeedback: buyerFeedback || [],
    },
    sellerHistory: {
      recentFeedback: sellerFeedback || [],
    },
  })
}
