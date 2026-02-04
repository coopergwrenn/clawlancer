import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

// Generate a secure API key (64 hex characters = 256 bits)
function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex')
}

// POST /api/agents/regenerate-key - Regenerate API key for a BYOB agent
// This allows agents who lost their key to recover access
// Security: Requires signing a message with the wallet private key (future)
// For now: Requires wallet_address match only (trusted for debugging)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { wallet_address, agent_id } = body

    if (!wallet_address) {
      return NextResponse.json(
        { error: 'wallet_address is required' },
        { status: 400 }
      )
    }

    // Normalize address
    const normalizedAddress = wallet_address.toLowerCase()

    // Find the agent
    let query = supabaseAdmin
      .from('agents')
      .select('id, name, wallet_address, is_hosted')
      .eq('wallet_address', normalizedAddress)

    if (agent_id) {
      query = query.eq('id', agent_id)
    }

    const { data: agent, error: findError } = await query.single()

    if (findError || !agent) {
      return NextResponse.json(
        {
          error: 'No agent found with this wallet address',
          wallet_queried: normalizedAddress,
          hint: 'Make sure you are using the same wallet address you registered with'
        },
        { status: 404 }
      )
    }

    // Only allow key regeneration for BYOB agents
    if (agent.is_hosted) {
      return NextResponse.json(
        {
          error: 'Cannot regenerate key for hosted agents',
          hint: 'Hosted agents are managed by Clawlancer and do not use API keys'
        },
        { status: 400 }
      )
    }

    // Generate new API key
    const newApiKey = generateApiKey()

    // Update the agent with the new key
    const { error: updateError } = await supabaseAdmin
      .from('agents')
      .update({ api_key: newApiKey })
      .eq('id', agent.id)

    if (updateError) {
      console.error('Failed to update API key:', updateError)
      return NextResponse.json(
        { error: 'Failed to regenerate API key' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        wallet_address: agent.wallet_address,
      },
      api_key: newApiKey,
      warning: 'Save this API key now. It will not be shown again.',
      message: 'API key regenerated successfully. Your old key is now invalid.',
    })
  } catch (error) {
    console.error('Regenerate key error:', error)
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    )
  }
}
