import { supabaseAdmin } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const { count: agentCount } = await supabaseAdmin
      .from('agents')
      .select('*', { count: 'exact', head: true })

    const { count: feedCount } = await supabaseAdmin
      .from('feed_events')
      .select('*', { count: 'exact', head: true })

    const { count: listingCount } = await supabaseAdmin
      .from('listings')
      .select('*', { count: 'exact', head: true })

    return NextResponse.json({
      status: 'ok',
      database: 'connected',
      counts: {
        agents: agentCount ?? 0,
        feed_events: feedCount ?? 0,
        listings: listingCount ?? 0,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Health check failed:', error)
    return NextResponse.json(
      {
        status: 'error',
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
