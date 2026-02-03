/**
 * End-to-End Test Suite
 *
 * Simulates complete user flows through the system:
 * 1. Agent registration and setup
 * 2. Listing creation
 * 3. Purchase flow (buyer → seller)
 * 4. Complete transaction lifecycle
 * 5. Reputation updates
 * 6. ERC-8004 registration
 *
 * Run: npx tsx scripts/e2e-test.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

interface E2EContext {
  seller?: { id: string; api_key: string; name: string }
  buyer?: { id: string; api_key: string; name: string }
  listing?: { id: string; title: string; price_wei: string }
  transaction?: { id: string; state: string }
}

const ctx: E2EContext = {}

// ========== E2E SCENARIOS ==========

async function scenario1_AgentRegistration(): Promise<void> {
  console.log('\n📋 Scenario 1: Agent Registration\n')

  // Register seller
  console.log('  Creating seller agent...')
  const sellerRes = await fetch(`${BASE_URL}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_name: `E2E Seller ${Date.now()}`,
      wallet_address: `0x${Math.random().toString(16).slice(2, 42).padEnd(40, '0')}`,
    }),
  })

  if (!sellerRes.ok) {
    throw new Error(`Seller registration failed: ${await sellerRes.text()}`)
  }

  const sellerData = await sellerRes.json()
  ctx.seller = {
    id: sellerData.agent.id,
    api_key: sellerData.api_key, // api_key is at root level
    name: sellerData.agent.name,
  }
  console.log(`  ✅ Seller created: ${ctx.seller.name}`)

  // Register buyer
  console.log('  Creating buyer agent...')
  const buyerRes = await fetch(`${BASE_URL}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_name: `E2E Buyer ${Date.now()}`,
      wallet_address: `0x${Math.random().toString(16).slice(2, 42).padEnd(40, '0')}`,
    }),
  })

  if (!buyerRes.ok) {
    throw new Error(`Buyer registration failed: ${await buyerRes.text()}`)
  }

  const buyerData = await buyerRes.json()
  ctx.buyer = {
    id: buyerData.agent.id,
    api_key: buyerData.api_key, // api_key is at root level
    name: buyerData.agent.name,
  }
  console.log(`  ✅ Buyer created: ${ctx.buyer.name}`)
}

async function scenario2_ListingCreation(): Promise<void> {
  console.log('\n📋 Scenario 2: Listing Creation\n')

  if (!ctx.seller) throw new Error('Seller not created')

  console.log('  Creating listing...')
  const res = await fetch(`${BASE_URL}/api/listings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ctx.seller.api_key}`,
    },
    body: JSON.stringify({
      agent_id: ctx.seller.id,
      title: 'E2E Test Service',
      description: 'This is an end-to-end test listing for integration testing',
      category: 'other',
      price_wei: '2000000', // 2 USDC
      currency: 'USDC',
    }),
  })

  if (!res.ok) {
    throw new Error(`Listing creation failed: ${await res.text()}`)
  }

  const data = await res.json()
  ctx.listing = {
    id: data.id,
    title: data.title,
    price_wei: data.price_wei,
  }
  console.log(`  ✅ Listing created: ${ctx.listing.title} ($${parseInt(ctx.listing.price_wei) / 1e6} USDC)`)

  // Verify listing appears in marketplace
  console.log('  Verifying listing in marketplace...')
  const listingsRes = await fetch(`${BASE_URL}/api/listings`)
  const listings = await listingsRes.json()

  const found = listings.listings?.find((l: { id: string }) => l.id === ctx.listing?.id)
  if (!found) {
    throw new Error('Listing not found in marketplace')
  }
  console.log(`  ✅ Listing visible in marketplace`)
}

async function scenario3_PurchaseFlow(): Promise<void> {
  console.log('\n📋 Scenario 3: Purchase Flow\n')

  if (!ctx.buyer || !ctx.listing) throw new Error('Missing buyer or listing')

  console.log('  Initiating purchase...')
  const res = await fetch(`${BASE_URL}/api/listings/${ctx.listing.id}/buy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ctx.buyer.api_key}`,
    },
    body: JSON.stringify({
      buyer_agent_id: ctx.buyer.id,
    }),
  })

  if (!res.ok) {
    throw new Error(`Purchase failed: ${await res.text()}`)
  }

  const data = await res.json()
  ctx.transaction = {
    id: data.transaction_id,
    state: data.state,
  }
  console.log(`  ✅ Transaction created: ${ctx.transaction.id}`)
  console.log(`  ✅ Initial state: ${ctx.transaction.state}`)

  // External agents without Privy wallet get PENDING state (need to fund on-chain)
  if (ctx.transaction.state !== 'PENDING') {
    throw new Error(`Expected PENDING state, got ${ctx.transaction.state}`)
  }
}

async function scenario4_TransactionLifecycle(): Promise<void> {
  console.log('\n📋 Scenario 4: Transaction Lifecycle (V2)\n')

  if (!ctx.transaction) throw new Error('No transaction')

  // Simulate funding (in real flow, buyer funds on-chain)
  console.log('  Simulating escrow funding...')
  const escrowId = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`

  await supabase
    .from('transactions')
    .update({
      state: 'FUNDED',
      escrow_id: escrowId,
      escrow_tx_hash: `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`,
      contract_version: 2,
      dispute_window_hours: 24,
      funded_at: new Date().toISOString(),
    })
    .eq('id', ctx.transaction.id)

  ctx.transaction.state = 'FUNDED'
  console.log(`  ✅ State: FUNDED`)

  // Simulate delivery
  console.log('  Simulating delivery...')
  const deliverableHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`

  await supabase
    .from('transactions')
    .update({
      state: 'DELIVERED',
      deliverable: 'E2E test deliverable content - the service has been completed',
      deliverable_hash: deliverableHash,
      deliver_tx_hash: `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`,
      delivered_at: new Date().toISOString(),
    })
    .eq('id', ctx.transaction.id)

  ctx.transaction.state = 'DELIVERED'
  console.log(`  ✅ State: DELIVERED`)
  console.log(`  ✅ Deliverable hash: ${deliverableHash.slice(0, 20)}...`)

  // Simulate release
  console.log('  Simulating release...')
  const releaseTxHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, '0')}`

  await supabase
    .from('transactions')
    .update({
      state: 'RELEASED',
      release_tx_hash: releaseTxHash,
      completed_at: new Date().toISOString(),
    })
    .eq('id', ctx.transaction.id)

  ctx.transaction.state = 'RELEASED'
  console.log(`  ✅ State: RELEASED`)
  console.log(`  ✅ Release tx: ${releaseTxHash.slice(0, 20)}...`)
}

async function scenario5_ReputationUpdate(): Promise<void> {
  console.log('\n📋 Scenario 5: Reputation Update\n')

  if (!ctx.seller || !ctx.transaction) throw new Error('Missing context')

  // Create reputation feedback
  console.log('  Creating reputation feedback...')
  const { error } = await supabase.from('reputation_feedback').insert({
    agent_id: ctx.seller.id,
    transaction_id: ctx.transaction.id,
    rating: 5,
    context: {
      transactionId: ctx.transaction.id,
      outcome: 'released',
      completedAt: new Date().toISOString(),
    },
  })

  if (error) {
    throw new Error(`Failed to create feedback: ${error.message}`)
  }
  console.log(`  ✅ Reputation feedback created (rating: 5)`)

  // Check reputation endpoint
  console.log('  Fetching reputation...')
  const res = await fetch(`${BASE_URL}/api/agents/${ctx.seller.id}/reputation`)

  if (!res.ok) {
    throw new Error(`Reputation fetch failed: ${res.status}`)
  }

  const data = await res.json()
  console.log(`  ✅ Reputation score: ${data.reputation?.score || 'N/A'}`)
  console.log(`  ✅ Reputation tier: ${data.reputation?.tier || 'NEW'}`)
}

async function scenario6_ERC8004Registration(): Promise<void> {
  console.log('\n📋 Scenario 6: ERC-8004 Registration\n')

  if (!ctx.seller) throw new Error('No seller')

  // The ERC-8004 system auto-creates registration from agent data via GET
  // No POST required - just verify the default registration works
  console.log('  Fetching ERC-8004 registration (auto-created from agent data)...')
  const res = await fetch(`${BASE_URL}/api/agents/${ctx.seller.id}/erc8004`)

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ERC-8004 fetch failed: ${res.status} - ${text}`)
  }

  const data = await res.json()
  console.log(`  ✅ Registration name: ${data.registration?.name || 'N/A'}`)
  const wallet = data.registration?.agentWallet || data.registration?.agent_wallet || 'N/A'
  console.log(`  ✅ Agent wallet: ${typeof wallet === 'string' ? wallet.slice(0, 20) : 'N/A'}...`)
  console.log(`  ✅ Chain status: ${data.registration?.chainStatus?.chain || 'local'}`)

  // Fetch token metadata format
  console.log('  Fetching token metadata format...')
  const tokenRes = await fetch(`${BASE_URL}/api/agents/${ctx.seller.id}/erc8004?format=token`)
  if (tokenRes.ok) {
    const tokenData = await tokenRes.json()
    console.log(`  ✅ Token metadata available (${tokenData.attributes?.length || 0} attributes)`)
  } else {
    console.log(`  ⚠️ Token metadata not available`)
  }
}

async function cleanup(): Promise<void> {
  console.log('\n🧹 Cleanup\n')

  if (ctx.transaction) {
    await supabase.from('reputation_feedback').delete().eq('transaction_id', ctx.transaction.id)
    await supabase.from('transactions').delete().eq('id', ctx.transaction.id)
    console.log('  Deleted transaction and feedback')
  }

  if (ctx.listing) {
    await supabase.from('listings').delete().eq('id', ctx.listing.id)
    console.log('  Deleted listing')
  }

  if (ctx.seller) {
    await supabase.from('agents').delete().eq('id', ctx.seller.id)
    console.log('  Deleted seller agent')
  }

  if (ctx.buyer) {
    await supabase.from('agents').delete().eq('id', ctx.buyer.id)
    console.log('  Deleted buyer agent')
  }
}

// ========== MAIN ==========

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║           Wild West Bots V2 - E2E Test Suite             ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log(`\nBase URL: ${BASE_URL}`)

  const scenarios = [
    { name: 'Agent Registration', fn: scenario1_AgentRegistration },
    { name: 'Listing Creation', fn: scenario2_ListingCreation },
    { name: 'Purchase Flow', fn: scenario3_PurchaseFlow },
    { name: 'Transaction Lifecycle', fn: scenario4_TransactionLifecycle },
    { name: 'Reputation Update', fn: scenario5_ReputationUpdate },
    { name: 'ERC-8004 Registration', fn: scenario6_ERC8004Registration },
  ]

  const results: Array<{ name: string; passed: boolean; error?: string }> = []

  for (const scenario of scenarios) {
    try {
      await scenario.fn()
      results.push({ name: scenario.name, passed: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.log(`\n  ❌ FAILED: ${error}`)
      results.push({ name: scenario.name, passed: false, error })
      break // Stop on first failure for E2E
    }
  }

  await cleanup()

  // Summary
  console.log('\n' + '═'.repeat(60))
  console.log('E2E TEST RESULTS')
  console.log('═'.repeat(60) + '\n')

  for (const result of results) {
    const status = result.passed ? '✅ PASSED' : '❌ FAILED'
    console.log(`  ${status}  ${result.name}`)
    if (result.error) {
      console.log(`           Error: ${result.error}`)
    }
  }

  const passed = results.filter(r => r.passed).length
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${passed}/${scenarios.length} scenarios passed`)
  console.log('─'.repeat(60) + '\n')

  if (passed < scenarios.length) {
    console.log('❌ E2E tests failed')
    process.exit(1)
  } else {
    console.log('✅ All E2E tests passed!')
  }
}

main().catch(err => {
  console.error('\nFatal error:', err)
  cleanup().finally(() => process.exit(1))
})
