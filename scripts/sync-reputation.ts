/**
 * Sync all agent reputation stats from actual transaction data
 * Run with: npx tsx scripts/sync-reputation.ts
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseKey)

interface Agent {
  id: string
  name: string
  transaction_count: number
  total_earned_wei: number
  total_spent_wei: number
  success_rate: number | null
  reputation_tier: string | null
}

function getReputationTier(completedCount: number): string {
  if (completedCount >= 50) return 'VETERAN'
  if (completedCount >= 20) return 'TRUSTED'
  if (completedCount >= 5) return 'RELIABLE'
  return 'NEWCOMER'
}

async function syncAgentReputation(agentId: string, agentName: string): Promise<{
  name: string
  oldCount: number
  newCount: number
  changed: boolean
}> {
  // Get current stats
  const { data: agent } = await supabase
    .from('agents')
    .select('transaction_count, total_earned_wei, total_spent_wei')
    .eq('id', agentId)
    .single()

  const oldCount = agent?.transaction_count || 0

  // Count completed transactions as seller
  const { count: sellerCount } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('seller_agent_id', agentId)
    .eq('state', 'RELEASED')

  // Count completed transactions as buyer
  const { count: buyerCount } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('buyer_agent_id', agentId)
    .eq('state', 'RELEASED')

  const totalCompleted = (sellerCount || 0) + (buyerCount || 0)

  // Count total non-pending transactions for success rate
  const { count: totalNonPending } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .or(`buyer_agent_id.eq.${agentId},seller_agent_id.eq.${agentId}`)
    .in('state', ['RELEASED', 'REFUNDED', 'DISPUTED'])

  // Calculate total earned (as seller)
  const { data: earnedTx } = await supabase
    .from('transactions')
    .select('amount_wei')
    .eq('seller_agent_id', agentId)
    .eq('state', 'RELEASED')

  let totalEarned = BigInt(0)
  for (const tx of earnedTx || []) {
    totalEarned += BigInt(tx.amount_wei || 0)
  }

  // Calculate total spent (as buyer)
  const { data: spentTx } = await supabase
    .from('transactions')
    .select('amount_wei')
    .eq('buyer_agent_id', agentId)
    .eq('state', 'RELEASED')

  let totalSpent = BigInt(0)
  for (const tx of spentTx || []) {
    totalSpent += BigInt(tx.amount_wei || 0)
  }

  // Calculate success rate
  const successRate = (totalNonPending || 0) > 0
    ? (totalCompleted / (totalNonPending || 1)) * 100
    : 100

  // Determine reputation tier
  const tier = getReputationTier(totalCompleted)

  // Update the agent (only columns that exist)
  const { error } = await supabase
    .from('agents')
    .update({
      transaction_count: totalCompleted,
      total_earned_wei: totalEarned.toString(),
      total_spent_wei: totalSpent.toString(),
      reputation_tier: tier,
    })
    .eq('id', agentId)

  if (error) {
    console.error(`Failed to update ${agentName}:`, error)
  }

  return {
    name: agentName,
    oldCount,
    newCount: totalCompleted,
    changed: oldCount !== totalCompleted,
  }
}

async function main() {
  console.log('=== REPUTATION SYNC ===\n')

  // Get all agents
  const { data: agents } = await supabase
    .from('agents')
    .select('id, name')

  if (!agents || agents.length === 0) {
    console.log('No agents found')
    return
  }

  console.log(`Syncing ${agents.length} agents...\n`)

  const results: { name: string; oldCount: number; newCount: number; changed: boolean }[] = []

  for (const agent of agents) {
    const result = await syncAgentReputation(agent.id, agent.name)
    results.push(result)
  }

  // Show results
  console.log('Results:')
  console.log('-'.repeat(60))

  const changed = results.filter(r => r.changed)
  const unchanged = results.filter(r => !r.changed)

  if (changed.length > 0) {
    console.log('\n✓ UPDATED:')
    for (const r of changed) {
      console.log(`  ${r.name}: ${r.oldCount} → ${r.newCount}`)
    }
  }

  if (unchanged.length > 0) {
    console.log('\n○ UNCHANGED:')
    for (const r of unchanged) {
      console.log(`  ${r.name}: ${r.newCount}`)
    }
  }

  console.log('\n' + '-'.repeat(60))
  console.log(`Total: ${changed.length} updated, ${unchanged.length} unchanged`)

  // Verify Richie specifically
  console.log('\n=== VERIFICATION: Richie ===')
  const { data: richie } = await supabase
    .from('agents')
    .select('name, transaction_count, total_earned_wei, total_spent_wei, reputation_tier')
    .eq('id', 'a5daf737-954d-4d0b-82d1-e5eb2b40c5ba')
    .single()

  console.log(richie)
}

main().catch(console.error)
