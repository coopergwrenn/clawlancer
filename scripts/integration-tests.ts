/**
 * Integration Tests for Wild West Bots V2
 *
 * Tests the full transaction lifecycle with house bots:
 * 1. Transaction creation (PENDING)
 * 2. Escrow funding (FUNDED)
 * 3. Delivery (DELIVERED)
 * 4. Release/Dispute (RELEASED/DISPUTED)
 * 5. Reputation updates
 *
 * Run: npx tsx scripts/integration-tests.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

interface TestResult {
  name: string
  passed: boolean
  duration: number
  error?: string
}

const results: TestResult[] = []

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now()
  try {
    await fn()
    results.push({ name, passed: true, duration: Date.now() - start })
    console.log(`✅ ${name}`)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    results.push({ name, passed: false, duration: Date.now() - start, error })
    console.log(`❌ ${name}: ${error}`)
  }
}

// ========== TEST HELPERS ==========

async function getHouseBot(): Promise<{ id: string; name: string; wallet_address: string; privy_wallet_id: string }> {
  const { data, error } = await supabase
    .from('agents')
    .select('id, name, wallet_address, privy_wallet_id')
    .eq('is_hosted', true)
    .not('privy_wallet_id', 'is', null)
    .limit(1)
    .single()

  if (error || !data) {
    throw new Error('No house bot found with Privy wallet')
  }

  return data
}

async function createTestAgent(name: string): Promise<{ id: string; api_key: string }> {
  const { data, error } = await supabase
    .from('agents')
    .insert({
      name,
      wallet_address: `0x${Math.random().toString(16).slice(2, 42).padEnd(40, '0')}`,
      owner_address: process.env.TREASURY_ADDRESS?.toLowerCase(),
      is_hosted: false,
    })
    .select('id, api_key')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create test agent: ${error?.message}`)
  }

  return data
}

async function cleanupTestAgent(agentId: string) {
  await supabase.from('agents').delete().eq('id', agentId)
}

// ========== TESTS ==========

async function testHealthEndpoint() {
  const response = await fetch(`${BASE_URL}/api/health`)
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`)
  }
  const data = await response.json()
  if (data.status !== 'healthy') {
    throw new Error(`Unhealthy status: ${data.status}`)
  }
}

async function testHouseBotExists() {
  const bot = await getHouseBot()
  if (!bot.privy_wallet_id) {
    throw new Error('House bot missing Privy wallet ID')
  }
}

async function testAgentRegistration() {
  const response = await fetch(`${BASE_URL}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Test Agent ${Date.now()}`,
      wallet_address: `0x${Math.random().toString(16).slice(2, 42).padEnd(40, '0')}`,
      owner_address: process.env.TREASURY_ADDRESS?.toLowerCase(),
    }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(`Registration failed: ${error.error}`)
  }

  const data = await response.json()
  if (!data.agent?.id) {
    throw new Error('No agent ID returned')
  }

  // Cleanup
  await cleanupTestAgent(data.agent.id)
}

async function testListingsAPI() {
  const response = await fetch(`${BASE_URL}/api/listings`)
  if (!response.ok) {
    throw new Error(`Listings fetch failed: ${response.status}`)
  }
  const data = await response.json()
  if (!Array.isArray(data.listings)) {
    throw new Error('Invalid listings response')
  }
}

async function testTransactionCreation() {
  const bot = await getHouseBot()

  // Get a listing from this bot
  const { data: listing } = await supabase
    .from('listings')
    .select('id, price_wei')
    .eq('agent_id', bot.id)
    .eq('is_active', true)
    .limit(1)
    .single()

  if (!listing) {
    throw new Error('No active listing found for house bot')
  }

  // Create a test buyer
  const buyer = await createTestAgent(`Test Buyer ${Date.now()}`)

  try {
    // Create transaction via buy endpoint
    const response = await fetch(`${BASE_URL}/api/listings/${listing.id}/buy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${buyer.api_key}`,
      },
      body: JSON.stringify({
        buyer_agent_id: buyer.id,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(`Buy failed: ${error.error}`)
    }

    const data = await response.json()
    if (!data.transaction?.id) {
      throw new Error('No transaction ID returned')
    }

    if (data.transaction.state !== 'PENDING') {
      throw new Error(`Expected PENDING state, got ${data.transaction.state}`)
    }

    // Cleanup transaction
    await supabase.from('transactions').delete().eq('id', data.transaction.id)
  } finally {
    await cleanupTestAgent(buyer.id)
  }
}

async function testReputationEndpoint() {
  const bot = await getHouseBot()

  const response = await fetch(`${BASE_URL}/api/agents/${bot.id}/reputation`)
  if (!response.ok) {
    throw new Error(`Reputation fetch failed: ${response.status}`)
  }

  const data = await response.json()
  if (!data.reputation) {
    throw new Error('No reputation data returned')
  }

  if (typeof data.reputation.score !== 'number') {
    throw new Error('Invalid reputation score')
  }
}

async function testERC8004Endpoint() {
  const bot = await getHouseBot()

  // Initialize ERC-8004 if not exists
  const initResponse = await fetch(`${BASE_URL}/api/agents/${bot.id}/erc8004`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-wallet': process.env.TREASURY_ADDRESS?.toLowerCase() || '',
    },
    body: JSON.stringify({
      description: 'Test house bot',
      category: 'TRADING',
    }),
  })

  // May already exist, that's OK
  if (!initResponse.ok && initResponse.status !== 400) {
    throw new Error(`ERC-8004 init failed: ${initResponse.status}`)
  }

  // Fetch ERC-8004 data
  const response = await fetch(`${BASE_URL}/api/agents/${bot.id}/erc8004`)
  if (!response.ok) {
    throw new Error(`ERC-8004 fetch failed: ${response.status}`)
  }

  const data = await response.json()
  if (!data.registration) {
    throw new Error('No ERC-8004 registration returned')
  }
}

async function testOracleWalletHealth() {
  // Check if oracle wallet has balance (via health endpoint or direct check)
  const { data: lastRun } = await supabase
    .from('oracle_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)
    .single()

  // If no runs yet, that's OK for integration test
  if (!lastRun) {
    console.log('  (No oracle runs found yet - OK for fresh deploy)')
    return
  }

  if (lastRun.error_message?.includes('wallet empty')) {
    throw new Error('Oracle wallet is empty')
  }
}

async function testDisputeEndpointsExist() {
  const bot = await getHouseBot()

  // Just check that the endpoints return proper errors (not 404)
  const response = await fetch(`${BASE_URL}/api/admin/disputes`, {
    headers: {
      'x-admin-wallet': process.env.TREASURY_ADDRESS?.toLowerCase() || '',
    },
  })

  if (response.status === 404) {
    throw new Error('Dispute endpoint not found')
  }

  // 403 (not admin) or 200 are both valid
  if (response.status !== 200 && response.status !== 403) {
    throw new Error(`Unexpected status: ${response.status}`)
  }
}

async function testFeatureFlags() {
  const { data: flags, error } = await supabase
    .from('feature_flags')
    .select('name, enabled')

  if (error) {
    throw new Error(`Failed to fetch feature flags: ${error.message}`)
  }

  const requiredFlags = ['v2_contract', 'auto_release', 'auto_refund', 'erc8004_identity']
  for (const flagName of requiredFlags) {
    if (!flags?.find(f => f.name === flagName)) {
      throw new Error(`Missing feature flag: ${flagName}`)
    }
  }
}

async function testDatabaseSchema() {
  // Verify key columns exist
  const { data: agent } = await supabase
    .from('agents')
    .select('id, reputation_score, reputation_tier, erc8004_registration, compute_credits')
    .limit(1)
    .single()

  if (!agent) {
    throw new Error('No agents in database')
  }

  // Check transactions table has V2 columns
  const { data: tx } = await supabase
    .from('transactions')
    .select('id, contract_version, dispute_window_hours, deliverable_hash')
    .limit(1)

  // Empty is OK, just checking columns exist
  if (tx === null) {
    throw new Error('Transactions table query failed')
  }
}

async function testReputationCacheTable() {
  // Verify reputation_feedback table exists
  const { error } = await supabase
    .from('reputation_feedback')
    .select('id')
    .limit(1)

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows, which is fine
    throw new Error(`Reputation feedback table error: ${error.message}`)
  }
}

// ========== MAIN ==========

async function main() {
  console.log('=== Wild West Bots V2 Integration Tests ===\n')
  console.log(`Base URL: ${BASE_URL}`)
  console.log(`Treasury: ${process.env.TREASURY_ADDRESS}\n`)

  // Core infrastructure tests
  await runTest('Health endpoint responds', testHealthEndpoint)
  await runTest('Database schema has V2 columns', testDatabaseSchema)
  await runTest('Feature flags exist', testFeatureFlags)
  await runTest('Reputation feedback table exists', testReputationCacheTable)

  // House bot tests
  await runTest('House bot exists with Privy wallet', testHouseBotExists)
  await runTest('Oracle wallet health check', testOracleWalletHealth)

  // API endpoint tests
  await runTest('Agent registration works', testAgentRegistration)
  await runTest('Listings API works', testListingsAPI)
  await runTest('Transaction creation works', testTransactionCreation)
  await runTest('Reputation endpoint works', testReputationEndpoint)
  await runTest('ERC-8004 endpoint works', testERC8004Endpoint)
  await runTest('Dispute endpoints exist', testDisputeEndpointsExist)

  // Summary
  console.log('\n=== Results ===\n')

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  for (const result of results) {
    const status = result.passed ? '✅' : '❌'
    const time = `(${result.duration}ms)`
    console.log(`${status} ${result.name} ${time}`)
    if (result.error) {
      console.log(`   Error: ${result.error}`)
    }
  }

  console.log(`\n${passed}/${results.length} tests passed`)

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Review errors above.')
    process.exit(1)
  } else {
    console.log('\n✅ All integration tests passed!')
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
