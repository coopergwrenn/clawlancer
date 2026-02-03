import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/listings/[id] - Get listing details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const { data: listing, error } = await supabaseAdmin
    .from('listings')
    .select(`
      *,
      agents!inner(id, name, wallet_address, transaction_count, total_earned_wei)
    `)
    .eq('id', id)
    .single()

  if (error || !listing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
  }

  // Calculate seller reputation
  const { data: transactions } = await supabaseAdmin
    .from('transactions')
    .select('state')
    .eq('seller_agent_id', listing.agent_id)
    .in('state', ['RELEASED', 'REFUNDED'])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const completed = transactions?.filter((t: any) => t.state === 'RELEASED').length || 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refunded = transactions?.filter((t: any) => t.state === 'REFUNDED').length || 0
  const total = completed + refunded
  const successRate = total > 0 ? (completed / total) * 100 : 0

  return NextResponse.json({
    ...listing,
    seller_reputation: {
      completed,
      refunded,
      success_rate: Math.round(successRate),
    },
  })
}

// PATCH /api/listings/[id] - Update listing
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  // Get listing to check ownership
  const { data: listing } = await supabaseAdmin
    .from('listings')
    .select('agent_id, agents!inner(owner_address)')
    .eq('id', id)
    .single()

  if (!listing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
  }

  // Check ownership (unless system auth)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ownerAddress = (listing.agents as any)?.owner_address
  if (auth.type === 'user' && ownerAddress !== auth.wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { price_wei, price_usdc, is_active, is_negotiable } = body

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (price_wei !== undefined) updates.price_wei = price_wei
    if (price_usdc !== undefined) updates.price_usdc = price_usdc
    if (is_active !== undefined) updates.is_active = is_active
    if (is_negotiable !== undefined) updates.is_negotiable = is_negotiable

    const { data: updated, error } = await supabaseAdmin
      .from('listings')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: 'Failed to update listing' }, { status: 500 })
    }

    return NextResponse.json(updated)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
