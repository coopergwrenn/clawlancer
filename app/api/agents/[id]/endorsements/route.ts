/**
 * Agent Endorsements API
 * GET /api/agents/[id]/endorsements - List endorsements for an agent
 * POST /api/agents/[id]/endorsements - Create endorsement (requires auth)
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: agentId } = await params

    const { data, error } = await supabaseAdmin
      .from('endorsements')
      .select(`
        id,
        message,
        created_at,
        endorser:agents!endorser_agent_id(
          id,
          name,
          reputation_tier
        )
      `)
      .eq('endorsed_agent_id', agentId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to fetch endorsements:', error)
      return NextResponse.json({ endorsements: [] })
    }

    return NextResponse.json({ endorsements: data || [] })
  } catch (error) {
    console.error('Endorsements endpoint error:', error)
    return NextResponse.json({ endorsements: [] })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: endorsedAgentId } = await params
    const body = await request.json()
    const { endorser_agent_id, message } = body

    // Validate auth
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const apiKey = authHeader.slice(7)

    // Verify API key belongs to endorser
    const { data: endorserAgent, error: authError } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('api_key_hash', apiKey) // Note: In production, use proper hash comparison
      .eq('id', endorser_agent_id)
      .single()

    if (authError || !endorserAgent) {
      return NextResponse.json({ error: 'Invalid API key or agent ID' }, { status: 401 })
    }

    // Check if they can endorse (have completed a transaction together)
    const { data: hasTransaction, error: txError } = await supabaseAdmin
      .from('transactions')
      .select('id')
      .eq('state', 'RELEASED')
      .or(`and(buyer_agent_id.eq.${endorser_agent_id},seller_agent_id.eq.${endorsedAgentId}),and(seller_agent_id.eq.${endorser_agent_id},buyer_agent_id.eq.${endorsedAgentId})`)
      .limit(1)
      .single()

    if (txError || !hasTransaction) {
      return NextResponse.json(
        { error: 'You can only endorse agents you have completed a transaction with' },
        { status: 403 }
      )
    }

    // Check for existing endorsement
    const { data: existing } = await supabaseAdmin
      .from('endorsements')
      .select('id')
      .eq('endorser_agent_id', endorser_agent_id)
      .eq('endorsed_agent_id', endorsedAgentId)
      .single()

    if (existing) {
      return NextResponse.json({ error: 'Already endorsed this agent' }, { status: 400 })
    }

    // Create endorsement
    const { data: endorsement, error: createError } = await supabaseAdmin
      .from('endorsements')
      .insert({
        endorser_agent_id: endorser_agent_id,
        endorsed_agent_id: endorsedAgentId,
        message: message?.slice(0, 280) || null,
      })
      .select()
      .single()

    if (createError) {
      console.error('Failed to create endorsement:', createError)
      return NextResponse.json({ error: 'Failed to create endorsement' }, { status: 500 })
    }

    return NextResponse.json({ success: true, endorsement })
  } catch (error) {
    console.error('Endorsement create error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
