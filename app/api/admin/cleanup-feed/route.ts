import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/admin/cleanup-feed - Remove fake feed events
export async function POST(request: NextRequest) {
  // Verify admin/system auth
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
      authHeader !== `Bearer ${process.env.AGENT_RUNNER_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Step 1: Get counts before cleanup
    const { count: beforeCount } = await supabaseAdmin
      .from('feed_events')
      .select('*', { count: 'exact', head: true })

    // Step 2: Get all real transaction IDs
    const { data: transactions } = await supabaseAdmin
      .from('transactions')
      .select('id, buyer_agent_id, seller_agent_id')

    const realTransactionIds = new Set(transactions?.map((t: { id: string }) => t.id) || [])
    const realAgentPairs = new Set(
      transactions?.map((t: { buyer_agent_id: string; seller_agent_id: string }) =>
        `${t.buyer_agent_id}-${t.seller_agent_id}`
      ) || []
    )

    // Step 3: Get all feed events
    const { data: feedEvents } = await supabaseAdmin
      .from('feed_events')
      .select('id, event_type, agent_id, related_agent_id, metadata')

    // Step 4: Identify fake events to delete
    const fakeEventIds: string[] = []

    interface FeedEvent {
      id: string
      event_type: string
      agent_id: string
      related_agent_id: string | null
      metadata: { transaction_id?: string } | null
    }

    for (const event of (feedEvents || []) as FeedEvent[]) {
      // Keep listing events (they're valid)
      if (event.event_type === 'LISTING_CREATED' || event.event_type === 'LISTING_UPDATED') {
        continue
      }

      // Keep agent creation events
      if (event.event_type === 'AGENT_CREATED') {
        continue
      }

      // For transaction events, check if they have a real transaction
      if (event.event_type === 'TRANSACTION_CREATED' ||
          event.event_type === 'TRANSACTION_RELEASED' ||
          event.event_type === 'TRANSACTION_REFUNDED') {

        // Check if metadata has a transaction_id that exists
        const txId = event.metadata?.transaction_id
        if (txId && realTransactionIds.has(txId)) {
          continue // Keep this event
        }

        // Check if agent pair matches any real transaction
        const agentPair = `${event.agent_id}-${event.related_agent_id}`
        const reversePair = `${event.related_agent_id}-${event.agent_id}`
        if (realAgentPairs.has(agentPair) || realAgentPairs.has(reversePair)) {
          continue // Keep this event (likely valid)
        }

        // This is a fake event - mark for deletion
        fakeEventIds.push(event.id)
      }
    }

    // Step 5: Delete fake events
    if (fakeEventIds.length > 0) {
      const { error: deleteError } = await supabaseAdmin
        .from('feed_events')
        .delete()
        .in('id', fakeEventIds)

      if (deleteError) {
        console.error('Failed to delete fake events:', deleteError)
        return NextResponse.json({ error: 'Failed to delete fake events' }, { status: 500 })
      }
    }

    // Step 6: Get counts after cleanup
    const { count: afterCount } = await supabaseAdmin
      .from('feed_events')
      .select('*', { count: 'exact', head: true })

    return NextResponse.json({
      success: true,
      before: beforeCount,
      after: afterCount,
      deleted: fakeEventIds.length,
      message: `Cleaned up ${fakeEventIds.length} fake feed events`,
    })
  } catch (err) {
    console.error('Cleanup error:', err)
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}
