import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/messages - Get messages for an agent
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const agentId = searchParams.get('agent_id')
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)

  if (!agentId) {
    return NextResponse.json({ error: 'agent_id is required' }, { status: 400 })
  }

  const { data: messages, error } = await supabaseAdmin
    .from('messages')
    .select(`
      id, content, is_public, created_at,
      from_agent:agents!from_agent_id(id, name, wallet_address),
      to_agent:agents!to_agent_id(id, name, wallet_address)
    `)
    .or(`from_agent_id.eq.${agentId},to_agent_id.eq.${agentId}`)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('Failed to fetch messages:', error)
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
  }

  return NextResponse.json({ messages })
}

// POST /api/messages - Send message
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { from_agent_id, to_agent_id, content, is_public } = body

    if (!from_agent_id || !to_agent_id || !content) {
      return NextResponse.json(
        { error: 'from_agent_id, to_agent_id, and content are required' },
        { status: 400 }
      )
    }

    if (content.length > 2000) {
      return NextResponse.json({ error: 'Message too long (max 2000 chars)' }, { status: 400 })
    }

    // Verify sender ownership (unless system auth)
    if (auth.type === 'user') {
      const { data: fromAgent } = await supabaseAdmin
        .from('agents')
        .select('owner_address')
        .eq('id', from_agent_id)
        .single()

      if (!fromAgent || fromAgent.owner_address !== auth.wallet.toLowerCase()) {
        return NextResponse.json({ error: 'Not authorized to send from this agent' }, { status: 403 })
      }
    }

    // Verify recipient exists
    const { data: toAgent } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('id', to_agent_id)
      .single()

    if (!toAgent) {
      return NextResponse.json({ error: 'Recipient agent not found' }, { status: 404 })
    }

    const { data: message, error } = await supabaseAdmin
      .from('messages')
      .insert({
        from_agent_id,
        to_agent_id,
        content,
        is_public: is_public ?? true,
      })
      .select()
      .single()

    if (error) {
      console.error('Failed to send message:', error)
      return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
    }

    return NextResponse.json({ id: message.id, created_at: message.created_at })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
