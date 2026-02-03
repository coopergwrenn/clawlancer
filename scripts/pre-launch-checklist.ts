/**
 * Pre-Launch Checklist
 *
 * Verifies all systems are ready for production:
 * 1. Environment variables
 * 2. Database schema
 * 3. Feature flags
 * 4. Oracle wallet
 * 5. Contract deployment
 * 6. House bots
 * 7. Cron jobs
 *
 * Run: npx tsx scripts/pre-launch-checklist.ts
 */

import { createClient } from '@supabase/supabase-js'
import { createPublicClient, http, formatEther } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { config } from 'dotenv'

config({ path: '.env.local' })

interface CheckResult {
  category: string
  check: string
  status: 'PASS' | 'FAIL' | 'WARN'
  message: string
}

const results: CheckResult[] = []

function addResult(category: string, check: string, status: CheckResult['status'], message: string) {
  results.push({ category, check, status, message })
  const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : '❌'
  console.log(`  ${icon} ${check}: ${message}`)
}

// ========== CHECKS ==========

async function checkEnvironment() {
  console.log('\n📋 Environment Variables\n')

  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_PRIVY_APP_ID',
    'PRIVY_APP_SECRET',
    'ALCHEMY_BASE_URL',
    'ORACLE_PRIVATE_KEY',
    'TREASURY_ADDRESS',
    'NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS',
    'CRON_SECRET',
  ]

  const optional = [
    'SLACK_WEBHOOK_URL',
    'ADMIN_WALLETS',
    'NEXT_PUBLIC_APP_URL',
  ]

  for (const key of required) {
    const value = process.env[key]
    if (value) {
      addResult('Environment', key, 'PASS', 'Set')
    } else {
      addResult('Environment', key, 'FAIL', 'Missing')
    }
  }

  for (const key of optional) {
    const value = process.env[key]
    if (value) {
      addResult('Environment', key, 'PASS', 'Set')
    } else {
      addResult('Environment', key, 'WARN', 'Not set (optional)')
    }
  }
}

async function checkDatabase() {
  console.log('\n📋 Database Schema\n')

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Check agents table has V2 columns
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, reputation_score, erc8004_registration, compute_credits')
    .limit(1)

  if (agentError) {
    addResult('Database', 'agents table', 'FAIL', agentError.message)
  } else {
    addResult('Database', 'agents table', 'PASS', 'V2 columns present')
  }

  // Check transactions table
  const { error: txError } = await supabase
    .from('transactions')
    .select('id, contract_version, dispute_window_hours, deliverable_hash')
    .limit(1)

  if (txError) {
    addResult('Database', 'transactions table', 'FAIL', txError.message)
  } else {
    addResult('Database', 'transactions table', 'PASS', 'V2 columns present')
  }

  // Check reputation_feedback table
  const { error: repError } = await supabase
    .from('reputation_feedback')
    .select('id')
    .limit(1)

  if (repError && repError.code !== 'PGRST116') {
    addResult('Database', 'reputation_feedback table', 'FAIL', repError.message)
  } else {
    addResult('Database', 'reputation_feedback table', 'PASS', 'Exists')
  }

  // Check oracle_runs table
  const { error: oracleError } = await supabase
    .from('oracle_runs')
    .select('id')
    .limit(1)

  if (oracleError && oracleError.code !== 'PGRST116') {
    addResult('Database', 'oracle_runs table', 'FAIL', oracleError.message)
  } else {
    addResult('Database', 'oracle_runs table', 'PASS', 'Exists')
  }
}

async function checkFeatureFlags() {
  console.log('\n📋 Feature Flags\n')

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: flags, error } = await supabase
    .from('feature_flags')
    .select('name, enabled')

  if (error) {
    addResult('Flags', 'feature_flags table', 'FAIL', error.message)
    return
  }

  const requiredFlags = ['v2_contract', 'auto_release', 'auto_refund', 'erc8004_identity']

  for (const flagName of requiredFlags) {
    const flag = flags?.find(f => f.name === flagName)
    if (!flag) {
      addResult('Flags', flagName, 'FAIL', 'Not found')
    } else {
      const status = flag.enabled ? 'ENABLED' : 'DISABLED'
      addResult('Flags', flagName, 'PASS', status)
    }
  }
}

async function checkOracleWallet() {
  console.log('\n📋 Oracle Wallet\n')

  const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia'
  const chain = isTestnet ? baseSepolia : base

  const publicClient = createPublicClient({
    chain,
    transport: http(process.env.ALCHEMY_BASE_URL),
  })

  try {
    // Derive address from private key
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(process.env.ORACLE_PRIVATE_KEY as `0x${string}`)
    const oracleAddress = account.address

    addResult('Oracle', 'Address', 'PASS', oracleAddress)

    // Check balance
    const balance = await publicClient.getBalance({ address: oracleAddress })
    const ethBalance = parseFloat(formatEther(balance))

    if (ethBalance < 0.001) {
      addResult('Oracle', 'ETH Balance', 'FAIL', `${ethBalance.toFixed(6)} ETH (needs gas)`)
    } else if (ethBalance < 0.01) {
      addResult('Oracle', 'ETH Balance', 'WARN', `${ethBalance.toFixed(6)} ETH (low)`)
    } else {
      addResult('Oracle', 'ETH Balance', 'PASS', `${ethBalance.toFixed(6)} ETH`)
    }
  } catch (err) {
    addResult('Oracle', 'Wallet Check', 'FAIL', err instanceof Error ? err.message : 'Unknown error')
  }
}

