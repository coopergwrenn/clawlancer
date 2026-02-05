/**
 * Cleanup script - Remove fake feed events not tied to real transactions
 * Run with: npx tsx scripts/cleanup-feed.ts
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)

interface FeedEvent {
  id: string
  event_type: string
  agent_id: string
  related_agent_id: string | null
  metadata: { transaction_id?: string } | null
}

async function main() {
  console.log('=== FEED CLEANUP SCRIPT ===\n')

  // Step 1: Get counts before cleanup
  const { count: beforeCount } = await supabase
    .from('feed_events')
    .select('*', { count: 'exact', head: true })

  console.log(`BEFORE: ${beforeCount} total feed events`)

  // Step 2: Get all real transaction IDs
  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, buyer_agent_id, seller_agent_id')

  console.log(`Real transactions: ${transactions?.length || 0}`)

  const realTransactionIds = new Set(
    transactions?.map((t: { id: string }) => t.id) || []
  )
  const realAgentPairs = new Set(
    transactions?.map(
      (t: { buyer_agent_id: string; seller_agent_id: string }) =>
        `${t.buyer_agent_id}-${t.seller_agent_id}`
    ) || []
  )

  // Step 3: Get all feed events
  const { data: feedEvents } = await supabase
    .from('feed_events')
    .select('id, event_type, agent_id, related_agent_id, metadata')

  // Step 4: Identify fake events to delete
  const fakeEventIds: string[] = []
  const keepReasons: Record<string, number> = {}

  for (const event of (feedEvents || []) as FeedEvent[]) {
    // Keep listing events (they're valid)
    if (
      event.event_type === 'LISTING_CREATED' ||
      event.event_type === 'LISTING_UPDATED'
    ) {
      keepReasons['listing_event'] = (keepReasons['listing_event'] || 0) + 1
      continue
    }

    // Keep agent creation events
    if (event.event_type === 'AGENT_CREATED') {
      keepReasons['agent_event'] = (keepReasons['agent_event'] || 0) + 1
      continue
    }

    // For transaction events, check if they have a real transaction
    if (
      event.event_type === 'TRANSACTION_CREATED' ||
      event.event_type === 'TRANSACTION_RELEASED' ||
      event.event_type === 'TRANSACTION_REFUNDED'
    ) {
      // Check if metadata has a transaction_id that exists
      const txId = event.metadata?.transaction_id
      if (txId && realTransactionIds.has(txId)) {
        keepReasons['has_real_tx'] = (keepReasons['has_real_tx'] || 0) + 1
        continue // Keep this event
      }

      // Check if agent pair matches any real transaction
      const agentPair = `${event.agent_id}-${event.related_agent_id}`
      const reversePair = `${event.related_agent_id}-${event.agent_id}`
      if (realAgentPairs.has(agentPair) || realAgentPairs.has(reversePair)) {
        keepReasons['matching_agents'] =
          (keepReasons['matching_agents'] || 0) + 1
        continue // Keep this event (likely valid)
      }

      // This is a fake event - mark for deletion
      fakeEventIds.push(event.id)
    }
  }

  console.log(`\nKeep reasons:`, keepReasons)
  console.log(`Fake events to delete: ${fakeEventIds.length}`)

  // Step 5: Delete fake events in batches
  if (fakeEventIds.length > 0) {
    console.log('\nDeleting fake events in batches...')
    const batchSize = 100
    let deleted = 0

    for (let i = 0; i < fakeEventIds.length; i += batchSize) {
      const batch = fakeEventIds.slice(i, i + batchSize)
      const { error: deleteError } = await supabase
        .from('feed_events')
        .delete()
        .in('id', batch)

      if (deleteError) {
        console.error(`Failed to delete batch ${i / batchSize + 1}:`, deleteError)
      } else {
        deleted += batch.length
        console.log(`Deleted batch ${Math.floor(i / batchSize) + 1}: ${batch.length} events (total: ${deleted})`)
      }
    }
    console.log(`Deletion complete! Total deleted: ${deleted}`)
  }

  // Step 6: Get counts after cleanup
  const { count: afterCount } = await supabase
    .from('feed_events')
    .select('*', { count: 'exact', head: true })

  console.log(`\n=== RESULTS ===`)
  console.log(`BEFORE: ${beforeCount} feed events`)
  console.log(`AFTER: ${afterCount} feed events`)
  console.log(`DELETED: ${fakeEventIds.length} fake events`)
}

main().catch(console.error)
