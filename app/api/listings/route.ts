import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/listings - Browse marketplace
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const category = searchParams.get('category')
  const minPrice = searchParams.get('min_price')
  const maxPrice = searchParams.get('max_price')
  const sort = searchParams.get('sort') || 'newest'
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
  const excludeAgent = searchParams.get('exclude_agent')

  let query = supabaseAdmin
    .from('listings')
    .select(`
      id, title, description, category, price_wei, price_usdc, currency,
      is_negotiable, times_purchased, avg_rating, created_at,
      agents!inner(id, name, wallet_address, transaction_count)
    `)
    .eq('is_active', true)
    .limit(limit)

  if (category) {
    query = query.eq('category', category)
  }

  if (minPrice) {
    query = query.gte('price_wei', minPrice)
  }

  if (maxPrice) {
    query = query.lte('price_wei', maxPrice)
  }

  if (excludeAgent) {
    query = query.neq('agent_id', excludeAgent)
  }

  // Sorting
  switch (sort) {
    case 'cheapest':
      query = query.order('price_wei', { ascending: true })
      break
    case 'popular':
      query = query.order('times_purchased', { ascending: false })
      break
    case 'newest':
    default:
      query = query.order('created_at', { ascending: false })
  }

  const { data: listings, error } = await query

  if (error) {
    console.error('Failed to fetch listings:', error)
    return NextResponse.json({ error: 'Failed to fetch listings' }, { status: 500 })
  }

  return NextResponse.json({ listings })
}

// POST /api/listings - Create listing
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { agent_id, title, description, category, price_wei, price_usdc, currency, is_negotiable } = body

    if (!agent_id || !title || !description || !category || !price_wei) {
      return NextResponse.json(
        { error: 'agent_id, title, description, category, and price_wei are required' },
        { status: 400 }
      )
    }

    const validCategories = ['analysis', 'creative', 'data', 'code', 'research', 'other']
    if (!validCategories.includes(category)) {
      return NextResponse.json(
        { error: `category must be one of: ${validCategories.join(', ')}` },
        { status: 400 }
      )
    }

    // Verify agent ownership (unless system auth)
    if (auth.type === 'user') {
      const { data: agent } = await supabaseAdmin
        .from('agents')
        .select('owner_address')
        .eq('id', agent_id)
        .single()

      if (!agent || agent.owner_address !== auth.wallet.toLowerCase()) {
        return NextResponse.json({ error: 'Not authorized to create listing for this agent' }, { status: 403 })
      }
    }

    const { data: listing, error } = await supabaseAdmin
      .from('listings')
      .insert({
        agent_id,
        title,
        description,
        category,
        price_wei,
        price_usdc: price_usdc || null,
        currency: currency || 'USDC',
        is_negotiable: is_negotiable ?? true,
      })
      .select()
      .single()

    if (error) {
      console.error('Failed to create listing:', error)
      return NextResponse.json({ error: 'Failed to create listing' }, { status: 500 })
    }

    return NextResponse.json(listing)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
