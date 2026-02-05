/**
 * Check house bot wallet balances
 * Run with: npx tsx scripts/check-balances.ts
 */

import { createClient } from '@supabase/supabase-js'
import { createPublicClient, http, formatEther, formatUnits } from 'viem'
import { base } from 'viem/chains'
import * as dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS?.toLowerCase()

const supabase = createClient(supabaseUrl, supabaseKey)

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

async function main() {
  console.log('=== HOUSE BOT BALANCE CHECK ===\n')
  console.log(`Treasury address: ${TREASURY_ADDRESS}\n`)

  // Get house bots
  const { data: houseBots, error } = await supabase
    .from('agents')
    .select('id, name, wallet_address, is_hosted, privy_wallet_id')
    .eq('owner_address', TREASURY_ADDRESS || '')

  if (error) {
    console.error('Failed to fetch house bots:', error)
    return
  }

  if (!houseBots || houseBots.length === 0) {
    console.log('No house bots found!')
    return
  }

  console.log(`Found ${houseBots.length} house bots\n`)

  // Create public client for Base
  const client = createPublicClient({
    chain: base,
    transport: http(),
  })

  // Check balances
  console.log('Wallet Balances:')
  console.log('-'.repeat(80))

  let needsFunding = 0

  for (const bot of houseBots) {
    try {
      const walletAddress = bot.wallet_address as `0x${string}`

      // Get ETH balance
      const ethBalance = await client.getBalance({ address: walletAddress })

      // Get USDC balance
      const usdcBalance = await client.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletAddress],
      })

      const usdcFormatted = formatUnits(usdcBalance, 6)
      const ethFormatted = formatEther(ethBalance)
      const hasPrivy = bot.privy_wallet_id ? '✓' : '✗'
      const funded = usdcBalance > BigInt(0) ? '✓ FUNDED' : '✗ NEEDS FUNDING'

      if (usdcBalance === BigInt(0)) needsFunding++

      console.log(`${bot.name}`)
      console.log(`  Wallet: ${bot.wallet_address}`)
      console.log(`  Privy: ${hasPrivy} | ETH: ${parseFloat(ethFormatted).toFixed(6)} | USDC: $${parseFloat(usdcFormatted).toFixed(2)} | ${funded}`)
      console.log('')
    } catch (err) {
      console.log(`${bot.name}`)
      console.log(`  Wallet: ${bot.wallet_address}`)
      console.log(`  ERROR: Failed to fetch balance`)
      console.log('')
    }
  }

  console.log('-'.repeat(80))
  console.log(`\nSUMMARY: ${needsFunding} of ${houseBots.length} house bots need USDC funding`)

  if (needsFunding > 0) {
    console.log('\n⚠️  House bots without USDC cannot create on-chain escrows!')
    console.log('   This is why the live feed was showing fake activity - transactions were failing.')
  }
}

main().catch(console.error)
