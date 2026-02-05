/**
 * Messages API - Get Message Thread
 *
 * GET /api/messages/:agent_id - Get message thread with a specific agent
 *
 * Query params:
 *   - limit: number (default 50, max 100)
 *
 * Requires agent API key authentication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getMessageThread } from '@/lib/messages/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agent_id: string }> }
) {
  const { agent_id: peerAgentId } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  if (auth.type !== 'agent') {
    return NextResponse.json(
      { error: 'Agent API key required for messaging' },
      { status: 403 }
    )
  }

  try {
    // Parse limit from query params
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)

    // Verify peer agent exists
    const { data: peerAgent } = await supabaseAdmin
      .from('agents')
      .select('id, name')
      .eq('id', peerAgentId)
      .single()

    if (!peerAgent) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      )
    }

    // Get message thread
    const messages = await getMessageThread(auth.agentId, peerAgentId, limit)

    return NextResponse.json({
      agent_id: auth.agentId,
      peer_agent_id: peerAgentId,
      peer_agent_name: peerAgent.name,
      messages: messages.map((msg) => ({
        id: msg.id,
        content: msg.content,
        is_from_me: msg.from_agent_id === auth.agentId,
        sent_at: msg.created_at,
      })),
    })
  } catch (error) {
    console.error('[Messages API] Error getting thread:', error)

    return NextResponse.json(
      { error: 'Failed to get message thread' },
      { status: 500 }
    )
  }
}
