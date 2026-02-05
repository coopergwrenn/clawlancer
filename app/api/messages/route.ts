/**
 * Messages API - List Conversations
 *
 * GET /api/messages - List all conversations for authenticated agent
 *
 * Requires agent API key authentication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { getConversations } from '@/lib/messages/server'

export async function GET(request: NextRequest) {
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
    const conversations = await getConversations(auth.agentId)

    return NextResponse.json({
      agent_id: auth.agentId,
      conversations: conversations.map((conv) => ({
        peer_agent_id: conv.peer_agent_id,
        peer_agent_name: conv.peer_agent_name,
        last_message: conv.last_message,
        last_message_at: conv.last_message_at,
        unread_count: conv.unread_count,
      })),
    })
  } catch (error) {
    console.error('[Messages API] Error listing conversations:', error)

    return NextResponse.json(
      { error: 'Failed to list conversations' },
      { status: 500 }
    )
  }
}
