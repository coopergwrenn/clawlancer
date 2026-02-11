/**
 * Auto-Release Cron
 *
 * Runs every 15 minutes. Finds all transactions in DELIVERED state
 * where delivered_at is older than 1 hour and releases them.
 * This ensures sellers always get paid for completed work.
 *
 * Handles V1 transactions (no on-chain escrow) via DB-only release.
 * V2 transactions with on-chain escrow are handled by oracle-release cron.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { checkAndAwardAchievements } from '@/lib/achievements/check'
import { notifyPaymentReceived } from '@/lib/notifications/create'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  // Find DELIVERED transactions older than 1 hour (V1 with no escrow_id)
  const { data: deliveredTxns, error } = await supabaseAdmin
    .from('transactions')
    .select(`
      id, buyer_agent_id, seller_agent_id, amount_wei, currency, listing_id,
      buyer:agents!buyer_agent_id(id, name, total_spent_wei),
      seller:agents!seller_agent_id(id, name, total_earned_wei)
    `)
    .eq('state', 'DELIVERED')
    .lt('delivered_at', oneHourAgo)
    .is('escrow_id', null)
    .order('delivered_at', { ascending: true })
    .limit(20)

  if (error) {
    console.error('[auto-release] Query failed:', error)
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  if (!deliveredTxns || deliveredTxns.length === 0) {
    return NextResponse.json({ message: 'No transactions to release', released: 0 })
  }

  const results: Array<{ id: string; status: string; amount: string; seller: string }> = []
  const now = new Date().toISOString()

  for (const tx of deliveredTxns) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buyer = tx.buyer as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const seller = tx.seller as any
      const amountWei = BigInt(tx.amount_wei)
      const feeAmount = (amountWei * BigInt(100)) / BigInt(10000) // 1% fee
      const sellerAmount = amountWei - feeAmount

      // Update transaction to RELEASED
      await supabaseAdmin
        .from('transactions')
        .update({ state: 'RELEASED', completed_at: now })
        .eq('id', tx.id)

      // Update seller earnings
      const oldEarned = BigInt(seller.total_earned_wei || '0')
      await supabaseAdmin
        .from('agents')
        .update({ total_earned_wei: (oldEarned + sellerAmount).toString() })
        .eq('id', seller.id)

      // Increment transaction counts
      await supabaseAdmin.rpc('increment_transaction_count', { agent_id: seller.id }).catch(() => {})
      await supabaseAdmin.rpc('increment_transaction_count', { agent_id: buyer.id }).catch(() => {})

      // Feed event is created automatically by DB trigger (create_transaction_feed_event)
      // when transaction state changes to RELEASED — no manual insert needed

      // Record platform fee
      if (feeAmount > BigInt(0)) {
        await supabaseAdmin.from('platform_fees').insert({
          transaction_id: tx.id,
          fee_type: 'MARKETPLACE',
          amount_wei: feeAmount.toString(),
          currency: tx.currency || 'USDC',
          buyer_agent_id: buyer.id,
          seller_agent_id: seller.id,
          description: `1% auto-release fee on "${listingTitle}"`,
        }).catch(() => {})
      }

      // Notify seller
      notifyPaymentReceived(
        seller.id,
        buyer.name || 'Buyer',
        listingTitle,
        sellerAmount.toString(),
        tx.id
      ).catch(() => {})

      // Check achievements
      checkAndAwardAchievements(seller.id).catch(() => {})

      const amt = (Number(amountWei) / 1e6).toFixed(4)
      results.push({ id: tx.id, status: 'released', amount: `$${amt}`, seller: seller.name })
    } catch (err) {
      console.error(`[auto-release] Failed to release ${tx.id}:`, err)
      results.push({ id: tx.id, status: 'error', amount: '?', seller: '?' })
    }
  }

  const released = results.filter(r => r.status === 'released').length
  console.log(`[auto-release] Released ${released}/${deliveredTxns.length} transactions`)

  return NextResponse.json({
    released,
    total: deliveredTxns.length,
    results,
  })
}
