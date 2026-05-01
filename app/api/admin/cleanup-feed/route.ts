import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/admin/cleanup-feed - Remove fake/spam feed events
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

    // Step 2: Delete broadcast spam (MESSAGE_SENT with null related_agent_id)
    const { count: broadcastDeleted } = await supabaseAdmin
      .from('feed_events')
      .delete({ count: 'exact' })
      .eq('event_type', 'MESSAGE_SENT')
      .is('related_agent_id', null)

    // Step 3: Get all real transaction IDs
    const { data: transactions } = await supabaseAdmin
      .from('transactions')
      .select('id, buyer_agent_id, seller_agent_id')

    const realTransactionIds = new Set(transactions?.map((t: { id: string }) => t.id) || [])
    const realAgentPairs = new Set(
      transactions?.map((t: { buyer_agent_id: string; seller_agent_id: string }) =>
        `${t.buyer_agent_id}-${t.seller_agent_id}`
      ) || []
    )

    // Step 4: Get remaining feed events for dedup
    const { data: feedEvents } = await supabaseAdmin
      .from('feed_events')
      .select('id, event_type, agent_id, related_agent_id, metadata, created_at')
      .order('created_at', { ascending: false })

    // Step 5: Identify fake/duplicate events
    const fakeEventIds: string[] = []

    // Track seen transaction events for dedup (keep first, remove rest)
    const seenTxEvents = new Map<string, string>() // key -> first event id

    interface FeedEvent {
      id: string
      event_type: string
      agent_id: string
      related_agent_id: string | null
      metadata: { transaction_id?: string } | null
      created_at: string
    }

    for (const event of (feedEvents || []) as FeedEvent[]) {
      // Keep listing events
      if (event.event_type === 'LISTING_CREATED' || event.event_type === 'LISTING_UPDATED') {
        continue
      }

      // Keep agent creation events
      if (event.event_type === 'AGENT_CREATED') {
        continue
      }

      // Keep valid MESSAGE_SENT events (broadcast already deleted above)
      if (event.event_type === 'MESSAGE_SENT') {
        continue
      }

      // For transaction events: check validity and dedup
      if (event.event_type === 'TRANSACTION_CREATED' ||
          event.event_type === 'TRANSACTION_RELEASED' ||
          event.event_type === 'TRANSACTION_REFUNDED') {

        const txId = event.metadata?.transaction_id
        if (txId && realTransactionIds.has(txId)) {
          // Valid transaction — but dedup (keep newest per transaction+event_type)
          const dedupKey = `${txId}-${event.event_type}`
          if (seenTxEvents.has(dedupKey)) {
            fakeEventIds.push(event.id) // Duplicate — delete older
          } else {
            seenTxEvents.set(dedupKey, event.id)
          }
          continue
        }

        // Check agent pair match
        const agentPair = `${event.agent_id}-${event.related_agent_id}`
        const reversePair = `${event.related_agent_id}-${event.agent_id}`
        if (realAgentPairs.has(agentPair) || realAgentPairs.has(reversePair)) {
          // Valid pair — dedup
          const dedupKey = `${agentPair}-${event.event_type}`
          if (seenTxEvents.has(dedupKey)) {
            fakeEventIds.push(event.id)
          } else {
            seenTxEvents.set(dedupKey, event.id)
          }
          continue
        }

        // No real transaction match — fake event
        fakeEventIds.push(event.id)
      }
    }

    // Step 6: Delete fake/duplicate events in batches
    let deletedCount = 0
    for (let i = 0; i < fakeEventIds.length; i += 100) {
      const batch = fakeEventIds.slice(i, i + 100)
      const { count } = await supabaseAdmin
        .from('feed_events')
        .delete({ count: 'exact' })
        .in('id', batch)
      deletedCount += count || 0
    }

    // Step 7: Final count
    const { count: afterCount } = await supabaseAdmin
      .from('feed_events')
      .select('*', { count: 'exact', head: true })

    return NextResponse.json({
      success: true,
      before: beforeCount,
      after: afterCount,
      broadcast_spam_deleted: broadcastDeleted || 0,
      fake_events_deleted: deletedCount,
      total_deleted: (broadcastDeleted || 0) + deletedCount,
    })
  } catch (err) {
    console.error('Cleanup error:', err)
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}

// Vercel Cron Jobs only send GET requests. Delegate to the POST handler so
// the daily-cron cleanup uses the exact same logic. Auth header is the same
// (Bearer ${CRON_SECRET}), and POST doesn't read a request body, so the
// pass-through is safe.
//
// Build-trigger note: this comment exists to ensure the Vercel ignoreCommand
// detects a change and runs the build that includes f6049ab7 (the tsconfig
// fix excluding instaclaw-mini). The kill switch (1058c330) and cleanup cron
// (4e2fed9a) need this build to land.
export async function GET(request: NextRequest) {
  return POST(request)
}
