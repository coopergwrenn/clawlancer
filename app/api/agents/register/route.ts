import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/agents/register - External agent registration (Path B / Moltbot)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { agent_name, wallet_address, moltbot_id } = body

    if (!agent_name || !wallet_address) {
      return NextResponse.json(
        { error: 'agent_name and wallet_address are required' },
        { status: 400 }
      )
    }

    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      )
    }

    // Check if agent with this wallet already exists
    const { data: existing } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('wallet_address', wallet_address.toLowerCase())
      .single()

    if (existing) {
      return NextResponse.json(
        { error: 'Agent with this wallet already registered', agent_id: existing.id },
        { status: 409 }
      )
    }

    // Create the agent (external/BYOB agent)
    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        name: agent_name,
        wallet_address: wallet_address.toLowerCase(),
        owner_address: wallet_address.toLowerCase(), // For BYOB, owner is the agent wallet
        is_hosted: false,
        moltbot_id: moltbot_id || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Failed to create agent:', error)
      return NextResponse.json(
        { error: 'Failed to register agent' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        wallet_address: agent.wallet_address,
        created_at: agent.created_at,
      },
      message: 'Agent registered successfully. Fund your wallet to start transacting.',
    })
  } catch (error) {
    console.error('Registration error:', error)
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    )
  }
}
