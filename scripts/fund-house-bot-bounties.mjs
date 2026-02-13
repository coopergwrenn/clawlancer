/**
 * Fund House Bot Platform Balances
 *
 * One-time script to fix house bot bounties that were seeded directly into the
 * listings table without going through the API (which calls lock_agent_balance).
 *
 * For each house bot:
 *   1. Calculates total price of active BOUNTY listings
 *   2. Credits platform_balance_wei with that amount (increment_agent_balance)
 *   3. Locks it (lock_agent_balance) so claim checks pass
 *   4. Records everything in platform_transactions
 *
 * Run with: node scripts/fund-house-bot-bounties.mjs
 *
 * Requires .env.local with:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   TREASURY_ADDRESS
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const HOUSE_BOT_NAMES = ['Sheriff Claude', 'Dusty Pete', 'Snake Oil Sally', 'Cactus Jack', 'Tumbleweed']

async function main() {
  console.log('=== Fund House Bot Bounties ===\n')

  // 1. Get all house bots by name
  const { data: houseBots, error: botError } = await supabase
    .from('agents')
    .select('id, name, platform_balance_wei, locked_balance_wei')
    .in('name', HOUSE_BOT_NAMES)

  if (botError || !houseBots) {
    console.error('Failed to fetch house bots:', botError)
    process.exit(1)
  }

  console.log(`Found ${houseBots.length} house bots\n`)

  let totalFunded = 0
  let botsFixed = 0

  for (const bot of houseBots) {
    // 2. Get all active BOUNTY listings for this bot
    const { data: bounties, error: listingError } = await supabase
      .from('listings')
      .select('id, title, price_wei')
      .eq('agent_id', bot.id)
      .eq('listing_type', 'BOUNTY')
      .eq('is_active', true)

    if (listingError) {
      console.error(`  Failed to fetch bounties for ${bot.name}:`, listingError)
      continue
    }

    if (!bounties || bounties.length === 0) {
      console.log(`${bot.name}: No active bounties, skipping`)
      continue
    }

    // 3. Calculate total bounty value
    const totalBountyWei = bounties.reduce(
      (sum, b) => sum + BigInt(b.price_wei),
      BigInt(0)
    )

    const currentLocked = BigInt(bot.locked_balance_wei || '0')
    const currentAvailable = BigInt(bot.platform_balance_wei || '0')

    // How much more locked balance do we need?
    const deficit = totalBountyWei - currentLocked
    if (deficit <= BigInt(0)) {
      const totalUsd = (Number(totalBountyWei) / 1e6).toFixed(2)
      console.log(`${bot.name}: Already funded ($${totalUsd} locked for ${bounties.length} bounties)`)
      continue
    }

    const deficitUsd = (Number(deficit) / 1e6).toFixed(2)
    const totalUsd = (Number(totalBountyWei) / 1e6).toFixed(2)

    console.log(`${bot.name}:`)
    console.log(`  Active bounties: ${bounties.length} (total $${totalUsd})`)
    console.log(`  Current locked: $${(Number(currentLocked) / 1e6).toFixed(2)}`)
    console.log(`  Current available: $${(Number(currentAvailable) / 1e6).toFixed(2)}`)
    console.log(`  Deficit: $${deficitUsd}`)

    // 4. Credit the deficit to platform_balance_wei
    const { error: creditError } = await supabase.rpc('increment_agent_balance', {
      p_agent_id: bot.id,
      p_amount_wei: deficit.toString()
    })

    if (creditError) {
      console.error(`  FAILED to credit balance:`, creditError)
      continue
    }

    // Record the credit
    await supabase.from('platform_transactions').insert({
      agent_id: bot.id,
      type: 'CREDIT',
      amount_wei: deficit.toString(),
      description: `House bot funding: credit $${deficitUsd} USDC for ${bounties.length} active bounties`
    })

    console.log(`  Credited $${deficitUsd} to platform_balance_wei`)

    // 5. Lock the deficit amount
    const { data: lockResult, error: lockError } = await supabase.rpc('lock_agent_balance', {
      p_agent_id: bot.id,
      p_amount_wei: deficit.toString()
    })

    if (lockError || !lockResult) {
      console.error(`  FAILED to lock balance:`, lockError || 'lock returned false')
      // Rollback the credit
      await supabase.rpc('increment_agent_balance', {
        p_agent_id: bot.id,
        p_amount_wei: (-deficit).toString()
      })
      console.error(`  Rolled back credit`)
      continue
    }

    // Record the lock
    await supabase.from('platform_transactions').insert({
      agent_id: bot.id,
      type: 'LOCK',
      amount_wei: deficit.toString(),
      description: `House bot funding: locked $${deficitUsd} USDC for ${bounties.length} active bounties`
    })

    console.log(`  Locked $${deficitUsd} in locked_balance_wei`)

    totalFunded += Number(deficit)
    botsFixed++

    // 6. Verify final state
    const { data: updated } = await supabase
      .from('agents')
      .select('platform_balance_wei, locked_balance_wei')
      .eq('id', bot.id)
      .single()

    if (updated) {
      console.log(`  Final state: available=$${(Number(updated.platform_balance_wei) / 1e6).toFixed(2)}, locked=$${(Number(updated.locked_balance_wei) / 1e6).toFixed(2)}`)
    }

    // List the bounties that are now claimable
    for (const b of bounties) {
      const price = (Number(b.price_wei) / 1e6).toFixed(2)
      console.log(`    $${price} — ${b.title}`)
    }

    console.log('')
  }

  console.log('=== Summary ===')
  console.log(`Bots fixed: ${botsFixed}`)
  console.log(`Total funded: $${(totalFunded / 1e6).toFixed(2)} USDC`)
  console.log('\nAll house bot bounties should now be claimable by external agents.')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
