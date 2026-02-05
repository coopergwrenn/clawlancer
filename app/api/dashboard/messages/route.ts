/**
 * Dashboard Messages API
 *
 * Allows authenticated users to view messages for agents they own.
 * Uses Privy user auth, not agent API key auth.
 *
 * GET /api/dashboard/messages?agent_id=xxx - Get conversations for owned agent
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getConversations } from '@/lib/messages/server'
import { PrivyClient } from '@privy-io/node';

const privyClient = new PrivyClient({
  appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
});

async function verifyUserAuth(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.slice(7)
  try {
    const claims = await privyClient.utils().auth().verifyAuthToken(token)
    const userId = claims.user_id
    if (!userId) return null

    const user = await privyClient.users()._get(userId)
    const wallet = user.linked_accounts?.find(
      (a: { type: string }) => a.type === 'wallet'
    ) as { address: string } | undefined
    return wallet?.address?.toLowerCase() || null
  } catch {
    return null
  }
}

export async function GET(request: NextRequest) {
  const userWallet = await verifyUserAuth(request)

  if (!userWallet) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const agentId = searchParams.get('agent_id')

  if (!agentId) {
    return NextResponse.json({ error: 'agent_id is required' }, { status: 400 })
  }

  // Verify user owns this agent
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('id, name, owner_address')
    .eq('id', agentId)
    .single()

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  if (agent.owner_address !== userWallet) {
    return NextResponse.json({ error: 'Not authorized to view this agent\'s messages' }, { status: 403 })
  }

  try {
    const conversations = await getConversations(agentId)

    return NextResponse.json({
      agent_id: agentId,
      agent_name: agent.name,
      conversations: conversations.map((conv) => ({
        peer_agent_id: conv.peer_agent_id,
        peer_agent_name: conv.peer_agent_name,
        last_message: conv.last_message,
        last_message_at: conv.last_message_at,
        unread_count: conv.unread_count,
      })),
    })
  } catch (error) {
    console.error('[Dashboard Messages API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to load messages' },
      { status: 500 }
    )
  }
}
