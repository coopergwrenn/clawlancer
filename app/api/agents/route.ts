import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth, requireUserAuth } from '@/lib/auth/middleware'
import { createAgentWallet } from '@/lib/privy/server-wallet'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/agents - List agents (public) or user's agents (authenticated)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const owner = searchParams.get('owner')
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)

  let query = supabaseAdmin
    .from('agents')
    .select('id, name, wallet_address, personality, is_hosted, transaction_count, total_earned_wei, created_at')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (owner) {
    query = query.eq('owner_address', owner.toLowerCase())
  }

  const { data: agents, error } = await query

  if (error) {
    console.error('Failed to fetch agents:', error)
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 })
  }

  return NextResponse.json({ agents })
}

// POST /api/agents - Create hosted agent (Path A) - requires auth
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)

  if (!requireUserAuth(auth)) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { name, personality } = body

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const validPersonalities = ['hustler', 'cautious', 'degen', 'random']
    if (personality && !validPersonalities.includes(personality)) {
      return NextResponse.json(
        { error: `personality must be one of: ${validPersonalities.join(', ')}` },
        { status: 400 }
      )
    }

    // Check rate limit: max 3 agents per user (known issue #16)
    const { count } = await supabaseAdmin
      .from('agents')
      .select('*', { count: 'exact', head: true })
      .eq('owner_address', auth.wallet.toLowerCase())
      .eq('is_active', true)

    if (count && count >= 3) {
      return NextResponse.json(
        { error: 'Maximum 3 agents per account' },
        { status: 429 }
      )
    }

    // Create Privy server wallet for hosted agent
    let walletAddress: string
    let privyWalletId: string | null = null

    try {
      const wallet = await createAgentWallet()
      walletAddress = wallet.address
      privyWalletId = wallet.walletId
    } catch (walletError) {
      console.error('Failed to create Privy wallet:', walletError)
      // Fallback to placeholder for development/testing
      walletAddress = `0x${Math.random().toString(16).slice(2, 42).padEnd(40, '0')}`
    }

    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        name,
        wallet_address: walletAddress,
        owner_address: auth.wallet.toLowerCase(),
        is_hosted: true,
        personality: personality || 'random',
        privy_wallet_id: privyWalletId,
      })
      .select()
      .single()

    if (error) {
      console.error('Failed to create agent:', error)
      return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 })
    }

    // Trigger immediate first heartbeat (Known Issue #13)
    // Fire-and-forget — don't wait for it
    if (process.env.NEXT_PUBLIC_APP_URL) {
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/cron/agent-heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({ agent_id: agent.id, immediate: true }),
      }).catch((err) => console.error('Failed to trigger immediate heartbeat:', err))
    }

    return NextResponse.json({
      id: agent.id,
      name: agent.name,
      wallet_address: agent.wallet_address,
      personality: agent.personality,
      privy_wallet_id: privyWalletId ? '[created]' : null,
      created_at: agent.created_at,
    })
  } catch (error) {
    console.error('Create agent error:', error)
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
