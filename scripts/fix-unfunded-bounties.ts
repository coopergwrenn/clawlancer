/**
 * Fix Unfunded Bounties
 *
 * Finds all active BOUNTY listings from hosted agents that were created
 * without proper balance locking (the bug in createWelcomeBounty and bounty-drip).
 *
 * For each unfunded bounty:
 *   1. Credits the posting agent's platform balance
 *   2. Locks the balance
 *   3. Records platform transactions
 *
 * Run with: npx tsx scripts/fix-unfunded-bounties.ts [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// All hosted agent IDs that post system bounties
const HOSTED_AGENT_IDS = [
  'a67d7b98-7a5d-42e1-8c15-38e5745bd789', // Dusty Pete
  'bbd8f6e2-96ca-4fe0-b432-8fe60d181ebb', // Sheriff Claude
  '0d458eb0-2325-4130-95cb-e4f5d43def9f', // Tumbleweed
  'c0916187-07c7-4cde-88c4-8de7fdbb59cc', // Cactus Jack
  'cf90cd61-0e0e-42d0-ab06-d333064b2323', // Snake Oil Sally
]

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
  if (DRY_RUN) console.log('=== DRY RUN — no changes will be made ===\n')

  // Find all active bounties from hosted agents
  const { data: bounties, error: fetchError } = await supabase
    .from('listings')
    .select('id, agent_id, title, price_wei')
    .in('agent_id', HOSTED_AGENT_IDS)
    .eq('listing_type', 'BOUNTY')
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  if (fetchError) {
    console.error('Failed to fetch bounties:', fetchError)
    process.exit(1)
  }

  if (!bounties || bounties.length === 0) {
    console.log('No active hosted-agent bounties found.')
    return
  }

  console.log(`Found ${bounties.length} active hosted-agent bounties\n`)

  // Get locked balances for each hosted agent
  const { data: agents, error: agentError } = await supabase
    .from('agents')
    .select('id, name, platform_balance_wei, locked_balance_wei')
    .in('id', HOSTED_AGENT_IDS)

  if (agentError || !agents) {
    console.error('Failed to fetch agents:', agentError)
    process.exit(1)
  }

  const agentMap = new Map(agents.map(a => [a.id, a]))

  // Calculate how much SHOULD be locked per agent
  const requiredLockByAgent = new Map<string, bigint>()
  for (const bounty of bounties) {
    const current = requiredLockByAgent.get(bounty.agent_id) ?? 0n
    requiredLockByAgent.set(bounty.agent_id, current + BigInt(bounty.price_wei))
  }

  // Report per agent
  let totalToFund = 0n
  const toFund: typeof bounties = []

  for (const [agentId, requiredLocked] of requiredLockByAgent) {
    const agent = agentMap.get(agentId)
    if (!agent) continue
    const actualLocked = BigInt(agent.locked_balance_wei || '0')
    const deficit = requiredLocked - actualLocked

    const price = (Number(requiredLocked) / 1e6).toFixed(4)
    const locked = (Number(actualLocked) / 1e6).toFixed(4)
    const deficitUsd = (Number(deficit > 0n ? deficit : 0n) / 1e6).toFixed(4)

    console.log(`${agent.name}:`)
    console.log(`  Active bounties require: $${price} locked`)
    console.log(`  Actually locked:         $${locked}`)
    console.log(`  Deficit:                 $${deficitUsd}`)
    console.log()

    if (deficit > 0n) {
      totalToFund += deficit
    }
  }

  // Find bounties that need funding — we'll fund ALL active bounties
  // to ensure each one is individually backed
  console.log(`\nFunding strategy: credit + lock for each active bounty individually\n`)

  let funded = 0
  let skipped = 0

  for (const bounty of bounties) {
    const agent = agentMap.get(bounty.agent_id)
    const price = (parseInt(bounty.price_wei) / 1e6).toFixed(4)

    // Check if there's already a LOCK platform_transaction for this listing
    const { data: existingLock } = await supabase
      .from('platform_transactions')
      .select('id')
      .eq('agent_id', bounty.agent_id)
      .eq('type', 'LOCK')
      .like('description', `%${bounty.id}%`)
      .limit(1)

    if (existingLock && existingLock.length > 0) {
      console.log(`  SKIP  $${price} — ${bounty.title} (already has LOCK record)`)
      skipped++
      continue
    }

    if (DRY_RUN) {
      console.log(`  WOULD FUND  $${price} — ${bounty.title} (${agent?.name})`)
      funded++
      continue
    }

    // Credit
    const { error: creditError } = await supabase.rpc('increment_agent_balance', {
      p_agent_id: bounty.agent_id,
      p_amount_wei: bounty.price_wei,
    })
    if (creditError) {
      console.error(`  FAIL  $${price} — ${bounty.title}: credit failed: ${creditError.message}`)
      continue
    }

    // Lock
    const { data: lockResult, error: lockError } = await supabase.rpc('lock_agent_balance', {
      p_agent_id: bounty.agent_id,
      p_amount_wei: bounty.price_wei,
    })
    if (lockError || !lockResult) {
      console.error(`  FAIL  $${price} — ${bounty.title}: lock failed: ${lockError?.message || 'returned false'}`)
      continue
    }

    // Record platform transactions
    await supabase.from('platform_transactions').insert({
      agent_id: bounty.agent_id,
      type: 'CREDIT',
      amount_wei: bounty.price_wei,
      description: `Backfill funding for bounty: ${bounty.title} (${bounty.id})`,
    })
    await supabase.from('platform_transactions').insert({
      agent_id: bounty.agent_id,
      type: 'LOCK',
      amount_wei: bounty.price_wei,
      description: `Backfill lock for bounty: ${bounty.title} (${bounty.id})`,
    })

    console.log(`  FUNDED  $${price} — ${bounty.title} (${agent?.name})`)
    funded++
  }

  console.log(`\n${DRY_RUN ? 'Would fund' : 'Funded'}: ${funded} | Skipped (already funded): ${skipped} | Total: ${bounties.length}`)
}

main().catch(console.error)
