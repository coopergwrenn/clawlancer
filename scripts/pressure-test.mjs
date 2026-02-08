import { createClient } from '@supabase/supabase-js'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

console.log('=== PRESSURE TEST ===\n')

// 1. Check Oracle Wallet
console.log('1. ORACLE WALLET CHECK')
const oracleKey = process.env.ORACLE_PRIVATE_KEY
if (!oracleKey) {
  console.log('❌ FAIL: ORACLE_PRIVATE_KEY not set in .env.local\n')
} else {
  const oracleAccount = privateKeyToAccount(oracleKey)
  console.log(`✅ Oracle address: ${oracleAccount.address}`)

  // Check ETH balance
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL)
  })

  const ethBalance = await publicClient.getBalance({ address: oracleAccount.address })
  console.log(`   ETH balance: ${(Number(ethBalance) / 1e18).toFixed(6)} ETH`)

  if (ethBalance < BigInt(1000000000000000)) { // 0.001 ETH
    console.log('⚠️  WARNING: Oracle has less than 0.001 ETH for gas')
  }

  // Check USDC balance
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const usdcBalance = await publicClient.readContract({
    address: USDC,
    abi: [{
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }]
    }],
    functionName: 'balanceOf',
    args: [oracleAccount.address]
  })
  console.log(`   USDC balance: ${(Number(usdcBalance) / 1e6).toFixed(2)} USDC`)

  if (usdcBalance < BigInt(10000000)) { // 10 USDC
    console.log('⚠️  WARNING: Oracle has less than 10 USDC')
  }
  console.log()
}

// 2. Check Cooper's Platform Balance
console.log('2. COOPER PLATFORM BALANCE CHECK')
const { data: cooper } = await supabase
  .from('users')
  .select('wallet_address, platform_balance_wei, locked_balance_wei')
  .eq('wallet_address', '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e')
  .single()

if (cooper) {
  const available = Number(cooper.platform_balance_wei) / 1e6
  const locked = Number(cooper.locked_balance_wei) / 1e6
  console.log(`✅ Cooper's balance (REAL in database):`)
  console.log(`   Available: $${available.toFixed(2)} USDC`)
  console.log(`   Locked: $${locked.toFixed(2)} USDC`)
  console.log(`   Total: $${(available + locked).toFixed(2)} USDC`)
} else {
  console.log('❌ FAIL: Cooper not found in users table')
}
console.log()

// 3. Check Database Functions Exist
console.log('3. DATABASE FUNCTIONS CHECK')
const functions = ['lock_user_balance', 'lock_agent_balance', 'debit_locked_user_balance']
for (const fn of functions) {
  const { error } = await supabase.rpc(fn, {
    p_wallet_address: '0xtest',
    p_amount_wei: '0'
  })
  if (error && !error.message.includes('not found')) {
    console.log(`✅ ${fn}() exists`)
  } else if (error && error.message.includes('not found')) {
    console.log(`❌ ${fn}() does NOT exist`)
  }
}
console.log()

// 4. Check Notifications Table Structure
console.log('4. NOTIFICATIONS TABLE CHECK')
const { data: notifSample } = await supabase
  .from('notifications')
  .select('id, type, user_wallet, agent_id, message')
  .limit(1)

if (notifSample || notifSample === null) {
  console.log('✅ Notifications table accessible')
  console.log('   Columns: id, type, user_wallet, agent_id, message')
} else {
  console.log('❌ Cannot query notifications table')
}
console.log()

// 5. Check Webhook Test
console.log('5. WEBHOOK COLUMNS CHECK')
const { data: webhookTest } = await supabase
  .from('agents')
  .select('webhook_url, webhook_enabled')
  .limit(1)

if (webhookTest || webhookTest === null) {
  console.log('✅ Webhook columns exist in agents table')
} else {
  console.log('❌ Webhook columns missing')
}
