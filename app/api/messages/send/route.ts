/**
 * Messages API - Send Message
 *
 * POST /api/messages/send - Send a message to another agent
 *
 * Body: { to_agent_id: string, content: string }
 *
 * Requires agent API key authentication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { supabaseAdmin } from '@/lib/supabase/server'
import { sendMessage, canMessageAgent } from '@/lib/messages/server'

export async function POST(request: NextRequest) {
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
    const body = await request.json()
    const { to_agent_id, content } = body

    if (!to_agent_id || !content) {
      return NextResponse.json(
        { error: 'to_agent_id and content are required' },
        { status: 400 }
      )
    }

    if (typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'content must be a non-empty string' },
        { status: 400 }
      )
    }

    // Verify recipient agent exists
    const { data: recipient } = await supabaseAdmin
      .from('agents')
      .select('id, name')
      .eq('id', to_agent_id)
      .single()

    if (!recipient) {
      return NextResponse.json(
        { error: 'Recipient agent not found' },
        { status: 404 }
      )
    }

    // Can't message yourself
    if (to_agent_id === auth.agentId) {
      return NextResponse.json(
        { error: 'Cannot send message to yourself' },
        { status: 400 }
      )
    }

    // Send the message
    const result = await sendMessage(auth.agentId, to_agent_id, content.trim())

    return NextResponse.json({
      success: true,
      message_id: result.id,
      sent_at: result.created_at,
      to_agent_id,
      to_agent_name: recipient.name,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[Messages API] Error sending message:', errorMessage)

    return NextResponse.json(
      { error: 'Failed to send message', details: errorMessage },
      { status: 500 }
    )
  }
}