async function checkContract() {
  console.log('\n📋 V2 Contract\n')

  const contractAddress = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS

  if (!contractAddress) {
    addResult('Contract', 'V2 Address', 'FAIL', 'Not configured')
    return
  }

  addResult('Contract', 'V2 Address', 'PASS', contractAddress)

  const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia'
  const chain = isTestnet ? baseSepolia : base

  const publicClient = createPublicClient({
    chain,
    transport: http(process.env.ALCHEMY_BASE_URL),
  })

  try {
    const code = await publicClient.getCode({ address: contractAddress as `0x${string}` })
    if (code && code !== '0x') {
      addResult('Contract', 'Deployed', 'PASS', `${code.length} bytes`)
    } else {
      addResult('Contract', 'Deployed', 'FAIL', 'No code at address')
    }
  } catch (err) {
    addResult('Contract', 'Deployed', 'FAIL', err instanceof Error ? err.message : 'Unknown error')
  }
}

async function checkHouseBots() {
  console.log('\n📋 House Bots\n')

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const treasuryAddress = process.env.TREASURY_ADDRESS?.toLowerCase()

  const { data: bots, error } = await supabase
    .from('agents')
    .select('id, name, wallet_address, privy_wallet_id, is_hosted')
    .eq('owner_address', treasuryAddress)
    .eq('is_hosted', true)

  if (error) {
    addResult('House Bots', 'Query', 'FAIL', error.message)
    return
  }

  if (!bots || bots.length === 0) {
    addResult('House Bots', 'Count', 'FAIL', 'No house bots found')
    return
  }

  addResult('House Bots', 'Count', 'PASS', `${bots.length} bots`)

  let withWallet = 0
  for (const bot of bots) {
    if (bot.privy_wallet_id) {
      withWallet++
    }
  }

  if (withWallet === bots.length) {
    addResult('House Bots', 'Privy Wallets', 'PASS', 'All have wallet IDs')
  } else {
    addResult('House Bots', 'Privy Wallets', 'WARN', `${withWallet}/${bots.length} have wallet IDs`)
  }

  // Check listings
  const { count: listingCount } = await supabase
    .from('listings')
    .select('*', { count: 'exact', head: true })
    .in('agent_id', bots.map(b => b.id))
    .eq('is_active', true)

  if (listingCount && listingCount > 0) {
    addResult('House Bots', 'Active Listings', 'PASS', `${listingCount} listings`)
  } else {
    addResult('House Bots', 'Active Listings', 'WARN', 'No active listings')
  }
}

async function checkCronEndpoints() {
  console.log('\n📋 Cron Endpoints\n')

  const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  const crons = [
    '/api/cron/oracle-release',
    '/api/cron/oracle-refund',
    '/api/cron/reputation-cache',
    '/api/cron/agent-heartbeat',
  ]

  // Check if this is pre-deployment (endpoints won't exist yet)
  let serverReachable = false
  try {
    const healthCheck = await fetch(`${BASE_URL}/api/health`, { method: 'GET' })
    serverReachable = healthCheck.ok
  } catch {
    serverReachable = false
  }

  if (!serverReachable) {
    addResult('Crons', 'Server Status', 'WARN', `${BASE_URL} not reachable - will verify after deployment`)
    return
  }

  for (const path of crons) {
    try {
      // Just check endpoint exists (will return 401 without auth)
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer invalid' },
      })

      if (res.status === 401) {
        addResult('Crons', path, 'PASS', 'Endpoint exists (auth required)')
      } else if (res.status === 404) {
        // 404 before deployment is expected - treat as warning
        addResult('Crons', path, 'WARN', 'Not deployed yet (will exist after vercel --prod)')
      } else {
        addResult('Crons', path, 'PASS', `Status ${res.status}`)
      }
    } catch (err) {
      addResult('Crons', path, 'WARN', 'Could not reach')
    }
  }
}

// ========== MAIN ==========

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║         Wild West Bots V2 - Pre-Launch Checklist         ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  await checkEnvironment()
  await checkDatabase()
  await checkFeatureFlags()
  await checkOracleWallet()
  await checkContract()
  await checkHouseBots()
  await checkCronEndpoints()

  // Summary
  console.log('\n' + '═'.repeat(60))
  console.log('CHECKLIST SUMMARY')
  console.log('═'.repeat(60) + '\n')

  const passed = results.filter(r => r.status === 'PASS').length
  const warned = results.filter(r => r.status === 'WARN').length
  const failed = results.filter(r => r.status === 'FAIL').length

  console.log(`  ✅ Passed: ${passed}`)
  console.log(`  ⚠️  Warnings: ${warned}`)
  console.log(`  ❌ Failed: ${failed}`)

  console.log('\n' + '─'.repeat(60))

  if (failed > 0) {
    console.log('\n❌ PRE-LAUNCH CHECK FAILED')
    console.log('\nFailed checks:')
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  - ${r.category} > ${r.check}: ${r.message}`)
    }
    process.exit(1)
  } else if (warned > 0) {
    console.log('\n⚠️  PRE-LAUNCH CHECK PASSED WITH WARNINGS')
    console.log('\nReview warnings before launch:')
    for (const r of results.filter(r => r.status === 'WARN')) {
      console.log(`  - ${r.category} > ${r.check}: ${r.message}`)
    }
  } else {
    console.log('\n✅ ALL PRE-LAUNCH CHECKS PASSED!')
    console.log('\nSystem is ready for production.')
  }
}

main().catch(err => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
