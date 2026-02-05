/**
 * Diagnose reputation sync issues
 * Run with: npx tsx scripts/diagnose-reputation.ts
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseKey)

const RICHIE_ID = 'a5daf737-954d-4d0b-82d1-e5eb2b40c5ba'

async function main() {
  console.log('=== REPUTATION DIAGNOSIS ===\n')

  // 1. Query Richie's current agent stats
  console.log("1. Richie's current agent record:")
  const { data: richie } = await supabase
    .from('agents')
    .select('id, name, transaction_count, total_earned_wei, total_spent_wei, reputation_tier')
    .eq('id', RICHIE_ID)
    .single()

  console.log(richie)
  console.log('')

  // 2. Query Richie's actual transactions
  console.log("2. Richie's actual transactions:")
  const { data: txAsSellerReleased } = await supabase
    .from('transactions')
    .select('id, state, amount_wei')
    .eq('seller_agent_id', RICHIE_ID)
    .eq('state', 'RELEASED')

  const { data: txAsBuyerReleased } = await supabase
    .from('transactions')
    .select('id, state, amount_wei')
    .eq('buyer_agent_id', RICHIE_ID)
    .eq('state', 'RELEASED')

  const { data: txAsSellerDelivered } = await supabase
    .from('transactions')
    .select('id, state, amount_wei')
    .eq('seller_agent_id', RICHIE_ID)
    .eq('state', 'DELIVERED')

  console.log(`  - As seller (RELEASED): ${txAsSellerReleased?.length || 0}`)
  console.log(`  - As buyer (RELEASED): ${txAsBuyerReleased?.length || 0}`)
  console.log(`  - As seller (DELIVERED): ${txAsSellerDelivered?.length || 0}`)

  const totalCompleted = (txAsSellerReleased?.length || 0) + (txAsBuyerReleased?.length || 0)
  console.log(`  - Total completed: ${totalCompleted}`)

  // Calculate what total_earned should be
  let totalEarned = BigInt(0)
  for (const tx of txAsSellerReleased || []) {
    totalEarned += BigInt(tx.amount_wei || 0)
  }
  console.log(`  - Should have earned: ${totalEarned.toString()} wei ($${(Number(totalEarned) / 1e6).toFixed(2)} USDC)`)
  console.log('')

  // 3. Check all agents for mismatches
  console.log('3. All agents with potential stat mismatches:')

  const { data: allAgents } = await supabase
    .from('agents')
    .select('id, name, transaction_count, total_earned_wei, total_spent_wei')

  for (const agent of allAgents || []) {
    // Count actual completed transactions
    const { count: sellerCount } = await supabase
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('seller_agent_id', agent.id)
      .eq('state', 'RELEASED')

    const { count: buyerCount } = await supabase
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('buyer_agent_id', agent.id)
      .eq('state', 'RELEASED')

    const actualCount = (sellerCount || 0) + (buyerCount || 0)
    const recordedCount = agent.transaction_count || 0

    if (actualCount !== recordedCount) {
      console.log(`  ❌ ${agent.name}: recorded=${recordedCount}, actual=${actualCount}`)
    }
  }

  console.log('\n=== DIAGNOSIS COMPLETE ===')
}

main().catch(console.error)
