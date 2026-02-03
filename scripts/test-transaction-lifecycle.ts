/**
 * Transaction Lifecycle Test
 *
 * Simulates a complete V2 transaction flow:
 * PENDING → FUNDED → DELIVERED → RELEASED
 *
 * This test mocks on-chain calls since we can't actually
 * execute transactions without real funds.
 *
 * Run: npx tsx scripts/test-transaction-lifecycle.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface TestTransaction {
  id: string
  state: string
  escrow_id: string | null
  contract_version: number
}

async function createTestTransaction(): Promise<TestTransaction> {
  // Get a house bot as seller
  const { data: seller } = await supabase
    .from('agents')
    .select('id, name, wallet_address')
    .eq('is_hosted', true)
    .limit(1)
    .single()

  if (!seller) {
    throw new Error('No house bot found for seller')
  }

  // Create a test buyer
  const { data: buyer } = await supabase
    .from('agents')
    .insert({
      name: `Test Buyer ${Date.now()}`,
      wallet_address: `0x${Math.random().toString(16).slice(2, 42).padEnd(40, '0')}`,
      owner_address: process.env.TREASURY_ADDRESS?.toLowerCase(),
      is_hosted: false,
    })
    .select('id, name')
    .single()

  if (!buyer) {
    throw new Error('Failed to create test buyer')
  }

  // Create transaction
  const escrowId = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`

  const { data: tx, error } = await supabase
    .from('transactions')
    .insert({
      buyer_agent_id: buyer.id,
      seller_agent_id: seller.id,
      listing_title: 'Test Transaction',
      price_wei: '1000000', // 1 USDC
      amount_wei: '1000000',
      currency: 'USDC',
      state: 'PENDING',
      contract_version: 2,
      escrow_id: escrowId,
      dispute_window_hours: 24,
    })
    .select()
    .single()

  if (error || !tx) {
    // Cleanup buyer
    await supabase.from('agents').delete().eq('id', buyer.id)
    throw new Error(`Failed to create transaction: ${error?.message}`)
  }

  console.log(`Created test transaction: ${tx.id}`)
  console.log(`  Buyer: ${buyer.name}`)
  console.log(`  Seller: ${seller.name}`)
  console.log(`  Escrow ID: ${escrowId}`)

  return {
    id: tx.id,
    state: tx.state,
    escrow_id: tx.escrow_id,
    contract_version: tx.contract_version,
  }
}

async function simulateFunding(txId: string): Promise<void> {
  console.log('\n[STEP 2] Simulating escrow funding...')

  const mockTxHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`

  const { error } = await supabase
    .from('transactions')
    .update({
      state: 'FUNDED',
      escrow_tx_hash: mockTxHash,
      funded_at: new Date().toISOString(),
    })
    .eq('id', txId)

  if (error) {
    throw new Error(`Failed to update to FUNDED: ${error.message}`)
  }

  console.log(`  State: FUNDED`)
  console.log(`  Mock tx_hash: ${mockTxHash.slice(0, 20)}...`)
}

async function simulateDelivery(txId: string): Promise<void> {
  console.log('\n[STEP 3] Simulating delivery...')

  const deliverableHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`
  const mockTxHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`

  const { error } = await supabase
    .from('transactions')
    .update({
      state: 'DELIVERED',
      deliverable: 'Test deliverable content - integration test',
      deliverable_hash: deliverableHash,
      deliver_tx_hash: mockTxHash,
      delivered_at: new Date().toISOString(),
    })
    .eq('id', txId)

  if (error) {
    throw new Error(`Failed to update to DELIVERED: ${error.message}`)
  }

  console.log(`  State: DELIVERED`)
  console.log(`  Deliverable hash: ${deliverableHash.slice(0, 20)}...`)
}

async function simulateRelease(txId: string): Promise<void> {
  console.log('\n[STEP 4] Simulating release...')

  const mockTxHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`

  // Get transaction for seller ID
  const { data: tx } = await supabase
    .from('transactions')
    .select('seller_agent_id, escrow_id, amount_wei, currency, created_at, deliverable_hash')
    .eq('id', txId)
    .single()

  if (!tx) {
    throw new Error('Transaction not found')
  }

  // Update transaction
  const { error } = await supabase
    .from('transactions')
    .update({
      state: 'RELEASED',
      release_tx_hash: mockTxHash,
      completed_at: new Date().toISOString(),
    })
    .eq('id', txId)

  if (error) {
    throw new Error(`Failed to update to RELEASED: ${error.message}`)
  }

  // Create reputation feedback
  const { error: feedbackError } = await supabase
    .from('reputation_feedback')
    .insert({
      agent_id: tx.seller_agent_id,
      transaction_id: txId,
      rating: 5, // Successful completion
      context: {
        transactionId: txId,
        escrowId: tx.escrow_id,
        txHash: mockTxHash,
        amount: tx.amount_wei,
        currency: tx.currency || 'USDC',
        completedAt: new Date().toISOString(),
        outcome: 'released',
        durationSeconds: Math.floor((Date.now() - new Date(tx.created_at).getTime()) / 1000),
        deliverableHash: tx.deliverable_hash,
      },
    })

  if (feedbackError) {
    console.log(`  Warning: Failed to create feedback: ${feedbackError.message}`)
  } else {
    console.log(`  Created reputation feedback`)
  }

  console.log(`  State: RELEASED`)
  console.log(`  Mock tx_hash: ${mockTxHash.slice(0, 20)}...`)
}

async function verifyFinalState(txId: string): Promise<void> {
  console.log('\n[STEP 5] Verifying final state...')

  const { data: tx } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', txId)
    .single()

  if (!tx) {
    throw new Error('Transaction not found')
  }

  const checks = [
    { name: 'State is RELEASED', pass: tx.state === 'RELEASED' },
    { name: 'Has escrow_tx_hash', pass: !!tx.escrow_tx_hash },
    { name: 'Has deliver_tx_hash', pass: !!tx.deliver_tx_hash },
    { name: 'Has release_tx_hash', pass: !!tx.release_tx_hash },
    { name: 'Has deliverable_hash', pass: !!tx.deliverable_hash },
    { name: 'Has completed_at', pass: !!tx.completed_at },
    { name: 'Contract version is 2', pass: tx.contract_version === 2 },
  ]

  let allPassed = true
  for (const check of checks) {
    const status = check.pass ? '✅' : '❌'
    console.log(`  ${status} ${check.name}`)
    if (!check.pass) allPassed = false
  }

  // Check reputation feedback was created
  const { data: feedback } = await supabase
    .from('reputation_feedback')
    .select('rating, context')
    .eq('transaction_id', txId)
    .single()

  if (feedback) {
    console.log(`  ✅ Reputation feedback exists (rating: ${feedback.rating})`)
  } else {
    console.log(`  ❌ No reputation feedback found`)
    allPassed = false
  }

  if (!allPassed) {
    throw new Error('Some verification checks failed')
  }
}

async function cleanup(txId: string): Promise<void> {
  console.log('\n[CLEANUP] Removing test data...')

  // Get buyer ID
  const { data: tx } = await supabase
    .from('transactions')
    .select('buyer_agent_id')
    .eq('id', txId)
    .single()

  // Delete feedback
  await supabase.from('reputation_feedback').delete().eq('transaction_id', txId)

  // Delete transaction
  await supabase.from('transactions').delete().eq('id', txId)

  // Delete test buyer
  if (tx?.buyer_agent_id) {
    await supabase.from('agents').delete().eq('id', tx.buyer_agent_id)
  }

  console.log('  Cleaned up test data')
}

async function main() {
  console.log('=== Transaction Lifecycle Test (V2) ===\n')

  let txId: string | null = null

  try {
    // Step 1: Create transaction
    console.log('[STEP 1] Creating test transaction...')
    const tx = await createTestTransaction()
    txId = tx.id

    // Step 2: Fund
    await simulateFunding(txId)

    // Step 3: Deliver
    await simulateDelivery(txId)

    // Step 4: Release
    await simulateRelease(txId)

    // Step 5: Verify
    await verifyFinalState(txId)

    console.log('\n✅ Transaction lifecycle test PASSED!')
  } catch (err) {
    console.error('\n❌ Test FAILED:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    if (txId) {
      await cleanup(txId)
    }
  }
}

main().catch(console.error)
