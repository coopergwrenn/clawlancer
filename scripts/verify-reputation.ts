/**
 * Verify reputation sync worked
 * Run with: npx tsx scripts/verify-reputation.ts
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseKey)

const RICHIE_ID = 'a5daf737-954d-4d0b-82d1-e5eb2b40c5ba'

async function main() {
  console.log('=== RICHIE STATS VERIFICATION ===\n')

  // 1. Get Richie's full stats
  const { data: richie } = await supabase
    .from('agents')
    .select('id, name, transaction_count, total_earned_wei, total_spent_wei, reputation_tier')
    .eq('id', RICHIE_ID)
    .single()

  console.log("Richie's current stats:")
  console.log(JSON.stringify(richie, null, 2))

  // 2. Verify against actual transactions
  console.log('\n=== ACTUAL TRANSACTION DATA ===')

  const { data: sellerTx } = await supabase
    .from('transactions')
    .select('id, state, amount_wei, created_at')
    .eq('seller_agent_id', RICHIE_ID)
    .eq('state', 'RELEASED')

  const { data: buyerTx } = await supabase
    .from('transactions')
    .select('id, state, amount_wei, created_at')
    .eq('buyer_agent_id', RICHIE_ID)
    .eq('state', 'RELEASED')

  console.log('As seller (RELEASED):', sellerTx?.length || 0, 'transactions')
  if (sellerTx?.length) {
    for (const tx of sellerTx) {
      console.log('  -', tx.id.slice(0, 8), '| amount:', tx.amount_wei, 'wei')
    }
  }

  console.log('As buyer (RELEASED):', buyerTx?.length || 0, 'transactions')
  if (buyerTx?.length) {
    for (const tx of buyerTx) {
      console.log('  -', tx.id.slice(0, 8), '| amount:', tx.amount_wei, 'wei')
    }
  }

  const totalCompleted = (sellerTx?.length || 0) + (buyerTx?.length || 0)
  console.log('\nTotal completed:', totalCompleted)

  // 3. Check if stats match
  console.log('\n=== VERIFICATION ===')
  const statsMatch = richie?.transaction_count === totalCompleted
  console.log('transaction_count matches actual:', statsMatch ? '✓ YES' : '✗ NO')
  console.log('  Recorded:', richie?.transaction_count)
  console.log('  Actual:', totalCompleted)

  // Expected tier
  let expectedTier = 'NEWCOMER'
  if (totalCompleted >= 50) expectedTier = 'VETERAN'
  else if (totalCompleted >= 20) expectedTier = 'TRUSTED'
  else if (totalCompleted >= 5) expectedTier = 'RELIABLE'

  const tierMatch = richie?.reputation_tier === expectedTier
  console.log('reputation_tier correct:', tierMatch ? '✓ YES' : '✗ NO')
  console.log('  Recorded:', richie?.reputation_tier)
  console.log('  Expected:', expectedTier)

  // 4. Check ALL agents
  console.log('\n=== ALL AGENTS VERIFICATION ===\n')

  const { data: agents } = await supabase
    .from('agents')
    .select('id, name, transaction_count, reputation_tier')
    .order('transaction_count', { ascending: false })

  let allMatch = true
  for (const agent of agents || []) {
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

    const actual = (sellerCount || 0) + (buyerCount || 0)
    const match = agent.transaction_count === actual
    if (!match) allMatch = false

    const icon = match ? '✓' : '✗'
    console.log(
      `${icon} ${agent.name}: recorded=${agent.transaction_count}, actual=${actual}, tier=${agent.reputation_tier}`
    )
  }

  console.log('\n' + '='.repeat(50))
  console.log(allMatch ? '✓ ALL AGENTS SYNCED CORRECTLY' : '✗ SOME AGENTS OUT OF SYNC')
}

main().catch(console.error)
