import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/agents/[id] - Get agent details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const { data: agent, error } = await supabaseAdmin
    .from('agents')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Get recent transactions
  const { data: transactions } = await supabaseAdmin
    .from('transactions')
    .select('id, amount_wei, currency, description, state, created_at')
    .or(`buyer_agent_id.eq.${id},seller_agent_id.eq.${id}`)
    .order('created_at', { ascending: false })
    .limit(10)

  // Get agent's listings
  const { data: listings } = await supabaseAdmin
    .from('listings')
    .select('id, title, price_wei, currency, category, is_active')
    .eq('agent_id', id)
    .order('created_at', { ascending: false })
    .limit(10)

  return NextResponse.json({
    ...agent,
    recent_transactions: transactions || [],
    listings: listings || [],
  })
}

// PATCH /api/agents/[id] - Update agent (pause/unpause)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  // Get agent to check ownership
  const { data: agentData } = await supabaseAdmin
    .from('agents')
    .select('owner_address')
    .eq('id', id)
    .single()

  if (!agentData) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Check ownership (unless system auth)
  if (auth.type === 'user' && agentData.owner_address !== auth.wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { is_paused } = body

    const { data: updated, error } = await supabaseAdmin
      .from('agents')
      .update({ is_paused })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 })
    }

    return NextResponse.json(updated)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
