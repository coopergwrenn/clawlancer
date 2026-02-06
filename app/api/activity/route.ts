import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

function formatUSDC(wei: number | string | null): string {
  const usdc = parseFloat(String(wei || '0')) / 1e6
  return `$${usdc.toFixed(2)}`
}

// GET /api/activity - Rich activity feed + today's stats
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50)

  // Fetch a balanced mix of event types so earnings aren't drowned by messages
  // Strategy: fetch priority events (earnings, listings, new agents) separately from messages,
  // then merge by timestamp for a diverse feed
  const priorityTypes = ['TRANSACTION_RELEASED', 'LISTING_CREATED', 'AGENT_CREATED', 'TRANSACTION_CREATED', 'LISTING_UPDATED']
  const priorityLimit = Math.ceil(limit * 0.6) // 60% priority events
  const messageLimit = Math.ceil(limit * 0.4)  // 40% messages

  const [priorityResult, messageResult] = await Promise.all([
    supabaseAdmin
      .from('feed_events')
      .select('*')
      .in('event_type', priorityTypes)
      .order('created_at', { ascending: false })
      .limit(priorityLimit),
    supabaseAdmin
      .from('feed_events')
      .select('*')
      .eq('event_type', 'MESSAGE_SENT')
      .order('created_at', { ascending: false })
      .limit(messageLimit),
  ])

  const error = priorityResult.error || messageResult.error

  // Merge and sort by timestamp
  const merged = [...(priorityResult.data || []), ...(messageResult.data || [])]
  merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  const events = merged.slice(0, limit)

  if (error) {
    console.error('Failed to fetch activity:', error)
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 })
  }

  // Collect related_agent_ids that are missing names so we can look them up
  const missingNameIds = new Set<string>()
  for (const e of events || []) {
    if (e.related_agent_id && !e.related_agent_name) {
      missingNameIds.add(e.related_agent_id)
    }
  }

  // Batch lookup missing agent names
  let agentNameMap: Record<string, string> = {}
  if (missingNameIds.size > 0) {
    const { data: agents } = await supabaseAdmin
      .from('agents')
      .select('id, name')
      .in('id', [...missingNameIds])
    for (const a of agents || []) {
      agentNameMap[a.id] = a.name
    }
  }

  // Build human-readable event strings
  // DB event_types: AGENT_CREATED, LISTING_CREATED, LISTING_UPDATED, TRANSACTION_CREATED, TRANSACTION_RELEASED, MESSAGE_SENT
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const richEvents = (events || []).map((e: any) => {
    let message = ''
    const agentName = e.agent_name || 'An agent'
    const relatedName = e.related_agent_name || agentNameMap[e.related_agent_id] || null

    switch (e.event_type) {
      case 'TRANSACTION_RELEASED':
        message = `${relatedName || agentName} earned ${formatUSDC(e.amount_wei)} for ${e.description || 'a task'}`
        break
      case 'AGENT_CREATED':
        message = `New agent ${agentName} just registered`
        break
      case 'LISTING_CREATED':
        message = `${agentName} posted: ${e.description || 'a new listing'}`
        break
      case 'LISTING_UPDATED':
        message = `${agentName} updated a listing`
        break
      case 'TRANSACTION_CREATED':
        message = `${agentName} started a new transaction with ${relatedName || 'another agent'}`
        break
      case 'MESSAGE_SENT': {
        // Show message preview instead of "sent a message to someone"
        const preview = e.description ? `"${e.description.slice(0, 80)}${e.description.length > 80 ? '...' : ''}"` : null
        if (preview) {
          message = `${agentName}: ${preview}`
        } else if (relatedName) {
          message = `${agentName} sent a message to ${relatedName}`
        } else {
          message = `${agentName} posted in the feed`
        }
        break
      }
      default:
        message = e.description || `${agentName} did something`
    }

    return {
      id: e.id,
      message,
      event_type: e.event_type,
      amount_wei: e.amount_wei,
      created_at: e.created_at,
      agent_name: agentName,
      related_agent_name: relatedName || null,
    }
  })

  // Compute "today" stats
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  // Active agents in last 24 hours (distinct agent_ids with feed events)
  const { data: activeAgentData } = await supabaseAdmin
    .from('feed_events')
    .select('agent_id')
    .gte('created_at', twentyFourHoursAgo)

  const uniqueActiveAgents = new Set((activeAgentData || []).map((e: { agent_id: string }) => e.agent_id).filter(Boolean))

  // Bounties completed today (TRANSACTION_RELEASED events, not bounty_claimed which doesn't exist)
  const { count: bountiesCount } = await supabaseAdmin
    .from('feed_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'TRANSACTION_RELEASED')
    .gte('created_at', todayStart)

  // $ paid today (sum of TRANSACTION_RELEASED amounts from feed_events)
  const { data: releasedToday } = await supabaseAdmin
    .from('feed_events')
    .select('amount_wei')
    .eq('event_type', 'TRANSACTION_RELEASED')
    .gte('created_at', todayStart)

  // Also check transactions table directly for released transactions today
  const { data: releasedTxns } = await supabaseAdmin
    .from('transactions')
    .select('amount_wei')
    .eq('state', 'RELEASED')
    .gte('completed_at', todayStart)

  // Use whichever source has more data
  const feedPaid = (releasedToday || []).reduce((sum: number, e: { amount_wei: number | string | null }) => {
    return sum + (parseFloat(String(e.amount_wei || '0')) / 1e6)
  }, 0)
  const txnPaid = (releasedTxns || []).reduce((sum: number, t: { amount_wei: number | string | null }) => {
    return sum + (parseFloat(String(t.amount_wei || '0')) / 1e6)
  }, 0)
  const paidToday = Math.max(feedPaid, txnPaid)

  // Gas slots remaining
  const { data: gasSetting } = await supabaseAdmin
    .from('platform_settings')
    .select('value')
    .eq('key', 'gas_promo_count')
    .single()

  const gasUsed = parseInt(gasSetting?.value || '0')
  const gasTotal = parseInt(process.env.GAS_PROMO_MAX_AGENTS || '100')
  const gasSlots = Math.max(0, gasTotal - gasUsed)

  return NextResponse.json({
    events: richEvents,
    today: {
      active_agents: uniqueActiveAgents.size,
      bounties_today: bountiesCount || 0,
      paid_today: `$${paidToday.toFixed(2)}`,
      gas_slots: gasSlots,
    },
  }, {
    headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
  })
}
