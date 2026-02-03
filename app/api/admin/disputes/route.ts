/**
 * Admin Disputes API
 *
 * Per PRD Section 8 (Dispute Resolution):
 * - Admin can view all disputed transactions
 * - Filter by status (pending, resolved)
 */

import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// Admin wallet addresses (from env)
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '').toLowerCase().split(',').filter(Boolean)

// GET /api/admin/disputes - List all disputed transactions
export async function GET(request: NextRequest) {
  // Check admin auth via header
  const adminWallet = request.headers.get('x-admin-wallet')?.toLowerCase()

  if (!adminWallet || !ADMIN_WALLETS.includes(adminWallet)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') // 'pending', 'resolved', or null for all
  const limit = parseInt(searchParams.get('limit') || '50')
  const offset = parseInt(searchParams.get('offset') || '0')

  let query = supabaseAdmin
    .from('transactions')
    .select(`
      id,
      state,
      disputed,
      disputed_at,
      dispute_reason,
      dispute_resolved_at,
      dispute_resolution,
      dispute_tx_hash,
      amount_wei,
      price_wei,
      currency,
      listing_title,
      escrow_id,
      contract_version,
      deliverable,
      deliverable_hash,
      delivered_at,
      created_at,
      buyer:agents!buyer_agent_id(id, name, wallet_address, reputation_tier),
      seller:agents!seller_agent_id(id, name, wallet_address, reputation_tier)
    `)
    .eq('disputed', true)
    .order('disputed_at', { ascending: false })
    .range(offset, offset + limit - 1)

  // Filter by resolution status
  if (status === 'pending') {
    query = query.is('dispute_resolved_at', null)
  } else if (status === 'resolved') {
    query = query.not('dispute_resolved_at', 'is', null)
  }

  const { data: disputes, error, count } = await query

  if (error) {
    console.error('Failed to fetch disputes:', error)
    return NextResponse.json({ error: 'Failed to fetch disputes' }, { status: 500 })
  }

  // Get counts for summary
  const { count: pendingCount } = await supabaseAdmin
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('disputed', true)
    .is('dispute_resolved_at', null)

  const { count: resolvedCount } = await supabaseAdmin
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('disputed', true)
    .not('dispute_resolved_at', 'is', null)

  return NextResponse.json({
    disputes: disputes || [],
    pagination: {
      total: (pendingCount || 0) + (resolvedCount || 0),
      pending: pendingCount || 0,
      resolved: resolvedCount || 0,
      limit,
      offset,
    },
  })
}
