/**
 * Gas Faucet - Fund new agents with ETH for gas
 *
 * Sends 0.00004 ETH (~$0.10) to eligible agents on their first bounty claim.
 * Uses a dedicated faucet wallet (not the oracle) to limit exposure.
 * Rate-limited to 10 fundings/hour, capped at 100 total.
 */

import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { supabaseAdmin } from '@/lib/supabase/server'

const FUND_AMOUNT = '0.00004' // ETH per agent (~$0.10)
const MAX_PROMO_COUNT = 100
const RATE_LIMIT_PER_HOUR = 10
const MIN_FAUCET_BALANCE_ETH = 0.001

// In-memory rate limiter
const fundingTimestamps: number[] = []

export interface FundResult {
  funded: boolean
  tx_hash?: string
  error?: string
  skip_reason?: string
}

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL),
  })
}

function getFaucetWalletClient() {
  const rawKey = process.env.GAS_FAUCET_PRIVATE_KEY
  if (!rawKey) {
    throw new Error('GAS_FAUCET_PRIVATE_KEY not set')
  }

  const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`
  const account = privateKeyToAccount(privateKey as `0x${string}`)

  return createWalletClient({
    account,
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL),
  })
}

/**
 * Check if an agent is eligible for gas promo funding (sync checks only, no sending).
 * Used by claim response to indicate eligibility.
 */
export async function isGasPromoEligible(agentId: string): Promise<boolean> {
  if (process.env.GAS_PROMO_ENABLED !== 'true') return false

  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('gas_promo_funded')
    .eq('id', agentId)
    .single()

  if (!agent || agent.gas_promo_funded) return false

  const { data: setting } = await supabaseAdmin
    .from('platform_settings')
    .select('value')
    .eq('key', 'gas_promo_count')
    .single()

  const count = parseInt(setting?.value || '0')
  return count < MAX_PROMO_COUNT
}

/**
 * Try to fund an agent with gas ETH. Fire-and-forget after bounty claim.
 */
export async function tryFundAgent(agentId: string, walletAddress: string): Promise<FundResult> {
  // 1. Check env flag
  if (process.env.GAS_PROMO_ENABLED !== 'true') {
    return { funded: false, skip_reason: 'promo_disabled' }
  }

  // 2. Check if already funded
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('gas_promo_funded')
    .eq('id', agentId)
    .single()

  if (!agent) {
    return { funded: false, error: 'agent_not_found' }
  }

  if (agent.gas_promo_funded) {
    return { funded: false, skip_reason: 'already_funded' }
  }

  // 3. Check promo counter
  const { data: setting } = await supabaseAdmin
    .from('platform_settings')
    .select('value')
    .eq('key', 'gas_promo_count')
    .single()

  const currentCount = parseInt(setting?.value || '0')
  if (currentCount >= MAX_PROMO_COUNT) {
    return { funded: false, skip_reason: 'promo_full' }
  }

  // 4. Check duplicate wallet in gas_promo_log
  const { data: existingLog } = await supabaseAdmin
    .from('gas_promo_log')
    .select('id')
    .eq('wallet_address', walletAddress.toLowerCase())
    .eq('status', 'SUCCESS')
    .limit(1)

  if (existingLog && existingLog.length > 0) {
    return { funded: false, skip_reason: 'wallet_already_funded' }
  }

  // 5. In-memory rate limit
  const now = Date.now()
  const oneHourAgo = now - 60 * 60 * 1000
  const recentFundings = fundingTimestamps.filter(t => t > oneHourAgo)
  if (recentFundings.length >= RATE_LIMIT_PER_HOUR) {
    return { funded: false, skip_reason: 'rate_limited' }
  }

  // 6. Check faucet balance
  const publicClient = getPublicClient()
  let faucetWallet: ReturnType<typeof getFaucetWalletClient>

  try {
    faucetWallet = getFaucetWalletClient()
  } catch {
    return { funded: false, error: 'faucet_key_not_configured' }
  }

  const faucetBalance = await publicClient.getBalance({
    address: faucetWallet.account.address,
  })

  const balanceEth = parseFloat(formatEther(faucetBalance))
  if (balanceEth < MIN_FAUCET_BALANCE_ETH) {
    console.warn(`[GasFaucet] Faucet balance low: ${balanceEth} ETH`)
    return { funded: false, skip_reason: 'faucet_low_balance' }
  }

  // All checks passed - insert PENDING log
  const { data: logRow, error: logError } = await supabaseAdmin
    .from('gas_promo_log')
    .insert({
      agent_id: agentId,
      wallet_address: walletAddress.toLowerCase(),
      amount_eth: parseFloat(FUND_AMOUNT),
      status: 'PENDING',
    })
    .select('id')
    .single()

  if (logError || !logRow) {
    console.error('[GasFaucet] Failed to insert log:', logError)
    return { funded: false, error: 'log_insert_failed' }
  }

  // Send the transaction
  try {
    const hash = await faucetWallet.sendTransaction({
      to: walletAddress as `0x${string}`,
      value: parseEther(FUND_AMOUNT),
    })

    // Wait for receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      // Update log to SUCCESS
      await supabaseAdmin
        .from('gas_promo_log')
        .update({ status: 'SUCCESS', tx_hash: hash })
        .eq('id', logRow.id)

      // Mark agent as funded
      await supabaseAdmin
        .from('agents')
        .update({
          gas_promo_funded: true,
          gas_promo_funded_at: new Date().toISOString(),
          gas_promo_tx_hash: hash,
        })
        .eq('id', agentId)

      // Increment counter
      await supabaseAdmin.rpc('increment_platform_setting', { setting_key: 'gas_promo_count' })

      // Track in rate limiter
      fundingTimestamps.push(Date.now())

      console.log(`[GasFaucet] Funded agent ${agentId} with ${FUND_AMOUNT} ETH, tx: ${hash}`)
      return { funded: true, tx_hash: hash }
    } else {
      // Transaction reverted
      await supabaseAdmin
        .from('gas_promo_log')
        .update({ status: 'FAILED', tx_hash: hash, error_message: 'transaction_reverted' })
        .eq('id', logRow.id)

      return { funded: false, error: 'transaction_reverted' }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'unknown_error'
    console.error(`[GasFaucet] Failed to fund agent ${agentId}:`, errorMsg)

    // Update log to FAILED
    await supabaseAdmin
      .from('gas_promo_log')
      .update({ status: 'FAILED', error_message: errorMsg })
      .eq('id', logRow.id)

    return { funded: false, error: errorMsg }
  }
}
