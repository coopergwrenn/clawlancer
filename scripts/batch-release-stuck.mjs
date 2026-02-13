/**
 * Batch Release Stuck DELIVERED Transactions
 *
 * One-time script to release 79 oracle-funded transactions stuck in DELIVERED
 * state due to the updated_at bug + safeOracleRelease rejecting FUNDED on-chain state.
 *
 * Uses the admin oracle release API endpoint which correctly handles FUNDED escrows.
 *
 * Run with: node scripts/batch-release-stuck.mjs
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

const API_BASE = 'http://localhost:3000'
const CRON_SECRET = process.env.CRON_SECRET
const DELAY_MS = 2500 // 2.5 seconds between transactions

async function callRelease(transactionId) {
  const res = await fetch(`${API_BASE}/api/admin/oracle/release/${transactionId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  const data = await res.json()
  return { status: res.status, ...data }
}

async function main() {
  console.log('=== Batch Release Stuck DELIVERED Transactions ===\n')

  // Get all stuck transactions
  const { data: stuck, error } = await supabase
    .from('transactions')
    .select('id, escrow_id, amount_wei, listing_title, seller_agent_id, delivered_at')
    .eq('state', 'DELIVERED')
    .eq('contract_version', 2)
    .eq('oracle_funded', true)
    .is('release_tx_hash', null)
    .order('delivered_at', { ascending: true })

  if (error) {
    console.error('Query error:', error)
    process.exit(1)
  }

  if (!stuck || stuck.length === 0) {
    console.log('No stuck transactions found.')
    return
  }

  console.log(`Found ${stuck.length} stuck transactions\n`)

  const results = {
    released: [],
    alreadyReleased: [],
    failed: [],
  }

  let totalReleasedWei = BigInt(0)

  for (let i = 0; i < stuck.length; i++) {
    const tx = stuck[i]
    const price = (Number(tx.amount_wei) / 1e6).toFixed(4)
    const title = (tx.listing_title || '').slice(0, 50)

    process.stdout.write(`[${i + 1}/${stuck.length}] $${price} "${title}" ... `)

    try {
      const result = await callRelease(tx.id)

      if (result.success) {
        if (result.already_released) {
          results.alreadyReleased.push({ id: tx.id, amount: tx.amount_wei })
          totalReleasedWei += BigInt(tx.amount_wei)
          console.log(`ALREADY RELEASED`)
        } else {
          results.released.push({ id: tx.id, amount: tx.amount_wei, txHash: result.tx_hash })
          totalReleasedWei += BigInt(tx.amount_wei)
          console.log(`RELEASED ${result.tx_hash}`)
        }
      } else {
        results.failed.push({ id: tx.id, amount: tx.amount_wei, error: result.error })
        console.log(`FAILED: ${result.error}`)
      }
    } catch (err) {
      results.failed.push({ id: tx.id, amount: tx.amount_wei, error: err.message })
      console.log(`ERROR: ${err.message}`)
    }

    // Delay between transactions to avoid nonce issues
    if (i < stuck.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS))
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===')
  console.log(`Total processed: ${stuck.length}`)
  console.log(`Released on-chain: ${results.released.length}`)
  console.log(`Already released: ${results.alreadyReleased.length}`)
  console.log(`Failed: ${results.failed.length}`)
  console.log(`Total USDC released: $${(Number(totalReleasedWei) / 1e6).toFixed(4)}`)

  if (results.released.length > 0) {
    console.log('\n--- TX Hashes ---')
    for (const r of results.released) {
      console.log(`  ${r.txHash}  ($${(Number(r.amount) / 1e6).toFixed(4)})`)
    }
  }

  if (results.failed.length > 0) {
    console.log('\n--- Failures ---')
    for (const f of results.failed) {
      console.log(`  ${f.id}: ${f.error}`)
    }
  }

  // Check remaining stuck
  const { data: remaining } = await supabase
    .from('transactions')
    .select('id')
    .eq('state', 'DELIVERED')
    .eq('contract_version', 2)
    .eq('oracle_funded', true)
    .is('release_tx_hash', null)

  console.log(`\nRemaining stuck DELIVERED: ${remaining?.length || 0}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
