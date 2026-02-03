import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/transactions - List transactions
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const agentId = searchParams.get('agent_id')
  const state = searchParams.get('state')
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)

  let query = supabaseAdmin
    .from('transactions')
    .select(`
      id, amount_wei, currency, description, state, deadline,
      created_at, completed_at, delivered_at,
      buyer:agents!buyer_agent_id(id, name, wallet_address),
      seller:agents!seller_agent_id(id, name, wallet_address)
    `)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (agentId) {
    query = query.or(`buyer_agent_id.eq.${agentId},seller_agent_id.eq.${agentId}`)
  }

  if (state) {
    query = query.eq('state', state)
  }

  const { data: transactions, error } = await query

  if (error) {
    console.error('Failed to fetch transactions:', error)
    return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 })
  }

  return NextResponse.json({ transactions })
}

// POST /api/transactions - Create escrow directly (without listing)
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { buyer_agent_id, seller_agent_id, amount_wei, currency, description, deadline_hours } = body

    if (!buyer_agent_id || !seller_agent_id || !amount_wei) {
      return NextResponse.json(
        { error: 'buyer_agent_id, seller_agent_id, and amount_wei are required' },
        { status: 400 }
      )
    }

    if (buyer_agent_id === seller_agent_id) {
      return NextResponse.json({ error: 'Buyer and seller cannot be the same' }, { status: 400 })
    }

    // Verify buyer agent exists and check ownership
    const { data: buyerAgent } = await supabaseAdmin
      .from('agents')
      .select('id, owner_address')
      .eq('id', buyer_agent_id)
      .single()

    if (!buyerAgent) {
      return NextResponse.json({ error: 'Buyer agent not found' }, { status: 404 })
    }

    if (auth.type === 'user' && buyerAgent.owner_address !== auth.wallet.toLowerCase()) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    // Verify seller agent exists
    const { data: sellerAgent } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('id', seller_agent_id)
      .single()

    if (!sellerAgent) {
      return NextResponse.json({ error: 'Seller agent not found' }, { status: 404 })
    }

    // Calculate deadline
    const deadline = new Date()
    deadline.setHours(deadline.getHours() + (deadline_hours || 24))

    // Create transaction
    const { data: transaction, error } = await supabaseAdmin
      .from('transactions')
      .insert({
        buyer_agent_id,
        seller_agent_id,
        amount_wei,
        currency: currency || 'USDC',
        description: description || null,
        state: 'FUNDED',
        deadline: deadline.toISOString(),
      })
      .select()
      .single()

    if (error) {
      console.error('Failed to create transaction:', error)
      return NextResponse.json({ error: 'Failed to create transaction' }, { status: 500 })
    }

    return NextResponse.json({
      id: transaction.id,
      escrow_id: transaction.escrow_id,
      amount_wei: transaction.amount_wei,
      currency: transaction.currency,
      deadline: transaction.deadline,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
