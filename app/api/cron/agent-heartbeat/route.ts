import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/cron/agent-heartbeat - Run heartbeat for agents
// Called by Vercel cron or triggered immediately on agent creation
export async function POST(request: NextRequest) {
  // Verify cron/system secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
      authHeader !== `Bearer ${process.env.AGENT_RUNNER_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let agentId: string | null = null
  let isImmediate = false
  let agentType: 'house' | 'user' | 'all' = 'all'

  try {
    const body = await request.json()
    agentId = body.agent_id || null
    isImmediate = body.immediate || false
  } catch {
    // Check query params for cron-style calls
    const { searchParams } = new URL(request.url)
    agentType = (searchParams.get('type') as 'house' | 'user' | 'all') || 'all'
  }

  // If specific agent requested, run just that one
  if (agentId) {
    const result = await runAgentHeartbeat(agentId, isImmediate)
    return NextResponse.json(result)
  }

  // Otherwise, get list of active hosted agents to process
  let query = supabaseAdmin
    .from('agents')
    .select('id, name, owner_address')
    .eq('is_active', true)
    .eq('is_hosted', true)
    .limit(50)

  // Filter by type if specified (for different cron frequencies)
  if (agentType === 'house') {
    // House bots owned by treasury
    query = query.eq('owner_address', process.env.TREASURY_ADDRESS?.toLowerCase() || '')
  } else if (agentType === 'user') {
    // User agents (not owned by treasury)
    query = query.neq('owner_address', process.env.TREASURY_ADDRESS?.toLowerCase() || '')
  }

  const { data: agents, error } = await query

  if (error) {
    console.error('Failed to fetch agents for heartbeat:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  if (!agents || agents.length === 0) {
    return NextResponse.json({ message: 'No agents to process', processed: 0 })
  }

  // Process agents with jittered timing to avoid thundering herd
  const results: { id: string; name: string; success: boolean; action?: string; error?: string }[] = []

  for (const agent of agents) {
    // Add small random delay between agents (0-500ms)
    await new Promise(resolve => setTimeout(resolve, Math.random() * 500))

    try {
      const result = await runAgentHeartbeat(agent.id, false)
      results.push({
        id: agent.id,
        name: agent.name,
        success: true,
        action: result.action,
      })
    } catch (err) {
      console.error(`Heartbeat failed for agent ${agent.id}:`, err)
      results.push({
        id: agent.id,
        name: agent.name,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  const successful = results.filter(r => r.success).length

  return NextResponse.json({
    message: `Processed ${results.length} agents`,
    processed: results.length,
    successful,
    failed: results.length - successful,
    results,
  })
}

// Also support GET for Vercel cron
export async function GET(request: NextRequest) {
  return POST(request)
}

// Run heartbeat for a single agent
async function runAgentHeartbeat(agentId: string, isImmediate: boolean) {
  const startTime = Date.now()

  // Get agent details
  const { data: agent, error: agentError } = await supabaseAdmin
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .single()

  if (agentError || !agent) {
    throw new Error('Agent not found')
  }

  // For now, stub the heartbeat logic
  // Full implementation requires gatherAgentContext + Claude API (Day 7)

  // Log the heartbeat
  await supabaseAdmin
    .from('agent_logs')
    .insert({
      agent_id: agentId,
      heartbeat_at: new Date().toISOString(),
      context_summary: { immediate: isImmediate },
      action_chosen: { type: 'do_nothing', reason: 'Heartbeat stub - full implementation pending' },
      execution_success: true,
      claude_latency_ms: Date.now() - startTime,
    })

  return {
    agent_id: agentId,
    action: 'do_nothing',
    reason: isImmediate ? 'First heartbeat - agent initialized' : 'Heartbeat stub',
    latency_ms: Date.now() - startTime,
  }
}
