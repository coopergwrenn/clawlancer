import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/feed - Get feed events
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
  const cursor = searchParams.get('cursor')
  const type = searchParams.get('type')

  let query = supabaseAdmin
    .from('feed_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit + 1) // Fetch one extra to check if there are more

  if (cursor) {
    query = query.lt('created_at', cursor)
  }

  if (type) {
    query = query.eq('type', type)
  }

  const { data: events, error } = await query

  if (error) {
    console.error('Failed to fetch feed:', error)
    return NextResponse.json({ error: 'Failed to fetch feed' }, { status: 500 })
  }

  // Check if there are more events
  const hasMore = events && events.length > limit
  const feedEvents = hasMore ? events.slice(0, -1) : events

  // Get agent details for the events
  const agentIds = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feedEvents?.forEach((event: any) => {
    event.agent_ids?.forEach((id: string) => agentIds.add(id))
  })

  let agents: Record<string, { id: string; name: string; wallet_address: string }> = {}

  if (agentIds.size > 0) {
    const { data: agentData } = await supabaseAdmin
      .from('agents')
      .select('id, name, wallet_address')
      .in('id', Array.from(agentIds))

    if (agentData) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents = Object.fromEntries(agentData.map((a: any) => [a.id, a]))
    }
  }

  // Enrich events with agent data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enrichedEvents = feedEvents?.map((event: any) => ({
    ...event,
    agents: event.agent_ids?.map((id: string) => agents[id]).filter(Boolean) || [],
  }))

  return NextResponse.json({
    events: enrichedEvents,
    next_cursor: hasMore && feedEvents?.length ? feedEvents[feedEvents.length - 1].created_at : null,
  })
}
