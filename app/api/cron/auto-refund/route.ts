import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { agentRefundEscrow } from '@/lib/privy/server-wallet'

// POST /api/cron/auto-refund - Auto-refund expired escrows
// Called by Vercel cron every 10 minutes
export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  // Find all FUNDED transactions past deadline
  const { data: expiredTransactions, error } = await supabaseAdmin
    .from('transactions')
    .select(`
      id,
      escrow_id,
      amount_wei,
      buyer:agents!buyer_agent_id(id, privy_wallet_id, is_hosted, wallet_address),
      seller:agents!seller_agent_id(id, privy_wallet_id, is_hosted)
    `)
    .eq('state', 'FUNDED')
    .lt('deadline', now.toISOString())
    .limit(10) // Process 10 at a time to avoid timeout

  if (error) {
    console.error('Failed to fetch expired transactions:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  if (!expiredTransactions || expiredTransactions.length === 0) {
    return NextResponse.json({ message: 'No expired escrows to refund', processed: 0 })
  }

  const results: { id: string; success: boolean; error?: string; tx_hash?: string }[] = []

  for (const tx of expiredTransactions) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buyer = tx.buyer as any

    try {
      let refundTxHash: string | null = null

      // For hosted agents, we can refund on their behalf
      // For external agents, we just mark as refunded (they need to claim on-chain)
      if (buyer.is_hosted && buyer.privy_wallet_id) {
        const result = await agentRefundEscrow(
          buyer.privy_wallet_id,
          tx.escrow_id || tx.id
        )
        refundTxHash = result.hash
      }

      // Update transaction state
      await supabaseAdmin
        .from('transactions')
        .update({
          state: 'REFUNDED',
          completed_at: new Date().toISOString(),
          refund_tx_hash: refundTxHash,
          refund_reason: 'deadline_expired_auto',
        })
        .eq('id', tx.id)

      results.push({ id: tx.id, success: true, tx_hash: refundTxHash || undefined })
    } catch (err) {
      console.error(`Failed to refund transaction ${tx.id}:`, err)
      results.push({
        id: tx.id,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      })
    }
  }

  const successful = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  return NextResponse.json({
    message: `Processed ${results.length} expired escrows`,
    processed: results.length,
    successful,
    failed,
    results,
  })
}

// Also support GET for Vercel cron (it uses GET by default)
export async function GET(request: NextRequest) {
  return POST(request)
}
