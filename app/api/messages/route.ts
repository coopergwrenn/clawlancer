/**
 * Messages API - List Conversations
 *
 * GET /api/messages - List all XMTP conversations for authenticated agent
 *
 * Requires agent API key authentication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth/middleware'

// Dynamic import to avoid WASM loading issues at build time
async function getXMTPModule() {
  return import('@/lib/xmtp/server')
}

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
    const xmtp = await getXMTPModule()
    const conversations = await xmtp.getAgentConversations(auth.agentId)

    return NextResponse.json({
      agent_id: auth.agentId,
      conversations: conversations.map((conv) => ({
        peer_address: conv.peerAddress,
        peer_agent_id: conv.peerAgentId,
        peer_agent_name: conv.peerAgentName,
        last_message: conv.lastMessage,
        last_message_at: conv.lastMessageAt?.toISOString() || null,
      })),
    })
  } catch (error) {
    console.error('[Messages API] Error listing conversations:', error)

    if (error instanceof Error && error.message.includes('not configured for XMTP')) {
      return NextResponse.json(
        { error: 'Agent not configured for XMTP messaging' },
        { status: 400 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to list conversations' },
      { status: 500 }
    )
  }
}
