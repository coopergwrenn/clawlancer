/**
 * Dispute Flow Test
 *
 * Simulates a disputed transaction:
 * PENDING → FUNDED → DELIVERED → DISPUTED → RESOLVED
 *
 * Run: npx tsx scripts/test-dispute-flow.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function createDisputedTransaction(): Promise<string> {
  // Get a house bot as seller
  const { data: seller } = await supabase
    .from('agents')
    .select('id, name')
    .eq('is_hosted', true)
    .limit(1)
    .single()

  if (!seller) {
    throw new Error('No house bot found')
  }

  // Create test buyer
  const { data: buyer } = await supabase
    .from('agents')
    .insert({
      name: `Dispute Test Buyer ${Date.now()}`,
      wallet_address: `0x${Math.random().toString(16).slice(2, 42).padEnd(40, '0')}`,
      owner_address: process.env.TREASURY_ADDRESS?.toLowerCase(),
      is_hosted: false,
    })
    .select('id, name')
    .single()

  if (!buyer) {
    throw new Error('Failed to create test buyer')
  }

  const escrowId = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`
  const deliverableHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`

  // Create transaction in DELIVERED state (ready to dispute)
  const { data: tx, error } = await supabase
    .from('transactions')
    .insert({
      buyer_agent_id: buyer.id,
      seller_agent_id: seller.id,
      listing_title: 'Dispute Test Transaction',
      price_wei: '5000000', // 5 USDC
      amount_wei: '5000000',
      currency: 'USDC',
      state: 'DELIVERED',
      contract_version: 2,
      escrow_id: escrowId,
      escrow_tx_hash: `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`,
      deliverable: 'This is the test deliverable that will be disputed',
      deliverable_hash: deliverableHash,
      delivered_at: new Date().toISOString(),
      dispute_window_hours: 24,
      funded_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    })
    .select()
    .single()

  if (error || !tx) {
    await supabase.from('agents').delete().eq('id', buyer.id)
    throw new Error(`Failed to create transaction: ${error?.message}`)
  }

  console.log(`Created test transaction: ${tx.id}`)
  console.log(`  State: DELIVERED (ready for dispute)`)
  console.log(`  Buyer: ${buyer.name}`)
  console.log(`  Seller: ${seller.name}`)

  return tx.id
}

async function simulateDispute(txId: string): Promise<void> {
  console.log('\n[STEP 2] Filing dispute...')

  const mockTxHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`

  const { error } = await supabase
    .from('transactions')
    .update({
      state: 'DISPUTED',
      disputed: true,
      disputed_at: new Date().toISOString(),
      dispute_reason: 'The deliverable did not match the listing description. Expected market analysis but received generic content.',
      dispute_tx_hash: mockTxHash,
    })
    .eq('id', txId)

  if (error) {
    throw new Error(`Failed to file dispute: ${error.message}`)
  }

  console.log(`  State: DISPUTED`)
  console.log(`  Reason: Quality dispute`)
}

async function simulateResolution(txId: string, releaseToSeller: boolean): Promise<void> {
  console.log(`\n[STEP 3] Resolving dispute (${releaseToSeller ? 'seller wins' : 'buyer wins'})...`)

  const mockTxHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`
  const resolution = releaseToSeller ? 'SELLER_WINS' : 'BUYER_WINS'
  const finalState = releaseToSeller ? 'RELEASED' : 'REFUNDED'

  // Get transaction for seller ID
  const { data: tx } = await supabase
    .from('transactions')
    .select('seller_agent_id, buyer_agent_id, escrow_id, amount_wei, currency, created_at')
    .eq('id', txId)
    .single()

  if (!tx) {
    throw new Error('Transaction not found')
  }

  // Update transaction
  const { error } = await supabase
    .from('transactions')
    .update({
      state: finalState,
      dispute_resolved_at: new Date().toISOString(),
      dispute_resolution: resolution,
      dispute_resolution_notes: 'Integration test resolution',
      dispute_resolved_by: process.env.TREASURY_ADDRESS?.toLowerCase(),
      completed_at: new Date().toISOString(),
    })
    .eq('id', txId)

  if (error) {
    throw new Error(`Failed to resolve dispute: ${error.message}`)
  }

  // Create reputation feedback based on outcome
  const outcome = releaseToSeller ? 'disputed_release' : 'disputed_refund'
  const rating = releaseToSeller ? 3 : 1
  const feedbackAgentId = releaseToSeller ? tx.seller_agent_id : tx.buyer_agent_id

  await supabase.from('reputation_feedback').insert({
    agent_id: feedbackAgentId,
    transaction_id: txId,
    rating,
    context: {
      transactionId: txId,
      escrowId: tx.escrow_id,
      txHash: mockTxHash,
      amount: tx.amount_wei,
      currency: tx.currency || 'USDC',
      completedAt: new Date().toISOString(),
      outcome,
      durationSeconds: Math.floor((Date.now() - new Date(tx.created_at).getTime()) / 1000),
    },
  })

  console.log(`  Resolution: ${resolution}`)
  console.log(`  Final state: ${finalState}`)
  console.log(`  Reputation impact: ${rating}/5 for ${releaseToSeller ? 'seller' : 'buyer'}`)
}

async function verifyDisputeState(txId: string): Promise<void> {
  console.log('\n[STEP 4] Verifying dispute state...')

  const { data: tx } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', txId)
    .single()

  if (!tx) {
    throw new Error('Transaction not found')
  }

  const checks = [
    { name: 'Was disputed', pass: tx.disputed === true },
    { name: 'Has dispute_reason', pass: !!tx.dispute_reason },
    { name: 'Has dispute_resolved_at', pass: !!tx.dispute_resolved_at },
    { name: 'Has dispute_resolution', pass: !!tx.dispute_resolution },
    { name: 'Final state is valid', pass: ['RELEASED', 'REFUNDED'].includes(tx.state) },
    { name: 'Has completed_at', pass: !!tx.completed_at },
  ]

  let allPassed = true
  for (const check of checks) {
    const status = check.pass ? '✅' : '❌'
    console.log(`  ${status} ${check.name}`)
    if (!check.pass) allPassed = false
  }

  // Check reputation feedback
  const { data: feedback } = await supabase
    .from('reputation_feedback')
    .select('rating')
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

  const { data: tx } = await supabase
    .from('transactions')
    .select('buyer_agent_id')
    .eq('id', txId)
    .single()

  await supabase.from('reputation_feedback').delete().eq('transaction_id', txId)
  await supabase.from('transactions').delete().eq('id', txId)

  if (tx?.buyer_agent_id) {
    await supabase.from('agents').delete().eq('id', tx.buyer_agent_id)
  }

  console.log('  Cleaned up test data')
}

async function main() {
  console.log('=== Dispute Flow Test (V2) ===\n')

  let txId: string | null = null

  try {
    // Step 1: Create transaction in DELIVERED state
    console.log('[STEP 1] Creating delivered transaction...')
    txId = await createDisputedTransaction()

    // Step 2: File dispute
    await simulateDispute(txId)

    // Step 3: Resolve (randomly pick winner for variety)
    const sellerWins = Math.random() > 0.5
    await simulateResolution(txId, sellerWins)

    // Step 4: Verify
    await verifyDisputeState(txId)

    console.log('\n✅ Dispute flow test PASSED!')
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
