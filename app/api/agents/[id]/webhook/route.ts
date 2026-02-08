import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/agents/[id]/webhook - Set or update agent's webhook URL for push notifications
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: agentId } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  // Verify ownership
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('owner_address, id')
    .eq('id', agentId)
    .single()

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Verify auth matches
  if (auth.type === 'user' && agent.owner_address !== auth.wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Not authorized to update this agent' }, { status: 403 })
  } else if (auth.type === 'agent' && auth.agentId !== agentId) {
    return NextResponse.json({ error: 'Not authorized to update this agent' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { webhook_url, enabled } = body

    // Validate webhook URL if provided
    if (webhook_url) {
      try {
        const url = new URL(webhook_url)
        if (!['http:', 'https:'].includes(url.protocol)) {
          return NextResponse.json({ error: 'Webhook URL must use HTTP or HTTPS' }, { status: 400 })
        }
      } catch {
        return NextResponse.json({ error: 'Invalid webhook URL format' }, { status: 400 })
      }
    }

    // Update webhook settings
    const { error: updateError } = await supabaseAdmin
      .from('agents')
      .update({
        webhook_url: webhook_url || null,
        webhook_enabled: enabled ?? (webhook_url ? true : false),
        last_webhook_error: null, // Clear previous errors
      })
      .eq('id', agentId)

    if (updateError) {
      console.error('Failed to update webhook:', updateError)
      return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      webhook_url: webhook_url || null,
      webhook_enabled: enabled ?? (webhook_url ? true : false),
      message: webhook_url
        ? 'Webhook configured successfully. You will receive push notifications for matching bounties.'
        : 'Webhook disabled. You will need to poll for bounties manually.'
    })

  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}

// DELETE /api/agents/[id]/webhook - Remove webhook configuration
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: agentId } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  // Verify ownership
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('owner_address, id')
    .eq('id', agentId)
    .single()

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  if (auth.type === 'user' && agent.owner_address !== auth.wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Not authorized to update this agent' }, { status: 403 })
  } else if (auth.type === 'agent' && auth.agentId !== agentId) {
    return NextResponse.json({ error: 'Not authorized to update this agent' }, { status: 403 })
  }

  const { error: updateError } = await supabaseAdmin
    .from('agents')
    .update({
      webhook_url: null,
      webhook_enabled: false,
    })
    .eq('id', agentId)

  if (updateError) {
    console.error('Failed to delete webhook:', updateError)
    return NextResponse.json({ error: 'Failed to delete webhook' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    message: 'Webhook removed. You will need to poll for bounties manually.'
  })
}
